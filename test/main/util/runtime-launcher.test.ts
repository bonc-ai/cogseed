import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../../..');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const sourceVariant = JSON.parse(read('package.json')).cogseedSourceRuntimeVariant;

describe('source runtime launchers', () => {
  it('locks this worktree to its package and passes that identity to Electron', () => {
    const shell = read('run.sh');
    const windows = read('run.cmd');
    const bootstrap = read('bootstrap.cjs');
    const restart = read('scripts/restart-cogseed.sh');
    const runtimePids = read('scripts/lib/runtime-pids.sh');
    const packageMeta = JSON.parse(read('package.json')) as { cogseedSourceRuntimeVariant?: string };

    expect(shell).toContain('source "$APP_DIR/scripts/lib/source-launch.sh"');
    expect(windows).toContain('set "VARIANT=cogseed"');
    expect(shell).toContain('--cogseed-runtime-variant=$VARIANT');
    expect(windows).toContain('--cogseed-runtime-variant=!VARIANT!');
    expect(shell).toContain('prepare-source-runtime.cjs" --variant="$VARIANT"');
    expect(windows).toContain('prepare-source-runtime.cjs" --variant=!VARIANT!');
    expect(shell).toContain('locked by this checkout\'s package.json');
    expect(windows).toContain('locked to the cogseed runtime');
    expect(shell).toContain('"$APP_BUNDLE"');
    expect(shell).not.toContain('Usage: ./run.sh [--variant');
    expect(windows).not.toContain('Usage: run.cmd [--variant');
    expect(['cognition', 'expense', 'cogseed', 'messaging', 'optimization']).toContain(packageMeta.cogseedSourceRuntimeVariant);
    expect(restart).toContain('DATA_LOGS="$HOME/.cogseed/runtime-variants/${VARIANT}/data/logs"');
    expect(restart).toContain('source "$APP_DIR/scripts/lib/source-launch.sh"');
    expect(restart).toContain('worktree_pids()');
    // 进程匹配集中在共享库（本 worktree 前缀锚定，嵌套 worktree 不计入）。
    expect(restart).toContain('source "$APP_DIR/scripts/lib/runtime-pids.sh"');
    expect(restart).toContain('ps_snapshot | worktree_runtime_pids "$APP_DIR" "$VARIANT"');
    expect(restart).toContain('ps_snapshot | other_worktree_runtime_pids "$APP_DIR" "$VARIANT"');
    expect(runtimePids).toContain('_RUNTIME_EXE_SUFFIX');
    expect(runtimePids).toContain('local npm_exe="$app_dir/node_modules/.bin/electron"');
    // 具体进程归属与 Vitest 排除由 restart-cogseed-runtime-pids 的行为回归验证。
    expect(runtimePids).toContain('worktree_runtime_pids()');
    expect(runtimePids).toContain('$app_dir/p3394-gateway/gateway.cjs');
    expect(restart).toContain('if [ -n "$(worktree_main_pids)" ]; then');
    expect(restart).toContain('ps_snapshot | worktree_runtime_pids "$APP_DIR" "$VARIANT" "$APP_NAME" main');
    expect(restart).toContain('if [ -z "$(worktree_pids)" ]; then');
    expect(bootstrap).toContain('sourceVariant: packageMeta.cogseedSourceRuntimeVariant');
    expect(bootstrap).toContain('allowWorkspaceOverride: isPackagedDev');
  });

  it.skipIf(process.platform === 'win32')('rejects every shell argument or environment attempt to override the package lock', () => {
    for (const variant of ['main', 'cognition', 'expense', 'cogseed', 'optimization']) {
      const result = spawnSync('bash', [path.join(root, 'run.sh'), `--variant=${variant}`], {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '', COGSEED_RUNTIME_VARIANT: '' },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`Unknown argument: --variant=${variant}`);
    }

    for (const variant of ['main', 'cognition', 'expense', 'cogseed', 'messaging', 'optimization'].filter(value => value !== sourceVariant)) {
      const result = spawnSync('bash', [path.join(root, 'run.sh')], {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '', COGSEED_RUNTIME_VARIANT: variant },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`COGSEED_RUNTIME_VARIANT=${variant} is not allowed`);
    }

    const sharedRoot = spawnSync('bash', [path.join(root, 'run.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        COGSEED_RUNTIME_VARIANT: '',
        COGSEED_WORKSPACE_ROOT: path.join(root, 'shared-data-that-must-not-be-used'),
      },
    });
    expect(sharedRoot.status).toBe(2);
    expect(sharedRoot.stderr).toContain('inherited COGSEED_WORKSPACE_ROOT is not allowed');
  });

  it.runIf(process.platform === 'win32')('rejects every Windows launcher argument or environment attempt to override cogseed', () => {
    const runWindows = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(
      'cmd.exe',
      ['/d', '/s', '/c', ['run.cmd', ...args].join(' ')],
      { cwd: root, encoding: 'utf8', env },
    );

    for (const variant of ['main', 'cognition', 'expense', 'cogseed', 'optimization']) {
      const result = runWindows([`--variant=${variant}`], {
        ...process.env,
        COGSEED_RUNTIME_VARIANT: '',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Unknown argument: --variant');
    }

    for (const variant of ['main', 'cognition', 'expense', 'optimization']) {
      const result = runWindows([], {
        ...process.env,
        COGSEED_RUNTIME_VARIANT: variant,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`COGSEED_RUNTIME_VARIANT=${variant} is not allowed`);
    }

    const sharedRoot = runWindows([], {
      ...process.env,
      COGSEED_RUNTIME_VARIANT: '',
      COGSEED_WORKSPACE_ROOT: path.join(root, 'shared-data-that-must-not-be-used'),
    });
    expect(sharedRoot.status).toBe(2);
    expect(sharedRoot.stderr).toContain('inherited COGSEED_WORKSPACE_ROOT is not allowed');
  });

  it('sets variant userData before taking the retained single-instance lock', () => {
    const main = read('src/main/index.ts');
    const sources = [read('run.sh'), read('run.cmd'), main].join('\n');

    expect(sources).not.toMatch(/\bpkill\b/);
    expect(sources).not.toMatch(/\btaskkill\b/i);
    expect(sources).not.toContain('COGSEED_ALLOW_MULTI_INSTANCE');
    expect(sources).toContain('app.requestSingleInstanceLock()');
    expect(main).toContain("app.setPath('userData', path.join(container, 'electron-user-data'));\n");
    expect(main.indexOf("app.setPath('userData'")).toBeLessThan(
      main.indexOf('app.requestSingleInstanceLock()'),
    );
    expect(main).not.toContain('variantArg');
    expect(main).toContain("['bash',    [script]]");
    expect(main).toContain('delete relaunchEnv.COGSEED_WORKSPACE_ROOT');
    expect(main).toContain('delete relaunchEnv.COGSEED_RUNTIME_CONTAINER');
    expect(main).toContain('delete relaunchEnv.CORE_AGENT_AUTH_DIR');
    expect(main).toContain('env: relaunchEnv');
  });

  it('keeps protocol ownership in the prepared cogseed bundle, not launcher code', () => {
    const sources = `${read('run.sh')}\n${read('run.cmd')}`;
    expect(sources).not.toContain('prepare-source-protocol.cjs');
    expect(sources).not.toContain('setAsDefaultProtocolClient');
  });

  it('locks the case-sensitive Windows environment value to cogseed', () => {
    const windows = read('run.cmd');
    expect(windows).toContain('if not "%COGSEED_RUNTIME_VARIANT%"=="cogseed"');
    expect(windows).not.toMatch(/if \/I not "%COGSEED_RUNTIME_VARIANT%"/);
    expect(windows).toContain('if defined COGSEED_WORKSPACE_ROOT');
  });
});
