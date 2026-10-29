import { createLogger } from '../../logger';

/**
 * task-intent.ts — host-side task-intent detection (layer 1 of routing
 * uplift). The Commander is the router (Commander-centric), but the host
 * must not rely on the user phrasing requests as "formal tasks": ordinary
 * user wording like "审查一下 X" must still surface a routing hint.
 *
 * This is DETERMINISTIC and advisory only: it never writes KStar state and
 * never blocks anything. It detects task-shaped user messages (goal +
 * deliverable/action signal, not greeting/thanks/status/trivia) so the
 * host can nudge the Commander to consider KStar tracking instead of
 * silently skipping it (the observed default).
 */

const log = createLogger('kstar.task-intent');

/** Message shapes that are NOT tasks (inverse detection). */
const TRIVIAL_PATTERNS = [
  // Greetings / politeness — word sequences with optional separators
  // ("谢谢，辛苦了", "好的收到", "嗯 好的" all trivial).
  /^(你好|您好|嗨|哈喽|hello|hi|hey|早上好|下午好|晚上好|谢谢|感谢|辛苦了|ok|好的|收到|明白|嗯|好|行|可以|再见|拜拜|谢谢[，,、]辛苦了)([\s。！!？?,.，、]*|$)/i,
  // Pure acknowledgements / single-word confirmations
  /^(嗯+|哦+|对|是|不是|对的对的|没问题|可以的?|就这样|继续|好的继续|接着来)[\s。！!？?,.，]*$/i,
  // Status queries ("where are we", "done?")
  /(到哪|进行到|完成了吗|结束了吗|好了吗|还在吗|在不在|什么状态|进度|现在.*阶段|还差|多久|什么时候好)/i,
  // Punctuation / emoji only
  /^[\s。！!？?,.，~～·、;；:："'""''（）()\[\]【】\-—…]+$/,
  /^[\p{Extended_Pictographic}\u200d]+$/u,
];

/** Task-shaped signals: goal verbs + deliverable nouns. */
const TASK_SIGNALS = [
  /(审查|分析|检查|修复|实现|开发|编写|创建|生成|总结|调研|评估|设计|重构|优化|迁移|部署|测试|验证|对比|梳理|整理|翻译|解释|排查|调试|构建|写|做|完成|处理|解决|研究|规划|评审|验收|输出|提交|推送)/,
  /(report|review|analy|fix|implement|build|create|write|design|refactor|optimize|migrate|deploy|test|verify|investigat|debug|summar|draft|prepare|audit|evaluate|research|plan|document)/i,
];

/** Closing intent: the user says the open task is DONE. Deterministic and
 *  checked BEFORE the trivial filter so "完成/搞定/结束" closes the open
 *  task via the finish path (requirement precipitation runs) instead of
 *  being treated as a new task or ignored as small talk. */
const CLOSING_PATTERNS = [
  /^(完成|搞定|结束|完结|收工|完工|做完|干完|办完|就这样|可以了|好了|行吧)(了|啦|吧|！|!|。|~|～|,|，|\.)*$/i,
  /^(done|finished|finish|complete|completed|that'?s (it|all)|all done|wrap (it )?up|we'?re done)[!。.]*$/i,
];

const MIN_TASK_TEXT = 12;

export interface TaskIntentResult {
  /** True when the message looks like a real task, not trivia. */
  isTask: boolean;
  /** Short human-readable reason (for the hint line). */
  reason?: string;
}

/** True when the message expresses that the current task is finished. */
export function isClosingIntent(text: string | undefined): boolean {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return false;
  return CLOSING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Fast deterministic filter: is this message OBVIOUSLY trivial (greeting,
 *  politeness, pure confirmation, status query, punctuation/emoji)? Only
 *  these are filtered without a model call — everything else goes to the
 *  model judgement so boundary task-shaped requests are never missed.
 *  The predicate itself writes nothing; the caller records the decision (and
 *  only once the conversation already has KStar state). */
export function isObviouslyTrivial(text: string | undefined): boolean {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return true;
  if (!TRIVIAL_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  // The status-query pattern is unanchored, so "进度" / "还差" / "多久" match
  // ANYWHERE — including inside a real request ("整理一下这个季度的进度报告",
  // "分析一下竞品的进度报告怎么写"). A message carrying a goal verb or a
  // deliverable noun is never OBVIOUSLY trivial: one extra judge round trip
  // is cheap, silently dropping the task's governance is not.
  return !TASK_SIGNALS.some((pattern) => pattern.test(trimmed));
}

/** Closed set of yes/no acknowledgements. Trailing particles (了/吧/呀) and
 *  punctuation are stripped before lookup, so "不用了" and "都要吧" match. */
const ANSWER_CONFIRMATIONS = new Set([
  '是', '是的', '是了', '对', '对的', '好', '好的', '行', '行的', '可以', '没问题', '没错',
  '要', '需要', '不用', '不要', '不需要', '都要', '都可以', '都行', '全要', '全都要',
  '同意', '赞成', '支持',
  'ok', 'okay', '嗯',
]);

/** Pure ordinal/number selection: "1", "1234", "第一"、"第三个"、
 *  "第一个和第三个"、"前两个"、"1234都需要"、"第一个就行".
 *  Grammar-only on purpose: any real word ("把这个整成 PDF") breaks it. */
const ANSWER_SELECTION =
  /^(前|后|第)?[0-9一二三四五六七八九十两]+(个)?([和及与、,，+\/](前|后|第)?[0-9一二三四五六七八九十两]+(个)?)*([都全](要|需要)?)?(就行|可以|吧|了)?$/;

/** Selection by label: "方案一"、"选项2". Narrow on purpose — the label must
 *  be the whole message, so "方案一有问题" is not matched. */
const ANSWER_SELECTION_BY_LABEL = /^(方案|选项)[0-9一二三四五六七八九十两]+$/;

/**
 * Answer-like confirmations: short selections ("1"、"第一个和第三个") and
 * yes/no acknowledgements ("是的"、"需要"、"不用") that answer a question the
 * assistant just asked.
 *
 * Why this is its own gate rather than part of TRIVIAL_PATTERNS: these are
 * not small talk, they are substantive answers inside an ongoing
 * interaction. But they are equally not tasks, and they carry no signal that
 * could start or switch one — so routing them through the model costs a full
 * round trip (660–820ms measured) to reach the conclusion the message shape
 * already implies: no task write.
 *
 * Measured on 242 real user messages: the two earlier gates cover 21 of them
 * (closing intent 2, obviously trivial 19), this gate newly covers 16 (6.6%),
 * and 205 (84.7%) still reach the model. The two `TRIVIAL_PATTERNS` entries
 * above match the *bare* forms ("是"、"对"、"好的"), so the particle-bearing
 * forms users actually type ("是的"、"不用了"、"都要吧") fall through — that gap
 * is what this gate closes. All 16 matches on the corpus were real
 * confirmations; none was a task.
 *
 * SAFETY: this gate only ever SUPPRESSES work — the caller writes no KStar
 * task/requirement state, so an open task stays open and still gets its
 * projection injected (that path reads the lifecycle independently). A wrongly
 * matched message is therefore answered normally, it is just not routed. That
 * is the cheap failure direction.
 */
export function isAnswerLikeConfirmation(text: string | undefined): boolean {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  const trimmed = raw.replace(/[。！!？?,.，、;；:：~～]+$/u, '').replace(/[了吧呀呢]$/u, '').trim();
  if (!trimmed || trimmed.length > 12) return false;
  if (ANSWER_CONFIRMATIONS.has(trimmed.toLowerCase())) return true;
  return ANSWER_SELECTION.test(trimmed) || ANSWER_SELECTION_BY_LABEL.test(trimmed);
}

/** Detect whether a user message is a task-shaped request. Kept for
 *  compatibility: the host routing line now uses isObviouslyTrivial +
 *  the model judgement; this keyword-based detector remains as a fast
 *  pre-check helper (and for tests / non-model contexts).
 *
 *  It shares `isObviouslyTrivial` rather than re-testing TRIVIAL_PATTERNS:
 *  the two must agree on what counts as trivia, or the hint line would call a
 *  message task-shaped while the gate filtered it as a greeting. */
export function detectTaskIntent(text: string | undefined): TaskIntentResult {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (isObviouslyTrivial(trimmed)) return { isTask: false };
  const signal = TASK_SIGNALS.find((pattern) => pattern.test(trimmed));
  if (!signal) return { isTask: false };
  if (trimmed.length < MIN_TASK_TEXT) return { isTask: false };
  return { isTask: true, reason: 'task signal detected' };
}

/** Render the routing note appended to the Commander system prompt.
 *  `hostOpenedTask` must reflect what host routing ACTUALLY did for this
 *  turn's user message. The world model owns the whole governed lifecycle:
 *  task, projection, and forecast are all host-side (auto-forecast), so the
 *  note only informs the Commander — it never instructs a kstar_control
 *  call (that tool is no longer in the Commander's surface). When the host
 *  did NOT open a task, the note must not claim tracked state that doesn't
 *  exist. */
export function taskIntentHint(
  text: string | undefined,
  opts?: { hostOpenedTask?: boolean },
): string {
  try {
    const detected = detectTaskIntent(text);
    if (!detected.isTask) return '';
    const hostOpened = opts?.hostOpenedTask === true;
    return [
      '',
      '## Host routing note',
      hostOpened
        ? 'The host has already tracked this task (KStar task + confirmed projection + world-model forecast). Governance is handled automatically — just execute the work.'
        : 'This message looks task-shaped. The host did not open a governed KStar task for it (routing judged it non-task or the judgement was unavailable), so this turn runs ungoverned.',
      '',
    ].join('\n');
  } catch (error) {
    log.warn('task intent hint degraded', { error: (error as Error).message });
    return '';
  }
}
