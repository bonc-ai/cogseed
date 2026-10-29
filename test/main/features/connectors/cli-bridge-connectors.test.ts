/**
 * The DingTalk (`dws`) and WeCom (`wecom-cli`) users of `local_cli` + the shared CLI bridge.
 *
 * These two dialects differ from Lark in the two places that matter, so both are pinned here:
 *
 *  - **Where the read-only decision comes from.** DingTalk publishes structured safety metadata
 *    (`effect: read|write|destructive`) in `schema --compact`, so the gate answers from the CLI's
 *    own words. WeCom publishes none, so it falls back to the conservative verb allowlist — weaker
 *    by construction, and the classification reports which source answered so that weakness is
 *    visible rather than implied.
 *  - **How discovery works.** DingTalk returns JSON (33 products, ~1495 tools); WeCom has no index
 *    at all and is parsed out of help tables.
 *
 * Availability and template materialization are covered for both catalog entries as well.
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

const TEST_UID = 'u-cli-bridge-connectors';

type Bridge = {
  CliBridge: new (dialect: string, options?: { exec?: unknown; spawn?: unknown }) => any;
  toolsFor: (dialect: string) => Array<{ name: string }>;
  _cliWritableDir: () => string;
  flagsFromJson: (json: string) => string[];
};

function bridge(): Bridge {
  return requireCjs(path.join(REPO_ROOT, 'bin/cli-bridge-mcp-server.cjs'));
}

/** Answers every exec from one routing callback and records the argv it was asked for. */
function fakeExec(route: (args: string[]) => { stdout: string; stderr?: string; code?: number }) {
  const calls: string[][] = [];
  const exec = (_cmd: string, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    calls.push(args);
    const r = route(args);
    setImmediate(() => cb(r.code ? new Error(`exit ${r.code}`) : null, r.stdout, r.stderr || ''));
    return { on() { /* run() also listens for 'error' */ } };
  };
  return { exec, calls };
}

// Real `dws schema --compact` shapes, trimmed to the fields the bridge reads.
const DWS_PRODUCTS = JSON.stringify({
  kind: 'schema', level: 'products', count: 2,
  products: [
    { id: 'doc', agent_summary: '管理钉钉在线文档的正文、块、评论', tool_count: 99 },
    { id: 'calendar', agent_summary: '日历日程 / 会议室 / 闲忙', tool_count: 24 },
  ],
});
const DWS_DOC_TOOLS = JSON.stringify({
  kind: 'schema', level: 'product', count: 2,
  product: {
    id: 'doc',
    tools: [
      { cli_path: 'doc comment batch-query', agent_summary: '批量获取评论详情', effect: 'read', risk: 'low', confirmation: 'not_required' },
      { cli_path: 'doc create', agent_summary: '创建一篇新的在线文档', effect: 'write', risk: 'medium', confirmation: 'not_required' },
      { cli_path: 'doc delete', agent_summary: '删除文档', effect: 'destructive', risk: 'high', confirmation: 'user_required' },
    ],
  },
});

describe('cli-bridge — DingTalk dialect', () => {
  it('discovers products from the CLI JSON index', async () => {
    const { exec } = fakeExec(() => ({ stdout: DWS_PRODUCTS }));
    const b = new (bridge().CliBridge)('dws', { exec });

    const out = await b.listCommands();
    expect(out.domains).toEqual([
      { name: 'doc', description: '管理钉钉在线文档的正文、块、评论', tool_count: 99 },
      { name: 'calendar', description: '日历日程 / 会议室 / 闲忙', tool_count: 24 },
    ]);
  });

  it('lists a product\'s tools with their safety metadata', async () => {
    const { exec } = fakeExec(() => ({ stdout: DWS_DOC_TOOLS }));
    const b = new (bridge().CliBridge)('dws', { exec });

    const out = await b.listCommands('doc');
    expect(out.commands.map((c: any) => c.name)).toEqual(['doc comment batch-query', 'doc create', 'doc delete']);
    expect(out.commands[0]).toMatchObject({ effect: 'read', risk: 'low' });
  });

  it('classifies from the CLI\'s own effect field, not from the command name', async () => {
    // `batch-query` would not be recognised by the verb allowlist, and `permission add` might read
    // as harmless — the CLI's metadata is what keeps both decisions honest.
    const { exec } = fakeExec(() => ({ stdout: DWS_DOC_TOOLS }));
    const b = new (bridge().CliBridge)('dws', { exec });

    expect(await b.classify('doc comment batch-query')).toMatchObject({ risk: 'read', source: 'tool-metadata', effect: 'read' });
    expect(await b.classify('doc create')).toMatchObject({ risk: 'write', source: 'tool-metadata', effect: 'write' });
    expect(await b.classify('doc delete')).toMatchObject({ risk: 'write', source: 'tool-metadata', effect: 'destructive' });
  });

  it('runs a read tool by mapping JSON keys onto flags', async () => {
    const { exec, calls } = fakeExec((args) => (args.includes('schema') ? { stdout: DWS_DOC_TOOLS } : { stdout: '{"ok":true}' }));
    const b = new (bridge().CliBridge)('dws', { exec });

    const out = await b.runReadCommand('doc comment batch-query', JSON.stringify({ doc_id: 'd1', page_size: 20 }));
    expect(out.refused).toBeUndefined();
    const invoke = calls[calls.length - 1];
    expect(invoke).toEqual(['doc', 'comment', 'batch-query', '--doc-id', 'd1', '--page-size', '20']);
  });

  it('reads authentication state from the CLI\'s JSON status', async () => {
    const { exec } = fakeExec(() => ({ stdout: JSON.stringify({ success: true, authenticated: false, message: '未登录' }) }));
    const b = new (bridge().CliBridge)('dws', { exec });
    expect(await b.checkLogin()).toMatchObject({ logged_in: false });
  });

  it('uses the loopback flow without launching a browser, so the app opens the printed URL itself', () => {
    // Verified against dws v1.0.63: `--no-browser` prints the authorization URL and still listens on
    // 127.0.0.1. The device flow skips DingTalk's in-browser "apply to an admin" step.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'bin/cli-bridge-mcp-server.cjs'), 'utf8');
    expect(src).toContain("['auth', 'login', '--no-browser']");
    expect(src).not.toContain("['auth', 'login', '--device']");
  });
});

describe('cli-bridge — WeCom dialect', () => {
  const ROOT_HELP = [
    'Usage: wecom-cli [COMMAND]', '', 'Commands:',
    '  auth        企业微信机器人授权管理',
    '  doc         文档服务，提供文档的创建、重命名、导入、搜索',
    '  sheet       表格服务', '', 'Options:', '  -h, --help  Print help',
  ].join('\n');
  const DOC_HELP = [
    '文档服务', '', 'Commands:',
    '  create    新建文档，支持 doc/sheet/smartsheet 文档类型',
    '  search    按关键词搜索文档',
    '  help      Print this message', '', 'Options:', '      --doc     显示服务文档',
  ].join('\n');

  it('discovers services and their commands from help tables, having no JSON index', async () => {
    const { exec } = fakeExec((args) => (args.length === 1 ? { stdout: ROOT_HELP } : { stdout: DOC_HELP }));
    const b = new (bridge().CliBridge)('wecom', { exec });

    const services = await b.listCommands();
    expect(services.domains.map((d: any) => d.name)).toEqual(['auth', 'doc', 'sheet']);
    const doc = await b.listCommands('doc');
    expect(doc.commands.map((c: any) => c.name)).toEqual(['create', 'search', 'help']);
  });

  it('fetches a command schema with --schema', async () => {
    const schema = { method: 'doc.create', description: '新建文档', schemas: { Req: { type: 'object' } } };
    const { exec, calls } = fakeExec(() => ({ stdout: JSON.stringify(schema) }));
    const b = new (bridge().CliBridge)('wecom', { exec });

    const out = await b.schema('doc create');
    expect(calls[0]).toEqual(['doc', 'create', '--schema']);
    expect(out.schema).toMatchObject({ method: 'doc.create' });
  });

  it('falls back to the verb allowlist and SAYS SO, since WeCom publishes no risk metadata', async () => {
    const { exec } = fakeExec(() => ({ stdout: DOC_HELP }));
    const b = new (bridge().CliBridge)('wecom', { exec });

    expect(await b.classify('doc search')).toMatchObject({ risk: 'read', source: 'verb-heuristic' });
    expect(await b.classify('doc create')).toMatchObject({ risk: 'write', source: 'verb-heuristic' });
    // Anything the allowlist does not recognise stays refused — the weakest dialect must fail closed.
    expect(await b.classify('doc frobnicate')).toMatchObject({ risk: 'unknown' });
  });

  it('parses the plain-text status output, which is not JSON', async () => {
    const { exec } = fakeExec(() => ({ stdout: 'Status: unauthorized\n' }));
    const b = new (bridge().CliBridge)('wecom', { exec });
    expect(await b.checkLogin()).toMatchObject({ logged_in: false });

    const authorized = new (bridge().CliBridge)('wecom', {
      exec: fakeExec(() => ({ stdout: 'Status: authorized\nUsername: 张照航\n' })).exec,
    });
    expect(await authorized.checkLogin()).toMatchObject({ logged_in: true, user_name: '张照航' });
  });

  it('asks for the QR image and returns its path when the CLI prints no URL', async () => {
    // WeCom authorizes by scanning. `local-cli-auth.ts` opens the PNG with the OS viewer instead of
    // failing the connect, so `start_login` must report the path.
    const qrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-wecom-qr-test-'));
    const spawned: string[][] = [];
    const fakeSpawn = (_cmd: string, args: string[]) => {
      spawned.push(args);
      // Emulate the CLI writing the QR file, then exiting without a URL.
      const qrFlag = args.indexOf('--output-qrcode');
      if (qrFlag >= 0) fs.writeFileSync(args[qrFlag + 1], 'PNG');
      return {
        stdout: { on: () => { /* nothing to say */ } },
        stderr: { on: () => { /* nothing to say */ } },
        on: (event: string, cb: () => void) => { if (event === 'exit') setImmediate(cb); },
        kill: () => { /* noop */ },
      };
    };

    try {
      const b = new (bridge().CliBridge)('wecom', { spawn: fakeSpawn });
      b.run = async (args: string[]) =>
        args[0] === 'auth'
          ? { ok: true, stdout: 'Status: unauthorized', stderr: '', error: null }
          : { ok: true, stdout: '', stderr: '', error: null };

      const out = await b.startLogin();
      expect(out.authorization_url).toBe('');
      expect(out.qrcode_path).toMatch(/cogseed-wecom-qr-\d+\.png$/);
      expect(fs.existsSync(out.qrcode_path)).toBe(true);
      // `--noninteractive` keeps the CLI from blocking on a picker in a headless spawn.
      expect(spawned[0]).toContain('--noninteractive');
      b.stopLogin();
    } finally {
      fs.rmSync(qrDir, { recursive: true, force: true });
    }
  });
});


// ── Regressions found by driving the REAL CLIs (not mocks) ──────────────
//
// Both of these shipped as silent failures: the connector looked like it was authorizing and simply
// never finished, with no error the user could act on.

describe('cli-bridge — real-CLI regressions', () => {
  it('treats a configured Feishu CLI as logged in, even though its success payload has no `ok` key', () => {
    // `lark-cli whoami` answers TWO different shapes (verified v1.0.97):
    //   not configured: { ok: false, error: { subtype: 'not_configured' } }
    //   configured:     { profile, appId, brand, identity: 'bot', tokenStatus: 'ready', available: true }
    // Keying "logged in" on `ok === true` reported a fully configured CLI as logged out forever, so
    // the app polled until its five-minute deadline and the card never turned connected.
    const { CliBridge } = bridge();
    const lark = new CliBridge('lark');
    const parse = (lark as any).dialect.auth.parseStatus;

    expect(parse({ profile: 'cli_aa42', appId: 'cli_aa42', brand: 'feishu', identity: 'bot', tokenStatus: 'ready', available: true }))
      .toMatchObject({ logged_in: true });
    expect(parse({ ok: false, error: { subtype: 'not_configured' } }))
      .toEqual({ logged_in: false, setup_required: true });
    expect(parse({ ok: false, error: { subtype: 'invalid_token' } })).toMatchObject({ logged_in: false });
    // A CLI that says the account is unusable is not logged in, whatever else it claims.
    expect(parse({ profile: 'p', identity: 'bot', tokenStatus: 'ready', available: false }))
      .toMatchObject({ logged_in: false });
  });

  it('writes CLI-created files where the CLI is actually allowed to', () => {
    // WeCom's CLI sandboxes output to its cwd + the platform temp dir and REJECTS `os.tmpdir()` on
    // macOS (`/var/folders/...`) with PermissionError 893006, then exits before printing anything.
    // The helper must therefore probe for a directory rather than assume the OS temp dir.
    const dir = bridge()._cliWritableDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(path.isAbsolute(dir)).toBe(true);
    if (process.platform === 'darwin') {
      // `/private/tmp` is the one macOS location WeCom accepts that is not the cwd.
      expect(dir.startsWith('/private/tmp')).toBe(true);
    }
    // The directory must be usable for a real write, which is the whole point.
    const probe = path.join(dir, `.probe-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    expect(fs.readFileSync(probe, 'utf8')).toBe('x');
    fs.unlinkSync(probe);
  });

  it('isolates an authorization child from the MCP stream and from our lifetime', () => {
    // Three properties, each learned from a real failure:
    //   - stdin is `ignore` (our stdin is the JSON-RPC pipe; a CLI probing it read protocol frames)
    //   - the child writes to a FILE (a pipe dies with EPIPE once we exit, killing the poll loop)
    //   - the child is `detached` (any reconnect/other connector used to kill the pending flow)
    const src = fs.readFileSync(path.join(REPO_ROOT, 'bin/cli-bridge-mcp-server.cjs'), 'utf8');
    expect(src).toContain("stdio: ['ignore', loginFd, loginFd]");
    expect(src).toContain('detached: true');
    expect(src).toContain('const loginFd = fs.openSync(loginLogPath');
    // And the URL must be scraped from that file, not from a pipe.
    expect(src).toContain('_scrapeUrlFromFile(loginLogPath)');
  });
});

describe('cli-bridge — login attempt isolation', () => {
  let authDir: string;
  let previousAuthDir: string | undefined;

  beforeEach(() => {
    authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-login-retry-'));
    previousAuthDir = process.env.COGSEED_CONNECTOR_AUTH_DIR;
    process.env.COGSEED_CONNECTOR_AUTH_DIR = authDir;
  });

  afterEach(() => {
    if (previousAuthDir === undefined) delete process.env.COGSEED_CONNECTOR_AUTH_DIR;
    else process.env.COGSEED_CONNECTOR_AUTH_DIR = previousAuthDir;
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  it.each([
    'process interrupted by terminated',
    '您暂无 CLI 数据访问权限，请联系管理员开启',
  ])('allows a fresh authorization after an old failure: %s', async (message) => {
    fs.writeFileSync(path.join(authDir, 'cogseed-dws-login-1.log'), JSON.stringify({ error: { message } }));
    const { exec } = fakeExec(() => ({ stdout: '{"authenticated":false}' }));
    const b = new (bridge().CliBridge)('dws', {
      exec,
      spawn: (_cmd: string, _args: string[], opts: { stdio: unknown[] }) => {
        fs.writeSync(opts.stdio[1] as number, 'https://example.test/device\n');
        return { kill() {}, unref() {} };
      },
    });
    try {
      expect(await b.checkLogin()).toMatchObject({ logged_in: false });
      expect(await b.checkLogin()).not.toHaveProperty('blocked_reason');
      expect(await b.startLogin()).toEqual({ authorization_url: 'https://example.test/device' });
      expect(await b.checkLogin()).not.toHaveProperty('blocked_reason');
    } finally { b.stopLogin(); }
  });

  it.each([
    ['process interrupted by terminated', undefined],
    ['您暂无 CLI 数据访问权限，请联系管理员开启', '您暂无 CLI 数据访问权限，请联系管理员开启'],
  ])('reports current provider refusals but not process interruption: %s', async (message, blockedReason) => {
    const { exec } = fakeExec(() => ({ stdout: '{"authenticated":false}' }));
    const b = new (bridge().CliBridge)('dws', {
      exec,
      spawn: (_cmd: string, _args: string[], opts: { stdio: unknown[] }) => {
        fs.writeSync(opts.stdio[1] as number,
          `https://example.test/device\n${JSON.stringify({ error: { message } })}\n`);
        return { kill() {}, unref() {} };
      },
    });
    try {
      await b.startLogin();
      expect((await b.checkLogin()).blocked_reason).toBe(blockedReason);
      b.stopLogin();
      expect(await b.checkLogin()).not.toHaveProperty('blocked_reason');
    } finally { b.stopLogin(); }
  });
});

describe('cli-bridge — flag mapping', () => {
  it('maps JSON keys to flags, booleans to presence and arrays to repeats', () => {
    expect(bridge().flagsFromJson(JSON.stringify({ doc_name: 'x', dry_run: true, off: false, tag: ['a', 'b'] })))
      .toEqual(['--doc-name', 'x', '--dry-run', '--tag', 'a', '--tag', 'b']);
  });

  it('lets a caller pass exact argv through `_args`, for commands whose schema wants raw flags', () => {
    expect(bridge().flagsFromJson(JSON.stringify({ _args: ['--json', '{"a":1}'] }))).toEqual(['--json', '{"a":1}']);
  });

  it('rejects arguments that are not a JSON object, instead of silently running with none', () => {
    expect(() => bridge().flagsFromJson('not json')).toThrow(/JSON object/);
    expect(() => bridge().flagsFromJson('[1,2]')).toThrow(/JSON object/);
  });
});

// ── Availability + materialization for the two new catalog entries ───────

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cli-bridge-'));
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

describe('dingtalk / wecom catalog entries', () => {
  it('materializes each entry against the shared bridge with its own dialect', async () => {
    const { applyTemplate } = await import('../../../../src/main/features/connectors/apply-template');
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');

    for (const [id, dialect] of [['dingtalk', 'dws'], ['wecom', 'wecom']] as const) {
      const entry = findCatalogEntry(id);
      expect(entry, id).toBeTruthy();
      expect(entry!.auth_mode, id).toBe('local_cli');

      const transport = applyTemplate(entry!, null);
      expect(transport.kind).toBe('stdio');
      if (transport.kind !== 'stdio') throw new Error('expected stdio');
      expect(transport.args[0]).toMatch(/\/bin\/cli-bridge-mcp-server\.cjs$/);
      expect(transport.args[1]).toBe(dialect);
      // Credential-owning: nothing token-shaped is forwarded into the child env.
      expect(Object.keys(transport.env || {}).sort()).toEqual(['COGSEED_NODE', 'COGSEED_PC_DIR', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH']);
    }
  });

  it('gates each card on its own CLI being installed', async () => {
    await activateTestUser();
    const availability = await import('../../../../src/main/features/connectors/availability');
    const catalog = await import('../../../../src/main/features/connectors/catalog');

    availability._setLocalCliProbeForTest(() => false);
    const disabled = availability.catalogWithAvailability('test-runtime-user', catalog.CONNECTOR_CATALOG);
    for (const id of ['dingtalk', 'wecom']) {
      expect(availability.connectorAvailabilityForId('test-runtime-user', id), id).toBe('visible_disabled');
      expect(disabled.find((e) => e.id === id), id).toMatchObject({
        availability: 'visible_disabled',
        disabled_reason: 'cli_missing',
      });
    }

    availability._setLocalCliProbeForTest(() => true);
    for (const id of ['dingtalk', 'wecom']) {
      expect(availability.connectorAvailabilityForId('test-runtime-user', id), id).toBe('enabled');
      expect(availability.isConnectorRuntimeEnabled('test-runtime-user', id), id).toBe(true);
    }
  });
});
