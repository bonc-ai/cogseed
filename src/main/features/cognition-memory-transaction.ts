import { Mutex } from 'async-mutex';

import { userMemoryFile } from '../paths';

const transactionBrand: unique symbol = Symbol('cognition-memory-transaction');

/**
 * An active, per-user transaction spanning the cognition store and shared
 * MEMORY.md. Callers cannot construct a valid lease; it exists only while the
 * callback passed to `withCognitionMemoryTransaction` is running.
 */
export interface CognitionMemoryTransaction {
  readonly userId: string;
  readonly [transactionBrand]: true;
}

const locks = new Map<string, Mutex>();
const activeTransactions = new WeakSet<object>();

function lockForUser(userId: string): Mutex {
  // The canonical memory path gives every writer the same key. Callers keep
  // responsibility for their existing uid validation at the feature boundary.
  const key = userMemoryFile(userId);
  const existing = locks.get(key);
  if (existing) return existing;
  const created = new Mutex();
  locks.set(key, created);
  return created;
}

export async function withCognitionMemoryTransaction<T>(
  userId: string,
  operation: (transaction: CognitionMemoryTransaction) => T | Promise<T>,
): Promise<T> {
  if (typeof operation !== 'function') throw new TypeError('cognition-memory transaction operation is required');
  return lockForUser(userId).runExclusive(async () => {
    const transaction = Object.freeze({
      userId,
      [transactionBrand]: true as const,
    });
    activeTransactions.add(transaction);
    try {
      return await operation(transaction);
    } finally {
      activeTransactions.delete(transaction);
    }
  });
}

export function assertCognitionMemoryTransaction(
  transaction: CognitionMemoryTransaction,
  expectedUserId?: string,
): void {
  if (!transaction || !activeTransactions.has(transaction)) {
    throw new Error('inactive cognition-memory transaction');
  }
  if (expectedUserId !== undefined && transaction.userId !== expectedUserId) {
    throw new Error('cognition-memory transaction user mismatch');
  }
}
