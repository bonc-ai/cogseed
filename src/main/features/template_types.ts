/**
 * S5 Hub 模板（工作空间模板 / 定时任务模板）的客户端内部结构。
 *
 * 这里只放类型，字段与取值对应 `specs/010-hub-workspace-task-templates/data-model.md`。
 * Hub 字段名只在映射层（`marketplace/template-catalog.ts`）出现；业务代码只认这里的结构，
 * Hub 契约冻结后字段改名只动映射层。
 */

import type { ScheduleDaily, ScheduleMonthly, ScheduleWeekly } from './auto_tasks';

/** 引用来源：只看这个字段判定，不按 id 形态推断（内置与 Hub 的 id 都可能是 12 位十六进制）。 */
export type TemplateRefSource = 'builtin' | 'hub';

export type TemplateRefKind = 'role_template' | 'agent' | 'skill' | 'builtin_capability' | 'connector_type';

/** 模板对一项能力的声明。`kind = 'connector_type'` 时 `source` 固定为 `builtin`，`id` 为连接器目录 id。 */
export interface TemplateRef {
  source: TemplateRefSource;
  kind: TemplateRefKind;
  id: string;
  compat?: { min_version?: string };
  /** Hub 侧对该引用的结论（映射层从 `availability` 转来）；本机是否已装仍由客户端自己判断。
   *  Frozen S5 contract: available / missing / disabled / incompatible / unknown. */
  hub_availability?: 'available' | 'missing' | 'disabled' | 'incompatible' | 'unknown';
}

/**
 * 引用在本机的解析结果。
 * - `needs_fetch`：Hub 内容未安装，可一键安装；
 * - `user_disabled`：用户自己关掉的，不自动恢复；
 * - `unknown`：客户端不认识的类型或可用性取值，按不可用处理并提示更新客户端。
 */
export type RefState = 'ready' | 'needs_fetch' | 'missing' | 'incompatible' | 'disabled' | 'user_disabled' | 'unknown';

export interface RefResolution {
  ref: TemplateRef;
  state: RefState;
  local_id?: string;
  /** 由哪条引用展开而来（角色模板附带的能力、Agent 依赖的 Skill）。 */
  via?: TemplateRef;
}

export type ConnectorState = 'ready' | 'missing' | 'disabled' | 'disconnected' | 'auth_error';

export interface ConnectorReadiness {
  connector_type: string;
  state: ConnectorState;
}

/** 模板里留空的信息；只用来生成提示文字，正文里的占位由用户直接改。 */
export interface TemplateFillIn {
  id: string;
  label_zh: string;
  label_en?: string;
  hint?: string;
}

interface TemplateBase {
  template_id: string;
  version: string;
  /** 映射层只放行已发布的模板，停用的不进入客户端结构。 */
  status: 'published';
  min_app_version?: string;
  name: string;
  fill_ins: TemplateFillIn[];
}

/** `required` remains a wire-compatibility value; the client maps it to `optional`. */
export type TemplateProjectDirRequirement = 'required' | 'optional' | 'none';

export interface WorkspaceTemplate extends TemplateBase {
  /**
   * 新建空间时预填的名称（Hub `config.suggested_name`）；`{{id}}` 已转成【label】。
   * `name` 是模板本身的名称，只用于来源记录，不能拿预填名称代替。
   */
  suggested_name: string;
  goal: string;
  instructions: string;
  project_dir: TemplateProjectDirRequirement;
  role_templates: TemplateRef[];
  extra_agents: TemplateRef[];
  extra_skills: TemplateRef[];
  connector_types: string[];
}

/** 复用 `auto_tasks.ts` 的周期；`one_time` 只有类型，时间由用户在客户端选。`weekday` 0 = 周日。 */
export type TaskTemplateSchedule =
  | ScheduleDaily
  | ScheduleWeekly
  | ScheduleMonthly
  | { type: 'one_time' };

export interface TaskTemplate extends TemplateBase {
  title: string;
  /** ≤ 8000 字（与 `auto_tasks.ts` 的 `MAX_CONTENT_LEN` 一致）。 */
  content: string;
  schedule: TaskTemplateSchedule;
  /** 缺省 = 主智能体执行。 */
  execution_agent: TemplateRef | null;
  skills: TemplateRef[];
}
