import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Agent, AgentRuntime } from '../agents';
import { isAgentEnabled } from '../component_enabled';
import { assertCogSeedAgentId, assertCogSeedConversationId, assertCogSeedUserId } from './paths';
import type { RuntimeTextContext } from '../cogseed_runtime/protocol';

const MAX_AGENT_CONTEXT_CHARS = 24_000;
const COGSEED_EXECUTABLE_CLI_RUNTIMES = new Set([
  'claude',
  'codex',
  'openclaw',
  'opencode',
  'hermes',
  'workbuddy',
]);

export function isCogSeedAgentRuntimeSupported(runtime: AgentRuntime | null | undefined): boolean {
  return !runtime || runtime.kind === 'in_process' || COGSEED_EXECUTABLE_CLI_RUNTIMES.has(runtime.cli);
}

export interface CogSeedAgentExecutionContext {
  agentId: string;
  agentName: string;
  workflow: string;
  skillList?: string[];
  skillInstructions?: RuntimeTextContext[];
  /** Workspace-local AGENTS.md / CLAUDE.md, already clipped and trusted by selection. */
  workspaceInstructions?: RuntimeTextContext[];
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
  getWorkspacePath?: (userId: string, conversationId: string) => Promise<string>;
}

const WORKSPACE_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
const MAX_WORKSPACE_INSTRUCTION_CHARS = 16_000;

async function readWorkspaceInstructions(workspaceRoot: string): Promise<RuntimeTextContext[]> {
  const out: RuntimeTextContext[] = [];
  for (const name of WORKSPACE_INSTRUCTION_FILES) {
    const file = path.join(workspaceRoot, name);
    try {
      const content = await fs.readFile(file, 'utf8');
      const trimmed = content.trim();
      if (!trimmed) continue;
      out.push({
        type: 'text',
        label: `Workspace instructions: ${name}`,
        content: clip(trimmed, MAX_WORKSPACE_INSTRUCTION_CHARS),
      });
    } catch {
      // Missing/unreadable instruction files are normal.
    }
  }
  return out;
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
  if (!enabled(userId, safeAgentId)) throw new Error('CogSeed Agent is unavailable');
  const load = deps.getAgentForChatDispatch ?? (await import('../agents')).getAgentForChatDispatch;
  const agent = await load(userId, safeAgentId);
  if (!agent || agent.agent_id !== safeAgentId) throw new Error('CogSeed Agent is unavailable');
  const runtime = agent.runtime ?? { kind: 'in_process' as const };
  if (!isCogSeedAgentRuntimeSupported(runtime)) throw new Error('CogSeed Agent runtime is not executable');
  let workspacePath: string | undefined;
  try {
    workspacePath = deps.getWorkspacePath
      ? await deps.getWorkspacePath(userId, conversationId)
      : await (await import('../group_chat/conv_workspace')).getConversationWorkspacePath(userId, conversationId);
  } catch {
    workspacePath = undefined;
  }

  const skillList = agent.skill_list === undefined ? undefined : cleanList(agent.skill_list);
  const skillInstructions: RuntimeTextContext[] = [];
  if (skillList?.length) {
    const skills = await import('../skills');
    const available = await skills.listSkillsForUser(userId, workspacePath ? { cwd: workspacePath } : {});
    for (const id of skillList) {
      const skill = available.find(item => item.id === id && item.enabled);
      if (!skill) continue;
      const source = skill.workspaceRoot && id.startsWith('ws-')
        ? await skills.readWorkspaceSkillFile(skill.workspaceRoot, id)
        : await skills.readSkillFileForUser(userId, skill.source, id);
      if (source.ok && source.content.length <= 32_000) skillInstructions.push({
        type: 'text', label: `Authorized skill instructions: ${id}`,
        content: `The host has read this SKILL.md for this execution. Use these instructions directly; do not search for or reread the same skill.\n\n${source.content}`,
      });
    }
  }
  const workspaceInstructions = workspacePath ? await readWorkspaceInstructions(workspacePath) : [];

  return {
    agentId: safeAgentId,
    agentName: String(agent.name || safeAgentId).trim() || safeAgentId,
    workflow: String(agent.workflow || '').trim(),
    ...(skillList !== undefined ? { skillList } : {}),
    ...(skillInstructions.length ? { skillInstructions } : {}),
    ...(workspaceInstructions.length ? { workspaceInstructions } : {}),
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
    input.workflow.includes('transcript_glossary_apply')
      ? 'Runtime prerequisite: correction must finish before any deliverable writes or successful completion. Tool failures, an empty glossary, incomplete review or unconfirmed corrections STOP the workflow. Never fall back to raw-transcript minutes or create a placeholder corrected transcript. Read the source, scan and apply first; preserve the raw source and corrected file after correction succeeds. This boundary overrides legacy downgrade instructions below.'
      : '',
    input.role ? `Role:\n${input.role}` : '',
    input.description ? `Description:\n${input.description}` : '',
    input.workflow ? `Workflow instructions:\n${input.workflow}` : '',
    ...(input.workspaceInstructions || []).map((instruction) => instruction.content),
    input.knowhow.length ? `Know-how:\n${input.knowhow.map((item) => `- ${item}`).join('\n')}` : '',
    input.standards.length ? `Standards:\n${input.standards.map((item) => `- ${item}`).join('\n')}` : '',
    input.skillList === undefined
      ? 'Skill scope: legacy unfiltered persisted Agent scope.'
      : input.skillList.length
        ? `Allowed skill ids:\n${input.skillList.map((item) => `- ${item}`).join('\n')}`
        : 'Allowed skill ids: none.',
    'Interaction mode: interactive. Preserve this Agent identity across follow-up turns until explicit handback or abort.',
    'When asking the user for a decision, end with <agent-result status="waiting_input" />. Do not report success or hand back while awaiting a decision. A submitted correction card already authorizes exactly its selected changes; apply them and proceed to the requested deliverable without asking for the same correction confirmation again. On later confirmation, reuse the existing deliverable and acknowledge it; do not regenerate it unless the user requests a revision. Read each needed skill once and reuse available tool results.',
  ].filter(Boolean).join('\n\n');
  return [{
    type: 'text',
    label: 'Formal Agent execution context',
    content: clip(sections, MAX_AGENT_CONTEXT_CHARS),
  }, ...(input.skillInstructions ?? [])];
}
