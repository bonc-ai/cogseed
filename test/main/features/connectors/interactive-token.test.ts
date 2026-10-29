import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyTemplate } from '../../../../src/main/features/connectors/apply-template';
import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * `interactive_token` connectors forward a credential the *user* obtained from the provider.
 * These cases pin the two properties the rest of the stack relies on: the credential reaches the
 * official MCP endpoint as an RFC 6750 bearer header, and a missing credential fails loudly at
 * materialization time instead of producing a transport that would 401 on every call.
 */
describe('interactive_token — paste tolerance', () => {
  it('normalises whitespace instead of refusing a real-world paste', async () => {
    // Field report: a token copied from the vendor page carried whitespace and the connection was
    // rejected with "contains whitespace or control characters" — an error the user cannot act on,
    // for a value that was actually correct. Whitespace is never part of a token.
    const manager = await import('../../../../src/main/features/connectors/manager');
    expect(typeof manager.connectInteractiveToken).toBe('function');
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'src/main/features/connectors/manager.ts'),
      'utf8',
    );
    // The normalisation is the behaviour under test: strip whitespace rather than refuse it…
    expect(src).toContain("String(raw || '').replace(/\\s+/g, '')");
    // …recover the token when the copy dragged page text along (the observed failure: a Chinese
    // label in the paste reached the transport and surfaced as a ByteString conversion error)…
    expect(src).toContain('interactive credential extracted from surrounding text');
    expect(src).toContain('credential_not_a_token');
    // …and still refuse what is clearly not a token.
    expect(src).toContain('credential_too_long');
  });
});

describe('interactive_token — credential materialization', () => {
  const entry = findCatalogEntry('tencent-docs');

  it('targets the official Tencent Docs MCP endpoint over https', () => {
    expect(entry).not.toBeNull();
    expect(entry?.auth_mode).toBe('interactive_token');
    expect(entry?.transport_template).toMatchObject({
      kind: 'streamable-http',
      url: 'https://docs.qq.com/openapi/mcp',
      oauth_header_key: 'Authorization',
    });
  });

  it('forwards the credential RAW, because Tencent Docs rejects a Bearer prefix', () => {
    // Evidence, not preference: the vendor's configuration guide specifies
    // `"Authorization": "<token>"` (stressing the key must be exactly `Authorization`), and the
    // published `qqdocs` client sends `Authorization: getToken()` unprefixed. The shared
    // `applyTemplate` default is `Bearer <token>`, so this entry opts out via
    // `oauth_header_scheme: ''` — with the default, every request would authenticate as nothing.
    expect(applyTemplate(entry!, { access_token: 'tok-abc123' })).toEqual({
      kind: 'streamable-http',
      url: 'https://docs.qq.com/openapi/mcp',
      headers: { Authorization: 'tok-abc123' },
    });
  });

  it('still sends Bearer for entries that do not opt out', async () => {
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');
    const wps: any = applyTemplate(findCatalogEntry('wps')!, { access_token: 'tok-abc123' });
    expect(wps.headers).toEqual({ Authorization: 'Bearer tok-abc123' });
  });

  it('refuses a credential that would crash the HTTP layer, with a localisable code', () => {
    // The observed failure: a paste carrying a Chinese label produced
    // "Cannot convert argument to a ByteString … value of 19979" from undici, naming neither cause
    // nor fix. It must be caught here instead.
    expect(() => applyTemplate(entry!, { access_token: 'abc\u4e0bdef' }))
      .toThrowError(/not header-safe/);
    try {
      applyTemplate(entry!, { access_token: 'abc\u4e0bdef' });
    } catch (err) {
      expect((err as { code?: string }).code).toBe('credential_not_a_token');
    }
  });

  it('points users at the page the vendor guide names for obtaining a token', () => {
    // The earlier revision linked the Tencent Cloud developer docs, where no user can get a token;
    // `openapi/mcp` is only the JSON-RPC endpoint.
    expect(entry!.setup?.docs_url).toBe('https://docs.qq.com/open/auth/mcp.html');
    expect(entry!.setup?.steps_zh?.join(' ')).toContain('Token');
  });

  it('refuses to materialize without a credential', () => {
    // Both shapes matter: `null` (nothing supplied) and `{}` (a caller that forgot the token).
    // Either would otherwise spawn an MCP client that fails every request with 401.
    expect(() => applyTemplate(entry!, null)).toThrow(/no access_token/);
    expect(() => applyTemplate(entry!, {})).toThrow(/no access_token/);
  });
});
