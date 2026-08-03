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
import * as path from 'node:path';
import { userLocalRoot } from '../paths';
import { writeTextAtomicSync, safeId, nowIso, readJsonSync } from '../storage';
import { addEntry as addMemoryEntry } from './memory';
import { appendToGroup, appendFieldValue, listGroupFields, listGroups, listRoleTemplateStatus } from './personal_ontology_groups';
import { routeCandidateToField, type RouteDecision } from './personal_ontology_router';
import { createLogger } from '../logger';

const log = createLogger('personal-ontology-candidates');

/** "选择去向"控件：确认一条候选时可以同时/分别写入全局记忆和任意数量的记忆
 *  分组，两者不互斥。`toGlobalMemory` 缺省为 true（向后兼容旧的单一去向行为）；
 *  `toGroupIds` 缺省为空数组（不写任何分组）。`targetField`（可选）：建议字段
 *  名（来自候选的 `target_field` / 用户在下拉里改选）——有坑填坑、没坑进流水区。 */
export interface ConfirmDestinations {
  toGlobalMemory?: boolean;
  toGroupIds?: string[];
  targetField?: string;
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
  fieldWrites?: Array<{ groupId: string; fieldName: string; ok: boolean; error?: string }>;
}

/** 候选类型。`preference`（偏好）是一等公民，不再藏在 relation 里。 */
export type CandidateKind = 'preference' | 'instance' | 'property' | 'relation' | 'rule';

/** 这条候选确认后应该进哪本记忆——对应 `features/memory.ts` 的两个用户级存储：
 *  `user`   → USER.md   （个人画像/偏好，跨 agent 生效，容量较小）
 *  `shared` → MEMORY.md （更泛化的事实/规则，跨项目跨 agent，容量稍大） */
export type MemoryTargetScope = 'user' | 'shared';

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
};

const VALID_KINDS: CandidateKind[] = ['preference', 'instance', 'property', 'relation', 'rule'];
const VALID_CONFIDENCE = ['low', 'medium', 'high'];

function coerceKind(v: unknown): CandidateKind {
  return (VALID_KINDS as string[]).includes(String(v)) ? (v as CandidateKind) : 'instance';
}

function coerceConfidence(v: unknown): 'low' | 'medium' | 'high' {
  return (VALID_CONFIDENCE.includes(String(v)) ? v : 'medium') as 'low' | 'medium' | 'high';
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
      ...(raw.registry_like_path ? { registry_like_path: raw.registry_like_path } : {}),
      ...(raw.diff_summary ? { diff_summary: raw.diff_summary } : {}),
      ...(raw.target_field ? { target_field: raw.target_field } : {}),
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

/**
 * 把一条候选实际写入所有请求的去向（全局记忆 + 0..N 个记忆分组）。不改候选池，
 * 纯粹的“写”这一步 —— 池的增删由调用方（confirmCandidate/confirmCandidates）
 * 负责，方便批量场景复用同一份落地逻辑。
 *
 * 容错风格跟现有批量确认一致：一个去向失败不影响其余去向。只要至少一个去向
 * 写入成功，就认为这条候选“已处理”，应该从池里移除；如果全部去向都失败
 * （或没有任何去向被请求），候选保留在池里，不会静默丢失。
 */
async function writeCandidateToDestinations(
  uid: string,
  candidate: CandidateUpdate,
  dest: ConfirmDestinations,
  source = '候选',
): Promise<ConfirmCandidateResult> {
  const text = (candidate.memory_text || candidate.summary || '').trim();
  if (!text) return { ok: false, error: 'candidate has no memory text' };

  const wantsGlobal = dest.toGlobalMemory !== false; // default true — back-compat
  const groupIds = Array.isArray(dest.toGroupIds) ? dest.toGroupIds.filter(Boolean) : [];

  const result: ConfirmCandidateResult = { ok: false };
  let anySucceeded = false;

  if (wantsGlobal) {
    const target = candidate.memory_scope === 'shared' ? 'memory' : 'user';
    const res = addMemoryEntry(uid, target, text);
    result.globalMemory = { ok: res.ok, ...(res.error ? { error: res.error } : {}) };
    if (res.ok) anySucceeded = true;
    else log.warn('candidate global-memory write blocked', { uid, candidateId: candidate.candidate_id, error: res.error });
  }

  if (groupIds.length) {
    for (const groupId of groupIds) {
      // 阶段 B 路由：有 targetField → 先判该组有没有这个“坑”（模板声明或实例
      // 字段，见 listGroupFields），有 → appendFieldValue（多值追加+[候选]来源）；
      // 没有 → 回退流水区 appendToGroup。无 targetField → 直接流水区（旧行为）。
      // 裁决说明：任务书 §3.3 的“返回 field not found 则回退”通过 listGroupFields
      // 预检查实现，避免与 §3.2“appendFieldValue 字段小节不存在则创建”冲突。
      if (dest.targetField) {
        if (!result.fieldWrites) result.fieldWrites = [];
        let fieldExists = false;
        try {
          const fieldsRes = await listGroupFields(uid, groupId);
          fieldExists = !!fieldsRes.fields?.some((f) => f.name === dest.targetField);
        } catch {
          fieldExists = false;
        }
        if (fieldExists) {
          const res = await appendFieldValue(uid, groupId, dest.targetField, text, source);
          result.fieldWrites.push({
            groupId,
            fieldName: dest.targetField as string,
            ok: res.ok,
            ...(res.error ? { error: res.error } : {}),
          });
          if (res.ok) anySucceeded = true;
          else log.warn('candidate field write failed', { uid, candidateId: candidate.candidate_id, groupId, error: res.error });
          continue; // 已尝试填坑，不再写流水区
        }
        result.fieldWrites.push({ groupId, fieldName: dest.targetField, ok: false, error: 'field not found' });
      }
      const res = await appendToGroup(uid, groupId, text);
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
 * 填哪个模板组字段。用户已指定字段 → 不覆盖（用户意图优先）。
 * 返回生效的 dest + 来源标记（'智能' 或 '候选'）。
 */
async function resolveLlmRoute(
  uid: string,
  candidate: CandidateUpdate,
  dest: ConfirmDestinations,
  opts: ConfirmCandidateOptions,
): Promise<{ effectiveDest: ConfirmDestinations; source: string }> {
  if (!opts.routeWithLlm || dest.targetField) return { effectiveDest: dest, source: '候选' };
  const text = (candidate.memory_text || candidate.summary || '').trim();
  if (!text) return { effectiveDest: dest, source: '候选' };

  const templates = await listRoleTemplateStatus(uid);
  const decision: RouteDecision = await routeCandidateToField(uid, text, templates);
  if (decision.action !== 'field' || !decision.group_title || !decision.field_name) {
    return { effectiveDest: dest, source: '候选' }; // flow → 维持原 dest（流水区）
  }

  const dest2: ConfirmDestinations = { ...dest, toGroupIds: dest.toGroupIds ? [...dest.toGroupIds] : [] };
  // 优先用户已选组（title 匹配）；用户没选组 → 用已安装模板组
  let targetGroup = (await listGroups(uid)).find(
    (g) => dest2.toGroupIds.includes(g.group_id) && g.title === decision.group_title,
  );
  if (!targetGroup && !dest2.toGroupIds.length) {
    targetGroup = (await listGroups(uid)).find((g) => g.template_id && g.title === decision.group_title);
    if (targetGroup) dest2.toGroupIds.push(targetGroup.group_id);
  }
  if (!targetGroup) return { effectiveDest: dest, source: '候选' };
  dest2.targetField = decision.field_name;
  return { effectiveDest: dest2, source: '智能' };
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
  const { effectiveDest, source } = await resolveLlmRoute(uid, candidate, dest, opts);
  const result = await writeCandidateToDestinations(uid, candidate, effectiveDest, source);
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

/** 批量确认的去向总览：`toFields` = 各字段名实际填坑成功条数，`toEntries` =
 *  实际进入流水区的条数（每条候选每个组的流水区写入计一次）。供确认前总览提示。 */
export interface ConfirmSummary {
  toFields: Array<{ fieldName: string; count: number }>;
  toEntries: number;
}

/**
 * 批量确认。逐条尝试写入所有请求的去向；某条候选的某个去向失败不影响其余候选
 * 或其余去向 —— 一条候选只要至少一个去向成功就算确认，全部失败才保留在池里。
 * `dest` 对这一批里的每一条候选生效（跟审阅面板"批量操作走同一份选择去向"的
 * 用法一致；如需要逐条不同去向，调用方应改用单条 `confirmCandidate`）。
 * 返回体带 `summary`（实际路由总览：填坑 vs 流水区）。
 */
export async function confirmCandidates(
  uid: string,
  candidateIds: string[],
  dest: ConfirmDestinations = {},
  opts: ConfirmCandidateOptions = {},
): Promise<{
  ok: boolean;
  confirmedCount: number;
  failedIds: string[];
  results: Record<string, ConfirmCandidateResult>;
  summary: ConfirmSummary;
}> {
  if (!safeId(uid)) throw new Error('invalid uid');
  if (!Array.isArray(candidateIds) || !candidateIds.length) {
    return { ok: true, confirmedCount: 0, failedIds: [], results: {}, summary: { toFields: [], toEntries: 0 } };
  }

  const candidates = readCandidates(uid);
  const idSet = new Set(candidateIds);
  const remaining: CandidateUpdate[] = [];
  const failedIds: string[] = [];
  const results: Record<string, ConfirmCandidateResult> = {};
  let confirmedCount = 0;

  for (const c of candidates) {
    if (!idSet.has(c.candidate_id)) { remaining.push(c); continue; }
    const { effectiveDest, source } = await resolveLlmRoute(uid, c, dest, opts);
    const res = await writeCandidateToDestinations(uid, c, effectiveDest, source);
    results[c.candidate_id] = res;
    if (res.ok) confirmedCount++;
    else { remaining.push(c); failedIds.push(c.candidate_id); }
  }

  writeCandidates(uid, remaining);
  log.info('candidates batch confirmed', { uid, confirmedCount, failed: failedIds.length });

  // 按每条候选各自的实际路由结果统计总览（填坑 ok 的按字段名聚合；流水区计数）
  const fieldCounts = new Map<string, number>();
  let toEntries = 0;
  for (const res of Object.values(results)) {
    if (!res.ok) continue;
    for (const fw of res.fieldWrites || []) {
      if (fw.ok) fieldCounts.set(fw.fieldName, (fieldCounts.get(fw.fieldName) || 0) + 1);
    }
    for (const g of res.groups || []) {
      if (!g.ok) continue;
      const hadFieldWrite = (res.fieldWrites || []).some((fw) => fw.ok && fw.groupId === g.groupId);
      if (!hadFieldWrite) toEntries++;
    }
  }
  const summary: ConfirmSummary = {
    toFields: Array.from(fieldCounts.entries()).map(([fieldName, count]) => ({ fieldName, count })),
    toEntries,
  };

  return { ok: true, confirmedCount, failedIds, results, summary };
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
