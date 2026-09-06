/**
 * V-01：wiring → Doctor 输入装配的纯函数测试。app-wiring 收集的实时事实
 * 通过 buildP3394WiringDoctorInput 映射成完整检查，全绑定 → 全 pass，
 * 任一缺口 → 对应 fail 且不虚报。
 */

import { describe, expect, it } from 'vitest';
import {
  buildP3394WiringDoctorInput,
  runP3394BridgeDoctor,
  type P3394WiringDoctorFacts,
} from '../../../../src/main/features/p3394_bridge/doctor';

function allFacts(overrides: Partial<P3394WiringDoctorFacts> = {}): P3394WiringDoctorFacts {
  return {
    agentHomeExists: true,
    registryPersisted: true,
    runtimeAdapterBound: true,
    replayProtectionBound: true,
    idempotencyBound: true,
    auditJournalBound: true,
    policyBound: true,
    channelAdapterBound: true,
    objectStorePresent: true,
    channelCapabilitiesMissing: [],
    resourceLimitsMissing: [],
    autoReplyEnabled: true,
    ...overrides,
  };
}

function manifestFor(id: string) {
  return {
    spec_version: 'p3394/1.0',
    identity: { agent_id: id, display_name: id },
    runtime: { kind: 'in_process' },
    capability_profile: { agent_id: id, runtime_kind: 'cogseed-native', capabilities: ['handle_message'], supported_performatives: ['request', 'response', 'inform', 'accept', 'reject', 'cancel', 'error', 'negotiate'], supports_streaming: false, supports_artifacts: false },
    channels: [{ id: 'local-agent-bridge', kind: 'local', direction: 'inbound-outbound' }],
    session: { scope: 'per-conversation', requires_session_id: true },
    security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true },
    conformance: { level: 'bridge-phase-1', registry: false, agent_home: false, runtime_adapter: false },
  } as never;
}

describe('P3394 wiring doctor input assembly (V-01)', () => {
  it('fully bound wiring reports all pass', () => {
    const report = runP3394BridgeDoctor(buildP3394WiringDoctorInput(allFacts()));
    expect(report.ok).toBe(true);
    const passNames = [
      'registry', 'agent-home', 'runtime-adapter', 'replay-protection',
      'idempotency', 'audit-journal', 'policy', 'channel-adapter',
      'object-store', 'channel-capabilities', 'resource-limits', 'auto-reply',
    ];
    for (const name of passNames) {
      expect(report.checks.find((check) => check.name === name)?.status, name).toBe('pass');
    }
  });

  it('an unbound replay protector fails the report', () => {
    const report = runP3394BridgeDoctor(buildP3394WiringDoctorInput(allFacts({ replayProtectionBound: false })));
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.name === 'replay-protection');
    expect(check?.status).toBe('fail');
    expect(check?.reason).toBe('replay-protection is not bound');
  });

  it('missing resource limits fail and name the gaps', () => {
    const report = runP3394BridgeDoctor(buildP3394WiringDoctorInput(allFacts({ resourceLimitsMissing: ['queue', 'rate'] })));
    const check = report.checks.find((c) => c.name === 'resource-limits');
    expect(check?.status).toBe('fail');
    expect(check?.reason).toContain('queue');
    expect(check?.reason).toContain('rate');
    expect(report.ok).toBe(false);
  });

  it('missing channel capabilities fail and name the semantics', () => {
    const report = runP3394BridgeDoctor(buildP3394WiringDoctorInput(allFacts({ channelCapabilitiesMissing: ['cancellation', 'multi_party_sessions'] })));
    const check = report.checks.find((c) => c.name === 'channel-capabilities');
    expect(check?.status).toBe('fail');
    expect(check?.reason).toContain('cancellation');
    expect(check?.reason).toContain('multi_party_sessions');
  });

  it('maps every §16 prototype acceptance item to a check ref (guide v1.1 §16)', () => {
    const report = runP3394BridgeDoctor(buildP3394WiringDoctorInput(allFacts({ manifest: manifestFor('doctor-agent') })));
    for (let item = 1; item <= 15; item += 1) {
      const ref = `§16-${item}`;
      const matching = report.checks.filter((check) => check.ref === ref);
      expect(matching.length > 0, ref).toBe(true);
      // 每条 §16 检查只有 pass（wiring 可证）或 warn（需运行时验证），不虚报 fail。
      for (const check of matching) {
        expect(['pass', 'warn'], `${ref} → ${check.name}`).toContain(check.status);
      }
    }
  });

  it('runtime-verification items stay warn without breaking ok (§16-5/8/10/13/14…)', () => {
    const report = runP3394BridgeDoctor(buildP3394WiringDoctorInput(allFacts({ manifest: manifestFor('doctor-agent') })));
    expect(report.ok).toBe(true);
    const runtimeVerificationNames = [
      'envelope-immutability', 'session-continuity', 'goal-isolation',
      'restart-recovery', 'kstar-episodes', 'remote-fallback', 'reduced-profile',
    ];
    for (const name of runtimeVerificationNames) {
      const check = report.checks.find((c) => c.name === name);
      expect(check, name).toBeDefined();
      expect(check?.status, name).toBe('warn');
      expect(check?.reason, name).toContain('runtime verification');
    }
  });
});
