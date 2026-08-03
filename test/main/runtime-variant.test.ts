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
  selectRuntimeVariant: (options?: {
    argv?: readonly string[];
    envVariant?: string;
    isPackaged?: boolean;
  }) => string;
  resolveVariantContainer: (base: string, variant: string) => string;
};

describe('runtime variant isolation', () => {
  it('accepts only the four named variants and defaults direct source runs to main', () => {
    expect(RUNTIME_VARIANTS).toEqual(['main', 'cognition', 'expense', 'integration']);
    expect(installRoot.selectRuntimeVariant()).toBe('main');
    expect(installRoot.selectRuntimeVariant({ argv: ['--orkas-runtime-variant=expense'] }))
      .toBe('expense');
    expect(() => installRoot.selectRuntimeVariant({ envVariant: 'production' })).toThrow(
      /invalid ORKAS_RUNTIME_VARIANT/,
    );
    expect(() => installRoot.selectRuntimeVariant({ argv: ['--orkas-runtime-variant'] }))
      .toThrow(/requires/);
  });

  it('fails closed on conflicting argument, environment, and packaged values', () => {
    expect(() => installRoot.selectRuntimeVariant({
      argv: ['--orkas-runtime-variant=expense'],
      envVariant: 'cognition',
    })).toThrow(/conflict/);
    expect(() => installRoot.selectRuntimeVariant({
      argv: ['--orkas-runtime-variant=expense'],
      isPackaged: true,
    })).toThrow(/only supports the main/);
    expect(installRoot.selectRuntimeVariant({ isPackaged: true })).toBe('main');
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
      .toEqual(['integration']);
  });

  it('keeps the packaged identity stable and grants it protocol ownership', () => {
    expect(resolveRuntimeIdentity(true, 'main')).toEqual({
      variant: 'main',
      appName: APP_BRAND.appName,
      appId: APP_BRAND.appId,
      protocolOwner: true,
    });
    expect(() => resolveRuntimeIdentity(true, 'integration')).toThrow(/only supports the main/);
  });
});
