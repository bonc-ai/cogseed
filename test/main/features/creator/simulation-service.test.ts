import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  runCreatorSimulation,
  type CreatorSimulationAction,
  type CreatorSimulationScope,
} from '../../../../src/main/features/creator/simulation-service';
import type { CreatorCapabilityDescriptor } from '../../../../src/main/features/creator/catalog';
import type { CreatorPresetManifestV1 } from '../../../../src/main/features/creator/types';

const golden = JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), 'test/fixtures/creator/golden/local-agent.json'),
  'utf8',
)) as {
  manifest: CreatorPresetManifestV1;
  catalog: CreatorCapabilityDescriptor[];
  actions: CreatorSimulationAction[];
};

function dependencies() {
  return {
    createId: () => 'simulation-1',
    now: (() => {
      let tick = 0;
      return () => `2026-08-21T00:00:0${tick++}.000Z`;
    })(),
    onEffect: vi.fn(),
    onScopeCreated: vi.fn((_scope: CreatorSimulationScope) => undefined),
    onScopeDisposed: vi.fn((_runId: string) => undefined),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Creator disposable simulation', () => {
  it('freezes the outer scope so callbacks cannot replace or mutate snapshots', async () => {
    const replacementManifest = structuredClone(golden.manifest);
    replacementManifest.permissions.tools = [];
    const replacementCatalog: CreatorCapabilityDescriptor[] = [];
    let captured: CreatorSimulationScope | undefined;
    const deps = {
      ...dependencies(),
      onScopeCreated: vi.fn((scope: CreatorSimulationScope) => {
        captured = scope;
        try { (scope as any).manifest = replacementManifest; } catch { /* expected for frozen scope */ }
        try { (scope as any).catalogSnapshot = replacementCatalog; } catch { /* expected for frozen scope */ }
        try { (scope.manifest.model as any).modelId = 'mutated-model'; } catch { /* expected for deep freeze */ }
        try { (scope.catalogSnapshot[0] as any).displayName = 'mutated-name'; } catch { /* expected for deep freeze */ }
      }),
    };

    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: golden.actions,
    }, deps);

    expect(result.status).toBe('passed');
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured?.manifest.model.modelId).toBe(golden.manifest.model.modelId);
    expect(captured?.catalogSnapshot[0]?.displayName).toBe(golden.catalog[0]?.displayName);
  });

  it('executes an immutable action snapshot even when creation mutates the caller array', async () => {
    const actions: CreatorSimulationAction[] = [
      { kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'immutable-action' },
    ];
    const deps = {
      ...dependencies(),
      onScopeCreated: vi.fn(() => {
        (actions[0] as any).capabilityId = 'tool.denied';
        actions.push(...Array.from({ length: 1_000 }, (_unused, index) => ({
          kind: 'delay' as const, delayMs: index,
        })));
      }),
    };

    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions,
    }, deps);

    expect(result.status).toBe('passed');
    expect(result.effects).toEqual([{
      kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'immutable-action',
    }]);
    expect(deps.onEffect).toHaveBeenCalledOnce();
  });

  it('does not clone arbitrary action payloads and honors pre-abort before action inspection', async () => {
    const controller = new AbortController();
    controller.abort();
    const extra: Record<string, unknown> = {};
    extra.self = extra;
    const action = new Proxy({
      kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'safe-action', extra,
    }, {
      ownKeys() { throw new Error('arbitrary action graph was inspected'); },
    });
    const input: any = {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      signal: controller.signal,
    };
    Object.defineProperty(input, 'actions', {
      get() { throw new Error('actions inspected after pre-abort'); },
    });
    const result = await runCreatorSimulation('user-1', input, dependencies());
    expect(result.status).toBe('cancelled');
    void action;
  });

  it('projects valid action fields without traversing extra cyclic payloads', async () => {
    const extra: Record<string, unknown> = {};
    extra.self = extra;
    const action = new Proxy({
      kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'canonical-action', extra,
    }, { ownKeys() { throw new Error('extra action payload was inspected'); } });
    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [action as any],
    }, dependencies());
    expect(result.status).toBe('passed');
    expect(result.effects).toEqual([{ kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'canonical-action' }]);
  });

  it('bounds omitted-timeout creation and effect hooks', async () => {
    const creation = await Promise.race([
      runCreatorSimulation('user-1', {
        manifest: golden.manifest, catalogSnapshot: golden.catalog, actions: [],
      }, { ...dependencies(), onScopeCreated: () => new Promise<void>(() => undefined) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung default creation')), 500)),
    ]);
    expect(creation.status).toBe('timed_out');

    const effect = await Promise.race([
      runCreatorSimulation('user-1', {
        manifest: golden.manifest, catalogSnapshot: golden.catalog,
        actions: [{ kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'default-effect' }],
      }, { ...dependencies(), onEffect: () => new Promise<void>(() => undefined) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung default effect')), 500)),
    ]);
    expect(effect.status).toBe('timed_out');
    expect(effect.effects).toEqual([]);
  });

  it('records the immutable effect snapshot when the effect hook mutates its input', async () => {
    const deps = {
      ...dependencies(),
      onEffect: vi.fn((effect) => {
        try { (effect as any).capabilityId = 'tool.denied'; } catch { /* frozen callback input */ }
        try { (effect as any).idempotencyKey = 'forged-key'; } catch { /* frozen callback input */ }
      }),
    };
    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [{ kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'immutable-effect' }],
    }, deps);

    expect(result.status).toBe('passed');
    expect(result.effects).toEqual([{
      kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'immutable-effect',
    }]);
    expect(Object.isFrozen(deps.onEffect.mock.calls[0]?.[0])).toBe(true);
  });

  it('bounds a successful run when disposal never resolves', async () => {
    const result = await Promise.race([
      runCreatorSimulation('user-1', {
        manifest: golden.manifest,
        catalogSnapshot: golden.catalog,
        actions: [],
      }, {
        ...dependencies(),
        onScopeDisposed: vi.fn(() => new Promise<void>(() => undefined)),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung disposal')), 250)),
    ]);

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'creator_simulation_scope_dispose_timeout',
    });
  });

  it('observes a rejected cancelled disposal hook before returning', async () => {
    const controller = new AbortController();
    const started = deferred();
    const release = deferred();
    let rejectCleanup!: (error: Error) => void;
    const cleanup = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
    const catchSpy = vi.spyOn(cleanup, 'catch');
    const running = runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [{ kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'cancel-cleanup' }],
      signal: controller.signal,
    }, {
      ...dependencies(),
      onEffect: async () => { started.resolve(); await release.promise; },
      onScopeDisposed: () => cleanup,
    });
    await started.promise;
    controller.abort();
    release.resolve();
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(catchSpy).toHaveBeenCalled();
    rejectCleanup(new Error('late cleanup rejection'));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('returns a stable failed result when the external signal listener throws', async () => {
    const hostile = {
      aborted: false,
      addEventListener() { throw new Error('/private/signal token=secret'); },
      removeEventListener() { return undefined; },
    };
    await expect(runCreatorSimulation('user-1', {
      manifest: golden.manifest, catalogSnapshot: golden.catalog, actions: [], signal: hostile as any,
    }, dependencies())).resolves.toMatchObject({
      status: 'failed', errorCode: 'creator_simulation_signal_invalid',
    });
  });

  it('removes a listener even when a hostile signal stores it before throwing', async () => {
    let retained: (() => void) | undefined;
    let removed = 0;
    const hostile = {
      aborted: false,
      addEventListener(_type: string, listener: () => void) { retained = listener; throw new Error('listener failed'); },
      removeEventListener(_type: string, listener: () => void) { if (listener === retained) removed += 1; },
    };
    await expect(runCreatorSimulation('user-1', {
      manifest: golden.manifest, catalogSnapshot: golden.catalog, actions: [], signal: hostile as any,
    }, dependencies())).resolves.toMatchObject({ status: 'failed', errorCode: 'creator_simulation_signal_invalid' });
    expect(removed).toBe(1);
  });

  it('does not return passed when external listener cleanup throws', async () => {
    const hostile = {
      aborted: false,
      addEventListener() { return undefined; },
      removeEventListener() { throw new Error('/private/signal cleanup token=secret'); },
    };
    await expect(runCreatorSimulation('user-1', {
      manifest: golden.manifest, catalogSnapshot: golden.catalog, actions: [], signal: hostile as any,
    }, dependencies())).resolves.toMatchObject({
      status: 'failed', errorCode: 'creator_simulation_scope_dispose_failed',
    });
  });

  it('treats the user id as an opaque scope value', async () => {
    const result = await runCreatorSimulation('opaque:user@tenant', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [],
    }, dependencies());

    expect(result.status).toBe('passed');
  });

  it('runs only registered mock executors in a deep-frozen in-memory scope', async () => {
    const deps = dependencies();
    const before = JSON.stringify(golden);

    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: golden.actions,
    }, deps);

    expect(result.status).toBe('passed');
    expect(result.effects.map((effect) => effect.kind)).toEqual(['local-read', 'mock-search']);
    expect(result.trajectory.map((event) => event.type)).toEqual(expect.arrayContaining([
      'scope.started', 'effect.applied', 'scope.completed', 'scope.disposed',
    ]));
    expect(deps.onEffect).toHaveBeenCalledTimes(2);
    expect(deps.onScopeDisposed).toHaveBeenCalledOnce();
    const scope = deps.onScopeCreated.mock.calls[0]?.[0];
    expect(Object.isFrozen(scope.manifest)).toBe(true);
    expect(Object.isFrozen(scope.manifest.runtime.budget)).toBe(true);
    expect(Object.isFrozen(scope.catalogSnapshot)).toBe(true);
    expect(Object.isFrozen(scope.catalogSnapshot[0])).toBe(true);
    await scope.dispose();
    expect(deps.onScopeDisposed).toHaveBeenCalledOnce();
    expect(JSON.stringify(golden)).toBe(before);
  });

  it.each([
    [
      'unlisted tool',
      { kind: 'mock-search', capabilityId: 'tool.browser', idempotencyKey: 'denied-tool' },
      'creator_simulation_capability_denied',
      true,
    ],
    [
      'unlisted file grant',
      { kind: 'local-read', capabilityId: 'tool.file', fileGrant: 'home.readonly', idempotencyKey: 'denied-file' },
      'creator_simulation_file_denied',
      true,
    ],
    [
      'unknown executor',
      { kind: 'shell', capabilityId: 'tool.search', idempotencyKey: 'unknown' },
      'creator_simulation_executor_unknown',
      false,
    ],
  ])('fails closed for %s without fallback effects', async (_name, action, errorCode, disposes) => {
    const deps = dependencies();
    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [action as CreatorSimulationAction],
    }, deps);

    expect(result).toMatchObject({ status: 'failed', errorCode, effects: [] });
    expect(deps.onEffect).not.toHaveBeenCalled();
    if (disposes) expect(deps.onScopeDisposed).toHaveBeenCalledOnce();
    else expect(deps.onScopeDisposed).not.toHaveBeenCalled();
  });

  it('deduplicates repeated idempotency keys before applying an effect', async () => {
    const deps = dependencies();
    const duplicate = { kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'same-effect' } as const;

    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [duplicate, duplicate],
    }, deps);

    expect(result.status).toBe('passed');
    expect(result.effects).toHaveLength(1);
    expect(deps.onEffect).toHaveBeenCalledOnce();
    expect(result.trajectory).toContainEqual(expect.objectContaining({
      type: 'effect.duplicate', idempotencyKey: 'same-effect',
    }));
  });

  it('cancels while an asynchronous effect is unresolved without committing it', async () => {
    const controller = new AbortController();
    const started = deferred();
    const release = deferred();
    const deps = {
      ...dependencies(),
      onEffect: vi.fn(async () => {
        started.resolve();
        await release.promise;
      }),
    };
    const running = runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [{ kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'async-effect' }],
      signal: controller.signal,
    }, deps);
    await started.promise;

    controller.abort();
    const result = await running;
    release.resolve();

    expect(result.status).toBe('cancelled');
    expect(result.effects).toEqual([]);
    expect(result.trajectory.some((event) => event.type === 'effect.applied')).toBe(false);
    expect(result.trajectory.some((event) => event.type === 'scope.completed')).toBe(false);
  });

  it('times out while an asynchronous effect is unresolved without committing it', async () => {
    const started = deferred();
    const release = deferred();
    const aborted = deferred();
    const deps = {
      ...dependencies(),
      onScopeCreated: vi.fn((scope: CreatorSimulationScope) => {
        scope.signal.addEventListener('abort', aborted.resolve, { once: true });
      }),
      onEffect: vi.fn(async () => {
        started.resolve();
        await release.promise;
      }),
    };
    const running = runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [{ kind: 'mock-search', capabilityId: 'tool.search', idempotencyKey: 'async-effect' }],
      timeoutMs: 5,
    }, deps);
    await started.promise;
    await aborted.promise;

    const result = await running;
    release.resolve();

    expect(result.status).toBe('timed_out');
    expect(result.effects).toEqual([]);
    expect(result.trajectory.some((event) => event.type === 'effect.applied')).toBe(false);
    expect(result.trajectory.some((event) => event.type === 'scope.completed')).toBe(false);
  });

  it('cleans timeout timers and abort listeners when a run times out', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const clear = vi.spyOn(globalThis, 'clearTimeout');

    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [{ kind: 'delay', delayMs: 50 }],
      timeoutMs: 5,
      signal: controller.signal,
    }, deps);

    expect(result.status).toBe('timed_out');
    expect(deps.onScopeDisposed).toHaveBeenCalledOnce();
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('cleans timers and listeners when cancelled by the caller', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const running = runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [{ kind: 'delay', delayMs: 100 }],
      signal: controller.signal,
    }, deps);
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();

    const result = await running;

    expect(result.status).toBe('cancelled');
    expect(deps.onScopeDisposed).toHaveBeenCalledOnce();
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('returns promptly when scope creation is hung and the caller cancels', async () => {
    const controller = new AbortController();
    const started = deferred();
    const release = deferred();
    const running = runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [],
      signal: controller.signal,
    }, {
      ...dependencies(),
      onScopeCreated: vi.fn(async () => {
        started.resolve();
        await release.promise;
      }),
    });
    await started.promise;
    controller.abort();
    const result = await Promise.race([
      running,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung creation')), 100)),
    ]);
    release.resolve();
    expect(result.status).toBe('cancelled');
  });

  it('does not invoke creation for a pre-aborted run or allow post-return trajectory writes', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = dependencies();
    let captured: CreatorSimulationScope | undefined;
    deps.onScopeCreated = vi.fn((scope: CreatorSimulationScope) => { captured = scope; });
    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest, catalogSnapshot: golden.catalog, actions: [], signal: controller.signal,
    }, deps);
    expect(result.status).toBe('cancelled');
    expect(deps.onScopeCreated).not.toHaveBeenCalled();

    const liveDeps = dependencies();
    liveDeps.onScopeCreated = vi.fn((scope: CreatorSimulationScope) => { captured = scope; });
    const completed = await runCreatorSimulation('user-1', {
      manifest: golden.manifest, catalogSnapshot: golden.catalog, actions: [],
    }, liveDeps);
    const before = completed.trajectory.length;
    await expect(captured!.emit({ type: 'scope.started', at: 'late' }))
      .rejects.toThrow('creator_simulation_scope_closed');
    expect(completed.trajectory).toHaveLength(before);
  });

  it('turns disposal from inside a creation hook into a stable cancellation', async () => {
    const onScopeDisposed = vi.fn();
    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [],
    }, {
      ...dependencies(),
      onScopeCreated: async (scope) => { await scope.dispose(); },
      onScopeDisposed,
    });

    expect(result.status).toBe('cancelled');
    expect(onScopeDisposed).toHaveBeenCalledOnce();
    expect(result.trajectory.some((event) => event.type === 'scope.completed')).toBe(false);
  });

  it('always contains cleanup when the trajectory is already at its limit', async () => {
    const onScopeDisposed = vi.fn();
    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [],
    }, {
      ...dependencies(),
      onScopeCreated: async (scope) => {
        for (let index = 0; index < 255; index += 1) {
          await scope.emit({ type: 'scope.started', at: String(index) });
        }
      },
      onScopeDisposed,
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('creator_simulation_trajectory_too_large');
    expect(onScopeDisposed).toHaveBeenCalledOnce();
  });

  it('converts disposal hook failures into a stable failed result', async () => {
    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [],
    }, {
      ...dependencies(),
      onScopeDisposed: async () => { throw new Error('/private/raw disposal failure'); },
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'creator_simulation_scope_dispose_failed' });
    expect(result.trajectory.some((event) => event.type === 'scope.completed')).toBe(true);
  });

  it.each([
    ['actions', { actions: Array.from({ length: 65 }, () => ({ kind: 'delay', delayMs: 0 })) }],
    ['catalog', { catalogSnapshot: Array.from({ length: 65 }, () => golden.catalog[0]) }],
  ])('fails closed before iterating over-limit %s input', async (_name, override) => {
    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [],
      ...override,
    } as any, dependencies());
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('creator_simulation_input_too_large');
    expect(result.effects).toEqual([]);
  });

  it('rejects oversized file grants during action projection', async () => {
    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [{ kind: 'local-read', capabilityId: 'tool.file', fileGrant: 'x'.repeat(1_000), idempotencyKey: 'large-grant' }],
    }, dependencies());
    expect(result).toMatchObject({ status: 'failed', errorCode: 'creator_simulation_file_grant_invalid' });
  });

  it('rejects malformed actions before invoking the creation hook', async () => {
    const deps = dependencies();
    const result = await runCreatorSimulation('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      actions: [{ kind: 'mock-search', capabilityId: 'tool.search' } as any],
    }, deps);

    expect(result.status).toBe('failed');
    expect(deps.onScopeCreated).not.toHaveBeenCalled();
    expect(deps.onScopeDisposed).not.toHaveBeenCalled();
  });

  it.each([
    ['cyclic manifest', () => {
      const value: any = { ...golden.manifest };
      value.self = value;
      return value;
    }],
    ['BigInt manifest', () => ({ ...golden.manifest, displayName: 1n })],
    ['oversized manifest collection', () => ({
      ...golden.manifest,
      capabilities: Array.from({ length: 10_000 }, () => ({ capabilityId: 'tool.search', version: '1' })),
    })],
  ])('rejects a %s before cloning or invoking hooks', async (_name, createManifest) => {
    const deps = dependencies();
    const result = await runCreatorSimulation('user-1', {
      manifest: createManifest() as CreatorPresetManifestV1,
      catalogSnapshot: golden.catalog,
      actions: [],
    }, deps);

    expect(result).toMatchObject({ status: 'failed', errorCode: 'creator_simulation_manifest_invalid', effects: [] });
    expect(deps.onScopeCreated).not.toHaveBeenCalled();
    expect(deps.onScopeDisposed).not.toHaveBeenCalled();
  });
});
