/**
 * po/model — 个人本体 v2 数据模型（结构化 JSON 单一事实源）。
 *
 * 2026-09-29 重构：告别「markdown 当数据库」。个人本体的全部状态收进一个
 * JSON 文档（`<uid>/cloud/cognition/personal-ontology.json`，与本体图谱
 * ontology-graph.json 同目录、同耐久级别：参与云同步、原子写、schemaVersion）。
 *
 * 四个业务概念，一一对应界面：
 *   PoGroup  分组   —— 主题容器。kind='user' 用户自建；kind='template' 角色模板安装实例。
 *   PoField  字段   —— 组内的属性槽（如「常用工具」）。模板组里分 T-box 声明（origin='schema'）
 *                      与用户自建（origin='user'）；普通组全是用户自建。
 *   PoValue  字段值 —— 一条具体事实。来源 / 时间锚 / 核实 / 规则分类 / 敏感性 /
 *                      资产投影归属全部是**一等列**，不再是行内标记。
 *   PoEntry  流水   —— 组内不结构化的一条记录（「记一笔」）。
 *
 * 与 v1 的兼容由 po/view.ts（渲染方言副本）与旧模块转出层负责；本文件只管
 * 数据本身的形状与防御性修复（normalizeDocument）。
 */

import { genId12, nowIso } from '../../storage';

export const PO_SCHEMA_VERSION = 2;

/** 规则分类（值的一等列）。undefined = 未分类。 */
export type PoRuleKind = 'operation' | 'preference' | 'constraint';

/** 单条字段值。 */
export interface PoValue {
  /** 稳定 id（v1 按值文本寻址是病根之一；新模型一律按 id）。 */
  id: string;
  /** 所属字段 id。 */
  fieldId: string;
  /** 事实文本（单行；写入侧 sanitizePoText 兜底）。 */
  text: string;
  /** 来源：候选 / 手动 / 导入 / 智能（方言层归一化口径）。 */
  source: string;
  /** 来源项目 id（可选）。 */
  project?: string;
  /** 信息截至年月 YYYY-MM（可选）。 */
  asOf?: string;
  /** 核实：true=有来源支持；'independent'=独立核实。缺省未核实。 */
  verified?: boolean | 'independent';
  /** 规则分类（可选）。 */
  ruleKind?: PoRuleKind;
  /** 敏感性：true = 仅自己可见（不进任务注入与世界模型）。 */
  restricted?: boolean;
  /** 正式认知资产投影归属：带此标记的值由来源资产维护（只读、同步时先清后写）。 */
  assetId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 字段（属性槽）。 */
export interface PoField {
  id: string;
  name: string;
  /** 关系字段（R-box）：值形如 `A → B`。 */
  isRelation?: boolean;
  description?: string;
  /** 模板组：所属分节名。普通组恒为 undefined（单区）。 */
  section?: string;
  /** schema = 模板 T-box 声明的坑；user = 用户自建（普通组全部是 user）。 */
  origin: 'schema' | 'user';
  createdAt: string;
}

/** 流水条目（「记一笔」）。 */
export interface PoEntry {
  id: string;
  text: string;
  /** 模板组：所属分节名。普通组恒为 undefined。 */
  section?: string;
  createdAt: string;
}

/** 分组。 */
export interface PoGroup {
  /** 与 v1 的 group_id 同空间（迁移原样保留；聊天草稿里的 @ 引用不失效）。 */
  id: string;
  title: string;
  kind: 'user' | 'template';
  /** kind='template'：模板 id（role_templates 目录键）。 */
  templateId?: string;
  /** 安装实例的实际 schema 版本（迁移 reconcile 的比较基准）。 */
  templateVersion?: string;
  installedAt?: string;
  fields: PoField[];
  values: PoValue[];
  entries: PoEntry[];
  createdAt: string;
  updatedAt: string;
}

/** 回收站条目：被删除的分组整状态保留，可恢复。 */
export interface PoTrashItem {
  group: PoGroup;
  deletedAt: string;
}

/** 个人本体文档（磁盘上的 JSON 根）。 */
export interface PoDocument {
  schemaVersion: typeof PO_SCHEMA_VERSION;
  /** 一次性 v1 导入完成时间（存在 = 不再重跑迁移）。 */
  migratedFromV1At?: string;
  groups: PoGroup[];
  trash: PoTrashItem[];
}

export function emptyPoDocument(): PoDocument {
  return { schemaVersion: PO_SCHEMA_VERSION, groups: [], trash: [] };
}

/** 单行文本兜底：换行/制表压空格、首尾去空白、控字数。 */
export function sanitizePoText(text: unknown, maxLen = 2000): string {
  let s = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, maxLen);
  // slice 按 UTF-16 码元截断可能劈开代理对（emoji 等），末尾留下孤立高代理：
  // 它落盘 JSON 后经 UTF-8 往返会变 U+FFFD，本地与云同步远端不一致。孤立
  // 代理必在末尾，砍 1 码元即愈、不引入 U+FFFD；读写都过此处，存量脏数据
  // 下次读写自愈。maxLen 语义不变（按码元封顶，不按码点翻倍）。
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  return s;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function normalizeRuleKind(v: unknown): PoRuleKind | undefined {
  return v === 'operation' || v === 'preference' || v === 'constraint' ? v : undefined;
}

function normalizeVerified(v: unknown): boolean | 'independent' | undefined {
  if (v === true || v === 'independent') return v;
  return undefined;
}

/** 修复一个字段值（防御外部/旧数据：缺 id 补 id、非法枚举丢弃、文本单行化）。 */
function normalizeValue(raw: any, fieldId: string): PoValue | null {
  const text = sanitizePoText(raw?.text ?? raw?.value, 100_000);
  if (!text) return null;
  const value: PoValue = {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : genId12(),
    fieldId,
    text,
    source: asString(raw?.source) || '手动',
    createdAt: asString(raw?.createdAt) || nowIso(),
    updatedAt: asString(raw?.updatedAt) || asString(raw?.createdAt) || nowIso(),
  };
  if (typeof raw?.project === 'string' && raw.project) value.project = raw.project;
  if (typeof raw?.asOf === 'string' && raw.asOf) value.asOf = raw.asOf;
  const verified = normalizeVerified(raw?.verified);
  if (verified !== undefined) value.verified = verified;
  const ruleKind = normalizeRuleKind(raw?.ruleKind);
  if (ruleKind) value.ruleKind = ruleKind;
  if (raw?.restricted === true) value.restricted = true;
  if (typeof raw?.assetId === 'string' && raw.assetId) value.assetId = raw.assetId;
  return value;
}

/** 修复一个字段。 */
function normalizeField(raw: any): PoField | null {
  const name = sanitizePoText(raw?.name, 500);
  if (!name) return null;
  const field: PoField = {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : genId12(),
    name,
    origin: raw?.origin === 'schema' ? 'schema' : 'user',
    createdAt: asString(raw?.createdAt) || nowIso(),
  };
  if (raw?.isRelation === true) field.isRelation = true;
  if (typeof raw?.description === 'string' && raw.description) field.description = sanitizePoText(raw.description, 500);
  if (typeof raw?.section === 'string' && raw.section) field.section = sanitizePoText(raw.section, 200);
  return field;
}

/** 修复一个流水条目。 */
function normalizeEntry(raw: any): PoEntry | null {
  const text = sanitizePoText(raw?.text ?? raw, 1_000_000);
  if (!text) return null;
  const entry: PoEntry = {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : genId12(),
    text,
    createdAt: asString(raw?.createdAt) || nowIso(),
  };
  if (typeof raw?.section === 'string' && raw.section) entry.section = sanitizePoText(raw.section, 200);
  return entry;
}

/** 修复一个分组（含字段-值外键修复：fieldId 悬挂的值丢弃）。 */
function normalizeGroup(raw: any): PoGroup | null {
  const id = typeof raw?.id === 'string' && raw.id ? raw.id : genId12();
  const title = sanitizePoText(raw?.title, 500);
  if (!title) return null;
  const group: PoGroup = {
    id,
    title,
    kind: raw?.kind === 'template' ? 'template' : 'user',
    fields: [],
    values: [],
    entries: [],
    createdAt: asString(raw?.createdAt) || asString(raw?.created_at) || nowIso(),
    updatedAt: asString(raw?.updatedAt) || asString(raw?.updated_at) || nowIso(),
  };
  if (group.kind === 'template') {
    group.templateId = sanitizePoText(raw?.templateId ?? raw?.template_id, 100) || undefined;
    group.templateVersion = sanitizePoText(raw?.templateVersion ?? raw?.template_version, 40) || undefined;
    group.installedAt = asString(raw?.installedAt) || asString(raw?.installed_at) || undefined;
  }
  for (const rf of Array.isArray(raw?.fields) ? raw.fields : []) {
    const f = normalizeField(rf);
    if (f) group.fields.push(f);
  }
  const fieldIds = new Set(group.fields.map((f) => f.id));
  for (const rv of Array.isArray(raw?.values) ? raw.values : []) {
    const v = normalizeValue(rv, sanitizePoText(rv?.fieldId, 64));
    if (v && fieldIds.has(v.fieldId)) group.values.push(v);
  }
  for (const re of Array.isArray(raw?.entries) ? raw.entries : []) {
    const e = normalizeEntry(re);
    if (e) group.entries.push(e);
  }
  return group;
}

/**
 * 防御性修复：任何来源（磁盘 JSON、旧版残缺、手改坏档）的输入都修成合法
 * PoDocument。绝不让一条坏记录炸掉整个个人本体（renderer-loader 事故教训）。
 */
export function normalizePoDocument(raw: any): PoDocument {
  const doc = emptyPoDocument();
  if (!raw || typeof raw !== 'object') return doc;
  if (typeof raw.migratedFromV1At === 'string' && raw.migratedFromV1At) doc.migratedFromV1At = raw.migratedFromV1At;
  for (const rg of Array.isArray(raw.groups) ? raw.groups : []) {
    const g = normalizeGroup(rg);
    if (g) doc.groups.push(g);
  }
  for (const rt of Array.isArray(raw.trash) ? raw.trash : []) {
    const g = normalizeGroup(rt?.group);
    if (g) doc.trash.push({ group: g, deletedAt: asString(rt?.deletedAt) || nowIso() });
  }
  return doc;
}
