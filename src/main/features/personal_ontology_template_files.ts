/**
 * Personal Ontology Template Files — 角色模板文件化（阶段 D）。
 *
 * 一个角色模板 = 一个 md 文件（`<template_id>.md`，位于
 * `.personal_ontology_groups/` 目录），文件内 `## 分节`（原 preset_group），
 * 分节内 `### <字段名>` 小节 = 挖空表单的“坑”，字段小节无值行 = 空坑
 * （字段挖空清单与已填值合一）；`### 流水` 小节 = 分节级流水（§ 分隔）。
 *
 * 与普通组双区格式（`## 字段区` / `## 流水区`，personal_ontology_groups.ts）
 * 并存：模板文件以 `> 模板: <id>@<version>` 元信息行作为文件类型标记
 * （isTemplateFileText），读取入口按标记分流解析。
 *
 * 分节寻址：复合 id `<group_id>::<分节名>`（SECTION_REF_SEP）。@ Picker /
 * chat-use 只存/传字符串 id 不感知结构；读取端 splitContentRef 识别 `::`，
 * 模板分节 → 返回分节内容，普通组 → 返回整文件 —— chat-use.js 零改动。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userOntologyGroupsDir } from '../paths';
import { writeTextAtomicSync, safeId, nowIso, genId12 } from '../storage';
import { collectRoleTemplateMemoryEntries, removeRoleTemplateMemoryFromLive, restoreRoleTemplateMemoryEntries } from './memory';
import { getRoleTemplate, listRoleTemplates, type PresetGroup } from './role_templates';
import {
  parseFieldValueLine,
  serializeFieldValueLine,
  splitFlowEntries,
  normalizeSource,
  readGroups,
  writeGroups,
  notifyGroupUpserted,
  notifyGroupDeleted,
  appendFieldValue,
  appendToGroup,
  promoteEntryToField,
  setFieldValue,
  removeFieldValue,
  removeField,
  removeEntry,
  listGroupFields,
  readGroupContent,
  parseGroupContent,
  resolveGroupContentAbsPathForUser,
  type FieldValue,
  type GroupMeta,
  type GroupFieldInfo,
} from './personal_ontology_groups';
import { createLogger } from '../logger';
import { registerDeferred } from '../util/boot_init';
import { fileEditLock } from '../util/locks';
import { getActiveUserId, hasActiveUser } from './users';

export { readGroups };

const log = createLogger('personal-ontology-template-files');

const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** 角色模板安装上限：每人最多 3 个（产品规则，防去向面板/空间选择过载）。 */
export const MAX_INSTALLED_TEMPLATES = 3;

/** 复合 id 分隔符：`<group_id>::<分节名>`。普通组 id 不含此分隔符。 */
export const SECTION_REF_SEP = '::';

/** 模板元信息行：`> 模板: <template_id>@<semver> | 已安装: <ISO>`（版本支持 semver 预发布后缀） */
const TEMPLATE_META_RE = /^>\s*模板:\s*([a-z0-9_-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s*\|\s*已安装:\s*(.+))?$/;

// ── 纯函数：模板文件 parse / serialize ─────────────────────────────────────

export interface TemplateSection {
  /** 分节名（原 preset_group title，如「课程」）。 */
  title: string;
  /** 字段小节（文件出现顺序；空坑 = key 存在但值为空数组）。 */
  fields: Record<string, FieldValue[]>;
  /** 分节级流水条目。 */
  flowEntries: string[];
}

export interface TemplateFileContent {
  /** 文件标题（`# <title>（模板）`）。 */
  title: string;
  template_id: string;
  version: string;
  installed_at: string;
  sections: TemplateSection[];
}

/** 文件是否携带 `> 模板:` 元信息行（= 模板文件，按分节式解析）。 */
export function isTemplateFileText(text: string): boolean {
  if (typeof text !== 'string') return false;
  return text.split('\n').some((line) => TEMPLATE_META_RE.test(line.trim()));
}

/** 按标题行切块：`^<prefix>\s+(.+)$` 多行模式，返回 {title, body} 序列。 */
function splitByHeading(text: string, prefix: '##' | '###'): Array<{ title: string; body: string }> {
  const parts = text.split(new RegExp(`^${prefix}\\s+(.+)$`, 'm'));
  const out: Array<{ title: string; body: string }> = [];
  for (let i = 1; i < parts.length; i += 2) {
    out.push({ title: parts[i].trim(), body: parts[i + 1] || '' });
  }
  return out;
}

function parseSection(body: string): TemplateSection | null {
  const blocks = splitByHeading(body, '###');
  if (!blocks.length) return null;
  const fields: Record<string, FieldValue[]> = {};
  const flowEntries: string[] = [];
  for (const block of blocks) {
    if (block.title === '流水') {
      flowEntries.push(...splitFlowEntries(block.body));
      continue;
    }
    const values: FieldValue[] = [];
    for (const line of block.body.split('\n')) {
      const pv = parseFieldValueLine(line);
      if (pv) values.push(pv);
    }
    fields[block.title] = values; // 空坑 = 无值行 → []
  }
  return { title: '', fields, flowEntries };
}

/**
 * 解析模板文件。标题/元信息行从全文提取；`## 分节` 按文件顺序解析。
 * 字段小节无值行 = 空坑（fields[name] = []，key 存在）。
 */
export function parseTemplateContent(text: string): TemplateFileContent {
  const raw = String(text ?? '');
  let title = '';
  let template_id = '';
  let version = '';
  let installed_at = '';
  for (const line of raw.split('\n')) {
    const h = line.match(/^#\s+(.+?)\s*（模板）\s*$/);
    if (h && !title) {
      title = h[1].trim();
      continue;
    }
    const m = line.match(TEMPLATE_META_RE);
    if (m) {
      template_id = m[1];
      version = m[2];
      installed_at = (m[3] || '').trim();
      break;
    }
  }

  const sections: TemplateSection[] = [];
  const sectionBlocks = splitByHeading(raw, '##');
  for (const block of sectionBlocks) {
    const sec = parseSection(block.body);
    if (sec) {
      sec.title = block.title;
      sections.push(sec);
    }
  }

  return { title, template_id, version, installed_at, sections };
}

export function serializeSection(sec: TemplateSection): string {
  const parts: string[] = [`## ${sec.title}`];
  for (const name of Object.keys(sec.fields)) {
    const values = sec.fields[name] || [];
    const block = [`### ${name}`];
    for (const fv of values) block.push(serializeFieldValueLine(fv));
    parts.push(block.join('\n'));
  }
  const flowBlock = ['### 流水'];
  if (sec.flowEntries.length) flowBlock.push('', sec.flowEntries.join('\n§\n'));
  parts.push(flowBlock.join('\n'));
  return parts.join('\n\n');
}

/** 序列化模板文件：标题 + 元信息 + 分节（含全部空坑小节）。 */
export function serializeTemplateContent(content: TemplateFileContent): string {
  const head = [
    `# ${content.title}（模板）`,
    `> 模板: ${content.template_id}@${content.version}${content.installed_at ? ` | 已安装: ${content.installed_at}` : ''}`,
  ];
  const body = content.sections.map(serializeSection);
  return [...head, ...body].join('\n\n') + '\n';
}

// ── 分节寻址：复合 id ──────────────────────────────────────────────────────

/** 构造复合 id：`<groupId>::<分节名>`。 */
export function buildContentRef(groupId: string, section: string): string {
  return `${groupId}${SECTION_REF_SEP}${section}`;
}

/** 拆分复合 id。普通组 id（无 `::`）→ section = null。 */
export function splitContentRef(ref: string): { groupId: string; section: string | null } {
  const s = String(ref ?? '');
  const idx = s.indexOf(SECTION_REF_SEP);
  if (idx === -1) return { groupId: s, section: null };
  return { groupId: s.slice(0, idx), section: s.slice(idx + SECTION_REF_SEP.length) };
}

/** 模板文件绝对路径（文件名 = `<template_id>.md`）。 */
export function templateFileAbsPath(uid: string, templateId: string): string {
  return path.join(userOntologyGroupsDir(uid), `${templateId}.md`);
}

/** 读取模板文件内容；文件不存在 → 空字符串。 */
export function readTemplateFileText(uid: string, templateId: string): string {
  try {
    return fs.readFileSync(templateFileAbsPath(uid, templateId), 'utf8');
  } catch {
    return '';
  }
}

// ── 安装 ────────────────────────────────────────────────────────────────────

export interface InstallTemplateFileResult {
  ok: boolean;
  already_installed?: boolean;
  created?: GroupMeta[];
  conflict_groups?: Array<{ group_id: string; title: string }>;
  /** 重装时是否从归档恢复了旧数据（有旧数据 → true）。 */
  restored_from_archive?: boolean;
  /** 随模板恢复的全局记忆条目数。 */
  restored_memory_count?: number;
  error?: string;
}

/**
 * 安装角色模板：生成单个 `<template_id>.md`（全部分节 + 字段空坑落盘）+ 台账
 * 一行（title = 模板名，rel_path = 模板文件）。幂等：同 template_id 已装 →
 * already_installed（不覆盖文件）。与普通组同名 → conflict_groups 警告。
 * `restoreData`：重装时若归档目录有旧文件 → 恢复旧数据（字段值/流水保留），
 * 否则新建空模板。卸载走 uninstallTemplateFile（归档保留）。
 */
export async function installTemplateFile(
  uid: string,
  templateId: string,
  restoreData = false,
): Promise<InstallTemplateFileResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const template = getRoleTemplate(templateId);
  if (!template) return { ok: false, error: 'template not found' };

  const groups = readGroups(uid);
  const reservedTitles = new Set([template.name, ...template.preset_groups.map((p) => p.title)]);
  const conflictGroups = groups
    .filter((g) => !g.template_id && reservedTitles.has(g.title))
    .map((g) => ({ group_id: g.group_id, title: g.title }));

  if (groups.some((g) => g.template_id === templateId)) {
    return { ok: true, already_installed: true, conflict_groups: conflictGroups };
  }

  // 角色模板上限：每人最多安装 3 个（产品规则，防去向面板/空间选择过载）。
  const installedCount = groups.filter((g) => g.template_id).length;
  if (installedCount >= MAX_INSTALLED_TEMPLATES) {
    return { ok: false, error: 'template_limit_reached', conflict_groups: conflictGroups };
  }

  const abs = templateFileAbsPath(uid, templateId);
  let restored_from_archive = false;
  let restored_memory_count = 0;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (restoreData) {
      const archived = readTemplateArchive(uid, templateId);
      if (archived != null) {
        writeTextAtomicSync(abs, archived); // 恢复旧数据（字段值/流水原样）
        restored_from_archive = true;
      }
    }
    if (!restored_from_archive) {
      const content: TemplateFileContent = {
        title: template.name,
        template_id: templateId,
        version: template.version,
        installed_at: nowIso(),
        sections: template.preset_groups.map((p) => ({
          title: p.title,
          fields: Object.fromEntries(p.fields.map((f) => [f.name, [] as FieldValue[]])),
          flowEntries: [],
        })),
      };
      writeTextAtomicSync(abs, serializeTemplateContent(content));
    }
    // 恢复随模板归档的全局记忆（.memory.md）—— 按实际成功数上报（B-3：空间满时
    // 部分恢复失败，不能按归档长度谎报）。
    if (restoreData) {
      const memArchived = readTemplateMemoryArchive(uid, templateId);
      if (memArchived) {
        restored_memory_count = restoreRoleTemplateMemoryEntries(uid, templateId, memArchived);
      }
    }
    // 恢复成功后清理该模板的归档（数据已回活；B-2：避免旧归档残留/隐私驻留）
    if (restored_from_archive || restored_memory_count > 0) {
      clearTemplateArchives(uid, templateId);
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const now = nowIso();
  const relPath = `.personal_ontology_groups/${templateId}.md`;
  const meta: GroupMeta = {
    group_id: genId12(),
    title: template.name,
    rel_path: relPath,
    created_at: now,
    updated_at: now,
    template_id: templateId,
    template_version: template.version,
  };
  groups.push(meta);
  writeGroups(uid, groups);
  notifyGroupUpserted(uid, relPath);
  log.info('ontology template file installed', { uid, templateId, restored_from_archive, restored_memory_count });
  return { ok: true, created: [meta], conflict_groups: conflictGroups, restored_from_archive, restored_memory_count };
}

// ── 卸载 / 归档 ─────────────────────────────────────────────────────────────

export interface UninstallTemplateFileResult {
  ok: boolean;
  error?: string;
  /** 归档目录绝对路径（数据保留位置，UI 展示给用户）。 */
  archive_dir?: string;
  /** 随模板一起归档的全局记忆条目数。 */
  archived_memory_count?: number;
}

/** 模板文件归档目录：`.personal_ontology_groups/_backup_<ts>/`（与既有备份先例同构）。 */
export function templateArchiveDir(uid: string): string {
  return path.join(userOntologyGroupsDir(uid), `_backup_${Date.now()}`);
}

/**
 * 卸载角色模板：把 `<template_id>.md` 整体移到归档目录（**数据保留**，可重装
 * 恢复），并从台账移除该组。`archiveMemory` 时，该角色来源的全局记忆条目
 * （USER.md/MEMORY.md 中带 role_template 标签的）一并归档到
 * `<template_id>.memory.md` 并从全局记忆移除。幂等：模板未安装 → ok（无操作）。
 */
export async function uninstallTemplateFile(
  uid: string,
  templateId: string,
  archiveMemory = false,
): Promise<UninstallTemplateFileResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const groups = readGroups(uid);
  const row = groups.find((g) => g.template_id === templateId);
  if (!row) return { ok: true }; // 未安装 → 无操作

  const abs = templateFileAbsPath(uid, templateId);
  let archive_dir: string | undefined;
  let archived_memory_count = 0;
  try {
    if (fs.existsSync(abs) || archiveMemory) {
      archive_dir = templateArchiveDir(uid);
      fs.mkdirSync(archive_dir, { recursive: true });
      if (fs.existsSync(abs)) {
        fs.renameSync(abs, path.join(archive_dir, `${templateId}.md`));
      }
      if (archiveMemory) {
        // 顺序保证（防崩溃窗口数据丢失）：先收集 → 先写归档文件 → 再删活数据。
        // 若在"归档已写、活数据未删"之间崩溃 → 重试安全（重装恢复可去重）；
        // 若反过来（先删后写）崩溃 → 数据永久丢失。
        const texts = collectRoleTemplateMemoryEntries(uid, templateId);
        const all = [...(texts.user || []), ...(texts.memory || [])];
        if (all.length) {
          // B-4 分层：user/memory 分区头，恢复时按原层级还原（不再全部降级为 user）
          const parts: string[] = [];
          if (texts.user.length) parts.push(`# user\n${texts.user.join('\n§\n')}`);
          if (texts.memory.length) parts.push(`# memory\n${texts.memory.join('\n§\n')}`);
          writeTextAtomicSync(path.join(archive_dir, `${templateId}.memory.md`), parts.join('\n\n'));
          const removed = removeRoleTemplateMemoryFromLive(uid, templateId);
          if (!removed.userOk || !removed.memoryOk) {
            log.warn('uninstall: global-memory removal failed after archive write', { uid, templateId, removed });
            // 归档已写，活数据可能残留 —— 不视为失败（数据双份可恢复），但记录
          }
          archived_memory_count = all.length;
        }
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  writeGroups(uid, groups.filter((g) => g.group_id !== row.group_id));
  log.info('ontology template file uninstalled (archived)', {
    uid, templateId,
    // 归档路径脱敏：只记相对名（_backup_<ts>），不落绝对路径（含 uid 数据根）
    archive_base: archive_dir ? path.basename(archive_dir) : undefined,
    archived_memory_count,
  });
  return { ok: true, archive_dir, archived_memory_count };
}

/** 归档目录里是否还有该模板的旧数据（重装时决定是否提供「恢复原数据」选项）。 */
export function templateHasArchive(uid: string, templateId: string): boolean {
  return listArchiveDirs(uid).some((dir) => fs.existsSync(path.join(dir, `${templateId}.md`)));
}

/** 全部 `_backup_<ts>` 归档目录（绝对路径），按时间戳**从新到旧**排序。 */
function listArchiveDirs(uid: string): string[] {
  try {
    const base = userOntologyGroupsDir(uid);
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^_backup_\d+$/.test(entry.name))
      .map((entry) => path.join(base, entry.name))
      .sort((a, b) => {
        const ta = Number(path.basename(a).replace('_backup_', ''));
        const tb = Number(path.basename(b).replace('_backup_', ''));
        return tb - ta; // 新的在前
      });
  } catch {
    return [];
  }
}

/** 从归档目录读回模板旧数据；无归档 → null。按时间戳取最新一份。 */
export function readTemplateArchive(uid: string, templateId: string): string | null {
  for (const dir of listArchiveDirs(uid)) {
    const p = path.join(dir, `${templateId}.md`);
    if (fs.existsSync(p)) {
      try { return fs.readFileSync(p, 'utf8'); } catch { /* 继续找下一份 */ }
    }
  }
  return null;
}

/**
 * 从归档目录读回该模板随附的全局记忆归档（`.memory.md`）。
 * 格式（B-4 起）：`# user` / `# memory` 分区头 + § 分隔正文；旧格式（无分区头）
 * 全部按 user 处理（候选确认时 user 级是默认去向）。无归档 → null。
 */
export function readTemplateMemoryArchive(
  uid: string,
  templateId: string,
): { user: string[]; memory: string[] } | null {
  for (const dir of listArchiveDirs(uid)) {
    const p = path.join(dir, `${templateId}.memory.md`);
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8').trim();
        if (!raw) return { user: [], memory: [] };
        const user: string[] = [];
        const memory: string[] = [];
        let current: string[] | null = null;
        for (const line of raw.split(/\r?\n/)) {
          if (line.trim() === '# user') { current = user; continue; }
          if (line.trim() === '# memory') { current = memory; continue; }
          if (current === null) current = user; // 旧格式：无分区头 → user
          current.push(line);
        }
        const split = (arr: string[]) => arr.join('\n').split(/\n?§\n?/).map((s) => s.trim()).filter(Boolean);
        return { user: split(user), memory: split(memory) };
      } catch { /* 继续找下一份 */ }
    }
  }
  return null;
}

/** 归档目录里是否还有该模板的全局记忆归档（决定重装时是否提示恢复记忆）。 */
export function templateHasMemoryArchive(uid: string, templateId: string): boolean {
  return listArchiveDirs(uid).some((dir) => fs.existsSync(path.join(dir, `${templateId}.memory.md`)));
}

/** 重装恢复成功后清理该模板的所有归档（数据已回活，避免旧归档残留/隐私驻留）。 */
export function clearTemplateArchives(uid: string, templateId: string): void {
  for (const dir of listArchiveDirs(uid)) {
    for (const name of [`${templateId}.md`, `${templateId}.memory.md`]) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* 忽略 */ }
    }
  }
}

// ── 模板文件"读改写"骨架（与 groups.ts 的 mutateGroupContent 对应）──────────

type TemplateMutator = (content: TemplateFileContent) => { changed?: boolean; ok?: boolean; error?: string };

/** 台账里按 group_id 找模板文件元信息（含 template_id / rel_path）。 */
function findTemplateMeta(uid: string, groupId: string): GroupMeta | undefined {
  const meta = readGroups(uid).find((g) => g.group_id === groupId);
  return meta && meta.template_id ? meta : undefined;
}

async function mutateTemplateFile(
  uid: string,
  groupId: string,
  templateId: string,
  mutator: TemplateMutator,
): Promise<{ ok: boolean; error?: string }> {
  const abs = templateFileAbsPath(uid, templateId);
  return fileEditLock(abs).runExclusive(async () => {
    const content = parseTemplateContent(readTemplateFileText(uid, templateId));
    const outcome = mutator(content);
    if (outcome.error || outcome.ok === false) return { ok: false, error: outcome.error || 'failed' };

    const next = serializeTemplateContent(content);
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

    const groups = readGroups(uid);
    const idx = groups.findIndex((g) => g.group_id === groupId);
    if (idx !== -1) {
      groups[idx] = { ...groups[idx], updated_at: nowIso() };
      writeGroups(uid, groups);
    }
    notifyGroupUpserted(uid, `.personal_ontology_groups/${templateId}.md`);
    return { ok: true };
  });
}

/** 定位模板文件里的分节；不存在 → null。 */
function findSection(content: TemplateFileContent, section: string): TemplateSection | undefined {
  return content.sections.find((s) => s.title === section);
}

// ── 复合 id 统一入口：读取 ─────────────────────────────────────────────────

export interface ReadContentByIdResult {
  ok: boolean;
  content?: string;
  section?: string | null;
  error?: string;
}

/**
 * 按 id（普通组 id 或复合 id `groupId::分节`）读取内容。
 * 模板分节 → 返回该分节的 markdown（含 `## 分节` 标题，供 @ Picker 注入）；
 * 普通组 → 整文件（现状，chat-use 兼容）。
 */
export async function readContentById(uid: string, ref: string): Promise<ReadContentByIdResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const { groupId, section } = splitContentRef(ref);
  if (!section) return readGroupContent(uid, groupId);

  const meta = findTemplateMeta(uid, groupId);
  if (!meta) return { ok: false, error: 'template group not found' };
  const content = parseTemplateContent(readTemplateFileText(uid, meta.template_id));
  const sec = findSection(content, section);
  if (!sec) return { ok: false, error: 'section not found' };
  return { ok: true, content: serializeSection(sec), section };
}

// ── 复合 id 统一入口：写入 ─────────────────────────────────────────────────

/**
 * 字段写入：复合 id → 模板分节字段（多值追加 + 同值同源同项目去重，空坑变有值）；
 * 普通组 id → 转发 appendFieldValue（双区格式，行为不变）。`project`（可选）=
 * 来源项目 id，落盘 `@proj:<pid>`。
 */
export async function appendFieldValueToRef(
  uid: string,
  ref: string,
  fieldName: string,
  value: string,
  source: string,
  project?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const { groupId, section } = splitContentRef(ref);
  if (!section) return appendFieldValue(uid, groupId, fieldName, value, source, project);

  const name = String(fieldName || '').trim();
  const val = String(value ?? '').trim();
  if (!name) return { ok: false, error: 'field name required' };
  if (!val) return { ok: false, error: 'empty value' };
  const src = normalizeSource(source);
  const proj = project ? String(project).trim() : undefined;

  const meta = findTemplateMeta(uid, groupId);
  if (!meta) return { ok: false, error: 'template group not found' };

  return mutateTemplateFile(uid, groupId, meta.template_id, (content) => {
    const sec = findSection(content, section);
    if (!sec) return { ok: false, error: 'section not found' };
    const values = sec.fields[name] || (sec.fields[name] = []);
    if (values.some((fv) => fv.value === val && fv.source === src && (fv.project ?? undefined) === proj)) {
      return { changed: false }; // 同值同源同项目去重
    }
    values.push({ value: val, source: src, ...(proj ? { project: proj } : {}) });
    return { changed: true };
  });
}

/**
 * Automatic profile projection may only append to a field declared by the
 * installed built-in role template and still present in the template file.
 * Unlike appendFieldValueToRef, this never creates a field and never falls
 * back to a free-form group.
 */
export async function appendExistingTemplateFieldValueToRef(
  uid: string,
  ref: string,
  fieldName: string,
  value: string,
  source: string,
  project?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const { groupId, section } = splitContentRef(ref);
  if (!section) return { ok: false, error: 'template section ref required' };

  const name = String(fieldName || '').trim();
  const val = String(value ?? '').trim();
  if (!name) return { ok: false, error: 'field name required' };
  if (!val) return { ok: false, error: 'empty value' };
  const src = normalizeSource(source);
  const proj = project ? String(project).trim() : undefined;

  const meta = findTemplateMeta(uid, groupId);
  if (!meta) return { ok: false, error: 'template group not found' };
  const template = getRoleTemplate(meta.template_id);
  const declared = template?.preset_groups.some((preset) =>
    preset.title === section && preset.fields.some((field) => field.name === name),
  );
  if (!declared) return { ok: false, error: 'field is not declared by the role template' };

  return mutateTemplateFile(uid, groupId, meta.template_id, (content) => {
    const sec = findSection(content, section);
    if (!sec) return { ok: false, error: 'section not found' };
    if (!Object.prototype.hasOwnProperty.call(sec.fields, name)) {
      return { ok: false, error: 'field not found' };
    }
    const values = sec.fields[name];
    if (values.some((fv) => fv.value === val && fv.source === src && (fv.project ?? undefined) === proj)) {
      return { changed: false };
    }
    values.push({ value: val, source: src, ...(proj ? { project: proj } : {}) });
    return { changed: true };
  });
}

/** 流水追加：复合 id → 分节流水；普通组 id → 转发 appendToGroup。 */
export async function appendFlowEntryToRef(
  uid: string,
  ref: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: 'empty content' };

  const { groupId, section } = splitContentRef(ref);
  if (!section) return appendToGroup(uid, groupId, trimmed);

  const meta = findTemplateMeta(uid, groupId);
  if (!meta) return { ok: false, error: 'template group not found' };

  return mutateTemplateFile(uid, groupId, meta.template_id, (content) => {
    const sec = findSection(content, section);
    if (!sec) return { ok: false, error: 'section not found' };
    sec.flowEntries.push(trimmed);
    return { changed: true };
  });
}

/** 流水升格：复合 id → 同分节流水条目升格为该分节字段（来源 `手动`）。
 *  升格允许创建模板 T-box 之外的自定义字段（用户手动建坑回填的设计）；
 *  返回 `isCustom` 标记供 UI 提示「将创建/已创建自定义字段」。 */
export async function promoteEntryToRef(
  uid: string,
  ref: string,
  entryText: string,
  fieldName: string,
): Promise<{ ok: boolean; error?: string; isCustom?: boolean }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const target = String(entryText ?? '').trim();
  const name = String(fieldName || '').trim();
  if (!target) return { ok: false, error: 'empty entry' };
  if (!name) return { ok: false, error: 'field name required' };

  const { groupId, section } = splitContentRef(ref);
  if (!section) {
    const res = await promoteEntryToField(uid, groupId, target, name);
    if (!res.ok) return res;
    // 普通组：无模板 T-box 概念，一律按自定义处理（组实例字段本就自由）
    return { ok: true, isCustom: true };
  }

  const meta = findTemplateMeta(uid, groupId);
  if (!meta) return { ok: false, error: 'template group not found' };

  // 预判 isCustom：字段名不在该模板 T-box 清单内 → 自定义字段
  let isCustom = true;
  const template = getRoleTemplate(meta.template_id);
  if (template) {
    const tboxNames = new Set(template.preset_groups.flatMap((p) => p.fields.map((f) => f.name)));
    isCustom = !tboxNames.has(name);
  }

  const outcome = await mutateTemplateFile(uid, groupId, meta.template_id, (content) => {
    const sec = findSection(content, section);
    if (!sec) return { ok: false, error: 'section not found' };
    const idx = sec.flowEntries.findIndex((e) => e === target);
    if (idx === -1) return { ok: false, error: 'entry not found' };
    sec.flowEntries.splice(idx, 1);
    const values = sec.fields[name] || (sec.fields[name] = []);
    values.push({ value: target, source: '手动' });
    return { changed: true };
  });
  return { ...outcome, ...(outcome.ok ? { isCustom } : {}) };
}

/** 字段值替换：复合 id → 分节字段按值匹配替换（保留来源标记）；普通组转发。 */
export async function setFieldValueToRef(
  uid: string,
  ref: string,
  fieldName: string,
  oldValue: string,
  newValue: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = String(fieldName || '').trim();
  const next = String(newValue ?? '').trim();
  if (!name) return { ok: false, error: 'field name required' };
  if (!next) return { ok: false, error: 'empty value' };

  const { groupId, section } = splitContentRef(ref);
  if (!section) return setFieldValue(uid, groupId, name, String(oldValue ?? ''), next);

  const meta = findTemplateMeta(uid, groupId);
  if (!meta) return { ok: false, error: 'template group not found' };

  return mutateTemplateFile(uid, groupId, meta.template_id, (content) => {
    const sec = findSection(content, section);
    if (!sec) return { ok: false, error: 'section not found' };
    const values = sec.fields[name];
    if (!values) return { ok: false, error: 'field value not found' };
    const idx = values.findIndex((fv) => fv.value === oldValue);
    if (idx === -1) return { ok: false, error: 'field value not found' };
    values[idx] = { ...values[idx], value: next };
    return { changed: true };
  });
}

/** 删值行：复合 id → 分节字段删值后小节保留为空坑（模板字段=挖空清单，不因删值消失）；普通组转发。 */
export async function removeFieldValueToRef(
  uid: string,
  ref: string,
  fieldName: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = String(fieldName || '').trim();
  if (!name) return { ok: false, error: 'field name required' };

  const { groupId, section } = splitContentRef(ref);
  if (!section) return removeFieldValue(uid, groupId, name, String(value ?? ''));

  const meta = findTemplateMeta(uid, groupId);
  if (!meta) return { ok: false, error: 'template group not found' };

  return mutateTemplateFile(uid, groupId, meta.template_id, (content) => {
    const sec = findSection(content, section);
    if (!sec) return { ok: false, error: 'section not found' };
    const values = sec.fields[name];
    if (!values) return { ok: true, changed: false };
    const kept = values.filter((fv) => fv.value !== value);
    if (kept.length === values.length) return { ok: true, changed: false };
    sec.fields[name] = kept; // 空坑保留（小节不删）
    return { changed: true };
  });
}

/** 删字段小节：复合 id → 分节移除该字段（坑消失）；普通组转发。 */
export async function removeFieldToRef(
  uid: string,
  ref: string,
  fieldName: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = String(fieldName || '').trim();
  if (!name) return { ok: false, error: 'field name required' };

  const { groupId, section } = splitContentRef(ref);
  if (!section) return removeField(uid, groupId, name);

  const meta = findTemplateMeta(uid, groupId);
  if (!meta) return { ok: false, error: 'template group not found' };

  return mutateTemplateFile(uid, groupId, meta.template_id, (content) => {
    const sec = findSection(content, section);
    if (!sec) return { ok: false, error: 'section not found' };
    if (!(name in sec.fields)) return { ok: true, changed: false };
    delete sec.fields[name];
    return { changed: true };
  });
}

/** 删流水条目：复合 id → 分节流水移除；普通组转发。 */
export async function removeEntryToRef(
  uid: string,
  ref: string,
  entryText: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const target = String(entryText ?? '').trim();
  if (!target) return { ok: false, error: 'empty entry' };

  const { groupId, section } = splitContentRef(ref);
  if (!section) return removeEntry(uid, groupId, target);

  const meta = findTemplateMeta(uid, groupId);
  if (!meta) return { ok: false, error: 'template group not found' };

  return mutateTemplateFile(uid, groupId, meta.template_id, (content) => {
    const sec = findSection(content, section);
    if (!sec) return { ok: false, error: 'section not found' };
    const idx = sec.flowEntries.findIndex((e) => e === target);
    if (idx === -1) return { ok: false, error: 'entry not found' };
    sec.flowEntries.splice(idx, 1);
    return { changed: true };
  });
}

// ── 复合 id 统一入口：字段清单（候选确认预检查用）──────────────────────────

export interface TemplateCatalogSection {
  title: string;
  fields: string[];
}

export interface TemplateCatalogEntry {
  /** 台账行 group_id（复合 id 的基座）。 */
  group_id: string;
  template_id: string;
  name: string;
  version: string;
  sections: TemplateCatalogSection[];
}

/**
 * 已安装模板文件的分节字段清单（LLM 路由 catalog 用）。只返回已安装模板
 * （台账有模板文件行）；分节/字段从文件内容解析（文件是唯一事实来源：
 * 含空坑、自定义字段）。普通组不参与。
 */
export async function listTemplateFileCatalog(uid: string): Promise<TemplateCatalogEntry[]> {
  if (!safeId(uid)) return [];
  const out: TemplateCatalogEntry[] = [];
  for (const meta of readGroups(uid)) {
    if (!meta.template_id) continue;
    const text = readTemplateFileText(uid, meta.template_id);
    if (!text) continue;
    const content = parseTemplateContent(text);
    out.push({
      group_id: meta.group_id,
      template_id: content.template_id || meta.template_id,
      name: content.title || meta.title,
      version: content.version || meta.template_version || '',
      sections: content.sections.map((s) => ({ title: s.title, fields: Object.keys(s.fields) })),
    });
  }
  return out;
}

export interface ListFieldsByRefResult {
  ok: boolean;
  fields?: GroupFieldInfo[];
  error?: string;
}

/**
 * 字段清单：复合 id → 分节字段（含空坑，文件顺序，模板文件是唯一事实来源）；
 * 普通组 id → 转发 listGroupFields（双区实例字段）。
 */
export async function listFieldsByRef(uid: string, ref: string): Promise<ListFieldsByRefResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const { groupId, section } = splitContentRef(ref);
  if (!section) return listGroupFields(uid, groupId);

  const meta = findTemplateMeta(uid, groupId);
  if (!meta) return { ok: false, error: 'template group not found' };
  const content = parseTemplateContent(readTemplateFileText(uid, meta.template_id));
  const sec = findSection(content, section);
  if (!sec) return { ok: false, error: 'section not found' };
  // 自定义字段标记：不在该模板 T-box 清单内的字段（用户升格/自建）
  let tboxNames: Set<string> | null = null;
  const template = getRoleTemplate(meta.template_id);
  if (template) {
    tboxNames = new Set(template.preset_groups.flatMap((p) => p.fields.map((f) => f.name)));
  }
  const fields: GroupFieldInfo[] = Object.keys(sec.fields).map((name) => ({
    name,
    values: sec.fields[name] || [],
    ...(tboxNames !== null ? { isCustom: !tboxNames.has(name) } : {}),
  }));
  return { ok: true, fields };
}

// ── 旧式模板组 → 模板文件 迁移（启动时幂等）────────────────────────────────

export interface MigrateLegacyResult {
  ok: boolean;
  /** 迁移的 template_id 数。 */
  migrated: number;
  /** 移入备份目录的旧组文件数。 */
  groups_moved: number;
  error?: string;
}

/**
 * 旧式模板组（阶段 B/C：一个模板 = 多个 UUID 组文件，台账行带 template_id）
 * 合并为单个模板文件。合并规则：
 * - 分节 = 种子 preset_groups（空坑全量）；旧组按 title 匹配分节，字段值
 *   （含来源）与流水条目并入（去重）；
 * - 旧组里种子没有的自定义字段 → 追加为该分节新字段小节；
 * - 旧组 title 匹配不到种子分节（组改名）→ 创建同名分节（数据零丢失）；
 * - 台账：删旧组行，加模板文件行（或更新已存在行）；旧文件移入
 *   `_backup_<ts>/`（不删除，可回滚）。
 * 幂等：迁移后不再有 template_id 旧组 → 后续调用 migrated = 0。
 */
export async function migrateLegacyTemplateGroups(uid: string): Promise<MigrateLegacyResult> {
  if (!safeId(uid)) return { ok: false, migrated: 0, groups_moved: 0, error: 'invalid uid' };

  const groups = readGroups(uid);
  // 旧式组判定：带 template_id 但 rel_path 不是 `<template_id>.md`（模板文件行
  // 也带 template_id，不能算旧式——否则迁移永不幂等）。
  const legacy = groups.filter((g) => g.template_id && !g.rel_path.endsWith(`/${g.template_id}.md`));
  if (!legacy.length) return { ok: true, migrated: 0, groups_moved: 0 };

  const byTemplate = new Map<string, GroupMeta[]>();
  for (const g of legacy) {
    const arr = byTemplate.get(g.template_id!) || [];
    arr.push(g);
    byTemplate.set(g.template_id!, arr);
  }

  // 新台账：删旧式组行，保留模板文件行（部分迁移场景）
  const nextGroups = groups.filter((g) => !g.template_id || g.rel_path.endsWith(`/${g.template_id}.md`));
  const backupDir = path.join(userOntologyGroupsDir(uid), `_backup_${Date.now()}`);
  let migrated = 0;
  let groupsMoved = 0;

  for (const [templateId, oldGroups] of byTemplate) {
    const template = getRoleTemplate(templateId);
    if (!template) {
      log.warn('migrate: template seed missing, legacy groups kept', { uid, templateId });
      continue;
    }

    // 已有模板文件（部分迁移/用户手建）→ 在其基础上合并，不重置
    const existingText = readTemplateFileText(uid, templateId);
    const content: TemplateFileContent = existingText
      ? parseTemplateContent(existingText)
      : {
          title: template.name,
          template_id: templateId,
          version: template.version,
          installed_at: nowIso(),
          sections: template.preset_groups.map((p) => ({
            title: p.title,
            fields: Object.fromEntries(p.fields.map((f) => [f.name, [] as FieldValue[]])),
            flowEntries: [],
          })),
        };

    for (const old of oldGroups) {
      let oldText = '';
      try {
        oldText = fs.readFileSync(resolveGroupContentAbsPathForUser(uid, old.group_id), 'utf8');
      } catch {
        log.warn('migrate: legacy group file unreadable, skipped', { uid, groupId: old.group_id });
        continue;
      }
      const oldContent = parseGroupContent(oldText);

      let sec = content.sections.find((s) => s.title === old.title);
      if (!sec) {
        sec = { title: old.title, fields: {}, flowEntries: [] };
        content.sections.push(sec);
      }
      for (const [fname, fvals] of Object.entries(oldContent.fields)) {
        const existing = sec.fields[fname] || (sec.fields[fname] = []);
        for (const fv of fvals) {
          if (!existing.some((e) => e.value === fv.value && e.source === fv.source)) {
            existing.push({ ...fv });
          }
        }
      }
      for (const e of oldContent.entries) {
        if (!sec.flowEntries.includes(e)) sec.flowEntries.push(e);
      }

      // 旧文件移备份（不删除）
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.renameSync(
          resolveGroupContentAbsPathForUser(uid, old.group_id),
          path.join(backupDir, path.basename(old.rel_path)),
        );
      } catch (err) {
        log.warn('migrate: failed to move legacy group file to backup', { uid, groupId: old.group_id, error: (err as Error).message });
      }
      notifyGroupDeleted(uid, old.rel_path);
      groupsMoved++;
    }

    // 写模板文件
    const relPath = `.personal_ontology_groups/${templateId}.md`;
    try {
      fs.mkdirSync(path.dirname(templateFileAbsPath(uid, templateId)), { recursive: true });
      writeTextAtomicSync(templateFileAbsPath(uid, templateId), serializeTemplateContent(content));
    } catch (err) {
      return { ok: false, migrated, groups_moved: groupsMoved, error: (err as Error).message };
    }

    // 台账：已有模板行 → 更新；没有 → 新增
    const now = nowIso();
    const existingMeta = nextGroups.find((g) => g.template_id === templateId);
    if (existingMeta) {
      existingMeta.updated_at = now;
    } else {
      nextGroups.push({
        group_id: genId12(),
        title: template.name,
        rel_path: relPath,
        created_at: now,
        updated_at: now,
        template_id: templateId,
        template_version: template.version,
      });
    }
    notifyGroupUpserted(uid, relPath);
    migrated++;
  }

  writeGroups(uid, nextGroups);
  log.info('ontology legacy template groups migrated', { uid, migrated, groupsMoved });
  return { ok: true, migrated, groups_moved: groupsMoved };
}

// ── 模板状态（渲染层 templates.list 用）────────────────────────────────────

export interface TemplateStatusSection {
  title: string;
  fields: Array<{ name: string; values: FieldValue[] }>;
}

export interface TemplateStatus {
  template_id: string;
  name: string;
  description: string;
  version: string;
  installed: boolean;
  installed_version?: string;
  /** 已安装时的台账行 group_id（复合 id 基座）。 */
  group_id?: string;
  /** 已安装时从模板文件读的分节（含空坑与已填值）。 */
  sections?: TemplateStatusSection[];
  /** 模板捆绑资源（角色空间 = 本体模板 + skill + task agent 打通的数据源）。 */
  bundle?: { skill_ids: string[]; agent_ids: string[] };
}

/**
 * 内置模板的安装状态 + 文件分节内容（渲染层展示）。字段从文件读
 * （文件是唯一事实来源）；未安装 → sections 缺省。
 */
export async function listTemplateStatus(uid: string): Promise<TemplateStatus[]> {
  if (!safeId(uid)) return [];
  const rows = readGroups(uid).filter((g) => g.template_id);
  return listRoleTemplates().map((t) => {
    const row = rows.find((r) => r.template_id === t.template_id);
    let sections: TemplateStatusSection[] | undefined;
    if (row) {
      const text = readTemplateFileText(uid, t.template_id);
      if (text) {
        sections = parseTemplateContent(text).sections.map((s) => ({
          title: s.title,
          fields: Object.keys(s.fields).map((name) => ({ name, values: s.fields[name] || [] })),
        }));
      }
    }
    return {
      template_id: t.template_id,
      name: t.name,
      description: t.description,
      version: t.version,
      installed: !!row,
      installed_version: row?.template_version,
      group_id: row?.group_id,
      sections,
      bundle: t.bundle ? { skill_ids: t.bundle.skill_ids || [], agent_ids: t.bundle.agent_ids || [] } : undefined,
    };
  });
}

// ── 启动时幂等迁移（deferred boot；旧式模板组 → 模板文件）──────────────────

registerDeferred(
  'personal-ontology-template-migrate',
  async () => {
    try {
      if (!hasActiveUser()) return;
      const uid = getActiveUserId();
      const res = await migrateLegacyTemplateGroups(uid);
      if (res.migrated > 0 || res.groups_moved > 0) {
        log.info('boot: legacy template groups migrated', { uid, migrated: res.migrated, groupsMoved: res.groups_moved });
      }
    } catch (err) {
      log.warn('boot: template migration failed', { error: (err as Error).message });
    }
  },
  'serial',
  1000,
  { resourceClass: 'disk' },
);
