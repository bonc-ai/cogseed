/**
 * `local_cli` — the Feishu/Lark connector, second user of the mode after Tencent Meeting.
 *
 * Four separate invariants, because each fails differently:
 *
 *  1. **Bridge behaviour** — the shared `bin/cli-bridge-mcp-server.cjs` must discover commands and,
 *     critically, must REFUSE anything the CLI classifies as a write. The refusal is asserted to
 *     happen *before* the vendor CLI is invoked, so a misclassification cannot mutate a tenant.
 *  2. **Availability** — a `local_cli` card must render disabled (with a fixable reason) when
 *     `lark-cli` is absent. The probe reads the real filesystem, so tests inject through the seam.
 *  3. **Template materialization** — the entry must point at our bundled bridge with the `lark`
 *     dialect selected, and forward no credential (the CLI owns it).
 *  4. **No drift between the two candidate lists** — the bridge resolves the binary at spawn time
 *     and `availability.ts` probes for it up front. The duplication is deliberate (main must not
 *     `require` an MCP adapter) and is pinned equal here, per-CLI, so adding a third CLI cannot
 *     silently fold the lists together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const requireCjs = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const AVAILABILITY_REL = 'src/main/features/connectors/availability.ts';
const BRIDGE_REL = 'bin/cli-bridge-mcp-server.cjs';

const TEST_UID = 'u-lark-local-cli';

type Bridge = {
  CliBridge: new (dialect: string, options?: { exec?: unknown }) => any;
  parseDomainCommands: (help: string) => Array<{ name: string; description: string }>;
  _cliAbsoluteCandidates: (binName: string) => string[];
  DIALECTS: Record<string, { label: string; bin: string; pending?: boolean }>;
  TOOLS: Array<{ name: string }>;
  toolsFor: (dialect: string) => Array<{ name: string }>;
};

function bridge(): Bridge {
  return requireCjs(path.join(REPO_ROOT, BRIDGE_REL));
}

/** A fake `execFile` that answers from a routing table and records every invocation. */
function fakeExec(route: (args: string[]) => { stdout: string; code?: number }) {
  const calls: string[][] = [];
  const exec = (_cmd: string, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    calls.push(args);
    const r = route(args);
    setImmediate(() => cb(r.code ? new Error(`exit ${r.code}`) : null, r.stdout, ''));
    return { on() { /* run() also listens for 'error'; nothing to deliver */ } };
  };
  return { exec, calls };
}

describe('cli-bridge — command discovery', () => {
  it('parses a command table out of a domain help page', () => {
    const help = [
      'Document and content operations',
      '',
      'Available Commands:',
      '  +fetch                 Fetch Lark document content',
      '  +history-list          List Lark document history versions',
      '  +update                Update a Lark document',
      '',
      'Flags:',
      '  -h, --help   help for docs',
    ].join('\n');

    expect(bridge().parseDomainCommands(help)).toEqual([
      { name: '+fetch', description: 'Fetch Lark document content' },
      { name: '+history-list', description: 'List Lark document history versions' },
      { name: '+update', description: 'Update a Lark document' },
    ]);
  });

  it('stops at the end of the table instead of swallowing the flags section', () => {
    const help = ['Available Commands:', '  +fetch   Fetch content', '', 'Flags:', '  -x   not a command'].join('\n');
    expect(bridge().parseDomainCommands(help).map((c) => c.name)).toEqual(['+fetch']);
  });

  it('ships every declared dialect as implemented', () => {
    // All three vendors now have a connector. If a fourth is ever declared ahead of its connector,
    // it must carry `pending: true` (covered by the next case) rather than shipping guessed argv.
    for (const name of ['lark', 'dws', 'wecom']) {
      expect(bridge().DIALECTS[name].pending).toBeUndefined();
      expect(bridge().toolsFor(name)).toHaveLength(6);
    }
  });

  it('refuses a dialect that is declared but not implemented', async () => {
    // The mechanism has to keep working for the next vendor: a dialect with guessed argv shapes
    // would fail at the user's first call, so it must say so instead of pretending.
    const mod = bridge();
    (mod.DIALECTS as Record<string, unknown>).__test_pending = { label: 'Test', bin: 'test-cli', pending: true };
    try {
      const b = new mod.CliBridge('__test_pending');
      await expect(b.listCommands()).rejects.toThrow(/not implemented yet/);
      // …and it must not advertise tools it cannot serve.
      expect(mod.toolsFor('__test_pending').map((t) => t.name)).toEqual([
        'cli_list_commands', 'cli_command_schema', 'cli_run_read_command',
      ]);
    } finally {
      delete (mod.DIALECTS as Record<string, unknown>).__test_pending;
    }
  });
});

describe('cli-bridge — read-only gate', () => {
  const HELP_READ = 'Fetch a document\n\nRisk: read\n\nFlags:\n  --json string\n';
  const HELP_NO_RISK = 'Delete a document\n\nFlags:\n  --json string\n';

  it('runs a command the CLI itself classifies as read', async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args.includes('--help')) return { stdout: HELP_READ };
      return { stdout: '{"ok":true,"items":[]}' };
    });
    const b = new (bridge().CliBridge)('lark', { exec });

    const out = await b.runReadCommand('drive.files.list');
    expect(out.refused).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.output).toContain('"ok":true');
    // Two invocations: classify (--help) then the actual call.
    expect(calls).toHaveLength(2);
  });

  it('refuses a write command WITHOUT invoking the CLI', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: HELP_NO_RISK }));
    const b = new (bridge().CliBridge)('lark', { exec });

    // The CLI publishes no risk line for this command, so the conservative verb heuristic decides —
    // and it must decide "write", not "unknown, let it through".
    const out = await b.runReadCommand('drive.files.delete');
    expect(out.refused).toBe(true);
    expect(out.risk).toBe('write');
    expect(out.message).toMatch(/read-only/);
    // Only the classification call happened; nothing reached the mutating command.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--help');
  });

  it('refuses an unclassifiable command rather than assuming it is safe', async () => {
    const { exec } = fakeExec(() => ({ stdout: 'Frobnicate a widget\n' }));
    const b = new (bridge().CliBridge)('lark', { exec });

    const out = await b.runReadCommand('drive.widget.frobnicate');
    expect(out.refused).toBe(true);
    expect(out.risk).toBe('unknown');
  });
});

// ── Authorization contract (`local-cli-auth.ts` drives every local_cli connector) ──

describe('cli-bridge — authorization tools', () => {
  it('reads status JSON from stderr, which is where lark-cli actually prints it', async () => {
    // Verified trap: `lark-cli whoami` leaves stdout EMPTY and writes its JSON to stderr. Parsing
    // stdout alone degrades every answer to "not logged in", which would make the app start a
    // login flow for an already-authorized user.
    const { exec } = fakeExec(() => ({ stdout: '' }));
    const b = new (bridge().CliBridge)('lark', { exec, spawn: null });
    // Re-route the status call through a fake that answers on stderr only.
    b.run = async () => ({
      ok: true,
      stdout: '',
      stderr: JSON.stringify({ ok: false, error: { type: 'config', subtype: 'not_configured' } }),
      error: null,
    });

    expect(await b.checkLogin()).toEqual({ logged_in: false, setup_required: true });
  });

  it('reports a logged-in account with its display name', async () => {
    const b = new (bridge().CliBridge)('lark', { exec: fakeExec(() => ({ stdout: '' })).exec });
    b.run = async () => ({ ok: true, stdout: JSON.stringify({ ok: true, user_name: '张照航' }), stderr: '', error: null });

    expect(await b.checkLogin()).toEqual({ logged_in: true, user_name: '张照航' });
  });

  it('picks `config init` for a not-yet-configured CLI and `auth login` afterwards', async () => {
    const spawned: string[][] = [];
    const fakeSpawn = (_cmd: string, args: string[], opts: { stdio?: unknown[] }) => {
      spawned.push(args);
      // The authorization child writes to a FILE, not a pipe (a pipe dies with EPIPE once this
      // process exits, which killed the poll loop in the field). Emulate that: write the URL through
      // the very fd the adapter opened, then behave like a blocking CLI.
      const fd = Array.isArray(opts?.stdio) ? (opts.stdio[1] as number) : null;
      // Write SYNCHRONOUSLY: the adapter closes its own duplicate of this fd as soon as spawn
      // returns, so a deferred write would hit EBADF.
      if (typeof fd === 'number') {
        fs.writeSync(fd, 'open this link to continue: https://open.feishu.cn/verify?code=AB12\n');
      }
      return {
        stdout: { on: () => { /* file-based now */ } },
        stderr: { on: () => { /* file-based now */ } },
        on: () => { /* no exit/error */ },
        unref: () => { /* detached child no longer keeps us alive */ },
        kill: () => { killed.push(args.join(' ')); },
      };
    };
    const killed: string[] = [];

    // Stage 1: not configured → `config init --new`.
    const b1 = new (bridge().CliBridge)('lark', { spawn: fakeSpawn });
    b1.run = async () => ({ ok: true, stdout: JSON.stringify({ ok: false, error: { subtype: 'not_configured' } }), stderr: '', error: null });
    expect(await b1.startLogin()).toEqual({ authorization_url: 'https://open.feishu.cn/verify?code=AB12' });
    expect(spawned[0]).toEqual(['config', 'init', '--new']);
    b1.stopLogin();
    expect(killed[0]).toBe('config init --new');

    // Stage 2: configured but not logged in → `auth login`.
    const b2 = new (bridge().CliBridge)('lark', { spawn: fakeSpawn });
    b2.run = async () => ({ ok: true, stdout: JSON.stringify({ ok: false, error: { subtype: 'invalid_token' } }), stderr: '', error: null });
    await b2.startLogin();
    expect(spawned[1]).toEqual(['auth', 'login']);
    b2.stopLogin();
  });

  it('does not start a login when the CLI is already authorized', async () => {
    const spawned: string[][] = [];
    const b = new (bridge().CliBridge)('lark', { spawn: (_c: string, a: string[]) => { spawned.push(a); return { unref: () => {} }; } });
    b.run = async () => ({ ok: true, stdout: JSON.stringify({ ok: true, user_name: 'me' }), stderr: '', error: null });

    expect(await b.startLogin()).toEqual({ authorization_url: '', already_authorized: true });
    expect(spawned).toHaveLength(0);
  });

  it('treats stop_login as idempotent, because the auth driver calls it on every exit path', () => {
    const b = new (bridge().CliBridge)('lark', {});
    expect(b.stopLogin()).toEqual({ stopped: false });
    expect(b.stopLogin()).toEqual({ stopped: false });
  });

  it('exposes the six tools for every shipped dialect', () => {
    const names = (d: string) => bridge().toolsFor(d).map((t) => t.name);
    const expected = ['check_login', 'start_login', 'stop_login', 'cli_list_commands', 'cli_command_schema', 'cli_run_read_command'];
    for (const d of ['lark', 'dws', 'wecom']) expect(names(d)).toEqual(expected);
  });
});

// ── Availability ────────────────────────────────────────────────────────

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-lark-cli-'));
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

async function activateTestUser(): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
}

describe('feishu local_cli availability gate', () => {
  it('reports the card as enabled when the CLI is installed', async () => {
    await activateTestUser();
    const availability = await import('../../../../src/main/features/connectors/availability');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    availability._setLocalCliProbeForTest(() => true);

    expect(availability.connectorAvailabilityForId('test-runtime-user', 'feishu')).toBe('enabled');
    expect(availability.isConnectorRuntimeEnabled('test-runtime-user', 'feishu')).toBe(true);

    const entry = availability.catalogWithAvailability('test-runtime-user', catalog.CONNECTOR_CATALOG).find((e) => e.id === 'feishu');
    expect(entry).toBeTruthy();
    expect(entry).not.toHaveProperty('availability');
  });

  it('keeps the card visible but disabled, with a fixable reason, when the CLI is missing', async () => {
    await activateTestUser();
    const availability = await import('../../../../src/main/features/connectors/availability');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    availability._setLocalCliProbeForTest(() => false);

    expect(availability.connectorAvailabilityForId('test-runtime-user', 'feishu')).toBe('visible_disabled');

    const entry = availability.catalogWithAvailability('test-runtime-user', catalog.CONNECTOR_CATALOG).find((e) => e.id === 'feishu');
    expect(entry).toMatchObject({ availability: 'visible_disabled', disabled_reason: 'cli_missing' });

    // And the install path is blocked, so a stale renderer cannot start a connect that the catalog
    // already knows will fail.
    expect(() => availability.assertConnectorRuntimeEnabled('test-runtime-user', 'feishu')).toThrow(/connector_unsupported/);
  });

  it('does not let one CLI probe answer for the other', async () => {
    await activateTestUser();
    const availability = await import('../../../../src/main/features/connectors/availability');
    // Lark present, tmeet absent: the two rows must be independent.
    availability._setLocalCliProbeForTest(() => true);
    expect(availability.connectorAvailabilityForId('test-runtime-user', 'feishu')).toBe('enabled');
    expect(availability.connectorAvailabilityForId('test-runtime-user', 'tencent-meeting')).toBe('enabled');
    // A non-CLI connector stays untouched.
    expect(availability.connectorAvailabilityForId('test-runtime-user', 'github')).toBe('enabled');
  });
});

// ── Template materialization ────────────────────────────────────────────

describe('feishu local_cli template materialization', () => {
  it('materializes the bundled bridge with the lark dialect from a null grant', async () => {
    const { applyTemplate } = await import('../../../../src/main/features/connectors/apply-template');
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');

    const entry = findCatalogEntry('feishu');
    expect(entry).toBeTruthy();
    expect(entry!.auth_mode).toBe('local_cli');

    const transport = applyTemplate(entry!, null);
    expect(transport.kind).toBe('stdio');
    if (transport.kind !== 'stdio') throw new Error('expected stdio');

    expect(transport.args[0]).toMatch(/\/bin\/cli-bridge-mcp-server\.cjs$/);
    expect(transport.args[0]).not.toContain('${');
    expect(transport.args[1]).toBe('lark');
    expect(transport.command).toBe(process.execPath);
    // Credential-owning: nothing token-shaped is forwarded. The Electron-as-Node vars are injected
    // because the template uses `${COGSEED_NODE}`, and that is all.
    expect(Object.keys(transport.env || {}).sort()).toEqual(['COGSEED_NODE', 'COGSEED_PC_DIR', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH']);
  });
});

// ── Candidate-list drift pin ────────────────────────────────────────────

/** See the sibling tencent test for why this parses source text: main must not `require` an MCP
 *  adapter, so the two copies cannot share a module and are pinned textually instead. */
function candidatesFrom(source: string): { absolute: string[]; homeJoined: string[] } {
  const absolute = [...source.matchAll(/'\/(?:opt|usr)[^']*'/g)].map((m) => m[0].slice(1, -1));
  const homeJoined = [...source.matchAll(/path\.join\(home,\s*([^)]*)\)/g)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]).join('/'),
  );
  return { absolute: [...new Set(absolute)].sort(), homeJoined: [...new Set(homeJoined)].sort() };
}

function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = source.indexOf('\n}', start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

describe('feishu candidate-list drift pin', () => {
  it('keeps the availability probe and the bridge resolving the same lark-cli locations', () => {
    const bridgeSrc = fs.readFileSync(path.join(REPO_ROOT, BRIDGE_REL), 'utf8');
    const availabilitySrc = fs.readFileSync(path.join(REPO_ROOT, AVAILABILITY_REL), 'utf8');

    const adapter = candidatesFrom(sliceFunction(bridgeSrc, '_cliAbsoluteCandidates'));
    const availability = candidatesFrom(sliceFunction(availabilitySrc, '_cliAbsoluteCandidates'));

    expect(availability.absolute).toEqual(adapter.absolute);
    expect(availability.homeJoined).toEqual(adapter.homeJoined);
    expect(adapter.absolute.length).toBeGreaterThan(1);
    expect(adapter.homeJoined.length).toBeGreaterThan(1);
  });

  it('keeps both implementations aware of the Windows shim names and the override', () => {
    const bridgeSrc = fs.readFileSync(path.join(REPO_ROOT, BRIDGE_REL), 'utf8');
    const availabilitySrc = fs.readFileSync(path.join(REPO_ROOT, AVAILABILITY_REL), 'utf8');

    // The bridge is generic across dialects, so it names the shim suffixes; main is per-CLI and
    // names the concrete files. Both must cover `.cmd`/`.exe` or Windows resolves nothing.
    // Both sides build Windows names from the binary name, so neither hard-codes a single CLI's.
    for (const src of [bridgeSrc, availabilitySrc]) {
      expect(src).toContain('${binName}.cmd');
      expect(src).toContain('${binName}.exe');
    }

    // The override must be honoured by both, or a user who installed the CLI somewhere custom
    // would see the card claim it is missing.
    for (const src of [bridgeSrc, availabilitySrc]) expect(src).toContain('COGSEED_LARK_CLI_BIN');
  });

  it('globs nvm bin dirs, because that is where a Node CLI usually lands off the GUI PATH', () => {
    for (const rel of [BRIDGE_REL, AVAILABILITY_REL]) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(src).toContain("'.nvm'");
      expect(src).toContain("'versions'");
    }
    // `npm test` redirects HOME per worker, so the glob legitimately returns nothing there and a
    // bare "nvm paths exist" assertion would encode the developer's machine, not the contract.
    // The contract is conditional: IF the nvm root exists, its bin dirs are among the candidates.
    const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
    if (process.platform !== 'win32' && fs.existsSync(nvmRoot)) {
      const candidates = bridge()._cliAbsoluteCandidates('lark-cli');
      expect(candidates.some((c) => c.includes(`${path.sep}.nvm${path.sep}`))).toBe(true);
      expect(candidates.length).toBeGreaterThan(5);
    }
  });
});
