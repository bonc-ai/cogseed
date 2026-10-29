import { Mutex } from 'async-mutex';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { userLocalRoot } from '../../paths';
import { nowIso, readJson, writeJson } from '../../storage';
import type { WakeState } from './types';

const locks = new Map<string, Mutex>();

function lockFor(userId: string): Mutex {
  const existing = locks.get(userId);
  if (existing) return existing;
  const created = new Mutex();
  locks.set(userId, created);
  return created;
}

export function wakeStateFile(userId: string): string {
  return path.join(userLocalRoot(userId), 'p3394', 'wake-state.json');
}

export async function readWakeState(userId: string): Promise<WakeState> {
  const raw = await readJson<Partial<WakeState>>(wakeStateFile(userId));
  return {
    version: 1,
    requests: Array.isArray(raw.requests) ? raw.requests : [],
    approvals: Array.isArray(raw.approvals) ? raw.approvals : [],
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : nowIso(),
  };
}

/** 「等用户批准」索引：只读、按用户 TTL 缓存。
 *
 *  两个消费方都要它，而且都在热路径上：
 *   - `conversations.list` 要给侧栏每一行打标（含**从不轮询的陈旧会话**，它们
 *     的 run/actor/wake 会互等几天）；
 *   - `/runtime` 投影要判断"这个 run 是不是在等批准"（据此不再伪装成运行中）。
 *  唤醒状态文件可能很大（本机已 150KB），所以整文件只解析一次、按 TTL 复用；
 *  需要即时生效的写路径（批准/拒绝/过期）会走 mutateWakeState，它们不依赖本缓存。
 */
/** 缓存失效用文件戳（mtime+size）而不是 TTL：批准/拒绝后必须立刻反映，同时
 *  热点轮询只需一次 stat，不必反复解析整份状态。 */
function wakeStateStamp(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

const pendingApprovalCache = new Map<string, { stamp: string; index: { conversations: Set<string>; runs: Set<string> } }>();

export async function pendingApprovalIndex(
  userId: string,
): Promise<{ conversations: Set<string>; runs: Set<string> }> {
  const file = wakeStateFile(userId);
  const stamp = wakeStateStamp(file);
  const cached = pendingApprovalCache.get(userId);
  if (cached && cached.stamp === stamp) return cached.index;
  const state = await readWakeState(userId);
  const conversations = new Set<string>();
  const runs = new Set<string>();
  for (const request of state.requests) {
    // 只认 pending：approved 表示用户**已经决定**（派发可能正在进行或已中止），
    // 再显示"等待你批准"就是错的（真机反馈：唤醒后停止，标签还挂着）。
    if (request.status !== 'pending') continue;
    if (request.conversation_id) conversations.add(request.conversation_id);
    const runId = String(request.dispatch_payload?.run_id || '');
    if (runId) runs.add(runId);
  }
  const index = { conversations, runs };
  pendingApprovalCache.set(userId, { stamp, index });
  return index;
}

/** 测试缝隙：清掉索引缓存（生产路径靠文件戳自动失效，不需要）。 */
export function _resetPendingApprovalCacheForTest(): void {
  pendingApprovalCache.clear();
}

function recordStamp(row: { updated_at?: string }): string {
  return typeof row.updated_at === 'string' ? row.updated_at : '';
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Converge two writers' views of the same state file.
 *
 * Wake state is append-and-update only: a request or approval is never removed,
 * it only changes status. That makes the union of two concurrent read-modify-write
 * cycles the correct result, so no cross-process lock is needed — and none is
 * available: `fileEditLock` is an in-process, path-keyed Mutex, and the app's
 * single-instance guard is per build, so a source build and an installed build can
 * share one data root.
 *
 * Without this, the second writer persisted its stale copy and silently dropped
 * the first writer's request: the UI kept showing a pending approval card (the
 * card also lives on the message record) while `getWakeRequest` had nothing to
 * find, so "approve" failed with `wake request not found` (2026-10-21).
 *
 * Precedence per record id: a record only one side changed wins; when both changed
 * it, the later `updated_at` wins (ISO timestamps compare lexicographically), and
 * the local view breaks ties.
 */
function mergeRecords<T extends { id: string; updated_at?: string }>(
  base: readonly T[],
  ours: readonly T[],
  theirs: readonly T[],
): T[] {
  const baseById = new Map(base.filter((row) => row && typeof row.id === 'string').map((row) => [row.id, row]));
  const theirsById = new Map(theirs.filter((row) => row && typeof row.id === 'string').map((row) => [row.id, row]));
  const merged: T[] = [];
  const seen = new Set<string>();
  const loose: T[] = [];
  for (const row of ours) {
    // A row without a usable id cannot be merged by identity; keep it verbatim
    // rather than dropping user-visible state over a malformed record.
    if (!row || typeof row.id !== 'string') { loose.push(row); continue; }
    seen.add(row.id);
    const peerRow = theirsById.get(row.id);
    if (!peerRow) { merged.push(row); continue; }
    const before = baseById.get(row.id);
    const oursChanged = !sameRecord(before, row);
    const peerChanged = !sameRecord(before, peerRow);
    if (!oursChanged) merged.push(peerRow);
    else if (!peerChanged) merged.push(row);
    else merged.push(recordStamp(peerRow) > recordStamp(row) ? peerRow : row);
  }
  for (const row of theirs) {
    if (!row || typeof row.id !== 'string') {
      if (!loose.some((candidate) => sameRecord(candidate, row))) loose.push(row);
      continue;
    }
    if (!seen.has(row.id)) merged.push(row);
  }
  return loose.length ? [...merged, ...loose] : merged;
}

export async function mutateWakeState<T>(
  userId: string,
  mutate: (state: WakeState) => T | Promise<T>,
): Promise<T> {
  return lockFor(userId).runExclusive(async () => {
    const state = await readWakeState(userId);
    // Snapshot before the mutation so the merge can tell which records this cycle
    // actually changed. `mutate` may await for a while (workflow reconciliation),
    // which is exactly the window another instance writes in.
    const base = JSON.parse(JSON.stringify(state)) as WakeState;
    const result = await mutate(state);
    state.updated_at = nowIso();
    const peer = await readWakeState(userId).catch(() => null);
    const next = peer
      ? {
        ...state,
        requests: mergeRecords(base.requests, state.requests, peer.requests),
        approvals: mergeRecords(base.approvals, state.approvals, peer.approvals),
      }
      : state;
    await writeJson(wakeStateFile(userId), next);
    return result;
  });
}
