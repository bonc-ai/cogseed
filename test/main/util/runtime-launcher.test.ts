import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../../..');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');

describe('source runtime launchers', () => {
  it('locks this worktree to cogseed and passes that identity to Electron', () => {
    const shell = read('run.sh');
    const windows = read('run.cmd');
    const bootstrap = read('bootstrap.cjs');
    const restart = read('scripts/restart-cogseed.sh');
    const packageMeta = JSON.parse(read('package.json')) as { orkasSourceRuntimeVariant?: string };

    expect(shell).toContain('VARIANT="cogseed"');
    expect(windows).toContain('set "VARIANT=cogseed"');
    expect(shell).toContain('--orkas-runtime-variant=$VARIANT');
    expect(windows).toContain('--orkas-runtime-variant=!VARIANT!');
    expect(shell).toContain('prepare-source-runtime.cjs" --variant="$VARIANT"');
    expect(windows).toContain('prepare-source-runtime.cjs" --variant=!VARIANT!');
    expect(shell).toContain('locked to the cogseed runtime');
    expect(windows).toContain('locked to the cogseed runtime');
    expect(shell).toContain('CogSeed.app');
    expect(shell).not.toContain('Usage: ./run.sh [--variant');
    expect(windows).not.toContain('Usage: run.cmd [--variant');
    expect(packageMeta.orkasSourceRuntimeVariant).toBe('cogseed');
    expect(restart).toContain('DATA_LOGS="$HOME/.cogseed/runtime-variants/${VARIANT}/data/logs"');
    expect(bootstrap).toContain('sourceVariant: packageMeta.orkasSourceRuntimeVariant');
    expect(bootstrap).toContain('allowWorkspaceOverride: isPackagedDev');
  });

  it('rejects every shell argument or environment attempt to override cogseed', () => {
    for (const variant of ['main', 'cognition', 'expense', 'mate', 'optimization']) {
      const result = spawnSync('bash', [path.join(root, 'run.sh'), `--variant=${variant}`], {
        encoding: 'utf8',
        env: { ...process.env, ORKAS_RUNTIME_VARIANT: '' },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`Unknown argument: --variant=${variant}`);
    }

    for (const variant of ['main', 'cognition', 'expense', 'optimization']) {
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
        ORKAS_RUNTIME_VARIANT: '',
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

  it('keeps protocol ownership in the prepared cogseed bundle, not launcher code', () => {
    const sources = `${read('run.sh')}\n${read('run.cmd')}`;
    expect(sources).not.toContain('prepare-source-protocol.cjs');
    expect(sources).not.toContain('setAsDefaultProtocolClient');
  });

  it('locks the case-sensitive Windows environment value to cogseed', () => {
    const windows = read('run.cmd');
    expect(windows).toContain('if not "%ORKAS_RUNTIME_VARIANT%"=="cogseed"');
    expect(windows).not.toMatch(/if \/I not "%ORKAS_RUNTIME_VARIANT%"/);
    expect(windows).toContain('if defined ORKAS_WORKSPACE_ROOT');
  });
});
