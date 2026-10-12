/**
 * po/api — 个人本体 v2 业务 API（新 `po.*` IPC 层的唯一后端）。
 *
 * 与旧 personal_ontology_groups / personal_ontology_template_files 的区别：
 * - 全 id 寻址（fieldId/valueId/entryId），不再按值文本定位——v1 的
 *   「同文本两行只能一起改」就是文本寻址的病；
 * - 一次 `snapshot` 交付整棵结构（v1 前端要 1+N 次往返拼装三盒数据）；
 * - 值编辑一个通道带全所有列（文本/时间锚/规则分类/敏感性/核实），
 *   规则分类是**直接设档**，不是循环 toggle——「规则筛选全空、不可编辑」
 *   两个用户痛点在这里根治；
 * - 导出/导入是个人本体自己的 markdown（人读、可回灌），不再指向已退役的
 *   USER.md/MEMORY.md 导出。
 */

import { safeId, genId12, nowIso } from '../../storage';
import { createLogger } from '../../logger';
import { sanitizePoText, type PoEntry, type PoField, type PoGroup, type PoRuleKind, type PoValue } from './model';
import type { FieldValue } from './dialect';
import { editPoDoc, listPoGroupHistory, loadPoDocSync, type PoHistoryEntry } from './store';
import { getRoleTemplate } from '../role_templates';
import { roleTemplateFieldStatus } from '../personal_ontology_contract';
import { renderUserGroupMarkdown, renderTemplateGroupMarkdown } from './view';
import { parseGroupContent, parseTemplateContent, isTemplateFileText, isValidAsOfValue } from './dialect';
import {
  deleteGroup,
  renameGroup,
  createGroup,
  restoreDeletedGroup,
  listDeletedGroups,
  type DeletedGroupSummary,
} from '../personal_ontology_groups';
import {
  installTemplateFile,
  listTemplateStatus,
  uninstallTemplateFile,
  templateHasArchive,
  templateHasMemoryArchive,
  type TemplateStatus,
} from '../personal_ontology_template_files';

const log = createLogger('po-api');

// ── 快照视图 ─────────────────────────────────────────────────────────────

export interface PoSnapshotValue extends PoValue {}

export interface PoSnapshotField {
  id: string;
  name: string;
  isRelation?: boolean;
  description?: string;
  section?: string;
  origin: 'schema' | 'user';
  /** 模板组：T-box 三态。 */
  status?: 'active' | 'retired' | 'custom';
  valueIds: string[];
}

export interface PoSnapshotEntry extends PoEntry {}

export interface PoSnapshotGroup {
  id: string;
  title: string;
  kind: 'user' | 'template';
  templateId?: string;
  templateVersion?: string;
  installedAt?: string;
  /** 模板显示名（来自内置目录；未安装目录的孤儿模板组回退 templateId）。 */
  templateName?: string;
  createdAt: string;
  updatedAt: string;
  fields: PoSnapshotField[];
  values: PoSnapshotValue[];
  entries: PoSnapshotEntry[];
}

export interface PoSnapshot {
  groups: PoSnapshotGroup[];
  counts: {
    groups: number;
    facts: number;
    rules: number;
    entries: number;
  };
  deleted: DeletedGroupSummary[];
}

/** 规则形值的判定（渲染层同款口径）：关系字段，或文本含箭头，或已设分类。 */
export function isRuleShapedValue(field: PoSnapshotField | undefined, value: PoSnapshotValue): boolean {
  if (field?.isRelation) return true;
  if (value.ruleKind) return true;
  return /→|->/.test(value.text);
}

export function getPoSnapshot(uid: string): PoSnapshot {
  const doc = loadPoDocSync(uid);
  const groups: PoSnapshotGroup[] = doc.groups.map((g) => {
    const template = g.kind === 'template' ? getRoleTemplate(g.templateId || '') : undefined;
    const fields: PoSnapshotField[] = g.fields.map((f) => ({
      id: f.id,
      name: f.name,
      isRelation: f.isRelation,
      description: f.description,
      section: f.section,
      origin: f.origin,
      valueIds: g.values.filter((v) => v.fieldId === f.id).map((v) => v.id),
    }));
    if (g.kind === 'template') {
      for (const f of fields) {
        f.status = roleTemplateFieldStatus(g.templateId || '', f.section || '', f.name);
      }
    }
    return {
      id: g.id,
      title: g.title,
      kind: g.kind,
      templateId: g.templateId,
      templateVersion: g.templateVersion,
      installedAt: g.installedAt,
      templateName: template?.name || g.templateId,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      fields,
      values: g.values.map((v) => ({ ...v })),
      entries: g.entries.map((e) => ({ ...e })),
    };
  });
  const fieldById = new Map<string, PoSnapshotField>();
  for (const g of groups) for (const f of g.fields) fieldById.set(f.id, f);
  let facts = 0;
  let rules = 0;
  for (const g of groups) {
    for (const v of g.values) {
      if (isRuleShapedValue(fieldById.get(v.fieldId), v)) rules += 1;
      else facts += 1;
    }
  }
  return {
    groups,
    counts: {
      groups: groups.length,
      facts,
      rules,
      entries: groups.reduce((n, g) => n + g.entries.length, 0),
    },
    deleted: listDeletedGroups(uid),
  };
}

// ── 组（转发旧层实现，行为一致）──────────────────────────────────────────

export async function poCreateGroup(uid: string, title: string) {
  return createGroup(uid, title);
}

export async function poRenameGroup(uid: string, groupId: string, title: string) {
  return renameGroup(uid, groupId, title);
}

export async function poDeleteGroup(uid: string, groupId: string) {
  return deleteGroup(uid, groupId);
}

export async function poRestoreDeletedGroup(uid: string, groupId: string) {
  return restoreDeletedGroup(uid, groupId);
}

export function poListDeletedGroups(uid: string): DeletedGroupSummary[] {
  return listDeletedGroups(uid);
}

// ── 字段（id 寻址；模板 schema 字段只读）─────────────────────────────────

export async function poCreateField(
  uid: string,
  groupId: string,
  name: string,
  opts?: { isRelation?: boolean; section?: string },
): Promise<{ ok: boolean; field?: PoSnapshotField; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const fieldName = sanitizePoText(name, 200);
  if (!fieldName) return { ok: false, error: 'field name required' };
  let created: PoField | undefined;
  const result = await editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const section = opts?.section ? sanitizePoText(opts.section, 200) : group.kind === 'template' ? undefined : undefined;
    if (group.kind === 'template' && !section) return ctx.fail('template section required');
    if (group.fields.some((f) => (f.section || '') === (section || '') && f.name === fieldName)) {
      return ctx.fail('field already exists');
    }
    created = {
      id: genId12(),
      name: fieldName,
      isRelation: opts?.isRelation === true ? true : undefined,
      section,
      origin: 'user',
      createdAt: nowIso(),
    };
    group.fields.push(created);
    group.updatedAt = nowIso();
  });
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    field: created
      ? {
          id: created.id,
          name: created.name,
          isRelation: created.isRelation,
          description: created.description,
          section: created.section,
          origin: created.origin,
          valueIds: [],
        }
      : undefined,
  };
}

export async function poRenameField(uid: string, groupId: string, fieldId: string, name: string) {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const fieldName = sanitizePoText(name, 200);
  if (!fieldName) return { ok: false, error: 'field name required' };
  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const field = group.fields.find((f) => f.id === fieldId);
    if (!field) return ctx.fail('field not found');
    if (field.origin === 'schema') return ctx.fail('template field is read-only');
    if (group.fields.some((f) => f.id !== fieldId && (f.section || '') === (field.section || '') && f.name === fieldName)) {
      return ctx.fail('field already exists');
    }
    field.name = fieldName;
    group.updatedAt = nowIso();
  });
}

export async function poDeleteField(uid: string, groupId: string, fieldId: string) {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const field = group.fields.find((f) => f.id === fieldId);
    if (!field) return;
    if (field.origin === 'schema') return ctx.fail('template field is read-only');
    if (group.values.some((v) => v.fieldId === fieldId && v.assetId)) {
      return ctx.fail('asset_projection_read_only');
    }
    group.fields = group.fields.filter((f) => f.id !== fieldId);
    group.values = group.values.filter((v) => v.fieldId !== fieldId);
    group.updatedAt = nowIso();
  });
}

export async function poSetFieldRelationFlag(uid: string, groupId: string, fieldId: string, isRelation: boolean) {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const field = group.fields.find((f) => f.id === fieldId);
    if (!field) return ctx.fail('field not found');
    if (field.origin === 'schema') return ctx.fail('template field is read-only');
    if (isRelation) field.isRelation = true;
    else delete field.isRelation;
    group.updatedAt = nowIso();
  });
}

// ── 值（id 寻址；一通道改全列）───────────────────────────────────────────

export interface PoValueDraft {
  text: string;
  asOf?: string;
  ruleKind?: PoRuleKind | null;
}

export async function poAddValue(
  uid: string,
  groupId: string,
  fieldId: string,
  draft: PoValueDraft,
): Promise<{ ok: boolean; value?: PoSnapshotValue; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const text = sanitizePoText(draft?.text, 2000);
  if (!text) return { ok: false, error: 'empty value' };
  if (draft?.asOf !== undefined && draft.asOf !== '' && !/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/.test(draft.asOf)) {
    return { ok: false, error: 'invalid asof' };
  }
  // 与 poUpdateValue(:338-341) 同口径的枚举门（r2 补齐）：否则非法 ruleKind
  // 写成功落盘、读侧 normalizeRuleKind 剥掉——写读不对称幽灵写。null/undefined 放行。
  if (draft?.ruleKind !== undefined && draft.ruleKind !== null
    && draft.ruleKind !== 'operation' && draft.ruleKind !== 'preference' && draft.ruleKind !== 'constraint') {
    return { ok: false, error: 'invalid rule kind' };
  }
  let created: PoValue | undefined;
  const result = await editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const field = group.fields.find((f) => f.id === fieldId);
    if (!field) return ctx.fail('field not found');
    if (group.values.some((v) => v.fieldId === fieldId && v.text === text)) {
      return ctx.fail('duplicate value');
    }
    created = {
      id: genId12(),
      fieldId,
      text,
      source: '手动',
      ...(draft?.asOf ? { asOf: draft.asOf } : {}),
      ...(draft?.ruleKind ? { ruleKind: draft.ruleKind } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    group.values.push(created);
    group.updatedAt = nowIso();
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, value: created ? { ...created } : undefined };
}

export interface PoValuePatch {
  text?: string;
  asOf?: string;
  clearAsOf?: boolean;
  /** null = 清除分类（未分类）。 */
  ruleKind?: PoRuleKind | null;
  sensitivity?: 'standard' | 'restricted';
  verified?: boolean | 'independent';
}

/** 编辑一条值的任意列组合。资产投影值只读（回来源资产改）。 */
export async function poUpdateValue(
  uid: string,
  groupId: string,
  valueId: string,
  patch: PoValuePatch,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  if (patch?.text !== undefined && !sanitizePoText(patch.text, 2000)) return { ok: false, error: 'empty value' };
  if (patch?.asOf !== undefined && patch.asOf !== '' && !/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/.test(patch.asOf)) {
    return { ok: false, error: 'invalid asof' };
  }
  if (patch?.asOf !== undefined && patch.asOf !== '' && patch.clearAsOf) return { ok: false, error: 'conflicting asof params' };
  if (patch?.ruleKind !== undefined && patch.ruleKind !== null
    && patch.ruleKind !== 'operation' && patch.ruleKind !== 'preference' && patch.ruleKind !== 'constraint') {
    return { ok: false, error: 'invalid rule kind' };
  }
  // verified 取值门（r2 补齐，与同函数兄弟参数同风格）：true/'independent'/
  // false（=清除）之外拒绝——否则任意值写成功落盘、读侧剥掉，成功回执与
  // 实际效果脱节。读侧 normalizePoDocument 兜底保留不动。
  if (patch?.verified !== undefined && patch.verified !== true && patch.verified !== false && patch.verified !== 'independent') {
    return { ok: false, error: 'invalid verified' };
  }
  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const value = group.values.find((v) => v.id === valueId);
    if (!value) return ctx.fail('field value not found');
    if (value.assetId) return ctx.fail('asset_projection_read_only');
    if (patch.text !== undefined) value.text = sanitizePoText(patch.text, 2000);
    if (patch.asOf !== undefined && patch.asOf !== '') value.asOf = patch.asOf;
    else if (patch.clearAsOf) delete value.asOf;
    if (patch.ruleKind !== undefined) {
      if (patch.ruleKind === null) delete value.ruleKind;
      else value.ruleKind = patch.ruleKind;
    }
    if (patch.sensitivity !== undefined) {
      if (patch.sensitivity === 'restricted') value.restricted = true;
      else delete value.restricted;
    }
    if (patch.verified !== undefined) {
      if (patch.verified === false) delete value.verified;
      else value.verified = patch.verified;
    }
    value.updatedAt = nowIso();
    group.updatedAt = nowIso();
  });
}

export async function poDeleteValue(uid: string, groupId: string, valueId: string) {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const value = group.values.find((v) => v.id === valueId);
    if (!value) return;
    if (value.assetId) return ctx.fail('asset_projection_read_only');
    group.values = group.values.filter((v) => v.id !== valueId);
    group.updatedAt = nowIso();
  });
}

// ── 流水 ─────────────────────────────────────────────────────────────────

export async function poAddEntry(uid: string, groupId: string, text: string, opts?: { section?: string }) {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const trimmed = sanitizePoText(text, 4000);
  if (!trimmed) return { ok: false, error: 'empty content' };
  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const section = opts?.section ? sanitizePoText(opts.section, 200) : undefined;
    if (group.kind === 'template' && !section) return ctx.fail('template section required');
    group.entries.push({ id: genId12(), text: trimmed, section, createdAt: nowIso() });
    group.updatedAt = nowIso();
  });
}

export async function poDeleteEntry(uid: string, groupId: string, entryId: string) {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const before = group.entries.length;
    group.entries = group.entries.filter((e) => e.id !== entryId);
    if (group.entries.length === before) return ctx.fail('entry not found');
    group.updatedAt = nowIso();
  });
}

export async function poPromoteEntry(uid: string, groupId: string, entryId: string, fieldName: string) {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = sanitizePoText(fieldName, 200);
  if (!name) return { ok: false, error: 'field name required' };
  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const entry = group.entries.find((e) => e.id === entryId);
    if (!entry) return ctx.fail('entry not found');
    let field = group.fields.find((f) => (f.section || '') === (entry.section || '') && f.name === name);
    if (!field) {
      field = { id: genId12(), name, origin: 'user', section: entry.section, createdAt: nowIso() };
      group.fields.push(field);
    }
    group.entries = group.entries.filter((e) => e.id !== entryId);
    group.values.push({
      id: genId12(),
      fieldId: field.id,
      text: entry.text,
      source: '手动',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    group.updatedAt = nowIso();
  });
}

// ── 模板 / 历史（转发）───────────────────────────────────────────────────

export async function poInstallTemplate(uid: string, templateId: string, restoreData = false) {
  return installTemplateFile(uid, templateId, restoreData);
}

export async function poUninstallTemplate(uid: string, templateId: string, archiveMemory = false) {
  return uninstallTemplateFile(uid, templateId, archiveMemory);
}

export function poTemplateArchiveInfo(uid: string, templateId: string) {
  return { hasArchive: templateHasArchive(uid, templateId), hasMemoryArchive: templateHasMemoryArchive(uid, templateId) };
}

export function poListTemplateStatus(uid: string): Promise<TemplateStatus[]> {
  return listTemplateStatus(uid);
}

export function poListHistory(uid: string, groupId: string): PoHistoryEntry[] {
  return listPoGroupHistory(uid, groupId);
}

// ── 导出 / 导入 ──────────────────────────────────────────────────────────

/** 导出为可回灌的 markdown：`## 组名` + 用户组双区方言（规则分类、时间锚、
 *  敏感性都编码在值行里，round-trip 无损）。 */
export function poExportMarkdown(uid: string): string {
  const doc = loadPoDocSync(uid);
  const parts: string[] = ['# 个人本体导出', `> 导出时间: ${nowIso()} | 共 ${doc.groups.length} 个分组`];
  for (const group of doc.groups) {
    if (group.kind === 'template') {
      parts.push(`## ${group.title}`, renderTemplateGroupMarkdown(group));
    } else {
      parts.push(`## ${group.title}`, renderUserGroupMarkdown(group));
    }
  }
  return parts.join('\n\n') + '\n';
}

export interface PoImportPreviewValue {
  value: string;
  source?: string;
  asOf?: string;
  ruleKind?: PoRuleKind;
  restricted?: boolean;
  verified?: boolean | 'independent';
}

export interface PoImportPreviewItem {
  title: string;
  /** 同名组已存在 → 应用时合并（按字段名/文本去重），否则新建组。 */
  mergeIntoExisting: boolean;
  fields: Array<{ name: string; values: PoImportPreviewValue[] }>;
  entries: string[];
}

/** 解析导入文本（与导出同格式；也容忍纯「- 条目」列表或「字段： 值」行）。
 *  导出里组内还有 `## 字段区` / `## 流水区` 两个保留标题——它们属于组正文，
 *  不切组，原样留给 parseGroupContent。 */
export function poImportPreview(uid: string, text: string): { items: PoImportPreviewItem[]; error?: string } {
  const raw = String(text ?? '');
  if (!raw.trim()) return { items: [], error: 'empty content' };
  const doc = loadPoDocSync(uid);
  const titles = new Set(doc.groups.map((g) => g.title));

  const chunks: Array<{ title: string; body: string }> = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      const title = m[1].trim();
      if (title === '字段区' || title === '流水区') {
        if (current) current.lines.push(line);
        continue;
      }
      if (current) chunks.push({ title: current.title, body: current.lines.join('\n') });
      current = { title, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) chunks.push({ title: current.title, body: current.lines.join('\n') });

  const toPreviewValue = (v: FieldValue): PoImportPreviewValue => ({
    value: v.value,
    source: v.source,
    ...(v.asOf ? { asOf: v.asOf } : {}),
    ...(v.ruleKind ? { ruleKind: v.ruleKind } : {}),
    ...(v.sensitivity === 'restricted' ? { restricted: true } : {}),
    ...(v.verified !== undefined ? { verified: v.verified } : {}),
  });
  const items: PoImportPreviewItem[] = [];
  for (const chunk of chunks) {
    const title = sanitizePoText(chunk.title, 200);
    if (!title) continue;
    const body = chunk.body;
    let fields: Array<{ name: string; values: PoImportPreviewValue[] }> = [];
    let entries: string[] = [];
    if (isTemplateFileText(body)) {
      const content = parseTemplateContent(body);
      fields = content.sections.flatMap((s) => Object.keys(s.fields).map((name) => ({ name, values: (s.fields[name] || []).map(toPreviewValue) })));
      entries = content.sections.flatMap((s) => s.flowEntries);
    } else {
      const content = parseGroupContent(body);
      fields = Object.keys(content.fields).map((name) => ({ name, values: content.fields[name].map(toPreviewValue) }));
      entries = content.entries;
    }
    items.push({ title, mergeIntoExisting: titles.has(title), fields, entries });
  }
  return { items };
}

/** 应用导入：逐组逐字段写入（同名组合并、字段名匹配、文本去重）。 */
export async function poImportApply(uid: string, items: PoImportPreviewItem[]): Promise<{ ok: boolean; applied: number; error?: string }> {
  if (!safeId(uid)) return { ok: false, applied: 0, error: 'invalid uid' };
  if (!Array.isArray(items) || !items.length) return { ok: false, applied: 0, error: 'nothing to import' };
  let applied = 0;
  for (const item of items) {
    const title = sanitizePoText(item?.title, 200);
    if (!title) continue;
    const doc = loadPoDocSync(uid);
    let groupId = doc.groups.find((g) => g.title === title && g.kind === 'user')?.id;
    if (!groupId) {
      const created = await createGroup(uid, title);
      if (!created.ok || !created.group) continue;
      groupId = created.group.group_id;
    }
    let groupChanged = false;
    for (const f of item.fields || []) {
      const fieldName = sanitizePoText(f?.name, 200);
      if (!fieldName) continue;
      for (const pv of f.values || []) {
        const text = sanitizePoText(pv?.value, 2000);
        if (!text) continue;
        const result = await poAddValueToFieldByName(uid, groupId, fieldName, text, pv);
        if (result.ok) {
          applied += 1;
          groupChanged = true;
        }
      }
    }
    for (const entryText of item.entries || []) {
      const text = sanitizePoText(entryText, 4000);
      if (!text) continue;
      const result = await poAddEntryIfNew(uid, groupId, text);
      if (result.ok) {
        applied += 1;
        groupChanged = true;
      }
    }
    void groupChanged;
  }
  log.info('po import applied', { uid, applied, items: items.length });
  return { ok: true, applied };
}

import { editPoDoc as editDoc } from './store';

async function poAddValueToFieldByName(uid: string, groupId: string, fieldName: string, text: string, meta?: PoImportPreviewValue) {
  return editDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    let field = group.fields.find((f) => !f.section && f.name === fieldName);
    if (!field) {
      field = { id: genId12(), name: fieldName, origin: 'user', createdAt: nowIso() };
      group.fields.push(field);
    }
    if (group.values.some((v) => v.fieldId === field!.id && v.text === text)) return;
    // meta 与手写通道同口径校验（对齐 poAddValue/poUpdateValue 的 asOf 正则、
    // ruleKind 枚举、verified 取值）：导入通道不因单条坏 meta 中止，非法字段
    // 剥离、合法部分照常落盘——否则外部构造的 items 能把 `asOf: '2026-09\nBOGUS'`
    // 之类非法结构写进单一事实源，撕裂方言 md 副本并造成写读不对称。
    const asOf = typeof meta?.asOf === 'string' && isValidAsOfValue(meta.asOf) ? meta.asOf.trim() : undefined;
    const ruleKind = meta?.ruleKind === 'operation' || meta?.ruleKind === 'preference' || meta?.ruleKind === 'constraint'
      ? meta.ruleKind
      : undefined;
    const verified = meta?.verified === true || meta?.verified === 'independent' ? meta.verified : undefined;
    group.values.push({
      id: genId12(),
      fieldId: field.id,
      text,
      source: '导入',
      ...(asOf ? { asOf } : {}),
      ...(ruleKind ? { ruleKind } : {}),
      ...(meta?.restricted ? { restricted: true } : {}),
      ...(verified !== undefined ? { verified } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    group.updatedAt = nowIso();
  });
}

async function poAddEntryIfNew(uid: string, groupId: string, text: string) {
  return editDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    if (group.entries.some((e) => e.text === text)) return;
    group.entries.push({ id: genId12(), text, createdAt: nowIso() });
    group.updatedAt = nowIso();
  });
}
