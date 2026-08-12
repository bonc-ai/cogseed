/**
 * 飞书开放平台原始对象类型（骨架）。
 *
 * 字段按开放平台常见返回裁剪，真实租户接入时以实际响应校准；
 * 本文件只描述"从飞书拿到的形状"，与标准化后的 ExternalResource 严格分离。
 */

export interface FeishuCalendar {
  calendar_id: string;
  summary: string;
  description?: string;
  /** default | public | private */
  visibility?: string;
  /** 当前用户对日历的权限角色（unknown/reader/writer/owner） */
  role?: string;
  /** ISO 时间 */
  updated_at?: string;
}

export interface FeishuCalendarEvent {
  event_id: string;
  summary: string;
  description?: string;
  /** 毫秒时间戳（开放平台 event 用毫秒） */
  start_time?: number;
  end_time?: number;
  /** 组织者 union_id（可能与当前用户不同） */
  organizer_union_id?: string;
  /** default | public | private */
  visibility?: string;
  /** ISO 时间，同步水位字段 */
  updated_at?: string;
}

export type FeishuDriveType = 'folder' | 'doc' | 'docx' | 'sheet' | 'bitable' | 'file' | string;

export interface FeishuDriveFile {
  file_token: string;
  name: string;
  type: FeishuDriveType;
  parent_token?: string;
  owner_union_id?: string;
  url?: string;
  /** ISO 时间，同步水位字段 */
  updated_at?: string;
}

export type FeishuWikiObjType = 'docx' | 'sheet' | 'bitable' | 'file' | 'mindnote' | string;

export interface FeishuWikiNode {
  node_token: string;
  obj_token: string;
  obj_type: FeishuWikiObjType;
  title: string;
  parent_node_token?: string;
  space_id?: string;
  has_child?: boolean;
  /** ISO 时间 */
  updated_at?: string;
}

export interface FeishuChat {
  chat_id: string;
  name: string;
  description?: string;
  /** 群头像 URL */
  avatar?: string;
  /** ISO 时间 */
  updated_at?: string;
}

/** 事件流的统一包装（messaging 适配器/回调推送的变更事件） */
export interface FeishuEvent {
  /** 事件唯一 id：幂等去重键 */
  event_id: string;
  event_type: string;
  tenant_key: string;
  /** 事件携带的原始数据（按 event_type 解释） */
  payload: unknown;
  received_at: string;
}
