import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The tools resolve uid-scoped paths per call, so redirecting the two helpers
 *  is enough to make them hermetic. */
let tmpRoot = '';
vi.mock('../../../../src/main/paths', () => ({
  userBackgroundRunsDir: (uid: string) => path.join(tmpRoot, uid, 'background_runs'),
  userBackgroundRunFile: (uid: string, runId: string) =>
    path.join(tmpRoot, uid, 'background_runs', `${runId}.json`),
  userLocalRoot: (uid: string) => path.join(tmpRoot, uid),
}));

type Store = typeof import('../../../../src/main/features/local_agents/background_runs');
type Registry = typeof import('../../../../src/main/features/local_agents/background_run_registry');
type Tools = typeof import('../../../../src/main/model/core-agent/background-run-tools');

const UID = 'user-a';

async function loadModules(): Promise<{ store: Store; registry: Registry; tools: Tools }> {
  return {
    store: await import('../../../../src/main/features/local_agents/background_runs'),
    registry: await import('../../../../src/main/features/local_agents/background_run_registry'),
    tools: await import('../../../../src/main/model/core-agent/background-run-tools'),
  };
}

function seedRecord(store: Store, over: Record<string, unknown> = {}) {
  store.createBackgroundRun({
    runId: 'run-1',
    kind: 'local-cli',
    cli: 'claude',
    uid: UID,
    cwd: tmpRoot,
    argv: ['claude'],
    pid: 4242,
    startedAt: '2026-10-16T10:00:00.000Z',
    promotedBy: 'wall',
    outputPath: path.join(tmpRoot, UID, 'outputs', 'run-1.txt'),
    status: 'running',
    updatedAt: '2026-10-16T10:00:00.000Z',
    ...over,
  } as never);
}

function tool(tools: Tools, name: string) {
  const found = tools.createBackgroundRunTools({ userId: UID }).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not created`);
  return found;
}

describe('core-agent › background run tools', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-tools-'));
  });
  afterEach(async () => {
    const { registry } = await loadModules();
    registry.__resetPromotedRunsForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('registers exactly the three documented tools', async () => {
    const { tools } = await loadModules();
    expect(tools.createBackgroundRunTools({ userId: UID }).map((t) => t.name).sort())
      .toEqual(['background_list', 'background_output', 'background_stop']);
  });

  it('background_list says so when there is nothing, and reports liveness', async () => {
    const { store, registry, tools } = await loadModules();
    const list = tool(tools, 'background_list');

    const empty = await list.execute({}, {} as never);
    expect(String(empty.content)).toBe('No background runs.');

    seedRecord(store);
    const settled = await list.execute({}, {} as never);
    expect(String(settled.content)).toContain('run-1');
    expect(String(settled.content)).toContain('alive=no');

    // A live registration flips liveness and surfaces the pid the record cannot know.
    registry.registerPromotedRun({ runId: 'run-1', uid: UID, cli: 'claude', pid: 777, stop: vi.fn() });
    const live = await list.execute({}, {} as never);
    expect(String(live.content)).toContain('alive=yes');
    expect(String(live.content)).toContain('pid=777');
  });

  it('background_output reads only the tail of the recorded output', async () => {
    const { store, tools } = await loadModules();
    seedRecord(store);
    const outFile = path.join(tmpRoot, UID, 'outputs', 'run-1.txt');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n'), 'utf8');

    const res = await tool(tools, 'background_output').execute({ run_id: 'run-1', tail_lines: 2 }, {} as never);
    const text = String(res.content);
    expect(text).toContain('showing the last 2 lines');
    expect(text).toContain('l4');
    expect(text).toContain('l5');
    expect(text).not.toContain('l1');
  });

  it('background_output refuses an unknown run and an out-of-tree output path', async () => {
    const { store, tools } = await loadModules();
    const out = tool(tools, 'background_output');

    const missing = await out.execute({ run_id: 'nope' }, {} as never);
    expect(missing.isError).toBe(true);
    expect(String(missing.content)).toContain('E_NOT_FOUND');

    // A tampered record must not become an arbitrary-file read.
    seedRecord(store, { outputPath: path.join(os.tmpdir(), 'outside-the-user-tree.txt') });
    const denied = await out.execute({ run_id: 'run-1' }, {} as never);
    expect(denied.isError).toBe(true);
    expect(String(denied.content)).toContain('E_PATH_DENIED');
  });

  it('background_stop refuses a run with no live process and stops a live one', async () => {
    const { store, registry, tools } = await loadModules();
    seedRecord(store);
    const stop = tool(tools, 'background_stop');

    const notLive = await stop.execute({ run_id: 'run-1' }, {} as never);
    expect(notLive.isError).toBe(true);
    expect(String(notLive.content)).toContain('E_NOT_LIVE');

    const stopFn = vi.fn();
    registry.registerPromotedRun({ runId: 'run-1', uid: UID, cli: 'claude', pid: 777, stop: stopFn });
    const live = await stop.execute({ run_id: 'run-1' }, {} as never);
    expect(live.isError).toBeFalsy();
    expect(stopFn).toHaveBeenCalledWith('user-stop');
  });

  it('refuses every tool when there is no active user', async () => {
    const { tools } = await loadModules();
    const anonymous = tools.createBackgroundRunTools({});
    for (const name of ['background_list', 'background_output', 'background_stop']) {
      const t = anonymous.find((x) => x.name === name)!;
      const res = await t.execute({ run_id: 'run-1' }, {} as never);
      expect(res.isError).toBe(true);
      expect(String(res.content)).toContain('E_NO_USER');
    }
  });
});
