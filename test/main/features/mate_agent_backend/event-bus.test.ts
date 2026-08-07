import { describe, expect, it } from 'vitest';

describe('mate_agent_backend append-first event bus primitives', () => {
  it('assigns append-first sequence numbers and replays in append order', async () => {
    const bus = await import('../../../../src/main/features/mate_agent_backend/event-bus');
    const store = bus.createEventBus();

    const first = store.append({ eventId: 'e-1', ownerUserId: 'u-1', kind: 'message', scope: { kind: 'task', taskId: 'task-1' }, payload: { text: 'first' } });
    const second = store.append({ eventId: 'e-2', ownerUserId: 'u-1', kind: 'message', scope: { kind: 'task', taskId: 'task-1' }, payload: { text: 'second' } });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(store.read()).toEqual([first, second]);
    expect(store.replay()).toEqual([first, second]);
  });

  it('supports afterSequence replay and stable subscription filtering', async () => {
    const bus = await import('../../../../src/main/features/mate_agent_backend/event-bus');
    const store = bus.createEventBus();
    store.append({ eventId: 'e-1', ownerUserId: 'u-1', kind: 'message', scope: { kind: 'user', userId: 'u-1' }, payload: { text: 'ignore' } });
    store.append({ eventId: 'e-2', ownerUserId: 'u-1', kind: 'tool', scope: { kind: 'task', taskId: 'task-a' }, payload: { tool: 'shell' } });
    store.append({ eventId: 'e-3', ownerUserId: 'u-1', kind: 'tool', scope: { kind: 'workflow', workflowId: 'flow-a' }, payload: { tool: 'browser' } });

    const subscription = store.subscribe({ afterSequence: 1, filter: (event) => event.kind === 'tool' });
    expect(subscription.snapshot().map((event) => event.eventId)).toEqual(['e-2', 'e-3']);
    store.append({ eventId: 'e-4', ownerUserId: 'u-1', kind: 'tool', scope: { kind: 'task', taskId: 'task-b' }, payload: { tool: 'office' } });
    expect(subscription.snapshot().map((event) => event.eventId)).toEqual(['e-2', 'e-3', 'e-4']);
    expect(store.replay({ afterSequence: 2 }).map((event) => event.eventId)).toEqual(['e-3', 'e-4']);
  });

  it('deduplicates repeated event ids while preserving the first append', async () => {
    const bus = await import('../../../../src/main/features/mate_agent_backend/event-bus');
    const store = bus.createEventBus();
    const first = store.append({ eventId: 'dup', ownerUserId: 'u-1', kind: 'message', scope: { kind: 'task', taskId: 'task-1' }, payload: { text: 'first' } });
    const second = store.append({ eventId: 'dup', ownerUserId: 'u-1', kind: 'message', scope: { kind: 'task', taskId: 'task-1' }, payload: { text: 'second' } });

    expect(second).toBe(first);
    expect(store.read()).toEqual([first]);
  });

  it('can combine replay with a visibility predicate without touching storage', async () => {
    const bus = await import('../../../../src/main/features/mate_agent_backend/event-bus');
    const vis = await import('../../../../src/main/features/mate_agent_backend/visibility-policy');
    const store = bus.createEventBus();

    store.append({
      eventId: 'secret-1',
      ownerUserId: 'u-1',
      kind: 'secret',
      scope: { kind: 'task', taskId: 'task-a' },
      payload: { text: 'shh' },
      allowedRoles: ['commander'],
    });
    store.append({
      eventId: 'message-1',
      ownerUserId: 'u-1',
      kind: 'message',
      scope: { kind: 'task', taskId: 'task-a' },
      payload: { text: 'ok' },
    });

    const events = store.subscribe({
      principal: { userId: 'u-1', role: 'commander', taskId: 'task-a' },
      filter: (event) => vis.canSeeVisibility({ userId: 'u-1', role: 'commander', taskId: 'task-a' }, event),
    }).snapshot();

    expect(events.map((event) => event.eventId)).toEqual(['secret-1', 'message-1']);
  });

  it('treats malformed append input as a rejected invariant', async () => {
    const bus = await import('../../../../src/main/features/mate_agent_backend/event-bus');
    const store = bus.createEventBus();
    expect(() => store.append(null as never)).toThrow(/event/i);
    expect(() => store.append({ eventId: '', ownerUserId: 'u-1', kind: 'message', scope: { kind: 'task', taskId: 'task-a' }, payload: {} })).toThrow(/eventId/i);
  });
});
