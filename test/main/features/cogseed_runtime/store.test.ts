import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as paths from '../../../../src/main/paths';
import {
  appendRuntimeRunEvent,
  readRuntimeRunEvents,
  runtimeRunEventsFile,
  writeRuntimeRunMeta,
} from '../../../../src/main/features/cogseed_runtime/store';

afterEach(() => {
  fs.rmSync(paths.userRoot('runtime-store-user'), { recursive: true, force: true });
});

describe('Mate Agent Runtime local run store', () => {
  it('writes metadata and events under local/mate_runtime/runs', async () => {
    const uid = 'runtime-store-user';
    const runId = 'run_abc123';

    await writeRuntimeRunMeta(uid, runId, {
      run_id: runId,
      request_id: 'req-abc123',
      runtime_session_id: 'mruntime-abc123',
      status: 'running',
      created_at: '2026-08-04T00:00:00',
    });
    await appendRuntimeRunEvent(uid, runId, {
      type: 'event',
      request_id: 'req-abc123',
      runtime_session_id: 'mruntime-abc123',
      status: 'started',
      text: 'started',
    });

    expect(runtimeRunEventsFile(uid, runId)).toBe(path.join(paths.userLocalRoot(uid), 'mate_runtime', 'runs', runId, 'events.jsonl'));
    expect(fs.existsSync(path.join(paths.userLocalRoot(uid), 'mate_runtime', 'runs', runId, 'meta.json'))).toBe(true);
    expect(await readRuntimeRunEvents(uid, runId)).toEqual([
      expect.objectContaining({ type: 'event', request_id: 'req-abc123', status: 'started' }),
    ]);
  });

  it('rejects invalid run ids before touching disk', async () => {
    await expect(appendRuntimeRunEvent('runtime-store-user', '../escape', {
      type: 'event',
      request_id: 'req-1',
      runtime_session_id: 'mruntime-1',
      status: 'started',
    })).rejects.toThrow(/invalid runtime run id/);
  });
});
