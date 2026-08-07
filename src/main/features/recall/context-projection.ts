import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { genId12 } from '../../storage';
import { listAbilityAssets, readAbilityAsset } from './asset-service';
import { recallJsonRecordPath } from './paths';
import { listWorkspaceAssetReferences } from './workspace-refs';
import { readRecallJsonRecord, updateRecallJsonRecord, writeRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';
import { normalizeCognitionSourceRefs, type CognitionSourceRef } from './source-service';

export type ProjectionAuthorization = 'user_confirmed' | 'workspace_policy' | 'not_required';
export type ContextProjectionStatus = 'preview' | 'confirmed' | 'expired' | 'revoked';

export interface OmittedAssetRef {
  assetId: string;
  reason: 'asset_paused' | 'asset_revoked' | 'workspace_not_referenced' | 'workspace_disabled' | 'scope_mismatch';
}

export interface ContextProjectionRecord extends RecallJsonRecord {
  taskRunId: string;
  workspaceId?: string;
  purpose: string;
  authorization: ProjectionAuthorization;
  assetIds: string[];
  sourceRefs: CognitionSourceRef[];
  omittedRefs: OmittedAssetRef[];
  expiresAt?: string;
  status: ContextProjectionStatus;
  createdAt: string;
  confirmedAt?: string;
}

export interface ProjectionInput {
  taskRunId: string;
  workspaceId?: string;
  purpose: string;
  authorization?: ProjectionAuthorization;
  expiresAt?: string;
}

export interface ListContextProjectionsQuery {
  workspaceId?: string;
  status?: ContextProjectionStatus;
  includeExpired?: boolean;
  limit?: number;
}

function projectionsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'projections', 'placeholder'));
}

function normalizeTerm(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string') throw new Error(`invalid projection ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) throw new Error(`invalid projection ${field}`);
  return text;
}

function scopeIncludes(scope: string, purpose: string): boolean {
  const terms = scope.split(',').map((term) => term.trim());
  return terms.includes(purpose) || terms.includes('*');
}

function asProjection(value: RecallJsonRecord): ContextProjectionRecord {
  if (!Array.isArray(value.assetIds) || !Array.isArray(value.sourceRefs) || !Array.isArray(value.omittedRefs) || typeof value.taskRunId !== 'string' || typeof value.purpose !== 'string' || typeof value.authorization !== 'string' || typeof value.status !== 'string' || typeof value.createdAt !== 'string') throw new Error('malformed context projection');
  return { ...value, sourceRefs: normalizeCognitionSourceRefs(value.sourceRefs) } as ContextProjectionRecord;
}

export async function buildRecallView(userId: string, input: ProjectionInput): Promise<{ assetIds: string[]; sourceRefs: CognitionSourceRef[]; omittedRefs: OmittedAssetRef[] }> {
  const purpose = normalizeTerm(input.purpose, 'purpose', 120);
  const assets = await listAbilityAssets(userId);
  const refs = input.workspaceId ? await listWorkspaceAssetReferences(userId) : [];
  const refsByAsset = new Map(refs.filter((ref) => !input.workspaceId || ref.workspaceId === input.workspaceId).map((ref) => [ref.assetId, ref]));
  const assetIds: string[] = [];
  const sourceRefs: CognitionSourceRef[] = [];
  const seen = new Set<string>();
  const omittedRefs: OmittedAssetRef[] = [];
  for (const asset of assets) {
    if (asset.status === 'paused') { omittedRefs.push({ assetId: asset.id, reason: 'asset_paused' }); continue; }
    if (asset.status === 'revoked') { omittedRefs.push({ assetId: asset.id, reason: 'asset_revoked' }); continue; }
    const ref = input.workspaceId ? refsByAsset.get(asset.id) : undefined;
    if (input.workspaceId && !ref) { omittedRefs.push({ assetId: asset.id, reason: 'workspace_not_referenced' }); continue; }
    if (ref && !ref.enabled) { omittedRefs.push({ assetId: asset.id, reason: 'workspace_disabled' }); continue; }
    if (ref && !scopeIncludes(ref.scope, purpose)) { omittedRefs.push({ assetId: asset.id, reason: 'scope_mismatch' }); continue; }
    if (!ref && !scopeIncludes(asset.scope, purpose)) { omittedRefs.push({ assetId: asset.id, reason: 'scope_mismatch' }); continue; }
    assetIds.push(asset.id);
    for (const source of asset.evidenceRefs) {
      const key = `${source.kind}:${source.id}`;
      if (!seen.has(key)) { seen.add(key); sourceRefs.push(source); }
    }
  }
  return { assetIds, sourceRefs, omittedRefs };
}

export async function previewContextProjection(userId: string, input: ProjectionInput): Promise<ContextProjectionRecord> {
  const taskRunId = normalizeTerm(input.taskRunId, 'task run id', 160);
  const purpose = normalizeTerm(input.purpose, 'purpose', 120);
  const workspaceId = input.workspaceId === undefined ? undefined : normalizeTerm(input.workspaceId, 'workspace id', 160);
  const authorization: ProjectionAuthorization = input.authorization || 'user_confirmed';
  if (authorization !== 'user_confirmed' && authorization !== 'workspace_policy' && authorization !== 'not_required') throw new Error('invalid projection authorization');
  if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) throw new Error('invalid projection expiry');
  const view = await buildRecallView(userId, { taskRunId, purpose, ...(workspaceId ? { workspaceId } : {}) });
  const now = new Date().toISOString();
  const record: ContextProjectionRecord = {
    schemaVersion: 1, ownerId: userId, id: `proj-${genId12()}`,
    taskRunId, ...(workspaceId ? { workspaceId } : {}), purpose, authorization,
    assetIds: view.assetIds, sourceRefs: view.sourceRefs, omittedRefs: view.omittedRefs,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), status: 'preview', createdAt: now,
  };
  await writeRecallJsonRecord(userId, 'projections', record.id, record);
  return record;
}

export async function readContextProjection(userId: string, projectionId: string): Promise<ContextProjectionRecord> {
  const raw = await readRecallJsonRecord(userId, 'projections', projectionId);
  if (!raw) throw new Error('context projection not found');
  return asProjection(raw);
}

export async function listContextProjections(
  userId: string,
  query: ListContextProjectionsQuery = {},
): Promise<ContextProjectionRecord[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 20)));
  let names: string[];
  try {
    names = await fs.readdir(projectionsDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readRecallJsonRecord(userId, 'projections', name.slice(0, -5))));
  const now = Date.now();
  return records
    .filter((record): record is RecallJsonRecord => Boolean(record))
    .map(asProjection)
    .map((projection) => (
      projection.status === 'preview' && projection.expiresAt && Date.parse(projection.expiresAt) <= now
        ? { ...projection, status: 'expired' as const }
        : projection
    ))
    .filter((projection) => query.workspaceId === undefined || projection.workspaceId === query.workspaceId)
    .filter((projection) => query.status === undefined || projection.status === query.status)
    .filter((projection) => query.includeExpired === true || projection.status !== 'expired')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

export async function confirmContextProjection(userId: string, projectionId: string): Promise<ContextProjectionRecord> {
  const updated = await updateRecallJsonRecord(userId, 'projections', projectionId, async (raw) => {
    if (!raw) throw new Error('context projection not found');
    const current = asProjection(raw);
    if (current.status === 'confirmed') throw new Error('context projection is already confirmed');
    if (current.status !== 'preview') throw new Error('context projection is not confirmable');
    if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) return { ...current, status: 'expired' };
    for (const assetId of current.assetIds) {
      const asset = await readAbilityAsset(userId, assetId);
      if (asset.status !== 'active') throw new Error('context projection asset is no longer active');
    }
    return { ...current, status: 'confirmed', confirmedAt: new Date().toISOString() };
  });
  const projection = asProjection(updated);
  if (projection.status === 'expired') throw new Error('context projection is expired');
  return projection;
}
