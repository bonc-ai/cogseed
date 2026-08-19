import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gate = require('../../../bin/runtime-gate.cjs') as {
  MANIFEST_RUNTIME_KINDS: readonly string[];
  PACKAGED_RUNTIME_KINDS: readonly string[];
  requiredRuntimeVerificationEntries: (platform: string, arch: string) => string[];
};

describe('runtime-gate', () => {
  it('registers only the remaining packaged runtimes', () => {
    expect(gate.MANIFEST_RUNTIME_KINDS).toEqual(['python', 'uv', 'node']);
    expect(gate.PACKAGED_RUNTIME_KINDS).toEqual(['python', 'uv', 'node', 'vc']);
  });

  it('requires only the remaining runtime verification entries', () => {
    const entries = gate.requiredRuntimeVerificationEntries('darwin', 'arm64');
    expect(entries).toEqual([
      'runtime:python:darwin-arm64',
      'runtime:uv:darwin-arm64',
      'runtime:node:darwin-arm64',
    ]);
  });
});
