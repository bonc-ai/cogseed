import { createHash, randomUUID } from 'node:crypto';

import type { CreatorCapabilityDescriptor } from './catalog';
import { buildCreatorCapabilityCatalog, creatorCatalogLogicalId, validateCreatorCatalogSnapshot } from './catalog';
import { forEachOwnEnumerableCreatorKey, validateCreatorPresetManifest } from './schema';
import {
  runCreatorSimulation,
  type CreatorSimulationAction,
  type CreatorSimulationDependencies,
  type CreatorSimulationResult,
} from './simulation-service';
import type { CreatorPresetManifestV1 } from './types';

export interface CreatorVerificationCheck {
  id:
    | 'schema'
    | 'catalog-resolution'
    | 'tool-allow-list'
    | 'file-grants'
    | 'side-effects'
    | 'budget'
    | 'timeout'
    | 'cancel'
    | 'idempotency'
    | 'audit-trajectory'
    | 'agent-usefulness';
  status: 'passed' | 'failed';
  evidence: string[];
}

export interface CreatorVerificationReport {
  schemaVersion: 1;
  runId: string;
  presetId: string;
  manifestDigest: string;
  status: 'passed' | 'failed' | 'cancelled';
  checks: CreatorVerificationCheck[];
  startedAt: string;
  completedAt: string;
}

export interface CreatorVerificationInput {
  manifest: CreatorPresetManifestV1;
  catalogSnapshot: CreatorCapabilityDescriptor[];
  signal?: AbortSignal;
}

export interface CreatorVerificationDependencies extends CreatorSimulationDependencies {
  /** Trusted host catalog source. Caller-provided snapshots are hints only. */
  buildCatalog?: (userId: string, signal?: AbortSignal) => Promise<CreatorCapabilityDescriptor[]>;
}

const CHECK_IDS: CreatorVerificationCheck['id'][] = [
  'schema',
  'catalog-resolution',
  'tool-allow-list',
  'file-grants',
  'side-effects',
  'budget',
  'timeout',
  'cancel',
  'idempotency',
  'audit-trajectory',
  'agent-usefulness',
];

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') return '"[UNSUPPORTED]"';
  if (typeof value === 'undefined') return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (seen.has(value)) return '"[CYCLE]"';
  seen.add(value);
  if (Array.isArray(value)) {
    let length: number;
    try { length = value.length; } catch { throw new Error('creator_manifest_digest_invalid'); }
    if (!Number.isSafeInteger(length) || length > 256) throw new Error('creator_manifest_digest_invalid');
    const entries: string[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error('creator_manifest_digest_invalid');
      entries.push(stableStringify(value[index], seen));
    }
    const result = `[${entries.join(',')}]`;
    seen.delete(value);
    return result;
  }
  const keys: string[] = [];
  if (!forEachOwnEnumerableCreatorKey(value, 256, (key) => keys.push(key))) {
    throw new Error('creator_manifest_digest_invalid');
  }
  const result = `{${keys.sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key], seen)}`)
    .join(',')}}`;
  seen.delete(value);
  return result;
}

export function creatorManifestDigest(manifest: CreatorPresetManifestV1): string {
  let canonical = '{}';
  try { canonical = stableStringify(manifest); } catch { canonical = '{}'; }
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function check(
  id: CreatorVerificationCheck['id'],
  passed: boolean,
  successEvidence: string,
  failureEvidence: string,
): CreatorVerificationCheck {
  return {
    id,
    status: passed ? 'passed' : 'failed',
    evidence: [passed ? successEvidence : failureEvidence],
  };
}

function exactCatalogEntry(
  manifest: CreatorPresetManifestV1,
  catalog: readonly CreatorCapabilityDescriptor[],
  capabilityId: string,
): CreatorCapabilityDescriptor | undefined {
  const selected = manifest.capabilities.find((item) => item.capabilityId === capabilityId);
  if (!selected) return undefined;
  return catalog.find((item) => (
    item.capabilityId === capabilityId
    && item.version === selected.version
    && item.available
  ));
}

function policyChecks(
  manifest: CreatorPresetManifestV1,
  catalog: readonly CreatorCapabilityDescriptor[],
): CreatorVerificationCheck[] {
  const schema = validateCreatorPresetManifest(manifest);
  const modelId = creatorCatalogLogicalId('model', manifest.model?.providerId ?? '', manifest.model?.modelId ?? '');
  const modelAvailable = catalog.some((item) => item.kind === 'model' && item.available && item.capabilityId === modelId);
  const capabilitiesAvailable = Array.isArray(manifest.capabilities) && manifest.capabilities.every((selected) => (
    catalog.some((item) => item.available
      && item.capabilityId === selected.capabilityId
      && item.version === selected.version)
  ));
  const toolsAllowed = Array.isArray(manifest.permissions?.tools) && manifest.permissions.tools.every((toolId) => {
    const descriptor = exactCatalogEntry(manifest, catalog, toolId);
    return descriptor?.kind === 'tool';
  });
  const filesAllowed = Array.isArray(manifest.permissions?.files)
    && manifest.permissions.files.every((grant) => grant === 'workspace.readonly');
  const noSideEffects = Array.isArray(manifest.permissions?.sideEffects)
    && manifest.permissions.sideEffects.length === 0;
  const maxCost = manifest.runtime?.budget?.maxCost;
  const maxTokens = manifest.runtime?.budget?.maxTokens;
  const budgetAllowed = (maxCost === undefined || (Number.isFinite(maxCost) && maxCost >= 0 && maxCost <= 10_000))
    && (maxTokens === undefined || (Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 10_000_000));

  return [
    check('schema', schema.ok, 'manifest schema accepted', 'manifest schema rejected'),
    check('catalog-resolution', modelAvailable && capabilitiesAvailable,
      'model and capabilities resolved', 'model or capability is outside the available catalog'),
    check('tool-allow-list', toolsAllowed, 'all tools are selected catalog capabilities', 'tool is not selected or unavailable'),
    check('file-grants', filesAllowed, 'file grants are read-only', 'file grant exceeds the read-only simulation boundary'),
    check('side-effects', noSideEffects, 'no side effects requested', 'side effects are forbidden during verification'),
    check('budget', budgetAllowed, 'budget is inside fixed bounds', 'budget exceeds fixed bounds'),
    agentUsefulnessCheck(manifest, catalog),
  ];
}

function agentUsefulnessCheck(
  manifest: CreatorPresetManifestV1,
  catalog: readonly CreatorCapabilityDescriptor[],
): CreatorVerificationCheck {
  const agent = manifest.agent;
  if (!agent) {
    return {
      id: 'agent-usefulness',
      status: 'passed',
      evidence: ['no agent section; skipped'],
    };
  }

  const workflow = manifest.prompt.systemSections.join('\n');
  const evidence: string[] = [];
  for (const input of agent.inputs ?? []) {
    if (!workflow.includes(input.id)) {
      evidence.push(`input ${input.id} not referenced in workflow`);
    }
  }

  for (const capability of manifest.capabilities) {
    const descriptor = catalog.find((item) => (
      item.capabilityId === capability.capabilityId && item.version === capability.version
    ));
    if (descriptor?.kind !== 'skill') continue;
    const displayName = descriptor.displayName.trim();
    const capabilityLeaf = capability.capabilityId.split('.').at(-1) ?? capability.capabilityId;
    if (!workflow.includes(displayName) && !workflow.includes(capability.capabilityId) && !workflow.includes(capabilityLeaf)) {
      evidence.push(`skill ${displayName || capability.capabilityId} not referenced in workflow`);
    }
  }

  if (!/(停止规则|停止条件|stop(?:ping)?\s+rule|stop condition)/i.test(workflow)) {
    evidence.push('workflow lacks explicit stop rule');
  }
  if (!/(失败行为|失败处理|failure(?:\s+behavior|\s+handling)?|fallback)/i.test(workflow)) {
    evidence.push('workflow lacks failure behavior');
  }
  if (!agent.description_zh || !agent.description_en) {
    evidence.push('description is not bilingual');
  }

  return {
    id: 'agent-usefulness',
    status: evidence.length === 0 ? 'passed' : 'failed',
    evidence: evidence.length > 0 ? evidence : ['workflow covers inputs and skills with stop/failure rules; description is bilingual'],
  };
}

function selectedAction(
  manifest: CreatorPresetManifestV1,
  catalog: readonly CreatorCapabilityDescriptor[],
): CreatorSimulationAction | undefined {
  const search = manifest.permissions.tools.find((toolId) => toolId === 'tool.search')
    ?? manifest.permissions.tools.find((toolId) => exactCatalogEntry(manifest, catalog, toolId)?.kind === 'tool');
  if (!search) return undefined;
  if (search === 'tool.file') {
    return {
      kind: 'local-read', capabilityId: search,
      fileGrant: manifest.permissions.files[0] ?? 'workspace.readonly',
      idempotencyKey: 'verification-effect',
    };
  }
  return { kind: 'mock-search', capabilityId: search, idempotencyKey: 'verification-effect' };
}

function simulationPassed(result: CreatorSimulationResult): boolean {
  return result.status === 'passed';
}

function hasSimulationShape(manifest: CreatorPresetManifestV1): boolean {
  return Array.isArray(manifest.capabilities)
    && Array.isArray(manifest.permissions?.tools)
    && Array.isArray(manifest.permissions?.files)
    && Array.isArray(manifest.permissions?.sideEffects);
}

const MAX_VERIFICATION_PREFLIGHT_NODES = 512;
const MAX_VERIFICATION_PREFLIGHT_ARRAY = 256;

interface VerificationEnvelope {
  manifest: unknown;
  catalogSnapshot: unknown;
  signal?: AbortSignal;
  valid: boolean;
}

function readVerificationEnvelope(input: unknown): VerificationEnvelope {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { manifest: undefined, catalogSnapshot: undefined, valid: false };
    }
    const value = input as Record<string, unknown>;
    const signal = value.signal;
    if (signal !== undefined) {
      if (typeof signal !== 'object' || signal === null) {
        return { manifest: undefined, catalogSnapshot: undefined, valid: false };
      }
      const signalValue = signal as Record<string, unknown>;
      if (typeof signalValue.aborted !== 'boolean'
        || typeof signalValue.addEventListener !== 'function'
        || typeof signalValue.removeEventListener !== 'function') {
        return { manifest: undefined, catalogSnapshot: undefined, valid: false };
      }
    }
    return {
      manifest: value.manifest,
      catalogSnapshot: value.catalogSnapshot,
      signal: signal as AbortSignal | undefined,
      valid: true,
    };
  } catch {
    return { manifest: undefined, catalogSnapshot: undefined, valid: false };
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  try { return signal?.aborted === true; } catch { return true; }
}

async function awaitVerificationOperation<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const settled = Promise.resolve(operation);
  void settled.catch(() => undefined);
  if (!signal) return settled;
  if (signalAborted(signal)) return Promise.reject(new Error('creator_verification_cancelled'));
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('creator_verification_cancelled'));
    try { signal.addEventListener('abort', onAbort, { once: true }); }
    catch { try { signal.removeEventListener('abort', onAbort); } catch { /* contain hostile signals */ } reject(new Error('creator_verification_cancelled')); }
  });
  try { return await Promise.race([settled, aborted]); }
  finally { try { signal.removeEventListener('abort', onAbort); } catch { /* contain hostile signals */ } }
}

/** Inspect invalid input only far enough to retain a safe, useful preset id. */
function safeManifestFallback(value: unknown): CreatorPresetManifestV1 {
  if (!value || typeof value !== 'object') return {} as CreatorPresetManifestV1;
  try {
    if (Array.isArray(value)) return {} as CreatorPresetManifestV1;
  } catch {
    return {} as CreatorPresetManifestV1;
  }
  let presetId: unknown;
  try { presetId = (value as Record<string, unknown>).presetId; } catch { return {} as CreatorPresetManifestV1; }

  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  let nodes = 0;
  try {
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current === 'bigint' || typeof current === 'function' || typeof current === 'symbol') {
        return {} as CreatorPresetManifestV1;
      }
      if (!current || typeof current !== 'object') continue;
      if (seen.has(current)) return {} as CreatorPresetManifestV1;
      seen.add(current);
      if (++nodes > MAX_VERIFICATION_PREFLIGHT_NODES) return {} as CreatorPresetManifestV1;
      if (Array.isArray(current)) {
        if (current.length > MAX_VERIFICATION_PREFLIGHT_ARRAY) return {} as CreatorPresetManifestV1;
        for (let index = 0; index < current.length; index += 1) {
          if (Object.prototype.hasOwnProperty.call(current, index)) pending.push(current[index]);
        }
        continue;
      }
      let keys = 0;
      if (!forEachOwnEnumerableCreatorKey(current, MAX_VERIFICATION_PREFLIGHT_ARRAY, (key) => {
        if (++keys > MAX_VERIFICATION_PREFLIGHT_ARRAY) throw new Error('creator_verification_preflight_too_large');
        pending.push((current as Record<string, unknown>)[key]);
      })) return {} as CreatorPresetManifestV1;
    }
  } catch {
    return {} as CreatorPresetManifestV1;
  }
  return typeof presetId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(presetId)
    ? { presetId } as CreatorPresetManifestV1
    : {} as CreatorPresetManifestV1;
}

async function dynamicChecks(
  userId: string,
  input: CreatorVerificationInput,
  deps: CreatorVerificationDependencies,
): Promise<CreatorVerificationCheck[]> {
  let counter = 0;
  const simulationDeps: CreatorSimulationDependencies = {
    createId: () => `verify-sim-${counter++}`,
    onEffect: deps.onEffect,
    onScopeCreated: deps.onScopeCreated,
    onScopeDisposed: deps.onScopeDisposed,
  };
  const cancelledChecks = (): CreatorVerificationCheck[] => CHECK_IDS.slice(7, 11).map((id) => check(
    id,
    false,
    '',
    'check cancelled before simulation started',
  ));
  const baseAction = selectedAction(input.manifest, input.catalogSnapshot);
  const ordinary = await runCreatorSimulation(userId, {
    manifest: input.manifest,
    catalogSnapshot: input.catalogSnapshot,
    actions: baseAction ? [baseAction] : [],
    signal: input.signal,
  }, simulationDeps);
  if (signalAborted(input.signal)) return cancelledChecks();

  const timeout = await runCreatorSimulation(userId, {
    manifest: input.manifest,
    catalogSnapshot: input.catalogSnapshot,
    actions: [{ kind: 'delay', delayMs: 10 }],
    timeoutMs: 1,
    signal: input.signal,
  }, simulationDeps);
  if (signalAborted(input.signal)) return cancelledChecks();

  const cancelController = new AbortController();
  cancelController.abort();
  const cancelled = await runCreatorSimulation(userId, {
    manifest: input.manifest,
    catalogSnapshot: input.catalogSnapshot,
    actions: [{ kind: 'delay', delayMs: 10 }],
    signal: cancelController.signal,
  }, simulationDeps);
  if (signalAborted(input.signal)) return cancelledChecks();

  let idempotencyCheck: CreatorVerificationCheck;
  if (baseAction && baseAction.kind !== 'delay') {
    const duplicate = await runCreatorSimulation(userId, {
      manifest: input.manifest,
      catalogSnapshot: input.catalogSnapshot,
      actions: [baseAction, baseAction],
      signal: input.signal,
    }, simulationDeps);
    if (signalAborted(input.signal)) return cancelledChecks();
    const idempotencyPassed = simulationPassed(duplicate)
      && duplicate.effects.length === 1
      && duplicate.trajectory.some((event) => event.type === 'effect.duplicate');
    idempotencyCheck = check(
      'idempotency',
      idempotencyPassed,
      'duplicate idempotency key produced one effect',
      'idempotency could not be proven',
    );
  } else {
    idempotencyCheck = {
      id: 'idempotency',
      status: 'passed',
      evidence: ['no effect-capable tool selected; idempotency is not applicable'],
    };
  }

  const auditPassed = ordinary.trajectory[0]?.type === 'scope.started'
    && ordinary.trajectory.some((event) => event.type === 'scope.disposed')
    && ordinary.trajectory.every((event) => typeof event.at === 'string' && event.at.length > 0);

  if (signalAborted(input.signal)) return cancelledChecks();
  return [
    check('timeout', timeout.status === 'timed_out', 'timeout cancelled and disposed the scope', 'timeout boundary did not fire'),
    check('cancel', cancelled.status === 'cancelled', 'caller cancellation disposed the scope', 'caller cancellation boundary failed'),
    idempotencyCheck,
    check('audit-trajectory', auditPassed, 'trajectory contains bounded start and disposal events', 'trajectory is incomplete'),
  ];
}

export async function verifyCreatorPreset(
  userId: string,
  input: CreatorVerificationInput,
  deps: CreatorVerificationDependencies = {},
): Promise<CreatorVerificationReport> {
  const now = deps.now ?? (() => new Date().toISOString());
  const runId = (deps.createId ?? randomUUID)();
  const startedAt = now();
  const envelope = readVerificationEnvelope(input);
  const rawManifest = envelope.manifest;
  const schema = validateCreatorPresetManifest(rawManifest);
  const manifest = schema.ok ? schema.value : safeManifestFallback(rawManifest);
  if (signalAborted(envelope.signal)) {
    return {
      schemaVersion: 1,
      runId,
      presetId: typeof manifest.presetId === 'string' ? manifest.presetId : 'invalid-preset',
      manifestDigest: creatorManifestDigest(manifest),
      status: 'cancelled',
      checks: CHECK_IDS.map((id) => check(id, false, '', 'check cancelled before catalog resolution')),
      startedAt,
      completedAt: now(),
    };
  }
  let catalogResult: { valid: boolean; catalog: CreatorCapabilityDescriptor[] };
  try {
    catalogResult = envelope.valid
      ? validateCreatorCatalogSnapshot(envelope.catalogSnapshot)
      : { valid: false, catalog: [] };
  } catch {
    catalogResult = { valid: false, catalog: [] };
  }
  if (schema.ok && catalogResult.valid) {
    try {
      const buildCatalog = deps.buildCatalog ?? ((id: string, signal?: AbortSignal) => buildCreatorCapabilityCatalog(id, { signal }));
      const trustedSnapshot = await awaitVerificationOperation(buildCatalog(userId, envelope.signal), envelope.signal);
      catalogResult = validateCreatorCatalogSnapshot(trustedSnapshot);
    } catch {
      catalogResult = { valid: false, catalog: [] };
    }
  }
  const catalog = catalogResult.catalog;
  let orderedChecks: CreatorVerificationCheck[];
  if (!schema.ok || !catalogResult.valid) {
    orderedChecks = CHECK_IDS.map((id) => check(
      id,
      false,
      '',
      id === 'schema' ? 'manifest schema rejected' : 'check skipped because manifest schema is invalid',
    ));
  } else if (hasSimulationShape(manifest)) {
    const checks = [
      ...policyChecks(manifest, catalog),
      ...await dynamicChecks(userId, { manifest, catalogSnapshot: catalog, signal: envelope.signal }, deps),
    ];
    orderedChecks = CHECK_IDS.map((id) => checks.find((entry) => entry.id === id)!);
  } else {
    orderedChecks = CHECK_IDS.map((id) => check(
      id,
      false,
      '',
      id === 'schema' && !schema.ok
        ? 'manifest schema rejected'
        : 'check skipped because manifest structure is incomplete',
    ));
  }
  const status = signalAborted(envelope.signal)
    ? 'cancelled' as const
    : orderedChecks.some((entry) => entry.status === 'failed') ? 'failed' as const : 'passed' as const;
  return {
    schemaVersion: 1,
    runId,
    presetId: typeof manifest.presetId === 'string' ? manifest.presetId : 'invalid-preset',
    manifestDigest: creatorManifestDigest(manifest),
    status,
    checks: orderedChecks,
    startedAt,
    completedAt: now(),
  };
}
