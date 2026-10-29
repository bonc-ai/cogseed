/**
 * po/model — 个人本体 v2 数据模型（结构化 JSON 单一事实源）。
 *
 * 个人本体的全部状态存放在一个
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
  /** 当前代码认识 2；更高值 = 未来版本写的文档，读侧透传保留（见 normalizePoDocument）。 */
  schemaVersion: number;
  /** 一次性 v1 导入完成时间（存在 = 不再重跑迁移）。 */
  migratedFromV1At?: string;
  groups: PoGroup[];
  trash: PoTrashItem[];
}

export function emptyPoDocument(): PoDocument {
  return { schemaVersion: PO_SCHEMA_VERSION, groups: [], trash: [] };
}

/**
 * 单行文本兜底：换行/制表压空格、剥控制/不可见字符、去孤立代理、首尾去
 * 空白、控字数。读写都过此处，存量脏数据下次读写自愈。
 *
 * 控制/不可见字符：C0/C1 控制（NUL/BEL/ESC…）、DEL、零宽与双向
 * 格式字符（ZWSP/ZWNJ/ZWJ/LRM/RLM/嵌入/覆盖/隔离、BOM）以及行/段分隔符
 * （U+2028/U+2029）在单行字段值里没有合法语义，只会造成视觉欺骗（RTL
 * override 反转显示）、匹配错位或撕裂方言副本（JS 正则把 2028/29 当行终止
 * 符，含它们的值行在方言 parse 中整行失配 → 原文视图保存即丢值）。写读
 * 两侧统一剥除，存量值读入时收敛。
 */
const PO_INVISIBLE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

export function sanitizePoText(text: unknown, maxLen = 2000): string {
  let s = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(PO_INVISIBLE_RE, '')
    // 孤立代理（高代理后不跟低代理 / 低代理前无高代理）：存量脏数据可能在
    // 任意位置（撕裂、坏同步），全量剥除；落盘 JSON 后经 UTF-8 往返会变
    // U+FFFD，本地与远端不一致。截断边界产生的末尾孤立高代理由下方兜底。
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '')
    .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .trim()
    .slice(0, maxLen);
  // slice 按 UTF-16 码元截断仍可能劈开代理对（emoji 等）——末尾孤立高代理
  // 砍 1 码元即愈、不引入 U+FFFD。maxLen 语义不变（按码元封顶）。
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
function normalizeValue(raw: any, fieldId: string, forward = false): PoValue | null {
  const text = sanitizePoText(raw?.text ?? raw?.value, 100_000);
  if (!text) return null;
  const value: PoValue = {
    ...(forward ? forwardRestKeys(raw, VALUE_KNOWN_KEYS) : {}),
    id: typeof raw?.id === 'string' && raw.id ? raw.id : genId12(),
    fieldId,
    text,
    source: asString(raw?.source) || '手动',
    createdAt: asString(raw?.createdAt) || nowIso(),
    updatedAt: asString(raw?.updatedAt) || asString(raw?.createdAt) || nowIso(),
  } as PoValue;
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
function normalizeField(raw: any, forward = false): PoField | null {
  const name = sanitizePoText(raw?.name, 500);
  if (!name) return null;
  const field: PoField = {
    ...(forward ? forwardRestKeys(raw, FIELD_KNOWN_KEYS) : {}),
    id: typeof raw?.id === 'string' && raw.id ? raw.id : genId12(),
    name,
    origin: raw?.origin === 'schema' ? 'schema' : 'user',
    createdAt: asString(raw?.createdAt) || nowIso(),
  } as PoField;
  if (raw?.isRelation === true) field.isRelation = true;
  if (typeof raw?.description === 'string' && raw.description) field.description = sanitizePoText(raw.description, 500);
  if (typeof raw?.section === 'string' && raw.section) field.section = sanitizePoText(raw.section, 200);
  return field;
}

/** 修复一个流水条目。 */
function normalizeEntry(raw: any, forward = false): PoEntry | null {
  const text = sanitizePoText(raw?.text ?? raw, 1_000_000);
  if (!text) return null;
  const entry: PoEntry = {
    ...(forward ? forwardRestKeys(raw, ENTRY_KNOWN_KEYS) : {}),
    id: typeof raw?.id === 'string' && raw.id ? raw.id : genId12(),
    text,
    createdAt: asString(raw?.createdAt) || nowIso(),
  } as PoEntry;
  if (typeof raw?.section === 'string' && raw.section) entry.section = sanitizePoText(raw.section, 200);
  return entry;
}

/**
 * 未来版本键透传：schemaVersion 高于当前版本的文档是新版
 * 应用写的——旧版「只认识什么留什么」的重建会把未知键静默抹除、版本号降回
 * 2，新版扩展数据在一次常规写入后单向丢失。前向模式下未知键原样保留、
 * 版本号不降级；已知键仍按本版语义规范化。
 */
function forwardRestKeys(raw: any, known: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.includes(key)) rest[key] = value;
  }
  return rest;
}

const GROUP_KNOWN_KEYS = ['id', 'title', 'kind', 'templateId', 'template_id', 'templateVersion', 'template_version', 'installedAt', 'installed_at', 'fields', 'values', 'entries', 'createdAt', 'created_at', 'updatedAt', 'updated_at'] as const;
const FIELD_KNOWN_KEYS = ['id', 'name', 'origin', 'isRelation', 'description', 'section', 'createdAt'] as const;
const VALUE_KNOWN_KEYS = ['id', 'fieldId', 'text', 'value', 'source', 'project', 'asOf', 'verified', 'ruleKind', 'restricted', 'assetId', 'recallAssetId', 'createdAt', 'updatedAt'] as const;
const ENTRY_KNOWN_KEYS = ['id', 'text', 'section', 'createdAt'] as const;

/** 修复一个分组（含字段-值外键修复：fieldId 悬挂的值丢弃）。 */
function normalizeGroup(raw: any, forward = false): PoGroup | null {
  const id = typeof raw?.id === 'string' && raw.id ? raw.id : genId12();
  const title = sanitizePoText(raw?.title, 500);
  if (!title) return null;
  const group: PoGroup = {
    ...(forward ? forwardRestKeys(raw, GROUP_KNOWN_KEYS) : {}),
    id,
    title,
    kind: raw?.kind === 'template' ? 'template' : 'user',
    fields: [],
    values: [],
    entries: [],
    createdAt: asString(raw?.createdAt) || asString(raw?.created_at) || nowIso(),
    updatedAt: asString(raw?.updatedAt) || asString(raw?.updated_at) || nowIso(),
  } as PoGroup;
  if (group.kind === 'template') {
    group.templateId = sanitizePoText(raw?.templateId ?? raw?.template_id, 100) || undefined;
    group.templateVersion = sanitizePoText(raw?.templateVersion ?? raw?.template_version, 40) || undefined;
    group.installedAt = asString(raw?.installedAt) || asString(raw?.installed_at) || undefined;
  }
  for (const rf of Array.isArray(raw?.fields) ? raw.fields : []) {
    const f = normalizeField(rf, forward);
    if (f) group.fields.push(f);
  }
  const fieldIds = new Set(group.fields.map((f) => f.id));
  for (const rv of Array.isArray(raw?.values) ? raw.values : []) {
    const v = normalizeValue(rv, sanitizePoText(rv?.fieldId, 64), forward);
    if (v && fieldIds.has(v.fieldId)) group.values.push(v);
  }
  for (const re of Array.isArray(raw?.entries) ? raw.entries : []) {
    const e = normalizeEntry(re, forward);
    if (e) group.entries.push(e);
  }
  return group;
}

/**
 * 防御性修复：任何来源（磁盘 JSON、旧版残缺、手改坏档）的输入都修成合法
 * PoDocument。绝不让一条坏记录炸掉整个个人本体。
 *
 * 两条边界：
 * - 前向保护：schemaVersion 高于当前版本的文档（新版应用所写）按透传模式
 *   修复——未知键保留、版本号不降级，一次常规写入不再单向抹除新版扩展数据。
 * - 坏组登记：title 为空的坏组仍从视图丢弃（单条坏记录不炸整库），但经
 *   `onDroppedGroup` 上报——调用方（store 读路径）按 corrupt-guard 口径登记
 *   坏档（copy 备份 + 拒写 latch），下一次写被拒，坏组不再随写入从盘上
 *   静默永久删除。
 */
export interface NormalizePoDocumentOptions {
  onDroppedGroup?: (rawGroup: unknown) => void;
}

export function normalizePoDocument(raw: any, opts: NormalizePoDocumentOptions = {}): PoDocument {
  const forward = typeof raw?.schemaVersion === 'number'
    && Number.isFinite(raw.schemaVersion) && raw.schemaVersion > PO_SCHEMA_VERSION;
  const doc = emptyPoDocument();
  if (!raw || typeof raw !== 'object') return doc;
  if (forward) {
    doc.schemaVersion = raw.schemaVersion;
    Object.assign(doc, forwardRestKeys(raw, ['schemaVersion', 'migratedFromV1At', 'groups', 'trash']));
  }
  if (typeof raw.migratedFromV1At === 'string' && raw.migratedFromV1At) doc.migratedFromV1At = raw.migratedFromV1At;
  for (const rg of Array.isArray(raw.groups) ? raw.groups : []) {
    const g = normalizeGroup(rg, forward);
    if (g) doc.groups.push(g);
    else if (opts.onDroppedGroup) opts.onDroppedGroup(rg);
  }
  for (const rt of Array.isArray(raw.trash) ? raw.trash : []) {
    const g = normalizeGroup(rt?.group, forward);
    if (g) doc.trash.push({ group: g, deletedAt: asString(rt?.deletedAt) || nowIso() });
  }
  return doc;
}
