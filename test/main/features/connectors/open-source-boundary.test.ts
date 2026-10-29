import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONNECTOR_CATALOG } from '../../../../src/main/features/connectors/catalog';

const root = path.join(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('public connector boundary', () => {
  // "Public" means: any user can authorize it themselves, with no company-held secret and no
  // paid metering. Two shapes satisfy that, and this test pins both:
  //
  //   - `server_bridge` / `mcp_dcr` — publicly reachable OAuth authorization.
  //   - `local_cli` — the provider publishes no authorization server, and its supported
  //     programmatic surface is an openly licensed CLI the user installs themselves. The
  //     credential lives in the user's own OS keychain (the `bin/` adapter child owns it) and
  //     never transits CogSeed, so nothing about it depends on a CogSeed-held secret.
  //
  //   - `interactive_token` — the provider issues the credential to the user directly (its own
  //     console, or a bespoke consent flow) and exposes an official remote MCP endpoint that takes
  //     that credential as a bearer. CogSeed stores it in the instance's encrypted local
  //     `secrets_enc` blob and pre-registers nothing. Still public: the user authorizes themselves
  //     and can revoke in the provider's console.
  //
  // What this test must keep preventing: an entry that only works because CogSeed holds a
  // private client secret, or that meters usage. Adding a mode is a deliberate widening — it is
  // not a licence to add non-public connectors under the new label.
  const PUBLIC_AUTH_MODES = ['server_bridge', 'mcp_dcr', 'local_cli', 'credentials', 'provider_device', 'interactive_token'];

  it('keeps every catalog connector on a public authorization mode without credit metering', () => {
    expect(CONNECTOR_CATALOG).toHaveLength(31);
    expect(CONNECTOR_CATALOG.filter((entry) => entry.auth_mode === 'mcp_dcr')).toHaveLength(11);
    expect(CONNECTOR_CATALOG.filter((entry) => entry.auth_mode === 'server_bridge')).toHaveLength(10);
    expect(CONNECTOR_CATALOG.filter((entry) => entry.auth_mode === 'local_cli')).toHaveLength(4);
    expect(CONNECTOR_CATALOG.filter(entry => entry.auth_mode === 'credentials').map(entry => entry.id)).toEqual(['email-qq', 'email-163', 'email-enterprise']);
    expect(CONNECTOR_CATALOG.filter((entry) => entry.auth_mode === 'interactive_token')).toHaveLength(2);
    for (const entry of CONNECTOR_CATALOG) {
      expect(PUBLIC_AUTH_MODES).toContain(entry.auth_mode);
      if (entry.auth_mode === 'credentials') expect(entry.icon_name).toBe(entry.id === 'email-enterprise' ? 'mail' : `connector-${entry.id}`);
      else if (entry.auth_mode === 'provider_device') {
        expect(entry.id).toBe('tencent-survey');
        expect(entry.icon_name).toBe('connector-tencent-survey');
        expect(entry.oauth).toBeUndefined();
        expect(entry.transport_template).toEqual({ kind: 'streamable-http', url: 'https://wj.qq.com/api/v2/mcp' });
      }
      else if (['tencent-meeting', 'feishu', 'wecom', 'dingtalk', 'tencent-docs', 'wps'].includes(entry.id)) {
        expect(entry.icon_name).toBe(`connector-${entry.id}`);
      }
      else expect(entry.icon_svg).toMatch(/^<svg\b/);
      if (entry.auth_mode === 'mcp_dcr') {
        expect(entry.transport_template?.kind).toBe('streamable-http');
        expect(entry.transport_template && 'url' in entry.transport_template
          ? entry.transport_template.url
          : '').toMatch(/^https:\/\//);
      }
      if (entry.auth_mode === 'interactive_token') {
        // Same rigour as `local_cli` above: the mode is only public because the *user* obtains the
        // credential, so the entry must not smuggle in a CogSeed-side app registration, and the
        // credential must have a declared way for the user to supply it.
        expect(entry.oauth).toBeUndefined();
        expect(entry.required_oauth_scopes).toBeUndefined();
        // Both variants must declare an https way for the user to authorize; which one they use is
        // the entry's business, but "no endpoints at all" would leave the card unconnectable.
        const auth = entry.interactive_auth;
        expect(['paste', 'browser_poll']).toContain(auth?.kind);
        if (auth?.kind === 'paste') {
          expect(auth.token_url).toMatch(/^https:\/\//);
        } else if (auth?.kind === 'browser_poll') {
          expect(auth.authorize_url).toMatch(/^https:\/\//);
          expect(auth.exchange_url).toMatch(/^https:\/\//);
          // A poll without a deadline can hang a connect forever.
          expect(auth.timeout_ms).toBeGreaterThan(0);
        }
        // It forwards the credential over the official remote MCP endpoint, so the template must be
        // an https streamable-http target that names the bearer header.
        expect(entry.transport_template?.kind).toBe('streamable-http');
        const tpl = entry.transport_template as { url?: string; oauth_header_key?: string } | null;
        expect(tpl?.url).toMatch(/^https:\/\//);
        expect(tpl?.oauth_header_key).toBe('Authorization');
        // And it must be marked non-`local_cli` in the one place that distinguishes "the child owns
        // the credential" from "we forward it": there is no bundled adapter to spawn.
        expect((entry.transport_template as { command?: string } | null)?.command).toBeUndefined();
      }
      if (entry.auth_mode === 'local_cli' || entry.auth_mode === 'credentials') {
        // `local_cli` must be credential-owning, not credential-forwarding: a stdio template that
        // carries no `oauth_env_key` and no `env_synthesizer` is what makes `applyTemplate` accept
        // a null grant. A `local_cli` entry that names either key would demand a token that no
        // flow can produce, so the requirement is asserted here rather than left implicit.
        expect(entry.transport_template?.kind).toBe('stdio');
        const tpl = entry.transport_template as { oauth_env_key?: string; env_synthesizer?: string } | null;
        expect(tpl?.oauth_env_key).toBeUndefined();
        expect(tpl?.env_synthesizer).toBeUndefined();
        // No pre-registered app, no scopes to require, and no OAuth provider id.
        expect(entry.oauth).toBeUndefined();
        expect(entry.required_oauth_scopes).toBeUndefined();
        // And it must point at a bundled adapter we ship, not an arbitrary command.
        const args = (entry.transport_template as { args?: string[] } | null)?.args || [];
        expect(args.join(' ')).toMatch(/\$\{COGSEED_PC_DIR\}\/bin\/[A-Za-z0-9._-]+\.cjs/);
      }
      for (const forbiddenKey of [
        `usage_${'metering'}`,
        `credits_milli_${'per_call'}`,
        `connect_requires_${'credits'}`,
      ]) {
        expect((entry as any)[forbiddenKey]).toBeUndefined();
      }
    }
  });

  it('pins connector OAuth to the global HTTPS bridge with no loopback or environment override', () => {
    const bridge = read('src/main/features/connectors/_server_bridge.ts');
    const marketplace = read('src/main/features/marketplace.ts');
    const oauthSources = [
      bridge,
      read('src/main/features/connectors/oauth.ts'),
      read('src/main/features/connectors/oauth-dcr.ts'),
    ].join('\n');

    expect(bridge).toContain('return apiBase();');
    expect(marketplace).toContain('return requireCogSeedApiBase();');
    expect(oauthSources).not.toMatch(/http:\/\/(?:localhost|127\.0\.0\.1)|OAUTH_REDIRECT_BASE/);
  });

  it('ships and boots a connector-only callback receiver', () => {
    const main = read('src/main/index.ts');
    const pkg = JSON.parse(read('package.json'));
    const sourceLauncher = read('run.sh');
    const identity = JSON.parse(read('src/resources/identity.json'));

    expect(main).toContain('registerConnectorProtocol({ owner: RUNTIME_IDENTITY.protocolOwner });');
    expect(main).toContain('await consumeColdLaunchConnectorCallback();');
    expect(pkg.build.protocols).toEqual(expect.arrayContaining([
      expect.objectContaining({ schemes: [identity.protocolScheme] }),
    ]));
    expect(sourceLauncher).not.toContain('scripts/prepare-source-protocol.cjs');
  });

  it('keeps MCP DCR credentials local and excludes account-scoped DCR grant hosting', () => {
    const dcr = read('src/main/features/connectors/oauth-dcr.ts');
    const manager = read('src/main/features/connectors/manager.ts');
    const sources = `${dcr}\n${manager}`;

    expect(sources).not.toContain('/connectors/oauth/dcr-store');
    expect(sources).not.toContain('storeDcrServerManaged');
    expect(sources).not.toContain('refreshDcrServerManaged');
    expect(dcr).toContain('pending.resolve({ grant: localGrant, client: pending.client });');
    expect(manager).toContain('dcrClient = result.client;');
  });
});
