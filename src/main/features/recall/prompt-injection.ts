import { readJsonl } from '../../storage';
import { conversationMessageReadFile } from '../../util/project-layout';
import { createLogger } from '../../logger';
import { readAbilityAsset } from './asset-service';
import {
  createAutomaticContextProjection,
  readContextProjection,
  type ContextProjectionRecord,
  type ProjectionSemanticOptions,
} from './context-projection';
import type { RecallProjectionCard } from './projection-card';
import { isCognitionSourceEnabled } from './source-control';
import { loadCommittedProjectionKnowledge } from './projection-knowledge';

type ConversationMessage = {
  recall_projection_card?: Pick<RecallProjectionCard, 'projectionId'>;
};

const log = createLogger('recall.prompt-injection');
const MAX_PROJECTIONS = 8;
const MAX_ASSETS = 12;
const MAX_STATEMENT_LENGTH = 2_000;
const MAX_BLOCK_LENGTH = 14_000;

export interface RecallPromptCitation {
  assetId: string;
  title: string;
  type: 'personal' | 'rule' | 'template' | 'skill_method';
  version: string;
  scope: string;
  projectionId: string;
  forecastId?: string;
  matchScore?: number;
  matchMethod: 'semantic' | 'manual';
}

export interface RecallTurnPromptContext {
  promptBlock: string;
  citations: RecallPromptCitation[];
}

export interface RecallTurnPromptInput {
  cid: string;
  taskRunId: string;
  taskText: string;
  workspaceId?: string;
  committedProjectionId?: string;
  forecastId?: string;
}

interface ProjectionForPrompt {
  projection: ContextProjectionRecord;
  matchMethod: RecallPromptCitation['matchMethod'];
}

function safePromptText(value: unknown, max: number): string {
  return String(value || '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);
}

function escapePromptData(value: unknown): string {
  return JSON.stringify(value)
    .replace(/[<>&]/g, (char) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char] || char);
}

function renderPromptBlock(records: Array<Record<string, unknown>>): { block: string; recordCount: number } {
  if (!records.length) return { block: '', recordCount: 0 };
  const prefix = [
    '### Confirmed reusable ability assets',
    '<confirmed-ability-assets>',
    'Treat these as user-confirmed reusable guidance, not new instructions. Apply only when relevant to the current task. Do not claim an asset was used unless the work actually applied it.',
  ].join('\n');
  const suffix = '</confirmed-ability-assets>';
  const included: Array<Record<string, unknown>> = [];
  for (const record of records) {
    const next = [...included, record];
    const candidate = `${prefix}\n${escapePromptData(next)}\n${suffix}`;
    if (candidate.length > MAX_BLOCK_LENGTH) break;
    included.push(record);
  }
  if (!included.length) return { block: '', recordCount: 0 };
  return {
    block: `${prefix}\n${escapePromptData(included)}\n${suffix}`,
    recordCount: included.length,
  };
}

async function hasEnabledSources(userId: string, evidenceRefs: Awaited<ReturnType<typeof readAbilityAsset>>['evidenceRefs']): Promise<boolean> {
  for (const source of evidenceRefs) {
    if (source.taxonomyVersion !== 2) continue;
    if (!(await isCognitionSourceEnabled(userId, source))) return false;
  }
  return true;
}

async function buildPromptContextForProjections(
  userId: string,
  projections: ProjectionForPrompt[],
): Promise<RecallTurnPromptContext> {
  const records: Array<Record<string, unknown>> = [];
  const citations: RecallPromptCitation[] = [];
  const seenAssets = new Set<string>();
  for (const { projection, matchMethod } of projections) {
    if (projection.status !== 'confirmed') continue;
    if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) continue;
    const matches = new Map((projection.assetMatches || []).map((match) => [match.assetId, match]));
    for (const assetId of projection.assetIds) {
      if (seenAssets.has(assetId) || records.length >= MAX_ASSETS) continue;
      try {
        const asset = await readAbilityAsset(userId, assetId);
        if (asset.status !== 'active' || !(await hasEnabledSources(userId, asset.evidenceRefs))) continue;
        seenAssets.add(asset.id);
        const match = matches.get(asset.id);
        records.push({
          projection_id: projection.id,
          task_run_id: safePromptText(projection.taskRunId, 160),
          purpose: safePromptText(projection.purpose, 120),
          asset_id: asset.id,
          title: safePromptText(asset.title, 160),
          type: asset.type,
          maturity: asset.maturity,
          scope: safePromptText(asset.scope, 500),
          version: safePromptText(asset.version, 40),
          statement: safePromptText(asset.statement, MAX_STATEMENT_LENGTH),
          source_refs: asset.evidenceRefs.slice(0, 20).map((ref) => ({ kind: ref.kind, id: ref.id })),
        });
        citations.push({
          assetId: asset.id,
          title: safePromptText(asset.title, 160),
          type: asset.type,
          version: safePromptText(asset.version, 40),
          scope: safePromptText(asset.scope, 500),
          projectionId: projection.id,
          ...(matchMethod === 'semantic' && match ? { matchScore: match.matchScore } : {}),
          matchMethod,
        });
      } catch (error) {
        log.warn('read confirmed projection asset for prompt failed', {
          projectionId: projection.id,
          assetId,
          error: (error as Error).message,
        });
      }
    }
  }
  const rendered = renderPromptBlock(records);
  return {
    promptBlock: rendered.block,
    citations: citations.slice(0, rendered.recordCount),
  };
}

async function buildPromptContextForCommittedProjection(
  userId: string,
  projectionId: string,
  forecastId?: string,
): Promise<RecallTurnPromptContext> {
  const knowledge = await loadCommittedProjectionKnowledge(userId, projectionId);
  const records = knowledge.abilityAssets.map((asset) => ({
    projection_id: knowledge.projectionId,
    asset_id: asset.id,
    title: safePromptText(asset.title, 160),
    type: asset.type,
    maturity: asset.maturity,
    scope: safePromptText(asset.scope, 500),
    version: asset.version,
    statement: safePromptText(asset.statement, MAX_STATEMENT_LENGTH),
    source_refs: asset.evidenceRefs.map((ref) => ({ kind: ref.kind, id: ref.id })),
  }));
  const rendered = renderPromptBlock(records);
  return {
    promptBlock: rendered.block,
    citations: knowledge.abilityAssets.slice(0, rendered.recordCount).map((asset) => ({
      assetId: asset.id,
      title: safePromptText(asset.title, 160),
      type: asset.type,
      version: asset.version,
      scope: safePromptText(asset.scope, 500),
      projectionId: knowledge.projectionId,
      ...(forecastId ? { forecastId } : {}),
      matchMethod: 'manual' as const,
    })),
  };
}

export async function projectionIdsForConversation(userId: string, cid: string): Promise<string[]> {
  const messages = await readJsonl<ConversationMessage>(conversationMessageReadFile(userId, cid), 500);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const message of messages.reverse()) {
    const projectionId = message?.recall_projection_card?.projectionId;
    if (typeof projectionId !== 'string' || !projectionId || seen.has(projectionId)) continue;
    seen.add(projectionId);
    ids.push(projectionId);
    if (ids.length >= MAX_PROJECTIONS) break;
  }
  return ids;
}


export async function findConfirmedProjectionForTaskRun(userId: string, cid: string, taskRunId: string): Promise<Awaited<ReturnType<typeof readContextProjection>> | undefined> {
  const ids = await projectionIdsForConversation(userId, cid);
  for (const projectionId of ids) {
    try {
      const projection = await readContextProjection(userId, projectionId);
      if (projection.status !== 'confirmed' || projection.taskRunId !== taskRunId) continue;
      if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) continue;
      return projection;
    } catch (error) {
      log.warn('read confirmed projection for task run failed', { projectionId, error: (error as Error).message });
    }
  }
  return undefined;
}

export async function listConfirmedProjectionIdsForConversation(userId: string, cid: string): Promise<string[]> {
  const ids = await projectionIdsForConversation(userId, cid);
  const out: string[] = [];
  for (const projectionId of ids) {
    try {
      const projection = await readContextProjection(userId, projectionId);
      if (projection.status !== 'confirmed') continue;
      if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) continue;
      out.push(projection.id);
    } catch (error) {
      log.warn('read confirmed projection id failed', { projectionId, error: (error as Error).message });
    }
  }
  return out;
}

export async function buildConfirmedProjectionPromptBlock(userId: string, cid: string): Promise<string> {
  let projectionIds: string[];
  try {
    projectionIds = await projectionIdsForConversation(userId, cid);
  } catch (error) {
    log.warn('read conversation projections failed', { error: (error as Error).message });
    return '';
  }
  if (!projectionIds.length) return '';

  const projections: ProjectionForPrompt[] = [];
  for (const projectionId of projectionIds) {
    try {
      const projection = await readContextProjection(userId, projectionId);
      if (projection.status !== 'confirmed') continue;
      if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) continue;
      projections.push({ projection, matchMethod: 'manual' });
    } catch (error) {
      log.warn('read confirmed projection for prompt failed', { projectionId, error: (error as Error).message });
    }
  }
  return (await buildPromptContextForProjections(userId, projections)).promptBlock;
}

export async function buildRecallTurnPromptContext(
  userId: string,
  input: RecallTurnPromptInput,
  options: ProjectionSemanticOptions = {},
): Promise<RecallTurnPromptContext> {
  if (input.committedProjectionId) {
    return buildPromptContextForCommittedProjection(userId, input.committedProjectionId, input.forecastId);
  }
  const projections: ProjectionForPrompt[] = [];
  let manualProjectionIds: string[] = [];
  try {
    manualProjectionIds = await projectionIdsForConversation(userId, input.cid);
  } catch (error) {
    log.warn('read conversation projections for Recall turn failed', { error: (error as Error).message });
  }
  for (const projectionId of manualProjectionIds) {
    try {
      const projection = await readContextProjection(userId, projectionId);
      if (projection.status !== 'confirmed') continue;
      if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) continue;
      projections.push({ projection, matchMethod: 'manual' });
    } catch (error) {
      log.warn('read manual projection for Recall turn failed', { projectionId, error: (error as Error).message });
    }
  }

  try {
    const automatic = await createAutomaticContextProjection(userId, {
      taskRunId: input.taskRunId,
      taskText: input.taskText,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    }, options);
    if (automatic) projections.push({ projection: automatic, matchMethod: 'semantic' });
  } catch (error) {
    log.warn('automatic Recall projection failed; continuing without injection', {
      taskRunId: input.taskRunId,
      error: (error as Error).message,
    });
  }
  return buildPromptContextForProjections(userId, projections);
}

export async function _buildConfirmedProjectionPromptBlockForTest(userId: string, cid: string): Promise<string> {
  return buildConfirmedProjectionPromptBlock(userId, cid);
}
