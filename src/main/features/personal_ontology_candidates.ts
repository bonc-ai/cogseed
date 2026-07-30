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
import { createLogger } from '../logger';

const log = createLogger('personal-ontology-candidates');

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
 * 确认一个候选：从候选池移除，真正写入 `features/memory.ts` 管理的
 * USER.md（memory_scope=user）或 MEMORY.md（memory_scope=shared）。
 * 写入失败（比如触发了敏感内容扫描）时候选保留在池里，不会静默丢失。
 */
export async function confirmCandidate(uid: string, candidateId: string): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid) || !candidateId) throw new Error('invalid uid or candidateId');

  const candidates = readCandidates(uid);
  const idx = candidates.findIndex(c => c.candidate_id === candidateId);
  if (idx === -1) {
    log.warn('confirmCandidate: candidate not found', { uid, candidateId });
    return { ok: false, error: 'candidate not found' };
  }

  const candidate = candidates[idx];
  const text = (candidate.memory_text || candidate.summary || '').trim();
  if (!text) return { ok: false, error: 'candidate has no memory text' };

  const target = candidate.memory_scope === 'shared' ? 'memory' : 'user';
  const res = addMemoryEntry(uid, target, text);
  if (!res.ok) {
    log.warn('confirmCandidate: memory write blocked', { uid, candidateId, error: res.error });
    return { ok: false, error: res.error };
  }

  candidates.splice(idx, 1);
  writeCandidates(uid, candidates);
  log.info('candidate confirmed and written to memory', { uid, candidateId, scope: candidate.memory_scope });
  return { ok: true };
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
 * 批量确认。逐条尝试写入记忆；某条写入失败（如触发注入扫描）不影响其余条目，
 * 失败的条目会保留在候选池里，不会静默丢失。
 */
export async function confirmCandidates(uid: string, candidateIds: string[]): Promise<{ ok: boolean; confirmedCount: number; failedIds: string[] }> {
  if (!safeId(uid)) throw new Error('invalid uid');
  if (!Array.isArray(candidateIds) || !candidateIds.length) return { ok: true, confirmedCount: 0, failedIds: [] };

  const candidates = readCandidates(uid);
  const idSet = new Set(candidateIds);
  const remaining: CandidateUpdate[] = [];
  const failedIds: string[] = [];
  let confirmedCount = 0;

  for (const c of candidates) {
    if (!idSet.has(c.candidate_id)) { remaining.push(c); continue; }
    const text = (c.memory_text || c.summary || '').trim();
    const target = c.memory_scope === 'shared' ? 'memory' : 'user';
    const res = text ? addMemoryEntry(uid, target, text) : { ok: false, error: 'empty memory text' };
    if (res.ok) confirmedCount++;
    else { remaining.push(c); failedIds.push(c.candidate_id); }
  }

  writeCandidates(uid, remaining);
  log.info('candidates batch confirmed', { uid, confirmedCount, failed: failedIds.length });
  return { ok: true, confirmedCount, failedIds };
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
