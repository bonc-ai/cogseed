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
import { logErrorRef, maskId } from '../../util/log-redact';
import { createSearchAbilityAssetsTool, type AssetSearchOptions } from '../../features/recall/asset-search';
import { catalogSnapshot } from '../../features/recall/catalog-engine';
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

const log = createLogger('recall-tools');

export interface RecallToolsOpts extends AssetSearchOptions {
  userId: string;
  onAssetUsageClaim?: (claim: AssetUsageClaim) => void | Promise<void>;
  suppliedAbilityAssets?: Array<{ assetId: string; assetVersion: string }>;
  /** Evidence from assets already injected by the host before the model run. */
  initialEvidence?: OntologyAnswerEvidenceBundle;
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
      createSearchAbilityAssetsTool(opts.userId, opts, evidence.assets),
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
