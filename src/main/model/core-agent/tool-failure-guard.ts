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
 * Contract (pinned by tests)
 * --------------------------
 *   1. A non-error observation resets the same-kind streak.
 *   2. `transient` failures never trip the breaker and never raise the total.
 *   3. The breaker trips on `maxSameKind` consecutive same-kind failures or
 *      `maxTotal` counted failures in one turn, whichever comes first.
 *   4. A tripped reason always carries three parts: cause, last progress,
 *      recovery action.
 */

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

/** Classify a failed tool result's message. Never throws; unknown shapes fall
 *  back to `unclassified`, which still counts toward the breaker — bounded
 *  retries are the point, not perfect taxonomy. */
export function classifyToolFailure(content: string): ToolFailureClassification {
  const text = typeof content === 'string' ? content : String(content ?? '');
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
  /** Consecutive same-kind failures that trip the breaker. */
  maxSameKind?: number;
  /** Counted (non-transient) failures in the turn that trip the breaker. */
  maxTotal?: number;
}

const DEFAULT_MAX_SAME_KIND = 3;
const DEFAULT_MAX_TOTAL = 6;
const PROGRESS_EXCERPT_CHARS = 120;

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

  let lastKind: ToolFailureKind | null = null;
  let sameKindStreak = 0;
  let countedFailures = 0;
  let lastProgress = '本轮尚无成功步骤';

  const api: ToolFailureGuard = {
    observe(observation: ToolFailureObservation): ToolFailureDecision {
      const content = typeof observation?.content === 'string' ? observation.content : '';
      const tool = String(observation?.tool || 'tool');

      if (!observation?.isError) {
        // Evidence recovered: the streak is about *consecutive* dead ends.
        lastKind = null;
        sameKindStreak = 0;
        lastProgress = `${tool} 成功：${excerpt(content) || '(无输出)'}`;
        return { action: 'continue' };
      }

      // Persisted-result retrieval errors (read budget/cursor/duplicate/ref)
      // are usage control, not a broken tool. Ending the turn here hides the
      // model's pending answer; let it adapt in the next step instead.
      if (/\bE_RESULT_[A-Z_]+\b/.test(content)) return { action: 'continue' };

      const { kind, code } = classifyToolFailure(content);
      if (kind === 'transient') {
        // Network-shaped: leave counting to the existing retry path.
        return { action: 'continue' };
      }

      sameKindStreak = kind === lastKind ? sameKindStreak + 1 : 1;
      lastKind = kind;
      countedFailures += 1;
      if (COGNITION_READ_TOOLS.has(tool)) {
        // P1-3: remember WHY, so the blocked write can quote the real failure.
        ontologyWriteBlocks.set(api, `确定性读取失败已阻断后续本体写入（${tool} → ${code}）：${excerpt(content)}`);
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
  const cause = `工具 ${input.tool} 连续 ${input.sameKindStreak} 次同类确定性失败`
    + `（${input.code}）：${excerpt(input.content)}`;
  const progress = `最近一次有效进展：${input.lastProgress}`;
  const recovery = `建议：${RECOVERY_BY_KIND[input.kind]}`
    + `（本轮已计 ${input.countedFailures} 次确定性失败，未包含网络类重试）`;
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
 * The breaker counts *consecutive same-kind* failures, so a model that answers a
 * failed read by switching tool (`cognition_ontology_query` → `create_cognition
 * (ontology)`) resets the streak and writes anyway. P1-3: a deterministic read
 * failure is a dead end, so writes to the ontology are refused until the read
 * succeeds again. State is per guard (one per turn) and kept out of the public
 * interface on purpose — only the wrapper decides.
 */
const COGNITION_READ_TOOLS: ReadonlySet<string> = new Set([
  'cognition_ontology_query',
  'transcript_corrections_query',
]);
const ontologyWriteBlocks = new WeakMap<ToolFailureGuard, string>();

function isOntologyWriteTool(tool: string, input: unknown): boolean {
  if (tool !== 'create_cognition') return false;
  const record = (input ?? {}) as Record<string, unknown>;
  return record.target === 'ontology' || record.asset_type === 'ontology' || record.ontology === true;
}

export interface ToolFailureBreakerOptions {
  guard: ToolFailureGuard;
  /**
   * Parallel batches must NOT end the turn early: the runner decides terminality
   * per batch (`agent/runner.ts:1580-1581`), and a sibling result in the same
   * batch would be dropped. Parallel tools therefore only *count*; the trip is
   * reported through `onTrip` and surfaces on the next sequential result.
   */
  endTurnInParallel?: boolean;
  onTrip?: (event: {
    tool: string;
    kind: ToolFailureKind;
    code: string;
    reason: string;
    countedFailures: number;
  }) => void;
}

/**
 * Wrap tools so a repeated deterministic failure ends the turn instead of being
 * handed back to the model as ordinary evidence. Non-error results are untouched
 * (they reset the streak), and the original result is preserved — only a tripped
 * result gains the reason text and `endTurn: true`.
 */
export function guardToolsWithFailureBreaker<T extends GuardableTool>(
  tools: readonly T[],
  options: ToolFailureBreakerOptions,
): T[] {
  const { guard, onTrip, endTurnInParallel = false } = options;
  return tools.map((tool) => {
    const wrapped = {
      ...tool,
      async execute(input: never, ctx: never): Promise<unknown> {
        // P1-3: a deterministic cognition-read failure blocks an ontology write
        // before it runs — the same-kind streak alone cannot catch a tool switch.
        const blockReason = ontologyWriteBlocks.get(guard);
        if (blockReason && isOntologyWriteTool(tool.name, input)) {
          return {
            content: `${blockReason}\n\n已阻断：读取失败后不允许继续写入本体；请先让认知查询成功。`,
            isError: true,
            endTurn: true,
          };
        }
        const result = await tool.execute(input, ctx);
        const record = (result ?? {}) as { content?: unknown; isError?: unknown };
        const decision = guard.observe({
          tool: tool.name,
          content: typeof record.content === 'string' ? record.content : '',
          isError: Boolean(record.isError),
        });
        if (decision.action !== 'endTurn') return result;

        onTrip?.({
          tool: tool.name,
          kind: decision.kind,
          code: decision.code,
          reason: decision.reason,
          countedFailures: decision.countedFailures,
        });

        const mayEndTurn = endTurnInParallel || tool.executionMode !== 'parallel';
        if (!mayEndTurn) return result;

        const existing = typeof record.content === 'string' ? record.content : '';
        return {
          ...(result as Record<string, unknown>),
          content: existing ? `${existing}\n\n${decision.reason}` : decision.reason,
          isError: true,
          endTurn: true,
        };
      },
    };
    return wrapped as unknown as T;
  });
}
