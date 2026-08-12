import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  APP_BRAND,
  RUNTIME_VARIANTS,
  resolveRuntimeIdentity,
} from '../../src/main/brand';

const require = createRequire(import.meta.url);
const installRoot = require('../../src/main/install-data-root.cjs') as {
  SOURCE_RUNTIME_VARIANTS: readonly string[];
  selectRuntimeVariant: (options?: {
    argv?: readonly string[];
    envVariant?: string;
    isPackaged?: boolean;
    sourceVariant?: string;
  }) => string;
  initializeInstallDataRoot: (
    variant: string,
    options?: { allowWorkspaceOverride?: boolean },
  ) => { variant: string; container: string; workspaceRoot: string; overridden: boolean };
  resolveVariantContainer: (base: string, variant: string) => string;
};
const packageMeta = require('../../package.json') as { orkasSourceRuntimeVariant?: string };
const SOURCE_VARIANT = 'cogseed';

describe('runtime variant isolation', () => {
  it('locks every direct source entry to this worktree identity', () => {
    expect(RUNTIME_VARIANTS).toEqual(['main', 'cognition', 'expense', 'cogseed', 'mate', 'messaging', 'optimization']);
    expect(installRoot.SOURCE_RUNTIME_VARIANTS).toEqual(['cognition', 'expense', 'cogseed', 'mate', 'messaging', 'optimization']);
    expect(packageMeta.orkasSourceRuntimeVariant).toBe(SOURCE_VARIANT);
    expect(installRoot.selectRuntimeVariant({ sourceVariant: SOURCE_VARIANT }))
      .toBe(SOURCE_VARIANT);
    expect(installRoot.selectRuntimeVariant({
      sourceVariant: SOURCE_VARIANT,
      argv: [`--orkas-runtime-variant=${SOURCE_VARIANT}`],
      envVariant: SOURCE_VARIANT,
    })).toBe(SOURCE_VARIANT);
    expect(() => installRoot.selectRuntimeVariant()).toThrow(/source runtime lock/);
    for (const requested of RUNTIME_VARIANTS.filter((variant) => variant !== SOURCE_VARIANT)) {
      expect(() => installRoot.selectRuntimeVariant({
        sourceVariant: SOURCE_VARIANT,
        argv: [`--orkas-runtime-variant=${requested}`],
      })).toThrow(/source runtime is locked/);
    }
    expect(() => installRoot.selectRuntimeVariant({
      sourceVariant: SOURCE_VARIANT,
      envVariant: 'production',
    })).toThrow(
      /invalid ORKAS_RUNTIME_VARIANT/,
    );
    expect(() => installRoot.selectRuntimeVariant({
      sourceVariant: SOURCE_VARIANT,
      argv: ['--orkas-runtime-variant'],
    }))
      .toThrow(/requires/);
  });

  it('fails closed on conflicting argument, environment, and packaged values', () => {
    expect(() => installRoot.selectRuntimeVariant({
      argv: ['--orkas-runtime-variant=expense'],
      envVariant: 'cognition',
      sourceVariant: SOURCE_VARIANT,
    })).toThrow(/conflict/);
    expect(() => installRoot.selectRuntimeVariant({
      argv: ['--orkas-runtime-variant=expense'],
      isPackaged: true,
    })).toThrow(/only supports the main/);
    expect(installRoot.selectRuntimeVariant({ isPackaged: true })).toBe('main');
  });

  it('rejects inherited workspace roots outside controlled packaged-dev verification', () => {
    const previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
    const previousContainer = process.env.ORKAS_RUNTIME_CONTAINER;
    const injectedRoot = path.join('/tmp', 'mate-runtime-injected-root');
    try {
      process.env.ORKAS_WORKSPACE_ROOT = injectedRoot;
      expect(() => installRoot.initializeInstallDataRoot(SOURCE_VARIANT))
        .toThrow(/inherited (?:COGSEED|ORKAS)_WORKSPACE_ROOT is not allowed/);
      expect(installRoot.initializeInstallDataRoot(SOURCE_VARIANT, {
        allowWorkspaceOverride: true,
      })).toMatchObject({
        variant: SOURCE_VARIANT,
        workspaceRoot: path.resolve(injectedRoot),
        overridden: true,
      });
    } finally {
      if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
      else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
      if (previousContainer === undefined) delete process.env.ORKAS_RUNTIME_CONTAINER;
      else process.env.ORKAS_RUNTIME_CONTAINER = previousContainer;
    }
  });

  it('gives every source variant a different container and application identity', () => {
    const base = path.resolve('/tmp/mate-runtime-contract');
    const containers = RUNTIME_VARIANTS.map((variant) => (
      installRoot.resolveVariantContainer(base, variant)
    ));
    const identities = RUNTIME_VARIANTS.map((variant) => resolveRuntimeIdentity(false, variant));

    expect(new Set(containers).size).toBe(RUNTIME_VARIANTS.length);
    expect(new Set(identities.map((identity) => identity.appName)).size).toBe(RUNTIME_VARIANTS.length);
    expect(new Set(identities.map((identity) => identity.appId)).size).toBe(RUNTIME_VARIANTS.length);
    expect(identities.filter((identity) => identity.protocolOwner).map((identity) => identity.variant))
      .toEqual(['cogseed']);
  });

  it('keeps the packaged identity stable and grants it protocol ownership', () => {
    expect(resolveRuntimeIdentity(true, 'main')).toEqual({
      variant: 'main',
      appName: APP_BRAND.appName,
      appId: APP_BRAND.appId,
      protocolOwner: true,
    });
    expect(() => resolveRuntimeIdentity(true, 'cogseed')).toThrow(/only supports the main/);
  });
});
