/**
 * po/view — 从 v2 JSON 文档投影出两样东西：
 *
 * 1. 方言渲染副本（write-time view）：`.personal_ontology_groups/` 下的 md
 *    文件。消费者只剩 kb 检索索引、transcript 术语桥与人类调试（见
 *    po/dialect.ts 文件头）。渲染是**派生**：任何读取都应走 JSON（store），
 *    这里只为兼容那几个按路径 stat 磁盘文件的旧消费者。
 * 2. GroupMeta 视图：旧 `readGroups` 消费方（注入链 / taxonomy / rules /
 *    facts / contract / candidates）拿到的台账行形状。
 */

import type { GroupMeta, TemplateFileContent, TemplateSection } from './dialect';
import {
  serializeFieldValueLine,
  serializeGroupContent,
  serializeTemplateContent,
} from './dialect';
import type { PoEntry, PoField, PoGroup, PoValue } from './model';

/** 普通组渲染副本的 contexts 相对路径。 */
export function poUserGroupRelPath(group: PoGroup): string {
  return `.personal_ontology_groups/${group.id}.md`;
}

/** 模板组渲染副本的 contexts 相对路径（与 v1 相同：按 templateId 命名）。 */
export function poTemplateGroupRelPath(group: PoGroup): string {
  return `.personal_ontology_groups/${group.templateId}.md`;
}

export function poGroupRelPath(group: PoGroup): string {
  return group.kind === 'template' ? poTemplateGroupRelPath(group) : poUserGroupRelPath(group);
}

/** PoValue → 方言值行视图（丢 id/时间戳等 JSON 列）。 */
export function poValueToFieldValue(v: PoValue): Parameters<typeof serializeFieldValueLine>[0] {
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
 * 普通组 → 双区方言文本。字段顺序 = JSON 里的 fields 数组顺序（v1 是
 * Object.keys 顺序，迁移时按原顺序灌入，因此渲染字节与 v1 一致）。
 */
export function renderUserGroupMarkdown(group: PoGroup): string {
  const fields: Record<string, ReturnType<typeof poValueToFieldValue>[]> = {};
  for (const field of group.fields) {
    if (field.section) continue; // 理论上不会出现（普通组无分节）；防御
    fields[field.name] = group.values.filter((v) => v.fieldId === field.id).map(poValueToFieldValue);
  }
  const content = {
    fields,
    entries: group.entries.filter((e) => !e.section).map((e) => e.text),
  };
  return serializeGroupContent(content);
}

/**
 * 模板组 → 分节式方言文本。分节顺序：模板组 fields 里按分节首次出现顺序；
 * 字段顺序 = fields 数组顺序。标题/元信息行来自组上的安装实例信息。
 */
export function renderTemplateGroupMarkdown(group: PoGroup): string {
  const sectionOrder: string[] = [];
  for (const field of group.fields) {
    const section = field.section || '';
    if (!sectionOrder.includes(section)) sectionOrder.push(section);
  }
  // 有流水条目但没有任何字段的分节也要出现（极端空模板）。
  for (const entry of group.entries) {
    const section = entry.section || '';
    if (!sectionOrder.includes(section)) sectionOrder.push(section);
  }
  const sections: TemplateSection[] = sectionOrder.map((title) => ({
    title,
    fields: Object.fromEntries(
      group.fields
        .filter((f) => (f.section || '') === title)
        .map((f) => [f.name, group.values.filter((v) => v.fieldId === f.id).map(poValueToFieldValue)]),
    ),
    flowEntries: group.entries.filter((e) => (e.section || '') === title).map((e) => e.text),
  }));
  const content: TemplateFileContent = {
    title: group.title,
    template_id: group.templateId || '',
    version: group.templateVersion || '0.0.0',
    installed_at: group.installedAt || group.createdAt,
    sections,
  };
  return serializeTemplateContent(content);
}

/** 渲染一个组的方言副本文本（按 kind 分流）。 */
export function renderGroupMarkdown(group: PoGroup): string {
  return group.kind === 'template' ? renderTemplateGroupMarkdown(group) : renderUserGroupMarkdown(group);
}

/**
 * 渲染副本专用出口：restricted 值的正文以固定占位符替代，
 * 其余标记（来源/项目/时间锚/核实/规则分类/@restricted/@asset）原样保留——
 * 副本因此继续进 kb 检索索引与 transcript 术语桥，但不携带受限正文。
 *
 * 仅 store.syncGroupRender 写盘用这条出口；编辑器原文视图（readGroupContent）、
 * 历史预览与模板卸载归档（重装恢复要按原文重建值）仍走 renderGroupMarkdown，
 * 本人授权视图与读路径不变。占位符是机器副本（kb/术语桥/调试打开）里的定界
 * 文本，不作为 UI 文案消费，因此不进四语 locales。
 */
export const RESTRICTED_VALUE_PLACEHOLDER = '[受限值]';

/** 渲染写盘用的副本文本：restricted 值占位化（无受限值时与原文渲染逐字节一致）。 */
export function renderGroupMarkdownCopy(group: PoGroup): string {
  if (!group.values.some((v) => v.restricted)) return renderGroupMarkdown(group);
  const redacted: PoGroup = {
    ...group,
    values: group.values.map((v) => (v.restricted ? { ...v, text: RESTRICTED_VALUE_PLACEHOLDER } : v)),
  };
  return renderGroupMarkdown(redacted);
}

/** PoGroup → 旧 GroupMeta（台账行视图；template_name 由 IPC 层照旧运行时附加）。 */
export function poGroupToMeta(group: PoGroup): GroupMeta {
  return {
    group_id: group.id,
    title: group.title,
    rel_path: poGroupRelPath(group),
    created_at: group.createdAt,
    updated_at: group.updatedAt,
    ...(group.kind === 'template'
      ? { template_id: group.templateId, template_version: group.templateVersion }
      : {}),
  };
}

/** 导出方便：字段/条目/值类型再输出（store 内部签 名用到）。 */
export type { PoEntry, PoField, PoGroup, PoValue };
