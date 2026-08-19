import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { userLocalRoot } from '../../paths';
import { safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { snapshotSkillFiles, type SkillSnapshotFile } from './snapshot-service';

export type SkillVersionOperation = 'install' | 'upgrade' | 'manual_edit' | 'rollback' | 'migration';
export type SkillRollbackScope = 'full_tree' | 'skill_md_only';

export interface SkillVersionSecurity {
  outcome: 'pass' | 'restricted' | 'unknown';
  payloadHash?: string;
  scannerVersion?: string;
  rulesetVersion?: string;
  findingCount: number;
  scannedAt?: string;
}

export interface SkillVersionSource {
  kind: 'recall_asset' | 'manual_edit' | 'rollback' | 'migration';
  assetId?: string;
  assetVersion?: string;
  draftHash?: string;
  restoredFromVersion?: string;
  runId?: string;
}

export interface SkillVersionRecord {
  schemaVersion?: 2;
  revisionId: string;
  version: string;
  parentRevisionId?: string;
  at: string;
  note?: string;
  runId?: string;
  operation: SkillVersionOperation;
  files?: SkillSnapshotFile[];
  manifestHash?: string;
  content?: string;
  source: SkillVersionSource;
  security: SkillVersionSecurity;
  rollbackScope: SkillRollbackScope;
  canRollback: boolean;
}

export interface SkillVersionEnvelope {
  schemaVersion: 2;
  skillId: string;
  currentRevisionId?: string;
  records: SkillVersionRecord[];
  legacy?: boolean;
}

export interface AppendFullSkillVersionInput {
  version?: string;
  note?: string;
  operation: SkillVersionOperation;
  files: ReadonlyArray<SkillSnapshotFile>;
  source: SkillVersionSource;
  security: SkillVersionSecurity;
  expectedCurrentRevisionId?: string;
}

function versionsDir(uid: string): string {
  const root = process.env.COGSEED_WORKSPACE_ROOT
    || path.dirname(path.dirname(userLocalRoot(uid)));
  return path.join(root, uid, 'local', 'skills', 'versions');
}

function legacyVersionsDir(uid: string): string {
  const root = process.env.COGSEED_WORKSPACE_ROOT
    || path.dirname(path.dirname(userLocalRoot(uid)));
  return path.join(root, uid, 'local', 'kstar', 'versions');
}

export function skillVersionsPath(uid: string, skillId: string): string {
  if (!safeId(uid) || !safeId(skillId)) throw new Error('invalid skill version path');
  return path.join(versionsDir(uid), `${skillId}.json`);
}

function legacyVersionsPath(uid: string, skillId: string): string {
  return path.join(legacyVersionsDir(uid), `${skillId}.json`);
}

function asLegacyRecord(row: unknown, index: number): SkillVersionRecord | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const item = row as Record<string, unknown>;
  if (typeof item.version !== 'string' || typeof item.at !== 'string') return null;
  const content = typeof item.content === 'string' ? item.content : undefined;
  return {
    revisionId: typeof item.revisionId === 'string' ? item.revisionId : `legacy-${index}-${item.version}`,
    version: item.version,
    at: item.at,
    ...(typeof item.note === 'string' ? { note: item.note } : {}),
    ...(typeof item.runId === 'string' ? { runId: item.runId } : {}),
    ...(content !== undefined ? { content } : {}),
    operation: 'migration',
    source: { kind: 'migration', ...(typeof item.runId === 'string' ? { runId: item.runId } : {}) },
    security: { outcome: 'unknown', findingCount: 0 },
    rollbackScope: 'skill_md_only',
    canRollback: content !== undefined,
  };
}

function asV2Record(row: unknown): SkillVersionRecord | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const item = row as Record<string, unknown>;
  if (item.schemaVersion !== 2 || typeof item.revisionId !== 'string'
    || typeof item.version !== 'string' || typeof item.at !== 'string') return null;
  let files: SkillSnapshotFile[] | undefined;
  try {
    files = Array.isArray(item.files) ? snapshotSkillFiles(item.files as SkillSnapshotFile[]).files : undefined;
  } catch {
    return null;
  }
  const content = typeof item.content === 'string' ? item.content : undefined;
  const source = item.source && typeof item.source === 'object' && !Array.isArray(item.source)
    ? item.source as SkillVersionSource
    : { kind: 'migration' as const };
  const security = item.security && typeof item.security === 'object' && !Array.isArray(item.security)
    ? item.security as SkillVersionSecurity
    : { outcome: 'unknown' as const, findingCount: 0 };
  return {
    schemaVersion: 2,
    revisionId: item.revisionId,
    version: item.version,
    ...(typeof item.parentRevisionId === 'string' ? { parentRevisionId: item.parentRevisionId } : {}),
    at: item.at,
    ...(typeof item.note === 'string' ? { note: item.note } : {}),
    ...(typeof item.runId === 'string' ? { runId: item.runId } : {}),
    operation: typeof item.operation === 'string' ? item.operation as SkillVersionOperation : 'migration',
    ...(files ? { files, manifestHash: snapshotSkillFiles(files).manifestHash } : {}),
    ...(content !== undefined ? { content } : {}),
    source,
    security,
    rollbackScope: files ? 'full_tree' : 'skill_md_only',
    canRollback: files !== undefined || content !== undefined,
  };
}

async function readJsonFile(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    return undefined;
  }
}

async function readEnvelopeUnlocked(uid: string, skillId: string): Promise<SkillVersionEnvelope> {
  const current = await readJsonFile(skillVersionsPath(uid, skillId));
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    const raw = current as Record<string, unknown>;
    if (raw.schemaVersion === 2 && raw.skillId === skillId && Array.isArray(raw.records)) {
      const records = raw.records.map(asV2Record).filter((row): row is SkillVersionRecord => !!row);
      return {
        schemaVersion: 2,
        skillId,
        ...(typeof raw.currentRevisionId === 'string' ? { currentRevisionId: raw.currentRevisionId } : {}),
        records,
      };
    }
  }
  const loadedFromCurrent = Array.isArray(current);
  const legacyCurrent = loadedFromCurrent ? current : await readJsonFile(legacyVersionsPath(uid, skillId));
  const records = Array.isArray(legacyCurrent)
    ? legacyCurrent.map(asLegacyRecord).filter((row): row is SkillVersionRecord => !!row)
    : [];
  return { schemaVersion: 2, skillId, records, legacy: true };
}

export async function readSkillVersionEnvelope(uid: string, skillId: string): Promise<SkillVersionEnvelope> {
  return readEnvelopeUnlocked(uid, skillId);
}

export async function writeSkillVersionEnvelope(
  uid: string,
  skillId: string,
  envelope: SkillVersionEnvelope,
): Promise<void> {
  const file = skillVersionsPath(uid, skillId);
  await fileEditLock(file).runExclusive(() => writeJson(file, envelope));
}

export async function listSkillVersions(uid: string, skillId: string): Promise<SkillVersionRecord[]> {
  const envelope = await readEnvelopeUnlocked(uid, skillId);
  return envelope.records;
}

export async function readSkillVersion(
  uid: string,
  skillId: string,
  revisionOrVersion: string,
): Promise<SkillVersionRecord | undefined> {
  const records = await listSkillVersions(uid, skillId);
  return records.find((record) => record.revisionId === revisionOrVersion)
    || records.find((record) => record.version === revisionOrVersion);
}

function nextVersion(records: SkillVersionRecord[]): string {
  const highest = records.reduce((max, record) => {
    const value = /^[0-9]+$/.test(record.version) ? Number(record.version) : 0;
    return Number.isSafeInteger(value) ? Math.max(max, value) : max;
  }, 0);
  return String(highest + 1);
}

export async function appendFullSkillVersion(
  uid: string,
  skillId: string,
  entry: AppendFullSkillVersionInput,
): Promise<SkillVersionRecord> {
  const file = skillVersionsPath(uid, skillId);
  return fileEditLock(file).runExclusive(async () => {
    const envelope = await readEnvelopeUnlocked(uid, skillId);
    if (entry.expectedCurrentRevisionId !== undefined
      && envelope.currentRevisionId !== entry.expectedCurrentRevisionId) {
      throw new Error('skill version changed');
    }
    const snapshot = snapshotSkillFiles(entry.files);
    const version = entry.version || nextVersion(envelope.records);
    if (envelope.records.some((record) => record.version === version)) {
      throw new Error('skill version already exists');
    }
    const record: SkillVersionRecord = {
      schemaVersion: 2,
      revisionId: randomUUID(),
      version,
      ...(envelope.currentRevisionId ? { parentRevisionId: envelope.currentRevisionId } : {}),
      at: new Date().toISOString(),
      ...(entry.note ? { note: entry.note } : {}),
      operation: entry.operation,
      files: snapshot.files,
      manifestHash: snapshot.manifestHash,
      source: entry.source,
      security: entry.security,
      rollbackScope: 'full_tree',
      canRollback: true,
    };
    const next: SkillVersionEnvelope = {
      schemaVersion: 2,
      skillId,
      currentRevisionId: record.revisionId,
      records: [record, ...envelope.records],
    };
    await writeJson(file, next);
    return record;
  });
}

/** Compatibility writer for older callers. New production mutations must use
 * appendFullSkillVersion so rollback never pretends a SKILL.md-only record is
 * a complete tree snapshot. */
export async function appendSkillVersion(
  uid: string,
  skillId: string,
  entry: { version: string; note?: string; runId?: string; content?: string },
): Promise<SkillVersionRecord[]> {
  const file = skillVersionsPath(uid, skillId);
  return fileEditLock(file).runExclusive(async () => {
    const envelope = await readEnvelopeUnlocked(uid, skillId);
    const content = typeof entry.content === 'string' ? entry.content : undefined;
    const record: SkillVersionRecord = {
      revisionId: randomUUID(),
      version: entry.version,
      at: new Date().toISOString(),
      ...(entry.note ? { note: entry.note } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(content !== undefined ? { content } : {}),
      operation: 'migration',
      source: { kind: 'migration', ...(entry.runId ? { runId: entry.runId } : {}) },
      security: { outcome: 'unknown', findingCount: 0 },
      rollbackScope: 'skill_md_only',
      canRollback: content !== undefined,
    };
    const records = [record, ...envelope.records];
    // Keep this compatibility writer flat so older readers that only know the
    // pre-V2 array can still inspect the history. New production writes use
    // appendFullSkillVersion and always use the V2 envelope.
    await writeJson(file, records);
    return records;
  });
}
