import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../../..');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');

describe('source runtime launchers', () => {
  it('default this worktree to expense and pass one validated variant to Electron', () => {
    const shell = read('run.sh');
    const windows = read('run.cmd');

    expect(shell).toContain('VARIANT="expense"');
    expect(windows).toContain('set "VARIANT=expense"');
    expect(shell).toContain('--orkas-runtime-variant=$VARIANT');
    expect(windows).toContain('--orkas-runtime-variant=!VARIANT!');
    for (const source of [shell, windows]) {
      for (const variant of ['main', 'cognition', 'expense', 'integration']) {
        expect(source).toContain(variant);
      }
    }
  });

  it('never kills a global Electron process or bypasses the single-instance lock', () => {
    const sources = [
      read('run.sh'),
      read('run.cmd'),
      read('src/main/index.ts'),
    ].join('\n');

    expect(sources).not.toMatch(/\bpkill\b/);
    expect(sources).not.toMatch(/\btaskkill\b/i);
    expect(sources).not.toContain('ORKAS_ALLOW_MULTI_INSTANCE');
    expect(sources).toContain('app.requestSingleInstanceLock()');
  });

  it('does not let a source launcher claim connector protocols', () => {
    const sources = `${read('run.sh')}\n${read('run.cmd')}`;
    expect(sources).not.toContain('prepare-source-protocol.cjs');
    expect(sources).not.toContain('setAsDefaultProtocolClient');
  });
});
