import type { P3394BridgeManifest } from './manifest';
import { validateP3394BridgeManifest } from './manifest';

export interface P3394DoctorCheck { name: string; status: 'pass' | 'fail' | 'warn'; reason?: string }
export interface P3394DoctorReport { ok: boolean; checks: P3394DoctorCheck[] }

export interface P3394DoctorInput {
  manifest?: unknown;
  /** True when the local peer registry has been persisted/loaded (Agent Home). */
  registryPersisted?: boolean;
  /** True when the Agent Home directory exists on disk. */
  agentHomeExists?: boolean;
  /** True when a real CogSeed runtime adapter is bound. */
  runtimeAdapterBound?: boolean;
  /** True when at least one channel adapter is registered. */
  channelAdapterBound?: boolean;
  /** True when the content-addressed object store is present. */
  objectStorePresent?: boolean;
  /** True when §11 result auto-reply is enabled. */
  autoReplyEnabled?: boolean;
  /** Missing required channel capabilities (empty array = all present). */
  channelCapabilitiesMissing?: string[];
  /** Whether replay protection and idempotency are wired into the bridge. */
  replayProtectionBound?: boolean;
  idempotencyBound?: boolean;
  /** Whether the audit journal and authorization policy are wired. */
  auditJournalBound?: boolean;
  policyBound?: boolean;
  /** Missing resource controls such as frame, queue, rate and concurrency limits. */
  resourceLimitsMissing?: string[];
}

export function runP3394BridgeDoctor(input: P3394DoctorInput = {}): P3394DoctorReport {
  const checks: P3394DoctorCheck[] = [];
  if (input.manifest === undefined) {
    checks.push({ name: 'manifest', status: 'warn', reason: 'no manifest provided' });
  } else {
    const result = validateP3394BridgeManifest(input.manifest);
    if (result.ok === false) {
      checks.push({ name: 'manifest', status: 'fail', reason: result.error.reason });
    } else {
      checks.push({ name: 'manifest', status: 'pass' });
      const manifest = result.manifest as P3394BridgeManifest;
      checks.push({ name: 'identity', status: manifest.identity.agent_id ? 'pass' : 'fail' });
      checks.push({ name: 'local-channel', status: manifest.channels.some((c) => c.kind === 'local') ? 'pass' : 'fail' });
      // Conformance level: declared level must be backed by the real wiring
      // (SDK §17: "magic" must remain inspectable).
      const level = manifest.conformance.level;
      const levelOk = level === 'bridge-phase-1' || (manifest.conformance.registry && manifest.conformance.agent_home && manifest.conformance.runtime_adapter);
      checks.push({
        name: 'conformance-level',
        status: levelOk ? 'pass' : 'fail',
        reason: levelOk ? 'declared ' + level : 'level ' + level + ' is not backed by registry/agent-home/runtime-adapter support',
      });
      const caps = manifest.conformance.capabilities;
      if (caps) {
        checks.push({
          name: 'conformance-capabilities',
          status: 'pass',
          reason: ['sessions', 'artifacts', 'streaming', 'cancellation', 'restart_recovery', 'multi_party_sessions', 'delegation', 'checkpoints', 'resource_policy']
            .filter((key) => (caps as unknown as Record<string, boolean>)[key])
            .join(',') || 'no capabilities declared',
        });
      }
    }
  }

  if (input.registryPersisted === undefined) {
    checks.push({ name: 'registry', status: 'warn', reason: 'registry persistence not reported' });
  } else {
    checks.push({ name: 'registry', status: input.registryPersisted ? 'pass' : 'fail', reason: input.registryPersisted ? undefined : 'peer registry is not persisted' });
  }

  if (input.agentHomeExists === undefined) {
    checks.push({ name: 'agent-home', status: 'warn', reason: 'agent home not reported' });
  } else {
    checks.push({ name: 'agent-home', status: input.agentHomeExists ? 'pass' : 'fail', reason: input.agentHomeExists ? undefined : 'agent home directory missing' });
  }

  if (input.runtimeAdapterBound === undefined) {
    checks.push({ name: 'runtime-adapter', status: 'warn', reason: 'runtime adapter binding not reported' });
  } else {
    checks.push({ name: 'runtime-adapter', status: input.runtimeAdapterBound ? 'pass' : 'fail', reason: input.runtimeAdapterBound ? undefined : 'no real CogSeed runtime adapter bound' });
  }

  if (input.channelAdapterBound === undefined) {
    checks.push({ name: 'channel-adapter', status: 'warn', reason: 'channel adapter registration not reported' });
  } else {
    checks.push({ name: 'channel-adapter', status: input.channelAdapterBound ? 'pass' : 'fail', reason: input.channelAdapterBound ? undefined : 'no channel adapter registered' });
  }

  if (input.channelCapabilitiesMissing === undefined) {
    checks.push({ name: 'channel-capabilities', status: 'warn', reason: 'required channel capability check not reported' });
  } else if (Array.isArray(input.channelCapabilitiesMissing) && input.channelCapabilitiesMissing.length > 0) {
    checks.push({ name: 'channel-capabilities', status: 'fail', reason: 'channel cannot carry required semantics: ' + input.channelCapabilitiesMissing.join(', ') });
  } else {
    checks.push({ name: 'channel-capabilities', status: 'pass' });
  }

  if (input.objectStorePresent === undefined) {
    checks.push({ name: 'object-store', status: 'warn', reason: 'object store presence not reported' });
  } else {
    checks.push({ name: 'object-store', status: input.objectStorePresent ? 'pass' : 'fail', reason: input.objectStorePresent ? undefined : 'content-addressed object store missing' });
  }

  if (input.autoReplyEnabled === undefined) {
    checks.push({ name: 'auto-reply', status: 'warn', reason: '§11 auto reply state not reported' });
  } else {
    checks.push({ name: 'auto-reply', status: input.autoReplyEnabled ? 'pass' : 'warn', reason: input.autoReplyEnabled ? '§11 result auto reply-back enabled' : '§11 result auto reply-back disabled' });
  }

  const booleanBindings: Array<[string, boolean | undefined, string]> = [
    ['replay-protection', input.replayProtectionBound, 'replay protection binding not reported'],
    ['idempotency', input.idempotencyBound, 'idempotency binding not reported'],
    ['audit-journal', input.auditJournalBound, 'audit journal binding not reported'],
    ['policy', input.policyBound, 'authorization policy binding not reported'],
  ];
  for (const [name, value, missingReason] of booleanBindings) {
    checks.push({ name, status: value === undefined ? 'warn' : value ? 'pass' : 'fail', ...(value === undefined ? { reason: missingReason } : value ? {} : { reason: name + ' is not bound' }) });
  }
  if (input.resourceLimitsMissing === undefined) {
    checks.push({ name: 'resource-limits', status: 'warn', reason: 'resource limit checks not reported' });
  } else if (input.resourceLimitsMissing.length > 0) {
    checks.push({ name: 'resource-limits', status: 'fail', reason: 'missing resource limits: ' + input.resourceLimitsMissing.join(', ') });
  } else {
    checks.push({ name: 'resource-limits', status: 'pass' });
  }

  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}
