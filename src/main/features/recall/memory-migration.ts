/**
 * Migrate legacy USER.md / MEMORY.md entries into cognition assets.
 *
 * The source remains authoritative until its exact scanned bytes have been
 * backed up. Only entries that reach the asset store are removed; failed and
 * review-pending entries remain, and role-template records stay in place.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { userMemoryFile, userProfileFile } from '../../paths';
import { writeTextAtomicSync } from '../../storage';
import { parseMemoryRecordsContent, serializeMemoryRecords, type MemoryRecord } from '../memory-records';

const log = createLogger('recall.memory-migration');

export interface MemoryMigrationReport {
  scannedUser: number;
  scannedShared: number;
  migrated: number;
  skippedNoText: number;
  /** Entries held in the candidate/review flow remain in the legacy source. */
  pendingReview: number;
  failed: number;
  backupDir?: string;
  backupFailed: boolean;
  corruptFiles: number;
  readFailedFiles: number;
  sourceChangedFiles: number;
  cleanupFailedFiles: number;
  /** Selected source/hash rows that were no longer present in the reviewed snapshot. */
  staleSelections: number;
  dryRun: boolean;
}

export type LegacyMemoryScope = 'user' | 'shared';

export interface LegacyMemoryMigrationSelection {
  scope: LegacyMemoryScope;
  contentHash: string;
}

export interface LegacyMemoryMigrationPreview {
  fingerprints: Record<LegacyMemoryScope, string>;
  sources: Record<LegacyMemoryScope, {
    status: 'ready' | 'empty' | 'blocked' | 'unavailable';
    eligibleEntries: number;
    eligibleRecords: number;
    retainedTemplateRecords: number;
    retainedAssetRecords: number;
    retainedNonIndependentRecords: number;
  }>;
  items: Array<LegacyMemoryMigrationSelection & { text: string; occurrences: number }>;
}

interface PendingSource {
  file: string;
  scope: LegacyMemoryScope;
  rawSnapshot: Buffer;
  records: MemoryRecord[];
  migratableRecords: MemoryRecord[];
}

const CONTENT_HASH = /^[a-f0-9]{64}$/;

function contentHash(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceFiles(userId: string, files?: { user?: string; shared?: string }) {
  return [
    { scope: 'user' as const, file: files?.user || userProfileFile(userId) },
    { scope: 'shared' as const, file: files?.shared || userMemoryFile(userId) },
  ];
}

function readSourceSnapshot(file: string): { raw: Buffer; unavailable: boolean } {
  try {
    return { raw: fs.readFileSync(file), unavailable: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: Buffer.alloc(0), unavailable: false };
    return { raw: Buffer.alloc(0), unavailable: true };
  }
}

/** Read-only inventory used by the explicit migration review UI. No backup,
 * candidate, asset, or source-file mutation happens here. Repeated identical
 * notes in one file are grouped because selecting a content hash moves every
 * matching occurrence together. */
export function previewLegacyMemoryMigration(
  userId: string,
  opts: { files?: { user?: string; shared?: string } } = {},
): LegacyMemoryMigrationPreview {
  const fingerprints: Record<LegacyMemoryScope, string> = { user: '', shared: '' };
  const sources: LegacyMemoryMigrationPreview['sources'] = {
    user: { status: 'empty', eligibleEntries: 0, eligibleRecords: 0, retainedTemplateRecords: 0, retainedAssetRecords: 0, retainedNonIndependentRecords: 0 },
    shared: { status: 'empty', eligibleEntries: 0, eligibleRecords: 0, retainedTemplateRecords: 0, retainedAssetRecords: 0, retainedNonIndependentRecords: 0 },
  };
  const grouped = new Map<string, LegacyMemoryMigrationPreview['items'][number]>();

  for (const target of sourceFiles(userId, opts.files)) {
    const { raw, unavailable } = readSourceSnapshot(target.file);
    fingerprints[target.scope] = contentHash(raw);
    if (unavailable) {
      sources[target.scope] = { ...sources[target.scope], status: 'unavailable' };
      continue;
    }

    const parsed = parseMemoryRecordsContent(raw.toString('utf8'));
    if (parsed.corruptMetadata || parsed.degradedMetadata) {
      // The visible notes may still be readable, but unclear ownership means
      // this file cannot be safely migrated as a whole.
      sources[target.scope] = { ...sources[target.scope], status: 'blocked' };
      continue;
    }

    const sourceSummary = sources[target.scope];
    for (const record of parsed.records) {
      if (!String(record.text || '').trim()) continue;
      if (record.sources.some((source) => source.kind === 'role_template')) {
        sourceSummary.retainedTemplateRecords += 1;
        continue;
      }
      if (record.sources.some((source) => source.kind === 'cognition_asset')) {
        sourceSummary.retainedAssetRecords += 1;
        continue;
      }
      if (!record.independent) {
        // A projection with no surviving owner marker is not a user-authored
        // memory. Leave it in place until its provenance can be reconciled.
        sourceSummary.retainedNonIndependentRecords += 1;
        continue;
      }
      const hash = record.contentSha256 || contentHash(record.text.trim());
      const key = `${target.scope}:${hash}`;
      const prior = grouped.get(key);
      if (prior) prior.occurrences += 1;
      else grouped.set(key, { scope: target.scope, contentHash: hash, text: record.text.trim(), occurrences: 1 });
      sourceSummary.eligibleRecords += 1;
    }
    sourceSummary.eligibleEntries = [...grouped.values()]
      .filter((item) => item.scope === target.scope).length;
    sourceSummary.status = sourceSummary.eligibleRecords > 0 ? 'ready' : 'empty';
  }

  return { fingerprints, sources, items: [...grouped.values()] };
}

function backupFile(source: PendingSource, backupDir: string): boolean {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, path.basename(source.file));
    // Persist the exact scanned bytes, not a later copy of a source that may
    // have changed while this migration was preparing its backup.
    writeTextAtomicSync(backupPath, source.rawSnapshot);
    return fs.readFileSync(backupPath).equals(source.rawSnapshot);
  } catch (error) {
    log.warn('memory migration backup failed', { sourceFile: source.file, error: (error as Error).message });
    return false;
  }
}

function sourceMatchesSnapshot(file: string, snapshot: Buffer): boolean {
  try {
    return fs.readFileSync(file).equals(snapshot);
  } catch {
    return false;
  }
}

/**
 * Migrate entries from USER.md / MEMORY.md. dryRun inventories only and never
 * creates a backup or writes to the source files.
 */
export async function migrateLegacyMemoryToAssets(
  userId: string,
  opts: {
    selectedEntries: LegacyMemoryMigrationSelection[];
    expectedFingerprints: Partial<Record<LegacyMemoryScope, string>>;
    files?: { user?: string; shared?: string };
  },
): Promise<MemoryMigrationReport> {
  if (!Array.isArray(opts.selectedEntries) || opts.selectedEntries.length === 0 || opts.selectedEntries.length > 500) {
    throw new Error('explicit migration selection is required');
  }
  const selections = new Map<string, LegacyMemoryMigrationSelection>();
  for (const selection of opts.selectedEntries) {
    if (!selection || (selection.scope !== 'user' && selection.scope !== 'shared') || !CONTENT_HASH.test(selection.contentHash)) {
      throw new Error('invalid migration selection');
    }
    selections.set(`${selection.scope}:${selection.contentHash}`, selection);
  }
  for (const selection of selections.values()) {
    const fingerprint = opts.expectedFingerprints?.[selection.scope];
    if (typeof fingerprint !== 'string' || !CONTENT_HASH.test(fingerprint)) {
      throw new Error('reviewed source fingerprint is required');
    }
  }
  const report: MemoryMigrationReport = {
    scannedUser: 0,
    scannedShared: 0,
    migrated: 0,
    skippedNoText: 0,
    pendingReview: 0,
    failed: 0,
    backupFailed: false,
    corruptFiles: 0,
    readFailedFiles: 0,
    sourceChangedFiles: 0,
    cleanupFailedFiles: 0,
    staleSelections: 0,
    dryRun: false,
  };

  const files = sourceFiles(userId, opts.files);
  const selectedMatches = new Set<string>();

  const pending: PendingSource[] = [];
  for (const target of files) {
    const selectedHashes = new Set([...selections.values()]
      .filter((selection) => selection.scope === target.scope)
      .map((selection) => selection.contentHash));
    if (!selectedHashes.size) continue;
    const { raw: rawSnapshot, unavailable } = readSourceSnapshot(target.file);
    if (unavailable) {
      report.readFailedFiles += 1;
      log.warn('memory migration read failed', { file: target.file });
      continue;
    }
    if (contentHash(rawSnapshot) !== opts.expectedFingerprints[target.scope]) {
      report.sourceChangedFiles += 1;
      log.info('memory migration deferred because source differs from the reviewed snapshot', { file: target.file });
      continue;
    }

    const parsed = parseMemoryRecordsContent(rawSnapshot.toString('utf8'));
    if (parsed.corruptMetadata || parsed.degradedMetadata) {
      report.corruptFiles += 1;
      log.warn('memory migration skipped file with unreliable metadata', { file: target.file });
      continue;
    }
    const eligibleRecords = parsed.records.filter(
      (record) => record.independent && record.sources.length === 0,
    );
    const candidateTexts = eligibleRecords.map((record) => String(record.text || '').trim());
    const texts = candidateTexts.filter(Boolean);
    report[target.scope === 'user' ? 'scannedUser' : 'scannedShared'] = texts.length;
    report.skippedNoText += candidateTexts.length - texts.length;

    const migratableRecords = eligibleRecords.filter((record) => {
      const text = String(record.text || '').trim();
      if (!text) return false;
      const hash = record.contentSha256 || contentHash(text);
      const key = `${target.scope}:${hash}`;
      if (!selectedHashes.has(hash)) return false;
      selectedMatches.add(key);
      return true;
    });
    if (migratableRecords.length) {
      pending.push({
        file: target.file,
        scope: target.scope,
        rawSnapshot,
        records: parsed.records,
        migratableRecords,
      });
    }
  }
  report.staleSelections = [...selections.keys()].filter((key) => !selectedMatches.has(key)).length;
  if (!pending.length) return report;

  let backupDir: string;
  try {
    const backupParent = path.dirname(userMemoryFile(userId));
    fs.mkdirSync(backupParent, { recursive: true });
    backupDir = fs.mkdtempSync(
      path.join(backupParent, `memory-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-`),
    );
    report.backupDir = backupDir;
  } catch (error) {
    report.backupFailed = true;
    report.failed += pending.reduce((total, source) => total + source.migratableRecords.length, 0);
    log.error('memory migration could not create a backup directory', { error: (error as Error).message });
    return report;
  }
  for (const source of pending) {
    if (!backupFile(source, backupDir)) report.backupFailed = true;
  }
  if (report.backupFailed) {
    // A partially created backup directory is harmless; no ingestion or source
    // mutation starts unless every source snapshot is safely recoverable.
    report.failed += pending.reduce((total, source) => total + source.migratableRecords.length, 0);
    log.error('memory migration stopped because a source backup could not be verified', {
      backupDir,
      files: pending.length,
    });
    return report;
  }

  const { ingestLegacyMemoryKnowledge } = await import('./candidate-service');
  for (const source of pending) {
    if (!sourceMatchesSnapshot(source.file, source.rawSnapshot)) {
      report.sourceChangedFiles += 1;
      report.failed += source.migratableRecords.length;
      log.info('memory migration deferred because source changed after backup', { file: source.file });
      continue;
    }

    const succeededRecords = new Set<MemoryRecord>();
    for (const record of source.migratableRecords) {
      const text = String(record.text || '').trim();
      try {
        const result = await ingestLegacyMemoryKnowledge(userId, {
          text,
          scope: source.scope,
          contentHash: record.contentSha256 || contentHash(text),
        });
        if (result.mode === 'created' || result.mode === 'merged') {
          succeededRecords.add(record);
          report.migrated += 1;
        } else {
          // Candidate-only results are not complete: the original remains until
          // the user or a later retry resolves the review flow.
          report.pendingReview += 1;
        }
      } catch (error) {
        report.failed += 1;
        log.warn('memory migration entry failed', { error: (error as Error).message, head: text.slice(0, 40) });
      }
    }

    // Retire only migrated records. Keep template-owned records, and require an
    // exact byte match so concurrent writes are never swept away with the scan.
    if (succeededRecords.size > 0) {
      if (!sourceMatchesSnapshot(source.file, source.rawSnapshot)) {
        report.sourceChangedFiles += 1;
        log.info('memory migration cleanup deferred because source changed during migration', { file: source.file });
        continue;
      }
      try {
        const retainedRecords = source.records.filter((record) => {
          const isRoleTemplateRecord = record.sources.some((sourceRef) => sourceRef.kind === 'role_template');
          return isRoleTemplateRecord || !succeededRecords.has(record);
        });
        writeTextAtomicSync(source.file, serializeMemoryRecords(retainedRecords));
      } catch (error) {
        report.cleanupFailedFiles += 1;
        log.warn('memory migration cleanup failed', { file: source.file, error: (error as Error).message });
      }
    }
  }
  return report;
}
