import { createHash } from 'node:crypto';

import { safeId } from '../../storage';
import { loadEntries } from '../memory';
import { userMemoryFile, userProfileFile } from '../../paths';
import { loadOntologyRules } from './ontology-rules';
import { loadOntologyTaxonomy } from './ontology-taxonomy';
import { normalizeCognitionSourceRefs } from './source-service';
import { readAbilityAsset } from './asset-service';
import type { RecallAbilityAssetRecord } from './candidate-service';
import { readGroups, listGroupFields, isStaleAsOf } from '../personal_ontology_groups';
import { readLiveConflicts } from './ontology-conflicts';
import { splitScopeTerms, type AssetScopeContext } from './scope-policy';
import {
  readContextProjection,
  validateCommittedProjectionAssetVersions,
} from './context-projection';
import type {
  WorldModelAbilityAsset,
  WorldModelCausalRuleRef,
} from './world-model-types';

const MAX_ASSETS = 12;
const MAX_ASSET_CONTENT_CHARS = 14_000;
const MAX_EVIDENCE_REFS = 20;
const MAX_ONTOLOGY_ASSETS = 12;
const MAX_ONTOLOGY_STATEMENT = 1_000;
const MAX_ONTOLOGY_FACTS = 24;
const MAX_ONTOLOGY_FACT_CANDIDATES = 512;
const MAX_ONTOLOGY_FACT_VALUE = 500;

export interface CommittedProjectionKnowledge {
  projectionId: string;
  projectionPurpose: string;
  projectionConfirmedAt: string;
  workspaceId?: string;
  projectId?: string;
  abilityAssetRefs: string[];
  abilityAssets: WorldModelAbilityAsset[];
  assetVersions: Record<string, string>;
  /** Whole assets omitted from the knowledge budget; never partial bodies. */
  omittedAssetIds?: string[];
  /** 本次加载实际读到的资产记录快照：注入层据此免于
   *  对同一资产再各读一遍全库——快照即本轮事实，miss 罕见时才回退直读。 */
  loadedRecords?: ReadonlyMap<string, RecallAbilityAssetRecord>;
  rules: WorldModelCausalRuleRef[];
  /** Runtime-eligible personal assets as background profile context. */
  ontologyAssets: WorldModelAbilityAsset[];
  ontologyFacts: import('./world-model-types').WorldModelOntologyFact[];
  /** T-Box concept definitions (ontology group ledger + field vocabulary). */
  ontologyTaxonomy: Awaited<ReturnType<typeof loadOntologyTaxonomy>>;
  /** R-Box (ontology): durable business rules from relation fields. */
  ontologyRules: Awaited<ReturnType<typeof loadOntologyRules>>['rules'];
}

/** 导出作测试缝：世界模型侧矛盾标记的直接用例入口；
 *  生产调用方仍是 loadCommittedProjectionKnowledge 一处。 */
export async function loadOntologyFacts(
  userId: string,
  context: { projectId?: string; workspaceId?: string; taskText?: string } = {},
): Promise<import('./world-model-types').WorldModelOntologyFact[]> {
  const facts: import('./world-model-types').WorldModelOntologyFact[] = [];
  // factKey 由组、字段及归一值组成，读侧按 id 去重，
  // 防止旧空白变体重复占用 top-24 预算。
  const seenFactIds = new Set<string>();
  let groups: ReturnType<typeof readGroups>;
  try {
    groups = readGroups(userId).slice(0, 48);
  } catch {
    return facts;
  }
  for (const group of groups) {
    let fields: Awaited<ReturnType<typeof listGroupFields>>;
    try {
      fields = await listGroupFields(userId, group.group_id);
    } catch {
      continue;
    }
    if (!fields.ok || !fields.fields) continue;
    for (const field of fields.fields) {
      for (const entry of field.values) {
        // @proj values are bound to app projects, not spaces/workspaces. If
        // the current project is unknown, omit project-bound values (fail closed).
        if (entry.project && entry.project !== context.projectId) continue;
        // 敏感性：restricted 值不进任务自动上下文与世界模型
        // （用户在对话里显式 @ 该组仍会带全文——显式选择即授权）。
        if (entry.sensitivity === 'restricted') continue;
        const value = String(entry.value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ONTOLOGY_FACT_VALUE);
        if (!value) continue;
        const factKey = createHash('sha256')
          .update(`${group.group_id}\0${field.name}\0${value}`)
          .digest('hex');
        const factId = `po-fact-${factKey.slice(0, 24)}`;
        if (seenFactIds.has(factId)) continue;
        seenFactIds.add(factId);
        facts.push({
          id: factId,
          groupTitle: String(group.title || group.group_id).slice(0, 200),
          field: String(field.name || '').trim().slice(0, 200),
          value,
          source: 'personal_ontology',
          ...(entry.project ? { projectId: entry.project } : {}),
          ...(entry.asOf ? { asOf: entry.asOf, ...(isStaleAsOf(entry.asOf) ? { needsRefresh: true } : {}) } : {}),
          ...(entry.verified ? { verified: entry.verified } : {}),
        });
        if (facts.length >= MAX_ONTOLOGY_FACT_CANDIDATES) break;
      }
      if (facts.length >= MAX_ONTOLOGY_FACT_CANDIDATES) break;
    }
    if (facts.length >= MAX_ONTOLOGY_FACT_CANDIDATES) break;
  }
  // 矛盾标记：一次读只读索引（readLiveConflicts
  // 不写盘、不触发自愈），命中 (组标题, 字段) 的事实挂 disputed + 非受限对端
  // （≤2 条、每条截 MAX_ONTOLOGY_FACT_VALUE）；对端受限只置位不带文本。
  // 无矛盾时不增加标记字段，保持下游产物不变。
  let liveConflicts: Array<{ groupId: string; field: string; valueA: string; valueB: string; aRestricted: boolean; bRestricted: boolean }> = [];
  try {
    liveConflicts = await readLiveConflicts(userId);
  } catch {
    liveConflicts = [];
  }
  if (liveConflicts.length) {
    const titleByGroupId = new Map(groups.map((group) => [group.group_id, String(group.title || group.group_id)]));
    const byKey = new Map(liveConflicts.map((pair) => [`${titleByGroupId.get(pair.groupId) || pair.groupId}\0${pair.field}`, pair]));
    for (const fact of facts) {
      const pair = byKey.get(`${fact.groupTitle}\0${fact.field}`);
      if (!pair) continue;
      const others = [pair.aRestricted ? null : pair.valueA, pair.bRestricted ? null : pair.valueB]
        .filter((value): value is string => Boolean(value) && value !== fact.value)
        .map((value) => value.replace(/\s+/g, ' ').trim().slice(0, MAX_ONTOLOGY_FACT_VALUE))
        .filter(Boolean)
        .slice(0, 2);
      fact.disputed = true;
      if (others.length) fact.conflictedWith = others;
    }
  }
  const taskTokens = splitScopeTerms(context.taskText || '').map((token) => token.toLocaleLowerCase());
  return facts
    .map((fact, index) => {
      const searchable = `${fact.groupTitle} ${fact.field} ${fact.value}`.toLocaleLowerCase();
      return { fact, index, score: taskTokens.filter((token) => searchable.includes(token)).length };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_ONTOLOGY_FACTS)
    .map(({ fact }) => fact);
}

/** 画像标题 ≤80 字时原样呈现；超长在句读边界截断并加省略号。 */
function ontologyTitle(statement: string): string {
  if (statement.length <= 80) return statement;
  const head = statement.slice(0, 80);
  let cut = -1;
  for (const mark of ['。', '；', '，', '、', '；', ' ', ',', ';']) {
    cut = Math.max(cut, head.lastIndexOf(mark));
  }
  // 边界太靠前（前 40 字内无断点）时保长度优先，硬切。
  const base = cut >= 40 ? head.slice(0, cut + 1) : head;
  return `${base}…`;
}

/** Legacy USER/MEMORY 文件条目 → 虚拟画像条目（onto-<sha256 prefix>，bud/v1
 *  伪造值）。仅在资产库没有任何 personal 记录（迁移未跑）的过渡回退里使用：
 *  那里「不是资产」，伪造的治理字段是如实的。正式个人资产走真实字段镜像。 */
function ontologyAssetFromEntry(
  text: string,
  source: 'user_profile' | 'shared_memory',
): WorldModelAbilityAsset | null {
  const statement = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ONTOLOGY_STATEMENT);
  if (!statement) return null;
  const contentKey = createHash('sha256').update(statement).digest('hex');
  return {
    id: `onto-${contentKey.slice(0, 24)}`,
    version: '1',
    title: ontologyTitle(statement) || 'Personal ontology',
    type: 'personal',
    statement,
    scope: 'general',
    maturity: 'bud',
    ontologyRefs: [],
    evidenceRefs: normalizeCognitionSourceRefs([{
      kind: 'memory',
      id: source,
      title: source === 'user_profile' ? 'User profile' : 'Shared memory',
    }]),
  };
}

/** Load personal assets through the same formal store and runtime gate.
 * Mirrors preserve the asset's real id, version, maturity, title, scope and evidence.
 * Callers supply the IDs admitted for the current task; profile presentation does
 * not create projection citations. Legacy USER/MEMORY files are a fallback only
 * after a successful store read confirms that no personal asset records exist. */
export async function loadOntologyAssets(
  userId: string,
  options: { allowedPersonalAssetIds?: ReadonlySet<string> } = {},
): Promise<WorldModelAbilityAsset[]> {
  const assets: WorldModelAbilityAsset[] = [];
  let personal: RecallAbilityAssetRecord[] = [];
  let personalAssetStoreRead = false;
  let hasPersonalAssetRecords = false;
  try {
    const { listAbilityAssets } = await import('./asset-service');
    const personalRecords: RecallAbilityAssetRecord[] = (await listAbilityAssets(userId))
      .filter((asset) => asset.type === 'personal');
    personalAssetStoreRead = true;
    hasPersonalAssetRecords = personalRecords.length > 0;
    personal = personalRecords.filter((asset) => (
      asset.status === 'active'
      && (options.allowedPersonalAssetIds === undefined || options.allowedPersonalAssetIds.has(asset.id))
    ));
  } catch {
    personal = [];
  }
  if (personalAssetStoreRead && hasPersonalAssetRecords) {
    for (const record of personal) {
      assets.push({
        id: record.id,
        version: record.version,
        title: record.title,
        type: record.type,
        statement: record.statement,
        ...(record.applicableWhen ? { applicableWhen: [...record.applicableWhen] } : {}),
        ...(record.forbiddenWhen ? { forbiddenWhen: [...record.forbiddenWhen] } : {}),
        scope: record.scope,
        maturity: record.maturity,
        ontologyRefs: (record.ontologyRefs || []).map((ref) => ({ ...ref })),
        evidenceRefs: record.evidenceRefs.slice(0, MAX_EVIDENCE_REFS).map((ref) => ({ ...ref })),
      });
      if (assets.length >= MAX_ONTOLOGY_ASSETS) break;
    }
    return assets;
  }
  // 过渡回退：资产库还没有画像（迁移未跑）时读文件。
  let statements: Array<{ text: string; name: 'user_profile' | 'shared_memory' }> = [];
  if (personalAssetStoreRead && !hasPersonalAssetRecords) {
    for (const { file, name } of [
      { file: userProfileFile(userId), name: 'user_profile' as const },
      { file: userMemoryFile(userId), name: 'shared_memory' as const },
    ]) {
      try {
        for (const entry of loadEntries(file)) {
          statements.push({ text: entry.text, name });
        }
      } catch { /* missing file is not a forecast blocker */ }
    }
  }
  for (const entry of statements) {
    const asset = ontologyAssetFromEntry(entry.text, entry.name);
    if (asset) assets.push(asset);
    if (assets.length >= MAX_ONTOLOGY_ASSETS) break;
  }
  return assets;
}

export async function loadCommittedProjectionKnowledge(
  userId: string,
  projectionId: string,
  context: AssetScopeContext & { taskText?: string; allowedPersonalAssetIds?: ReadonlySet<string> } = {},
): Promise<CommittedProjectionKnowledge> {
  const projection = await readContextProjection(userId, projectionId);
  let conversationScope: { projectId?: string; workspaceId?: string } = {};
  if (projection.conversationId && (!projection.projectId || !projection.workspaceId)) {
    try {
      const { getConversation } = await import('../chats');
      const conversation = await getConversation(userId, projection.conversationId);
      if (conversation) {
        conversationScope = {
          ...(conversation.project_id && safeId(conversation.project_id) ? { projectId: conversation.project_id } : {}),
          ...(conversation.space_id && safeId(conversation.space_id) ? { workspaceId: conversation.space_id } : {}),
        };
      }
    } catch {
      // Old projections may outlive conversation metadata; preserve the
      // projection's captured context and let scope policies fail closed.
    }
  }
  const projectId = context.projectId ?? projection.projectId ?? conversationScope.projectId;
  const workspaceId = context.workspaceId ?? projection.workspaceId ?? conversationScope.workspaceId;
  const hasTaskPurpose = context.purpose !== undefined || Boolean(context.taskText);
  const runtimeScope: AssetScopeContext = {
    ...(hasTaskPurpose ? {
      purpose: [projection.purpose, context.purpose, context.taskText].filter(Boolean).join('\n'),
    } : {}),
    ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
    ...(context.roleId !== undefined ? { roleId: context.roleId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(context.conversationKind !== undefined ? { conversationKind: context.conversationKind } : {}),
    ...(context.fileKinds !== undefined ? { fileKinds: context.fileKinds } : {}),
  };
  // 单次快照：validate、knowledge、prompt 注入此前对同一资产各做一次
  // 全库读；这里先读一遍建快照传给 validate 复用，并随返回值带给注入层。
  // 读不到的条目不进快照——validate 的回退重读会按原语义（missing/停用）处理。
  const assetSnapshot = new Map<string, RecallAbilityAssetRecord>();
  for (const assetId of projection.assetIds.slice(0, MAX_ASSETS)) {
    try {
      assetSnapshot.set(assetId, await readAbilityAsset(userId, assetId));
    } catch {
      // 快照缺席交给 validate 的回退读取判定，不在预读层另行分类。
    }
  }
  const assetVersions = await validateCommittedProjectionAssetVersions(userId, projection, runtimeScope, assetSnapshot);
  const assets: RecallAbilityAssetRecord[] = [];
  for (const assetId of projection.assetIds.slice(0, MAX_ASSETS)) {
    // validateCommittedProjectionAssetVersions 会省略当前已停用的资产；只读
    // 仍有效且版本一致的子集，避免同一投影中的单条暂停使其他资产也不可用。
    if (!Object.prototype.hasOwnProperty.call(assetVersions, assetId)) continue;
    // 快照命中是常态；miss（预读瞬时失败而 validate 回退成功）罕见，才回退直读。
    assets.push(assetSnapshot.get(assetId) ?? await readAbilityAsset(userId, assetId));
  }
  const completeAssets: WorldModelAbilityAsset[] = assets.map((asset) => ({
    id: asset.id,
    version: asset.version,
    title: asset.title,
    type: asset.type,
    statement: asset.statement,
    ...(asset.applicableWhen ? { applicableWhen: [...asset.applicableWhen] } : {}),
    ...(asset.forbiddenWhen ? { forbiddenWhen: [...asset.forbiddenWhen] } : {}),
    scope: asset.scope,
    maturity: asset.maturity,
    ...(asset.learningSignal ? { learningSignal: asset.learningSignal } : {}),
    ...(asset.causalRule ? { causalRule: asset.causalRule } : {}),
    ontologyRefs: (asset.ontologyRefs || []).map((ref) => ({ ...ref })),
    evidenceRefs: asset.evidenceRefs.slice(0, MAX_EVIDENCE_REFS).map((ref) => ({ ...ref })),
  }));
  const abilityAssets: WorldModelAbilityAsset[] = [];
  const omittedAssetIds: string[] = [];
  for (const asset of completeAssets) {
    if (JSON.stringify([...abilityAssets, asset]).length > MAX_ASSET_CONTENT_CHARS) omittedAssetIds.push(asset.id);
    else abilityAssets.push(asset);
  }
  const rules: WorldModelCausalRuleRef[] = abilityAssets.flatMap((asset) => (
    asset.causalRule
      ? [{
          id: `rule:${asset.id}:${asset.version}`,
          assetId: asset.id,
          assetVersion: asset.version,
          rule: asset.causalRule,
        }]
      : []
  ));
  const ontologyAssets = await loadOntologyAssets(userId, {
    ...(context.allowedPersonalAssetIds !== undefined
      ? { allowedPersonalAssetIds: context.allowedPersonalAssetIds }
      : {}),
  });
  return {
    projectionId: projection.id,
    projectionPurpose: projection.purpose,
    projectionConfirmedAt: projection.confirmedAt || projection.decidedAt || projection.createdAt,
    ...(workspaceId ? { workspaceId } : {}),
    ...(projectId ? { projectId } : {}),
    abilityAssetRefs: abilityAssets.map((asset) => asset.id),
    abilityAssets,
    assetVersions: Object.fromEntries(abilityAssets.map((asset) => [asset.id, assetVersions[asset.id]])),
    loadedRecords: assetSnapshot,
    ...(omittedAssetIds.length ? { omittedAssetIds } : {}),
    rules,
    ontologyAssets,
    ontologyFacts: [
      ...(await loadOntologyFacts(userId, {
        projectId,
        workspaceId,
        taskText: context.taskText,
      })),
      ...ontologyAssets.map((asset) => ({
        id: asset.id,
        groupTitle: 'Durable personal context',
        field: 'memory',
        value: asset.statement,
        // onto-* 虚拟条目按文件来源标注；正式资产镜像（aa-*）的真身证据引用
        // 里没有 user_profile 键，不能落进 shared_memory 误标——画像是用户档案。
        source: asset.id.startsWith('onto-')
          ? (asset.evidenceRefs.some((ref) => ref.id === 'user_profile') ? 'user_profile' as const : 'shared_memory' as const)
          : 'user_profile' as const,
      })),
    ].slice(0, MAX_ONTOLOGY_FACTS),
    ontologyTaxonomy: await loadOntologyTaxonomy(userId),
    ontologyRules: (await loadOntologyRules(userId, {
      projectId,
      workspaceId,
    })).rules,
  };
}
