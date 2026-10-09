import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src/main/ipc/index.ts'), 'utf8');
const shim = fs.readFileSync(path.join(process.cwd(), 'src/renderer/modules/ipc-shim.js'), 'utf8');

describe('model authorization IPC contract', () => {
  it('registers every unified workflow channel', () => {
    for (const channel of [
      'modelAuthorizations.list',
      'modelAuthorizations.prepareCcSwitch',
      'modelAuthorizations.discover',
      'modelAuthorizations.testDraft',
      'modelAuthorizations.complete',
      'modelAuthorizations.removeModel',
      'modelAuthorizations.remove',
    ]) expect(source).toContain(`'${channel}'`);
  });

  it('uses context-owned user scope and bounded model arrays', () => {
    expect(source).toMatch(/listAuthorizationSummaries\(ctx\.userId\)/);
    expect(source).toMatch(/prepareCcSwitchAuthorization\(\s*ctx\.userId/);
    expect(source).toMatch(/discoverAuthorizationModels\(\s*ctx\.userId/);
    expect(source).toMatch(/testPreparedAuthorizationDraft\(\s*ctx\.userId/);
    expect(source).toMatch(/completeAuthorization\(ctx\.userId/);
    expect(source).toMatch(/completePreparedCcSwitchAuthorization\(\s*ctx\.userId/);
    expect(source).toMatch(/removeAuthorizationModel\(\s*ctx\.userId/);
    expect(source).toMatch(/removeAuthorization\(ctx\.userId/);
    expect(source).toContain('slice(0, 100)');
  });

  it('adds centralized browser shim routes without creating a new preload surface', () => {
    expect(shim).toContain('modelAuthorizations.list');
    expect(shim).toContain('modelAuthorizations.complete');
    expect(source).not.toContain('apiKeyMasked: args.apiKey');
  });
});
