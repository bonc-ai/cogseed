import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src/main/ipc/index.ts'), 'utf8');

describe('custom provider IPC contract', () => {
  it('registers CRUD and CC Switch channels with context-owned user scope', () => {
    for (const channel of [
      'customProviders.list',
      'customProviders.add',
      'customProviders.update',
      'customProviders.remove',
      'customProviders.ccswitch.probe',
      'customProviders.ccswitch.preview',
      'customProviders.ccswitch.sync',
    ]) {
      expect(source).toContain(`'${channel}'`);
    }
    expect(source).toMatch(/customProviders\.listCustomProviders\(ctx\.userId\)/);
    expect(source).toContain('apiKeyMasked: auth.maskKey');
    expect(source).not.toMatch(/customProviders\.[^(]+\([^)]*\buid\b/);
  });
});
