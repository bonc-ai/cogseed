import { describe, expect, it } from 'vitest';
import { P3394ConversationRuntimeAdapter } from '../../../../src/main/features/p3394_bridge/conversation-runtime';

class FakeBus {
  calls: Array<{ uid: string; cid: string; fromActorId: string; text: string }> = [];
  listeners = new Map<string, Set<(ev: unknown) => void>>();
  async enqueue(params: { uid: string; cid: string; fromActorId: string; text: string }): Promise<void> {
    this.calls.push(params);
    return undefined;
  }
  subscribe(uid: string, cid: string, listener: (ev: unknown) => void): () => void {
    const key = uid + ':' + cid;
    let set = this.listeners.get(key);
    if (!set) { set = new Set(); this.listeners.set(key, set); }
    set.add(listener);
    return () => set.delete(listener);
  }
  emit(uid: string, cid: string, ev: unknown): void {
    const set = this.listeners.get(uid + ':' + cid);
    if (set) for (const listener of [...set]) listener(ev);
  }
}

const UID = 'conv-user';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 'msg-conv-1',
    session_id: 'ses-conv-1',
    task_id: 'tsk-conv-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'hermes' },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: 'hello cogseed' }] },
    idempotency_key: 'idem-conv-1',
    ...overrides,
  } as never;
}

function replyEvent(cid: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    cid,
    turn_end: true,
    msg: { id: 'm-reply', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'hello, i am cogseed' },
    ...overrides,
  };
}

async function collect(adapter: P3394ConversationRuntimeAdapter, taskId: string): Promise<{ kinds: string[]; texts: string[] }> {
  const kinds: string[] = [];
  const texts: string[] = [];
  for await (const event of adapter.stream(taskId)) {
    kinds.push(event.kind);
    if (event.kind === 'delta' && event.data && typeof event.data.text === 'string') texts.push(event.data.text);
    if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled') break;
  }
  return { kinds, texts };
}

describe('P3394ConversationRuntimeAdapter (path B: daily conversation flow)', () => {
  it('injects the external message under the peer\'s own agent identity (never the user)', async () => {
    const bus = new FakeBus();
    const peerActors: Array<{ uid: string; cid: string; actor: Record<string, unknown> }> = [];
    const adapter = new P3394ConversationRuntimeAdapter({
      userId: () => UID,
      bus,
      conversationForSession: () => 'ses-conv-1',
      displayNameFor: (id) => (id === 'hermes' ? 'Hermes' : undefined),
      ensurePeerActor: async (uid, cid, actor) => { peerActors.push({ uid, cid, actor }); },
    });
    await adapter.openSession({ session_id: 'ses-conv-1', agent_id: 'cogseed' });
    const { task_id } = await adapter.deliver(envelope() as never);
    expect(task_id).toBe('tsk-conv-1');
    expect(bus.calls).toHaveLength(1);
    expect(bus.calls[0]).toMatchObject({
      uid: UID,
      fromActorId: 'p3394_hermes',
      forceTo: ['commander'],
      externalInbound: true,
    });
    // Security boundary: external messages must not carry the wake-gate bypass.
    expect(bus.calls[0].skipWakeGate).toBeUndefined();
    expect(bus.calls[0].text).toBe('hello cogseed');
    expect(peerActors).toEqual([
      { uid: UID, cid: 'ses-conv-1', actor: { kind: 'agent', id: 'p3394_hermes', name: 'Hermes' } },
    ]);
  });

  it('registers the conversation in the chats index and the peer as its own actor', async () => {
    const bus = new FakeBus();
    const ensured: Array<{ uid: string; cid: string; title: string }> = [];
    const peerActors: Array<{ cid: string; actor: Record<string, unknown> }> = [];
    const adapter = new P3394ConversationRuntimeAdapter({
      userId: () => UID,
      bus,
      conversationForSession: () => 'ses-conv-1',
      ensureConversation: async (uid, cid, title) => { ensured.push({ uid, cid, title }); },
      ensurePeerActor: async (_uid, cid, actor) => { peerActors.push({ cid, actor }); },
    });
    await adapter.openSession({ session_id: 'ses-conv-1', agent_id: 'cogseed' });
    await adapter.deliver(envelope() as never);
    expect(ensured).toEqual([{ uid: UID, cid: 'ses-conv-1', title: '[P3394] hermes' }]);
    expect(peerActors).toEqual([{ cid: 'ses-conv-1', actor: { kind: 'agent', id: 'p3394_hermes', name: 'hermes' } }]);
  });

  it('names a user-built peer by its self-declared alias', async () => {
    const bus = new FakeBus();
    const peerActors: Array<Record<string, unknown>> = [];
    const adapter = new P3394ConversationRuntimeAdapter({
      userId: () => UID,
      bus,
      conversationForSession: () => 'ses-conv-1',
      ensurePeerActor: async (_uid, _cid, actor) => { peerActors.push(actor); },
    });
    await adapter.openSession({ session_id: 'ses-conv-1', agent_id: 'cogseed' });
    await adapter.deliver(envelope({
      sender: { agent_id: 'my-custom-agent', alias: '我的助手' },
    }) as never);
    expect(bus.calls[0]).toMatchObject({ fromActorId: 'p3394_my-custom-agent' });
    expect(peerActors).toEqual([{ kind: 'agent', id: 'p3394_my-custom-agent', name: '我的助手' }]);
  });

  it('captures a reply that arrives immediately after enqueue (subscribe-before-enqueue)', async () => {
    const bus = new FakeBus();
    const adapter = new P3394ConversationRuntimeAdapter({ userId: () => UID, bus, conversationForSession: () => 'ses-conv-1' });
    await adapter.openSession({ session_id: 'ses-conv-1', agent_id: 'cogseed' });
    await adapter.deliver(envelope() as never);
    // No setTimeout: the reply fires on the same tick the deliver returned.
    bus.emit(UID, 'ses-conv-1', replyEvent('ses-conv-1'));
    const { kinds, texts } = await collect(adapter, 'tsk-conv-1');
    expect(kinds[0]).toBe('started');
    expect(kinds).toContain('delta');
    expect(texts).toContain('hello, i am cogseed');
    expect(kinds[kinds.length - 1]).toBe('completed');
  });

  it('ignores side-effect messages (turn_end false) and only takes the official reply', async () => {
    const bus = new FakeBus();
    const adapter = new P3394ConversationRuntimeAdapter({ userId: () => UID, bus, conversationForSession: () => 'ses-conv-1' });
    await adapter.openSession({ session_id: 'ses-conv-1', agent_id: 'cogseed' });
    await adapter.deliver(envelope() as never);

    const eventsPromise = collect(adapter, 'tsk-conv-1');
    bus.emit(UID, 'ses-conv-1', replyEvent('ses-conv-1', { turn_end: false, msg: { id: 'm-plan', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'plan announcement, not a reply' } }));
    setTimeout(() => {
      bus.emit(UID, 'ses-conv-1', replyEvent('ses-conv-1', { msg: { id: 'm-real', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'the real reply' } }));
    }, 10);
    const { texts } = await eventsPromise;
    expect(texts).toEqual(['the real reply']);
  });

  it('ignores its own injected peer message (no turn_end) and only takes the next real reply', async () => {
    const bus = new FakeBus();
    const adapter = new P3394ConversationRuntimeAdapter({
      userId: () => UID,
      bus,
      conversationForSession: () => 'ses-conv-1',
      ensurePeerActor: async () => {},
    });
    await adapter.openSession({ session_id: 'ses-conv-1', agent_id: 'cogseed' });
    await adapter.deliver(envelope() as never);

    const eventsPromise = collect(adapter, 'tsk-conv-1');
    bus.emit(UID, 'ses-conv-1', replyEvent('ses-conv-1', { turn_end: false, msg: { id: 'm-self', ts: new Date().toISOString(), from: 'p3394_hermes', to: ['commander'], text: 'hello cogseed' } }));
    setTimeout(() => {
      bus.emit(UID, 'ses-conv-1', replyEvent('ses-conv-1', { msg: { id: 'm-real', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'the real reply' } }));
    }, 10);
    const { texts } = await eventsPromise;
    expect(texts).toEqual(['the real reply']);
  });

  it('hands replies to concurrent tasks in FIFO order (no stealing)', async () => {
    const bus = new FakeBus();
    const adapter = new P3394ConversationRuntimeAdapter({ userId: () => UID, bus, conversationForSession: () => 'ses-conv-1' });
    await adapter.openSession({ session_id: 'ses-conv-1', agent_id: 'cogseed' });
    await adapter.deliver(envelope({ task_id: 'tsk-1', message_id: 'msg-1' }) as never);
    await adapter.deliver(envelope({ task_id: 'tsk-2', message_id: 'msg-2' }) as never);

    const first = collect(adapter, 'tsk-1');
    const second = collect(adapter, 'tsk-2');
    // First reply → task 1; second reply → task 2 (commander processes serially).
    bus.emit(UID, 'ses-conv-1', replyEvent('ses-conv-1', { msg: { id: 'm-1', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'reply one' } }));
    bus.emit(UID, 'ses-conv-1', replyEvent('ses-conv-1', { msg: { id: 'm-2', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'reply two' } }));
    const [a, b] = await Promise.all([first, second]);
    expect(a.texts).toEqual(['reply one']);
    expect(b.texts).toEqual(['reply two']);
  });

  it('fails the stream when no reply arrives in time', async () => {
    const bus = new FakeBus();
    const adapter = new P3394ConversationRuntimeAdapter({ userId: () => UID, bus, replyTimeoutMs: 60 });
    await adapter.openSession({ session_id: 'ses-conv-1', agent_id: 'cogseed' });
    await adapter.deliver(envelope() as never);
    const { kinds } = await collect(adapter, 'tsk-conv-1');
    expect(kinds).toContain('failed');
  });

  it('cancel settles the pending waiter as failed', async () => {
    const bus = new FakeBus();
    const adapter = new P3394ConversationRuntimeAdapter({ userId: () => UID, bus, conversationForSession: () => 'ses-conv-1' });
    await adapter.openSession({ session_id: 'ses-conv-1', agent_id: 'cogseed' });
    await adapter.deliver(envelope() as never);
    const eventsPromise = collect(adapter, 'tsk-conv-1');
    await adapter.cancel('tsk-conv-1');
    const { kinds } = await eventsPromise;
    expect(kinds).toContain('failed');
  });

  it('closeSession settles pending waiters and releases the subscription', async () => {
    const bus = new FakeBus();
    const adapter = new P3394ConversationRuntimeAdapter({ userId: () => UID, bus, conversationForSession: () => 'ses-conv-1' });
    await adapter.openSession({ session_id: 'ses-conv-1', agent_id: 'cogseed' });
    await adapter.deliver(envelope() as never);
    const eventsPromise = collect(adapter, 'tsk-conv-1');
    await adapter.closeSession('ses-conv-1');
    const { kinds } = await eventsPromise;
    expect(kinds).toContain('failed');
  });

  it('maps the same P3394 session to the same conversation across adapter restarts (deterministic cid)', async () => {
    const adapterA = new P3394ConversationRuntimeAdapter({ userId: () => UID, bus: new FakeBus(), ensurePeerActor: async () => {} });
    await adapterA.openSession({ session_id: 'ses-restart-1', agent_id: 'cogseed' });
    const snapshotA = await adapterA.snapshot('ses-restart-1');
    // A fresh adapter (restart simulation) must derive the SAME conversation id.
    const adapterB = new P3394ConversationRuntimeAdapter({ userId: () => UID, bus: new FakeBus(), ensurePeerActor: async () => {} });
    await adapterB.openSession({ session_id: 'ses-restart-1', agent_id: 'cogseed' });
    const snapshotB = await adapterB.snapshot('ses-restart-1');
    expect(snapshotA.native_session_id).toBe(snapshotB.native_session_id);
    expect(snapshotA.native_session_id).toMatch(/^p3394-[a-z0-9]+-[a-z0-9]+$/);
  });

  it('snapshot reports the conversation id and close releases the mapping', async () => {
    const bus = new FakeBus();
    const adapter = new P3394ConversationRuntimeAdapter({ userId: () => UID, bus, conversationForSession: () => 'p3394-fixed-cid' });
    await adapter.openSession({ session_id: 'ses-conv-1', agent_id: 'cogseed' });
    const snapshot = await adapter.snapshot('ses-conv-1');
    expect(snapshot.native_session_id).toBe('p3394-fixed-cid');
    await adapter.closeSession('ses-conv-1');
    await expect(adapter.snapshot('ses-conv-1')).rejects.toThrow('p3394_session_not_found');
  });
});

