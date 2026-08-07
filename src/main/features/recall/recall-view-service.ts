import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { genId12, safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import {
  cognitionSourceRefKey,
  normalizeCognitionSourceRefsForWrite,
  type CognitionSourceRef,
} from './source-service';
import { readRecallJsonRecord, writeRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';

const RECALL_VIEW_COLLECTION = 'views';

export type RecallViewPurpose = 'conversation_capture' | 'task_context';

export interface RecallViewRecord extends RecallJsonRecord {
  taxonomyVersion: 2;
  purpose: RecallViewPurpose;
  workspaceId?: string;
  sourceRefs: CognitionSourceRef[];
  assetRefs: string[];
  degradedRefs: string[];
  createdAt: string;
  expiresAt?: string;
}

export interface CreateRecallViewInput {
  purpose: RecallViewPurpose;
  workspaceId?: string;
  sourceRefs: unknown[];
  assetRefs?: string[];
  degradedRefs?: string[];
  expiresAt?: string;
}

export interface ListRecallViewsQuery {
  purpose?: RecallViewPurpose;
  workspaceId?: string;
  includeExpired?: boolean;
  limit?: number;
}

function viewDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, RECALL_VIEW_COLLECTION, 'placeholder'));
}

function requirePurpose(value: unknown): RecallViewPurpose {
  if (value === 'conversation_capture' || value === 'task_context') return value;
  throw new Error('invalid recall view purpose');
}

function optionalSafeId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !safeId(value)) throw new Error(`invalid recall view ${field}`);
  return value;
}

function safeIds(values: unknown, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !safeId(value))) {
    throw new Error(`invalid recall view ${field}`);
  }
  return [...new Set(values)];
}

function safeRefKeys(values: unknown): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !/^[a-z_]+:[A-Za-z0-9_-]+$/.test(value))) {
    throw new Error('invalid recall view degraded refs');
  }
  return [...new Set(values)];
}

function asRecallView(value: RecallJsonRecord): RecallViewRecord {
  const purpose = requirePurpose(value.purpose);
  const workspaceId = optionalSafeId(value.workspaceId, 'workspace id');
  if (!Array.isArray(value.sourceRefs) || typeof value.createdAt !== 'string') {
    throw new Error('malformed recall view');
  }
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt)))) {
    throw new Error('malformed recall view expiry');
  }
  const sourceRefs = normalizeCognitionSourceRefsForWrite(value.sourceRefs);
  const assetRefs = safeIds(value.assetRefs, 'asset refs');
  const degradedRefs = safeRefKeys(value.degradedRefs);
  return {
    ...value,
    taxonomyVersion: 2,
    purpose,
    ...(workspaceId ? { workspaceId } : {}),
    sourceRefs,
    assetRefs,
    degradedRefs: [...new Set([
      ...degradedRefs,
      ...sourceRefs.filter((ref) => ref.degraded).map(cognitionSourceRefKey),
    ])],
  } as RecallViewRecord;
}

export function isRecallViewExpired(view: Pick<RecallViewRecord, 'expiresAt'>, now = Date.now()): boolean {
  return Boolean(view.expiresAt && Date.parse(view.expiresAt) <= now);
}

export async function createRecallView(userId: string, input: CreateRecallViewInput): Promise<RecallViewRecord> {
  const purpose = requirePurpose(input.purpose);
  const workspaceId = optionalSafeId(input.workspaceId, 'workspace id');
  if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) {
    throw new Error('invalid recall view expiry');
  }
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  const assetRefs = safeIds(input.assetRefs, 'asset refs');
  const degradedRefs = [...new Set([
    ...safeRefKeys(input.degradedRefs),
    ...sourceRefs.filter((ref) => ref.degraded).map(cognitionSourceRefKey),
  ])];
  const record: RecallViewRecord = {
    schemaVersion: 1,
    taxonomyVersion: 2,
    ownerId: userId,
    id: `rv-${genId12()}`,
    purpose,
    ...(workspaceId ? { workspaceId } : {}),
    sourceRefs,
    assetRefs,
    degradedRefs,
    createdAt: new Date().toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  await writeRecallJsonRecord(userId, RECALL_VIEW_COLLECTION, record.id, record);
  return record;
}

export async function readRecallView(userId: string, viewId: string): Promise<RecallViewRecord> {
  if (!safeId(viewId)) throw new Error('invalid recall view id');
  const record = await readRecallJsonRecord(userId, RECALL_VIEW_COLLECTION, viewId);
  if (!record) throw new Error('recall view not found');
  return asRecallView(record);
}

export async function listRecallViews(userId: string, query: ListRecallViewsQuery = {}): Promise<RecallViewRecord[]> {
  const purpose = query.purpose === undefined ? undefined : requirePurpose(query.purpose);
  const workspaceId = optionalSafeId(query.workspaceId, 'workspace id');
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 20)));
  let names: string[];
  try {
    names = await fs.readdir(viewDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => readRecallJsonRecord(userId, RECALL_VIEW_COLLECTION, name.slice(0, -5))));
  return records
    .filter((record): record is RecallJsonRecord => Boolean(record))
    .map(asRecallView)
    .filter((view) => !purpose || view.purpose === purpose)
    .filter((view) => workspaceId === undefined || view.workspaceId === workspaceId)
    .filter((view) => query.includeExpired === true || !isRecallViewExpired(view))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}
