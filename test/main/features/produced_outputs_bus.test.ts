/**
 * 产物登记广播的契约测试。
 *
 * 这个模块是会话主链路（`group_chat/bus.ts::onOutputsPublished`）唯一的对外旁路，
 * 所以它的容错性比功能更重要：**观察者出错绝不能影响会话**。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

type Bus = typeof import('../../../src/main/features/produced_outputs_bus');

async function loadMod(): Promise<Bus> {
  return import('../../../src/main/features/produced_outputs_bus');
}

const EV = {
  uid: 'po-u1',
  conversationId: 'cid-1',
  acceptedAbsPaths: ['/ws/2026-10-14_周会_会议纪要_v001.md'],
};

describe('produced_outputs_bus', () => {
  beforeEach(() => { vi.resetModules(); });

  it('delivers an accepted publication to subscribers', async () => {
    const bus = await loadMod();
    const seen: Array<{ uid: string; cid: string; paths: readonly string[] }> = [];
    const unsub = bus.subscribeProducedOutputs((ev) => {
      seen.push({ uid: ev.uid, cid: ev.conversationId, paths: ev.acceptedAbsPaths });
    });
    try {
      bus.emitProducedOutputs(EV);
      expect(seen.length).toBe(1);
      expect(seen[0].uid).toBe('po-u1');
      expect(seen[0].cid).toBe('cid-1');
      expect(seen[0].paths).toEqual(['/ws/2026-10-14_周会_会议纪要_v001.md']);
    } finally {
      unsub();
    }
  });

  it('isolates a throwing observer: others still run and the caller never sees the error', async () => {
    const bus = await loadMod();
    const after = vi.fn();
    const unsubBad = bus.subscribeProducedOutputs(() => { throw new Error('observer blew up'); });
    const unsubGood = bus.subscribeProducedOutputs(after);
    try {
      // 关键：会话主链路调用它，所以它**绝不能抛**。
      expect(() => bus.emitProducedOutputs(EV)).not.toThrow();
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      unsubBad();
      unsubGood();
    }
  });

  it('emits a frozen snapshot that observers cannot mutate into the bus', async () => {
    const bus = await loadMod();
    let captured: unknown = null;
    const unsub = bus.subscribeProducedOutputs((ev) => { captured = ev; });
    try {
      bus.emitProducedOutputs(EV);
      expect(Object.isFrozen(captured)).toBe(true);
      const paths = (captured as { acceptedAbsPaths: string[] }).acceptedAbsPaths;
      expect(Object.isFrozen(paths)).toBe(true);
      try { paths.push('/evil'); } catch { /* strict 模式会抛，宽松模式静默 */ }
      expect(paths.length).toBe(1);
    } finally {
      unsub();
    }
  });

  it('does not fire for an empty acceptance (a rejected declaration is not a publication)', async () => {
    const bus = await loadMod();
    const spy = vi.fn();
    const unsub = bus.subscribeProducedOutputs(spy);
    try {
      bus.emitProducedOutputs({ uid: 'po-u1', conversationId: 'cid-1', acceptedAbsPaths: [] });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      unsub();
    }
  });

  it('ignores malformed events instead of throwing', async () => {
    const bus = await loadMod();
    const spy = vi.fn();
    const unsub = bus.subscribeProducedOutputs(spy);
    try {
      expect(() => bus.emitProducedOutputs(null as never)).not.toThrow();
      expect(() => bus.emitProducedOutputs({} as never)).not.toThrow();
      expect(() => bus.emitProducedOutputs({ uid: 'u', conversationId: 'c', acceptedAbsPaths: 'x' } as never)).not.toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      unsub();
    }
  });

  it('unsubscribe is idempotent and stops delivery', async () => {
    const bus = await loadMod();
    const spy = vi.fn();
    const unsub = bus.subscribeProducedOutputs(spy);
    unsub();
    unsub();
    bus.emitProducedOutputs(EV);
    expect(spy).not.toHaveBeenCalled();
    expect(bus.producedOutputsObserverCount()).toBe(0);
  });

  it('delivers to every subscriber (multiple observers coexist)', async () => {
    const bus = await loadMod();
    const a = vi.fn(); const b = vi.fn();
    const ua = bus.subscribeProducedOutputs(a);
    const ub = bus.subscribeProducedOutputs(b);
    try {
      bus.emitProducedOutputs(EV);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    } finally {
      ua(); ub();
    }
  });
});
