/**
 * 情境空间（原"工作空间"）—— 空间 = 主界面 + 资源作用域限制。
 *
 * 空间是纯配置实体（模板 + 技能/智能体集合，纯元数据），不存会话/文件/记忆。
 * 项目通过 `project.json.space_id` 引用空间；运行时资源 = 空间派生集 ∪ 项目
 * bindings（两级模型，见 projects.ts::resolveProjectScope 与 PC/CLAUDE.md §6）。
 *
 * 数据布局（照抄 projects.ts 的 no-aggregate 模式，云同步友好）：
 *   `<uid>/cloud/spaces/<space_id>.json` = 单文件实体，列目录扫描即列表。
 *
 * 语义裁决（情境空间变更设计 v0.2 §2.4）：
 *   S1 空配置（无模板且无 extra）→ 派生结果全空，调用方据此返回 null（全局可见），
 *      不沿用项目 bindings "空数组 = 零资源" 的语义；
 *   S2 两级资源：项目运行时 = S ∪ B（空间派生集 ∪ 项目 bindings 追加）；
 *   S3 失效引用（被删/被禁用）在派生时过滤 + 归入 invalid_refs，绝不抛错。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { userSpacesDir, spaceMetaFile } from '../paths';
import { nowIso, readJson, writeJson } from '../storage';
import { createLogger } from '../logger';
import { limitNameDisplayText } from '../util/name-limit';
import { getRoleTemplate, type RoleTemplate, type RoleTemplateBundle } from './role_templates';

const log = createLogger('spaces');

// ── Types ──────────────────────────────────────────────────────────────────

export interface Space {
  space_id: string;
  name: string;
  /** 可选卡片图标（emoji）。 */
  icon?: string;
  /**
   * @deprecated 保留兼容：读取时等效 primary_template_id，写入时同步两者。
   * 新代码请用 primary_template_id + secondary_template_ids。
   */
  template_id?: string;
  /** 主角色模板 id（必选，兼容旧字段 template_id；缺省 = 未套模板）。 */
  primary_template_id?: string;
  /** 副角色模板 id 列表（可选，最多 2 个）。 */
  secondary_template_ids: string[];
  /** 空间级扩充技能（共享，空间内所有项目吃到）。 */
  extra_skills: string[];
  /** 空间级扩充智能体。 */
  extra_agents: string[];
  created_at: string;
  updated_at: string;
}

/** 列表展示用派生元数据（不落盘，渲染层 Stage A 用）。 */
export interface SpaceWithMeta extends Space {
  template_name?: string;
  /** 主+副角色模板名列表（空格间隔）；单模板时与 template_name 相同。 */
  template_names?: string;
  skill_count: number;
  agent_count: number;
  invalid_count: number;
}

/** 派生结果（纯函数输出）。 */
export interface SpaceResources {
  /** 解析到的主模板；无模板/模板不存在 = null。 */
  template: RoleTemplate | null;
  /** 解析到的副模板列表（最多 2 个）。 */
  secondary_templates: RoleTemplate[];
  /** 模板 bundle ∪ extra，过滤失效、去重保序。 */
  effective_skills: string[];
  effective_agents: string[];
  invalid_refs: { skills: string[]; agents: string[] };
}

export type SpaceError = 'name_empty' | 'name_dup' | 'not_found' | 'too_long';

// ── Pure helpers ───────────────────────────────────────────────────────────

/** 从模板文件文本解析捆绑声明行（自定义模板，一期"复制改"产物）。
 *  声明格式（模板文件元信息区，置于 `> 模板: <id>@<ver>` 之后）：
 *    `> 捆绑技能: sk-a, sk-b`
 *    `> 捆绑智能体: ag-1`
 *  无声明行 → 空捆绑。纯函数，不 import template_files（避免循环依赖）。 */
export function parseTemplateFileBundle(text: string): RoleTemplateBundle {
  const bundle: RoleTemplateBundle = { skill_ids: [], agent_ids: [] };
  if (!text) return bundle;
  for (const line of text.split(/\r?\n/)) {
    const m = /^>\s*捆绑技能\s*:\s*(.*)$/.exec(line);
    if (m) {
      bundle.skill_ids = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    const ma = /^>\s*捆绑智能体\s*:\s*(.*)$/.exec(line);
    if (ma) {
      bundle.agent_ids = ma[1].split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return bundle;
}

/** 空间 → 资源派生（纯函数，同步）。
 *  @param space  空间（可部分：primary_template_id/extra_skills/extra_agents）
 *  @param valid  当前用户可见资源的 id 集合（调用方从 listSkills/listAgents 构造）
 *  @returns effective = 模板 bundle ∪ extra 过滤失效去重保序；失效 id 归 invalid_refs。 */
export function resolveSpaceResources(
  space: Pick<Space, 'primary_template_id' | 'secondary_template_ids' | 'extra_skills' | 'extra_agents'> & { template_id?: string },
  valid: { skills?: ReadonlySet<string>; agents?: ReadonlySet<string> },
): SpaceResources {
  const validSkills = valid.skills ?? new Set<string>();
  const validAgents = valid.agents ?? new Set<string>();

  // 归一化：兼容旧 template_id 字段（等效 primary_template_id）
  const primary = space.primary_template_id || space.template_id;
  const secondary = space.secondary_template_ids ?? [];

  let template: RoleTemplate | null = null;
  const secondaryTemplates: RoleTemplate[] = [];
  const bundleSkills: string[] = [];
  const bundleAgents: string[] = [];

  // 主模板
  if (primary) {
    template = getRoleTemplate(primary) ?? null;
    if (template?.bundle) {
      bundleSkills.push(...template.bundle.skill_ids);
      bundleAgents.push(...template.bundle.agent_ids);
    }
  }
  // 副模板（去重：排除与主模板相同的 id）
  for (const sid of secondary) {
    if (sid === primary) continue;
    const st = getRoleTemplate(sid);
    if (st) {
      secondaryTemplates.push(st);
      if (st.bundle) {
        bundleSkills.push(...st.bundle.skill_ids);
        bundleAgents.push(...st.bundle.agent_ids);
      }
    }
  }

  const unionSkills = [...bundleSkills, ...(space.extra_skills ?? [])];
  const unionAgents = [...bundleAgents, ...(space.extra_agents ?? [])];

  const effectiveSkills: string[] = [];
  const invalidSkills: string[] = [];
  const seenSkills = new Set<string>();
  for (const s of unionSkills) {
    if (!s || seenSkills.has(s)) continue;
    seenSkills.add(s);
    if (validSkills.has(s)) effectiveSkills.push(s);
    else invalidSkills.push(s);
  }

  const effectiveAgents: string[] = [];
  const invalidAgents: string[] = [];
  const seenAgents = new Set<string>();
  for (const a of unionAgents) {
    if (!a || seenAgents.has(a)) continue;
    seenAgents.add(a);
    if (validAgents.has(a)) effectiveAgents.push(a);
    else invalidAgents.push(a);
  }

  return {
    template,
    secondary_templates: secondaryTemplates,
    effective_skills: effectiveSkills,
    effective_agents: effectiveAgents,
    invalid_refs: { skills: invalidSkills, agents: invalidAgents },
  };
}

// ── Persistence ────────────────────────────────────────────────────────────

function _normaliseSpace(raw: any): Space | null {
  if (!raw || typeof raw !== 'object') return null;
  const sid = typeof raw.space_id === 'string' ? raw.space_id : '';
  if (!sid) return null;
  const filt = (arr: unknown): string[] =>
    Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && !!s) as string[] : [];
  // 归一化：旧数据 template_id → primary_template_id；新数据优先 primary
  const primary = (typeof raw.primary_template_id === 'string' && raw.primary_template_id)
    || (typeof raw.template_id === 'string' && raw.template_id)
    || undefined;
  const secondary = filt(raw.secondary_template_ids);
  return {
    space_id: sid,
    name: typeof raw.name === 'string' ? raw.name : '',
    icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : undefined,
    template_id: primary, // 兼容旧字段
    primary_template_id: primary,
    secondary_template_ids: secondary,
    extra_skills: filt(raw.extra_skills),
    extra_agents: filt(raw.extra_agents),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  };
}

function ensureSpacesDir(uid: string): string {
  const d = userSpacesDir(uid);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function _readSpace(uid: string, spaceId: string): Promise<Space | null> {
  const f = spaceMetaFile(uid, spaceId);
  if (!fs.existsSync(f)) return Promise.resolve(null);
  return readJson(f)
    .then((raw: any) => _normaliseSpace(raw))
    .catch((err) => {
      log.warn(`read space user=${uid} sid=${spaceId}: ${(err as Error).message}`);
      return null;
    });
}

async function _writeSpace(uid: string, space: Space): Promise<void> {
  await writeJson(spaceMetaFile(uid, space.space_id), space);
  _notifyDirty();
}

/** Sync engine dirty signal — mirrors projects.ts::_notifyDirty. Any write to
 *  `cloud/spaces/...` should kick the sync debounce. */
function _notifyDirty(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('spaces', 'cloud/spaces');
  } catch { /* features/sync stripped */ }
}

function genSpaceId(): string {
  return 'sp_' + crypto.randomBytes(6).toString('hex');
}

/** Trim + length cap（照抄 projects.normName）。 */
function normName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = limitNameDisplayText(raw.trim());
  if (!s) return null;
  return s;
}

async function _isDuplicateName(uid: string, name: string, excludeSid?: string): Promise<boolean> {
  const ids = await _listSpaceIds(uid);
  const lower = name.toLocaleLowerCase();
  for (const sid of ids) {
    if (excludeSid && sid === excludeSid) continue;
    const s = await _readSpace(uid, sid);
    if (s && (s.name || '').toLocaleLowerCase() === lower) return true;
  }
  return false;
}

async function _listSpaceIds(uid: string): Promise<string[]> {
  const dir = ensureSpacesDir(uid);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.slice(0, -'.json'.length))
    .filter((n) => n.startsWith('sp_'));
}

// ── Public API ─────────────────────────────────────────────────────────────

/** 空间列表 + 派生展示元数据（模板名/资源数/失效数）。坏文件跳过。 */
export async function listSpaces(uid: string): Promise<SpaceWithMeta[]> {
  const ids = await _listSpaceIds(uid);
  const out: SpaceWithMeta[] = [];
  for (const sid of ids) {
    const s = await _readSpace(uid, sid);
    if (!s) continue;
    const res = resolveSpaceResources(s, { skills: new Set(), agents: new Set() });
    out.push({
      ...s,
      template_name: res.template?.name,
      template_names: [res.template?.name, ...res.secondary_templates.map((t) => t.name)]
        .filter(Boolean).join(' ') || undefined,
      skill_count: res.effective_skills.length + res.invalid_refs.skills.length,
      agent_count: res.effective_agents.length + res.invalid_refs.agents.length,
      invalid_count: res.invalid_refs.skills.length + res.invalid_refs.agents.length,
    });
  }
  const collator = new Intl.Collator('zh', { sensitivity: 'base', numeric: true });
  out.sort((a, b) => collator.compare(a.name, b.name) || a.space_id.localeCompare(b.space_id));
  return out;
}

export async function getSpace(uid: string, spaceId: string): Promise<Space | null> {
  if (!spaceId) return null;
  return _readSpace(uid, spaceId);
}

export async function createSpace(
  uid: string,
  opts: { name: string; template_id?: string; primary_template_id?: string; secondary_template_ids?: string[]; icon?: string },
): Promise<{ ok: true; space: Space } | { ok: false; error: SpaceError }> {
  const name = normName(opts.name);
  if (!name) return { ok: false, error: 'name_empty' };
  if (await _isDuplicateName(uid, name)) return { ok: false, error: 'name_dup' };
  // 归一化：template_id 兼容，primary 优先
  const primary = opts.primary_template_id || opts.template_id || undefined;
  const secondary = (opts.secondary_template_ids || []).filter(Boolean).slice(0, 2);
  const space: Space = {
    space_id: genSpaceId(),
    name,
    icon: typeof opts.icon === 'string' && opts.icon ? opts.icon : undefined,
    template_id: primary,
    primary_template_id: primary,
    secondary_template_ids: secondary,
    extra_skills: [],
    extra_agents: [],
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await _writeSpace(uid, space);
  log.info(`created space user=${uid} sid=${space.space_id} name=${name}`);
  return { ok: true, space };
}

export async function updateSpace(
  uid: string,
  spaceId: string,
  opts: { name?: string; icon?: string; template_id?: string; primary_template_id?: string; secondary_template_ids?: string[] },
): Promise<{ ok: true; space: Space } | { ok: false; error: SpaceError }> {
  const cur = await _readSpace(uid, spaceId);
  if (!cur) return { ok: false, error: 'not_found' };
  if (opts.name !== undefined) {
    const name = normName(opts.name);
    if (!name) return { ok: false, error: 'name_empty' };
    if (await _isDuplicateName(uid, name, spaceId)) return { ok: false, error: 'name_dup' };
    cur.name = name;
  }
  if (opts.icon !== undefined) cur.icon = opts.icon || undefined;
  if (opts.primary_template_id !== undefined || opts.template_id !== undefined) {
    const primary = opts.primary_template_id || opts.template_id || undefined;
    cur.primary_template_id = primary;
    cur.template_id = primary; // 同步兼容字段
  }
  if (opts.secondary_template_ids !== undefined) {
    cur.secondary_template_ids = (opts.secondary_template_ids || []).filter(Boolean).slice(0, 2);
  }
  cur.updated_at = nowIso();
  await _writeSpace(uid, cur);
  return { ok: true, space: cur };
}

/** 删除空间 = 删能力包，不删项目。引用项目由 projects.unbindProjectsBySpace 解绑
 *  （lazy require 避免静态循环依赖）。 */
export async function deleteSpace(
  uid: string,
  spaceId: string,
): Promise<{ ok: true; unbound_projects: string[] } | { ok: false; error: SpaceError }> {
  const cur = await _readSpace(uid, spaceId);
  if (!cur) return { ok: false, error: 'not_found' };
  let unbound: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const projects = await import('./projects');
    unbound = await projects.unbindProjectsBySpace(uid, spaceId);
  } catch (err) {
    log.warn(`unbind projects on space delete user=${uid} sid=${spaceId}: ${(err as Error).message}`);
  }
  try {
    const f = spaceMetaFile(uid, spaceId);
    if (fs.existsSync(f)) await fsp.rm(f, { force: true });
  } catch (err) {
    log.warn(`drop space file user=${uid} sid=${spaceId}: ${(err as Error).message}`);
  }
  log.info(`deleted space user=${uid} sid=${spaceId} unbound_projects=${unbound.length}`);
  return { ok: true, unbound_projects: unbound };
}

export async function addSpaceResource(
  uid: string,
  spaceId: string,
  kind: 'skill' | 'agent',
  id: string,
): Promise<{ ok: true; resources: { extra_skills: string[]; extra_agents: string[] } } | { ok: false; error: SpaceError }> {
  if (!id) return { ok: false, error: 'not_found' };
  const cur = await _readSpace(uid, spaceId);
  if (!cur) return { ok: false, error: 'not_found' };
  if (kind === 'skill') {
    if (!cur.extra_skills.includes(id)) cur.extra_skills.push(id);
  } else {
    if (!cur.extra_agents.includes(id)) cur.extra_agents.push(id);
  }
  cur.updated_at = nowIso();
  await _writeSpace(uid, cur);
  return { ok: true, resources: { extra_skills: cur.extra_skills, extra_agents: cur.extra_agents } };
}

export async function removeSpaceResource(
  uid: string,
  spaceId: string,
  kind: 'skill' | 'agent',
  id: string,
): Promise<{ ok: true; resources: { extra_skills: string[]; extra_agents: string[] } } | { ok: false; error: SpaceError }> {
  const cur = await _readSpace(uid, spaceId);
  if (!cur) return { ok: false, error: 'not_found' };
  if (kind === 'skill') cur.extra_skills = cur.extra_skills.filter((s) => s !== id);
  else cur.extra_agents = cur.extra_agents.filter((a) => a !== id);
  cur.updated_at = nowIso();
  await _writeSpace(uid, cur);
  return { ok: true, resources: { extra_skills: cur.extra_skills, extra_agents: cur.extra_agents } };
}

/** 清理失效引用（裁决 S3）：按有效集合过滤，返回被移除的 id。 */
export async function pruneInvalidSpaceResources(
  uid: string,
  spaceId: string,
  valid: { skills?: ReadonlySet<string>; agents?: ReadonlySet<string> },
): Promise<{ ok: true; removed: string[] } | { ok: false; error: SpaceError }> {
  const cur = await _readSpace(uid, spaceId);
  if (!cur) return { ok: false, error: 'not_found' };
  const validSkills = valid.skills ?? new Set<string>();
  const validAgents = valid.agents ?? new Set<string>();
  const removed: string[] = [];
  cur.extra_skills = cur.extra_skills.filter((s) => {
    if (validSkills.has(s)) return true;
    removed.push(s);
    return false;
  });
  cur.extra_agents = cur.extra_agents.filter((a) => {
    if (validAgents.has(a)) return true;
    removed.push(a);
    return false;
  });
  if (removed.length) {
    cur.updated_at = nowIso();
    await _writeSpace(uid, cur);
  }
  return { ok: true, removed };
}

/** 用户级派生：内部用 listAgents/listSkills 构造有效集合（均有磁盘缓存），
 *  再走纯函数。仅绑空间的项目在 runTurn 热路径上调用；未绑空间零开销。 */
export async function resolveSpaceResourcesForUser(uid: string, space: Space): Promise<SpaceResources> {
  const [agents, skills] = await Promise.all([
    import('./agents').then((m) => m.listAgents()).catch(() => []),
    import('./skills').then((m) => m.listSkills()).catch(() => []),
  ]);
  return resolveSpaceResources(space, {
    skills: new Set(skills.map((s) => s.id)),
    agents: new Set(agents.map((a) => a.agent_id)),
  });
}

/**
 * 情境空间「角色画像」注入：项目绑空间 + 空间有主模板 → 读主+副角色模板文件
 * （个人本体唯一事实来源）的有值字段，格式化为「当前角色画像」块，由 runner 注入
 * system prompt。主角色优先，副角色字段排后；空坑不注入；任何失败 → ''（静默降级）。
 */
export async function formatRoleProfileForSystemPrompt(
  uid: string,
  projectId: string | null | undefined,
): Promise<string> {
  try {
    if (!projectId) return '';
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const projects = await import('./projects');
    const meta = await projects.getProjectScopeMeta(uid, projectId);
    const space = meta.space;
    const primary = space?.primary_template_id || space?.template_id;
    if (!primary) return '';
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const tmpl = await import('./personal_ontology_template_files');

    // 收集所有需要读的模板 id（主+副，去重）
    const allTemplateIds = [primary];
    if (space?.secondary_template_ids?.length) {
      for (const sid of space.secondary_template_ids) {
        if (sid && sid !== primary) allTemplateIds.push(sid);
      }
    }

    const allLines: string[] = [];
    for (const tid of allTemplateIds) {
      const text = tmpl.readTemplateFileText(uid, tid);
      if (!text) continue;
      const content = tmpl.parseTemplateContent(text);
      const tpl = getRoleTemplate(tid);
      const tplName = (tpl && tpl.name) || tid;
      const lines: string[] = [];
      for (const sec of content.sections) {
        for (const [fieldName, values] of Object.entries(sec.fields)) {
          if (!values.length) continue; // 空坑不注入
          lines.push(`- ${sec.title} · ${fieldName}: ${values.map((v) => v.value).join('、')}`);
        }
      }
      if (lines.length) {
        allLines.push(`### 角色「${tplName}」`, ...lines);
      }
    }
    if (!allLines.length) return ''; // 全空坑 → 不注入空画像

    return [
      `## 当前角色画像`,
      `本空间绑定了以下角色模板；以下为已记录的个人画像（来源：个人本体角色模板文件，随候选确认更新）：`,
      ...allLines,
    ].join('\n');
  } catch {
    return ''; // 静默降级
  }
}
