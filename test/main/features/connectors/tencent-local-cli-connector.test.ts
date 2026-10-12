/**
 * `auth_mode: 'local_cli'` — the third authorization mode, introduced for the Tencent Meeting
 * connector.
 *
 * Three separate invariants are pinned here, because each one has a different failure mode:
 *
 *  1. **Availability** — a `local_cli` card must render as disabled (with a fixable reason) when
 *     the CLI is absent, instead of offering a connect action that can only fail. The probe reads
 *     the real filesystem and `PATH`, so every assertion injects a probe through the test seam;
 *     otherwise the suite would pass or fail depending on whether the runner happens to have the
 *     CLI installed.
 *  2. **Template materialization** — `applyTemplate` must accept a null grant for this mode and
 *     still reject it for the credential-forwarding shapes, and the entry must actually point at a
 *     bundled adapter.
 *  3. **No drift between the two candidate lists** — the adapter resolves the binary at spawn time
 *     and `availability.ts` probes for it up front. They deliberately duplicate the candidate list
 *     (main must not `require` an MCP adapter, which would pull the MCP SDK into the main process),
 *     so the duplication is pinned equal here rather than left to review.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ADAPTER_REL = 'bin/tencent-meeting-mcp-server.cjs';
const AVAILABILITY_REL = 'src/main/features/connectors/availability.ts';

const TEST_UID = 'u-tencent-local-cli';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cogseed-tencent-cli-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  const availability = await import('../../../../src/main/features/connectors/availability');
  availability._setLocalCliProbeForTest(null);
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Activate the test user so `client_config` reads a real (default) remote-config file rather
 *  than throwing on an unset uid. */
async function activateTestUser(): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
}

// ── 1. Availability ─────────────────────────────────────────────────────

describe('local_cli availability gate', () => {
  it('reports the Tencent Meeting card as enabled when the CLI is installed', async () => {
    await activateTestUser();
    const availability = await import('../../../../src/main/features/connectors/availability');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    availability._setLocalCliProbeForTest(() => true);

    expect(availability.connectorAvailabilityForId('tencent-meeting')).toBe('enabled');
    expect(availability.isConnectorRuntimeEnabled('tencent-meeting')).toBe(true);
    expect(() => availability.assertConnectorRuntimeEnabled('tencent-meeting')).not.toThrow();

    const out = availability.catalogWithAvailability(catalog.CONNECTOR_CATALOG);
    const entry = out.find((e) => e.id === 'tencent-meeting');
    expect(entry).toBeTruthy();
    expect(entry).not.toHaveProperty('availability');
  });

  it('keeps the card visible but disabled, with a fixable reason, when the CLI is missing', async () => {
    await activateTestUser();
    const availability = await import('../../../../src/main/features/connectors/availability');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    availability._setLocalCliProbeForTest(() => false);

    // Visible (not hidden): the user can act on it by installing the CLI, so hiding the card
    // would remove the only hint that the connector exists.
    expect(availability.connectorAvailabilityForId('tencent-meeting')).toBe('visible_disabled');

    const out = availability.catalogWithAvailability(catalog.CONNECTOR_CATALOG);
    const entry = out.find((e) => e.id === 'tencent-meeting');
    expect(entry).toMatchObject({
      availability: 'visible_disabled',
      disabled_reason: 'cli_missing',
    });

    // And the install path is blocked, so a stale renderer cannot start a connect that the
    // catalog already knows will fail.
    expect(availability.isConnectorRuntimeEnabled('tencent-meeting')).toBe(false);
    expect(() => availability.assertConnectorRuntimeEnabled('tencent-meeting')).toThrow(/connector_unsupported/);
  });

  it('leaves unrelated connectors untouched when the CLI is missing', async () => {
    await activateTestUser();
    const availability = await import('../../../../src/main/features/connectors/availability');
    availability._setLocalCliProbeForTest(() => false);

    // A missing CLI must not leak into the Google remote-switch decisions.
    expect(availability.connectorAvailabilityForId('github')).toBe('enabled');
    expect(availability.connectorAvailabilityForId('notion')).toBe('enabled');
  });
});

// ── 2. Template materialization ─────────────────────────────────────────

describe('local_cli template materialization', () => {
  it('materializes the bundled stdio adapter from a null grant', async () => {
    const { applyTemplate } = await import('../../../../src/main/features/connectors/apply-template');
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');

    const entry = findCatalogEntry('tencent-meeting');
    expect(entry).toBeTruthy();
    const transport = applyTemplate(entry!, null);

    expect(transport.kind).toBe('stdio');
    if (transport.kind !== 'stdio') throw new Error('expected stdio');
    // Placeholders resolve to real paths, and the command is the Electron binary re-runnable as
    // plain Node — the child must be our own bundled adapter, never an arbitrary command.
    expect(transport.args[0]).toMatch(/\/bin\/tencent-meeting-mcp-server\.cjs$/);
    expect(transport.args[0]).not.toContain('${');
    expect(transport.command).toBe(process.execPath);
    // Credential-owning: nothing token-shaped is forwarded into the child env. The Electron-as-Node
    // vars are injected because the template uses `${COGSEED_NODE}`, and that is all.
    expect(Object.keys(transport.env || {}).sort()).toEqual(['COGSEED_NODE', 'COGSEED_PC_DIR', 'ELECTRON_RUN_AS_NODE']);
  });

  it('still requires a token for credential-forwarding templates', async () => {
    const { applyTemplate } = await import('../../../../src/main/features/connectors/apply-template');
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');

    // `server_bridge` stdio with an env key.
    expect(() => applyTemplate(findCatalogEntry('bing-webmaster')!, null)).toThrow(/no access_token/);
    expect(() => applyTemplate(findCatalogEntry('bing-webmaster')!, null)).toThrow(/no access_token/);
    // `streamable-http` builds a Bearer header, so it needs a token too.
    expect(() => applyTemplate(findCatalogEntry('github')!, null)).toThrow(/no access_token/);
    // A synthesizer-based stdio template is equally credential-forwarding.
    expect(() => applyTemplate(findCatalogEntry('notion')!, null)).toThrow(/no access_token/);
  });
});

// ── 3. Candidate-list drift pin ─────────────────────────────────────────

/** Pull the binary candidates out of either implementation so both can be compared without
 *  executing them. Absolute paths are taken verbatim; `path.join(home, ...)` tuples are reduced to
 *  their joined segments, since both files build the same home-relative locations. */
function candidatesFrom(source: string): { absolute: string[]; homeJoined: string[] } {
  const absolute = [...source.matchAll(/'\/(?:opt|usr)[^']*'/g)].map((m) => m[0].slice(1, -1));
  const homeJoined = [...source.matchAll(/path\.join\(home,\s*([^)]*)\)/g)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]).join('/'),
  );
  return {
    absolute: [...new Set(absolute)].sort(),
    homeJoined: [...new Set(homeJoined)].sort(),
  };
}

describe('local_cli candidate-list drift pin', () => {
  it('keeps the availability probe and the adapter resolving the same tmeet locations', () => {
    const adapterSrc = fs.readFileSync(path.join(REPO_ROOT, ADAPTER_REL), 'utf8');
    const availabilitySrc = fs.readFileSync(path.join(REPO_ROOT, AVAILABILITY_REL), 'utf8');

    const adapter = candidatesFrom(adapterSrc);
    const availability = candidatesFrom(availabilitySrc);

    expect(availability.absolute).toEqual(adapter.absolute);
    expect(availability.homeJoined).toEqual(adapter.homeJoined);
    // Guard against a parser that silently matched nothing and made the comparison vacuous.
    expect(adapter.absolute.length).toBeGreaterThan(1);
    expect(adapter.homeJoined.length).toBeGreaterThan(1);
  });

  it('keeps both implementations aware of the Windows shim names', () => {
    const adapterSrc = fs.readFileSync(path.join(REPO_ROOT, ADAPTER_REL), 'utf8');
    const availabilitySrc = fs.readFileSync(path.join(REPO_ROOT, AVAILABILITY_REL), 'utf8');
    for (const src of [adapterSrc, availabilitySrc]) {
      expect(src).toContain("'tmeet.cmd'");
      expect(src).toContain("'tmeet.exe'");
      // The override env var must be honoured by both, or a user could install the CLI somewhere
      // custom and have the card claim it is missing.
      expect(src).toContain('COGSEED_TMEET_BIN');
    }
  });
});
