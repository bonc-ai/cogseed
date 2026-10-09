/**
 * Personal Ontology Candidates — 个人本体候选审阅功能。
 *
 * 从技能 `personal-ontology-candidate-builder` 产出的候选台账中读取候选列表，
 * 支持 UI 层展示、确认/驳回操作。候选数据存储在 `<uid>/local/ontology_candidates/`。
 *
 * 数据格式（人读 markdown，不是 JSON）：
 * - `candidates.md`     —— 当前待确认的候选池（本模块读写）
 * - `blocked_items.md`  —— 阻断项（技能生成，本模块只读，用于展示）
 *
 * 关键设计：候选不是「打个状态戳」就算完事。
 * - 确认一条候选 = 把它从候选池挪走，真正写入 `features/memory.ts`
 *   管理的 `USER.md`（个人画像）或 `MEMORY.md`（共享事实）——这才是
 *   会被塞进每次对话 system prompt、让 AI 真正「记住」的地方。
 * - 驳回一条候选 = 直接从候选池移除，不进入任何记忆。
 * 所以候选池里只会有「待确认」的条目，不需要 status/confirmed_at 之类的
 * 状态字段——存在于文件里 == 待确认，被处理过 == 从文件里消失。
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { userLocalRoot, userOntologyGroupsDir } from '../paths';
import { writeTextAtomicSync, safeId, nowIso, readJsonSync } from '../storage';
import { addEntry as addMemoryEntry, addRoleTemplateMemoryEntry } from './memory';
import { listGroups } from './personal_ontology_groups';
import { routeCandidateToField } from './personal_ontology_router';
import {
  listTemplateFileCatalog,
  listFieldsByRef,
  appendFieldValueToRef,
  appendFlowEntryToRef,
  buildContentRef,
  splitContentRef,
  isTemplateFileText,
  parseTemplateContent,
  type TemplateSection,
} from './personal_ontology_template_files';
import { createLogger } from '../logger';
import type { FieldTargetStatus } from './personal_ontology_contract';

const log = createLogger('personal-ontology-candidates');

/** "选择去向"控件：确认一条候选时可以同时/分别写入全局记忆和任意数量的记忆
 *  分组，两者不互斥。`toGlobalMemory` 缺省为 true（向后兼容旧的单一去向行为）；
 *  `toGroupIds` 缺省为空数组（不写任何分组）。`targetField`（可选）：建议字段
 *  名（来自候选的 `target_field` / 用户在下拉里改选）——有坑填坑、没坑进流水区。 */
export interface ConfirmDestinations {
  toGlobalMemory?: boolean;
  toGroupIds?: string[];
  targetField?: string;
  /** 二期 D5：来源项目 id。确认落盘时附加到字段值（`@proj:<pid>`），展示层按项目过滤。 */
  projectId?: string;
}

/** Per-destination outcome, so the UI can tell "全局记忆写入失败" apart from
 *  "某个分组写入失败" and show them separately. */
export interface ConfirmCandidateResult {
  /** True once the candidate was actually placed somewhere (global memory
   *  and/or at least one group) and removed from the pending pool. False
   *  means every requested destination failed — the candidate stays in the
   *  pool, exactly like the pre-existing single-target behavior. */
  ok: boolean;
  error?: string;
  globalMemory?: { ok: boolean; error?: string };
  groups?: Array<{ groupId: string; ok: boolean; error?: string }>;
  /** 阶段 B：每条填坑尝试（appendFieldValue）的结果；`ok:false` = 该组无此
   *  字段，已回退流水区（流水区结果在 `groups` 里）。无 targetField 时缺省。 */
  fieldWrites?: Array<{
    groupId: string;
    /** 候选/用户给的字段名（原样回显，不是换算后的名字）。 */
    fieldName: string;
    ok: boolean;
    error?: string;
    /**
     * 历史名换算的结果分档。产品行为不变（命不中一律回退流水区），但**回退的
     * 原因不再被吞成一句 `field not found`** —— 退役、歧义、认不出是三种不同的
     * 处置，日志/回执里分不出来就没法查。缺省（无 targetField 时）不带。
     */
    targetStatus?: FieldTargetStatus;
    /** 换算后真正写入的字段名；仅在与 fieldName 不同时出现。 */
    resolvedFieldName?: string;
  }>;
}

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
}

function candidatesDir(uid: string): string {
  return path.join(userLocalRoot(uid), 'ontology_candidates');
}

function candidatesMdPath(uid: string): string {
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

/** 把候选数组序列化成人读 markdown。技能产出内容也应遵循这个格式。 */
export function serializeCandidatesMarkdown(candidates: CandidateUpdate[]): string {
  const header = `# 个人本体候选（待确认）\n\n> 最后更新: ${nowIso()} | 共 ${candidates.length} 条待确认\n`;
  if (!candidates.length) return `${header}\n暂无待确认候选。\n`;
  const blocks = candidates.map(c => {
    const lines = [`### ${c.candidate_id}`];
    lines.push(`- 类型: ${c.kind}`);
    lines.push(`- 置信度: ${c.confidence}`);
    if (c.summary) lines.push(`- 摘要: ${c.summary}`);
    lines.push(`- 记忆去向: ${c.memory_scope}`);
    if (c.memory_text) lines.push(`- 记忆文本: ${c.memory_text}`);
    if (c.registry_like_path) lines.push(`- 路径: ${c.registry_like_path}`);
    if (c.diff_summary) lines.push(`- 差异: ${c.diff_summary}`);
    if (c.target_field) lines.push(`- 建议字段: ${c.target_field}`);
    if (c.project_id) lines.push(`- 来源项目: ${c.project_id}`);
    if (c.sensitivity && c.sensitivity !== 'standard') lines.push(`- 敏感度: ${c.sensitivity}`);
    if (c.write_actor && c.write_actor !== 'llm') lines.push(`- 写入者: ${c.write_actor}`);
    if (c.recorded_time) lines.push(`- 记录时间: ${c.recorded_time}`);
    if (c.source_memory_refs?.length) lines.push(`- 来源: ${c.source_memory_refs.join(', ')}`);
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

function migrateLegacyJsonIfPresent(uid: string): void {
  const mdPath = candidatesMdPath(uid);
  const jsonPath = legacyCandidatesJsonPath(uid);
  if (fs.existsSync(mdPath) || !fs.existsSync(jsonPath)) return;

  try {
    const legacy = readJsonSync<LegacyCandidatesJson>(jsonPath);
    const items = Array.isArray(legacy.candidate_updates) ? legacy.candidate_updates : [];
    const kept: CandidateUpdate[] = [];
    let migratedToMemory = 0;

    for (const c of items) {
      if (!c || !c.candidate_id) continue;
      if (c.status === 'rejected') continue; // 驳回过的直接丢弃

      const summary = legacySummaryFor(c);
      const scope: MemoryTargetScope = c.identity_scope_decision === 'personal_global' ? 'user' : 'shared';

      if (c.status === 'confirmed') {
        // 历史欠账：之前「确认」只打了状态戳，从未真正写入记忆。这里补写。
        const res = addMemoryEntry(uid, scope === 'user' ? 'user' : 'memory', summary);
        if (res.ok) migratedToMemory++;
        else log.warn('legacy confirmed candidate migration write failed', { uid, candidateId: c.candidate_id, error: res.error });
        continue;
      }

      // pending → 转换格式，保留在候选池里
      kept.push({
        candidate_id: c.candidate_id,
        kind: coerceKind(c.kind),
        confidence: coerceConfidence(c.confidence),
        summary,
        memory_scope: scope,
        memory_text: summary,
        ...(c.registry_like_path ? { registry_like_path: c.registry_like_path } : {}),
        ...(c.diff_summary ? { diff_summary: c.diff_summary } : {}),
        source_memory_refs: Array.isArray(c.source_memory_refs) ? c.source_memory_refs : [],
      });
    }

    writeTextAtomicSync(mdPath, serializeCandidatesMarkdown(kept));
    fs.renameSync(jsonPath, `${jsonPath}.bak`);
    log.info('migrated legacy candidates.json', { uid, kept: kept.length, migratedToMemory });
  } catch (err) {
    log.warn('legacy candidates.json migration failed', { uid, error: (err as Error).message });
  }
}

// ── 读写 ─────────────────────────────────────────────────────────────────

function readCandidates(uid: string): CandidateUpdate[] {
  migrateLegacyJsonIfPresent(uid);
  return parseCandidatesMarkdown(readTextSafe(candidatesMdPath(uid)));
}

function writeCandidates(uid: string, candidates: CandidateUpdate[]): void {
  writeTextAtomicSync(candidatesMdPath(uid), serializeCandidatesMarkdown(candidates));
}

function readBlockedItems(uid: string): BlockedItem[] {
  return parseBlockedItemsMarkdown(readTextSafe(blockedItemsMdPath(uid)));
}

/**
 * 读取候选列表 + 阻断项。文件不存在时返回空数组（首次读取会顺带触发旧数据迁移）。
 */
export async function listCandidates(uid: string): Promise<CandidatesData> {
  if (!safeId(uid)) throw new Error('invalid uid');
  return {
    candidate_updates: readCandidates(uid),
    blocked_items: readBlockedItems(uid),
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
export async function addCandidate(
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
  writeCandidates(uid, candidates);
  return { ok: true, candidate, candidates };
}

/** onboarding 抽取产物 → 候选池的最小映射。抽取层用的是 `ExtractionCandidate`
 *  （judgment/summary/suggestedType/suggestedScope/uncertainty），候选池用的是
 *  `CandidateUpdate`。这里做一次忠实转换，不臆造任何字段：
 *  - suggestedType → kind + memory_scope：
 *      personal     → preference / user   （个人偏好进 USER.md）
 *      rule         → rule       / shared （通用规则进 MEMORY.md）
 *      template     → instance   / user   （实例化信息，个人画像）
 *      skill_method → rule       / shared （可复用做法，当规则记）
 *  - judgment → memory_text（确认后真正写进记忆的文本）；summary 回退用 judgment
 *  - confidence 一律 'low'：onboarding 首轮抽取未经用户核对，进池等确认，不冒充高置信
 *  - source_memory_refs 置空：onboarding 没有可回指的既有记忆条目 */
type OnboardingCandidate = {
  judgment: string;
  summary?: string;
  suggestedType: 'personal' | 'rule' | 'template' | 'skill_method';
  suggestedScope?: string;
  uncertainty?: string;
};

function mapOnboardingType(
  t: OnboardingCandidate['suggestedType'],
): { kind: CandidateKind; scope: MemoryTargetScope } {
  switch (t) {
    case 'personal':
      return { kind: 'preference', scope: 'user' };
    case 'rule':
      return { kind: 'rule', scope: 'shared' };
    case 'template':
      return { kind: 'instance', scope: 'user' };
    case 'skill_method':
      return { kind: 'rule', scope: 'shared' };
    default:
      return { kind: 'instance', scope: 'user' };
  }
}

/**
 * 把 onboarding 抽取出的候选批量写入候选池（不确认、不落记忆——只是进池等
 * 用户在第 4 步勾选后再走 `confirmCandidate`）。返回实际写入的 candidate_id 列表，
 * 供前端记录「哪些进了池」，勾选确认时按 id 调 `confirmCandidate`。
 *
 * 忠实约束：judgment 为空的条目直接跳过（不编造摘要）；candidate_id 不含空白
 * （解析器用 `### <id>` 且 id 匹配 `\S+`），用时间戳+序号+随机后缀保证唯一。
 */
export async function addCandidates(
  uid: string,
  candidates: OnboardingCandidate[],
): Promise<{ candidate_ids: string[] }> {
  if (!safeId(uid)) throw new Error('invalid uid');
  const incoming = Array.isArray(candidates) ? candidates : [];
  if (!incoming.length) return { candidate_ids: [] };

  const existing = readCandidates(uid);
  const written: string[] = [];
  const stamp = Date.now();
  let seq = 0;

  for (const c of incoming) {
    const judgment = typeof c?.judgment === 'string' ? c.judgment.trim() : '';
    if (!judgment) continue; // 无正文不入池，绝不编造
    const { kind, scope } = mapOnboardingType(c.suggestedType);
    const summary = (typeof c.summary === 'string' && c.summary.trim()) || judgment;
    const rand = Math.random().toString(36).slice(2, 8);
    const candidateId = `ob-${stamp}-${seq++}-${rand}`;
    existing.push({
      candidate_id: candidateId,
      kind,
      confidence: 'low',
      summary,
      memory_scope: scope,
      memory_text: judgment,
      ...(typeof c.uncertainty === 'string' && c.uncertainty.trim()
        ? { diff_summary: c.uncertainty.trim() }
        : {}),
      source_memory_refs: [],
    });
    written.push(candidateId);
  }

  if (written.length) writeCandidates(uid, existing);
  log.info('onboarding candidates added to pool', { uid, added: written.length });
  return { candidate_ids: written };
}

/**
 * 判断 groupId 是否模板文件组（阶段 D：台账带 template_id 且文件携带
 * `> 模板:` 元信息行）。是 → 返回 template_id + 解析出的分节（含字段与流水）；
 * 否 → null。模板文件是模板组的唯一事实来源；候选路由必须按分节寻址，
 * 双区解析器会把分节式文件误当纯文本流水（fields 恒空），导致“有坑填坑”判断失真。
 */
async function resolveTemplateGroupSections(
  uid: string,
  groupId: string,
): Promise<{ template_id: string; sections: TemplateSection[] } | null> {
  try {
    const groups = await listGroups(uid);
    const meta = groups.find((g) => g.group_id === groupId);
    if (!meta || !meta.template_id) return null;
    const rel = meta.rel_path || `.personal_ontology_groups/${meta.template_id}.md`;
    const abs = path.join(userOntologyGroupsDir(uid), rel.replace(/^\.personal_ontology_groups\//, ''));
    const text = fs.readFileSync(abs, 'utf8');
    if (!isTemplateFileText(text)) return null;
    return { template_id: meta.template_id, sections: parseTemplateContent(text).sections };
  } catch {
    return null;
  }
}

/**
 * 候选的「建议字段」→ 当前 schema 下的真实落点。
 *
 * `target_field` 是**长期存在候选池里**的一个裸字段名（`- 建议字段:` 行，候选生成
 * 那一刻的 schema）。候选还没确认、角色模板先做了 rename / move 迁移时，拿旧字面量
 * 去文件里找只会落空 —— 值退回流水区、预选无声消失。这里在消费的那一刻做一次换算。
 *
 * **候选文件本身不动**：不重写 candidates.md，不批量迁移存量，换算只发生在读取侧。
 *
 * 换算走 PO contract 的 resolveRoleTemplateFieldTarget（唯一那道 identity 阶梯），
 * 这里不自建第二套名字兼容逻辑。普通记忆分组没有角色模板 schema，原样返回。
 */
async function resolveCandidateFieldTarget(
  uid: string,
  groupRef: string,
  targetField: string,
): Promise<{ ref: string; fieldName: string; section?: string; status: FieldTargetStatus; resolved: boolean }> {
  const { groupId: baseId, section } = splitContentRef(groupRef);
  const tpl = await resolveTemplateGroupSections(uid, baseId);
  // 普通组：没有角色模板 schema，无从换算，行为与改动前完全一致。
  if (!tpl) return { ref: groupRef, fieldName: targetField, status: 'current_name', resolved: true };

  const { resolveRoleTemplateFieldTarget, isResolvedFieldTarget } =
    await import('./personal_ontology_contract');
  // 复合 ref 自带分节上下文；模板整组（候选没有分节概念）则不给，让它走全模板解析。
  const res = resolveRoleTemplateFieldTarget(tpl.template_id, targetField, section || undefined);
  // 认不出 / 退役 / 歧义 → 不是可写落点。**必须在这里断掉**：候选自动通道只填
  // T-box 声明过的坑，不得顺手写用户自建字段，也不得复活退役字段。
  if (!isResolvedFieldTarget(res)) {
    return { ref: groupRef, fieldName: targetField, status: res.status, resolved: false };
  }
  return {
    ref: section ? buildContentRef(baseId, res.section as string) : groupRef,
    fieldName: res.fieldName as string,
    section: res.section,
    status: res.status,
    resolved: true,
  };
}

/** 命不中落点时的可观测记录：四种原因分开，不吞成一句 field not found。 */
function recordFieldTargetMiss(
  result: ConfirmCandidateResult,
  uid: string,
  candidateId: string,
  groupId: string,
  targetField: string,
  status: FieldTargetStatus,
): void {
  result.fieldWrites!.push({
    groupId, fieldName: targetField, ok: false, error: 'field not found', targetStatus: status,
  });
  log.warn('candidate field target unresolved, falling back to flow', {
    uid, candidateId, groupId, targetField, targetStatus: status,
  });
}

/**
 * 把一条候选实际写入所有请求的去向（全局记忆 + 0..N 个记忆分组）。不改候选池，
 * 纯粹的“写”这一步 —— 候选池的增删由调用方（confirmCandidate）
 * 负责，方便批量场景复用同一份落地逻辑。
 *
 * 容错风格：一个去向失败不影响其余去向。只要至少一个去向
 * 写入成功，就认为这条候选“已处理”，应该从池里移除；如果全部去向都失败
 * （或没有任何去向被请求），候选保留在池里，不会静默丢失。
 */
async function writeCandidateToDestinations(
  uid: string,
  candidate: CandidateUpdate,
  dest: ConfirmDestinations,
  source = '候选',
  userPickedRole = false,
): Promise<ConfirmCandidateResult> {
  const text = (candidate.memory_text || candidate.summary || '').trim();
  if (!text) return { ok: false, error: 'candidate has no memory text' };

  const wantsGlobal = dest.toGlobalMemory !== false; // default true — back-compat
  const groupIds = Array.isArray(dest.toGroupIds) ? dest.toGroupIds.filter(Boolean) : [];

  const result: ConfirmCandidateResult = { ok: false };
  let anySucceeded = false;

  if (wantsGlobal) {
    const target = candidate.memory_scope === 'shared' ? 'memory' : 'user';
    // 角色标签：只有**用户显式选了角色模板**（去向含模板组）时，全局记忆条目才附带
    // 来源标记；LLM 自动加入的模板去向（userPickedRole=false）不打标签 —— 否则
    // 用户从未关联的角色会在卸载时连带归档/删除其全局记忆（A-4）。
    let roleTemplateId: string | undefined;
    if (userPickedRole) {
      for (const gid of groupIds) {
        const tpl = await resolveTemplateGroupSections(uid, gid.split('::')[0]);
        if (tpl) { roleTemplateId = tpl.template_id; break; }
      }
    }
    const res = roleTemplateId
      ? addRoleTemplateMemoryEntry(uid, target, roleTemplateId, text)
      : addMemoryEntry(uid, target, text);
    result.globalMemory = { ok: res.ok, ...(res.error ? { error: res.error } : {}) };
    if (res.ok) anySucceeded = true;
    else log.warn('candidate global-memory write blocked', { uid, candidateId: candidate.candidate_id, error: res.error });
  }

  if (groupIds.length) {
    for (const groupId of groupIds) {
      // 模板文件组：候选没有分节概念，跨分节路由 —— targetField 命中该模板
      // 某分节的字段 → 写那个分节；未命中 / 无 targetField → 回退首个分节
      // 流水区（模板文件没有整组流水区；数据不丢，可后续升格）。
      const tpl = await resolveTemplateGroupSections(uid, groupId);
      if (tpl && tpl.sections.length) {
        // 候选自动通道的白名单：只填模板 T-box 声明过的字段（“有坑填坑”）；
        // 自定义字段只能由用户手动升格创建，候选不得顺手建坑。判据与历史名换算
        // 都来自 contract（单一实现）；模板未知 / 认不出 → 不放行。
        if (dest.targetField) {
          if (!result.fieldWrites) result.fieldWrites = [];
          const target = await resolveCandidateFieldTarget(uid, groupId, dest.targetField);
          // 先按 catalog 当前分节找，再退回“文件里哪一节有这个字段就写哪一节”——
          // 后者是换算之前的既有行为，实例文件与 catalog 暂时不同步时不该变坏。
          const has = (sec: TemplateSection) =>
            Object.prototype.hasOwnProperty.call(sec.fields, target.fieldName);
          const sec = !target.resolved
            ? undefined
            : tpl.sections.find((x) => has(x) && x.title === target.section) || tpl.sections.find(has);
          if (sec) {
            const res = await appendFieldValueToRef(uid, `${groupId}::${sec.title}`, target.fieldName, text, source, dest.projectId ?? candidate.project_id);
            result.fieldWrites.push({
              groupId,
              fieldName: dest.targetField as string,
              ok: res.ok,
              targetStatus: target.status,
              ...(target.fieldName !== dest.targetField ? { resolvedFieldName: target.fieldName } : {}),
              ...(res.error ? { error: res.error } : {}),
            });
            if (res.ok) anySucceeded = true;
            else log.warn('candidate template field write failed', { uid, candidateId: candidate.candidate_id, groupId, error: res.error });
            continue; // 已尝试填坑，不再写流水区
          }
          recordFieldTargetMiss(result, uid, candidate.candidate_id, groupId, dest.targetField, target.status);
        }
        const res = await appendFlowEntryToRef(uid, `${groupId}::${tpl.sections[0].title}`, text);
        if (!result.groups) result.groups = [];
        result.groups.push({ groupId, ok: res.ok, ...(res.error ? { error: res.error } : {}) });
        if (res.ok) anySucceeded = true;
        else log.warn('candidate template flow write failed', { uid, candidateId: candidate.candidate_id, groupId, error: res.error });
        continue;
      }

      // 阶段 B/D 路由：有 targetField → 先判该去向有没有这个“坑”（模板分节
      // 字段或普通组实例字段，见 listFieldsByRef），有 → appendFieldValueToRef
      // （多值追加+[候选]/[智能]来源）；没有 → 回退流水区 appendFlowEntryToRef。
      // 无 targetField → 直接流水区（旧行为）。
      // 裁决说明：任务书 §3.3 的“返回 field not found 则回退”通过 listFieldsByRef
      // 预检查实现，避免与 §3.2“appendFieldValue 字段小节不存在则创建”冲突。
      if (dest.targetField) {
        if (!result.fieldWrites) result.fieldWrites = [];
        // 复合 ref（gid::分节）指向的是模板分节，历史名要先换算；普通组原样。
        const target = await resolveCandidateFieldTarget(uid, groupId, dest.targetField);
        let fieldExists = false;
        try {
          const fieldsRes = target.resolved ? await listFieldsByRef(uid, target.ref) : undefined;
          fieldExists = !!fieldsRes?.fields?.some((f) => f.name === target.fieldName);
        } catch {
          fieldExists = false;
        }
        if (fieldExists) {
          const res = await appendFieldValueToRef(uid, target.ref, target.fieldName, text, source, dest.projectId ?? candidate.project_id);
          result.fieldWrites.push({
            groupId,
            fieldName: dest.targetField as string,
            ok: res.ok,
            targetStatus: target.status,
            ...(target.fieldName !== dest.targetField ? { resolvedFieldName: target.fieldName } : {}),
            ...(res.error ? { error: res.error } : {}),
          });
          if (res.ok) anySucceeded = true;
          else log.warn('candidate field write failed', { uid, candidateId: candidate.candidate_id, groupId, error: res.error });
          continue; // 已尝试填坑，不再写流水区
        }
        recordFieldTargetMiss(result, uid, candidate.candidate_id, groupId, dest.targetField, target.status);
      }
      const res = await appendFlowEntryToRef(uid, groupId, text);
      if (!result.groups) result.groups = [];
      result.groups.push({ groupId, ok: res.ok, ...(res.error ? { error: res.error } : {}) });
      if (res.ok) anySucceeded = true;
      else log.warn('candidate group write failed', { uid, candidateId: candidate.candidate_id, groupId, error: res.error });
    }
  }

  result.ok = anySucceeded;
  if (!anySucceeded && !result.error) {
    result.error = wantsGlobal || groupIds.length ? 'all destinations failed' : 'no destination selected';
  }
  return result;
}

export interface ConfirmCandidateOptions {
  /** 确认时经一轮 LLM 识别路由：没显式指定字段的候选，由 LLM 判断填哪个模板组
   *  字段（来源标「智能」）；拿不准/失败回退流水区。默认关闭（老行为）。 */
  routeWithLlm?: boolean;
}

/**
 * LLM 路由解析：routeWithLlm 且候选未显式指定 targetField 时，调 LLM 判断
 * 填哪个模板文件分节的哪个字段。用户已指定字段 → 不覆盖（用户意图优先）。
 * 命中模板分节 → toGroupIds push 复合 id（`groupId::分节`，分节编码在内，
 * 无需新增 targetSection 参数）；命中普通组 → 仅设 targetField（预检查兜底）。
 * 返回生效的 dest + 来源标记（'智能' 或 '候选'）。
 */
async function resolveLlmRoute(
  uid: string,
  candidate: CandidateUpdate,
  dest: ConfirmDestinations,
  opts: ConfirmCandidateOptions,
): Promise<{ effectiveDest: ConfirmDestinations; source: string; userPickedRole: boolean }> {
  // 用户是否显式选过角色模板（原始 dest 含模板组）。LLM 分支 3 自动加入的模板
  // 不算 —— 那只是"自动归位"，用户没有主动关联该角色。
  const userPickedRole = (dest.toGroupIds || []).some((id) => {
    if (id.includes('::')) return false; // 复合 id 是分节，不是模板组本身
    return true;
  });
  if (!opts.routeWithLlm || dest.targetField) return { effectiveDest: dest, source: '候选', userPickedRole };
  const text = (candidate.memory_text || candidate.summary || '').trim();
  if (!text) return { effectiveDest: dest, source: '候选', userPickedRole };

  const catalog = await listTemplateFileCatalog(uid);
  if (!catalog.length) return { effectiveDest: dest, source: '候选', userPickedRole };
  const decision = await routeCandidateToField(uid, text, catalog);
  if (decision.action !== 'field' || !decision.group_title || !decision.field_name) {
    return { effectiveDest: dest, source: '候选', userPickedRole }; // flow → 维持原 dest（流水区）
  }

  const dest2: ConfirmDestinations = { ...dest, toGroupIds: dest.toGroupIds ? [...dest.toGroupIds] : [] };

  // 1) 用户已选模板分节（复合 id）→ 字段必须在该分节内
  for (const ref of dest2.toGroupIds) {
    const { groupId, section } = splitContentRef(ref);
    if (!section) continue;
    const entry = catalog.find((e) => e.group_id === groupId);
    if (entry && entry.sections.some((s) => s.title === section && s.fields.includes(decision.field_name))) {
      dest2.targetField = decision.field_name;
      return { effectiveDest: dest2, source: '智能', userPickedRole };
    }
  }
  // 2) 用户已选普通组（title 匹配）→ 建议字段，最终由 listFieldsByRef 预检查兜底
  const groups = await listGroups(uid);
  if (dest2.toGroupIds.some((id) =>
    groups.some((g) => g.group_id === id && !g.template_id && g.title === decision.group_title),
  )) {
    dest2.targetField = decision.field_name;
    return { effectiveDest: dest2, source: '智能', userPickedRole };
  }
  // 2b) 用户只选了角色（模板组纯 group_id，未展开到分节）→ 在该角色模板内找分节，
  //     命中则把去向收窄到该分节复合 id + 目标字段（LLM 自动归位）。
  for (const id of dest2.toGroupIds) {
    if (id.includes('::')) continue; // 已是复合 id，走上面的分节分支
    const entry = catalog.find((e) => e.group_id === id);
    if (!entry) continue;
    const sec = entry.sections.find((s) => s.title === decision.group_title && s.fields.includes(decision.field_name));
    if (sec) {
      dest2.toGroupIds = dest2.toGroupIds.filter((x) => x !== id);
      dest2.toGroupIds.push(buildContentRef(id, sec.title));
      dest2.targetField = decision.field_name;
      return { effectiveDest: dest2, source: '智能', userPickedRole };
    }
  }
  // 3) 用户没选组 → 找第一个含该分节.字段的模板文件，自动加入（复合 id）
  if (!dest2.toGroupIds.length) {
    const hit = catalog.find((e) =>
      e.sections.some((s) => s.title === decision.group_title && s.fields.includes(decision.field_name)),
    );
    if (hit) {
      dest2.toGroupIds.push(buildContentRef(hit.group_id, decision.group_title));
      dest2.targetField = decision.field_name;
      return { effectiveDest: dest2, source: '智能', userPickedRole: false };
    }
  }
  return { effectiveDest: dest, source: '候选', userPickedRole };
}

/**
 * 确认一个候选：写入所有请求的去向（默认只写全局记忆，向后兼容旧行为），
 * 至少一个去向成功即从候选池移除；全部失败则保留在池里，不会静默丢失。
 * `opts.routeWithLlm` 开启时先做一轮 LLM 对号入座路由（见 resolveLlmRoute）。
 */
export async function confirmCandidate(
  uid: string,
  candidateId: string,
  dest: ConfirmDestinations = {},
  opts: ConfirmCandidateOptions = {},
): Promise<ConfirmCandidateResult> {
  if (!safeId(uid) || !candidateId) throw new Error('invalid uid or candidateId');

  const candidates = readCandidates(uid);
  const idx = candidates.findIndex(c => c.candidate_id === candidateId);
  if (idx === -1) {
    log.warn('confirmCandidate: candidate not found', { uid, candidateId });
    return { ok: false, error: 'candidate not found' };
  }

  const candidate = candidates[idx];
  const { effectiveDest, source, userPickedRole } = await resolveLlmRoute(uid, candidate, dest, opts);
  const result = await writeCandidateToDestinations(uid, candidate, effectiveDest, source, userPickedRole);
  if (!result.ok) return result;

  candidates.splice(idx, 1);
  writeCandidates(uid, candidates);
  log.info('candidate confirmed and written to destinations', {
    uid, candidateId,
    globalMemory: result.globalMemory?.ok,
    groupCount: result.groups?.length || 0,
    fieldCount: result.fieldWrites?.length || 0,
    source,
  });
  return result;
}

/**
 * 驳回一个候选：直接从候选池移除，不写入任何记忆。
 */
export async function rejectCandidate(uid: string, candidateId: string, reason?: string): Promise<{ ok: boolean }> {
  if (!safeId(uid) || !candidateId) throw new Error('invalid uid or candidateId');

  const candidates = readCandidates(uid);
  const idx = candidates.findIndex(c => c.candidate_id === candidateId);
  if (idx === -1) {
    log.warn('rejectCandidate: candidate not found', { uid, candidateId });
    return { ok: false };
  }

  candidates.splice(idx, 1);
  writeCandidates(uid, candidates);
  log.info('candidate rejected', { uid, candidateId, reason });
  return { ok: true };
}

/**
 * 批量驳回。
 */
export async function rejectCandidates(uid: string, candidateIds: string[], reason?: string): Promise<{ ok: boolean; rejectedCount: number }> {
  if (!safeId(uid)) throw new Error('invalid uid');
  if (!Array.isArray(candidateIds) || !candidateIds.length) return { ok: true, rejectedCount: 0 };

  const candidates = readCandidates(uid);
  const idSet = new Set(candidateIds);
  const remaining = candidates.filter(c => !idSet.has(c.candidate_id));
  const rejectedCount = candidates.length - remaining.length;

  if (rejectedCount > 0) {
    writeCandidates(uid, remaining);
    log.info('candidates batch rejected', { uid, rejectedCount, reason });
  }

  return { ok: true, rejectedCount };
}
