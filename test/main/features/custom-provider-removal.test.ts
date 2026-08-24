import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'cp-removal-user';
/** Fake, non-usable marker value — lets the test grep the on-disk store for
 * key remnants after a delete without touching any real credential. */
const MARKER_KEY = 'sk-not-a-real-key-marker-000';

let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-removal-test-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Raw store file text (may be ciphertext when a vault is configured). */
function storeFileText(): string {
  try {
    return fs.readFileSync(path.join(root, UID, 'local', 'config', 'auth-profiles.json'), 'utf8');
  } catch {
    return '';
  }
}

function addProvider(
  providers: typeof import('../../../src/main/features/custom_providers'),
  name: string,
  models: string[],
): string {
  const res = providers.addCustomProvider(UID, {
    name, protocol: 'openai', baseUrl: `https://${name}.example/v1`,
    apiKey: MARKER_KEY, models: models.map((id) => ({ id })),
  });
  if (!res.ok) throw new Error(res.error);
  return res.id;
}

describe('custom provider removal cleanup', () => {
  it('removing a provider drops its default-model entry and the stored key', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const auth = await import('../../../src/main/features/auth');

    const id = addProvider(providers, 'RelayA', ['model-a1', 'model-a2']);
    // addCustomProvider auto-binds the first model as the default chat entry —
    // exactly what the settings "已配置" list renders.
    let { entries } = await auth.listEntries({ includeUnavailable: true });
    expect(entries.some((e) => e.provider === `cp:${id}`)).toBe(true);

    expect(providers.removeCustomProvider(UID, id)).toMatchObject({ ok: true });

    ({ entries } = await auth.listEntries({ includeUnavailable: true }));
    expect(entries.some((e) => e.provider === `cp:${id}` || e.profileId === `cp:${id}`)).toBe(false);
    expect(providers.listCustomProviders(UID)).toHaveLength(0);
    expect((await auth.hasConfiguredModel()).configured).toBe(false);

    // Key remnant check against the on-disk store. When the store is stored
    // in plaintext (no vault in tests) the marker must be gone after removal.
    const raw = storeFileText();
    if (raw.includes('customProviders')) expect(raw).not.toContain(MARKER_KEY);
  });

  it('removing one model drops only that model entry, keeping sibling models', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const auth = await import('../../../src/main/features/auth');

    const id = addProvider(providers, 'RelayB', ['model-b1', 'model-b2']);
    await auth.addEntry({ provider: `cp:${id}`, model: 'model-b2', profileId: `cp:${id}` });

    expect(providers.removeCustomProviderModel(UID, id, 'model-b1')).toMatchObject({ ok: true });

    const { entries } = await auth.listEntries({ includeUnavailable: true });
    const mine = entries.filter((e) => e.provider === `cp:${id}`);
    expect(mine.map((e) => e.model)).toEqual(['model-b2']);
  });

  it('editing the model list drops entries for models no longer present', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const auth = await import('../../../src/main/features/auth');

    const id = addProvider(providers, 'RelayC', ['model-c1', 'model-c2']);
    await auth.addEntry({ provider: `cp:${id}`, model: 'model-c2', profileId: `cp:${id}` });

    expect(providers.updateCustomProvider(UID, id, {
      models: [{ id: 'model-c2' }],
    })).toMatchObject({ ok: true });

    const { entries } = await auth.listEntries({ includeUnavailable: true });
    expect(entries.filter((e) => e.provider === `cp:${id}`).map((e) => e.model)).toEqual(['model-c2']);
  });

  it('marks entries unavailable instead of usable when the provider is disabled', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const auth = await import('../../../src/main/features/auth');

    const id = addProvider(providers, 'RelayD', ['model-d1']);
    expect(providers.setCustomProviderEnabled(UID, id, false)).toMatchObject({ ok: true });

    const withUnavailable = await auth.listEntries({ includeUnavailable: true });
    expect(withUnavailable.entries.some((e) => e.provider === `cp:${id}` && e.modelAvailable === false)).toBe(true);
    // The default view (used for chat dispatch) hides it entirely.
    const usableOnly = await auth.listEntries();
    expect(usableOnly.entries.some((e) => e.provider === `cp:${id}`)).toBe(false);
    expect((await auth.hasConfiguredModel()).configured).toBe(false);
  });
});
