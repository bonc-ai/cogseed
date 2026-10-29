import { randomUUID } from 'node:crypto';

import { getLanguageForUser } from '../config';
import { chatWithModel, type ChatOptions, type ChatResult } from '../../model/client';
import { prompts } from '../../prompts/loader';
import {
  buildCreatorCapabilityCatalog,
  creatorCatalogLogicalId,
  sanitizeCreatorCapabilityCatalog,
  type CreatorCapabilityDescriptor,
} from './catalog';
import {
  forEachOwnEnumerableCreatorKey,
  safeCreatorIssuePathSegment,
  validateCreatorPresetManifest,
} from './schema';
import { saveCreatorDraft, type CreatorPresetDraft } from './store';
import type { CreatorPresetManifestV1, CreatorSchemaIssue } from './types';

const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const URL_VALUE = /(?:https?|wss?|ftp|file):\/\/|\bwww\./i;
const SECRET_VALUE = /(?:\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const MAX_GOAL_LENGTH = 4_000;
const MAX_MODEL_OUTPUT_BYTES = 64_000;
const MAX_INSPECTION_DEPTH = 64;
const MAX_INSPECTION_NODES = 4_096;
const MAX_INSPECTION_CHILDREN = 256;

export interface CreatorProposalDependencies {
  runModel?: (args: { systemPrompt: string; message: string }) => Promise<string>;
  chatModel?: (options: ChatOptions) => Promise<ChatResult>;
  buildCatalog?: (userId: string) => Promise<CreatorCapabilityDescriptor[]>;
  saveDraft?: (userId: string, draft: CreatorPresetDraft) => Promise<CreatorPresetDraft>;
  getLocale?: (userId: string) => string;
  now?: () => string;
  createId?: () => string;
}

export class CreatorProposalError extends Error {
  readonly issues: CreatorSchemaIssue[];

  constructor(code: string, issues: CreatorSchemaIssue[] = []) {
    super(code);
    this.name = 'CreatorProposalError';
    this.issues = issues;
  }
}

function proposalIssue(path: string, message: string): CreatorSchemaIssue {
  return { code: 'creator_invalid_reference', path, message };
}

function cleanGoal(value: unknown): string {
  if (typeof value !== 'string') throw new CreatorProposalError('creator_goal_invalid');
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (!cleaned || cleaned.length > MAX_GOAL_LENGTH || URL_VALUE.test(cleaned) || SECRET_VALUE.test(cleaned)) {
    throw new CreatorProposalError('creator_goal_invalid');
  }
  return cleaned;
}

function assertModelOutputBounded(value: string): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_MODEL_OUTPUT_BYTES) {
    throw new CreatorProposalError('creator_proposal_invalid_output');
  }
}

function requireLogicalId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !LOGICAL_ID.test(value)) {
    throw new CreatorProposalError(code);
  }
  return value;
}

function unwrapSingleFence(text: string): string {
  if (!text.startsWith('```')) return text;
  const match = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (!match) throw new CreatorProposalError('creator_proposal_invalid_output');
  return match[1].trim();
}

function objectRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}') {
      if (depth === 0) throw new CreatorProposalError('creator_proposal_invalid_output');
      depth -= 1;
      if (depth === 0 && start >= 0) {
        ranges.push([start, index + 1]);
        start = -1;
      }
    }
  }
  if (depth !== 0 || inString) throw new CreatorProposalError('creator_proposal_invalid_output');
  return ranges;
}

function parseSingleObject(raw: string): Record<string, unknown> {
  if (URL_VALUE.test(raw) || SECRET_VALUE.test(raw)) {
    throw new CreatorProposalError('creator_proposal_invalid_output');
  }
  const trimmed = raw.trim();
  if (!trimmed) throw new CreatorProposalError('creator_proposal_invalid_output');
  const text = unwrapSingleFence(trimmed);

  try {
    const direct = JSON.parse(text) as unknown;
    if (!direct || typeof direct !== 'object' || Array.isArray(direct)) {
      throw new CreatorProposalError('creator_proposal_invalid_output');
    }
    return direct as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CreatorProposalError) throw error;
  }

  const ranges = objectRanges(text);
  if (ranges.length > 1) throw new CreatorProposalError('creator_proposal_multiple_objects');
  if (ranges.length !== 1) throw new CreatorProposalError('creator_proposal_invalid_output');
  const [start, end] = ranges[0];
  const prefix = text.slice(0, start);
  const suffix = text.slice(end);
  if (/[\[\]{}]|```/.test(prefix) || /[\[\]{}]|```/.test(suffix)) {
    throw new CreatorProposalError('creator_proposal_invalid_output');
  }
  try {
    const parsed = JSON.parse(text.slice(start, end)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CreatorProposalError('creator_proposal_invalid_output');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CreatorProposalError) throw error;
    throw new CreatorProposalError('creator_proposal_invalid_output');
  }
}

function inspectForbiddenValues(value: unknown, path = '', seen = new WeakSet<object>()): CreatorSchemaIssue[] {
  const issues: CreatorSchemaIssue[] = [];
  const pending: Array<{ value: unknown; path: string; depth: number }> = [{ value, path, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (++nodes > MAX_INSPECTION_NODES || current.depth > MAX_INSPECTION_DEPTH) {
      return [proposalIssue('', 'proposal output exceeds structural limits')];
    }
    if (typeof current.value === 'string') {
      if (URL_VALUE.test(current.value)) issues.push(proposalIssue(current.path, 'URLs are forbidden in Creator proposals'));
      else if (SECRET_VALUE.test(current.value)) issues.push(proposalIssue(current.path, 'credential-like values are forbidden in Creator proposals'));
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value as object)) {
      issues.push(proposalIssue(current.path, 'cyclic values are forbidden'));
      continue;
    }
    seen.add(current.value as object);
    try {
      if (Array.isArray(current.value)) {
        let length: number;
        try { length = current.value.length; } catch { return [proposalIssue('', 'proposal output is not inspectable')]; }
        if (!Number.isSafeInteger(length) || length > MAX_INSPECTION_CHILDREN) {
          return [proposalIssue('', 'proposal output exceeds structural limits')];
        }
        for (let index = length - 1; index >= 0; index -= 1) {
          if (!Object.prototype.hasOwnProperty.call(current.value, index)) {
            return [proposalIssue('', 'proposal output exceeds structural limits')];
          }
          pending.push({ value: current.value[index], path: current.path ? `${current.path}.${index}` : String(index), depth: current.depth + 1 });
        }
      } else {
        const entries: Array<[string, unknown]> = [];
        const complete = forEachOwnEnumerableCreatorKey(current.value, MAX_INSPECTION_CHILDREN, (key) => {
          if (key.length > 256 || entries.length >= MAX_INSPECTION_CHILDREN) {
            throw new Error('proposal output exceeds structural limits');
          }
          entries.push([key, (current.value as Record<string, unknown>)[key]]);
        });
        if (!complete) return [proposalIssue('', 'proposal output exceeds structural limits')];
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const [key, entry] = entries[index];
          const safeKey = safeCreatorIssuePathSegment(key);
          pending.push({
            value: entry,
            path: current.path ? `${current.path}.${safeKey}` : safeKey,
            depth: current.depth + 1,
          });
        }
      }
    } catch {
      return [proposalIssue('', 'proposal output is not inspectable')];
    }
  }
  return issues;
}

function resolveCatalog(
  manifest: CreatorPresetManifestV1,
  catalog: readonly CreatorCapabilityDescriptor[],
): CreatorSchemaIssue[] {
  const issues: CreatorSchemaIssue[] = [];
  const exact = new Map(catalog.map((descriptor) => [`${descriptor.capabilityId}\u0000${descriptor.version}`, descriptor]));
  const availableModels = catalog.filter((descriptor) => descriptor.kind === 'model' && descriptor.available);
  const expectedModelId = creatorCatalogLogicalId('model', manifest.model.providerId, manifest.model.modelId);
  if (!availableModels.some((descriptor) => descriptor.capabilityId === expectedModelId)) {
    issues.push(proposalIssue('model', 'model is not available in the current catalog'));
  }

  manifest.capabilities.forEach((requested, index) => {
    const descriptor = exact.get(`${requested.capabilityId}\u0000${requested.version}`);
    if (!descriptor || !descriptor.available) {
      issues.push(proposalIssue(`capabilities.${index}.capabilityId`, 'capability is not available in the current catalog'));
    }
  });

  manifest.permissions.tools.forEach((capabilityId, index) => {
    const descriptor = catalog.find((item) => item.capabilityId === capabilityId && item.kind === 'tool' && item.available);
    if (!descriptor) issues.push(proposalIssue(`permissions.tools.${index}`, 'tool is not available in the current catalog'));
  });
  manifest.permissions.files.forEach((grant, index) => {
    if (grant !== 'workspace.readonly') {
      issues.push(proposalIssue(`permissions.files.${index}`, 'file grant is not allowed by Creator proposal policy'));
    }
  });
  manifest.permissions.sideEffects.forEach((_effect, index) => {
    issues.push(proposalIssue(`permissions.sideEffects.${index}`, 'side effects require a later explicit approval stage'));
  });

  return issues;
}

function runtimePrompt(
  staticPrompt: string,
  goal: string,
  sourceSessionId: string,
  locale: string,
  catalog: readonly CreatorCapabilityDescriptor[],
): string {
  const safeCatalog = catalog.map(({ capabilityId, version, kind, available, permissions }) => ({ capabilityId, version, kind, available, permissions }));
  const injection = {
    locale,
    userGoal: goal,
    sourceSessionId,
    bounds: { maxTimeoutMs: 1_800_000, maxCost: 10_000, maxTokens: 10_000_000 },
    catalog: safeCatalog,
  };
  const prompt = staticPrompt.trim();
  if ((prompt.match(/^## Runtime injection$/gm) ?? []).length !== 1
    || !prompt.endsWith('## Runtime injection')) {
    throw new CreatorProposalError('creator_proposal_prompt_invalid');
  }
  return `${prompt}\n\n${JSON.stringify(injection, null, 2)}`;
}

async function defaultRunModel(
  userId: string,
  proposalId: string,
  args: { systemPrompt: string; message: string },
  chatModel: (options: ChatOptions) => Promise<ChatResult>,
): Promise<string> {
  const result = await chatModel({
    userId,
    message: args.message,
    sessionId: `creator-${proposalId}`,
    systemPrompt: args.systemPrompt,
    disableTools: true,
    skillList: [],
    ephemeralSession: true,
    idleTimeout: 120,
    streamIdleTimeout: 60,
  });
  if (!result.ok || result.aborted) throw new CreatorProposalError('creator_proposal_model_failed');
  return result.text;
}

async function proposeCreatorPresetInternal(
  userId: string,
  input: { goal: string; sourceSessionId: string },
  deps: CreatorProposalDependencies = {},
): Promise<{ draft: CreatorPresetDraft; issues: CreatorSchemaIssue[] }> {
  if (!userId) throw new CreatorProposalError('creator_user_invalid');
  const goal = cleanGoal(input?.goal);
  const sourceSessionId = requireLogicalId(input?.sourceSessionId, 'creator_source_session_invalid');
  let rawProposalId: unknown;
  try {
    rawProposalId = (deps.createId ?? (() => randomUUID()))();
  } catch {
    throw new CreatorProposalError('creator_proposal_dependency_failed');
  }
  const proposalId = requireLogicalId(rawProposalId, 'creator_proposal_id_invalid');
  let catalog: CreatorCapabilityDescriptor[];
  try {
    catalog = sanitizeCreatorCapabilityCatalog(
      await (deps.buildCatalog ?? buildCreatorCapabilityCatalog)(userId),
    );
  } catch {
    throw new CreatorProposalError('creator_proposal_dependency_failed');
  }
  let locale: string;
  try {
    locale = (deps.getLocale ?? getLanguageForUser)(userId);
  } catch {
    throw new CreatorProposalError('creator_proposal_dependency_failed');
  }
  const systemPrompt = runtimePrompt(
    prompts.load('creator_preset'),
    goal,
    sourceSessionId,
    locale,
    catalog,
  );
  const modelArgs = { systemPrompt, message: 'Generate the bounded Creator Preset v1 JSON object now.' };

  let output: string;
  try {
    output = deps.runModel
      ? await deps.runModel(modelArgs)
      : await defaultRunModel(userId, proposalId, modelArgs, deps.chatModel ?? chatWithModel);
  } catch {
    throw new CreatorProposalError('creator_proposal_model_failed');
  }
  assertModelOutputBounded(output);

  const parsed = parseSingleObject(output);
  const forbiddenIssues = inspectForbiddenValues(parsed);
  if (forbiddenIssues.length > 0) {
    throw new CreatorProposalError('creator_proposal_invalid_output', forbiddenIssues);
  }
  const trustedCandidate = {
    ...parsed,
    provenance: {
      createdBy: 'creator-agent',
      sourceSessionId,
      sourceAssetRefs: [],
    },
  };
  const schema = validateCreatorPresetManifest(trustedCandidate);
  if (schema.ok === false) throw new CreatorProposalError('creator_proposal_invalid_output', schema.issues);
  const catalogIssues = resolveCatalog(schema.value, catalog);
  if (catalogIssues.length > 0) {
    throw new CreatorProposalError('creator_proposal_catalog_mismatch', catalogIssues);
  }

  // Revalidate the exact value written to storage so later code never receives
  // a partially resolved or post-validation mutation.
  const finalValidation = validateCreatorPresetManifest(schema.value);
  if (finalValidation.ok === false) throw new CreatorProposalError('creator_proposal_invalid_output', finalValidation.issues);
  let updatedAt: string;
  try {
    updatedAt = (deps.now ?? (() => new Date().toISOString()))();
  } catch {
    throw new CreatorProposalError('creator_proposal_dependency_failed');
  }
  const draft: CreatorPresetDraft = {
    schemaVersion: 1,
    draftId: `draft-${proposalId}`,
    manifest: finalValidation.value,
    updatedAt,
  };
  let saved: CreatorPresetDraft;
  try {
    saved = await (deps.saveDraft ?? saveCreatorDraft)(userId, draft);
  } catch {
    throw new CreatorProposalError('creator_proposal_dependency_failed');
  }
  return { draft: saved, issues: [] };
}

export async function proposeCreatorPreset(
  userId: string,
  input: { goal: string; sourceSessionId: string },
  deps: CreatorProposalDependencies = {},
): Promise<{ draft: CreatorPresetDraft; issues: CreatorSchemaIssue[] }> {
  try {
    return await proposeCreatorPresetInternal(userId, input, deps);
  } catch (error) {
    if (error instanceof CreatorProposalError) throw error;
    throw new CreatorProposalError('creator_proposal_dependency_failed');
  }
}
