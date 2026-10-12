/**
 * 后台巡检（specs/008 US-405）。
 *
 * **只报不改**——这是本 Story 的立身之本：巡检定期扫一遍资产库，发现重复 /
 * 过时 / 冲突，**只产出待办与建议（Change Candidate）**，不修改任何资产：不改
 * 状态、不改正文、不合并、不打标。用户看到的是一条条可以自己去处理的待办。
 *
 * 三条口径：
 *   ① 「重复 / 过时」的**呈现分组待 specs/010 落地**：这里只给发现类别
 *      （duplicate / outdated / conflict，取自 US-405 原文），不臆造一套分组名，
 *      也不建平行机制——呈现仍走既有 inbox 通道。
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
import type { RecallJsonRecord } from './types';
import { listAbilityAssets } from './asset-service';
import { nearDuplicateScore } from './cleanup-report-service';
import type { RecallAbilityAssetRecord } from './candidate-service';
import { scheduleBootBackground, type ScheduledBootBackgroundTask } from '../../util/boot_init';
import { logErrorRef, maskId } from '../../util/log-redact';

const log = createLogger('recall.asset-inspection');

const SETTINGS_COLLECTION = 'inspection-settings';
const SETTINGS_ID = 'settings';
const RUNS_COLLECTION = 'inspection-runs';

export type InspectionTrigger = 'scheduled' | 'manual';
/** 发现类别取自 US-405 原文（重复 / 过时 / 冲突）；呈现分组待 specs/010 落地。 */
export type InspectionFindingCategory = 'duplicate' | 'outdated' | 'conflict';

export interface InspectionFinding {
  /** 稳定去重键：同一条问题在两轮巡检里是同一个 key（待办 id 由它派生）。 */
  key: string;
  category: InspectionFindingCategory;
  assetIds: string[];
  title: string;
  detail: string;
}

export interface InspectionRun extends RecallJsonRecord {
  id: string;
  trigger: InspectionTrigger;
  scope: { statuses: string[] };
  findings: InspectionFinding[];
  scanned: number;
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

// 默认关（2026-09-28 四病整改 G2 / 拍板项 #5）：巡检是低频增值能力，不该
// 未经用户开启就后台自跑——真机 125 轮 findings 全零也说明默认开没有产出。
// 用户在「资产设置 → 高级设置」里打开后才会写入 settings 记录（此后以记录为准）。
const DEFAULT_SETTINGS = Object.freeze({ enabled: false });

/** 巡检周期：一天两轮足够——重复/过时/冲突都不是分钟级变化的事，
 *  频率高只会多刷待办、不增加发现。 */
export const INSPECTION_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** 「过时」判据：在用资产多久没被碰过算过时。 */
export const INSPECTION_OUTDATED_DAYS = 180;
/** 疑似重复阈值（与整理报告同一套字面重叠判据）。 */
const DUPLICATE_SCORE_THRESHOLD = 0.8;
/** 单轮两两比对上限：超过就只做逐条检查，不硬算（宁可少报）。 */
const DUPLICATE_SCAN_LIMIT = 200;

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
    // 容错方向与默认关一致（拍板项 #5）：缺 enabled 字段视为关——历史记录
    // 若真缺过该字段，宁可不跑也不要"没说过要开却自己跑了"。
    enabled: raw.enabled === true,
    dismissedFindingKeys: keysOf(raw.dismissedFindingKeys),
    deferredFindingKeys: keysOf(raw.deferredFindingKeys),
  } as InspectionSettings;
}

/** 开关（T049）：关掉之后不再自动运行；手动触发仍可用（那是用户自己要的）。 */
export async function setInspectionEnabled(userId: string, enabled: boolean): Promise<InspectionSettings> {
  const current = await readInspectionSettings(userId);
  const next: InspectionSettings = { ...current, enabled: Boolean(enabled), updatedAt: new Date().toISOString() };
  await writeRecallJsonRecord(userId, SETTINGS_COLLECTION, SETTINGS_ID, next);
  return next;
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
  const current = await readInspectionSettings(userId);
  const dismissed = decision === 'dismissed'
    ? [...new Set([...current.dismissedFindingKeys, findingKey])].slice(-500)
    : current.dismissedFindingKeys.filter((key) => key !== findingKey);
  const deferred = decision === 'deferred'
    ? [...new Set([...current.deferredFindingKeys, findingKey])].slice(-500)
    : current.deferredFindingKeys.filter((key) => key !== findingKey);
  const updated = await updateRecallJsonRecord(userId, SETTINGS_COLLECTION, SETTINGS_ID, (raw) => ({
    ...(raw || current),
    dismissedFindingKeys: dismissed,
    deferredFindingKeys: deferred,
    updatedAt: new Date().toISOString(),
  }));
  return {
    ...(updated as InspectionSettings),
    dismissedFindingKeys: dismissed,
    deferredFindingKeys: deferred,
  };
}

export async function readInspectionRun(userId: string, runId: string): Promise<InspectionRun | undefined> {
  if (!safeId(runId)) throw new Error('invalid asset inspection run id');
  const raw = await readRecallJsonRecord(userId, RUNS_COLLECTION, runId);
  return raw ? asRun(raw) : undefined;
}

export async function listInspectionRuns(userId: string, limit = 20): Promise<InspectionRun[]> {
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
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

function findingKey(category: InspectionFindingCategory, assetIds: readonly string[]): string {
  return `${category}:${[...assetIds].sort().join('+')}`;
}

/** 一轮巡检的发现。**纯读**：只看、不算账、不改任何东西。 */
export function collectInspectionFindings(
  assets: readonly RecallAbilityAssetRecord[],
  now: Date = new Date(),
): InspectionFinding[] {
  const findings: InspectionFinding[] = [];
  const active = assets.filter((asset) => asset.status === 'active');

  // 过时：在用但很久没被碰过（内容没变过、也没被用过）。
  const staleBefore = now.getTime() - INSPECTION_OUTDATED_DAYS * 86_400_000;
  for (const asset of active) {
    const touched = Date.parse(String(asset.updatedAt || ''));
    if (Number.isNaN(touched) || touched >= staleBefore) continue;
    findings.push({
      key: findingKey('outdated', [asset.id]),
      category: 'outdated',
      assetIds: [asset.id],
      title: String(asset.title || asset.id),
      detail: `超过 ${INSPECTION_OUTDATED_DAYS} 天没有更新过（最后更新 ${String(asset.updatedAt).slice(0, 10)}），可能已经过时。`,
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
    if (types.size < 2) continue;
    findings.push({
      key: findingKey('conflict', group.map((asset) => asset.id)),
      category: 'conflict',
      assetIds: group.map((asset) => asset.id),
      title: String(group[0].title || group[0].id),
      detail: `同一句正文被归成了 ${[...types].sort().join(' / ')} 两种类型，需要你裁定它到底是哪一种。`,
    });
  }

  // 疑似重复：同类型、正文不同但字面高度重叠。**只报不并**。
  const candidates = active.slice(0, DUPLICATE_SCAN_LIMIT);
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i];
      const right = candidates[j];
      if (left.type !== right.type) continue;
      const score = nearDuplicateScore(left.statement, right.statement);
      if (score < DUPLICATE_SCORE_THRESHOLD) continue;
      findings.push({
        key: findingKey('duplicate', [left.id, right.id]),
        category: 'duplicate',
        assetIds: [left.id, right.id],
        title: String(left.title || left.id),
        detail: `这两条看字面很像（${Math.round(score * 100)}%）：要不要合并？系统不替你判断。`,
      });
    }
  }

  return findings;
}

export interface RunInspectionOptions {
  trigger?: InspectionTrigger;
  now?: Date;
  signal?: AbortSignal;
}

/**
 * 跑一轮巡检并留下运行记录。**不修改任何资产**——发现只进记录，呈现走 inbox。
 * 已被用户处置（不管它）的发现不再进记录，所以连续两轮不会产生重复待办。
 */
export async function runAssetInspection(
  userId: string,
  options: RunInspectionOptions = {},
): Promise<InspectionRun> {
  const startedAt = new Date().toISOString();
  const settings = await readInspectionSettings(userId);
  const dismissed = new Set(settings.dismissedFindingKeys);
  const assets = await listAbilityAssets(userId);
  const findings = collectInspectionFindings(assets, options.now)
    .filter((finding) => !dismissed.has(finding.key));
  const runId = `ir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const run: InspectionRun = {
    schemaVersion: 1,
    ownerId: userId,
    id: runId,
    trigger: options.trigger || 'manual',
    scope: { statuses: ['active'] },
    findings,
    scanned: assets.length,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(options.signal?.aborted ? { stoppedBy: 'abort' } : {}),
  };
  await writeRecallJsonRecord(userId, RUNS_COLLECTION, runId, run);
  if (findings.length) {
    log.info('asset inspection found issues', {
      userId: maskId(userId),
      runId,
      duplicate: findings.filter((f) => f.category === 'duplicate').length,
      outdated: findings.filter((f) => f.category === 'outdated').length,
      conflict: findings.filter((f) => f.category === 'conflict').length,
    });
  }
  return run;
}

/**
 * 定时那一轮要不要跑（T049 的开关语义）：关掉之后**不再自动运行**；
 * 手动触发仍可用（那是用户自己要的，与开关无关）。
 *
 * 抽成导出函数是为了让"关掉就不再自动跑"这条能被行为测试钉住——只读代码
 * 断言不了"它真的没跑"。
 */
export async function runScheduledInspectionIfEnabled(
  userId: string,
  options: { signal?: AbortSignal } = {},
): Promise<InspectionRun | undefined> {
  const settings = await readInspectionSettings(userId);
  if (!settings.enabled) return undefined;
  const run = await runAssetInspection(userId, { trigger: 'scheduled', ...(options.signal ? { signal: options.signal } : {}) });
  // 集成维护（2026-09-29 子安拍板「完全合并」）：自动维护开启时，检查轮之后
  // 同天追加一轮完整清理（规范标题/合并重复/补标签/重写啰嗦正文，trigger
  // =inspection，写前备份照旧）。当天已跑过则跳过（按最近一条清理报告的
  // trigger+日期判重）；失败只记日志，不拖垮检查结果，也不影响返回值。
  try {
    const { listCleanupReports, runAssetCleanup } = await import('./cleanup-report-service');
    const reports = await listCleanupReports(userId, 1);
    const latest = reports[0];
    const today = new Date().toISOString().slice(0, 10);
    const alreadyToday = Boolean(
      latest
      && String(latest.trigger || '') === 'inspection'
      && String(latest.createdAt || '').slice(0, 10) === today,
    );
    if (!alreadyToday) await runAssetCleanup(userId, { trigger: 'inspection' });
  } catch (error) {
    log.warn('scheduled maintenance cleanup failed', { userId, error: (error as Error).message });
  }
  return run;
}

export interface InspectionLoopHandle {
  stop(): void;
}

/** 低频自续期循环（与到期清理同款：经 boot_init 的准入与空闲等待，不用裸定时器）。 */
export function startAssetInspectionLoop(
  userId: string,
  intervalMs: number = INSPECTION_INTERVAL_MS,
): InspectionLoopHandle {
  let scheduled: ScheduledBootBackgroundTask | null = null;
  let stopped = false;
  const scheduleNext = (delayMs: number): void => {
    scheduled = scheduleBootBackground('recall:asset-inspection', async (signal) => {
      if (stopped || signal?.aborted) return;
      try {
        await runScheduledInspectionIfEnabled(userId, { ...(signal ? { signal } : {}) });
      } catch (err) {
        log.error('asset inspection threw', { userId: maskId(userId), error: logErrorRef(err as Error) });
      }
    }, delayMs, { resourceClass: 'disk', preferIdle: true, maxSliceMs: 20_000 });
    void scheduled.promise.finally(() => {
      scheduled = null;
      if (!stopped) scheduleNext(intervalMs);
    });
  };
  scheduleNext(0);
  return {
    stop() {
      stopped = true;
      scheduled?.cancel();
      scheduled = null;
    },
  };
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
  return latest.findings
    .filter((finding) => !dismissed.has(finding.key))
    .map((finding) => ({
      runId: latest.id,
      key: finding.key,
      category: finding.category,
      assetIds: [...finding.assetIds],
      title: finding.title,
      detail: finding.detail,
      ...(deferred.has(finding.key) ? { deferred: true } : {}),
    }));
}
