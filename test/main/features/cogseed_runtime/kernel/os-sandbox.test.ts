import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runRuntimeBashTool } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/shell-tools';
import type { RuntimeToolCallContext } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/file-tools';
import { wrapBashForOsSandbox } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/os-sandbox';

let tmp: string;
let workspace: string;
let outside: string;
let previousSandbox: string | undefined;

beforeEach(() => {
  previousSandbox = process.env.COGSEED_OS_SANDBOX;
  process.env.COGSEED_OS_SANDBOX = '1';
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-os-sandbox-')));
  workspace = path.join(tmp, 'workspace');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  if (previousSandbox === undefined) delete process.env.COGSEED_OS_SANDBOX;
  else process.env.COGSEED_OS_SANDBOX = previousSandbox;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function context(): RuntimeToolCallContext {
  return {
    userId: 'u1',
    runtimeSessionId: 'mruntime-os-sandbox',
    allowedRoots: [workspace],
    writableRoots: [workspace],
    workspaceRoot: workspace,
    pcDir: process.cwd(),
    // Kernel bash asks the host preflight on every call (reception may need a
    // per-action approval); an ordinary session's decision is just "allowed".
    beforeAction: async () => undefined,
    toolPolicy: {
      fileRead: 'explicit_roots',
      fileWrite: 'explicit_writable_roots',
      shell: 'allow_with_confirmation',
      skillRun: 'none',
      network: 'none',
      connectors: 'enabled',
    },
  };
}

describe('OS sandbox wrapper', () => {
  it('only wraps on macOS and keeps the original command in argv', () => {
    expect(wrapBashForOsSandbox('echo ok', { workspaceRoot: workspace }, { platform: 'win32' })).toBeNull();
    expect(wrapBashForOsSandbox('echo ok', { workspaceRoot: workspace }, { platform: 'linux' })).toMatchObject({
      file: 'bwrap',
      enforcement: 'os-full',
    });
    const wrapped = wrapBashForOsSandbox('echo ok', { workspaceRoot: workspace }, { platform: 'darwin' });
    expect(wrapped).toMatchObject({ file: '/usr/bin/sandbox-exec', enforcement: 'os-full' });
    expect(wrapped?.args).toContain('echo ok');
  });

  it.runIf(process.platform === 'darwin')('allows workspace writes and denies writes outside it', async () => {
    if (!fs.existsSync('/usr/bin/sandbox-exec')) return;
    const inside = await runRuntimeBashTool({ command: `printf ok > ${workspace}/inside.txt` }, context(), {
      userId: 'u1',
      runtimeSessionId: 'mruntime-os-sandbox',
    });
    expect(inside.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8')).toBe('ok');

    const outsideResult = await runRuntimeBashTool({ command: `printf no > ${outside}/outside.txt` }, context(), {
      userId: 'u1',
      runtimeSessionId: 'mruntime-os-sandbox',
    });
    expect(outsideResult.isError).toBeTruthy();
    expect(fs.existsSync(path.join(outside, 'outside.txt'))).toBe(false);
  });
});
