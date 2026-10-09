import { Mutex } from 'async-mutex';
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

export async function mutateWakeState<T>(
  userId: string,
  mutate: (state: WakeState) => T | Promise<T>,
): Promise<T> {
  return lockFor(userId).runExclusive(async () => {
    const state = await readWakeState(userId);
    const result = await mutate(state);
    state.updated_at = nowIso();
    await writeJson(wakeStateFile(userId), state);
    return result;
  });
}
