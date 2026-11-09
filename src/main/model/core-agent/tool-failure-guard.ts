/**
 * Host-side failure classification and turn-count circuit breaker for tool results.
 *
 * Why this exists
 * ---------------
 * core-agent's runner already *detects* permanent tool failures: a result with
 * `isError: true` and no `recoverable` mark increments `permanentToolErrors`
 * (`core-agent/src/agent/runner.ts:1500-1502`), and this host already *collects*
 * that count (`model/core-agent/client.ts:745-746,849-850`). Nothing, however,
 * *decides* anything from it. A deterministic failure — a missing role template,
 * an invalid argument shape, a denied policy — therefore travels back to the
 * model as ordinary evidence, and the turn keeps re-trying variations of the
 * same dead end until it burns its budget or compacts its context.
 *
 * Observed 2026-10-12: a report-writing rule was routed into the personal
 * ontology field channel, the channel answered "no role template installed, do
 * not guess field names" as *plain content*, and the run kept searching instead
 * of stopping or asking the user.
 *
 * Design boundaries
 * -----------------
 *   - Turn-count semantics only. No wall-clock budget, no idle override: the
 *     existing idle/watchdog path stays the single owner of time-based stops.
 *   - Network failures are never counted (`transient`), so retry behaviour stays
 *     network-specific and owned by the existing retry path.
 *   - Pure logic: no I/O, no logging, no timers. Callers pass observations in and
 *     act on the decision. That keeps it unit-testable and keeps the wiring in
 *     `model/core-agent/runner.ts` explicit.
 *
 * Recovery contract
 * -----------------
 * Three failures of the same tool/declared target/error within twelve effective
 * observations stop a dead end. Six errors without any success remain a fallback
 * against hopping between unrelated failures. A successful matching operation
 * retires its failure groups; unrelated reads cannot erase a repeated dead end.
 * Network/result-retrieval control errors consume neither counter nor window.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

export type ToolFailureKind =
  | 'missing_dependency'
  | 'missing_user_input'
  | 'invalid_args'
  | 'policy_denied'
  | 'transient'
  | 'unclassified';

export interface ToolFailureClassification {
  kind: ToolFailureKind;
  /** Stable, log-safe identifier for the classified failure. */
  code: string;
}

/**
 * Ordered table: the first match wins. Order matters — a message that mentions
 * both a network error and a policy hint must classify as the more specific one,
 * and transient detection has to run before generic argument patterns so a
 * "Request timed out" is never counted as a deterministic dead end.
 */
const FAILURE_PATTERNS: Array<{ kind: ToolFailureKind; code: string; test: RegExp }> = [
  {
    kind: 'transient',
    code: 'transient_network',
    test: /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|rate limit|too many requests|\b429\b|\b50[234]\b|request timed out|timed out/i,
  },
  {
    kind: 'policy_denied',
    code: 'policy_denied',
    test: /_DENIED\b|permission denied|not allowed|forbidden|sandbox|权限不足|拒绝访问|被策略拒绝/i,
  },
  {
    kind: 'missing_dependency',
    code: 'missing_dependency',
    test: /没有可填字段|尚未安装|未安装|not installed|missing (dependency|template)|ENOENT.*(template|model)|角色模板/i,
  },
  {
    kind: 'missing_user_input',
    code: 'missing_user_input',
    test: /缺少.{0,6}(信息|参数|输入)|请(用户)?提供|需要用户|waiting for user|please provide|user input required/i,
  },
  {
    kind: 'invalid_args',
    code: 'invalid_args',
    test: /at most one in_progress|必须是|只能是|取值范围|不能为空|invalid |unresolved variable|E_BASH_DYNAMIC_PATH_UNSUPPORTED|unsupported variable/i,
  },
];

/** Read the leading error envelope, never an error code quoted in recovery text. */
function leadingErrorCode(content: string): string | undefined {
  return content.trim().match(/^(?:<tool-error\s+code=["'])?(E_[A-Z][A-Z0-9_]*)(?=["':\s>]|$)/)?.[1];
}

/** Classify a failed tool result's message. Never throws; unknown shapes fall
 *  back to `unclassified`, which still counts toward the breaker — bounded
 *  retries are the point, not perfect taxonomy. */
export function classifyToolFailure(content: string): ToolFailureClassification {
  const text = typeof content === 'string' ? content : String(content ?? '');
  const recoveryCode = leadingErrorCode(text);
  if (recoveryCode && ['E_NOT_READ', 'E_STALE', 'E_BAD_INPUT', 'E_NO_MATCH'].includes(recoveryCode)) return { kind: 'invalid_args', code: recoveryCode };
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.test.test(text)) return { kind: pattern.kind, code: pattern.code };
  }
  return { kind: 'unclassified', code: 'tool_error_unclassified' };
}

/** Recovery hint per kind — the third part of a tripped reason. */
const RECOVERY_BY_KIND: Record<ToolFailureKind, string> = {
  missing_dependency: '先补齐缺失的依赖（例如安装角色模板），或改走不依赖它的通道',
  missing_user_input: '向用户提一个最小问题补齐信息后重试，不要用其它工具绕开',
  invalid_args: '按报错修正参数或路径，不要重复同一调用',
  policy_denied: '请用户放开所需权限，或改用被允许的路径',
  transient: '等待既有网络重试路径处理，不要改变工具或参数',
  unclassified: '停止重试，向用户说明失败工具与现象并询问下一步',
};

export interface ToolFailureObservation {
  tool: string;
  content: string;
  isError: boolean;
  /** Used only for bounded local grouping, never exposed in receipts. */
  input?: unknown;
  workingDir?: string;
}

export type ToolFailureDecision =
  | { action: 'continue' }
  | {
      action: 'endTurn';
      kind: ToolFailureKind;
      code: string;
      /** cause + last progress + recovery, in that order. */
      reason: string;
      countedFailures: number;
    };

export interface ToolFailureGuard {
  observe(observation: ToolFailureObservation): ToolFailureDecision;
  snapshot(): { sameKindStreak: number; countedFailures: number; lastProgress: string };
}

export interface ToolFailureGuardOptions {
  /** Failures of one tool/target/error inside the recovery window. */
  maxSameKind?: number;
  /** Counted failures without a successful observation that trip the breaker. */
  maxTotal?: number;
}

const DEFAULT_MAX_SAME_KIND = 3;
const DEFAULT_MAX_TOTAL = 6;
const PROGRESS_EXCERPT_CHARS = 120;
const RECOVERY_WINDOW = 12;

/** Select declared resource identity, not replacement text or expected hashes:
 * changing the attempted correction must not buy an unbounded retry budget.
 * Unknown tools conservatively share a tool-level target. Connector actions are
 * separate operations, and common resource identifiers inside args are scoped.
 * Hashing keeps retained state bounded and avoids retaining raw arguments. */
function operationKey(observation: ToolFailureObservation): string {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const input = object(observation.input);
  const identities: unknown[] = [observation.tool];
  let resource = input;
  if (observation.tool === 'call_connector_tool') {
    identities.push(typeof input.connector_id === 'string' ? input.connector_id : '',
      typeof input.tool_name === 'string' ? input.tool_name : '');
    let args = input.args;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    resource = object(args);
  }
  const resourceFields = ['edit_file', 'write_file', 'read_file', 'stat_file'].includes(observation.tool)
    ? [['path']] // These tools use only path; ignored fields cannot split retries.
    : [
    ['path', 'file_path', 'filePath', 'target_path'],
    ['url', 'uri'],
    ['id', 'resource_id', 'note_id', 'reminder_id'],
    ['target'],
  ];
  for (const aliases of resourceFields) {
    const field = aliases.find(key => typeof resource[key] === 'string' || typeof resource[key] === 'number');
    if (!field) continue;
    const value = resource[field];
    identities.push(aliases[0], aliases[0] === 'path' && typeof value === 'string'
      ? path.resolve(observation.workingDir || '.', value) : value);
  }
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}

function excerpt(text: string): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > PROGRESS_EXCERPT_CHARS ? `${flat.slice(0, PROGRESS_EXCERPT_CHARS)}…` : flat;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

/**
 * Create a per-turn breaker. One instance per run: state is deliberately not
 * shared across turns so a recovered turn starts clean.
 */
export function createToolFailureGuard(options: ToolFailureGuardOptions = {}): ToolFailureGuard {
  const maxSameKind = positiveInt(options.maxSameKind, DEFAULT_MAX_SAME_KIND);
  const maxTotal = positiveInt(options.maxTotal, DEFAULT_MAX_TOTAL);

  let observationIndex = 0;
  const groups = new Map<string, { operation: string; attempts: number[] }>();
  let sameKindStreak = 0;
  let countedFailures = 0;
  let lastProgress = '本轮尚无成功步骤';

  const api: ToolFailureGuard = {
    observe(observation: ToolFailureObservation): ToolFailureDecision {
      const content = typeof observation?.content === 'string' ? observation.content : '';
      const tool = String(observation?.tool || 'tool');

      // Excluded control/network errors neither age nor erase recovery state.
      if (observation?.isError && /\bE_RESULT_[A-Z_]+\b/.test(content)) return { action: 'continue' };
      const { kind, code } = classifyToolFailure(content);
      if (observation?.isError && kind === 'transient') return { action: 'continue' };

      observationIndex += 1;
      for (const [key, group] of groups) {
        group.attempts = group.attempts.filter(index => observationIndex - index < RECOVERY_WINDOW);
        if (!group.attempts.length) groups.delete(key);
      }
      const operation = operationKey(observation);
      if (!observation?.isError) {
        // Successful edits clear their own failures. A successful prerequisite
        // read clears the global no-progress budget but not failed edit groups.
        for (const [key, group] of groups) if (group.operation === operation) groups.delete(key);
        if (COGNITION_READ_TOOLS.has(tool)) ontologyWriteBlocks.get(api)?.delete(tool);
        countedFailures = 0;
        sameKindStreak = 0;
        lastProgress = `${tool} 成功：${excerpt(content) || '(无输出)'}`;
        return { action: 'continue' };
      }

      const errorIdentity = leadingErrorCode(content) ?? code;
      const key = `${operation}:${errorIdentity}`;
      const group = groups.get(key) ?? { operation, attempts: [] };
      group.attempts.push(observationIndex);
      groups.set(key, group);
      sameKindStreak = group.attempts.length;
      countedFailures += 1;
      if (COGNITION_READ_TOOLS.has(tool)) {
        // P1-3: remember WHY, so the blocked write can quote the real failure.
        const blocks = ontologyWriteBlocks.get(api) ?? new Map<string, string>();
        blocks.set(tool, `确定性读取失败已阻断后续本体写入（${tool} → ${code}）：${excerpt(content)}`);
        ontologyWriteBlocks.set(api, blocks);
      }

      if (sameKindStreak >= maxSameKind || countedFailures >= maxTotal) {
        return {
          action: 'endTurn',
          kind,
          code,
          reason: describeToolFailure({ kind, code, tool, content, sameKindStreak, countedFailures, lastProgress }),
          countedFailures,
        };
      }
      return { action: 'continue' };
    },

    snapshot() {
      return { sameKindStreak, countedFailures, lastProgress };
    },
  };
  return api;
}

/** The tripped reason, always cause → last progress → recovery. */
export function describeToolFailure(input: {
  kind: ToolFailureKind;
  code: string;
  tool: string;
  content: string;
  sameKindStreak: number;
  countedFailures: number;
  lastProgress: string;
}): string {
  const cause = `工具 ${input.tool} 在恢复窗口内同一目标与错误出现 ${input.sameKindStreak} 次确定性失败`
    + `（${input.code}）：${excerpt(input.content)}`;
  const progress = `最近一次有效进展：${input.lastProgress}`;
  const recovery = `建议：${RECOVERY_BY_KIND[input.kind]}`
    + `（距最近成功步骤已计 ${input.countedFailures} 次确定性失败，未包含网络类重试）`;
  return `${cause}；${progress}；${recovery}`;
}

/** Minimal structural shape this module needs from an agent tool. */
export interface GuardableTool {
  readonly name: string;
  readonly executionMode?: 'sequential' | 'parallel';
  execute(input: never, ctx: never): Promise<unknown>;
}

/**
 * Cognition reads whose deterministic failure must block a following ontology write.
 * Failure groups alone cannot prevent a model that answers a
 * failed read by switching tool (`cognition_ontology_query` → `create_cognition
 * (ontology)`) from writing anyway. P1-3: a deterministic read
 * failure is a dead end, so writes to the ontology are refused until the read
 * succeeds again. State is per guard (one per turn) and kept out of the public
 * interface on purpose — only the wrapper decides.
 */
const COGNITION_READ_TOOLS: ReadonlySet<string> = new Set([
  'cognition_ontology_query',
  'transcript_corrections_query',
]);
const ontologyWriteBlocks = new WeakMap<ToolFailureGuard, Map<string, string>>();

function isOntologyWriteTool(tool: string, input: unknown): boolean {
  if (tool !== 'create_cognition') return false;
  const record = (input ?? {}) as Record<string, unknown>;
  return record.target === 'ontology' || record.target === 'joint' || record.asset_type === 'ontology' || record.ontology === true;
}

export interface ToolFailureBreakerOptions {
  guard: ToolFailureGuard;
  /**
   * Parallel batches must NOT end the turn early: the runner decides terminality
   * per batch (`agent/runner.ts:1580-1581`), and a sibling result in the same
   * batch would be dropped. Parallel tools therefore only *count*; the trip is
   * reported through `onTrip` with `endTurn: false`; only a later sequential
   * trip may become a terminal receipt.
   */
  endTurnInParallel?: boolean;
  onTrip?: (event: {
    tool: string;
    kind: ToolFailureKind;
    code: string;
    reason: string;
    countedFailures: number;
    /** True only when this breaker result requests the end of execution. */
    endTurn: boolean;
  }) => void;
}

/**
 * Host policy at the runner's execution boundaries. Tools retain their identity;
 * the SDK supplies the winning implementation and normalizes thrown failures
 * before afterExecute. Cancelled, skipped and idle-abandoned calls are excluded
 * by the runner, so late completions cannot mutate the guard.
 */
export function createToolFailureBreaker(options: ToolFailureBreakerOptions) {
  const { guard, onTrip, endTurnInParallel = false } = options;
  return {
    beforeExecute(toolName: string, input: unknown) {
      const blockReason = [...(ontologyWriteBlocks.get(guard)?.values() ?? [])].join('；');
      if (!blockReason || !isOntologyWriteTool(toolName, input)) return undefined;
      const reason = `${blockReason}\n\n已阻断：读取失败后不允许继续写入本体；请先让认知查询成功。`;
      onTrip?.({ tool: toolName, kind: 'policy_denied', code: 'ontology_read_blocked',
        reason, countedFailures: guard.snapshot().countedFailures, endTurn: true });
      return { content: reason, isError: true, endTurn: true };
    },
    afterExecute<T>(tool: Pick<GuardableTool, 'name' | 'executionMode'>, input: unknown, result: T, ctx?: { workingDir?: string }, completion?: { transientNetworkError?: boolean }): T {
      // Preserve positive classification from the original exception, whose
      // socket code may live only in `cause` and disappear during text mapping.
      if (completion?.transientNetworkError) return result;
      const record = (result ?? {}) as { content?: unknown; isError?: unknown };
      const decision = guard.observe({
        tool: tool.name,
        input,
        workingDir: ctx?.workingDir,
        content: typeof record.content === 'string' ? record.content : '',
        isError: Boolean(record.isError),
      });
      if (decision.action !== 'endTurn') return result;

      const mayEndTurn = endTurnInParallel || tool.executionMode !== 'parallel';
      onTrip?.({
        tool: tool.name,
        kind: decision.kind,
        code: decision.code,
        reason: decision.reason,
        countedFailures: decision.countedFailures,
        endTurn: mayEndTurn,
      });
      if (!mayEndTurn) return result;
      const existing = typeof record.content === 'string' ? record.content : '';
      return {
        ...result,
        content: existing ? `${existing}\n\n${decision.reason}` : decision.reason,
        isError: true,
        endTurn: true,
      };
    },
  };
}

/** Compatibility adapter for callers executing tools without the SDK runner.
 * Production runners use the boundary callbacks directly, after normalization. */
export function guardToolsWithFailureBreaker<T extends GuardableTool>(
  tools: readonly T[],
  options: ToolFailureBreakerOptions,
): T[] {
  const breaker = createToolFailureBreaker(options);
  return tools.map(tool => ({
    ...tool,
    async execute(input: never, ctx: never): Promise<unknown> {
      const denial = breaker.beforeExecute(tool.name, input);
      if (denial) return denial;
      return breaker.afterExecute(tool, input, await tool.execute(input, ctx), ctx);
    },
  }) as T);
}
