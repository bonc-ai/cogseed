import { createHash } from 'node:crypto';

import { loadEntries } from '../memory';
import { userMemoryFile, userProfileFile } from '../../paths';
import { loadOntologyRules } from './ontology-rules';
import { loadOntologyTaxonomy } from './ontology-taxonomy';
import { normalizeCognitionSourceRefs } from './source-service';
import { readAbilityAsset } from './asset-service';
import { readGroups, listGroupFields, isStaleAsOf } from '../personal_ontology_groups';
import { splitScopeTerms } from './scope-policy';
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
  projectionConfirmedAt: string;
  workspaceId?: string;
  abilityAssetRefs: string[];
  abilityAssets: WorldModelAbilityAsset[];
  assetVersions: Record<string, string>;
  rules: WorldModelCausalRuleRef[];
  /** Durable personal ontology (USER.md + MEMORY.md) as `personal` ability assets. */
  ontologyAssets: WorldModelAbilityAsset[];
  ontologyFacts: import('./world-model-types').WorldModelOntologyFact[];
  /** T-Box concept definitions (ontology group ledger + field vocabulary). */
  ontologyTaxonomy: Awaited<ReturnType<typeof loadOntologyTaxonomy>>;
  /** R-Box (ontology): durable business rules from relation fields. */
  ontologyRules: Awaited<ReturnType<typeof loadOntologyRules>>['rules'];
}

async function loadOntologyFacts(
  userId: string,
  context: { workspaceId?: string; taskText?: string } = {},
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
        if (entry.project && entry.project !== context.workspaceId) continue;
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
        });
        if (facts.length >= MAX_ONTOLOGY_FACT_CANDIDATES) break;
      }
      if (facts.length >= MAX_ONTOLOGY_FACT_CANDIDATES) break;
    }
    if (facts.length >= MAX_ONTOLOGY_FACT_CANDIDATES) break;
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

/** USER.md / MEMORY.md → 虚拟画像资产（onto-<sha256 前 24 位>）。
 *  导出供检索侧复用（search_ability_assets 把画像纳入检索池并标来源）；
 *  条目不落盘、不进投影授权链——只作为背景通道存在（见 prompt-injection
 *  的 <durable-profile-memory> 独立块）。 */
/** 画像资产来源（2026-09-22 记忆退役）：personal 类正式资产取代 USER/MEMORY
 *  文件条目——onto-* 虚拟资产形态保留（committed 画像通道不进授权链的契约
 *  不变），条目文本换为资产正文。读不到资产库时回退文件（迁移前过渡）。 */
export async function loadOntologyAssets(userId: string): Promise<WorldModelAbilityAsset[]> {
  const assets: WorldModelAbilityAsset[] = [];
  let statements: Array<{ text: string; name: 'user_profile' | 'shared_memory' }> = [];
  try {
    const { listAbilityAssets } = await import('./asset-service');
    const personal = (await listAbilityAssets(userId))
      .filter((asset) => asset.type === 'personal' && asset.status === 'active');
    statements = personal.map((asset) => ({ text: String(asset.statement || ''), name: 'user_profile' as const }));
  } catch {
    statements = [];
  }
  if (!statements.length) {
    // 过渡回退：资产库还没有画像（迁移未跑）时读文件。
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
  context: { taskText?: string } = {},
): Promise<CommittedProjectionKnowledge> {
  const projection = await readContextProjection(userId, projectionId);
  const assetVersions = await validateCommittedProjectionAssetVersions(userId, projection);
  const assets = [];
  for (const assetId of projection.assetIds.slice(0, MAX_ASSETS)) {
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
  const ontologyAssets = await loadOntologyAssets(userId);
  return {
    projectionId: projection.id,
    projectionConfirmedAt: projection.confirmedAt || projection.decidedAt || projection.createdAt,
    ...(projection.workspaceId ? { workspaceId: projection.workspaceId } : {}),
    abilityAssetRefs: abilityAssets.map((asset) => asset.id),
    abilityAssets,
    assetVersions: Object.fromEntries(abilityAssets.map((asset) => [asset.id, assetVersions[asset.id]])),
    rules,
    ontologyAssets,
    ontologyFacts: [
      ...(await loadOntologyFacts(userId, {
        workspaceId: projection.workspaceId,
        taskText: context.taskText,
      })),
      ...ontologyAssets.map((asset) => ({
        id: asset.id,
        groupTitle: 'Durable personal context',
        field: 'memory',
        value: asset.statement,
        source: asset.evidenceRefs.some((ref) => ref.id === 'user_profile')
          ? 'user_profile' as const
          : 'shared_memory' as const,
      })),
    ].slice(0, MAX_ONTOLOGY_FACTS),
    ontologyTaxonomy: await loadOntologyTaxonomy(userId),
    ontologyRules: (await loadOntologyRules(userId, { workspaceId: projection.workspaceId })).rules,
  };
}
