import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Regression for the 2026-10-13 worker failures:
 *   400 {"type":"error","error":{"type":"MissingSessionID",
 *        "message":"Request is missing x-opencode-session …"}}
 * The configured baseUrl is a *relay* that fronts OpenCode Zen/Go, so matching on
 * `opencode.ai` never fired; the header is now sent for every custom provider.
 */
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-provider-headers-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function headers() {
  const mod = await import('../../../../src/main/model/core-agent/custom_provider_runtime');
  return mod.customProviderHeaders;
}

describe('custom provider headers · opencode session routing', () => {
  it('sends x-opencode-session for an opencode host', async () => {
    const customProviderHeaders = await headers();
    for (const baseUrl of ['https://opencode.ai', 'https://opencode.ai/zen/v1', 'https://zen.opencode.ai/v1']) {
      expect(customProviderHeaders(baseUrl, 'cp-1'), baseUrl).toEqual({ 'x-opencode-session': 'cogseed-cp-1' });
    }
  });

  it('also sends it for a relay that is not an opencode host', async () => {
    // The live failure: baseUrl is the relay, the 400 comes from upstream.
    const customProviderHeaders = await headers();
    for (const baseUrl of ['https://relay.example.com/v1', 'https://api.example.com', '']) {
      expect(customProviderHeaders(baseUrl, 'cp-mv55dx7q-1'), baseUrl)
        .toEqual({ 'x-opencode-session': 'cogseed-cp-mv55dx7q-1' });
    }
  });

  it('keys the session on the provider id so routing stays stable per provider', async () => {
    const customProviderHeaders = await headers();
    expect(customProviderHeaders('https://opencode.ai', 'cp-abc')?.['x-opencode-session']).toBe('cogseed-cp-abc');
    expect(customProviderHeaders('https://relay.example.com', 'cp-abc')?.['x-opencode-session']).toBe('cogseed-cp-abc');
  });
});
