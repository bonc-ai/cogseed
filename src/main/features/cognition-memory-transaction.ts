import { AsyncLocalStorage } from 'node:async_hooks';

import { Mutex } from 'async-mutex';

import { userMemoryFile } from '../paths';
import { safeId } from '../storage';

const transactionBrand: unique symbol = Symbol('cognition-memory-transaction');

// 与 cognition 域 assertUserId 的 id 预算同口径（MAX_ID_LENGTH）。
const MAX_TRANSACTION_USER_ID_LENGTH = 80;

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

/**
 * P-r1-41：入口段校验。userId 不合法直接抛错——不再为高熵垃圾 id 在 locks
 * Map 里建条目（该 Map 只增不减，入口校验把键空间收敛到合法 id 集合）。
 */
function assertTransactionUserId(userId: string): void {
  if (typeof userId !== 'string' || !safeId(userId) || userId.length > MAX_TRANSACTION_USER_ID_LENGTH) {
    throw new Error('invalid cognition-memory transaction user id');
  }
}

function lockForUser(userId: string): Mutex {
  // The canonical memory path gives every writer the same key; the userId
  // itself has already been validated at this module's entry.
  const key = userMemoryFile(userId);
  const existing = locks.get(key);
  if (existing) return existing;
  const created = new Mutex();
  locks.set(key, created);
  return created;
}

/**
 * P-r1-40：同键重入检测。async-mutex 的 Mutex 不可重入——在同一事务回调里
 * 对同一用户再开一层事务会永久挂起且无超时提示。AsyncLocalStorage 只在
 * 同一异步调用链内传播，独立并发（非嵌套）的事务互不可见，不会被误伤。
 */
const transactionScope = new AsyncLocalStorage<string>();

export async function withCognitionMemoryTransaction<T>(
  userId: string,
  operation: (transaction: CognitionMemoryTransaction) => T | Promise<T>,
): Promise<T> {
  if (typeof operation !== 'function') throw new TypeError('cognition-memory transaction operation is required');
  assertTransactionUserId(userId);
  const lockKey = userMemoryFile(userId);
  if (transactionScope.getStore() === lockKey) {
    throw new Error(
      'cognition-memory transaction re-entered for the same user lock; the mutex is not reentrant and a nested transaction would hang forever',
    );
  }
  return lockForUser(userId).runExclusive(async () => {
    const transaction = Object.freeze({
      userId,
      [transactionBrand]: true as const,
    });
    activeTransactions.add(transaction);
    try {
      return await transactionScope.run(lockKey, () => operation(transaction));
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
