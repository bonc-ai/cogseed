import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sourceRuntime = require('../../../scripts/prepare-source-runtime.cjs') as {
  sourceRuntimeBundleSpec(variant: string): {
    variant: string;
    appName: string;
    appId: string;
    protocolOwner: boolean;
    protocolSchemes: readonly string[];
  };
  currentAppFromPathFile(distDir: string, pathFile: string): string;
  parseVariant(argv: readonly string[]): string;
  parseExpenseWorktreeVariant(argv: readonly string[]): string;
};

describe('macOS source runtime bundle contract', () => {
  it('assigns unique bundle names and identifiers to every source variant', () => {
    const variants = ['main', 'cognition', 'expense', 'integration'];
    const specs = variants.map((variant) => sourceRuntime.sourceRuntimeBundleSpec(variant));

    expect(new Set(specs.map((spec) => spec.appName)).size).toBe(variants.length);
    expect(new Set(specs.map((spec) => spec.appId)).size).toBe(variants.length);
    expect(specs.map((spec) => spec.appId)).toEqual([
      'com.mateagent.desktop.source.main',
      'com.mateagent.desktop.source.cognition',
      'com.mateagent.desktop.source.expense',
      'com.mateagent.desktop.source.integration',
    ]);
  });

  it('declares connector schemes only for integration', () => {
    for (const variant of ['main', 'cognition', 'expense']) {
      expect(sourceRuntime.sourceRuntimeBundleSpec(variant).protocolSchemes).toEqual([]);
    }
    expect(sourceRuntime.sourceRuntimeBundleSpec('integration').protocolSchemes)
      .toEqual(['mateagent', 'orkas']);
  });

  it('requires exactly one canonical, case-sensitive launcher variant', () => {
    expect(sourceRuntime.parseVariant(['--variant=expense'])).toBe('expense');
    expect(sourceRuntime.parseVariant(['--variant', 'integration'])).toBe('integration');
    expect(() => sourceRuntime.parseVariant([])).toThrow('exactly one');
    expect(() => sourceRuntime.parseVariant(['--variant=Expense'])).toThrow('invalid');
    expect(() => sourceRuntime.parseVariant(['--variant=main', '--variant=expense'])).toThrow('exactly one');
  });

  it('locks the executable bundle-preparation entry to expense', () => {
    expect(sourceRuntime.parseExpenseWorktreeVariant(['--variant=expense'])).toBe('expense');
    expect(() => sourceRuntime.parseExpenseWorktreeVariant(['--variant=integration']))
      .toThrow('locked to the expense runtime');
  });

  it('rejects a missing path file rather than guessing outside Electron dist', () => {
    const dist = path.resolve('/tmp/electron/dist');
    expect(sourceRuntime.currentAppFromPathFile(dist, '/definitely/missing/path.txt')).toBe('');
  });
});
