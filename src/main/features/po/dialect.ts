/**
 * po/dialect — 个人本体「文本方言」的唯一定义。
 *
 * 2026-09-29 个人本体重构：存储已经换成结构化 JSON 单文档（po/store.ts），
 * 个人本体目录 `.personal_ontology_groups/` 里的 markdown 文件从「数据库」
 * 降级为「写时渲染的视图副本」——它们只剩三个消费者：
 *   1. kb 检索索引（search.upsertContext 按路径 stat 磁盘文件）；
 *   2. transcript_ontology_bridge 的术语收集（直接 readdir 读 .md）；
 *   3. 人类调试（文件还能直接打开看）。
 *
 * 本文件就是那份被渲染出来的方言的语法书：值行 `- <值> [<来源>] @标记…`、
 * 普通组双区（`## 字段区` / `## 流水区`）、模板文件分节式（`> 模板:` 元信息
 * + `## 分节` + `### 字段`）。全部是从旧 personal_ontology_groups /
 * personal_ontology_template_files 原样迁来的纯函数——语义一个字没改，
 * 改的只是家。旧模块从那里转出导出，消费方零改动。
 */

import { ENTRY_SEPARATOR } from '../memory';

// ── 值行模型 ─────────────────────────────────────────────────────────────

/** 单条字段值（方言行 `- <值> [<来源>]` + `@` 标记的结构化视图）。 */
export interface FieldValue {
  value: string;
  source: string;
  /** 可选：由正式认知资产投影的值。仅用于运行时回查当前资产与授权；不作为独立事实。 */
  recallAssetId?: string;
  /** 可选：来源项目 id（落盘 `@proj:<pid>`，展示层映射项目名）。缺省 = 全局/手动。 */
  project?: string;
  /** 可选：信息截至年月（落盘 `@asof:YYYY-MM`）。缺省 = 未标注（不参与时效判断）。 */
  asOf?: string;
  /** 可选：用户已核实（`@verified` 裸标记=有来源支持；`@verified:independent`
   *  =独立核实过）。缺省 = 未核实。 */
  verified?: boolean | 'independent';
  /** 可选：规则分类：operation 操作规则 / preference 偏好 / constraint 约束。
   *  落盘 `@kind:<v>`。缺省 = 未分类。 */
  ruleKind?: 'operation' | 'preference' | 'constraint';
  /** 可选：敏感性：restricted 的值不进任务注入与世界模型 ontologyFacts。
   *  落盘 `@restricted`。缺省 = standard。 */
  sensitivity?: 'restricted';
}

/** 字段值来源：候选（技能预判）/ 手动（用户填写）/ 导入 / 智能（LLM 路由）。
 *  解析缺省/非法值归一化为 `手动`。 */
export const FIELD_VALUE_SOURCES = ['候选', '手动', '导入', '智能'] as const;
export type FieldValueSource = (typeof FIELD_VALUE_SOURCES)[number];

/** 非法来源归一化为 `手动`（防技能侧乱写来源标记污染展示）。 */
export function normalizeSource(source: string): string {
  const trimmed = String(source ?? '').trim();
  return (FIELD_VALUE_SOURCES as readonly string[]).includes(trimmed) ? trimmed : '手动';
}

/** 受限值摘要：只记 `[受限]` + 长度，正文绝不进台账。 */
export function summarizeFieldValue(fv: FieldValue): string {
  return fv.sensitivity === 'restricted' ? `[受限] ${fv.value.length}` : fv.value;
}

// ── 时间锚 ───────────────────────────────────────────────────────────────

/** `@asof:` 合法年月：1900-2099 年 + 01-12 月。写错的（如 2026-13）不认作
 *  asOf 也不落 project——它显然是想写时间，落 project 会把笔误当项目 id。 */
const ASOF_MARKER_RE = /^asof:((?:19|20)\d{2})-(0[1-9]|1[0-2])$/;

/** asof 超龄判定（月差 > 12 = 可能过时）。12 个月是提醒阈值不是判死：稳定的
 *  事实（出生年）到龄也只标不改，删除/刷新权在用户。 */
export const ASOF_STALE_MONTHS = 12;

/** 纯函数：某条 asOf（YYYY-MM）距今是否超龄。非法输入返回 false（无从判断
 *  就不制造噪音，与"无 asof 不标"同一原则）。 */
export function isStaleAsOf(asOf: string | undefined, now: Date = new Date()): boolean {
  if (typeof asOf !== 'string') return false;
  const match = asOf.match(/^((?:19|20)\d{2})-(0[1-9]|1[0-2])$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const monthsSince = (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month);
  return monthsSince > ASOF_STALE_MONTHS;
}

/** 组内容文件的结构化视图：字段区（多值）+ 流水区（条目数组）。 */
export interface GroupContent {
  fields: Record<string, FieldValue[]>;
  entries: string[];
}

/* ── 时间锚三态：表单语义。时间栏预填现有值；用户没动 = 保留（缺省）；
 * 清空 = 显式删除（clearAsOf）；填了新值 = 设置（asOf）。区分靠表单 dirty
 * 检测，不靠猜。只校验格式（1900-2099 + 01-12），过去的合法日期**不拒收**
 * ——超龄是标记不是判死（isStaleAsOf 同一哲学）。 */

export interface AsOfControl {
  asOf?: string;
  clearAsOf?: boolean;
}

export type AsOfControlResolution =
  | { ok: true; mode: 'keep' | 'set' | 'clear'; asOf?: string }
  | { ok: false; error: 'invalid asof' | 'conflicting asof params' };

/** 三态裁决唯一处：格式复用 `ASOF_MARKER_RE` 的语义。同时给 asOf + clearAsOf → 报错。 */
export function resolveAsOfControl(control: AsOfControl): AsOfControlResolution {
  const hasSet = control.asOf !== undefined;
  const hasClear = control.clearAsOf === true;
  if (hasSet && hasClear) return { ok: false, error: 'conflicting asof params' };
  if (hasSet) {
    const candidate = String(control.asOf ?? '').trim();
    if (!candidate) return { ok: false, error: 'invalid asof' };
    if (!ASOF_MARKER_RE.test(`asof:${candidate}`)) return { ok: false, error: 'invalid asof' };
    return { ok: true, mode: 'set', asOf: candidate };
  }
  if (hasClear) return { ok: true, mode: 'clear' };
  return { ok: true, mode: 'keep' };
}

/** `asof:` 值合法性（不含前缀的 YYYY-MM）。 */
export function isValidAsOfValue(asOf: string): boolean {
  return ASOF_MARKER_RE.test(`asof:${String(asOf ?? '').trim()}`);
}

// ── 值行 parse / serialize ───────────────────────────────────────────────

/** 把流水区文本按 ENTRY_SEPARATOR 切成条目数组（逐段 trim、滤空）。 */
export function splitFlowEntries(text: string): string[] {
  return String(text ?? '')
    .split(ENTRY_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 匹配 `- <值> [<来源>]`（可选多个 `@` 标记：`@proj:<pid>` 项目、
 *  `@asof:<YYYY-MM>` 信息截至时间，顺序不限）；值内的 `\\[` 转义在此还原为 `[`。
 *  无 `[来源]` 后缀的裸值行也解析（来源默认 `手动`）。
 *  `@proj:` 前缀剥离存 pid；`asof:` 前缀合法年月存 asOf、写错忽略（笔误的
 *  时间不该落进 project 冒充项目 id）；其他形态宽容保留原样（原行为）。 */
export function parseFieldValueLine(line: string): FieldValue | null {
  if (typeof line !== 'string') return null;
  const withSource = line.match(/^- (.+) \[(\S+)\]((?: @\S+)*)$/);
  if (withSource) {
    const out: FieldValue = {
      value: withSource[1].replace(/\\\[/g, '['),
      source: withSource[2],
    };
    const markers = withSource[3].match(/@(\S+)/g) || [];
    for (const raw of markers) {
      const marker = raw.slice(1);
      if (marker === 'verified') {
        out.verified = true; // 裸标记=有来源支持（存量兼容）；先于前缀判断，防掉进 project
      } else if (marker === 'verified:independent') {
        out.verified = 'independent'; // 独立核实过（两档中更强的一档）
      } else if (marker.startsWith('proj:')) {
        out.project = marker.slice('proj:'.length);
      } else if (marker.startsWith('asof:')) {
        if (ASOF_MARKER_RE.test(marker)) out.asOf = marker.slice('asof:'.length);
      } else if (marker.startsWith('asset:')) {
        const assetId = marker.slice('asset:'.length);
        if (/^[A-Za-z0-9_-]{1,128}$/.test(assetId)) out.recallAssetId = assetId;
      } else if (marker === 'kind:operation' || marker === 'kind:preference' || marker === 'kind:constraint') {
        out.ruleKind = marker.slice('kind:'.length) as FieldValue['ruleKind'];
      } else if (marker === 'restricted') {
        out.sensitivity = 'restricted';
      } else {
        out.project = marker;
      }
    }
    return out;
  }
  const bare = line.match(/^- (.+)$/);
  if (!bare) return null;
  return { value: bare[1].replace(/\\\[/g, '['), source: '手动' };
}

/** 序列化单条值行：值内 `[` 转义为 `\\[`，避免与来源标记冲突；带项目/截至
 *  时间/核实则依次追加 `@proj:<pid>`、`@asof:<YYYY-MM>`、`@verified`。 */
export function serializeFieldValueLine(fv: FieldValue): string {
  const base = `- ${String(fv.value).replace(/\[/g, '\\[')} [${fv.source}]`;
  const withProject = fv.project ? `${base} @proj:${fv.project}` : base;
  const withAsOf = fv.asOf ? `${withProject} @asof:${fv.asOf}` : withProject;
  let withVerified = withAsOf;
  if (fv.verified === 'independent') withVerified = `${withVerified} @verified:independent`;
  else if (fv.verified) withVerified = `${withVerified} @verified`;
  if (fv.ruleKind) withVerified = `${withVerified} @kind:${fv.ruleKind}`;
  if (fv.sensitivity === 'restricted') withVerified = `${withVerified} @restricted`;
  if (fv.recallAssetId && /^[A-Za-z0-9_-]{1,128}$/.test(fv.recallAssetId)) withVerified = `${withVerified} @asset:${fv.recallAssetId}`;
  return withVerified;
}

// ── 普通组双区格式 ───────────────────────────────────────────────────────

export const FIELD_ZONE_HEADER = '## 字段区';
export const FLOW_ZONE_HEADER = '## 流水区';

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
 * 解析组内容文本。无 `## 字段区` 标题 = 旧纯文本格式，全文按流水区解析
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

// ── 台账（groups.md）parse/serialize —— 仅 v1 迁移导入还在读 ─────────────

/** 台账组行元数据。rel_path 相对 contexts 根（`.personal_ontology_groups/<file>`）。 */
export interface GroupMeta {
  group_id: string;
  title: string;
  /** Relative to `userContextsDir(uid)`, e.g. `.personal_ontology_groups/<id>.md`. */
  rel_path: string;
  created_at: string;
  updated_at: string;
  /** 可选：来源角色模板（模板文件服务写入，`- 模板:` 台账行）。 */
  template_id?: string;
  template_version?: string;
  /** 运行时附加（IPC 层填充，不落盘）：模板显示名（如「学生」），供渲染层做层级展示。 */
  template_name?: string;
}

/** 台账字段标签 → 结构字段。 */
const GROUP_FIELD_LABELS: Record<string, string> = {
  '标题': 'title',
  '文件': 'rel_path',
  '创建时间': 'created_at',
  '更新时间': 'updated_at',
  '模板': 'template_ref',
};

/** 台账模板行值格式：`<template_id>@<semver>`。 */
const TEMPLATE_REF_RE = /^([a-z0-9_-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** semver（含预发布后缀）形状校验。 */
export function isValidTemplateVersion(version: string): boolean {
  return TEMPLATE_REF_RE.test(`x@${String(version ?? '')}`);
}

/** `.personal_ontology_groups/<groupId>.md`（contexts 相对路径）。 */
export function groupFileRelPathFromContextsRoot(groupId: string): string {
  return `.personal_ontology_groups/${groupId}.md`;
}

/** 解析台账（groups.md）文本 → GroupMeta[]。坏块跳过不抛。 */
export function parseGroupsMarkdown(text: string): GroupMeta[] {
  const blocks = String(text ?? '').split(/\n(?=###\s+\S)/).map((b) => b.trim()).filter((b) => b.startsWith('### '));
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
    // 可选模板行：非法值按无模板处理。
    if (raw.template_ref) {
      const tm = raw.template_ref.match(TEMPLATE_REF_RE);
      if (tm) {
        meta.template_id = tm[1];
        meta.template_version = tm[2];
      }
    }
    out.push(meta);
  }
  return out;
}

/** 序列化台账文本（仅 v1 兼容工具用；新存储不再写台账）。 */
export function serializeGroupsMarkdown(groups: GroupMeta[]): string {
  const header = `# 记忆分组\n\n> 最后更新: ${new Date().toISOString()} | 共 ${groups.length} 个分组\n`;
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

// ── 模板文件分节式方言 ───────────────────────────────────────────────────

/** 模板文件元信息行：`> 模板: <id>@<semver>[ | 已安装: <ISO>]`。
 *  捕获组：1 = template_id，2 = 版本（支持 semver 预发布后缀），3 = 已安装时间。 */
export const TEMPLATE_FILE_META_RE =
  /^>\s*模板:\s*([a-z0-9_-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s*\|\s*已安装:\s*(.+))?$/;

/** 文件是否携带模板元信息行（= 模板文件，按分节式解析）。 */
export function isTemplateFileText(text: string): boolean {
  if (typeof text !== 'string') return false;
  return text.split('\n').some((line) => TEMPLATE_FILE_META_RE.test(line.trim()));
}

/** 模板文件里的一个分节：字段小节（空坑 = key 存在但值为空数组）+ 分节级流水。 */
export interface TemplateSection {
  /** 分节名（原 preset_group title，如「课程」）。 */
  title: string;
  fields: Record<string, FieldValue[]>;
  flowEntries: string[];
}

/** 模板文件的结构化视图。 */
export interface TemplateFileContent {
  /** 文件标题（`# <title>（模板）`）。 */
  title: string;
  template_id: string;
  version: string;
  installed_at: string;
  sections: TemplateSection[];
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

function parseSectionBody(body: string): { fields: Record<string, FieldValue[]>; flowEntries: string[] } {
  const fields: Record<string, FieldValue[]> = {};
  const flowEntries: string[] = [];
  for (const block of splitByHeading(body, '###')) {
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
  return { fields, flowEntries };
}

/** 解析模板文件。标题/元信息行从全文提取；`## 分节` 按文件顺序解析。 */
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
    const m = line.match(TEMPLATE_FILE_META_RE);
    if (m) {
      template_id = m[1];
      version = m[2];
      installed_at = (m[3] || '').trim();
      break;
    }
  }

  const sections: TemplateSection[] = [];
  for (const block of splitByHeading(raw, '##')) {
    const { fields, flowEntries } = parseSectionBody(block.body);
    // v1 语义：只要有 `###` 块（含空 `### 流水`）就保留分节——空坑分节
    // （挖空清单）在 serialize→parse 往返里不能丢。
    if (!Object.keys(fields).length && !flowEntries.length && !block.body.includes('###')) continue;
    sections.push({ title: block.title, fields, flowEntries });
  }

  return { title, template_id, version, installed_at, sections };
}

/** 序列化一个分节：`## 分节` + `### 字段` 小节（含空坑）+ `### 流水`。 */
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

/** 模板分节式文件的轻量字段汇总：跨分节合并所有 `### <字段名>` 小节
 *  （含空坑与值，文件顺序）。仅提取字段名+值；isRelation/description 由
 *  调用方按模板 T-box 补充。 */
export function collectTemplateFileFields(text: string): Array<{ name: string; values: FieldValue[]; sectionTitle?: string }> {
  const out: Array<{ name: string; values: FieldValue[]; sectionTitle?: string }> = [];
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
      out.push({ name, values, sectionTitle: sections[i].trim() });
    }
  }
  return out;
}
