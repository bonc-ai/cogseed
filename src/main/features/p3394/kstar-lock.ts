import { Mutex } from 'async-mutex';

const userLocks = new Map<string, Mutex>();

function lockFor(uid: string): Mutex {
  let mutex = userLocks.get(uid);
  if (!mutex) {
    mutex = new Mutex();
    userLocks.set(uid, mutex);
  }
  return mutex;
}

export async function withKstarUserLock<T>(uid: string, fn: () => Promise<T> | T): Promise<T> {
  return await lockFor(uid).runExclusive(async () => await fn());
}
