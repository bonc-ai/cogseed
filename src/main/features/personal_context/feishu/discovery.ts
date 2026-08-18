/**
 * 飞书资源发现（设计稿 §5.3 discovery.ts）：列出可选接入资源，只读元数据、不读全文。
 *
 * 发现产出为 ExternalResource 候选，是否接入由用户勾选（scope-manifest 语义在
 * 注册表 selection 上表达）；发现阶段不做任何写入。
 */
import type { ExternalResource, ResourceType } from '../contract';
import type { FeishuApiClient } from './api-client';
import {
  normalizeCalendar,
  normalizeChat,
  normalizeDriveFile,
  normalizeWikiNode,
} from './normalize';

export interface DiscoverOptions {
  tenant: string;
  unionId: string;
  /** 缺省 = 全部类型；日历事件不参与发现（事件经同步进入，不逐个勾选） */
  types?: ResourceType[];
}

export async function discoverResources(client: FeishuApiClient, opts: DiscoverOptions): Promise<ExternalResource[]> {
  const { tenant, unionId } = opts;
  const want = (type: ResourceType): boolean => !opts.types || opts.types.includes(type);
  const results: ExternalResource[] = [];

  if (want('calendar')) {
    for (const cal of await client.listCalendars()) {
      results.push(normalizeCalendar(tenant, unionId, cal));
    }
  }
  if (want('document') || want('file') || want('folder')) {
    for (const file of await client.listDriveFiles()) {
      results.push(normalizeDriveFile(tenant, unionId, file));
    }
  }
  if (want('document') || want('file')) {
    for (const node of await client.listWikiNodes()) {
      results.push(normalizeWikiNode(tenant, unionId, node));
    }
  }
  if (want('chat')) {
    for (const chat of await client.listChats()) {
      results.push(normalizeChat(tenant, unionId, chat));
    }
  }
  return results;
}
