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
  version: 2;
  uid: string;
  entries: GlossaryEntry[];
  meta: {
    lastReconcileAt: number;
    ownerNote: string;
    /** 检索前 query 同义改写开关（方案 §五 P2-3，默认关：用户要能预期检索行为）。 */
    queryRewrite?: boolean;
  };
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
  /**
   * 创建上下文：未显式给 `scope` 时用它决定默认作用域（本文档 / 本场景）。
   * 不给就会被兜底成全局规则——那正是作用域机制要防的事故，所以调用方应当传。
   */
  docId?: unknown;
  scenarioTags?: unknown;
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

const GLOSSARY_VERSION = 2 as const;
const MAX_ENTRIES = 2000;
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
  return { version: GLOSSARY_VERSION, uid, entries: [], meta: { lastReconcileAt: 0, ownerNote: '' } };
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
    log.info('glossary migrated to v2', { entries: migrated.entries.length });
    saveGlossary(userId, migrated);
    return migrated;
  }
  const file2 = raw as Partial<GlossaryFile>;
  return {
    version: GLOSSARY_VERSION,
    uid: userId,
    entries: Array.isArray(file2.entries) ? file2.entries.map(normalizeStoredEntry).filter(isEntry) : [],
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
  if (!input.scope) {
    if (existingIndex >= 0) {
      // 更新已有词条时保持其原有作用域：一次编辑不该把它悄悄放宽成全局。
      Object.assign(scope, file.entries[existingIndex].scope);
    } else {
      // 未显式给作用域时的兜底：有文档 → 仅本文档；有场景标签 → 仅本场景；
      // 两者都没有才退到全局。
      //
      // 此前这里判断 `source !== 'meeting_accept'`，但全仓库没有任何调用方发送过该
      // source（面板发 'manual'、本体桥接发 'ontology_seed'）⇒ 判断恒真 ⇒ 每个新词条
      // 都成了全局规则，等于把 transcript_auto_correct 记录的事故重新引入
      // （一次会议学到的 7 个姓氏变体被当全局规则，改了无关稿件的"某老师"）。
      const contextDocId = typeof input.docId === 'string' && input.docId.trim() ? input.docId.trim() : '';
      const contextTags = Array.isArray(input.scenarioTags)
        ? input.scenarioTags.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 50)
        : [];
      if (contextDocId) {
        scope.docIds = [contextDocId];
        scope.scenarioTags = [];
        scope.global = false;
      } else if (contextTags.length) {
        scope.docIds = [];
        scope.scenarioTags = contextTags;
        scope.global = false;
      } else {
        scope.global = true;
      }
    }
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
  return { version: GLOSSARY_VERSION, exportedAt: Date.now(), entries };
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
