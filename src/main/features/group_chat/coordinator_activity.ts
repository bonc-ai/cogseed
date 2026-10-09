export const DEFAULT_COORDINATOR_LEASES = {
  toolIdleMs: 120_000,
  agentProbeMs: 5 * 60_000,
  agentAbortMs: 8 * 60_000,
} as const;

export type CoordinatorStallReason = 'tool_idle' | 'agent_idle';

export type CoordinatorActivityEvent =
  | { kind: 'activity' }
  | { kind: 'idle_heartbeat' }
  | { kind: 'tool_start'; callId?: string; tool: string; longRunning?: boolean }
  | { kind: 'tool_result'; callId?: string; tool?: string }
  | { kind: 'awaiting_user' }
  | { kind: 'user_resumed' }
  | { kind: 'terminal' };

export type CoordinatorLeaseDecision =
  | { kind: 'none' }
  | { kind: 'probe'; reason: 'agent_idle'; idleMs: number }
  | { kind: 'abort'; reason: CoordinatorStallReason; idleMs: number };

export interface CoordinatorLeaseConfig {
  toolIdleMs: number;
  agentProbeMs: number;
  agentAbortMs: number;
}

type OpenTool = { tool: string; startedAt: number; longRunning: boolean };
type OpenToolKey = string | symbol;

export class TurnActivityTracker {
  private phaseValue: 'agent_idle' | 'tool_in_flight' | 'awaiting_user' | 'terminal' = 'agent_idle';
  private lastActivityAtValue: number;
  private probeSentAtValue: number | undefined;
  private readonly openTools = new Map<OpenToolKey, OpenTool>();

  constructor(
    startedAt: number,
    private readonly config: CoordinatorLeaseConfig = DEFAULT_COORDINATOR_LEASES,
  ) {
    this.lastActivityAtValue = startedAt;
  }

  observe(event: CoordinatorActivityEvent, now: number): void {
    if (this.phaseValue === 'terminal') return;
    if (event.kind === 'idle_heartbeat') return;
    if (event.kind === 'terminal') {
      this.phaseValue = 'terminal';
      this.openTools.clear();
      return;
    }
    if (event.kind === 'awaiting_user') {
      this.phaseValue = 'awaiting_user';
      return;
    }
    if (event.kind === 'user_resumed') {
      this.lastActivityAtValue = now;
      this.probeSentAtValue = undefined;
      this.phaseValue = this.openTools.size ? 'tool_in_flight' : 'agent_idle';
      return;
    }
    let renewed = event.kind === 'activity';
    if (event.kind === 'tool_start') {
      const key: OpenToolKey = event.callId || Symbol('synthetic-tool');
      if (!this.openTools.has(key)) {
        this.openTools.set(key, {
          tool: event.tool,
          startedAt: now,
          longRunning: event.longRunning === true,
        });
        renewed = true;
      }
    } else if (event.kind === 'tool_result') {
      let matchedKey: OpenToolKey | undefined;
      if (event.callId && this.openTools.has(event.callId)) {
        matchedKey = event.callId;
      } else if (!event.callId) {
        matchedKey = [...this.openTools.entries()].find(
          ([, tool]) => !event.tool || tool.tool === event.tool,
        )?.[0];
      }
      if (matchedKey !== undefined) {
        this.openTools.delete(matchedKey);
        renewed = true;
      }
    }
    if (!renewed) return;
    this.lastActivityAtValue = now;
    this.probeSentAtValue = undefined;
    if (this.phaseValue !== 'awaiting_user') {
      this.phaseValue = this.openTools.size ? 'tool_in_flight' : 'agent_idle';
    }
  }

  evaluate(now: number): CoordinatorLeaseDecision {
    if (this.phaseValue === 'terminal' || this.phaseValue === 'awaiting_user') {
      return { kind: 'none' };
    }
    const idleMs = Math.max(0, now - this.lastActivityAtValue);
    if (this.phaseValue === 'tool_in_flight') {
      const hasNormalTool = [...this.openTools.values()].some((tool) => !tool.longRunning);
      return hasNormalTool && idleMs >= this.config.toolIdleMs
        ? { kind: 'abort', reason: 'tool_idle', idleMs }
        : { kind: 'none' };
    }
    if (idleMs >= this.config.agentAbortMs) {
      return { kind: 'abort', reason: 'agent_idle', idleMs };
    }
    if (idleMs >= this.config.agentProbeMs && this.probeSentAtValue === undefined) {
      this.probeSentAtValue = now;
      return { kind: 'probe', reason: 'agent_idle', idleMs };
    }
    return { kind: 'none' };
  }

  snapshot(): {
    phase: 'agent_idle' | 'tool_in_flight' | 'awaiting_user' | 'terminal';
    lastActivityAt: number;
    probeSentAt?: number;
    openToolCount: number;
  } {
    return {
      phase: this.phaseValue,
      lastActivityAt: this.lastActivityAtValue,
      ...(this.probeSentAtValue !== undefined ? { probeSentAt: this.probeSentAtValue } : {}),
      openToolCount: this.openTools.size,
    };
  }
}
