import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'custom-runtime-user';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-runtime-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('custom provider runtime', () => {
  it.each([
    ['anthropic', 'anthropic-messages'],
    ['openai', 'openai-completions'],
    ['gemini', 'google-generative-ai'],
  ] as const)('maps %s providers to %s', async (protocol, api) => {
    const providers = await import('../../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: `${protocol} relay`, protocol, baseUrl: `https://${protocol}.example/v1`, apiKey: 'secret',
    });
    if (!added.ok) throw new Error(added.error);
    const runtime = await import('../../../../src/main/model/core-agent/custom_provider_runtime');
    const record = runtime.findCustomProvider(UID, `cp:${added.id}`);
    expect(record).toBeTruthy();
    const model = runtime.buildCustomProviderModel(record!, 'model-x');
    expect(model).toMatchObject({
      id: 'model-x', api, provider: `cp:${added.id}`, baseUrl: `https://${protocol}.example/v1`,
      contextWindow: 131072, maxTokens: 8192,
    });
  });

  it('does not resolve unknown synthetic ids', async () => {
    const runtime = await import('../../../../src/main/model/core-agent/custom_provider_runtime');
    expect(runtime.findCustomProvider(UID, 'cp:missing')).toBeUndefined();
    expect(runtime.isCustomProviderId('openai-compatible')).toBe(false);
  });
});
