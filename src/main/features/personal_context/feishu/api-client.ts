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
  FeishuWikiSpace,
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
  /** 知识库空间节点；spaceId 为空时遍历当前账号可见空间的文档树。 */
  listWikiNodes(spaceId?: string): Promise<FeishuWikiNode[]>;
  /** 读取新版飞书文档正文（Markdown）；仅在用户明确导入时调用。 */
  getDocumentRawContent(documentId: string): Promise<string>;
  listChats(): Promise<FeishuChat[]>;
  healthCheck(): Promise<HealthResult>;
}

// ── HTTP 实现（骨架）──────────────────────────────────────────────────────
const FEISHU_OPEN_BASE = 'https://open.feishu.cn';

// 只读端点。
const EP_CALENDARS = '/open-apis/calendar/v4/calendars';
const EP_CALENDAR_EVENTS = (calendarId: string) => `/open-apis/calendar/v4/calendars/${calendarId}/events`;
const EP_DRIVE_FILES = '/open-apis/drive/v1/files';
const EP_WIKI_SPACES = '/open-apis/wiki/v2/spaces';
const EP_WIKI_NODES = '/open-apis/wiki/v2/spaces/{space_id}/nodes';
const EP_DOCX_RAW_CONTENT = (documentId: string) => `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`;
const EP_CHATS = '/open-apis/im/v1/chats';
const EP_USER_INFO = '/open-apis/authen/v1/user_info';

interface FeishuPageData<T> {
  items?: T[];
  has_more?: boolean;
  page_token?: string;
}

interface FeishuListResponse<T> {
  code: number;
  msg: string;
  data: FeishuPageData<T> | T[];
}

const WIKI_PAGE_SIZE = '50';
const MAX_WIKI_SPACES = 100;
const MAX_WIKI_NODES = 5000;

function isFeishuError(body: { code?: unknown; msg?: unknown }): boolean {
  return typeof body.code === 'number' && body.code !== 0;
}

export interface HttpFeishuApiClientOptions {
  accessToken: string;
  /** access token 被飞书拒绝时刷新；回调不得把令牌写入日志。 */
  refreshAccessToken?: (rejectedAccessToken: string) => Promise<string | null>;
  /** 默认 https://open.feishu.cn；测试可注入 mock base（如 lark 域名） */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class HttpFeishuApiClient implements FeishuApiClient {
  private accessToken: string;
  private readonly refreshAccessToken?: (rejectedAccessToken: string) => Promise<string | null>;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpFeishuApiClientOptions) {
    this.accessToken = opts.accessToken;
    this.refreshAccessToken = opts.refreshAccessToken;
    this.baseUrl = (opts.baseUrl ?? FEISHU_OPEN_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestAccessToken = this.accessToken;
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${requestAccessToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
        });
      } catch (err) {
        throw new Error(`feishu api network error: ${err instanceof Error ? err.message : String(err)}`);
      }

      let text = '';
      try {
        text = await response.text();
      } catch { /* body read is best effort */ }
      let body: { code?: unknown; msg?: unknown } = {};
      if (text) {
        try {
          body = JSON.parse(text) as { code?: unknown; msg?: unknown };
        } catch {
          if (response.ok) throw new Error(`feishu api invalid json ${path}`);
        }
      }

      const accessTokenExpired = response.status === 401 || body.code === 99991677;
      if (attempt === 0 && accessTokenExpired && this.refreshAccessToken) {
        const refreshed = await this.refreshAccessToken(requestAccessToken);
        if (refreshed) {
          this.accessToken = refreshed;
          continue;
        }
      }
      if (!response.ok) {
        const detail = text ? `: ${text.slice(0, 400)}` : '';
        throw new Error(`feishu api http ${response.status} ${path}${detail}`);
      }
      if (isFeishuError(body)) {
        throw new Error(`feishu api error ${body.code}: ${body.msg ?? ''}`);
      }
      return body as T;
    }
    throw new Error(`feishu api request failed ${path}`);
  }

  private async listPaged<T>(path: string, params: Record<string, string | undefined> = {}, maxItems = MAX_WIKI_NODES): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    do {
      const body = await this.get<FeishuListResponse<T>>(path, {
        ...params,
        page_size: params.page_size ?? WIKI_PAGE_SIZE,
        page_token: pageToken,
      });
      const data = body.data;
      const pageItems = Array.isArray(data) ? data : (data.items ?? []);
      items.push(...pageItems);
      if (items.length >= maxItems || Array.isArray(data) || data.has_more !== true || !data.page_token) break;
      pageToken = data.page_token;
    } while (true);
    return items.slice(0, maxItems);
  }

  private async listWikiSpaces(): Promise<FeishuWikiSpace[]> {
    return this.listPaged<FeishuWikiSpace>(EP_WIKI_SPACES, {}, MAX_WIKI_SPACES);
  }

  private async listWikiChildNodes(spaceId: string, parentNodeToken?: string): Promise<FeishuWikiNode[]> {
    return this.listPaged<FeishuWikiNode>(EP_WIKI_NODES.replace('{space_id}', encodeURIComponent(spaceId)), {
      parent_node_token: parentNodeToken,
    });
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
    const spaceIds = spaceId
      ? [spaceId]
      : (await this.listWikiSpaces()).map((space) => space.space_id).filter(Boolean);
    const nodes: FeishuWikiNode[] = [];
    const seen = new Set<string>();

    for (const currentSpaceId of spaceIds) {
      const pendingParents: Array<string | undefined> = [undefined];
      while (pendingParents.length > 0 && nodes.length < MAX_WIKI_NODES) {
        const parentNodeToken = pendingParents.shift();
        const children = await this.listWikiChildNodes(currentSpaceId, parentNodeToken);
        for (const child of children) {
          if (!child || !child.node_token || !child.obj_token) continue;
          const key = `${currentSpaceId}:${child.node_token}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const node = child.space_id ? child : { ...child, space_id: currentSpaceId };
          nodes.push(node);
          if (node.has_child) pendingParents.push(node.node_token);
          if (nodes.length >= MAX_WIKI_NODES) break;
        }
      }
      if (nodes.length >= MAX_WIKI_NODES) {
        log.warn('feishu wiki node enumeration reached safety cap', { cap: MAX_WIKI_NODES });
        break;
      }
    }
    return nodes;
  }

  async getDocumentRawContent(documentId: string): Promise<string> {
    const body = await this.get<{ data?: { content?: unknown } }>(EP_DOCX_RAW_CONTENT(documentId));
    return typeof body.data?.content === 'string' ? body.data.content : '';
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
