/**
 * po/migrate — v1（markdown 台账 + 组文件 + .history）一次性导入 v2 JSON。
 *
 * 触发时机：读路径发现 JSON 文档不存在而 v1 目录存在（loadPoDocSync →
 * importFromV1Sync；写路径/启动钩子走 ensurePoDoc 完成持久化 + 备份）。
 *
 * 数据保全原则：
 * - 组 id / 组标题 / 字段名 / 值及其全部元数据（来源/时间锚/核实/规则分类/
 *   敏感性/资产归属）原样保留——旧 opaque ref、@ 引用、矛盾检测、注入链不断；
 * - .history 下的旧 .md 快照逐版转成 v2 JSON 快照（po-history/），audit.jsonl
 *   原样复制（行格式本来就没变）；
 * - 只有台账没有的组（v1 的「已删除分组」）从最新快照复活进回收站 trash；
 * - 迁移不删除任何用户数据：整个 v1 目录先备份到 local（backupV1Dir，在
 *   持久化之前调用），台账 groups.md 备份后移除（其信息已进 JSON）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userLocalRoot, userOntologyGroupsDir } from '../../paths';
import { genId12, nowIso, safeId } from '../../storage';
import { createLogger } from '../../logger';
import {
  isTemplateFileText,
  parseGroupContent,
  parseGroupsMarkdown,
  parseTemplateContent,
  type FieldValue,
  type GroupMeta,
} from './dialect';
import { getRoleTemplate } from '../role_templates';
import { emptyPoDocument, sanitizePoText, type PoDocument, type PoEntry, type PoField, type PoGroup, type PoValue } from './model';
import { poHistoryDir } from './store';

const log = createLogger('po-migrate');

const HISTORY_DIR = '.history';
const HISTORY_MAX_PER_GROUP = 50;

function readTextSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

/** v1 内容文件绝对路径（与旧 resolveGroupFileAbsPathFromMeta 同一套安全规则）。 */
function resolveV1ContentPath(uid: string, meta: GroupMeta): string {
  const prefix = '.personal_ontology_groups/';
  const rel = meta.rel_path || `${meta.group_id}.md`;
  if (rel.startsWith(prefix) && !rel.includes('..')) {
    return path.join(userOntologyGroupsDir(uid), rel.slice(prefix.length));
  }
  if (!/^[A-Za-z0-9_-]+$/.test(meta.group_id)) return '';
  return path.join(userOntologyGroupsDir(uid), `${meta.group_id}.md`);
}

/** 方言值行 → PoValue（元数据全保留；id/时间戳为导入时新生成）。 */
function toPoValue(v: FieldValue, fieldId: string): PoValue {
  const at = nowIso();
  return {
    id: genId12(),
    fieldId,
    text: sanitizePoText(v.value),
    source: v.source || '手动',
    ...(v.project ? { project: v.project } : {}),
    ...(v.asOf ? { asOf: v.asOf } : {}),
    ...(v.verified !== undefined ? { verified: v.verified } : {}),
    ...(v.ruleKind ? { ruleKind: v.ruleKind } : {}),
    ...(v.sensitivity === 'restricted' ? { restricted: true } : {}),
    ...(v.recallAssetId ? { assetId: v.recallAssetId } : {}),
    createdAt: at,
    updatedAt: at,
  };
}

/** 从一段快照/组正文重建组（kind 自动判别；标题取模板标题，普通组回退 fallback）。 */
function buildGroupFromText(id: string, fallbackTitle: string, text: string, meta?: GroupMeta): PoGroup | null {
  const at = meta?.created_at || nowIso();
  if (isTemplateFileText(text)) {
    const content = parseTemplateContent(text);
    const group: PoGroup = {
      id,
      title: sanitizePoText(content.title) || sanitizePoText(fallbackTitle),
      kind: 'template',
      templateId: content.template_id || meta?.template_id,
      templateVersion: content.version || meta?.template_version,
      installedAt: content.installed_at || undefined,
      fields: [],
      values: [],
      entries: [],
      createdAt: at,
      updatedAt: meta?.updated_at || at,
    };
    for (const section of content.sections) {
      for (const name of Object.keys(section.fields)) {
        const field: PoField = {
          id: genId12(),
          name: sanitizePoText(name, 200),
          origin: 'schema',
          section: sanitizePoText(section.title, 200),
          createdAt: at,
        };
        if (!field.name) continue;
        group.fields.push(field);
        for (const fv of section.fields[name] || []) group.values.push(toPoValue(fv, field.id));
      }
      for (const text0 of section.flowEntries) {
        const entry: PoEntry = { id: genId12(), text: sanitizePoText(text0, 4000), section: sanitizePoText(section.title, 200), createdAt: at };
        if (entry.text) group.entries.push(entry);
      }
    }
    return group;
  }
  const content = parseGroupContent(text);
  const group: PoGroup = {
    id,
    title: sanitizePoText(fallbackTitle) || id,
    kind: 'user',
    fields: [],
    values: [],
    entries: [],
    createdAt: at,
    updatedAt: meta?.updated_at || at,
  };
  for (const name of Object.keys(content.fields)) {
    const field: PoField = { id: genId12(), name: sanitizePoText(name, 200), origin: 'user', createdAt: at };
    if (!field.name) continue;
    group.fields.push(field);
    for (const fv of content.fields[name] || []) group.values.push(toPoValue(fv, field.id));
  }
  for (const text0 of content.entries) {
    const entry: PoEntry = { id: genId12(), text: sanitizePoText(text0, 4000), createdAt: at };
    if (entry.text) group.entries.push(entry);
  }
  return group;
}

/** 旧 .history/<gid>/ 里的快照文件名（ISO 时间戳，24 字符 + 可选 -NN 序号）。 */
function snapshotSavedFromFileName(fileName: string): string {
  const raw = fileName.slice(0, 24).replace(/-/g, (m, i) => (i === 4 || i === 7 ? '-' : i === 13 || i === 16 ? ':' : i === 19 ? '.' : m));
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? nowIso() : new Date(ms).toISOString();
}

/** 把旧 .md 快照目录转成 v2 JSON 快照 + 返回可用于复活的组状态列表（新→旧）。 */
function convertHistoryDir(uid: string, groupId: string, histDir: string): PoGroup[] {
  const out: PoGroup[] = [];
  try {
    if (!fs.existsSync(histDir)) return out;
    const files = fs.readdirSync(histDir).filter((f) => f.endsWith('.md')).sort();
    const targetDir = poHistoryDir(uid, groupId);
    fs.mkdirSync(targetDir, { recursive: true });
    // audit.jsonl 行格式未变，原样复制。
    const auditSrc = path.join(histDir, 'audit.jsonl');
    const auditDst = path.join(targetDir, 'audit.jsonl');
    if (fs.existsSync(auditSrc) && !fs.existsSync(auditDst)) fs.copyFileSync(auditSrc, auditDst);
    for (const fileName of files.slice(-HISTORY_MAX_PER_GROUP)) {
      try {
        const text = readTextSafe(path.join(histDir, fileName));
        if (!text.trim()) continue;
        const savedAt = snapshotSavedFromFileName(fileName);
        const group = buildGroupFromText(groupId, groupId, text);
        if (!group) continue;
        out.push(group);
        const dstName = `${fileName.replace(/\.md$/, '')}.json`;
        if (!fs.existsSync(path.join(targetDir, dstName))) {
          fs.writeFileSync(path.join(targetDir, dstName), JSON.stringify({ group, savedAt }, null, 2), 'utf8');
        }
      } catch { /* 单版快照坏档跳过 */ }
    }
  } catch (err) {
    log.warn('po migrate: history convert failed', { uid, groupId, error: (err as Error).message });
  }
  return out;
}

/**
 * 同步 v1 导入。返回 null = v1 目录不存在（新用户，无事可做）；返回空文档 =
 * 目录在但没有可导入内容（同样结清，调用方据此不再重扫）。
 */
export function importFromV1Sync(uid: string): PoDocument | null {
  if (!safeId(uid)) return null;
  const dir = userOntologyGroupsDir(uid);
  if (!fs.existsSync(dir)) return null;

  const doc = emptyPoDocument();
  doc.migratedFromV1At = nowIso();

  const metas = parseGroupsMarkdown(readTextSafe(path.join(dir, 'groups.md')));
  const liveIds = new Set(metas.map((m) => m.group_id));

  for (const meta of metas) {
    try {
      const abs = resolveV1ContentPath(uid, meta);
      const text = abs ? readTextSafe(abs) : '';
      const group = buildGroupFromText(meta.group_id, meta.title || meta.group_id, text, meta);
      if (group) doc.groups.push(group);
    } catch (err) {
      log.warn('po migrate: group import failed; skipped', { uid, groupId: meta.group_id, error: (err as Error).message });
    }
  }

  // 阶段 B 遗留（台账带 template_id 但内容是双区组文件）：并进该模板的
  // 模板组——值/流水按组标题对号入座，自定义字段保留，不丢任何用户数据。
  const legacyByTemplate = new Map<string, { group: PoGroup; title: string }[]>();
  for (const meta of metas) {
    if (!meta.template_id) continue;
    const group = doc.groups.find((g) => g.id === meta.group_id);
    if (!group || group.kind !== 'user') continue;
    const arr = legacyByTemplate.get(meta.template_id) || [];
    arr.push({ group, title: meta.title });
    legacyByTemplate.set(meta.template_id, arr);
  }
  for (const [templateId, legacies] of legacyByTemplate) {
    let templateGroup = doc.groups.find((g) => g.kind === 'template' && g.templateId === templateId);
    if (!templateGroup) {
      // 模板没有模板文件行但目录里有种子（v1 迁移从 catalog 建空模板再并入）——同款行为。
      const catalog = getRoleTemplate(templateId);
      if (!catalog) continue; // 目录都没有：legacy 组按普通组保留（数据不丢）
      const now = nowIso();
      templateGroup = {
        id: genId12(),
        title: catalog.name,
        kind: 'template',
        templateId,
        templateVersion: catalog.version,
        installedAt: now,
        fields: catalog.preset_groups.flatMap((preset) => preset.fields.map((f) => ({
          id: genId12(), name: f.name, isRelation: f.isRelation || undefined,
          description: f.description, section: preset.title, origin: 'schema' as const,
          createdAt: now,
        }))),
        values: [],
        entries: [],
        createdAt: now,
        updatedAt: now,
      };
      doc.groups.push(templateGroup);
    }
    for (const { group } of legacies) {
      const section = sanitizePoText(group.title, 200) || '未命名';
      for (const field of group.fields) {
        const fieldId = genId12();
        templateGroup.fields.push({ ...field, id: fieldId, section, origin: 'user' });
        for (const value of group.values.filter((v) => v.fieldId === field.id)) {
          templateGroup.values.push({ ...value, id: genId12(), fieldId });
        }
      }
      for (const entry of group.entries) {
        templateGroup.entries.push({ ...entry, id: genId12(), section });
      }
      const idx = doc.groups.findIndex((g) => g.id === group.id);
      if (idx !== -1) doc.groups.splice(idx, 1);
      log.info('po migrate: legacy stage-B group merged into template', { uid, templateId, section });
    }
  }

  // .history：活组转快照；孤儿目录（台账无行）= v1 已删除分组 → 复活进回收站。
  try {
    const histRoot = path.join(dir, HISTORY_DIR);
    if (fs.existsSync(histRoot)) {
      for (const name of fs.readdirSync(histRoot)) {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
        const histDir = path.join(histRoot, name);
        if (!fs.statSync(histDir).isDirectory()) continue;
        const converted = convertHistoryDir(uid, name, histDir);
        if (liveIds.has(name)) continue;
        const newest = converted[0];
        if (!newest) continue;
        doc.trash.push({ group: newest, deletedAt: nowIso() });
      }
    }
  } catch (err) {
    log.warn('po migrate: trash revival failed', { uid, error: (err as Error).message });
  }

  const valueCount = doc.groups.reduce((n, g) => n + g.values.length, 0);
  log.info('po v1 import scanned', { uid, groups: doc.groups.length, trash: doc.trash.length, values: valueCount });
  return doc;
}

/**
 * 备份整个 v1 目录到 local（不同步、退出 kb 索引视野），随后移除已退役的
 * groups.md 台账。组内容 .md 文件保留在原地——它们从今天起是渲染副本，
 * 会被渲染同步逐个覆写成与 JSON 一致的规范字节。
 */
export function backupV1Dir(uid: string): string | null {
  try {
    const dir = userOntologyGroupsDir(uid);
    if (!fs.existsSync(dir)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(userLocalRoot(uid), `ontology-v1-backup-${stamp}`);
    fs.cpSync(dir, dest, { recursive: true, force: false, errorOnExist: false });
    try { fs.rmSync(path.join(dir, 'groups.md'), { force: true }); } catch { /* 尽力而为 */ }
    log.info('po v1 dir backed up', { uid, backup: path.basename(dest) });
    return dest;
  } catch (err) {
    log.warn('po v1 backup failed (migration continues)', { uid, error: (err as Error).message });
    return null;
  }
}
