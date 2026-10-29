import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runRuntimeFileTool } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/file-tools';
import type { RuntimeToolCallContext } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/file-tools';

let tmp: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-danger-files-')));
  workspace = path.join(tmp, 'workspace');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function context(fileWrite: 'explicit_writable_roots' | 'all'): RuntimeToolCallContext {
  return {
    userId: 'u1',
    runtimeSessionId: 'mruntime-danger-files',
    allowedRoots: [workspace],
    writableRoots: [workspace],
    workspaceRoot: workspace,
    pcDir: process.cwd(),
    // Host preflight is mandatory for runtime writes; an ordinary session's
    // decision is "allowed" without a reception approval.
    beforeAction: async () => undefined,
    toolPolicy: {
      fileRead: 'all',
      fileWrite,
      shell: 'allow_with_confirmation',
      skillRun: 'none',
      network: 'none',
      connectors: 'enabled',
    },
  };
}

describe('danger full access file tools', () => {
  it('reads and writes outside the workspace only when fileWrite=all', async () => {
    const target = path.join(outside, 'danger.txt');
    const denied = await runRuntimeFileTool('write_file', { path: target, content: 'no' }, context('explicit_writable_roots'), {
      userId: 'u1',
      runtimeSessionId: 'mruntime-danger-files',
    });
    expect(denied.isError).toBeTruthy();

    const written = await runRuntimeFileTool('write_file', { path: target, content: 'danger' }, context('all'), {
      userId: 'u1',
      runtimeSessionId: 'mruntime-danger-files',
    });
    expect(written.isError).toBeFalsy();
    expect(fs.readFileSync(target, 'utf8')).toBe('danger');

    const read = await runRuntimeFileTool('read_file', { path: target }, context('all'), {
      userId: 'u1',
      runtimeSessionId: 'mruntime-danger-files',
    });
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('danger');
  });
});
