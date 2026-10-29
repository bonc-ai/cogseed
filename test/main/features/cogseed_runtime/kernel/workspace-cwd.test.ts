import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runRuntimeBashTool } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/shell-tools';
import type { RuntimeToolCallContext } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/file-tools';

let tmp: string;
let workspace: string;
let attachments: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cwd-')));
  workspace = path.join(tmp, 'workspace');
  attachments = path.join(tmp, 'attachments');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(attachments, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * runtime bash 用的是**宿主 shell**（`spawn(command, { shell: true })` 在 win32 上
 * 就是 ComSpec=cmd.exe，见 shell-tools.ts 的 runProcess）。所以 `pwd` / `$VAR`
 * 这类 POSIX 语法不是「cwd 语义」，而是另一套 shell 语言：
 *   - win32 CI 的 PATH 上有 Git Bash 的 `usr/bin`，`pwd.exe` 会被 cmd 找到，
 *     打印的是 MSYS 形状的 `/tmp/...`（%TEMP% 的挂载点），不是 Node 看到的
 *     `C:\...`；`$COGSEED_WORKSPACE_DIR` 在 cmd 里更是原样输出（不展开）。
 * 断言要守的是「shell 的 cwd / 环境变量指向 workspace」，不是某种 shell 方言，
 * 所以按宿主 shell 取等价命令：cmd 用 `cd`（无参数时打印当前目录）和 `%VAR%`。
 */
function hostShell(posix: string, cmd: string): string {
  return process.platform === 'win32' ? cmd : posix;
}

function context(): RuntimeToolCallContext {
  return {
    userId: 'u1',
    runtimeSessionId: 'mruntime-cwd',
    allowedRoots: [attachments, workspace],
    writableRoots: [workspace],
    workspaceRoot: workspace,
    pcDir: process.cwd(),
    // Host preflight is mandatory for runtime bash; ordinary runs allow it.
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

describe('runtime shell workspace cwd', () => {
  it('defaults to the workspace, not the first read-only attachment root', async () => {
    const result = await runRuntimeBashTool({ command: hostShell('pwd', 'cd') }, context(), {
      userId: 'u1',
      runtimeSessionId: 'mruntime-cwd',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe(workspace);
  });

  it('exposes COGSEED_WORKSPACE_DIR as the workspace root', async () => {
    const result = await runRuntimeBashTool({
      command: hostShell('printf "%s" "$COGSEED_WORKSPACE_DIR"', 'echo %COGSEED_WORKSPACE_DIR%'),
    }, context(), {
      userId: 'u1',
      runtimeSessionId: 'mruntime-cwd',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe(workspace);
  });
});
