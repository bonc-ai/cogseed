/**
 * 飞书 API 客户端：只读元数据访问（日历/云空间/知识库/聊天）。
 *
 * FeishuApiClient 接口是 provider 与 HTTP 实现之间的接缝——测试注入 mock，
 * 真实实现 HttpFeishuApiClient 走 user_access_token（与机器人应用令牌严格分离）。
 *
 * ⚠️ 端点路径为骨架初值，接入真实测试租户时以开放平台文档校准。
 * ⚠️ 本模块只读：MVP 默认只读权限，任何写入端点不得在此出现。
 */
import { createLogger } from '../../../logger';
import type {
  FeishuCalendar,
  FeishuCalendarEvent,
  FeishuChat,
  FeishuDriveFile,
  FeishuWikiNode,
} from './types';

const log = createLogger('personal-context:feishu:api');

export interface TimeRange {
  /** ISO 时间 */
  start: string;
  /** ISO 时间 */
  end: string;
}

export interface HealthResult {
  ok: boolean;
  error?: string;
}

export interface FeishuApiClient {
  listCalendars(): Promise<FeishuCalendar[]>;
  listCalendarEvents(calendarId: string, range: TimeRange, updatedAfter?: string): Promise<FeishuCalendarEvent[]>;
  /** 云空间文件；parentToken 为空时列根目录 */
  listDriveFiles(parentToken?: string): Promise<FeishuDriveFile[]>;
  /** 知识库空间节点；spaceId 为空时列全部可见空间根节点 */
  listWikiNodes(spaceId?: string): Promise<FeishuWikiNode[]>;
  listChats(): Promise<FeishuChat[]>;
  healthCheck(): Promise<HealthResult>;
}

// ── HTTP 实现（骨架）──────────────────────────────────────────────────────
const FEISHU_OPEN_BASE = 'https://open.feishu.cn';

// 端点路径（待真实租户校准）
const EP_CALENDARS = '/open-apis/calendar/v4/calendars';
const EP_CALENDAR_EVENTS = (calendarId: string) => `/open-apis/calendar/v4/calendars/${calendarId}/events`;
const EP_DRIVE_FILES = '/open-apis/drive/v1/files';
const EP_WIKI_NODES = '/open-apis/wiki/v2/spaces/{space_id}/nodes';
const EP_CHATS = '/open-apis/im/v1/chats';
const EP_USER_INFO = '/open-apis/authen/v1/user_info';

interface FeishuListResponse<T> {
  code: number;
  msg: string;
  data: { items?: T[] } | T[];
}

function isFeishuError(body: { code?: unknown; msg?: unknown }): boolean {
  return typeof body.code === 'number' && body.code !== 0;
}

export interface HttpFeishuApiClientOptions {
  accessToken: string;
  /** 默认 https://open.feishu.cn；测试可注入 mock base（如 lark 域名） */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class HttpFeishuApiClient implements FeishuApiClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpFeishuApiClientOptions) {
    this.accessToken = opts.accessToken;
    this.baseUrl = (opts.baseUrl ?? FEISHU_OPEN_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    } catch (err) {
      throw new Error(`feishu api network error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      throw new Error(`feishu api http ${response.status}`);
    }
    const body = (await response.json()) as { code?: unknown; msg?: unknown };
    if (isFeishuError(body)) {
      throw new Error(`feishu api error ${body.code}: ${body.msg ?? ''}`);
    }
    return body as T;
  }

  async listCalendars(): Promise<FeishuCalendar[]> {
    const body = await this.get<FeishuListResponse<FeishuCalendar>>(EP_CALENDARS);
    return Array.isArray(body.data) ? body.data : (body.data.items ?? []);
  }

  async listCalendarEvents(calendarId: string, range: TimeRange, updatedAfter?: string): Promise<FeishuCalendarEvent[]> {
    const startMs = Date.parse(range.start);
    const endMs = Date.parse(range.end);
    const body = await this.get<FeishuListResponse<FeishuCalendarEvent>>(EP_CALENDAR_EVENTS(calendarId), {
      start_time: Number.isNaN(startMs) ? undefined : String(startMs),
      end_time: Number.isNaN(endMs) ? undefined : String(endMs),
      page_size: '100',
    });
    const events = Array.isArray(body.data) ? body.data : (body.data.items ?? []);
    if (!updatedAfter) return events;
    return events.filter((event) => !event.updated_at || event.updated_at > updatedAfter);
  }

  async listDriveFiles(parentToken?: string): Promise<FeishuDriveFile[]> {
    const body = await this.get<FeishuListResponse<FeishuDriveFile>>(EP_DRIVE_FILES, {
      parent_node_token: parentToken,
      page_size: '100',
    });
    return Array.isArray(body.data) ? body.data : (body.data.items ?? []);
  }

  async listWikiNodes(spaceId?: string): Promise<FeishuWikiNode[]> {
    // 骨架：按空间列节点；未指定空间时先列空间列表（端点待校准），此处返回空
    if (!spaceId) return [];
    const body = await this.get<FeishuListResponse<FeishuWikiNode>>(EP_WIKI_NODES.replace('{space_id}', spaceId), {
      page_size: '100',
    });
    return Array.isArray(body.data) ? body.data : (body.data.items ?? []);
  }

  async listChats(): Promise<FeishuChat[]> {
    const body = await this.get<FeishuListResponse<FeishuChat>>(EP_CHATS, { page_size: '100' });
    return Array.isArray(body.data) ? body.data : (body.data.items ?? []);
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      const body = await this.get<{ code?: unknown; msg?: unknown }>(EP_USER_INFO);
      if (isFeishuError(body)) {
        log.warn('feishu health check failed', { code: body.code });
        return { ok: false, error: String(body.code) };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
