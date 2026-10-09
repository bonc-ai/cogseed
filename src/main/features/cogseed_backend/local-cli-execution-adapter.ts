import type { LocalEvent } from '../local_agents/backends/base';
import * as fs from 'node:fs';
import {
  run as runLocalAgent,
  type RunCliAgentOpts,
  type RunCliAgentResult,
} from '../local_agents/runner';
import * as cliSessions from '../local_agents/sessions';
import { getAgentCliProjectDirInfo } from '../agents';
import { getWorkspacePath } from '../user_workspace';
import type { RuntimeEventEnvelope } from '../cogseed_runtime/protocol';
import type { CogSeedLocalCliConfig } from './types';
import type { CogSeedExecutionProcessHealth } from './runtime-health-watchdog';

const RESUME_REJECTED_PATTERNS = [
  /session\s+(?:not\s+found|expired|invalid|does\s+not\s+exist)/i,
  /unknown\s+(?:session|conversation|thread)/i,
  /cannot\s+resume/i,
  /failed\s+to\s+resume/i,
];

export interface CogSeedLocalCliExecutionInput {
  userId: string;
  conversationId: string;
  agentId: string;
  agentName?: string;
  requestId: string;
  taskId: string;
  executionId?: string;
  sessionId: string;
  runtimeSessionId: string;
  task: string;
  context?: unknown[];
  attachments?: unknown[];
  workingDir?: string;
  abilityAssetIds?: string[];
  localCli: CogSeedLocalCliConfig;
}

export interface CogSeedLocalCliExecutionAdapter {
  run(input: CogSeedLocalCliExecutionInput, opts?: { signal?: AbortSignal | null }): AsyncIterable<RuntimeEventEnvelope>;
  probeProcess?(input: Pick<CogSeedLocalCliExecutionInput, 'taskId' | 'executionId'>): Promise<CogSeedExecutionProcessHealth>;
}

export interface CogSeedLocalCliExecutionAdapterDeps {
  runCli?: (opts: RunCliAgentOpts) => Promise<RunCliAgentResult>;
  getSessionId?: typeof cliSessions.getSessionId;
  setSessionId?: typeof cliSessions.setSessionId;
  clearSession?: typeof cliSessions.clearForAgent;
  resolveWorkingDir?: (input: CogSeedLocalCliExecutionInput) => Promise<string>;
  probePid?: (pid: number) => CogSeedExecutionProcessHealth | Promise<CogSeedExecutionProcessHealth>;
}

interface LocalCliProcessRecord {
  executionId?: string;
  pid?: number;
  settled: boolean;
}

function defaultProbePid(pid: number): CogSeedExecutionProcessHealth {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'invalid';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ESRCH') return 'missing';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function promptFromInput(input: CogSeedLocalCliExecutionInput): string {
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

async function resolveWorkingDirForAgent(input: Pick<CogSeedLocalCliExecutionInput, 'userId' | 'conversationId' | 'agentId'>): Promise<string> {
  const chats = await import('../chats');
  const conversation = await chats.getConversation(input.userId, input.conversationId);
  const projectId = conversation?.project_id || undefined;
  // 空间会话：cwd 进空间工作区（spaces/<sid>/workspace/<slug>），与内置
  // 智能体 / group_chat CLI 分支一致 —— 保证空间隔离 + 空间产物扫描
  // 能收到 CLI 产出。agent 详情页显式自定义目录仍优先。
  const info = await getAgentCliProjectDirInfo(input.userId, input.agentId, projectId);
  if (info?.custom_path && info.exists) return info.effective_path;
  const sid = conversation ? (conversation as { space_id?: unknown }).space_id : undefined;
  if (typeof sid === 'string' && sid) {
    const { getConversationWorkspacePath } = await import('../group_chat/conv_workspace');
    const ws = await getConversationWorkspacePath(input.userId, input.conversationId);
    // CLI spawn 要求 cwd 已存在（conv_workspace 惰性 mkdir 只覆盖产出工具路径；
    // 空间会话 CLI 派发若此前只有对话没有产出，目录不存在会 spawn ENOENT）。
    try {
      fs.mkdirSync(ws, { recursive: true });
    } catch { /* mkdir 失败由 spawn 环节报错兜底 */ }
    return ws;
  }
  return info?.effective_path || getWorkspacePath(input.userId, projectId);
}

export async function resolveCogSeedLocalCliWorkingDir(
  input: Pick<CogSeedLocalCliExecutionInput, 'userId' | 'conversationId' | 'agentId'>,
): Promise<string> {
  return resolveWorkingDirForAgent(input);
}

async function defaultWorkingDir(input: CogSeedLocalCliExecutionInput): Promise<string> {
  return resolveWorkingDirForAgent(input);
}

function resumeRejected(events: LocalEvent[]): boolean {
  return events.some((event) => (
    event.type === 'stderr-line'
    && typeof event.line === 'string'
    && RESUME_REJECTED_PATTERNS.some((pattern) => pattern.test(event.line as string))
  ));
}

function mapNonTerminalEvent(
  input: CogSeedLocalCliExecutionInput,
  event: LocalEvent,
): RuntimeEventEnvelope | null {
  const base = { request_id: input.requestId, runtime_session_id: input.runtimeSessionId };
  if ((event.type === 'text-delta' || event.type === 'thinking') && typeof event.text === 'string' && event.text) {
    return { type: 'event', ...base, status: 'running', text: event.text };
  }
  if (event.type === 'tool-event') {
    const phase = event.phase === 'result' ? 'tool_result' : 'tool_call';
    const toolErrorText = event.isError === true && typeof event.output === 'string'
      ? event.output.trim()
      : '';
    return {
      type: 'event',
      ...base,
      status: 'running',
      metadata: {
        kernel_event: phase,
        ...(typeof event.tool === 'string' ? { name: event.tool } : {}),
        ...(typeof event.callId === 'string' && event.callId ? { call_id: event.callId } : {}),
        ...(phase === 'tool_result' ? { isError: event.isError === true } : {}),
        ...(phase === 'tool_result' && toolErrorText ? { error: toolErrorText.slice(0, 2000) } : {}),
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

function terminalEnvelope(input: CogSeedLocalCliExecutionInput, result: RunCliAgentResult): RuntimeEventEnvelope {
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

export function createCogSeedLocalCliExecutionAdapter(
  deps: CogSeedLocalCliExecutionAdapterDeps = {},
): CogSeedLocalCliExecutionAdapter {
  const runCli = deps.runCli ?? runLocalAgent;
  const getSessionId = deps.getSessionId ?? cliSessions.getSessionId;
  const setSessionId = deps.setSessionId ?? cliSessions.setSessionId;
  const clearSession = deps.clearSession ?? cliSessions.clearForAgent;
  const resolveWorkingDir = deps.resolveWorkingDir ?? defaultWorkingDir;
  const probePid = deps.probePid ?? defaultProbePid;
  const processes = new Map<string, LocalCliProcessRecord>();

  return {
    async probeProcess(input) {
      const record = processes.get(input.taskId);
      if (!record || record.executionId !== input.executionId) return 'unknown';
      if (record.settled) return 'missing';
      if (record.pid === undefined) return 'unknown';
      return probePid(record.pid);
    },
    async *run(input, opts = {}) {
      // 统一执行路径：P3394 外接智能体（viaP3394Gateway）走托管 gateway
      // （UMF 信封），与对话分派共用同一条协议轨，事件语义映射到 Runtime
      // 事件流（task store / recall 语义保持不变）。
      if (input.localCli.viaP3394Gateway) {
        yield* runViaP3394Gateway(input, opts);
        return;
      }
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
          ...(input.executionId ? { executionId: input.executionId } : {}),
          agentName: input.agentName || input.localCli.agentName,
          cli: input.localCli.cli as RunCliAgentOpts['cli'],
          ...(input.localCli.model ? { model: input.localCli.model } : {}),
          ...(input.localCli.customArgs?.length ? { customArgs: input.localCli.customArgs } : {}),
          ...(input.localCli.cliProviderId ? { cliProviderId: input.localCli.cliProviderId } : {}),
          ...(resumeId ? { resumeSessionId: resumeId } : {}),
          prompt,
          cwd,
          signal,
          onEvent: (event) => {
            if (event.type === 'process-info') {
              const pid = typeof event.pid === 'number' ? event.pid : undefined;
              processes.set(input.taskId, {
                ...(input.executionId ? { executionId: input.executionId } : {}),
                ...(pid !== undefined ? { pid } : {}),
                settled: false,
              });
            }
            events.push(event);
          },
        });
        return { events, result };
      };

      let attempt = await runAttempt(resumeSessionId);
      if (resumeSessionId && resumeRejected(attempt.events)) {
        await clearSession(input.userId, input.conversationId, input.agentId);
        attempt = await runAttempt(null);
      }
      const processRecord = processes.get(input.taskId);
      if (processRecord && processRecord.executionId === input.executionId) processRecord.settled = true;
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

export const cogseedLocalCliExecutionAdapter = createCogSeedLocalCliExecutionAdapter();

/**
 * P3394 外接智能体的执行（wake 路径）：经 runP3394GatewayTurn 走托管
 * gateway 节点——与对话分派(p3394-gateway-turn)复用同一实现。gateway
 * 离线时按需自愈（recoverGateway），事件/错误分类都在 gateway-turn 内完成。
 * 产物仍以 RuntimeEventEnvelope 流返回，保持 task/event/recall 语义。
 */
async function* runViaP3394Gateway(
  input: CogSeedLocalCliExecutionInput,
  opts: { signal?: AbortSignal | null } = {},
): AsyncIterable<RuntimeEventEnvelope> {
  const base = { request_id: input.requestId, runtime_session_id: input.runtimeSessionId };
  const prompt = promptFromInput(input);
  const { runP3394GatewayTurn } = await import('../p3394_bridge/p3394-gateway-turn');
  const runningEvents: Array<{ text: string }> = [];
  let wakeConsumer: (() => void) | undefined;
  let settled = false;
  let result: Awaited<ReturnType<typeof runP3394GatewayTurn>> | undefined;
  let runError: unknown;
  const notifyConsumer = (): void => {
    const wake = wakeConsumer;
    wakeConsumer = undefined;
    wake?.();
  };
  const turn = runP3394GatewayTurn({
      uid: input.userId,
      cid: input.conversationId,
      agent: { agent_id: input.agentId, name: input.agentName || input.localCli.agentName || input.agentId },
      ...(input.executionId ? { executionId: input.executionId } : {}),
      cli: input.localCli.cli,
      prompt,
      ...(input.workingDir ? { workingDir: input.workingDir } : {}),
      signal: opts.signal ?? undefined,
      onProcess: (data) => {
        const typed = data as { type?: string; text?: string };
        if (typed.type === 'delta' && typeof typed.text === 'string' && typed.text) {
          runningEvents.push({ text: typed.text });
          notifyConsumer();
        }
      },
    })
    .then((value) => { result = value; })
    .catch((error: unknown) => { runError = error; })
    .finally(() => {
      settled = true;
      notifyConsumer();
    });

  while (!settled || runningEvents.length > 0) {
    const item = runningEvents.shift();
    if (item) {
      yield { type: 'event', ...base, status: 'running', text: item.text };
      continue;
    }
    if (!settled) {
      await new Promise<void>((resolve) => {
        if (settled || runningEvents.length > 0) resolve();
        else wakeConsumer = resolve;
      });
    }
  }
  await turn;
  if (runError) {
    yield { type: 'error', ...base, status: 'failed', error: runError instanceof Error ? runError.message : String(runError) };
    return;
  }
  if (!result) {
    yield { type: 'error', ...base, status: 'failed', error: 'p3394 gateway execution ended without a result' };
    return;
  }
  if (result.failureCode || result.error) {
    yield {
      type: 'error',
      ...base,
      status: 'failed',
      error: result.error || result.failureCode || 'p3394 gateway execution failed',
      metadata: result.failureCode ? { code: result.failureCode, p3394: true } : { p3394: true },
    };
    return;
  }
  // 用量/模型自报（runP3394GatewayTurn 的 metrics：usage + CLI 自报 model）随
  // 终态信封透传——runtime-controller → group-chat-projection → 落库 metrics。
  // 丢了它，exec 路径（wake→task→exec 投影）的回合用量与回读校验全空。
  yield {
    type: 'result',
    ...base,
    status: 'completed',
    text: result.text,
    ...((result as { metrics?: unknown }).metrics
      ? { metadata: { metrics: (result as { metrics?: unknown }).metrics } }
      : {}),
  };
}
