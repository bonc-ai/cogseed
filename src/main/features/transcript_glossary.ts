/**
 * transcript_glossary — 转写纠错词表（本体驱动的转写词汇纠错表 · P0）
 *
 * 规划依据（本仓库外的方案文档，2026-09-14 v0.2）：
 *   - 词条是 `wrong → correct` 的**用户确认过的**纠错对；LLM/本体只能产生"候选"，
 *     不得静默写回词表，更不得改写本体别名（Candidate ≠ Confirmed）。
 *   - 词条带**作用域**：一次会议里学到的变体不得自动升格为全局规则
 *     （真实事故：7 个姓氏变体被当全局规则加载数月，把无关稿件的"某老师"
 *     替换成他人姓名）。
 *   - 高危短词（`for` / `model` / `contact` / `redmi` 这类合法英文词）默认
 *     逐条人工确认，不允许"全部个人库"范围。
 *
 * 存储：`<uid>/cloud/cogseed/transcript/transcript-glossary.json`（见 paths.ts）。
 *   - 用户私有可复核资产 → cloud 域；目录**非隐藏**（隐藏目录会被 KB
 *     reconcile 的 walk 跳过 → 索引行在下次启动时被 prune）。
 *   - 写入是原子替换（tmp + rename），读损坏时降级为空表并告警，避免把
 *     整份词表搞丢。
 *
 * 本模块只做"词表数据 + 归一化 + 风险分级 + 迁移"，不含扫描/替换
 * （见 transcript_auto_correct.ts）与产物/回滚（见 transcript_correction_runs.ts）。
 *
 * ── 候选区（`candidates`）与词条区（`entries`）的硬隔离 ──────────────────
 * 模型在纠错里给出的候选**只能进候选区**，且只能是 `pending`：
 *   - `entries` 是扫描/替换的唯一输入（`transcript_auto_correct.scanText` 只吃
 *     `GlossaryEntry[]`；IPC 也一律 `listEntries(uid, { status: 'active' })`）。
 *     候选存在另一个数组里，**结构上不可能**被扫描到——这不是靠调用方自觉过滤。
 *     不用 `status: 'pending'` 的原因：`scanText` 有 `includePaused` 逃生口，
 *     同一个 status 字段迟早会被那个开关连带放开，等于把闸门交给调用方。
 *   - 候选 → 词条的唯一通道是 `adoptCandidate`，且必须由人显式调用；
 *     采纳时按 `source: 'manual'` / `createdBy: 'manual'` 建条，留 `adoptedEntryId`
 *     以便追溯"这条规则当初是哪次模型候选、谁点的确认"。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { userTranscriptGlossaryFile } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('transcript_glossary');

// ── 类型 ────────────────────────────────────────────────────────────────

export type GlossaryKind =
  | 'product' | 'people' | 'org' | 'term' | 'venue' | 'course' | 'filler';
export type GlossaryAction = 'replace' | 'delete';
export type RiskLevel = 'low' | 'medium' | 'high';
export type BoundaryMode = 'substring' | 'word';
export type EntryStatus = 'active' | 'paused';
export type OwnerScope = 'personal' | 'team' | 'org';
export type EntrySource = 'manual' | 'meeting_accept' | 'ontology_seed' | 'import';
export type CreatedBy = 'manual' | 'harvest' | 'import';
/** 候选来源。目前只有模型：人工输入走 `upsertEntry` 直接建词条，不进候选区。 */
export type CandidateOrigin = 'llm';
/** 候选状态：`pending` 待核 → `adopted` 已入表 / `discarded` 已丢弃（终态可复习）。 */
export type CandidateState = 'pending' | 'adopted' | 'discarded';

export interface GlossaryScope {
  /** 允许生效的文档 id（空数组 = 不按文档限制）。 */
  docIds: string[];
  /** 允许生效的场景标签（空数组 = 不按场景限制）。 */
  scenarioTags: string[];
  /** true = 全局生效；false = 只在 docIds/scenarioTags 命中时生效。 */
  global: boolean;
}

export interface ReplacedInRef {
  docId: string;
  runId: string;
  count: number;
  at: number;
}

export interface GlossaryEntry {
  id: string;
  /** 错误/待纠形态（按用户输入保留展示用大小写）。 */
  wrong: string;
  correct: string;
  action: GlossaryAction;
  kind: GlossaryKind;
  riskLevel: RiskLevel;
  boundary: BoundaryMode;
  /** 语境黑名单：命中窗口内出现任一词则拒绝替换（防 `傅平/扶贫办` 类误替换）。 */
  contextDeny: string[];
  /**
   * 语境白名单（方案 §七「加白」）：窗口内出现任一词则**整条候选不产出**，
   * 连待确认都不出现——用于"这个词在这个语境里是对的，别再提示我"。
   * 与 `contextDeny` 的区别：deny 只否决替换（仍上报为 denied），allow 直接静默。
   */
  contextAllow: string[];
  scope: GlossaryScope;
  /** 被确认替换的累计次数（越高越优先展示）。 */
  freq: number;
  source: EntrySource;
  status: EntryStatus;
  ownerScope: OwnerScope;
  ontologyRef?: { groupId: string; fieldId: string };
  /** 台账：只追加，替换路径不得改写（改写台账 = 审计失效）。 */
  replacedIn: ReplacedInRef[];
  createdBy: CreatedBy;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt: number;
  /**
   * 忽略留痕（方案 §七「忽略（可逆，降权）」）：被忽略的次数与最近一次时间。
   * 忽略**不删词条**、不改台账，只用于降权排序与面板折叠；恢复时次数清零。
   */
  ignoredCount?: number;
  ignoredAt?: number;
}

export interface GlossaryFile {
  version: 3;
  uid: string;
  entries: GlossaryEntry[];
  /**
   * 候选区：模型的"我觉得这里应该是 X"只落在这里，**永远不参与扫描**。
   * 与 `entries` 是两个数组——扫描入口拿到的类型就是 `GlossaryEntry[]`，
   * 候选结构上到不了扫描器。
   */
  candidates: GlossaryCandidate[];
  meta: {
    lastReconcileAt: number;
    ownerNote: string;
    /** 检索前 query 同义改写开关（方案 §五 P2-3，默认关：用户要能预期检索行为）。 */
    queryRewrite?: boolean;
  };
}

/**
 * 一条待核候选：模型给出的 `wrong → correct` 建议 + 它凭什么这么说。
 * 关键约束：**没有 `status: 'active'` 这种状态**。候选就是候选，
 * 想生效必须先 `adoptCandidate` 变成真词条（人工确认）。
 */
export interface GlossaryCandidate {
  id: string;
  /** 转写里被怀疑写错的那段原文。 */
  wrong: string;
  /** 模型建议的写法。**允许不在词表里**（放开白名单后这是常态）。 */
  correct: string;
  /** 模型自报置信度（0~1，仅用于排序与展示，不构成任何自动动作）。 */
  confidence: number;
  /** 模型给的一句理由。 */
  reason: string;
  /** 给出该候选时的上下文片段（截断），供人工复核判断。 */
  context: string;
  kind: GlossaryKind;
  origin: CandidateOrigin;
  /** 来源文档（有则记，便于"这条候选是哪份稿子里的"）。 */
  docId?: string;
  /** 原文偏移；只在该次扫描的坐标下有意义，仅作展示线索。 */
  start?: number;
  /**
   * 该建议是否落在"允许目标"提示名单里。放开白名单后模型可以提议表外写法，
   * 这一位用来在复核时区分"词表已有的写法"与"模型自己想的写法"。
   */
  inAllowlist: boolean;
  state: CandidateState;
  createdAt: number;
  /** 终态时间（采纳/丢弃）。 */
  resolvedAt?: number;
  /** 采纳后生成的词条 id —— 用来追溯"哪条规则来自哪次模型候选"。 */
  adoptedEntryId?: string;
}

export interface RecordCandidateInput {
  wrong?: unknown;
  correct?: unknown;
  confidence?: unknown;
  reason?: unknown;
  context?: unknown;
  kind?: unknown;
  docId?: unknown;
  start?: unknown;
  inAllowlist?: unknown;
}

export interface RecordCandidatesResult {
  /** 本次新记入的候选 id（已存在的 pending 只更新置信/理由，不重复入库）。 */
  added: number;
  updated: number;
  /** 被挡掉的：空 wrong/correct、纯数字变体、已是词条、超长。 */
  skipped: Array<{ wrong: string; correct: string; why: string }>;
  /** 记入后的待核总数。 */
  pending: number;
}

export interface AdoptCandidateResult {
  candidate: GlossaryCandidate | null;
  entry: GlossaryEntry | null;
  /** 词条是否新建（false = 更新已有词条）。 */
  created: boolean;
  /** 未入表的原因。 */
  skippedReason?: 'not_found' | 'not_pending' | 'pure_digit_variant' | 'invalid_target';
}

export interface UpsertEntryInput {
  wrong?: unknown;
  correct?: unknown;
  action?: unknown;
  kind?: unknown;
  boundary?: unknown;
  /** 允许调用方（人工复核后的导入）显式指定；缺省时按规则推导。 */
  riskLevel?: unknown;
  contextDeny?: unknown;
  contextAllow?: unknown;
  scope?: unknown;
  source?: unknown;
  ownerScope?: unknown;
  ontologyRef?: unknown;
  /** 明确标注"仅在某语境成立"的条目 → 强制 high。 */
  partial?: unknown;
}

export interface UpsertResult {
  entry: GlossaryEntry | null;
  created: boolean;
  /** 未入册的原因（当前只有一种：纯数字变体）。 */
  skippedReason?: 'pure_digit_variant';
}

const GLOSSARY_VERSION = 3 as const;
const MAX_ENTRIES = 2000;
/** 候选区上限：只留最近这么多条，防止长期使用把文件撑大。 */
const MAX_CANDIDATES = 500;
const MAX_CANDIDATE_CONTEXT_LEN = 200;
const MAX_WRONG_LEN = 80;
const MAX_CORRECT_LEN = 200;

// ── 归一化 ──────────────────────────────────────────────────────────────
// 逐**码点**折叠（NFKC + 小写），折叠后长度与原文一致时采用，否则保留原字符。
// 这样 folded 串与原串的 UTF-16 下标一一对应，扫描器可直接用折叠串定位、
// 用原串取 span（否则全角/大小写归一化会让 span 整体错位）。

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const WORD_RE = /[0-9A-Za-z]/;

export function foldChar(ch: string): string {
  const folded = ch.normalize('NFKC').toLowerCase();
  return folded.length === 1 ? folded : ch;
}

export function foldText(text: string): string {
  let out = '';
  for (const ch of text) out += foldChar(ch);
  return out;
}

export function isCjkOrWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return CJK_RE.test(ch) || WORD_RE.test(ch);
}

export function isPureDigits(text: string): boolean {
  return /^[0-9]+$/.test(foldText(text).trim());
}

/** 单姓 + 敬称（朱老师 / 王总 / 张哥…）：拒绝入册的形态之一。 */
export function isSingleSurnameHonorific(text: string): boolean {
  return /^[\u4e00-\u9fff](老师|总|哥|姐|先生|女士)$/.test(text.trim());
}

// ── 风险分级 ────────────────────────────────────────────────────────────

/**
 * 已知高危 token：合法英文词/介词/框架词，全局替换会写坏用户所有文档。
 * 来源：真实清理产物里出现过 `for→Foo`、`model→Moodle`、`contact→Context`、
 * `redmi→README` 这几条。
 */
const HIGH_RISK_TOKENS = new Set([
  'for', 'model', 'contact', 'redmi', 'readme', 'cloud', 'moodle', 'context',
  'code', 'data', 'test', 'all', 'new', 'open', 'name', 'type', 'list',
]);

export interface RiskContext {
  /** 同一 wrong 已存在的其它 correct（同形多解 → high）。 */
  otherCorrects?: string[];
}

export function deriveRiskLevel(
  input: { wrong: string; correct: string; action: GlossaryAction; partial?: boolean },
  ctx: RiskContext = {},
): RiskLevel {
  const foldedWrong = foldText(input.wrong).trim();
  if (input.partial) return 'high';
  if (input.action === 'delete') return 'low';
  if (isSingleSurnameHonorific(input.wrong)) return 'high';
  if (foldedWrong.length <= 2) return 'high';
  if (/^[a-z]+$/.test(foldedWrong) && HIGH_RISK_TOKENS.has(foldedWrong)) return 'high';
  if (input.correct.length >= input.wrong.length * 4 && foldedWrong.length <= 3) return 'high';
  const others = (ctx.otherCorrects ?? []).map((c) => foldText(c).trim());
  if (others.length > 0 && !others.every((c) => c === foldText(input.correct).trim())) return 'high';
  return 'low';
}

export function defaultBoundary(wrong: string, action: GlossaryAction): BoundaryMode {
  if (action === 'delete') return 'substring';
  return /^[A-Za-z][A-Za-z0-9._+-]*$/.test(wrong.trim()) ? 'word' : 'substring';
}

// ── 作用域 ──────────────────────────────────────────────────────────────

export function scopeAllows(
  scope: GlossaryScope,
  target: { docId?: string; scenarioTags?: string[] },
): boolean {
  if (scope.global) return true;
  if (target.docId && scope.docIds.includes(target.docId)) return true;
  const tags = target.scenarioTags ?? [];
  return tags.some((t) => scope.scenarioTags.includes(t));
}

// ── 迁移 v1 → v2 ────────────────────────────────────────────────────────

interface V1Entry {
  id?: unknown; wrong?: unknown; correct?: unknown; kind?: unknown;
  scenarioTags?: unknown; freq?: unknown; source?: unknown; status?: unknown;
  ownerScope?: unknown; ontologyRef?: unknown; createdAt?: unknown; updatedAt?: unknown;
}

/** v1（2026-09-07 方案首版模型）→ v2：补 action / riskLevel / boundary /
 *  contextDeny / scope / replacedIn / createdBy / lastVerifiedAt / uid。 */
export function migrateGlossaryV1ToV2(raw: { entries?: unknown; meta?: unknown }, uid: string): GlossaryFile {
  const list = Array.isArray(raw?.entries) ? raw.entries : [];
  const entries: GlossaryEntry[] = [];
  for (const item of list as V1Entry[]) {
    const wrong = typeof item?.wrong === 'string' ? item.wrong.trim() : '';
    const correct = typeof item?.correct === 'string' ? item.correct.trim() : '';
    if (!wrong || !correct) continue;
    const createdAt = typeof item?.createdAt === 'number' ? item.createdAt : Date.now();
    const updatedAt = typeof item?.updatedAt === 'number' ? item.updatedAt : createdAt;
    const kind = normalizeKind(item?.kind);
    const action: GlossaryAction = 'replace';
    entries.push({
      id: entryId(wrong, correct),
      wrong,
      correct,
      action,
      kind,
      riskLevel: deriveRiskLevel({ wrong, correct, action, partial: isPartialTag(item) }),
      boundary: defaultBoundary(wrong, action),
      contextDeny: [],
      contextAllow: [],
      scope: {
        docIds: [],
        scenarioTags: Array.isArray(item?.scenarioTags)
          ? (item.scenarioTags as unknown[]).filter((t): t is string => typeof t === 'string')
          : [],
        // v1 没有作用域概念，词条语义上就是全局的；保持原语义，避免迁移后
        // 突然"什么都不命中了"。
        global: true,
      },
      freq: typeof item?.freq === 'number' && item.freq >= 0 ? Math.floor(item.freq) : 0,
      source: normalizeSource(item?.source),
      status: item?.status === 'paused' ? 'paused' : 'active',
      ownerScope: item?.ownerScope === 'team' || item?.ownerScope === 'org' ? item.ownerScope : 'personal',
      ...(isOntologyRef(item?.ontologyRef) ? { ontologyRef: item.ontologyRef } : {}),
      replacedIn: [],
      createdBy: item?.source === 'import' ? 'import' : 'manual',
      createdAt,
      updatedAt,
      lastVerifiedAt: updatedAt,
    });
  }
  const meta = (raw?.meta ?? {}) as { lastReconcileAt?: unknown; ownerNote?: unknown };
  return {
    version: GLOSSARY_VERSION,
    uid,
    entries,
    // v1 没有候选区；迁移出来的表就是"没有待核候选"，不造占位数据。
    candidates: [],
    meta: {
      lastReconcileAt: typeof meta.lastReconcileAt === 'number' ? meta.lastReconcileAt : 0,
      ownerNote: typeof meta.ownerNote === 'string' ? meta.ownerNote : '',
    },
  };
}

function isPartialTag(item: V1Entry): boolean {
  const tags = Array.isArray(item?.scenarioTags) ? (item.scenarioTags as unknown[]) : [];
  return tags.some((t) => typeof t === 'string' && /部分|仅/.test(t));
}

function isOntologyRef(v: unknown): v is { groupId: string; fieldId: string } {
  const r = v as { groupId?: unknown; fieldId?: unknown } | null;
  return !!r && typeof r.groupId === 'string' && typeof r.fieldId === 'string';
}

function normalizeKind(v: unknown): GlossaryKind {
  const allowed: GlossaryKind[] = ['product', 'people', 'org', 'term', 'venue', 'course', 'filler'];
  return typeof v === 'string' && (allowed as string[]).includes(v) ? (v as GlossaryKind) : 'term';
}

function normalizeSource(v: unknown): EntrySource {
  const allowed: EntrySource[] = ['manual', 'meeting_accept', 'ontology_seed', 'import'];
  return typeof v === 'string' && (allowed as string[]).includes(v) ? (v as EntrySource) : 'manual';
}

// ── 存储 ────────────────────────────────────────────────────────────────

export function emptyGlossary(uid: string): GlossaryFile {
  return { version: GLOSSARY_VERSION, uid, entries: [], candidates: [], meta: { lastReconcileAt: 0, ownerNote: '' } };
}

export function loadGlossary(userId: string): GlossaryFile {
  const file = userTranscriptGlossaryFile(userId);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ENOENT') log.warn('glossary unreadable; starting from empty', { code });
    return emptyGlossary(userId);
  }
  const record = raw as { version?: unknown; uid?: unknown } | null;
  if (!record || typeof record !== 'object') {
    log.warn('glossary payload is not an object; starting from empty');
    return emptyGlossary(userId);
  }
  // uid 落盘校验：文件里的 uid 与本会话属主不一致说明被拷错了位置，
  // 宁可报警重来，也不要把别人的词表当成自己的用。
  if (typeof record.uid === 'string' && record.uid && record.uid !== userId) {
    log.warn('glossary uid mismatch; ignoring foreign file', { expected: userId });
    return emptyGlossary(userId);
  }
  if (record.version === 1 || typeof record.version !== 'number') {
    const migrated = migrateGlossaryV1ToV2(raw as { entries?: unknown; meta?: unknown }, userId);
    log.info('glossary migrated from v1 to current', { version: migrated.version, entries: migrated.entries.length });
    saveGlossary(userId, migrated);
    return migrated;
  }
  const file2 = raw as Partial<GlossaryFile>;
  return {
    version: GLOSSARY_VERSION,
    uid: userId,
    entries: Array.isArray(file2.entries) ? file2.entries.map(normalizeStoredEntry).filter(isEntry) : [],
    // v2 文件没有候选区 → 空数组，读取路径不需要迁移动作（写回时统一升到 v3）。
    candidates: Array.isArray(file2.candidates)
      ? file2.candidates.map(normalizeStoredCandidate).filter(isCandidate)
      : [],
    meta: {
      lastReconcileAt: typeof file2.meta?.lastReconcileAt === 'number' ? file2.meta.lastReconcileAt : 0,
      ownerNote: typeof file2.meta?.ownerNote === 'string' ? file2.meta.ownerNote : '',
      ...(file2.meta?.queryRewrite === true ? { queryRewrite: true } : {}),
    },
  };
}

function isEntry(e: GlossaryEntry | null): e is GlossaryEntry {
  return !!e;
}

function isCandidate(c: GlossaryCandidate | null): c is GlossaryCandidate {
  return !!c;
}

/**
 * 候选区的磁盘归一化。这里刻意**不**复用 `normalizeStoredEntry`：
 * 候选没有 scope/riskLevel/boundary 这些"生效语义"，任何一条被改坏就整条丢掉，
 * 绝不把可疑数据补成一个看起来合法的词条。
 */
function normalizeStoredCandidate(input: unknown): GlossaryCandidate | null {
  const c = input as Partial<GlossaryCandidate> | null;
  if (!c || typeof c.wrong !== 'string' || typeof c.correct !== 'string') return null;
  const wrong = c.wrong.trim();
  const correct = c.correct.trim();
  if (!wrong || !correct) return null;
  const state: CandidateState = c.state === 'adopted' || c.state === 'discarded' ? c.state : 'pending';
  const confidenceRaw = Number(c.confidence);
  const createdAt = typeof c.createdAt === 'number' ? c.createdAt : Date.now();
  return {
    id: typeof c.id === 'string' && c.id ? c.id : candidateId(wrong, correct),
    wrong: wrong.slice(0, MAX_WRONG_LEN),
    correct: correct.slice(0, MAX_CORRECT_LEN),
    confidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0,
    reason: typeof c.reason === 'string' ? c.reason.slice(0, 200) : '',
    context: typeof c.context === 'string' ? c.context.slice(0, MAX_CANDIDATE_CONTEXT_LEN) : '',
    kind: normalizeKind(c.kind),
    // 目前只有模型会写候选区；手工改文件写别的来源也归到 llm，宁可保守。
    origin: 'llm',
    ...(typeof c.docId === 'string' && c.docId ? { docId: c.docId.slice(0, 200) } : {}),
    ...(typeof c.start === 'number' && Number.isFinite(c.start) ? { start: Math.max(0, Math.floor(c.start)) } : {}),
    inAllowlist: c.inAllowlist === true,
    state,
    createdAt,
    ...(typeof c.resolvedAt === 'number' ? { resolvedAt: c.resolvedAt } : {}),
    ...(typeof c.adoptedEntryId === 'string' && c.adoptedEntryId ? { adoptedEntryId: c.adoptedEntryId } : {}),
  };
}

/** 磁盘上可能残留手工改坏的字段；逐字段收敛到合法值，避免扫描器拿到野值。 */
function normalizeStoredEntry(input: unknown): GlossaryEntry | null {
  const e = input as Partial<GlossaryEntry> | null;
  if (!e || typeof e.wrong !== 'string' || typeof e.correct !== 'string') return null;
  const wrong = e.wrong.trim();
  const correct = e.correct.trim();
  const action: GlossaryAction = e.action === 'delete' ? 'delete' : 'replace';
  // 删除类词条（口癖）**本来就没有 correct**：早先的校验把 `correct` 为空一律当脏数据
  // 丢掉，于是口癖词条能写进文件却读不回来（写一次覆盖一次，只剩最后一条）。
  // 这里按 action 区分：replace 必须有正确写法，delete 只要求错形非空。
  if (!wrong) return null;
  if (action === 'replace' && !correct) return null;
  const createdAt = typeof e.createdAt === 'number' ? e.createdAt : Date.now();
  const updatedAt = typeof e.updatedAt === 'number' ? e.updatedAt : createdAt;
  return {
    id: typeof e.id === 'string' && e.id ? e.id : entryId(wrong, correct),
    wrong,
    correct,
    action,
    kind: normalizeKind(e.kind),
    riskLevel: e.riskLevel === 'high' || e.riskLevel === 'medium' || e.riskLevel === 'low'
      ? e.riskLevel
      : deriveRiskLevel({ wrong, correct, action }),
    boundary: e.boundary === 'word' || e.boundary === 'substring' ? e.boundary : defaultBoundary(wrong, action),
    contextDeny: Array.isArray(e.contextDeny)
      ? e.contextDeny.filter((t): t is string => typeof t === 'string' && !!t.trim()).slice(0, 50)
      : [],
    contextAllow: Array.isArray(e.contextAllow)
      ? e.contextAllow.filter((t): t is string => typeof t === 'string' && !!t.trim()).slice(0, 50)
      : [],
    // 忽略留痕：可选字段，恢复时直接删键（避免在用户文件里留一堆 0）
    ...(typeof e.ignoredCount === 'number' && e.ignoredCount > 0
      ? { ignoredCount: Math.floor(e.ignoredCount) }
      : {}),
    ...(typeof e.ignoredAt === 'number' ? { ignoredAt: e.ignoredAt } : {}),
    scope: normalizeScope(e.scope),
    freq: typeof e.freq === 'number' && e.freq >= 0 ? Math.floor(e.freq) : 0,
    source: normalizeSource(e.source),
    status: e.status === 'paused' ? 'paused' : 'active',
    ownerScope: e.ownerScope === 'team' || e.ownerScope === 'org' ? e.ownerScope : 'personal',
    ...(isOntologyRef(e.ontologyRef) ? { ontologyRef: e.ontologyRef } : {}),
    replacedIn: Array.isArray(e.replacedIn)
      ? e.replacedIn.filter(isReplacedInRef).slice(-200)
      : [],
    createdBy: e.createdBy === 'harvest' || e.createdBy === 'import' ? e.createdBy : 'manual',
    createdAt,
    updatedAt,
    lastVerifiedAt: typeof e.lastVerifiedAt === 'number' ? e.lastVerifiedAt : updatedAt,
  };
}

function isReplacedInRef(v: unknown): v is ReplacedInRef {
  const r = v as Partial<ReplacedInRef> | null;
  return !!r && typeof r.docId === 'string' && typeof r.runId === 'string' && typeof r.count === 'number';
}

function normalizeScope(v: unknown): GlossaryScope {
  const s = v as Partial<GlossaryScope> | null;
  return {
    docIds: Array.isArray(s?.docIds) ? s!.docIds.filter((d): d is string => typeof d === 'string').slice(0, 200) : [],
    scenarioTags: Array.isArray(s?.scenarioTags)
      ? s!.scenarioTags.filter((t): t is string => typeof t === 'string').slice(0, 50)
      : [],
    global: s?.global === true,
  };
}

export function saveGlossary(userId: string, file: GlossaryFile): void {
  const target = userTranscriptGlossaryFile(userId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload: GlossaryFile = {
    version: GLOSSARY_VERSION,
    uid: userId,
    entries: file.entries.slice(0, MAX_ENTRIES),
    // 候选区独立落盘、独立限长：候选再多也不会挤掉词条（词条是扫描依据，候选不是）。
    candidates: (file.candidates || []).slice(-MAX_CANDIDATES),
    meta: file.meta,
  };
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

// ── CRUD ────────────────────────────────────────────────────────────────

export function entryId(wrong: string, correct: string): string {
  return `g_${createHash('sha1').update(`${foldText(wrong).trim()}|${foldText(correct).trim()}`).digest('hex').slice(0, 16)}`;
}

export function listEntries(
  userId: string,
  filter: { kind?: GlossaryKind; riskLevel?: RiskLevel; status?: EntryStatus; search?: string } = {},
): GlossaryEntry[] {
  // 搜索按折叠值做子串匹配：用户记得的是"大概长这样"，不该被大小写/全角挡住。
  const needle = filter.search ? foldText(String(filter.search)).trim() : '';
  return loadGlossary(userId).entries.filter((e) =>
    (!filter.kind || e.kind === filter.kind)
    && (!filter.riskLevel || e.riskLevel === filter.riskLevel)
    && (!filter.status || e.status === filter.status)
    && (!needle
      || foldText(e.wrong).includes(needle)
      || foldText(e.correct).includes(needle)));
}

export function findEntry(userId: string, id: string): GlossaryEntry | null {
  return loadGlossary(userId).entries.find((e) => e.id === id) ?? null;
}

// ── 候选区 CRUD（模型候选只在这里，永不进扫描）───────────────────────────

export function candidateId(wrong: string, correct: string): string {
  return `c_${createHash('sha1').update(`${foldText(wrong).trim()}|${foldText(correct).trim()}`).digest('hex').slice(0, 16)}`;
}

export function listCandidates(
  userId: string,
  filter: { state?: CandidateState } = {},
): GlossaryCandidate[] {
  const list = loadGlossary(userId).candidates || [];
  // 待核优先、新在前：复核界面第一眼要看到"还没处理过的"。
  return list
    .filter((c) => !filter.state || c.state === filter.state)
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === 'pending' ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
}

export function countPendingCandidates(userId: string): number {
  return (loadGlossary(userId).candidates || []).filter((c) => c.state === 'pending').length;
}

/**
 * 记入模型候选。这是**唯一**写入候选区的入口，且它只碰 `candidates`：
 * 任何情况下都不会往 `entries` 里写东西——扫描依据因此完全不受模型输出影响。
 *
 * 去重口径：同一 `wrong → correct` 只留一条。
 *   - 已有 `pending` → 更新置信/理由/上下文（模型第二次说得更有理，采纳的是新信息）；
 *   - 已是 `adopted` / `discarded` → **跳过**。人已经拍过板的事，模型下一轮不该
 *     把它重新翻出来，否则「丢弃」等于没有效果。
 */
export function recordCandidates(userId: string, inputs: RecordCandidateInput[]): RecordCandidatesResult {
  const skipped: RecordCandidatesResult['skipped'] = [];
  const file = loadGlossary(userId);
  const actives = new Set(
    file.entries
      .filter((e) => e.status === 'active')
      .map((e) => `${foldText(e.wrong).trim()}|${foldText(e.correct).trim()}`),
  );
  const byKey = new Map(file.candidates.map((c) => [`${foldText(c.wrong).trim()}|${foldText(c.correct).trim()}`, c]));
  let added = 0;
  let updated = 0;
  const now = Date.now();

  for (const input of inputs || []) {
    const wrong = typeof input?.wrong === 'string' ? input.wrong.trim().slice(0, MAX_WRONG_LEN) : '';
    const correct = typeof input?.correct === 'string' ? input.correct.trim().slice(0, MAX_CORRECT_LEN) : '';
    if (!wrong || !correct) {
      skipped.push({ wrong, correct, why: 'empty_target' });
      continue;
    }
    // 与词条入册同一条红线：纯数字变体无法与真实数字区分。
    if (isPureDigits(wrong)) {
      skipped.push({ wrong, correct, why: 'pure_digit_variant' });
      continue;
    }
    // 只有**逐字相同**才算自相矛盾。这里不能按折叠值比：`kstar → KSTAR`
    // 是合法的纠错对（模型改的是大小写/全角），折叠后会被误判成"没错"。
    if (wrong === correct) {
      skipped.push({ wrong, correct, why: 'identical_pair' });
      continue;
    }
    const key = `${foldText(wrong).trim()}|${foldText(correct).trim()}`;
    // 已经是生效词条 → 没什么可复核的，不进候选区。
    if (actives.has(key)) {
      skipped.push({ wrong, correct, why: 'already_in_glossary' });
      continue;
    }
    const confidenceRaw = Number(input?.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
    const patch = {
      confidence,
      reason: typeof input?.reason === 'string' ? input.reason.slice(0, 200) : '',
      context: typeof input?.context === 'string' ? input.context.slice(0, MAX_CANDIDATE_CONTEXT_LEN) : '',
      kind: normalizeKind(input?.kind),
      inAllowlist: input?.inAllowlist === true,
      ...(typeof input?.docId === 'string' && input.docId ? { docId: input.docId.slice(0, 200) } : {}),
      ...(typeof input?.start === 'number' && Number.isFinite(input.start)
        ? { start: Math.max(0, Math.floor(input.start)) }
        : {}),
    };
    const current = byKey.get(key);
    if (!current) {
      const candidate: GlossaryCandidate = {
        id: candidateId(wrong, correct),
        wrong,
        correct,
        origin: 'llm',
        state: 'pending',
        createdAt: now,
        ...patch,
      };
      file.candidates.push(candidate);
      byKey.set(key, candidate);
      added += 1;
      continue;
    }
    if (current.state !== 'pending') {
      skipped.push({ wrong, correct, why: `already_${current.state}` });
      continue;
    }
    // 保留更可信的一次读数：第二次报低了不该把信息量冲掉。
    current.confidence = Math.max(current.confidence, patch.confidence);
    if (patch.reason) current.reason = patch.reason;
    if (patch.context) current.context = patch.context;
    if (patch.docId) current.docId = patch.docId;
    if (typeof patch.start === 'number') current.start = patch.start;
    if (patch.inAllowlist) current.inAllowlist = true;
    updated += 1;
  }

  if (added || updated) saveGlossary(userId, file);
  return {
    added,
    updated,
    skipped,
    pending: file.candidates.filter((c) => c.state === 'pending').length,
  };
}

/**
 * 候选 → 词条。**人工确认后才走这条路**，也是候选唯一能影响扫描的通道。
 * 采纳出的词条按 `source: 'manual'` / `createdBy: 'manual'` 建（人拍的板就是人工词条），
 * 并回写 `adoptedEntryId`，于是"这条规则当初来自哪次模型候选"在文件里可追溯。
 */
export function adoptCandidate(userId: string, id: string): AdoptCandidateResult {
  const file = loadGlossary(userId);
  const candidate = file.candidates.find((c) => c.id === id);
  if (!candidate) return { candidate: null, entry: null, created: false, skippedReason: 'not_found' };
  if (candidate.state !== 'pending') {
    return { candidate, entry: null, created: false, skippedReason: 'not_pending' };
  }
  const result = upsertEntry(userId, {
    wrong: candidate.wrong,
    correct: candidate.correct,
    kind: candidate.kind,
    source: 'manual',
    ...(candidate.docId ? { docId: candidate.docId } : {}),
  });
  if (!result.entry) {
    return {
      candidate,
      entry: null,
      created: false,
      skippedReason: result.skippedReason === 'pure_digit_variant' ? 'pure_digit_variant' : 'invalid_target',
    };
  }
  // 词条先落盘成功，再改候选状态：中途失败时候选仍是 pending，不会出现
  // "标记成已采纳但词表里什么都没有"的假象。
  const after = loadGlossary(userId);
  const target = after.candidates.find((c) => c.id === id);
  if (target) {
    target.state = 'adopted';
    target.resolvedAt = Date.now();
    target.adoptedEntryId = result.entry.id;
    saveGlossary(userId, after);
  }
  return { candidate: target ?? candidate, entry: result.entry, created: result.created };
}

/** 丢弃一条待核候选（终态留痕，不删记录：避免模型下一轮又把它翻出来）。 */
export function discardCandidate(userId: string, id: string): GlossaryCandidate | null {
  const file = loadGlossary(userId);
  const target = file.candidates.find((c) => c.id === id);
  if (!target) return null;
  if (target.state === 'pending') {
    target.state = 'discarded';
    target.resolvedAt = Date.now();
    saveGlossary(userId, file);
  }
  return target;
}

/** 清空候选区（只清终态；`pending` 有待核标记挂着，要一起清得调用方明说）。 */
export function clearCandidates(userId: string, opts: { includePending?: boolean } = {}): number {
  const file = loadGlossary(userId);
  const keep = opts.includePending ? [] : file.candidates.filter((c) => c.state === 'pending');
  const removed = file.candidates.length - keep.length;
  if (removed > 0) {
    file.candidates = keep;
    saveGlossary(userId, file);
  }
  return removed;
}

/**
 * 把**已确认应用**的 `wrong → correct` 对记进词表（source: meeting_accept）。
 *
 * 为什么放在这里：'meeting_accept' 这个 source 一直是"词表里预留、但全仓库没人发过"
 * 的值（见 upsertEntry 里那段注释——它曾经因此让每个新词条都变成全局规则）。
 * 现在由"扫描里勾选并应用了模型候选"来发它：人点了勾、正文里真的换了，才算确认。
 *
 * 作用域刻意收窄到**当前文档**（传 `docId` ⇒ upsertEntry 走"仅本文档"分支）：
 * 一次会议里确认的写法不等于全局规则，这正是那份事故注释要防的事。
 */
export function rememberConfirmedPairs(
  userId: string,
  pairs: Array<{ wrong: string; correct: string }>,
  context: { docId?: string } = {},
): { created: number; updated: number; skipped: number } {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const docId = typeof context.docId === 'string' ? context.docId.trim() : '';
  // 作用域必须**显式给**。`upsertEntry` 里 `source === 'meeting_accept'` 只会把
  // `global` 置为 false，却不动 `docIds`/`scenarioTags`——那样得到的条目
  // `scopeAllows` 恒为 false，等于一条**永不命中的死规则**（这也正是
  // 'meeting_accept' 这个 source 一直没有任何调用方的真正原因）。
  if (!docId) {
    // 没有文档作用域时宁可如实跳过，也不要写死条目。
    return { created: 0, updated: 0, skipped: (pairs || []).length };
  }
  const scope = { docIds: [docId], scenarioTags: [] as string[], global: false };
  const seen = new Set<string>();
  for (const pair of pairs || []) {
    const wrong = String(pair?.wrong ?? '').trim();
    const correct = String(pair?.correct ?? '').trim();
    if (!wrong || !correct) {
      skipped += 1;
      continue;
    }
    const key = `${foldText(wrong).trim()}|${foldText(correct).trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const result = upsertEntry(userId, {
        wrong,
        correct,
        source: 'meeting_accept',
        scope,
      });
      if (!result.entry) skipped += 1;
      else if (result.created) created += 1;
      else updated += 1;
    } catch (error) {
      // 单条不合法（超长/空）不该让整次应用失败：如实计入 skipped。
      log.warn('remember confirmed pair failed', { error: (error as Error).message });
      skipped += 1;
    }
  }
  return { created, updated, skipped };
}

/** 作用域选择（面板「接受」动作的范围，方案 §七）。 */
export type ScopeChoice = 'keep' | 'doc' | 'task' | 'global';

export interface SetScopeResult {
  updated: number;
  /**
   * 被拒的条目：**高危词条不允许"全部个人库"范围**（方案 §2.2 红线）。
   * 拒绝时保持原作用域不变，并如实回报，绝不静默降级。
   */
  refused: Array<{ id: string; wrong: string; reason: 'high_risk_cannot_global' }>;
}

/**
 * 设定已接受词条的作用域——"接受（范围：本文档 / 当前任务 / 全局）"。
 *   keep   不动（默认）
 *   doc    只在本文档生效（`docIds=[docId]`，global=false）
 *   task   只在本场景生效（`scenarioTags=[…]`，global=false）
 *   global 全局（高危词条拒绝，见 SetScopeResult.refused）
 */
export function setScope(
  userId: string,
  ids: string[],
  opts: { choice: ScopeChoice; docId?: string; scenarioTags?: string[] },
): SetScopeResult {
  const wanted = new Set(ids.filter((id) => typeof id === 'string' && !!id));
  if (wanted.size === 0 || opts.choice === 'keep') return { updated: 0, refused: [] };
  const file = loadGlossary(userId);
  const now = Date.now();
  let updated = 0;
  const refused: SetScopeResult['refused'] = [];
  for (const entry of file.entries) {
    if (!wanted.has(entry.id)) continue;
    if (opts.choice === 'global') {
      if (entry.riskLevel === 'high') {
        refused.push({ id: entry.id, wrong: entry.wrong, reason: 'high_risk_cannot_global' });
        continue;
      }
      entry.scope = { docIds: [], scenarioTags: [], global: true };
    } else if (opts.choice === 'doc') {
      if (!opts.docId) throw new Error('transcript glossary: docId is required for doc scope');
      entry.scope = { docIds: [opts.docId], scenarioTags: [], global: false };
    } else {
      const tags = (opts.scenarioTags ?? []).filter((t) => typeof t === 'string' && !!t.trim()).slice(0, 50);
      if (!tags.length) throw new Error('transcript glossary: scenarioTags are required for task scope');
      entry.scope = { docIds: [], scenarioTags: tags, global: false };
    }
    entry.updatedAt = now;
    updated += 1;
  }
  if (updated > 0) saveGlossary(userId, file);
  return { updated, refused };
}

/**
 * 忽略 / 恢复（方案 §七「忽略（可逆，降权）」）。
 * 忽略不删词条、不动台账：只累计次数与时间（面板据此折叠到末尾、默认不勾选）。
 */
export function setIgnored(userId: string, ids: string[], ignored: boolean): number {
  const wanted = new Set(ids.filter((id) => typeof id === 'string' && !!id));
  if (wanted.size === 0) return 0;
  const file = loadGlossary(userId);
  const now = Date.now();
  let updated = 0;
  for (const entry of file.entries) {
    if (!wanted.has(entry.id)) continue;
    if (ignored) {
      entry.ignoredCount = (entry.ignoredCount ?? 0) + 1;
      entry.ignoredAt = now;
    } else {
      delete entry.ignoredCount;
      delete entry.ignoredAt;
    }
    entry.updatedAt = now;
    updated += 1;
  }
  if (updated > 0) saveGlossary(userId, file);
  return updated;
}

/**
 * 加白（方案 §七「加白（误杀加白）」）：把某个上下文词加到白名单，
 * 以后这些词出现在窗口里就整条静默，不再提示。重复加白只留一条。
 */
export function addContextAllow(userId: string, ids: string[], term: string): number {
  const needle = bounded(term, 'contextAllow', 40);
  if (!needle) throw new Error('transcript glossary: contextAllow term is required');
  const wanted = new Set(ids.filter((id) => typeof id === 'string' && !!id));
  if (wanted.size === 0) return 0;
  const file = loadGlossary(userId);
  const now = Date.now();
  let updated = 0;
  for (const entry of file.entries) {
    if (!wanted.has(entry.id)) continue;
    const list = entry.contextAllow ?? [];
    if (list.some((item) => foldText(item).trim() === foldText(needle).trim())) continue;
    entry.contextAllow = [...list, needle].slice(0, 50);
    entry.updatedAt = now;
    updated += 1;
  }
  if (updated > 0) saveGlossary(userId, file);
  return updated;
}

/**
 * 检索前 query 同义改写开关（方案 §五 P2-3）。
 * 默认关：改检索词会改变用户看到的结果，必须由用户显式打开。
 */
export function setQueryRewrite(userId: string, enabled: boolean): boolean {
  const file = loadGlossary(userId);
  file.meta = { ...file.meta, queryRewrite: enabled === true };
  saveGlossary(userId, file);
  return enabled === true;
}

/** 读取开关状态（缺省 false）。 */
export function isQueryRewriteEnabled(userId: string): boolean {
  return loadGlossary(userId).meta.queryRewrite === true;
}

/**
 * 词表 owner 备注（方案 §2.1-11 / §七「每行显示 owner、最后维护时间、来源」的词表级部分）。
 * 只写 `meta.ownerNote`，不动词条。
 */
export function setOwnerNote(userId: string, note: string): string {
  const file = loadGlossary(userId);
  const text = typeof note === 'string' ? note.trim().slice(0, 120) : '';
  file.meta = { ...file.meta, ownerNote: text };
  saveGlossary(userId, file);
  return text;
}

/** 词表级元数据（面板/管理页展示用）。 */
export function readMeta(userId: string): GlossaryFile['meta'] {
  return loadGlossary(userId).meta;
}

/** 移除一条加白（误加了就得能撤：白名单静默候选，不能只进不出）。 */
export function removeContextAllow(userId: string, ids: string[], term: string): number {
  const needle = foldText(bounded(term, 'contextAllow', 40)).trim();
  if (!needle) throw new Error('transcript glossary: contextAllow term is required');
  const wanted = new Set(ids.filter((id) => typeof id === 'string' && !!id));
  if (wanted.size === 0) return 0;
  const file = loadGlossary(userId);
  const now = Date.now();
  let updated = 0;
  for (const entry of file.entries) {
    if (!wanted.has(entry.id)) continue;
    const list = entry.contextAllow ?? [];
    const next = list.filter((item) => foldText(item).trim() !== needle);
    if (next.length === list.length) continue;
    entry.contextAllow = next;
    entry.updatedAt = now;
    updated += 1;
  }
  if (updated > 0) saveGlossary(userId, file);
  return updated;
}

/**
 * 改一个词条的"正确写法"（本体对齐用：本体里的规范名比词表里的写法更权威）。
 *
 * 只动 `correct` / 重算的 `riskLevel` / `updatedAt`：
 *   - 不碰 `wrong`：对齐是"写法修正"，不是新发现的错形；
 *   - 不碰 `replacedIn` 台账与 `freq`：一次写法修正不等于一次新确认（审计口径）；
 *   - 风险等级按新写法重算（写法变长变短会改变误替换风险），调用方无需自己猜。
 */
export function retargetEntry(userId: string, id: string, correctInput: unknown): GlossaryEntry | null {
  const target = findEntry(userId, id);
  if (!target) return null;
  const correct = bounded(correctInput, 'correct', MAX_CORRECT_LEN);
  if (!correct) throw new Error('transcript glossary: correct is required');
  if (correct === target.correct) return target;

  const file = loadGlossary(userId);
  const entry = file.entries.find((e) => e.id === target.id);
  if (!entry) return null;
  const others = file.entries
    .filter((e) => e.id !== entry.id && e.status === 'active' && foldText(e.wrong).trim() === foldText(entry.wrong).trim())
    .map((e) => e.correct);
  entry.correct = correct;
  entry.riskLevel = deriveRiskLevel(
    { wrong: entry.wrong, correct, action: entry.action, partial: false },
    { otherCorrects: others },
  );
  entry.updatedAt = Date.now();
  saveGlossary(userId, file);
  return entry;
}

export function upsertEntry(userId: string, input: UpsertEntryInput): UpsertResult {
  const wrong = bounded(input.wrong, 'wrong', MAX_WRONG_LEN);
  const correct = input.action === 'delete' ? '' : bounded(input.correct, 'correct', MAX_CORRECT_LEN);
  const action: GlossaryAction = input.action === 'delete' ? 'delete' : 'replace';
  if (!wrong) throw new Error('transcript glossary: wrong is required');
  if (action === 'replace' && !correct) throw new Error('transcript glossary: correct is required');

  // 纯数字变体拒绝入册：无法与真实数字（学号、指标、金额）区分。
  if (isPureDigits(wrong)) return { entry: null, created: false, skippedReason: 'pure_digit_variant' };

  const file = loadGlossary(userId);
  const foldedWrong = foldText(wrong).trim();
  const foldedCorrect = foldText(correct).trim();
  const kind = normalizeKind(input.kind);
  const others = file.entries
    .filter((e) => e.status === 'active' && foldText(e.wrong).trim() === foldedWrong)
    .map((e) => e.correct);
  const explicitRisk = input.riskLevel;
  const derived = deriveRiskLevel(
    { wrong, correct, action, partial: input.partial === true },
    { otherCorrects: others },
  );
  const riskLevel: RiskLevel = explicitRisk === 'high' || explicitRisk === 'medium' || explicitRisk === 'low'
    ? explicitRisk
    : derived;
  const now = Date.now();
  const existingIndex = file.entries.findIndex(
    (e) => foldText(e.wrong).trim() === foldedWrong && foldText(e.correct).trim() === foldedCorrect,
  );

  const source = normalizeSource(input.source);
  const scope = normalizeScope(input.scope);
  // 会议中"顺手确认"的词条默认只在本次文档/场景生效；显式 hand-add 的才算全局。
  if (!input.scope) {
    scope.global = source !== 'meeting_accept';
  }

  const entry: GlossaryEntry = {
    id: existingIndex >= 0 ? file.entries[existingIndex].id : entryId(wrong, correct),
    wrong,
    correct,
    action,
    kind,
    riskLevel,
    boundary: input.boundary === 'word' || input.boundary === 'substring'
      ? input.boundary
      : defaultBoundary(wrong, action),
    contextDeny: Array.isArray(input.contextDeny)
      ? input.contextDeny.filter((t): t is string => typeof t === 'string' && !!t.trim()).slice(0, 50)
      : [],
    contextAllow: Array.isArray(input.contextAllow)
      ? input.contextAllow.filter((t): t is string => typeof t === 'string' && !!t.trim()).slice(0, 50)
      : [],
    scope,
    freq: existingIndex >= 0 ? file.entries[existingIndex].freq : 0,
    source,
    status: existingIndex >= 0 ? file.entries[existingIndex].status : 'active',
    ownerScope: input.ownerScope === 'team' || input.ownerScope === 'org' ? input.ownerScope : 'personal',
    ...(isOntologyRef(input.ontologyRef) ? { ontologyRef: input.ontologyRef } : {}),
    replacedIn: existingIndex >= 0 ? file.entries[existingIndex].replacedIn : [],
    createdBy: existingIndex >= 0 ? file.entries[existingIndex].createdBy : (source === 'import' ? 'import' : 'manual'),
    createdAt: existingIndex >= 0 ? file.entries[existingIndex].createdAt : now,
    updatedAt: now,
    lastVerifiedAt: existingIndex >= 0 ? now : (source === 'ontology_seed' ? 0 : now),
  };

  if (existingIndex >= 0) file.entries[existingIndex] = entry;
  else file.entries.push(entry);
  saveGlossary(userId, file);
  return { entry, created: existingIndex < 0 };
}

export function setEntryStatus(userId: string, id: string, status: EntryStatus): GlossaryEntry | null {
  const file = loadGlossary(userId);
  const target = file.entries.find((e) => e.id === id);
  if (!target) return null;
  target.status = status;
  target.updatedAt = Date.now();
  saveGlossary(userId, file);
  return target;
}

export function deleteEntry(userId: string, id: string): boolean {
  const file = loadGlossary(userId);
  const next = file.entries.filter((e) => e.id !== id);
  if (next.length === file.entries.length) return false;
  file.entries = next;
  saveGlossary(userId, file);
  return true;
}

export function markVerified(userId: string, id: string, at = Date.now()): GlossaryEntry | null {
  const file = loadGlossary(userId);
  const target = file.entries.find((e) => e.id === id);
  if (!target) return null;
  target.lastVerifiedAt = at;
  target.updatedAt = at;
  saveGlossary(userId, file);
  return target;
}

/**
 * 追加一次替换记录（**只追加**）。freq 同步 +1，用于 UI 排序与"高频词优先"。
 * 注意：runId/docId 由调用方（runs 模块）给出，本函数不做去重——
 * 台账的意义就是"发生过几次"，压掉重复等于篡改审计线索。
 */
export function recordReplacement(
  userId: string,
  entryIds: string[],
  ref: { docId: string; runId: string; at?: number },
): void {
  if (entryIds.length === 0) return;
  const file = loadGlossary(userId);
  const at = ref.at ?? Date.now();
  let changed = false;
  for (const id of new Set(entryIds)) {
    const target = file.entries.find((e) => e.id === id);
    if (!target) continue;
    target.replacedIn = [...target.replacedIn, { docId: ref.docId, runId: ref.runId, count: 1, at }].slice(-200);
    target.freq += 1;
    target.updatedAt = at;
    changed = true;
  }
  if (changed) saveGlossary(userId, file);
}

// ── 导入 / 导出 ─────────────────────────────────────────────────────────

/**
 * 导出包格式版本：与词表**文件**版本（`GLOSSARY_VERSION`）是两件事——
 * 导出包只带词条、不带候选区，不跟着文件版本走。此前两者共用一个常量，
 * 文件版本一升就把导出包的契约类型也跟着改，属于误耦合，这里显式拆开。
 */
const GLOSSARY_PACK_VERSION = 2 as const;

/** 导出：人名类默认不导出（披露红线），可用 includePeople 显式放开。 */
export function exportGlossary(
  userId: string,
  opts: { includePeople?: boolean } = {},
): { version: 2; exportedAt: number; entries: Array<Partial<GlossaryEntry>> } {
  const file = loadGlossary(userId);
  const entries = file.entries
    .filter((e) => opts.includePeople || e.kind !== 'people')
    .map((e) => ({
      wrong: e.wrong, correct: e.correct, action: e.action, kind: e.kind,
      riskLevel: e.riskLevel, boundary: e.boundary, contextDeny: e.contextDeny, contextAllow: e.contextAllow,
      scope: e.scope, ownerScope: e.ownerScope, source: e.source,
    }));
  return { version: GLOSSARY_PACK_VERSION, exportedAt: Date.now(), entries };
}

export function importGlossary(
  userId: string,
  payload: unknown,
  opts: { mode?: 'merge' | 'replace' } = {},
): { imported: number; skipped: number } {
  const list = (payload as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) throw new Error('transcript glossary: payload.entries must be an array');
  const mode = opts.mode === 'replace' ? 'replace' : 'merge';
  if (mode === 'replace') {
    const empty = emptyGlossary(userId);
    saveGlossary(userId, empty);
  }
  let imported = 0;
  let skipped = 0;
  for (const item of list.slice(0, MAX_ENTRIES)) {
    const rec = item as UpsertEntryInput & { riskLevel?: unknown };
    try {
      const res = upsertEntry(userId, { ...rec, source: 'import' });
      if (res.entry) imported += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { imported, skipped };
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    if (value === undefined || value === null) return '';
    throw new Error(`transcript glossary: ${field} must be a string`);
  }
  const text = value.trim();
  if (text.length > max) throw new Error(`transcript glossary: ${field} too long`);
  return text;
}
