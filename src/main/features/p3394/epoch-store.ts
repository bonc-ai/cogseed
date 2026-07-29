import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';

function workspaceRoot(): string {
  const root = process.env.ORKAS_WORKSPACE_ROOT || '';
  if (!root) throw new Error('ORKAS_WORKSPACE_ROOT not set');
  return root;
}
function epochFile(uid: string): string {
  return path.join(workspaceRoot(), uid, 'local', 'kstar', 'p3394-epochs.json');
}

/**
 * P3394 接收方水位 epoch 存储。防消息重复投递。
 * uid 级 mutex 串行化写,防并发丢更新(照抄 kstar-store)。
 */
export class EpochStore {
  private mutexes = new Map<string, Mutex>();
  private mutex(uid: string): Mutex {
    let m = this.mutexes.get(uid);
    if (!m) { m = new Mutex(); this.mutexes.set(uid, m); }
    return m;
  }

  private async read(uid: string): Promise<Record<string, number>> {
    try {
      const raw = await fs.readFile(epochFile(uid), 'utf8');
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
  }

  async current(uid: string, sessionId: string): Promise<number> {
    const map = await this.read(uid);
    return Number.isSafeInteger(map[sessionId]) ? map[sessionId] : 0;
  }

  async nextEpoch(uid: string, sessionId: string): Promise<number> {
    return this.mutex(uid).runExclusive(async () => {
      const map = await this.read(uid);
      const next = (Number.isSafeInteger(map[sessionId]) ? map[sessionId] : 0) + 1;
      map[sessionId] = next;
      const f = epochFile(uid);
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, JSON.stringify(map, null, 2), 'utf8');
      return next;
    });
  }
}
