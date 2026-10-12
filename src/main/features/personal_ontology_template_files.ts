/**
 * Personal Ontology Template Files — 角色模板子域（2026-09-29 重构）。
 *
 * 一个已安装角色模板 = PoDocument 里一个 kind='template' 的组（po/model.ts）：
 * 分节（原 preset_group）承载在字段的 `section` 列上，字段分 T-box 声明的坑
 * （origin='schema'）与用户自建（origin='user'），值与流水与普通组同模型。
 * `.personal_ontology_groups/<templateId>.md` 只是写时渲染的视图副本
 * （kb 索引 / transcript 术语桥 / 人类调试），元信息行与分节式方言由
 * po/dialect.ts 唯一定义、按需渲染。
 *
 * 对外导出名与 v1 一致：安装 / 卸载 / 归档（`_backup_<ts>/` 文件保留）、
 * 复合 id `<group_id>::<分节>` 读写、LLM 路由 catalog、渲染层 templates.list、
 * 旧式迁移入口。实现全部改走 po/store。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userOntologyGroupsDir } from '../paths';
import { writeTextAtomicSync, safeId, nowIso, genId12 } from '../storage';
import { collectRoleTemplateMemoryEntries, removeRoleTemplateMemoryFromLive, restoreRoleTemplateMemoryEntries } from './memory';
import { getRoleTemplate, listRoleTemplates } from './role_templates';
import { createLogger } from '../logger';
import { registerDeferred } from '../util/boot_init';
import { hasActiveUser, getActiveUserId } from './users';
import { editPoDoc, ensurePoDoc, loadPoDocSync } from './po/store';
import type { PoDocument, PoEntry, PoField, PoGroup, PoValue } from './po/model';
import { sanitizePoText } from './po/model';
import { poGroupRelPath, poGroupToMeta, renderTemplateGroupMarkdown } from './po/view';
import {
  isTemplateFileText,
  normalizeSource,
  parseTemplateContent,
  resolveAsOfControl,
  serializeSection,
  serializeTemplateContent,
  summarizeFieldValue,
  isValidTemplateVersion,
  type AsOfControl,
  type FieldValue,
  type GroupMeta,
  type TemplateFileContent,
  type TemplateSection,
} from './po/dialect';
import {
  appendFieldValue,
  appendToGroup,
  listGroupFields,
  promoteEntryToField,
  readGroups,
  removeEntry,
  removeField,
  removeFieldValue,
  setFieldValue,
  type GroupFieldInfo,
} from './personal_ontology_groups';

export { readGroups };
export { isTemplateFileText, parseTemplateContent, serializeSection, serializeTemplateContent };
export type { TemplateFileContent, TemplateSection };
export { isValidTemplateVersion };

const log = createLogger('personal-ontology-template-files');

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** 角色模板安装上限：每人最多 3 个（产品规则，防去向面板/空间选择过载）。 */
export const MAX_INSTALLED_TEMPLATES = 3;

/** 复合 id 分隔符：`<group_id>::<分节名>`。普通组 id 不含此分隔符。 */
export const SECTION_REF_SEP = '::';

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

/** 模板文件（渲染副本）绝对路径（文件名 = `<template_id>.md`，归档/备份用）。 */
export function templateFileAbsPath(uid: string, templateId: string): string {
  return path.join(userOntologyGroupsDir(uid), `${templateId}.md`);
}

/** 读取模板的方言文本（从 JSON 现渲染）；未安装 → 空字符串。 */
export function readTemplateFileText(uid: string, templateId: string): string {
  const group = loadPoDocSync(uid).groups.find((g) => g.kind === 'template' && g.templateId === templateId);
  return group ? renderTemplateGroupMarkdown(group) : '';
}

function findTemplateGroup(uid: string, groupId: string): PoGroup | undefined {
  const group = loadPoDocSync(uid).groups.find((g) => g.id === groupId);
  return group && group.kind === 'template' ? group : undefined;
}

// ── JSON 组 ↔ 方言互转（模板形状）────────────────────────────────────────

/** PoValue → 方言值行视图。 */
function poValueToLine(v: PoValue): FieldValue {
  return {
    value: v.text,
    source: v.source,
    ...(v.project ? { project: v.project } : {}),
    ...(v.asOf ? { asOf: v.asOf } : {}),
    ...(v.verified !== undefined ? { verified: v.verified } : {}),
    ...(v.ruleKind ? { ruleKind: v.ruleKind } : {}),
    ...(v.restricted ? { sensitivity: 'restricted' as const } : {}),
    ...(v.assetId ? { recallAssetId: v.assetId } : {}),
  };
}

/** 从模板方言文本重建组内容（字段/值/条目；id 保全回调可选）。 */
function groupContentFromTemplateText(
  text: string,
): { fields: PoField[]; values: PoValue[]; entries: PoEntry[] } {
  const now = nowIso();
  const content = parseTemplateContent(text);
  const fields: PoField[] = [];
  const values: PoValue[] = [];
  const entries: PoEntry[] = [];
  for (const section of content.sections) {
    for (const name of Object.keys(section.fields)) {
      const id = `f${Math.random().toString(16).slice(2, 10)}`;
      const field: PoField = { id, name: sanitizePoText(name, 200), origin: 'user', section: sanitizePoText(section.title, 200), createdAt: now };
      if (field.name) {
        fields.push(field);
        for (const fv of section.fields[name] || []) {
          const at = nowIso();
          values.push({
            id: `v${Math.random().toString(16).slice(2, 10)}`,
            fieldId: field.id,
            text: sanitizePoText(fv.value, 2000),
            source: fv.source || '手动',
            ...(fv.project ? { project: fv.project } : {}),
            ...(fv.asOf ? { asOf: fv.asOf } : {}),
            ...(fv.verified !== undefined ? { verified: fv.verified } : {}),
            ...(fv.ruleKind ? { ruleKind: fv.ruleKind } : {}),
            ...(fv.sensitivity === 'restricted' ? { restricted: true } : {}),
            ...(fv.recallAssetId ? { assetId: fv.recallAssetId } : {}),
            createdAt: at,
            updatedAt: at,
          });
        }
      }
    }
    for (const t of section.flowEntries) {
      const text0 = sanitizePoText(t, 4000);
      if (text0) entries.push({ id: `e${Math.random().toString(16).slice(2, 10)}`, text: text0, section: sanitizePoText(section.title, 200), createdAt: now });
    }
  }
  return { fields, values, entries };
}

// ── 安装 / 卸载 / 归档 ───────────────────────────────────────────────────

export interface InstallTemplateFileResult {
  ok: boolean;
  already_installed?: boolean;
  created?: GroupMeta[];
  conflict_groups?: Array<{ group_id: string; title: string }>;
  /** 重装时是否从归档恢复了旧数据（有旧数据 → true）。 */
  restored_from_archive?: boolean;
  /** 随模板恢复的全局记忆条目数。 */
  restored_memory_count?: number;
  /** 恢复旧版本实例后的 schema reconcile 结果（见 applyRoleTemplateMigration）。 */
  migration?: {
    outcome: 'migrated' | 'ledger_repaired' | 'noop' | 'refused' | 'failed';
    fromVersion?: string;
    toVersion?: string;
    unsupported?: string[];
    error?: string;
  };
  error?: string;
}

/** 从模板目录种子生成一个空模板组（全部分节 + 字段空坑）。 */
function seedTemplateGroup(templateId: string): PoGroup | undefined {
  const template = getRoleTemplate(templateId);
  if (!template) return undefined;
  const now = nowIso();
  const group: PoGroup = {
    id: genId12(),
    title: template.name,
    kind: 'template',
    templateId,
    templateVersion: template.version,
    installedAt: now,
    fields: [],
    values: [],
    entries: [],
    createdAt: now,
    updatedAt: now,
  };
  for (const preset of template.preset_groups) {
    for (const f of preset.fields) {
      group.fields.push({
        id: genId12(),
        name: f.name,
        isRelation: f.isRelation || undefined,
        description: f.description,
        section: preset.title,
        origin: 'schema',
        createdAt: now,
      });
    }
  }
  return group;
}

/** 从归档的模板方言文本重建模板组（保留值/流水；schema 以归档版本为准）。 */
function templateGroupFromArchiveText(uid: string, templateId: string, text: string): PoGroup | undefined {
  const template = getRoleTemplate(templateId);
  if (!template) return undefined;
  const content = parseTemplateContent(text);
  const group = seedTemplateGroup(templateId);
  if (!group) return undefined;
  group.templateVersion = content.version || template.version;
  group.installedAt = content.installed_at || group.installedAt;
  // 归档恢复 = **原样**（v1 语义）：结构以归档为准，不并入当前 catalog 的
  // 空坑——新版本补坑是 install 之后 reconcile（真迁移）的职责；提前并入
  // 会把「检测到需要迁移」这个事实抹掉。
  const rebuilt = groupContentFromTemplateText(text);
  group.fields = rebuilt.fields;
  group.values = rebuilt.values;
  group.entries = rebuilt.entries;
  return group;
}

/**
 * 安装角色模板：生成模板组（全部分节 + 字段空坑落 JSON）。幂等：同
 * template_id 已装 → already_installed。与普通组同名 → conflict_groups 警告。
 * `restoreData`：重装时若归档目录有旧数据 → 恢复旧数据（字段值/流水保留），
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

  const doc = loadPoDocSync(uid);
  const reservedTitles = new Set([template.name, ...template.preset_groups.map((p) => p.title)]);
  const conflictGroups = doc.groups
    .filter((g) => g.kind === 'user' && reservedTitles.has(g.title))
    .map((g) => ({ group_id: g.id, title: g.title }));

  if (doc.groups.some((g) => g.kind === 'template' && g.templateId === templateId)) {
    return { ok: true, already_installed: true, conflict_groups: conflictGroups };
  }
  const installedCount = doc.groups.filter((g) => g.kind === 'template').length;
  if (installedCount >= MAX_INSTALLED_TEMPLATES) {
    return { ok: false, error: 'template_limit_reached', conflict_groups: conflictGroups };
  }

  let restored_from_archive = false;
  let restored_memory_count = 0;
  let newGroup: PoGroup | undefined;
  if (restoreData) {
    const archived = readTemplateArchive(uid, templateId);
    if (archived) {
      newGroup = templateGroupFromArchiveText(uid, templateId, archived);
      restored_from_archive = !!newGroup;
      if (!newGroup) log.warn('restore: archived template unparsable; falling back to fresh install', { uid, templateId });
    }
  }
  if (!newGroup) newGroup = seedTemplateGroup(templateId);
  if (!newGroup) return { ok: false, error: 'template not found' };

  // 恢复随模板归档的全局记忆 —— 按实际成功数上报（B-3）。
  if (restoreData) {
    const memArchived = readTemplateMemoryArchive(uid, templateId);
    if (memArchived) {
      restored_memory_count = restoreRoleTemplateMemoryEntries(uid, templateId, memArchived);
    }
  }
  if (restored_from_archive || restored_memory_count > 0) {
    clearTemplateArchives(uid, templateId);
  }

  const result = await editPoDoc(uid, (ctx) => {
    ctx.doc.groups.push(newGroup!);
    ctx.touch(newGroup!.id);
  });
  if (!result.ok) return { ok: false, error: result.error };
  log.info('ontology template installed', {
    uid, templateId, restored_from_archive, restored_memory_count,
    installed_version: newGroup.templateVersion,
    catalog_version: template.version,
  });

  // 恢复出来的是旧 schema 实例 → 返回成功之前 reconcile 到当前 catalog。
  let migration: InstallTemplateFileResult['migration'];
  if (restored_from_archive && newGroup.templateVersion !== template.version) {
    try {
      const { applyRoleTemplateMigration } = await import('./personal_ontology_migration');
      const res = await applyRoleTemplateMigration(uid, templateId);
      migration = {
        outcome: res.outcome,
        ...(res.fromVersion ? { fromVersion: res.fromVersion } : {}),
        ...(res.toVersion ? { toVersion: res.toVersion } : {}),
        ...(res.refusal ? { unsupported: [...new Set(res.refusal.unsupportedChanges.map((c) => c.kind))] } : {}),
        ...(res.error ? { error: res.error } : {}),
      };
    } catch (err) {
      migration = { outcome: 'failed', error: (err as Error).message };
      log.warn('restored role template reconcile threw; instance kept at its restored version', {
        uid, templateId, error: (err as Error).message,
      });
    }
  }

  const finalDoc = loadPoDocSync(uid);
  const finalGroup = finalDoc.groups.find((g) => g.id === newGroup!.id);
  const finalMeta = finalGroup
    ? poGroupToMeta(finalGroup)
    : undefined;
  return {
    ok: true,
    created: finalMeta ? [finalMeta] : [],
    conflict_groups: conflictGroups,
    restored_from_archive,
    restored_memory_count,
    ...(migration ? { migration } : {}),
  };
}

// poGroupToMeta 在 groups.ts 里；这里做本地薄别名（避免再扩 groups 导出面）。


export interface UninstallTemplateFileResult {
  ok: boolean;
  error?: string;
  /** 归档目录绝对路径（数据保留位置，UI 展示给用户）。 */
  archive_dir?: string;
  /** 随模板一起归档的全局记忆条目数。 */
  archived_memory_count?: number;
}

/** 模板归档目录：`.personal_ontology_groups/_backup_<ts>/`。 */
export function templateArchiveDir(uid: string): string {
  return path.join(userOntologyGroupsDir(uid), `_backup_${Date.now()}`);
}

/** schema migration 的备份目录：`.personal_ontology_groups/_migration_<ts>/`。
 *  前缀必须与卸载归档的 `_backup_` 分开（两套生命周期不共享发现路径）。 */
export function templateMigrationBackupDir(uid: string): string {
  return path.join(userOntologyGroupsDir(uid), `_migration_${Date.now()}`);
}

/**
 * 迁移前把当前模板的方言渲染**复制**一份到 `_migration_<ts>/`（复制而非移动：
 * 移动会让活数据在窗口期短暂消失）。返回备份目录绝对路径；模板未装 → null。
 */
export function backupTemplateFileForMigration(uid: string, templateId: string): string | null {
  const text = readTemplateFileText(uid, templateId);
  if (!text) return null;
  const dir = templateMigrationBackupDir(uid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${templateId}.md`), text, 'utf8');
  return dir;
}

/** 该用户下现存的 migration 备份目录（新的在前）。 */
export function listMigrationBackupDirs(uid: string): string[] {
  try {
    const base = userOntologyGroupsDir(uid);
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^_migration_\d+$/.test(entry.name))
      .map((entry) => path.join(base, entry.name))
      .sort((a, b) => Number(path.basename(b).replace('_migration_', '')) - Number(path.basename(a).replace('_migration_', '')));
  } catch {
    return [];
  }
}

/** 每个模板保留最近 N 份迁移备份；更老的删掉。 */
export const MAX_MIGRATION_BACKUPS = 3;

export function pruneMigrationBackups(uid: string, templateId: string, keep = MAX_MIGRATION_BACKUPS): void {
  const withTemplate = listMigrationBackupDirs(uid)
    .filter((dir) => fs.existsSync(path.join(dir, `${templateId}.md`)));
  for (const dir of withTemplate.slice(keep)) {
    try {
      fs.rmSync(path.join(dir, `${templateId}.md`), { force: true });
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch { /* 清理失败不影响迁移结果 */ }
  }
}

/**
 * 卸载角色模板：模板组从文档移除（渲染副本一并清理），方言渲染先归档到
 * `_backup_<ts>/`（数据保留，可重装恢复）。`archiveMemory` 时，该角色来源的
 * 全局记忆条目（USER.md/MEMORY.md 中带 role_template 标签的）一并归档到
 * `<templateId>.memory.md` 并从全局记忆移除。幂等：未安装 → ok（无操作）。
 */
export async function uninstallTemplateFile(
  uid: string,
  templateId: string,
  archiveMemory = false,
): Promise<UninstallTemplateFileResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const doc = loadPoDocSync(uid);
  const group = doc.groups.find((g) => g.kind === 'template' && g.templateId === templateId);
  if (!group) return { ok: true }; // 未安装 → 无操作

  const currentText = renderTemplateGroupMarkdown(group);
  let archive_dir: string | undefined;
  let archived_memory_count = 0;
  try {
    archive_dir = templateArchiveDir(uid);
    fs.mkdirSync(archive_dir, { recursive: true });
    writeTextAtomicSync(path.join(archive_dir, `${templateId}.md`), currentText);
    if (archiveMemory) {
      // 顺序保证（防崩溃窗口数据丢失）：先写归档文件 → 再删活数据。
      const texts = collectRoleTemplateMemoryEntries(uid, templateId);
      const all = [...(texts.user || []), ...(texts.memory || [])];
      if (all.length) {
        const parts: string[] = [];
        if (texts.user.length) parts.push(`# user\n${texts.user.join('\n§\n')}`);
        if (texts.memory.length) parts.push(`# memory\n${texts.memory.join('\n§\n')}`);
        writeTextAtomicSync(path.join(archive_dir, `${templateId}.memory.md`), parts.join('\n\n'));
        const removed = removeRoleTemplateMemoryFromLive(uid, templateId);
        if (!removed.userOk || !removed.memoryOk) {
          log.warn('uninstall: global-memory removal failed after archive write', { uid, templateId, removed });
        }
        archived_memory_count = all.length;
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const result = await editPoDoc(uid, (ctx) => {
    const idx = ctx.doc.groups.findIndex((g) => g.id === group.id);
    if (idx !== -1) ctx.doc.groups.splice(idx, 1);
    ctx.markRemoved(poGroupRelPath(group));
  });
  if (!result.ok) return { ok: false, error: result.error };
  log.info('ontology template file uninstalled (archived)', {
    uid, templateId,
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
      .sort((a, b) => Number(path.basename(b).replace('_backup_', '')) - Number(path.basename(a).replace('_backup_', ''))); // 新的在前
  } catch {
    return [];
  }
}

/** 从归档目录读回模板旧数据（方言文本）；无归档 → null。取最新一份。 */
export function readTemplateArchive(uid: string, templateId: string): string | null {
  for (const dir of listArchiveDirs(uid)) {
    const p = path.join(dir, `${templateId}.md`);
    if (fs.existsSync(p)) {
      try { return fs.readFileSync(p, 'utf8'); } catch { /* 继续找下一份 */ }
    }
  }
  return null;
}

/** 从归档读回该模板随附的全局记忆归档（`.memory.md`，B-4 分区格式）。 */
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

/** 归档目录里是否还有该模板的全局记忆归档。 */
export function templateHasMemoryArchive(uid: string, templateId: string): boolean {
  return listArchiveDirs(uid).some((dir) => fs.existsSync(path.join(dir, `${templateId}.memory.md`)));
}

/** 重装恢复成功后清理该模板的所有归档（数据已回活，避免隐私驻留）。 */
export function clearTemplateArchives(uid: string, templateId: string): void {
  for (const dir of listArchiveDirs(uid)) {
    for (const name of [`${templateId}.md`, `${templateId}.memory.md`]) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* 忽略 */ }
    }
  }
}

// ── 模板编辑 / 复合 id 统一入口 ──────────────────────────────────────────

function assetProjectionSignatures(group: PoGroup): string[] {
  const signatures: string[] = [];
  for (const value of group.values) {
    if (!value.assetId) continue;
    const field = group.fields.find((f) => f.id === value.fieldId);
    signatures.push(JSON.stringify([
      field?.section || '',
      field?.name || '',
      serializeFieldValueLine(poValueToLine(value)),
    ]));
  }
  return signatures.sort();
}

import { serializeFieldValueLine } from './po/dialect';

/** Full-template raw editor save. 用户可以编辑模板值；模板元数据与正式资产
 *  投影的集合/内容/位置分别归各自来源服务所有（只读守卫同 v1）。 */
export async function writeTemplateFileContent(
  uid: string,
  groupId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const current = findTemplateGroup(uid, groupId);
  if (!current) return { ok: false, error: 'template group not found' };
  const body = typeof text === 'string' ? text : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_FILE_BYTES) {
    return { ok: false, error: `file exceeds ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB limit` };
  }
  const submitted = parseTemplateContent(body);

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('template group not found');
    if (submitted.template_id !== (group.templateId || '')
      || submitted.title !== group.title
      || submitted.version !== (group.templateVersion || '')
      || submitted.installed_at !== (group.installedAt || group.createdAt)) {
      return ctx.fail('template_metadata_read_only');
    }
    const previousProjections = assetProjectionSignatures(group);
    const submittedGroupState = groupContentFromTemplateText(body);
    const submittedLike: PoGroup = { ...group, fields: submittedGroupState.fields, values: submittedGroupState.values, entries: submittedGroupState.entries };
    const submittedProjections = assetProjectionSignatures(submittedLike);
    if (previousProjections.length !== submittedProjections.length
      || previousProjections.some((signature, index) => signature !== submittedProjections[index])) {
      return ctx.fail('asset_projection_read_only');
    }
    // id 保全：同 分节+字段名 沿用旧字段 id（值的外键 fieldId 同步改指）；
    // 同字段内同文本值沿用旧值 id。
    const oldFieldByKey = new Map(group.fields.map((f) => [`${f.section || ''}\u0000${f.name}`, f]));
    const fieldIdOverride = new Map<string, string>();
    for (const f of submittedLike.fields) {
      const old = oldFieldByKey.get(`${f.section || ''}\u0000${f.name}`);
      if (old) {
        fieldIdOverride.set(f.id, old.id);
        f.id = old.id;
      }
    }
    for (const v of submittedLike.values) {
      const mapped = fieldIdOverride.get(v.fieldId);
      if (mapped) v.fieldId = mapped;
    }
    const oldValuesByKey = new Map(group.values.map((v) => {
      const f = group.fields.find((x) => x.id === v.fieldId);
      return [`${f?.section || ''}\u0000${f?.name || ''}\u0000${v.text}`, v];
    }));
    for (const v of submittedLike.values) {
      const f = submittedLike.fields.find((x) => x.id === v.fieldId);
      const old = oldValuesByKey.get(`${f?.section || ''}\u0000${f?.name || ''}\u0000${v.text}`);
      if (old) v.id = old.id;
    }
    group.fields = submittedLike.fields;
    group.values = submittedLike.values;
    group.entries = submittedLike.entries;
    group.updatedAt = nowIso();
  });
}

/** 定位分节下的字段（含空坑判据：fields 数组里有这个 key）。 */
function findSectionField(group: PoGroup, section: string, fieldName: string): PoField | undefined {
  return group.fields.find((f) => (f.section || '') === section && f.name === fieldName);
}

export interface ReadContentByIdResult {
  ok: boolean;
  content?: string;
  section?: string | null;
  error?: string;
}

/**
 * 按 id（普通组 id 或复合 id `groupId::分节`）读取内容。
 * 模板分节 → 返回该分节的方言文本（含 `## 分节` 标题，供 @ Picker 注入）；
 * 普通组 → 整组内容（chat-use 兼容）。
 */
export async function readContentById(uid: string, ref: string): Promise<ReadContentByIdResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const { groupId, section } = splitContentRef(ref);
  if (!section) {
    const { readGroupContent } = await import('./personal_ontology_groups');
    return readGroupContent(uid, groupId);
  }

  const group = findTemplateGroup(uid, groupId);
  if (!group) return { ok: false, error: 'template group not found' };
  const fields = group.fields.filter((f) => (f.section || '') === section);
  const hasSection = fields.length > 0 || group.entries.some((e) => (e.section || '') === section);
  if (!hasSection) return { ok: false, error: 'section not found' };
  const sec: TemplateSection = {
    title: section,
    fields: Object.fromEntries(fields.map((f) => [f.name, group.values.filter((v) => v.fieldId === f.id).map(poValueToLine)])),
    flowEntries: group.entries.filter((e) => (e.section || '') === section).map((e) => e.text),
  };
  return { ok: true, content: serializeSection(sec), section };
}

/**
 * 字段写入：复合 id → 模板分节字段（多值追加 + 同值同源同项目去重，空坑变有值；
 * 字段不存在则创建——等价于自定义字段）；普通组 id → 转发 appendFieldValue。
 */
export async function appendFieldValueToRef(
  uid: string,
  ref: string,
  fieldName: string,
  value: string,
  source: string,
  project?: string,
  asOf?: string,
  asOfControl?: AsOfControl,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const { groupId, section } = splitContentRef(ref);
  if (!section) return appendFieldValue(uid, groupId, fieldName, value, source, project, asOf, asOfControl);

  const name = sanitizePoText(fieldName, 200);
  const val = sanitizePoText(value, 2000);
  if (!name) return { ok: false, error: 'field name required' };
  if (!val) return { ok: false, error: 'empty value' };
  const src = normalizeSource(source);
  const proj = project ? String(project).trim() : undefined;
  if (asOfControl) {
    const resolved = resolveAsOfControl(asOfControl);
    if (!resolved.ok) return resolved;
  }
  const validAsOf = asOfControl
    ? (asOfControl.asOf !== undefined ? asOfControl.asOf : undefined)
    : (asOf && /^asof:((?:19|20)\d{2})-(0[1-9]|1[0-2])$/.test(`asof:${asOf}`) ? asOf : undefined);

  const current = findTemplateGroup(uid, groupId);
  if (!current) return { ok: false, error: 'template group not found' };

  let existingSnapshot: Array<{ value: string; restricted: boolean }> = [];
  let appended = false;
  const result = await editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('template group not found');
    // 分节必须已存在（v1 口径：分节寻址不允许凭空造节）；节内字段不存在才
    // 允许创建（自定义字段）。
    const sectionExists = group.fields.some((f) => (f.section || '') === section)
      || group.entries.some((e) => (e.section || '') === section);
    if (!sectionExists) return ctx.fail('section not found');
    let field = findSectionField(group, section, name);
    if (!field) {
      field = { id: genId12(), name, origin: 'user', section, createdAt: nowIso() };
      group.fields.push(field);
    }
    existingSnapshot = group.values.filter((v) => v.fieldId === field!.id).map((v) => ({ value: v.text, restricted: v.restricted === true }));
    if (group.values.some((v) => v.fieldId === field!.id && v.text === val && v.source === src && (v.project ?? undefined) === proj)) {
      return; // 同值同源同项目去重
    }
    group.values.push({
      id: genId12(), fieldId: field.id, text: val, source: src,
      ...(proj ? { project: proj } : {}), ...(validAsOf ? { asOf: validAsOf } : {}),
      createdAt: nowIso(), updatedAt: nowIso(),
    });
    appended = true;
    group.updatedAt = nowIso();
  });
  if (result.ok && appended && existingSnapshot.length) {
    void import('./recall/ontology-conflicts')
      .then((m) => m.checkNewValueAgainst(uid, groupId, name, val, existingSnapshot))
      .catch(() => {});
  }
  return result;
}

/**
 * 画像投影专用写入口：只允许写进模板 T-box 声明且实例中存在的坑；永不建字段、
 * 永不落到自由组。带 recallAssetId 时先清该资产旧投影再写（所有权转移）。
 */
export async function appendExistingTemplateFieldValueToRef(
  uid: string,
  ref: string,
  fieldName: string,
  value: string,
  source: string,
  project?: string,
  recallAssetId?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  if (recallAssetId !== undefined && !safeId(recallAssetId)) return { ok: false, error: 'invalid recall asset id' };
  const { groupId, section } = splitContentRef(ref);
  if (!section) return { ok: false, error: 'template section ref required' };

  const name = sanitizePoText(fieldName, 200);
  const val = sanitizePoText(value, 2000);
  if (!name) return { ok: false, error: 'field name required' };
  if (!val) return { ok: false, error: 'empty value' };
  const src = normalizeSource(source);
  const proj = project ? String(project).trim() : undefined;

  const current = findTemplateGroup(uid, groupId);
  if (!current) return { ok: false, error: 'template group not found' };
  const { isTboxField } = await import('./personal_ontology_contract');
  if (!isTboxField(current.templateId || '', section, name)) {
    return { ok: false, error: 'field is not declared by the role template' };
  }

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('template group not found');
    const field = findSectionField(group, section, name);
    if (!field) return ctx.fail('field not found');
    const values = group.values.filter((v) => v.fieldId === field.id);
    if (recallAssetId) {
      const prior = values.filter((v) => v.assetId === recallAssetId);
      const keptIds = new Set(values.filter((v) => v.assetId !== recallAssetId).map((v) => v.id));
      const exactPrior = prior.find((v) => v.text === val && v.source === src && (v.project ?? undefined) === proj);
      if (exactPrior && prior.length === 1) return; // 已是最新投影
      // 孤儿同值（无所有权标记的手写/遗留行）不静默认领，报给上层人工处理。
      if (values.some((v) => keptIds.has(v.id) && v.text === val && v.source === src && (v.project ?? undefined) === proj)) {
        return ctx.fail('profile_value_untracked_duplicate');
      }
      group.values = group.values.filter((v) => v.assetId !== recallAssetId || v.fieldId !== field.id);
      group.values.push({
        id: genId12(), fieldId: field.id, text: val, source: src, assetId: recallAssetId,
        ...(proj ? { project: proj } : {}),
        createdAt: nowIso(), updatedAt: nowIso(),
      });
      group.updatedAt = nowIso();
      return;
    }
    if (values.some((v) => v.text === val && v.source === src && (v.project ?? undefined) === proj)) return;
    group.values.push({
      id: genId12(), fieldId: field.id, text: val, source: src,
      ...(proj ? { project: proj } : {}),
      createdAt: nowIso(), updatedAt: nowIso(),
    });
    group.updatedAt = nowIso();
  });
}

/** 只清除带该资产所有权标记的模板值；手写/导入/无标记值一律不动。 */
export async function removeTemplateFieldValuesForRecallAsset(
  uid: string,
  recallAssetId: string,
): Promise<{ ok: boolean; removed: number; error?: string }> {
  if (!safeId(uid)) return { ok: false, removed: 0, error: 'invalid uid' };
  if (!safeId(recallAssetId)) return { ok: false, removed: 0, error: 'invalid recall asset id' };

  const doc = loadPoDocSync(uid);
  const templateGroups = doc.groups.filter((g) => g.kind === 'template');
  let removed = 0;
  for (const group of templateGroups) {
    removed += group.values.filter((v) => v.assetId === recallAssetId).length;
  }
  if (!removed) return { ok: true, removed: 0 };
  const result = await editPoDoc(uid, (ctx) => {
    for (const group of ctx.doc.groups) {
      if (group.kind !== 'template') continue;
      const before = group.values.length;
      group.values = group.values.filter((v) => v.assetId !== recallAssetId);
      if (group.values.length !== before) {
        group.updatedAt = nowIso();
        ctx.touch(group.id);
      }
    }
  });
  return result.ok ? { ok: true, removed } : { ok: false, removed: 0, error: result.error };
}

/** 流水追加：复合 id → 分节流水；普通组 id → 转发 appendToGroup。 */
export async function appendFlowEntryToRef(uid: string, ref: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const trimmed = sanitizePoText(text, 4000);
  if (!trimmed) return { ok: false, error: 'empty content' };

  const { groupId, section } = splitContentRef(ref);
  if (!section) return appendToGroup(uid, groupId, trimmed);

  const current = findTemplateGroup(uid, groupId);
  if (!current) return { ok: false, error: 'template group not found' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('template group not found');
    if (!group.fields.some((f) => (f.section || '') === section) && !group.entries.some((e) => (e.section || '') === section)) {
      return ctx.fail('section not found');
    }
    group.entries.push({ id: genId12(), text: trimmed, section, createdAt: nowIso() });
    group.updatedAt = nowIso();
  });
}

/** 流水升格：复合 id → 同分节流水条目升格为该分节字段（来源「手动」）。
 *  允许创建 T-box 之外的自定义字段；返回 isCustom 供 UI 提示。 */
export async function promoteEntryToRef(
  uid: string,
  ref: string,
  entryText: string,
  fieldName: string,
): Promise<{ ok: boolean; error?: string; isCustom?: boolean }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const target = sanitizePoText(entryText, 4000);
  const name = sanitizePoText(fieldName, 200);
  if (!target) return { ok: false, error: 'empty entry' };
  if (!name) return { ok: false, error: 'field name required' };

  const { groupId, section } = splitContentRef(ref);
  if (!section) {
    const res = await promoteEntryToField(uid, groupId, target, name);
    if (!res.ok) return res;
    return { ok: true, isCustom: true };
  }

  const current = findTemplateGroup(uid, groupId);
  if (!current) return { ok: false, error: 'template group not found' };

  const { listTboxFieldNames } = await import('./personal_ontology_contract');
  const tboxNames = listTboxFieldNames(current.templateId || '');
  const isCustom = tboxNames.size ? !tboxNames.has(name) : true;

  const result = await editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('template group not found');
    const idx = group.entries.findIndex((e) => (e.section || '') === section && e.text === target);
    if (idx === -1) return ctx.fail('entry not found');
    group.entries.splice(idx, 1);
    let field = findSectionField(group, section, name);
    if (!field) {
      field = { id: genId12(), name, origin: 'user', section, createdAt: nowIso() };
      group.fields.push(field);
    }
    group.values.push({ id: genId12(), fieldId: field.id, text: target, source: '手动', createdAt: nowIso(), updatedAt: nowIso() });
    group.updatedAt = nowIso();
  });
  return { ...result, ...(result.ok ? { isCustom } : {}) };
}

/** 字段值替换：复合 id → 分节字段按值匹配替换（保留来源与全部列）。 */
export async function setFieldValueToRef(
  uid: string,
  ref: string,
  fieldName: string,
  oldValue: string,
  newValue: string,
  asOfControl?: AsOfControl,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = sanitizePoText(fieldName, 200);
  const next = sanitizePoText(newValue, 2000);
  if (!name) return { ok: false, error: 'field name required' };
  if (!next) return { ok: false, error: 'empty value' };
  if (asOfControl) {
    const resolved = resolveAsOfControl(asOfControl);
    if (!resolved.ok) return resolved;
  }

  const { groupId, section } = splitContentRef(ref);
  if (!section) return setFieldValue(uid, groupId, name, String(oldValue ?? ''), next, asOfControl);

  const current = findTemplateGroup(uid, groupId);
  if (!current) return { ok: false, error: 'template group not found' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('template group not found');
    const field = findSectionField(group, section, name);
    if (!field) return ctx.fail('field value not found');
    const value = group.values.find((v) => v.fieldId === field.id && v.text === oldValue);
    if (!value) return ctx.fail('field value not found');
    // 正式资产拥有它的投影值；编辑这份拷贝会制造第二事实来源（下次同步即覆盖）。
    if (value.assetId) return ctx.fail('asset_projection_read_only');
    const beforeSummary = summarizeFieldValue(poValueToLine(value));
    value.text = next;
    if (asOfControl?.asOf !== undefined) value.asOf = asOfControl.asOf;
    else if (asOfControl?.clearAsOf === true) delete value.asOf;
    value.updatedAt = nowIso();
    group.updatedAt = nowIso();
    appendTemplateAudit(uid, groupId, 'value_edit', { field: name, beforeSummary, afterSummary: summarizeFieldValue(poValueToLine(value)) });
  });
}

/** 删值行：分节字段删值后空坑保留（模板字段=挖空清单，不因删值消失）。 */
export async function removeFieldValueToRef(uid: string, ref: string, fieldName: string, value: string): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = sanitizePoText(fieldName, 200);

  const { groupId, section } = splitContentRef(ref);
  if (!section) {
    const { removeFieldValue: rm } = await import('./personal_ontology_groups');
    return rm(uid, groupId, name, String(value ?? ''));
  }
  if (!name) return { ok: false, error: 'field name required' };

  const current = findTemplateGroup(uid, groupId);
  if (!current) return { ok: false, error: 'template group not found' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('template group not found');
    const field = findSectionField(group, section, name);
    if (!field) return; // no-op ok
    const targets = group.values.filter((v) => v.fieldId === field.id && v.text === value);
    if (!targets.length) return;
    // 匹配按可见文本（旧 API 语义）；只要有一行是资产-owned 就拒绝模糊删除。
    if (targets.some((v) => v.assetId)) return ctx.fail('asset_projection_read_only');
    const beforeSummary = targets.map((v) => summarizeFieldValue(poValueToLine(v))).join('、');
    group.values = group.values.filter((v) => !(v.fieldId === field.id && v.text === value));
    group.updatedAt = nowIso();
    appendTemplateAudit(uid, groupId, 'value_remove', { field: name, beforeSummary });
  });
}

/** 删字段小节（坑消失）；带资产投影的字段拒绝。 */
export async function removeFieldToRef(uid: string, ref: string, fieldName: string): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = sanitizePoText(fieldName, 200);

  const { groupId, section } = splitContentRef(ref);
  if (!section) {
    const { removeField: rm } = await import('./personal_ontology_groups');
    return rm(uid, groupId, name);
  }
  if (!name) return { ok: false, error: 'field name required' };

  const current = findTemplateGroup(uid, groupId);
  if (!current) return { ok: false, error: 'template group not found' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('template group not found');
    const field = findSectionField(group, section, name);
    if (!field) return;
    if (group.values.some((v) => v.fieldId === field.id && v.assetId)) {
      return ctx.fail('asset_projection_read_only');
    }
    group.fields = group.fields.filter((f) => f.id !== field.id);
    group.values = group.values.filter((v) => v.fieldId !== field.id);
    group.updatedAt = nowIso();
    appendTemplateAudit(uid, groupId, 'field_remove', { field: name });
  });
}

/** 删流水条目：复合 id → 分节流水移除。 */
export async function removeEntryToRef(uid: string, ref: string, entryText: string): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const target = sanitizePoText(entryText, 4000);
  if (!target) return { ok: false, error: 'empty entry' };

  const { groupId, section } = splitContentRef(ref);
  if (!section) return removeEntry(uid, groupId, target);

  const current = findTemplateGroup(uid, groupId);
  if (!current) return { ok: false, error: 'template group not found' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('template group not found');
    const idx = group.entries.findIndex((e) => (e.section || '') === section && e.text === target);
    if (idx === -1) return ctx.fail('entry not found');
    group.entries.splice(idx, 1);
    group.updatedAt = nowIso();
  });
}

// 模板侧审计走同一台账（appendOntologyAudit 的转出别名）。
import { appendOntologyAudit as appendTemplateAudit } from './personal_ontology_groups';

// ── 复合 id 统一入口：字段清单（候选确认预检查用）────────────────────────

export interface TemplateCatalogSection {
  title: string;
  fields: string[];
}

export interface TemplateCatalogEntry {
  /** 组 id（复合 id 的基座）。 */
  group_id: string;
  template_id: string;
  name: string;
  version: string;
  sections: TemplateCatalogSection[];
}

/** 已安装模板的分节字段清单（LLM 路由 catalog 用；含空坑与自定义字段）。 */
export async function listTemplateFileCatalog(uid: string): Promise<TemplateCatalogEntry[]> {
  if (!safeId(uid)) return [];
  return loadPoDocSync(uid).groups
    .filter((g) => g.kind === 'template')
    .map((g) => ({
      group_id: g.id,
      template_id: g.templateId || '',
      name: g.title,
      version: g.templateVersion || '',
      sections: catalogSectionsOf(g),
    }));
}

function catalogSectionsOf(group: PoGroup): TemplateCatalogSection[] {
  const order: string[] = [];
  for (const f of group.fields) {
    const s = f.section || '';
    if (!order.includes(s)) order.push(s);
  }
  for (const e of group.entries) {
    const s = e.section || '';
    if (!order.includes(s)) order.push(s);
  }
  return order.map((title) => ({
    title,
    fields: group.fields.filter((f) => (f.section || '') === title).map((f) => f.name),
  }));
}

export interface ListFieldsByRefResult {
  ok: boolean;
  fields?: GroupFieldInfo[];
  error?: string;
}

/** 字段清单：复合 id → 分节字段（含空坑）；普通组 id → 转发 listGroupFields。 */
export async function listFieldsByRef(uid: string, ref: string): Promise<ListFieldsByRefResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const { groupId, section } = splitContentRef(ref);
  if (!section) return listGroupFields(uid, groupId);

  const group = findTemplateGroup(uid, groupId);
  if (!group) return { ok: false, error: 'template group not found' };
  const fields = group.fields.filter((f) => (f.section || '') === section);
  if (!fields.length && !group.entries.some((e) => (e.section || '') === section)) {
    return { ok: false, error: 'section not found' };
  }
  const { roleTemplateFieldStatus } = await import('./personal_ontology_contract');
  return {
    ok: true,
    fields: fields.map((f) => {
      const status = roleTemplateFieldStatus(group.templateId || '', section, f.name);
      return {
        name: f.name,
        isRelation: f.isRelation,
        description: f.description,
        values: group.values.filter((v) => v.fieldId === f.id).map(poValueToLine),
        sectionTitle: section,
        status,
        isCustom: status !== 'active',
      };
    }),
  };
}

// ── 模板状态（渲染层 templates.list 用）──────────────────────────────────

export interface TemplateStatusSection {
  title: string;
  fields: Array<{
    name: string;
    values: FieldValue[];
    status: 'active' | 'retired' | 'custom';
  }>;
}

export interface TemplateStatus {
  template_id: string;
  name: string;
  description: string;
  version: string;
  installed: boolean;
  installed_version?: string;
  /** 已安装时的组 id（复合 id 基座）。 */
  group_id?: string;
  /** 已安装时分节内容（含空坑与已填值）。 */
  sections?: TemplateStatusSection[];
  /** 模板捆绑资源（角色空间 = 本体模板 + skill + task agent 打通的数据源）。 */
  bundle?: { skill_ids: string[]; agent_ids: string[] };
}

/** 内置模板安装状态 + 分节内容；字段从 JSON 读（新存储是唯一事实来源）。 */
export async function listTemplateStatus(uid: string): Promise<TemplateStatus[]> {
  if (!safeId(uid)) return [];
  const { roleTemplateFieldStatus: fieldStatus } = await import('./personal_ontology_contract');
  const doc = loadPoDocSync(uid);
  return listRoleTemplates().map((t) => {
    const row = doc.groups.find((g) => g.kind === 'template' && g.templateId === t.template_id);
    let sections: TemplateStatusSection[] | undefined;
    if (row) {
      sections = catalogSectionsOf(row).map((s) => ({
        title: s.title,
        fields: s.fields.map((name) => {
          const field = row.fields.find((f) => (f.section || '') === s.title && f.name === name);
          return {
            name,
            values: field ? row.values.filter((v) => v.fieldId === field.id).map(poValueToLine) : [],
            status: fieldStatus(t.template_id, s.title, name),
          };
        }),
      }));
    }
    return {
      template_id: t.template_id,
      name: t.name,
      description: t.description,
      version: t.version,
      installed: !!row,
      installed_version: row?.templateVersion,
      group_id: row?.id,
      sections,
      bundle: t.bundle ? { skill_ids: t.bundle.skill_ids || [], agent_ids: t.bundle.agent_ids || [] } : undefined,
    };
  });
}

/** 测试支撑缝：直接设置已装模板的实例版本（v1 时代测试用 writeGroups 掰
 *  台账版本行，v2 的版本列在组上，等价缝在这里）。非 IPC 面。 */
export async function setTemplateInstalledVersionForTest(
  uid: string,
  templateId: string,
  version: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const current = loadPoDocSync(uid).groups.find((g) => g.kind === 'template' && g.templateId === templateId);
  if (!current) return { ok: false, error: 'template group not found' };
  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(current.id);
    if (!group) return ctx.fail('template group not found');
    group.templateVersion = version;
    group.updatedAt = nowIso();
  });
}

// ── v1 兼容迁移入口 + 启动钩子 ───────────────────────────────────────────

export interface MigrateLegacyResult {
  ok: boolean;
  /** 迁移的 template_id 数。 */
  migrated: number;
  /** 移入备份目录的旧组文件数。 */
  groups_moved: number;
  error?: string;
}

/**
 * v1 兼容入口：真正的迁移在 po/store（v1 markdown → JSON 文档，组与历史全量
 * 保全）。v1 的「旧式模板组 → 模板文件」合并已经是历史——v1 导入直接产出
 * kind='template' 的组。这里只负责触发迁移并报告。
 */
export async function migrateLegacyTemplateGroups(uid: string): Promise<MigrateLegacyResult> {
  if (!safeId(uid)) return { ok: false, migrated: 0, groups_moved: 0, error: 'invalid uid' };
  try {
    const doc = await ensurePoDoc(uid);
    return { ok: true, migrated: 0, groups_moved: 0 };
  } catch (err) {
    return { ok: false, migrated: 0, groups_moved: 0, error: (err as Error).message };
  }
}

// ── 启动时幂等迁移（deferred boot）：v1 导入 + 已装模板 schema reconcile ──

registerDeferred(
  'personal-ontology-template-migrate',
  async () => {
    try {
      if (!hasActiveUser()) return;
      const uid = getActiveUserId();
      await ensurePoDoc(uid);
      const { reconcileInstalledRoleTemplates } = await import('./personal_ontology_migration');
      const results = await reconcileInstalledRoleTemplates(uid);
      if (results.length) {
        log.info('boot: installed role templates reconciled', {
          uid,
          templates: results.length,
          migrated: results.filter((r) => r.outcome === 'migrated').length,
        });
      }
    } catch (err) {
      log.warn('boot: template migration failed', { error: (err as Error).message });
    }
  },
  'serial',
  1000,
  { resourceClass: 'disk' },
);
