/**
 * 会话内治理状态存储 — per-conversation state for the multi-turn "governed"
 * Agent 创建师 creation flow (draft pending confirmation, 24h expiry).
 *
 * The state file lives under the user's cloud (syncable) data, scoped by
 * (uid, cid): `<uid>/cloud/chats/<cid>/builder-flow.json`, alongside the other
 * group-chat per-conversation metadata (members/state/plan). Writes go through
 * `writeJson` (atomic tmp+rename) so cloud sync never observes a torn file.
 *
 * Concurrency: writers/clearers are serialized per (uid, cid) with a Mutex,
 * mirroring `group_chat/state.ts`, so concurrent actors cannot last-writer-win
 * over a stale read.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';

import { groupChatBuilderFlowFile } from '../../paths';
import { readJson, writeJson } from '../../storage';
import { createLogger } from '../../logger';

const log = createLogger('group_chat.agent_builder_state');

/** A governed creation flow is confirmable for 24h, then treated as expired. */
export const BUILDER_FLOW_TTL_MS = 24 * 60 * 60 * 1000;

export type BuilderStage =
  | 'awaiting_confirm'
  | 'verifying'
  | 'awaiting_final_confirm'
  | 'materializing'
  | 'done'
  | 'failed'
  | 'expired';

const BUILDER_STAGES: ReadonlySet<string> = new Set<BuilderStage>([
  'awaiting_confirm',
  'verifying',
  'awaiting_final_confirm',
  'materializing',
  'done',
  'failed',
  'expired',
]);

function isBuilderStage(value: unknown): value is BuilderStage {
  return typeof value === 'string' && BUILDER_STAGES.has(value);
}

export interface BuilderFlowState {
  version: 1;
  cid: string;
  agentId: string;
  mode: 'governed';
  stage: BuilderStage;
  draftId: string;
  verificationRunId?: string;
  smokeRunId?: string;
  expiresAt: string;
  updatedAt: string;
  failureReason?: string;
}

export interface BuilderStateDeps {
  /** Test seam: container root; state lands at `<dir>/<uid>/<cid>/builder-flow.json`. */
  dir?: string;
}

// Per-(uid, cid) serialisation lock for builder-flow.json read-modify-write /
// clear. Without it concurrent writers could both write and the slower one's
// write wins, silently overwriting the other's intent. Lazy-create so we only
// pay for conversations that actually see a governed flow.
const _flowMutex = new Map<string, Mutex>();
function _flowLock(uid: string, cid: string): Mutex {
  const k = `${uid}:${cid}`;
  let m = _flowMutex.get(k);
  if (!m) { m = new Mutex(); _flowMutex.set(k, m); }
  return m;
}

function stateFile(uid: string, cid: string, deps: BuilderStateDeps = {}): string {
  if (deps.dir) return path.join(deps.dir, uid, cid, 'builder-flow.json');
  return groupChatBuilderFlowFile(uid, cid);
}

/** Structural validation: malformed state is treated as absent (null). */
function isBuilderFlowState(data: unknown): data is BuilderFlowState {
  if (!data || typeof data !== 'object') return false;
  const s = data as Record<string, unknown>;
  return s.version === 1
    && typeof s.cid === 'string' && s.cid.length > 0
    && typeof s.agentId === 'string' && s.agentId.length > 0
    && typeof s.draftId === 'string' && s.draftId.length > 0
    && s.mode === 'governed'
    && isBuilderStage(s.stage)
    && typeof s.expiresAt === 'string'
    && typeof s.updatedAt === 'string'
    && (s.failureReason === undefined || typeof s.failureReason === 'string');
}

export async function readBuilderFlow(
  uid: string,
  cid: string,
  deps: BuilderStateDeps = {},
): Promise<BuilderFlowState | null> {
  const file = stateFile(uid, cid, deps);
  if (!fs.existsSync(file)) return null;
  const data = await readJson<unknown>(file);
  return isBuilderFlowState(data) ? data : null;
}

export async function writeBuilderFlow(
  uid: string,
  cid: string,
  state: BuilderFlowState,
  deps: BuilderStateDeps = {},
): Promise<BuilderFlowState> {
  const file = stateFile(uid, cid, deps);
  await _flowLock(uid, cid).runExclusive(() => writeJson(file, state));
  return state;
}

/** Serialize a read/modify/write sequence for one conversation. Long-running
 * operations should reserve a `verifying`/`materializing` stage before doing
 * external work, then use this helper for the final compare-and-set. */
export async function withBuilderFlowLock<T>(
  uid: string,
  cid: string,
  deps: BuilderStateDeps,
  fn: (current: BuilderFlowState | null, write: (state: BuilderFlowState) => Promise<BuilderFlowState>, clear: () => Promise<void>) => Promise<T>,
): Promise<T> {
  return _flowLock(uid, cid).runExclusive(async () => {
    const file = stateFile(uid, cid, deps);
    const current = fs.existsSync(file) ? (() => {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        return isBuilderFlowState(parsed) ? parsed : null;
      } catch {
        return null;
      }
    })() : null;
    const write = async (state: BuilderFlowState): Promise<BuilderFlowState> => {
      await writeJson(file, state);
      return state;
    };
    const clear = async (): Promise<void> => {
      await fsp.rm(file, { recursive: false, force: true });
    };
    return fn(current, write, clear);
  });
}

export async function clearBuilderFlow(
  uid: string,
  cid: string,
  deps: BuilderStateDeps = {},
): Promise<void> {
  const file = stateFile(uid, cid, deps);
  await _flowLock(uid, cid).runExclusive(async () => {
    try { await fsp.rm(file, { force: true }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`clear builder flow failed user=${uid} cid=${cid}: ${(err as Error).message}`);
      }
    }
  });
}

/** Expiry predicate. A missing/unparseable `expiresAt` is treated as expired
 *  rather than never-expiring (`NaN <= now` is false and would otherwise let a
 *  corrupt flow live forever). */
export function isExpired(state: BuilderFlowState, now: Date = new Date()): boolean {
  const t = new Date(state.expiresAt).getTime();
  if (!Number.isFinite(t)) return true;
  return t <= now.getTime();
}
