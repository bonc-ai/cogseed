import {
  getAgentForChatDispatch,
  type Agent,
  type AgentRuntime,
} from '../agents';
import { isAgentEnabled } from '../component_enabled';
import { assertMateAgentId, assertMateConversationId, assertMateUserId } from './paths';
import type { RuntimeTextContext } from '../cogseed_runtime/protocol';

const MAX_AGENT_CONTEXT_CHARS = 24_000;

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
  assertMateUserId(userId);
  const safeAgentId = assertMateAgentId(agentId);
  assertMateConversationId(conversationId);
  const enabled = deps.isAgentEnabled ?? isAgentEnabled;
  if (!enabled(userId, safeAgentId)) throw new Error('CogSeed Agent is unavailable');
  const load = deps.getAgentForChatDispatch ?? getAgentForChatDispatch;
  const agent = await load(userId, safeAgentId);
  if (!agent || agent.agent_id !== safeAgentId) throw new Error('CogSeed Agent is unavailable');
  const skillList = agent.skill_list === undefined ? undefined : cleanList(agent.skill_list);
  return {
    agentId: safeAgentId,
    agentName: String(agent.name || safeAgentId).trim() || safeAgentId,
    workflow: String(agent.workflow || '').trim(),
    ...(skillList !== undefined ? { skillList } : {}),
    interactive: true,
    runtime: agent.runtime ?? { kind: 'in_process' },
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
