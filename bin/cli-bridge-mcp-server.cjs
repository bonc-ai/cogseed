#!/usr/bin/env node
'use strict';

// Generic CLI→MCP bridge (stdio) — exposes an *agent-oriented vendor CLI* as a small set of MCP
// meta-tools. Spawned as a child process by `features/connectors/mcp-client.ts`.
//
// ── Why a bridge instead of one adapter per vendor ────────────────────────────
// Lark/Feishu (`@larksuite/cli`), DingTalk (`dingtalk-workspace-cli`), and WeCom (`@wecom/cli`)
// all publish CLIs built for agents: each has machine-readable schemas (`lark-cli schema …`,
// `dws schema`, `wecom-cli <svc> <cmd> --schema`) and JSON output. Writing three bespoke MCP
// servers would duplicate the same plumbing; this file keeps the plumbing once and describes the
// per-CLI differences as a small "dialect" table.
//
// ── Umbrella exposure, deliberately (see AGENTS.md) ──────────────────────────
// These CLIs expose hundreds of commands. AGENTS.md forbids flattening vendor actions into a tool
// list ("Never inject every MCP action as a flat SDK tool list"), and a 300-tool surface would
// also poison the model's tool selection. So the bridge exposes three meta-tools — discover,
// inspect, run — and the model walks them the way it walks `list_connector_tools` /
// `call_connector_tool`.
//
// ── Read-only by construction ────────────────────────────────────────────────
// COGSEED-314.4 ships a read-only connector surface: no write tool exists, so the connector's
// always-allow bridge grant (per connector, not per tool) can never silently cover a mutation.
// Here that is enforced at call time from the CLI's OWN risk metadata where the CLI publishes it
// (`lark-cli` marks every command read | write | high-risk-write in its `--help`), and by a
// conservative verb allowlist otherwise. A write attempt returns a refusal, never a mutation.
//
// ── The one rule this file bends (same reviewed exception as tencent-meeting) ─
// AGENTS.md pins CLI dispatch to `features/local_agents/runner.ts` and MCP child spawns to
// `features/connectors/mcp-client.ts`. CogSeed's side is compliant (mcp-client spawns us); our own
// vendor-CLI subprocess is the layer that rule does not cover — a reviewed exception that must be
// recorded in the PR description, not an accident.
//
// ── Credentials ──────────────────────────────────────────────────────────────
// Nothing is injected by `apply-template.ts`: each vendor CLI owns its own login and keeps the
// credential in its own store, so this process reads no token.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCliLaunch } = require('./cli-launch.cjs');

// Install `proxy-bootstrap.cjs` like every other app-owned child so system-proxy routing works
// when the vendor CLI issues its own fetches.
require('./proxy-bootstrap.cjs');

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 60_000;

/** Verbs that are safe to run without further metadata. Deliberately conservative: an unknown verb
 *  is refused rather than assumed read-only — a wrong allow costs one refusal, a wrong deny costs a
 *  mutation in the user's tenant. */
const READ_ONLY_VERB_RE = /^(get|list|search|read|query|show|info|describe|fetch|find|export|download|preview|stat|status|help|version|whoami|schema|doctor)\b/i;
const WRITE_VERB_RE = /^(create|update|delete|remove|set|add|insert|upload|import|move|rename|copy|share|send|post|put|patch|apply|commit|revert|restore|cancel|close|archive|approve|reject|assign|transfer|invite|publish|submit|bind|unbind|enable|disable|start|stop|run|exec|invoke|modify|edit|write|append|clear|reset|revoke|grant)\b/i;

/** Absolute install locations a vendor CLI can land in but the GUI PATH does not carry.
 *
 *  A Finder-launched app (and therefore every child it spawns) inherits the minimal macOS GUI PATH,
 *  where nvm/homebrew/pnpm bin dirs are absent. Resolving by bare name would then fail at the first
 *  call even though the CLI is installed. `availability.ts` duplicates these lists on purpose (main
 *  must not require this adapter — that would pull the MCP SDK into the main process) and a test
 *  pins the two copies equal so they cannot drift.
 *
 *  nvm keeps every version under `~/.nvm/versions/node/<version>/bin`, which no static list can
 *  spell, so that one directory is globbed. */
function _nvmBinCandidates(binName) {
  const out = [];
  try {
    const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
    for (const version of fs.readdirSync(root)) out.push(path.join(root, version, 'bin', binName));
  } catch { /* nvm not installed — the other candidates still apply */ }
  return out;
}

function _cliAbsoluteCandidates(binName) {
  const home = os.homedir();
  const names = process.platform === 'win32' ? [`${binName}.cmd`, `${binName}.exe`] : [binName];
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'Library', 'pnpm'),
  ];
  const out = [];
  for (const dir of dirs) for (const name of names) out.push(path.join(dir, name));
  if (process.platform !== 'win32') for (const name of names) out.push(..._nvmBinCandidates(name));
  return out;
}

function _isExecutableFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Per-CLI dialect. `argv` receives the already-split command path; every dialect must be able to
 * (a) enumerate domains, (b) enumerate commands inside a domain, (c) fetch a schema or help page,
 * and (d) invoke a command as JSON. Only the surface that differs lives here.
 */
const DIALECTS = {
  lark: {
    label: 'Lark/Feishu',
    bin: 'lark-cli',
    envOverride: 'COGSEED_LARK_CLI_BIN',
    /** Domains are the first-level nouns printed in the top-level help. */
    domains: [
      'approval', 'attendance', 'calendar', 'contact', 'drive', 'im', 'mail',
      'mindnotes', 'minutes', 'okr', 'sheets', 'slides', 'task', 'vc', 'wiki', 'docs', 'base',
    ],
    domainHelpArgs: (domain) => [domain, '--help'],
    /** `lark-cli schema <service>.<resource>.<method>` is the raw-API schema entry point. */
    schemaArgs: (command) => ['schema', command],
    invokeArgs: (command, jsonBody) => {
      const parts = command.split('.');
      // Raw API surface: `lark-cli api <method> <path>`; typed surface: `lark-cli <svc>.<res>.<method>`
      return jsonBody ? [...parts, '--data', jsonBody] : [...parts];
    },
    /** `lark-cli` prints "Risk: read|write|high-risk-write" in each command's own --help. */
    riskFromHelp: (helpText) => {
      const m = /Risk:\s*(read|write|high-risk-write)/i.exec(helpText || '');
      return m ? m[1].toLowerCase() : null;
    },
    // Two-stage onboarding, verified against v1.0.97: until `config init --new` has run, `whoami`
    // and `auth status` both answer `{"ok":false,"error":{"subtype":"not_configured"}}` — and that
    // hint explicitly tells callers to run the init in the background and scrape its URL, which is
    // exactly what `startLogin` does.
    auth: {
      statusArgs: ['whoami'],
      setupArgs: ['config', 'init', '--new'],
      loginArgs: ['auth', 'login'],
      // Two different SUCCESS shapes, verified against v1.0.97:
      //   - before setup: `{ ok: false, error: { subtype: 'not_configured' } }`
      //   - after setup:  `{ profile, appId, brand, identity, tokenStatus: 'ready', available: true }`
      //     — note the ABSENCE of `ok`. Keying "logged in" on `ok === true` therefore reported a
      //     fully configured CLI as logged out forever: the app polled until its 5-minute deadline
      //     and the card never turned connected. Read the token state the CLI actually publishes.
      parseStatus: (json) => {
        if (!json || typeof json !== 'object') return { logged_in: false };
        const subtype = (json.error && json.error.subtype) || '';
        if (json.ok === false) {
          return { logged_in: false, setup_required: subtype === 'not_configured' };
        }
        const tokenStatus = String(json.tokenStatus || json.token_status || '').toLowerCase();
        const name =
          json.user_name || json.name || json.profile || json.appId ||
          (json.data && (json.data.user_name || json.data.name)) ||
          (json.user && (json.user.name || json.user.user_name)) || '';
        // `available: false` means the CLI itself says the account cannot be used, whatever else
        // the payload claims.
        const loggedIn = json.available === false
          ? false
          : json.ok === true || tokenStatus === 'ready' || Boolean(json.profile && json.identity);
        return { logged_in: loggedIn, user_name: String(name || '') };
      },
    },
  },
  // Declared but not yet wired: the connectors that need them are not built yet, and a dialect with
  // guessed argv shapes would fail at the user's first call. `dws`/`wecom` discovery commands are
  // already verified — see the connector work that lands with them.
  dws: {
    label: 'DingTalk',
    bin: 'dws',
    envOverride: 'COGSEED_DWS_BIN',
    // DingTalk's CLI is JSON-first: `dws schema` lists 33 products / ~1495 tools, each carrying
    // per-tool safety metadata (`effect: read|write|destructive`, `risk`, `confirmation`). Both
    // discovery and the read-only gate therefore read structured output instead of scraping help.
    splitCommand: (command) => String(command).trim().split(/\s+/).filter(Boolean),
    listCommandsArgs: (domain) => ['schema', domain, '--compact'],
    parseDomains: (json) => ((json && json.products) || []).map((p) => ({
      name: p.id,
      description: p.agent_summary || p.description || '',
      tool_count: p.tool_count,
    })),
    parseCommands: (json) => {
      const tools = (json && json.product && json.product.tools) || [];
      return tools.map((t) => ({
        name: t.cli_path || t.canonical_path || t.id,
        description: t.agent_summary || t.description || '',
        // Carried through so `classify` can answer from the CLI's own safety semantics.
        effect: t.effect,
        risk: t.risk,
        confirmation: t.confirmation,
      }));
    },
    schemaArgs: (command) => ['schema', command, '--compact'],
    auth: {
      statusArgs: ['auth', 'status'],
      // Loopback flow (the CLI default) with `--no-browser`: the CLI prints the authorization URL
      // and listens on 127.0.0.1 for the callback, and the app opens that URL itself. Verified
      // against v1.0.63. The device flow (`--device`) was used before and is a trap on a desktop:
      // it never redirects through the browser, so when the organisation has not enabled CLI data
      // access the user sees "authorized" on the web and the failure only surfaces later in the
      // app. The loopback page instead shows DingTalk's own "apply to an admin" step in-browser.
      loginArgs: ['auth', 'login', '--no-browser'],
      parseStatus: (json) => {
        if (!json || typeof json !== 'object') return { logged_in: false };
        const name = json.user_name || json.name || (json.profile && (json.profile.userName || json.profile.user_name)) || '';
        return { logged_in: json.authenticated === true || json.success === true && json.authenticated === true, user_name: String(name || '') };
      },
    },
  },
  wecom: {
    label: 'WeCom',
    bin: 'wecom-cli',
    envOverride: 'COGSEED_WECOM_CLI_BIN',
    // No machine-readable command index: services are enumerated from the top-level help table and
    // each command's schema is fetched individually with `--schema`. NOTE the weakest safety story
    // of the three dialects — WeCom publishes no per-command risk metadata, so write detection
    // falls back to the verb allowlist. That is why `classify` reports its `source`.
    splitCommand: (command) => String(command).trim().split(/\s+/).filter(Boolean),
    // Services come from the top-level help table and each service's commands from its own help;
    // there is no JSON index to read.
    rootHelpArgs: ['--help'],
    parseDomainsFromHelp: true,
    domainHelpArgs: (domain) => [domain, '--help'],
    schemaArgs: (command) => [...String(command).trim().split(/\s+/), '--schema'],
    auth: {
      statusArgs: ['auth', 'show'],
      // QR-based onboarding: `--noninteractive` skips the interactive picker and `--output-qrcode`
      // writes the scannable image to a file we can open for the user.
      loginArgs: ['auth', 'init', '--noninteractive'],
      qrcodeFlag: '--output-qrcode',
      parseStatus: (json, res) => {
        // `auth show` prints plain text ("Status: unauthorized"), not JSON.
        const text = `${(res && res.stdout) || ''}${(res && res.stderr) || ''}`;
        const m = /Status:\s*([A-Za-z_-]+)/i.exec(text);
        const status = m ? m[1].toLowerCase() : '';
        const loggedIn = Boolean(status) && !/unauthorized|expired|invalid|none/.test(status);
        const name = (/User(?:name)?:\s*(.+)/i.exec(text) || [])[1];
        return { logged_in: loggedIn, ...(name ? { user_name: name.trim() } : {}) };
      },
    },
  },
};

function parseDomainCommands(helpText) {
  // Command tables print as `  <name>   <description>` under an "Available Commands:"/命令 heading.
  const out = [];
  let inTable = false;
  for (const raw of String(helpText || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^[A-Za-z\u4e00-\u9fa5][^\n]*:$/.test(line) && /command|命令/i.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!line.trim()) { inTable = false; continue; }
    const m = /^\s{1,6}(\+?[A-Za-z0-9][A-Za-z0-9._+-]*)\s{2,}(.+)$/.exec(line);
    if (m) out.push({ name: m[1], description: m[2].trim() });
  }
  return out;
}

/** Parse JSON from whichever stream the CLI used. Verified trap: `lark-cli` prints result JSON on
 *  stderr (stdout stays empty), while most CLIs do the opposite — accepting either is the only
 *  portable choice. */
function _parseJsonAnyStream(res) {
  for (const stream of [res && res.stdout, res && res.stderr]) {
    const text = String(stream || '').trim();
    if (!text) continue;
    try { return JSON.parse(text); } catch { /* try the next stream */ }
  }
  return null;
}

/** Map a JSON argument object onto CLI flags, one flag per key.
 *
 *  Both call styles are covered: `{"doc_name": "x", "dry_run": true, "tag": ["a","b"]}` becomes
 *  `--doc-name x --dry-run --tag a --tag b`, and a caller that already knows the exact argv can pass
 *  `{"_args": ["--raw","value"]}` to bypass the mapping. Underscores become dashes because that is
 *  what CLI flag parsers name things; `cli_command_schema` is what tells the model which keys exist.
 */
function flagsFromJson(jsonBody) {
  if (!jsonBody) return [];
  let parsed;
  try { parsed = JSON.parse(jsonBody); }
  catch { throw new Error('`json` must be a JSON object string'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('`json` must be a JSON object');
  }
  const argv = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === '_args') {
      if (!Array.isArray(value)) throw new Error('`_args` must be an array of strings');
      argv.push(...value.map(String));
      continue;
    }
    if (value === undefined || value === null) continue;
    const flag = key.startsWith('-') ? key : `--${key.replace(/_/g, '-')}`;
    if (typeof value === 'boolean') { if (value) argv.push(flag); continue; }
    if (Array.isArray(value)) { for (const item of value) argv.push(flag, String(item)); continue; }
    argv.push(flag, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return argv;
}

/** A directory a vendor CLI will actually accept for files it must create.
 *
 *  Verified trap: WeCom's CLI sandboxes its output path to its working directory plus the platform
 *  temp directory, and `os.tmpdir()` on macOS is `/var/folders/...` (= `/private/var/...`), which it
 *  REJECTS with `PermissionError 893006` — "目标路径超出可访问范围 … (允许范围: <cwd>, /private/tmp)"
 *  — then exits before printing anything. That surfaced as "the CLI exited before printing a
 *  verification URL" with an empty QR file. Probe for a writable directory it accepts instead of
 *  assuming the OS temp dir is usable. */
function _cliWritableDir() {
  // Managed runtimes keep transient authorization images/logs inside the active account too.
  // Do not fall back to a shared temp directory if this explicit private root is unavailable.
  if (process.env.COGSEED_CONNECTOR_AUTH_DIR) {
    const dir = process.env.COGSEED_CONNECTOR_AUTH_DIR;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  const candidates = [];
  if (process.platform === 'darwin') candidates.push('/private/tmp');
  candidates.push(os.tmpdir(), process.cwd());
  for (const dir of candidates) {
    try {
      const probe = path.join(dir, `.cogseed-write-probe-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      const sub = path.join(dir, 'cogseed-connector-auth');
      fs.mkdirSync(sub, { recursive: true });
      return sub;
    } catch { /* not writable here — try the next candidate */ }
  }
  return os.tmpdir();
}

class CliBridge {
  constructor(dialectName, options = {}) {
    const dialect = DIALECTS[dialectName];
    if (!dialect) throw new Error(`unknown CLI dialect: ${dialectName}`);
    this.dialectName = dialectName;
    this.dialect = dialect;
    this.timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
    this._exec = options.exec || execFile;
    this._spawn = options.spawn || null;
    this._loginChild = null;
    this._toolsByProduct = new Map();
    this._bin = options.bin || null;
  }

  /** Absolute-first resolution, then a bare-name fallback that trusts PATH.
   *
   *  The absolute pass is what makes a Finder-launched app work (see `_cliAbsoluteCandidates`); the
   *  bare-name fallback keeps a terminal run working when the CLI sits somewhere unusual. An
   *  explicit `<dialect>_BIN` override wins and is validated rather than trusted, so a typo shows up
   *  as "not found" naming the path instead of a mysterious spawn failure. */
  bin() {
    if (this._bin) return this._bin;
    const override = process.env[this.dialect.envOverride];
    if (override) return (this._bin = override);
    for (const candidate of _cliAbsoluteCandidates(this.dialect.bin)) {
      if (_isExecutableFile(candidate)) return (this._bin = candidate);
    }
    return (this._bin = this.dialect.bin);
  }

  /** Test seam: the probe touches the real filesystem and PATH, which differ between CI runners and
   *  developer machines, so tests must be able to pin the answer. Mirrors the tmeet adapter's
   *  `_setExecForTest` / `_resetBinForTest` convention. */
  _setBinForTest(bin) { this._bin = bin; }

  /** Run the vendor CLI and return stdout. Never throws for a non-zero exit: callers decide. */
  async run(args) {
    const launch = resolveCliLaunch(this.bin(), args);
    return await new Promise((resolve) => {
      let settled = false;
      const child = this._exec(launch.command, launch.args, {
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...(launch.envPatch || {}) },
        windowsVerbatimArguments: Boolean(launch.windowsVerbatimArguments),
      }, (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        resolve({
          ok: !error,
          // Full output: `dws schema <product> --compact` is ~128 KB of structured metadata that we
          // must be able to parse. `MAX_OUTPUT_CHARS` is a MODEL-facing budget and is applied at the
          // boundaries that return to the model, never here — truncating before parsing silently
          // turned a 99-tool product index into "0 tools".
          stdout: String(stdout || ''),
          stderr: String(stderr || '').slice(0, 4000),
          error: error ? String(error.message || error) : null,
        });
      });
      child.on?.('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, stdout: '', stderr: '', error: String(err && err.message || err) });
      });
    });
  }

  /** A dialect may be declared ahead of its connector (see `DIALECTS`). Every public entry point
   *  goes through here: shipping guessed argv shapes would fail at the user's first call, so an
   *  unimplemented dialect says so instead of pretending. */
  _assertImplemented() {
    if (this.dialect.pending) throw new Error(`${this.dialect.label} bridge is not implemented yet`);
  }

  /** Split a command path into argv parts. CLIs disagree: Lark uses dots (`drive.files.list`),
   *  DingTalk and WeCom use spaces (`doc comment batch-query`). */
  commandArgv(command) {
    const split = this.dialect.splitCommand || ((c) => String(c).split('.'));
    return split(String(command));
  }

  async listCommands(domain) {
    this._assertImplemented();
    if (!domain) {
      // Structured index where the CLI offers one (DingTalk), a static domain list otherwise.
      if (this.dialect.parseDomains) {
        const json = _parseJsonAnyStream(await this.run(['schema']));
        const domains = this.dialect.parseDomains(json);
        if (domains.length) return { domains };
        throw new Error(`'${this.dialect.bin} schema' returned no product list`);
      }
      if (this.dialect.parseDomainsFromHelp) {
        const res = await this.run(this.dialect.rootHelpArgs || ['--help']);
        const domains = parseDomainCommands(res.stdout || res.stderr)
          .map((c) => ({ name: c.name, description: c.description }));
        if (domains.length) return { domains };
        throw new Error(`could not read the service list from '${this.dialect.bin} --help'`);
      }
      return { domains: this.dialect.domains.slice() };
    }
    if (this.dialect.parseCommands) {
      const json = _parseJsonAnyStream(await this.run(this.dialect.listCommandsArgs(domain)));
      const commands = this.dialect.parseCommands(json);
      // Cache the product's tool table: `classify` answers from it without a second call.
      this._toolsByProduct.set(domain, new Map(commands.map((c) => [c.name, c])));
      return { domain, commands };
    }
    const res = await this.run(this.dialect.domainHelpArgs(domain));
    if (!res.ok && !res.stdout && !res.stderr) throw new Error(res.error || 'command listing failed');
    return { domain, commands: parseDomainCommands(res.stdout || res.stderr) };
  }

  async schema(command) {
    this._assertImplemented();
    const res = await this.run(this.dialect.schemaArgs(command));
    const text = (res.stdout || res.stderr || '').trim();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON — return the raw page below */ }
    return { command, ok: res.ok, schema: parsed, raw: parsed ? undefined : text.slice(0, 8000) };
  }

  /** The CLI's own safety metadata for a command, when the dialect publishes it. DingTalk does
   *  (`effect: read|write|destructive`), so no extra process is needed thanks to the listing cache. */
  async _cliToolMeta(command) {
    if (!this.dialect.parseCommands) return null;
    const product = this.commandArgv(command)[0];
    if (!product) return null;
    if (!this._toolsByProduct.has(product)) {
      const json = _parseJsonAnyStream(await this.run(this.dialect.listCommandsArgs(product)));
      const commands = this.dialect.parseCommands(json);
      this._toolsByProduct.set(product, new Map(commands.map((c) => [c.name, c])));
    }
    return this._toolsByProduct.get(product).get(String(command).trim()) || null;
  }

  /** Resolve the CLI's own risk classification for a command, then refuse anything not read-only.
   *
   *  Three sources, strongest first, and the report says which one answered:
   *   1. `tool-metadata` — the CLI's structured safety semantics (DingTalk).
   *   2. `cli-metadata`  — a risk line in the command's own help (Lark).
   *   3. `verb-heuristic` — a conservative allowlist. Weaker by construction: it can only classify
   *      names it recognises, and everything else stays refused. */
  async classify(command) {
    this._assertImplemented();
    let meta = null;
    try { meta = await this._cliToolMeta(command); } catch { /* fall through to the weaker sources */ }
    if (meta && meta.effect) {
      const risk = meta.effect === 'read' ? 'read' : 'write';
      return { risk, source: 'tool-metadata', effect: meta.effect, confirmation: meta.confirmation };
    }
    if (this.dialect.riskFromHelp) {
      const res = await this.run([...this.commandArgv(command), '--help']);
      const risk = this.dialect.riskFromHelp(`${res.stdout}\n${res.stderr}`);
      if (risk) return { risk, source: 'cli-metadata' };
    }
    const argv = this.commandArgv(command);
    const leaf = argv[argv.length - 1] || String(command);
    if (WRITE_VERB_RE.test(leaf)) return { risk: 'write', source: 'verb-heuristic' };
    if (READ_ONLY_VERB_RE.test(leaf)) return { risk: 'read', source: 'verb-heuristic' };
    return { risk: 'unknown', source: 'default' };
  }

  async runReadCommand(command, jsonBody) {
    this._assertImplemented();
    const { risk, source } = await this.classify(command);
    if (risk !== 'read') {
      return {
        refused: true,
        risk,
        source,
        message:
          `'${command}' is classified '${risk}' (${source}) and this connector is read-only. ` +
          'Run it yourself in a terminal if you intend the write, then re-read with a read command.',
      };
    }
    const res = await this.run([...this.commandArgv(command), ...flagsFromJson(jsonBody)]);
    const output = res.stdout || res.stderr;
    return {
      command,
      ok: res.ok,
      output: output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated at ${MAX_OUTPUT_CHARS} chars]` : output,
      error: res.error,
    };
  }

  // ── Authorization (the `local_cli` contract) ───────────────────────────
  //
  // `features/connectors/local-cli-auth.ts` drives every `local_cli` connector through the same
  // three tools: it calls `check_login`, and if that says "not logged in" it calls `start_login`,
  // opens the returned URL in the user's browser, then polls `check_login` every 2s until the
  // session appears (or a 5-minute deadline / user cancel fires) and calls `stop_login`. Nothing
  // about the credential passes through that loop — the CLI keeps it.

  /** Parse the CLI's own status JSON. Feishu's CLI needs TWO stages: `config init --new` before any
   *  token can exist, so "not configured" is reported distinctly from "configured, not logged in"
   *  and `startLogin` picks the matching command.
   *
   *  Trap (verified against `lark-cli` v1.0.97): this CLI writes its JSON to **stderr**, leaving
   *  stdout empty, so parsing stdout alone silently degrades every answer to "not logged in". */
  async checkLogin() {
    this._assertImplemented();
    const auth = this.dialect.auth;
    if (!auth) throw new Error(`${this.dialect.label} bridge has no authorization flow`);
    const res = await this.run(auth.statusArgs);
    const status = auth.parseStatus(_parseJsonAnyStream(res), res);
    if (status.logged_in) return status;
    // The CLI records why the current login attempt failed in its own log (DingTalk writes
    // "您暂无 CLI 数据访问权限…"). Without this, the app only ever sees "not logged in" and the user
    // waits out the full five-minute poll for nothing. Surface the vendor's own sentence instead.
    const blocked = this._currentLoginError();
    return blocked ? { ...status, blocked_reason: blocked } : status;
  }

  /** Historical failures are diagnostics, not current authorization state. A timed-out login
   *  writes a termination error, and even a genuine denial may be resolved before a retry.
   *  Only the attempt owned by this bridge may supply a blocking reason. */
  _currentLoginError() {
    if (!this._loginLogPath) return null;
    let text = '';
    try { text = fs.readFileSync(this._loginLogPath, 'utf8'); } catch { return null; }
    const match = /\{[^{}]*"error"\s*:\s*\{[\s\S]{0,600}?"message"\s*:\s*"([^"]{4,300})"/.exec(text);
    // SIGTERM is also emitted by our timeout/cancel cleanup, not by the provider's policy.
    if (match && /^process interrupted by\b/i.test(match[1])) return null;
    return match ? match[1] : null;
  }

  /** Start the CLI's own login in the background and return the verification URL it prints.
   *
   *  Both Feishu stages BLOCK while the user completes them in a browser, so this must not await the
   *  child: it spawns, scrapes the first URL out of the stream, and leaves the process running for
   *  `stop_login` to reap. */
  async startLogin() {
    this._assertImplemented();
    const auth = this.dialect.auth;
    if (!auth) throw new Error(`${this.dialect.label} bridge has no authorization flow`);
    const status = await this.checkLogin();
    if (status.logged_in) return { authorization_url: '', already_authorized: true };

    // Some providers (WeCom) authorize by QR scan and print no URL at all. When the dialect names a
    // QR flag, ask the CLI to write the image and keep the path: `local-cli-auth.ts` opens it with
    // the OS viewer so the flow stays usable without a renderer change.
    const qrPath = auth.qrcodeFlag
      ? path.join(_cliWritableDir(), `cogseed-${this.dialectName}-qr-${Date.now()}.png`)
      : null;
    const baseArgs = status.setup_required ? auth.setupArgs : auth.loginArgs;
    const args = qrPath ? [...baseArgs, auth.qrcodeFlag, qrPath] : baseArgs;
    this.stopLogin();
    const launch = resolveCliLaunch(this.bin(), args);
    // The child writes its progress to a FILE rather than to a pipe back to us. Verified trap: a
    // detached flow that keeps a stale pipe dies with EPIPE the next time it prints (DingTalk logs
    // "轮询中…" every 5s), so a user confirming a valid code afterwards found no process listening.
    // A file also leaves an operator-readable trace of what the vendor CLI actually did.
    const loginLogPath = path.join(_cliWritableDir(), `cogseed-${this.dialectName}-login-${Date.now()}.log`);
    const loginFd = fs.openSync(loginLogPath, 'a');
    const child = (this._spawn || require('node:child_process').spawn)(
      launch.command,
      launch.args,
      {
        env: { ...process.env, ...(launch.envPatch || {}) },
        windowsVerbatimArguments: Boolean(launch.windowsVerbatimArguments),
        stdio: ['ignore', loginFd, loginFd],
        // CRITICAL (1): stdin is `ignore` — this process's own stdin is the MCP JSON-RPC pipe, and
        // a vendor CLI that probes stdin for a terminal (WeCom's does) reads those frames and exits
        // instantly, which surfaced as "the CLI exited before printing a verification URL".
        // CRITICAL (2): detach the authorization child from our process group.
        //
        // Field report: a user completed DingTalk's device-authorization page twice and the CLI
        // still reported "not logged in". The device flow polls for up to 900s in THIS child, but
        // the child is a grandchild of the app (app → adapter → CLI): any reconnect, or the user
        // clicking a second connector (which supersedes the pending one), closes the MCP connection,
        // kills the adapter, and takes the polling child with it — so the confirmation lands on a
        // process that no longer exists. Detached, the flow finishes on its own and writes the
        // credential into the CLI's own store, where the next `check_login` finds it.
        detached: true,
      },
    );
    this._loginChild = child;
    this._loginLogPath = loginLogPath;
    fs.closeSync(loginFd); // the child holds its own duplicate

    let url;
    try {
      url = await this._scrapeUrlFromFile(loginLogPath);
    } catch (err) {
      // QR-only onboarding: no URL ever appears, but the image did. Hand back the path instead of
      // failing the whole connect — the caller decides how to show it.
      if (qrPath && fs.existsSync(qrPath)) return { authorization_url: '', qrcode_path: qrPath };
      throw err;
    }
    // Detached means we must not keep the event loop alive for it: the flow continues on its own.
    child.unref?.();
    return { authorization_url: url };
  }

  /** Resolve with the first https URL the vendor CLI writes to its log file.
   *
   *  Reading a file rather than listening on a pipe is what lets the child outlive us: the flow
   *  keeps polling the provider for up to 15 minutes after we return the URL, and a pipe whose
   *  reader has exited kills it on the next write. The log file doubles as a diagnostic artifact —
   *  nothing secret is written to it by us, and the provider only prints the consent URL + codes. */
  async _scrapeUrlFromFile(logPath, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let text = '';
      try { text = fs.readFileSync(logPath, 'utf8'); } catch { /* not created yet */ }
      const match = /https:\/\/[^\s"'<>]+/.exec(text);
      if (match) return match[0];
      if (Date.now() >= deadline) {
        throw new Error('the CLI printed no verification URL in time');
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  /** Reap the background login process. Idempotent: `local-cli-auth.ts` calls it on every exit path. */
  stopLogin() {
    const child = this._loginChild;
    this._loginChild = null;
    this._loginLogPath = null;
    if (!child) return { stopped: false };
    try { child.kill(); } catch { /* already gone */ }
    return { stopped: true };
  }
}

/** The meta-tools. Static descriptions (not per-command) keep the tool list small — the model
 *  discovers the command surface through `cli_list_commands` / `cli_command_schema`.
 *
 *  The three `*_login` tools are the `local_cli` authorization contract (see
 *  `features/connectors/local-cli-auth.ts`); `toolsFor` drops them for dialects that have no
 *  authorization flow yet. */
const TOOLS = [
  {
    name: 'check_login',
    description:
      'Report whether the vendor CLI currently holds a valid session, and for which account. Called ' +
      'by the app before connecting and while a login is pending.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_login',
    description:
      'Begin the vendor CLI\'s own authorization and return the URL the user must open. The CLI keeps ' +
      'running in the background; the app polls `check_login` until it reports logged in.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop_login',
    description: 'Abandon a pending authorization started by `start_login`. Safe to call when none is running.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cli_list_commands',
    description:
      'List the vendor CLI\'s service domains, or the commands inside one domain. Call with no ' +
      'arguments first to see the domains, then pass one to see its commands. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'A domain from the no-argument listing, e.g. "drive" or "calendar".' },
      },
    },
  },
  {
    name: 'cli_command_schema',
    description:
      'Show one command\'s parameters, types and response shape, as published by the CLI itself. ' +
      'Call this before running a command whose arguments you are unsure about. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Dotted command path, e.g. "drive.files.list".' },
      },
      required: ['command'],
    },
  },
  {
    name: 'cli_run_read_command',
    description:
      'Run a READ-ONLY command and return its JSON output. Write commands are refused: this ' +
      'connector is read-only by design, so the user performs mutations themselves. Pass arguments ' +
      'as a JSON object in `json`.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Dotted command path returned by cli_list_commands.' },
        json: { type: 'string', description: 'Optional JSON object string with the command arguments.' },
      },
      required: ['command'],
    },
  },
];

async function callTool(bridge, name, args) {
  switch (name) {
    case 'check_login':
      return await bridge.checkLogin();
    case 'start_login':
      return await bridge.startLogin();
    case 'stop_login':
      return bridge.stopLogin();
    case 'cli_list_commands':
      return await bridge.listCommands(args.domain ? String(args.domain) : undefined);
    case 'cli_command_schema':
      return await bridge.schema(String(args.command || ''));
    case 'cli_run_read_command':
      return await bridge.runReadCommand(String(args.command || ''), args.json ? String(args.json) : undefined);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** Auth tools exist only where a dialect has an authorization flow; a pending dialect must not
 *  advertise tools it cannot serve. */
function toolsFor(dialectName) {
  const dialect = DIALECTS[dialectName];
  if (!dialect) throw new Error(`unknown CLI dialect: ${dialectName}`);
  return TOOLS.filter((t) => !t.name.endsWith('_login') || Boolean(dialect.auth));
}

async function main() {
  // argv: [dialect] — `apply-template.ts` passes it from the catalog entry's args.
  const dialectName = process.argv[2] || 'lark';
  const bridge = new CliBridge(dialectName);

  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

  const server = new Server(
    { name: `cogseed-cli-bridge-${dialectName}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(dialectName) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await callTool(bridge, name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err && err.message) || String(err) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[cli-bridge] fatal: ${(err && err.message) || err}\n`);
    process.exit(1);
  });
}

module.exports = {
  CliBridge,
  _cliAbsoluteCandidates,
  _isExecutableFile,
  DIALECTS,
  TOOLS,
  toolsFor,
  flagsFromJson,
  _cliWritableDir,
  _parseJsonAnyStream,
  callTool,
  parseDomainCommands,
  READ_ONLY_VERB_RE,
  WRITE_VERB_RE,
  DEFAULT_TIMEOUT_MS,
};
