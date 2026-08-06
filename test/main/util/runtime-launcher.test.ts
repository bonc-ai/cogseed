import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../../..');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');

describe('messaging source launchers', () => {
  it('locks both launchers to messaging and passes that identity to Electron', () => {
    const shell = read('run.sh');
    const windows = read('run.cmd');
    const bootstrap = read('bootstrap.cjs');
    const packageMeta = JSON.parse(read('package.json')) as { orkasSourceRuntimeVariant?: string };

    expect(shell).toContain('VARIANT="messaging"');
    expect(windows).toContain('set "VARIANT=messaging"');
    expect(shell).toContain('--orkas-runtime-variant=$VARIANT');
    expect(windows).toContain('--orkas-runtime-variant=!VARIANT!');
    expect(shell).toContain('prepare-source-runtime.cjs" --variant="$VARIANT"');
    expect(windows).toContain('prepare-source-runtime.cjs" --variant=!VARIANT!');
    expect(shell).toContain('Mate Agent [Messaging].app');
    expect(packageMeta.orkasSourceRuntimeVariant).toBe('messaging');
    expect(bootstrap).toContain('sourceVariant: packageMeta.orkasSourceRuntimeVariant');
  });

  it('rejects attempts to override the worktree runtime or data root', () => {
    const result = spawnSync('bash', [path.join(root, 'run.sh'), '--variant=integration'], {
      encoding: 'utf8',
      env: { ...process.env, ORKAS_RUNTIME_VARIANT: '' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown argument: --variant=integration');

    const inherited = spawnSync('bash', [path.join(root, 'run.sh')], {
      encoding: 'utf8',
      env: { ...process.env, ORKAS_RUNTIME_VARIANT: 'integration' },
    });
    expect(inherited.status).toBe(2);
    expect(inherited.stderr).toContain('ORKAS_RUNTIME_VARIANT=integration is not allowed');
  });

  it('keeps source runtimes isolated without killing other Electron processes', () => {
    const main = read('src/main/index.ts');
    const sources = [read('run.sh'), read('run.cmd'), main].join('\n');
    expect(sources).not.toMatch(/\bpkill\b/);
    expect(sources).not.toMatch(/\btaskkill\b/i);
    expect(sources).not.toContain('ORKAS_ALLOW_MULTI_INSTANCE');
    expect(main).toContain("app.setPath('userData', path.join(container, 'electron-user-data'));\n");
    expect(main.indexOf("app.setPath('userData'")).toBeLessThan(main.indexOf('app.requestSingleInstanceLock()'));
    expect(main).toContain('delete relaunchEnv.ORKAS_WORKSPACE_ROOT');
    expect(main).toContain('delete relaunchEnv.ORKAS_RUNTIME_CONTAINER');
    expect(main).toContain('delete relaunchEnv.CORE_AGENT_AUTH_DIR');
    expect(main).toContain('env: relaunchEnv');
    expect(main).toContain("['/d', '/s', '/c'");
  });
});
