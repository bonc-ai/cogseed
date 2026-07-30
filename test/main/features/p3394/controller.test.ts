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
  epochStore: { admit: async (_u: string, _s: string, inc?: number) => ({ replay: false, epoch: inc ?? 1 }) },
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

describe('P3394Controller.admitMessage — epoch 重放', () => {
  const sess = { resolve: async (sid: string) => ({ sessionId: sid, kind: 'gconv', region: 'cloud', valid: true }) };
  it('不同 sender 对同一 recipient session 的相同 epoch 不互相碰撞', async () => {
    const { P3394Controller } = await import('../../../../src/main/features/p3394/controller');
    const watermarks = new Map<string, number>();
    const epochStore = {
      admit: async (_uid: string, streamId: string, incomingEpoch?: number) => {
        const current = watermarks.get(streamId) || 0;
        if (incomingEpoch !== undefined && incomingEpoch <= current) {
          return { replay: true, epoch: current };
        }
        const next = incomingEpoch ?? current + 1;
        watermarks.set(streamId, next);
        return { replay: false, epoch: next };
      },
    };
    const c = new P3394Controller({ sessionSource: sess, epochStore, contextSource: { snapshot: async () => null } } as any);

    expect((await c.admitMessage(baseInput({ sender: 'agent-a', incomingEpoch: 1 }))).ok).toBe(true);
    expect((await c.admitMessage(baseInput({ sender: 'agent-b', incomingEpoch: 1 }))).ok).toBe(true);
    const replay = await c.admitMessage(baseInput({ sender: 'agent-a', incomingEpoch: 1 }));
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('should reject same-stream replay');
    expect(replay.error.body.reason_code).toBe('replay_detected');
  });

  it('incomingEpoch <= 水位 → 拒 replay_detected', async () => {
    const { P3394Controller } = await import('../../../../src/main/features/p3394/controller');
    const c = new P3394Controller({ sessionSource: sess, epochStore: { admit: async () => ({ replay: true, epoch: 5 }) }, contextSource: { snapshot: async () => null } } as any);
    const r = await c.admitMessage(baseInput({ incomingEpoch: 5 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('should reject');
    expect(r.error.body.reason_code).toBe('replay_detected');
  });
  it('EpochStore 故障 → 降级放行,epoch=0 + epoch_degraded', async () => {
    const { P3394Controller } = await import('../../../../src/main/features/p3394/controller');
    const c = new P3394Controller({ sessionSource: sess, epochStore: { admit: async () => { throw new Error('io'); } }, contextSource: { snapshot: async () => null } } as any);
    const r = await c.admitMessage(baseInput());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('should pass degraded');
    expect(r.message.metadata.session_epoch).toBe(0);
    expect((r.message.metadata as any).epoch_degraded).toBe(true);
  });
});

describe('P3394Controller.admitMessage — context 归属', () => {
  const sess = { resolve: async (sid: string) => ({ sessionId: sid, kind: 'gconv', region: 'cloud', valid: true }) };
  const epoch = { admit: async (_u: string, _s: string, inc?: number) => ({ replay: false, epoch: inc ?? 1 }) };
  const collab = (context_id: string) => ({ workflow_run_id: 'run-1', context_id, context_revision: 1 });
  it('context_id 越界 → 拒 context_scope_violation', async () => {
    const { P3394Controller } = await import('../../../../src/main/features/p3394/controller');
    const c = new P3394Controller({ sessionSource: sess, epochStore: epoch, contextSource: { snapshot: async () => ({ context_id: 'ctx-current', status: 'running' }) } } as any);
    const r = await c.admitMessage(baseInput({ collaboration: collab('ctx-other') }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('should reject');
    expect(r.error.body.reason_code).toBe('context_scope_violation');
  });
  it('context_id 相符 → 放行', async () => {
    const { P3394Controller } = await import('../../../../src/main/features/p3394/controller');
    const c = new P3394Controller({ sessionSource: sess, epochStore: epoch, contextSource: { snapshot: async () => ({ context_id: 'ctx-current', status: 'running' }) } } as any);
    expect((await c.admitMessage(baseInput({ collaboration: collab('ctx-current') }))).ok).toBe(true);
  });
  it('不带 collaboration → 放行', async () => {
    const { P3394Controller } = await import('../../../../src/main/features/p3394/controller');
    const c = new P3394Controller({ sessionSource: sess, epochStore: epoch, contextSource: { snapshot: async () => ({ context_id: 'ctx-current', status: 'running' }) } } as any);
    expect((await c.admitMessage(baseInput())).ok).toBe(true);
  });
  it('snapshot 读失败 → 降级放行', async () => {
    const { P3394Controller } = await import('../../../../src/main/features/p3394/controller');
    const c = new P3394Controller({ sessionSource: sess, epochStore: epoch, contextSource: { snapshot: async () => { throw new Error('io'); } } } as any);
    expect((await c.admitMessage(baseInput({ collaboration: collab('ctx-other') }))).ok).toBe(true);
  });
  it('带 collaboration 但 snapshot 为 null → 降级放行', async () => {
    const { P3394Controller } = await import('../../../../src/main/features/p3394/controller');
    const c = new P3394Controller({ sessionSource: sess, epochStore: epoch, contextSource: { snapshot: async () => null } } as any);
    expect((await c.admitMessage(baseInput({ collaboration: collab('ctx-anything') }))).ok).toBe(true);
  });
});
