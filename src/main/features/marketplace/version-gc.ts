/**
 * 保守回收 —— 按三条删除条件清理 Hub 不可变版本副本。
 *
 * 契约：specs/010 `contracts/immutable-version-store.md`｜需求：FR-050～FR-053
 * 形态参照 `marketplace_cache.ts` 的 sweep 范式（一次性扫描 + 年龄过期）。
 *
 * ⚠️ **pin 扫描不在本模块实现**：消费 `pin-scan.ts` 的唯一一份扫描，
 * **不用引用计数、不重复实现扫描**（FR-050）。
 *
 * ⚠️ **与 cache sweep 的关键差异**：`marketplace_cache.ts` 遇删除失败是 `log.warn`
 * 后继续；本模块不行——FR-053 要求「任何异常本轮不删任何副本」。因此**判定与删除
 * 分成两段**：先把整轮计划算完，判定期任何异常即整轮放弃（删 0）；删除期一旦失败
 * 就停止后续删除（已删的无法撤销，继续删只会扩大损失）。
 */

import * as fs from 'node:fs';

import { createLogger } from '../../logger';
import { userMarketplaceVersionDir } from '../../paths';
import { installedVersionOf } from './installed-version';
import { pinKey, scanActivePins } from './pin-scan';
import { listVersionCopies } from './version-store';

const log = createLogger('marketplace/version-gc');

/** `[CLIENT]` 自定的宽限期，默认 7 天。与 `marketplace_cache.ts` 的过期口径一致。 */
export const DEFAULT_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** 保留原因。每一条都对应一条删除条件未满足。 */
export type KeepReason =
  /** ① 在在用集合里——被非终态 Task 钉固。 */
  | 'pinned'
  /** ② 是该 content_id 的 current 版本。 */
  | 'current'
  /** ③ `installed_at` 未超过宽限期。 */
  | 'within-grace'
  /** 无法判定 current 版本——拿不准不删。 */
  | 'current-unknown'
  /** `meta.json` 读不到或 `installed_at` 不可用，无法证明已过宽限期。 */
  | 'meta-unreadable';

export interface VersionCopyDecision {
  contentId: string;
  version: string;
  keep: boolean;
  reason?: KeepReason;
}

export interface VersionGcPlan {
  /** 判定是否可信。`false` 时**本轮一个都不删**。 */
  trustworthy: boolean;
  decisions: VersionCopyDecision[];
  /** 不可信时的原因。 */
  reason?: string;
}

export interface VersionGcReport {
  /** 实际删除的副本。 */
  deleted: Array<{ contentId: string; version: string }>;
  /** 本轮因任何原因未删的副本及其原因。 */
  kept: VersionCopyDecision[];
  /** 整轮被放弃（删除数必为 0）。 */
  aborted: boolean;
  reason?: string;
}

/**
 * 判定某 `content_id` 的 current 版本。
 *
 * @returns 版本号；**判不出时返回 `null`**（而不是猜一个）。
 */
export type CurrentVersionResolver = (userId: string, contentId: string) => Promise<string | null>;

/**
 * 默认解析器：**实际已安装版本**（T023，2026-09-20 接入）。
 *
 * 走 `installed-version.ts` 这一**单一判定入口**（FR-020），其权威是
 * **已成功原子落盘的本地内容事实**——安装目录 + `_install.json` 这个 success marker。
 *
 * ⚠️ **不读安装清单的 `version`**：那是**目标版本**，更新失败时会领先于实际内容
 * （发现 12）。若用它当 current，会把**真正在用的那一版**留在可删集合里——方向恰好危险。
 *
 * 判不出时（未安装 / 落盘未完成 / 标记损坏）返回 `null`，该 `content_id` 的副本
 * **一个都不删**。
 */
export const currentInstalledVersion: CurrentVersionResolver = async (userId, contentId) =>
  installedVersionOf(userId, contentId);

/**
 * 「一律判不出」的解析器。
 *
 * 保留供测试与**刻意保守**的场景使用（例如某内容的安装状态存疑时整体跳过回收）。
 * **不再是默认值**——默认已是 `currentInstalledVersion`。
 */
export const unknownCurrentVersion: CurrentVersionResolver = async () => null;

export interface VersionGcOptions {
  graceMs?: number;
  /** 注入时钟，供测试构造「已过宽限期」。 */
  now?: number;
  resolveCurrentVersion?: CurrentVersionResolver;
}

/**
 * 算出本轮的删除计划。**纯判定，不删任何东西。**
 *
 * 判定期任何异常都会让整轮 `trustworthy: false`——空的删除集合与「算不出来」
 * 含义相反，必须分开表达。
 */
export async function collectVersionGcPlan(
  userId: string,
  opts: VersionGcOptions = {},
): Promise<VersionGcPlan> {
  const graceMs = opts.graceMs ?? DEFAULT_GC_GRACE_MS;
  const now = opts.now ?? Date.now();
  const resolveCurrentVersion = opts.resolveCurrentVersion ?? currentInstalledVersion;

  // 条件①的依据。扫描不可信时整轮放弃——把「扫不出来」当成「没人钉固」会删掉在用副本。
  const scan = await scanActivePins(userId);
  if (!scan.trustworthy) {
    log.warn('gc aborted: pin scan is not trustworthy', { reason: scan.reason });
    return { trustworthy: false, decisions: [], reason: `pin scan not trustworthy: ${scan.reason ?? 'unknown'}` };
  }

  let copies: ReturnType<typeof listVersionCopies>;
  try {
    copies = listVersionCopies(userId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('gc aborted: listing version copies failed', { reason });
    return { trustworthy: false, decisions: [], reason };
  }

  // current 版本按 content_id 解析一次，避免同一内容重复解析。
  const currentByContent = new Map<string, string | null>();
  const decisions: VersionCopyDecision[] = [];

  try {
    for (const copy of copies) {
      if (!currentByContent.has(copy.contentId)) {
        currentByContent.set(copy.contentId, await resolveCurrentVersion(userId, copy.contentId));
      }
      const current = currentByContent.get(copy.contentId) ?? null;

      // ① 不在在用集合
      if (scan.inUse.has(pinKey(copy.contentId, copy.version))) {
        decisions.push({ ...refOf(copy), keep: true, reason: 'pinned' });
        continue;
      }
      // ② 不是该 content_id 的 current 版本。判不出即不删。
      if (current === null) {
        decisions.push({ ...refOf(copy), keep: true, reason: 'current-unknown' });
        continue;
      }
      if (current === copy.version) {
        decisions.push({ ...refOf(copy), keep: true, reason: 'current' });
        continue;
      }
      // ③ installed_at 超过宽限期。读不到就无法证明已过期，保留。
      const installedAt = copy.meta?.installed_at;
      if (typeof installedAt !== 'number' || !Number.isFinite(installedAt)) {
        decisions.push({ ...refOf(copy), keep: true, reason: 'meta-unreadable' });
        continue;
      }
      if (now - installedAt <= graceMs) {
        decisions.push({ ...refOf(copy), keep: true, reason: 'within-grace' });
        continue;
      }

      decisions.push({ ...refOf(copy), keep: false });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('gc aborted: deciding version copies failed', { reason });
    return { trustworthy: false, decisions: [], reason };
  }

  return { trustworthy: true, decisions };
}

function refOf(copy: { contentId: string; version: string }): { contentId: string; version: string } {
  return { contentId: copy.contentId, version: copy.version };
}

/**
 * 跑一轮保守回收。
 *
 * 三条删除条件**全部满足**才删（FR-052）；判定期任何异常本轮删 0（FR-053）。
 * 不抛错：失败以 `aborted` 表达。
 */
export async function runVersionGc(
  userId: string,
  opts: VersionGcOptions = {},
): Promise<VersionGcReport> {
  const plan = await collectVersionGcPlan(userId, opts);
  if (!plan.trustworthy) {
    return { deleted: [], kept: [], aborted: true, reason: plan.reason };
  }

  const kept = plan.decisions.filter((d) => d.keep);
  const deleted: Array<{ contentId: string; version: string }> = [];

  for (const target of plan.decisions.filter((d) => !d.keep)) {
    try {
      await fs.promises.rm(userMarketplaceVersionDir(userId, target.contentId, target.version), {
        recursive: true, force: true,
      });
      deleted.push(refOf(target));
    } catch (err) {
      // 已删的无法撤销；继续删只会扩大损失。停在这里，如实上报。
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('gc stopped after a failed removal', { reason, deleted: deleted.length });
      return { deleted, kept, aborted: true, reason };
    }
  }

  log.info('gc complete', { deleted: deleted.length, kept: kept.length });
  return { deleted, kept, aborted: false };
}
