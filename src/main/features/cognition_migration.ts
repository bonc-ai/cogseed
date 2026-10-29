/** 认知事实主档迁移。完整保留来源记录/槽位/多值/治理态；不按正文合并资产。
 * 版本、引用、采用和审计 JSONL 保持原位置与原 id/version，迁移预检验证其可读。
 * dryRun 零写盘；先备份再原子提交；transition 锁禁止生产写入与切换竞态。
 * mirror 是旧库权威，activate 显式切到统一库。已切换时重跑从权威主档恢复投影，
 * 绝不能拿陈旧的兼容文件反向覆盖主档。
 */
import * as fs from 'node:fs';
import { pendingAssetVersions } from './recall/asset-version-journal';
import * as path from 'node:path';
import { userCognitionDir, userCloudRoot } from '../paths';
import { nowIso, safeId } from '../storage';
import { candidatesMdPath, parseCandidatesMarkdown } from './personal_ontology_candidates';
import { corruptRecordFor } from '../util/corrupt-guard';
import { loadPoDocSync, poDocPath } from './po/store';
import { cognitionCompatibility, withCognitionTransition, MANAGED_COLLECTIONS,
  validateCognitionSources, replaceCognitionSources, recoverCognitionProjection } from './cognition_bridge';
import type { CognitionCompatibilityState } from './cognition_kernel/object-model';

export interface MigrationReport {
  at: string; dryRun: boolean; backupDir?: string;
  mode?: 'mirror' | 'unified';
  projectionPending?: boolean;
  poValues: { total: number; migrated: number; skippedProjection: number; skippedEmpty: number; slotMerged: number; skippedRestricted?: number };
  assets: { total: number; migrated: number; skippedTerminal: number; fingerprintMerged: number; byType: Record<string, number> };
  candidates: { recallMigrated: number; poMigrated: number; skippedTerminal: number };
  differences: { added: number; updated: number; removed: number; unchanged: number };
  errors: string[];
}
function assertRecord(uid: string, id: string, raw: unknown): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid source record: ${id}`);
  const r = raw as Record<string, unknown>;
  if (!safeId(id) || r.id !== id || r.ownerId !== uid || !Number.isInteger(r.schemaVersion)
    || Number(r.schemaVersion) < 1 || Number(r.schemaVersion) > 2) throw new Error(`invalid source identity/schema: ${id}`);
}
function readRecords(uid: string, collection: string): Record<string, Record<string, unknown>> {
  const dir = path.join(userCloudRoot(uid), 'recall', 'records', collection);
  if (!fs.existsSync(dir)) return {};
  const result: Record<string, Record<string, unknown>> = Object.create(null);
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const r: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    assertRecord(uid, id, r);
    if (collection === 'ability-assets' && (typeof r.statement !== 'string' || typeof r.title !== 'string'
      || !Array.isArray(r.evidenceRefs) || typeof r.scope !== 'string')) throw new Error(`invalid asset content: ${id}`);
    result[id] = r;
  }
  return result;
}
function validateVersionStreams(uid: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  const dir = path.join(userCloudRoot(uid), 'recall', 'jsonl', 'ability-asset-versions');
  if (!fs.existsSync(dir)) return versions;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!text) continue;
    const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      const r: unknown = JSON.parse(line);
      assertRecord(uid, String((r as Record<string, unknown>).id), r);
      if (r.assetId !== name.slice(0, -6) || !/^\d+$/.test(String(r.version)) || !r.snapshot
        || typeof r.snapshot !== 'object' || Array.isArray(r.snapshot)) throw new Error(`invalid version stream: ${name}`);
      const id = String(r.assetId);
      const seen = versions.get(id) ?? new Set<string>();
      if (seen.has(String(r.version))) throw new Error(`duplicate version snapshot: ${id}`);
      seen.add(String(r.version)); versions.set(id, seen);
    }
  }
  return versions;
}
function countDifferences(old: CognitionCompatibilityState | undefined, next: CognitionCompatibilityState, report: MigrationReport): void {
  for (const collection of MANAGED_COLLECTIONS) {
    const before = old?.records[collection] ?? {}; const after = next.records[collection];
    for (const [id, r] of Object.entries(after)) {
      if (!Object.hasOwn(before, id)) report.differences.added++;
      else if (JSON.stringify(before[id]) === JSON.stringify(r)) report.differences.unchanged++;
      else report.differences.updated++;
    }
    for (const id of Object.keys(before)) if (!Object.hasOwn(after, id)) report.differences.removed++;
  }
  if (JSON.stringify(old?.po) !== JSON.stringify(next.po)) report.differences.updated++;
  if (JSON.stringify(old?.ontologyCandidates) !== JSON.stringify(next.ontologyCandidates)) report.differences.updated++;
}
function backup(uid: string, stamp: string): string {
  const dir = path.join(userCloudRoot(uid), `cognition-migration-backup-${stamp.replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const uniqueDir = fs.mkdtempSync(dir + '-');
  for (const domain of ['cognition', 'recall']) {
    const source = path.join(userCloudRoot(uid), domain);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(uniqueDir, domain), { recursive: true });
  }
  const candidateSource = path.dirname(candidatesMdPath(uid));
  if (fs.existsSync(candidateSource)) fs.cpSync(candidateSource, path.join(uniqueDir, 'ontology-candidates-local'), { recursive: true });
  return uniqueDir;
}
export async function migrateLegacyCognition(uid: string, options: { dryRun?: boolean; activate?: boolean } = {}): Promise<MigrationReport> {
  const report: MigrationReport = {
    at: nowIso(), dryRun: options.dryRun === true,
    poValues: { total: 0, migrated: 0, skippedProjection: 0, skippedEmpty: 0, slotMerged: 0, skippedRestricted: 0 },
    assets: { total: 0, migrated: 0, skippedTerminal: 0, fingerprintMerged: 0, byType: {} },
    candidates: { recallMigrated: 0, poMigrated: 0, skippedTerminal: 0 },
    differences: { added: 0, updated: 0, removed: 0, unchanged: 0 }, errors: [],
  };
  if (!safeId(uid)) { report.errors.push('invalid uid'); return report; }
  try {
    await withCognitionTransition(uid, async () => {
      const old = cognitionCompatibility(uid);
      report.mode = old?.mode ?? 'mirror';
      if (old?.mode === 'unified') {
        report.mode = 'unified';
        report.assets.total = Object.keys(old.records['ability-assets']).length;
        report.candidates.recallMigrated = Object.keys(old.records.candidates).length;
        report.candidates.poMigrated = old.ontologyCandidates?.length ?? 0;
        const groups = old.po?.groups;
        report.poValues.total = Array.isArray(groups)
          ? groups.reduce((n, g) => n + (Array.isArray(g?.values) ? g.values.length : 0), 0) : 0;
        report.projectionPending = report.dryRun ? old.pendingProjection : !await recoverCognitionProjection(uid, true);
        return;
      }
      const po = loadPoDocSync(uid);
      if (corruptRecordFor(poDocPath(uid))) throw new Error('ontology source corrupt; migration refused');
      const records: CognitionCompatibilityState['records'] = {};
      for (const collection of MANAGED_COLLECTIONS) records[collection] = readRecords(uid, collection);
      const versions = validateVersionStreams(uid);
      for (const a of Object.values(records['ability-assets'])) {
        const active = String(a.activeVersion ?? a.version);
        if (a.status !== 'purged' && active !== '1' && !versions.get(String(a.id))?.has(active) && !pendingAssetVersions(a as never).some(row => row.version === active)) {
          throw new Error(`active version snapshot missing: ${String(a.id)}`);
        }
        report.assets.total++; report.assets.migrated++;
        const type = String(a.type); report.assets.byType[type] = (report.assets.byType[type] ?? 0) + 1;
      }
      report.candidates.recallMigrated = Object.keys(records.candidates).length;
      for (const g of po.groups) for (const v of g.values) {
        report.poValues.total++;
        if (v.assetId) report.poValues.skippedProjection++; else report.poValues.migrated++;
      }
      const candidatePath = candidatesMdPath(uid);
      if (!fs.existsSync(candidatePath) && fs.existsSync(path.join(path.dirname(candidatePath), 'candidates.json'))) {
        throw new Error('legacy ontology candidate JSON requires original migration before authority switch');
      }
      const ontologyCandidates = fs.existsSync(candidatePath) ? parseCandidatesMarkdown(fs.readFileSync(candidatePath, 'utf8')) : [];
      if (corruptRecordFor(candidatePath)) throw new Error('ontology candidate source corrupt; migration refused');
      report.candidates.poMigrated = ontologyCandidates.length;
      const rawPo = fs.existsSync(poDocPath(uid)) ? JSON.parse(fs.readFileSync(poDocPath(uid), 'utf8')) : po;
      const next: CognitionCompatibilityState = { mode: options.activate ? 'unified' : 'mirror',
        revision: (old?.revision ?? 0) + 1, records, po: rawPo as Record<string, unknown>, ontologyCandidates: ontologyCandidates as unknown as Record<string, unknown>[],
        pendingProjection: options.activate === true, migratedAt: old?.migratedAt ?? report.at };
      validateCognitionSources(uid, next);
      countDifferences(old, next, report);

      if (report.dryRun || (old && old.mode === next.mode && report.differences.added + report.differences.updated + report.differences.removed === 0)) return;
      report.backupDir = backup(uid, report.at);
      await replaceCognitionSources(uid, next);
      report.mode = next.mode;
      if (next.mode === 'unified') report.projectionPending = !await recoverCognitionProjection(uid, true);
    });
  } catch (error) { report.errors.push(error instanceof Error ? error.message : String(error)); }
  return report;
}
