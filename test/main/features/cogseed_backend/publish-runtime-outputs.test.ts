import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { precipitate } = vi.hoisted(() => ({ precipitate: vi.fn() }));

vi.mock('../../../../src/main/features/meeting_kb_precipitate', () => ({
  precipitatePublishedOutputs: precipitate,
}));

import * as paths from '../../../../src/main/paths';
import { runPublishRuntimeOutputs } from '../../../../src/main/features/cogseed_backend/publish-runtime-outputs';
import { createCogSeedTask } from '../../../../src/main/features/cogseed_backend/task-store';
import {
  appendNativeSessionRecord,
  createNativeRuntimeSession,
} from '../../../../src/main/features/cogseed_runtime/kernel/session-store';

const UID = 'publish-outputs-user';
let root = '';

afterEach(() => {
  precipitate.mockReset();
  fs.rmSync(paths.userRoot(UID), { recursive: true, force: true });
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

async function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-publish-'));
  const task = (await createCogSeedTask(UID, { requestId: 'req-publish', task: 'Write minutes' })).task;
  await createNativeRuntimeSession(UID, task.runtimeSessionId, '2026-10-18T00:00:00');
  return task;
}

async function recordWrite(sessionId: string, absPath: string, requestId = 'req-publish') {
  await appendNativeSessionRecord(UID, sessionId, {
    type: 'turn',
    request_id: requestId,
    role: 'tool',
    content: '<runtime-tool-result/>',
    created_at: '2026-10-18T00:00:01',
    tool: {
      name: 'write_file',
      input: { path: absPath, content: '# minutes' },
      result: { content: 'ok' },
    },
  });
}

function call(task: { runtimeSessionId: string }, input: Record<string, unknown>) {
  return runPublishRuntimeOutputs({
    userId: UID,
    requestId: 'req-publish',
    runtimeSessionId: task.runtimeSessionId,
    workingDir: root,
    writableRoots: [root],
    input,
  });
}

describe('native publish_outputs', () => {
  it('accepts only files this Agent session wrote and returns the precipitation outcome', async () => {
    const task = await setup();
    const minutes = path.join(root, '2026-10-18_评审_123_会议纪要_v001.md');
    fs.writeFileSync(minutes, '# minutes');
    await recordWrite(task.runtimeSessionId, minutes);
    const other = path.join(root, 'not-written.md');
    fs.writeFileSync(other, '# other');
    precipitate.mockResolvedValue([{
      absPath: minutes,
      basename: '2026-10-18_评审_123_会议纪要_v001.md',
      artifactKind: 'minutes',
      meetingKey: '2026-10-18-评审-123',
      target: { scope: 'global', rel: '评审/会议纪要_v001.md' },
      added: ['会议纪要_v001.md'],
      skipped: [],
      failed: [],
    }]);

    const result = await call(task, { paths: [minutes, other] });

    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content);
    expect(body.published).toBe(1);
    expect(body.inLibrary).toBe(1);
    expect(body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: minutes, status: 'added', artifactKind: 'minutes' }),
      expect.objectContaining({ path: other, status: 'not_written' }),
    ]));
    expect(precipitate).toHaveBeenCalledWith(UID, undefined, [minutes]);
  });

  it('rejects a declaration whose every path was not written this session', async () => {
    const task = await setup();
    const foreign = path.join(root, 'foreign.md');
    fs.writeFileSync(foreign, '# foreign');

    const result = await call(task, { paths: [foreign] });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      published: 0,
      results: [expect.objectContaining({ path: foreign, status: 'not_written' })],
    });
    expect(precipitate).not.toHaveBeenCalled();
  });

  it('rejects a written file outside the run writable roots', async () => {
    const task = await setup();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-publish-outside-'));
    try {
      const outside = path.join(outsideRoot, '会议纪要.md');
      fs.writeFileSync(outside, '# minutes');
      await recordWrite(task.runtimeSessionId, outside);

      const result = await call(task, { paths: [outside] });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content)).toMatchObject({
        results: [expect.objectContaining({ path: outside, status: 'outside_roots' })],
      });
      expect(precipitate).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('treats an empty declaration as a valid "no file deliverable"', async () => {
    const task = await setup();
    const result = await call(task, { paths: [] });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content)).toEqual({ published: 0, inLibrary: 0, requested: 0, results: [] });
    expect(precipitate).not.toHaveBeenCalled();
  });

  it('reports a timed-out precipitation as a per-file status instead of failing the call', async () => {
    const task = await setup();
    const minutes = path.join(root, '会议纪要.md');
    fs.writeFileSync(minutes, '# minutes');
    await recordWrite(task.runtimeSessionId, minutes);
    precipitate.mockImplementation(() => new Promise(() => {}));

    const result = await call(task, { paths: [minutes] });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      published: 0,
      results: [expect.objectContaining({ path: minutes, status: 'timeout' })],
    });
  }, 20_000);

  it('accepts host-written transcript artifacts (scan rawOutputPath / apply corrected_path)', async () => {
    const task = await setup();
    const raw = path.join(root, '2026-10-18_评审_123_转写.md');
    const corrected = path.join(root, '2026-10-18_评审_123_转写-纠错.md');
    const minutes = path.join(root, '2026-10-18_评审_123_会议纪要_v001.md');
    for (const file of [raw, corrected, minutes]) fs.writeFileSync(file, '# content');
    await appendNativeSessionRecord(UID, task.runtimeSessionId, {
      type: 'turn', request_id: 'req-publish', role: 'tool', content: 'status: scanned', created_at: '2026-10-18T00:00:01',
      tool: { name: 'transcript_glossary_scan', input: { path: raw, rawOutputPath: raw }, result: { content: 'status: scanned' } },
    });
    await appendNativeSessionRecord(UID, task.runtimeSessionId, {
      type: 'turn', request_id: 'req-publish', role: 'tool',
      content: `status: applied\ncorrected_path: ${corrected}`, created_at: '2026-10-18T00:00:02',
      tool: {
        name: 'transcript_glossary_apply',
        input: { path: raw },
        result: { content: `status: applied\ncorrected_path: ${corrected}`, correction: { docId: 'doc', sourceHash: 'hash', state: 'applied' } },
      },
    });
    await recordWrite(task.runtimeSessionId, minutes);
    precipitate.mockImplementation(async (_uid: string, _cid: string, paths: string[]) => paths.map((absPath) => ({
      absPath, basename: path.basename(absPath), artifactKind: 'minutes', meetingKey: 'k',
      target: { scope: 'global', rel: 'k' }, added: [path.basename(absPath)], skipped: [], failed: [],
    })));

    const result = await call(task, { paths: [raw, corrected, minutes] });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content).published).toBe(3);
    expect(precipitate).toHaveBeenCalledWith(UID, undefined, [raw, corrected, minutes]);
  });


  it('resolves the owning task by runtime session on a follow-up request', async () => {
    const task = await setup();
    const minutes = path.join(root, '2026-10-18_评审_123_会议纪要_v001.md');
    fs.writeFileSync(minutes, '# minutes');
    await recordWrite(task.runtimeSessionId, minutes);
    precipitate.mockResolvedValue([{
      absPath: minutes, basename: '2026-10-18_评审_123_会议纪要_v001.md',
      artifactKind: 'minutes', meetingKey: '2026-10-18-评审-123',
      target: { scope: 'global', rel: '评审/会议纪要_v001.md' },
      added: ['会议纪要_v001.md'], skipped: [], failed: [],
    }]);

    // A resumed turn gets a new request id; the session still owns the task.
    const result = await runPublishRuntimeOutputs({
      userId: UID,
      requestId: 'req-followup',
      runtimeSessionId: task.runtimeSessionId,
      workingDir: root,
      writableRoots: [root],
      input: { paths: [minutes] },
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content).published).toBe(1);
    expect(precipitate).toHaveBeenCalledWith(UID, undefined, [minutes]);
  });

});
