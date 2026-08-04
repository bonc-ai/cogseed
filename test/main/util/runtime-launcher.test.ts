import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../../..');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');

describe('source runtime launchers', () => {
  it('locks this worktree to expense and passes that identity to Electron', () => {
    const shell = read('run.sh');
    const windows = read('run.cmd');
    const bootstrap = read('bootstrap.cjs');
    const packageMeta = JSON.parse(read('package.json')) as { orkasSourceRuntimeVariant?: string };

    expect(shell).toContain('VARIANT="expense"');
    expect(windows).toContain('set "VARIANT=expense"');
    expect(shell).toContain('--orkas-runtime-variant=$VARIANT');
    expect(windows).toContain('--orkas-runtime-variant=!VARIANT!');
    expect(shell).toContain('prepare-source-runtime.cjs" --variant="$VARIANT"');
    expect(windows).toContain('prepare-source-runtime.cjs" --variant=!VARIANT!');
    expect(shell).toContain('locked to the expense runtime');
    expect(windows).toContain('locked to the expense runtime');
    expect(shell).toContain('Mate Agent [Expense].app');
    expect(shell).not.toContain('Usage: ./run.sh [--variant');
    expect(windows).not.toContain('Usage: run.cmd [--variant');
    expect(packageMeta.orkasSourceRuntimeVariant).toBe('expense');
    expect(bootstrap).toContain('sourceVariant: packageMeta.orkasSourceRuntimeVariant');
    expect(bootstrap).toContain('allowWorkspaceOverride: isPackagedDev');
  });

  it('rejects every shell argument or environment attempt to override expense', () => {
    for (const variant of ['main', 'cognition', 'expense', 'integration']) {
      const result = spawnSync('bash', [path.join(root, 'run.sh'), `--variant=${variant}`], {
        encoding: 'utf8',
        env: { ...process.env, ORKAS_RUNTIME_VARIANT: '' },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`Unknown argument: --variant=${variant}`);
    }

    for (const variant of ['main', 'cognition', 'integration']) {
      const result = spawnSync('bash', [path.join(root, 'run.sh')], {
        encoding: 'utf8',
        env: { ...process.env, ORKAS_RUNTIME_VARIANT: variant },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`ORKAS_RUNTIME_VARIANT=${variant} is not allowed`);
    }

    const sharedRoot = spawnSync('bash', [path.join(root, 'run.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORKAS_RUNTIME_VARIANT: 'expense',
        ORKAS_WORKSPACE_ROOT: path.join(root, 'shared-data-that-must-not-be-used'),
      },
    });
    expect(sharedRoot.status).toBe(2);
    expect(sharedRoot.stderr).toContain('inherited ORKAS_WORKSPACE_ROOT is not allowed');
  });

  it('sets variant userData before taking the retained single-instance lock', () => {
    const main = read('src/main/index.ts');
    const sources = [read('run.sh'), read('run.cmd'), main].join('\n');

    expect(sources).not.toMatch(/\bpkill\b/);
    expect(sources).not.toMatch(/\btaskkill\b/i);
    expect(sources).not.toContain('ORKAS_ALLOW_MULTI_INSTANCE');
    expect(sources).toContain('app.requestSingleInstanceLock()');
    expect(main).toContain("app.setPath('userData', path.join(container, 'electron-user-data'));\n");
    expect(main.indexOf("app.setPath('userData'")).toBeLessThan(
      main.indexOf('app.requestSingleInstanceLock()'),
    );
    expect(main).not.toContain('variantArg');
    expect(main).toContain("['bash',    [script]]");
    expect(main).toContain('delete relaunchEnv.ORKAS_WORKSPACE_ROOT');
    expect(main).toContain('delete relaunchEnv.ORKAS_RUNTIME_CONTAINER');
    expect(main).toContain('delete relaunchEnv.CORE_AGENT_AUTH_DIR');
    expect(main).toContain('env: relaunchEnv');
  });

  it('does not let a source launcher claim connector protocols', () => {
    const sources = `${read('run.sh')}\n${read('run.cmd')}`;
    expect(sources).not.toContain('prepare-source-protocol.cjs');
    expect(sources).not.toContain('setAsDefaultProtocolClient');
  });

  it('locks the case-sensitive Windows environment value to expense', () => {
    const windows = read('run.cmd');
    expect(windows).toContain('if not "%ORKAS_RUNTIME_VARIANT%"=="expense"');
    expect(windows).not.toMatch(/if \/I not "%ORKAS_RUNTIME_VARIANT%"/);
    expect(windows).toContain('if defined ORKAS_WORKSPACE_ROOT');
  });
});
