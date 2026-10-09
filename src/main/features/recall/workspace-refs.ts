import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import { appendRecallJsonlRecord, listRecallJsonlRecords, readRecallJsonRecord, updateRecallJsonRecord, writeRecallJsonRecord } from './store';
import { readAbilityAsset } from './asset-service';
import type { RecallJsonRecord } from './types';

export interface WorkspaceAssetReference extends RecallJsonRecord {
  assetId: string;
  workspaceId: string;
  scope: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAssetReferenceHistory extends RecallJsonRecord {
  referenceId: string;
  action: 'added' | 'scope_updated' | 'enabled_updated' | 'removed';
  at: string;
  scope?: string;
}

function referencesDirectory(userId: string): string { return path.dirname(recallJsonRecordPath(userId, 'workspace-refs', 'placeholder')); }
function referenceId(assetId: string, workspaceId: string): string { return `war-${assetId}-${workspaceId}`; }
function normalizeScope(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid workspace reference scope');
  const terms = [...new Set(value.split(',').map((term) => term.trim()).filter(Boolean))].sort();
  if (!terms.length || terms.some((term) => term.length > 120)) throw new Error('invalid workspace reference scope');
  return terms.join(',');
}
function isNarrowerOrSame(before: string, after: string): boolean {
  const available = new Set(before.split(','));
  return after.split(',').every((term) => available.has(term));
}
function asReference(value: RecallJsonRecord): WorkspaceAssetReference {
  if (typeof value.assetId !== 'string' || typeof value.workspaceId !== 'string' || typeof value.scope !== 'string' || typeof value.enabled !== 'boolean' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') throw new Error('malformed workspace asset reference');
  return value as WorkspaceAssetReference;
}
async function appendHistory(userId: string, reference: WorkspaceAssetReference, action: WorkspaceAssetReferenceHistory['action']): Promise<void> {
  const at = new Date().toISOString();
  await appendRecallJsonlRecord(userId, 'workspace-ref-history', reference.id, {
    schemaVersion: 1, ownerId: userId, id: `${reference.id}-${action}-${at.replace(/[^A-Za-z0-9]/g, '')}`,
    referenceId: reference.id, action, at, scope: reference.scope,
  } satisfies WorkspaceAssetReferenceHistory);
}

export async function addWorkspaceAssetReference(userId: string, input: { assetId: string; workspaceId: string; scope: string; enabled?: boolean }): Promise<WorkspaceAssetReference> {
  if (!safeId(input.assetId) || !safeId(input.workspaceId)) throw new Error('invalid workspace reference identity');
  const asset = await readAbilityAsset(userId, input.assetId);
  if (asset.status !== 'active') throw new Error('ability asset is not active');
  const id = referenceId(input.assetId, input.workspaceId);
  const existing = await readRecallJsonRecord(userId, 'workspace-refs', id);
  if (existing) return asReference(existing);
  const now = new Date().toISOString();
  const reference: WorkspaceAssetReference = { schemaVersion: 1, ownerId: userId, id, assetId: input.assetId, workspaceId: input.workspaceId, scope: normalizeScope(input.scope), enabled: input.enabled !== false, createdAt: now, updatedAt: now };
  await writeRecallJsonRecord(userId, 'workspace-refs', id, reference);
  await appendHistory(userId, reference, 'added');
  return reference;
}

export async function listWorkspaceAssetReferences(userId: string, assetId?: string): Promise<WorkspaceAssetReference[]> {
  let names: string[];
  try { names = await fs.readdir(referencesDirectory(userId)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const refs = await Promise.all(names.filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5))).map((name) => readRecallJsonRecord(userId, 'workspace-refs', name.slice(0, -5))));
  return refs.filter((ref): ref is RecallJsonRecord => Boolean(ref)).map(asReference).filter((ref) => !assetId || ref.assetId === assetId).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
}

export async function updateWorkspaceAssetReference(userId: string, id: string, input: { scope?: string; enabled?: boolean }): Promise<WorkspaceAssetReference> {
  if (!safeId(id)) throw new Error('invalid workspace reference id');
  let action: WorkspaceAssetReferenceHistory['action'] | undefined;
  const updated = await updateRecallJsonRecord(userId, 'workspace-refs', id, (raw) => {
    if (!raw) throw new Error('workspace asset reference not found');
    const current = asReference(raw);
    const scope = input.scope === undefined ? current.scope : normalizeScope(input.scope);
    if (!isNarrowerOrSame(current.scope, scope)) throw new Error('workspace reference scope cannot expand');
    const enabled = input.enabled === undefined ? current.enabled : input.enabled;
    action = scope !== current.scope ? 'scope_updated' : enabled !== current.enabled ? 'enabled_updated' : undefined;
    return { ...current, scope, enabled, updatedAt: new Date().toISOString() };
  });
  const reference = asReference(updated);
  if (action) await appendHistory(userId, reference, action);
  return reference;
}

export async function removeWorkspaceAssetReference(userId: string, id: string): Promise<void> {
  const raw = await readRecallJsonRecord(userId, 'workspace-refs', id);
  if (!raw) throw new Error('workspace asset reference not found');
  const reference = asReference(raw);
  const file = recallJsonRecordPath(userId, 'workspace-refs', id);
  await fs.unlink(file);
  await appendHistory(userId, reference, 'removed');
}

export async function listWorkspaceAssetReferenceHistory(userId: string, id: string): Promise<WorkspaceAssetReferenceHistory[]> {
  return (await listRecallJsonlRecords(userId, 'workspace-ref-history', id, 0)) as WorkspaceAssetReferenceHistory[];
}
