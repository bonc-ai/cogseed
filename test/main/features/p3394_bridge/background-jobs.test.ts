import { describe, expect, it } from 'vitest';

import {
  P3394_BACKGROUND_OUTCOMES,
  backgroundJobId,
  backgroundResultIsInformative,
  parseBackgroundAccepted,
  parseBackgroundFinished,
  parseBackgroundPhase,
} from '../../../../src/main/features/p3394_bridge/background-jobs';

/**
 * Decision 2, phase 1 of the work: the wire shapes for a promoted run.
 *
 * These are the contract the gateway and the hub both parse, so the tests pin the
 * accepted shapes and the look-alikes that must be refused — a lenient parser here
 * would let an unrelated `extensions.background` object resolve a reply waiter.
 */
describe('p3394 › background jobs protocol', () => {
  describe('backgroundJobId', () => {
    it('is deterministic for the same peer and task', () => {
      expect(backgroundJobId('peer-a', 'task-1')).toBe('bg-peer-a-task-1');
      expect(backgroundJobId('peer-a', 'task-1')).toBe(backgroundJobId('peer-a', 'task-1'));
    });

    it('distinguishes different peers and tasks', () => {
      expect(backgroundJobId('peer-a', 'task-1')).not.toBe(backgroundJobId('peer-b', 'task-1'));
      expect(backgroundJobId('peer-a', 'task-1')).not.toBe(backgroundJobId('peer-a', 'task-2'));
    });

    it('sanitizes characters that would break the id pattern', () => {
      const id = backgroundJobId('peer/a b', 'task:1/x');
      expect(id.startsWith('bg-')).toBe(true);
      expect(id).not.toContain('/');
      expect(parseBackgroundAccepted({ phase: 'accepted', job_id: id })).not.toBeNull();
    });
  });

  describe('parseBackgroundAccepted', () => {
    it('accepts the minimal ack and keeps an eta when sane', () => {
      expect(parseBackgroundAccepted({ phase: 'accepted', job_id: 'bg-p-t' })).toEqual({
        phase: 'accepted',
        job_id: 'bg-p-t',
      });
      expect(parseBackgroundAccepted({ phase: 'accepted', job_id: 'bg-p-t', eta_seconds: 900 }))
        .toEqual({ phase: 'accepted', job_id: 'bg-p-t', eta_seconds: 900 });
    });

    it('drops nonsense etas instead of failing the ack', () => {
      expect(parseBackgroundAccepted({ phase: 'accepted', job_id: 'bg-p-t', eta_seconds: -1 }))
        .toEqual({ phase: 'accepted', job_id: 'bg-p-t' });
      expect(parseBackgroundAccepted({ phase: 'accepted', job_id: 'bg-p-t', eta_seconds: 10 ** 9 }))
        .toEqual({ phase: 'accepted', job_id: 'bg-p-t' });
    });

    it('refuses a malformed job id, a missing phase, and a finished phase', () => {
      expect(parseBackgroundAccepted({ phase: 'accepted', job_id: 'not-a-job' })).toBeNull();
      expect(parseBackgroundAccepted({ job_id: 'bg-p-t' })).toBeNull();
      expect(parseBackgroundAccepted({ phase: 'finished', job_id: 'bg-p-t' })).toBeNull();
      expect(parseBackgroundAccepted(null)).toBeNull();
      expect(parseBackgroundAccepted('bg-p-t')).toBeNull();
    });
  });

  describe('parseBackgroundFinished', () => {
    it('accepts every declared outcome', () => {
      for (const outcome of P3394_BACKGROUND_OUTCOMES) {
        expect(parseBackgroundFinished({ phase: 'finished', job_id: 'bg-p-t', outcome }))
          .toEqual({ phase: 'finished', job_id: 'bg-p-t', outcome });
      }
    });

    it('keeps summary, artifacts and a bounded log tail', () => {
      const parsed = parseBackgroundFinished({
        phase: 'finished',
        job_id: 'bg-p-t',
        outcome: 'completed',
        summary: 'wrote the report',
        artifacts: ['out/report.md', '  ', 42],
        log_tail: 'x'.repeat(5000),
      });
      expect(parsed?.summary).toBe('wrote the report');
      expect(parsed?.artifacts).toEqual(['out/report.md']);
      expect(parsed?.log_tail?.length).toBe(2000);
    });

    it('carries a structured error for failures', () => {
      const parsed = parseBackgroundFinished({
        phase: 'finished',
        job_id: 'bg-p-t',
        outcome: 'failed',
        error: { code: 'runtime_worker_error', message: 'no working directory' },
      });
      expect(parsed?.error).toEqual({ code: 'runtime_worker_error', message: 'no working directory' });
    });

    it('refuses unknown outcomes and look-alikes', () => {
      expect(parseBackgroundFinished({ phase: 'finished', job_id: 'bg-p-t', outcome: 'running' })).toBeNull();
      expect(parseBackgroundFinished({ phase: 'finished', job_id: 'bg-p-t' })).toBeNull();
      expect(parseBackgroundFinished({ phase: 'accepted', job_id: 'bg-p-t' })).toBeNull();
      expect(parseBackgroundFinished({ phase: 'finished', job_id: 'bg-p-t', outcome: 'completed', artifacts: 'nope' }))
        .toEqual({ phase: 'finished', job_id: 'bg-p-t', outcome: 'completed' });
    });
  });

  describe('parseBackgroundPhase', () => {
    it('returns whichever phase the object declares', () => {
      expect(parseBackgroundPhase({ phase: 'accepted', job_id: 'bg-p-t' })?.phase).toBe('accepted');
      expect(parseBackgroundPhase({ phase: 'finished', job_id: 'bg-p-t', outcome: 'timeout' })?.phase).toBe('finished');
      expect(parseBackgroundPhase({ phase: 'other' })).toBeNull();
      expect(parseBackgroundPhase(undefined)).toBeNull();
    });
  });

  describe('backgroundResultIsInformative', () => {
    it('requires something a human can read', () => {
      expect(backgroundResultIsInformative({ phase: 'finished', job_id: 'bg-p-t', outcome: 'completed' })).toBe(false);
      expect(backgroundResultIsInformative({
        phase: 'finished', job_id: 'bg-p-t', outcome: 'completed', summary: 'done',
      })).toBe(true);
      expect(backgroundResultIsInformative({
        phase: 'finished', job_id: 'bg-p-t', outcome: 'completed', artifacts: ['a.md'],
      })).toBe(true);
      expect(backgroundResultIsInformative({ phase: 'finished', job_id: 'bg-p-t', outcome: 'failed' })).toBe(false);
      expect(backgroundResultIsInformative({
        phase: 'finished', job_id: 'bg-p-t', outcome: 'failed', error: { message: 'boom' },
      })).toBe(true);
    });
  });
});
