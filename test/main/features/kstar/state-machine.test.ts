import { describe, expect, it } from 'vitest';

describe('KSTAR lifecycle state machine', () => {
  it('accepts only declared transitions and allows an idempotent same-state write', async () => {
    const { assertKstarTransition } = await import('../../../../src/main/features/kstar/state-machine');

    expect(() => assertKstarTransition('task', 'open', 'closing')).not.toThrow();
    expect(() => assertKstarTransition('task', 'open', 'closed')).not.toThrow();
    expect(() => assertKstarTransition('requirement', 'open', 'waiting_review')).not.toThrow();
    expect(() => assertKstarTransition('episode', 'failed', 'timed_out')).toThrow('invalid KSTAR episode transition');
    expect(() => assertKstarTransition('task', 'closed', 'open')).toThrow('invalid KSTAR task transition');
    expect(() => assertKstarTransition('task', 'closed', 'closed')).not.toThrow();
  });

  it('keeps terminal lifecycle records terminal', async () => {
    const { assertKstarTransition } = await import('../../../../src/main/features/kstar/state-machine');

    expect(() => assertKstarTransition('task', 'abandoned', 'closed')).toThrow();
    expect(() => assertKstarTransition('requirement', 'closed', 'waiting_review')).toThrow();
    expect(() => assertKstarTransition('review', 'confirmed', 'inferred')).toThrow();
  });
});
