import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sourceRuntime = require('../../../scripts/prepare-source-runtime.cjs') as {
  sourceRuntimeBundleSpec: (variant: string) => {
    variant: string;
    appName: string;
    appId: string;
    protocolOwner: boolean;
    protocolSchemes: readonly string[];
  };
  parseMessagingWorktreeVariant: (argv: readonly string[]) => string;
};

describe('messaging macOS runtime bundle contract', () => {
  it('assigns unique identities and connector schemes only to integration', () => {
    const variants = ['main', 'cognition', 'expense', 'integration', 'messaging'];
    const specs = variants.map((variant) => sourceRuntime.sourceRuntimeBundleSpec(variant));
    expect(new Set(specs.map((spec) => spec.appName)).size).toBe(variants.length);
    expect(new Set(specs.map((spec) => spec.appId)).size).toBe(variants.length);
    expect(specs.find((spec) => spec.variant === 'messaging')).toMatchObject({
      appName: 'Mate Agent [Messaging]',
      appId: 'com.mateagent.desktop.source.messaging',
      protocolOwner: false,
      protocolSchemes: [],
    });
    expect(specs.find((spec) => spec.variant === 'integration')?.protocolSchemes).toEqual(['mateagent', 'orkas']);
  });

  it('requires exactly the messaging preparation variant', () => {
    expect(sourceRuntime.parseMessagingWorktreeVariant(['--variant=messaging'])).toBe('messaging');
    expect(() => sourceRuntime.parseMessagingWorktreeVariant(['--variant=integration'])).toThrow(/locked/);
    expect(() => sourceRuntime.parseMessagingWorktreeVariant([])).toThrow(/exactly one/);
  });

});
