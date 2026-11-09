/**
 * S5 Hub 模板目录：工作空间模板 / 定时任务模板的列表与详情。
 *
 * - **映射层**：Hub 字段名只在本文件出现，转成 `template_types.ts` 的客户端结构。字段按
 *   2026-10-27 冻结的 Hub S5 T-00～T-06 契约读取；后续契约变更仍只改这里。
 * - 模板不是安装物：不进 `installs.json`、不进版本库、不参与 Hub 核对节奏（research R2）。
 * - 未登录不请求（与 S4 平台内容一致）；请求体不带空间 / 任务 / 设备 id、本机路径或账号标识。
 * - 断网 / Hub 出错时回退到本机缓存（`<uid>/local/`，机器私有）；Hub 回 `NOT_SUPPORTED` 时隐藏入口。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { userLocalRoot } from '../../paths';
import { readJson, writeJson } from '../../storage';
import { satisfiesMinAppVersion } from '../../util/app-version-compat';
import { getLanguage } from '../config';
import { currentAppVersion, isMarketplaceEndpointUnsupported, postJson } from '../marketplace';
import { prefilterInstructionText, type SuspectSegment } from '../security/instruction-audit';
import { isAnonymousLocalId } from '../users';
import type {
  TaskTemplate, TaskTemplateSchedule, TemplateFillIn, TemplateProjectDirRequirement, TemplateRef, WorkspaceTemplate,
} from '../template_types';

export type TemplateType = 'workspace' | 'task';

export type CatalogError = 'offline' | 'forbidden' | 'not_supported' | 'not_found' | 'disabled' | 'invalid_template' | 'server_error';

export type TemplateBlockedReason = 'client_too_old' | 'content_too_long' | 'disabled';

export interface TemplateSummary {
  template_id: string;
  name: string;
  summary: string;
  version: string;
  min_app_version?: string;
  creatable: boolean;
  blocked_reason?: TemplateBlockedReason;
}

export interface TemplateListResult {
  ok: boolean;
  items: TemplateSummary[];
  /** 未登录：不请求，只显示内置部分与登录提示（FR-034）。 */
  signed_out?: boolean;
  /** Hub 不支持模板接口：隐藏平台模板入口（FR-080）。 */
  hidden?: boolean;
  from_cache?: boolean;
  error?: CatalogError;
}

export type TemplateDetailResult =
  | {
    ok: true;
    template: WorkspaceTemplate | TaskTemplate;
    creatable: boolean;
    blocked_reason?: TemplateBlockedReason;
    /** 本地文本风险预检命中的段落（FR-071），在表单里标出；不拦创建。 */
    risk: SuspectSegment[];
  }
  | { ok: false; error: CatalogError | 'signed_out' };

/** 与 `auto_tasks.ts` 的 `MAX_CONTENT_LEN` 一致。 */
export const TASK_CONTENT_MAX_LEN = 8000;

/** Hub 目录分页：默认 20、上限 100；按 `total` 翻页，另设页数上限防服务端异常时死循环。 */
const CATALOG_PAGE_SIZE = 100;
const MAX_CATALOG_PAGES = 20;

const PATHS: Record<TemplateType, string> = {
  workspace: '/marketplace/workspace-templates',
  task: '/marketplace/scheduled-tasks',
};

// ── 映射层（只有这里读 Hub 字段名）─────────────────────────────────────────

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const DIGEST_RUNTIME_REFERENCE_FIELDS = new Set(['availability', 'resolved_version', 'reason']);

/**
 * Frozen T-03 digest contract: sort object keys, keep array order and omit unset optional values.
 * Strings are passed to JSON.stringify unchanged, so UTF-8 bytes, whitespace and Unicode form stay intact.
 */
function canonicalizeDigestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeDigestValue(item));
  if (isObj(value)) {
    const entries = Object.entries(value)
      .filter(([, nested]) => nested !== undefined && nested !== null)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, nested]) => [key, canonicalizeDigestValue(nested)]));
  }
  return value;
}

/** Recompute the Hub-published snapshot digest without its read-time reference resolution fields. */
export function computeTemplateContentSha256(raw: Raw): string {
  const references = (Array.isArray(raw.references) ? raw.references : []).map((item) => {
    if (!isObj(item)) return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !DIGEST_RUNTIME_REFERENCE_FIELDS.has(key)));
  });
  const declaration = {
    config: isObj(raw.config) ? raw.config : {},
    fill_ins: Array.isArray(raw.fill_ins) ? raw.fill_ins : [],
    references,
  };
  const serialized = JSON.stringify(canonicalizeDigestValue(declaration));
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function hasValidContentDigest(raw: Raw): boolean {
  const expected = str(raw.config_sha256);
  return /^[0-9a-f]{64}$/.test(expected) && computeTemplateContentSha256(raw) === expected;
}

/** 多语文本：界面是英文且有 `en` 就用 `en`，否则用 `zh`；也接受纯字符串。 */
function text(v: unknown, lang: string): string {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return '';
  return (lang.startsWith('en') && str(v.en)) || str(v.zh);
}

/** Frozen config fields use suffixes (`goal_zh` / `goal_en`) instead of nested locale objects. */
function configText(config: Raw, key: string, lang: string): string {
  const localized = (lang.startsWith('en') && str(config[`${key}_en`])) || str(config[`${key}_zh`]);
  return localized || text(config[key], lang);
}

function availabilityOf(v: unknown): TemplateRef['hub_availability'] {
  return v === 'available' || v === 'missing' || v === 'disabled' || v === 'incompatible' || v === 'unknown'
    ? v
    : 'unknown';
}

function refOf(raw: Raw): TemplateRef {
  const compatMin = str(raw.min_version);
  const hubAvailability = availabilityOf(raw.availability);
  return {
    // 不认识的 source / kind 原样保留，交给 `template_refs` 判为 unknown，不在这里猜。
    source: str(raw.source) as TemplateRef['source'],
    kind: str(raw.kind) as TemplateRef['kind'],
    id: str(raw.id),
    ...(compatMin ? { compat: { min_version: compatMin } } : {}),
    hub_availability: hubAvailability,
  };
}

function refsByUsage(raw: unknown): {
  primary: TemplateRef[];
  secondary: TemplateRef[];
  execution: TemplateRef[];
  agents: TemplateRef[];
  others: TemplateRef[];
  invalidUsage: boolean;
} {
  const out = {
    primary: [] as TemplateRef[], secondary: [] as TemplateRef[], execution: [] as TemplateRef[],
    agents: [] as TemplateRef[], others: [] as TemplateRef[], invalidUsage: false,
  };
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObj(item)) continue;
    const ref = refOf(item);
    const usage = str(item.usage) || 'extra';
    if (usage === 'primary_role') out.primary.push(ref);
    else if (usage === 'secondary_role') out.secondary.push(ref);
    else if (usage === 'execution_agent') out.execution.push(ref);
    else if (usage === 'extra' && ref.kind === 'agent') out.agents.push(ref);
    else if (usage === 'extra') out.others.push(ref);
    else out.invalidUsage = true;
  }
  return out;
}

function fillInsOf(raw: unknown): TemplateFillIn[] {
  return (Array.isArray(raw) ? raw : []).filter(isObj).filter((f) => str(f.id)).map((f) => ({
    id: str(f.id),
    label_zh: str(f.label_zh) || str(f.id),
    ...(str(f.label_en) ? { label_en: str(f.label_en) } : {}),
    ...(str(f.hint) ? { hint: str(f.hint) } : {}),
  }));
}

/**
 * Hub 的 `{{id}}` 占位在客户端显示为【label】，与 `fill_ins` 声明一一对应。
 * 未声明的占位退回 id（仍是【…】），这样它既看得见、也会被创建门拦住，不静默漏成空。
 * 只转换会被预填进表单的正文 / 名称；模板自身的 `name` 不转换。
 */
export function fillTemplateText(text: string, fillIns: readonly TemplateFillIn[]): string {
  if (!text || !text.includes('{{')) return text;
  const labels = new Map(fillIns.map((f) => [f.id, f.label_zh]));
  return text.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_, id: string) => `【${labels.get(id) || id}】`);
}

/** Frozen schedule contract: weekday 0–6, 0 = Sunday; one_time carries no time. */
function scheduleOf(raw: unknown): TaskTemplateSchedule | null {
  if (!isObj(raw)) return null;
  const hm = Number.isInteger(raw.hour) && Number.isInteger(raw.minute)
    && (raw.hour as number) >= 0 && (raw.hour as number) <= 23 && (raw.minute as number) >= 0 && (raw.minute as number) <= 59;
  const hour = raw.hour as number;
  const minute = raw.minute as number;
  switch (raw.type) {
    case 'one_time': return { type: 'one_time' };
    case 'daily': return hm ? { type: 'daily', hour, minute } : null;
    case 'weekly': {
      // Hub 的 weekday 是 0–6（0 = 周日），7 会被发布校验拒绝；客户端不再替它纠正。
      const wd = raw.weekday;
      return hm && Number.isInteger(wd) && (wd as number) >= 0 && (wd as number) <= 6 ? { type: 'weekly', weekday: wd as number, hour, minute } : null;
    }
    case 'monthly':
      return hm && Number.isInteger(raw.day) && (raw.day as number) >= 1 && (raw.day as number) <= 31
        ? { type: 'monthly', day: raw.day as number, hour, minute } : null;
    default: return null;
  }
}

/** Frozen connector requirement: `{ connector_type, note_zh? }`; free-text prerequisites are not inferred. */
function connectorTypesOf(raw: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const t = isObj(item) ? str(item.connector_type) : '';
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function projectDirOf(raw: unknown): TemplateProjectDirRequirement | null {
  // Frozen contract omits this key for `none`.
  if (raw === undefined || raw === null || raw === '') return 'none';
  // The client always treats a local folder as optional. Keep accepting the
  // frozen Hub `required` value so older published templates remain usable.
  if (raw === 'required') return 'optional';
  return raw === 'optional' || raw === 'none' ? raw : null;
}

/** Hub 的身份字段是 `content_id`；客户端内部统一叫 `template_id`，只在这一层做映射。 */
function templateIdOf(raw: Raw): string {
  return str((raw as Raw & { content_id?: unknown }).content_id);
}

function base(raw: Raw, lang: string, fillIns: TemplateFillIn[]) {
  return {
    template_id: templateIdOf(raw),
    version: str(raw.version),
    status: 'published' as const,
    ...(str(raw.min_app_version) ? { min_app_version: str(raw.min_app_version) } : {}),
    name: text(raw.name, lang),
    fill_ins: fillIns,
  };
}

export function mapWorkspaceTemplate(raw: Raw, lang: string): WorkspaceTemplate | null {
  if (!templateIdOf(raw)) return null;
  const config = isObj(raw.config) ? raw.config : {};
  const refs = refsByUsage(raw.references);
  const projectDir = projectDirOf(config.project_dir);
  const fillIns = fillInsOf(raw.fill_ins);
  const suggestedName = str(config.suggested_name);
  const goal = fillTemplateText(configText(config, 'goal', lang), fillIns);
  const instructions = fillTemplateText(configText(config, 'instructions', lang), fillIns);
  // Frozen workspace templates have exactly one builtin role-template primary role.
  const roles = [...refs.primary, ...refs.secondary];
  if (!suggestedName || !goal || !instructions || projectDir === null || refs.invalidUsage || refs.execution.length || refs.primary.length !== 1
      || roles.some((ref) => ref.source !== 'builtin' || ref.kind !== 'role_template')) return null;
  return {
    ...base(raw, lang, fillIns),
    // 模板名称来自目录 / 详情，来源记录（SpaceOrigin）用它；预填名称单独放 suggested_name。
    suggested_name: fillTemplateText(suggestedName, fillIns),
    goal,
    instructions,
    project_dir: projectDir,
    role_templates: roles,
    extra_agents: refs.agents,
    extra_skills: refs.others,
    connector_types: connectorTypesOf(config.prerequisites),
  };
}

export function mapTaskTemplate(raw: Raw, lang: string): TaskTemplate | null {
  if (!templateIdOf(raw)) return null;
  const config = isObj(raw.config) ? raw.config : {};
  const schedule = scheduleOf(config.schedule);
  if (!schedule) return null;
  const refs = refsByUsage(raw.references);
  const fillIns = fillInsOf(raw.fill_ins);
  // 任务正文的 `{{id}}` 同样先转【label】，后端的「留空未替换」门才拦得住。
  const content = fillTemplateText(configText(config, 'task_content', lang), fillIns);
  // Frozen contract allows 0..1 execution Agent; zero means Commander.
  if (!content || refs.invalidUsage || refs.primary.length || refs.secondary.length || refs.execution.length > 1
      || refs.execution.some((ref) => ref.kind !== 'agent')) return null;
  return {
    ...base(raw, lang, fillIns),
    title: text(raw.name, lang),
    content,
    schedule,
    execution_agent: refs.execution[0] ?? null,
    skills: [...refs.others, ...refs.agents],
  };
}

function summaryOf(raw: Raw, lang: string, appVersion: string): TemplateSummary | null {
  if (!templateIdOf(raw)) return null;
  // Hub 目录保留停用行（`disabled: true` + `status: "disabled"`）：「模板下架」和
  // 「网络失败」在用户侧必须能区分，所以客户端按状态判不可创建，而不是把行藏掉。
  const disabled = raw.disabled === true || raw.status === 'disabled';
  const min = str(raw.min_app_version);
  const tooOld = !!min && !satisfiesMinAppVersion(appVersion, min);
  return {
    template_id: templateIdOf(raw),
    name: text(raw.name, lang),
    summary: text(raw.summary, lang),
    version: str(raw.version),
    ...(min ? { min_app_version: min } : {}),
    creatable: !tooOld && !disabled,
    // 下架优先于版本：版本能靠升级解决，下架不能。
    ...(disabled ? { blocked_reason: 'disabled' as const }
      : (tooOld ? { blocked_reason: 'client_too_old' as const } : {})),
  };
}

// ── 错误归类 ──────────────────────────────────────────────────────────────

export function classifyCatalogError(err: unknown): CatalogError {
  if (isMarketplaceEndpointUnsupported(err)) return 'not_supported';
  const hubCode = isObj(err) ? str((err as Raw).hubErrorCode).toUpperCase() : '';
  if (hubCode === 'CONTENT_NOT_FOUND' || hubCode === 'NOT_FOUND') return 'not_found';
  if (hubCode === 'CONTENT_DISABLED' || hubCode === 'DISABLED') return 'disabled';
  if (hubCode === 'FORBIDDEN' || hubCode === 'UNAUTHORIZED') return 'forbidden';
  const status = Number(/\b([45]\d{2})\b/.exec(err instanceof Error ? err.message : String(err ?? ''))?.[1] ?? 0);
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 400) return 'server_error';
  // 有 Hub 业务码但不认识 → 服务端错误；什么状态都没有 → 网络问题。
  if (hubCode || (isObj(err) && (err as Raw).marketplaceCode !== undefined)) return 'server_error';
  return 'offline';
}

// ── 本机缓存（只存列表摘要）────────────────────────────────────────────────

interface CacheFile { workspace?: { at: number; items: TemplateSummary[] }; task?: { at: number; items: TemplateSummary[] } }

const cacheFile = (uid: string) => path.join(userLocalRoot(uid), 'marketplace', 'template-catalog-cache.json');

async function readCache(uid: string): Promise<CacheFile> {
  try { return (await readJson<CacheFile>(cacheFile(uid))) || {}; } catch { return {}; }
}

async function writeCache(uid: string, type: TemplateType, items: TemplateSummary[]): Promise<void> {
  try {
    const cur = await readCache(uid);
    await writeJson(cacheFile(uid), { ...cur, [type]: { at: Date.now(), items } });
  } catch { /* 缓存失败不影响本次结果 */ }
}

// ── 对外入口 ──────────────────────────────────────────────────────────────

export async function listTemplates(uid: string, type: TemplateType): Promise<TemplateListResult> {
  if (!uid || isAnonymousLocalId(uid)) return { ok: true, items: [], signed_out: true };
  const lang = getLanguage();
  const appVersion = currentAppVersion();
  try {
    const items: TemplateSummary[] = [];
    // Hub 默认 size=20、上限 100，`total` 不受分页影响：必须按 total 翻页，
    // 否则第 21 条以后会静默不返回（联调末期最难发现的坑）。
    for (let page = 1; page <= MAX_CATALOG_PAGES; page++) {
      const res = await postJson<{ list?: unknown; total?: unknown }>(`${PATHS[type]}/list`, { page, size: CATALOG_PAGE_SIZE });
      const rows = (Array.isArray(res.list) ? res.list : []).filter(isObj);
      for (const raw of rows) {
        const item = summaryOf(raw, lang, appVersion);
        if (item) items.push(item);
      }
      const total = Number(res.total);
      if (!rows.length || (Number.isFinite(total) && items.length >= total) || rows.length < CATALOG_PAGE_SIZE) break;
    }
    await writeCache(uid, type, items);
    return { ok: true, items };
  } catch (err) {
    const error = classifyCatalogError(err);
    if (error === 'not_supported') return { ok: true, items: [], hidden: true };
    const cached = (await readCache(uid))[type];
    // 缓存里的门槛按当前客户端版本重算：客户端升级后不应继续显示「需要更新」。
    const items = (cached?.items ?? []).map((it) => {
      const tooOld = !!it.min_app_version && !satisfiesMinAppVersion(appVersion, it.min_app_version);
      if (it.blocked_reason === 'disabled') return it;
      const { blocked_reason: _drop, ...rest } = it;
      return { ...rest, creatable: !tooOld, ...(tooOld ? { blocked_reason: 'client_too_old' as const } : {}) };
    });
    return { ok: false, items, error, ...(cached ? { from_cache: true } : {}) };
  }
}

export async function getTemplateDetail(uid: string, type: TemplateType, templateId: string): Promise<TemplateDetailResult> {
  if (!uid || isAnonymousLocalId(uid)) return { ok: false, error: 'signed_out' };
  if (!templateId) return { ok: false, error: 'not_found' };
  const lang = getLanguage();
  let detailRaw: Raw;
  try {
    // Hub 请求体严格校验：契约外字段会 UNEXPECTED_FIELD，所以只能用 content_id。
    detailRaw = await postJson<Raw>(`${PATHS[type]}/detail`, { content_id: templateId });
  } catch (err) {
    return { ok: false, error: classifyCatalogError(err) };
  }
  // 契约里只会出现 published / disabled；其它取值（草稿、脏数据）按「模板不可用」处理。
  const status = str(detailRaw.status) || (detailRaw.disabled === true ? 'disabled' : 'published');
  if (status !== 'published' && status !== 'disabled') return { ok: false, error: 'invalid_template' };
  let template = type === 'workspace' ? mapWorkspaceTemplate(detailRaw, lang) : mapTaskTemplate(detailRaw, lang);
  if (!template) return { ok: false, error: 'invalid_template' };
  const riskOf = (value: WorkspaceTemplate | TaskTemplate): SuspectSegment[] => ('instructions' in value
    ? [...prefilterInstructionText(value.goal, 'goal'), ...prefilterInstructionText(value.instructions, 'instructions')]
    : prefilterInstructionText(value.content, 'content'));
  const disabled = detailRaw.disabled === true || status === 'disabled';
  if (disabled) {
    return { ok: true, template, creatable: false, blocked_reason: 'disabled', risk: riskOf(template) };
  }
  const min = template.min_app_version;
  if (min && !satisfiesMinAppVersion(currentAppVersion(), min)) {
    return { ok: true, template, creatable: false, blocked_reason: 'client_too_old', risk: riskOf(template) };
  }

  // Opening a create form is a "take" operation: pin the exact published
  // version through /content instead of building from a moving /detail result.
  let contentRaw: Raw;
  try {
    contentRaw = await postJson<Raw>(`${PATHS[type]}/content`, { content_id: templateId, version: template.version });
  } catch (err) {
    return { ok: false, error: classifyCatalogError(err) };
  }
  const expectedKind = type === 'workspace' ? 'workspace' : 'scheduled_task';
  if (templateIdOf(contentRaw) !== templateId || str(contentRaw.version) !== template.version
      || str(contentRaw.template_kind) !== expectedKind) return { ok: false, error: 'invalid_template' };
  // The versioned snapshot is the creation authority. Missing or mismatched digests are local
  // integrity failures: reject the template and never report CONFIG_DIGEST_MISMATCH back to Hub.
  if (!hasValidContentDigest(contentRaw)) return { ok: false, error: 'invalid_template' };
  const contentStatus = str(contentRaw.status) || (contentRaw.disabled === true ? 'disabled' : 'published');
  if (contentStatus !== 'published' && contentStatus !== 'disabled') return { ok: false, error: 'invalid_template' };
  // /content intentionally omits catalog copy; merge only the display name
  // from detail, while config/fill-ins/references come from the versioned snapshot.
  const snapshot: Raw = { ...contentRaw, name: detailRaw.name };
  template = type === 'workspace' ? mapWorkspaceTemplate(snapshot, lang) : mapTaskTemplate(snapshot, lang);
  if (!template) return { ok: false, error: 'invalid_template' };
  const risk = riskOf(template);
  if (contentRaw.disabled === true || contentStatus === 'disabled') {
    return { ok: true, template, creatable: false, blocked_reason: 'disabled', risk };
  }
  const snapshotMin = template.min_app_version;
  if (snapshotMin && !satisfiesMinAppVersion(currentAppVersion(), snapshotMin)) {
    return { ok: true, template, creatable: false, blocked_reason: 'client_too_old', risk };
  }
  if (type === 'task' && (template as TaskTemplate).content.length > TASK_CONTENT_MAX_LEN) {
    return { ok: true, template, creatable: false, blocked_reason: 'content_too_long', risk };
  }
  return { ok: true, template, creatable: true, risk };
}
