// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeProcessResult {
  stdout: string;
  stderr: string;
}
export interface WorktreeProcessInspection {
  state: 'clear' | 'active' | 'unknown';
}

async function execFixedArgv(
  command: 'git' | 'lsof',
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<WorktreeProcessResult> {
  const result = await execFileAsync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

/** Run Git with an argv array. Shell parsing is never enabled. */
export function runWorktreeGit(cwd: string, args: string[]): Promise<WorktreeProcessResult> {
  return execFixedArgv('git', args, cwd, 30_000);
}

/** Fail closed when macOS cannot prove that the directory has no open handles. */
export async function inspectMacWorktreeProcesses(
  worktreePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<WorktreeProcessInspection> {
  if (platform !== 'darwin') return { state: 'clear' };
  try {
    const result = await execFixedArgv(
      'lsof',
      ['-n', '-P', '-F', 'p', '+D', worktreePath],
      path.dirname(worktreePath),
      15_000,
    );
    return { state: /^p\d+/m.test(result.stdout) ? 'active' : 'clear' };
  } catch (error) {
    const candidate = error as { code?: unknown; stdout?: unknown };
    if ((candidate.code === 1 || candidate.code === '1') && !String(candidate.stdout || '').trim()) {
      return { state: 'clear' };
    }
    return { state: 'unknown' };
  }
}
