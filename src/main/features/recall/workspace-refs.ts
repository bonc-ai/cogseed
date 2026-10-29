import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import { appendRecallJsonlRecord, listRecallJsonlRecords, readRecallJsonRecord, updateRecallJsonRecord, writeRecallJsonRecord } from './store';
import { readAbilityAsset } from './asset-service';
import type { RecallJsonRecord } from './types';

const log = createLogger('workspace-refs');

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
  const ids = names.filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5))).map((name) => name.slice(0, -5));
  // 逐条降级，而不是让一条坏引用把整份引用列表读失败（照抄同目录
  // listExperiences / listAbilityAssets / listRecallCandidates 的既有口径）：
  // 记录形状的不变量分布在两层——store 的 validateRecallRecord 和这里的
  // asReference——任一层一抛，`workspaceRefs.list` IPC 与 context-projection
  // 的投影/注入装配就整体失败，好引用也列不出、一并不可见。
  //
  // 只降级**记录形状**的错。真正的 IO 故障（EACCES / EISDIR……）带 errno code，
  // 照旧上抛：那种情况下静默少几条，等于把磁盘问题伪装成「引用变少了」。
  const reads = await Promise.all(ids.map(async (id) => {
    try {
      return { id, record: await readRecallJsonRecord(userId, 'workspace-refs', id) };
    } catch (error) {
      if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
      return { id, error: error as Error };
    }
  }));
  const references: WorkspaceAssetReference[] = [];
  for (const read of reads) {
    if (read.error) {
      log.warn('skipped an unreadable workspace asset reference', { referenceId: read.id, error: read.error.message });
      continue;
    }
    if (!read.record) continue;
    try {
      references.push(asReference(read.record));
    } catch (error) {
      log.warn('skipped a malformed workspace asset reference', { referenceId: read.id, error: (error as Error).message });
    }
  }
  return references.filter((ref) => !assetId || ref.assetId === assetId).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
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
