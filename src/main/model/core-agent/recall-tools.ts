/**
 * Recall ability-asset search tool injected into every main-conv runner.
 *
 *   - `search_ability_assets` — semantic search over the user's ability
 *     asset pool (沉淀的可复用经验：规则 / 模板 / 方法 / 个人偏好）。
 *
 * 产品设计（2026-08-17）：引用（自动注入 / 预载投影）只显示本空间产生的
 * 资产；全局资产池（所有空间产生的 + 全局资产）的使用交给 LLM 的主动检索
 * ——即本工具。只读，无需 localExec 权限（与 kb 工具一致）。
 */

import type { AgentTool } from '#core-agent';
import { createLogger } from '../../logger';
import * as kbEmbed from '../../features/kb_embed';
import { cosineScore } from '../../features/recall/similarity';
import { listAbilityAssets } from '../../features/recall/asset-service';
import { loadOntologyAssets } from '../../features/recall/projection-knowledge';
import type { RecallAbilityAssetRecord } from '../../features/recall/candidate-service';
import { logErrorRef, maskId } from '../../util/log-redact';

const log = createLogger('recall-tools');

export interface RecallToolsOpts {
  userId: string;
}

const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 30;

/** 检索池条目：正式资产 or 画像记忆（onto-*，未确认、无投影授权）。 */
interface PoolEntry {
  title: string;
  statement: string;
  scope: string;
  id: string;
  type?: string;
  maturity?: string;
  spaceId?: string;
  /** 画像来源标记（user_profile / shared_memory）；正式资产为 undefined。 */
  profileSource?: string;
}

/** 参与语义匹配的文本：标题 + 正文（前 1200 字）+ 适用范围。 */
function assetMatchText(asset: PoolEntry): string {
  return [asset.title, asset.statement ? asset.statement.slice(0, 1_200) : '', asset.scope]
    .filter(Boolean)
    .join('\n');
}

/** 返回给 LLM 的单条资产格式（含引用标记 [asset:<id>]）。 */
function formatAsset(asset: PoolEntry, score: number): string {
  const meta = [
    `类型:${asset.type || '?'}`,
    `适用范围:${asset.scope || 'general'}`,
    ...(asset.spaceId ? [`空间:${asset.spaceId}`] : []),
    `成熟度:${asset.maturity || '?'}`,
    // 画像条目显式标注来源与等级：LLM 必须能区分「已沉淀的资产」与
    // 「背景记忆」，否则会把记忆当成经过验证的经验来引用。
    ...(asset.profileSource ? [`来源:画像记忆(${asset.profileSource})，未经确认，仅供参考`] : []),
  ].join(' | ');
  return [
    `[asset:${asset.id}] ${asset.title || '(无标题)'} (相关度 ${score.toFixed(2)})`,
    meta,
    `内容: ${(asset.statement || '').slice(0, 500)}`,
  ].join('\n');
}

/** 画像记忆 → 检索池条目（不参与 status/spaceId 过滤——没有这些治理态）。 */
function profilePoolEntries(userId: string): PoolEntry[] {
  try {
    return loadOntologyAssets(userId).map((asset) => ({
      id: asset.id,
      title: asset.title,
      statement: asset.statement,
      scope: asset.scope,
      type: asset.type,
      maturity: asset.maturity,
      profileSource: asset.evidenceRefs[0]?.id || 'memory',
    }));
  } catch {
    // memory 文件缺失/损坏不阻断检索——资产池照常可搜。
    return [];
  }
}

function createSearchAbilityAssetsTool(opts: RecallToolsOpts): AgentTool {
  const userId = opts.userId;
  return {
    name: 'search_ability_assets',
    // 并行安全：embedTexts 在进程级共享 embedder 单例上并发调用安全
    // （与 kb_search 相同结论，见 kb-tools.ts 注释）。
    executionMode: 'parallel',
    description:
      '搜索认知资产：检索本 App 沉淀的可复用经验资产池（规则 / 模板 / 方法 / 个人偏好），'
      + '覆盖所有空间产生的资产与全局资产，并包含用户画像记忆（标注"画像记忆"来源，'
      + '未经确认、仅供参考）。当任务可能与过往沉淀的经验、教训、工作方法或用户背景'
      + '相关时，优先调用本工具主动查找，而不是只依赖注入的经验。'
      + '返回每条资产的标题、内容摘要、类型、适用范围、空间归属与相关度，'
      + '引用格式为 [asset:<id>]。可选按适用范围（scope）或空间（spaceId）过滤'
      + '（画像记忆无空间归属，不参与 spaceId 过滤）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '自然语言查询：想找的经验/规则/方法，如"发布公告怎么写"、"竞品调研的维度"',
        },
        k: {
          type: 'number',
          description: '返回条数，默认 8，最大 30',
        },
        scope: {
          type: 'string',
          description: '可选：按适用范围过滤（如 space / general / 任务类型词）',
        },
        spaceId: {
          type: 'string',
          description: '可选：只搜索某个空间产生的资产（sp_ 开头）',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>) {
      const query = String(input.query || '').trim();
      if (!query) return { content: 'search_ability_assets: `query` is required', isError: true };
      const k = Math.min(MAX_RESULTS, Math.max(1, Math.floor(Number(input.k) || DEFAULT_RESULTS)));
      const scopeFilter = typeof input.scope === 'string' && input.scope.trim() ? input.scope.trim() : undefined;
      const spaceIdFilter = typeof input.spaceId === 'string' && input.spaceId.trim() ? input.spaceId.trim() : undefined;

      let assets: RecallAbilityAssetRecord[];
      try {
        assets = await listAbilityAssets(userId);
      } catch (err) {
        log.warn('search_ability_assets list failed', { userId: maskId(userId), error: logErrorRef(err as Error) });
        return { content: 'search_ability_assets: 读取认知资产失败', isError: true };
      }
      // 池 = active 正式资产 + 画像记忆（onto-*，不落治理态：不受 status
      // 过滤、无 spaceId）。画像参与语义排序与 scope 匹配，检索结果里
      // 显式标注来源，防 LLM 把记忆当经验引用。
      let pool: PoolEntry[] = assets
        .filter((asset) => asset.status === 'active')
        .map((asset) => ({
          id: asset.id,
          title: asset.title,
          statement: asset.statement,
          scope: asset.scope,
          type: asset.type,
          maturity: asset.maturity,
          ...(asset.spaceId ? { spaceId: asset.spaceId } : {}),
        }));
      const profileEntries = profilePoolEntries(userId);
      if (!spaceIdFilter) pool = [...pool, ...profileEntries];
      if (scopeFilter) pool = pool.filter((asset) => asset.scope === scopeFilter);
      if (spaceIdFilter) pool = pool.filter((asset) => asset.spaceId === spaceIdFilter);
      if (!pool.length) {
        return { content: `认知资产池共 0 条（active 池为空或被过滤条件筛空${profileEntries.length ? `；另有画像记忆 ${profileEntries.length} 条被过滤条件排除` : ''}）`, isError: false };
      }

      let ranked: Array<{ asset: PoolEntry; score: number }>;
      try {
        const vectors = await kbEmbed.embedTexts([query, ...pool.map(assetMatchText)]);
        const queryVector = vectors[0];
        ranked = pool
          .map((asset, index) => ({ asset, score: cosineScore(queryVector, vectors[index + 1]) }))
          .sort((a, b) => b.score - a.score);
      } catch (err) {
        // embedding 不可用（模型未加载等）→ 关键词降级：标题/正文包含查询词者优先
        log.warn('search_ability_assets embed failed; keyword fallback', { userId: maskId(userId), error: logErrorRef(err as Error) });
        const needle = query.toLowerCase();
        ranked = pool
          .map((asset) => ({ asset, score: assetMatchText(asset).toLowerCase().includes(needle) ? 1 : 0 }))
          .sort((a, b) => b.score - a.score);
      }

      const top = ranked.slice(0, k);
      const profileInPool = pool.filter((entry) => entry.profileSource).length;
      return {
        content: [
          `认知资产池共 ${pool.length} 条（active 资产 ${pool.length - profileInPool}${profileInPool ? ` + 画像记忆 ${profileInPool}` : ''}${scopeFilter ? `，scope=${scopeFilter}` : ''}${spaceIdFilter ? `，spaceId=${spaceIdFilter}` : ''}），返回最相关的 ${top.length} 条：`,
          '',
          ...top.map((item, index) => `${index + 1}. ${formatAsset(item.asset, item.score)}`),
          '',
          '引用格式：回答中引用经验时使用 [asset:<id>]，例如 [asset:aa-xxx]。',
        ].join('\n'),
      };
    },
  };
}

/** Read-only recall asset search tools (currently one). No localExec needed. */
export function createRecallTools(opts: RecallToolsOpts): AgentTool[] {
  return [createSearchAbilityAssetsTool(opts)];
}
