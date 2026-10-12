import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' } }));
vi.mock('../../../../src/main/system_info', () => ({ desktopPlatform: () => 'macos' }));
vi.mock('../../../../src/main/i18n', () => ({ getCurrentLang: () => 'en' }));
vi.mock('../../../../src/main/features/marketplace', () => ({ apiBase: () => 'https://hub.example' }));

import { _resetTermsCacheForTest, fetchTerms } from '../../../../src/main/features/contribution/terms';

const originalFetch = globalThis.fetch;
beforeEach(() => { _resetTermsCacheForTest(); });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('contribution terms cache', () => {
  it('reuses the matching body after an ETag 304', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls.push(init || {});
      if (calls.length === 1) return new Response(JSON.stringify({ code: 0, open: true, terms: { version: '1', effective_at: 'now', body_markdown: 'terms' } }), { status: 200, headers: { ETag: '"1"' } });
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    const first = await fetchTerms();
    expect(first).toMatchObject({ status: 'open', terms: { version: '1', body_markdown: 'terms' } });
    await expect(fetchTerms()).resolves.toEqual(first);
    expect((calls[1].headers as Record<string, string>)['If-None-Match']).toBe('"1"');
  });

  it('distinguishes explicitly closed terms from transport failure', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ code: 0, open: false, terms: null }), { status: 200 })) as typeof fetch;
    await expect(fetchTerms()).resolves.toEqual({ status: 'closed' });
    _resetTermsCacheForTest();
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); }) as typeof fetch;
    await expect(fetchTerms()).resolves.toMatchObject({ status: 'unavailable', reason: 'network' });
  });
});
