import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import { createLogger } from '../../logger';

const log = createLogger('p3394.sender-epoch-store');

function workspaceRoot(): string {
  const root = process.env.COGSEED_WORKSPACE_ROOT || '';
  if (!root) throw new Error('COGSEED_WORKSPACE_ROOT not set');
  return root;
}

function senderEpochFile(uid: string): string {
  return path.join(workspaceRoot(), uid, 'local', 'kstar', 'p3394-sender-epochs.json');
}

export function p3394SenderEpochStreamKey(senderActorId: string, recipientSessionId: string): string {
  return JSON.stringify([senderActorId, recipientSessionId]);
}

export class SenderEpochStore {
  private mutexes = new Map<string, Mutex>();

  private mutex(uid: string): Mutex {
    let mutex = this.mutexes.get(uid);
    if (!mutex) {
      mutex = new Mutex();
      this.mutexes.set(uid, mutex);
    }
    return mutex;
  }

  private async read(uid: string): Promise<Record<string, number>> {
    try {
      const raw = await fs.readFile(senderEpochFile(uid), 'utf8');
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      if (err instanceof SyntaxError) {
        log.warn('sender epoch parse failed, treating as empty', { uid });
        return {};
      }
      log.error('sender epoch read failed', { uid, error: (err as Error).message });
      throw err;
    }
  }

  async next(uid: string, senderActorId: string, recipientSessionId: string): Promise<number> {
    return this.mutex(uid).runExclusive(async () => {
      const map = await this.read(uid);
      const key = p3394SenderEpochStreamKey(senderActorId, recipientSessionId);
      const next = (Number.isSafeInteger(map[key]) ? map[key] : 0) + 1;
      map[key] = next;

      const file = senderEpochFile(uid);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
        await fs.rename(tmp, file);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return next;
    });
  }
}
