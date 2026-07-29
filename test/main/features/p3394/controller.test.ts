import { describe, it, expect } from 'vitest';

function baseAgent(overrides: Record<string, any> = {}) {
  return {
    agent_id: 'agent-writer', name: 'Writer', description_zh: '', description_en: '',
    workflow: '', category: 'writing', source: 'custom',
    created_at: '2026-07-25T00:00:00.000Z', updated_at: '2026-07-25T00:00:00.000Z', enabled: true,
    interface_contract: {
      version: 1, role: 'orkas_core', runtime: { kind: 'in_process' },
      io: { input: 'task_message', output: 'final_message' },
      governance: { session_role: 'owner_capable', data_scope: 'visibility_slice_with_workspace', uses_mate_skills: true, records_process: true, records_tool_evidence: true },
    },
    ...overrides,
  };
}
function baseInput(overrides: Record<string, any> = {}) {
  return {
    agent: baseAgent() as any, conversationId: 'gconv-demo', turnId: 'turn-1',
    sender: 'commander', senderPrincipal: { person: 'user-local', org: 'local', role: 'owner' },
    relationship: 'owner' as const, speechAct: 'request' as const, capability: 'handle_message',
    body: { task: 'x' }, uid: 'u1', sessionId: 'gconv-demo',
    ...overrides,
  };
}
const okDeps = () => ({
  sessionSource: { resolve: async (sid: string) => ({ sessionId: sid, kind: 'gconv', region: 'cloud', valid: true }) },
  epochStore: { current: async () => 0, nextEpoch: async () => 1 },
  contextSource: { snapshot: async () => null },
});

describe('P3394Controller.admitMessage — session', () => {
  it('合法消息放行,metadata 带真实 kind/region + epoch', async () => {
    const { P3394Controller } = await import('../../../../src/main/features/p3394/controller');
    const c = new P3394Controller(okDeps() as any);
    const r = await c.admitMessage(baseInput());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.body.detail);
    expect((r.message.metadata as any).session_kind).toBe('gconv');
    expect(r.message.metadata.session_epoch).toBe(1);
  });

  it('内核校验失败(委托提权)仍被拦截', async () => {
    const { P3394Controller } = await import('../../../../src/main/features/p3394/controller');
    const c = new P3394Controller(okDeps() as any);
    const r = await c.admitMessage(baseInput({
      relationship: 'client', speechAct: 'request',
      senderPrincipal: { person: 'u', org: 'l', role: 'client' },
      delegation: { original_principal: { person: 'u', org: 'l', role: 'client' }, original_relationship: 'client', delegation_chain: [{ delegator: 'x', delegate: 'y', inherited_relationship: 'owner' }] },
    }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('should reject');
    expect(r.error.body.detail).toMatch(/escalat/i);
  });

  it('session 解析失败降级放行,标 session_resolved:false', async () => {
    const { P3394Controller } = await import('../../../../src/main/features/p3394/controller');
    const deps = okDeps();
    deps.sessionSource.resolve = async () => { throw new Error('io fail'); };
    const c = new P3394Controller(deps as any);
    const r = await c.admitMessage(baseInput());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('should pass degraded');
    expect((r.message.metadata as any).session_resolved).toBe(false);
  });
});
