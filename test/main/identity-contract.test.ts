import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const contractPath = path.join(root, 'src/main/identity-contract.cjs');

async function loadIdentity() {
  expect(fs.existsSync(contractPath)).toBe(true);
  return import('../../../src/main/identity-contract.cjs');
}

describe('CogSeed canonical identity contract', () => {
  it('defines canonical identity and one-version legacy aliases', async () => {
    const identity = await loadIdentity();
    expect(identity.IDENTITY).toMatchObject({
      appName: 'CogSeed',
      appId: 'com.cogseed.desktop',
      protocolScheme: 'cogseed',
      legacyProtocolSchemes: ['mateagent', 'orkas'],
      dataRootName: '.cogseed',
      legacyDataRootNames: ['.orkas'],
      devDataRootName: '.cogseed-dev',
      legacyDevDataRootNames: ['.orkas-dev'],
      runtimeVariant: 'cogseed',
      legacyRuntimeVariants: ['mate'],
      envPrefix: 'COGSEED',
      legacyEnvPrefix: 'ORKAS',
    });
    expect(fs.existsSync(path.join(root, 'src/resources/identity.json'))).toBe(true);
  });

  it.each([
    ['cogseed', 'cogseed'],
    ['mate', 'cogseed'],
    [undefined, 'cogseed'],
  ])('normalizes runtime variant %s to %s', async (input, expected) => {
    const identity = await loadIdentity();
    expect(identity.normalizeRuntimeVariant(input)).toBe(expected);
  });

  it('normalizes legacy environment variables without accepting conflicting values', async () => {
    const identity = await loadIdentity();
    expect(identity.normalizeEnv({ ORKAS_WORKSPACE_ROOT: '/legacy/root' })).toMatchObject({
      COGSEED_WORKSPACE_ROOT: '/legacy/root',
    });
    expect(() => identity.normalizeEnv({
      COGSEED_WORKSPACE_ROOT: '/new/root',
      ORKAS_WORKSPACE_ROOT: '/legacy/root',
    })).toThrow(/conflict/i);
  });

  it('returns canonical first protocol registration order', async () => {
    const identity = await loadIdentity();
    expect(identity.protocolSchemes()).toEqual(['cogseed', 'mateagent', 'orkas']);
  });
});
