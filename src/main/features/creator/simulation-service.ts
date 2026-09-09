import { randomUUID } from 'node:crypto';

import { validateCreatorCatalogSnapshot, type CreatorCapabilityDescriptor } from './catalog';
import { validateCreatorPresetManifest } from './schema';
import type { CreatorPresetManifestV1 } from './types';

const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const CREATOR_SIMULATION_LIMITS = Object.freeze({
  maxActions: 64,
  maxTrajectoryEvents: 256,
  maxEffects: 64,
  maxIdempotencyKeys: 64,
  maxCatalogEntries: 64,
});
const CREATOR_DISPOSAL_TIMEOUT_MS = 100;
const CREATOR_DEFAULT_SIMULATION_TIMEOUT_MS = 100;
const MAX_FILE_GRANT_LENGTH = 128;

export type CreatorSimulationAction =
  | {
    kind: 'local-read';
    capabilityId: string;
    fileGrant: string;
    idempotencyKey: string;
  }
  | {
    kind: 'mock-search';
    capabilityId: string;
    idempotencyKey: string;
  }
  | {
    kind: 'delay';
    delayMs: number;
  };

export interface CreatorTrajectoryEvent {
  type:
    | 'scope.started'
    | 'effect.applied'
    | 'effect.duplicate'
    | 'effect.rejected'
    | 'scope.completed'
    | 'scope.failed'
    | 'scope.cancelled'
    | 'scope.timed_out'
    | 'scope.disposed';
  at: string;
  capabilityId?: string;
  idempotencyKey?: string;
  errorCode?: string;
}

export interface CreatorSimulationEffect {
  kind: 'local-read' | 'mock-search';
  capabilityId: string;
  idempotencyKey: string;
}

export interface CreatorSimulationScope {
  readonly runId: string;
  readonly manifest: Readonly<CreatorPresetManifestV1>;
  readonly catalogSnapshot: ReadonlyArray<CreatorCapabilityDescriptor>;
  readonly signal: AbortSignal;
  readonly emit: (event: CreatorTrajectoryEvent) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export interface CreatorSimulationResult {
  runId: string;
  status: 'passed' | 'failed' | 'cancelled' | 'timed_out';
  errorCode?: string;
  effects: CreatorSimulationEffect[];
  trajectory: CreatorTrajectoryEvent[];
}

export interface CreatorSimulationDependencies {
  createId?: () => string;
  now?: () => string;
  onEffect?: (effect: CreatorSimulationEffect, signal: AbortSignal) => void | Promise<void>;
  onScopeCreated?: (scope: CreatorSimulationScope) => void | Promise<void>;
  onScopeDisposed?: (runId: string) => void | Promise<void>;
}

export interface CreatorSimulationInput {
  manifest: CreatorPresetManifestV1;
  catalogSnapshot: CreatorCapabilityDescriptor[];
  actions: CreatorSimulationAction[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

class CreatorSimulationPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && LOGICAL_ID.test(value);
}

function requireId(value: unknown, code: string): string {
  if (!validId(value)) throw new CreatorSimulationPolicyError(code);
  return value;
}

function descriptorFor(
  scope: CreatorSimulationScope,
  capabilityId: string,
): CreatorCapabilityDescriptor | undefined {
  const selected = scope.manifest.capabilities.find((item) => item.capabilityId === capabilityId);
  if (!selected) return undefined;
  return scope.catalogSnapshot.find((item) => (
    item.capabilityId === capabilityId
    && item.version === selected.version
    && item.available
  ));
}

function requireTool(scope: CreatorSimulationScope, capabilityId: string): CreatorCapabilityDescriptor {
  const descriptor = descriptorFor(scope, capabilityId);
  if (!descriptor || descriptor.kind !== 'tool' || !scope.manifest.permissions.tools.includes(capabilityId)) {
    throw new CreatorSimulationPolicyError('creator_simulation_capability_denied');
  }
  return descriptor;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function awaitAbortable(operation: void | Promise<void>, signal: AbortSignal): Promise<void> {
  const settled = Promise.resolve(operation);
  void settled.catch(() => undefined);
  throwIfAborted(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    try {
      signal.addEventListener('abort', onAbort, { once: true });
    } catch {
      try { signal.removeEventListener('abort', onAbort); } catch { /* contain hostile signals */ }
      reject(new CreatorSimulationPolicyError('creator_simulation_signal_invalid'));
    }
  });
  let cleanupFailed = false;
  try {
    await Promise.race([settled, aborted]);
  } finally {
    try { signal.removeEventListener('abort', onAbort); } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) throw new CreatorSimulationPolicyError('creator_simulation_signal_invalid');
  throwIfAborted(signal);
}

async function awaitDisposal(
  operation: void | Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const settled = Promise.resolve(operation);
  void settled.catch(() => undefined);
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    try { signal.addEventListener('abort', onAbort, { once: true }); }
    catch { try { signal.removeEventListener('abort', onAbort); } catch { /* contain hostile signals */ } reject(new CreatorSimulationPolicyError('creator_simulation_signal_invalid')); }
  });
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CreatorSimulationPolicyError('creator_simulation_scope_dispose_timeout')), CREATOR_DISPOSAL_TIMEOUT_MS);
  });
  let cleanupFailed = false;
  try {
    await Promise.race([settled, aborted, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { signal.removeEventListener('abort', onAbort); } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) throw new CreatorSimulationPolicyError('creator_simulation_signal_invalid');
}

function observePromise<T>(operation: Promise<T>): Promise<T> {
  void operation.catch(() => undefined);
  return operation;
}

function failedInputResult(
  runId: string,
  now: () => string,
  errorCode = 'creator_simulation_input_too_large',
): CreatorSimulationResult {
  return {
    runId,
    status: 'failed',
    errorCode,
    effects: [],
    trajectory: [{ type: 'scope.failed', at: now(), errorCode }],
  };
}

function assertAction(action: CreatorSimulationAction): void {
  if (!action || typeof action !== 'object' || typeof action.kind !== 'string') {
    throw new CreatorSimulationPolicyError('creator_simulation_executor_unknown');
  }
  if (action.kind === 'delay') {
    if (!Number.isFinite(action.delayMs) || action.delayMs < 0 || action.delayMs > 60_000) {
      throw new CreatorSimulationPolicyError('creator_simulation_delay_invalid');
    }
    return;
  }
  if (action.kind !== 'local-read' && action.kind !== 'mock-search') {
    throw new CreatorSimulationPolicyError('creator_simulation_executor_unknown');
  }
  if (action.kind === 'local-read'
    && (typeof action.fileGrant !== 'string' || action.fileGrant.length === 0 || action.fileGrant.length > MAX_FILE_GRANT_LENGTH)) {
    throw new CreatorSimulationPolicyError('creator_simulation_file_grant_invalid');
  }
  requireId(action.capabilityId, 'creator_simulation_capability_denied');
  requireId(action.idempotencyKey, 'creator_simulation_idempotency_invalid');
}

function snapshotActions(input: unknown): {
  actions: readonly CreatorSimulationAction[];
  validationError?: CreatorSimulationPolicyError;
} {
  if (!Array.isArray(input)) {
    throw new CreatorSimulationPolicyError('creator_simulation_input_too_large');
  }
  let length: number;
  try { length = input.length; } catch { throw new CreatorSimulationPolicyError('creator_simulation_input_invalid'); }
  if (!Number.isSafeInteger(length) || length < 0 || length > CREATOR_SIMULATION_LIMITS.maxActions) {
    throw new CreatorSimulationPolicyError('creator_simulation_input_too_large');
  }
  const copied: CreatorSimulationAction[] = [];
  let validationError: CreatorSimulationPolicyError | undefined;
  for (let index = 0; index < length; index += 1) {
    let raw: unknown;
    try {
      if (!Object.prototype.hasOwnProperty.call(input, index)) {
        throw new CreatorSimulationPolicyError('creator_simulation_executor_unknown');
      }
      raw = input[index];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new CreatorSimulationPolicyError('creator_simulation_executor_unknown');
      }
      const value = raw as Record<string, unknown>;
      const kind = value.kind;
      let action: CreatorSimulationAction;
      if (kind === 'delay') {
        action = { kind, delayMs: value.delayMs as number };
      } else if (kind === 'local-read') {
        action = {
          kind,
          capabilityId: value.capabilityId as string,
          fileGrant: value.fileGrant as string,
          idempotencyKey: value.idempotencyKey as string,
        };
      } else if (kind === 'mock-search') {
        action = {
          kind,
          capabilityId: value.capabilityId as string,
          idempotencyKey: value.idempotencyKey as string,
        };
      } else {
        action = { kind: kind as CreatorSimulationAction['kind'] } as CreatorSimulationAction;
      }
      assertAction(action);
      copied.push(deepFreeze(action));
    } catch (error) {
      if (error instanceof CreatorSimulationPolicyError) {
        validationError ??= error;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          copied.push(deepFreeze({ kind: '' as CreatorSimulationAction['kind'] } as CreatorSimulationAction));
        } else {
          copied.push(deepFreeze({ kind: '' as CreatorSimulationAction['kind'] } as CreatorSimulationAction));
        }
      }
      else throw error;
    }
  }
  return { actions: Object.freeze(copied), validationError };
}

function cancelledInputResult(runId: string, now: () => string): CreatorSimulationResult {
  return {
    runId,
    status: 'cancelled',
    effects: [],
    trajectory: [{ type: 'scope.cancelled', at: now() }],
  };
}

export async function runCreatorSimulation(
  userId: string,
  input: CreatorSimulationInput,
  deps: CreatorSimulationDependencies = {},
): Promise<CreatorSimulationResult> {
  if (!userId) throw new Error('creator_user_invalid');
  const runId = requireId((deps.createId ?? randomUUID)(), 'creator_simulation_run_id_invalid');
  const now = deps.now ?? (() => new Date().toISOString());
  let manifestInput: unknown;
  let catalogInput: unknown;
  let actions: unknown;
  let actionSnapshot: readonly CreatorSimulationAction[];
  let actionValidationError: CreatorSimulationPolicyError | undefined;
  let timeoutMs: unknown;
  let externalSignal: AbortSignal | undefined;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return failedInputResult(runId, now, 'creator_simulation_input_invalid');
    }
    const rawInput = input as unknown as Record<string, unknown>;
    externalSignal = rawInput.signal as AbortSignal | undefined;
    if (externalSignal !== undefined && (
      typeof externalSignal !== 'object'
      || typeof externalSignal.addEventListener !== 'function'
      || typeof externalSignal.removeEventListener !== 'function'
      || typeof externalSignal.aborted !== 'boolean'
    )) throw new CreatorSimulationPolicyError('creator_simulation_signal_invalid');
    if (externalSignal?.aborted) {
      return cancelledInputResult(runId, now);
    }
    manifestInput = rawInput.manifest;
    catalogInput = rawInput.catalogSnapshot;
    actions = rawInput.actions;
    timeoutMs = rawInput.timeoutMs;
    const snapshot = snapshotActions(actions);
    actionSnapshot = snapshot.actions;
    actionValidationError = snapshot.validationError;
    if (actionValidationError) return failedInputResult(runId, now, actionValidationError.code);
  } catch (error) {
    if (error instanceof CreatorSimulationPolicyError) {
      return failedInputResult(runId, now, error.code);
    }
    return failedInputResult(runId, now, 'creator_simulation_input_invalid');
  }
  const schema = validateCreatorPresetManifest(manifestInput);
  let catalogResult: { valid: boolean; catalog: CreatorCapabilityDescriptor[] };
  try {
    catalogResult = validateCreatorCatalogSnapshot(catalogInput);
  } catch {
    catalogResult = { valid: false, catalog: [] };
  }
  if (!schema.ok) {
    return failedInputResult(runId, now, 'creator_simulation_manifest_invalid');
  }
  if (!catalogResult.valid || catalogResult.catalog.length > CREATOR_SIMULATION_LIMITS.maxCatalogEntries) {
    return failedInputResult(runId, now);
  }
  const manifest = deepFreeze(schema.value);
  const catalogSnapshot = deepFreeze(cloneValue(catalogResult.catalog));
  const trajectory: CreatorTrajectoryEvent[] = [];
  const effects: CreatorSimulationEffect[] = [];
  const seenEffects = new Set<string>();
  const controller = new AbortController();
  let timedOut = false;
  let closed = false;
  let disposalPromise: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = () => controller.abort();
  let inScopeCreatedHook = false;

  try {
    if (externalSignal !== undefined && (
      typeof externalSignal !== 'object'
      || typeof externalSignal.addEventListener !== 'function'
      || typeof externalSignal.removeEventListener !== 'function'
      || typeof externalSignal.aborted !== 'boolean'
    )) throw new CreatorSimulationPolicyError('creator_simulation_signal_invalid');
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  } catch (error) {
    try { externalSignal?.removeEventListener('abort', onExternalAbort); } catch { /* contain hostile signals */ }
    return failedInputResult(runId, now, error instanceof CreatorSimulationPolicyError
      ? error.code
      : 'creator_simulation_signal_invalid');
  }
  if (timeoutMs === undefined) timeoutMs = CREATOR_DEFAULT_SIMULATION_TIMEOUT_MS;
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      try { externalSignal?.removeEventListener('abort', onExternalAbort); } catch { /* stable input error below */ }
      throw new Error('creator_simulation_timeout_invalid');
    }
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  const appendTrajectory = (event: CreatorTrajectoryEvent): void => {
    if (trajectory.length >= CREATOR_SIMULATION_LIMITS.maxTrajectoryEvents) {
      throw new CreatorSimulationPolicyError('creator_simulation_trajectory_too_large');
    }
    trajectory.push(deepFreeze({ ...event }));
  };
  const emit = async (event: CreatorTrajectoryEvent): Promise<void> => {
    if (closed) throw new CreatorSimulationPolicyError('creator_simulation_scope_closed');
    appendTrajectory(event);
  };
  const scope: CreatorSimulationScope = Object.freeze({
    runId,
    manifest,
    catalogSnapshot,
    signal: controller.signal,
    emit,
    async dispose(): Promise<void> {
      if (disposalPromise) return disposalPromise;
      closed = true;
      const wasAborted = controller.signal.aborted;
      controller.abort();
      disposalPromise = (async () => {
        if (timeout !== undefined) clearTimeout(timeout);
        try {
          externalSignal?.removeEventListener('abort', onExternalAbort);
        } catch {
          throw new CreatorSimulationPolicyError('creator_simulation_scope_dispose_failed');
        }
        try { appendTrajectory({ type: 'scope.disposed', at: now() }); } catch { /* cleanup still runs at the bound */ }
        try {
          const operation = observePromise(Promise.resolve(deps.onScopeDisposed?.(runId)));
          const cleanupSignal = wasAborted || inScopeCreatedHook
            ? controller.signal
            : new AbortController().signal;
          await awaitDisposal(operation, cleanupSignal);
        } catch (error) {
          if (isAbortError(error) || wasAborted || inScopeCreatedHook) return;
          if (error instanceof CreatorSimulationPolicyError
            && error.code === 'creator_simulation_scope_dispose_timeout') throw error;
          throw new CreatorSimulationPolicyError('creator_simulation_scope_dispose_failed');
        }
      })();
      return disposalPromise;
    },
  });

  let result: CreatorSimulationResult | undefined;
  try {
    throwIfAborted(scope.signal);
    inScopeCreatedHook = true;
    await awaitAbortable(deps.onScopeCreated?.(scope), scope.signal);
    inScopeCreatedHook = false;
    throwIfAborted(scope.signal);
    await emit({ type: 'scope.started', at: now() });
    if (actionValidationError) throw actionValidationError;
    for (const action of actionSnapshot) {
      throwIfAborted(scope.signal);
      assertAction(action);
      if (action.kind === 'delay') {
        await abortableDelay(action.delayMs, scope.signal);
        continue;
      }
      if (seenEffects.has(action.idempotencyKey)) {
        await emit({
          type: 'effect.duplicate',
          at: now(),
          capabilityId: action.capabilityId,
          idempotencyKey: action.idempotencyKey,
        });
        continue;
      }

      let effect: CreatorSimulationEffect;
      if (action.kind === 'local-read') {
        requireTool(scope, action.capabilityId);
        if (!scope.manifest.permissions.files.includes(action.fileGrant)) {
          throw new CreatorSimulationPolicyError('creator_simulation_file_denied');
        }
        effect = {
          kind: action.kind,
          capabilityId: action.capabilityId,
          idempotencyKey: action.idempotencyKey,
        };
      } else if (action.kind === 'mock-search') {
        requireTool(scope, action.capabilityId);
        effect = {
          kind: action.kind,
          capabilityId: action.capabilityId,
          idempotencyKey: action.idempotencyKey,
        };
      } else {
        throw new CreatorSimulationPolicyError('creator_simulation_executor_unknown');
      }

      const immutableEffect = deepFreeze({ ...effect });
      await awaitAbortable(deps.onEffect?.(immutableEffect, scope.signal), scope.signal);
      throwIfAborted(scope.signal);
      if (effects.length >= CREATOR_SIMULATION_LIMITS.maxEffects
        || (!seenEffects.has(action.idempotencyKey) && seenEffects.size >= CREATOR_SIMULATION_LIMITS.maxIdempotencyKeys)) {
        throw new CreatorSimulationPolicyError('creator_simulation_effects_too_large');
      }
      seenEffects.add(action.idempotencyKey);
      effects.push(immutableEffect);
      await emit({
        type: 'effect.applied',
        at: now(),
        capabilityId: effect.capabilityId,
        idempotencyKey: effect.idempotencyKey,
      });
    }
    throwIfAborted(scope.signal);
    await emit({ type: 'scope.completed', at: now() });
    result = { runId, status: 'passed', effects, trajectory };
  } catch (error) {
    inScopeCreatedHook = false;
    if (isAbortError(error) || closed) {
      const status = timedOut ? 'timed_out' as const : 'cancelled' as const;
      if (!closed) {
        try { await emit({ type: timedOut ? 'scope.timed_out' : 'scope.cancelled', at: now() }); } catch { /* bounded trajectory */ }
      }
      result = { runId, status, effects, trajectory };
    } else {
      const errorCode = error instanceof CreatorSimulationPolicyError
        ? error.code
        : 'creator_simulation_failed';
      try { await emit({ type: 'scope.failed', at: now(), errorCode }); } catch { /* bounded trajectory */ }
      result = { runId, status: 'failed', errorCode, effects, trajectory };
    }
  } finally {
    try {
      await scope.dispose();
    } catch (error) {
      if (!result || (result.status !== 'cancelled' && result.status !== 'timed_out')) {
        const errorCode = error instanceof CreatorSimulationPolicyError
          ? error.code
          : 'creator_simulation_scope_dispose_failed';
        if (result && error instanceof CreatorSimulationPolicyError) {
          try { await emit({ type: 'scope.failed', at: now(), errorCode }); } catch { /* trajectory is already bounded */ }
          result = { ...result, status: 'failed', errorCode };
        } else if (!result) {
          result = { runId, status: 'failed', errorCode, effects, trajectory };
        }
      }
    }
  }
  return result!;
}
