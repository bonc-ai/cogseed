/**
 * Minimal Agent authorization reads shared by ordinary runtimes and host-owned
 * management surfaces. Keep this module free of Agent catalog, prompt, skill,
 * memory, session, project, and tool imports: it is loaded by every dispatch
 * choke point, including the isolated reimbursement stdio bridge.
 */

import * as crypto from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  agentDefinitionFile,
  packagedBuiltinDir,
  packagedResourcesRoot,
  userComponentEnabledFile,
  userCreatorAuditFile,
  userCreatorAgentBindingFile,
  userCreatorPresetStateFile,
  userMarketplaceAgentDir,
} from '../paths';
import { safeId } from '../storage';
import { verifyBuiltinContentManifest } from '../util/builtin-content-manifest.js';
import { CANONICAL_EXPENSE_WORKBENCH_AGENT_ID } from './expense_workbench/identity';
import {
  assertCreatorAgentBindingPathSafe,
  creatorBindingPolicyMatchesManifest,
  type CreatorAgentBindingPolicy,
} from './creator/agent-binding-store';
import { readCreatorPresetVersion } from './creator/store';
import { creatorManifestDigest } from './creator/verification-service';

export const MANAGEMENT_ONLY_AGENT_ERROR_CODE = 'E_AGENT_MANAGEMENT_ONLY';
export const AGENT_CHAT_UNAVAILABLE_ERROR_CODE = 'E_AGENT_CHAT_UNAVAILABLE';

export type AgentInteractionMode = 'management_only';

export interface AgentDispatchPolicy {
  enabled: boolean;
  interaction_mode?: AgentInteractionMode;
  /** Verified materialized Creator policy used by runtime construction. */
  creator_runtime?: CreatorAgentBindingPolicy;
}

export interface CreatorRuntimeExecutionOptions {
  toolAccess: 'read-only';
  toolAllowlist: string[];
  idleTimeout: number;
  streamIdleTimeout: number;
  maxOutputTokens?: number;
}

const CREATOR_READ_ONLY_TOOLS = [
  'read_file', 'stat_file', 'search_files', 'grep_files', 'list_files',
  'tool_result_search', 'tool_result_read_chunk',
] as const;

const CREATOR_CAPABILITY_TOOLS: Record<string, readonly string[]> = {
  'tool.search': ['web_search', 'web_fetch'],
  'tool.kb': ['kb_list', 'kb_search', 'kb_read'],
  'tool.office': ['office_read', 'office_render'],
  'tool.history': ['chat_search', 'chat_read'],
  'tool.recall': ['search_ability_assets'],
  'tool.ontology': ['personal_ontology_fields'],
  'tool.materials': ['ask_materials', 'material_list', 'material_search'],
};

const CREATOR_COST_TO_TOKEN_RATE = 1_000_000 / 8;

/**
 * Convert a verified Creator binding into the options understood by the real
 * model/tool runtime. The read-only baseline is deliberately fixed; declared
 * capabilities can add read-only tools, but permissions can never add a
 * write, shell, messaging, or remote side-effect tool.
 *
 * core-agent currently exposes token limits, not a cost-budget primitive. A
 * declared maxCost is therefore represented by a conservative token ceiling
 * (8 cost units per million output tokens) and intersected with maxTokens.
 * This keeps the cost dimension executable instead of treating it as metadata.
 */
export function creatorRuntimeExecutionOptions(
  policy: CreatorAgentBindingPolicy,
): CreatorRuntimeExecutionOptions {
  if (!policy || !policy.runtime || !policy.permissions
      || !Array.isArray(policy.permissions.files)
      || !Array.isArray(policy.permissions.sideEffects)
      || !Array.isArray(policy.permissions.tools)
      || policy.runtime.sandboxProfile !== 'creator-read-only-v1'
      || policy.permissions.files.some((grant) => grant !== 'workspace.readonly')
      || policy.permissions.sideEffects.length > 0) {
    throw new Error('creator_runtime_policy_not_read_only');
  }

  const tools = new Set<string>(CREATOR_READ_ONLY_TOOLS);
  const declaredCapabilities = new Set(policy.capabilityIds);
  for (const capabilityId of policy.permissions.tools) {
    // Network access is a separate Creator capability. Requiring the same
    // catalog capability in both the declared capability set and tool grant
    // keeps a stale/partial policy from widening the read-only baseline.
    if (capabilityId === 'tool.search' && !declaredCapabilities.has(capabilityId)) continue;
    for (const toolName of CREATOR_CAPABILITY_TOOLS[capabilityId] || []) tools.add(toolName);
  }

  const budget = policy.runtime.budget;
  let maxOutputTokens = budget.maxTokens;
  if (budget.maxCost !== undefined) {
    const costTokenLimit = Math.floor(budget.maxCost * CREATOR_COST_TO_TOKEN_RATE);
    if (costTokenLimit < 1) throw new Error('creator_runtime_cost_budget_unrepresentable');
    maxOutputTokens = maxOutputTokens === undefined
      ? costTokenLimit
      : Math.min(maxOutputTokens, costTokenLimit);
  }

  const timeoutSeconds = Math.max(1, Math.ceil(policy.runtime.timeoutMs / 1000));
  return {
    toolAccess: 'read-only',
    toolAllowlist: [...tools],
    idleTimeout: timeoutSeconds,
    streamIdleTimeout: timeoutSeconds,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

export interface CanonicalManagementAgentPolicy<
  AgentId extends string = string,
  ManagementSurface extends string = string,
  ReimbursementEntryRole extends string = string,
> extends AgentDispatchPolicy {
  agent_id: AgentId;
  source: 'marketplace';
  seed_source: 'builtin';
  enabled: true;
  management_surface: ManagementSurface;
  interaction_mode: 'management_only';
  reimbursement_entry_role: ReimbursementEntryRole;
}

interface AgentPolicySpec {
  agent_id?: unknown;
  interaction_mode?: unknown;
  management_surface?: unknown;
  reimbursement_entry_role?: unknown;
  creator_binding?: unknown;
  skill_list?: unknown;
  default_model?: unknown;
  runtime?: unknown;
  interface_contract?: unknown;
}

interface CreatorAgentProvenance {
  schemaVersion: 1;
  presetId: string;
  version: string;
  manifestDigest: string;
  materializationRevision: string;
}

interface BuiltinManifestFile {
  path?: unknown;
  bytes?: unknown;
  sha256?: unknown;
}

interface BuiltinManifest {
  schema?: unknown;
  files?: unknown;
}

interface ComponentEnabledPolicy {
  agents?: unknown;
}

interface ReadJsonResult {
  found: boolean;
  value: Record<string, unknown> | null;
}

interface CreatorLifecycleAuditRecord {
  auditId?: unknown;
  schemaVersion?: unknown;
  event?: unknown;
  createdAt?: unknown;
  presetId?: unknown;
  version?: unknown;
  metadata?: unknown;
}

const MAX_AGENT_POLICY_JSON_BYTES = 1024 * 1024;
const MAX_CREATOR_AUDIT_RECORDS = 4_096;

const CREATOR_LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const CREATOR_DIGEST = /^sha256:[a-f0-9]{64}$/;
const CREATOR_PROVENANCE_KEYS = new Set(['schemaVersion', 'presetId', 'version', 'manifestDigest', 'materializationRevision']);
const CREATOR_BINDING_KEYS = new Set(['schemaVersion', 'presetId', 'version', 'manifestDigest', 'agentId', 'materializedAt', 'materializationRevision', 'policy']);
const CREATOR_BINDING_FILE_KEYS = new Set(['schemaVersion', 'presetId', 'bindings']);
const CREATOR_STATE_KEYS = new Set(['schemaVersion', 'presetId', 'activeVersion', 'previousActiveVersion', 'updatedAt']);
const CREATOR_MODEL_KEYS = new Set(['providerId', 'modelId', 'reasoningProfile']);
const CREATOR_POLICY_KEYS = new Set(['model', 'skillIds', 'capabilityIds', 'runtime', 'permissions']);
const CREATOR_RUNTIME_KEYS = new Set(['sessionPolicy', 'memoryPolicy', 'loopPolicy', 'sandboxProfile', 'timeoutMs', 'budget']);
const CREATOR_BUDGET_KEYS = new Set(['maxCost', 'maxTokens']);
const CREATOR_PERMISSION_KEYS = new Set(['tools', 'files', 'sideEffects', 'approvalMode']);
const MAX_CREATOR_POLICY_ITEMS = 64;

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function creatorIdentifier(value: unknown): value is string {
  return typeof value === 'string' && CREATOR_LOGICAL_ID.test(value);
}

function validCreatorIdentifierArray(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_CREATOR_POLICY_ITEMS
    && value.every(creatorIdentifier) && new Set(value).size === value.length;
}

function validCreatorPolicy(value: unknown): boolean {
  if (!plainObject(value) || !exactKeys(value, CREATOR_POLICY_KEYS)) return false;
  if (!plainObject(value.model) || !exactKeys(value.model, CREATOR_MODEL_KEYS)
      || !creatorIdentifier(value.model.providerId) || !creatorIdentifier(value.model.modelId)
      || (value.model.reasoningProfile !== undefined && !creatorIdentifier(value.model.reasoningProfile))) return false;
  if (!plainObject(value.runtime) || !exactKeys(value.runtime, CREATOR_RUNTIME_KEYS)
      || (value.runtime.sessionPolicy !== 'new-per-run' && value.runtime.sessionPolicy !== 'resume-explicit')
      || (value.runtime.memoryPolicy !== 'none' && value.runtime.memoryPolicy !== 'read-only')
      || value.runtime.loopPolicy !== 'single-agent' || value.runtime.sandboxProfile !== 'creator-read-only-v1'
      || typeof value.runtime.timeoutMs !== 'number' || !Number.isSafeInteger(value.runtime.timeoutMs)
      || value.runtime.timeoutMs < 1 || value.runtime.timeoutMs > 30 * 60 * 1_000
      || !plainObject(value.runtime.budget) || !exactKeys(value.runtime.budget, CREATOR_BUDGET_KEYS)
      || (value.runtime.budget.maxCost !== undefined
        && (typeof value.runtime.budget.maxCost !== 'number' || !Number.isFinite(value.runtime.budget.maxCost)
          || value.runtime.budget.maxCost < 0 || value.runtime.budget.maxCost > 10_000))
      || (value.runtime.budget.maxTokens !== undefined
        && (typeof value.runtime.budget.maxTokens !== 'number' || !Number.isSafeInteger(value.runtime.budget.maxTokens)
          || value.runtime.budget.maxTokens < 1 || value.runtime.budget.maxTokens > 10_000_000))) return false;
  return plainObject(value.permissions) && exactKeys(value.permissions, CREATOR_PERMISSION_KEYS)
    && validCreatorIdentifierArray(value.permissions.tools)
    && validCreatorIdentifierArray(value.permissions.files)
    && validCreatorIdentifierArray(value.permissions.sideEffects)
    && ['always', 'on-risk', 'preapproved'].includes(String(value.permissions.approvalMode))
    && validCreatorIdentifierArray(value.skillIds)
    && validCreatorIdentifierArray(value.capabilityIds);
}

function creatorProvenance(value: unknown): CreatorAgentProvenance | null {
  if (!plainObject(value) || !exactKeys(value, CREATOR_PROVENANCE_KEYS)
      || Object.keys(value).length !== CREATOR_PROVENANCE_KEYS.size
      || value.schemaVersion !== 1 || !creatorIdentifier(value.presetId)
      || !creatorIdentifier(value.version) || typeof value.manifestDigest !== 'string'
      || !CREATOR_DIGEST.test(value.manifestDigest) || !creatorIdentifier(value.materializationRevision)) return null;
  return value as unknown as CreatorAgentProvenance;
}

async function hasLatestActiveCreatorLifecycle(
  userId: string,
  provenance: CreatorAgentProvenance,
): Promise<boolean> {
  const auditFile = userCreatorAuditFile(userId);
  try { await assertCreatorAgentBindingPathSafe(userId, auditFile); } catch { return false; }
  const records = await readBoundedJsonLines(auditFile);
  if (!records) return false;
  let latest: CreatorLifecycleAuditRecord | null = null;
  for (const record of records) {
    if (record.presetId !== provenance.presetId || record.version !== provenance.version) continue;
    if (record.event !== 'creator.lifecycle.published'
        && record.event !== 'creator.lifecycle.active'
        && record.event !== 'creator.lifecycle.disabled'
        && record.event !== 'creator.lifecycle.rolled_back') continue;
    if (Object.keys(record).some((key) => !new Set([
      'schemaVersion', 'auditId', 'event', 'createdAt', 'presetId', 'version', 'draftId', 'metadata',
    ]).has(key))
        || record.schemaVersion !== 1
        || !creatorIdentifier(record.auditId)
        || !creatorIdentifier(record.event)
        || typeof record.createdAt !== 'string'
        || !Number.isFinite(Date.parse(record.createdAt))
        || !creatorIdentifier(record.presetId)
        || !creatorIdentifier(record.version)
        || !plainObject(record.metadata)
        || typeof record.metadata.manifestDigest !== 'string'
        || !CREATOR_DIGEST.test(record.metadata.manifestDigest)) return false;
    latest = record;
  }
  return !!latest
    && latest.schemaVersion === 1
    && latest.event === 'creator.lifecycle.active'
    && plainObject(latest.metadata)
    && latest.metadata.manifestDigest === provenance.manifestDigest;
}

async function hasActiveCreatorBinding(
  userId: string,
  agentId: string,
  provenance: CreatorAgentProvenance,
  spec: AgentPolicySpec,
): Promise<CreatorAgentBindingPolicy | null> {
  const bindingFile = userCreatorAgentBindingFile(userId, provenance.presetId);
  try { await assertCreatorAgentBindingPathSafe(userId, bindingFile); } catch { return null; }
  const bindingResult = await readBoundedObjectJson(bindingFile);
  if (!bindingResult.found || !bindingResult.value || !exactKeys(bindingResult.value, CREATOR_BINDING_FILE_KEYS)
      || Object.keys(bindingResult.value).length !== CREATOR_BINDING_FILE_KEYS.size
      || bindingResult.value.schemaVersion !== 1 || bindingResult.value.presetId !== provenance.presetId
      || !Array.isArray(bindingResult.value.bindings)) return null;
  const versions = new Set<string>();
  const agents = new Set<string>();
  let matches = 0;
  let matchedPolicy: Record<string, unknown> | null = null;
  for (const value of bindingResult.value.bindings) {
    if (!plainObject(value) || !exactKeys(value, CREATOR_BINDING_KEYS)
        || Object.keys(value).length !== CREATOR_BINDING_KEYS.size || value.schemaVersion !== 1
        || value.presetId !== provenance.presetId || !creatorIdentifier(value.version)
        || typeof value.manifestDigest !== 'string' || !CREATOR_DIGEST.test(value.manifestDigest)
        || !creatorIdentifier(value.agentId) || typeof value.materializedAt !== 'string'
        || !Number.isFinite(Date.parse(value.materializedAt)) || !creatorIdentifier(value.materializationRevision)
        || !validCreatorPolicy(value.policy) || versions.has(value.version) || agents.has(value.agentId)) return null;
    versions.add(value.version);
    agents.add(value.agentId);
    if (value.version === provenance.version && value.manifestDigest === provenance.manifestDigest
        && value.agentId === agentId && value.materializationRevision === provenance.materializationRevision) {
      matches += 1;
      matchedPolicy = value.policy as Record<string, unknown>;
    }
  }
  if (matches !== 1) return null;
  if (!matchedPolicy || !Array.isArray(spec.skill_list)
      || spec.skill_list.some((skill) => !creatorIdentifier(skill))) return null;
  let manifest;
  try {
    manifest = await readCreatorPresetVersion(userId, provenance.presetId, provenance.version);
  } catch {
    return null;
  }
  if (!manifest || creatorManifestDigest(manifest) !== provenance.manifestDigest
      || !creatorBindingPolicyMatchesManifest(matchedPolicy as unknown as CreatorAgentBindingPolicy, manifest)) return null;
  const allowedSkills = new Set(matchedPolicy.skillIds as string[]);
  if (spec.skill_list.some((skill) => !allowedSkills.has(skill as string))) return null;
  const defaultModel = plainObject(spec.default_model) ? spec.default_model : null;
  if (!defaultModel || defaultModel.provider !== (matchedPolicy.model as Record<string, unknown>).providerId
      || defaultModel.model !== (matchedPolicy.model as Record<string, unknown>).modelId) return null;
  try {
    await assertCreatorAgentBindingPathSafe(
      userId,
      userCreatorPresetStateFile(userId, provenance.presetId),
    );
  } catch {
    return null;
  }
  const stateResult = await readBoundedObjectJson(userCreatorPresetStateFile(userId, provenance.presetId));
  if (!stateResult.found || !stateResult.value || !exactKeys(stateResult.value, CREATOR_STATE_KEYS)
      || stateResult.value.schemaVersion !== 1 || stateResult.value.presetId !== provenance.presetId
      || stateResult.value.activeVersion !== provenance.version) return null;
  if (stateResult.value.previousActiveVersion !== undefined && !creatorIdentifier(stateResult.value.previousActiveVersion)) return null;
  if (stateResult.value.updatedAt !== undefined
      && (typeof stateResult.value.updatedAt !== 'string' || !Number.isFinite(Date.parse(stateResult.value.updatedAt)))) return null;
  if (!await hasLatestActiveCreatorLifecycle(userId, provenance)) return null;
  if (spec.runtime !== undefined
      && (!plainObject(spec.runtime) || Object.keys(spec.runtime).length !== 1 || spec.runtime.kind !== 'in_process')) {
    return null;
  }
  if (spec.interface_contract !== undefined && !validCreatorInterfaceContract(spec.interface_contract)) return null;
  return matchedPolicy as unknown as CreatorAgentBindingPolicy;
}

function validCreatorInterfaceContract(value: unknown): boolean {
  if (!plainObject(value) || Object.keys(value).length !== 5
      || !exactKeys(value, new Set(['version', 'role', 'runtime', 'io', 'governance']))
      || value.version !== 1 || value.role !== 'cogseed_core') return false;
  if (!plainObject(value.runtime) || Object.keys(value.runtime).length !== 1
      || !exactKeys(value.runtime, new Set(['kind'])) || value.runtime.kind !== 'in_process') return false;
  if (!plainObject(value.io) || Object.keys(value.io).length !== 2
      || !exactKeys(value.io, new Set(['input', 'output'])) || value.io.input !== 'task_message'
      || (value.io.output !== 'final_message' && value.io.output !== 'final_message_with_artifacts')) return false;
  if (!plainObject(value.governance) || Object.keys(value.governance).length !== 5
      || !exactKeys(value.governance, new Set(['session_role', 'data_scope', 'uses_mate_skills', 'records_process', 'records_tool_evidence']))
      || (value.governance.session_role !== 'owner_capable')
      || (value.governance.data_scope !== 'visibility_slice'
        && value.governance.data_scope !== 'visibility_slice_with_workspace')
      || value.governance.uses_mate_skills !== true
      || value.governance.records_process !== true
      || value.governance.records_tool_evidence !== true) return false;
  return true;
}

/**
 * The reimbursement identity is reserved by the host and always remains
 * management-only. Its declarative file may further restrict access, but a
 * missing or misspelled field must never turn that fixed identity into an
 * ordinary chat Agent.
 *
 * Unknown values for every other identity retain the legacy ordinary-Agent
 * semantics used by normalizeAgent.
 */
export function normalizeAgentInteractionMode(
  value: unknown,
  agentId?: string | null,
): AgentInteractionMode | undefined {
  if (agentId === CANONICAL_EXPENSE_WORKBENCH_AGENT_ID) return 'management_only';
  return value === 'management_only' ? 'management_only' : undefined;
}

export function isAgentChatDispatchable(
  agent: AgentDispatchPolicy | null | undefined,
): boolean {
  return !!agent && agent.enabled !== false && agent.interaction_mode !== 'management_only';
}

async function readBoundedObjectJson(file: string): Promise<ReadJsonResult> {
  let entry: Stats;
  try {
    entry = await fsp.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false, value: null };
    return { found: true, value: null };
  }
  if (!entry.isFile() || entry.isSymbolicLink()
      || entry.size < 2 || entry.size > MAX_AGENT_POLICY_JSON_BYTES) {
    return { found: true, value: null };
  }

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(
      file,
      fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
    );
  } catch {
    return { found: true, value: null };
  }
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size !== entry.size
        || initial.dev !== entry.dev || initial.ino !== entry.ino) {
      return { found: true, value: null };
    }
    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const final = await handle.stat();
    if (offset !== bytes.length || final.size !== initial.size
        || final.dev !== initial.dev || final.ino !== initial.ino) {
      return { found: true, value: null };
    }
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { found: true, value: null };
    }
    return { found: true, value: parsed as Record<string, unknown> };
  } catch {
    return { found: true, value: null };
  } finally {
    await handle.close();
  }
}

async function readBoundedJsonLines(file: string): Promise<CreatorLifecycleAuditRecord[] | null> {
  let entry: Stats;
  try {
    entry = await fsp.lstat(file);
  } catch {
    return null;
  }
  if (!entry.isFile() || entry.isSymbolicLink()
      || entry.size < 2 || entry.size > MAX_AGENT_POLICY_JSON_BYTES) return null;

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(
      file,
      fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
    );
  } catch {
    return null;
  }
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size !== entry.size
        || initial.dev !== entry.dev || initial.ino !== entry.ino) return null;
    const text = await handle.readFile('utf8');
    const final = await handle.stat();
    if (final.size !== initial.size || final.dev !== initial.dev || final.ino !== initial.ino) return null;
    const lines = text.split('\n').filter((line) => line.length > 0);
    if (!text.endsWith('\n') || lines.length === 0 || lines.length > MAX_CREATOR_AUDIT_RECORDS) return null;
    return lines.map((line) => {
      const value: unknown = JSON.parse(line);
      if (!plainObject(value)) throw new Error('invalid audit record');
      return value as CreatorLifecycleAuditRecord;
    });
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

const CANONICAL_AGENT_RELATIVE_PATH = path.posix.join(
  'marketplace',
  'agents',
  CANONICAL_EXPENSE_WORKBENCH_AGENT_ID,
  'agent.json',
);
const verifiedBuiltinSpecs = new Map<string, AgentPolicySpec>();

async function readCanonicalBuiltinSpec(): Promise<AgentPolicySpec | null> {
  const builtinRoot = path.resolve(packagedBuiltinDir());
  const cached = verifiedBuiltinSpecs.get(builtinRoot);
  if (cached) return cached;

  let manifest: BuiltinManifest;
  try {
    manifest = verifyBuiltinContentManifest(builtinRoot, {
      // Source worktrees may contain ignored Python/macOS cache junk. The
      // packaged extraResources filters remove the same entries, so finding
      // them in an installed application is evidence of post-build drift.
      allowIgnoredJunk: packagedResourcesRoot() === null,
    }) as BuiltinManifest;
  } catch {
    return null;
  }
  if (manifest.schema !== 1 || !Array.isArray(manifest.files)) return null;
  const manifestFiles = manifest.files as BuiltinManifestFile[];
  const canonicalRows = manifestFiles.filter((row) => row?.path === CANONICAL_AGENT_RELATIVE_PATH);
  if (canonicalRows.length !== 1
      || !Number.isSafeInteger(canonicalRows[0].bytes)
      || typeof canonicalRows[0].sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(canonicalRows[0].sha256)) {
    return null;
  }
  const specFile = path.join(
    builtinRoot,
    ...CANONICAL_AGENT_RELATIVE_PATH.split('/'),
  );
  let specBytes: Buffer;
  try {
    specBytes = await fsp.readFile(specFile);
  } catch {
    return null;
  }
  if (specBytes.length !== canonicalRows[0].bytes
      || crypto.createHash('sha256').update(specBytes).digest('hex') !== canonicalRows[0].sha256) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(specBytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const spec = parsed as AgentPolicySpec;
    verifiedBuiltinSpecs.set(builtinRoot, spec);
    return spec;
  } catch {
    return null;
  }
}

async function readAgentEnabled(userId: string, agentId: string): Promise<boolean | null> {
  const result = await readBoundedObjectJson(userComponentEnabledFile(userId));
  if (!result.found) return true;
  if (!result.value) return null;
  const file = result.value as ComponentEnabledPolicy;
  if (result.value.version !== 1) return null;
  if (file.agents === undefined) return true;
  if (!file.agents || typeof file.agents !== 'object' || Array.isArray(file.agents)) return null;
  const overrides = file.agents as Record<string, unknown>;
  if (Object.values(overrides).some((value) => typeof value !== 'boolean')) return null;
  const override = overrides[agentId];
  return override === false ? false : true;
}

async function readAgentPolicySpec(
  userId: string,
  agentId: string,
): Promise<{ source: 'marketplace' | 'custom'; spec: AgentPolicySpec } | null> {
  const candidates = [
    {
      source: 'marketplace' as const,
      file: path.join(userMarketplaceAgentDir(userId, agentId), 'agent.json'),
    },
    { source: 'custom' as const, file: agentDefinitionFile(userId, agentId) },
  ];
  for (const candidate of candidates) {
    const result = await readBoundedObjectJson(candidate.file);
    if (!result.found) continue;
    if (!result.value || result.value.agent_id !== agentId) return null;
    return { source: candidate.source, spec: result.value as AgentPolicySpec };
  }
  return null;
}

/**
 * Reads only agent.json and the per-user enable override. Marketplace wins an
 * id collision, matching the full Agent catalog.
 */
export async function getAgentDispatchPolicy(
  userId: string,
  agentId: string | null | undefined,
): Promise<AgentDispatchPolicy | null> {
  if (!safeId(userId) || !safeId(agentId)) return null;
  const resolvedAgentId = agentId;
  const resolved = await readAgentPolicySpec(userId, resolvedAgentId);
  if (!resolved) return null;
  const enabled = await readAgentEnabled(userId, resolvedAgentId);
  if (enabled === null) return null;
  const interactionMode = normalizeAgentInteractionMode(
    resolved.spec.interaction_mode,
    resolvedAgentId,
  );
  let creatorRuntime: CreatorAgentBindingPolicy | null = null;
  if (resolved.spec.creator_binding !== undefined) {
    const provenance = creatorProvenance(resolved.spec.creator_binding);
    creatorRuntime = provenance && resolved.source === 'custom'
      ? await hasActiveCreatorBinding(userId, resolvedAgentId, provenance, resolved.spec)
      : null;
    if (!creatorRuntime) {
      return {
        enabled: false,
        ...(interactionMode ? { interaction_mode: interactionMode } : {}),
      };
    }
  }
  return {
    enabled,
    ...(interactionMode ? { interaction_mode: interactionMode } : {}),
    ...(creatorRuntime ? { creator_runtime: creatorRuntime } : {}),
  };
}

export async function assertAgentChatDispatchable(
  userId: string,
  agentId: string | null | undefined,
): Promise<void> {
  const policy = await getAgentDispatchPolicy(userId, agentId);
  if (isAgentChatDispatchable(policy)) return;
  throw Object.assign(
    new Error('Agent is unavailable for ordinary chat dispatch.'),
    {
      code: policy?.interaction_mode === 'management_only'
        ? MANAGEMENT_ONLY_AGENT_ERROR_CODE
        : AGENT_CHAT_UNAVAILABLE_ERROR_CODE,
    },
  );
}

export interface CanonicalManagementAgentRequirements<
  AgentId extends string,
  ManagementSurface extends string,
  ReimbursementEntryRole extends string,
> {
  agentId: AgentId;
  managementSurface: ManagementSurface;
  reimbursementEntryRole: ReimbursementEntryRole;
}

/**
 * Validate a host-owned management entry without loading the Agent catalog.
 * Identity and management semantics come exclusively from the release-gated
 * builtin resource tree. The user install proves presence only; its agent.json
 * and optional `_install.json` can never establish host provenance.
 */
export async function getCanonicalManagementAgentPolicy<
  const AgentId extends string,
  const ManagementSurface extends string,
  const ReimbursementEntryRole extends string,
>(
  userId: string,
  requirements: CanonicalManagementAgentRequirements<AgentId, ManagementSurface, ReimbursementEntryRole>,
): Promise<CanonicalManagementAgentPolicy<AgentId, ManagementSurface, ReimbursementEntryRole> | null> {
  if (!safeId(userId) || !safeId(requirements.agentId)) return null;
  const { agentId } = requirements;
  const marketplaceDir = userMarketplaceAgentDir(userId, agentId);
  const [hostSpec, installResult, enabled] = await Promise.all([
    readCanonicalBuiltinSpec(),
    readBoundedObjectJson(path.join(marketplaceDir, 'agent.json')),
    readAgentEnabled(userId, agentId),
  ]);
  if (!hostSpec || !installResult.found || !installResult.value) return null;
  if (enabled !== true) return null;
  const installedSpec = installResult.value as AgentPolicySpec;
  if (installedSpec.agent_id !== agentId
      || hostSpec.agent_id !== agentId
      || hostSpec.management_surface !== requirements.managementSurface
      || normalizeAgentInteractionMode(hostSpec.interaction_mode) !== 'management_only'
      || hostSpec.reimbursement_entry_role !== requirements.reimbursementEntryRole) {
    return null;
  }
  return {
    agent_id: agentId,
    source: 'marketplace',
    seed_source: 'builtin',
    enabled: true,
    management_surface: requirements.managementSurface,
    interaction_mode: 'management_only',
    reimbursement_entry_role: requirements.reimbursementEntryRole,
  };
}
