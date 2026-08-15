import type { LocalEvent } from '../local_agents/backends/base';
import {
  run as runLocalAgent,
  type RunCliAgentOpts,
  type RunCliAgentResult,
} from '../local_agents/runner';
import * as cliSessions from '../local_agents/sessions';
import { getAgentCliProjectDirInfo } from '../agents';
import { getWorkspacePath } from '../user_workspace';
import type { RuntimeEventEnvelope } from '../cogseed_runtime/protocol';
import type { MateLocalCliConfig } from './types';

const RESUME_REJECTED_PATTERNS = [
  /session\s+(?:not\s+found|expired|invalid|does\s+not\s+exist)/i,
  /unknown\s+(?:session|conversation|thread)/i,
  /cannot\s+resume/i,
  /failed\s+to\s+resume/i,
];

export interface MateLocalCliExecutionInput {
  userId: string;
  conversationId: string;
  agentId: string;
  agentName?: string;
  requestId: string;
  taskId: string;
  sessionId: string;
  runtimeSessionId: string;
  task: string;
  context?: unknown[];
  attachments?: unknown[];
  workingDir?: string;
  localCli: MateLocalCliConfig;
}

export interface MateLocalCliExecutionAdapter {
  run(input: MateLocalCliExecutionInput, opts?: { signal?: AbortSignal | null }): AsyncIterable<RuntimeEventEnvelope>;
}

export interface MateLocalCliExecutionAdapterDeps {
  runCli?: (opts: RunCliAgentOpts) => Promise<RunCliAgentResult>;
  getSessionId?: typeof cliSessions.getSessionId;
  setSessionId?: typeof cliSessions.setSessionId;
  clearSession?: typeof cliSessions.clearForAgent;
  resolveWorkingDir?: (input: MateLocalCliExecutionInput) => Promise<string>;
}

function promptFromInput(input: MateLocalCliExecutionInput): string {
  const parts = [input.task.trim()];
  const textContext = (input.context || [])
    .filter((item): item is { type: 'text'; content: string; label?: string } => (
      !!item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).content === 'string'
    ))
    .map((item) => `${item.label ? `## ${item.label}\n` : ''}${item.content.trim()}`)
    .filter(Boolean);
  if (textContext.length) parts.push('', ...textContext);
  const attachmentLines = (input.attachments || [])
    .filter((item): item is { type: 'file'; path: string; name?: string } => (
      !!item && typeof item === 'object' && (item as any).type === 'file' && typeof (item as any).path === 'string'
    ))
    .map((item) => `- ${item.name || 'attachment'}: ${item.path}`);
  if (attachmentLines.length) parts.push('', '## Attachments', ...attachmentLines);
  return parts.join('\n').trim();
}

async function defaultWorkingDir(input: MateLocalCliExecutionInput): Promise<string> {
  const chats = await import('../chats');
  const conversation = await chats.getConversation(input.userId, input.conversationId);
  const info = await getAgentCliProjectDirInfo(
    input.userId,
    input.agentId,
    conversation?.project_id || undefined,
  );
  return info?.effective_path || getWorkspacePath(input.userId, conversation?.project_id || undefined);
}

function resumeRejected(events: LocalEvent[]): boolean {
  return events.some((event) => (
    event.type === 'stderr-line'
    && typeof event.line === 'string'
    && RESUME_REJECTED_PATTERNS.some((pattern) => pattern.test(event.line as string))
  ));
}

function mapNonTerminalEvent(
  input: MateLocalCliExecutionInput,
  event: LocalEvent,
): RuntimeEventEnvelope | null {
  const base = { request_id: input.requestId, runtime_session_id: input.runtimeSessionId };
  if ((event.type === 'text-delta' || event.type === 'thinking') && typeof event.text === 'string' && event.text) {
    return { type: 'event', ...base, status: 'running', text: event.text };
  }
  if (event.type === 'tool-event') {
    const phase = event.phase === 'result' ? 'tool_result' : 'tool_call';
    return {
      type: 'event',
      ...base,
      status: 'running',
      metadata: {
        kernel_event: phase,
        ...(typeof event.tool === 'string' ? { name: event.tool } : {}),
        ...(phase === 'tool_result' ? { isError: event.isError === true } : {}),
      },
    };
  }
  if (event.type === 'idle' || event.type === 'status') {
    return {
      type: 'event',
      ...base,
      status: 'running',
      metadata: { kernel_event: 'cli_status', event: event.type },
    };
  }
  return null;
}

function terminalEnvelope(input: MateLocalCliExecutionInput, result: RunCliAgentResult): RuntimeEventEnvelope {
  const base = { request_id: input.requestId, runtime_session_id: input.runtimeSessionId };
  if (result.status === 'completed') {
    return { type: 'result', ...base, status: 'completed', text: result.output || '' };
  }
  if (result.status === 'cancelled') {
    return { type: 'error', ...base, status: 'cancelled', error: 'cancelled' };
  }
  return {
    type: 'error',
    ...base,
    status: 'failed',
    error: result.status === 'timeout' ? 'local CLI timed out' : 'local CLI execution failed',
    metadata: { code: result.status },
  };
}

export function createMateLocalCliExecutionAdapter(
  deps: MateLocalCliExecutionAdapterDeps = {},
): MateLocalCliExecutionAdapter {
  const runCli = deps.runCli ?? runLocalAgent;
  const getSessionId = deps.getSessionId ?? cliSessions.getSessionId;
  const setSessionId = deps.setSessionId ?? cliSessions.setSessionId;
  const clearSession = deps.clearSession ?? cliSessions.clearForAgent;
  const resolveWorkingDir = deps.resolveWorkingDir ?? defaultWorkingDir;

  return {
    async *run(input, opts = {}) {
      const signal = opts.signal ?? new AbortController().signal;
      const cwd = input.workingDir || await resolveWorkingDir(input);
      const prompt = promptFromInput(input);
      const resumeSessionId = await getSessionId(
        input.userId,
        input.conversationId,
        input.agentId,
        input.localCli.cli,
      );

      const runAttempt = async (resumeId?: string | null) => {
        const events: LocalEvent[] = [];
        const result = await runCli({
          uid: input.userId,
          cid: input.conversationId,
          agentId: input.agentId,
          agentName: input.agentName || input.localCli.agentName,
          cli: input.localCli.cli as RunCliAgentOpts['cli'],
          ...(input.localCli.model ? { model: input.localCli.model } : {}),
          ...(input.localCli.customArgs?.length ? { customArgs: input.localCli.customArgs } : {}),
          ...(input.localCli.cliProviderId ? { cliProviderId: input.localCli.cliProviderId } : {}),
          ...(resumeId ? { resumeSessionId: resumeId } : {}),
          prompt,
          cwd,
          signal,
          onEvent: (event) => { events.push(event); },
        });
        return { events, result };
      };

      let attempt = await runAttempt(resumeSessionId);
      if (resumeSessionId && resumeRejected(attempt.events)) {
        await clearSession(input.userId, input.conversationId, input.agentId);
        attempt = await runAttempt(null);
      }
      for (const event of attempt.events) {
        if (event.type === 'done' || event.type === 'stderr-line' || event.type === 'raw-line' || event.type === 'log') continue;
        const mapped = mapNonTerminalEvent(input, event);
        if (mapped) yield mapped;
      }
      if (attempt.result.sessionId) {
        await setSessionId(
          input.userId,
          input.conversationId,
          input.agentId,
          input.localCli.cli,
          attempt.result.sessionId,
        );
      }
      yield terminalEnvelope(input, attempt.result);
    },
  };
}

export const mateLocalCliExecutionAdapter = createMateLocalCliExecutionAdapter();
