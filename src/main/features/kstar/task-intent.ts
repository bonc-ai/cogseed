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

const MIN_TASK_TEXT = 12;

export interface TaskIntentResult {
  /** True when the message looks like a real task, not trivia. */
  isTask: boolean;
  /** Short human-readable reason (for the hint line). */
  reason?: string;
}

/** Fast deterministic filter: is this message OBVIOUSLY trivial (greeting,
 *  politeness, pure confirmation, status query, punctuation/emoji)? Only
 *  these are filtered without a model call — everything else goes to the
 *  model judgement so boundary task-shaped requests are never missed.
 *  Zero KStar writes either way (a trivial message simply never routes). */
export function isObviouslyTrivial(text: string | undefined): boolean {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return true;
  return TRIVIAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Detect whether a user message is a task-shaped request. Kept for
 *  compatibility: the host routing line now uses isObviouslyTrivial +
 *  the model judgement; this keyword-based detector remains as a fast
 *  pre-check helper (and for tests / non-model contexts). */
export function detectTaskIntent(text: string | undefined): TaskIntentResult {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return { isTask: false };
  if (TRIVIAL_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { isTask: false };
  }
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
