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
  userMarketplaceAgentDir,
} from '../paths';
import { safeId } from '../storage';
import { verifyBuiltinContentManifest } from '../util/builtin-content-manifest.js';
import { CANONICAL_EXPENSE_WORKBENCH_AGENT_ID } from './expense_workbench/identity';

export const MANAGEMENT_ONLY_AGENT_ERROR_CODE = 'E_AGENT_MANAGEMENT_ONLY';
export const AGENT_CHAT_UNAVAILABLE_ERROR_CODE = 'E_AGENT_CHAT_UNAVAILABLE';

export type AgentInteractionMode = 'management_only';

export interface AgentDispatchPolicy {
  enabled: boolean;
  interaction_mode?: AgentInteractionMode;
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

const MAX_AGENT_POLICY_JSON_BYTES = 1024 * 1024;

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
  return {
    enabled,
    ...(interactionMode ? { interaction_mode: interactionMode } : {}),
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
