/**
 * 资产管家工具（specs/008 US-401 读 / US-402 写 / US-404 安全网）。
 *
 * 与 `recall-tools.ts` 的分工：那里是**任务执行期**的只读取用（目录 + 语义检索 +
 * agent_read 留痕），这里面向**管理**——全量浏览、按需读全文、按用户指令改动。
 * 分开的理由是两者语义不同：取用会写注入回执与使用流水，管理不该写（把"管家
 * 看了一眼"记成"任务用了这条资产"，会让采用统计失真）。
 *
 * 写通道不新开：全部落到既有 `asset-service.ts` 写函数（不新建第二套写路径）。
 */

import type { AgentTool } from '#core-agent';
import { createLogger } from '../../logger';
import { t } from '../../i18n';
import {
  abilityAssetActiveVersion,
  archiveAbilityAsset,
  classifyAbilityAssetWriteFailure,
  diffAbilityAssetsForAudit,
  summarizeAuditChange,
  deleteAbilityAsset,
  listAbilityAssets,
  mergeAbilityAssets,
  readAbilityAsset,
  recordAbilityAssetAudit,
  restoreAbilityAsset,
  rollbackAbilityAsset,
  updateAbilityAsset,
  type AbilityAssetFailureCategory,
  type UpdateAbilityAssetInput,
} from '../../features/recall/asset-service';
import type { RecallAbilityAssetRecord } from '../../features/recall/candidate-service';
import { normalizeAbilityTagList } from '../../features/recall/ability-tag-service';
import type { RecallAbilityAssetScopePolicy } from '../../features/recall/scope-policy';
import { assertCompliantAbilityAssetTitle } from '../../features/recall/title-policy';
import { evaluateRecallAssetRuntimeEligibility } from '../../features/recall/prompt-injection';
import { requestInteraction } from '../../features/chat_events/interaction-hub';
import {
  createAssetChangeProposal,
  listAssetChangeProposals,
  type AssetChangeProposal,
} from '../../features/recall/asset-approval-service';
import { busAssetApprovalCardPort, postAssetChangeApprovalCard } from '../../features/recall/asset-approval-card';
import { safeId } from '../../storage';
import { logErrorRef, maskId } from '../../util/log-redact';
import { classifyMemoryReplaceIntent } from '../../features/recall/memory-save-intent';

const log = createLogger('asset-steward-tools');

export interface AssetStewardToolsOpts {
  userId: string;
  agentId?: string;
  projectId?: string;
  /** 当前回合 id：Phase 5 的危险操作确认与台账定位用。 */
  turnId?: string;
  /** Conversation id：危险操作的单次确认要送回这条会话。 */
  cid?: string;
  /** 空间 id：运行时准入的作用域上下文。 */
  spaceId?: string;
  /** 当前用户消息文本：适用/禁用场景匹配用。 */
  taskText?: string;
  /** 只有当前可见来源行确实由用户发出时，才能把原话当作直写授权。 */
  sourceMessageFromUser?: boolean;
}

/** 列表分页默认与上限，对齐既有目录工具量级（一页 30、最多 50）。 */
const LIST_PAGE_DEFAULT = 30;
const LIST_PAGE_MAX = 50;

/** 单批正文上限。与既有正文模式的 2000 字同量级：再大就等于绕回"整块塞正文"。 */
export const READ_CHUNK_CHARS = 2_000;

/** 「已彻底清除」是终态、且规范要求"搜索不可见"——墓碑只剩一个 id，
 *  列出来只会是噪音，所以清单整体排除它（其余状态一律如实列出）。 */
const LISTABLE_STATUSES = ['active', 'paused', 'archived', 'deleted', 'revoked'] as const;

const STATUS_LABELS: Record<string, string> = {
  active: '在用', paused: '已暂停', archived: '已归档', deleted: '已删除',
  revoked: '已撤销', purged: '已彻底清除',
};

/** 准入被拦的原因 → 人话（与 recall-tools 的映射同源；这里的用途是"告知为什么
 *  不返回正文"，不是"换一条试试"）。 */
const BLOCK_REASON_LABELS: Record<string, string> = {
  status_not_active: '状态不是在用（已暂停/归档/删除/撤销）',
  source_unavailable: '来源被撤权，已停止使用',
  scope_mismatch: '作用范围与当前上下文不匹配',
  forbidden_context: '命中它自己声明的禁用场景',
  target_agent_not_allowed: '不允许用于当前 Agent',
  maturity_below_default_use: '置信度不足（未确认/未验证）',
};

function blockReasonText(reasons: readonly string[]): string {
  return reasons.length
    ? reasons.map((reason) => `${BLOCK_REASON_LABELS[reason] || reason}[${reason}]`).join('；')
    : '当前上下文不可使用';
}

function statusText(status: string): string {
  return `${STATUS_LABELS[status] || status}[${status}]`;
}

function metaLine(asset: RecallAbilityAssetRecord): string {
  const version = String(asset.activeVersion || asset.version || '1');
  return [
    `类型=${asset.type || '?'}`,
    `状态=${statusText(asset.status)}`,
    `范围=${asset.scope || 'general'}`,
    `成熟度=${asset.maturity || '?'}`,
    `在用版=v${version}`,
    ...(asset.activeVersion && asset.activeVersion !== asset.version ? [`最新版=v${asset.version}`] : []),
    ...(asset.spaceId ? [`空间=${asset.spaceId}`] : []),
    // 标签 = 主题分类（specs/012）；缺失不显示（缺省就是「未分类」，不伪造空值）。
    ...(asset.tags && asset.tags.length ? [`标签=${asset.tags.join('/')}`] : []),
    // 族名是用户手写的**同源血缘**分组名，不是主题标签（标签字段尚未落地）：
    // 显示它才能让归并判断有依据，但必须标清是什么，免得和"标签"混为一谈。
    ...(asset.familyName ? [`族名(同源血缘)=${asset.familyName}`] : []),
  ].join(' | ');
}

function listLine(asset: RecallAbilityAssetRecord): string {
  return `[asset:${asset.id}] ${asset.title || '(无标题)'} (${metaLine(asset)})`;
}

/** 一条资产是否是"能交给模型看的"——与注入/派单同一道运行时准入门，
 *  同源判定，避免两处标准分叉。
 *
 *  软条件 `not_applicable_context` 不计入拦截（与既有正文读取同口径）：
 *  applicableWhen 是给模型自己判断的软提示，按用户消息做词面匹配来否掉模型的
 *  明确选择，会把这个功能废掉。硬闸照旧：状态 / 来源 / scopePolicy / 禁用场景 /
 *  敏感度 / targetAgents。
 */
async function runtimeBlockReasons(
  opts: AssetStewardToolsOpts,
  asset: RecallAbilityAssetRecord,
): Promise<string[]> {
  const eligibility = await evaluateRecallAssetRuntimeEligibility(opts.userId, asset, {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.spaceId ? { workspaceId: opts.spaceId } : {}),
    ...(opts.taskText ? { taskText: opts.taskText } : {}),
    ...(opts.taskText ? { purpose: opts.taskText } : {}),
    silentDefaultInjection: true,
  });
  return eligibility.reasons.filter((reason) => reason !== 'not_applicable_context');
}

// ── 待审批提议（US-406）：管理视角的可见性 ────────────────────────────────
//
// 模型此前**看不到**自己提过什么（2026-09-25 子安："在对话中让他管理整个资产库，
// 他拿不到待审批的内容"）。看不见的代价不只是答不上"有哪些待办"：某条资产挂着
// 一张没定的卡片时，它会一遍遍重提同一个变更，然后被去重挡住、却不知道为什么。
// 这一段只做**读**——处置权在用户手里，模型不许代拍（也没有代拍的通道）。
const PROPOSAL_STATE_LABELS: Record<string, string> = {
  pending: '等用户定夺',
  deferred: '用户已「稍后处理」（还在待确认清单）',
  confirmed: '已确认生效',
  rejected: '已拒绝',
};

/** 提议里单字段值的展示上限：够模型判读，又不至于把一份清单撑成一本书。 */
const PROPOSAL_VALUE_CHARS = 1_200;

function proposalStateLabel(state: string): string {
  return PROPOSAL_STATE_LABELS[state] || state;
}

/** 还在等用户点头的提议（pending / deferred 都算：deferred 只是被推后，没被处置）。 */
async function listOpenProposals(userId: string): Promise<AssetChangeProposal[]> {
  try {
    const all = await listAssetChangeProposals(userId);
    return all.filter((proposal) => proposal.state === 'pending' || proposal.state === 'deferred');
  } catch (err) {
    log.warn('steward proposal list failed', { userId: maskId(userId), error: logErrorRef(err as Error) });
    return [];
  }
}

function proposalHeadline(proposal: AssetChangeProposal, assetTitle?: string): string {
  return [
    `[proposal:${proposal.id}] ${proposalStateLabel(proposal.state)}`,
    assetTitle ? `目标资产 ${assetTitle}` : `目标资产 [asset:${proposal.assetId}]`,
    `涉及 ${proposal.fields.join(' / ')}`,
    `基于 v${proposal.baselineVersion}`,
    `提出于 ${proposal.createdAt}`,
  ].join(' | ');
}

function cappedValue(text: string): string {
  const body = String(text || '');
  if (body.length <= PROPOSAL_VALUE_CHARS) return body;
  return `${body.slice(0, PROPOSAL_VALUE_CHARS)}……（已截断，全文共 ${body.length} 字；完整内容在用户的审批卡片上）`;
}

function proposalDetailLines(proposal: AssetChangeProposal): string[] {
  const lines: string[] = [];
  lines.push(`依据：${proposal.reason}`);
  lines.push('拟生效内容（改动后）：');
  for (const key of proposal.fields) {
    if (!(key in proposal.payload)) continue;
    const next = proposal.payload[key];
    const rendered = Array.isArray(next) ? next.map((item) => String(item)).join('；') : String(next ?? '');
    lines.push(`  ${key}（${Array.isArray(next) ? `${next.length} 项` : `${rendered.length} 字`}）：${cappedValue(rendered)}`);
  }
  if (proposal.beforeValues && Object.keys(proposal.beforeValues).length) {
    lines.push('当前值（改动前）：');
    for (const key of proposal.fields) {
      if (!(key in proposal.beforeValues)) continue;
      const before = proposal.beforeValues[key];
      const rendered = Array.isArray(before) ? before.map((item) => String(item)).join('；') : String(before ?? '');
      lines.push(`  ${key}：${cappedValue(rendered) || '(空)'}`);
    }
  }
  lines.push('处置：用户在对话里的卡片上三选一（确认更新 / 稍后处理 / 拒绝）。你**不能**替他决定。');
  return lines;
}

function createListAbilityAssetsTool(opts: AssetStewardToolsOpts): AgentTool {
  const userId = opts.userId;
  return {
    name: 'list_ability_assets',
    executionMode: 'parallel',
    description: [
      '列出这位用户的**全部**认知资产（经验/规则/模板/方法/偏好），含标题、类型、状态、范围、成熟度、在用版本、所属空间、标签。',
      '与 search_ability_assets 的区别：那是按相关度找"这次任务能用上什么"，这个是**管理视角的全量清单**——要看全、要按状态/类型/空间/标签筛、要交给后面的整理动作时用它。',
      '默认一页 30 条、最多 50 条，用 offset 翻页；返回里带总数与各状态的条数，翻完就能确认"一共多少条"。',
      '**已彻底清除的资产不在清单里**（规范要求搜索不可见）；已删除的会如实标成"已删除"，不会被藏起来，但它的正文读不出来（见 read_ability_asset）。',
      '可按 `filter.tags` 过滤（配 `filter.tagsMode` 选"任一/同时具备"），可用 `edit_ability_asset` 打标；返回里出现的"族名(同源血缘)"是系统自动的同源分组、**不是**标签。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'number', description: '从第几条开始（默认 0）。上一页末尾会提示下一页的 offset 与剩余条数。' },
        limit: { type: 'number', description: `一页条数：默认 ${LIST_PAGE_DEFAULT}、最大 ${LIST_PAGE_MAX}。` },
        filter: {
          type: 'object',
          description: '可选过滤：可同时给（各条件之间叠加，AND）。',
          properties: {
            assetType: { type: 'string', description: '资产类型：rule / template / skill_method / fact / personal。' },
            status: { type: 'string', description: '治理状态：active / paused / archived / deleted / revoked。' },
            spaceId: { type: 'string', description: '只看某个空间沉淀的资产（sp_ 开头）。' },
            tags: { type: 'array', items: { type: 'string' }, description: '只看带这些主题标签的资产（名字大小写不敏感）。' },
            tagsMode: { type: 'string', enum: ['any', 'all'], description: 'tags 的组合方式：any=带其中任一个（默认）；all=同时具备全部。' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
      const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
      const limit = Math.min(LIST_PAGE_MAX, Math.max(1, Math.floor(Number(input.limit) || LIST_PAGE_DEFAULT)));
      const rawFilter = parseStructuredInput(input.filter);
      const filter = (rawFilter && typeof rawFilter === 'object' && !Array.isArray(rawFilter))
        ? rawFilter as Record<string, unknown>
        : {};
      const assetType = typeof filter.assetType === 'string' && filter.assetType.trim() ? filter.assetType.trim() : undefined;
      const status = typeof filter.status === 'string' && filter.status.trim() ? filter.status.trim() : undefined;
      const spaceId = typeof filter.spaceId === 'string' && filter.spaceId.trim() ? filter.spaceId.trim() : undefined;
      // 标签过滤（specs/012 T023）：与类型/状态/空间叠加（AND）；匹配与标签
      // 规范化同一口径（大小写不敏感），不给渲染层之外的第二套判断。
      const rawTagsFilter = parseStructuredInput(filter.tags);
      const tagsFilter = Array.isArray(rawTagsFilter)
        ? rawTagsFilter.map((value) => String(value ?? '').trim()).filter(Boolean)
        : undefined;
      if (filter.tags !== undefined && !tagsFilter?.length) {
        return { content: 'filter.tags 要是非空字符串数组（每个一个标签名）。', isError: true };
      }
      const tagsModeInput = filter.tagsMode === undefined ? undefined : String(filter.tagsMode);
      if (tagsModeInput !== undefined && tagsModeInput !== 'any' && tagsModeInput !== 'all') {
        return { content: `filter.tagsMode 只能是 any / all，收到：${tagsModeInput}`, isError: true };
      }
      const tagsMode = tagsModeInput === 'all' ? 'all' : 'any';
      if (status && !LISTABLE_STATUSES.includes(status as typeof LISTABLE_STATUSES[number])) {
        return { content: `status 过滤值不认识：${status}（可用：${LISTABLE_STATUSES.join(' / ')}）`, isError: true };
      }
      if (spaceId && !safeId(spaceId)) {
        return { content: `spaceId 不是合法的空间 id：${spaceId}`, isError: true };
      }

      let assets: RecallAbilityAssetRecord[];
      try {
        assets = await listAbilityAssets(userId);
      } catch (err) {
        log.warn('steward list failed', { userId: maskId(userId), error: logErrorRef(err as Error) });
        return { content: '读取认知资产清单失败（详见应用日志）。', isError: true };
      }
      const all = assets.filter((asset) => asset.status !== 'purged');
      const counts = new Map<string, number>();
      for (const asset of all) counts.set(asset.status, (counts.get(asset.status) || 0) + 1);

      let pool = all;
      if (assetType) pool = pool.filter((asset) => asset.type === assetType);
      if (status) pool = pool.filter((asset) => asset.status === status);
      if (spaceId) pool = pool.filter((asset) => asset.spaceId === spaceId);
      if (tagsFilter?.length) {
        const wanted = tagsFilter.map((name) => name.toLocaleLowerCase());
        pool = pool.filter((asset) => {
          const owned = new Set((asset.tags || []).map((name) => name.toLocaleLowerCase()));
          return tagsMode === 'all'
            ? wanted.every((key) => owned.has(key))
            : wanted.some((key) => owned.has(key));
        });
      }

      const filterNote = [
        assetType ? `类型=${assetType}` : '',
        status ? `状态=${status}` : '',
        spaceId ? `空间=${spaceId}` : '',
        tagsFilter?.length ? `标签=${tagsFilter.join('/')}(tagsMode=${tagsMode})` : '',
      ].filter(Boolean).join('，');
      const countNote = LISTABLE_STATUSES
        .filter((key) => counts.get(key))
        .map((key) => `${STATUS_LABELS[key]} ${counts.get(key)}`)
        .join(' · ');
      if (!pool.length) {
        return {
          content: all.length
            ? `没有符合条件的资产（全部 ${all.length} 条：${countNote}${filterNote ? `；过滤条件：${filterNote}` : ''}）。去掉过滤条件或换一个再试。`
            : '认知资产库是空的：这位用户还没有任何资产。',
        };
      }
      const page = pool.slice(offset, offset + limit);
      if (!page.length) {
        return {
          content: `已到清单末尾（共 ${pool.length} 条${filterNote ? `，过滤：${filterNote}` : ''}；offset 从 0 开始）。用 offset=0 从头看，或去掉过滤条件。`,
        };
      }
      const more = pool.length - (offset + page.length);
      // 挂着待审批提议的条目要标出来：不标，模型会重提同一个变更、然后被去重挡住，
      // 却不知道自己提过（2026-09-25 子安："他拿不到待审批的内容"）。
      const openProposals = await listOpenProposals(userId);
      const openByAsset = new Map<string, number>();
      for (const proposal of openProposals) {
        openByAsset.set(proposal.assetId, (openByAsset.get(proposal.assetId) || 0) + 1);
      }
      const pageLines = page.map((asset) => {
        const pending = openByAsset.get(asset.id) || 0;
        return pending ? `${listLine(asset)} | 待审批=${pending}` : listLine(asset);
      });
      return {
        content: [
          `认知资产清单：共 ${all.length} 条（${countNote}）${filterNote ? `；过滤：${filterNote} → ${pool.length} 条` : ''}`,
          `本页 ${offset + 1}-${offset + page.length} 条：`,
          '',
          ...pageLines,
          '',
          more > 0 ? `还有 ${more} 条：用 offset=${offset + page.length} 继续翻页。` : '这是最后一页。',
          '看某条全文用 read_ability_asset（传 assetId）。',
          ...(openProposals.length
            ? [`有 ${openProposals.length} 条提议还在等用户点头（上面标了「待审批」的资产）：用 list_asset_change_proposals 看内容；**处置权在用户**，你只能看和转达。`]
            : []),
        ].join('\n'),
      };
    },
  };
}

function createReadAbilityAssetTool(opts: AssetStewardToolsOpts): AgentTool {
  const userId = opts.userId;
  return {
    name: 'read_ability_asset',
    executionMode: 'parallel',
    description: [
      '读出一条认知资产的**完整正文**：单批最多 2000 字，长正文用 chunk 逐批读完（返回里会写明第几批/共几批与下一批的 chunk）。',
      '这是管理视角的全文读取，不受"一次 6 条、每条 2000 字"的目录取用限制；适合改动前先看清内容、核对某条到底写了什么。',
      '资产**不可用时不会返回正文**，而是如实说明原因（已删除/已暂停/来源被撤权/范围不符/命中禁用场景/敏感级过高/未分级等）——这不是"找不到"，别当成资产不存在，也别试图绕过。',
      '已删除的资产在保留期内仍然存在，但正文已不可用；要恢复它用 restore_ability_asset。',
      '这条资产若挂着**待审批提议**（AI 提过改动、用户还没定），返回里会点明：那类改动**不重复提交**，先把卡片的事告诉用户。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: '目录里的资产 id（aa- 开头）。' },
        chunk: { type: 'number', description: `第几批（从 0 开始），默认 0。一批 ${READ_CHUNK_CHARS} 字；返回会写明总批数与下一批编号。` },
      },
      required: ['assetId'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
      const assetId = typeof input.assetId === 'string' ? input.assetId.trim() : '';
      if (!safeId(assetId)) return { content: `不是合法的资产 id：${assetId || '(空)'}`, isError: true };
      const chunk = Math.max(0, Math.floor(Number(input.chunk) || 0));

      let asset: RecallAbilityAssetRecord;
      try {
        asset = await readAbilityAsset(userId, assetId);
      } catch (err) {
        log.warn('steward read failed', { userId: maskId(userId), assetId, error: logErrorRef(err as Error) });
        return { content: `[asset:${assetId}] 读取失败：这条资产不存在，或不属于当前用户。`, isError: true };
      }

      const reasons = await runtimeBlockReasons(opts, asset);
      if (reasons.length) {
        // 「被拦截不得计为成功」：isError 是平台自身的成功/失败信号，回执同时写明
        // 具体命中哪条规则——不静默当不存在，也不把正文交出去。
        return {
          content: [
            `[asset:${assetId}] ${asset.title || '(无标题)'}：当前不可读出正文。`,
            `状态：${statusText(asset.status)}`,
            `拦截规则：${blockReasonText(reasons)}`,
            asset.status === 'deleted'
              ? '这条在删除保留期内：可以恢复（restore_ability_asset），恢复后才能读到正文。'
              : '这是权限/状态门禁的结果，不是"资产不存在"。',
          ].join('\n'),
          isError: true,
        };
      }

      const statement = String(asset.statement || '');
      const totalChunks = Math.max(1, Math.ceil(statement.length / READ_CHUNK_CHARS));
      if (chunk >= totalChunks) {
        return {
          content: `chunk 越界：这条资产正文共 ${totalChunks} 批（chunk 从 0 开始），收到 ${chunk}。`,
          isError: true,
        };
      }
      const body = statement.slice(chunk * READ_CHUNK_CHARS, (chunk + 1) * READ_CHUNK_CHARS);
      const applies = (asset.applicableWhen || []).join('；');
      const forbids = (asset.forbiddenWhen || []).join('；');
      const nextHint = chunk + 1 < totalChunks
        ? `还有 ${totalChunks - chunk - 1} 批：用 chunk=${chunk + 1} 继续。`
        : '这是最后一批，正文已读完。';
      // 「这条有没有没定的卡片」是管理这条资产的第一手信息：不点明，模型会重提
      // 同一个变更（被去重挡住）、或者把"改不动"当成工具坏了。
      const openProposals = (await listOpenProposals(userId)).filter((proposal) => proposal.assetId === assetId);
      return {
        content: [
          `[asset:${assetId}] ${asset.title || '(无标题)'}`,
          metaLine(asset),
          // 条件行不能靠"过滤空串"来拼：正文与下一批提示之间那个空行是**故意**的，
          // 一起滤掉会让提示黏在正文末尾，模型分不清哪句是内容、哪句是工具话。
          ...(applies ? [`适用于: ${applies}`] : []),
          ...(forbids ? [`禁用: ${forbids}`] : []),
          `正文（第 ${chunk + 1}/${totalChunks} 批，共 ${statement.length} 字）:`,
          body,
          '',
          nextHint,
          ...(openProposals.length
            ? [
              '',
              `待审批提议（${openProposals.length} 条，**处置权在用户**）：`,
              ...openProposals.flatMap((proposal) => [
                `- ${proposalHeadline(proposal)}`,
                `  依据：${proposal.reason}`,
              ]),
              '不要重复提交同一个变更（会被去重挡住）；把卡片的事告诉用户，内容看 list_asset_change_proposals。',
            ]
            : []),
        ].join('\n'),
      };
    },
  };
}

// ── 待审批提议清单（US-406 读侧） ─────────────────────────────────────────
//
// 只读：处置权在用户手里，这里不提供任何"代拍"的形状。做这个工具的直接原因见
// 上面 `listOpenProposals` 的注释（子安真机反馈"拿不到待审批的内容"）。
const PROPOSAL_PAGE_DEFAULT = 20;
const PROPOSAL_PAGE_MAX = 50;
const PROPOSAL_STATES = ['pending', 'deferred', 'rejected', 'confirmed', 'all'] as const;

function createListAssetChangeProposalsTool(opts: AssetStewardToolsOpts): AgentTool {
  const userId = opts.userId;
  return {
    name: 'list_asset_change_proposals',
    executionMode: 'parallel',
    description: [
      '列出**AI 提过、等用户点头**的资产改动（对话里那张审批卡片），含拟生效内容、当前值、依据与状态。',
      '什么时候用：① 用户问"有哪些待审批/待确认"；② 盘点整个资产库、要交代"哪些需要你点头"；③ 改某条资产前先看它有没有挂着卡片（清单与 read_ability_asset 也会标）。',
      '**处置权在用户**：你只能看、只能把内容转达给用户；没有让你替用户确认/拒绝的通道，也不要重复提交同一个变更（会被去重挡住并说明）。',
      '默认只看等用户定夺的（pending）；"稍后处理"的用 state=deferred，看全部用 state=all。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: '只看某条资产的提议（aa- 开头）。不给就列全部。' },
        state: { type: 'string', description: `提议状态：pending（默认，等用户定夺）/ deferred（用户已稍后处理）/ rejected / confirmed / all。` },
        offset: { type: 'number', description: '从第几条开始（默认 0）。' },
        limit: { type: 'number', description: `一页条数：默认 ${PROPOSAL_PAGE_DEFAULT}、最大 ${PROPOSAL_PAGE_MAX}。` },
      },
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
      const stateInput = typeof input.state === 'string' && input.state.trim() ? input.state.trim() : 'pending';
      if (!(PROPOSAL_STATES as readonly string[]).includes(stateInput)) {
        return { content: `state 不认识：${stateInput}（可用：${PROPOSAL_STATES.join(' / ')}）`, isError: true };
      }
      const assetId = typeof input.assetId === 'string' && input.assetId.trim() ? input.assetId.trim() : '';
      if (assetId && !safeId(assetId)) return { content: `不是合法的资产 id：${assetId}`, isError: true };
      const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
      const limit = Math.min(PROPOSAL_PAGE_MAX, Math.max(1, Math.floor(Number(input.limit) || PROPOSAL_PAGE_DEFAULT)));

      let all: AssetChangeProposal[];
      try {
        all = await listAssetChangeProposals(userId, assetId ? { assetId } : {});
      } catch (err) {
        log.warn('steward proposal list failed', { userId: maskId(userId), error: logErrorRef(err as Error) });
        return { content: '读取待审批提议失败（详见应用日志）。', isError: true };
      }
      const filtered = stateInput === 'all' ? all : all.filter((proposal) => proposal.state === stateInput);
      if (!filtered.length) {
        // 「没有待审批」不等于「没有待办」：稍后处理的那批还在等用户，别让模型答成"啥也没有"。
        const deferred = all.filter((proposal) => proposal.state === 'deferred').length;
        if (stateInput === 'pending' && deferred) {
          return {
            content: `没有正等着用户现下点头的提议；但有 ${deferred} 条是"稍后处理"（state=deferred），仍在待确认清单里、还没被处置。用 state=deferred 或 state=all 看。`,
          };
        }
        return {
          content: stateInput === 'pending'
            ? '当前没有等用户点头的资产改动：没有待审批提议。'
            : `没有状态为 ${stateInput} 的提议${assetId ? `（资产 ${assetId}）` : ''}。`,
        };
      }
      const page = filtered.slice(offset, offset + limit);
      // 提议内容也是资产内容：正文该拦的，提议里也不能放行（同 runtimeBlockReasons）。
      const blocks: string[] = [];
      for (const proposal of page) {
        let asset: RecallAbilityAssetRecord;
        try {
          asset = await readAbilityAsset(userId, proposal.assetId);
        } catch (err) {
          log.warn('steward proposal asset read failed', { userId: maskId(userId), assetId: proposal.assetId, error: logErrorRef(err as Error) });
          blocks.push([
            `- ${proposalHeadline(proposal)}`,
            '  目标资产读不到（可能已被彻底清除）：提议仍留档，处置权在用户。',
          ].join('\n'));
          continue;
        }
        const reasons = await runtimeBlockReasons(opts, asset);
        if (reasons.length) {
          blocks.push([
            `- ${proposalHeadline(proposal, `[asset:${proposal.assetId}] ${asset.title || '(无标题)'}`)}`,
            `  提议内容暂不展示：这条资产当前对运行时不可读（${blockReasonText(reasons)}）。`,
            '  这不是"提议不存在"——卡片照旧在用户的对话里，处置权在他手里。',
          ].join('\n'));
          continue;
        }
        blocks.push([
          `- ${proposalHeadline(proposal, `[asset:${proposal.assetId}] ${asset.title || '(无标题)'}`)}`,
          ...proposalDetailLines(proposal).map((line) => `  ${line}`),
        ].join('\n'));
      }
      const more = filtered.length - (offset + page.length);
      return {
        content: [
          `待审批提议：共 ${filtered.length} 条（state=${stateInput}${assetId ? `，资产=${assetId}` : ''}）`,
          `本页 ${offset + 1}-${offset + page.length} 条：`,
          '',
          ...blocks,
          '',
          more > 0 ? `还有 ${more} 条：用 offset=${offset + page.length} 继续翻页。` : '这是最后一页。',
          '处置权在用户：你可以转达内容、按用户要求安排后续动作，但不能替他确认/拒绝。',
        ].join('\n'),
      };
    },
  };
}

// ── 危险操作的安全网（US-404 / T027–T028） ────────────────────────────────
//
// 危险操作 = **批量删除 / 清空 / 跨作用域扩大**（2026-09-23 定稿，与 Backlog
// v2.6 US-404 一致）。不新增工具：由既有工具在批量或跨作用域形态下**自动升级**。
// 执行链：执行前快照 → 经 InteractionHub 单次确认（approval 类，**超时 deny**）
// → 确认结果与快照一并记账。未获确认 → 不执行 + 如实回执（不得计为成功）。
//
// A3 权限位：这是「AI 自主实质变化」之外唯一设具名人类确认点的地方；A4（无人工
// 介入的破坏性动作）禁用。

export type DangerKind = 'batch_delete' | 'clear_all' | 'cross_scope_widen';

export const DANGER_KIND_LABELS: Record<DangerKind, string> = {
  batch_delete: '批量删除',
  clear_all: '清空资产库',
  cross_scope_widen: '跨作用域扩大',
};

export interface DangerAssessment {
  dangerous: boolean;
  kind?: DangerKind;
  /** 给用户看的确认文案：必须具体到"要动几条、动什么"，一句"危险操作"等于没确认。 */
  detail?: string;
}

/** 删除形态判定：单条不是危险操作（用户明确要求删一条就是一次正常治理），
 *  批量才是；批量覆盖到全库就是"清空"——两者都危险，但告诉用户的是两件事。 */
export function assessDeleteDanger(assetIds: readonly string[], librarySize: number): DangerAssessment {
  if (assetIds.length < 2) return { dangerous: false };
  if (librarySize > 0 && assetIds.length >= librarySize) {
    return {
      dangerous: true,
      kind: 'clear_all',
      detail: `要删除的 ${assetIds.length} 条覆盖了资产库里全部 ${librarySize} 条`,
    };
  }
  return { dangerous: true, kind: 'batch_delete', detail: `一次删除 ${assetIds.length} 条资产` };
}

/** 作用域维度的中文标签（确认文案里要逐维列出差异）。 */
const SCOPE_POLICY_DIMENSION_LABELS: Array<[keyof RecallAbilityAssetScopePolicy, string]> = [
  ['workspaceIds', '空间'],
  ['projectIds', '项目'],
  ['agentIds', 'Agent'],
  ['roleIds', '角色'],
  ['purposeTags', '用途'],
  ['conversationKinds', '会话类型'],
  ['fileKinds', '文件类型'],
];

function scopeValuesText(values: readonly string[] | undefined): string {
  return values && values.length ? [...values].sort().join('、') : '(无)';
}

/** 作用域授权的**方向与范围**（逐维 旧 → 新）。确认文案必须给出这个：
 *  只说"它能进出的空间从此不同"，用户看不懂自己在批什么，确认就退化成点一下。 */
export function describeScopePolicyChange(
  current: RecallAbilityAssetScopePolicy | undefined,
  next: RecallAbilityAssetScopePolicy,
): string {
  const changed = SCOPE_POLICY_DIMENSION_LABELS
    .filter(([key]) => scopeValuesText(current?.[key]) !== scopeValuesText(next[key]))
    .map(([key, label]) => `${label}：${scopeValuesText(current?.[key])} → ${scopeValuesText(next[key])}`);
  if (!changed.length) {
    return '作用域授权的取值没有实际变化（仍按危险操作处理：任何 scopePolicy 写入都要用户确认一次）';
  }
  const text = changed.join('；');
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * 作用域判定：动 `scopePolicy` 就是动"这条资产能进出哪些空间"，属跨作用域扩大。
 *
 * **任何 `scopePolicy` 写入都计危险，收窄方向也一样**——这是**刻意选择**，不是漏判：
 * 收窄也可能是"改错了把可用空间收没了"，而"多一次确认"永远比"漏一次扩权"便宜；
 * 而且一旦允许按方向免确认，判定就得先算出"这次算扩还是算收"，那条边界本身就是
 * 新的误判来源。由测试钉住（steward 的「任何 scopePolicy 写入都要确认」用例）。
 */
export function assessScopeWidenDanger(
  fields: Record<string, unknown>,
  current?: RecallAbilityAssetScopePolicy,
): DangerAssessment {
  if (fields.scopePolicy === undefined) return { dangerous: false };
  return {
    dangerous: true,
    kind: 'cross_scope_widen',
    detail: describeScopePolicyChange(current, fields.scopePolicy as RecallAbilityAssetScopePolicy),
  };
}

interface DangerGuardOutcome {
  allowed: boolean;
  /** 未获放行时的如实回执；放行时为 undefined。 */
  blockedReceipt?: string;
}

/** 执行前快照：每条受影响的资产记一条 `danger_snapshot`，锚点是"当时在用哪一版"
 *  ——内容本身就在版本流里，不另抄一份（另抄一份就是第二份正文副本，与"台账只存
 *  摘要"冲突）。回滚锚点让"事后回滚到操作前"有确定落点。 */
async function recordDangerSnapshots(
  opts: AssetStewardToolsOpts,
  assetIds: readonly string[],
  kind: DangerKind,
  reason: string,
): Promise<string[]> {
  const recorded: string[] = [];
  for (const assetId of assetIds) {
    try {
      const asset = await readAbilityAsset(opts.userId, assetId);
      await recordAbilityAssetAudit(opts.userId, assetId, 'danger_snapshot', {
        actor: 'ai',
        reason: `${DANGER_KIND_LABELS[kind]}前的执行前快照：${reason}`,
        before: `${statusText(asset.status)}；在用版=v${abilityAssetActiveVersion(asset)}`,
        rollbackAnchor: abilityAssetActiveVersion(asset),
      });
      recorded.push(assetId);
    } catch (err) {
      // 快照记不下来的资产**不进**这次危险操作：没有执行前快照就没有兜底。
      log.warn('danger snapshot failed', { assetId, error: logErrorRef(err as Error) });
    }
  }
  return recorded;
}

/**
 * 危险操作的执行链。返回 `allowed: false` 时调用方**必须零执行**。
 *
 * 无法发起确认（缺 cid/turnId，例如非会话上下文）时同样不放行：确认是这类操作
 * 的合法性来源，"问不到人"不等于"默认同意"。
 */
async function runDangerGuard(
  opts: AssetStewardToolsOpts,
  params: { kind: DangerKind; detail: string; assetIds: readonly string[]; reason: string },
): Promise<DangerGuardOutcome> {
  const { kind, detail, reason } = params;
  const label = DANGER_KIND_LABELS[kind];
  const snapshotted = await recordDangerSnapshots(opts, params.assetIds, kind, reason);
  const unrecorded = params.assetIds.filter((id) => !snapshotted.includes(id));
  if (unrecorded.length) {
    return {
      allowed: false,
      blockedReceipt: [
        `未能执行${label}：这些资产没能留下执行前快照，因此不执行（${unrecorded.join('、')}）。`,
        '归因：data（数据缺失/不存在）',
      ].join('\n'),
    };
  }
  if (!opts.cid || !opts.turnId) {
    return {
      allowed: false,
      blockedReceipt: [
        `未能执行${label}：当前上下文无法发起单次确认（缺会话/回合信息），危险操作不执行。`,
        '危险操作必须有用户的一次确认；"问不到人"不等于默认同意。',
        '归因：workflow（并发/流程冲突）',
      ].join('\n'),
    };
  }

  const resolved = await requestInteraction({
    uid: opts.userId,
    cid: opts.cid,
    turnId: opts.turnId,
    kind: 'approval',
    prompt: `资产管家请求执行危险操作：${label}`,
    detail: `${detail}；依据：${reason}`,
  });
  const decision = resolved.decision ?? 'deny';
  const allowed = decision === 'allow' || decision === 'allowAlways';
  const outcomeNote = allowed
    ? `用户已确认（${decision}）`
    : `未获确认（${resolved.reason}${resolved.decision ? `/${resolved.decision}` : ''}）`;
  for (const assetId of params.assetIds) {
    await recordAbilityAssetAudit(opts.userId, assetId, allowed ? 'danger_confirmed' : 'danger_denied', {
      actor: 'ai',
      reason: `${label}：${reason}`,
      note: outcomeNote,
      ...(allowed ? {} : { failureCategory: 'permission' as AbilityAssetFailureCategory }),
    });
  }
  if (allowed) return { allowed: true };
  return {
    allowed: false,
    blockedReceipt: [
      `未能执行${label}：${outcomeNote}，所以什么都没做。`,
      `本次请求：${detail}`,
      '归因：permission（权限或敏感级拦截）',
      resolved.reason === 'timeout'
        ? '确认超时按拒绝处理（不悬停）。要执行请重新发起并留意确认卡。'
        : '用户没有同意这次操作。如果确实需要，请先说明要动哪些资产、为什么。',
    ].join('\n'),
  };
}

// ── 写工具（US-402） ──────────────────────────────────────────────────────
//
// 全部落到既有 `asset-service.ts` 写函数，不新建第二套写通道；`actor` 一律 `'ai'`，
// 依据写进台账的 `reason`（FR-004）。**被拦截的操作不得计为成功**：失败回执带
// `isError`、写明拦截规则与归因分类。

/** 归因分类 → 人话（回执给模型看，模型再向用户解释）。 */
const FAILURE_CATEGORY_LABELS: Record<AbilityAssetFailureCategory, string> = {
  product: '产品规则',
  model: '模型侧',
  prompt: '提示词',
  data: '数据缺失/不存在',
  tool: '工具执行',
  permission: '权限或敏感级拦截',
  workflow: '并发/流程冲突',
  schema: '入参或记录形状不合法',
  governance: '治理状态拦截',
  evidence: '证据不足',
  unknown: '未归类',
};

/** 「AI 自主提出的实质变化」不得直接生效（specs/008 分级②）。
 *
 *  实质变化 = 方法正文 / 事实判断 / 适用范围 / 主题标签：
 *    - `statement`：正文即"这条资产主张什么"；
 *    - `scope` 与 `applicableWhen`/`forbiddenWhen`：它从此会进出哪一批任务；
 *    - `tags`（specs/012）：打什么标签是含义判断，"这条该归哪类"必须由
 *      用户拍板（spec AC5：从"劝说"升级为"闸门"）；用户明确指令则直接执行。
 *  命名/标题不在此列（分级③允许自动处理）。 */
export const SUBSTANTIAL_FIELDS = ['statement', 'scope', 'applicableWhen', 'forbiddenWhen', 'tags'] as const;

function writeReceipt(action: string, asset: RecallAbilityAssetRecord, extra: string[] = []): string {
  return [
    `已${action}：[asset:${asset.id}] ${asset.title || '(无标题)'}`,
    metaLine(asset),
    ...extra,
  ].join('\n');
}

/**
 * 失败回执 + 台账留痕（T032）：**被拦下的尝试也要留一条 `attempt_blocked`**。
 * 否则「零静默放行」只在成功路径上成立——拦下的那些事事后无从审计，也就无法
 * 回答"AI 到底试过什么、被什么规则挡住了"。
 *
 * `assetExists=false`（资产不存在）时无处可挂：台账按 assetId 分流，为一个不存在
 * 的 id 建流只会污染目录，所以只回执不留痕。
 */
async function blockedWriteReceipt(
  opts: AssetStewardToolsOpts,
  action: string,
  assetId: string,
  error: unknown,
  hint?: string,
  assetExists = true,
): Promise<{ content: string; isError: true }> {
  const category = classifyAbilityAssetWriteFailure(error);
  const message = error instanceof Error ? error.message : String(error);
  if (assetExists) {
    try {
      await recordAbilityAssetAudit(opts.userId, assetId, 'attempt_blocked', {
        actor: 'ai',
        reason: `尝试${action}被拦下`,
        note: message,
        failureCategory: category,
      });
    } catch (err) {
      // 留痕失败不影响回执：模型该知道的拦截原因优先。
      log.warn('attempt_blocked audit failed', { assetId, error: logErrorRef(err as Error) });
    }
  }
  return {
    content: [
      `未能${action}：[asset:${assetId}]`,
      `拦截规则：${message}`,
      `归因：${category}（${FAILURE_CATEGORY_LABELS[category]}）`,
      ...(hint ? [hint] : []),
    ].join('\n'),
    isError: true,
  };
}

/**
 * 分级②的落地：AI 自主的实质变化 → 建提议 + 发审批卡片，**内容不生效**。
 *
 * 卡片发不出去（没有会话上下文、或下发失败）时**退回拒绝兜底**：提议照留（用户
 * 仍能在待确认清单里看到），但回执必须说清"没有生效"——这条兜底与建卡路径各有
 * 测试，不许被建卡路径取代（提议建不出来时它是唯一的保证）。
 */
async function proposeSubstantialChange(
  opts: AssetStewardToolsOpts,
  params: {
    asset: RecallAbilityAssetRecord;
    assetId: string;
    payload: Record<string, unknown>;
    fields: readonly string[];
    reason: string;
    claimedUserInstruction: boolean;
    userInstructionVerified: boolean;
  },
): Promise<{ content: string; isError?: boolean }> {
  const { asset, assetId, payload, fields, reason } = params;
  const summary = summarizeAuditChange(
    diffAbilityAssetsForAudit(asset, { ...asset, ...payload }),
  );
  // 带上这几个字段**当前**的值：卡片要能显示"当前 → 拟生效"，用户才判断得了。
  const beforeValues: Record<string, unknown> = {};
  for (const key of fields) beforeValues[key] = (asset as unknown as Record<string, unknown>)[key];
  const { proposal, created } = await createAssetChangeProposal(opts.userId, {
    assetId,
    baselineVersion: abilityAssetActiveVersion(asset),
    fields: [...fields],
    payload,
    beforeValues,
    before: summary?.before || '',
    after: summary?.after || '',
    reason,
  });
  // approval_proposed 的台账由 createAssetChangeProposal 自己写（实体创建即留痕，
  // 不依赖调用方记得写）；这里只在**下发失败**时补一句"卡片没发出去"。

  const cannotApply = [
    `[asset:${assetId}] ${asset.title || '(无标题)'}：这次改动涉及实质内容（${fields.join(' / ')}），我没有直接生效。`,
    '原因：正文/适用范围变了，意味着这条资产主张的内容、或者它以后会进出哪一批任务变了，必须由用户确认。',
  ];
  const originHint = params.claimedUserInstruction && !params.userInstructionVerified
    ? '当前用户原话无法验证这项直写授权；模型提供的来源标记不构成用户授权。内容保持待审，请勿声称已经生效。'
    : '';

  const dispatched = await dispatchApprovalCard(opts, proposal, asset.title || '');
  if (dispatched.ok !== true) {
    const why = dispatched.reason === 'no_conversation'
      ? '当前上下文发不出审批卡片（缺会话信息），所以这次改动没有生效，也不会自动生效。'
      : `审批卡片下发失败（${dispatched.reason}），所以这次改动没有生效。`;
    return {
      content: [
        ...cannotApply,
        why,
        `提议已留档（proposal=${proposal.id}），用户在待确认清单里仍能看到。`,
        originHint,
      ].filter(Boolean).join('\n'),
      isError: true,
    };
  }
  return {
    content: [
      `**内容尚未生效**：[asset:${assetId}] ${asset.title || '(无标题)'} 的实质变化已转成审批卡片，等用户决定。`,
      `涉及：${fields.join(' / ')}`,
      `依据：${reason}`,
      `提议：${proposal.id}；卡片已发到当前对话。`,
      '用户三选一：确认更新（当场生效）/ 稍后处理（进待确认清单）/ 拒绝（留档、不再重复提）。',
      '现在**不要**告诉用户"已经改好了"——生效与否由用户在卡片上决定。',
      originHint,
    ].filter(Boolean).join('\n'),
  };
}

/** 下发卡片；失败时给出可归因的原因（回执里要如实说为什么没生效）。 */
async function dispatchApprovalCard(
  opts: AssetStewardToolsOpts,
  proposal: AssetChangeProposal,
  assetTitle: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!opts.cid) return { ok: false, reason: 'no_conversation' };
  try {
    const { attachAssetChangeProposalCard } = await import('../../features/recall/asset-approval-service');
    const posted = await postAssetChangeApprovalCard(opts.userId, opts.cid, proposal, assetTitle, busAssetApprovalCardPort());
    await attachAssetChangeProposalCard(opts.userId, proposal.id, posted.msg.id);
    return { ok: true };
  } catch (err) {
    log.warn('approval card dispatch failed', { proposalId: proposal.id, error: logErrorRef(err as Error) });
    return { ok: false, reason: (err as Error).message || 'unknown' };
  }
}

/**
 * 模型常把嵌套对象/数组当 **JSON 字符串**传。真机实测（2026-09-25，deepseek）：
 * 模型把 `fields` 发成 `"{\"body\":\"…\"}"`，连续 6 次编辑全部落在"fields 至少要给
 * 一个要改的字段"上，旗舰编辑路径整轮不可用。字符串能解析成对象/数组就解析，
 * 否则原样返回交给下游校验（不静默当成空）。
 */
function parseStructuredInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return value;
  try { return JSON.parse(text); } catch { return value; }
}

/** `fields` 的字段名别名：契约（`contracts/model-tools.md`）写的是 `body`，
 *  底层字段叫 `statement`；模型按契约说 `body` 是对的，两个都收。 */
const EDIT_FIELD_ALIASES: Record<string, string> = { body: 'statement' };

/** 编辑允许的字段名（含别名）。**认不出的键要显式拒绝**——静默丢弃会让回执说
 *  "已改动"而实际一字未动（比报错更糟）。`tags`/`category` 已解禁（specs/012
 *  T022）：category 不落字段，收编为一条标签并入 tags。 */
const EDIT_ACCEPTED_FIELDS = new Set([
  'title', 'statement', 'body', 'scope', 'applicableWhen', 'forbiddenWhen', 'scopePolicy', 'tags', 'category',
]);

function requireReason(value: unknown): string | { error: string } {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason) return { error: 'reason 必填：这次改动依据的是用户的哪句话/哪条证据？（它会被写进台账的「依据」）' };
  if (reason.length > 1_000) return { error: 'reason 太长（上限 1000 字）' };
  return reason;
}

/** 标签形状不合法的回执（specs/012 T022）：归因固定为 **schema**（入参形状问题，
 *  不是数据缺失）；拒绝而不是截断/丢弃——静默截断会让模型以为打标成功。 */
function tagShapeReceipt(assetId: string, problem: string): { content: string; isError: true } {
  return {
    content: [
      `未能改动：[asset:${assetId}]`,
      `拦截规则：${problem}`,
      '归因：schema（入参或记录形状不合法）',
      '标签规则：tags 是字符串数组（整体替换），每条 trim 后非空且 ≤20 字、去重后 ≤12 条（超限拒绝不截断）；category 是单个字符串，会收编为一条标签并入 tags。',
    ].join('\n'),
    isError: true,
  };
}

/** 把唯一规范化处抛出的稳定英文不变量消息翻成模型可读的中文（只翻译，不改判定）。 */
function tagShapeExplanation(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('exceeds 12')) return '标签去重后超过 12 条：请只保留最关键的（拒绝而不截断，不会替你挑）。';
  if (message.includes('exceeds 20')) return '单个标签名超过 20 字：标签是短名，不是句子。';
  if (message.includes('tags entry')) return '标签列表里混了非字符串或空白项：每条必须是 trim 后非空的字符串。';
  return 'tags 必须是字符串数组（整体替换），每条一个标签名。';
}

function createEditAbilityAssetTool(opts: AssetStewardToolsOpts): AgentTool {
  const userId = opts.userId;
  return {
    name: 'edit_ability_asset',
    description: [
      '改一条认知资产的内容：标题、正文、适用范围、适用/禁用场景、主题标签。**必须**说明依据（reason）。',
      '**分级（很重要）**：只有用户在当前消息里明确给出并逐字写出要改成的正文或单组标签值，主进程才允许直接改这项；含义由你补写、值来自旧上下文或用户指令不够具体时，不得把 origin 标成 user_instruction，必须走用户审批。你自己提出的正文/适用范围/标签实质变化也必须审批。',
      '读到的版本号（metaLine 里的「在用版」）请通过 expectedVersion 带回来：如果这条资产在你读取之后被改过（用户正在手动编辑），工具会拒绝而不是覆盖——重新读一次再决定。',
      '改动会写进台账（谁改的/时间/前后值/依据），并且随时可回滚（rollback_ability_asset）。',
      '主题标签：fields.tags 传字符串数组（整体替换；每条 trim 后非空且 ≤20 字、去重后 ≤12 条，超限拒绝不截断）；category 是旧入参，会**收编为一条标签**与 tags 合并去重（不再单独存在）。标签改动不 bump 内容版本，台账记「标签：旧 → 新」。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: '要改的资产 id（aa- 开头）。' },
        fields: {
          type: 'object',
          description: '要改的字段对象，至少给一个；没给的字段不动。必须传**对象**（例如 {"statement":"新正文"}），不要传 JSON 字符串。正文的键名是 statement（别名 body）。',
          properties: {
            title: { type: 'string', description: '标题（命名规范化）：非空；含汉字时 ≤16 个字，其他语言 ≤60 字符；不得与正文开头重复（第一个字都不能与正文相同）；不以标点结尾。不合规会被拒绝。' },
            statement: { type: 'string', description: '正文（上限 4000 字）。' },
            scope: { type: 'string', description: '适用范围。' },
            applicableWhen: { type: 'array', items: { type: 'string' }, description: '适用场景（整体替换；传空数组=清空）。' },
            forbiddenWhen: { type: 'array', items: { type: 'string' }, description: '禁用场景（整体替换；传空数组=清空）。' },
            tags: { type: 'array', items: { type: 'string' }, description: '主题标签（整体替换）：字符串数组，每条 ≤20 字、去重后 ≤12 条；传空数组=清空标签。' },
            category: { type: 'string', description: '分类（收编）：单个字符串，会作为一条标签并入 tags 合并去重，不单独存在。' },
            scopePolicy: {
              type: 'object',
              description: '作用域授权（这条资产能进出哪些空间/项目/Agent）。**改它属危险操作**：会先留执行前快照、再请用户单次确认。字段值都是字符串数组：purposeTags / agentIds / roleIds / projectIds / workspaceIds / conversationKinds / fileKinds。',
              additionalProperties: { type: 'array', items: { type: 'string' } },
            },
          },
          additionalProperties: false,
        },
        reason: { type: 'string', description: '改动依据：用户的原话或具体证据（必填，写进台账）。' },
        expectedVersion: { type: 'string', description: '你读到这条时的版本号；给了就要求与当前一致，不一致则拒绝（不静默覆盖）。' },
        origin: {
          type: 'string',
          description: '这只是你对来源的声明，不是授权凭据。主进程会核对当前用户消息；只有用户原话明确要求、且单项正文或标签改动值逐字匹配时，才允许直接改动。其他实质变化会进入用户审批。你自己提出的改动用 ai_initiated（缺省）。',
        },
      },
      required: ['assetId', 'fields', 'reason'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
      const assetId = typeof input.assetId === 'string' ? input.assetId.trim() : '';
      if (!safeId(assetId)) return { content: `不是合法的资产 id：${assetId || '(空)'}`, isError: true };
      const reasonOrError = requireReason(input.reason);
      if (typeof reasonOrError !== 'string') return { content: reasonOrError.error, isError: true };
      const reason = reasonOrError;
      const rawFields = parseStructuredInput(input.fields);
      const fieldsIn = (rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields))
        ? rawFields as Record<string, unknown>
        : {};
      // 别名归一：body → statement（契约名 → 底层字段名）。
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fieldsIn)) {
        fields[EDIT_FIELD_ALIASES[key] || key] = value;
      }
      const unknownFields = Object.keys(fields).filter((key) => fields[key] !== undefined && !EDIT_ACCEPTED_FIELDS.has(key));
      if (unknownFields.length) {
        return {
          content: [
            `未能改动：[asset:${assetId}]`,
            `拦截规则：不认识的字段名：${unknownFields.join(' / ')}`,
            '归因：schema（入参或记录形状不合法）',
            '可用的字段：title / statement（别名 body）/ scope / applicableWhen / forbiddenWhen / tags / category / scopePolicy。',
            '注意：fields 要传**对象**（不要传 JSON 字符串），例如 {"statement":"新正文"}。',
          ].join('\n'),
          isError: true,
        };
      }
      if (!Object.keys(fields).length) return { content: 'fields 里至少要给一个要改的字段。', isError: true };
      // 标签解禁（specs/012 T022，本 Epic 的核心一步）：tags / category 统一并入
      // 标签字段——category 不落任何字段，**收编为一条标签**与 tags 合并去重后
      // 从 tags 写入（写路径唯一走 updateAbilityAsset 的元数据路径：不 bump 版本、
      // 台账记「标签：旧 → 新」）。禁映射到 `assetType`（资产数据形态）或
      // `familyName`（系统自动的同源血缘，不是分类）；禁静默丢弃：形状不对就拒绝，
      // 归因 schema。trim / ≤20 字 / 去重 / ≤12 条只走 ability-tag-service 的
      // 唯一规范化，这里不另写一份判定。
      let tagsToWrite: string[] | undefined;
      if (fields.tags !== undefined || fields.category !== undefined) {
        const rawTags = parseStructuredInput(fields.tags);
        const names: unknown[] = [];
        if (fields.tags !== undefined) {
          if (!Array.isArray(rawTags)) {
            return tagShapeReceipt(assetId, 'tags 必须是字符串数组（整体替换，每条一个标签名），不要传单个字符串。');
          }
          names.push(...rawTags);
        }
        if (fields.category !== undefined) {
          if (typeof fields.category !== 'string') {
            return tagShapeReceipt(assetId, 'category 必须是单个字符串（它会被收编为一条标签，与 tags 合并去重，不单独存在）。');
          }
          names.push(fields.category);
        }
        try {
          tagsToWrite = normalizeAbilityTagList(names);
        } catch (error) {
          return tagShapeReceipt(assetId, tagShapeExplanation(error));
        }
        // tags 是唯一落点；category 作为字段名从这里消失（不落任何字段）。
        fields.tags = tagsToWrite;
        delete fields.category;
      }
      // touched 在收编**之后**算：category 已并入 tags，闸门与回执都按 tags 口径
      // （AI 自主传 category 打标同样算实质变化，不能从别名绕开审批）。
      const touched = Object.keys(fields).filter((key) => fields[key] !== undefined);
      // 系统边界：模型给的值先在这里收口。上限与 IPC/服务层同口径（条件 ≤32 条），
      // 不指望下游兜——下游抛的是英文不变量消息，对模型不够可读。
      for (const key of ['applicableWhen', 'forbiddenWhen'] as const) {
        fields[key] = parseStructuredInput(fields[key]);
        const value = fields[key];
        if (value === undefined) continue;
        if (!Array.isArray(value) || value.length > 32) {
          return { content: `${key} 要是字符串数组、且不超过 32 条。`, isError: true };
        }
      }
      if (fields.scopePolicy !== undefined) {
        fields.scopePolicy = parseStructuredInput(fields.scopePolicy);
        if (!fields.scopePolicy || typeof fields.scopePolicy !== 'object' || Array.isArray(fields.scopePolicy)) {
          return { content: 'scopePolicy 要是一个对象（字段值都是字符串数组），不要传 JSON 字符串。', isError: true };
        }
      }
      // `origin` 是模型提供的字段，不能自己证明用户授权。直接改正文或单组标签，
      // 必须同时满足：来源行由用户发出、只改这一项、改动值逐字来自该条用户消息，
      // 且用户明确下达了修改命令。其余实质变化沿用 AI 提议 + 用户审批卡的流程。
      const directFieldText = touched.length === 1 && touched[0] === 'statement'
        ? fields.statement
        : touched.length === 1 && touched[0] === 'tags' && Array.isArray(fields.tags)
          ? fields.tags.join('、')
          : undefined;
      const directUserEdit = input.origin === 'user_instruction'
        && opts.sourceMessageFromUser === true
        && typeof directFieldText === 'string'
        && classifyMemoryReplaceIntent(opts.taskText, directFieldText, true) === 'direct';
      const origin = directUserEdit ? 'user_instruction' : 'ai_initiated';

      let asset: RecallAbilityAssetRecord;
      try {
        asset = await readAbilityAsset(userId, assetId);
      } catch {
        return { content: `[asset:${assetId}] 这条资产不存在，或不属于当前用户。`, isError: true };
      }

      // 分级②：AI 自主提出的实质变化不直接生效。Phase 6 会在这一步之前建提议并
      // 发审批卡片；这里保留"绝不静默生效"这道底线——提议建不出来时也宁可拒绝。
      const substantial = touched.filter((key) => (SUBSTANTIAL_FIELDS as readonly string[]).includes(key));
      const fieldsOutsideProposal = touched.filter((key) => !(SUBSTANTIAL_FIELDS as readonly string[]).includes(key));
      if (origin !== 'user_instruction' && substantial.length) {
        if (fieldsOutsideProposal.length) {
          return blockedWriteReceipt(
            opts,
            '改动',
            assetId,
            new Error(`Mixed proposal fields are not supported: ${fieldsOutsideProposal.join(', ')}.`),
            '这次请求同时包含待审批的实质变化和不属于审批卡片的字段。没有任何字段生效；请分开提交，避免部分修改被遗漏。',
          );
        }
        // 只把**这次真正要改的**字段带进提议：提议的 payload 就是"确认后要写什么"。
        const proposalPayload: Record<string, unknown> = {};
        for (const key of substantial) proposalPayload[key] = fields[key];
        return proposeSubstantialChange(opts, {
          asset,
          assetId,
          payload: proposalPayload,
          fields: substantial,
          reason,
          claimedUserInstruction: input.origin === 'user_instruction',
          userInstructionVerified: directUserEdit,
        });
      }

      // 标题一等化（设计 3.2 / 深探 F2）：title 不在 SUBSTANTIAL_FIELDS（分级③
      // 允许 AI 直接处理命名），但不合规标题一个字都不能落库——工具层先过 3.1
      // 判定，不合规即拒绝并在回执里说明规范；asset-service 收口闸门是第二道
      // 保险。判定用的正文是在用正文：能走到这里的 title 改动从不与 statement
      // 同单（混合提交已在上面被拦下），写后正文＝在用正文。
      if (typeof fields.title === 'string') {
        try {
          assertCompliantAbilityAssetTitle(fields.title, String(asset.statement || ''));
        } catch (error) {
          return blockedWriteReceipt(
            opts,
            '改动',
            assetId,
            error,
            '标题规范（全模块统一）：非空；含汉字时不超过 16 个字，其他语言不超过 60 字符；不得与正文开头重复；不以标点结尾。',
          );
        }
      }

      // 危险操作：改 scopePolicy = 改写"这条资产能进出哪些空间"（跨作用域扩大）。
      // 与分级②（实质变化）是两条独立的闸：那是"要不要用户拍板内容"，这是
      // "要不要用户确认一次危险动作"。
      const scopeDanger = assessScopeWidenDanger(fields, asset.scopePolicy);
      if (scopeDanger.dangerous && scopeDanger.kind) {
        const guard = await runDangerGuard(opts, {
          kind: scopeDanger.kind, detail: scopeDanger.detail || '', assetIds: [assetId], reason,
        });
        if (!guard.allowed) return { content: guard.blockedReceipt || '未获确认，危险操作未执行。', isError: true };
      }

      const update: UpdateAbilityAssetInput = {
        reason,
        actor: 'ai',
        ...(typeof input.expectedVersion === 'string' && input.expectedVersion.trim()
          ? { expectedVersion: input.expectedVersion.trim() }
          : {}),
        ...(typeof fields.title === 'string' ? { title: fields.title } : {}),
        ...(typeof fields.statement === 'string' ? { statement: fields.statement } : {}),
        ...(typeof fields.scope === 'string' ? { scope: fields.scope } : {}),
        ...(Array.isArray(fields.applicableWhen) ? { applicableWhen: fields.applicableWhen.map(String) } : {}),
        ...(Array.isArray(fields.forbiddenWhen) ? { forbiddenWhen: fields.forbiddenWhen.map(String) } : {}),
        ...(tagsToWrite !== undefined ? { tags: tagsToWrite } : {}),
        ...(fields.scopePolicy !== undefined
          ? { scopePolicy: fields.scopePolicy as RecallAbilityAssetScopePolicy }
          : {}),
      };
      try {
        const updated = await updateAbilityAsset(userId, assetId, update);
        return {
          content: writeReceipt('改动', updated, [
            `改了什么：${touched.join(' / ')}`,
            `依据：${reason}`,
            '台账已记（actor=ai）；要撤销这次改动用 rollback_ability_asset。',
          ]),
        };
      } catch (err) {
        log.warn('steward edit failed', { userId: maskId(userId), assetId, error: logErrorRef(err as Error) });
        const conflicted = err instanceof Error && err.message.includes('version conflict');
        return blockedWriteReceipt(opts, '改动', assetId, err, conflicted
          ? '这条资产在你读取之后被改过（可能是用户正在手动编辑）。重新读一次，确认用户想要的改动后再决定要不要改。'
          : undefined);
      }
    },
  };
}

/** 四个"状态治理"写工具共用一张表：动作名 → 落到哪个既有函数 + 回执里补什么。 */
function createStatusActionTool(
  opts: AssetStewardToolsOpts,
  spec: {
    name: string;
    description: string;
    actionLabel: string;
    run: (userId: string, assetId: string, reason: string) => Promise<RecallAbilityAssetRecord>;
    extra?: (asset: RecallAbilityAssetRecord) => string[];
  },
): AgentTool {
  const userId = opts.userId;
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: '资产 id（aa- 开头）。' },
        reason: { type: 'string', description: '依据：用户的原话或具体理由（必填，写进台账）。' },
      },
      required: ['assetId', 'reason'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
      const assetId = typeof input.assetId === 'string' ? input.assetId.trim() : '';
      if (!safeId(assetId)) return { content: `不是合法的资产 id：${assetId || '(空)'}`, isError: true };
      const reasonOrError = requireReason(input.reason);
      if (typeof reasonOrError !== 'string') return { content: reasonOrError.error, isError: true };
      try {
        const asset = await spec.run(userId, assetId, reasonOrError);
        return { content: writeReceipt(spec.actionLabel, asset, spec.extra ? spec.extra(asset) : []) };
      } catch (err) {
        log.warn(`steward ${spec.name} failed`, { userId: maskId(userId), assetId, error: logErrorRef(err as Error) });
        return blockedWriteReceipt(opts, spec.actionLabel, assetId, err);
      }
    },
  };
}

function createDeleteAbilityAssetTool(opts: AssetStewardToolsOpts): AgentTool {
  const userId = opts.userId;
  return {
    name: 'delete_ability_asset',
    description: [
      '删除资产：进入 30 天保留期（保留期内可恢复），到期系统自动彻底删除、不可恢复。',
      '单条删除（assetId）是普通治理动作；**批量删除（assetIds，≥2 条）或清空整个资产库属危险操作**——会先留执行前快照、再请用户单次确认，用户不确认就什么都不做。',
      '**只在用户明确要求删除时用**。拿不准就用归档——归档没有不可逆的一天。',
      '要清空整个库时不要绕开这条规则分批删：那正是"批量删除"要防的事，且会绕过用户的确认。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: '要删除的单条资产 id（与 assetIds 二选一）。' },
        assetIds: { type: 'array', items: { type: 'string' }, description: '批量删除的资产 id 列表（≥2 条按危险操作处理，需用户单次确认）。' },
        reason: { type: 'string', description: '依据：用户的原话或具体理由（必填，写进台账）。' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
      const reasonOrError = requireReason(input.reason);
      if (typeof reasonOrError !== 'string') return { content: reasonOrError.error, isError: true };
      const reason = reasonOrError;
      const rawIds = [
        ...(typeof input.assetId === 'string' && input.assetId.trim() ? [input.assetId.trim()] : []),
        ...(Array.isArray(parseStructuredInput(input.assetIds))
          ? (parseStructuredInput(input.assetIds) as unknown[]).map((value) => String(value ?? '').trim()).filter(Boolean)
          : []),
      ];
      const ids = [...new Set(rawIds)];
      if (!ids.length) return { content: '要给 assetId 或 assetIds。', isError: true };
      if (ids.length > 200) return { content: `一次最多删 200 条（收到 ${ids.length} 条）。`, isError: true };
      const invalid = ids.filter((id) => !safeId(id));
      if (invalid.length) return { content: `不是合法的资产 id：${invalid.join('、')}`, isError: true };

      let librarySize = 0;
      try {
        librarySize = (await listAbilityAssets(userId)).filter((asset) => asset.status !== 'purged').length;
      } catch (err) {
        log.warn('steward delete list failed', { userId: maskId(userId), error: logErrorRef(err as Error) });
      }
      const danger = assessDeleteDanger(ids, librarySize);
      if (danger.dangerous && danger.kind) {
        const guard = await runDangerGuard(opts, {
          kind: danger.kind, detail: danger.detail || '', assetIds: ids, reason,
        });
        if (!guard.allowed) return { content: guard.blockedReceipt || '未获确认，危险操作未执行。', isError: true };
      }

      const deleted: string[] = [];
      const failures: string[] = [];
      for (const assetId of ids) {
        try {
          await deleteAbilityAsset(userId, assetId, { actor: 'ai', reason });
          deleted.push(assetId);
        } catch (err) {
          log.warn('steward delete failed', { userId: maskId(userId), assetId, error: logErrorRef(err as Error) });
          // 失败原因必须**回给模型**（同时留一条 attempt_blocked 台账）：只写台账
          // 不回执，模型就不知道是"这条已经没了"还是"权限不够"，只会重试。
          const receipt = await blockedWriteReceipt(opts, '删除', assetId, err);
          failures.push(receipt.content);
        }
      }
      const lines = [
        deleted.length
          ? `已删除 ${deleted.length}/${ids.length} 条（状态=${statusText('deleted')}，保留期内可恢复）：${deleted.join('、')}`
          : `已删除 0/${ids.length} 条：一条都没删掉`,
        ...(danger.dangerous ? [`本次按「${DANGER_KIND_LABELS[danger.kind!]}」处理，已留执行前快照并经用户确认。`] : []),
        ...(failures.length ? ['', ...failures] : []),
        // 保留期口径必须随回执一起给：用户此刻要知道"这东西什么时候会真的没了"。
        ...(deleted.length ? [t('recall.asset.delete_confirm_rules')] : []),
      ];
      // isError 只在整批都没删掉时置位（部分成功要让模型看见两边）——false 时不
      // 发这个键，免得下游拿"存在但为 false"当第三种状态。
      return {
        content: lines.join('\n'),
        ...(deleted.length === 0 ? { isError: true as const } : {}),
      };
    },
  };
}

function createMergeAbilityAssetsTool(opts: AssetStewardToolsOpts): AgentTool {
  const userId = opts.userId;
  return {
    name: 'merge_ability_assets',
    description: [
      '把一条重复资产并进另一条：source 的版本链并入 target（同一版本组），source 随即归档并记下归并去向，历史引用仍指向原条目可读。',
      '两条必须同类型；source 不能已经被并过。判断"重复"要谨慎——拿不准就先问用户，别把两条不同主张的资产并掉。',
      '并进之后 source 的正文不再作为在用内容；要撤销只能靠回滚各自版本，不能"反归并"。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        sourceAssetId: { type: 'string', description: '被并入的资产（会归档）。' },
        targetAssetId: { type: 'string', description: '保留下来的资产（版本链接收方）。' },
        reason: { type: 'string', description: '依据：为什么判定这两条重复（必填，写进台账）。' },
      },
      required: ['sourceAssetId', 'targetAssetId', 'reason'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
      const sourceAssetId = typeof input.sourceAssetId === 'string' ? input.sourceAssetId.trim() : '';
      const targetAssetId = typeof input.targetAssetId === 'string' ? input.targetAssetId.trim() : '';
      if (!safeId(sourceAssetId) || !safeId(targetAssetId)) return { content: 'sourceAssetId / targetAssetId 不是合法的资产 id。', isError: true };
      const reasonOrError = requireReason(input.reason);
      if (typeof reasonOrError !== 'string') return { content: reasonOrError.error, isError: true };
      try {
        const merged = await mergeAbilityAssets(userId, sourceAssetId, targetAssetId, { actor: 'ai', reason: reasonOrError });
        return {
          content: writeReceipt('归并', merged, [
            `被并入的条目：${sourceAssetId}（已归档，历史引用仍指向它）`,
            '台账已记（两条各一条：merged_from / merged_into）。',
          ]),
        };
      } catch (err) {
        log.warn('steward merge failed', { userId: maskId(userId), error: logErrorRef(err as Error) });
        return blockedWriteReceipt(opts, '归并', targetAssetId, err, undefined, true);
      }
    },
  };
}

function createRollbackAbilityAssetTool(opts: AssetStewardToolsOpts): AgentTool {
  const userId = opts.userId;
  return {
    name: 'rollback_ability_asset',
    description: [
      '把一条资产回滚到某个历史版本：用那一版的内容**生成一个新版本**，历史版本号不回退（已经引用过旧版的任务不受影响）。',
      '回滚本身也进台账（actor=ai + 依据），所以"改错了再改回来"这条链是完整的。',
      '先用 read_ability_asset 或版本列表确认目标版本号；回滚不改治理状态（暂停过的不会因为回滚变回在用）。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: '资产 id（aa- 开头）。' },
        toVersion: { type: 'string', description: '要回滚到的版本号（纯数字字符串，如 "2"）。' },
        reason: { type: 'string', description: '依据（必填，写进台账）。' },
      },
      required: ['assetId', 'toVersion', 'reason'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
      const assetId = typeof input.assetId === 'string' ? input.assetId.trim() : '';
      const toVersion = typeof input.toVersion === 'string' ? input.toVersion.trim() : String(input.toVersion ?? '').trim();
      if (!safeId(assetId)) return { content: `不是合法的资产 id：${assetId || '(空)'}`, isError: true };
      if (!/^[0-9]{1,9}$/.test(toVersion)) return { content: `toVersion 要是纯数字版本号，收到：${toVersion || '(空)'}`, isError: true };
      const reasonOrError = requireReason(input.reason);
      if (typeof reasonOrError !== 'string') return { content: reasonOrError.error, isError: true };
      try {
        const asset = await rollbackAbilityAsset(userId, assetId, toVersion, { actor: 'ai', reason: reasonOrError });
        return {
          content: writeReceipt('回滚', asset, [
            `回滚到 v${toVersion}（已作为新版本 v${asset.version} 落地，历史不回退）`,
            '台账已记（rolled_back + 前后值）。',
          ]),
        };
      } catch (err) {
        log.warn('steward rollback failed', { userId: maskId(userId), assetId, error: logErrorRef(err as Error) });
        return blockedWriteReceipt(opts, '回滚', assetId, err);
      }
    },
  };
}

/** 资产管家工具面（US-401 的两个读工具；US-402 的 6 个写工具在本文件后续扩展）。
 *  只读会话不变量：这些工具**都不进** `runner.ts` 的闭合只读白名单——该白名单是
 *  「无副作用 actor 的最小工具集」，而资产库是用户私有全量数据，开给从属 actor
 *  属权限扩张。由 `test/main/model/core-agent/asset-steward-tools.test.ts` 钉住。 */
export function createAssetStewardTools(opts: AssetStewardToolsOpts): AgentTool[] {
  return [
    createListAbilityAssetsTool(opts),
    createReadAbilityAssetTool(opts),
    createListAssetChangeProposalsTool(opts),
    createEditAbilityAssetTool(opts),
    createMergeAbilityAssetsTool(opts),
    createStatusActionTool(opts, {
      name: 'archive_ability_asset',
      actionLabel: '归档',
      description: [
        '归档一条资产：从日常列表与推荐里移出，内容、证据与历史都保留，随时可恢复（restore_ability_asset）。',
        '适合"这条现在用不上但别删"的情况。删除（delete_ability_asset）会进保留期，比归档更重。',
      ].join(''),
      run: (userId, assetId, reason) => archiveAbilityAsset(userId, assetId, { actor: 'ai', reason }),
    }),
    createDeleteAbilityAssetTool(opts),
    createStatusActionTool(opts, {
      name: 'restore_ability_asset',
      actionLabel: '恢复',
      description: [
        '把一条资产放回在用：已归档的、以及已删除但仍在保留期内的都可以恢复。',
        '保留期已过或已彻底清除的会被拒绝并说明原因——那是终态，恢复不成立。',
      ].join(''),
      run: (userId, assetId, reason) => restoreAbilityAsset(userId, assetId, { actor: 'ai', reason }),
    }),
    createRollbackAbilityAssetTool(opts),
  ];
}
