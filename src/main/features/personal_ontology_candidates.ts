import { readUnifiedOntologyCandidates, persistOntologyCandidates } from './cognition_bridge';
import { fileEditLock } from '../util/locks';
/** Legacy personal ontology candidates remain available for history reads and
 * internal record lifecycle operations. Their former memory/asset confirmation
 * and transfer paths are retired; formal cognition forms through nightly capture. */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { userLocalRoot } from '../paths';
import { writeTextAtomicSync, safeId, nowIso, readJsonSync } from '../storage';
import { notifyCognitionWrite } from './recall/store-events';
import { createLogger } from '../logger';
import {
  CorruptFileError,
  assertNotCorrupt,
  readTextGuarded,
} from '../util/corrupt-guard';

const log = createLogger('personal-ontology-candidates');

/** 坏档三件套的业务域名（恢复通道 cognition.corrupt.* 按 domain 寻址）。 */
export const CANDIDATES_CORRUPT_DOMAIN = 'ontology-candidates';

/** 候选类型。`preference`（偏好）是一等公民，不再藏在 relation 里。 */
export type CandidateKind = 'preference' | 'instance' | 'property' | 'relation' | 'rule';

/** 这条候选确认后应该进哪本记忆——对应 `features/memory.ts` 的两个用户级存储：
 *  `user`   → USER.md   （个人画像/偏好，跨 agent 生效，容量较小）
 *  `shared` → MEMORY.md （更泛化的事实/规则，跨项目跨 agent，容量稍大） */
export type MemoryTargetScope = 'user' | 'shared';

/** 敏感度级别：standard = 常规注入 prompt，restricted = 存但不注入 LLM，
 *  sensitive = 加密/额外保护（本版仅占位，暂与 restricted 行为一致）。 */
export type SensitivityLevel = 'standard' | 'restricted' | 'sensitive';

/** 写入者身份：标识候选由谁产出（用户手动/LLM 提取/技能生成）。 */
export type WriteActor = 'user' | 'llm' | 'skill';

export interface CandidateUpdate {
  candidate_id: string;
  kind: CandidateKind;
  confidence: 'low' | 'medium' | 'high';
  /** 一句人话摘要，卡片上直接展示，不再是原始 JSON payload。 */
  summary: string;
  /** 确认后写入哪本记忆。 */
  memory_scope: MemoryTargetScope;
  /** 确认后真正写进 USER.md/MEMORY.md 的精炼文本；缺省时回退用 summary。 */
  memory_text?: string;
  /** 可选：定位路径，方便浏览/以后做图谱视图，非必需。 */
  registry_like_path?: string;
  /** 可选：相对当前记忆的差异说明。 */
  diff_summary?: string;
  /** 阶段 B（可选）：建议字段名（技能预判，`- 建议字段:` 行）。确认时 App 预选，
   *  用户可在下拉里改；目标分组无此字段时回退流水区。 */
  target_field?: string;
  source_memory_refs: string[];
  /** 二期 D5：来源项目 id（候选进池时标记，`- 来源项目:` 行）。确认落盘附加
   *  `@proj:<pid>`；dest.projectId 显式传入时覆盖（用户/UI 意图优先）。 */
  project_id?: string;
  /** M3：敏感度级别。缺省 `standard`（兼容旧数据）。 */
  sensitivity?: SensitivityLevel;
  /** M3：写入者身份。缺省 `llm`（候选多由技能/LLM 产出）。 */
  write_actor?: WriteActor;
  /** M3：候选记录时间（ISO 8601）。缺省空字符串（旧数据无此字段）。 */
  recorded_time?: string;
}

export interface BlockedItem {
  source_ref: string;
  reason: string;
  required_fix: string;
}

export interface CandidatesData {
  candidate_updates: CandidateUpdate[];
  blocked_items: BlockedItem[];
  /** 坏档如实上报（P-r2-7 读侧结构化错误，失败≠空态）：池文件读错被拒时
   *  给渲染层展示「文件损坏+恢复入口」的依据；无坏档时缺省。 */
  corrupt?: { reason: string; at: string };
}

function candidatesDir(uid: string): string {
  return path.join(userLocalRoot(uid), 'ontology_candidates');
}

/** 候选池主档路径（cognition.corrupt.* 恢复通道按 domain 寻址时主进程用）。 */
export function candidatesMdPath(uid: string): string {
  return path.join(candidatesDir(uid), 'candidates.md');
}

function legacyCandidatesJsonPath(uid: string): string {
  return path.join(candidatesDir(uid), 'candidates.json');
}

function blockedItemsMdPath(uid: string): string {
  return path.join(candidatesDir(uid), 'blocked_items.md');
}

function readTextSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

// ── candidates.md 解析/序列化 ────────────────────────────────────────────

const CANDIDATE_FIELD_LABELS: Record<string, string> = {
  '类型': 'kind',
  '置信度': 'confidence',
  '摘要': 'summary',
  '记忆去向': 'memory_scope',
  '记忆文本': 'memory_text',
  '路径': 'registry_like_path',
  '差异': 'diff_summary',
  '建议字段': 'target_field',
  '来源': 'source_memory_refs',
  '来源项目': 'project_id',
  '敏感度': 'sensitivity',
  '写入者': 'write_actor',
  '记录时间': 'recorded_time',
};

const VALID_KINDS: CandidateKind[] = ['preference', 'instance', 'property', 'relation', 'rule'];
const VALID_CONFIDENCE = ['low', 'medium', 'high'];
const VALID_SENSITIVITY: SensitivityLevel[] = ['standard', 'restricted', 'sensitive'];
const VALID_WRITE_ACTORS: WriteActor[] = ['user', 'llm', 'skill'];

function coerceKind(v: unknown): CandidateKind {
  return (VALID_KINDS as string[]).includes(String(v)) ? (v as CandidateKind) : 'instance';
}

function coerceConfidence(v: unknown): 'low' | 'medium' | 'high' {
  return (VALID_CONFIDENCE.includes(String(v)) ? v : 'medium') as 'low' | 'medium' | 'high';
}

function coerceSensitivity(v: unknown): SensitivityLevel {
  return (VALID_SENSITIVITY as string[]).includes(String(v)) ? (v as SensitivityLevel) : 'standard';
}

function coerceWriteActor(v: unknown): WriteActor {
  return (VALID_WRITE_ACTORS as string[]).includes(String(v)) ? (v as WriteActor) : 'llm';
}

function coerceMemoryScope(v: unknown): MemoryTargetScope {
  return String(v) === 'shared' ? 'shared' : 'user';
}

/** 把 candidates.md 解析成结构化候选数组。格式约定见 `serializeCandidatesMarkdown`。 */
export function parseCandidatesMarkdown(text: string): CandidateUpdate[] {
  const blocks = text.split(/\n(?=###\s+\S)/).map(b => b.trim()).filter(b => b.startsWith('### '));
  const out: CandidateUpdate[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0].match(/^###\s+(\S+)/);
    if (!header) continue;
    const raw: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(/^-\s*([^:：]+)[:：]\s*(.*)$/);
      if (!m) continue;
      const field = CANDIDATE_FIELD_LABELS[m[1].trim()];
      if (field) raw[field] = m[2].trim();
    }
    const candidateId = header[1];
    if (!candidateId) continue;
    out.push({
      candidate_id: candidateId,
      kind: coerceKind(raw.kind),
      confidence: coerceConfidence(raw.confidence),
      summary: raw.summary || '',
      memory_scope: coerceMemoryScope(raw.memory_scope),
      memory_text: raw.memory_text || raw.summary || '',
      sensitivity: coerceSensitivity(raw.sensitivity),
      write_actor: coerceWriteActor(raw.write_actor),
      recorded_time: raw.recorded_time || '',
      ...(raw.registry_like_path ? { registry_like_path: raw.registry_like_path } : {}),
      ...(raw.diff_summary ? { diff_summary: raw.diff_summary } : {}),
      ...(raw.target_field ? { target_field: raw.target_field } : {}),
      ...(raw.project_id ? { project_id: raw.project_id } : {}),
      source_memory_refs: raw.source_memory_refs
        ? raw.source_memory_refs.split(',').map(s => s.trim()).filter(Boolean)
        : [],
    });
  }
  return out;
}

/**
 * 候选方言拍平（P-r1-27，决策卡拍板）：`candidates.md` 的字段值是单行
 * `- 字段: 值` 列表，多行值无法往返——续行被解析器静默丢弃（截断），形如
 * `- 类型: x` 的续行更会覆盖字段（kind 污染改变落库分档），confirm 再把
 * 截断值写库固化。序列化侧统一拍平成单行（换行/制表折叠为单空格，有损
 * 归一）——与 recall/personal-profile-sync.ts 投影拍平同款先例。
 */
function flattenInline(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[\t ]+/g, ' ').trim();
}

/** 正文清除后的不可逆匹配键：候选池只存这个键，不存正文副本。 */
export function candidateTextHash(value: unknown): string {
  const flat = flattenInline(value);
  return flat ? crypto.createHash('sha256').update(flat).digest('hex') : '';
}

/** 把候选数组序列化成人读 markdown。技能产出内容也应遵循这个格式。
 *  所有自由文本字段值先经 flattenInline 拍平：落盘即单行，往返不再截断。 */
export function serializeCandidatesMarkdown(candidates: CandidateUpdate[]): string {
  const header = `# 个人本体候选（待确认）\n\n> 最后更新: ${nowIso()} | 共 ${candidates.length} 条待确认\n`;
  if (!candidates.length) return `${header}\n暂无待确认候选。\n`;
  const blocks = candidates.map(c => {
    const summary = flattenInline(c.summary);
    const memoryText = flattenInline(c.memory_text);
    const registryPath = flattenInline(c.registry_like_path);
    const diffSummary = flattenInline(c.diff_summary);
    const targetField = flattenInline(c.target_field);
    const projectId = flattenInline(c.project_id);
    const recordedTime = flattenInline(c.recorded_time);
    const sourceRefs = (c.source_memory_refs || []).map(flattenInline).filter(Boolean);
    const lines = [`### ${c.candidate_id}`];
    lines.push(`- 类型: ${c.kind}`);
    lines.push(`- 置信度: ${c.confidence}`);
    if (summary) lines.push(`- 摘要: ${summary}`);
    lines.push(`- 记忆去向: ${c.memory_scope}`);
    if (memoryText) lines.push(`- 记忆文本: ${memoryText}`);
    if (registryPath) lines.push(`- 路径: ${registryPath}`);
    if (diffSummary) lines.push(`- 差异: ${diffSummary}`);
    if (targetField) lines.push(`- 建议字段: ${targetField}`);
    if (projectId) lines.push(`- 来源项目: ${projectId}`);
    if (c.sensitivity && c.sensitivity !== 'standard') lines.push(`- 敏感度: ${c.sensitivity}`);
    if (c.write_actor && c.write_actor !== 'llm') lines.push(`- 写入者: ${c.write_actor}`);
    if (recordedTime) lines.push(`- 记录时间: ${recordedTime}`);
    if (sourceRefs.length) lines.push(`- 来源: ${sourceRefs.join(', ')}`);
    return lines.join('\n');
  });
  return `${header}\n${blocks.join('\n\n')}\n`;
}

// ── blocked_items.md 解析（只读，技能产出，本模块不写它）────────────────

function parseBlockedItemsMarkdown(text: string): BlockedItem[] {
  const blocks = text.split(/\n(?=###\s+\S)/).map(b => b.trim()).filter(b => b.startsWith('### '));
  const out: BlockedItem[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0].match(/^###\s+(.+)$/);
    if (!header) continue;
    let reason = '';
    let requiredFix = '';
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(/^-\s*([^:：]+)[:：]\s*(.*)$/);
      if (!m) continue;
      const label = m[1].trim();
      if (label === '原因') reason = m[2].trim();
      if (label === '修复建议') requiredFix = m[2].trim();
    }
    const sourceRef = header[1].trim();
    if (sourceRef) out.push({ source_ref: sourceRef, reason, required_fix: requiredFix });
  }
  return out;
}

// ── 旧版 candidates.json 一次性迁移 ───────────────────────────────────────
// 早期版本把候选存成 JSON，且「确认」只是打个状态标记，从未真正写入记忆。
// 首次以新格式读取时，就地迁移一次：已确认的直接补写进记忆（弥补历史欠账），
// 已驳回的丢弃，待确认的转换格式保留。迁移后把旧文件重命名为 .bak，不删除。

interface LegacyCandidate {
  candidate_id: string;
  kind?: string;
  confidence?: string;
  status?: string;
  diff_summary?: string;
  identity_scope_decision?: string;
  source_memory_refs?: string[];
  registry_like_path?: string;
  payload?: unknown;
}

interface LegacyCandidatesJson {
  candidate_updates?: LegacyCandidate[];
}

function legacySummaryFor(c: LegacyCandidate): string {
  if (c.diff_summary) return c.diff_summary;
  try { return JSON.stringify(c.payload).slice(0, 200); } catch { return c.candidate_id; }
}

/** Legacy JSON is a read-only history source. Reading it must never backfill
 * memory, publish cognition assets, rename the source, or consume its rows. */
function readLegacyCandidatesJson(uid: string): CandidateUpdate[] {
  const file = legacyCandidatesJsonPath(uid);
  if (!fs.existsSync(file)) return [];
  const legacy = readJsonSync<LegacyCandidatesJson>(file);
  return (Array.isArray(legacy.candidate_updates) ? legacy.candidate_updates : []).flatMap(c => {
    if (!c || !safeId(c.candidate_id)) return [];
    const summary = legacySummaryFor(c);
    return [{ candidate_id: c.candidate_id, kind: coerceKind(c.kind), confidence: coerceConfidence(c.confidence),
      summary, memory_scope: c.identity_scope_decision === 'personal_global' ? 'user' as const : 'shared' as const,
      memory_text: summary, ...(c.status ? { legacyStatus: c.status } : {}),
      ...(c.registry_like_path ? { registry_like_path: c.registry_like_path } : {}),
      ...(c.diff_summary ? { diff_summary: c.diff_summary } : {}),
      source_memory_refs: Array.isArray(c.source_memory_refs) ? c.source_memory_refs : [] }];
  });
}

// ── 读写 ─────────────────────────────────────────────────────────────────

/**
 * 读候选池（P-r2-7 三件套）：只吞**真 ENOENT**（空池初始化）；其它读错
 * （磁盘故障/权限等）先 copy `.corrupt-<ts>` 备份再抛 CorruptFileError——
 * 不再吞成空表让下一次写（含后台回流投放）全量覆写、候选池静默清空。
 */
// 2026-10-03：列表读取仍同步；异步持久化由池文件锁串行化读改写。
// 确认的目标写入可等待模型/其他业务，收尾重读池并只移除目标，避免旧数组覆写。
function readCandidates(uid: string): CandidateUpdate[] {
  const unified = readUnifiedOntologyCandidates(uid);
  if (unified) return unified as unknown as CandidateUpdate[];
  if (!fs.existsSync(candidatesMdPath(uid))) return readLegacyCandidatesJson(uid);
  const guarded = readTextGuarded(candidatesMdPath(uid), { domain: CANDIDATES_CORRUPT_DOMAIN });
  if (guarded.status === 'corrupt') throw new CorruptFileError(guarded.record);
  return parseCandidatesMarkdown(guarded.status === 'ok' ? guarded.text : '');
}

async function writeCandidates(uid: string, candidates: CandidateUpdate[]): Promise<void> {
  // 写侧门：坏档登记在案即拒绝（备份被移走不影响判定；恢复/重置后才可写）。
  assertNotCorrupt(candidatesMdPath(uid));
  await persistOntologyCandidates(uid, candidates as unknown as Record<string, unknown>[], async () => {
    writeTextAtomicSync(candidatesMdPath(uid), serializeCandidatesMarkdown(candidates));
  });
  notifyCognitionWrite(uid, 'ontology-candidates', 'update');
}

function readBlockedItems(uid: string): BlockedItem[] {
  return parseBlockedItemsMarkdown(readTextSafe(blockedItemsMdPath(uid)));
}

/**
 * 读取候选列表 + 阻断项。文件不存在时返回空数组；旧 JSON 仅作为只读历史解析。
 * 池文件坏档（非 ENOENT 读错）时不再吞成空表：corrupt 字段如实带回坏档信息，
 * 渲染层据此出「从备份恢复/重置」入口（写侧此时已被 corrupt-guard 拒绝）。
 */
export async function listCandidates(uid: string): Promise<CandidatesData> {
  if (!safeId(uid)) throw new Error('invalid uid');
  let candidates: CandidateUpdate[] = [];
  let corrupt: CandidatesData['corrupt'];
  try {
    candidates = readCandidates(uid);
  } catch (err) {
    if (!(err instanceof CorruptFileError)) throw err;
    corrupt = { reason: err.record.reason, at: err.record.at };
  }
  return {
    candidate_updates: candidates,
    blocked_items: readBlockedItems(uid),
    ...(corrupt ? { corrupt } : {}),
  };
}

export interface AddCandidateInput extends Partial<CandidateUpdate> {
  summary: string;
}

/**
 * Append a single candidate produced by an expert-team member.
 *
 * A caller-supplied candidate_id is an idempotency key: the latest payload
 * replaces the existing row instead of creating a duplicate.
 */
async function addCandidateUnlocked(
  uid: string,
  input: AddCandidateInput,
): Promise<{ ok: true; candidate: CandidateUpdate; candidates: CandidateUpdate[] }> {
  if (!safeId(uid)) throw new Error('invalid uid');
  const summary = typeof input?.summary === 'string' ? input.summary.trim() : '';
  const memoryText = typeof input?.memory_text === 'string' ? input.memory_text.trim() : '';
  if (!summary && !memoryText) throw new Error('candidate has no text');

  const candidateId = typeof input?.candidate_id === 'string' && input.candidate_id
    ? input.candidate_id
    : `c_${crypto.randomBytes(8).toString('hex')}`;
  if (!safeId(candidateId)) throw new Error('invalid candidate id');

  const candidate: CandidateUpdate = {
    candidate_id: candidateId,
    kind: coerceKind(input.kind),
    confidence: input.confidence === undefined ? 'medium' : coerceConfidence(input.confidence),
    summary: summary || memoryText,
    memory_scope: coerceMemoryScope(input.memory_scope),
    ...(memoryText ? { memory_text: memoryText } : {}),
    ...(typeof input.registry_like_path === 'string' && input.registry_like_path.trim()
      ? { registry_like_path: input.registry_like_path.trim() }
      : {}),
    ...(typeof input.diff_summary === 'string' && input.diff_summary.trim()
      ? { diff_summary: input.diff_summary.trim() }
      : {}),
    ...(typeof input.target_field === 'string' && input.target_field.trim()
      ? { target_field: input.target_field.trim() }
      : {}),
    source_memory_refs: Array.isArray(input.source_memory_refs)
      ? input.source_memory_refs.filter((ref): ref is string => typeof ref === 'string' && !!ref)
      : [],
    ...(typeof input.project_id === 'string' && input.project_id.trim()
      ? { project_id: input.project_id.trim() }
      : {}),
    sensitivity: input.sensitivity === undefined ? 'standard' : coerceSensitivity(input.sensitivity),
    write_actor: input.write_actor === undefined ? 'llm' : coerceWriteActor(input.write_actor),
    recorded_time: typeof input.recorded_time === 'string' && input.recorded_time.trim()
      ? input.recorded_time.trim()
      : nowIso(),
  };

  const candidates = readCandidates(uid);
  const index = candidates.findIndex((item) => item.candidate_id === candidateId);
  if (index >= 0) candidates[index] = candidate;
  else candidates.push(candidate);
  await writeCandidates(uid, candidates);
  return { ok: true, candidate, candidates };
}

/** P-r1-31：onboarding 批量入池函数 addCandidates（连同其私有映射
 *  OnboardingCandidate / mapOnboardingType）已删——生产零调用，注释描述的
 *  onboarding 第 4 步流程不存在；单条入池走 addCandidate（回流线
 *  ontology-backflow 也用它）。 */

async function rejectCandidateUnlocked(uid: string, candidateId: string, reason?: string): Promise<{ ok: boolean }> {
  if (!safeId(uid) || !candidateId) throw new Error('invalid uid or candidateId');

  const candidates = readCandidates(uid);
  const idx = candidates.findIndex(c => c.candidate_id === candidateId);
  if (idx === -1) {
    log.warn('rejectCandidate: candidate not found', { uid, candidateId });
    return { ok: false };
  }

  candidates.splice(idx, 1);
  await writeCandidates(uid, candidates);
  log.info('candidate rejected', { uid, candidateId, reason });
  return { ok: true };
}

/**
 * 批量驳回。
 */
async function rejectCandidatesUnlocked(uid: string, candidateIds: string[], reason?: string): Promise<{ ok: boolean; rejectedCount: number }> {
  if (!safeId(uid)) throw new Error('invalid uid');
  if (!Array.isArray(candidateIds) || !candidateIds.length) return { ok: true, rejectedCount: 0 };

  const candidates = readCandidates(uid);
  const idSet = new Set(candidateIds);
  const remaining = candidates.filter(c => !idSet.has(c.candidate_id));
  const rejectedCount = candidates.length - remaining.length;

  if (rejectedCount > 0) {
    await writeCandidates(uid, remaining);
    log.info('candidates batch rejected', { uid, rejectedCount, reason });
  }

  return { ok: true, rejectedCount };
}

/**
 * 按记忆文本驳回（P-r1-29 兜存量）：purge 级联里，带资产正文全文的回流
 * 候选不止 `asset-backflow-<assetId>` 一条 id——回流池满、id 之外的历史
 * 投放都可能留下同文 pending 候选，确认即复活已 purge 的正文。这里把
 * memory_text 与给定正文全文相等（拍平空白后）的候选一并驳回。
 *
 * 只做全文相等，不做包含匹配：包含会把用户自己的相近记忆一起清掉。
 * 空文本直接返回——空串与任何候选都不该匹配。
 */
async function rejectCandidatesByTextUnlocked(
  uid: string,
  text: string,
  reason?: string,
): Promise<{ ok: boolean; rejectedCount: number }> {
  if (!safeId(uid)) throw new Error('invalid uid');
  const needle = flattenInline(text);
  if (!needle) return { ok: true, rejectedCount: 0 };

  const candidates = readCandidates(uid);
  const remaining = candidates.filter(c => flattenInline(c.memory_text) !== needle);
  const rejectedCount = candidates.length - remaining.length;

  if (rejectedCount > 0) {
    await writeCandidates(uid, remaining);
    log.info('candidates rejected by text match (purge cascade)', { uid, rejectedCount, reason });
  }

  return { ok: true, rejectedCount };
}

async function rejectCandidatesByTextHashUnlocked(
  uid: string,
  hash: string,
  reason?: string,
): Promise<{ ok: boolean; rejectedCount: number }> {
  if (!safeId(uid)) throw new Error('invalid uid');
  const target = String(hash || '').trim();
  if (!/^[a-f0-9]{64}$/.test(target)) return { ok: true, rejectedCount: 0 };
  const candidates = readCandidates(uid);
  const remaining = candidates.filter(c => candidateTextHash(c.memory_text) !== target);
  const rejectedCount = candidates.length - remaining.length;
  if (rejectedCount > 0) {
    await writeCandidates(uid, remaining);
    log.info('candidates rejected by text hash (purge cascade)', { uid, rejectedCount, reason });
  }
  return { ok: true, rejectedCount };
}

/** 同一候选池读改写串行化；确认跨 await 不再覆盖期间新增/驳回。 */
export const addCandidate = (...args: Parameters<typeof addCandidateUnlocked>): ReturnType<typeof addCandidateUnlocked> => {
  if (!safeId(args[0])) return Promise.reject(new Error('invalid uid'));
  return fileEditLock(candidatesMdPath(args[0])).runExclusive(() => addCandidateUnlocked(...args));
};

/** 同一候选池读改写串行化；确认跨 await 不再覆盖期间新增/驳回。 */
export const rejectCandidate = (...args: Parameters<typeof rejectCandidateUnlocked>): ReturnType<typeof rejectCandidateUnlocked> => {
  if (!safeId(args[0])) return Promise.reject(new Error('invalid uid'));
  return fileEditLock(candidatesMdPath(args[0])).runExclusive(() => rejectCandidateUnlocked(...args));
};

/** 同一候选池读改写串行化；确认跨 await 不再覆盖期间新增/驳回。 */
export const rejectCandidates = (...args: Parameters<typeof rejectCandidatesUnlocked>): ReturnType<typeof rejectCandidatesUnlocked> => {
  if (!safeId(args[0])) return Promise.reject(new Error('invalid uid'));
  return fileEditLock(candidatesMdPath(args[0])).runExclusive(() => rejectCandidatesUnlocked(...args));
};

/** 同一候选池读改写串行化；确认跨 await 不再覆盖期间新增/驳回。 */
export const rejectCandidatesByText = (...args: Parameters<typeof rejectCandidatesByTextUnlocked>): ReturnType<typeof rejectCandidatesByTextUnlocked> => {
  if (!safeId(args[0])) return Promise.reject(new Error('invalid uid'));
  return fileEditLock(candidatesMdPath(args[0])).runExclusive(() => rejectCandidatesByTextUnlocked(...args));
};

export const rejectCandidatesByTextHash = (...args: Parameters<typeof rejectCandidatesByTextHashUnlocked>): ReturnType<typeof rejectCandidatesByTextHashUnlocked> => {
  if (!safeId(args[0])) return Promise.reject(new Error('invalid uid'));
  return fileEditLock(candidatesMdPath(args[0])).runExclusive(() => rejectCandidatesByTextHashUnlocked(...args));
};
