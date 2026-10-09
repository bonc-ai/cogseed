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
});
