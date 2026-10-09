/**
 * 飞书对象 → ExternalResource 标准化（设计稿 §5.3 normalize.ts）。
 *
 * 幂等键：`feishu:<tenant>:<resourceType>:<稳定id>`；稳定 id 一律取服务端稳定标识
 * （event_id / calendar_id / file_token / obj_token / chat_id），版本信息进
 * sourceVersion（updated_at），供注册表做幂等比较。
 *
 * 知识库节点与底层对象 token 分离：节点发现阶段直接按 obj_token + obj_type 生成
 * 对象资源（节点自身不单独注册，避免同一文档产生双条目）。
 */
import { nowIso } from '../../../storage';
import type { AccessLabel, ExternalResource, ResourceType } from '../contract';
import { buildResourceKey } from '../contract';
import type {
  FeishuCalendar,
  FeishuCalendarEvent,
  FeishuChat,
  FeishuDriveFile,
  FeishuWikiNode,
} from './types';

export interface NormalizeOptions {
  observedAt?: string;
}

function ownerRefOf(unionId: string | undefined): string | undefined {
  return unionId ? `feishu:union_id:${unionId}` : undefined;
}

/** 飞书 visibility → accessLabel（default/缺省视为 shared，范围收窄而非放宽） */
export function accessLabelFromVisibility(visibility?: string): AccessLabel {
  switch (visibility) {
    case 'private':
    case 'only_me':
      return 'personal';
    case 'public':
      return 'public';
    default:
      return 'shared';
  }
}

/** 云空间类型 → 标准资源类型 */
export function resourceTypeFromDriveType(type: FeishuDriveFile['type']): ResourceType {
  switch (type) {
    case 'folder':
      return 'folder';
    case 'doc':
    case 'docx':
    case 'sheet':
    case 'bitable':
      return 'document';
    default:
      return 'file';
  }
}

/** 知识库 obj_type → 标准资源类型 */
export function resourceTypeFromWikiObjType(objType: FeishuWikiNode['obj_type']): ResourceType {
  switch (objType) {
    case 'docx':
    case 'sheet':
    case 'bitable':
    case 'mindnote':
      return 'document';
    default:
      return 'file';
  }
}

export function normalizeCalendar(tenant: string, unionId: string, raw: FeishuCalendar, opts: NormalizeOptions = {}): ExternalResource {
  return {
    resourceId: buildResourceKey('feishu', tenant, 'calendar', raw.calendar_id),
    resourceType: 'calendar',
    sourceVersion: raw.updated_at ?? raw.calendar_id,
    title: raw.summary || raw.calendar_id,
    ownerRef: ownerRefOf(unionId),
    sourceUrl: undefined,
    observedAt: opts.observedAt ?? nowIso(),
    accessLabel: accessLabelFromVisibility(raw.visibility),
    retentionPolicy: 'source-linked',
    bodyLoaded: false,
  };
}

export function normalizeCalendarEvent(tenant: string, unionId: string, raw: FeishuCalendarEvent, opts: NormalizeOptions = {}): ExternalResource {
  return {
    resourceId: buildResourceKey('feishu', tenant, 'calendar_event', raw.event_id),
    resourceType: 'calendar_event',
    sourceVersion: raw.updated_at ?? raw.event_id,
    title: raw.summary || raw.event_id,
    ownerRef: ownerRefOf(raw.organizer_union_id ?? unionId),
    containerRef: undefined,
    sourceUrl: undefined,
    observedAt: opts.observedAt ?? nowIso(),
    accessLabel: accessLabelFromVisibility(raw.visibility),
    retentionPolicy: 'source-linked',
    bodyLoaded: raw.start_time !== undefined,
    calendarEvent: raw.start_time !== undefined ? {
      startAt: new Date(raw.start_time).toISOString(),
      ...(raw.end_time !== undefined ? { endAt: new Date(raw.end_time).toISOString() } : {}),
      ...(raw.description ? { description: raw.description } : {}),
    } : undefined,
  };
}

export function normalizeDriveFile(tenant: string, unionId: string, raw: FeishuDriveFile, opts: NormalizeOptions = {}): ExternalResource {
  const type = resourceTypeFromDriveType(raw.type);
  return {
    resourceId: buildResourceKey('feishu', tenant, type, raw.file_token),
    resourceType: type,
    sourceVersion: raw.updated_at ?? raw.file_token,
    title: raw.name || raw.file_token,
    ownerRef: ownerRefOf(raw.owner_union_id ?? unionId),
    containerRef: raw.parent_token,
    sourceUrl: raw.url,
    observedAt: opts.observedAt ?? nowIso(),
    accessLabel: accessLabelFromVisibility('default'),
    retentionPolicy: 'source-linked',
    bodyLoaded: false,
  };
}

/**
 * 知识库节点 → 底层对象资源：token 分离，节点自身不注册。
 * 同一 obj_token 出现在多个节点时按 obj_token 幂等（重复发现不产生双条目）。
 */
export function normalizeWikiNode(tenant: string, unionId: string, raw: FeishuWikiNode, opts: NormalizeOptions = {}): ExternalResource {
  const type = resourceTypeFromWikiObjType(raw.obj_type);
  return {
    resourceId: buildResourceKey('feishu', tenant, type, raw.obj_token),
    resourceType: type,
    sourceVersion: raw.updated_at ?? raw.obj_token,
    title: raw.title || raw.obj_token,
    ownerRef: ownerRefOf(unionId),
    containerRef: raw.space_id ?? raw.parent_node_token,
    sourceUrl: undefined,
    observedAt: opts.observedAt ?? nowIso(),
    accessLabel: accessLabelFromVisibility('default'),
    retentionPolicy: 'source-linked',
    bodyLoaded: false,
  };
}

export function normalizeChat(tenant: string, unionId: string, raw: FeishuChat, opts: NormalizeOptions = {}): ExternalResource {
  return {
    resourceId: buildResourceKey('feishu', tenant, 'chat', raw.chat_id),
    resourceType: 'chat',
    sourceVersion: raw.updated_at ?? raw.chat_id,
    title: raw.name || raw.chat_id,
    ownerRef: ownerRefOf(unionId),
    sourceUrl: undefined,
    observedAt: opts.observedAt ?? nowIso(),
    accessLabel: 'shared',
    retentionPolicy: 'source-linked',
    bodyLoaded: false,
  };
}
