import type { Agent, AgentRuntime } from '../agents';
import { isAgentEnabled } from '../component_enabled';
import { assertCogSeedAgentId, assertCogSeedConversationId, assertCogSeedUserId } from './paths';
import type { RuntimeTextContext } from '../cogseed_runtime/protocol';
import {
  deriveAgentEligibilityFacts,
  findAgentCliEntry,
  findAgentPeer,
  isCogSeedAgentRuntimeSupported,
  resolveAgentEligibility,
  type CogSeedAgentCliEntryFacts,
  type CogSeedAgentEligibilityReason,
  type CogSeedAgentPeerFacts,
} from './agent-eligibility';

const MAX_AGENT_CONTEXT_CHARS = 24_000;

export { isCogSeedAgentRuntimeSupported };

/** Prefix for the stable IPC code carried by an admission rejection. */
export const COGSEED_AGENT_ADMISSION_CODE_PREFIX = 'E_AGENT_ADMISSION_';
/** Used when the rejection has no more specific reason. */
export const COGSEED_AGENT_ADMISSION_CODE = 'E_AGENT_ADMISSION';

export function cogSeedAgentAdmissionCode(reasonCode?: CogSeedAgentEligibilityReason): string {
  return reasonCode
    ? `${COGSEED_AGENT_ADMISSION_CODE_PREFIX}${reasonCode.toUpperCase()}`
    : COGSEED_AGENT_ADMISSION_CODE;
}

/**
 * Admission rejections carry the same machine reason the Run Center registry
 * projection reports, so the two surfaces can never disagree about *why* an
 * Agent is unusable.
 *
 * `code` is what actually reaches the renderer: the invoke handler copies
 * `Error.code` into the `{ ok: false, error, code }` envelope, and the Run
 * Center's invoke wrapper copies it back onto the rejection. The message stays
 * human-readable for logs and for any surface without a mapping — nothing
 * decides behaviour by reading it.
 */
export class CogSeedAgentAdmissionError extends Error {
  readonly reasonCode?: CogSeedAgentEligibilityReason;
  readonly code: string;

  constructor(message: string, reasonCode?: CogSeedAgentEligibilityReason) {
    super(message);
    this.name = 'CogSeedAgentAdmissionError';
    if (reasonCode) this.reasonCode = reasonCode;
    this.code = cogSeedAgentAdmissionCode(reasonCode);
  }
}

function agentUnavailable(reasonCode?: CogSeedAgentEligibilityReason): CogSeedAgentAdmissionError {
  return new CogSeedAgentAdmissionError('CogSeed Agent is unavailable', reasonCode);
}

export interface CogSeedAgentExecutionContext {
  agentId: string;
  agentName: string;
  workflow: string;
  skillList?: string[];
  interactive: true;
  runtime: AgentRuntime;
  description?: string;
  role?: string;
  knowhow: string[];
  standards: string[];
}

export interface ResolveCogSeedAgentExecutionContextDeps {
  getAgentForChatDispatch?: (userId: string, agentId: string) => Promise<Agent | null>;
  isAgentEnabled?: (userId: string, agentId: string) => boolean;
  /** Host discovery, read only when the Agent's runtime makes install or
   *  reachability a real variable. In-process Agents never trigger these. */
  listCliEntries?: () => Promise<readonly CogSeedAgentCliEntryFacts[]>;
  listPeers?: () => Promise<readonly CogSeedAgentPeerFacts[]>;
}

async function hostEligibilityFacts(
  agentId: string,
  runtime: AgentRuntime,
  deps: ResolveCogSeedAgentExecutionContextDeps,
): Promise<{ cli: CogSeedAgentCliEntryFacts | undefined; peer: CogSeedAgentPeerFacts | undefined }> {
  // An in-process Agent has no install to detect and no peer to reach, so the
  // discovery facade is never loaded on the common dispatch path.
  if (runtime.kind === 'in_process') return { cli: undefined, peer: undefined };
  const host = deps.listCliEntries && deps.listPeers
    ? null
    : await import('../cogseed-agent-registry-host');
  const [cliEntries, peers] = await Promise.all([
    deps.listCliEntries?.() ?? host!.listCogSeedHostCliEntries(),
    deps.listPeers?.() ?? host!.listCogSeedHostPeers(),
  ]);
  return {
    cli: findAgentCliEntry(cliEntries, runtime),
    peer: findAgentPeer(peers, agentId, runtime),
  };
}

/**
 * `getAgentForChatDispatch` returns null for several distinct policy outcomes.
 * Read the policy back — only on the rejection path — so the caller learns which
 * one it was instead of receiving an undifferentiated "unavailable".
 */
async function missingAgentReason(
  userId: string,
  agentId: string,
  deps: ResolveCogSeedAgentExecutionContextDeps,
): Promise<CogSeedAgentEligibilityReason | undefined> {
  if (deps.getAgentForChatDispatch) return undefined;
  try {
    const policy = await (await import('../agents')).getAgentDispatchPolicy(userId, agentId);
    if (!policy) return undefined;
    if (policy.interaction_mode === 'management_only') return 'management_only';
    if (policy.enabled === false) return 'disabled';
  } catch { /* the reason is a diagnostic; never let it mask the rejection */ }
  return undefined;
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)));
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export async function resolveCogSeedAgentExecutionContext(
  userId: string,
  agentId: string,
  conversationId: string,
  deps: ResolveCogSeedAgentExecutionContextDeps = {},
): Promise<CogSeedAgentExecutionContext> {
  assertCogSeedUserId(userId);
  const safeAgentId = assertCogSeedAgentId(agentId);
  assertCogSeedConversationId(conversationId);
  const enabled = deps.isAgentEnabled ?? isAgentEnabled;
  if (!enabled(userId, safeAgentId)) throw agentUnavailable('disabled');
  // `getAgentForChatDispatch` applies the host dispatch policy (per-user enable
  // plus management-only identities). It stays the authority for those; the
  // shared resolver below adds the conditions this gate never checked.
  const load = deps.getAgentForChatDispatch ?? (await import('../agents')).getAgentForChatDispatch;
  const agent = await load(userId, safeAgentId);
  if (!agent || agent.agent_id !== safeAgentId) {
    throw agentUnavailable(await missingAgentReason(userId, safeAgentId, deps));
  }
  const runtime = agent.runtime ?? { kind: 'in_process' as const };
  const { cli, peer } = await hostEligibilityFacts(safeAgentId, runtime, deps);
  const eligibility = resolveAgentEligibility(deriveAgentEligibilityFacts({
    enabled: agent.enabled !== false,
    interactionMode: agent.interaction_mode,
    runtime,
    cli,
    peer,
  }));
  if (!eligibility.dispatchable) {
    throw eligibility.reasonCode === 'unsupported_runtime'
      ? new CogSeedAgentAdmissionError('CogSeed Agent runtime is not executable', 'unsupported_runtime')
      : agentUnavailable(eligibility.reasonCode);
  }
  const skillList = agent.skill_list === undefined ? undefined : cleanList(agent.skill_list);
  return {
    agentId: safeAgentId,
    agentName: String(agent.name || safeAgentId).trim() || safeAgentId,
    workflow: String(agent.workflow || '').trim(),
    ...(skillList !== undefined ? { skillList } : {}),
    interactive: true,
    runtime,
    ...(String(agent.description_en || agent.description_zh || '').trim()
      ? { description: String(agent.description_en || agent.description_zh).trim() }
      : {}),
    ...(String(agent.profile?.role || '').trim() ? { role: String(agent.profile?.role).trim() } : {}),
    knowhow: cleanList(agent.profile?.knowhow),
    standards: cleanList(agent.profile?.standards),
  };
}

export function buildCogSeedAgentRuntimeContext(
  input: CogSeedAgentExecutionContext,
): RuntimeTextContext[] {
  const sections = [
    `Agent identity: ${input.agentName} (${input.agentId})`,
    input.role ? `Role:\n${input.role}` : '',
    input.description ? `Description:\n${input.description}` : '',
    input.workflow ? `Workflow instructions:\n${input.workflow}` : '',
    input.knowhow.length ? `Know-how:\n${input.knowhow.map((item) => `- ${item}`).join('\n')}` : '',
    input.standards.length ? `Standards:\n${input.standards.map((item) => `- ${item}`).join('\n')}` : '',
    input.skillList === undefined
      ? 'Skill scope: legacy unfiltered persisted Agent scope.'
      : input.skillList.length
        ? `Allowed skill ids:\n${input.skillList.map((item) => `- ${item}`).join('\n')}`
        : 'Allowed skill ids: none.',
    'Interaction mode: interactive. Preserve this Agent identity across follow-up turns until explicit handback or abort.',
  ].filter(Boolean).join('\n\n');
  return [{
    type: 'text',
    label: 'Formal Agent execution context',
    content: clip(sections, MAX_AGENT_CONTEXT_CHARS),
  }];
}
