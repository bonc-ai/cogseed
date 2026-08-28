/**
 * Personal Ontology Contract — 角色模板子域对外的唯一出口。
 *
 * 收归结论（2026-08-27 会议 + 两轮真实性审计）：角色模板的定义、存储、寻址与
 * 生命周期全部归 Personal Ontology；Workspace 及其它外部消费者只保留绑定、
 * 展示与装配。本模块是那条边界。
 *
 * 外部模块**不得**再依赖下列 PO 内部概念——它们全部不出现在本文件的导出类型里：
 *   group_id / rel_path / markdown 文件路径 / `::` 复合 id 语法 /
 *   分节标题与字段名作为地址 / preset_groups / TemplateFileContent / 字段值来源与项目标记
 *
 * 外部长期允许依赖的稳定业务标识只有 `templateId`（T-box 常量 key）。其余内部
 * 对象一律通过本模块生成的 **opaque ref** 暴露：调用方原样存、原样回传，不解析、
 * 不构造。ref 里刻意**不含 group_id**——台账 group_id 每次安装由 genId12() 重新
 * 生成，卸载重装即变；ref 用 templateId + 分节/字段名寻址，重装后依然可解析。
 *
 * 四组能力（与收归任务书 Contract A/B/C/D 对应）：
 *   A 模板目录        listRoleTemplateSummaries / getRoleTemplateSummary / resolveRoleTemplateId
 *   B Runtime 角色画像 getRoleProfileForRuntime
 *   C 可 @ 引用条目    listOntologyEntries / readOntologyEntry
 *   D 可写入模板字段   listRoleTemplateFieldTargets / appendRoleTemplateFieldValue
 *
 * 另外把两处重复的 T-box 白名单（candidates.ts::tboxFields、
 * personal-profile-sync.ts::tboxCatalog）收归为 isTboxField / listTboxFieldNames，
 * 调用方不再自建 T-box 规则。
 */

import { createLogger } from '../logger';
import { safeId } from '../storage';
import {
  getRoleTemplate,
  listRoleTemplates,
  getScenario,
  listScenarios,
  type Scenario,
} from './role_templates';
import {
  buildContentRef,
  listTemplateStatus,
  parseTemplateContent,
  readContentById,
  readTemplateFileText,
  appendExistingTemplateFieldValueToRef,
  readGroups,
} from './personal_ontology_template_files';
import { listGroups } from './personal_ontology_groups';
import {
  roleTemplateFieldStatus as fieldStatus,
  type FieldSlotStatus,
} from './personal_ontology_migration';

const log = createLogger('personal-ontology-contract');

// ── Opaque ref 编解码 ──────────────────────────────────────────────────────

/** ref 前缀。`genId12()` 产出的是 12 位十六进制（无 p/o），普通组 id 与复合 id
 *  都不会以此开头，所以前缀足以把 contract ref 与历史 id 区分开。 */
const REF_PREFIX = 'po1';

/** 普通记忆分组（非模板）。分组没有模板那样的稳定业务 id，只能用 group_id。 */
interface PlainGroupRef {
  k: 'g';
  /** 台账 group_id。 */
  g: string;
}

/** 模板分节（@ Picker 的一行）。用 templateId + 分节名寻址，重装后仍有效。 */
interface TemplateSectionRef {
  k: 'ts';
  t: string;
  s: string;
}

/** 模板字段（可写入落点）。 */
interface TemplateFieldRef {
  k: 'tf';
  t: string;
  s: string;
  f: string;
}

type DecodedRef = PlainGroupRef | TemplateSectionRef | TemplateFieldRef;

function encodeRef(payload: DecodedRef): string {
  return REF_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * 解码 opaque ref。非 contract ref（历史 group_id / 复合 id）或结构非法 → null。
 * 结构校验从严：解码后的每个字段都必须是非空字符串，`k` 必须是已知种类——
 * ref 来自渲染层，按不可信输入处理。
 */
export function decodeOntologyRef(ref: unknown): DecodedRef | null {
  if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) return null;
  const body = ref.slice(REF_PREFIX.length);
  if (!body || !/^[A-Za-z0-9_-]+$/.test(body)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  if (obj.k === 'g' && str(obj.g) && safeId(obj.g)) return { k: 'g', g: obj.g };
  if (obj.k === 'ts' && str(obj.t) && safeId(obj.t) && str(obj.s)) return { k: 'ts', t: obj.t, s: obj.s };
  if (obj.k === 'tf' && str(obj.t) && safeId(obj.t) && str(obj.s) && str(obj.f)) {
    return { k: 'tf', t: obj.t, s: obj.s, f: obj.f };
  }
  return null;
}

/** 该字符串是否是本模块生成的 contract ref（不校验能否解析出实体）。 */
export function isOntologyRef(ref: unknown): boolean {
  return decodeOntologyRef(ref) !== null;
}

/**
 * contract ref → PO 内部寻址串（`group_id` 或 `group_id::分节`）。
 * 模板类 ref 在这一刻才去台账查 group_id —— 所以卸载重装换了 group_id 也不影响。
 * 模板未安装 / 分组不存在 → null。非 contract ref 原样返回（历史调用兼容）。
 */
export function resolveRefToInternalId(uid: string, ref: string): string | null {
  const decoded = decodeOntologyRef(ref);
  if (!decoded) return typeof ref === 'string' && ref ? ref : null;
  if (decoded.k === 'g') return decoded.g;
  const row = readGroups(uid).find((g) => g.template_id === decoded.t);
  if (!row) return null;
  return buildContentRef(row.group_id, decoded.s);
}

// ── Contract A：模板目录 ───────────────────────────────────────────────────

/**
 * 同步的模板目录条目。**不含安装状态**——装态要读台账，纯函数拿不到，也不该
 * 为了拿它把 resolveSpaceResources 之类的派生函数变成异步。需要装态的调用方
 * 用 listRoleTemplateSummaries / getRoleTemplateSummary。
 */
export interface RoleTemplateCatalogEntry {
  templateId: string;
  /** 默认显示名（中文源串）。有 nameKey 时应优先用 nameKey 本地化后的结果。 */
  name: string;
  description?: string;
  /**
   * 显示名的 i18n key。**key 由 PO 给出**，调用方不要自己拼
   * `ws.role_template.<id>.name` —— 收归前 Workspace 自己拼这个前缀，等于在
   * PO 之外维护了第二套模板名事实来源。渲染层按 `t(nameKey, name)` 取值即可，
   * 这样语言切换仍在渲染层实时生效（主进程不跟踪渲染层当前语言）。
   */
  nameKey: string;
  descriptionKey: string;
  version: string;
  bundle?: {
    skillIds?: string[];
    agentIds?: string[];
  };
}

export interface RoleTemplateSummary extends RoleTemplateCatalogEntry {
  installed: boolean;
}

/** 同步目录（无装态）。供 Workspace 的纯派生函数使用，替代直接 import role_templates。 */
export function listRoleTemplateCatalog(): RoleTemplateCatalogEntry[] {
  return listRoleTemplates().map((t) => toCatalogEntry(t));
}

/** 同步单查（无装态）；未知 id → undefined。 */
export function getRoleTemplateCatalogEntry(templateId: string): RoleTemplateCatalogEntry | undefined {
  const t = getRoleTemplate(templateId);
  return t ? toCatalogEntry(t) : undefined;
}

interface RoleTemplateShape {
  template_id: string;
  name: string;
  description: string;
  version: string;
  bundle?: { skill_ids: string[]; agent_ids: string[] };
}

function toCatalogEntry(t: RoleTemplateShape): RoleTemplateCatalogEntry {
  return {
    templateId: t.template_id,
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    nameKey: `ws.role_template.${t.template_id}.name`,
    descriptionKey: `ws.role_template.${t.template_id}.description`,
    version: t.version,
    ...(t.bundle
      ? { bundle: { skillIds: [...(t.bundle.skill_ids || [])], agentIds: [...(t.bundle.agent_ids || [])] } }
      : {}),
  };
}


function toSummary(t: RoleTemplateShape, installed: boolean): RoleTemplateSummary {
  return { ...toCatalogEntry(t), installed };
}

/**
 * 模板目录 + 安装状态。**不含** preset_groups / sections / 字段值 / group_id。
 * uid 非法 → 仍返回目录，但 installed 一律 false（目录本身是全局常量，
 * 不因用户态失败而消失；调用方拿不到装态时不该看到空目录）。
 */
export async function listRoleTemplateSummaries(uid: string): Promise<RoleTemplateSummary[]> {
  const installedIds = new Set<string>();
  if (safeId(uid)) {
    try {
      for (const row of readGroups(uid)) {
        if (row.template_id) installedIds.add(row.template_id);
      }
    } catch (err) {
      log.warn('template install state unavailable; catalog returned without it', {
        error: (err as Error).message,
      });
    }
  }
  return listRoleTemplates().map((t) => toSummary(t, installedIds.has(t.template_id)));
}

/** 按 templateId 取单个模板 metadata；未知 id → null。 */
export async function getRoleTemplateSummary(
  uid: string,
  templateId: string,
): Promise<RoleTemplateSummary | null> {
  const t = getRoleTemplate(templateId);
  if (!t) return null;
  let installed = false;
  if (safeId(uid)) {
    try {
      installed = readGroups(uid).some((row) => row.template_id === templateId);
    } catch { /* 装态读不到按未安装处理，不影响 metadata */ }
  }
  return toSummary(t, installed);
}

/**
 * 模板引用解析：id 精确 → 显示名模糊（忽略大小写/空白/常见分隔符）。
 * 供空间构建师草稿等「LLM 可能给出显示名当 id」的场景做后端兜底。
 * 解析不到 → undefined（调用方决定忽略还是报错）。
 */
export function resolveRoleTemplateId(raw: string): string | undefined {
  const v = String(raw || '').trim();
  if (!v) return undefined;
  const rows = listRoleTemplates();
  if (rows.some((t) => t.template_id === v)) return v;
  const norm = (s: string) => String(s || '').toLowerCase().replace(/[\s_\-./()（）]+/g, '');
  const target = norm(v);
  return rows.find((t) => norm(t.name) === target)?.template_id;
}

/** 场景目录（纯 UX 概念，不落盘）。归属未裁决，本轮先统一从 contract 出。 */
export interface RoleScenarioSummary {
  scenarioId: string;
  name: string;
  description: string;
  /** 显示名/描述的 i18n key（同 RoleTemplateCatalogEntry：key 由 PO 给出）。 */
  nameKey: string;
  descriptionKey: string;
  icon: string;
  suggestedPrimaryTemplateId?: string;
  suggestedSecondaryTemplateIds: string[];
  suggestedExtraSkills: string[];
  suggestedExtraAgents: string[];
}

function toScenarioSummary(s: Scenario): RoleScenarioSummary {
  return {
    scenarioId: s.scenario_id,
    name: s.name,
    description: s.description,
    nameKey: `ws.scenario.${s.scenario_id}.name`,
    descriptionKey: `ws.scenario.${s.scenario_id}.description`,
    icon: s.icon,
    ...(s.suggested_primary_template_id ? { suggestedPrimaryTemplateId: s.suggested_primary_template_id } : {}),
    suggestedSecondaryTemplateIds: [...s.suggested_secondary_template_ids],
    suggestedExtraSkills: [...s.suggested_extra_skills],
    suggestedExtraAgents: [...s.suggested_extra_agents],
  };
}

export function listRoleScenarios(): RoleScenarioSummary[] {
  return listScenarios().map(toScenarioSummary);
}

export function getRoleScenario(scenarioId: string): RoleScenarioSummary | undefined {
  const s = getScenario(scenarioId);
  return s ? toScenarioSummary(s) : undefined;
}

// ── Contract B：Runtime 角色画像 ───────────────────────────────────────────

/**
 * 按 templateId 读当前有效角色画像，返回**已格式化**的 system prompt 块。
 * 调用方（Workspace / runner）只拿最终文本：不接触文件、不接触分节结构、
 * 不处理来源与项目标记、不判断空坑。
 *
 * 语义（沿用收归前 spaces.ts::formatRoleProfileForSystemPrompt，产品行为不变）：
 * 主角色在前、副角色在后，按传入顺序；空坑不注入；全空 → ''；任何异常 → ''。
 */
export async function getRoleProfileForRuntime(
  uid: string,
  templateIds: ReadonlyArray<string>,
): Promise<string> {
  try {
    if (!safeId(uid) || !templateIds?.length) return '';
    const seen = new Set<string>();
    const allLines: string[] = [];
    for (const tid of templateIds) {
      if (!tid || seen.has(tid)) continue;
      seen.add(tid);
      const text = readTemplateFileText(uid, tid);
      if (!text) continue; // 未安装 / 文件缺失 → 静默跳过
      const content = parseTemplateContent(text);
      const tplName = getRoleTemplate(tid)?.name || tid;
      const lines: string[] = [];
      for (const sec of content.sections) {
        for (const [fieldName, values] of Object.entries(sec.fields)) {
          if (!values.length) continue; // 空坑不注入
          // 只取值本身：来源标记与 @proj 标记是 PO 内部账务，不进上下文
          lines.push(`- ${sec.title} · ${fieldName}: ${values.map((v) => v.value).join('、')}`);
        }
      }
      if (lines.length) allLines.push(`### 角色「${tplName}」`, ...lines);
    }
    if (!allLines.length) return '';
    return [
      `## 当前角色画像`,
      `本空间绑定了以下角色模板；以下为已记录的个人画像（来源：个人本体角色模板文件，随候选确认更新）：`,
      ...allLines,
    ].join('\n');
  } catch (err) {
    log.warn('runtime role profile unavailable; injecting nothing', {
      error: (err as Error).message,
    });
    return '';
  }
}

// ── Contract C：可 @ 引用的 Ontology Entry ─────────────────────────────────

export interface OntologyEntryRef {
  /** 不透明句柄。调用方原样存、原样回传，禁止解析或拼接。 */
  ref: string;
  label: string;
  /** 展示用分组标识（模板条目 = templateId）。**不是** PO 内部 group_id。 */
  parentId?: string;
  parentLabel?: string;
}

/**
 * 可 @ 引用的本体条目：普通记忆分组（平铺）+ 已安装模板的每个分节
 * （带 parentId/parentLabel 供渲染层折叠与搜索）。
 * 顺序：普通分组在前（台账顺序），模板分节在后（模板目录顺序 × 文件分节顺序）。
 */
export async function listOntologyEntries(uid: string): Promise<OntologyEntryRef[]> {
  if (!safeId(uid)) return [];
  const out: OntologyEntryRef[] = [];

  let groups: Awaited<ReturnType<typeof listGroups>> = [];
  try {
    groups = await listGroups(uid);
  } catch (err) {
    log.warn('ontology entry list: group ledger unreadable', { error: (err as Error).message });
    return [];
  }
  for (const g of groups) {
    if (g.template_id) continue; // 模板行走下面的分节展开
    out.push({ ref: encodeRef({ k: 'g', g: g.group_id }), label: g.title || g.group_id });
  }

  for (const status of await listTemplateStatus(uid)) {
    if (!status.installed || !status.sections?.length) continue;
    for (const sec of status.sections) {
      out.push({
        ref: encodeRef({ k: 'ts', t: status.template_id, s: sec.title }),
        label: sec.title,
        parentId: status.template_id,
        parentLabel: status.name,
      });
    }
  }
  return out;
}

export interface OntologyEntryContent {
  ok: boolean;
  content?: string;
  error?: string;
}

/**
 * 按 opaque ref 读条目内容（@ 发送时把内容注入消息）。
 * 兼容历史 id：非 contract ref 原样转给 readContentById，草稿里存量 token 不失效。
 */
export async function readOntologyEntry(uid: string, ref: string): Promise<OntologyEntryContent> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const internal = resolveRefToInternalId(uid, ref);
  if (!internal) return { ok: false, error: 'ontology entry not found' };
  return readContentById(uid, internal);
}

// ── Contract D：可写入的角色模板字段 ───────────────────────────────────────

export interface RoleTemplateFieldTarget {
  /** 不透明写入句柄。调用方只回传这一个字符串。 */
  fieldRef: string;
  /** 人读标签：`模板名 · 分节 · 字段`。 */
  label: string;
  parentId?: string;
  parentLabel?: string;
}

/**
 * 可写入落点清单 = 已安装模板 ∩ T-box 声明字段 ∩ **实例文件里真实存在的坑**。
 *
 * 三个条件缺一不可，而且必须与 buildRoleTemplateFieldRef / 自动写入通道用
 * 同一套判据 —— 「下拉里能选到」必须严格等价于「写得进去」。这里天然满足：
 * 它遍历的就是实例文件的分节与字段（listTemplateStatus 从文件读）。
 */
export async function listRoleTemplateFieldTargets(uid: string): Promise<RoleTemplateFieldTarget[]> {
  if (!safeId(uid)) return [];
  const out: RoleTemplateFieldTarget[] = [];
  for (const status of await listTemplateStatus(uid)) {
    if (!status.installed || !status.sections?.length) continue;
    for (const sec of status.sections) {
      for (const field of sec.fields) {
        if (!isTboxField(status.template_id, sec.title, field.name)) continue;
        out.push({
          fieldRef: encodeRef({ k: 'tf', t: status.template_id, s: sec.title, f: field.name }),
          label: `${status.name} · ${sec.title} · ${field.name}`,
          parentId: status.template_id,
          parentLabel: status.name,
        });
      }
    }
  }
  return out;
}

/**
 * 由 (templateId, 分节, 字段) 构造写入句柄。
 *
 * **签发前必须验到实例文件里真的有这个坑**，不能只看 catalog。只看 T-box 时，
 * catalog 新增了字段而实例还没迁移，这里照样会签出一个句柄，拿去
 * appendRoleTemplateFieldValue 却撞上 `field not found` —— 一个签得出来却写
 * 不进去的 ref 是最难查的那类 bug：路由说命中了，落点也「有」，值就是不出现。
 *
 * 判据与 listRoleTemplateFieldTargets 完全一致：T-box 声明 + 模板已安装 +
 * 实例文件里存在该分节与字段。任一不满足 → null，等于「这里不许自动写」。
 */
export async function buildRoleTemplateFieldRef(
  uid: string,
  templateId: string,
  section: string,
  fieldName: string,
): Promise<string | null> {
  if (!safeId(uid)) return null;
  if (!isTboxField(templateId, section, fieldName)) return null;
  if (!installedFieldExists(uid, templateId, section, fieldName)) return null;
  return encodeRef({ k: 'tf', t: templateId, s: section, f: fieldName });
}

/**
 * 实例文件里是否真的存在 (分节, 字段) 这个坑。
 * 未安装 / 文件缺失 / 分节或字段不存在 → false。
 */
function installedFieldExists(
  uid: string,
  templateId: string,
  section: string,
  fieldName: string,
): boolean {
  try {
    const text = readTemplateFileText(uid, templateId);
    if (!text) return false;
    const sec = parseTemplateContent(text).sections.find((s) => s.title === section);
    return Boolean(sec && Object.prototype.hasOwnProperty.call(sec.fields, fieldName));
  } catch {
    return false;
  }
}

/**
 * 反解写入句柄，**仅供回执/日志展示**。返回值不是地址：调用方不得用它去
 * 拼内部寻址串，写入一律走 appendRoleTemplateFieldValue。非 tf ref → null。
 */
export function describeRoleTemplateFieldRef(
  fieldRef: string,
): { templateId: string; section: string; fieldName: string } | null {
  const decoded = decodeOntologyRef(fieldRef);
  if (!decoded || decoded.k !== 'tf') return null;
  return { templateId: decoded.t, section: decoded.s, fieldName: decoded.f };
}

export interface AppendFieldValueResult {
  ok: boolean;
  error?: string;
  /** 写入命中的模板（回执/日志用；调用方不得据此构造地址）。 */
  templateId?: string;
}

/**
 * 按 opaque fieldRef 写入一条字段值。定位、安装状态、分节/字段存在性与
 * T-box 白名单全部在 PO 内部完成；调用方只给 fieldRef + 值 + 来源。
 * 最终落到 appendExistingTemplateFieldValueToRef —— 与手填共用同一个
 * lock / 原子写 / 台账更新 / 索引通知路径，且永不新建字段。
 */
export async function appendRoleTemplateFieldValue(
  uid: string,
  fieldRef: string,
  value: string,
  source: string,
  project?: string,
): Promise<AppendFieldValueResult> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const decoded = decodeOntologyRef(fieldRef);
  if (!decoded || decoded.k !== 'tf') return { ok: false, error: 'invalid field ref' };
  if (!isTboxField(decoded.t, decoded.s, decoded.f)) {
    return { ok: false, error: 'field is not declared by the role template' };
  }
  const row = readGroups(uid).find((g) => g.template_id === decoded.t);
  if (!row) return { ok: false, error: 'role template is not installed' };
  // T-box 声明了、实例文件里却还没有这个坑 = schema 迁移还没跑到。这与
  // 「这个字段不许自动写」是两回事，错误码必须分开：前者会自愈，后者不会。
  if (!installedFieldExists(uid, decoded.t, decoded.s, decoded.f)) {
    return { ok: false, error: 'template_migration_pending' };
  }

  const res = await appendExistingTemplateFieldValueToRef(
    uid,
    buildContentRef(row.group_id, decoded.s),
    decoded.f,
    value,
    source,
    project,
  );
  return res.ok ? { ok: true, templateId: decoded.t } : { ok: false, error: res.error };
}

// ── T-box 白名单（原 candidates.ts::tboxFields / profile-sync::tboxCatalog）──

export type { FieldSlotStatus };

/** 该字段是否由模板 T-box 声明（自动写入通道的唯一判据）。 */
export function isTboxField(templateId: string, section: string, fieldName: string): boolean {
  const template = getRoleTemplate(templateId);
  if (!template) return false;
  return template.preset_groups.some(
    (preset) => preset.title === section && preset.fields.some((f) => f.name === fieldName),
  );
}

/**
 * 字段的 T-box 归属三态（active / retired / custom）。这是 PO 对外的唯一判据，
 * 调用方不要再用「不在 T-box 清单里就是自定义」自行推断 —— 那样分不出
 * 「产品下架的官方历史字段」和「用户自己建的字段」，而这两者的处置不同：
 * 前者的值是官方画像的历史沉淀，后者是用户私有约定。
 *
 * 两者的共同点只有一条：都**不是可写落点**（见 listRoleTemplateFieldTargets）。
 */
export function roleTemplateFieldStatus(
  templateId: string,
  section: string,
  fieldName: string,
): FieldSlotStatus {
  return fieldStatus(templateId, section, fieldName);
}

/** 该模板 T-box 声明的全部字段名（跨分节扁平）。未知模板 → 空集。 */
export function listTboxFieldNames(templateId: string): ReadonlySet<string> {
  const template = getRoleTemplate(templateId);
  if (!template) return new Set<string>();
  return new Set(template.preset_groups.flatMap((p) => p.fields.map((f) => f.name)));
}
