/**
 * Personal Ontology Groups — “记忆分组”存储层。
 *
 * 一个分组 = 一个独立的 markdown 文件，物理存放在 Library 树下的隐藏子目录
 * `<uid>/cloud/contexts/.personal_ontology_groups/`（复用 contexts.ts 的
 * “点前缀 = 隐藏”约定，见 CONTEXTS_IGNORE / hasHiddenContextPathSegment：
 * listContextsTree 和 rebuildIndex 都会跳过点前缀条目，所以这些文件不会出现在
 * 资料库树形浏览器或 `_INDEX.md` 里）。
 *
 * 为什么不复用 contexts.ts 的 writeContextFile / resolveContextFileAbsPath：
 * 那些对外 API 专门拒绝点前缀路径（hasHiddenContextPathSegment），是用来防止
 * 用户越权碰 `.kb/` 的安全闸门。既然本体分组故意要隐藏，就必然会被那道闸门拦下，
 * 所以这里独立抄一份简化版的路径校验 + 原子写入（同样用 writeTextAtomicSync），
 * 不经过 contexts.ts 的对外拦截规则。
 *
 * 安全代价（产品已确认接受，见需求交接文档第二节决策 6）：分组文件仍然物理落在
 * Library 树下，写入时这里会主动调用 `kb_indexer.enqueue` + `search.upsertContext`
 * （跟 contexts.ts 的写入路径一致），所以模型的 kb_search/kb_read 工具理论上能
 * 搜到、读到这些文件的内容，即使这一轮对话没有通过 @ 选中对应分组。这是已知且
 * 接受的行为，本模块不做“排除本体分组文件不被 kb 工具索引”的特殊处理。
 *
 * 数据格式（人读 markdown，风格参照 personal_ontology_candidates.ts）：
 * - `groups.md`      —— 分组元数据台账（group_id / title / 相对路径 / 时间戳）
 * - `<group_id>.md`  —— 每个分组自己的内容文件，纯文本，§ 分隔追加的条目
 *
 * 范围边界（本期不做，见需求交接文档决策 10/11）：不接入资料库任意文档的选择；
 * 不支持“把 USER.md/MEMORY.md 旧条目后补进组”；不记录“被哪些历史对话引用过”。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userOntologyGroupsDir } from '../paths';
import { writeTextAtomicSync, safeId, nowIso, genId12 } from '../storage';
import { ENTRY_SEPARATOR } from './memory';
import * as search from './search';
import * as kbIndexer from './kb_indexer';
import { createLogger } from '../logger';

const log = createLogger('personal-ontology-groups');

// Same defensive cap contexts.ts applies to every Library file (its
// MAX_FILE_BYTES isn't exported, so this is a local copy of the same value —
// per decision 5, groups get no separate char/entry limit, only this).
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export interface GroupMeta {
  group_id: string;
  title: string;
  /** Relative to `userContextsDir(uid)`, e.g. `.personal_ontology_groups/<id>.md`. */
  rel_path: string;
  created_at: string;
  updated_at: string;
}

export interface GroupResult {
  ok: boolean;
  group?: GroupMeta;
  error?: string;
}

export interface SimpleResult {
  ok: boolean;
  error?: string;
}

export interface GroupContentResult {
  ok: boolean;
  content?: string;
  error?: string;
}

function groupsMdPath(uid: string): string {
  return path.join(userOntologyGroupsDir(uid), 'groups.md');
}

function groupFileRelPathFromContextsRoot(groupId: string): string {
  return `.personal_ontology_groups/${groupId}.md`;
}

/**
 * Resolve a group's content-file absolute path with the same traversal
 * safety `contexts.ts::resolvePathForRoot` applies, minus the hidden-path
 * rejection (this whole directory IS the hidden one, by design). `groupId`
 * is always internally generated (`genId12`) and re-validated with `safeId`
 * here as defense in depth — never taken as a free-form user path segment.
 */
function resolveGroupFileAbsPath(uid: string, groupId: string): string {
  if (!safeId(groupId)) throw new Error('invalid group id');
  const root = path.resolve(userOntologyGroupsDir(uid));
  const abs = path.resolve(root, `${groupId}.md`);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path escapes ontology groups root');
  return abs;
}

function readTextSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return ''; }
}

// ── groups.md parse/serialize (人读 markdown 台账，风格同 candidates.md) ──

const GROUP_FIELD_LABELS: Record<string, string> = {
  '标题': 'title',
  '文件': 'rel_path',
  '创建时间': 'created_at',
  '更新时间': 'updated_at',
};

export function parseGroupsMarkdown(text: string): GroupMeta[] {
  const blocks = text.split(/\n(?=###\s+\S)/).map((b) => b.trim()).filter((b) => b.startsWith('### '));
  const out: GroupMeta[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0].match(/^###\s+(\S+)/);
    if (!header) continue;
    const raw: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(/^-\s*([^:：]+)[:：]\s*(.*)$/);
      if (!m) continue;
      const field = GROUP_FIELD_LABELS[m[1].trim()];
      if (field) raw[field] = m[2].trim();
    }
    const groupId = header[1];
    if (!groupId) continue;
    out.push({
      group_id: groupId,
      title: raw.title || '',
      rel_path: raw.rel_path || groupFileRelPathFromContextsRoot(groupId),
      created_at: raw.created_at || '',
      updated_at: raw.updated_at || raw.created_at || '',
    });
  }
  return out;
}

export function serializeGroupsMarkdown(groups: GroupMeta[]): string {
  const header = `# 记忆分组\n\n> 最后更新: ${nowIso()} | 共 ${groups.length} 个分组\n`;
  if (!groups.length) return `${header}\n暂无分组。\n`;
  const blocks = groups.map((g) => {
    const lines = [`### ${g.group_id}`];
    lines.push(`- 标题: ${g.title}`);
    lines.push(`- 文件: ${g.rel_path}`);
    lines.push(`- 创建时间: ${g.created_at}`);
    lines.push(`- 更新时间: ${g.updated_at}`);
    return lines.join('\n');
  });
  return `${header}\n${blocks.join('\n\n')}\n`;
}

function readGroups(uid: string): GroupMeta[] {
  return parseGroupsMarkdown(readTextSafe(groupsMdPath(uid)));
}

function writeGroups(uid: string, groups: GroupMeta[]): void {
  writeTextAtomicSync(groupsMdPath(uid), serializeGroupsMarkdown(groups));
}

// ── kb-index side effects (mirrors contexts.ts's mutation → reindex hooks;
//    see the file header's decision-6 note for why this is intentional) ──

function notifyGroupUpserted(uid: string, relPath: string): void {
  try {
    search.upsertContext(uid, relPath);
    kbIndexer.enqueue(uid, relPath, 'upsert');
  } catch (err) {
    log.warn('kb reindex hook failed on group upsert', { error: (err as Error).message });
  }
}

function notifyGroupDeleted(uid: string, relPath: string): void {
  try {
    search.dropContext(uid, relPath);
    kbIndexer.enqueue(uid, relPath, 'delete');
  } catch (err) {
    log.warn('kb reindex hook failed on group delete', { error: (err as Error).message });
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export async function listGroups(uid: string): Promise<GroupMeta[]> {
  if (!safeId(uid)) throw new Error('invalid uid');
  return readGroups(uid);
}

export async function createGroup(uid: string, title: string): Promise<GroupResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) return { ok: false, error: 'title required' };

  const groups = readGroups(uid);
  const groupId = genId12();
  const relPath = groupFileRelPathFromContextsRoot(groupId);
  const now = nowIso();
  const meta: GroupMeta = { group_id: groupId, title: trimmedTitle, rel_path: relPath, created_at: now, updated_at: now };

  let abs: string;
  try { abs = resolveGroupFileAbsPath(uid, groupId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeTextAtomicSync(abs, '');
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  groups.push(meta);
  writeGroups(uid, groups);
  log.info('ontology group created', { uid, groupId });
  return { ok: true, group: meta };
}

export async function renameGroup(uid: string, groupId: string, newTitle: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const trimmedTitle = String(newTitle || '').trim();
  if (!trimmedTitle) return { ok: false, error: 'title required' };

  const groups = readGroups(uid);
  const idx = groups.findIndex((g) => g.group_id === groupId);
  if (idx === -1) return { ok: false, error: 'group not found' };

  groups[idx] = { ...groups[idx], title: trimmedTitle, updated_at: nowIso() };
  writeGroups(uid, groups);
  return { ok: true };
}

export async function deleteGroup(uid: string, groupId: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const groups = readGroups(uid);
  const idx = groups.findIndex((g) => g.group_id === groupId);
  if (idx === -1) return { ok: false, error: 'group not found' };

  const [removed] = groups.splice(idx, 1);
  writeGroups(uid, groups);

  try {
    const abs = resolveGroupFileAbsPath(uid, groupId);
    fs.rmSync(abs, { force: true });
  } catch (err) {
    log.warn('failed to remove group content file', { uid, groupId, error: (err as Error).message });
  }
  notifyGroupDeleted(uid, removed.rel_path);
  log.info('ontology group deleted', { uid, groupId });
  return { ok: true };
}

export async function readGroupContent(uid: string, groupId: string): Promise<GroupContentResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const groups = readGroups(uid);
  if (!groups.some((g) => g.group_id === groupId)) return { ok: false, error: 'group not found' };

  let abs: string;
  try { abs = resolveGroupFileAbsPath(uid, groupId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  return { ok: true, content: readTextSafe(abs) };
}

/** Whole-file overwrite — used by the group management editor. */
export async function writeGroupContent(uid: string, groupId: string, content: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const groups = readGroups(uid);
  const idx = groups.findIndex((g) => g.group_id === groupId);
  if (idx === -1) return { ok: false, error: 'group not found' };

  const body = typeof content === 'string' ? content : '';
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, error: `file exceeds ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB limit` };
  }

  let abs: string;
  try { abs = resolveGroupFileAbsPath(uid, groupId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeTextAtomicSync(abs, body);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  groups[idx] = { ...groups[idx], updated_at: nowIso() };
  writeGroups(uid, groups);
  notifyGroupUpserted(uid, groups[idx].rel_path);
  return { ok: true };
}

/**
 * Append one entry to a group's content file — used by candidate confirmation
 * (see personal_ontology_candidates.ts). Format mirrors `memory.ts::addEntry`'s
 * `§`-separator convention, but this is NOT char-limited: only the same
 * defensive `MAX_FILE_BYTES` cap every Library file gets (decision 5).
 */
export async function appendToGroup(uid: string, groupId: string, text: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: 'empty content' };

  const groups = readGroups(uid);
  const idx = groups.findIndex((g) => g.group_id === groupId);
  if (idx === -1) return { ok: false, error: 'group not found' };

  let abs: string;
  try { abs = resolveGroupFileAbsPath(uid, groupId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  const existing = readTextSafe(abs).trim();
  const next = existing ? `${existing}${ENTRY_SEPARATOR}${trimmed}` : trimmed;
  const bytes = Buffer.byteLength(next, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, error: `file exceeds ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB limit` };
  }

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeTextAtomicSync(abs, next);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  groups[idx] = { ...groups[idx], updated_at: nowIso() };
  writeGroups(uid, groups);
  notifyGroupUpserted(uid, groups[idx].rel_path);
  return { ok: true };
}

// Exposed for the IPC layer / tests that need to resolve a group's absolute
// content path (e.g. to build a chat-use read) without duplicating the
// traversal-safety logic above.
export function resolveGroupContentAbsPathForUser(uid: string, groupId: string): string {
  return resolveGroupFileAbsPath(uid, groupId);
}
