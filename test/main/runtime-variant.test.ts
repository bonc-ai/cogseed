import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { APP_BRAND, RUNTIME_VARIANTS, resolveRuntimeIdentity } from '../../src/main/brand';

const require = createRequire(import.meta.url);
const installRoot = require('../../src/main/install-data-root.cjs') as {
  SOURCE_RUNTIME_VARIANTS: readonly string[];
  selectRuntimeVariant: (options?: {
    argv?: readonly string[];
    envVariant?: string;
    isPackaged?: boolean;
    sourceVariant?: string;
  }) => string;
  initializeInstallDataRoot: (variant: string, options?: { allowWorkspaceOverride?: boolean }) => {
    variant: string;
    container: string;
    workspaceRoot: string;
    overridden: boolean;
  };
  resolveVariantContainer: (base: string, variant: string) => string;
};
const packageMeta = require('../../package.json') as { orkasSourceRuntimeVariant?: string };

describe('messaging runtime isolation', () => {
  it('locks this source worktree to messaging', () => {
    expect(RUNTIME_VARIANTS).toEqual(['main', 'cognition', 'expense', 'integration', 'messaging']);
    expect(installRoot.SOURCE_RUNTIME_VARIANTS).toEqual(['messaging']);
    expect(packageMeta.orkasSourceRuntimeVariant).toBe('messaging');
    expect(installRoot.selectRuntimeVariant({ sourceVariant: 'messaging' })).toBe('messaging');
    expect(() => installRoot.selectRuntimeVariant({ sourceVariant: 'messaging', argv: ['--orkas-runtime-variant=integration'] }))
      .toThrow(/source runtime is locked/);
    expect(() => installRoot.selectRuntimeVariant({ sourceVariant: 'messaging', envVariant: 'expense' }))
      .toThrow(/source runtime is locked/);
    expect(() => installRoot.selectRuntimeVariant({ argv: ['--orkas-runtime-variant=messaging'], envVariant: 'integration', sourceVariant: 'messaging' }))
      .toThrow(/conflict/);
  });

  it('rejects inherited roots and separates identities', () => {
    const previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
    const injectedRoot = path.join('/tmp', 'mate-messaging-injected-root');
    try {
      process.env.ORKAS_WORKSPACE_ROOT = injectedRoot;
      expect(() => installRoot.initializeInstallDataRoot('messaging')).toThrow(/inherited ORKAS_WORKSPACE_ROOT/);
      expect(installRoot.initializeInstallDataRoot('messaging', { allowWorkspaceOverride: true })).toMatchObject({
        variant: 'messaging',
        workspaceRoot: path.resolve(injectedRoot),
        overridden: true,
      });
    } finally {
      if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
      else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
    }

    const base = path.resolve('/tmp/mate-runtime-contract');
    const containers = RUNTIME_VARIANTS.map((variant) => installRoot.resolveVariantContainer(base, variant));
    const identities = RUNTIME_VARIANTS.map((variant) => resolveRuntimeIdentity(false, variant));
    expect(new Set(containers).size).toBe(RUNTIME_VARIANTS.length);
    expect(new Set(identities.map((identity) => identity.appName)).size).toBe(RUNTIME_VARIANTS.length);
    expect(new Set(identities.map((identity) => identity.appId)).size).toBe(RUNTIME_VARIANTS.length);
    expect(identities.filter((identity) => identity.protocolOwner).map((identity) => identity.variant)).toEqual(['integration']);
    expect(resolveRuntimeIdentity(false, 'messaging')).toEqual({
      variant: 'messaging',
      appName: `${APP_BRAND.appName} [Messaging]`,
      appId: `${APP_BRAND.appId}.source.messaging`,
      protocolOwner: false,
    });
  });
});
