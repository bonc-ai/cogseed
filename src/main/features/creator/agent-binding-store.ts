import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import {
  userRoot,
  userCreatorAgentBindingFile,
  userCreatorAgentBindingsDir,
} from '../../paths';
import { safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import type { CreatorPresetManifestV1 } from './types';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BINDING_KEYS = new Set([
  'schemaVersion',
  'presetId',
  'version',
  'manifestDigest',
  'agentId',
  'materializedAt',
  'materializationRevision',
  'policy',
]);
const FILE_KEYS = new Set(['schemaVersion', 'presetId', 'bindings']);

export interface CreatorAgentBindingPolicy {
  model: {
    providerId: string;
    modelId: string;
    reasoningProfile?: string;
  };
  skillIds: string[];
  capabilityIds: string[];
  runtime: {
    sessionPolicy: 'new-per-run' | 'resume-explicit';
    memoryPolicy: 'none' | 'read-only';
    loopPolicy: 'single-agent';
    sandboxProfile: 'creator-read-only-v1';
    timeoutMs: number;
    budget: {
      maxCost?: number;
      maxTokens?: number;
    };
  };
  permissions: {
    tools: string[];
    files: string[];
    sideEffects: string[];
    approvalMode: 'always' | 'on-risk' | 'preapproved';
  };

}

export interface CreatorAgentBinding {
  schemaVersion: 1;
  presetId: string;
  version: string;
  manifestDigest: string;
  agentId: string;
  materializedAt: string;
  materializationRevision: string;
  policy: CreatorAgentBindingPolicy;
}

interface CreatorAgentBindingFile {
  schemaVersion: 1;
  presetId: string;
  bindings: CreatorAgentBinding[];
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

const MODEL_KEYS = new Set(['providerId', 'modelId', 'reasoningProfile']);
const POLICY_KEYS = new Set(['model', 'skillIds', 'capabilityIds', 'runtime', 'permissions']);
const RUNTIME_KEYS = new Set(['sessionPolicy', 'memoryPolicy', 'loopPolicy', 'sandboxProfile', 'timeoutMs', 'budget']);
const BUDGET_KEYS = new Set(['maxCost', 'maxTokens']);
const PERMISSION_KEYS = new Set(['tools', 'files', 'sideEffects', 'approvalMode']);
const MAX_POLICY_ITEMS = 64;

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((value) => right.includes(value));
}

function catalogSkillCapabilityId(skillId: string): string {
  return `skill.id-${createHash('sha256').update(skillId).digest('hex').slice(0, 16)}`;
}

function skillApprovedByManifest(skillId: string, capabilities: readonly string[]): boolean {
  return capabilities.some((capabilityId) => {
    if (!capabilityId.startsWith('skill.')) return false;
    const suffix = capabilityId.slice('skill.'.length);
    return suffix === skillId || catalogSkillCapabilityId(skillId) === capabilityId;
  });
}

/**
 * Binding policy is authorization state, so its shape validation is not enough:
 * every policy field must still describe the verified immutable manifest. Skill
 * ids are the resolved upstream ids; hashed catalog ids are checked using the
 * same deterministic catalog encoding used during materialization.
 */
export function creatorBindingPolicyMatchesManifest(
  policy: CreatorAgentBindingPolicy,
  manifest: Readonly<CreatorPresetManifestV1>,
): boolean {
  const capabilityIds = manifest.capabilities.map((item) => item.capabilityId);
  return JSON.stringify(policy.model) === JSON.stringify(manifest.model)
    && sameStringSet(policy.capabilityIds, capabilityIds)
    && JSON.stringify(policy.runtime) === JSON.stringify(manifest.runtime)
    && JSON.stringify(policy.permissions) === JSON.stringify(manifest.permissions)
    && policy.skillIds.every((skillId) => skillApprovedByManifest(skillId, capabilityIds));
}

function assertUserId(userId: string): void {
  if (!safeId(userId)) throw new Error('creator_agent_binding_user_invalid');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Binding files are machine-private authorization state. Check every existing
 * path component without following links, then confirm the canonical target
 * remains below the requested user's root before any read or write.
 */
export async function assertCreatorAgentBindingPathSafe(
  userId: string,
  targetPath: string,
  errorCode = 'creator_agent_binding_corrupt',
): Promise<void> {
  assertUserId(userId);
  const root = path.resolve(userRoot(userId));
  const target = path.resolve(targetPath);
  if (!isWithin(root, target)) throw new Error(errorCode);

  let current = target;
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(errorCode);
      if (current !== target && current !== root && !stat.isDirectory()) throw new Error(errorCode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current || !isWithin(root, parent)) throw new Error(errorCode);
    current = parent;
  }

  const realRoot = await fs.realpath(root).catch(() => null);
  if (!realRoot) return;
  const realTarget = await fs.realpath(target).catch(() => null);
  const realParent = await fs.realpath(path.dirname(target)).catch(() => null);
  if ((realTarget && !isWithin(realRoot, realTarget))
      || (realParent && !isWithin(realRoot, realParent))) throw new Error(errorCode);
}

function validateIdentifierArray(value: unknown, errorCode: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_POLICY_ITEMS) throw new Error(errorCode);
  const result = value.map((entry) => {
    if (!isIdentifier(entry)) throw new Error(errorCode);
    return entry;
  });
  if (new Set(result).size !== result.length) throw new Error(errorCode);
  return result;
}

function validateBudget(value: unknown, errorCode: string): CreatorAgentBindingPolicy['runtime']['budget'] {
  if (!isPlainObject(value) || !hasExactKeys(value, BUDGET_KEYS)) throw new Error(errorCode);
  const maxCost = value.maxCost;
  const maxTokens = value.maxTokens;
  if (maxCost !== undefined
      && (typeof maxCost !== 'number' || !Number.isFinite(maxCost) || maxCost < 0 || maxCost > 10_000)) {
    throw new Error(errorCode);
  }
  if (maxTokens !== undefined
      && (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 10_000_000)) {
    throw new Error(errorCode);
  }
  const budget: CreatorAgentBindingPolicy['runtime']['budget'] = {};
  if (typeof maxCost === 'number') budget.maxCost = maxCost;
  if (typeof maxTokens === 'number') budget.maxTokens = maxTokens;
  return budget;
}

function validatePolicy(value: unknown, errorCode: string): CreatorAgentBindingPolicy {
  if (!isPlainObject(value) || !hasExactKeys(value, POLICY_KEYS)) throw new Error(errorCode);
  if (!isPlainObject(value.model) || !hasExactKeys(value.model, MODEL_KEYS)) throw new Error(errorCode);
  const reasoningProfile = value.model.reasoningProfile;
  if (!isIdentifier(value.model.providerId) || !isIdentifier(value.model.modelId)
      || (reasoningProfile !== undefined && !isIdentifier(reasoningProfile))) {
    throw new Error(errorCode);
  }
  if (!isPlainObject(value.runtime) || !hasExactKeys(value.runtime, RUNTIME_KEYS)) throw new Error(errorCode);
  if (value.runtime.sessionPolicy !== 'new-per-run' && value.runtime.sessionPolicy !== 'resume-explicit') throw new Error(errorCode);
  if (value.runtime.memoryPolicy !== 'none' && value.runtime.memoryPolicy !== 'read-only') throw new Error(errorCode);
  if (value.runtime.loopPolicy !== 'single-agent'
      || value.runtime.sandboxProfile !== 'creator-read-only-v1'
      || typeof value.runtime.timeoutMs !== 'number'
      || !Number.isSafeInteger(value.runtime.timeoutMs)
      || value.runtime.timeoutMs < 1
      || value.runtime.timeoutMs > 30 * 60 * 1_000) throw new Error(errorCode);

  if (!isPlainObject(value.permissions) || !hasExactKeys(value.permissions, PERMISSION_KEYS)) throw new Error(errorCode);
  if (!['always', 'on-risk', 'preapproved'].includes(String(value.permissions.approvalMode))) throw new Error(errorCode);


  return {
    model: {
      providerId: value.model.providerId,
      modelId: value.model.modelId,
      ...(typeof reasoningProfile === 'string' ? { reasoningProfile } : {}),
    },
    skillIds: validateIdentifierArray(value.skillIds, errorCode),
    capabilityIds: validateIdentifierArray(value.capabilityIds, errorCode),
    runtime: {
      sessionPolicy: value.runtime.sessionPolicy,
      memoryPolicy: value.runtime.memoryPolicy,
      loopPolicy: 'single-agent',
      sandboxProfile: 'creator-read-only-v1',
      timeoutMs: value.runtime.timeoutMs,
      budget: validateBudget(value.runtime.budget, errorCode),
    },
    permissions: {
      tools: validateIdentifierArray(value.permissions.tools, errorCode),
      files: validateIdentifierArray(value.permissions.files, errorCode),
      sideEffects: validateIdentifierArray(value.permissions.sideEffects, errorCode),
      approvalMode: value.permissions.approvalMode as CreatorAgentBindingPolicy['permissions']['approvalMode'],
    },
  };
}

function immutableBinding(binding: CreatorAgentBinding): CreatorAgentBinding {
  const clone = structuredClone(binding);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  };
  freeze(clone);
  return clone;
}

function validateBinding(value: unknown, errorCode: string): CreatorAgentBinding {
  if (!isPlainObject(value) || !hasExactKeys(value, BINDING_KEYS)) throw new Error(errorCode);
  if (
    value.schemaVersion !== 1
    || !isIdentifier(value.presetId)
    || !isIdentifier(value.version)
    || typeof value.manifestDigest !== 'string'
    || !DIGEST.test(value.manifestDigest)
    || !isIdentifier(value.agentId)
    || typeof value.materializedAt !== 'string'
    || !Number.isFinite(Date.parse(value.materializedAt))
    || !isIdentifier(value.materializationRevision)
  ) throw new Error(errorCode);
  const policy = validatePolicy(value.policy, errorCode);
  return {
    schemaVersion: 1,
    presetId: value.presetId,
    version: value.version,
    manifestDigest: value.manifestDigest,
    agentId: value.agentId,
    materializedAt: value.materializedAt,
    materializationRevision: value.materializationRevision,
    policy,
  };
}

function validateBindingFile(value: unknown, presetId: string): CreatorAgentBindingFile {
  const errorCode = 'creator_agent_binding_corrupt';
  if (!isPlainObject(value) || !hasExactKeys(value, FILE_KEYS)) throw new Error(errorCode);
  if (value.schemaVersion !== 1 || value.presetId !== presetId || !Array.isArray(value.bindings)) {
    throw new Error(errorCode);
  }
  const versions = new Set<string>();
  const agents = new Set<string>();
  const bindings = value.bindings.map((entry) => {
    const binding = validateBinding(entry, errorCode);
    if (binding.presetId !== presetId || versions.has(binding.version) || agents.has(binding.agentId)) {
      throw new Error(errorCode);
    }
    versions.add(binding.version);
    agents.add(binding.agentId);
    return immutableBinding(binding);
  });
  return { schemaVersion: 1, presetId, bindings };
}

async function readBindingFile(userId: string, presetId: string, file: string): Promise<CreatorAgentBindingFile | null> {
  await assertCreatorAgentBindingPathSafe(userId, file);
  let handle: fs.FileHandle | undefined;
  try {
    const flags = fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW);
    handle = await fs.open(file, flags);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error('creator_agent_binding_corrupt');
    const text = await handle.readFile('utf8');
    const final = await handle.stat();
    if (final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size) {
      throw new Error('creator_agent_binding_corrupt');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new Error('creator_agent_binding_corrupt');
    }
    return validateBindingFile(raw, presetId);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  } finally {
    try { await handle?.close(); } catch { /* contain close races */ }
  }
}

async function listBindingFiles(userId: string): Promise<CreatorAgentBindingFile[]> {
  const directory = userCreatorAgentBindingsDir(userId);
  await assertCreatorAgentBindingPathSafe(userId, directory);
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const files: CreatorAgentBindingFile[] = [];
  for (const name of entries.filter((entry) => entry.endsWith('.json')).sort()) {
    const presetId = name.slice(0, -'.json'.length);
    if (!isIdentifier(presetId)) throw new Error('creator_agent_binding_corrupt');
    const value = await readBindingFile(userId, presetId, path.join(directory, name));
    if (value) files.push(value);
  }
  return files;
}

function sameBinding(left: CreatorAgentBinding, right: CreatorAgentBinding): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.presetId === right.presetId
    && left.version === right.version
    && left.manifestDigest === right.manifestDigest
    && left.agentId === right.agentId
    && left.materializedAt === right.materializedAt
    && left.materializationRevision === right.materializationRevision
    && JSON.stringify(left.policy) === JSON.stringify(right.policy);
}

export async function saveCreatorAgentBinding(
  userId: string,
  input: CreatorAgentBinding,
): Promise<CreatorAgentBinding> {
  assertUserId(userId);
  const binding = validateBinding(input, 'creator_agent_binding_invalid');
  const directory = userCreatorAgentBindingsDir(userId);
  return fileEditLock(directory).runExclusive(async () => {
    await assertCreatorAgentBindingPathSafe(userId, userCreatorAgentBindingFile(userId, binding.presetId), 'creator_agent_binding_invalid');
    const files = await listBindingFiles(userId);
    const current = files.find((entry) => entry.presetId === binding.presetId)
      ?? { schemaVersion: 1 as const, presetId: binding.presetId, bindings: [] };
    const existingVersion = current.bindings.find((entry) => entry.version === binding.version);
    if (existingVersion) {
      if (!sameBinding(existingVersion, binding)) throw new Error('creator_agent_binding_conflict');
      return immutableBinding(existingVersion);
    }
    if (files.some((entry) => entry.bindings.some((item) => item.agentId === binding.agentId))) {
      throw new Error('creator_agent_binding_conflict');
    }
    const next: CreatorAgentBindingFile = {
      schemaVersion: 1,
      presetId: binding.presetId,
      bindings: [...current.bindings, binding].sort((a, b) => a.version.localeCompare(b.version)),
    };
    await writeJson(userCreatorAgentBindingFile(userId, binding.presetId), next);
    return immutableBinding(binding);
  });
}

export async function readCreatorAgentBinding(
  userId: string,
  presetId: string,
  version: string,
): Promise<CreatorAgentBinding | null> {
  assertUserId(userId);
  if (!isIdentifier(presetId) || !isIdentifier(version)) throw new Error('creator_agent_binding_invalid');
  const file = await readBindingFile(userId, presetId, userCreatorAgentBindingFile(userId, presetId));
  const binding = file?.bindings.find((entry) => entry.version === version);
  return binding ? immutableBinding(binding) : null;
}

export async function findCreatorAgentBindingByAgentId(
  userId: string,
  agentId: string,
): Promise<CreatorAgentBinding | null> {
  assertUserId(userId);
  if (!isIdentifier(agentId)) throw new Error('creator_agent_binding_invalid');
  for (const file of await listBindingFiles(userId)) {
    const binding = file.bindings.find((entry) => entry.agentId === agentId);
    if (binding) return immutableBinding(binding);
  }
  return null;
}

export async function isCreatorPresetMaterialized(
  userId: string,
  presetId: string,
  version: string,
  manifestDigest: string,
): Promise<boolean> {
  if (typeof manifestDigest !== 'string' || !DIGEST.test(manifestDigest)) return false;
  const binding = await readCreatorAgentBinding(userId, presetId, version);
  return binding?.manifestDigest === manifestDigest;
}
