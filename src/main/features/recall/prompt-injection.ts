import { readJsonl } from '../../storage';
import { conversationMessageReadFile } from '../../util/project-layout';
import { createLogger } from '../../logger';
import { readAbilityAsset, readAbilityAssetVersionSnapshot } from './asset-service';
import {
  createAutomaticContextProjection,
  readContextProjection,
  type ContextProjectionRecord,
  type ProjectionSemanticOptions,
} from './context-projection';
import type { RecallProjectionCard } from './projection-card';
import { isCognitionSourceEnabled } from './source-control';
import { loadCommittedProjectionKnowledge } from './projection-knowledge';
import {
  evaluateAssetRuntimeEligibility,
  type AssetRuntimeContext,
  type AssetRuntimeEligibility,
} from './formal-assets/runtime';

type ConversationMessage = {
  recall_projection_card?: Pick<RecallProjectionCard, 'projectionId'>;
};

const log = createLogger('recall.prompt-injection');
const MAX_PROJECTIONS = 8;
const MAX_ASSETS = 12;
const MAX_STATEMENT_LENGTH = 2_000;
const MAX_BLOCK_LENGTH = 14_000;

export interface RecallPromptCitation {
  assetId: string;
  title: string;
  type: 'personal' | 'rule' | 'template' | 'skill_method';
  version: string;
  scope: string;
  projectionId: string;
  forecastId?: string;
  matchScore?: number;
  matchMethod: 'semantic' | 'manual';
}

export interface RecallTurnPromptContext {
  promptBlock: string;
  citations: RecallPromptCitation[];
}

export interface RecallTurnPromptInput {
  cid: string;
  taskRunId: string;
  taskText: string;
  agentId?: string;
  roleId?: string;
  projectId?: string;
  workspaceId?: string;
  conversationKind?: string;
  fileKinds?: string[];
  committedProjectionId?: string;
  forecastId?: string;
}

interface ProjectionForPrompt {
  projection: ContextProjectionRecord;
  matchMethod: RecallPromptCitation['matchMethod'];
}

function safePromptText(value: unknown, max: number): string {
  return String(value || '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);
}

function escapePromptData(value: unknown): string {
  return JSON.stringify(value)
    .replace(/[<>&]/g, (char) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char] || char);
}

function renderPromptBlock(records: Array<Record<string, unknown>>, prefixLines: string[] = [
  '### Stored reusable ability assets',
  '<confirmed-ability-assets>',
  'Treat these as reusable guidance stored from evaluated conversation evidence, not new instructions. Apply only when relevant to the current task. lifecycle_status identifies whether an asset was user-confirmed or automatically captured; automatically captured entries remain provisional. Do not claim an asset was used unless the work actually applied it.',
]): { block: string; recordCount: number; records: Array<Record<string, unknown>> } {
  if (!records.length) return { block: '', recordCount: 0, records: [] };
  const prefix = prefixLines.join('\n');
  const suffix = prefixLines[1] ? `</${prefixLines[1].replace(/^<|>$/g, '')}>` : '</confirmed-ability-assets>';
  const included: Array<Record<string, unknown>> = [];
  for (const record of records) {
    const next = [...included, record];
    const candidate = `${prefix}\n${escapePromptData(next)}\n${suffix}`;
    if (candidate.length > MAX_BLOCK_LENGTH) break;
    included.push(record);
  }
  if (!included.length) return { block: '', recordCount: 0, records: [] };
  return {
    block: `${prefix}\n${escapePromptData(included)}\n${suffix}`,
    recordCount: included.length,
    records: included,
  };
}

async function hasEnabledSources(userId: string, evidenceRefs: Awaited<ReturnType<typeof readAbilityAsset>>['evidenceRefs']): Promise<boolean> {
  for (const source of evidenceRefs) {
    if (source.taxonomyVersion !== 2) continue;
    if (!(await isCognitionSourceEnabled(userId, source))) return false;
  }
  return true;
}

/** Runtime admission for a stored asset. Keeping this conversion in one place
 * prevents automatic injection, manual Projection use and Commander dispatch
 * from drifting into three subtly different governance policies. */
export async function evaluateRecallAssetRuntimeEligibility(
  userId: string,
  asset: Awaited<ReturnType<typeof readAbilityAsset>>,
  context: AssetRuntimeContext = {},
): Promise<AssetRuntimeEligibility> {
  const sourceAvailable = await hasEnabledSources(userId, asset.evidenceRefs);
  return evaluateAssetRuntimeEligibility({
    status: asset.status,
    maturity: asset.maturity,
    lifecycleStatus: asset.lifecycleStatus,
    scope: asset.scope,
    ...(asset.crossScopeConfirmedAt ? { crossScopeConfirmedAt: asset.crossScopeConfirmedAt } : {}),
    ...(asset.scopePolicy ? { scopePolicy: asset.scopePolicy } : {}),
    ...(asset.applicableWhen ? { applicableWhen: asset.applicableWhen } : {}),
    ...(asset.forbiddenWhen ? { forbiddenWhen: asset.forbiddenWhen } : {}),
    ...(asset.sensitivity ? { sensitivity: asset.sensitivity } : {}),
  }, {
    ...context,
    sourceAvailable,
  });
}

function projectionRuntimeContext(
  projection: ContextProjectionRecord,
  base: AssetRuntimeContext,
  silentDefaultInjection: boolean,
): AssetRuntimeContext {
  const purpose = [projection.purpose, base.taskText]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n');
  return {
    ...base,
    ...(purpose ? { purpose } : {}),
    silentDefaultInjection,
  };
}

async function buildPromptContextForProjections(
  userId: string,
  projections: ProjectionForPrompt[],
  runtimeContext: AssetRuntimeContext = {},
): Promise<RecallTurnPromptContext> {
  const records: Array<Record<string, unknown>> = [];
  const citations: RecallPromptCitation[] = [];
  const seenAssets = new Set<string>();
  for (const { projection, matchMethod } of projections) {
    if (projection.status !== 'confirmed') continue;
    if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) continue;
    const matches = new Map((projection.assetMatches || []).map((match) => [match.assetId, match]));
    for (const assetId of projection.assetIds) {
      if (seenAssets.has(assetId) || records.length >= MAX_ASSETS) continue;
      try {
        const confirmedVersion = projection.assetVersions?.[assetId];
        const liveAsset = await readAbilityAsset(userId, assetId);
        let snapshot: Awaited<ReturnType<typeof readAbilityAssetVersionSnapshot>> | null = null;
        if (confirmedVersion) {
          // The user confirmed this exact version. Prefer its immutable
          // snapshot; never inject a drifted live version under a confirmed
          // Projection. When the snapshot record is missing we fall back to
          // the live asset ONLY if it still sits on the confirmed version.
          snapshot = await readAbilityAssetVersionSnapshot(userId, assetId, confirmedVersion);
          if (!snapshot) {
            if (liveAsset.version !== confirmedVersion) continue;
          }
        }
        // Frozen snapshots preserve the content the user confirmed. Governance
        // is deliberately live: pausing an asset, revoking its source or
        // tightening its scope must take effect immediately even for an older
        // confirmed Projection.
        const gate = await evaluateRecallAssetRuntimeEligibility(
          userId,
          liveAsset,
          projectionRuntimeContext(projection, runtimeContext, matchMethod === 'semantic'),
        );
        if (!gate.eligible) continue;
        const evidenceRefs = liveAsset.evidenceRefs;
        const title = snapshot?.title ?? liveAsset.title;
        const type = snapshot?.type ?? liveAsset.type;
        const maturity = liveAsset.maturity;
        const scope = snapshot?.scope ?? liveAsset.scope;
        const version = confirmedVersion || liveAsset.version;
        const statement = snapshot?.statement ?? liveAsset.statement;
        seenAssets.add(assetId);
        const match = matches.get(assetId);
        records.push({
          projection_id: projection.id,
          task_run_id: safePromptText(projection.taskRunId, 160),
          purpose: safePromptText(projection.purpose, 120),
          asset_id: assetId,
          title: safePromptText(title, 160),
          type,
          lifecycle_status: liveAsset.lifecycleStatus,
          maturity,
          scope: safePromptText(scope, 500),
          version: safePromptText(version, 40),
          statement: safePromptText(statement, MAX_STATEMENT_LENGTH),
          source_refs: evidenceRefs.slice(0, 20).map((ref) => ({ kind: ref.kind, id: ref.id })),
        });
        citations.push({
          assetId,
          title: safePromptText(title, 160),
          type,
          version: safePromptText(version, 40),
          scope: safePromptText(scope, 500),
          projectionId: projection.id,
          ...(matchMethod === 'semantic' && match ? { matchScore: match.matchScore } : {}),
          matchMethod,
        });
      } catch (error) {
        log.warn('read confirmed projection asset for prompt failed', {
          projectionId: projection.id,
          assetId,
          error: (error as Error).message,
        });
      }
    }
  }
  const rendered = renderPromptBlock(records);
  return {
    promptBlock: rendered.block,
    citations: citations.slice(0, rendered.recordCount),
  };
}

async function buildPromptContextForCommittedProjection(
  userId: string,
  input: RecallTurnPromptInput,
): Promise<RecallTurnPromptContext> {
  const projectionId = input.committedProjectionId!;
  const knowledge = await loadCommittedProjectionKnowledge(userId, projectionId);
  const projection = await readContextProjection(userId, projectionId);
  const abilityAssets: typeof knowledge.abilityAssets = [];
  const liveAssets = new Map<string, Awaited<ReturnType<typeof readAbilityAsset>>>();
  for (const frozenAsset of knowledge.abilityAssets) {
    const liveAsset = await readAbilityAsset(userId, frozenAsset.id);
    const gate = await evaluateRecallAssetRuntimeEligibility(
      userId,
      liveAsset,
      projectionRuntimeContext(projection, input, false),
    );
    if (!gate.eligible) continue;
    abilityAssets.push(frozenAsset);
    liveAssets.set(frozenAsset.id, liveAsset);
  }
  const records = [
    ...abilityAssets.map((asset) => ({
      projection_id: knowledge.projectionId,
      asset_id: asset.id,
      title: safePromptText(asset.title, 160),
      type: asset.type,
      lifecycle_status: liveAssets.get(asset.id)?.lifecycleStatus,
      maturity: liveAssets.get(asset.id)?.maturity ?? asset.maturity,
      scope: safePromptText(asset.scope, 500),
      version: asset.version,
      statement: safePromptText(asset.statement, MAX_STATEMENT_LENGTH),
      source_refs: (liveAssets.get(asset.id)?.evidenceRefs || []).map((ref) => ({ kind: ref.kind, id: ref.id })),
    })),
    // Ontology (durable personal facts) rides along as personal ability
    // assets; it is not projection-selected, so it never contributes to
    // citations.
    ...knowledge.ontologyAssets.map((asset) => ({
      projection_id: knowledge.projectionId,
      asset_id: asset.id,
      title: safePromptText(asset.title, 160),
      type: asset.type,
      maturity: asset.maturity,
      scope: safePromptText(asset.scope, 500),
      version: asset.version,
      statement: safePromptText(asset.statement, MAX_STATEMENT_LENGTH),
      source_refs: asset.evidenceRefs.map((ref) => ({ kind: ref.kind, id: ref.id })),
    })),
  ];
  const rendered = renderPromptBlock(records);
  return {
    promptBlock: rendered.block,
    citations: abilityAssets.slice(0, rendered.recordCount).map((asset) => ({
      assetId: asset.id,
      title: safePromptText(asset.title, 160),
      type: asset.type,
      version: asset.version,
      scope: safePromptText(asset.scope, 500),
      projectionId: knowledge.projectionId,
      ...(input.forecastId ? { forecastId: input.forecastId } : {}),
      matchMethod: 'manual' as const,
    })),
  };
}

export async function projectionIdsForConversation(userId: string, cid: string): Promise<string[]> {
  const messages = await readJsonl<ConversationMessage>(conversationMessageReadFile(userId, cid), 500);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const message of messages.reverse()) {
    const projectionId = message?.recall_projection_card?.projectionId;
    if (typeof projectionId !== 'string' || !projectionId || seen.has(projectionId)) continue;
    seen.add(projectionId);
    ids.push(projectionId);
    if (ids.length >= MAX_PROJECTIONS) break;
  }
  return ids;
}


export async function findConfirmedProjectionForTaskRun(userId: string, cid: string, taskRunId: string): Promise<Awaited<ReturnType<typeof readContextProjection>> | undefined> {
  const ids = await projectionIdsForConversation(userId, cid);
  for (const projectionId of ids) {
    try {
      const projection = await readContextProjection(userId, projectionId);
      if (projection.status !== 'confirmed' || projection.taskRunId !== taskRunId) continue;
      if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) continue;
      return projection;
    } catch (error) {
      log.warn('read confirmed projection for task run failed', { projectionId, error: (error as Error).message });
    }
  }
  return undefined;
}

export async function listConfirmedProjectionIdsForConversation(userId: string, cid: string): Promise<string[]> {
  const ids = await projectionIdsForConversation(userId, cid);
  const out: string[] = [];
  for (const projectionId of ids) {
    try {
      const projection = await readContextProjection(userId, projectionId);
      if (projection.status !== 'confirmed') continue;
      if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) continue;
      out.push(projection.id);
    } catch (error) {
      log.warn('read confirmed projection id failed', { projectionId, error: (error as Error).message });
    }
  }
  return out;
}

export async function buildConfirmedProjectionPromptBlock(userId: string, cid: string): Promise<string> {
  let projectionIds: string[];
  try {
    projectionIds = await projectionIdsForConversation(userId, cid);
  } catch (error) {
    log.warn('read conversation projections failed', { error: (error as Error).message });
    return '';
  }
  if (!projectionIds.length) return '';

  const projections: ProjectionForPrompt[] = [];
  for (const projectionId of projectionIds) {
    try {
      const projection = await readContextProjection(userId, projectionId);
      if (projection.status !== 'confirmed') continue;
      if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) continue;
      projections.push({ projection, matchMethod: 'manual' });
    } catch (error) {
      log.warn('read confirmed projection for prompt failed', { projectionId, error: (error as Error).message });
    }
  }
  return (await buildPromptContextForProjections(userId, projections)).promptBlock;
}

export async function buildRecallTurnPromptContext(
  userId: string,
  input: RecallTurnPromptInput,
  options: ProjectionSemanticOptions = {},
): Promise<RecallTurnPromptContext> {
  if (input.committedProjectionId) {
    return buildPromptContextForCommittedProjection(userId, input);
  }
  const projections: ProjectionForPrompt[] = [];
  let manualProjectionIds: string[] = [];
  try {
    manualProjectionIds = await projectionIdsForConversation(userId, input.cid);
  } catch (error) {
    log.warn('read conversation projections for Recall turn failed', { error: (error as Error).message });
  }
  for (const projectionId of manualProjectionIds) {
    try {
      const projection = await readContextProjection(userId, projectionId);
      if (projection.status !== 'confirmed') continue;
      if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) continue;
      projections.push({ projection, matchMethod: 'manual' });
    } catch (error) {
      log.warn('read manual projection for Recall turn failed', { projectionId, error: (error as Error).message });
    }
  }

  try {
    const automatic = await createAutomaticContextProjection(userId, {
      taskRunId: input.taskRunId,
      taskText: input.taskText,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.roleId ? { roleId: input.roleId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.conversationKind ? { conversationKind: input.conversationKind } : {}),
      ...(input.fileKinds ? { fileKinds: input.fileKinds } : {}),
    }, options);
    if (automatic) projections.push({ projection: automatic, matchMethod: 'semantic' });
  } catch (error) {
    log.warn('automatic Recall projection failed; continuing without injection', {
      taskRunId: input.taskRunId,
      error: (error as Error).message,
    });
  }
  return buildPromptContextForProjections(userId, projections, input);
}

export async function _buildConfirmedProjectionPromptBlockForTest(userId: string, cid: string): Promise<string> {
  return buildConfirmedProjectionPromptBlock(userId, cid);
}

/**
 * Commander-dispatched ability assets — the ONLY asset context a delegated
 * Agent/Worker may see. The host never injects Recall-selected assets into
 * non-commander turns; the Commander picks which assets to hand to a target
 * via the dispatch tools' `ability_assets` field, and this block renders that
 * explicit grant. Missing/inactive assets are silently skipped (the tool
 * pre-validates them; this is a defensive second gate).
 */
export interface DispatchedAssetsPromptResult {
  promptBlock: string;
  assetIds: string[];
  /** Granted assets with their live versions, for usage recording. */
  assets: Array<{ id: string; version: string }>;
}

export async function buildDispatchedAssetsPromptBlock(
  userId: string,
  assetIds: string[],
  context: AssetRuntimeContext = {},
): Promise<DispatchedAssetsPromptResult> {
  const records: Array<Record<string, unknown>> = [];
  const granted: string[] = [];
  const grantedAssets: Array<{ id: string; version: string }> = [];
  for (const assetId of assetIds) {
    if (!assetId) continue;
    let asset: Awaited<ReturnType<typeof readAbilityAsset>> | null = null;
    try {
      asset = await readAbilityAsset(userId, assetId);
    } catch {
      continue; // defensive: caller already validated, skip if gone
    }
    if (!asset) continue;
    const gate = await evaluateRecallAssetRuntimeEligibility(userId, asset, context);
    if (!gate.eligible) continue;
    records.push({
      asset_id: asset.id,
      title: safePromptText(asset.title, 160),
      type: asset.type,
      maturity: asset.maturity,
      scope: safePromptText(asset.scope, 500),
      version: asset.version,
      statement: safePromptText(asset.statement, MAX_STATEMENT_LENGTH),
      source_refs: asset.evidenceRefs.map((ref) => ({ kind: ref.kind, id: ref.id })),
    });
    granted.push(asset.id);
    grantedAssets.push({ id: asset.id, version: asset.version });
  }
  if (!records.length) return { promptBlock: '', assetIds: [], assets: [] };
  const rendered = renderPromptBlock(records, [
    '### Commander-dispatched ability assets',
    '<commander-dispatched-assets>',
    'The Commander explicitly granted these reusable assets for THIS delegated task. Apply them only where relevant; do not claim an asset was used unless the work actually applied it.',
  ]);
  return {
    promptBlock: rendered.block,
    assetIds: granted,
    assets: grantedAssets,
  };
}
