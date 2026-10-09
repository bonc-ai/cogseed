/**
 * Static tripwire for `scripts/lib/runtime-pids.sh` — 「本 worktree 的运行时就绪」到底怎么判定。
 *
 * 为什么需要它（2026-09-22 真机踩到）：
 *   `.worktrees/` 嵌套在仓库内部，路径形如 `<repo>/.worktrees/<name>/node_modules/...`。
 *   任何基于仓库路径前缀或子串包含的宽松匹配，都会把嵌套 worktree 的实例算成本 worktree
 *   的运行时；而同一 variant 共享 userData 与单实例锁，本 worktree 的实例会先起来再被锁
 *   挡下退出——只看一次进程存在就会报「已就绪」，窗口里实际跑的是别的 checkout 的代码。
 *
 * 断言边界：
 *   - 本 worktree 的主进程与 gateway 子进程必须被识别；
 *   - 嵌套 worktree（`.worktrees/<name>/…`）的主进程与 gateway **绝不能**算作本 worktree；
 *   - 嵌套 worktree 的主进程必须能被单独识别出来（用于单实例锁冲突诊断）；
 *   - 无关进程一律忽略。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '../..');
const lib = path.join(root, 'scripts/lib/runtime-pids.sh');
const appDir = root;
const exe = `${appDir}/node_modules/electron/dist/CogSeed.app/Contents/MacOS/Electron`;
const nested = `${appDir}/.worktrees/perf-response-output`;

const SNAPSHOT = [
  `100 ${exe} ${appDir} --cogseed-runtime-variant=cogseed`,
  `101 ${exe} ${appDir} --cogseed-runtime-variant=cogseed --type=renderer`,
  `200 ${nested}/node_modules/electron/dist/CogSeed.app/Contents/MacOS/Electron ${nested} --cogseed-runtime-variant=cogseed`,
  `300 node ${appDir}/p3394-gateway/gateway.cjs --port 0`,
  `301 node ${nested}/p3394-gateway/gateway.cjs --port 0`,
  `400 /Applications/SomeOther.app/Contents/MacOS/SomeOther --flag`,
].join('\n');

function run(fn: 'worktree_runtime_pids' | 'other_worktree_runtime_pids'): string[] {
  const script = `set -euo pipefail\nsource ${JSON.stringify(lib)}\n${fn} ${JSON.stringify(appDir)} cogseed\n`;
  const out = execFileSync('bash', ['-c', script], { input: SNAPSHOT, encoding: 'utf8' });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

describe('restart-cogseed worktree pid matching', () => {
  it('matches only this worktree main process and its gateway', () => {
    expect(run('worktree_runtime_pids').sort()).toEqual(['100', '101', '300']);
  });

  it('never counts a nested worktree instance as this worktree', () => {
    const pids = run('worktree_runtime_pids');
    expect(pids).not.toContain('200');
    expect(pids).not.toContain('301');
  });

  it('reports the other worktree instance separately for lock-conflict diagnosis', () => {
    expect(run('other_worktree_runtime_pids')).toEqual(['200']);
  });

  it('ignores unrelated processes and empty snapshots', () => {
    const script = `set -euo pipefail\nsource ${JSON.stringify(lib)}\nworktree_runtime_pids ${JSON.stringify(appDir)} cogseed\nother_worktree_runtime_pids ${JSON.stringify(appDir)} cogseed\n`;
    const out = execFileSync('bash', ['-c', script], { input: '400 /usr/bin/something --x\n', encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });

  it('keeps the restart script wired to the shared matcher', () => {
    const script = fs.readFileSync(path.join(root, 'scripts/restart-cogseed.sh'), 'utf8');
    expect(script).toContain('source "$APP_DIR/scripts/lib/runtime-pids.sh"');
    expect(script).toContain('ps_snapshot | worktree_runtime_pids "$APP_DIR" "$VARIANT"');
    // 稳定就绪：连续两次采样都看到本 worktree 的进程才算就绪，避免单实例锁挡下时的假成功。
    expect(script).toMatch(/streak.*\n(?:.*\n)*?.*-ge 2/);
    expect(script).toContain('other_worktree_pids');
  });
});
