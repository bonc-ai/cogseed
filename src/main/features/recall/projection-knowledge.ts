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
const MAX_STATEMENT = 2_000;
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
  rules: WorldModelCausalRuleRef[];
  /** Runtime-eligible personal assets as background profile context. */
  ontologyAssets: WorldModelAbilityAsset[];
  ontologyFacts: import('./world-model-types').WorldModelOntologyFact[];
  /** T-Box concept definitions (ontology group ledger + field vocabulary). */
  ontologyTaxonomy: Awaited<ReturnType<typeof loadOntologyTaxonomy>>;
  /** R-Box (ontology): durable business rules from relation fields. */
  ontologyRules: Awaited<ReturnType<typeof loadOntologyRules>>['rules'];
}

/** 导出作测试缝（specs/014 T019）：世界模型侧矛盾标记的直接用例入口；
 *  生产调用方仍是 loadCommittedProjectionKnowledge 一处。 */
export async function loadOntologyFacts(
  userId: string,
  context: { projectId?: string; workspaceId?: string; taskText?: string } = {},
): Promise<import('./world-model-types').WorldModelOntologyFact[]> {
  const facts: import('./world-model-types').WorldModelOntologyFact[] = [];
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
        // 敏感性（spec 007 T302）：restricted 值不进任务自动上下文与世界模型
        // （用户在对话里显式 @ 该组仍会带全文——显式选择即授权）。
        if (entry.sensitivity === 'restricted') continue;
        const value = String(entry.value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ONTOLOGY_FACT_VALUE);
        if (!value) continue;
        const factKey = createHash('sha256')
          .update(`${group.group_id}\0${field.name}\0${value}`)
          .digest('hex');
        facts.push({
          id: `po-fact-${factKey.slice(0, 24)}`,
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
  // 矛盾标记（specs/014 US-903 / T018）：一次读只读索引（readLiveConflicts
  // 不写盘、不触发自愈），命中 (组标题, 字段) 的事实挂 disputed + 非受限对端
  // （≤2 条、每条截 MAX_ONTOLOGY_FACT_VALUE）；对端受限只置位不带文本。
  // 无矛盾时不挂任何键（下游产物深度相等，零差异承诺 I-9）。
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

/** 画像条目标题：≤80 字原样；超长在句读边界截断加省略号，不再半句断头
 *  （T1.4：原 slice(0,80) 会把标题切成"……技术口径处理，而不是按终端用户提"
 *  这种断头话，注入块/检索结果里的人读体验都受影响）。 */
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

/** Personal formal assets → profile entries carrying the asset's real
 *  governance fields (id/version/maturity/title/scope/evidenceRefs). Callers
 *  must pass the IDs admitted for the current task; this is a profile
 *  presentation channel and does not create projection citations. Legacy
 *  USER/MEMORY files remain a migration fallback only after a successful store
 *  read confirms that no personal asset records exist.
 *
 *  2026-09-30 修1：此前镜像把 id 换成 onto-<sha> 并硬编码 bud/v1——同一条
 *  记录两种投影互相矛盾（真身 v10 已实证 vs 镜像 v1 bud），注入块按伪造值
 *  展示治理（自检曾据此误判「画像通道绕过闸门」），回执按 onto-id 记账也
 *  永远连不回资产本体。镜像只保留展示职责，治理与审计回真身。 */
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
        statement: String(record.statement || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ONTOLOGY_STATEMENT),
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
  const assetVersions = await validateCommittedProjectionAssetVersions(userId, projection, runtimeScope);
  const assets = [];
  for (const assetId of projection.assetIds.slice(0, MAX_ASSETS)) {
    // validateCommittedProjectionAssetVersions 会省略当前已停用的资产；只读
    // 仍有效且版本一致的子集，避免同一投影中的单条暂停使其他资产也不可用。
    if (!Object.prototype.hasOwnProperty.call(assetVersions, assetId)) continue;
    const asset = await readAbilityAsset(userId, assetId);
    assets.push(asset);
  }
  const abilityAssets: WorldModelAbilityAsset[] = assets.map((asset) => ({
    id: asset.id,
    version: asset.version,
    title: asset.title,
    type: asset.type,
    statement: asset.statement.slice(0, MAX_STATEMENT),
    scope: asset.scope,
    maturity: asset.maturity,
    ...(asset.learningSignal ? { learningSignal: asset.learningSignal } : {}),
    ...(asset.causalRule ? { causalRule: asset.causalRule } : {}),
    ontologyRefs: (asset.ontologyRefs || []).map((ref) => ({ ...ref })),
    evidenceRefs: asset.evidenceRefs.slice(0, MAX_EVIDENCE_REFS).map((ref) => ({ ...ref })),
  }));
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
