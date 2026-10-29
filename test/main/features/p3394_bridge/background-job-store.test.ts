/**
 * Decision 2 · background-job ledger (machine-private `<uid>/local/p3394`).
 *
 * The ledger is what makes phase 2 replayable: write-ahead before delivery,
 * job_id as the idempotency key, 0600 because it carries the bridge token.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  P3394_BACKGROUND_JOB_DEADLINE_MS,
} from '../../../../src/main/features/p3394_bridge/background-jobs';
import {
  backgroundJobsFile,
  backgroundTimeoutResult,
  getBackgroundJob,
  listUndeliveredBackgroundJobs,
  loadBackgroundJobs,
  patchBackgroundJob,
  putBackgroundJob,
  requeueBackgroundJob,
  type P3394BackgroundJobRecord,
} from '../../../../src/main/features/p3394_bridge/background-job-store';

const uids: string[] = [];

function freshUid(): string {
  const uid = 'bgstore-' + Math.random().toString(36).slice(2, 10);
  uids.push(uid);
  return uid;
}

afterEach(() => {
  for (const uid of uids.splice(0)) {
    try { fs.rmSync(path.dirname(path.dirname(backgroundJobsFile(uid))), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function record(overrides: Partial<P3394BackgroundJobRecord> = {}): P3394BackgroundJobRecord {
  const now = new Date().toISOString();
  return {
    job_id: 'bg-hermes-tsk-1',
    peer: 'hermes',
    reply_endpoint: 'http://127.0.0.1:8444',
    reply_token: 'secret-token',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    state: 'pending',
    accepted_at: now,
    updated_at: now,
    session_id: 'ses-bg-1',
    task_id: 'tsk-bg-1',
    ...overrides,
  };
}

describe('p3394 background job ledger', () => {
  it('pins the independent 60-minute ceiling', () => {
    expect(P3394_BACKGROUND_JOB_DEADLINE_MS).toBe(60 * 60 * 1000);
  });

  it('persists to <uid>/local/p3394/background-jobs.json with mode 0600', () => {
    const uid = freshUid();
    const file = backgroundJobsFile(uid);
    expect(file.endsWith(path.join('local', 'p3394', 'background-jobs.json'))).toBe(true);
    putBackgroundJob(uid, record());
    expect(fs.existsSync(file)).toBe(true);
    expect(loadBackgroundJobs(uid)).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('upserts by job_id: a duplicate accepted cannot mint a second job', () => {
    const uid = freshUid();
    putBackgroundJob(uid, record());
    putBackgroundJob(uid, record({ eta_seconds: 30 }));
    expect(loadBackgroundJobs(uid)).toHaveLength(1);
    expect(loadBackgroundJobs(uid)[0].eta_seconds).toBe(30);
  });

  it('lists only undelivered states and degrades a corrupt file to empty', () => {
    const uid = freshUid();
    putBackgroundJob(uid, record({ job_id: 'bg-a-1' }));
    putBackgroundJob(uid, record({ job_id: 'bg-a-2', state: 'delivered' }));
    putBackgroundJob(uid, record({ job_id: 'bg-a-3', state: 'isolated' }));
    putBackgroundJob(uid, record({
      job_id: 'bg-a-4',
      state: 'finished',
      result: { phase: 'finished', job_id: 'bg-a-4', outcome: 'completed', summary: 'ok' },
    }));
    expect(listUndeliveredBackgroundJobs(uid).map((entry) => entry.job_id).sort()).toEqual(['bg-a-1', 'bg-a-4']);

    fs.writeFileSync(backgroundJobsFile(uid), '{not json');
    expect(loadBackgroundJobs(uid)).toEqual([]);
  });

  it('patches atomically and refuses to change the job id', () => {
    const uid = freshUid();
    putBackgroundJob(uid, record());
    const updated = patchBackgroundJob(uid, 'bg-hermes-tsk-1', { state: 'finished', attempts: 2 });
    expect(updated).toMatchObject({ job_id: 'bg-hermes-tsk-1', state: 'finished', attempts: 2 });
    expect(getBackgroundJob(uid, 'bg-hermes-tsk-1')?.state).toBe('finished');
    expect(patchBackgroundJob(uid, 'bg-missing', { state: 'finished' })).toBeNull();
  });

  it('requeues an isolated job only (keeps history, resets the budget)', () => {
    const uid = freshUid();
    putBackgroundJob(uid, record({ job_id: 'bg-a-1', state: 'isolated' }));
    expect(requeueBackgroundJob(uid, 'bg-a-1')).toBe(true);
    expect(getBackgroundJob(uid, 'bg-a-1')).toMatchObject({ state: 'pending', attempts: 0 });
    putBackgroundJob(uid, record({ job_id: 'bg-a-2', state: 'delivered' }));
    expect(requeueBackgroundJob(uid, 'bg-a-2')).toBe(false);
  });

  it('builds a timeout result with the protocol error code', () => {
    expect(backgroundTimeoutResult('bg-a-b')).toMatchObject({
      phase: 'finished',
      job_id: 'bg-a-b',
      outcome: 'timeout',
      error: { code: 'p3394_background_timeout' },
    });
  });
});
