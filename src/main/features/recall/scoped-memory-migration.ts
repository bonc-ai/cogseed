/**
 * Explicit migration preview for Agent, Space, and legacy Project memory.
 * Each source file is fingerprinted and backed up independently. The source is
 * cleaned only after the selected entry has become a formal cognition asset.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import {
  agentMemoryFile,
  projectMemoryFile,
  projectMetaFile,
  spaceMemoryFile,
  userAgentMemoryFile,
  userAgentsDir,
  userMemoryDir,
  userRoot,
} from '../../paths';
import { readJsonSync, safeId, writeTextAtomicSync } from '../../storage';
import { parseMemoryRecordsContent, serializeMemoryRecords, type MemoryRecord } from '../memory-records';
import type { RecallAbilityAssetScopePolicy } from './scope-policy';

const log = createLogger('recall.scoped-memory-migration');
const CONTENT_HASH = /^[a-f0-9]{64}$/;
const SOURCE_KEY = /^(agent|space|project):([A-Za-z0-9_-]+):(canonical|legacy)$/;

export type LegacyScopedMemoryKind = 'agent' | 'space' | 'project';

export interface LegacyScopedMemorySelection {
  kind: LegacyScopedMemoryKind;
  id: string;
  contentHash: string;
  /** Every physical source represented by this preview row. */
  sourceKeys: string[];
}

export interface LegacyScopedMemoryPreviewSource {
  sourceKey: string;
  kind: LegacyScopedMemoryKind;
  id: string;
  label: string;
  status: 'ready' | 'empty' | 'blocked' | 'unavailable';
  eligibleEntries: number;
  eligibleRecords: number;
  retainedTemplateRecords: number;
  retainedAssetRecords: number;
  retainedNonIndependentRecords: number;
  retainedOversizedRecords: number;
  /** Project memory may be hidden by a Space file and therefore not injected. */
  runtimeVisibility?: 'project_fallback' | 'shadowed' | 'legacy_only';
}

export interface LegacyScopedMemoryPreview {
  fingerprints: Record<string, string>;
  sources: LegacyScopedMemoryPreviewSource[];
  items: Array<LegacyScopedMemorySelection & {
    text: string;
    occurrences: number;
    scopePolicy: RecallAbilityAssetScopePolicy;
    spaceId?: string;
  }>;
}

export interface LegacyScopedMemoryMigrationReport {
  selected: number;
  migrated: number;
  pendingReview: number;
  /** Candidate links let users review held entries while their source stays intact. */
  pendingCandidateIds: string[];
  failed: number;
  backupDir?: string;
  backupFailed: boolean;
  corruptFiles: number;
  readFailedFiles: number;
  sourceChangedFiles: number;
  cleanupFailedFiles: number;
  staleSelections: number;
}

interface SourceDefinition {
  sourceKey: string;
  kind: LegacyScopedMemoryKind;
  id: string;
  label: string;
  file: string;
  scopePolicy: RecallAbilityAssetScopePolicy;
  spaceId?: string;
  runtimeVisibility?: 'project_fallback' | 'shadowed' | 'legacy_only';
}

interface SourceSnapshot extends SourceDefinition {
  raw: Buffer;
  fingerprint: string;
  records: MemoryRecord[];
  selectedRecords: Set<MemoryRecord>;
  selectedHashes: Map<string, MemoryRecord[]>;
}

function contentHash(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function policyIdentity(policy: RecallAbilityAssetScopePolicy): string {
  return JSON.stringify(Object.fromEntries(Object.entries(policy)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, [...values].sort()])));
}

function fingerprintFor(raw: Buffer, policy: RecallAbilityAssetScopePolicy): string {
  return contentHash(Buffer.concat([raw, Buffer.from(`\0${policyIdentity(policy)}`, 'utf8')]));
}

function safeDirectories(root: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  return entries.filter((entry) => entry.isDirectory() && safeId(entry.name))
    .map((entry) => entry.name).sort();
}

function displayName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

async function collectSources(userId: string): Promise<SourceDefinition[]> {
  const out: SourceDefinition[] = [];
  const add = (source: SourceDefinition) => {
    if (fs.existsSync(source.file)) out.push(source);
  };

  const agentIds = new Set([
    ...safeDirectories(path.join(userMemoryDir(userId), 'agents')),
    ...safeDirectories(userAgentsDir(userId)),
  ]);
  for (const agentId of [...agentIds].sort()) {
    const rawAgent = readJsonSync<unknown>(path.join(userAgentsDir(userId), agentId, 'agent.json'));
    const agent = rawAgent && typeof rawAgent === 'object' && !Array.isArray(rawAgent)
      ? rawAgent as Record<string, unknown>
      : {};
    const label = displayName(agent.name, agentId);
    const scopePolicy = { agentIds: [agentId] };
    add({
      sourceKey: `agent:${agentId}:canonical`, kind: 'agent', id: agentId,
      label, file: agentMemoryFile(userId, agentId), scopePolicy,
    });
    add({
      sourceKey: `agent:${agentId}:legacy`, kind: 'agent', id: agentId,
      label, file: userAgentMemoryFile(userId, agentId), scopePolicy,
    });
  }

  const spaces = await import('../spaces').then((module) => module.listSpaces(userId));
  const spaceNameById = new Map<string, string>();
  for (const space of spaces) {
    if (!safeId(space.space_id)) continue;
    spaceNameById.set(space.space_id, displayName(space.name, space.space_id));
    add({
      sourceKey: `space:${space.space_id}:canonical`, kind: 'space', id: space.space_id,
      label: displayName(space.name, space.space_id),
      file: spaceMemoryFile(userId, space.space_id),
      scopePolicy: { workspaceIds: [space.space_id] },
      spaceId: space.space_id,
    });
  }

  const { listProjectIds } = await import('../../util/project-layout');
  for (const projectId of listProjectIds(userId)) {
    const rawMeta = readJsonSync<unknown>(projectMetaFile(userId, projectId));
    const meta = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
      ? rawMeta as Record<string, unknown>
      : {};
    const rawSpaceId = typeof meta.space_id === 'string' && safeId(meta.space_id) ? meta.space_id : undefined;
    const projectName = displayName(meta.name, projectId);
    const spaceLabel = rawSpaceId
      ? (spaceNameById.get(rawSpaceId) || rawSpaceId)
      : undefined;
    const policy: RecallAbilityAssetScopePolicy = {
      ...(rawSpaceId ? { workspaceIds: [rawSpaceId] } : {}),
      projectIds: [projectId],
    };
    const spaceFileExists = rawSpaceId ? fs.existsSync(spaceMemoryFile(userId, rawSpaceId)) : false;
    add({
      sourceKey: `project:${projectId}:legacy`, kind: 'project', id: projectId,
      label: `${projectName}${spaceLabel ? ` · Space: ${spaceLabel}` : ''}`,
      file: projectMemoryFile(userId, projectId), scopePolicy: policy,
      ...(rawSpaceId ? { spaceId: rawSpaceId } : {}),
      ...(rawSpaceId ? { runtimeVisibility: spaceFileExists ? 'shadowed' : 'project_fallback' } : { runtimeVisibility: 'legacy_only' }),
    });
  }
  return out.sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
    || left.sourceKey.localeCompare(right.sourceKey));
}

function readSnapshot(source: SourceDefinition): { raw: Buffer; unavailable: boolean } {
  try {
    return { raw: fs.readFileSync(source.file), unavailable: false };
  } catch {
    // Sources are added only after existsSync. If the file disappears between
    // enumeration and read, report that race instead of presenting it as an
    // empty memory file.
    return { raw: Buffer.alloc(0), unavailable: true };
  }
}

function selectionKey(selection: Pick<LegacyScopedMemorySelection, 'kind' | 'id' | 'contentHash'>): string {
  return `${selection.kind}:${selection.id}:${selection.contentHash}`;
}

function groupKey(source: SourceDefinition, hash: string): string {
  return `${source.kind}:${source.id}:${policyIdentity(source.scopePolicy)}:${hash}`;
}

function isIndependentRecord(record: MemoryRecord): boolean {
  return record.independent && record.sources.length === 0;
}

/** Read-only inventory. It never triggers the legacy Agent-location move. */
export async function previewLegacyScopedMemoryMigration(userId: string): Promise<LegacyScopedMemoryPreview> {
  const sources = await collectSources(userId);
  const fingerprints: Record<string, string> = {};
  const previewSources: LegacyScopedMemoryPreviewSource[] = [];
  const grouped = new Map<string, LegacyScopedMemoryPreview['items'][number]>();

  for (const source of sources) {
    const { raw, unavailable } = readSnapshot(source);
    const fingerprint = fingerprintFor(raw, source.scopePolicy);
    fingerprints[source.sourceKey] = fingerprint;
    const summary: LegacyScopedMemoryPreviewSource = {
      sourceKey: source.sourceKey,
      kind: source.kind,
      id: source.id,
      label: source.label,
      status: 'empty',
      eligibleEntries: 0,
      eligibleRecords: 0,
      retainedTemplateRecords: 0,
      retainedAssetRecords: 0,
      retainedNonIndependentRecords: 0,
      retainedOversizedRecords: 0,
      ...(source.runtimeVisibility ? { runtimeVisibility: source.runtimeVisibility } : {}),
    };
    if (unavailable) {
      summary.status = 'unavailable';
      previewSources.push(summary);
      continue;
    }
    const parsed = parseMemoryRecordsContent(raw.toString('utf8'));
    if (parsed.corruptMetadata || parsed.degradedMetadata) {
      summary.status = 'blocked';
      previewSources.push(summary);
      continue;
    }
    for (const record of parsed.records) {
      if (!String(record.text || '').trim()) continue;
      if (record.sources.some((sourceRef) => sourceRef.kind === 'role_template')) {
        summary.retainedTemplateRecords += 1;
        continue;
      }
      if (record.sources.some((sourceRef) => sourceRef.kind === 'cognition_asset')) {
        summary.retainedAssetRecords += 1;
        continue;
      }
      if (!record.independent) {
        summary.retainedNonIndependentRecords += 1;
        continue;
      }
      // Promotion has a 4,000 character ceiling. Keep oversized legacy text
      // visible in the source counts, but do not offer a selection that can
      // only fail after the user confirms it.
      if (record.text.replace(/\s+/g, ' ').trim().length > 4_000) {
        summary.retainedOversizedRecords += 1;
        continue;
      }
      const hash = record.contentSha256 || contentHash(record.text.trim());
      const key = groupKey(source, hash);
      const prior = grouped.get(key);
      if (prior) {
        prior.occurrences += 1;
        if (!prior.sourceKeys.includes(source.sourceKey)) prior.sourceKeys.push(source.sourceKey);
      } else {
        grouped.set(key, {
          kind: source.kind,
          id: source.id,
          contentHash: hash,
          text: record.text.trim(),
          occurrences: 1,
          sourceKeys: [source.sourceKey],
          scopePolicy: source.scopePolicy,
          ...(source.spaceId ? { spaceId: source.spaceId } : {}),
        });
      }
      summary.eligibleRecords += 1;
    }
    summary.eligibleEntries = [...grouped.values()]
      .filter((item) => item.sourceKeys.includes(source.sourceKey)).length;
    summary.status = summary.eligibleRecords > 0 ? 'ready' : 'empty';
    previewSources.push(summary);
  }

  for (const item of grouped.values()) item.sourceKeys.sort();
  return { fingerprints, sources: previewSources, items: [...grouped.values()] };
}

function backupSource(source: SourceSnapshot, backupDir: string): string | null {
  try {
    const filename = `${contentHash(source.sourceKey)}-${path.basename(source.file)}`;
    const backupPath = path.join(backupDir, filename);
    writeTextAtomicSync(backupPath, source.raw);
    if (!fs.readFileSync(backupPath).equals(source.raw)) return null;
    return filename;
  } catch (error) {
    log.warn('scoped memory migration backup failed', { sourceKey: source.sourceKey, error: (error as Error).message });
    return null;
  }
}

/** A per-file backup manifest makes identically named MEMORY.md sources recoverable. */
export async function migrateLegacyScopedMemoryToAssets(
  userId: string,
  input: {
    selectedEntries: LegacyScopedMemorySelection[];
    expectedFingerprints: Record<string, string>;
  },
): Promise<LegacyScopedMemoryMigrationReport> {
  if (!Array.isArray(input.selectedEntries) || input.selectedEntries.length === 0 || input.selectedEntries.length > 500) {
    throw new Error('explicit scoped memory migration selection is required');
  }
  const selections = new Map<string, LegacyScopedMemorySelection>();
  for (const selection of input.selectedEntries) {
    if (!selection || !['agent', 'space', 'project'].includes(selection.kind) || !safeId(selection.id)
      || !CONTENT_HASH.test(selection.contentHash) || !Array.isArray(selection.sourceKeys)
      || selection.sourceKeys.length === 0 || selection.sourceKeys.length > 8
      || selection.sourceKeys.some((key) => typeof key !== 'string' || !SOURCE_KEY.test(key))) {
      throw new Error('invalid scoped memory migration selection');
    }
    selections.set(selectionKey(selection), { ...selection, sourceKeys: [...new Set(selection.sourceKeys)].sort() });
  }
  if (!input.expectedFingerprints || typeof input.expectedFingerprints !== 'object' || Array.isArray(input.expectedFingerprints)) {
    throw new Error('reviewed scoped source fingerprints are required');
  }
  const report: LegacyScopedMemoryMigrationReport = {
    selected: selections.size,
    migrated: 0,
    pendingReview: 0,
    pendingCandidateIds: [],
    failed: 0,
    backupFailed: false,
    corruptFiles: 0,
    readFailedFiles: 0,
    sourceChangedFiles: 0,
    cleanupFailedFiles: 0,
    staleSelections: 0,
  };

  const sources = await collectSources(userId);
  const sourcesByKey = new Map(sources.map((source) => [source.sourceKey, source]));
  const loaded = new Map<string, SourceSnapshot>();
  const selectedGroups = new Map<string, { selection: LegacyScopedMemorySelection; sourceKeys: Set<string> }>();
  for (const [key, selection] of selections) selectedGroups.set(key, { selection, sourceKeys: new Set() });

  for (const [key, group] of selectedGroups) {
    let foundInUnchangedSource = false;
    for (const sourceKey of group.selection.sourceKeys) {
      const source = sourcesByKey.get(sourceKey);
      if (!source || source.kind !== group.selection.kind || source.id !== group.selection.id) {
        report.sourceChangedFiles += 1;
        continue;
      }
      let snapshot = loaded.get(sourceKey);
      if (!snapshot) {
        const read = readSnapshot(source);
        if (read.unavailable) {
          report.readFailedFiles += 1;
          continue;
        }
        const fingerprint = fingerprintFor(read.raw, source.scopePolicy);
        const expected = input.expectedFingerprints[sourceKey];
        if (!CONTENT_HASH.test(String(expected || '')) || fingerprint !== expected) {
          report.sourceChangedFiles += 1;
          continue;
        }
        const parsed = parseMemoryRecordsContent(read.raw.toString('utf8'));
        if (parsed.corruptMetadata || parsed.degradedMetadata) {
          report.corruptFiles += 1;
          continue;
        }
        snapshot = {
          ...source,
          raw: read.raw,
          fingerprint,
          records: parsed.records,
          selectedRecords: new Set<MemoryRecord>(),
          selectedHashes: new Map<string, MemoryRecord[]>(),
        };
        loaded.set(sourceKey, snapshot);
      }
      const matches = snapshot.records.filter((record) => isIndependentRecord(record)
        && (record.contentSha256 || contentHash(record.text.trim())) === group.selection.contentHash);
      if (!matches.length) continue;
      for (const record of matches) {
        snapshot.selectedRecords.add(record);
        snapshot.selectedHashes.set(group.selection.contentHash, [
          ...(snapshot.selectedHashes.get(group.selection.contentHash) || []), record,
        ]);
      }
      group.sourceKeys.add(sourceKey);
      foundInUnchangedSource = true;
    }
    if (!foundInUnchangedSource) report.staleSelections += 1;
  }

  const pendingSources = [...loaded.values()].filter((source) => source.selectedRecords.size > 0);
  if (!pendingSources.length) return report;

  let backupDir: string;
  try {
    const backupRoot = userMemoryDir(userId);
    fs.mkdirSync(backupRoot, { recursive: true });
    backupDir = fs.mkdtempSync(path.join(backupRoot, `scoped-memory-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-`));
    report.backupDir = backupDir;
    const manifest: Array<{ sourceKey: string; sourcePath: string; fingerprint: string; backupFile: string }> = [];
    for (const source of pendingSources) {
      const backup = backupSource(source, backupDir);
      if (!backup) {
        report.backupFailed = true;
        break;
      }
      manifest.push({
        sourceKey: source.sourceKey,
        sourcePath: path.relative(userRoot(userId), source.file).split(path.sep).join('/'),
        fingerprint: source.fingerprint,
        backupFile: backup,
      });
    }
    if (!report.backupFailed) {
      const manifestText = JSON.stringify({ version: 1, createdAt: new Date().toISOString(), sources: manifest }, null, 2);
      const manifestPath = path.join(backupDir, 'manifest.json');
      writeTextAtomicSync(manifestPath, manifestText);
      if (fs.readFileSync(manifestPath, 'utf8') !== manifestText) report.backupFailed = true;
    }
  } catch (error) {
    report.backupFailed = true;
    log.error('scoped memory migration could not create a verified backup', { error: (error as Error).message });
  }
  if (report.backupFailed) {
    report.failed += pendingSources.reduce((total, source) => total + source.selectedRecords.size, 0);
    return report;
  }

  const { ingestLegacyMemoryKnowledge } = await import('./candidate-service');
  const migratedBySource = new Map<string, Set<MemoryRecord>>();
  for (const group of selectedGroups.values()) {
    const sourceSnapshots = [...group.sourceKeys]
      .map((sourceKey) => loaded.get(sourceKey))
      .filter((source): source is SourceSnapshot => Boolean(source));
    if (!sourceSnapshots.length) continue;
    const primary = sourceSnapshots[0];
    const sourceRefs = sourceSnapshots.map((source) => ({
      kind: 'memory' as const,
      id: `legacy-${contentHash(`${source.sourceKey}\0${group.selection.contentHash}`).slice(0, 48)}`,
      title: source.label,
      excerpt: group.selection.contentHash ? primary.records.find((record) =>
        (record.contentSha256 || contentHash(record.text.trim())) === group.selection.contentHash)?.text : undefined,
    }));
    const occurrencePairs = sourceSnapshots.flatMap((source) => (
      source.selectedHashes.get(group.selection.contentHash) || []
    ).map((record) => ({ source, record })));
    try {
      const result = await ingestLegacyMemoryKnowledge(userId, {
        text: primary.selectedHashes.get(group.selection.contentHash)?.[0]?.text || '',
        contentHash: group.selection.contentHash,
        target: {
          kind: group.selection.kind,
          id: group.selection.id,
          ...(primary.spaceId ? { spaceId: primary.spaceId } : {}),
        },
        sourceRefs,
      });
      if (result.mode === 'created' || result.mode === 'merged') {
        for (const { source, record } of occurrencePairs) {
          const records = migratedBySource.get(source.sourceKey) || new Set<MemoryRecord>();
          records.add(record);
          migratedBySource.set(source.sourceKey, records);
        }
        report.migrated += occurrencePairs.length;
      } else {
        report.pendingReview += occurrencePairs.length;
        // A held candidate remains in the old source until it becomes a formal asset.
        if (result.candidateId
          && !report.pendingCandidateIds.includes(result.candidateId)) {
          report.pendingCandidateIds.push(result.candidateId);
        }
      }
    } catch (error) {
      report.failed += occurrencePairs.length;
      log.warn('scoped legacy memory entry did not migrate', {
        kind: group.selection.kind,
        id: group.selection.id,
        error: (error as Error).message,
      });
    }
  }

  for (const source of pendingSources) {
    const migratedRecords = migratedBySource.get(source.sourceKey);
    if (!migratedRecords?.size) continue;
    const currentSources = await collectSources(userId).catch(() => [] as SourceDefinition[]);
    const current = currentSources.find((entry) => entry.sourceKey === source.sourceKey);
    if (!current || policyIdentity(current.scopePolicy) !== policyIdentity(source.scopePolicy)) {
      report.sourceChangedFiles += 1;
      continue;
    }
    const now = readSnapshot(current);
    if (now.unavailable) {
      report.readFailedFiles += 1;
      continue;
    }
    if (!now.raw.equals(source.raw) || fingerprintFor(now.raw, current.scopePolicy) !== source.fingerprint) {
      report.sourceChangedFiles += 1;
      continue;
    }
    try {
      const retained = source.records.filter((record) => !migratedRecords.has(record));
      // Space content folders follow the display name. A rename can change the
      // resolved path while preserving the same bytes and scope; clean the
      // current authoritative path after the equality check above.
      writeTextAtomicSync(current.file, serializeMemoryRecords(retained));
    } catch (error) {
      report.cleanupFailedFiles += 1;
      log.warn('scoped legacy memory cleanup failed', { sourceKey: source.sourceKey, error: (error as Error).message });
    }
  }
  return report;
}
