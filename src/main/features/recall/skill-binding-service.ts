import * as fs from 'node:fs/promises';

import { recallJsonRecordPath } from './paths';
import { readRecallJsonRecord, updateRecallJsonRecord, writeRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';

const COLLECTION = 'skill-bindings';

export interface RecallSkillBindingDecision {
  assetVersion: string;
  action: 'installed' | 'upgraded' | 'deferred' | 'rejected';
  at: string;
  draftHash?: string;
  skillVersion?: string;
}

export interface RecallSkillBindingRecord extends RecallJsonRecord {
  schemaVersion: number;
  ownerId: string;
  id: string;
  assetId: string;
  skillId: string;
  installedAssetVersion: string;
  currentSkillVersion: string;
  currentRevisionId: string;
  currentManifestHash: string;
  createdAt: string;
  updatedAt: string;
  decisions: RecallSkillBindingDecision[];
  legacySkillIds?: string[];
}

function safeAssetId(assetId: string): string {
  if (!assetId || /[\\/]/.test(assetId) || assetId.includes('..')) throw new Error('invalid recall skill binding asset id');
  return assetId;
}

function asBinding(value: RecallJsonRecord | undefined): RecallSkillBindingRecord | undefined {
  if (!value) return undefined;
  const row = value as Partial<RecallSkillBindingRecord>;
  if (typeof row.assetId !== 'string' || typeof row.skillId !== 'string'
    || typeof row.installedAssetVersion !== 'string' || typeof row.currentSkillVersion !== 'string'
    || typeof row.currentRevisionId !== 'string' || typeof row.currentManifestHash !== 'string'
    || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string'
    || !Array.isArray(row.decisions)) throw new Error('malformed recall skill binding');
  if (row.assetId !== row.id) throw new Error('malformed recall skill binding id');
  return {
    ...(value as object),
    decisions: row.decisions.filter((item): item is RecallSkillBindingDecision => (
      !!item && typeof item === 'object'
      && typeof item.assetVersion === 'string'
      && (item.action === 'installed' || item.action === 'upgraded' || item.action === 'deferred' || item.action === 'rejected')
      && typeof item.at === 'string'
    )),
  } as RecallSkillBindingRecord;
}

export async function readSkillBinding(userId: string, assetId: string): Promise<RecallSkillBindingRecord | undefined> {
  const id = safeAssetId(assetId);
  return asBinding(await readRecallJsonRecord(userId, COLLECTION, id));
}

export async function createSkillBinding(
  userId: string,
  input: Omit<RecallSkillBindingRecord, 'schemaVersion' | 'ownerId' | 'id' | 'assetId'> & { assetId: string },
): Promise<RecallSkillBindingRecord> {
  const id = safeAssetId(input.assetId);
  const now = input.updatedAt || new Date().toISOString();
  return asBinding(await writeRecallJsonRecord(userId, COLLECTION, id, {
    schemaVersion: 1,
    ownerId: userId,
    id,
    ...input,
    createdAt: input.createdAt || now,
    updatedAt: now,
  } as RecallSkillBindingRecord))!;
}

export async function updateSkillBinding(
  userId: string,
  assetId: string,
  updater: (current: RecallSkillBindingRecord) => RecallSkillBindingRecord,
): Promise<RecallSkillBindingRecord> {
  const id = safeAssetId(assetId);
  return asBinding(await updateRecallJsonRecord(userId, COLLECTION, id, (current) => {
    const previous = asBinding(current);
    if (!previous) throw new Error('recall skill binding not found');
    const next = updater(previous);
    return {
      ...next,
      schemaVersion: 1,
      ownerId: userId,
      id,
      assetId: id,
      updatedAt: new Date().toISOString(),
    } as RecallSkillBindingRecord;
  }))!;
}

export async function recordSkillBindingDecision(
  userId: string,
  assetId: string,
  decision: RecallSkillBindingDecision,
  update?: Partial<Pick<RecallSkillBindingRecord, 'installedAssetVersion' | 'currentSkillVersion' | 'currentRevisionId' | 'currentManifestHash'>>,
): Promise<RecallSkillBindingRecord> {
  return updateSkillBinding(userId, assetId, (current) => ({
    ...current,
    ...(update || {}),
    decisions: [...current.decisions, decision].slice(-32),
  }));
}

export async function listSkillBindings(userId: string): Promise<RecallSkillBindingRecord[]> {
  const dir = recallJsonRecordPath(userId, COLLECTION, 'placeholder').replace(/placeholder\.json$/, '');
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = await Promise.all(names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readSkillBinding(userId, name.slice(0, -5))));
  return rows.filter((row): row is RecallSkillBindingRecord => !!row);
}

export async function refreshBindingsForSkill(
  userId: string,
  skillId: string,
  version: string,
  revisionId: string,
  manifestHash: string,
): Promise<void> {
  const bindings = (await listSkillBindings(userId)).filter((binding) => binding.skillId === skillId);
  await Promise.all(bindings.map((binding) => updateSkillBinding(userId, binding.assetId, (current) => ({
    ...current,
    currentSkillVersion: version,
    currentRevisionId: revisionId,
    currentManifestHash: manifestHash,
  }))));
}

export function bindingHasDecision(
  binding: RecallSkillBindingRecord,
  assetVersion: string,
  actions?: RecallSkillBindingDecision['action'][],
): boolean {
  return binding.decisions.some((item) => item.assetVersion === assetVersion
    && (!actions || actions.includes(item.action)));
}

export function bindingIsStale(binding: RecallSkillBindingRecord, assetVersion: string): boolean {
  return binding.installedAssetVersion !== assetVersion;
}
