/**
 * 飞书 ConnectorProvider 组装（设计稿 §5.3）。
 *
 * 依赖注入：FeishuApiClient（真实 HTTP / mock）+ 注册表 + 游标存储。
 * OAuth 状态由统一 OAuthManager 独立管理（feishu/oauth.ts），provider 只做
 * 资源面操作；status() 的健康检查只验证 user_access_token 是否仍可用。
 */
import { nowIso } from '../../../storage';
import { createLogger } from '../../../logger';
import type { ConnectorContext, ConnectorProvider, ConnectorStatus, ExternalResource, SyncCursor, SyncResult } from '../contract';
import type { PersonalContextCursorStore, PersonalContextRegistry } from '../registry';
import { parseResourceKey } from '../contract';
import type { FeishuApiClient } from './api-client';
import { discoverResources as feishuDiscover } from './discovery';
import { syncResources as feishuSync } from './sync';

const log = createLogger('personal-context:feishu:provider');

export interface FeishuProviderOptions {
  tenant: string;
  /** 当前用户的 union_id（身份稳定键，ownerRef 用） */
  unionId: string;
  registry: PersonalContextRegistry;
  cursors: PersonalContextCursorStore;
}

export function createFeishuProvider(client: FeishuApiClient, opts: FeishuProviderOptions): ConnectorProvider {
  return {
    id: 'feishu',
    kind: 'oauth',

    async status(ctx: ConnectorContext): Promise<ConnectorStatus> {
      const health = await client.healthCheck();
      return {
        kind: health.ok ? 'connected' : 'error',
        checkedAt: nowIso(),
        ...(health.error ? { error: health.error } : {}),
      };
    },

    async discoverResources(ctx: ConnectorContext): Promise<ExternalResource[]> {
      return feishuDiscover(client, { tenant: opts.tenant, unionId: opts.unionId });
    },

    async sync(ctx: ConnectorContext, cursor?: SyncCursor): Promise<SyncResult> {
      const prev = cursor ?? (await opts.cursors.get(ctx.uid, 'feishu'));
      const selected = await opts.registry.list(ctx.uid, { providerId: 'feishu', selectedOnly: true });
      const refs = selected.map((entry) => {
        const parsed = parseResourceKey(entry.resource.resourceId);
        return parsed ? { type: entry.resource.resourceType, stableId: parsed.stableId } : null;
      }).filter((ref): ref is { type: ExternalResource['resourceType']; stableId: string } => ref !== null);

      const result = await feishuSync(client, {
        tenant: opts.tenant,
        unionId: opts.unionId,
        selected: refs,
        cursor: prev,
        applyResource: (resource) => opts.registry.upsert(ctx.uid, resource),
        // 批量落盘：首次回填一次同步可能上百条资源，逐条 upsert 会 N 次全量读写
        // registry.json；批量提交收敛为一次读 + 一次写。
        applyResourceMany: (resources) => opts.registry.upsertMany(ctx.uid, resources),
      });

      // 同步成功才落水位；expectedPrev 防并发覆盖
      await opts.cursors.advance(ctx.uid, 'feishu', {
        watermarks: result.nextCursor.watermarks,
        newEventIds: result.processedEventIds,
      }, { expectedPrev: prev ?? undefined });
      log.info('feishu sync committed', { uid: ctx.uid, added: result.added, updated: result.updated, unchanged: result.unchanged });
      return result;
    },

    async revoke(ctx: ConnectorContext): Promise<void> {
      // OAuth 撤销由 OAuthManager 负责；这里级联标记资源来源失效（资源保留）
      const count = await opts.registry.invalidateProvider(ctx.uid, 'feishu', 'oauth revoked');
      log.info('feishu resources invalidated on revoke', { uid: ctx.uid, count });
    },
  };
}
