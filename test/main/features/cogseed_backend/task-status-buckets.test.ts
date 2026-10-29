import { describe, expect, it } from 'vitest';

import {
  COGSEED_ACTIVE_TASK_STATUSES,
  COGSEED_ATTENTION_TASK_STATUSES,
  COGSEED_TERMINAL_TASK_STATUSES,
} from '../../../../src/main/features/cogseed_backend/task-status-buckets';

describe('task status buckets', () => {
  it('never reports a task that waits for the user as executing', () => {
    // Regression for the 2026-10-12 incident: a task whose turn had ended
    // (turn_end=1 at 17:17:23) stayed waiting_user, yet the sidebar badge kept
    // claiming "1 在执行" because waiting_user sat in the active bucket.
    expect(COGSEED_ACTIVE_TASK_STATUSES).not.toContain('waiting_user');
    expect(COGSEED_ATTENTION_TASK_STATUSES).toContain('waiting_user');
  });

  it('reports a worker-restart task as attention, not as progress', () => {
    expect(COGSEED_ACTIVE_TASK_STATUSES).not.toContain('recoverable');
    expect(COGSEED_ATTENTION_TASK_STATUSES).toContain('recoverable');
  });

  it('keeps active and terminal disjoint', () => {
    for (const status of COGSEED_ACTIVE_TASK_STATUSES) {
      expect(COGSEED_TERMINAL_TASK_STATUSES).not.toContain(status);
      expect(COGSEED_ATTENTION_TASK_STATUSES).not.toContain(status);
    }
  });

  it('classifies every status the backend can produce', () => {
    const all = [
      'planned', 'created', 'queued', 'running',
      'waiting_user', 'recoverable',
      'completed', 'failed', 'cancelled',
    ];
    const buckets = [
      COGSEED_ACTIVE_TASK_STATUSES,
      COGSEED_ATTENTION_TASK_STATUSES,
      COGSEED_TERMINAL_TASK_STATUSES,
    ];
    for (const status of all) {
      const hits = buckets.filter((bucket) => (bucket as readonly string[]).includes(status));
      expect(hits.length, `${status} must land in at least one bucket`).toBeGreaterThan(0);
    }
  });
});
