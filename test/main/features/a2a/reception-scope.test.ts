import { describe, expect, it } from 'vitest';
import {
  A2A_RECEPTION_TOOL_POLICY,
  applyA2AReceptionScope,
  isReceptionRun,
  receptionReadRoots,
  toolPolicyForConversation,
} from '../../../../src/main/features/a2a/reception-scope';
import type { A2AConversationMarker } from '../../../../src/main/features/a2a/conversation-marker';

/**
 * The reception ceiling is the hard boundary from PRD D-18/R-12: the model is not
 * asked to stay in scope, it is handed a policy that cannot leave it. These cases
 * pin that the scope never widens and that only an *active receiver* is scoped —
 * the initiator's own conversation keeps its normal permissions.
 */
const receiver: A2AConversationMarker = { role: 'receiver', peer_user_id: 'cs_alice', state: 'active' };

describe('a2a reception › scope ceiling', () => {
  it('allows write and shell only behind per-action approval, and keeps the rest closed', () => {
    // 设计 §5 L2/§3.6 L3：写与执行可以做，但每次都要接收方本人批准；网络/连接器/技能仍关。
    expect(A2A_RECEPTION_TOOL_POLICY).toMatchObject({
      fileWrite: 'explicit_writable_roots',
      shell: 'allow_with_confirmation',
      network: 'none',
      connectors: 'none',
      skillRun: 'none',
    });
  });

  it('never widens a stricter base policy', () => {
    const denyAll = {
      fileRead: 'none' as const, fileWrite: 'none' as const, shell: 'none' as const,
      skillRun: 'none' as const, network: 'none' as const, connectors: 'none' as const,
    };
    expect(applyA2AReceptionScope(denyAll)).toEqual(denyAll);
  });

  it('keeps reads only when the base allowed them', () => {
    const permissive = {
      fileRead: 'explicit_roots' as const, fileWrite: 'explicit_writable_roots' as const,
      shell: 'allow_with_confirmation' as const, skillRun: 'allowlisted_skills' as const,
      network: 'none' as const, connectors: 'enabled' as const,
    };
    expect(applyA2AReceptionScope(permissive)).toEqual({
      fileRead: 'explicit_roots', fileWrite: 'explicit_writable_roots', shell: 'allow_with_confirmation',
      skillRun: 'none', network: 'none', connectors: 'none',
    });
    expect(applyA2AReceptionScope(null)).toMatchObject({
      fileRead: 'explicit_roots', fileWrite: 'explicit_writable_roots', shell: 'allow_with_confirmation',
    });
  });
});

describe('a2a reception › which conversations are scoped', () => {
  const base = {
    fileRead: 'explicit_roots' as const, fileWrite: 'explicit_writable_roots' as const,
    shell: 'allow_with_confirmation' as const, skillRun: 'none' as const,
    network: 'none' as const, connectors: 'enabled' as const,
  };

  it('scopes only an active receiving conversation', () => {
    expect(isReceptionRun(receiver)).toBe(true);
    expect(isReceptionRun({ ...receiver, state: 'waiting' })).toBe(false);
    expect(isReceptionRun({ ...receiver, role: 'initiator' })).toBe(false);
    expect(isReceptionRun(null)).toBe(false);
  });

  it('leaves the initiator conversation on its own policy', () => {
    const initiator: A2AConversationMarker = { role: 'initiator', peer_user_id: 'cs_bob', state: 'active' };
    expect(toolPolicyForConversation(base, initiator)).toEqual(base);
    expect(toolPolicyForConversation(base, null)).toEqual(base);
  });

  it('tightens the receiving conversation', () => {
    const scoped = toolPolicyForConversation(base, receiver);
    expect(scoped).toMatchObject({ fileWrite: 'explicit_writable_roots', shell: 'allow_with_confirmation', connectors: 'none' });
  });
});

describe('a2a reception › read roots', () => {
  it('uses the granted workspace only', () => {
    expect(receptionReadRoots({ ...receiver, workspace: '/ws/a' }, '/fallback')).toEqual(['/ws/a']);
  });

  it('falls back to the run workspace when none was granted', () => {
    expect(receptionReadRoots(receiver, '/fallback')).toEqual(['/fallback']);
    expect(receptionReadRoots(receiver, null)).toEqual([]);
  });
});

describe('a2a reception › stricter base stays stricter', () => {
  it('keeps a low_risk_only base instead of widening it to allow_with_confirmation', () => {
    const base = {
      fileRead: 'explicit_roots' as const, fileWrite: 'none' as const, shell: 'low_risk_only' as const,
      skillRun: 'none' as const, network: 'none' as const, connectors: 'none' as const,
    };
    const scoped = applyA2AReceptionScope(base);
    expect(scoped.shell).toBe('low_risk_only');
    // 写：基策略关着就不放开。
    expect(scoped.fileWrite).toBe('none');
  });
});
