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
  // What this test must keep preventing: an entry that only works because CogSeed holds a
  // private client secret, or that meters usage. Adding a mode is a deliberate widening — it is
  // not a licence to add non-public connectors under the new label.
  const PUBLIC_AUTH_MODES = ['server_bridge', 'mcp_dcr', 'local_cli'];

  it('keeps every catalog connector on a public authorization mode without credit metering', () => {
    expect(CONNECTOR_CATALOG).toHaveLength(22);
    expect(CONNECTOR_CATALOG.filter((entry) => entry.auth_mode === 'mcp_dcr')).toHaveLength(11);
    expect(CONNECTOR_CATALOG.filter((entry) => entry.auth_mode === 'server_bridge')).toHaveLength(10);
    expect(CONNECTOR_CATALOG.filter((entry) => entry.auth_mode === 'local_cli')).toHaveLength(1);
    for (const entry of CONNECTOR_CATALOG) {
      expect(PUBLIC_AUTH_MODES).toContain(entry.auth_mode);
      expect(entry.icon_svg).toMatch(/^<svg\b/);
      if (entry.auth_mode === 'mcp_dcr') {
        expect(entry.transport_template?.kind).toBe('streamable-http');
        expect(entry.transport_template && 'url' in entry.transport_template
          ? entry.transport_template.url
          : '').toMatch(/^https:\/\//);
      }
      if (entry.auth_mode === 'local_cli') {
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

    expect(main).toContain('registerConnectorProtocol({ owner: RUNTIME_IDENTITY.protocolOwner });');
    expect(main).toContain('await consumeColdLaunchConnectorCallback();');
    expect(pkg.build.protocols).toEqual(expect.arrayContaining([
      expect.objectContaining({ schemes: ['cogseed'] }),
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
