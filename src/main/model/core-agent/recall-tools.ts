import { ambiguousRecallAssetIds, assessSemanticApplicability, type SemanticApplicabilityResult } from '../../features/recall/semantic-applicability';
/**
 * Recall ability-asset search tool injected into every main-conv runner.
 *
 *   - `search_ability_assets` — 三种用法：
 *     ① 不带 query、不带 assetIds → **目录模式**：返回全量在用资产目录
 *        （一行一条：id/标题/类型/范围/成熟度/版本/使用次数/适用与禁用场景），
 *        模型自己看着目录判断要用哪几条 —— "目录在手，按需取用"；
 *     ② 带 assetIds → **正文模式**：按目录里的 id 取完整正文（≤6 条/次）；
 *     ③ 带 query → **混合检索**。搜索结果只记展示；按 ID 读完整正文
 *     才写 `agent_read` 注入回执与使用流水。
 *
 * 引用（自动注入 / 预载投影）只显示本空间产生的
 * 资产；全局资产池（所有空间产生的 + 全局资产）的使用交给 LLM 的主动检索
 * ——即本工具。只读，无需 localExec 权限（与 kb 工具一致）。
 */

import type { AgentTool } from '#core-agent';
import { createLogger } from '../../logger';
import { listAbilityAssets, readAbilityAsset } from '../../features/recall/asset-service';
import {
  evaluateRecallAssetAgentReadEligibility,
  filterRecallAssetsForAgentRead,
  recallAssetAgentReadBlockReasons,
  type RecallAgentReadContext,
} from '../../features/recall/prompt-injection';
import { loadOntologyAssets } from '../../features/recall/projection-knowledge';
import { formatCatalogEntries } from '../../features/recall/asset-catalog';
import type { RecallAbilityAssetRecord } from '../../features/recall/candidate-service';
import { safeId } from '../../storage';
import { logErrorRef, maskId } from '../../util/log-redact';
import { catalogMatches } from '../../features/recall/catalog-relevance';
import {
  catalogOrderedToolPool,
  catalogSnapshot,
  type CatalogContext,
} from '../../features/recall/catalog-engine';
import { recordCatalogObservations } from '../../features/recall/catalog-observation';
import {
  queryOntologyAssets,
  type OntologyAssetQueryDirection,
} from '../../features/recall/ontology-asset-query';
import type { AbilityAssetRelationKind } from '../../features/recall/asset-relations';
import {
  recordOntologyAnswerValidation,
  validateOntologyAnswer,
  type AnswerAssetEvidence,
  type AnswerRelationEvidence,
  type OntologyAnswerEvidenceBundle,
} from '../../features/recall/ontology-answer-validation';
import { isSemanticaEnabled } from '../../features/recall/semantica-settings';
import { prepareAssetUsageClaim, type AssetUsageClaim } from '../../features/recall/asset-usage-claim';

import { buildFormalAssetPayload, instantiateAssetTemplate, resolveFormalAssetPayload } from '../../features/recall/formal-assets/payload';
import { recordAssetAgentReads as recordAgentReads } from '../../features/recall/agent-read-accounting';
const log = createLogger('recall-tools');

export interface RecallToolsOpts {
  userId: string;
  onAssetUsageClaim?: (claim: AssetUsageClaim) => void | Promise<void>;
  suppliedAbilityAssets?: Array<{ assetId: string; assetVersion: string }>;
  /** 当前目标 Agent；用于资产 scopePolicy.agentIds 准入判断。 */
  agentId?: string;
  /** 当前回合 id：写 agent_read 注入回执/使用流水用；缺省时只读不记账。 */
  turnId?: string;
  /** Conversation id（预留：回执/流水定位用）。 */
  cid?: string;
  /** 当前会话空间；作为 runtime scopePolicy.workspaceIds 上下文。 */
  spaceId?: string;
  /** 空间主角色模板；作为 runtime scopePolicy.roleIds 上下文。 */
  roleId?: string;
  /** 当前会话类型；作为 runtime scopePolicy.conversationKinds 上下文。 */
  conversationKind?: string;
  /** 当前回合附件类型；作为 runtime scopePolicy.fileKinds 上下文。 */
  fileKinds?: readonly string[];
  /** 会话的项目归属：目录模式 scene 因子用（与提示词常驻
   *  目录同序的前提：同一份场景输入）；缺省时该维度不参与。 */
  projectId?: string;
  /** 当前用户消息文本：适用/禁用场景匹配用。 */
  taskText?: string;
  /** Evidence from assets already injected by the host before the model run. */
  initialEvidence?: OntologyAnswerEvidenceBundle;
}

const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 30;
/** 正文模式单次取用上限：一次取太多等于绕回"整块塞正文"，目录化的意义就没了。 */
const MAX_READ_IDS = 6;
const CATALOG_PAGE_DEFAULT = 30;
const CATALOG_PAGE_MAX = 50;

/** 检索池条目：正式资产 or legacy profile memory（onto-*，无投影授权）。 */
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

interface RecallTurnEvidence {
  assets: Map<string, AnswerAssetEvidence>;
  relations: AnswerRelationEvidence[];
}

export interface RecallFinalResponseGate {
  isRequired(): boolean;
  validate(input: { text: string; signal?: AbortSignal }): Promise<{ text: string }>;
}

export interface RecallToolSuite {
  tools: AgentTool[];
  finalResponseGate: RecallFinalResponseGate;
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
    ...(asset.profileSource ? [`来源:遗留画像记忆(${asset.profileSource})，仅供参考`] : []),
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
  maturity_below_default_use: '置信度不足（未确认/未验证）',
};

function blockReasonText(reasons: readonly string[]): string {
  const labels = reasons.map((reason) => BLOCK_REASON_LABELS[reason] || reason);
  return labels.length ? labels.join('；') : '当前上下文不可使用';
}

/** 正文读取和语义检索必须用同一份运行时上下文，避免入口各自漏传边界字段。
 *  `spaceId` 是目的地 workspace，不是资产内容用途 `scope`。 */
function agentReadRuntimeContext(opts: RecallToolsOpts): RecallAgentReadContext {
  return {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.roleId ? { roleId: opts.roleId } : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.spaceId ? { workspaceId: opts.spaceId } : {}),
    ...(opts.conversationKind ? { conversationKind: opts.conversationKind } : {}),
    ...(opts.fileKinds?.length ? { fileKinds: [...opts.fileKinds] } : {}),
    ...(opts.taskText ? { taskText: opts.taskText } : {}),
  };
}

/** 正文模式的一条（含版本与范围，便于模型判断适用性）。 */
function formatReadEntry(asset: RecallAbilityAssetRecord, version: string, payload = buildFormalAssetPayload(asset)): string {
  const meta = [
    `类型:${asset.type || '?'}`,
    `范围:${asset.scope || 'general'}`,
    `成熟度:${asset.maturity || '?'}`,
    `版本:v${version}`,
  ].join(' | ');
  const applies = (asset.applicableWhen || []).join('；');
  const forbids = (asset.forbiddenWhen || []).join('；');
  return [
    `[asset:${asset.id}] ${asset.title || '(无标题)'}`,
    meta,
    applies ? `适用于: ${applies}` : '',
    forbids ? `禁用: ${forbids}` : '',
    '结构: ' + JSON.stringify(payload),
    '正文:',
    asset.statement || '',
  ].filter(Boolean).join('\n');
}

/** 画像记忆 → 检索池条目；记忆本身不带 status/spaceId 治理态。 */
async function profilePoolEntries(
  userId: string,
  context: RecallAgentReadContext,
  assets: RecallAbilityAssetRecord[],
): Promise<PoolEntry[]> {
  try {
    const personalAssets = assets.filter((asset) => asset.type === 'personal');
    const readablePersonalAssets = await filterRecallAssetsForAgentRead(userId, personalAssets, context);
    const formalStatements = new Set(readablePersonalAssets.map((asset) => asset.statement.trim()));
    return (await loadOntologyAssets(userId, {
      allowedPersonalAssetIds: new Set(readablePersonalAssets.map((asset) => asset.id)),
    })).map((asset) => ({
      id: asset.id,
      title: asset.title,
      statement: asset.statement,
      scope: asset.scope,
      type: asset.type,
      maturity: asset.maturity,
      profileSource: asset.evidenceRefs[0]?.id || 'memory',
    })).filter((asset) => !formalStatements.has(asset.statement.trim()));
  } catch {
    // memory 文件缺失/损坏不阻断检索——资产池照常可搜。
    return [];
  }
}

/**
 * agent_read 留痕：模型自己取用的资产也写注入回执 + 使用流水。
 *   - 回执幂等（同回合同资产同版本只一条），所以重复取用不会刷次数；
 *   - 使用流水按"该回合首次取用"记一次，避免同回合反复读把统计刷高；
 *   - 记账失败只告警，绝不影响工具结果（模型拿得到内容优先）。
 */

function createSearchAbilityAssetsTool(opts: RecallToolsOpts, evidence: RecallTurnEvidence): AgentTool {
  const userId = opts.userId;
  let semanticCheckSpent = false;
  const semanticChecks = new Map<string, SemanticApplicabilityResult>();

  const catalogContext = (): CatalogContext => ({
    ...(opts.cid ? { cid: opts.cid } : {}),
    ...(opts.turnId ? { turnId: opts.turnId } : {}),
    ...(opts.taskText ? { taskText: opts.taskText } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.roleId ? { roleId: opts.roleId } : {}),
    ...(opts.conversationKind ? { conversationKind: opts.conversationKind } : {}),
    ...(opts.fileKinds?.length ? { fileKinds: [...opts.fileKinds] } : {}),
    scene: {
      ...(opts.projectId ? { turnProjectId: opts.projectId } : {}),
      ...(opts.spaceId ? { turnSpaceId: opts.spaceId } : {}),
    },
  });

  /** The prompt and tool catalog use the same turn snapshot. Live runtime
   * admission is repeated before returning a tool page. */
  const rankCatalogPool = async (
    pool: RecallAbilityAssetRecord[],
  ): Promise<RecallAbilityAssetRecord[]> => {
    try {
      return catalogOrderedToolPool(userId, catalogContext(), pool);
    } catch (err) {
      log.warn('asset catalog build failed', { userId: maskId(userId), error: logErrorRef(err as Error) });
      return [];
    }
  };

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
    pool = await filterRecallAssetsForAgentRead(userId, pool, agentReadRuntimeContext(opts));
    const filterNote = [
      typeFilter ? `type=${typeFilter}` : '',
      scopeFilter ? `scope=${scopeFilter}` : '',
      spaceIdFilter ? `spaceId=${spaceIdFilter}` : '',
    ].filter(Boolean).join('，');
    if (!pool.length) {
      return `当前条件下没有可用于本任务的认知资产（可能没有在用资产、筛选未命中，或当前任务不满足使用规则${filterNote ? `；过滤条件：${filterNote}` : ''}）。`;
    }
    // 过滤（准入/筛选）先于排序、排序先于分页：过滤后的集合整段按同一
    // 推荐分排（只排不裁——顺序变化，条目一条不少），再切页。
    const ordered = await rankCatalogPool(pool);
    if (!ordered.length) {
      return `当前条件下没有可用于本任务的认知资产${filterNote ? `（过滤条件：${filterNote}）` : ''}。`;
    }
    const page = ordered.slice(offset, offset + k);
    if (!page.length) {
      // offset 越界：给"已到末尾 + 总数"的明确语义，而不是一个空页（模型据此
      // 停止翻页，而不是以为目录坏了）。
      return `已到目录末尾（共 ${ordered.length} 条${filterNote ? `；过滤条件：${filterNote}` : ''}，offset 从 0 开始）。用 offset=0 从头看，或去掉过滤条件。`;
    }
    const snapshot = await catalogSnapshot(userId, catalogContext());
    const stats = new Map([...snapshot.adoption].map(([id, stat]) => [id, { count: stat.appliedCount }]));
    const more = ordered.length - (offset + page.length);
    await recordCatalogObservations(userId, {
      turnId: opts.turnId, cid: opts.cid, stage: 'tool_page_shown',
      assets: page.map((asset) => ({ id: asset.id, version: String(asset.activeVersion || asset.version || '1') })),
    });
    return [
      `认知资产目录（当前可用 ${ordered.length} 条${filterNote ? `，过滤：${filterNote}` : ''}；本页 ${offset + 1}-${offset + page.length} 条；用N次=实际采用）：`,
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
    if (input.templateValues !== undefined && ids.length !== 1) return { content: '模板填写需要明确指定一条模板资产。', isError: true };
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
      let eligibility: Awaited<ReturnType<typeof evaluateRecallAssetAgentReadEligibility>>;
      try {
        eligibility = await evaluateRecallAssetAgentReadEligibility(userId, asset, agentReadRuntimeContext(opts));
      } catch (err) {
        log.warn('asset runtime eligibility failed during id read', {
          userId: maskId(userId), assetId: maskId(asset.id), error: logErrorRef(err as Error),
        });
        blocks.push(`- [asset:${id}] 当前不可使用（准入检查暂不可用）`);
        continue;
      }
      // applicableWhen 是目录中的适用性提示，不以词面匹配拒绝模型的明确读取。
      // 硬边界仍包括状态 / 来源可用 / scopePolicy / 禁用场景 / 敏感度 /
      // Agent 与项目/空间白名单。
      const reasons = recallAssetAgentReadBlockReasons(eligibility);
      if (reasons.length) {
        blocks.push(`- [asset:${id}] 当前不可使用（${blockReasonText(reasons)}）`);
        continue;
      }
      const version = String(asset.activeVersion || asset.version || '1');
      const payload = await resolveFormalAssetPayload(userId, asset);
      if (input.templateValues !== undefined) {
        try { blocks.push(formatReadEntry(asset, version, payload) + '\n填充结果:\n' + instantiateAssetTemplate(asset, input.templateValues)); }
        catch { blocks.push(`- [asset:${id}] 模板填写失败：请提供完整的槽位值；未登记读取。`); continue; }
      } else blocks.push(formatReadEntry(asset, version, payload));
      readEntries.push({ assetId: asset.id, assetVersion: version });
      evidence.assets.set(asset.id, {
        assetId: asset.id,
        title: asset.title,
        version,
        statement: String(asset.statement || ''),
      });
    }
    await recordAgentReads(opts, readEntries);
    await recordCatalogObservations(userId, {
      turnId: opts.turnId, cid: opts.cid, stage: 'body_read',
      assets: readEntries.map((entry) => ({ id: entry.assetId, version: entry.assetVersion })),
    });
    return {
      ...(input.templateValues !== undefined && readEntries.length === 0 ? { isError: true } : {}),
      content: [
        `已取出 ${readEntries.length} 条资产正文${skipped > 0 ? `（单次最多 ${MAX_READ_IDS} 条，忽略了多余的 ${skipped} 条）` : ''}：`,
        '',
        ...blocks,
        '',
        '引用格式：[asset:<id>]。',
      ].join('\n'),
    };
  };

  /** 混合检索模式：query 必填；embedding 失败仍可词面和专名检索。 */
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
    // 正式资产先过与按 ID 读取相同的运行时准入门，再交给 embedding 排序。
    // 画像记忆是独立的背景记忆通道，保留既有显式标注语义。
    const filteredAssets = assets.filter((asset) => (
      asset.status === 'active'
      && (!scopeFilter || asset.scope === scopeFilter)
      && (!spaceIdFilter || asset.spaceId === spaceIdFilter)
    ));
    const eligibleFormalAssets = await filterRecallAssetsForAgentRead(userId, filteredAssets, agentReadRuntimeContext(opts));
    const eligibleFormalPool: PoolEntry[] = eligibleFormalAssets.map((asset) => ({
      id: asset.id,
      title: asset.title,
      statement: asset.statement,
      scope: asset.scope,
      type: asset.type,
      maturity: asset.maturity,
      version: String(asset.activeVersion || asset.version || '1'),
      ...(asset.spaceId ? { spaceId: asset.spaceId } : {}),
    }));
    let pool: PoolEntry[] = eligibleFormalPool;
    const profileEntries = await profilePoolEntries(userId, agentReadRuntimeContext(opts), assets);
    if (!spaceIdFilter) pool = [...pool, ...profileEntries];
    if (scopeFilter) pool = pool.filter((asset) => asset.scope === scopeFilter);
    if (spaceIdFilter) pool = pool.filter((asset) => asset.spaceId === spaceIdFilter);
    if (!pool.length) {
      return { content: `当前条件下没有可用于语义检索的认知资产（可能没有在用资产、筛选未命中，或当前任务不满足使用规则${profileEntries.length ? `；另有画像记忆 ${profileEntries.length} 条被过滤条件排除` : ''}）`, isError: false };
    }

    const matches = await catalogMatches(userId, query, pool.map((asset) => ({
      id: asset.id, title: asset.title, statement: asset.statement,
    })));
    const ranked = pool
      .map((asset) => ({ asset, score: matches.get(asset.id)?.score || 0 }))
      .sort((left, right) => right.score - left.score || left.asset.id.localeCompare(right.asset.id));

    let top = ranked.slice(0, k);
    const selectionNotes: string[] = [];
    // Query is a retrieval hint, never a replacement for the complete host
    // request. Explicit body reads and reviewed preference entrypoints retain
    // their contract; this gate only disambiguates automatic search ranking.
    if (opts.taskText) {
      const formal = top.filter(item => !item.asset.profileSource).map(item => eligibleFormalAssets.find(asset => asset.id === item.asset.id)!).filter(Boolean);
      const ambiguousIds = ambiguousRecallAssetIds(formal, opts.taskText, eligibleFormalAssets);
      const ambiguous = formal.filter(asset => ambiguousIds.has(asset.id));
      if (ambiguous.length) {
        const key = JSON.stringify([opts.taskText, agentReadRuntimeContext(opts), ambiguous, eligibleFormalAssets]);
        let assessment = semanticChecks.get(key);
        if (!assessment && !semanticCheckSpent) {
          semanticCheckSpent = true;
          try {
            assessment = await assessSemanticApplicability(userId, opts.taskText, ambiguous, agentReadRuntimeContext(opts), undefined, eligibleFormalAssets);
            semanticChecks.set(key, assessment);
          } catch { /* Unresolved search hits are not asserted applicable. */ }
        }
        const decisions = assessment?.decisions;
        const allowed = new Set((decisions || []).filter(row => row.verdict === 'applicable').map(row => row.assetId));
        top = top.filter(item => !ambiguousIds.has(item.asset.id) || allowed.has(item.asset.id));
        for (const asset of ambiguous) {
          const decision = decisions?.find(row => row.assetId === asset.id);
          const unassessed = assessment?.unassessed.find(row => row.assetId === asset.id);
          if (unassessed) { selectionNotes.push(`[asset:${asset.id}@v${unassessed.version}] not_evaluated: semantic_applicability_${unassessed.reason}`); continue; }
          selectionNotes.push(`[asset:${asset.id}@v${asset.activeVersion || asset.version}] ${decision?.verdict || 'uncertain'}: ${decision?.reason || 'Applicability unresolved; read explicitly only if you can resolve the conditions from the current task.'}`);
        }
        const rank = new Map((decisions || []).map(row => [row.assetId, row.rank]));
        const slots = top.flatMap((item, index) => ambiguousIds.has(item.asset.id) ? [index] : []);
        const ordered = slots.map(index => top[index]).sort((a, b) => (rank.get(a.asset.id) ?? 100) - (rank.get(b.asset.id) ?? 100));
        slots.forEach((slot, index) => { top[slot] = ordered[index]; });
      }
    }
    const profileInPool = pool.filter((entry) => entry.profileSource).length;
    await recordCatalogObservations(userId, {
      turnId: opts.turnId, cid: opts.cid, stage: 'search_result_shown',
      assets: top.filter((item) => !item.asset.profileSource && item.asset.version)
        .map((item) => ({ id: item.asset.id, version: String(item.asset.version) })),
    });
    return {
      content: [
        `混合检索候选共 ${pool.length} 条（当前可用正式资产 ${pool.length - profileInPool}${profileInPool ? ` + 独立画像记忆 ${profileInPool}` : ''}${scopeFilter ? `，scope=${scopeFilter}` : ''}${spaceIdFilter ? `，spaceId=${spaceIdFilter}` : ''}），返回最相关的 ${top.length} 条：`,
        '',
        ...top.map((item, index) => `${index + 1}. ${formatAsset(item.asset, item.score)}`),
        '',
        ...selectionNotes,
        '搜索结果是线索；采用正式资产前用 assetIds 读取完整正文，并检查适用与禁用条件。',
        '引用格式：[asset:<id>]，例如 [asset:aa-xxx]。',
      ].join('\n'),
    };
  };

  return {
    name: 'search_ability_assets',
    // Catalog embedding calls are isolated from receipt accounting.
    executionMode: 'parallel',
    description: [
      '用户的认知资产目录：本 App 里沉淀下来的规则、模板、方法、偏好——用户自己的经验，不是通用知识。',
      '**任务一开始就先看一眼目录（不带任何参数调一次）**：里面常常有正好适用的模板或教训，照着它做比从零想更快，也更符合这位用户的既定习惯；目录很便宜（每条一行），不必省这一步。',
      '目录摘要、语义检索和按 ID 取正文都会按当前 Agent、项目、空间、来源状态与使用规则做同一套准入检查；不可用于当前任务的正式资产不会出现在目录或检索结果中。',
      '三种用法：①不带参数 = 全量目录（一行一条，可带 type/scope/spaceId 过滤、offset 翻页）；',
      '②assetIds = 取某几条的完整正文（最多 6 条/次）——看到目录里有合适的，取正文再动手；',
      '③query = 语义、词面与专名混合检索（覆盖当前可用正式资产 + 遗留画像记忆；遗留记忆会标注来源并仅供参考）。',
      '目录很长时带 query 检索；搜索摘要只是线索，采用前须用 assetIds 读完整正文。',
      '读到正文仍不算采用。若本轮有 report_ability_asset_usage 且你确实据此形成产出，在最终回复前报告具体资产版本和产出原文片段；只写“已采用”不会生成回执。',
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
        templateValues: { type: 'object', additionalProperties: { type: 'string' }, description: 'Template slot values; only with one template asset id. All slots must be filled.' },
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
      if (input.templateValues !== undefined && !hasIds) return { content: '模板填写需要明确指定一条模板资产。', isError: true };
      if (hasIds) return runRead(input);
      const query = String(input.query || '').trim();
      if (query) return runSearch(input);
      return { content: await runCatalog(input) };
    },
  };
}

function createOntologyQueryTool(opts: RecallToolsOpts, evidence: RecallTurnEvidence): AgentTool {
  const relationKinds = new Set<AbilityAssetRelationKind>([
    'refines', 'depends_on', 'replaces', 'conflicts_with', 'related_to', 'same_family',
  ]);
  const directions = new Set<OntologyAssetQueryDirection>(['incoming', 'outgoing', 'both']);

  return {
    name: 'ontology_query',
    executionMode: 'parallel',
    description: [
      '按用户已沉淀的认知资产关系查询可复用资产，并返回可核对的关系证据路径。',
      '适合“哪些资产依赖 X”“X 依赖哪些资产”“哪些资产替代/细化/冲突于 X”等问题；支持最多 4 跳。',
      '查询只在当前回合资产目录已经通过状态、来源、Agent、项目、空间和使用规则准入的正式资产上执行，不会绕过治理边界。',
      '结果只含资产元数据和关系路径；采用资产前仍用 search_ability_assets 的 assetIds 模式读取正文，长期使用再用 attach_assets_to_task。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 500,
          description: '自然语言关系问题，例如“哪些资产依赖 本体查询示例：API 网关”。',
        },
        target: {
          type: 'string',
          maxLength: 200,
          description: '可选目标资产 ID 或准确标题；提供后优先于从 query 推断。',
        },
        relationKind: {
          type: 'string',
          enum: ['refines', 'depends_on', 'replaces', 'conflicts_with', 'related_to', 'same_family'],
          description: '可选关系类型；省略时从 query 推断，无法推断则查询全部关系。',
        },
        direction: {
          type: 'string',
          enum: ['incoming', 'outgoing', 'both'],
          description: 'incoming=谁指向目标，outgoing=目标指向谁，both=双向。省略时从 query 推断。',
        },
        maxHops: { type: 'integer', minimum: 1, maximum: 4, description: '最大关系跳数，默认 1。' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回多少个匹配资产，默认 30。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>) {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query || query.length > 500) return { content: 'ontology_query: query 必须是 1-500 字的文本', isError: true };
      const target = input.target === undefined ? undefined : String(input.target || '').trim();
      if (target !== undefined && (!target || target.length > 200)) {
        return { content: 'ontology_query: target 必须是 1-200 字的资产 ID 或标题', isError: true };
      }
      const relationKind = input.relationKind as AbilityAssetRelationKind | undefined;
      if (relationKind !== undefined && !relationKinds.has(relationKind)) {
        return { content: 'ontology_query: relationKind 无效', isError: true };
      }
      const direction = input.direction as OntologyAssetQueryDirection | undefined;
      if (direction !== undefined && !directions.has(direction)) {
        return { content: 'ontology_query: direction 无效', isError: true };
      }

      try {
        const snapshot = await catalogSnapshot(opts.userId, {
          ...(opts.cid ? { cid: opts.cid } : {}),
          ...(opts.turnId ? { turnId: opts.turnId } : {}),
          ...(opts.taskText ? { taskText: opts.taskText } : {}),
          ...(opts.agentId ? { agentId: opts.agentId } : {}),
          ...(opts.roleId ? { roleId: opts.roleId } : {}),
          ...(opts.conversationKind ? { conversationKind: opts.conversationKind } : {}),
          ...(opts.fileKinds?.length ? { fileKinds: [...opts.fileKinds] } : {}),
          scene: {
            ...(opts.projectId ? { turnProjectId: opts.projectId } : {}),
            ...(opts.spaceId ? { turnSpaceId: opts.spaceId } : {}),
          },
        });
        const result = queryOntologyAssets(snapshot.assets, {
          query,
          ...(target ? { target } : {}),
          ...(relationKind ? { relationKind } : {}),
          ...(direction ? { direction } : {}),
          ...(input.maxHops !== undefined ? { maxHops: Number(input.maxHops) } : {}),
          ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
        });
        if (result.status === 'ok') {
          evidence.relations.push({ query, result });
          await recordCatalogObservations(opts.userId, {
            turnId: opts.turnId,
            cid: opts.cid,
            stage: 'search_result_shown',
            assets: result.matches.map((match) => ({
              id: match.asset.id,
              version: String(match.asset.activeVersion || match.asset.version || '1'),
            })),
          });
        }
        return { content: JSON.stringify({ schemaVersion: 1, query, ...result }, null, 2) };
      } catch (error) {
        log.warn('ontology asset query failed', { userId: maskId(opts.userId), error: logErrorRef(error as Error) });
        return { content: 'ontology_query: 本体资产关系查询暂不可用，请改用 search_ability_assets', isError: true };
      }
    },
  };
}

/** Build the tools and the final-response gate over one shared turn evidence set. */
export function createRecallToolSuite(opts: RecallToolsOpts): RecallToolSuite {
  const semanticaEnabled = isSemanticaEnabled(opts.userId);
  const evidence: RecallTurnEvidence = { assets: new Map(), relations: [] };
  if (semanticaEnabled && opts.initialEvidence) {
    for (const asset of opts.initialEvidence.assets) evidence.assets.set(asset.assetId, { ...asset });
    evidence.relations.push(...opts.initialEvidence.relations.map((relation) => ({
      ...relation,
      ...(relation.paths ? {
        paths: relation.paths.map((path) => ({
          ...path,
          evidencePath: path.evidencePath.map((edge) => ({ ...edge })),
        })),
      } : {}),
    })));
  }
  const finalResponseGate: RecallFinalResponseGate = {
    isRequired: () => semanticaEnabled && (evidence.assets.size > 0 || evidence.relations.length > 0),
    validate: async ({ text, signal }) => {
      // The legacy recall path must remain behaviorally unchanged while
      // Semantica is off, even if search_ability_assets read asset bodies.
      if (!semanticaEnabled) return { text };
      const input = {
        query: String(opts.initialEvidence?.taskText || opts.taskText || ''),
        answer: text,
        assets: [...evidence.assets.values()],
        relations: [...evidence.relations],
        ...(opts.turnId || opts.cid ? { requestId: String(opts.turnId || opts.cid) } : {}),
      };
      try {
        const result = await validateOntologyAnswer(input, {
          rolloutKey: opts.userId,
          // Local deterministic checks are the authority for evidence,
          // relationship direction and direct/indirect consistency.
          mode: 'observe',
          ...(signal ? { signal } : {}),
        });
        await recordOntologyAnswerValidation(opts.userId, input, result).catch((error) => {
          log.warn('ontology answer validation receipt failed', {
            userId: maskId(opts.userId), error: logErrorRef(error as Error),
          });
        });
        return { text: result.answer };
      } catch (error) {
        log.warn('ontology answer validation failed open', {
          userId: maskId(opts.userId), error: logErrorRef(error as Error),
        });
        // The validator is a judgment gate, not the source of truth. Runtime
        // failures must not erase an answer or artifact the model completed.
        return { text };
      }
    },
  };
  return {
    tools: [
      createSearchAbilityAssetsTool(opts, evidence),
      ...(semanticaEnabled ? [createOntologyQueryTool(opts, evidence)] : []),
      ...createAssetUsageReportTools(opts),
    ],
    finalResponseGate,
  };
}

function createAssetUsageReportTools(opts: RecallToolsOpts): AgentTool[] {
  const tools: AgentTool[] = [];
  if (opts.onAssetUsageClaim && opts.turnId) tools.push({
    name: 'report_ability_asset_usage',
    description: '报告本轮确实采用的一条资产及读到的版本。完成产出后、最终回复前调用，outputExcerpt 必须是本轮最终消息或已发布文件中的原文片段（12至500字），具体体现这条资产如何影响产出。文件无需再贴入聊天；不能转义换行、改写引文或引用工具过程。只读取、列目录、提及名称不算采用。此工具只登记待核验报告；主进程核对当轮供应或主动读取记录（search_ability_assets 的 assetIds 正文模式）及实际持久化成果后才留下采用回执，不代表效果已验证。无法核验则只记采用未知，不改变成果正文。不采用则不要调用。多条资产分别报告，不要把同一工具成功算给所有引用。',
    inputSchema: {
      type: 'object', properties: {
        assetId: { type: 'string' }, assetVersion: { type: 'string', description: '读到的版本，例如 1 或 v1。' },
        outputExcerpt: { type: 'string', minLength: 12, maxLength: 500 },
      }, required: ['assetId', 'assetVersion', 'outputExcerpt'], additionalProperties: false,
    },
    async execute(input: Record<string, unknown>) {
      try {
        const claim = await prepareAssetUsageClaim(opts.userId, opts.turnId!, input, opts.suppliedAbilityAssets || []);
        await opts.onAssetUsageClaim!(claim);
        return { content: '采用报告已登记，等待最终消息持久化后核验；尚未生成采用回执，也未验证效果。' };
      } catch {
        return { content: '未登记：需要本轮已供应或已读正文（search_ability_assets 的 assetIds 模式）的资产及版本、12至500字的最终产出原文片段；没有生成采用回执。', isError: true };
      }
    },
  });
  return tools;
}
