// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { fileEditLock } from '../../util/locks';
import { assertCogSeedConversationId, assertCogSeedUserId } from './paths';

const deletedConversations = new Set<string>();
const deletingConversations = new Set<string>();
const activeProjectionEffects = new Map<string, number>();
const projectionDrainWaiters = new Map<string, Set<() => void>>();

export class CogSeedConversationUnavailableError extends Error {
  readonly code = 'E_COGSEED_CONVERSATION_UNAVAILABLE';

  constructor() {
    super('CogSeed conversation is unavailable');
    this.name = 'CogSeedConversationUnavailableError';
  }
}

export function isCogSeedConversationUnavailableError(
  error: unknown,
): error is CogSeedConversationUnavailableError {
  return error instanceof CogSeedConversationUnavailableError
    || Boolean(error && typeof error === 'object' && 'code' in error
      && error.code === 'E_COGSEED_CONVERSATION_UNAVAILABLE');
}

function operationKey(userId: string, conversationId: string): string {
  return `cogseed-conversation-operation:${userId}:${conversationId}`;
}

function deletionKey(userId: string, conversationId: string): string {
  return `cogseed-conversation-deletion:${userId}:${conversationId}`;
}

function assertConversationAvailable(key: string): void {
  if (deletedConversations.has(key) || deletingConversations.has(key)) {
    throw new CogSeedConversationUnavailableError();
  }
}

async function waitForProjectionEffects(key: string): Promise<void> {
  if ((activeProjectionEffects.get(key) || 0) === 0) return;
  await new Promise<void>((resolve) => {
    const waiters = projectionDrainWaiters.get(key) || new Set<() => void>();
    waiters.add(resolve);
    projectionDrainWaiters.set(key, waiters);
  });
}

function finishProjectionEffect(key: string): void {
  const remaining = (activeProjectionEffects.get(key) || 1) - 1;
  if (remaining > 0) {
    activeProjectionEffects.set(key, remaining);
    return;
  }
  activeProjectionEffects.delete(key);
  const waiters = projectionDrainWaiters.get(key);
  projectionDrainWaiters.delete(key);
  for (const resolve of waiters || []) resolve();
}

/** Serialize task admission against conversation deletion. */
export async function withCogSeedConversationAdmission<T>(
  userId: string,
  conversationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const ownerId = assertCogSeedUserId(userId);
  const cid = assertCogSeedConversationId(conversationId);
  const key = operationKey(ownerId, cid);
  return fileEditLock(key).runExclusive(async () => {
    assertConversationAvailable(key);
    return operation();
  });
}

/** Serialize explicit-id creation against deletion. Automatic callers cannot
 * revive a tombstone; an intentional import may opt in and clears the
 * process-local tombstone only after its durable write succeeds. */
export async function withCogSeedConversationCreation<T>(
  userId: string,
  conversationId: string,
  options: { reviveDeleted?: boolean },
  operation: () => Promise<T>,
): Promise<T> {
  const ownerId = assertCogSeedUserId(userId);
  const cid = assertCogSeedConversationId(conversationId);
  const key = operationKey(ownerId, cid);
  return fileEditLock(key).runExclusive(async () => {
    if (deletingConversations.has(key)
      || (deletedConversations.has(key) && options.reviveDeleted !== true)) {
      throw new CogSeedConversationUnavailableError();
    }
    const result = await operation();
    if (options.reviveDeleted === true) deletedConversations.delete(key);
    return result;
  });
}

/** Register one short, local projection side effect against Conversation
 * deletion. Registration is synchronous, so deletion can close admission and
 * wait for already-started writes without holding up a detached projection
 * while it waits on unrelated task locks or timeout bookkeeping. */
export async function withCogSeedConversationProjectionEffect<T>(
  userId: string,
  conversationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const ownerId = assertCogSeedUserId(userId);
  const cid = assertCogSeedConversationId(conversationId);
  const key = operationKey(ownerId, cid);
  assertConversationAvailable(key);
  activeProjectionEffects.set(key, (activeProjectionEffects.get(key) || 0) + 1);
  try {
    return await operation();
  } finally {
    finishProjectionEffect(key);
  }
}

/** Hold the same admission lock for cancellation, tombstoning, and purge. */
export async function withCogSeedConversationDeletion(
  userId: string,
  conversationId: string,
  operation: () => Promise<boolean>,
): Promise<boolean> {
  return withCogSeedConversationDeletionPhases(
    userId,
    conversationId,
    async () => ({ removed: await operation(), settled: Promise.resolve() }),
    async () => undefined,
  );
}

export interface CogSeedConversationDeletionPreparation {
  removed: boolean;
  settled: Promise<void>;
}

/** Delete in two operation-lock phases while one separate deletion lease keeps
 * the Conversation unavailable throughout the settlement gap. The gap lets a
 * CLI consumer that was scheduled before deletion finish its admission attempt
 * instead of deadlocking behind the lock held by its own canceller. */
export async function withCogSeedConversationDeletionPhases(
  userId: string,
  conversationId: string,
  prepare: () => Promise<CogSeedConversationDeletionPreparation>,
  finalize: () => Promise<void>,
): Promise<boolean> {
  const ownerId = assertCogSeedUserId(userId);
  const cid = assertCogSeedConversationId(conversationId);
  const key = operationKey(ownerId, cid);
  return fileEditLock(deletionKey(ownerId, cid)).runExclusive(async () => {
    deletingConversations.add(key);
    try {
      const prepared = await fileEditLock(key).runExclusive(async () => {
        await waitForProjectionEffects(key);
        return prepare();
      });
      if (prepared.removed) deletedConversations.add(key);
      await prepared.settled;
      if (!prepared.removed) return false;
      await fileEditLock(key).runExclusive(async () => {
        await waitForProjectionEffects(key);
        await finalize();
      });
      return true;
    } finally {
      deletingConversations.delete(key);
    }
  });
}
