// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('CogSeed conversation operation guard', () => {
  it('serializes deletion behind admission and rejects admission after deletion succeeds', async () => {
    const guard = await import('../../../../src/main/features/cogseed_backend/conversation-operation-guard');
    let releaseAdmission!: () => void;
    let admissionEntered!: () => void;
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const admissionStarted = new Promise<void>((resolve) => { admissionEntered = resolve; });
    let deletionEntered = false;

    const admitting = guard.withCogSeedConversationAdmission('guard-user', 'cid-guard', async () => {
      admissionEntered();
      await admissionGate;
      return 'admitted';
    });
    await admissionStarted;
    const deleting = guard.withCogSeedConversationDeletion('guard-user', 'cid-guard', async () => {
      deletionEntered = true;
      return true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(deletionEntered).toBe(false);

    releaseAdmission();
    await expect(admitting).resolves.toBe('admitted');
    await expect(deleting).resolves.toBe(true);
    await expect(guard.withCogSeedConversationAdmission('guard-user', 'cid-guard', async () => 'late'))
      .rejects.toThrow(/unavailable/i);
  });

  it('closes projection admission and drains only an already-started side effect', async () => {
    const guard = await import('../../../../src/main/features/cogseed_backend/conversation-operation-guard');
    let releaseEffect!: () => void;
    let effectEntered!: () => void;
    const effectGate = new Promise<void>((resolve) => { releaseEffect = resolve; });
    const effectStarted = new Promise<void>((resolve) => { effectEntered = resolve; });
    let deletionEntered = false;

    const projecting = guard.withCogSeedConversationProjectionEffect(
      'projection-guard-user',
      'cid-projection-guard',
      async () => {
        effectEntered();
        await effectGate;
      },
    );
    await effectStarted;
    const deleting = guard.withCogSeedConversationDeletion(
      'projection-guard-user',
      'cid-projection-guard',
      async () => {
        deletionEntered = true;
        return true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(deletionEntered).toBe(false);
    await expect(guard.withCogSeedConversationProjectionEffect(
      'projection-guard-user',
      'cid-projection-guard',
      async () => undefined,
    )).rejects.toThrow(/unavailable/i);

    releaseEffect();
    await expect(projecting).resolves.toBeUndefined();
    await expect(deleting).resolves.toBe(true);
  });

  it('releases the operation lock while deleted executions settle', async () => {
    const guard = await import('../../../../src/main/features/cogseed_backend/conversation-operation-guard');
    let releaseSettlement!: () => void;
    let preparationEntered!: () => void;
    const settlement = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    const prepared = new Promise<void>((resolve) => { preparationEntered = resolve; });
    let finalized = false;

    const deleting = guard.withCogSeedConversationDeletionPhases(
      'phased-guard-user',
      'cid-phased-guard',
      async () => {
        preparationEntered();
        return { removed: true, settled: settlement };
      },
      async () => { finalized = true; },
    );
    await prepared;

    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('late admission remained locked')), 250);
      timer.unref?.();
    });
    await expect(Promise.race([
      guard.withCogSeedConversationAdmission('phased-guard-user', 'cid-phased-guard', async () => 'late'),
      deadline,
    ])).rejects.toThrow(/unavailable/i);
    await expect(guard.withCogSeedConversationProjectionEffect(
      'phased-guard-user',
      'cid-phased-guard',
      async () => undefined,
    )).rejects.toThrow(/unavailable/i);
    await expect(guard.withCogSeedConversationCreation(
      'phased-guard-user',
      'cid-phased-guard',
      { reviveDeleted: true },
      async () => 'revived',
    )).rejects.toThrow(/unavailable/i);
    expect(finalized).toBe(false);

    releaseSettlement();
    await expect(deleting).resolves.toBe(true);
    expect(finalized).toBe(true);
  });

  it('serializes concurrent deletion leases and permits only explicit revival afterwards', async () => {
    const guard = await import('../../../../src/main/features/cogseed_backend/conversation-operation-guard');
    let releaseFirst!: () => void;
    let firstPrepared!: () => void;
    const firstSettlement = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { firstPrepared = resolve; });
    const order: string[] = [];

    const first = guard.withCogSeedConversationDeletionPhases(
      'serialized-guard-user',
      'cid-serialized-guard',
      async () => {
        order.push('first.prepare');
        firstPrepared();
        return { removed: true, settled: firstSettlement };
      },
      async () => { order.push('first.finalize'); },
    );
    await firstStarted;
    const second = guard.withCogSeedConversationDeletionPhases(
      'serialized-guard-user',
      'cid-serialized-guard',
      async () => {
        order.push('second.prepare');
        return { removed: true, settled: Promise.resolve() };
      },
      async () => { order.push('second.finalize'); },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['first.prepare']);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(order).toEqual([
      'first.prepare',
      'first.finalize',
      'second.prepare',
      'second.finalize',
    ]);
    await expect(guard.withCogSeedConversationCreation(
      'serialized-guard-user',
      'cid-serialized-guard',
      {},
      async () => 'automatic',
    )).rejects.toThrow(/unavailable/i);
    await expect(guard.withCogSeedConversationCreation(
      'serialized-guard-user',
      'cid-serialized-guard',
      { reviveDeleted: true },
      async () => 'imported',
    )).resolves.toBe('imported');
    await expect(guard.withCogSeedConversationAdmission(
      'serialized-guard-user',
      'cid-serialized-guard',
      async () => 'admitted',
    )).resolves.toBe('admitted');
  });
});
