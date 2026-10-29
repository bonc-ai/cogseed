import { createHash } from 'node:crypto';
import { cognitionMessageSourceId } from './source-identity';
import { withCognitionTransition } from '../cognition_bridge';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { safeId } from '../../storage';
import {
  downgradeAbilityAssetMaturityForRevokedEvidence,
  pauseAbilityAssetForRevokedEvidence,
  listAbilityAssets,
  revokeAbilityAsset,
} from './asset-service';
import { recallJsonRecordPath } from './paths';
import {
  COGNITION_SOURCE_TYPES,
  cognitionSourceRefKey,
  cognitionSourceDependsOn,
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
  locator?: CognitionSourceRef['locator'];
  availability: CognitionSourceAvailability;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoveCognitionSourceResult {
  control: CognitionSourceControlRecord;
  affectedAssetIds: string[];
  downgradedAssetIds: string[];
  pausedAssetIds?: string[];
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

/** A read-boundary invalidation token, never an approval or availability grant. */
export function cognitionSourceControlSnapshot(userId: string, source: Pick<CognitionSourceRef, 'kind' | 'id'> & Partial<Pick<CognitionSourceRef, 'locator'>>): string {
  const parent = source.locator ? ':' + cognitionSourceControlSnapshot(userId, { kind: 'conversation', id: source.locator.conversationId })
    + ':' + cognitionSourceControlSnapshot(userId, { kind: 'conversation', id: cognitionMessageSourceId(source.locator.conversationId, source.locator.messageId) }) : '';
  const file = recallJsonRecordPath(userId, SOURCE_CONTROL_COLLECTION, cognitionSourceControlId(source));
  try { return createHash('sha256').update(readFileSync(file)).digest('hex') + parent; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing' + parent; throw error; }
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
    locator: value.locator,
  });
  if (!source || source.taxonomyVersion !== 2) throw new Error('malformed cognition source control source');
  if (cognitionSourceControlId(source) !== value.id) throw new Error('cognition source control identity mismatch');
  return {
    ...value,
    kind: source.kind as CognitionSourceType,
    sourceId: source.id,
    subtype: source.subtype,
    ...(source.scope ? { scope: source.scope } : {}),
    ...(source.locator ? { locator: source.locator } : {}),
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
  const updated = await withCognitionTransition(userId, () => updateRecallJsonRecord(userId, SOURCE_CONTROL_COLLECTION, id, (current) => {
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
      ...(source.locator ? { locator: source.locator } : previous?.locator ? { locator: previous.locator } : {}),
      availability,
      ...(lastErrorCode ? { lastErrorCode } : {}),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    } satisfies CognitionSourceControlRecord;
  }));
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
  source: Pick<CognitionSourceRef, 'kind' | 'id'> & Partial<Pick<CognitionSourceRef, 'locator'>>,
): Promise<boolean> {
  // Legacy (taxonomyVersion 1) evidence refs predate source controls, which are
  // keyed only by the v2 taxonomy. They cannot have a control record, so they
  // are not disabled by one; querying the v2 control API with a legacy kind
  // would throw and make every legacy-backed asset unmanageable.
  if (!isSourceType(source.kind)) return true;
  const control = await readCognitionSourceControl(userId, source);
  if (control && control.availability !== 'active') return false;
  if (source.locator) return await isCognitionSourceEnabled(userId, { kind: 'conversation', id: source.locator.conversationId })
    && await isCognitionSourceEnabled(userId, { kind: 'conversation', id: cognitionMessageSourceId(source.locator.conversationId, source.locator.messageId) });
  return true;
}

/** Message-level controls for one frozen capture set. Match both the stored
 *  locator and the stable source id so controls created before the locator
 *  field existed still invalidate the message. */
export async function listDisabledCognitionMessageIds(
  userId: string,
  conversationId: string,
  messageIds: readonly string[],
): Promise<Set<string>> {
  const wanted = new Set(messageIds);
  if (!safeId(conversationId) || !wanted.size) return new Set();
  const bySourceId = new Map([...wanted].map(id => [cognitionMessageSourceId(conversationId, id), id]));
  const disabled = new Set<string>();
  for (const control of await listCognitionSourceControls(userId)) {
    if (control.kind !== 'conversation' || control.availability === 'active') continue;
    const byLocator = control.locator?.conversationId === conversationId && wanted.has(control.locator.messageId)
      ? control.locator.messageId : undefined;
    const messageId = byLocator || bySourceId.get(control.sourceId);
    if (messageId) disabled.add(messageId);
  }
  return disabled;
}

export async function removeCognitionSource(
  userId: string,
  sourceInput: CognitionSourceRef,
  revokeAssets: boolean,
): Promise<RemoveCognitionSourceResult> {
  const source = requireCatalogSource(sourceInput);
  const control = await setSourceControl(userId, source, 'removed');
  const assets = await listAbilityAssets(userId);
  const affected = assets.filter(asset => asset.evidenceRefs.some(ref => cognitionSourceDependsOn(ref, source)));
  const affectedAssetIds = affected.map((asset) => asset.id);
  if (!revokeAssets) {
    const [downgrades, pauses] = await Promise.all([
      Promise.all(affected.map((asset) => (
        downgradeAbilityAssetMaturityForRevokedEvidence(userId, asset.id, source)
      ))),
      Promise.all(affected.map((asset) => (
        pauseAbilityAssetForRevokedEvidence(userId, asset.id, source)
      ))),
    ]);
    return {
      control,
      affectedAssetIds,
      downgradedAssetIds: affected.filter((_, index) => downgrades[index].downgraded).map((asset) => asset.id),
      pausedAssetIds: affected.filter((_, index) => pauses[index].paused).map((asset) => asset.id),
      revokedAssetIds: [],
      failedAssetIds: [],
    };
  }

  const downgradedAssetIds: string[] = [];
  const revokedAssetIds: string[] = [];
  const failedAssetIds: string[] = [];
  for (const asset of affected) {
    try {
      const downgrade = await downgradeAbilityAssetMaturityForRevokedEvidence(userId, asset.id, source);
      if (downgrade.downgraded) downgradedAssetIds.push(asset.id);
      if (asset.status !== 'revoked') {
        await revokeAbilityAsset(userId, asset.id, {
          actor: 'user',
          reason: `source_removed:${source.kind}:${source.id}`,
        });
      }
      revokedAssetIds.push(asset.id);
    } catch {
      failedAssetIds.push(asset.id);
    }
  }
  if (failedAssetIds.length) {
    const failedControl = await setSourceControl(userId, source, 'removed', 'asset_revoke_partial');
    return { control: failedControl, affectedAssetIds, downgradedAssetIds, revokedAssetIds, failedAssetIds };
  }
  return { control, affectedAssetIds, downgradedAssetIds, revokedAssetIds, failedAssetIds };
}

export async function previewCognitionSourceRemoval(
  userId: string,
  sourceInput: CognitionSourceRef,
): Promise<CognitionSourceRemovalImpact> {
  const source = requireCatalogSource(sourceInput);
  const assets = await listAbilityAssets(userId);
  const affected = assets.filter(asset => asset.evidenceRefs.some(ref => cognitionSourceDependsOn(ref, source)));
  return {
    affectedAssetCount: affected.length,
    revocableAssetCount: affected.filter((asset) => asset.status !== 'revoked').length,
  };
}
