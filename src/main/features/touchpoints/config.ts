import { Mutex } from 'async-mutex';
import { readJson, safeId, writeJson } from '../../storage';
import { userCloudConfigDir } from '../../paths';
import type { TouchpointActionKind, TouchpointIntent, TouchpointRouteScene, TouchpointTemplate } from './types';
import { TOUCHPOINT_ROUTE_SCENES } from './types';
import * as path from 'node:path';

const CONFIG_VERSION = 1 as const;
const MAX_TITLE = 120;
const MAX_BODY = 4_000;
const MAX_BUTTON = 80;
const ACTIONS = new Set<TouchpointActionKind>(['open', 'snooze', 'confirm', 'reject', 'edit', 'approve', 'adjust', 'retry', 'forget_source', 'revoke_grant']);
const TEMPLATES = new Set<TouchpointTemplate>(['daily_briefing', 'ontology_confirmation', 'task_approval', 'task_result', 'task_failure', 'deadline_risk', 'calendar_conflict', 'binding_status']);
const ROUTE_SCENES = new Set<TouchpointRouteScene>(TOUCHPOINT_ROUTE_SCENES);
const FEISHU_ONLY_ROUTE_SCENES = ['task_approval', 'daily_briefing'] as const satisfies readonly TouchpointRouteScene[];
const locks = new Map<string, Mutex>();

export interface TouchpointRoutingInstance {
  id: string;
  platform: 'feishu_lark' | 'wechat_personal';
}

export interface TouchpointTemplateConfig {
  title: string;
  body: string;
  buttons?: Partial<Record<TouchpointActionKind, string>>;
}

export interface TouchpointConfigFile {
  version: typeof CONFIG_VERSION;
  defaultInstanceId: string | null;
  templates: Partial<Record<TouchpointTemplate, TouchpointTemplateConfig>>;
  routes: Partial<Record<TouchpointRouteScene, string | null>>;
}

export class TouchpointConfigError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'TouchpointConfigError';
    this.field = field;
  }
}

function filePath(userId: string): string {
  if (!safeId(userId)) throw new TouchpointConfigError('userId', '用户标识无效');
  return path.join(userCloudConfigDir(userId), 'touchpoints.json');
}

function lockFor(userId: string): Mutex {
  let lock = locks.get(userId);
  if (!lock) { lock = new Mutex(); locks.set(userId, lock); }
  return lock;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new TouchpointConfigError(field, `${field} 必须是文本`);
  const result = value.trim();
  if (!result) throw new TouchpointConfigError(field, `${field} 不能为空`);
  if (result.length > max) throw new TouchpointConfigError(field, `${field} 超出长度限制`);
  if ([...result].some((character) => {
    const code = character.codePointAt(0) || 0;
    return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
  })) throw new TouchpointConfigError(field, `${field} 包含非法控制字符`);
  return result;
}

function normalizeTemplate(raw: unknown, field: string): TouchpointTemplateConfig {
  if (!raw || typeof raw !== 'object') throw new TouchpointConfigError(field, '模板必须是对象');
  const candidate = raw as { title?: unknown; body?: unknown; buttons?: unknown };
  const title = text(candidate.title, `${field}.title`, MAX_TITLE);
  const body = text(candidate.body, `${field}.body`, MAX_BODY);
  const buttons: Partial<Record<TouchpointActionKind, string>> = {};
  if (candidate.buttons !== undefined) {
    if (!candidate.buttons || typeof candidate.buttons !== 'object' || Array.isArray(candidate.buttons)) throw new TouchpointConfigError(`${field}.buttons`, '按钮文案必须是对象');
    for (const [rawAction, rawLabel] of Object.entries(candidate.buttons)) {
      if (!ACTIONS.has(rawAction as TouchpointActionKind)) throw new TouchpointConfigError(`${field}.buttons.${rawAction}`, '不支持的动作');
      if (typeof rawLabel === 'string' && !rawLabel.trim()) continue;
      buttons[rawAction as TouchpointActionKind] = text(rawLabel, `${field}.buttons.${rawAction}`, MAX_BUTTON);
    }
  }
  return { title, body, ...(Object.keys(buttons).length ? { buttons } : {}) };
}

function emptyConfig(): TouchpointConfigFile {
  return { version: CONFIG_VERSION, defaultInstanceId: null, templates: {}, routes: {} };
}

function normalizeConfig(raw: unknown): TouchpointConfigFile {
  if (!raw || typeof raw !== 'object') return emptyConfig();
  const candidate = raw as { version?: unknown; defaultInstanceId?: unknown; templates?: unknown; routes?: unknown };
  if (candidate.version !== CONFIG_VERSION) return emptyConfig();
  const defaultInstanceId = candidate.defaultInstanceId === null || candidate.defaultInstanceId === undefined
    ? null
    : typeof candidate.defaultInstanceId === 'string' && safeId(candidate.defaultInstanceId) ? candidate.defaultInstanceId : null;
  const templates: Partial<Record<TouchpointTemplate, TouchpointTemplateConfig>> = {};
  if (candidate.templates && typeof candidate.templates === 'object' && !Array.isArray(candidate.templates)) {
    for (const [key, value] of Object.entries(candidate.templates)) if (TEMPLATES.has(key as TouchpointTemplate)) templates[key as TouchpointTemplate] = normalizeTemplate(value, `templates.${key}`);
  }
  const routes: Partial<Record<TouchpointRouteScene, string | null>> = {};
  if (candidate.routes && typeof candidate.routes === 'object' && !Array.isArray(candidate.routes)) {
    for (const [key, value] of Object.entries(candidate.routes)) {
      if (!ROUTE_SCENES.has(key as TouchpointRouteScene)) continue;
      if (value === null || value === '') routes[key as TouchpointRouteScene] = null;
      else if (typeof value === 'string' && safeId(value)) routes[key as TouchpointRouteScene] = value;
    }
  }
  return { version: CONFIG_VERSION, defaultInstanceId, templates, routes };
}

export async function getTouchpointConfig(userId: string): Promise<TouchpointConfigFile> {
  try { return normalizeConfig(await readJson<unknown>(filePath(userId))); }
  catch { return emptyConfig(); }
}

function validateRoutingConfig(
  config: TouchpointConfigFile,
  instances: readonly TouchpointRoutingInstance[],
): void {
  const instancesById = new Map(instances.map((instance) => [instance.id, instance]));
  const validateTarget = (
    field: string,
    instanceId: string | null | undefined,
    allowedPlatforms: readonly TouchpointRoutingInstance['platform'][],
  ): TouchpointRoutingInstance | undefined => {
    if (!instanceId) return undefined;
    const instance = instancesById.get(instanceId);
    if (!instance || !allowedPlatforms.includes(instance.platform)) {
      throw new TouchpointConfigError(field, '消息实例不存在或不支持此投递场景');
    }
    return instance;
  };

  const defaultInstance = validateTarget(
    'defaultInstanceId',
    config.defaultInstanceId,
    ['feishu_lark', 'wechat_personal'],
  );
  for (const scene of TOUCHPOINT_ROUTE_SCENES) {
    validateTarget(
      `routes.${scene}`,
      config.routes[scene],
      scene === 'external_send' ? ['feishu_lark', 'wechat_personal'] : ['feishu_lark'],
    );
  }
  if (defaultInstance?.platform === 'wechat_personal') {
    for (const scene of FEISHU_ONLY_ROUTE_SCENES) {
      if (!config.routes[scene]) {
        throw new TouchpointConfigError(
          `routes.${scene}`,
          '默认投递实例为个人微信时，飞书专属场景必须明确选择飞书/Lark 机器人',
        );
      }
    }
  }
}

export async function saveTouchpointConfig(
  userId: string,
  input: unknown,
  instances: readonly TouchpointRoutingInstance[],
): Promise<TouchpointConfigFile> {
  if (!input || typeof input !== 'object' || (input as { version?: unknown }).version !== CONFIG_VERSION) {
    throw new TouchpointConfigError('version', '触达配置版本不受支持');
  }
  const config = normalizeConfig(input);
  validateRoutingConfig(config, instances);
  return lockFor(userId).runExclusive(async () => {
    await writeJson(filePath(userId), config);
    return config;
  });
}

const DEFAULT_TEMPLATES: Readonly<Record<TouchpointTemplate, TouchpointTemplateConfig>> = {
  daily_briefing: { title: '今日简报', body: '{{summary}}' },
  ontology_confirmation: { title: '请确认：{{task_title}}', body: '{{summary}}' },
  task_approval: { title: '{{actor}} 请求你确认任务', body: '{{summary}}\n影响范围：{{impact}}', buttons: { approve: '同意执行', reject: '退回补充材料' } },
  task_result: { title: '任务已完成：{{task_title}}', body: '{{summary}}' },
  task_failure: { title: '任务执行失败：{{task_title}}', body: '{{summary}}', buttons: { retry: '重试' } },
  deadline_risk: { title: '截止风险提醒', body: '{{summary}}' },
  calendar_conflict: { title: '日程冲突提醒', body: '{{summary}}' },
  binding_status: { title: '消息连接状态变化', body: '{{summary}}' },
};

function replaceVariables(value: string, intent: TouchpointIntent): string {
  const variables: Record<string, string> = {
    actor: intent.subject.type,
    summary: intent.content.body?.trim() || intent.content.title.trim(),
    task_title: intent.content.title.trim(),
    impact: intent.contextRef?.trim() || '未提供',
  };
  return value.replace(/\{\{([a-z_]+)\}\}/g, (whole, key: string) => variables[key] === undefined ? whole : variables[key]);
}

export async function applyTouchpointTemplate(userId: string, intent: TouchpointIntent): Promise<TouchpointIntent> {
  const config = await getTouchpointConfig(userId);
  const template = config.templates[intent.template] || DEFAULT_TEMPLATES[intent.template];
  const allowed = new Set(intent.actionContract?.allowedActions || []);
  const labels = Object.fromEntries(Object.entries(template.buttons || {}).filter(([key]) => allowed.has(key as TouchpointActionKind))) as Partial<Record<TouchpointActionKind, string>>;
  return {
    ...intent,
    content: { title: replaceVariables(template.title, intent), body: replaceVariables(template.body, intent) },
    ...(intent.actionContract ? { actionContract: { ...intent.actionContract, ...(Object.keys(labels).length ? { buttonLabels: labels } : {}) } } : {}),
  };
}

export async function resolveTouchpointInstanceId(userId: string, scene: TouchpointRouteScene, explicit?: string): Promise<string | undefined> {
  const config = await getTouchpointConfig(userId);
  const candidate = explicit?.trim() || config.routes[scene] || config.defaultInstanceId || undefined;
  return candidate && safeId(candidate) ? candidate : undefined;
}
