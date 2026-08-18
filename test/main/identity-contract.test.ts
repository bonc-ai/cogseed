import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const contractPath = path.join(root, 'src/main/identity-contract.cjs');

async function loadIdentity() {
  expect(fs.existsSync(contractPath)).toBe(true);
  return import('../../../src/main/identity-contract.cjs');
}

describe('CogSeed-only identity contract', () => {
  it('defines only canonical CogSeed identity fields', async () => {
    const identity = await loadIdentity();
    expect(identity.IDENTITY).toMatchObject({
      appName: 'CogSeed',
      appId: 'com.cogseed.desktop',
      protocolScheme: 'cogseed',
      dataRootName: '.cogseed',
      devDataRootName: '.cogseed-dev',
      runtimeVariant: 'cogseed',
      envPrefix: 'COGSEED',
    });
    expect(identity.IDENTITY).not.toHaveProperty('legacyProtocolSchemes');
    expect(identity.IDENTITY).not.toHaveProperty('legacyDataRootNames');
    expect(identity.IDENTITY).not.toHaveProperty('legacyDevDataRootNames');
    expect(identity.IDENTITY).not.toHaveProperty('legacyRuntimeVariants');
    expect(identity.IDENTITY).not.toHaveProperty('legacyEnvPrefix');
    expect(fs.existsSync(path.join(root, 'src/resources/identity.json'))).toBe(true);
  });

  it('accepts only the CogSeed runtime variant', async () => {
    const identity = await loadIdentity();
    expect(identity.normalizeRuntimeVariant('cogseed')).toBe('cogseed');
    expect(identity.normalizeRuntimeVariant(undefined)).toBe('cogseed');
    expect(() => identity.normalizeRuntimeVariant('legacy')).toThrow(/cogseed/i);
  });

  it('does not normalize legacy environment variables', async () => {
    const identity = await loadIdentity();
    expect(identity.normalizeEnv({ COGSEED_WORKSPACE_ROOT: '/root' })).toEqual({
      COGSEED_WORKSPACE_ROOT: '/root',
    });
    const legacyKey = ['OR', 'KAS_WORKSPACE_ROOT'].join('');
    expect(identity.normalizeEnv({ [legacyKey]: '/legacy/root' })).toEqual({
      [legacyKey]: '/legacy/root',
    });
  });

  it('registers only the CogSeed connector protocol', async () => {
    const identity = await loadIdentity();
    expect(identity.protocolSchemes()).toEqual(['cogseed']);
  });
});
