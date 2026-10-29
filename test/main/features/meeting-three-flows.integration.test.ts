/**
 * Meeting Agent 三条主干的端到端契约：
 *   1. 转写纠错：scan → apply → 重复 apply 幂等回执；
 *   2. 本地沉淀：publish_outputs 声明的产物集合（消息 footer 只显示这一组）；
 *   3. 知识库沉淀：四份产物真实落进 contexts，重复发布不产副本，确认版变化落 _vNNN。
 *
 * 不打桩被测链路本身，只打桩索引/搜索/日志等副作用边界；使用临时
 * `COGSEED_WORKSPACE_ROOT`，不触碰真实用户数据。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const enqueued: Array<{ userId: string; relPath: string; op: string }> = [];
vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: (userId: string, relPath: string, op = 'upsert') => { enqueued.push({ userId, relPath, op }); },
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

const USER = 'meeting-three-flows-user';
let ws = '';
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-three-flows-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = ws;
  enqueued.length = 0;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(ws, { recursive: true, force: true });
});

function workDir(): string {
  const dir = path.join(ws, 'meeting-output');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function contextsRoot(): string {
  return path.join(ws, USER, 'cloud', 'contexts');
}

function kbFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (path.basename(abs) !== '_INDEX.md') out.push(abs);
    }
  };
  if (fs.existsSync(contextsRoot())) walk(contextsRoot());
  return out;
}

async function load() {
  const users = await import('../../../src/main/features/users');
  users.activateUser(USER);
  const contexts = await import('../../../src/main/features/contexts');
  const glossaryTools = await import('../../../src/main/features/transcript-agent-tools');
  const tasks = await import('../../../src/main/features/cogseed_backend/task-store');
  const sessions = await import('../../../src/main/features/cogseed_runtime/kernel/session-store');
  const publish = await import('../../../src/main/features/cogseed_backend/publish-runtime-outputs');
  const bus = await import('../../../src/main/features/group_chat/bus');
  const precipitate = await import('../../../src/main/features/meeting_kb_precipitate');
  return { contexts, glossaryTools, tasks, sessions, publish, bus, precipitate };
}

async function recordWrite(
  sessions: Awaited<ReturnType<typeof load>>['sessions'],
  sessionId: string,
  requestId: string,
  absPath: string,
) {
  await sessions.appendNativeSessionRecord(USER, sessionId, {
    type: 'turn',
    request_id: requestId,
    role: 'tool',
    content: '<runtime-tool-result/>',
    created_at: new Date().toISOString(),
    tool: { name: 'write_file', input: { path: absPath, content: 'x' }, result: { content: 'ok' } },
  });
}

describe('智能会议Agent 三条主干契约', () => {
  it('correction → local publish → knowledge-base precipitation, idempotently and with versioned revisions', async () => {
    const { contexts, glossaryTools, tasks, sessions, publish, bus } = await load();
    const work = workDir();

    // ── 1. 纠错：scan → apply → 重复 apply 幂等 ──────────────────────────
    const raw = path.join(work, '2026-10-18_评审_123_转写.md');
    const corrected = path.join(work, '2026-10-18_评审_123_转写-纠错.md');
    fs.writeFileSync(raw, '我用 coxy 做了个东西。');
    const tools = glossaryTools.createTranscriptGlossaryTools({
      userId: USER,
      files: { readRoots: [work], writeRoots: [work], workingDir: work },
    });
    const run = async (name: string, input: Record<string, unknown>) =>
      tools.find((tool) => tool.name === name)!.execute(input, { state: {} }) as Promise<{ content: string; isError?: boolean }>;

    await run('transcript_glossary_upsert', { wrong: 'coxy', correct: 'Cogseed', kind: 'product' });
    // Rule-only scan: a headless run has no model for the open-set review, and
    // `includeReview:false` is the documented rule-only path (not a silent skip).
    const scan = await run('transcript_glossary_scan', { path: raw, rawOutputPath: raw, outputPath: corrected, includeReview: false });
    expect(scan.isError).not.toBe(true);
    const firstApply = await run('transcript_glossary_apply', { path: raw });
    expect(firstApply.content).toContain('status: applied');
    expect(firstApply.content).toContain(`corrected_path: ${corrected}`);
    expect(fs.readFileSync(corrected, 'utf8')).toContain('Cogseed');
    const secondApply = await run('transcript_glossary_apply', { path: raw });
    expect(secondApply.content).toContain('already applied for this exact source');
    expect(secondApply.content).not.toContain('MUST confirm');

    // ── 2. 本地沉淀：四份产物 + publish_outputs 声明 ─────────────────────
    const minutes = path.join(work, '2026-10-18_评审_123_会议纪要_v001.md');
    const actions = path.join(work, '2026-10-18_评审_123_任务清单_v001.md');
    fs.writeFileSync(minutes, '# 会议纪要 v001');
    fs.writeFileSync(actions, '# 任务清单 v001');
    const artifacts = [raw, corrected, minutes, actions];

    const task = (await tasks.createCogSeedTask(USER, { requestId: 'req-three-flows', task: 'meeting' })).task;
    await sessions.createNativeRuntimeSession(USER, task.runtimeSessionId, new Date().toISOString());
    for (const artifact of artifacts) {
      await recordWrite(sessions, task.runtimeSessionId, task.requestId, artifact);
    }
    const publishCall = () => publish.runPublishRuntimeOutputs({
      userId: USER,
      requestId: task.requestId,
      runtimeSessionId: task.runtimeSessionId,
      workingDir: work,
      writableRoots: [work],
      input: { paths: artifacts },
    });

    const published = await publishCall();
    expect(published.isError).not.toBe(true);
    const publishedBody = JSON.parse(published.content);
    expect(publishedBody.published).toBe(4);
    expect(publishedBody.results.every((entry: { status: string }) => entry.status === 'added')).toBe(true);

    const afterFirst = kbFiles();
    for (const expected of ['转写.md', '转写-纠错.md', '会议纪要_v001.md', '任务清单_v001.md']) {
      expect(afterFirst.some((file) => file.endsWith(expected)), expected).toBe(true);
    }
    // 四份同前缀 → 同一个归集目录。
    const dirs = new Set(afterFirst.map((file) => path.dirname(file)));
    expect(dirs.size).toBe(1);
    expect(enqueued.length).toBeGreaterThanOrEqual(4);

    // 重复发布：不产副本。
    const repeated = await publishCall();
    expect(JSON.parse(repeated.content).published).toBe(0);
    expect(kbFiles().length).toBe(afterFirst.length);

    // 确认版内容变化：落 _v002，原 v001 保留。
    fs.writeFileSync(minutes, '# 会议纪要 v002 已确认');
    const revised = await publish.runPublishRuntimeOutputs({
      userId: USER,
      requestId: task.requestId,
      runtimeSessionId: task.runtimeSessionId,
      workingDir: work,
      writableRoots: [work],
      input: { paths: [minutes] },
    });
    const revisedBody = JSON.parse(revised.content);
    expect(revisedBody.published).toBe(1);
    expect(revisedBody.results[0].added.join(',')).toContain('会议纪要_v002.md');
    const minuteFiles = kbFiles().filter((file) => path.basename(file).startsWith('会议纪要'));
    expect(minuteFiles.map((file) => path.basename(file)).sort()).toEqual(['会议纪要_v001.md', '会议纪要_v002.md']);
    expect(fs.readFileSync(minuteFiles.find((file) => file.endsWith('v001.md'))!, 'utf8')).toBe('# 会议纪要 v001');

    // ── 3. 本地可见性：footer 只取 publish_outputs 的声明集合 ────────────
    const process = [{
      type: 'event' as const,
      event: {
        stream: 'tool',
        data: { phase: 'start', name: 'publish_outputs', arguments: { paths: artifacts } },
      },
    }];
    const visible = bus.projectedProducedFiles(process as never);
    expect(visible.sort()).toEqual([...artifacts].sort());

    void contexts;
  });

  it('archives transcript + corrected transcript at terminal even when publish_outputs was never called', async () => {
    const { tasks, sessions, precipitate } = await load();
    const work = workDir();
    const raw = path.join(work, '2026-10-18_评审_999_转写.md');
    const corrected = path.join(work, '2026-10-18_评审_999_转写-纠错.md');
    const minutes = path.join(work, '2026-10-18_评审_999_会议纪要_v001.md');
    fs.writeFileSync(raw, '原始转写');
    fs.writeFileSync(corrected, '纠错转写');
    fs.writeFileSync(minutes, '未确认纪要');

    const task = (await tasks.createCogSeedTask(USER, { requestId: 'req-sweep', task: 'meeting' })).task;
    await sessions.createNativeRuntimeSession(USER, task.runtimeSessionId, new Date().toISOString());
    // The two correction artifacts are written by the HOST tools, not write_file.
    await sessions.appendNativeSessionRecord(USER, task.runtimeSessionId, {
      type: 'turn',
      request_id: task.requestId,
      role: 'tool',
      content: 'status: scanned',
      created_at: new Date().toISOString(),
      tool: { name: 'transcript_glossary_scan', input: { path: raw, rawOutputPath: raw }, result: { content: 'status: scanned' } },
    });
    await sessions.appendNativeSessionRecord(USER, task.runtimeSessionId, {
      type: 'turn',
      request_id: task.requestId,
      role: 'tool',
      content: `status: applied\ncorrected_path: ${corrected}`,
      created_at: new Date().toISOString(),
      tool: {
        name: 'transcript_glossary_apply',
        input: { path: raw },
        result: { content: `status: applied\ncorrected_path: ${corrected}`, correction: { docId: 'doc', sourceHash: 'hash', state: 'applied' } },
      },
    });
    // Minutes are model-written and must only be archived through a declaration.
    await recordWrite(sessions, task.runtimeSessionId, task.requestId, minutes);

    const sweep = await precipitate.sweepRuntimeCorrectionArtifacts(USER, task.runtimeSessionId);
    expect(sweep.considered).toBe(2);
    expect(sweep.added).toHaveLength(2);
    const names = kbFiles().map((file) => path.basename(file));
    expect(names).toEqual(expect.arrayContaining(['转写.md', '转写-纠错.md']));
    expect(names).not.toContain('会议纪要_v001.md');

    const repeated = await precipitate.sweepRuntimeCorrectionArtifacts(USER, task.runtimeSessionId);
    expect(repeated.added).toHaveLength(0);
    expect(kbFiles().filter((file) => path.basename(file).startsWith('转写')).length).toBe(2);
  });

});
