/**
 * Background-job completion bridge.
 *
 * Decision 2 delivers a promoted run's result as a second-phase envelope that the
 * p3394 bridge consumes: it lands in the conversation as a projected message. The
 * *task* record, however, lives in `cogseed_backend` — and that module already
 * imports the bridge, so the bridge cannot import it back without a cycle.
 *
 * This module is the neutral seam: the bridge reports "this job finished" here, and
 * the backend registers a settler that moves the task out of `background`. Both
 * sides depend only on this file, and a missing settler is harmless (the message
 * still lands in the conversation).
 */

export interface BackgroundJobFinished {
  /** Owning user, so the backend can find the task without scanning every user. */
  uid?: string;
  job_id: string;
  outcome: 'completed' | 'failed' | 'timeout';
  summary?: string;
  errorMessage?: string;
}

type BackgroundJobSettler = (finished: BackgroundJobFinished) => void | Promise<void>;

const settlers: BackgroundJobSettler[] = [];

/** Register a consumer of finished background jobs. Returns an unsubscribe. */
export function onBackgroundJobFinished(settler: BackgroundJobSettler): () => void {
  settlers.push(settler);
  return () => {
    const index = settlers.indexOf(settler);
    if (index >= 0) settlers.splice(index, 1);
  };
}

/**
 * Report a finished background job to every registered settler. A throwing settler
 * must not break delivery — the message has already been projected.
 */
export async function settleBackgroundJob(finished: BackgroundJobFinished): Promise<void> {
  for (const settler of [...settlers]) {
    try {
      await settler(finished);
    } catch { /* a failing settler must not block the others or the delivery */ }
  }
}

/** Test seam: drop every registered settler. */
export function resetBackgroundJobSettlers(): void {
  settlers.length = 0;
}
