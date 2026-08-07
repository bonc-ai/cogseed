import { describe, expect, it, vi } from 'vitest';
import {
  TurnActivityTracker,
  DEFAULT_COORDINATOR_LEASES,
} from '../../../../src/main/features/group_chat/coordinator_activity';
import {
  activityFromLocalEvent,
  activityFromProcessEvent,
  probeProcessLiveness,
  startTurnLeaseMonitor,
} from '../../../../src/main/features/group_chat/coordinator_runtime';

describe('TurnActivityTracker', () => {
  it('treats a completed tool followed by silence as agent idle', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'tool_start', callId: 'c1', tool: 'exec_command' }, 1_000);
    t.observe({ kind: 'tool_result', callId: 'c1' }, 2_000);

    expect(t.snapshot().phase).toBe('agent_idle');
    expect(t.evaluate(2_000 + DEFAULT_COORDINATOR_LEASES.agentProbeMs)).toMatchObject({
      kind: 'probe',
      reason: 'agent_idle',
    });
  });

  it('aborts an unfinished normal tool after 120 seconds of real inactivity', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'tool_start', callId: 'c1', tool: 'exec_command' }, 1_000);

    expect(t.evaluate(120_999)).toEqual({ kind: 'none' });
    expect(t.evaluate(121_000)).toMatchObject({ kind: 'abort', reason: 'tool_idle' });
  });

  it('does not count the runner idle heartbeat as activity', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'activity' }, 1_000);
    t.observe({ kind: 'idle_heartbeat' }, 100_000);

    expect(t.snapshot().lastActivityAt).toBe(1_000);
  });

  it('probes once at five minutes and aborts at eight minutes', () => {
    const t = new TurnActivityTracker(0);

    expect(t.evaluate(299_999)).toEqual({ kind: 'none' });
    expect(t.evaluate(300_000)).toMatchObject({ kind: 'probe', reason: 'agent_idle' });
    expect(t.evaluate(360_000)).toEqual({ kind: 'none' });
    expect(t.evaluate(480_000)).toMatchObject({ kind: 'abort', reason: 'agent_idle' });
  });

  it('clears a previous probe when real activity resumes', () => {
    const t = new TurnActivityTracker(0);
    expect(t.evaluate(300_000).kind).toBe('probe');
    t.observe({ kind: 'activity' }, 310_000);

    expect(t.evaluate(610_000).kind).toBe('probe');
  });

  it('pauses while explicitly waiting for the user', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'awaiting_user' }, 10_000);

    expect(t.evaluate(900_000)).toEqual({ kind: 'none' });
    t.observe({ kind: 'user_resumed' }, 910_000);
    expect(t.evaluate(1_210_000).kind).toBe('probe');
  });

  it('stays paused when ordinary activity arrives while awaiting the user', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'awaiting_user' }, 10_000);
    t.observe({ kind: 'activity' }, 20_000);

    expect(t.snapshot()).toMatchObject({
      phase: 'awaiting_user',
      lastActivityAt: 20_000,
    });
    expect(t.evaluate(900_000)).toEqual({ kind: 'none' });
  });

  it('stays paused when an open tool completes while awaiting the user', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'tool_start', callId: 'c1', tool: 'exec_command' }, 1_000);
    t.observe({ kind: 'awaiting_user' }, 2_000);
    t.observe({ kind: 'tool_result', callId: 'c1' }, 3_000);

    expect(t.snapshot()).toMatchObject({
      phase: 'awaiting_user',
      lastActivityAt: 3_000,
      openToolCount: 0,
    });
    expect(t.evaluate(900_000)).toEqual({ kind: 'none' });
  });

  it('does not renew activity for a duplicate tool start', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'tool_start', callId: 'c1', tool: 'exec_command' }, 1_000);
    t.observe({ kind: 'tool_start', callId: 'c1', tool: 'exec_command' }, 100_000);

    expect(t.snapshot().lastActivityAt).toBe(1_000);
    expect(t.evaluate(121_000)).toMatchObject({ kind: 'abort', reason: 'tool_idle' });
  });

  it('does not renew activity for unmatched or duplicate tool results', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'tool_start', callId: 'c1', tool: 'exec_command' }, 1_000);
    t.observe({ kind: 'tool_result', callId: 'missing' }, 100_000);

    expect(t.snapshot().lastActivityAt).toBe(1_000);

    t.observe({ kind: 'tool_result', callId: 'c1' }, 110_000);
    t.observe({ kind: 'tool_result', callId: 'c1' }, 200_000);

    expect(t.snapshot()).toMatchObject({
      phase: 'agent_idle',
      lastActivityAt: 110_000,
      openToolCount: 0,
    });
  });

  it('keeps backend and synthetic tool calls in separate key spaces', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'tool_start', callId: 'synthetic-1', tool: 'backend_tool' }, 1_000);
    t.observe({ kind: 'tool_start', tool: 'anonymous_tool' }, 2_000);

    expect(t.snapshot().openToolCount).toBe(2);

    t.observe({ kind: 'tool_result', callId: 'synthetic-1' }, 3_000);
    expect(t.snapshot()).toMatchObject({ phase: 'tool_in_flight', openToolCount: 1 });

    t.observe({ kind: 'tool_result', tool: 'anonymous_tool' }, 4_000);
    expect(t.snapshot()).toMatchObject({ phase: 'agent_idle', openToolCount: 0 });
  });

  it('lets explicitly long-running silent tools fall through to the backend watchdog', () => {
    const t = new TurnActivityTracker(0);
    t.observe({
      kind: 'tool_start',
      callId: 'download',
      tool: 'exec_command',
      longRunning: true,
    }, 1_000);

    expect(t.evaluate(20 * 60_000)).toEqual({ kind: 'none' });
  });
});

describe('coordinator runtime event normalization', () => {
  it('maps local tool use and result events with stable call metadata', () => {
    expect(activityFromLocalEvent({
      type: 'tool-event',
      phase: 'use',
      callId: 'x',
      tool: 'exec_command',
    })).toEqual({
      kind: 'tool_start',
      callId: 'x',
      tool: 'exec_command',
      longRunning: false,
    });

    expect(activityFromLocalEvent({
      type: 'tool-event',
      phase: 'result',
      callId: 'x',
      tool: 'exec_command',
    })).toEqual({
      kind: 'tool_result',
      callId: 'x',
      tool: 'exec_command',
    });
  });

  it('maps local idle and done events without treating idle as activity', () => {
    expect(activityFromLocalEvent({ type: 'idle', stalledMs: 99_000 }))
      .toEqual({ kind: 'idle_heartbeat' });
    expect(activityFromLocalEvent({ type: 'done', status: 'completed' }))
      .toEqual({ kind: 'terminal' });
    expect(activityFromLocalEvent({ type: 'status', status: 'running' }))
      .toEqual({ kind: 'activity' });
  });

  it('defaults missing local tool metadata and only honors explicit long-running flags', () => {
    expect(activityFromLocalEvent({
      type: 'tool-event',
      phase: 'use',
      longRunning: 'true',
    })).toEqual({
      kind: 'tool_start',
      tool: 'tool',
      longRunning: false,
    });
  });

  it('trims scalar metadata and skips whitespace-only primary fields', () => {
    expect(activityFromLocalEvent({
      type: 'tool-event',
      phase: 'use',
      callId: '  local-call  ',
      tool: '  exec_command  ',
    })).toEqual({
      kind: 'tool_start',
      callId: 'local-call',
      tool: 'exec_command',
      longRunning: false,
    });

    expect(activityFromProcessEvent({
      stream: 'tool',
      data: {
        phase: 'start',
        call_id: '   ',
        callId: '  process-call  ',
        name: '\t',
        toolName: '  bash  ',
      },
    })).toEqual({
      kind: 'tool_start',
      callId: 'process-call',
      tool: 'bash',
      longRunning: false,
    });

    expect(activityFromProcessEvent({
      stream: 'tool',
      data: { phase: 'end', call_id: 0, name: 42n },
    })).toEqual({
      kind: 'tool_result',
      callId: '0',
      tool: '42',
    });
  });

  it('maps process tool start and result phases with call ids and tool names', () => {
    for (const phase of ['start', 'running', 'request', 'call', 'begin']) {
      expect(activityFromProcessEvent({
        stream: 'TOOL',
        data: { phase: phase.toUpperCase(), call_id: 'x', name: 'bash' },
      })).toEqual({
        kind: 'tool_start',
        callId: 'x',
        tool: 'bash',
        longRunning: false,
      });
    }

    for (const phase of ['end', 'result', 'completed', 'done']) {
      expect(activityFromProcessEvent({
        stream: 'tool',
        data: { phase, callId: 'x', toolName: 'bash' },
      })).toEqual({
        kind: 'tool_result',
        callId: 'x',
        tool: 'bash',
      });
    }
  });

  it('maps approval waiting and terminal decisions to pause and resume activity', () => {
    expect(activityFromProcessEvent({
      stream: 'Approval',
      data: { phase: 'WAITING' },
    })).toEqual({ kind: 'awaiting_user' });

    for (const phase of ['approved', 'rejected', 'cancelled']) {
      expect(activityFromProcessEvent({
        stream: 'approval',
        data: { phase: phase.toUpperCase() },
      })).toEqual({ kind: 'user_resumed' });
    }
  });

  it('falls back to status when phase is empty or non-string', () => {
    expect(activityFromProcessEvent({
      stream: 'tool',
      data: { phase: '', status: 'running', call_id: 'x', name: 'bash' },
    })).toEqual({
      kind: 'tool_start',
      callId: 'x',
      tool: 'bash',
      longRunning: false,
    });

    expect(activityFromProcessEvent({
      stream: 'approval',
      data: { phase: '', status: 'approved' },
    })).toEqual({ kind: 'user_resumed' });

    expect(activityFromProcessEvent({
      stream: 'approval',
      data: { phase: 42, status: 'rejected' },
    })).toEqual({ kind: 'user_resumed' });
  });

  it('falls back to ordinary activity for malformed or unrelated process events', () => {
    expect(activityFromProcessEvent({ stream: 'tool', data: { phase: null } }))
      .toEqual({ kind: 'activity' });
    expect(activityFromProcessEvent({ stream: 'text', data: { value: 'hello' } }))
      .toEqual({ kind: 'activity' });
  });
});

describe('coordinator runtime lease hosting', () => {
  it('delivers one probe and one abort, then stops and clears its injected timer', () => {
    let tick: (() => void) | undefined;
    let now = 0;
    const timer = { unref: vi.fn() };
    const setIntervalFn = vi.fn((callback: () => void, delay: number) => {
      tick = callback;
      expect(delay).toBe(5_000);
      return timer;
    });
    const clearIntervalFn = vi.fn();
    const onProbe = vi.fn();
    const onAbort = vi.fn();

    const monitor = startTurnLeaseMonitor({
      startedAt: 0,
      config: { toolIdleMs: 5, agentProbeMs: 10, agentAbortMs: 20 },
      onProbe,
      onAbort,
      now: () => now,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });

    expect(setIntervalFn).toHaveBeenCalledOnce();
    expect(timer.unref).toHaveBeenCalledOnce();

    now = 10;
    tick!();
    tick!();
    expect(onProbe).toHaveBeenCalledOnce();
    expect(onProbe).toHaveBeenCalledWith(10);

    now = 20;
    tick!();
    tick!();
    expect(onAbort).toHaveBeenCalledOnce();
    expect(onAbort).toHaveBeenCalledWith('agent_idle', 20);
    expect(clearIntervalFn).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);

    monitor.stop();
    monitor.stop();
    expect(clearIntervalFn).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);

    now = 100;
    monitor.observe({ kind: 'activity' });
    tick!();
    expect(onProbe).toHaveBeenCalledOnce();
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it('prevents all later delivery when stopped before a lease decision', () => {
    let tick: (() => void) | undefined;
    let now = 0;
    const timer = {};
    const clearIntervalFn = vi.fn();
    const onProbe = vi.fn();
    const onAbort = vi.fn();
    const monitor = startTurnLeaseMonitor({
      startedAt: 0,
      config: { toolIdleMs: 5, agentProbeMs: 10, agentAbortMs: 20 },
      onProbe,
      onAbort,
      now: () => now,
      setIntervalFn: ((callback: () => void) => {
        tick = callback;
        return timer;
      }) as unknown as typeof setInterval,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });

    monitor.stop();
    monitor.stop();
    now = 100;
    tick!();

    expect(clearIntervalFn).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
    expect(onProbe).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('contains synchronous probe failures and continues after renewed activity', () => {
    let tick: (() => void) | undefined;
    let now = 0;
    const onProbe = vi.fn(() => {
      throw new Error('probe callback failed');
    });
    const monitor = startTurnLeaseMonitor({
      startedAt: 0,
      config: { toolIdleMs: 5, agentProbeMs: 10, agentAbortMs: 100 },
      onProbe,
      onAbort: vi.fn(),
      now: () => now,
      setIntervalFn: ((callback: () => void) => {
        tick = callback;
        return {};
      }) as unknown as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
    });

    now = 10;
    expect(() => tick!()).not.toThrow();
    expect(onProbe).toHaveBeenCalledOnce();

    now = 11;
    monitor.observe({ kind: 'activity' });
    now = 21;
    expect(() => tick!()).not.toThrow();
    expect(onProbe).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it('contains synchronous abort failures and clears a synchronously-fired timer once', () => {
    const timer = {};
    const clearIntervalFn = vi.fn();
    const onAbort = vi.fn(() => {
      throw new Error('abort callback failed');
    });
    let monitor: ReturnType<typeof startTurnLeaseMonitor> | undefined;

    expect(() => {
      monitor = startTurnLeaseMonitor({
        startedAt: 0,
        config: { toolIdleMs: 5, agentProbeMs: 10, agentAbortMs: 20 },
        onProbe: vi.fn(),
        onAbort,
        now: () => 20,
        setIntervalFn: ((callback: () => void) => {
          callback();
          return timer;
        }) as unknown as typeof setInterval,
        clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
      });
    }).not.toThrow();

    expect(onAbort).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
    monitor!.stop();
    expect(clearIntervalFn).toHaveBeenCalledOnce();
  });

  it('handles rejected callback promises and rejected thenables', async () => {
    let tick: (() => void) | undefined;
    let now = 0;
    let abortThenCalled = false;
    const clearIntervalFn = vi.fn();
    const monitor = startTurnLeaseMonitor({
      startedAt: 0,
      config: { toolIdleMs: 5, agentProbeMs: 10, agentAbortMs: 20 },
      onProbe: () => Promise.reject(new Error('probe rejection')),
      onAbort: () => ({
        then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
          abortThenCalled = true;
          reject(new Error('abort thenable rejection'));
        },
      }),
      now: () => now,
      setIntervalFn: ((callback: () => void) => {
        tick = callback;
        return {};
      }) as unknown as typeof setInterval,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });

    now = 10;
    expect(() => tick!()).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));

    now = 20;
    expect(() => tick!()).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(abortThenCalled).toBe(true);
    expect(clearIntervalFn).toHaveBeenCalledOnce();
    monitor.stop();
    expect(clearIntervalFn).toHaveBeenCalledOnce();
  });
});

describe('probeProcessLiveness', () => {
  it('rejects invalid pids without probing the process table', () => {
    const kill = vi.spyOn(process, 'kill');
    try {
      expect(probeProcessLiveness(undefined)).toBe(false);
      expect(probeProcessLiveness(0)).toBe(false);
      expect(probeProcessLiveness(-1)).toBe(false);
      expect(probeProcessLiveness(1.5)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('classifies signal-zero results conservatively for positive integer pids', () => {
    const kill = vi.spyOn(process, 'kill');
    try {
      kill.mockImplementationOnce(() => true);
      expect(probeProcessLiveness(process.pid)).toBe(true);
      expect(kill).toHaveBeenCalledWith(process.pid, 0);

      kill.mockImplementationOnce(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
      expect(probeProcessLiveness(2_147_483_647)).toBe(false);
      expect(kill).toHaveBeenLastCalledWith(2_147_483_647, 0);

      kill.mockImplementationOnce(() => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      });
      expect(probeProcessLiveness(42)).toBe(true);

      kill.mockImplementationOnce(() => {
        throw Object.assign(new Error('unexpected failure'), { code: 'EACCES' });
      });
      expect(probeProcessLiveness(43)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });
});
