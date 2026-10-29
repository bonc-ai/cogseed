/**
 * Personal Ontology Groups — 「个人本体分组」业务层。
 *
 * 存储已经换成结构化 JSON 单文档（po/store.ts：`<uid>/cloud/cognition/
 * personal-ontology.json`）。本文件保留 v1 的全部导出名与返回形状——注入链
 * （facts/taxonomy/rules）、矛盾检测、候选确认、contract 都还在消费它们——
 * 但全部实现改为操作新模型：字段值不是带 `@` 标记的文本行，而是有 id 与
 * 一等列（来源/时间锚/核实/规则分类/敏感性/资产归属）的对象。
 *
 * `.personal_ontology_groups/` 下的 md 文件降级为写时渲染的视图副本
 * （kb 索引 / transcript 术语桥 / 人类调试在读），不再是事实来源；本文件
 * 仍转出那份方言的 parse/serialize 纯函数（唯一定义在 po/dialect.ts）。
 */

import * as fs from 'node:fs';
import { nowIso, safeId } from '../storage';
import { ENTRY_SEPARATOR } from './memory';
import { getRoleTemplate } from './role_templates';
import { createLogger } from '../logger';
import {
  appendPoAudit,
  editPoDoc,
  listPoGroupHistory,
  loadPoDocSync,
  readPoGroupAudit,
  readPoGroupSnapshot,
  type PoAuditLine,
  type PoAuditOpts,
  type PoHistoryEntry,
} from './po/store';
import type { PoEntry, PoField, PoGroup, PoValue } from './po/model';
import { sanitizePoText } from './po/model';
import { poGroupRelPath, poGroupToMeta } from './po/view';

const log = createLogger('personal-ontology-groups');

// ── 方言层转出（唯一定义在 po/dialect.ts；导出名是消费方契约）────────────

export {
  FIELD_ZONE_HEADER,
  FLOW_ZONE_HEADER,
  FIELD_VALUE_SOURCES,
  ASOF_STALE_MONTHS,
  TEMPLATE_FILE_META_RE,
  splitFlowEntries,
  isStaleAsOf,
  resolveAsOfControl,
  parseFieldValueLine,
  serializeFieldValueLine,
  parseGroupContent,
  serializeGroupContent,
  parseGroupsMarkdown,
  serializeGroupsMarkdown,
  normalizeSource,
  summarizeFieldValue,
  isValidTemplateVersion,
  isTemplateFileText,
  collectTemplateFileFields,
} from './po/dialect';
export type {
  FieldValue,
  GroupContent,
  GroupMeta,
  AsOfControl,
  AsOfControlResolution,
} from './po/dialect';

import type {
  AsOfControl,
  FieldValue,
  GroupContent,
  GroupMeta,
} from './po/dialect';
import {
  normalizeSource,
  parseFieldValueLine,
  parseGroupContent,
  resolveAsOfControl,
  serializeFieldValueLine,
  summarizeFieldValue,
} from './po/dialect';

// 兼容别名：v1 从这里导出这组结果类型；形状不变。
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

export type OntologyAuditLine = PoAuditLine;
export type OntologyAuditOpts = PoAuditOpts;
export type GroupHistoryEntry = PoHistoryEntry;

// ── 读取（同步，注入链在用）──────────────────────────────────────────────

/** 台账视图（旧形状）：全部组（含模板组）。消费方：注入链 / contract / 候选。 */
export function readGroups(uid: string): GroupMeta[] {
  return loadPoDocSync(uid).groups.map(poGroupToMeta);
}

export { readGroups as readGroupsSync };

export async function listGroups(uid: string): Promise<GroupMeta[]> {
  if (!safeId(uid)) throw new Error('invalid uid');
  return readGroups(uid);
}

// ── 组 CRUD ──────────────────────────────────────────────────────────────

export async function createGroup(uid: string, title: string): Promise<GroupResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const trimmedTitle = sanitizePoText(title, 200);
  if (!trimmedTitle) return { ok: false, error: 'title required' };

  const { poGenId } = await import('./po/store');
  let meta: GroupMeta | undefined;
  const result = await editPoDoc(uid, (ctx) => {
    const now = nowIso();
    const group: PoGroup = {
      id: poGenId(),
      title: trimmedTitle,
      kind: 'user',
      fields: [],
      values: [],
      entries: [],
      createdAt: now,
      updatedAt: now,
    };
    ctx.doc.groups.push(group);
    ctx.touch(group.id);
    meta = poGroupToMeta(group);
  });
  if (!result.ok) return { ok: false, error: result.error };
  log.info('ontology group created', { uid, groupId: meta?.group_id });
  return { ok: true, group: meta };
}

/** 普通分组改名。拒绝模板组（显示名归模板目录，改这里会分叉出第三套事实）。 */
export async function renameGroup(uid: string, groupId: string, newTitle: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const trimmedTitle = sanitizePoText(newTitle, 200);
  if (!trimmedTitle) return { ok: false, error: 'title required' };

  const result = await editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    if (group.kind === 'template') return ctx.fail('role_template_group');
    const oldTitle = group.title;
    group.title = trimmedTitle;
    group.updatedAt = nowIso();
    appendPoAudit(uid, groupId, 'group_rename', { beforeSummary: oldTitle, afterSummary: trimmedTitle });
  });
  return result;
}

/**
 * 普通分组删除：整状态进文档回收站（trash），可从「已删除分组」恢复。
 * 拒绝模板组（下架走 uninstallTemplateFile，要归档 + 清理全局记忆）。
 */
export async function deleteGroup(uid: string, groupId: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const result = await editPoDoc(uid, (ctx) => {
    const idx = ctx.doc.groups.findIndex((g) => g.id === groupId);
    if (idx === -1) return ctx.fail('group not found');
    const group = ctx.doc.groups[idx];
    if (group.kind === 'template') return ctx.fail('role_template_group');
    ctx.doc.groups.splice(idx, 1);
    ctx.doc.trash.push({ group, deletedAt: nowIso() });
    ctx.markRemoved(poGroupRelPath(group));
    appendPoAudit(uid, groupId, 'group_delete', { beforeSummary: group.title });
    log.info('ontology group deleted', { uid, groupId });
  });
  return result;
}

/** 组内容（方言文本视图；从 JSON 现渲染，不读磁盘副本）。 */
export async function readGroupContent(uid: string, groupId: string): Promise<GroupContentResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const group = loadPoDocSync(uid).groups.find((g) => g.id === groupId);
  if (!group) return { ok: false, error: 'group not found' };
  const { renderGroupMarkdown } = await import('./po/view');
  return { ok: true, content: renderGroupMarkdown(group) };
}

/**
 * 整体覆写（组管理编辑器的「原文」视图）：把提交的方言文本解析回结构化
 * 状态（尽量保留既有 id）。模板组转发 writeTemplateFileContent（模板元数据
 * 与资产投影只读的守卫在那边）。
 */
export async function writeGroupContent(uid: string, groupId: string, content: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const body = typeof content === 'string' ? content : '';
  const doc = loadPoDocSync(uid);
  const current = doc.groups.find((g) => g.id === groupId);
  if (!current) return { ok: false, error: 'group not found' };
  if (current.kind === 'template') {
    const templateFiles = await import('./personal_ontology_template_files');
    return templateFiles.writeTemplateFileContent(uid, groupId, body);
  }

  const parsed = parseGroupContent(body);
  const result = await editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    // 资产投影守卫（与模板侧 writeTemplateFileContent 同口径）。提交文本
    // 里的 @asset: 行只允许「与现盘投影逐条一致」的回显（原文编辑器原样保存
    // 走得通）；伪造（凭空新增）、篡改（改文本/标记）、删除（漏提交）一律拒绝
    // ——投影值由来源资产维护，不经全文覆写通道。
    const previousProjections = assetProjectionSignaturesOf(group);
    const submittedProjections = Object.entries(parsed.fields)
      .flatMap(([name, fvs]) => fvs.filter((fv) => fv.recallAssetId).map((fv) => JSON.stringify([name, serializeFieldValueLine(fv)])))
      .sort();
    if (previousProjections.length !== submittedProjections.length
      || previousProjections.some((sig, i) => sig !== submittedProjections[i])) {
      return ctx.fail('asset_projection_read_only');
    }
    // id 保全：同名字段沿用旧 id；同字段内同文本值沿用旧值 id。
    const oldByName = new Map(group.fields.map((f) => [f.name, f]));
    const nextFields: PoField[] = [];
    const nextValues: PoValue[] = [];
    for (const name of Object.keys(parsed.fields)) {
      const old = oldByName.get(name);
      const field: PoField = old
        ? { ...old }
        : { id: `f${Math.random().toString(16).slice(2, 10)}`, name, origin: 'user', createdAt: nowIso() };
      nextFields.push(field);
      const oldValues = group.values.filter((v) => v.fieldId === (old?.id ?? ''));
      const usedIds = new Set<string>();
      for (const fv of parsed.fields[name]) {
        const prior = oldValues.find((v) => v.text === fv.value && !usedIds.has(v.id));
        const id = prior ? (usedIds.add(prior.id), prior.id) : `v${Math.random().toString(16).slice(2, 10)}`;
        usedIds.add(id);
        nextValues.push(poLineToValue(fv, field.id, { id, createdAt: prior?.createdAt }));
      }
    }
    const oldEntryIds = new Map(group.entries.map((e) => [e.text, e.id]));
    const nextEntries: PoEntry[] = parsed.entries.map((text, i) => ({
      id: oldEntryIds.get(text) || `e${Math.random().toString(16).slice(2, 10)}${i}`,
      text,
      createdAt: nowIso(),
    }));
    group.fields = nextFields;
    group.values = nextValues;
    group.entries = nextEntries;
    group.updatedAt = nowIso();
  });
  return result;
}

/** 方言值行 → PoValue。keep.id 由调用方传入（prior 命中时为旧值 id，保全
 *  值身份——po.values.* 按 id 寻址、cognition 对象身份哈希含该 id）；prior
 *  命中同时带上原 createdAt 保住值龄，updatedAt 刷新为本次保存时间。 */
function poLineToValue(fv: FieldValue, fieldId: string, keep: { id: string; createdAt?: string }): PoValue {
  const now = nowIso();
  return {
    id: keep.id,
    fieldId,
    text: fv.value,
    source: fv.source || '手动',
    ...(fv.project ? { project: fv.project } : {}),
    ...(fv.asOf ? { asOf: fv.asOf } : {}),
    ...(fv.verified !== undefined ? { verified: fv.verified } : {}),
    ...(fv.ruleKind ? { ruleKind: fv.ruleKind } : {}),
    ...(fv.sensitivity === 'restricted' ? { restricted: true } : {}),
    ...(fv.recallAssetId ? { assetId: fv.recallAssetId } : {}),
    createdAt: keep.createdAt || now,
    updatedAt: now,
  };
}

/** 追加一条流水（「记一笔」）。 */
export async function appendToGroup(uid: string, groupId: string, text: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const trimmed = sanitizePoText(text, 1_000_000);
  if (!trimmed) return { ok: false, error: 'empty content' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    if (group.kind === 'template') return ctx.fail('template_section_required');
    group.entries.push({ id: `e${Math.random().toString(16).slice(2, 10)}`, text: trimmed, createdAt: nowIso() });
    group.updatedAt = nowIso();
  });
}

// ── 字段值操作（全部按 id 落点、按文本兼容寻址）─────────────────────────

/** 写后矛盾检查：fire-and-forget，只报忧不报喜。 */
function fireConflictCheck(uid: string, groupId: string, fieldName: string, value: string, existing: Array<{ value: string; restricted: boolean }>): void {
  if (!existing.length) return;
  void import('./recall/ontology-conflicts')
    .then((m) => m.checkNewValueAgainst(uid, groupId, fieldName, value, existing))
    .catch(() => {});
}

function existingSnapshotOf(group: PoGroup, fieldId: string): Array<{ value: string; restricted: boolean }> {
  return group.values.filter((v) => v.fieldId === fieldId).map((v) => ({ value: v.text, restricted: v.restricted === true }));
}

/**
 * 字段区追加一条值。字段小节不存在则创建（普通组自由建；模板组分节下的
 * 自由建坑等价于自定义字段）。完全匹配（同值同源同项目）去重跳过。
 */
export async function appendFieldValue(
  uid: string,
  groupId: string,
  fieldName: string,
  value: string,
  source: string,
  project?: string,
  asOf?: string,
  asOfControl?: AsOfControl,
): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
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

  let snapshot: Array<{ value: string; restricted: boolean }> = [];
  let appended = false;
  const result = await editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    if (group.kind === 'template') return ctx.fail('template_section_required');
    let field = group.fields.find((f) => !f.section && f.name === name);
    if (!field) {
      field = { id: `f${Math.random().toString(16).slice(2, 10)}`, name, origin: 'user', createdAt: nowIso() };
      group.fields.push(field);
    }
    snapshot = existingSnapshotOf(group, field.id);
    if (group.values.some((v) => v.fieldId === field!.id && v.text === val && v.source === src && (v.project ?? undefined) === proj)) {
      return; // 完全匹配去重
    }
    group.values.push({
      id: `v${Math.random().toString(16).slice(2, 10)}`,
      fieldId: field.id,
      text: val,
      source: src,
      ...(proj ? { project: proj } : {}),
      ...(validAsOf ? { asOf: validAsOf } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    appended = true;
    group.updatedAt = nowIso();
    appendPoAudit(uid, groupId, 'value_add', { field: name, afterSummary: summarizeFieldValue({ value: val, source: src }) });
  });
  if (result.ok && appended) fireConflictCheck(uid, groupId, name, val, snapshot);
  return result;
}

/** 按值文本替换（保留原行的来源与全部标记）。 */
export async function setFieldValue(
  uid: string,
  groupId: string,
  fieldName: string,
  oldValue: string,
  newValue: string,
  asOfControl?: AsOfControl,
): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = sanitizePoText(fieldName, 200);
  const next = sanitizePoText(newValue, 2000);
  if (!name) return { ok: false, error: 'field name required' };
  if (!next) return { ok: false, error: 'empty value' };
  if (asOfControl) {
    const resolved = resolveAsOfControl(asOfControl);
    if (!resolved.ok) return resolved;
  }

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    if (group.kind === 'template') return ctx.fail('template_section_required');
    const field = group.fields.find((f) => !f.section && f.name === name);
    if (!field) return ctx.fail('field value not found');
    const value = group.values.find((v) => v.fieldId === field.id && v.text === oldValue);
    if (!value) return ctx.fail('field value not found');
    if (value.assetId) return ctx.fail('asset_projection_read_only');
    const beforeSummary = summarizeFieldValue(poValueToLine(value));
    value.text = next;
    if (asOfControl?.asOf !== undefined) value.asOf = asOfControl.asOf;
    else if (asOfControl?.clearAsOf === true) delete value.asOf;
    value.updatedAt = nowIso();
    group.updatedAt = nowIso();
    appendPoAudit(uid, groupId, 'value_edit', { field: name, beforeSummary, afterSummary: summarizeFieldValue(poValueToLine(value)) });
  });
}

/** 核实档设置：false 取消 / true 有来源支持 / 'independent' 独立核实。 */
export async function setFieldValueVerified(
  uid: string,
  groupId: string,
  fieldName: string,
  value: string,
  level: boolean | 'independent',
): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = sanitizePoText(fieldName, 200);
  const val = sanitizePoText(value, 2000);
  if (!name) return { ok: false, error: 'field name required' };
  if (!val) return { ok: false, error: 'empty value' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const field = group.fields.find((f) => f.name === name && (group.kind === 'template' ? true : !f.section));
    if (!field) return ctx.fail('field value not found');
    const targets = group.values.filter((v) => v.fieldId === field.id && v.text === val);
    if (!targets.length) return ctx.fail('field value not found');
    // 资产投影值的核实档归来源资产管（与 setFieldValue/removeFieldValue 同款守卫）。
    if (targets.some((v) => v.assetId)) return ctx.fail('asset_projection_read_only');
    const next: boolean | 'independent' | undefined = level === false ? undefined : level;
    let changed = false;
    for (const v of targets) {
      if (v.verified !== next) changed = true;
      if (next === undefined) delete v.verified;
      else v.verified = next;
      v.updatedAt = nowIso();
    }
    if (changed) group.updatedAt = nowIso();
  });
}

/** 规则分类循环 toggle（兼容旧通道；新界面用 setValueRuleKind 直接设档）。 */
export async function cycleFieldValueRuleKind(
  uid: string,
  groupId: string,
  fieldName: string,
  value: string,
): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = sanitizePoText(fieldName, 200);
  const val = sanitizePoText(value, 2000);
  if (!name || !val) return { ok: false, error: 'field name or value required' };
  const ORDER: Array<'operation' | 'preference' | 'constraint' | undefined> =
    [undefined, 'operation', 'preference', 'constraint'];

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const field = group.fields.find((f) => f.name === name && (group.kind === 'template' ? true : !f.section));
    if (!field) return ctx.fail('field value not found');
    const targets = group.values.filter((v) => v.fieldId === field.id && v.text === val);
    if (!targets.length) return ctx.fail('field value not found');
    // 资产投影值的规则分类归来源资产管（同款守卫）。
    if (targets.some((v) => v.assetId)) return ctx.fail('asset_projection_read_only');
    let changed = false;
    for (const v of targets) {
      const idx = ORDER.indexOf(v.ruleKind);
      const next = ORDER[(idx + 1) % ORDER.length];
      if (v.ruleKind !== next) changed = true;
      if (next === undefined) delete v.ruleKind;
      else v.ruleKind = next;
      v.updatedAt = nowIso();
    }
    if (changed) group.updatedAt = nowIso();
  });
}

/** 敏感性 toggle（standard ⇄ restricted）。 */
export async function setFieldValueSensitivity(
  uid: string,
  groupId: string,
  fieldName: string,
  value: string,
  restricted: boolean,
): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = sanitizePoText(fieldName, 200);
  const val = sanitizePoText(value, 2000);
  if (!name) return { ok: false, error: 'field name or value required' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const field = group.fields.find((f) => f.name === name && (group.kind === 'template' ? true : !f.section));
    if (!field) return ctx.fail('field value not found');
    const targets = group.values.filter((v) => v.fieldId === field.id && v.text === val);
    if (!targets.length) return ctx.fail('field value not found');
    // 资产投影值的敏感性标记有安全语义，同样归来源资产管（同款守卫）。
    // 字段级的 restricted 判定逻辑（ontology-rules / projection-knowledge）不受影响。
    if (targets.some((v) => v.assetId)) return ctx.fail('asset_projection_read_only');
    let changed = false;
    for (const v of targets) {
      const next = restricted;
      if (v.restricted !== next) changed = true;
      if (!next) delete v.restricted;
      else v.restricted = true;
      v.updatedAt = nowIso();
    }
    if (changed) group.updatedAt = nowIso();
  });
}

/** 删掉匹配该值的行；字段空了连字段一起删（普通组语义）。 */
export async function removeFieldValue(uid: string, groupId: string, fieldName: string, value: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = sanitizePoText(fieldName, 200);
  if (!name) return { ok: false, error: 'field name required' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const field = group.fields.find((f) => f.name === name && (group.kind === 'template' ? true : !f.section));
    if (!field) return; // 字段不存在视为 no-op ok
    const targets = group.values.filter((v) => v.fieldId === field.id && v.text === value);
    if (!targets.length) return;
    if (targets.some((v) => v.assetId)) return ctx.fail('asset_projection_read_only');
    const beforeSummary = targets.map((v) => summarizeFieldValue(poValueToLine(v))).join('、');
    group.values = group.values.filter((v) => !(v.fieldId === field.id && v.text === value));
    if (group.kind === 'user' && !group.values.some((v) => v.fieldId === field.id)) {
      group.fields = group.fields.filter((f) => f.id !== field.id);
    }
    group.updatedAt = nowIso();
    appendPoAudit(uid, groupId, 'value_remove', { field: name, beforeSummary });
  });
}

/** 删整个字段（含全部值）。 */
export async function removeField(uid: string, groupId: string, fieldName: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const name = sanitizePoText(fieldName, 200);
  if (!name) return { ok: false, error: 'field name required' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const fields = group.fields.filter((f) => f.name === name && (group.kind === 'template' ? true : !f.section));
    if (!fields.length) return; // no-op ok
    if (group.values.some((v) => fields.some((f) => f.id === v.fieldId) && v.assetId)) {
      return ctx.fail('asset_projection_read_only');
    }
    const beforeSummary = group.values
      .filter((v) => fields.some((f) => f.id === v.fieldId))
      .map((v) => summarizeFieldValue(poValueToLine(v)))
      .join('、');
    const ids = new Set(fields.map((f) => f.id));
    group.fields = group.fields.filter((f) => !ids.has(f.id));
    group.values = group.values.filter((v) => !ids.has(v.fieldId));
    group.updatedAt = nowIso();
    appendPoAudit(uid, groupId, 'field_remove', { field: name, beforeSummary });
  });
}

/** 流水区：按文本删除一条。 */
export async function removeEntry(uid: string, groupId: string, entryText: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const target = sanitizePoText(entryText, 4000);
  if (!target) return { ok: false, error: 'empty entry' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    const idx = group.entries.findIndex((e) => e.text === target);
    if (idx === -1) return ctx.fail('entry not found');
    group.entries.splice(idx, 1);
    group.updatedAt = nowIso();
    appendPoAudit(uid, groupId, 'entry_remove', { beforeSummary: target });
  });
}

/** 流水条目升格为字段值（来源「手动」）。 */
export async function promoteEntryToField(uid: string, groupId: string, entryText: string, fieldName: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const target = sanitizePoText(entryText, 4000);
  const name = sanitizePoText(fieldName, 200);
  if (!target) return { ok: false, error: 'empty entry' };
  if (!name) return { ok: false, error: 'field name required' };

  return editPoDoc(uid, (ctx) => {
    const group = ctx.touch(groupId);
    if (!group) return ctx.fail('group not found');
    if (group.kind === 'template') return ctx.fail('template_section_required');
    const idx = group.entries.findIndex((e) => e.text === target);
    if (idx === -1) return ctx.fail('entry not found');
    let field = group.fields.find((f) => !f.section && f.name === name);
    if (!field) {
      field = { id: `f${Math.random().toString(16).slice(2, 10)}`, name, origin: 'user', createdAt: nowIso() };
      group.fields.push(field);
    }
    // 升格与 poAddValue/setFieldValue 同一道同文本去重门（与 po/api.ts
    // 的 poPromoteEntry 同口径）：同字段同文本已存在值时拒绝升格，流水保留
    // 不动，不再绕门落出第二条同文值。
    if (group.values.some((v) => v.fieldId === field.id && v.text === target)) {
      return ctx.fail('duplicate value');
    }
    group.entries.splice(idx, 1);
    group.values.push({
      id: `v${Math.random().toString(16).slice(2, 10)}`,
      fieldId: field.id,
      text: target,
      source: '手动',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    group.updatedAt = nowIso();
    appendPoAudit(uid, groupId, 'entry_promote', { field: name, afterSummary: target });
  });
}

// ── 字段清单（注入链 / 候选预检 / 渲染层）────────────────────────────────

export interface GroupFieldInfo {
  name: string;
  isRelation?: boolean;
  description?: string;
  values: FieldValue[];
  /** 模板组：字段 T-box 归属三态（active / retired / custom）。 */
  status?: 'active' | 'retired' | 'custom';
  /** 派生别名（旧渲染层用）：status !== 'active'。 */
  isCustom?: boolean;
  /** 模板组：字段所属分节。 */
  sectionTitle?: string;
}

export interface ListGroupFieldsResult {
  ok: boolean;
  fields?: GroupFieldInfo[];
  error?: string;
}

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

/**
 * 投影签名：一条资产投影值的身份 = 所属字段名 + 方言值行（含
 * @asset 与全部元数据标记）。整组覆写与快照回滚用它比对「提交/快照内容里
 * 的投影集合」与「现盘投影集合」：任何新增（伪造）、改文本/标记（篡改）、
 * 漏提交（删除）都不一致 → 拒绝。投影值由来源资产维护（宿主通道
 * appendRoleTemplateFieldValue 专写），全文覆写通道无权改动它们。
 */
function assetProjectionSignaturesOf(group: PoGroup): string[] {
  const signatures: string[] = [];
  for (const value of group.values) {
    if (!value.assetId) continue;
    const field = group.fields.find((f) => f.id === value.fieldId);
    signatures.push(JSON.stringify([field?.name || '', serializeFieldValueLine(poValueToLine(value))]));
  }
  return signatures.sort();
}

/**
 * 字段清单：普通组 = 实例字段；模板组 = 全部字段（含空坑）+ T-box 三态标注。
 */
export async function listGroupFields(uid: string, groupId: string): Promise<ListGroupFieldsResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const group = loadPoDocSync(uid).groups.find((g) => g.id === groupId);
  if (!group) return { ok: false, error: 'group not found' };

  const valuesOf = (fieldId: string): FieldValue[] =>
    group.values.filter((v) => v.fieldId === fieldId).map(poValueToLine);

  if (group.kind === 'user') {
    return {
      ok: true,
      fields: group.fields
        .filter((f) => !f.section)
        .map((f) => ({ name: f.name, isRelation: f.isRelation, description: f.description, values: valuesOf(f.id) })),
    };
  }

  // 模板组：三态判据来自 contract 的单一 T-box 能力。
  const { roleTemplateFieldStatus } = await import('./personal_ontology_contract');
  const template = getRoleTemplate(group.templateId || '');
  const declared = new Map<string, { isRelation?: boolean; description?: string }>();
  for (const preset of template?.preset_groups || []) {
    for (const f of preset.fields) declared.set(`${preset.title}\u0000${f.name}`, { isRelation: f.isRelation, description: f.description });
  }
  const fields: GroupFieldInfo[] = group.fields.map((f) => {
    const status = roleTemplateFieldStatus(group.templateId || '', f.section || '', f.name);
    const hint = declared.get(`${f.section || ''}\u0000${f.name}`);
    return {
      name: f.name,
      isRelation: hint?.isRelation || f.isRelation,
      description: hint?.description || f.description,
      values: valuesOf(f.id),
      sectionTitle: f.section || '',
      status,
      isCustom: status !== 'active',
    };
  });
  return { ok: true, fields };
}

// ── 历史 / 回收站 / 恢复 ─────────────────────────────────────────────────
// 写前留档走 store 的 writePoGroupSnapshot，保存整组状态。

export function listGroupHistory(uid: string, groupId: string): GroupHistoryEntry[] {
  return listPoGroupHistory(uid, groupId);
}

/** 「已删除分组」列表项。 */
export interface DeletedGroupSummary {
  groupId: string;
  title: string;
  deletedAt: string;
  snapshotCount: number;
}

export function listDeletedGroups(uid: string): DeletedGroupSummary[] {
  if (!safeId(uid)) return [];
  const doc = loadPoDocSync(uid);
  return doc.trash
    .map((item) => ({
      groupId: item.group.id,
      title: item.group.title || item.group.id,
      deletedAt: item.deletedAt,
      snapshotCount: listPoGroupHistory(uid, item.group.id).length,
    }))
    .sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : a.groupId.localeCompare(b.groupId)));
}

/** 从回收站恢复一个被删除的分组（整状态回活）。 */
export async function restoreDeletedGroup(uid: string, groupId: string): Promise<SimpleResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  return editPoDoc(uid, async (ctx) => {
    const idx = ctx.doc.trash.findIndex((t) => t.group.id === groupId);
    if (idx === -1) return ctx.fail('group not found');
    const [item] = ctx.doc.trash.splice(idx, 1);
    if (ctx.doc.groups.some((g) => g.id === groupId)) return ctx.fail('group already exists');
    // 回收站恢复不复活已清资产的投影。投影级联只扫活组是既定口径
    // （普通组/trash 不在级联面），复活入口按资产可投影性过滤——与模板归档
    // 恢复侧 dropRevivedValuesOfClearedAssets 同一判据，组件其余内容照常恢复。
    const { dropRevivedValuesOfClearedAssets } = await import('./personal_ontology_template_files');
    const dropped = await dropRevivedValuesOfClearedAssets(uid, item.group);
    if (dropped > 0) {
      log.warn('restore: dropped projection values of cleared assets', { uid, groupId, dropped });
    }
    ctx.doc.groups.push(item.group);
    ctx.touch(groupId);
    appendPoAudit(uid, groupId, 'group_restore', { afterSummary: item.group.title });
  });
}

/**
 * 恢复某版快照：当前内容先快照（可再回滚），再写回快照内容。
 * 组不在台账（已删除）→ 从回收站复活（沿用快照内容）。
 */
export async function restoreGroupSnapshot(uid: string, groupId: string, snapshotId: string): Promise<SimpleResult> {
  if (!safeId(uid) || !safeId(groupId)) return { ok: false, error: 'invalid uid or groupId' };
  if (!/^[0-9TZ-]{20,}(?:-\d{2})?$/.test(snapshotId)) return { ok: false, error: 'invalid snapshot id' };
  const snap = readPoGroupSnapshot(uid, groupId, snapshotId);
  if (!snap) return { ok: false, error: 'snapshot not found' };

  return editPoDoc(uid, async (ctx) => {
    // 先滤掉快照里已清资产（暂停/删除/清洗/type 改变）的投影值——
    // 任何恢复通道都不复活死投影（判据与模板归档恢复侧一致）。
    const { dropRevivedValuesOfClearedAssets } = await import('./personal_ontology_template_files');
    await dropRevivedValuesOfClearedAssets(uid, snap);
    let group = ctx.doc.groups.find((g) => g.id === groupId);
    if (!group) {
      // 已删除组：优先从回收站复活整状态，再叠加快照内容。
      const tIdx = ctx.doc.trash.findIndex((t) => t.group.id === groupId);
      if (tIdx !== -1) {
        const [item] = ctx.doc.trash.splice(tIdx, 1);
        group = item.group;
        ctx.doc.groups.push(group);
      } else {
        group = JSON.parse(JSON.stringify(snap)) as PoGroup;
        ctx.doc.groups.push(group);
      }
    }
    ctx.touch(groupId);
    // 快照回滚不得改写或复活投影——现盘投影集合与（已滤已清资产的）
    // 快照投影集合不一致即拒绝整个恢复（与整组覆写同口径）；一致时投影值
    // 身份/文本原样随组恢复。拒绝发生在任何落盘前，现场保持不变。
    const currentSignatures = assetProjectionSignaturesOf(group);
    const snapSignatures = assetProjectionSignaturesOf(snap);
    if (currentSignatures.length !== snapSignatures.length
      || currentSignatures.some((sig, i) => sig !== snapSignatures[i])) {
      return ctx.fail('asset_projection_read_only');
    }
    group.fields = JSON.parse(JSON.stringify(snap.fields)) as PoField[];
    group.values = JSON.parse(JSON.stringify(snap.values)) as PoValue[];
    group.entries = JSON.parse(JSON.stringify(snap.entries)) as PoEntry[];
    group.updatedAt = nowIso();
    // 摘要台账：恢复动作的「依据」= 恢复到哪版快照；零正文即零泄漏面。
    appendPoAudit(uid, groupId, 'snapshot_restore', { reason: snapshotId });
  });
}

// ── 台账 / 渲染钩子（兼容导出）──────────────────────────────────────────

export function appendOntologyAudit(uid: string, groupId: string, action: string, opts?: OntologyAuditOpts): void {
  appendPoAudit(uid, groupId, action, opts);
}

export function readGroupAudit(uid: string, groupId: string): OntologyAuditLine[] {
  return readPoGroupAudit(uid, groupId);
}

// 组渲染副本由 po/store.ts 写路径内的 touch/markRemoved 更新。

// 兼容：v1 的 ENTRY_SEPARATOR 再导出（模板文件流水分隔符）。
export { ENTRY_SEPARATOR };
