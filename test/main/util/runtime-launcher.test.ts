import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../../..');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');

describe('source runtime launchers', () => {
  it('locks this worktree to integration and passes that identity to Electron', () => {
    const shell = read('run.sh');
    const windows = read('run.cmd');

    expect(shell).toContain('VARIANT="integration"');
    expect(windows).toContain('set "VARIANT=integration"');
    expect(shell).toContain('--orkas-runtime-variant=$VARIANT');
    expect(windows).toContain('--orkas-runtime-variant=!VARIANT!');
    expect(shell).toContain('prepare-source-runtime.cjs" --variant="$VARIANT"');
    expect(windows).toContain('prepare-source-runtime.cjs" --variant=!VARIANT!');
    expect(shell).toContain('locked to the integration runtime');
    expect(windows).toContain('locked to the integration runtime');
    expect(shell).toContain('Mate Agent [Integration].app');
    expect(shell).not.toContain('Usage: ./run.sh [--variant');
    expect(windows).not.toContain('Usage: run.cmd [--variant');
  });

  it('rejects every shell argument or environment attempt to override integration', () => {
    for (const variant of ['main', 'cognition', 'expense', 'integration']) {
      const result = spawnSync('bash', [path.join(root, 'run.sh'), `--variant=${variant}`], {
        encoding: 'utf8',
        env: { ...process.env, ORKAS_RUNTIME_VARIANT: '' },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`Unknown argument: --variant=${variant}`);
    }

    for (const variant of ['main', 'cognition', 'expense']) {
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
        ORKAS_RUNTIME_VARIANT: 'integration',
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
  });

  it('keeps protocol ownership in the prepared integration bundle, not launcher code', () => {
    const sources = `${read('run.sh')}\n${read('run.cmd')}`;
    expect(sources).not.toContain('prepare-source-protocol.cjs');
    expect(sources).not.toContain('setAsDefaultProtocolClient');
  });

  it('locks the case-sensitive Windows environment value to integration', () => {
    const windows = read('run.cmd');
    expect(windows).toContain('if not "%ORKAS_RUNTIME_VARIANT%"=="integration"');
    expect(windows).not.toMatch(/if \/I not "%ORKAS_RUNTIME_VARIANT%"/);
    expect(windows).toContain('if defined ORKAS_WORKSPACE_ROOT');
  });
});
