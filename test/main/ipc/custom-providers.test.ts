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
      'customProviders.setEnabled',
      'customProviders.model.add',
      'customProviders.model.update',
      'customProviders.model.remove',
      'customProviders.model.test',
      'customProviders.ccswitch.probe',
      'customProviders.ccswitch.preview',
      'customProviders.ccswitch.sync',
    ]) {
      expect(source).toContain(`'${channel}'`);
    }
    expect(source).toMatch(/customProviders\.listCustomProviders\(ctx\.userId\)/);
    expect(source).toContain('apiKeyMasked: auth.maskKey');
    expect(source).toContain('enabled: provider.enabled');
    expect(source).toMatch(/customProviders\.setCustomProviderEnabled\(\s*ctx\.userId,/);
    expect(source).toMatch(/customProviders\.addCustomProviderModel\(\s*ctx\.userId,/);
    expect(source).toMatch(/customProviders\.updateCustomProviderModel\(\s*ctx\.userId,/);
    expect(source).toMatch(/customProviders\.removeCustomProviderModel\(\s*ctx\.userId,/);
    expect(source).toMatch(/customProviders\.testCustomProviderModel\(\s*ctx\.userId,/);
    expect(source).toContain("boundedCustomProviderModel(args.model, 'model')");
    expect(source).toMatch(/boundedText\(args\?\.modelId,\s*'modelId',\s*200\)/);
    expect(source).toMatch(/boundedText\(args\?\.providerId,\s*'providerId',\s*120\)/);
    expect(source).not.toMatch(/customProviders\.[^(]+\([^)]*\buid\b/);
  });

  it('validates and forwards the unavailable-entry view option', () => {
    expect(source).toMatch(/'auth\.listEntries':\s*async\s*\(\{\s*includeUnavailable\s*\}\s*=\s*\{\}\)\s*=>\s*\{/);
    expect(source).toContain("typeof includeUnavailable !== 'boolean'");
    expect(source).toMatch(/auth\.listEntries\(\{\s*includeUnavailable:\s*includeUnavailable\s*===\s*true\s*\}\)/);
  });
});
