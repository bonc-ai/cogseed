import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { safeId } from '../../storage';
import { listAbilityAssets, revokeAbilityAsset } from './asset-service';
import { recallJsonRecordPath } from './paths';
import {
  COGNITION_SOURCE_TYPES,
  cognitionSourceRefKey,
  normalizeCognitionSourceRef,
  type CognitionSourceRef,
  type CognitionSourceType,
} from './source-service';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';

const SOURCE_CONTROL_COLLECTION = 'source-controls';

export type CognitionSourceAvailability = 'active' | 'paused' | 'removed';

export interface CognitionSourceControlRecord extends RecallJsonRecord {
  id: string;
  kind: CognitionSourceType;
  sourceId: string;
  subtype: CognitionSourceRef['subtype'];
  scope?: CognitionSourceRef['scope'];
  title?: string;
  sourceVersion?: string;
  availability: CognitionSourceAvailability;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoveCognitionSourceResult {
  control: CognitionSourceControlRecord;
  affectedAssetIds: string[];
  revokedAssetIds: string[];
  failedAssetIds: string[];
}

export interface CognitionSourceRemovalImpact {
  affectedAssetCount: number;
  revocableAssetCount: number;
}

function controlsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, SOURCE_CONTROL_COLLECTION, 'placeholder'));
}

export function cognitionSourceControlId(source: Pick<CognitionSourceRef, 'kind' | 'id'>): string {
  const digest = createHash('sha256').update(cognitionSourceRefKey(source)).digest('hex').slice(0, 24);
  return `srcctl-${digest}`;
}

function isSourceType(value: unknown): value is CognitionSourceType {
  return typeof value === 'string' && COGNITION_SOURCE_TYPES.includes(value as CognitionSourceType);
}

function isAvailability(value: unknown): value is CognitionSourceAvailability {
  return value === 'active' || value === 'paused' || value === 'removed';
}

function asSourceControl(value: RecallJsonRecord): CognitionSourceControlRecord {
  if (
    !isSourceType(value.kind)
    || typeof value.sourceId !== 'string'
    || !safeId(value.sourceId)
    || typeof value.subtype !== 'string'
    || !isAvailability(value.availability)
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || (value.lastErrorCode !== undefined && (typeof value.lastErrorCode !== 'string' || !safeId(value.lastErrorCode)))
  ) throw new Error('malformed cognition source control');
  const source = normalizeCognitionSourceRef({
    kind: value.kind,
    id: value.sourceId,
    subtype: value.subtype,
    scope: value.scope,
    title: value.title,
    sourceVersion: value.sourceVersion,
  });
  if (!source || source.taxonomyVersion !== 2) throw new Error('malformed cognition source control source');
  if (cognitionSourceControlId(source) !== value.id) throw new Error('cognition source control identity mismatch');
  return {
    ...value,
    kind: source.kind as CognitionSourceType,
    sourceId: source.id,
    subtype: source.subtype,
    ...(source.scope ? { scope: source.scope } : {}),
    ...(source.title ? { title: source.title } : {}),
    ...(source.sourceVersion ? { sourceVersion: source.sourceVersion } : {}),
  } as CognitionSourceControlRecord;
}

function requireCatalogSource(source: CognitionSourceRef): CognitionSourceRef & { kind: CognitionSourceType } {
  const normalized = normalizeCognitionSourceRef(source);
  if (!normalized || normalized.taxonomyVersion !== 2 || !isSourceType(normalized.kind)) {
    throw new Error('invalid cognition source');
  }
  return normalized as CognitionSourceRef & { kind: CognitionSourceType };
}

export async function listCognitionSourceControls(userId: string): Promise<CognitionSourceControlRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(controlsDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => readRecallJsonRecord(userId, SOURCE_CONTROL_COLLECTION, name.slice(0, -5))));
  return records
    .filter((record): record is RecallJsonRecord => Boolean(record))
    .map(asSourceControl)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readCognitionSourceControl(
  userId: string,
  source: Pick<CognitionSourceRef, 'kind' | 'id'>,
): Promise<CognitionSourceControlRecord | undefined> {
  if (!isSourceType(source.kind) || typeof source.id !== 'string' || !safeId(source.id)) {
    throw new Error('invalid cognition source');
  }
  const record = await readRecallJsonRecord(userId, SOURCE_CONTROL_COLLECTION, cognitionSourceControlId(source));
  return record ? asSourceControl(record) : undefined;
}

async function setSourceControl(
  userId: string,
  sourceInput: CognitionSourceRef,
  availability: CognitionSourceAvailability,
  lastErrorCode?: string,
): Promise<CognitionSourceControlRecord> {
  const source = requireCatalogSource(sourceInput);
  if (lastErrorCode !== undefined && !safeId(lastErrorCode)) throw new Error('invalid cognition source error code');
  const id = cognitionSourceControlId(source);
  const now = new Date().toISOString();
  const updated = await updateRecallJsonRecord(userId, SOURCE_CONTROL_COLLECTION, id, (current) => {
    const previous = current ? asSourceControl(current) : undefined;
    return {
      schemaVersion: 1,
      ownerId: userId,
      id,
      kind: source.kind,
      sourceId: source.id,
      subtype: source.subtype,
      ...(source.scope ? { scope: source.scope } : {}),
      ...(source.title ? { title: source.title } : previous?.title ? { title: previous.title } : {}),
      ...(source.sourceVersion ? { sourceVersion: source.sourceVersion } : previous?.sourceVersion ? { sourceVersion: previous.sourceVersion } : {}),
      availability,
      ...(lastErrorCode ? { lastErrorCode } : {}),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    } satisfies CognitionSourceControlRecord;
  });
  return asSourceControl(updated);
}

export function pauseCognitionSource(userId: string, source: CognitionSourceRef): Promise<CognitionSourceControlRecord> {
  return setSourceControl(userId, source, 'paused');
}

export function resumeCognitionSource(userId: string, source: CognitionSourceRef): Promise<CognitionSourceControlRecord> {
  return setSourceControl(userId, source, 'active');
}

export function reconnectCognitionSource(userId: string, source: CognitionSourceRef): Promise<CognitionSourceControlRecord> {
  return setSourceControl(userId, source, 'active');
}

export function markCognitionSourceFailure(
  userId: string,
  source: CognitionSourceRef,
  errorCode: string,
): Promise<CognitionSourceControlRecord> {
  return setSourceControl(userId, source, 'active', errorCode);
}

export function clearCognitionSourceFailure(userId: string, source: CognitionSourceRef): Promise<CognitionSourceControlRecord> {
  return setSourceControl(userId, source, 'active');
}

export async function isCognitionSourceEnabled(
  userId: string,
  source: Pick<CognitionSourceRef, 'kind' | 'id'>,
): Promise<boolean> {
  const control = await readCognitionSourceControl(userId, source);
  return !control || control.availability === 'active';
}

export async function removeCognitionSource(
  userId: string,
  sourceInput: CognitionSourceRef,
  revokeAssets: boolean,
): Promise<RemoveCognitionSourceResult> {
  const source = requireCatalogSource(sourceInput);
  const control = await setSourceControl(userId, source, 'removed');
  const assets = await listAbilityAssets(userId);
  const affected = assets.filter((asset) => asset.evidenceRefs.some((ref) => (
    ref.kind === source.kind && ref.id === source.id
  )));
  const affectedAssetIds = affected.map((asset) => asset.id);
  if (!revokeAssets) return { control, affectedAssetIds, revokedAssetIds: [], failedAssetIds: [] };

  const revokedAssetIds: string[] = [];
  const failedAssetIds: string[] = [];
  for (const asset of affected) {
    if (asset.status === 'revoked') {
      revokedAssetIds.push(asset.id);
      continue;
    }
    try {
      await revokeAbilityAsset(userId, asset.id, `source_removed:${source.kind}:${source.id}`);
      revokedAssetIds.push(asset.id);
    } catch {
      failedAssetIds.push(asset.id);
    }
  }
  if (failedAssetIds.length) {
    const failedControl = await setSourceControl(userId, source, 'removed', 'asset_revoke_partial');
    return { control: failedControl, affectedAssetIds, revokedAssetIds, failedAssetIds };
  }
  return { control, affectedAssetIds, revokedAssetIds, failedAssetIds };
}

export async function previewCognitionSourceRemoval(
  userId: string,
  sourceInput: CognitionSourceRef,
): Promise<CognitionSourceRemovalImpact> {
  const source = requireCatalogSource(sourceInput);
  const assets = await listAbilityAssets(userId);
  const affected = assets.filter((asset) => asset.evidenceRefs.some((ref) => (
    ref.kind === source.kind && ref.id === source.id
  )));
  return {
    affectedAssetCount: affected.length,
    revocableAssetCount: affected.filter((asset) => asset.status !== 'revoked').length,
  };
}
