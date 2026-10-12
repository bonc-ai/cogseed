/**
 * meeting_metrics — 会议引用层指标与回执汇总（specs/013 · FR-008/FR-009 / US-506 / T053~T056）
 *
 * 两件事：
 *   1. **会议指标事件流水**（T054/T055/T056）：五种 `meeting_*` 事件写**新文件**
 *      `<uid>/local/cogseed/transcript/meeting-metrics.jsonl`，并提供五项口径的
 *      汇总读口（采纳率 / 误引用率 / token 增量 / 术语改对率 / 过纠正率）。
 *   2. **回执汇总**（T053）：读**既有** `listRecentReviewDecisions`（review-decision.ts，
 *      一行不改），按 `target_ref` 前缀 `meeting:` 过滤成 `MeetingReceiptView`
 *      （只带标识，不带正文）。
 *
 * 为什么必须另开文件（tasks T054 明令）：既有 `transcript_metrics.readEvents` 显式
 * 只收 `confirm_latency`/`retention` 两种 kind、未知 kind **静默丢弃**
 * （`transcript_metrics.ts:112-133`）。会议事件写进同一文件 = 永远读不到；改
 * 既有读口 = 触碰既有断言。故同目录、另开文件、复用同一 append-only 与
 * 坏行跳过纪律（对齐 `readEvents` 的容错口径）。
 *
 * 三条纪律：
 *   - **指标不编数字**：每项比率必带分母与样本数；空数据 ⇒ `rate: null` 且
 *     样本数 0；测不到的进 `notMeasurable`（对齐 `transcript_metrics.ts` 的
 *     既有诚实清单，至少含 data-model §5.2 的三条）。
 *   - **事件只带 id/版本/计数**，不含正文（隐私；对齐 cost-telemetry 的匿名计数纪律）。
 *   - **写入失败不炸链路**：IO 失败 try/catch + `log.warn`（照 `recordCostTelemetry`
 *     的先例）；调用方（扫描/落账路径）不受影响。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { userMeetingMetricsFile } from '../paths';
import { listRecentReviewDecisions } from './cognition/review-decision';
import type { ReviewDecision, ReviewDecisionType } from './cognition/review-decision';

const log = createLogger('meeting-metrics');

// ── T054：事件类型（data-model §5.2，加法可选字段见各分支注释） ─────────────

export type MeetingDecisionKind =
  | 'accept' | 'modify' | 'defer' | 'reject' | 'ignore' | 'keep_current'
  /** 撤销拒绝写的 accept（`decision:'unreject'`，ipc/transcript.ts 的 unreject 通道）：
   *  如实记账，但**不计入采纳率的分子分母**（T055 的撤销口径，fed2cf8e 留的口子）。 */
  | 'unreject';

export type MeetingDecisionItemKind = 'correction' | 'conclusion' | 'action' | 'asset_ref';

export type MeetingMetricEvent =
  | {
    kind: 'meeting_scan';
    docId: string;
    candidates: number;
    exact: number;
    recall: number;
    model: number;
    quotedExample: number;
    truncated: boolean;
    /** 【加法，T055】本次扫描出现的**术语类**候选数（kind ∈ TERM_KINDS；术语改对率
     *  的分母）。写入方测不出（未按 kind 分桶）时缺省——缺省不按 0 编，只是该项
     *  分母不计。delete 类（口癖）不算术语，写入方不应计入。 */
    termCandidates?: number;
    at: number;
  }
  | {
    kind: 'meeting_decision';
    docId: string;
    itemId: string;
    itemKind: MeetingDecisionItemKind;
    decision: MeetingDecisionKind;
    /** 该决定的依据条数（只计数，不存依据本体）。 */
    refs: number;
    /** 【加法，T055】被评判词条的 kind（correction 类决定且写入方知道时带上；
     *  术语改对率的分子按它过滤，delete/filler 不算术语）。 */
    entryKind?: string;
    at: number;
  }
  | {
    kind: 'meeting_asset_ref';
    docId: string;
    assetId: string;
    version: string;
    via: 'attach' | 'conclusion' | 'action_draft';
    at: number;
  }
  | {
    kind: 'meeting_model_usage';
    docId: string;
    operation: 'review';
    /** 测不到的字段允许缺失（不写 0 假装测到，T056）；至少一个存在才成事件。 */
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    at: number;
  }
  | {
    kind: 'meeting_revert';
    docId: string;
    runId: string;
    /** 被回滚 run 接受过的条数（过纠正率的分子：这些 accept 被撤销）。 */
    acceptedCount: number;
    at: number;
  };

export type MeetingMetricKind = MeetingMetricEvent['kind'];

/** 事件输入形态（`at` 由 recordMeetingMetric 内部补，调用方不操心时钟）。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type MeetingMetricEventInput = DistributiveOmit<MeetingMetricEvent, 'at'>;

const MEETING_METRIC_KINDS: ReadonlySet<string> = new Set([
  'meeting_scan', 'meeting_decision', 'meeting_asset_ref', 'meeting_model_usage', 'meeting_revert',
]);

/** 每字段截断上限（防御性：脏输入不该让一行无限长）。 */
const MAX_EVENT_DOC_ID_CHARS = 1000;
const MAX_EVENT_ID_CHARS = 128;

function boundedId(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function optionalCount(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * 追加一条会议指标事件（append-only、一行一事件）。
 * IO 失败不炸链路（try/catch + warn）；事件里至少要有一个可辨认的 token 读数
 * （`meeting_model_usage`）——全缺失时不写（不写 0 假装测到）。
 */
export function recordMeetingMetric(userId: string, event: MeetingMetricEventInput): void {
  if (!event || typeof event.kind !== 'string' || !MEETING_METRIC_KINDS.has(event.kind)) {
    throw new Error(`unknown meeting metric kind: ${(event as { kind?: unknown })?.kind}`);
  }
  const at = Date.now();
  let record: MeetingMetricEvent;
  switch (event.kind) {
    case 'meeting_scan':
      record = {
        kind: 'meeting_scan',
        docId: boundedId(event.docId, MAX_EVENT_DOC_ID_CHARS),
        candidates: count(event.candidates),
        exact: count(event.exact),
        recall: count(event.recall),
        model: count(event.model),
        quotedExample: count(event.quotedExample),
        truncated: event.truncated === true,
        ...(optionalCount(event.termCandidates) !== undefined ? { termCandidates: optionalCount(event.termCandidates) as number } : {}),
        at,
      };
      break;
    case 'meeting_decision':
      record = {
        kind: 'meeting_decision',
        docId: boundedId(event.docId, MAX_EVENT_DOC_ID_CHARS),
        itemId: boundedId(event.itemId, MAX_EVENT_ID_CHARS),
        itemKind: event.itemKind,
        decision: event.decision,
        refs: count(event.refs),
        ...(boundedId(event.entryKind, 64) ? { entryKind: boundedId(event.entryKind, 64) } : {}),
        at,
      };
      break;
    case 'meeting_asset_ref':
      record = {
        kind: 'meeting_asset_ref',
        docId: boundedId(event.docId, MAX_EVENT_DOC_ID_CHARS),
        assetId: boundedId(event.assetId, MAX_EVENT_ID_CHARS),
        version: boundedId(event.version, 64) || '1',
        via: event.via,
        at,
      };
      break;
    case 'meeting_model_usage': {
      const inputTokens = optionalCount(event.inputTokens);
      const outputTokens = optionalCount(event.outputTokens);
      const totalTokens = optionalCount(event.totalTokens);
      // 无采集就不写事件（T056：no_model / model_failed ⇒ 零事件，不写 0 假装测到）。
      if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return;
      record = {
        kind: 'meeting_model_usage',
        docId: boundedId(event.docId, MAX_EVENT_DOC_ID_CHARS),
        operation: 'review',
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        at,
      };
      break;
    }
    default:
      record = {
        kind: 'meeting_revert',
        docId: boundedId(event.docId, MAX_EVENT_DOC_ID_CHARS),
        runId: boundedId(event.runId, MAX_EVENT_ID_CHARS),
        acceptedCount: count(event.acceptedCount),
        at,
      };
      break;
  }
  try {
    const file = userMeetingMetricsFile(userId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    // 埋点写不进去不该让业务链路失败（对齐 recordCostTelemetry 的先例）。
    log.warn('record meeting metric failed', { error: (error as Error).message });
  }
}

/** 读会议指标事件（坏行与未知 kind 跳过；可按 docId 过滤）。文件缺失 → 空数组。 */
export function readMeetingEvents(
  userId: string,
  opts: { docId?: string } = {},
): MeetingMetricEvent[] {
  let raw = '';
  try {
    raw = fs.readFileSync(userMeetingMetricsFile(userId), 'utf8');
  } catch {
    return [];
  }
  const docId = opts?.docId ? String(opts.docId) : '';
  const out: MeetingMetricEvent[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as MeetingMetricEvent;
      if (!parsed || typeof parsed.kind !== 'string' || !MEETING_METRIC_KINDS.has(parsed.kind)) continue;
      if (docId && parsed.docId !== docId) continue;
      out.push(parsed);
    } catch {
      continue; // 坏行跳过（对齐既有 readEvents 的容错口径）
    }
  }
  return out;
}

// ── T055：五项口径 ────────────────────────────────────────────────────────

/** 每项比率必带分母与样本数（"只给裸数说不出所以然"，spec US-506 AC2）。 */
export interface MetricRate {
  numerator: number;
  denominator: number;
  /** 分母为 0 ⇒ null（空数据不编数字）。 */
  rate: number | null;
  samples: number;
}

export interface MeetingMetricsSummary {
  scope: { docId?: string };
  /** 扫描次数（= meeting_scan 事件数；字段名沿用既有 runs 语义）。 */
  glossaryRuns: number;
  adoption: MetricRate;
  misReference: MetricRate;
  token: { inputTokens: number; outputTokens: number; totalTokens: number; samples: number };
  entity: {
    termFixedRate: MetricRate;
    overCorrectionRate: MetricRate;
    samples: number;
  };
  /** 测不了的指标（如实列出，不编数字；至少含 data-model §5.2 的三条）。 */
  notMeasurable: string[];
}

/** 术语类的词条 kind（data-model §5.1：delete 类——口癖——不算术语）。 */
export const TERM_ENTRY_KINDS: ReadonlySet<string> = new Set(['product', 'term', 'course', 'people', 'org']);

function rate(numerator: number, denominator: number): MetricRate {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
    samples: denominator,
  };
}

type ScanEvent = Extract<MeetingMetricEvent, { kind: 'meeting_scan' }>;
type DecisionEvent = Extract<MeetingMetricEvent, { kind: 'meeting_decision' }>;

/**
 * 五项口径汇总（纯函数：给事件，算口径——形态对齐 `summarizeMetrics`）。
 *
 * 口径（plan.md D15 / data-model §5.1）与撤销处理：
 *   - 采纳率 = accept / (accept + modify + reject + ignore)。`defer` 不入分母
 *     （暂缓不是决定）；`keep_current` 不在公式内（同样不入）；引例降级项没进
 *     候选 ⇒ 不会有 decision 事件，天然排除；**`unreject`（撤销写的 accept）
 *     不计入分子也不计入分母**——撤销是"回到未定"，不是一次采纳。
 *   - 误引用率 = 判为"引用不当"的引用条数 / `assetRefs` 出现次数（同 docId+
 *     assetId 去重，与引用包"同一 assetId 只留一条"同口径）。"引用不当"按
 *     该引用条目 decision 事件的**末条**判定（reject/modify），其后被 `unreject`
 *     撤销的不再计（与撤销剔除口径一致）；未被评判的引用**不算错**。
 *   - token 增量 = 会议场景模型调用 input+output 累加（绝对值，不宣称因果；
 *     事件里的 totalTokens 如实记账，汇总口径固定 input+output，不混 cache）。
 *   - 术语改对率 = 术语类 accept / 术语类候选出现次数（`meeting_scan.termCandidates`
 *     累加；写入方没分桶时分母为 0 ⇒ rate:null，不编）。
 *   - 过纠正率 = accept 后被 revertRun 撤销的条数（meeting_revert.acceptedCount
 *     累加；未 apply 的 accept 本来就不该被 revert 撤到）/ accept 总数。
 */
export function summarizeMeetingMetrics(
  events: MeetingMetricEvent[],
  opts: { docId?: string } = {},
): MeetingMetricsSummary {
  const scoped = opts?.docId ? events.filter((event) => event.docId === opts.docId) : events;

  const scanEvents = scoped.filter((event): event is ScanEvent => event.kind === 'meeting_scan');
  const decisionEvents = scoped.filter((event): event is DecisionEvent => event.kind === 'meeting_decision');
  // 撤销（unreject）双侧剔除：它撤销的是既有决定，自己不是一次新的采纳/拒绝。
  const effective = decisionEvents.filter((event) => event.decision !== 'unreject');
  const accepts = effective.filter((event) => event.decision === 'accept');
  const adoption = rate(
    accepts.length,
    effective.filter((event) => ['accept', 'modify', 'reject', 'ignore'].includes(event.decision)).length,
  );

  const assetRefEvents = scoped.filter((event) => event.kind === 'meeting_asset_ref');
  const distinctAssetRefs = new Set(assetRefEvents.map((event) => `${event.docId}\u0000${event.assetId}`));
  // 引用条目的"不当"判定按末条（追加序）：被 unreject 撤销的 reject/modify 不再计。
  const lastJudgeByItem = new Map<string, DecisionEvent>();
  for (const event of decisionEvents) {
    if (event.itemKind !== 'asset_ref') continue;
    if (event.decision !== 'reject' && event.decision !== 'modify' && event.decision !== 'unreject') continue;
    lastJudgeByItem.set(`${event.docId}\u0000${event.itemId}`, event);
  }
  const misJudged = [...lastJudgeByItem.values()]
    .filter((event) => event.decision === 'reject' || event.decision === 'modify').length;
  const misReference = rate(misJudged, distinctAssetRefs.size);

  const usageEvents = scoped.filter((event) => event.kind === 'meeting_model_usage');
  const sumOf = (pick: (event: Extract<MeetingMetricEvent, { kind: 'meeting_model_usage' }>) => number | undefined) =>
    usageEvents.reduce((total, event) => total + (pick(event as Extract<MeetingMetricEvent, { kind: 'meeting_model_usage' }>) ?? 0), 0);
  const inputTokens = sumOf((event) => event.inputTokens);
  const outputTokens = sumOf((event) => event.outputTokens);
  const token = {
    inputTokens,
    outputTokens,
    // 口径固定 input+output（D15）；totalTokens 字段如实存账但不进汇总（避免与
    // cache 计入口径混流——两套口径并排会让人以为差值也是实测）。
    totalTokens: inputTokens + outputTokens,
    samples: usageEvents.length,
  };

  const termAccepts = effective.filter((event) =>
    event.decision === 'accept'
    && typeof event.entryKind === 'string'
    && TERM_ENTRY_KINDS.has(event.entryKind)).length;
  const termAppearances = scanEvents.reduce(
    (total, event) => total + (typeof event.termCandidates === 'number' && Number.isFinite(event.termCandidates)
      ? Math.max(0, Math.floor(event.termCandidates))
      : 0),
    0,
  );
  const termFixedRate = rate(termAccepts, termAppearances);

  const revertedCount = scoped
    .filter((event) => event.kind === 'meeting_revert')
    .reduce((total, event) => total + Math.max(0, Math.floor((event as Extract<MeetingMetricEvent, { kind: 'meeting_revert' }>).acceptedCount) || 0), 0);
  const overCorrectionRate = rate(revertedCount, accepts.length);

  return {
    scope: opts?.docId ? { docId: opts.docId } : {},
    glossaryRuns: scanEvents.length,
    adoption,
    misReference,
    token,
    entity: {
      termFixedRate,
      overCorrectionRate,
      samples: termFixedRate.samples + overCorrectionRate.samples,
    },
    notMeasurable: [
      '引用层带来的纪要质量提升：无对照环境，不宣称因果',
      '引用层带来的 token 净增/净省：仅能测引用层自身消耗，无"同任务无引用"的基线',
      '跨设备/跨用户的对照口径：本功能只有本机数据，不做跨账号推断',
      'accept 后被用户手动改回的条数：该动作发生在产品之外，过纠正率分子只含 revertRun 可追溯部分',
    ],
  };
}

// ── T053：回执汇总（读既有账本过滤，不建第二套） ───────────────────────────

/** 回执视图的依据标识（只带标识不带正文：词条 id / 资产 id，privacy D20）。 */
export type MeetingReceiptRef =
  | { source: 'glossary'; entryId: string }
  | { source: 'asset'; assetId: string };

export interface MeetingReceiptView {
  decisionId: string;
  /** `target_ref = meeting:<docId>:<itemId>` 的条目段（候选 entryRef / 结论 id / 待办 id / 引用 id）。 */
  itemId: string;
  itemKind: 'correction' | 'conclusion' | 'action';
  decisionType: ReviewDecisionType;
  /** 用户可见的动作名（原样透传，不在此翻译）。 */
  decision: string;
  at: string;
  refs: MeetingReceiptRef[];
}

/** 会议侧回执的 target_ref 前缀（与 ipc/transcript.ts 的写入侧同构）。 */
export const MEETING_RECEIPT_TARGET_PREFIX = 'meeting:';
/** 读既有账本时一次拉取的窗口上限（`listRecentReviewDecisions` 自身 clamp 到 200）。 */
export const MEETING_RECEIPT_SCAN_LIMIT = 200;
/** 返回条数上限（contracts/ipc.md §1.6：limit 1~200，缺省 50）。 */
export const MAX_MEETING_RECEIPTS = 50;

/** `meeting:<docId>:<itemId>` → `itemId`（docId 可含 `:`，itemId 段不含——取末段）。 */
export function itemIdOfTargetRef(targetRef: string): string | null {
  const rest = String(targetRef ?? '').slice(MEETING_RECEIPT_TARGET_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0 || sep >= rest.length - 1) return null;
  return rest.slice(sep + 1);
}

function itemKindOfItemId(itemId: string): MeetingReceiptView['itemKind'] {
  if (itemId.startsWith('mc_')) return 'conclusion';
  if (itemId.startsWith('ma_')) return 'action';
  return 'correction';
}

function toReceiptView(record: ReviewDecision): MeetingReceiptView {
  const itemId = itemIdOfTargetRef(record.target_ref) ?? '';
  const itemKind = itemKindOfItemId(itemId);
  const refs: MeetingReceiptRef[] = [];
  if (itemKind === 'correction' && itemId) refs.push({ source: 'glossary', entryId: itemId });
  // 账本的 asset_id 字段（涉及资产时填）——只带标识；版本快照不在账本里，
  // 不去引用包现拼（那是另一个数据源的活，拼了反而要处理失步）。
  if (typeof record.asset_id === 'string' && record.asset_id) {
    refs.push({ source: 'asset', assetId: record.asset_id });
  }
  return {
    decisionId: record.decision_id,
    itemId,
    itemKind,
    decisionType: record.decision_type,
    decision: record.decision,
    at: record.timestamp,
    refs,
  };
}

/**
 * 会议侧回执清单（contracts/ipc.md §1.6，features 层读口）。
 *
 * 读**既有** `listRecentReviewDecisions`（review-decision.ts:200，一行不改）后按
 * `target_ref` 前缀 `meeting:` 过滤；`docId` 给定时进一步按 `meeting:<docId>:`
 * 前缀收窄。返回体只带标识（decisionId/itemId/决定/时间/依据标识）——
 * `reason`/`modified_content` 等自由文本**不进视图**（不含正文）。
 * 空数组即空态，无失败码。
 */
export async function listMeetingReceipts(
  uid: string,
  opts: { docId?: string; limit?: number } = {},
): Promise<MeetingReceiptView[]> {
  const limitRaw = Math.floor(Number(opts?.limit));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, limitRaw) : MAX_MEETING_RECEIPTS;
  const docId = opts?.docId ? String(opts.docId) : '';
  // 先拉最大窗再过滤：listRecentReviewDecisions 是"先全局截断再返回"，直接把
  // 调用方的 limit 传下去会把会议回执截没（非会议决定占满窗口时一条都漏不出来）。
  const page = await listRecentReviewDecisions(uid, { limit: MEETING_RECEIPT_SCAN_LIMIT });
  return page.items
    .filter((record) => typeof record.target_ref === 'string'
      && record.target_ref.startsWith(MEETING_RECEIPT_TARGET_PREFIX))
    .filter((record) => !docId || record.target_ref.startsWith(`${MEETING_RECEIPT_TARGET_PREFIX}${docId}:`))
    .slice(0, limit)
    .map(toReceiptView);
}
