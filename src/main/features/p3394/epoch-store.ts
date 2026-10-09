import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import { createLogger } from '../../logger';

const log = createLogger('p3394.epoch-store');

export function p3394EpochStreamKey(senderActorId: string, recipientSessionId: string): string {
  return JSON.stringify([senderActorId, recipientSessionId]);
}

function workspaceRoot(): string {
  const root = process.env.COGSEED_WORKSPACE_ROOT || '';
  if (!root) throw new Error('COGSEED_WORKSPACE_ROOT not set');
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
    let raw: string;
    try {
      raw = await fs.readFile(epochFile(uid), 'utf8');
    } catch (err) {
      // 只对文件缺失返回空 map;真实 IO 错误抛出,防拿空 map 写回抹掉其它 session 水位。
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      log.error('epoch read failed', { uid, error: (err as Error).message });
      throw err;
    }
    // 坏 JSON 不崩:解析失败或非对象一律返回空 map。
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch {
      log.warn('epoch parse failed, treating as empty', { uid });
      return {};
    }
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
      // 原子写:temp+rename,防崩溃或并发写坏文件导致水位丢失 → 重复投递。
      const tmp = f + `.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
        await fs.rename(tmp, f);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return next;
    });
  }

  /**
   * 原子地判定重放 + 推进水位(接收方水位语义:见过的最大 epoch)。
   * 全程在 uid 锁内,消除 current/nextEpoch 两次调用的 TOCTOU。
   * - incomingEpoch 省略: 水位 +1,返回 { replay:false, epoch:新水位 }。
   * - incomingEpoch 为安全整数:
   *     <= 当前水位 → { replay:true, epoch:当前水位 }(不推进/不落盘)
   *     否则 → 水位 = incomingEpoch,返回 { replay:false, epoch:incomingEpoch }
   * - incomingEpoch 非安全整数(NaN/Infinity/非整): 当作无效,按 +1 处理,不视为重放。
   */
  async admit(uid: string, sessionId: string, incomingEpoch?: number): Promise<{ replay: boolean; epoch: number }> {
    return this.mutex(uid).runExclusive(async () => {
      const map = await this.read(uid);
      const cur = Number.isSafeInteger(map[sessionId]) ? map[sessionId] as number : 0;
      let next: number;
      if (typeof incomingEpoch === 'number' && Number.isSafeInteger(incomingEpoch)) {
        if (incomingEpoch <= cur) {
          return { replay: true, epoch: cur };
        }
        next = incomingEpoch;
      } else {
        next = cur + 1;
      }
      map[sessionId] = next;
      const f = epochFile(uid);
      await fs.mkdir(path.dirname(f), { recursive: true });
      const tmp = f + `.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
        await fs.rename(tmp, f);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return { replay: false, epoch: next };
    });
  }
}
