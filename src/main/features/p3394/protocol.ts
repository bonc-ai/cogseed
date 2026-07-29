import type { Agent, AgentInterfaceContract } from '../agents';
import * as path from 'node:path';
import { readJsonl, safeId } from '../../storage';

export type P3394Relationship = 'owner' | 'administrator' | 'peer' | 'client' | 'anonymous';
export type P3394SpeechAct = 'request' | 'command' | 'query' | 'configure' | 'delegate' | 'negotiate';

export interface P3394ServicePrincipal {
  person: string;
  org: string;
  role: string;
}

export interface P3394CollaborationRef {
  workflow_run_id: string;
  context_id: string;
  context_revision: number;
  step_id?: string;
  conflict_ids?: string[];
}

export interface P3394DelegationContext {
  original_principal: P3394ServicePrincipal;
  original_relationship: P3394Relationship;
  delegation_chain: Array<{
    delegator: string;
    delegate: string;
    inherited_relationship: P3394Relationship;
  }>;
}

export interface P3394LiteManifest {
  version: 1;
  agent_id: string;
  name: string;
  channels: Array<{
    id: string;
    scope: string;
    channel: 'group_chat' | 'cli';
    principal_source: 'mate_user' | 'orkas_runtime';
    security: { inbound: { mode: 'implicit' } };
  }>;
  service_principal: { schema: { person: string; org: string; role: string } };
  channel_adapter: { responsibilities: string[] };
  handle_message: { canonical_form: 'umf-lite'; input_forms: string[] };
  relationships: Array<{
    name: P3394Relationship;
    capability_access: 'all' | { include: string[]; exclude?: string[] };
    allowed_speech_acts: 'unrestricted' | P3394SpeechAct[];
  }>;
  capability: {
    name: 'handle_message';
    declarations: Array<{
      name: string;
      input_schema: string;
      output_schema: string;
      semantic_block_spec: P3394SemanticBlockPolicy;
    }>;
  };
  semantic_block_constraints: { policies: Record<string, P3394SemanticBlockPolicy> };
  session: { mode: 'session'; ownership: { role: AgentInterfaceContract['governance']['session_role'] }; tagging: { correlation_id: true } };
  conformance: { p3394_level: 2; p3394_version: 'p3394-lite-mvp/1'; normative_interface: 'handle_message' };
}

export interface P3394SemanticBlockPolicy {
  max_embedding_depth: number;
  allowed_formats: string[];
  allow_executable_blocks: boolean;
  max_semantic_blocks_per_message: number;
}

export interface P3394LiteMessage {
  message_id: string;
  sender: string;
  recipient: string;
  message_type: string;
  correlation_id: string;
  canonical_session_id: string;
  parent_session_id: string | null;
  timestamp: string;
  content_type: 'application/json' | 'text/plain';
  body: unknown;
  metadata: {
    service_principal: P3394ServicePrincipal;
    relationship: P3394Relationship;
    security_context_level: 'standard';
    invoked_capability: string;
    semantic_block_contract: P3394SemanticBlockPolicy;
    session_lifecycle: 'open';
    session_owner: P3394ServicePrincipal;
    session_epoch: number;
    delegation_context?: P3394DelegationContext;
    collaboration?: P3394CollaborationRef;
  };
}

export interface P3394AgentError {
  message_id: string;
  sender: string;
  recipient: string;
  message_type: 'agent.error';
  correlation_id: string;
  canonical_session_id: string;
  timestamp: string;
  content_type: 'application/json';
  body: {
    reason_code: 'unknown_capability' | 'speech_act_denied' | 'semantic_block_violation';
    detail: string;
    original_message_id: string;
  };
}

export type P3394NormalizeResult =
  | { ok: true; message: P3394LiteMessage }
  | { ok: false; error: P3394AgentError };

export interface P3394ProtocolEventRecord {
  conversation_id: string;
  message_id: string;
  agent_id: string;
  turn_id?: string;
  index: number;
  data: Record<string, unknown>;
}

const ADAPTER_RESPONSIBILITIES = [
  'listen',
  'extract_channel_unique_id',
  'validate_security',
  'resolve_service_principal',
  'resolve_relationship',
  'validate_semantic_blocks',
  'normalize_to_umf',
  'deliver_to_handle_message',
];

function normalizeCollaborationRef(value: unknown): P3394CollaborationRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const workflowRunId = typeof raw.workflow_run_id === "string" ? raw.workflow_run_id.trim() : "";
  const contextId = typeof raw.context_id === "string" ? raw.context_id.trim() : "";
  const revision = raw.context_revision;
  if (!safeId(workflowRunId) || !safeId(contextId) || !Number.isSafeInteger(revision) || Number(revision) < 0) return undefined;
  const stepId = typeof raw.step_id === "string" && safeId(raw.step_id.trim()) ? raw.step_id.trim() : undefined;
  const conflictIds = Array.isArray(raw.conflict_ids)
    ? Array.from(new Set(raw.conflict_ids.filter((id): id is string => typeof id === "string" && safeId(id.trim())).map((id) => id.trim()))).slice(-5)
    : undefined;
  return {
    workflow_run_id: workflowRunId,
    context_id: contextId,
    context_revision: Number(revision),
    ...(stepId ? { step_id: stepId } : {}),
    ...(conflictIds?.length ? { conflict_ids: conflictIds } : {}),
  };
}

const STANDARD_SEMANTIC_POLICY: P3394SemanticBlockPolicy = {
  max_embedding_depth: 3,
  allowed_formats: ['text', 'markdown', 'json'],
  allow_executable_blocks: false,
  max_semantic_blocks_per_message: 20,
};

const MINIMAL_SEMANTIC_POLICY: P3394SemanticBlockPolicy = {
  max_embedding_depth: 1,
  allowed_formats: ['text'],
  allow_executable_blocks: false,
  max_semantic_blocks_per_message: 1,
};

const RELATIONSHIP_SPEECH_ACTS: Record<P3394Relationship, 'unrestricted' | P3394SpeechAct[]> = {
  owner: 'unrestricted',
  administrator: ['request', 'command', 'query', 'configure'],
  peer: ['request', 'query', 'delegate', 'negotiate'],
  client: ['request', 'query'],
  anonymous: ['query'],
};

function agentContract(agent: Agent): AgentInterfaceContract {
  return agent.interface_contract || {
    version: 1,
    role: agent.runtime?.kind === 'cli' ? 'external_expert' : 'orkas_core',
    runtime: agent.runtime?.kind === 'cli' ? { kind: 'cli', cli: agent.runtime.cli } : { kind: 'in_process' },
    io: { input: 'task_message', output: 'final_message' },
    governance: {
      session_role: agent.runtime?.kind === 'cli' ? 'participant_only' : 'owner_capable',
      data_scope: 'visibility_slice_with_workspace',
      uses_mate_skills: agent.runtime?.kind !== 'cli',
      records_process: true,
      records_tool_evidence: true,
    },
  };
}

export function buildP3394Level2Manifest(agent: Agent): P3394LiteManifest {
  const contract = agentContract(agent);
  const channels: P3394LiteManifest['channels'] = [{
    id: agent.agent_id,
    scope: 'mate-agent://group_chat/',
    channel: 'group_chat',
    principal_source: 'mate_user',
    security: { inbound: { mode: 'implicit' } },
  }];
  if (contract.runtime.kind === 'cli') {
    channels.push({
      id: contract.runtime.cli,
      scope: '$PATH',
      channel: 'cli',
      principal_source: 'orkas_runtime',
      security: { inbound: { mode: 'implicit' } },
    });
  }

  return {
    version: 1,
    agent_id: agent.agent_id,
    name: agent.name || agent.agent_id,
    channels,
    service_principal: { schema: { person: 'mate user or agent uri', org: 'workspace', role: 'runtime role' } },
    channel_adapter: { responsibilities: ADAPTER_RESPONSIBILITIES },
    handle_message: { canonical_form: 'umf-lite', input_forms: ['task_message'] },
    relationships: [
      { name: 'owner', capability_access: 'all', allowed_speech_acts: 'unrestricted' },
      { name: 'administrator', capability_access: { include: ['handle_message', 'session_management'] }, allowed_speech_acts: RELATIONSHIP_SPEECH_ACTS.administrator },
      { name: 'peer', capability_access: { include: ['handle_message', 'session_management'] }, allowed_speech_acts: RELATIONSHIP_SPEECH_ACTS.peer },
      { name: 'client', capability_access: { include: ['handle_message'] }, allowed_speech_acts: RELATIONSHIP_SPEECH_ACTS.client },
      { name: 'anonymous', capability_access: { include: [] }, allowed_speech_acts: RELATIONSHIP_SPEECH_ACTS.anonymous },
    ],
    capability: {
      name: 'handle_message',
      declarations: [
        { name: 'handle_message', input_schema: 'task_message', output_schema: contract.io.output, semantic_block_spec: STANDARD_SEMANTIC_POLICY },
        { name: 'session_management', input_schema: 'session.*', output_schema: 'session.response', semantic_block_spec: MINIMAL_SEMANTIC_POLICY },
      ],
    },
    semantic_block_constraints: { policies: { standard: STANDARD_SEMANTIC_POLICY, minimal: MINIMAL_SEMANTIC_POLICY } },
    session: { mode: 'session', ownership: { role: contract.governance.session_role }, tagging: { correlation_id: true } },
    conformance: { p3394_level: 2, p3394_version: 'p3394-lite-mvp/1', normative_interface: 'handle_message' },
  };
}

export function assessP3394Level2Readiness(manifest: P3394LiteManifest): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!manifest.channels?.length) missing.push('channels');
  if (manifest.channel_adapter?.responsibilities?.length !== ADAPTER_RESPONSIBILITIES.length) missing.push('channel_adapter.responsibilities');
  if (!manifest.service_principal?.schema) missing.push('service_principal.schema');
  if (!manifest.relationships?.length) missing.push('relationships');
  if (!manifest.capability?.declarations?.some((d) => d.name === 'handle_message')) missing.push('capability.handle_message');
  if (!manifest.semantic_block_constraints?.policies?.standard) missing.push('semantic_block_constraints.standard');
  if (manifest.session?.mode !== 'session' || manifest.session?.tagging?.correlation_id !== true) missing.push('session.correlation_id');
  return { ok: missing.length === 0, missing };
}

function relationshipAllowsSpeechAct(relationship: P3394Relationship, speechAct: P3394SpeechAct): boolean {
  const allowed = RELATIONSHIP_SPEECH_ACTS[relationship];
  return allowed === 'unrestricted' || allowed.includes(speechAct);
}

// 关系权限等级（与 RELATIONSHIP_SPEECH_ACTS 的层级一致）。用于委托链校验：
// 委托只能平级或降级，不得抬高（防提权）。
const RELATIONSHIP_RANK: Record<P3394Relationship, number> = {
  anonymous: 0,
  client: 1,
  peer: 2,
  administrator: 3,
  owner: 4,
};

const MAX_DELEGATION_HOPS = 5;

/**
 * 委托链准入校验（改法 2）：把 delegation_chain 从「只记录」升级为「先审后放」。
 * 三条规则：
 *   1. 只降不升 —— 每一跳继承的 relationship 不得高于 original_relationship（防提权）。
 *   2. 防环 —— delegate 不得是链中已出现过的 delegator（防 A→B→A 循环委托）。
 *   3. 限长 —— 链长不得超过 MAX_DELEGATION_HOPS（防无限膨胀）。
 * 不改任何数据，仅返回是否放行 + 原因。
 */
function validateDelegation(d: P3394DelegationContext): { ok: boolean; detail?: string } {
  const chain = d.delegation_chain || [];
  if (chain.length > MAX_DELEGATION_HOPS) {
    return { ok: false, detail: `delegation chain too long (${chain.length} > ${MAX_DELEGATION_HOPS})` };
  }
  const originRank = RELATIONSHIP_RANK[d.original_relationship];
  const seen = new Set<string>();
  for (const hop of chain) {
    if (RELATIONSHIP_RANK[hop.inherited_relationship] > originRank) {
      return { ok: false, detail: `delegation escalation: ${hop.inherited_relationship} exceeds original ${d.original_relationship}` };
    }
    if (seen.has(hop.delegate)) {
      return { ok: false, detail: `delegation cycle detected at ${hop.delegate}` };
    }
    seen.add(hop.delegator);
  }
  return { ok: true };
}

function relationshipAllowsCapability(manifest: P3394LiteManifest, relationship: P3394Relationship, capability: string): boolean {
  const rel = manifest.relationships.find((r) => r.name === relationship);
  if (!rel) return false;
  if (rel.capability_access === 'all') return true;
  return rel.capability_access.include.includes(capability) && !(rel.capability_access.exclude || []).includes(capability);
}

function containsExecutableBlock(body: unknown): boolean {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return /```\s*(bash|sh|zsh|powershell|cmd|python|javascript|typescript|js|ts)\b/i.test(text || '');
}

function makeError(input: NormalizeP3394AgentMessageInput, reason: P3394AgentError['body']['reason_code'], detail: string): P3394AgentError {
  const messageId = `p3394-${input.conversationId}-${input.turnId}`;
  return {
    message_id: `${messageId}-error`,
    sender: input.agent.agent_id,
    recipient: input.sender,
    message_type: 'agent.error',
    correlation_id: input.conversationId,
    canonical_session_id: input.conversationId,
    timestamp: new Date().toISOString(),
    content_type: 'application/json',
    body: { reason_code: reason, detail, original_message_id: messageId },
  };
}

export interface NormalizeP3394AgentMessageInput {
  agent: Agent;
  conversationId: string;
  turnId: string;
  sender: string;
  senderPrincipal: P3394ServicePrincipal;
  relationship: P3394Relationship;
  speechAct: P3394SpeechAct;
  capability: string;
  body: unknown;
  parentSessionId?: string | null;
  delegation?: P3394DelegationContext;
  collaboration?: P3394CollaborationRef;
}

export function normalizeP3394AgentMessage(input: NormalizeP3394AgentMessageInput): P3394NormalizeResult {
  const manifest = buildP3394Level2Manifest(input.agent);
  if (!relationshipAllowsCapability(manifest, input.relationship, input.capability)) {
    return { ok: false, error: makeError(input, 'unknown_capability', `Relationship ${input.relationship} cannot use ${input.capability}.`) };
  }
  if (!relationshipAllowsSpeechAct(input.relationship, input.speechAct)) {
    return { ok: false, error: makeError(input, 'speech_act_denied', `Relationship ${input.relationship} cannot use speech act ${input.speechAct}.`) };
  }
  if (containsExecutableBlock(input.body)) {
    return { ok: false, error: makeError(input, 'semantic_block_violation', 'Message contains an executable semantic block.') };
  }
  if (input.delegation) {
    const dv = validateDelegation(input.delegation);
    if (!dv.ok) {
      return { ok: false, error: makeError(input, 'speech_act_denied', dv.detail || 'delegation rejected') };
    }
  }

  const collaboration = normalizeCollaborationRef(input.collaboration);
  const messageId = `p3394-${input.conversationId}-${input.turnId}`;
  const sessionOwner = input.agent.interface_contract?.governance.session_role === 'participant_only'
    ? input.senderPrincipal
    : { person: input.agent.agent_id, org: 'mate-agent', role: 'session_owner' };
  const message: P3394LiteMessage = {
    message_id: messageId,
    sender: input.sender,
    recipient: input.agent.agent_id,
    message_type: `agent.handle_message.${input.speechAct}`,
    correlation_id: input.conversationId,
    canonical_session_id: input.conversationId,
    parent_session_id: input.parentSessionId ?? null,
    timestamp: new Date().toISOString(),
    content_type: typeof input.body === 'string' ? 'text/plain' : 'application/json',
    body: input.body,
    metadata: {
      service_principal: input.senderPrincipal,
      relationship: input.relationship,
      security_context_level: 'standard',
      invoked_capability: input.capability,
      semantic_block_contract: STANDARD_SEMANTIC_POLICY,
      session_lifecycle: 'open',
      session_owner: sessionOwner,
      session_epoch: 0,
      ...(input.delegation ? { delegation_context: input.delegation } : {}),
      ...(collaboration ? { collaboration } : {}),
    },
  };
  return { ok: true, message };
}

export async function listP3394ProtocolEvents(uid: string, conversationId: string): Promise<P3394ProtocolEventRecord[]> {
  if (!safeId(uid)) throw new Error('invalid user id');
  if (!safeId(conversationId)) throw new Error('invalid conversation id');
  const paths = await import('../../paths');
  const file = path.join(paths.userChatsDir(uid), `${conversationId}.jsonl`);
  const rows = await readJsonl<Record<string, unknown>>(file, 0);
  const out: P3394ProtocolEventRecord[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const processItems = Array.isArray(row.process) ? row.process : [];
    for (let index = 0; index < processItems.length; index += 1) {
      const item = processItems[index];
      const itemObj = item && typeof item === 'object' ? item as Record<string, unknown> : null;
      const event = itemObj?.event && typeof itemObj.event === 'object' ? itemObj.event as Record<string, unknown> : null;
      if (event?.stream !== 'p3394') continue;
      const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? event.data as Record<string, unknown>
        : {};
      out.push({
        conversation_id: conversationId,
        message_id: typeof row.id === 'string' ? row.id : '',
        agent_id: typeof row.from === 'string' ? row.from : '',
        ...(typeof row.turn_id === 'string' ? { turn_id: row.turn_id } : {}),
        index,
        data,
      });
    }
  }
  return out;
}
