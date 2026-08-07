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
 * - `groups.md`      —— 分组元数据台账（group_id / title / 相对路径 / 时间戳 /
 *                        可选模板行 `- 模板: <template_id>@<version>`）
 * - `<group_id>.md`  —— 每个分组自己的内容文件。阶段 B 起支持“双区格式”：
 *                        `## 字段区`（`### <字段名>` 小节 + `- <值> [<来源>]`
 *                        多值行，挖空表单的“坑”）+ `## 流水区`（`§` 分隔追加的
 *                        条目）。旧纯文本文件（无字段区标题）全文按流水区解析，
 *                        首次“写字段”时才升级为双区格式（内容无损）。
 *
 * 范围边界（本期不做，见需求交接文档决策 10/11）：不接入资料库任意文档的选择；
 * 不支持“把 USER.md/MEMORY.md 旧条目后补进组”；不记录“被哪些历史对话引用过”。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userOntologyGroupsDir } from '../paths';
import { writeTextAtomicSync, safeId, nowIso, genId12 } from '../storage';
import { ENTRY_SEPARATOR } from './memory';
import { getRoleTemplate, listRoleTemplates, type RoleTemplate, type PresetGroup } from './role_templates';
import * as search from './search';
import * as kbIndexer from './kb_indexer';
import { createLogger } from '../logger';

const log = createLogger('personal-ontology-groups');

// Same defensive cap contexts.ts applies to every Library file (its
// MAX_FILE_BYTES isn't exported, so this is a local copy of the same value —
// per decision 5, groups get no separate char/entry limit, only this).
const MAX_FILE_BYTES = 200 * 1024 * 1024;

// ── 双区格式常量 ──────────────────────────────────────────────────────────

export const FIELD_ZONE_HEADER = '## 字段区';
export const FLOW_ZONE_HEADER = '## 流水区';

/** 字段值来源：候选（技能预判）/ 手动（用户填写）/ 导入 / 智能（LLM 路由）。
 *  解析缺省/非法值归一化为 `手动`。 */
export const FIELD_VALUE_SOURCES = ['候选', '手动', '导入', '智能'] as const;
export type FieldValueSource = (typeof FIELD_VALUE_SOURCES)[number];

export interface GroupMeta {
  group_id: string;
  title: string;
  /** Relative to `userContextsDir(uid)`, e.g. `.personal_ontology_groups/<id>.md`. */
  rel_path: string;
  created_at: string;
  updated_at: string;
  /** 可选：来源角色模板（installRoleTemplate 写入，`- 模板:` 台账行）。 */
  template_id?: string;
  template_version?: string;
  /** 运行时附加（IPC 层填充，不落盘）：模板显示名（如「学生」），供渲染层做层级展示。 */
  template_name?: string;
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

/** 单条字段值：`- <值> [<来源>]`。 */
export interface FieldValue {
  value: string;
  source: string;
}

/** 组内容文件的结构化视图：字段区（多值）+ 流水区（条目数组）。 */
export interface GroupContent {
  fields: Record<string, FieldValue[]>;
  entries: string[];
}

function groupsMdPath(uid: string): string {
  return path.join(userOntologyGroupsDir(uid), 'groups.md');
}

function groupFileRelPathFromContextsRoot(groupId: string): string {
  return `.personal_ontology_groups/${groupId}.md`;
}

/**
 * 按台账 meta 解析内容文件绝对路径。普通组行 rel_path 恒等于
 * `<groupId>.md`（与 resolveGroupFileAbsPath 一致）；模板文件行
 * （阶段 D）rel_path 是真实文件名（如 `student.md`），与 groupId 无关，
 * 必须按 rel_path 解析——否则读到的是一块不存在的 `<groupId>.md`。
 */
function resolveGroupFileAbsPathFromMeta(uid: string, meta: GroupMeta): string {
  const rel = meta.rel_path || groupFileRelPathFromContextsRoot(meta.group_id);
  const prefix = '.personal_ontology_groups/';
  if (rel.startsWith(prefix) && !rel.includes('..')) {
    return path.join(userOntologyGroupsDir(uid), rel.slice(prefix.length));
  }
  return resolveGroupFileAbsPath(uid, meta.group_id);
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

// ── 双区格式 parse/serialize（纯函数，可导出供测试）────────────────────────

/** 把流水区文本按 ENTRY_SEPARATOR 切成条目数组（逐段 trim、滤空）。 */
export function splitFlowEntries(text: string): string[] {
  return String(text ?? '')
    .split(ENTRY_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 匹配 `- <值> [<来源>]`；值内的 `\[` 转义在此还原为 `[`。
 *  无 `[来源]` 后缀的裸值行也解析（来源默认 `手动`，任务书 §2.1）。 */
export function parseFieldValueLine(line: string): { value: string; source: string } | null {
  if (typeof line !== 'string') return null;
  const withSource = line.match(/^- (.+) \[(\S+)\]$/);
  if (withSource) return { value: withSource[1].replace(/\\\[/g, '['), source: withSource[2] };
  const bare = line.match(/^- (.+)$/);
  if (!bare) return null;
  return { value: bare[1].replace(/\\\[/g, '['), source: '手动' };
}

/** 序列化单条值行：值内 `[` 转义为 `\[`，避免与来源标记冲突。 */
export function serializeFieldValueLine(fv: FieldValue): string {
  return `- ${String(fv.value).replace(/\[/g, '\\[')} [${fv.source}]`;
}

/** 解析字段区文本（`## 字段区` 与 `## 流水区` 之间的部分）为字段表。 */
function parseFieldSections(zoneText: string, fields: Record<string, FieldValue[]>): void {
  const blocks = zoneText.split(/\n(?=###\s+\S)/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0].match(/^###\s+(.+)$/);
    if (!header) continue;
    const fieldName = header[1].trim();
    if (!fieldName) continue;
    const values: FieldValue[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parsed = parseFieldValueLine(lines[i]);
      if (parsed) values.push(parsed);
    }
    if (values.length) fields[fieldName] = values;
  }
}

/**
 * 解析组内容文件。无 `## 字段区` 标题 = 旧纯文本格式，全文按流水区解析
 * （fields 为空，entries 原样）。有双区标题则按字段区/流水区分区解析。
 */
export function parseGroupContent(text: string): GroupContent {
  const fields: Record<string, FieldValue[]> = {};
  const entries: string[] = [];
  const raw = String(text ?? '');

  const fieldIdx = raw.indexOf(FIELD_ZONE_HEADER);
  const flowIdx = raw.indexOf(FLOW_ZONE_HEADER);

  if (fieldIdx === -1) {
    // 旧格式：全文都是流水区
    entries.push(...splitFlowEntries(raw));
    return { fields, entries };
  }

  // 字段区：字段标题行之后到流水区标题（或文件尾）之间
  const fieldZoneStart = fieldIdx + FIELD_ZONE_HEADER.length;
  const fieldZoneEnd = flowIdx === -1 ? raw.length : flowIdx;
  parseFieldSections(raw.slice(fieldZoneStart, fieldZoneEnd), fields);

  // 流水区：流水标题行之后
  if (flowIdx !== -1) {
    entries.push(...splitFlowEntries(raw.slice(flowIdx + FLOW_ZONE_HEADER.length)));
  }
  return { fields, entries };
}

/**
 * 序列化组内容。有字段 → 输出双区格式（`## 字段区` + 字段块 + `---` +
 * `## 流水区` + 条目）；无字段 → 只输出流水条目（纯文本，保持旧行为等价）。
 */
export function serializeGroupContent(content: GroupContent): string {
  const fields = (content && content.fields) || {};
  const entries = (content && content.entries) || [];
  const fieldNames = Object.keys(fields);
  if (!fieldNames.length) {
    return entries.join(ENTRY_SEPARATOR);
  }

  const blocks = fieldNames.map((name) => {
    const lines = [`### ${name}`];
    for (const fv of fields[name] || []) {
      lines.push(serializeFieldValueLine(fv));
    }
    return lines.join('\n');
  });

  const parts: string[] = [FIELD_ZONE_HEADER, '', blocks.join('\n\n')];
  parts.push('', '---', '', FLOW_ZONE_HEADER);
  if (entries.length) parts.push('', entries.join(ENTRY_SEPARATOR));
  return parts.join('\n');
}

function normalizeSource(source: unknown): string {
  const v = String(source ?? '').trim();
  return (FIELD_VALUE_SOURCES as readonly string[]).includes(v) ? v : '手动';
}

export { normalizeSource };

// ── groups.md parse/serialize (人读 markdown 台账，风格同 candidates.md) ──

const GROUP_FIELD_LABELS: Record<string, string> = {
  '标题': 'title',
  '文件': 'rel_path',
  '创建时间': 'created_at',
  '更新时间': 'updated_at',
  '模板': 'template_ref',
};

/** 模板行合法格式：`<template_id>@<semver>`（id 只允许小写字母数字连字符）。 */
const TEMPLATE_REF_RE = /^([a-z0-9-]+)@(\d+\.\d+\.\d+)$/;

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
    const meta: GroupMeta = {
      group_id: groupId,
      title: raw.title || '',
      rel_path: raw.rel_path || groupFileRelPathFromContextsRoot(groupId),
      created_at: raw.created_at || '',
      updated_at: raw.updated_at || raw.created_at || '',
    };
    // 可选模板行：非法值按无模板处理并 log.warn（任务书 §2.2）
    if (raw.template_ref) {
      const tm = raw.template_ref.match(TEMPLATE_REF_RE);
      if (tm) {
        meta.template_id = tm[1];
        meta.template_version = tm[2];
      } else {
        log.warn('invalid template_ref in groups.md ignored', { uid: '', groupId, template_ref: raw.template_ref });
      }
    }
    out.push(meta);
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
    if (g.template_id && g.template_version) {
      lines.push(`- 模板: ${g.template_id}@${g.template_version}`);
    }
    return lines.join('\n');
  });
  return `${header}\n${blocks.join('\n\n')}\n`;
}

function readGroups(uid: string): GroupMeta[] {
  return parseGroupsMarkdown(readTextSafe(groupsMdPath(uid)));
}

export { readGroups };

function writeGroups(uid: string, groups: GroupMeta[]): void {
  writeTextAtomicSync(groupsMdPath(uid), serializeGroupsMarkdown(groups));
}

export { writeGroups };

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

export { notifyGroupUpserted, notifyGroupDeleted };

// ── 共享的“读改写”骨架：字段/流水操作统一走 parse → mutate → serialize → 原子写 ──

type Mutator = (content: GroupContent) => { changed?: boolean; ok?: boolean; error?: string };

async function mutateGroupContent(uid: string, groupId: string, mutator: Mutator): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const groups = readGroups(uid);
  const idx = groups.findIndex((g) => g.group_id === groupId);
  if (idx === -1) return { ok: false, error: 'group not found' };

  let abs: string;
  try { abs = resolveGroupFileAbsPathFromMeta(uid, groups[idx]); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  const content = parseGroupContent(readTextSafe(abs));
  const outcome = mutator(content);
  if (outcome.error || outcome.ok === false) return { ok: false, error: outcome.error || 'failed' };

  const next = serializeGroupContent(content);
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
    const abs = resolveGroupFileAbsPathFromMeta(uid, removed);
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
  const meta = groups.find((g) => g.group_id === groupId);
  if (!meta) return { ok: false, error: 'group not found' };

  let abs: string;
  try { abs = resolveGroupFileAbsPathFromMeta(uid, meta); }
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
  try { abs = resolveGroupFileAbsPathFromMeta(uid, groups[idx]); }
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
 *
 * 阶段 B 起走 parse → push → serialize：旧纯文本文件保持行为等价（纯文本追加，
 * 由既有测试锁定）；已是双区格式的文件在流水区追加，字段区原样保留。
 */
export async function appendToGroup(uid: string, groupId: string, text: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: 'empty content' };

  return mutateGroupContent(uid, groupId, (content) => {
    content.entries.push(trimmed);
    return { changed: true };
  });
}

/**
 * 字段区：往 `### <fieldName>` 小节追加一条 `- <值> [<来源>]`。
 * 完全匹配（同值同来源）去重跳过；多值追加不覆盖。字段小节不存在则创建；
 * 首次写字段会把旧纯文本文件升级为双区格式（内容无损）。
 */
export async function appendFieldValue(
  uid: string,
  groupId: string,
  fieldName: string,
  value: string,
  source: string,
): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = String(fieldName || '').trim();
  const val = String(value ?? '').trim();
  if (!name) return { ok: false, error: 'field name required' };
  if (!val) return { ok: false, error: 'empty value' };
  const src = normalizeSource(source);

  return mutateGroupContent(uid, groupId, (content) => {
    const values = content.fields[name] || (content.fields[name] = []);
    if (values.some((fv) => fv.value === val && fv.source === src)) {
      return { changed: false }; // 完全匹配去重
    }
    values.push({ value: val, source: src });
    return { changed: true };
  });
}

/** 字段区：按值匹配替换那一行（保留原来源标记）。 */
export async function setFieldValue(
  uid: string,
  groupId: string,
  fieldName: string,
  oldValue: string,
  newValue: string,
): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = String(fieldName || '').trim();
  const next = String(newValue ?? '').trim();
  if (!name) return { ok: false, error: 'field name required' };
  if (!next) return { ok: false, error: 'empty value' };

  return mutateGroupContent(uid, groupId, (content) => {
    const values = content.fields[name];
    if (!values) return { ok: false, error: 'field value not found' };
    const idx = values.findIndex((fv) => fv.value === oldValue);
    if (idx === -1) return { ok: false, error: 'field value not found' };
    values[idx] = { ...values[idx], value: next };
    return { changed: true };
  });
}

/** 字段区：删掉匹配该值的行；小节空则整个字段小节删除。值不存在视为 no-op ok。 */
export async function removeFieldValue(
  uid: string,
  groupId: string,
  fieldName: string,
  value: string,
): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = String(fieldName || '').trim();
  if (!name) return { ok: false, error: 'field name required' };

  return mutateGroupContent(uid, groupId, (content) => {
    const values = content.fields[name];
    if (!values) return { ok: true, changed: false };
    const kept = values.filter((fv) => fv.value !== value);
    if (kept.length === values.length) return { ok: true, changed: false };
    if (kept.length) content.fields[name] = kept;
    else delete content.fields[name];
    return { changed: true };
  });
}

/** 字段区：删整个字段小节（含全部值）。字段不存在视为 no-op ok。 */
export async function removeField(uid: string, groupId: string, fieldName: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = String(fieldName || '').trim();
  if (!name) return { ok: false, error: 'field name required' };

  return mutateGroupContent(uid, groupId, (content) => {
    if (!(name in content.fields)) return { ok: true, changed: false };
    delete content.fields[name];
    return { changed: true };
  });
}

/** 流水区：按文本完全匹配删除一条，其余保留。 */
export async function removeEntry(uid: string, groupId: string, entryText: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const target = String(entryText ?? '').trim();
  if (!target) return { ok: false, error: 'empty entry' };

  return mutateGroupContent(uid, groupId, (content) => {
    const idx = content.entries.findIndex((e) => e === target);
    if (idx === -1) return { ok: false, error: 'entry not found' };
    content.entries.splice(idx, 1);
    return { changed: true };
  });
}

/**
 * 流水条目升格为字段值：从流水区移除该条目 + 字段区写入（来源 `手动`）。
 * 该字段小节不存在则创建；已升格过的条目再次升格会因条目不存在而失败（幂等）。
 */
export async function promoteEntryToField(
  uid: string,
  groupId: string,
  entryText: string,
  fieldName: string,
): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const target = String(entryText ?? '').trim();
  const name = String(fieldName || '').trim();
  if (!target) return { ok: false, error: 'empty entry' };
  if (!name) return { ok: false, error: 'field name required' };

  return mutateGroupContent(uid, groupId, (content) => {
    const idx = content.entries.findIndex((e) => e === target);
    if (idx === -1) return { ok: false, error: 'entry not found' };
    content.entries.splice(idx, 1);
    const values = content.fields[name] || (content.fields[name] = []);
    values.push({ value: target, source: '手动' });
    return { changed: true };
  });
}

export interface GroupFieldInfo {
  name: string;
  isRelation?: boolean;
  description?: string;
  values: FieldValue[];
  /** 模板组：字段不在模板 T-box 清单内（用户升格/自建的自定义字段）。 */
  isCustom?: boolean;
}

export interface ListGroupFieldsResult {
  ok: boolean;
  fields?: GroupFieldInfo[];
  error?: string;
}

/** 模板文件元信息行：`> 模板: <template_id>@<semver>`（与 template_files.ts 同源，
 *  这里做轻量识别，避免 groups ↔ template_files 循环依赖）。 */
const TEMPLATE_FILE_META_RE = /^>\s*模板:\s*([a-z0-9-]+)@(\d+\.\d+\.\d+)/m;

/** 模板文件（`## 分节` / `### 字段` 分节式）的轻量字段汇总：跨分节合并所有
 *  `### <字段名>` 小节为字段清单（含空坑与值，文件顺序）。仅提取字段名+值；
 *  isRelation/description 由调用方按模板 T-box 补充。 */
export function collectTemplateFileFields(text: string): GroupFieldInfo[] {
  const out: GroupFieldInfo[] = [];
  const sections = String(text ?? '').split(/^##\s+(.+)$/m);
  for (let i = 1; i < sections.length; i += 2) {
    const body = sections[i + 1] || '';
    const blocks = body.split(/^###\s+(.+)$/m);
    for (let j = 1; j < blocks.length; j += 2) {
      const name = blocks[j].trim();
      if (!name || name === '流水') continue;
      const values: FieldValue[] = [];
      for (const line of blocks[j + 1].split('\n')) {
        const pv = parseFieldValueLine(line);
        if (pv) values.push(pv);
      }
      out.push({ name, values });
    }
  }
  return out;
}

/**
 * 合并模板声明与实例值：模板组返回模板字段清单（含 isRelation/description）
 * + 各组实例值（可能为空坑）；非模板组返回实例字段（无模板声明）。
 * 模板字段按 preset_groups 中该组标题（title）匹配 —— 组改名后匹配不上时
 * 退化为只返回实例字段，不猜测。
 * 模板文件（阶段 D，一模板一文件分节式）优先按模板文件解析：跨分节汇总
 * 所有 `###` 字段小节（含自定义字段），避免双区解析器把分节式文件误当流水。
 */
export async function listGroupFields(uid: string, groupId: string): Promise<ListGroupFieldsResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const groups = readGroups(uid);
  const meta = groups.find((g) => g.group_id === groupId);
  if (!meta) return { ok: false, error: 'group not found' };

  let abs: string;
  try { abs = resolveGroupFileAbsPathFromMeta(uid, meta); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  const fileText = readTextSafe(abs);

  // 模板文件（分节式）→ 跨分节字段汇总（这是模板组的唯一事实来源）
  if (TEMPLATE_FILE_META_RE.test(fileText)) {
    const fields = collectTemplateFileFields(fileText);
    // 标注自定义字段：不在该模板 T-box 清单内的字段（用户升格/自建）
    let tboxNames: Set<string> | null = null;
    if (meta.template_id) {
      const template = getRoleTemplate(meta.template_id);
      if (template) {
        tboxNames = new Set(template.preset_groups.flatMap((p) => p.fields.map((f) => f.name)));
      }
    }
    if (tboxNames !== null) {
      for (const f of fields) f.isCustom = !tboxNames.has(f.name);
    }
    return { ok: true, fields };
  }

  const content = parseGroupContent(fileText);

  // 实例字段（有值的），按文件出现顺序
  const instanceFields = Object.keys(content.fields).map((name) => ({
    name,
    values: content.fields[name],
  }));

  // 模板声明（template_id 命中内置模板 + 组标题命中 preset）
  let templatePreset: PresetGroup | undefined;
  if (meta.template_id) {
    const template = getRoleTemplate(meta.template_id);
    if (template) {
      templatePreset = template.preset_groups.find((p) => p.title === meta.title);
    }
  }

  if (!templatePreset) {
    return { ok: true, fields: instanceFields };
  }

  const merged: GroupFieldInfo[] = templatePreset.fields.map((f) => ({
    name: f.name,
    isRelation: f.isRelation,
    description: f.description,
    values: content.fields[f.name] || [],
  }));
  // 实例里有、模板没声明的字段也补上（用户自建字段）
  for (const inst of instanceFields) {
    if (!templatePreset.fields.some((f) => f.name === inst.name)) {
      merged.push(inst);
    }
  }
  return { ok: true, fields: merged };
}

export interface InstallRoleTemplateResult {
  ok: boolean;
  already_installed?: boolean;
  created?: GroupMeta[];
  /** 与模板名/预设组名同名的现有普通分组（无 template_id）——用户已有同名组，
   *  安装后会出现"模板 vs 普通组"两个同名字样，UI 应提示用户处理。 */
  conflict_groups?: Array<{ group_id: string; title: string }>;
  error?: string;
}

/**
 * 安装角色模板：对每个 preset_group 创建分组，并给这些组写 template_id/
 * template_version 到台账。幂等：已存在同 template_id 的分组 → already_installed。
 * 同名冲突检测：模板名 / 预设组名与现有普通分组（无 template_id）撞名时，
 * 在返回体带 `conflict_groups` 警告（不阻断安装）。
 */
export async function installRoleTemplate(uid: string, templateId: string): Promise<InstallRoleTemplateResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const template = getRoleTemplate(templateId);
  if (!template) return { ok: false, error: 'template not found' };

  const groups = readGroups(uid);
  // 与模板名 / 预设组名同名的普通组（早期手工建的同名组，无模板归属）
  const reservedTitles = new Set([template.name, ...template.preset_groups.map((p) => p.title)]);
  const conflictGroups = groups
    .filter((g) => !g.template_id && reservedTitles.has(g.title))
    .map((g) => ({ group_id: g.group_id, title: g.title }));

  if (groups.some((g) => g.template_id === templateId)) {
    return { ok: true, already_installed: true, conflict_groups: conflictGroups };
  }

  const created: GroupMeta[] = [];
  for (const preset of template.preset_groups) {
    const res = await createGroup(uid, preset.title);
    if (!res.ok || !res.group) {
      return { ok: false, error: `create preset group "${preset.title}" failed: ${res.error || ''}` };
    }
    created.push(res.group);
  }

  // 给新建组补模板标记（重写台账）
  const all = readGroups(uid);
  for (const meta of created) {
    const idx = all.findIndex((g) => g.group_id === meta.group_id);
    if (idx !== -1) {
      all[idx] = { ...all[idx], template_id: templateId, template_version: template.version };
    }
  }
  writeGroups(uid, all);

  log.info('ontology role template installed', { uid, templateId, created: created.length, conflicts: conflictGroups.length });
  return { ok: true, created, conflict_groups: conflictGroups };
}

export interface TemplateGap {
  group_id: string;
  title: string;
  empty_fields: string[];
}

export interface RoleTemplateStatus extends RoleTemplate {
  installed: boolean;
  installed_version?: string;
  gaps: TemplateGap[];
  /** 该模板已安装的分组（group_id + title 映射），渲染层模板卡片展开用。 */
  installed_groups?: Array<{ group_id: string; title: string }>;
}

/**
 * 每个模板的安装状态 + 缺口（模板声明字段在该组无值的字段名列表，读内容判空）。
 * 供渲染层“角色模板”区块展示：未安装 → 安装按钮；已安装 → 缺口清单。
 */
export async function listRoleTemplateStatus(uid: string): Promise<RoleTemplateStatus[]> {
  if (!safeId(uid)) throw new Error('invalid uid');
  const groups = readGroups(uid);

  const out: RoleTemplateStatus[] = [];
  for (const template of listRoleTemplates()) {
    const installedGroups = groups.filter((g) => g.template_id === template.template_id);
    const installed = installedGroups.length > 0;
    const gaps: TemplateGap[] = [];

    if (installed) {
      for (const g of installedGroups) {
        const preset = template.preset_groups.find((p) => p.title === g.title);
        if (!preset) continue;
        let abs: string;
        try { abs = resolveGroupFileAbsPath(uid, g.group_id); } catch { continue; }
        const content = parseGroupContent(readTextSafe(abs));
        const emptyFields = preset.fields
          .filter((f) => !(content.fields[f.name] && content.fields[f.name].length))
          .map((f) => f.name);
        if (emptyFields.length) {
          gaps.push({ group_id: g.group_id, title: g.title, empty_fields: emptyFields });
        }
      }
    }

    out.push({
      ...template,
      installed,
      installed_version: installed ? installedGroups[0].template_version : undefined,
      gaps,
      installed_groups: installed ? installedGroups.map((g) => ({ group_id: g.group_id, title: g.title })) : [],
    });
  }
  return out;
}

// Exposed for the IPC layer / tests that need to resolve a group's absolute
// content path (e.g. to build a chat-use read) without duplicating the
// traversal-safety logic above.
export function resolveGroupContentAbsPathForUser(uid: string, groupId: string): string {
  return resolveGroupFileAbsPath(uid, groupId);
}
