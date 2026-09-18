/**
 * Recall ability-asset search tool injected into every main-conv runner.
 *
 *   - `search_ability_assets` — 三种用法（2026-09-18 目录化）：
 *     ① 不带 query、不带 assetIds → **目录模式**：返回全量在用资产目录
 *        （一行一条：id/标题/类型/范围/成熟度/版本/使用次数/适用与禁用场景），
 *        模型自己看着目录判断要用哪几条 —— "目录在手，按需取用"；
 *     ② 带 assetIds → **正文模式**：按目录里的 id 取正文（≤6 条/次，截 2000 字）；
 *     ③ 带 query → **语义检索**（原有行为，2026-08-17 设计）。
 *     正文真正进入模型上下文的资产（②的全部、③的命中结果）会写
 *     `agent_read` 渠道的注入回执 + 使用流水——模型主动取用也算一次真实
 *     带入，否则"模型自选"永远进不了使用统计与升档链。
 *
 * 产品设计（2026-08-17）：引用（自动注入 / 预载投影）只显示本空间产生的
 * 资产；全局资产池（所有空间产生的 + 全局资产）的使用交给 LLM 的主动检索
 * ——即本工具。只读，无需 localExec 权限（与 kb 工具一致）。
 */

import type { AgentTool } from '#core-agent';
import { createLogger } from '../../logger';
import * as kbEmbed from '../../features/kb_embed';
import { cosineScore } from '../../features/recall/similarity';
import { listAbilityAssets, readAbilityAsset } from '../../features/recall/asset-service';
import { evaluateRecallAssetRuntimeEligibility } from '../../features/recall/prompt-injection';
import { recordInjectionReceipt, listInjectionReceipts } from '../../features/recall/injection-receipt';
import { recordRecallUsage, listRecallUsage } from '../../features/recall/usage-service';
import { loadOntologyAssets } from '../../features/recall/projection-knowledge';
import {
  formatCatalogEntries,
  loadAssetUsageStatsCached,
  type AssetUsageStat,
} from '../../features/recall/asset-catalog';
import type { RecallAbilityAssetRecord } from '../../features/recall/candidate-service';
import { safeId } from '../../storage';
import { logErrorRef, maskId } from '../../util/log-redact';

const log = createLogger('recall-tools');

export interface RecallToolsOpts {
  userId: string;
  /** 当前回合 id：写 agent_read 注入回执/使用流水用；缺省时只读不记账。 */
  turnId?: string;
  /** Conversation id（预留：回执/流水定位用）。 */
  cid?: string;
  /** 空间 id：作为运行时准入的作用域上下文。 */
  spaceId?: string;
  /** 当前用户消息文本：适用/禁用场景匹配用。 */
  taskText?: string;
}

const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 30;
/** 正文模式单次取用上限：一次取太多等于绕回"整块塞正文"，目录化的意义就没了。 */
const MAX_READ_IDS = 6;
const READ_STATEMENT_LIMIT = 2_000;
const CATALOG_PAGE_DEFAULT = 30;
const CATALOG_PAGE_MAX = 50;

/** 检索池条目：正式资产 or 画像记忆（onto-*，未确认、无投影授权）。 */
interface PoolEntry {
  title: string;
  statement: string;
  scope: string;
  id: string;
  type?: string;
  maturity?: string;
  version?: string;
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
    ...(asset.version ? [`版本:v${asset.version}`] : []),
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

/** 准入被拦的原因 → 人话（模型据此决定换一条还是放弃）。 */
const BLOCK_REASON_LABELS: Record<string, string> = {
  status_not_active: '已暂停/归档/撤销，当前不可使用',
  source_unavailable: '来源被撤权，已停止使用',
  scope_mismatch: '作用范围与当前任务不匹配',
  forbidden_context: '命中它自己声明的禁用场景',
  not_applicable_context: '与它自己声明的适用场景不符',
  target_agent_not_allowed: '不允许注入给当前 Agent',
  sensitivity_unclassified: '敏感级未分级',
  sensitivity_above_destination: '敏感级高于当前目的地上限',
  maturity_below_default_use: '置信度不足（未确认/未验证）',
};

function blockReasonText(reasons: readonly string[]): string {
  const labels = reasons.map((reason) => BLOCK_REASON_LABELS[reason] || reason);
  return labels.length ? labels.join('；') : '当前上下文不可使用';
}

/** 正文模式的一条（含版本与范围，便于模型判断适用性）。 */
function formatReadEntry(asset: RecallAbilityAssetRecord, version: string): string {
  const meta = [
    `类型:${asset.type || '?'}`,
    `范围:${asset.scope || 'general'}`,
    `成熟度:${asset.maturity || '?'}`,
    `版本:v${version}`,
    `生命周期:${asset.lifecycleStatus || '?'}`,
  ].join(' | ');
  const applies = (asset.applicableWhen || []).join('；');
  const forbids = (asset.forbiddenWhen || []).join('；');
  return [
    `[asset:${asset.id}] ${asset.title || '(无标题)'}`,
    meta,
    applies ? `适用于: ${applies}` : '',
    forbids ? `禁用: ${forbids}` : '',
    '正文:',
    (asset.statement || '').slice(0, READ_STATEMENT_LIMIT),
  ].filter(Boolean).join('\n');
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

/**
 * agent_read 留痕（2026-09-18）：模型自己取用的资产也写注入回执 + 使用流水。
 *   - 回执幂等（同回合同资产同版本只一条），所以重复取用不会刷次数；
 *   - 使用流水按"该回合首次取用"记一次，避免同回合反复读把统计刷高；
 *   - 记账失败只告警，绝不影响工具结果（模型拿得到内容优先）。
 */
async function recordAgentReads(
  opts: RecallToolsOpts,
  entries: Array<{ assetId: string; assetVersion: string }>,
): Promise<void> {
  const turnId = String(opts.turnId || '');
  if (!entries.length) return;
  if (!turnId) {
    // 没有回合 id 就记不了账（taskRunId 必填）：如实告警而不是静默丢弃——
    // 静默丢弃正是"模型自取等于升档黑洞"的成因（2026-09-18 诊断补）。
    log.warn('agent_read not recorded: tool built without a turn id', { userId: maskId(opts.userId) });
    return;
  }
  try {
    const seenThisTurn = new Set(
      (await listInjectionReceipts(opts.userId, turnId))
        .filter((row) => String(row.channel || '') === 'agent_read')
        .map((row) => String(row.assetId || '')),
    );
    for (const entry of entries) {
      await recordInjectionReceipt(opts.userId, {
        taskRunId: turnId,
        assetId: entry.assetId,
        assetVersion: entry.assetVersion,
        boundary: 'real',
        status: 'injected',
        channel: 'agent_read',
      });
      if (seenThisTurn.has(entry.assetId)) continue;
      seenThisTurn.add(entry.assetId);
      await recordRecallUsage(opts.userId, {
        assetId: entry.assetId,
        assetVersion: entry.assetVersion,
        taskRunId: turnId,
        ...(opts.spaceId ? { workspaceId: opts.spaceId } : {}),
        boundary: 'real',
        outcome: 'agent_read',
      });
    }
  } catch (err) {
    log.warn('agent_read accounting failed', { userId: maskId(opts.userId), error: logErrorRef(err as Error) });
  }
}

function createSearchAbilityAssetsTool(opts: RecallToolsOpts): AgentTool {
  const userId = opts.userId;

  /** 目录模式：全量在用资产，一行一条，可过滤分页。 */
  const runCatalog = async (input: Record<string, unknown>): Promise<string> => {
    const k = Math.min(CATALOG_PAGE_MAX, Math.max(1, Math.floor(Number(input.k) || CATALOG_PAGE_DEFAULT)));
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const typeFilter = typeof input.type === 'string' && input.type.trim() ? input.type.trim() : undefined;
    const scopeFilter = typeof input.scope === 'string' && input.scope.trim() ? input.scope.trim() : undefined;
    const spaceIdFilter = typeof input.spaceId === 'string' && input.spaceId.trim() ? input.spaceId.trim() : undefined;

    let assets: RecallAbilityAssetRecord[];
    try {
      assets = await listAbilityAssets(userId);
    } catch (err) {
      log.warn('asset catalog list failed', { userId: maskId(userId), error: logErrorRef(err as Error) });
      return '读取认知资产目录失败';
    }
    let pool = assets.filter((asset) => asset.status === 'active');
    if (typeFilter) pool = pool.filter((asset) => asset.type === typeFilter);
    if (scopeFilter) pool = pool.filter((asset) => asset.scope === scopeFilter);
    if (spaceIdFilter) pool = pool.filter((asset) => asset.spaceId === spaceIdFilter);
    const filterNote = [
      typeFilter ? `type=${typeFilter}` : '',
      scopeFilter ? `scope=${scopeFilter}` : '',
      spaceIdFilter ? `spaceId=${spaceIdFilter}` : '',
    ].filter(Boolean).join('，');
    if (!pool.length) {
      return `认知资产目录为空（共 0 条${filterNote ? `；过滤条件：${filterNote}` : ''}）。`;
    }
    const page = pool.slice(offset, offset + k);
    if (!page.length) {
      // offset 越界：给"已到末尾 + 总数"的明确语义，而不是一个空页（模型据此
      // 停止翻页，而不是以为目录坏了）。
      return `已到目录末尾（共 ${pool.length} 条${filterNote ? `；过滤条件：${filterNote}` : ''}，offset 从 0 开始）。用 offset=0 从头看，或去掉过滤条件。`;
    }
    const stats = await loadAssetUsageStatsCached(userId);
    const more = pool.length - (offset + page.length);
    return [
      `认知资产目录（在用 ${pool.length} 条${filterNote ? `，过滤：${filterNote}` : ''}；本页 ${offset + 1}-${offset + page.length} 条）：`,
      '',
      ...formatCatalogEntries(page, stats, offset + 1),
      '',
      more > 0 ? `还有 ${more} 条：用 offset=${offset + page.length} 继续翻页。` : '这是最后一页。',
      '用法：看中哪条就用 assetIds 取正文（最多 6 条/次）；也可以直接用 query 做语义检索。',
      '引用格式：[asset:<id>]，例如 [asset:aa-xxx]。',
    ].join('\n');
  };

  /** 正文模式：按目录 id 取正文，过运行时准入门并留痕。 */
  const runRead = async (input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> => {
    const rawIds = Array.isArray(input.assetIds) ? input.assetIds.map((value) => String(value || '').trim()).filter(Boolean) : [];
    const uniqueIds = [...new Set(rawIds)];
    if (!uniqueIds.length) return { content: 'assetIds 为空', isError: true };
    const ids = uniqueIds.slice(0, MAX_READ_IDS);
    const skipped = uniqueIds.length - ids.length;
    const blocks: string[] = [];
    const readEntries: Array<{ assetId: string; assetVersion: string }> = [];
    for (const id of ids) {
      if (!safeId(id)) { blocks.push(`- ${id}：不是合法的资产 id`); continue; }
      let asset: Awaited<ReturnType<typeof readAbilityAsset>> = null;
      try {
        asset = await readAbilityAsset(userId, id);
      } catch (err) {
        log.warn('asset read failed', { userId: maskId(userId), error: logErrorRef(err as Error) });
      }
      if (!asset) { blocks.push(`- [asset:${id}] 未找到（可能已删除或不属于当前用户）`); continue; }
      // 与注入/派单同一道运行时准入门；这里采用"适合度为准"的静默语义
      // （成熟度不进闸、靠返回的元信息标注诚实性），否则目录里能看到的
      // 未验证资产一取就被拒，目录本身就失真了。
      const eligibility = await evaluateRecallAssetRuntimeEligibility(userId, asset, {
        ...(opts.spaceId ? { scope: opts.spaceId } : {}),
        ...(opts.taskText ? { taskText: opts.taskText } : {}),
        purpose: 'agent_read',
        silentDefaultInjection: true,
      });
      // 读取路径不拿"适用场景不符"当拒绝理由（2026-09-18 真机修正）：
      // applicableWhen 是软提示，模型在目录里看过它、已自行判断适用性——按
      // 用户消息做词面匹配来否掉模型的明确选择，会把这个功能废掉（真机实测：
      // 模型按目录取正文被拦）。硬闸照旧：状态 / 来源可用 / scopePolicy /
      // 禁用场景 / 敏感度 / targetAgents。
      const reasons = eligibility.reasons.filter((reason) => reason !== 'not_applicable_context');
      if (reasons.length) {
        blocks.push(`- [asset:${id}] ${asset.title || '(无标题)'}：当前不可使用（${blockReasonText(reasons)}）`);
        continue;
      }
      const version = String(asset.activeVersion || asset.version || '1');
      blocks.push(formatReadEntry(asset, version));
      readEntries.push({ assetId: asset.id, assetVersion: version });
    }
    await recordAgentReads(opts, readEntries);
    return {
      content: [
        `已取出 ${readEntries.length} 条资产正文${skipped > 0 ? `（单次最多 ${MAX_READ_IDS} 条，忽略了多余的 ${skipped} 条）` : ''}：`,
        '',
        ...blocks,
        '',
        '引用格式：[asset:<id>]。',
      ].join('\n'),
    };
  };

  /** 语义检索模式（原有行为）：query 必填，embedding 失败降级关键词。 */
  const runSearch = async (input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> => {
    const query = String(input.query || '').trim();
    if (!query) return { content: 'search_ability_assets: `query` is required in search mode', isError: true };
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
        version: String(asset.activeVersion || asset.version || '1'),
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
    await recordAgentReads(opts, top
      .filter((item) => !item.asset.profileSource && item.asset.version)
      .map((item) => ({ assetId: item.asset.id, assetVersion: String(item.asset.version) })));
    return {
      content: [
        `认知资产池共 ${pool.length} 条（active 资产 ${pool.length - profileInPool}${profileInPool ? ` + 画像记忆 ${profileInPool}` : ''}${scopeFilter ? `，scope=${scopeFilter}` : ''}${spaceIdFilter ? `，spaceId=${spaceIdFilter}` : ''}），返回最相关的 ${top.length} 条：`,
        '',
        ...top.map((item, index) => `${index + 1}. ${formatAsset(item.asset, item.score)}`),
        '',
        '引用格式：回答中引用经验时使用 [asset:<id>]，例如 [asset:aa-xxx]。',
        '需要看某条的完整正文时，用 assetIds 传它的 id 再取一次（最多 6 条/次）。',
      ].join('\n'),
    };
  };

  return {
    name: 'search_ability_assets',
    // 并行安全：embedTexts 在进程级共享 embedder 单例上并发调用安全
    // （与 kb_search 相同结论，见 kb-tools.ts 注释）。
    executionMode: 'parallel',
    description: [
      '用户的认知资产目录：本 App 里沉淀下来的规则、模板、方法、偏好——用户自己的经验，不是通用知识。',
      '**任务一开始就先看一眼目录（不带任何参数调一次）**：里面常常有正好适用的模板或教训，照着它做比从零想更快，也更符合这位用户的既定习惯；目录很便宜（每条一行），不必省这一步。',
      '三种用法：①不带参数 = 全量目录（一行一条，可带 type/scope/spaceId 过滤、offset 翻页）；',
      '②assetIds = 取某几条的完整正文（最多 6 条/次）——看到目录里有合适的，取正文再动手；',
      '③query = 语义检索（覆盖所有空间资产 + 用户画像记忆，画像条目会标注"未经确认、仅供参考"）。',
      '如果这次任务确实要长期用到某几条，用 attach_assets_to_task 把它们挂到本任务上（用户会看到一张可撤销的卡）。',
      '引用格式 [asset:<id>]，例如 [asset:aa-xxx]。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '自然语言查询：想找的经验/规则/方法，如"发布公告怎么写"、"竞品调研的维度"。与 assetIds 二选一；两者都不给则返回全量目录。',
        },
        assetIds: {
          type: 'array',
          items: { type: 'string' },
          description: `按目录里的资产 id 取正文，最多 ${MAX_READ_IDS} 条。用于"看到目录后按需取内容"。`,
        },
        k: {
          type: 'number',
          description: `返回条数：检索模式默认 ${DEFAULT_RESULTS}、最大 ${MAX_RESULTS}；目录模式默认 ${CATALOG_PAGE_DEFAULT}、最大 ${CATALOG_PAGE_MAX}（一页的条数）。`,
        },
        offset: {
          type: 'number',
          description: '仅目录模式：从第几条开始（默认 0）。上一页末尾会提示还有多少条、下一页的 offset。',
        },
        scope: {
          type: 'string',
          description: '可选：按适用范围过滤（如 space / general / 任务类型词）',
        },
        spaceId: {
          type: 'string',
          description: '可选：只搜索某个空间产生的资产（sp_ 开头）',
        },
        type: {
          type: 'string',
          description: '可选：目录模式按资产类型过滤（rule / template / skill / personal 等）',
        },
      },
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>) {
      const hasIds = Array.isArray(input.assetIds) && input.assetIds.some((value) => String(value || '').trim());
      if (hasIds) return runRead(input);
      const query = String(input.query || '').trim();
      if (query) return runSearch(input);
      return { content: await runCatalog(input) };
    },
  };
}

/** Read-only recall asset tools (currently one). No localExec needed. */
export function createRecallTools(opts: RecallToolsOpts): AgentTool[] {
  return [createSearchAbilityAssetsTool(opts)];
}
