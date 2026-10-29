/**
 * 后台巡检：发现资产重复、过时与冲突，生成待处理建议。
 *
 * **只报不改**：巡检定期扫一遍资产库，发现重复 /
 * 过时 / 冲突，**只产出待办与建议（Change Candidate）**，不修改任何资产：不改
 * 状态、不改正文、不合并、不打标。用户看到的是一条条可以自己去处理的待办。
 *
 * 结果约束：
 *   ① 发现类别为 duplicate / outdated / conflict，呈现走既有 inbox 通道。
 *   ② **跨轮不重复报**：发现带稳定去重键（同一条问题在两轮里是同一个 key），
 *      待办 id 由 key 派生；用户处置过（"不管它"）的 key 持久记在设置里，
 *      以后各轮不再报。
 *
 * 调度经 `util/boot_init.ts` 注册（不用裸启动定时器），开关经设置项承载。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import { readRecallJsonRecord, updateRecallJsonRecord, writeRecallJsonRecord } from './store';
import { clearedReportRow, type ReportContentOwnership } from './report-content-lifecycle';
import type { RecallJsonRecord } from './types';
import { loadCaptureExistingAssetPool } from './capture-existing-assets';
import { listAbilityAssets } from './asset-service';
import { fileEditLock } from '../../util/locks';
import { withCognitionTransition } from '../cognition_bridge';
import { nearDuplicateScore } from './cleanup-report-service';
import type { RecallAbilityAssetRecord } from './candidate-service';
import { maskId } from '../../util/log-redact';

const log = createLogger('recall.asset-inspection');

const SETTINGS_COLLECTION = 'inspection-settings';
const SETTINGS_ID = 'settings';
const RUNS_COLLECTION = 'inspection-runs';
const PROGRESS_COLLECTION = 'inspection-progress';
const PROGRESS_ID = 'coverage';

export type InspectionTrigger = 'scheduled' | 'manual' | 'nightly';
/** 巡检发现类别：重复、过时、冲突。 */
export type InspectionFindingCategory = 'duplicate' | 'outdated' | 'conflict';

export interface InspectionFinding extends ReportContentOwnership {
  /** 稳定去重键：同一条问题在两轮巡检里是同一个 key（待办 id 由它派生）。 */
  key: string;
  category: InspectionFindingCategory;
  assetIds: string[];
  title: string;
  detail: string;
  /** Semantic findings remain review items until a person resolves them. */
  method?: 'semantic';
  assetVersions?: Record<string, string>;
}

export interface InspectionRun extends RecallJsonRecord {
  id: string;
  trigger: InspectionTrigger;
  scope: { statuses: string[] };
  findings: InspectionFinding[];
  scanned: number;
  /** Coverage of all active heads; unavailable content is counted without its body. */
  coverage?: { total: number; evaluated: number; remaining: number; unavailable?: number };
  /** Keys observed in this batch; findings also retain earlier unresolved results. */
  currentFindingKeys?: string[];
  /** Readable assets checked in this pass, including prior batches. */
  coveredAssetIds?: string[];
  /** Identity-only coverage for work that remains or cannot be read. */
  pendingAssetIds?: string[];
  unavailableAssetIds?: string[];
  /** Assets actually inspected this run. Missing on legacy runs. */
  evaluatedAssetIds?: string[];
  /** Assets skipped because the nightly discovery already changed them. */
  skippedAssetIds?: string[];
  startedAt: string;
  finishedAt?: string;
  /** 本轮是被中止的（关闭开关 / 应用退出）；自然跑完为空。 */
  stoppedBy?: string;
}

export interface InspectionSettings extends RecallJsonRecord {
  id: typeof SETTINGS_ID;
  enabled: boolean;
  /** 用户已处置（"不管它"）的发现键：跨轮生效，同一问题不再反复打扰。 */
  dismissedFindingKeys: string[];
  /** "回头再看"的发现键：仍然报（没让用户失去线索），只是界面标一下状态。 */
  deferredFindingKeys: string[];
  updatedAt: string;
}

// 默认关闭；用户开启后以保存的 settings 记录为准。
const DEFAULT_SETTINGS = Object.freeze({ enabled: false });

/** 「过时」判据：在用资产多久没被碰过算过时。 */
export const INSPECTION_OUTDATED_DAYS = 180;
/** 疑似重复阈值（与整理报告同一套字面重叠判据）。 */
const DUPLICATE_SCORE_THRESHOLD = 0.8;
/** One batch compares each selected target with the whole readable pool. */
const INSPECTION_BATCH_SIZE = 100;

function runsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, RUNS_COLLECTION, 'placeholder'));
}

function asRun(value: RecallJsonRecord): InspectionRun {
  if (
    typeof value.trigger !== 'string' || !Array.isArray(value.findings)
    || typeof value.startedAt !== 'string'
  ) throw new Error('malformed asset inspection run');
  return { ...value, scanned: Number(value.scanned) || 0 } as InspectionRun;
}

export async function readInspectionSettings(userId: string): Promise<InspectionSettings> {
  const raw = await readRecallJsonRecord(userId, SETTINGS_COLLECTION, SETTINGS_ID);
  if (!raw) {
    return {
      schemaVersion: 1,
      ownerId: userId,
      id: SETTINGS_ID,
      enabled: DEFAULT_SETTINGS.enabled,
      dismissedFindingKeys: [],
      deferredFindingKeys: [],
      updatedAt: new Date().toISOString(),
    };
  }
  const keysOf = (value: unknown): string[] => (Array.isArray(value)
    ? (value as string[]).filter((key) => typeof key === 'string')
    : []);
  return {
    ...raw,
    // 缺少 enabled 字段视为关闭，避免缺省配置触发后台巡检。
    enabled: raw.enabled === true,
    dismissedFindingKeys: keysOf(raw.dismissedFindingKeys),
    deferredFindingKeys: keysOf(raw.deferredFindingKeys),
  } as InspectionSettings;
}

/** 开关：关掉之后不再自动运行；手动触发仍可用（那是用户自己要的）。 */
export async function setInspectionEnabled(userId: string, enabled: boolean): Promise<InspectionSettings> {
  // 原子 patch：只改 enabled/updatedAt 两键，其余（含处置数组）从锁内最新 raw
  // 保留。先前「预读快照 + writeRecallJsonRecord 整写」会在开关切换与待办处置
  // 并发时把 dismissed/deferred 整组覆盖掉，下轮巡检重复打扰。
  const fallback = await readInspectionSettings(userId);
  const updated = await updateRecallJsonRecord(userId, SETTINGS_COLLECTION, SETTINGS_ID, (raw) => ({
    ...(raw || fallback),
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString(),
  }));
  return updated as InspectionSettings;
}

/**
 * 用户处置一条发现：`dismissed`（不管它，跨轮不再报）/ `deferred`（回头再看，
 * 仍然报、只是标个状态）。**两种处置都不改资产**——处置的是"要不要继续提醒"，
 * 不是"这条资产怎么办"（那是用户自己去资产详情做的事）。
 */
export async function decideInspectionFinding(
  userId: string,
  findingKey: string,
  decision: 'dismissed' | 'deferred',
): Promise<InspectionSettings> {
  // 入口 throw 与 readInspectionRun 同款：非法入参宁可炸出来。否则拼错的
  // decision（如 'dismiss'）会让下面双三元双双走反向 filter——已处置的 key
  // 从两数组同时移除、待办静默复活；超长 key 则原样落盘。
  if (decision !== 'dismissed' && decision !== 'deferred') {
    throw new Error(`invalid inspection decision: ${decision}`);
  }
  // 宽松长度门而非形状正则：真实 key 是 `${category}:${assetId}+…`（含 : 与
  // +，safeId 不可用），几十字符；1024 远超真实长度、远低于已实证的 10,000
  // 字符滥用面。
  if (typeof findingKey !== 'string' || !findingKey.length || findingKey.length > 1024) {
    throw new Error('invalid inspection finding key');
  }
  // 读-算-写整段留在 updateRecallJsonRecord 的锁内（fileEditLock 按 recordPath
  // 串行）：处置数组从锁内最新 raw 增量而来。先前锁外预读再整组覆盖会让两个
  // 并发处置互相抹掉——已「不管它」的待办复活回清单。
  const updated = await updateRecallJsonRecord(userId, SETTINGS_COLLECTION, SETTINGS_ID, (raw) => {
    const base: RecallJsonRecord = raw || {
      schemaVersion: 1,
      ownerId: userId,
      id: SETTINGS_ID,
      enabled: DEFAULT_SETTINGS.enabled,
    };
    // 与 readInspectionSettings 同款容错归一：磁盘上的数组可能缺字段/混入非字符串。
    const keysOf = (value: unknown): string[] => (Array.isArray(value)
      ? (value as string[]).filter((key) => typeof key === 'string')
      : []);
    return {
      ...base,
      dismissedFindingKeys: decision === 'dismissed'
        ? [...new Set([...keysOf(base.dismissedFindingKeys), findingKey])].slice(-500)
        : keysOf(base.dismissedFindingKeys).filter((key) => key !== findingKey),
      deferredFindingKeys: decision === 'deferred'
        ? [...new Set([...keysOf(base.deferredFindingKeys), findingKey])].slice(-500)
        : keysOf(base.deferredFindingKeys).filter((key) => key !== findingKey),
      updatedAt: new Date().toISOString(),
    };
  });
  return updated as InspectionSettings;
}

export async function readInspectionRun(userId: string, runId: string): Promise<InspectionRun | undefined> {
  if (!safeId(runId)) throw new Error('invalid asset inspection run id');
  const raw = await readRecallJsonRecord(userId, RUNS_COLLECTION, runId);
  return raw ? asRun(raw) : undefined;
}

async function readAllInspectionRuns(userId: string): Promise<InspectionRun[]> {
  let names: string[];
  try {
    names = await fs.readdir(runsDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => readRecallJsonRecord(userId, RUNS_COLLECTION, name.slice(0, -5))));
  return records
    .filter((raw): raw is RecallJsonRecord => Boolean(raw))
    .flatMap((raw) => {
      try { return [asRun(raw)]; } catch { return []; }
    })
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export async function listInspectionRuns(userId: string, limit = 20): Promise<InspectionRun[]> {
  return (await readAllInspectionRuns(userId)).slice(0, Math.max(1, Math.min(100, limit)));
}

function findingKey(category: InspectionFindingCategory, assetIds: readonly string[]): string {
  return `${category}:${[...assetIds].sort().join('+')}`;
}

/** 一轮巡检的发现。**纯读**：只看、不算账、不改任何东西。 */
export function collectInspectionFindings(
  assets: readonly RecallAbilityAssetRecord[],
  now: Date = new Date(),
  targetIds?: ReadonlySet<string>,
): InspectionFinding[] {
  const findings: InspectionFinding[] = [];
  const active = assets.filter((asset) => asset.status === 'active');

  // 过时：在用但很久没被碰过（内容没变过、也没被用过）。
  const staleBefore = now.getTime() - INSPECTION_OUTDATED_DAYS * 86_400_000;
  for (const asset of active) {
    if (targetIds && !targetIds.has(asset.id)) continue;
    const touched = Date.parse(String(asset.updatedAt || ''));
    if (Number.isNaN(touched) || touched >= staleBefore) continue;
    findings.push({
      key: findingKey('outdated', [asset.id]),
      category: 'outdated',
      assetIds: [asset.id],
      // 巡检记录是持久台账，只落 id 引用，不落资产标题。
      title: asset.id,
      detail: `超过 ${INSPECTION_OUTDATED_DAYS} 天没有更新过（最后更新 ${String(asset.updatedAt).slice(0, 10)}），建议复核是否仍适用。`,
    });
  }

  // 冲突：同一句话被归到了两个不同的资产类型——同一条主张不该有两个身份。
  const byStatement = new Map<string, RecallAbilityAssetRecord[]>();
  for (const asset of active) {
    const key = String(asset.statement || '').replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const group = byStatement.get(key) || [];
    group.push(asset);
    byStatement.set(key, group);
  }
  for (const group of byStatement.values()) {
    const types = new Set(group.map((asset) => String(asset.type)));
    if (types.size < 2 || (targetIds && !group.some(asset => targetIds.has(asset.id)))) continue;
    findings.push({
      key: findingKey('conflict', group.map((asset) => asset.id)),
      category: 'conflict',
      assetIds: group.map((asset) => asset.id),
      // 同上，只落 id 引用。
      title: group.map((asset) => asset.id).join('+'),
      detail: `同一句正文被归成了 ${[...types].sort().join(' / ')} 不同类型；请结合时间、适用场景和例外核对，不能据此认定内容矛盾。`,
    });
  }

  // 疑似重复：同类型、正文不同但字面高度重叠。**只报不并**。
  const targets = targetIds ? active.filter(asset => targetIds.has(asset.id)) : active;
  const seenPairs = new Set<string>();
  for (const left of targets) {
    for (const right of active) {
      if (left.id === right.id || left.type !== right.type) continue;
      const key = findingKey('duplicate', [left.id, right.id]);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const score = nearDuplicateScore(left.statement, right.statement);
      if (score < DUPLICATE_SCORE_THRESHOLD) continue;
      findings.push({
        key, category: 'duplicate', assetIds: [left.id, right.id],
        title: `${left.id}+${right.id}`,
        detail: `这两条看字面很像（${Math.round(score * 100)}%）；请结合时间、适用场景和例外核对，是否合并由你决定。`,
      });
    }
  }

  return findings;
}

export interface RunInspectionOptions {
  trigger?: InspectionTrigger;
  now?: Date;
  signal?: AbortSignal;
  /** Targets already changed by this nightly run. They are not re-inspected,
   * so a related duplicate/conflict is left to the next run. */
  excludeAssetIds?: ReadonlySet<string>;
  /** Bound one run to this many targets; each target sees the full pool. */
  batchSize?: number;
}

/**
 * 跑一轮巡检并留下运行记录。**不修改任何资产**——发现只进记录，呈现走 inbox。
 * 已被用户处置（不管它）的发现不再进记录，所以连续两轮不会产生重复待办。
 */
export async function runAssetInspection(
  userId: string,
  options: RunInspectionOptions = {},
): Promise<InspectionRun> {
  const batchSize = options.batchSize ?? INSPECTION_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > INSPECTION_BATCH_SIZE) {
    throw new Error('invalid inspection batch size');
  }
  // The progress lock is separate from the record's write lock. It serializes
  // manual and scheduled inspections without holding the cognition write lock
  // while the pool is loaded or compared.
  return fileEditLock(`${recallJsonRecordPath(userId, PROGRESS_COLLECTION, PROGRESS_ID)}.run`)
    .runExclusive(async () => {
      const startedAt = new Date().toISOString();
      const settings = await readInspectionSettings(userId);
      const dismissed = new Set(settings.dismissedFindingKeys);
      const activeHeads = (await listAbilityAssets(userId)).filter(asset => asset.ownerId === userId && asset.status === 'active');
      const headsBaseline = (heads: readonly RecallAbilityAssetRecord[]) => JSON.stringify(heads
        .map(asset => [asset.id, asset.version, asset.activeVersion || asset.version, asset.updatedAt])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
      const initialHeads = headsBaseline(activeHeads);
      const pool = await loadCaptureExistingAssetPool(userId);
      const allAssets = pool.entries.map(({ record, snapshot }) => ({
        ...record, ...snapshot, version: record.version, activeVersion: snapshot.version,
      } as RecallAbilityAssetRecord)).sort((left, right) => left.id.localeCompare(right.id));
      const excluded = options.excludeAssetIds ? new Set(options.excludeAssetIds) : new Set<string>();
      const assets = allAssets.filter(asset => !excluded.has(asset.id));
      const readable = new Set(allAssets.map(asset => asset.id));
      const available = new Set(assets.map(asset => asset.id));
      const marker = (asset: RecallAbilityAssetRecord) => JSON.stringify([
        asset.version, asset.activeVersion || asset.version, asset.updatedAt,
      ]);
      const previous = await readRecallJsonRecord(userId, PROGRESS_COLLECTION, PROGRESS_ID);
      const saved = previous?.covered && typeof previous.covered === 'object' && !Array.isArray(previous.covered)
        ? previous.covered as Record<string, string> : {};
      let covered: Record<string, string> = Object.fromEntries(allAssets.flatMap(asset =>
        !excluded.has(asset.id) && saved[asset.id] === marker(asset) ? [[asset.id, saved[asset.id]]] : []));
      // A completed pass starts a new one on the next run, so aging assets are
      // revisited. A changed asset in an unfinished pass is naturally requeued.
      if (previous?.complete === true && allAssets.every(asset => covered[asset.id] === marker(asset))) covered = {};
      const pending = assets.filter(asset => covered[asset.id] !== marker(asset));
      const selected = pending.slice(0, batchSize);
      const evaluated: RecallAbilityAssetRecord[] = [];
      const current = new Map<string, InspectionFinding>();
      for (const asset of selected) {
        if (options.signal?.aborted) break;
        // Yield so a stop request can interrupt a long batch between targets.
        if (evaluated.length && evaluated.length % 10 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        if (options.signal?.aborted) break;
        for (const finding of collectInspectionFindings(assets, options.now, new Set([asset.id]))) {
          if (!dismissed.has(finding.key)) current.set(finding.key, finding);
        }
        evaluated.push(asset);
        covered[asset.id] = marker(asset);
      }
      const evaluatedIds = new Set(evaluated.map(asset => asset.id));
      // Bootstrap older installations once. The progress record subsequently
      // owns the complete unresolved set, independent of run-history limits.
      const earlier: InspectionFinding[] = Array.isArray(previous?.findings)
        ? previous.findings as InspectionFinding[]
        : pendingInspectionFindings(await readAllInspectionRuns(userId), settings.dismissedFindingKeys)
          .map(({ runId: _runId, deferred: _deferred, ...finding }) => finding);
      const retained = new Map<string, InspectionFinding>();
      for (const finding of earlier) {
        if (dismissed.has(finding.key)) continue;
        // A lexical comparison cannot settle a model's semantic review finding.
        if (finding.method === 'semantic') { retained.set(finding.key, finding); continue; }
        // A pair was actually compared when at least one member was a target
        // and every member was in the comparison pool. Skipped members are not
        // evidence that an older finding has disappeared.
        const reviewed = finding.assetIds.some(id => evaluatedIds.has(id))
          && finding.assetIds.every(id => available.has(id));
        if (!reviewed) retained.set(finding.key, finding);
      }
      for (const [key, finding] of current) retained.set(key, finding);
      // Keep findings that temporarily cannot be read, but do not expose them
      // until every referenced asset is readable again.
      const storedFindings = [...retained.values()];
      const findings = storedFindings.filter(finding => finding.assetIds.every(id => readable.has(id)))
        .map(finding => finding.method === 'semantic' && finding.assetVersions && finding.assetIds.some(id => {
          const asset = allAssets.find(row => row.id === id);
          return !asset || String(asset.activeVersion || asset.version) !== finding.assetVersions![id];
        }) ? { ...finding, detail: `${finding.detail} 相关内容已变化，请重新核对。` } : finding);
      const coveredAssetIds = allAssets.filter(asset => covered[asset.id] === marker(asset)).map(asset => asset.id);
      const evaluatedCount = coveredAssetIds.length;
      // Count restricted and unavailable heads without retaining their bodies.
      const allIds = [...new Set([...activeHeads.map(asset => asset.id), ...allAssets.map(asset => asset.id)])].sort();
      const unavailableAssetIds = allIds.filter(id => !readable.has(id));
      const pendingAssetIds = allIds.filter(id => {
        const asset = allAssets.find(row => row.id === id);
        return !asset || covered[id] !== marker(asset);
      });
      const total = allIds.length;
      const unavailable = unavailableAssetIds.length;
      const coverage = { total, evaluated: evaluatedCount, remaining: total - evaluatedCount,
        ...(unavailable ? { unavailable } : {}) };

      const runId = `ir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const run: InspectionRun = {
        schemaVersion: 1, ownerId: userId, id: runId, trigger: options.trigger || 'manual',
        scope: { statuses: ['active'] }, findings, scanned: evaluated.length,
        evaluatedAssetIds: evaluated.map(asset => asset.id), coveredAssetIds, pendingAssetIds, unavailableAssetIds, coverage,
        currentFindingKeys: [...new Set([...current.keys(), ...((previous?.unreportedSemanticKeys || []) as string[])])].filter(key => findings.some(finding => finding.key === key)),
        ...(excluded.size ? { skippedAssetIds: [...excluded] } : {}),
        startedAt, finishedAt: new Date().toISOString(),
        ...(options.signal?.aborted ? { stoppedBy: 'abort' } : {}),
      };
      // Save the run before advancing progress: a crash can repeat a batch but
      // cannot mark an unwritten result as inspected.
      await withCognitionTransition(userId, async () => {
        // Re-read only the comparison baseline under the write transition. It
        // performs no ranking, embeddings or model calls. A changed pool must
        // be retried; neither its findings nor coverage can be settled.
        const latestHeads = (await listAbilityAssets(userId)).filter(asset => asset.ownerId === userId && asset.status === 'active');
        const latestPool = await loadCaptureExistingAssetPool(userId);
        if (headsBaseline(latestHeads) !== initialHeads || latestPool.baselineDigest !== pool.baselineDigest)
          throw Object.assign(new Error('inspection assets changed; retry the inspection'), { code: 'inspection_baseline_stale' });
        await writeRecallJsonRecord(userId, RUNS_COLLECTION, runId, run);
        const ids = [...new Set(storedFindings.flatMap(finding => finding.assetIds))];
        const purged = new Set((await Promise.all(ids.map(async id => {
          const asset = await readRecallJsonRecord(userId, 'ability-assets', id);
          return asset?.status === 'purged' ? id : undefined;
        }))).filter((id): id is string => Boolean(id)));
        const safeFindings = storedFindings.filter(finding => !finding.assetIds.some(id => purged.has(id)));
        await writeRecallJsonRecord(userId, PROGRESS_COLLECTION, PROGRESS_ID, {
          schemaVersion: 1, ownerId: userId, id: PROGRESS_ID, covered, findings: safeFindings, unreportedSemanticKeys: [],
          complete: allAssets.every(asset => covered[asset.id] === marker(asset)) && !options.signal?.aborted,
        });
      });
      if (current.size) log.info('asset inspection found issues', {
        userId: maskId(userId), runId, duplicate: [...current.values()].filter(f => f.category === 'duplicate').length,
        outdated: [...current.values()].filter(f => f.category === 'outdated').length,
        conflict: [...current.values()].filter(f => f.category === 'conflict').length,
      });
      return run;
    });
}

/** Record source-checked model observations as review-only findings. The caller
 * supplies a read-only baseline check; no model executes under either lock. */
export async function recordSemanticInspectionFindings(
  userId: string,
  primaryId: string,
  comparisonIds: readonly string[],
  observations: ReadonlyArray<{ assetVersions: Record<string, string> }>,
  assertBaseline: () => Promise<void>,
): Promise<void> {
  await fileEditLock(`${recallJsonRecordPath(userId, PROGRESS_COLLECTION, PROGRESS_ID)}.run`).runExclusive(async () => {
    await withCognitionTransition(userId, async () => {
      const settings = await readInspectionSettings(userId);
      const dismissed = new Set(settings.dismissedFindingKeys);
      const previous = await readRecallJsonRecord(userId, PROGRESS_COLLECTION, PROGRESS_ID);
      if (!previous && !observations.length) return;
      const earlier: InspectionFinding[] = Array.isArray(previous?.findings) ? previous.findings as InspectionFinding[]
        : pendingInspectionFindings(await readAllInspectionRuns(userId), settings.dismissedFindingKeys)
          .map(({ runId: _runId, deferred: _deferred, ...finding }) => finding);
      const findings = new Map<string, InspectionFinding>(earlier.map(finding => [finding.key, finding]));
      const current = new Set((previous?.unreportedSemanticKeys || []) as string[]);
      const compared = new Set(comparisonIds);
      const reported = new Set(observations.map(observation => `conflict:semantic:${Object.keys(observation.assetVersions).sort().join('+')}`));
      let changed = false;
      for (const [key, finding] of findings) {
        // A completed comparison can resolve an earlier issue only if both
        // assets were supplied. Conflicting observations in this sweep stay
        // pending until they can be reviewed together on a later pass.
        if (finding.method === 'semantic' && finding.assetIds.includes(primaryId)
          && finding.assetIds.every(id => compared.has(id)) && !current.has(key) && !reported.has(key)) { findings.delete(key); changed = true; }
      }
      for (const observation of observations) {
        const assetIds = Object.keys(observation.assetVersions).sort();
        if (assetIds.length !== 2 || assetIds.some(id => !safeId(id)))
          throw new Error('invalid semantic inspection observation');
        const key = `conflict:semantic:${assetIds.join('+')}`;
        if (dismissed.has(key)) continue;
        findings.set(key, { key, category: 'conflict', assetIds, title: assetIds.join('+'),
          detail: '相关内容的结论或适用范围可能不同，请结合时间、场景和例外核对。',
          method: 'semantic', assetVersions: { ...observation.assetVersions } });
        current.add(key); changed = true;
      }
      if (!changed) return;
      await assertBaseline();
      await writeRecallJsonRecord(userId, PROGRESS_COLLECTION, PROGRESS_ID, {
        ...(previous || { schemaVersion: 1, ownerId: userId, id: PROGRESS_ID, covered: {}, complete: false }),
        findings: [...findings.values()], unreportedSemanticKeys: [...current],
      });
    });
  });
}

/** Findings the user explicitly dismissed. Kept for the "processed" history
 * without re-opening them in the attention list. */
export function dismissedInspectionFindings(
  runs: readonly InspectionRun[],
  dismissedKeys: readonly string[],
): Array<{ key: string; category: InspectionFindingCategory; assetIds: string[]; title: string; detail: string; at: string }> {
  const dismissed = new Set(dismissedKeys);
  const seen = new Set<string>();
  const items: Array<{ key: string; category: InspectionFindingCategory; assetIds: string[]; title: string; detail: string; at: string }> = [];
  for (const run of runs) {
    for (const finding of run.findings) {
      if (!dismissed.has(finding.key) || seen.has(finding.key)) continue;
      seen.add(finding.key);
      items.push({
        key: finding.key,
        category: finding.category,
        assetIds: [...finding.assetIds],
        title: finding.title,
        detail: finding.detail,
        at: run.finishedAt || run.startedAt,
      });
    }
  }
  return items;
}

/** purge 级联清理段：存量巡检运行记录里引用被清除资产的发现，
 *  标题清成不可识别形式（新发现只落 id，本函数收存量尾巴）。无命中不写盘
 *  （幂等，可随级联重入重试）。 */
export async function sweepPurgedAssetFromInspectionRuns(userId: string, assetId: string): Promise<number> {
  const progress = await readRecallJsonRecord(userId, PROGRESS_COLLECTION, PROGRESS_ID);
  if (progress && (Array.isArray(progress.findings) || progress.covered)) {
    await updateRecallJsonRecord(userId, PROGRESS_COLLECTION, PROGRESS_ID, locked => {
      if (!locked) throw new Error('inspection progress not found');
      const covered = { ...((locked.covered || {}) as Record<string, string>) };
      delete covered[assetId];
      const findings = ((locked.findings || []) as InspectionFinding[]).filter(finding => !finding.assetIds.includes(assetId));
      const unreportedSemanticKeys = ((locked.unreportedSemanticKeys || []) as string[])
        .filter(key => findings.some(finding => finding.key === key));
      return { ...locked, covered, findings, unreportedSemanticKeys };
    });
  }
  const needsSweep = (findings: InspectionFinding[]): boolean => findings
    .some((finding) => finding.assetIds.includes(assetId) && !finding.contentPurgedAt);
  let names: string[];
  try {
    names = await fs.readdir(runsDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let swept = 0;
  for (const name of names) {
    if (!name.endsWith('.json') || !safeId(name.slice(0, -5))) continue;
    const runId = name.slice(0, -5);
    // 预读只为「无命中不写盘」；改写以锁内最新 raw 为准。
    const raw = await readRecallJsonRecord(userId, RUNS_COLLECTION, runId);
    if (!raw || !needsSweep(asRun(raw).findings)) continue;
    await updateRecallJsonRecord(userId, RUNS_COLLECTION, runId, (locked) => {
      if (!locked) throw new Error('asset inspection run not found');
      const run = asRun(locked);
      if (!needsSweep(run.findings)) return locked;
      const findings = run.findings.map((finding) => finding.assetIds.includes(assetId)
        ? clearedReportRow('findings', finding, finding.contentPurgedAt || new Date().toISOString()) as InspectionFinding
        : finding);
      return { ...run, findings } as unknown as RecallJsonRecord;
    });
    swept += 1;
  }
  return swept;
}

/** 最新一轮的发现（未处置的）→ 待确认清单条目（`id` 前缀 `inspection:`）。 */
export function pendingInspectionFindings(
  runs: readonly InspectionRun[],
  dismissedKeys: readonly string[] = [],
  deferredKeys: readonly string[] = [],
): Array<{ runId: string; key: string; category: InspectionFindingCategory; assetIds: string[]; title: string; detail: string; deferred?: boolean }> {
  const latest = runs[0];
  if (!latest) return [];
  const dismissed = new Set(dismissedKeys);
  const deferred = new Set(deferredKeys);
  const seen = new Set<string>();
  const items: Array<{ runId: string; key: string; category: InspectionFindingCategory; assetIds: string[]; title: string; detail: string; deferred?: boolean }> = [];
  const push = (run: InspectionRun, finding: InspectionFinding): void => {
    if (dismissed.has(finding.key) || seen.has(finding.key)) return;
    seen.add(finding.key);
    items.push({
      runId: run.id,
      key: finding.key,
      category: finding.category,
      assetIds: [...finding.assetIds],
      title: finding.title,
      detail: finding.detail,
      ...(deferred.has(finding.key) ? { deferred: true } : {}),
    });
  };
  for (const finding of latest.findings) push(latest, finding);
  // New runs already carry the complete unresolved set across batches.
  if (latest.coverage) return items;
  // Keep an older finding until its assets are actually re-inspected. A nightly
  // run that skipped a claimed asset has not proved the duplicate/conflict gone.
  const evaluated = Array.isArray(latest.evaluatedAssetIds) ? new Set(latest.evaluatedAssetIds) : undefined;
  if (!evaluated) return items;
  for (const run of runs.slice(1)) {
    for (const finding of run.findings) {
      if (finding.assetIds.every(id => evaluated.has(id))) continue;
      push(run, finding);
    }
  }
  return items;
}
