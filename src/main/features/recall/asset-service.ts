import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import { appendRecallJsonlRecord, listRecallJsonlRecords, readRecallJsonRecord, updateRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';
import type { RecallAbilityAssetRecord } from './candidate-service';

export interface AbilityAssetVersionRecord extends RecallJsonRecord {
  assetId: string;
  version: string;
  at: string;
  snapshot: Pick<RecallAbilityAssetRecord, 'title' | 'statement' | 'type' | 'scope' | 'evidenceRefs' | 'status' | 'maturity' | 'version'>;
}

export interface AbilityAssetAuditRecord extends RecallJsonRecord {
  assetId: string;
  action: 'created' | 'updated' | 'paused' | 'revoked';
  at: string;
  note?: string;
}

export interface UpdateAbilityAssetInput {
  title?: string;
  statement?: string;
  scope?: string;
  type?: RecallAbilityAssetRecord['type'];
  evidenceRefs?: RecallAbilityAssetRecord['evidenceRefs'];
  id?: never;
  ownerId?: never;
}

function assetsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'ability-assets', 'placeholder'));
}

function asAsset(value: RecallJsonRecord): RecallAbilityAssetRecord {
  if (
    typeof value.candidateId !== 'string' || typeof value.title !== 'string' ||
    typeof value.statement !== 'string' || !Array.isArray(value.evidenceRefs) ||
    typeof value.scope !== 'string' || typeof value.version !== 'string' ||
    (value.status !== 'active' && value.status !== 'paused' && value.status !== 'revoked')
  ) throw new Error('malformed recall ability asset');
  return value as RecallAbilityAssetRecord;
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`invalid ability asset ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) throw new Error(`invalid ability asset ${field}`);
  return text;
}

function nextVersion(version: string): string {
  const current = Number(version);
  if (!Number.isSafeInteger(current) || current < 1) throw new Error('invalid ability asset version');
  return String(current + 1);
}

function snapshot(asset: RecallAbilityAssetRecord): AbilityAssetVersionRecord['snapshot'] {
  return {
    title: asset.title,
    statement: asset.statement,
    type: asset.type,
    scope: asset.scope,
    evidenceRefs: asset.evidenceRefs,
    status: asset.status,
    maturity: asset.maturity,
    version: asset.version,
  };
}

async function appendVersion(userId: string, asset: RecallAbilityAssetRecord): Promise<void> {
  const at = new Date().toISOString();
  await appendRecallJsonlRecord(userId, 'ability-asset-versions', asset.id, {
    schemaVersion: 1,
    ownerId: userId,
    id: `${asset.id}-v${asset.version}`,
    assetId: asset.id,
    version: asset.version,
    at,
    snapshot: snapshot(asset),
  } satisfies AbilityAssetVersionRecord);
}

async function appendAudit(userId: string, assetId: string, action: AbilityAssetAuditRecord['action'], note?: string): Promise<void> {
  const at = new Date().toISOString();
  await appendRecallJsonlRecord(userId, 'ability-asset-audit', assetId, {
    schemaVersion: 1,
    ownerId: userId,
    id: `${assetId}-${action}-${at.replace(/[^A-Za-z0-9]/g, '')}`,
    assetId,
    action,
    at,
    ...(note ? { note } : {}),
  } satisfies AbilityAssetAuditRecord);
}

export async function initializeAbilityAsset(userId: string, asset: RecallAbilityAssetRecord): Promise<void> {
  const current = await listAbilityAssetVersions(userId, asset.id);
  if (!current.length) await appendVersion(userId, asset);
  const audit = await listAbilityAssetAudit(userId, asset.id);
  if (!audit.length) await appendAudit(userId, asset.id, 'created');
}

export async function readAbilityAsset(userId: string, assetId: string): Promise<RecallAbilityAssetRecord> {
  const raw = await readRecallJsonRecord(userId, 'ability-assets', assetId);
  if (!raw) throw new Error('recall ability asset not found');
  return asAsset(raw);
}

export async function listAbilityAssets(userId: string): Promise<RecallAbilityAssetRecord[]> {
  let names: string[];
  try { names = await fs.readdir(assetsDirectory(userId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names.filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => readRecallJsonRecord(userId, 'ability-assets', name.slice(0, -5))));
  return records.filter((record): record is RecallJsonRecord => Boolean(record)).map(asAsset)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function updateAbilityAsset(userId: string, assetId: string, input: UpdateAbilityAssetInput): Promise<RecallAbilityAssetRecord> {
  if ('id' in input || 'ownerId' in input) throw new Error('ability asset identity is immutable');
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    const next: RecallAbilityAssetRecord = {
      ...current,
      ...(input.title !== undefined ? { title: bounded(input.title, 'title', 120) } : {}),
      ...(input.statement !== undefined ? { statement: bounded(input.statement, 'statement', 4_000) } : {}),
      ...(input.scope !== undefined ? { scope: bounded(input.scope, 'scope', 500) } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.evidenceRefs !== undefined ? { evidenceRefs: input.evidenceRefs } : {}),
      version: nextVersion(current.version),
      updatedAt: new Date().toISOString(),
    };
    return next;
  });
  const asset = asAsset(updated);
  await appendVersion(userId, asset);
  await appendAudit(userId, asset.id, 'updated');
  return asset;
}

async function setStatus(userId: string, assetId: string, status: RecallAbilityAssetRecord['status'], note?: string): Promise<RecallAbilityAssetRecord> {
  const normalizedNote = note === undefined ? undefined : bounded(note, 'audit note', 1_000);
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    return { ...current, status, updatedAt: new Date().toISOString() };
  });
  const asset = asAsset(updated);
  await appendAudit(userId, asset.id, status === 'paused' ? 'paused' : 'revoked', normalizedNote);
  return asset;
}

export function pauseAbilityAsset(userId: string, assetId: string, note?: string): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'paused', note);
}

export function revokeAbilityAsset(userId: string, assetId: string, note?: string): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'revoked', note);
}

export async function listAbilityAssetVersions(userId: string, assetId: string): Promise<AbilityAssetVersionRecord[]> {
  return (await listRecallJsonlRecords(userId, 'ability-asset-versions', assetId, 0)) as AbilityAssetVersionRecord[];
}

export async function listAbilityAssetAudit(userId: string, assetId: string): Promise<AbilityAssetAuditRecord[]> {
  return (await listRecallJsonlRecords(userId, 'ability-asset-audit', assetId, 0)) as AbilityAssetAuditRecord[];
}

export async function setAbilityAssetMaturity(
  userId: string,
  assetId: string,
  maturity: RecallAbilityAssetRecord['maturity'],
): Promise<RecallAbilityAssetRecord> {
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    return { ...current, maturity, updatedAt: new Date().toISOString() };
  });
  return asAsset(updated);
}
