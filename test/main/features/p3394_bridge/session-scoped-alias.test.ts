/**
 * §17.4 Session-Scoped Alias 优先级接线：
 *  - kernel.send 的 resolution context 透传：sessionAliases 命中优先于全局
 *    alias（sender 与 recipient 两侧都生效）；
 *  - 不传 sessionAliases 时全局解析行为不变；
 *  - 未注册 token（会话级和全局都没有）返回 peer_not_found，不误触；
 *  - executor 的 sessionAliasesFor 依赖按 session id 注入会话级绑定。
 */
import { describe, expect, it } from 'vitest';
import { P3394BridgeKernel } from '../../../../src/main/features/p3394_bridge/bridge';
import { P3394BridgeExecutor } from '../../../../src/main/features/p3394_bridge/executor';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../src/main/features/p3394_bridge/runtime-adapter';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

function manifest(id: string) {
  const result = buildP3394BridgeManifest({ agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general' } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function kernelWithPeers(): P3394BridgeKernel {
  const bridge = new P3394BridgeKernel();
  bridge.registry.register({ identity: { agent_id: 'agent-a', display_name: 'A' }, aliases: ['@helper'], manifest: manifest('agent-a') });
  bridge.registry.register({ identity: { agent_id: 'agent-b', display_name: 'B' }, aliases: ['@other'], manifest: manifest('agent-b') });
  return bridge;
}

function envelope(overrides: Record<string, unknown> = {}): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-ssa-1',
    session_id: 'ses-ssa-1',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'agent-a' },
    recipients: [{ agent_id: '@helper' }],
    payload: { parts: [{ type: 'text', text: 'hi' }] },
    idempotency_key: 'idem-ssa-1',
    ...overrides,
  } as P3394Envelope;
}

function fakeRuntime(): P3394RuntimeAdapter {
  return {
    async openSession(_input): Promise<P3394RuntimeSessionBinding> {
      return { session_id: 'ses-ssa-1', native_session_id: 'native-ssa', agent_id: 'agent-b' };
    },
    async deliver(): Promise<{ task_id: string }> {
      return { task_id: 'tsk-ssa' };
    },
    async *stream(): AsyncIterable<P3394RuntimeEvent> {
      yield { sequence: 1, task_id: 'tsk-ssa', kind: 'completed', data: {} };
    },
    async resume(): Promise<void> {},
    async cancel(): Promise<void> {},
    async snapshot(): Promise<P3394RuntimeSnapshot> {
      return { session_id: 'ses-ssa-1', native_session_id: 'native-ssa', at: new Date().toISOString() };
    },
    async closeSession(): Promise<void> {},
  };
}

describe('Session-scoped alias resolution wiring (§17.4)', () => {
  it('sessionAliases take precedence over the global alias for recipients', () => {
    const bridge = kernelWithPeers();
    // 全局：@helper → agent-a。
    const globalSend = bridge.send(envelope({ message_id: 'msg-ssa-g', idempotency_key: 'idem-ssa-g' }));
    expect(globalSend.ok).toBe(true);
    if (globalSend.ok) expect(globalSend.receipt.recipient_ids).toEqual(['agent-a']);

    // 会话级：@helper → agent-b（仅本会话）。
    const scopedSend = bridge.send(envelope({ message_id: 'msg-ssa-s', idempotency_key: 'idem-ssa-s' }), {
      sessionAliases: { '@helper': 'agent-b' },
    });
    expect(scopedSend.ok).toBe(true);
    if (scopedSend.ok) expect(scopedSend.receipt.recipient_ids).toEqual(['agent-b']);
  });

  it('sessionAliases apply to the sender side too', () => {
    const bridge = kernelWithPeers();
    // @shuttle 未全局注册：不带会话级绑定时 sender 解析失败。
    const unbound = bridge.send(envelope({
      message_id: 'msg-ssa-unbound',
      idempotency_key: 'idem-ssa-unbound',
      sender: { agent_id: '@shuttle' },
      recipients: [{ agent_id: '@helper' }],
    }));
    expect(unbound.ok).toBe(false);
    if (!unbound.ok) expect(unbound.error.reason).toBe('peer_not_found');

    // 会话级把 @shuttle 绑到 agent-a：sender 准入通过，发送成功。
    const bound = bridge.send(envelope({
      message_id: 'msg-ssa-sender',
      idempotency_key: 'idem-ssa-sender',
      sender: { agent_id: '@shuttle' },
      recipients: [{ agent_id: '@helper' }],
    }), { sessionAliases: { '@shuttle': 'agent-a' } });
    expect(bound.ok).toBe(true);
    if (bound.ok) expect(bound.receipt.recipient_ids).toEqual(['agent-a']);
  });

  it('a session alias pointing at an unregistered agent id is not silently coerced', () => {
    const bridge = kernelWithPeers();
    const sent = bridge.send(envelope({ message_id: 'msg-ssa-ghost', idempotency_key: 'idem-ssa-ghost' }), {
      sessionAliases: { '@helper': 'agent-not-registered' },
    });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.reason).toBe('peer_not_found');
  });

  it('unregistered tokens resolve to peer_not_found and never trip the global table', () => {
    const bridge = kernelWithPeers();
    // 会话级映射里没有 @ghost，全局也没有 → 明确失败，不误触任何注册方。
    const sent = bridge.send(envelope({
      message_id: 'msg-ssa-ghost2',
      idempotency_key: 'idem-ssa-ghost2',
      recipients: [{ agent_id: '@ghost' }],
    }), { sessionAliases: { '@helper': 'agent-b' } });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.reason).toBe('peer_not_found');
  });

  it('executor sessionAliasesFor injects per-session bindings into kernel.send', async () => {
    const bridge = kernelWithPeers();
    const seenSessionIds: string[] = [];
    const executor = new P3394BridgeExecutor({
      bridge,
      runtime: fakeRuntime(),
      sessionAliasesFor: (sessionId) => {
        seenSessionIds.push(sessionId);
        return sessionId === 'ses-ssa-1' ? { '@helper': 'agent-b' } : undefined;
      },
    });
    const result = executor.execute(envelope());
    // receipt.recipient_ids 证明 @helper 在 ses-ssa-1 内解析到了 agent-b。
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipt.recipient_ids).toEqual(['agent-b']);
    expect(seenSessionIds).toContain('ses-ssa-1');
  });

  it('executor without sessionAliasesFor keeps the historical global resolution', async () => {
    const bridge = kernelWithPeers();
    const executor = new P3394BridgeExecutor({ bridge, runtime: fakeRuntime() });
    const result = executor.execute(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipt.recipient_ids).toEqual(['agent-a']);
  });
});
