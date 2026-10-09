/**
 * Daily briefing generator — 今日简报生成器（伴侣智能体场景层 · 原型）。
 *
 * 纯函数模块，零 IO、零依赖：输入「本体已确认事实 + 授权日历事件」两个
 * JSON 形状，输出用户可见的简报文本 + 结构化段落。对应设计稿
 * `docs/superpowers/specs/2026-08-10-feishu-companion-context-design.md` §5.6：
 *
 * - 数据 = 本体已确认事实（日程/截止日期/项目）+ 授权日历近 24h 事件；
 * - 输出 = 文本推送到主页会话（只读展示，无需用户确认）；
 * - 失败处理 = 数据缺失时降级为通用简报，不阻塞、不抛错。
 *
 * 定位：产品是面向**各行各业**的个人伴侣智能体（学生只是首个场景案例），
 * 因此本模块保持场景中立——事实类别用通用语义（appointment/deadline/
 * project/preference），学生场景的「课程/学习」措辞由调用方通过 `copy`
 * 覆盖，不写死在本模块内。
 *
 * 场景只信本体：本模块不摸 provider、不读文件，输入由上层（连接器同步 +
 * 本体查询）组装。文案通过 `copy` 参数注入（默认中文），为 i18n 与后续
 * 流式卡片渲染预留扩展点。
 *
 * 时间基准：`input.now` 可注入（调度器/测试固定时间），缺省取当前时间。
 * 日期比较按本地时区日历日；纯日期字符串（YYYY-MM-DD）直接取年月日组件，
 * 避免 `new Date('YYYY-MM-DD')` 的 UTC 午夜解析在非零时区偏移日。
 */

/** 事实类别（场景中立语义）：appointment=定时日程类（课程/会议/预约），
 *  deadline=截止/交付节点，project=进行中事项，preference=偏好，
 *  other=其他。学生场景的课程即 appointment 的一个实例。 */
export type BriefingFactKind = 'appointment' | 'deadline' | 'project' | 'preference' | 'other';

/** 本体已确认事实（场景层只消费治理后的本体事实，不直接摸 provider）。 */
export interface BriefingFact {
  id: string;
  kind: BriefingFactKind;
  /** 一句人话摘要（对应本体候选确认后的 memory_text / summary）。 */
  summary: string;
  /** 关联日期（ISO date 或 datetime）；appointment/deadline 通常携带。 */
  date?: string;
  /** 来源引用（本体事实的 source ref），用于可追溯。 */
  sourceRef?: string;
}

/** 授权日历事件（来自 personal_context 资源层，已标准化的最小字段集）。 */
export interface BriefingCalendarEvent {
  id: string;
  title: string;
  /** ISO datetime。解析失败的事件被忽略（防脏数据，不崩）。 */
  startAt: string;
  endAt?: string;
  allDay?: boolean;
  location?: string;
  sourceRef?: string;
}

export interface BriefingInput {
  facts?: BriefingFact[];
  events?: BriefingCalendarEvent[];
  /** 时间基准（ISO）；缺省 = 当前时间。 */
  now?: string;
}

export type MissingDataKind = 'facts' | 'events';

export type BriefingSectionKey =
  | 'today_schedule'      // 今日日程 / 会议（本体日程事实 + 日历事件）
  | 'upcoming_deadlines'  // 未来 7 天截止（本体 deadline 事实）
  | 'free_slot'           // 空闲时段建议（日历空档 × 近期截止推算）
  | 'notes'               // 其他要点（偏好/项目等未消费事实）
  | 'generic';            // 通用简报（数据缺失时的降级内容）

export interface BriefingSection {
  key: BriefingSectionKey;
  lines: string[];
}

export interface BriefingOutput {
  /** 最终简报文本（用户可见，推送到主页会话）。 */
  text: string;
  /** 结构化段落（按 key 稳定排序，供将来流式卡片/分块渲染）。 */
  sections: BriefingSection[];
  /** true = 存在数据缺失，走了降级路径。 */
  degraded: boolean;
  /** 缺失的数据类别（facts = 无本体事实，events = 无日历事件）。 */
  missingData: MissingDataKind[];
}

export interface BriefingCopy {
  header: string;             // "今日简报" 标题
  todaySchedule: string;      // "今日安排"
  upcomingDeadlines: string;  // "近期截止"
  freeSlot: string;           // "空闲时段建议"
  notes: string;              // "其他要点"
  generic: string;            // 通用简报正文（数据全缺时的降级内容）
  missingEventsHint: string;  // 无日历事件提示
  missingFactsHint: string;   // 无本体事实提示
  noDeadlines: string;        // 无近期截止提示
  /** 日期/时间格式化（locale 决定星期/月份语言），默认 zh-CN。 */
  locale: string;
  timeFormatter: (d: Date) => string;
  dateFormatter: (d: Date) => string;
}

export const DEFAULT_BRIEFING_COPY: BriefingCopy = {
  header: '今日简报',
  todaySchedule: '今日安排',
  upcomingDeadlines: '近期截止',
  freeSlot: '空闲时段建议',
  notes: '其他要点',
  generic:
    '今天还没有已接入的课程、会议或截止日期安排。' +
    '已授权资源暂无新数据，可稍后查看，或检查日历 / 文档接入状态。',
  missingEventsHint: '今日无日历事件（授权日历暂无数据）',
  missingFactsHint: '暂无已确认的本体事实',
  noDeadlines: '未来 7 天暂无截止日期',
  locale: 'zh-CN',
  timeFormatter: (d: Date) =>
    d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
  dateFormatter: (d: Date) =>
    d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }),
};

const DEADLINE_WINDOW_DAYS = 7;
const FREE_SLOT_MIN_MINUTES = 60;
const NOTES_MAX_LINES = 3;

// ── 时间工具（纯函数）────────────────────────────────────────────────────

function _parse(dateText: string | undefined): Date | null {
  if (!dateText) return null;
  const d = new Date(dateText);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 把 date 文本规整为「本地日历日」三元组；纯日期字符串直接取组件，
 *  datetime 取本地时区的年月日。解析失败返回 null（调用方忽略该条）。 */
function _calendarDay(dateText: string | undefined): { y: number; m: number; d: number } | null {
  if (!dateText) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateText.trim());
  if (m) {
    const y = Number(m[1]); const mo = Number(m[2]); const day = Number(m[3]);
    if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(day)) return null;
    return { y, m: mo, d: day };
  }
  const dt = _parse(dateText);
  return dt ? { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() } : null;
}

function _dayKey(day: { y: number; m: number; d: number }): number {
  return day.y * 10000 + day.m * 100 + day.d;
}

function _startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 本地日历日偏移；返回绝对毫秒，跨月/跨年安全。 */
function _dayOffsetMs(base: Date, days: number): number {
  return _startOfLocalDay(base).getTime() + days * 86_400_000;
}

// ── 数据裁剪 ─────────────────────────────────────────────────────────────

function _filterFacts(input: BriefingInput): BriefingFact[] {
  return Array.isArray(input.facts)
    ? input.facts.filter((f) => f && typeof f.summary === 'string' && f.summary.trim())
    : [];
}

function _filterEvents(input: BriefingInput): BriefingCalendarEvent[] {
  return Array.isArray(input.events)
    ? input.events.filter((e) =>
        e && typeof e.title === 'string' && e.title.trim() && !e.allDay && _parse(e.startAt))
    : [];
}

// ── 段落构建 ─────────────────────────────────────────────────────────────

interface BuildCtx {
  now: Date;
  todayDay: { y: number; m: number; d: number };
  todayStartMs: number;
  deadlineWindowEndMs: number;
  copy: BriefingCopy;
}

function _buildTodaySchedule(
  ctx: BuildCtx,
  events: BriefingCalendarEvent[],
  facts: BriefingFact[],
): BriefingSection | null {
  const lines: string[] = [];
  const todayKey = _dayKey(ctx.todayDay);
  const sortedEvents = [...events].sort((a, b) => a.startAt.localeCompare(b.startAt));
  for (const ev of sortedEvents) {
    const start = _parse(ev.startAt)!;
    const time = ctx.copy.timeFormatter(start);
    const end = ev.endAt ? _parse(ev.endAt) : null;
    const range = end ? `${time}–${ctx.copy.timeFormatter(end)}` : time;
    const where = ev.location && ev.location.trim() ? `（${ev.location.trim()}）` : '';
    lines.push(`• ${range} ${ev.title.trim()}${where}`);
  }
  // 本体日程事实：带「今天」日期的日程类事实（课程/会议/预约）并入今日
  // 安排（场景只信本体；具体语义由上层按场景分类注入）。
  for (const f of facts) {
    if (f.kind !== 'appointment') continue;
    const day = _calendarDay(f.date);
    if (!day || _dayKey(day) !== todayKey) continue;
    const d = _parse(f.date);
    const prefix = d ? ctx.copy.timeFormatter(d) : '';
    lines.push(`• ${prefix ? `${prefix} ` : ''}${f.summary.trim()}`);
  }
  return lines.length ? { key: 'today_schedule', lines } : null;
}

function _buildUpcomingDeadlines(ctx: BuildCtx, facts: BriefingFact[]): BriefingSection | null {
  const rows: Array<{ day: number; text: string }> = [];
  for (const f of facts) {
    if (f.kind !== 'deadline') continue;
    const day = _calendarDay(f.date);
    if (!day) continue;
    const ms = new Date(day.y, day.m - 1, day.d).getTime();
    if (ms < ctx.todayStartMs || ms > ctx.deadlineWindowEndMs) continue; // 过去 / 超出窗口
    rows.push({ day: _dayKey(day), text: f.summary.trim() });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.day - b.day);
  const lines = rows.map((r) => {
    const d = new Date(r.day / 10000, ((r.day / 100) % 100) - 1, r.day % 100);
    return `• ${ctx.copy.dateFormatter(d)} ${r.text}`;
  });
  return { key: 'upcoming_deadlines', lines };
}

/** 最大空闲时段：今日事件排序后相邻 startAt 的最大间隙（含晨间与晚间，
 *  全天事件已在上游过滤）。间隙起点取简报生成时刻（now）——已过去的
 *  晨间空档对「现在开始可用的时段」没有建议价值。不足
 *  FREE_SLOT_MIN_MINUTES 不产出建议。 */
function _largestGapMs(
  ctx: BuildCtx,
  events: BriefingCalendarEvent[],
): { start: Date; end: Date; ms: number } | null {
  const starts = events
    .map((e) => _parse(e.startAt)!.getTime())
    .sort((a, b) => a - b);
  if (!starts.length) return null;
  const bounds: Array<{ startMs: number; endMs: number }> = [
    { startMs: ctx.now.getTime(), endMs: starts[0] },
  ];
  for (let i = 1; i < starts.length; i += 1) {
    bounds.push({ startMs: starts[i - 1], endMs: starts[i] });
  }
  let best: { start: Date; end: Date; ms: number } | null = null;
  for (const b of bounds) {
    const ms = b.endMs - b.startMs;
    if (ms < FREE_SLOT_MIN_MINUTES * 60_000) continue;
    if (!best || ms > best.ms) {
      best = { start: new Date(b.startMs), end: new Date(b.endMs), ms };
    }
  }
  return best;
}

function _buildFreeSlot(
  ctx: BuildCtx,
  events: BriefingCalendarEvent[],
  deadlines: BriefingSection | null,
): BriefingSection | null {
  if (!deadlines) return null; // 无截止目标 → 空档没有意义，不推
  const gap = _largestGapMs(ctx, events);
  if (!gap) return null;
  // 已按日期升序 → 第一行是最近截止；去掉行内 bullet 前缀避免嵌套「•」。
  const firstDeadline = deadlines.lines[0].replace(/^•\s*/, '');
  const line = `${ctx.copy.timeFormatter(gap.start)}–${ctx.copy.timeFormatter(gap.end)} 有空档，可用来推进「${firstDeadline}」`;
  return { key: 'free_slot', lines: [line] };
}

function _buildNotes(facts: BriefingFact[]): BriefingSection | null {
  const lines: string[] = [];
  for (const f of facts) {
    if (f.kind === 'appointment' || f.kind === 'deadline') continue; // 已消费
    lines.push(`• ${f.summary.trim()}`);
    if (lines.length >= NOTES_MAX_LINES) break;
  }
  return lines.length ? { key: 'notes', lines } : null;
}

function _buildGeneric(ctx: BuildCtx): BriefingSection {
  return { key: 'generic', lines: [ctx.copy.generic] };
}

function _titleOf(copy: BriefingCopy, key: BriefingSectionKey): string | null {
  switch (key) {
    case 'today_schedule': return copy.todaySchedule;
    case 'upcoming_deadlines': return copy.upcomingDeadlines;
    case 'free_slot': return copy.freeSlot;
    case 'notes': return copy.notes;
    case 'generic': return null;
  }
}

// ── 主入口 ───────────────────────────────────────────────────────────────

export function buildDailyBriefing(
  input: BriefingInput,
  copy: BriefingCopy = DEFAULT_BRIEFING_COPY,
): BriefingOutput {
  const rawNow = _parse(input.now);
  const now = rawNow ?? new Date();
  const facts = _filterFacts(input);
  const events = _filterEvents(input);
  const ctx: BuildCtx = {
    now,
    todayDay: { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() },
    todayStartMs: _startOfLocalDay(now).getTime(),
    deadlineWindowEndMs: _dayOffsetMs(now, DEADLINE_WINDOW_DAYS),
    copy,
  };

  const missingData: MissingDataKind[] = [];
  if (!facts.length) missingData.push('facts');
  if (!events.length) missingData.push('events');
  const degraded = missingData.length > 0;

  const sections: BriefingSection[] = [];
  if (degraded && !facts.length && !events.length) {
    // 数据全缺 → 通用简报，不含任何资源数据（设计稿 §5.6 降级路径）。
    sections.push(_buildGeneric(ctx));
  } else {
    const schedule = _buildTodaySchedule(ctx, events, facts);
    const deadlines = _buildUpcomingDeadlines(ctx, facts);
    if (schedule) sections.push(schedule);
    if (deadlines) sections.push(deadlines);
    const slot = _buildFreeSlot(ctx, events, deadlines);
    if (slot) sections.push(slot);
    const notes = _buildNotes(facts);
    if (notes) sections.push(notes);
    if (!facts.length) {
      sections.push({ key: 'generic', lines: [copy.missingFactsHint] });
    } else if (!deadlines) {
      sections.push({ key: 'generic', lines: [copy.noDeadlines] });
    }
    if (!events.length) {
      sections.push({ key: 'generic', lines: [copy.missingEventsHint] });
    }
  }

  const header = `${copy.header} · ${ctx.copy.dateFormatter(now)}`;
  const text = [
    header,
    '',
    sections
      .map((s) => {
        const t = _titleOf(copy, s.key);
        const body = s.lines.join('\n');
        return t ? `【${t}】\n${body}` : body;
      })
      .join('\n\n'),
  ].join('\n');

  return { text, sections, degraded, missingData };
}
