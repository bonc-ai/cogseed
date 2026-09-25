#!/usr/bin/env node
require('./proxy-bootstrap.cjs');
// Tencent Meeting MCP server (stdio) — wraps the official `tmeet` CLI behind the MCP tool-use
// protocol. Spawned as a child process by `features/connectors/mcp-client.ts`.
//
// ── Why a CLI wrapper (and the one rule it bends) ─────────────────────────────
// `tmeet` is Tencent's official CLI (`npm i -g @tencentcloud/tmeet`, MIT, Go). It speaks the
// Tencent Meeting open-platform REST API and keeps the OAuth2 device-flow credential in the OS
// keychain (AES-256-GCM, device-bound) — this process therefore reads NO token: there is no
// `TENCENT_*` env var and nothing is injected by `apply-template.ts`. That is the whole point:
// the credential never enters CogSeed's config, logs, or `secrets_enc`.
//
// `AGENTS.md` pins CLI dispatch to `features/local_agents/runner.ts` and MCP child spawns to
// `features/connectors/mcp-client.ts`. CogSeed's side of this adapter is compliant (mcp-client
// spawns us). This adapter's own `tmeet` subprocess is the layer that rule does not cover —
// **reviewed exception, recorded in the PR description**, not an accident.
//
// ── Read-only surface ────────────────────────────────────────────────────────
// COGSEED-314.4 is "只读接入适配". We expose records/transcripts and the *preview* half of the
// recording-permission application only. No `meeting create|update|cancel`, no
// `record permission-apply-commit`. Tencent's own docs require a self-built agent to implement
// write confirmation itself; shipping no write tool satisfies that by construction and keeps the
// `bridge_permissions` always-allow grant (which is per (agent, connector), not per tool) from
// silently covering a mutation.
//
// ── Two traps from the real CLI (verified against v1.0.18, not just the docs) ──
// 1. TWO DIFFERENT IDS. Transcript tools need `--record-file-id`; `record address` and
//    `record permission-apply-prepare` need `--meeting-record-id`. They are not
//    interchangeable. `list_recordings` returns both so the model cannot mix them up.
// 2. A ROW'S FILE ID IS NESTED, AND MAY BE ABSENT. `record_file_id` does not exist at row level —
//    it lives in `record_files[]`, which is legitimately EMPTY for some records (a 转写 record with
//    no file yet). Those records cannot drive any transcript call, so `list_recordings` marks them
//    `usable_for_transcript: false` and lists them under `unusable_records`.
//
//    CORRECTION worth keeping: an earlier revision of this file asserted that a `云录制` record's
//    id is rejected by the transcript tools. Real responses disprove that — a `云录制` file id can
//    return transcript content. `record_type` is therefore a PREFERENCE hint
//    (`preferred_transcript_records`), never a gate.
//
// ── Transcript shape (verified) ──────────────────────────────────────────────
// Text is three levels down: `data.minutes.paragraphs[].sentences[].words[].text`, with
// `speaker.user_id` (stable) + `speaker.user_name` (display only) per paragraph, and timestamps
// that are RELATIVE clocks (`02:45`). `get_transcript` returns both the structured paragraphs and
// a flattened speaker-prefixed `text`.
//
// ── TWO INDEPENDENT DATA CHANNELS (verified — this is easy to get wrong) ─────
//   `record`  — per-sentence transcript. REQUIRES a cloud recording, which the host must start
//               manually. `record_type` is `云录制` or `文字转写`.
//   `minutes` — the platform's own meeting summary ("Yuanbao minutes"). Requires NO recording.
// A real meeting was observed with `records_total_count: 0` (nothing to fetch from `record`) while
// still exposing three `minutes`. So the two channels do NOT cover the same meetings: a meeting
// that is invisible to the transcript tools may still be reachable through `get_meeting_minutes`.
// Neither channel subsumes the other — `minutes` carries no per-sentence text, so word-level
// correction still needs `record`.
//
// ── Time format ──────────────────────────────────────────────────────────────
// `record list` takes ISO 8601 *with an offset* (`--start 2026-03-12T14:00+08:00`). A bare local
// time is rejected by the CLI with `--start format error`, which is a confusing dead end for the
// model, so `_requireOffsetIso` fails fast with a message that says what to add.

const { execFile } = require('node:child_process');
const { resolveCliLaunch } = require('./cli-launch.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

/**
 * Resolve the `tmeet` binary.
 *
 * PATH is the trap here: the SDK spawns us with getDefaultEnvironment() + the connector's own env,
 * which does include PATH — but on macOS a Finder-launched packaged app inherits the minimal GUI
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which does NOT contain `/opt/homebrew/bin` or
 * `/usr/local/bin`. `npm i -g @tencentcloud/tmeet` therefore succeeds while the app still cannot
 * find the CLI, and the user sees only ENOENT. Probe the usual global-install locations so the
 * common case works without asking the user to configure anything.
 */
const _RESOLVED = new Map();

function _candidates() {
  const home = os.homedir();
  const out = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'npm', 'tmeet.cmd'));
    out.push('tmeet.cmd', 'tmeet.exe');
  }
  // Explicit override is handled by `tmeetBin()` before probing.
  out.push(
    // Let the shell find it when PATH is intact (dev runs, terminal launches).
    'tmeet',
    // Homebrew: Apple Silicon then Intel.
    '/opt/homebrew/bin/tmeet',
    '/usr/local/bin/tmeet',
    // npm global prefixes that do not land on the GUI PATH.
    path.join(home, '.npm-global', 'bin', 'tmeet'),
    path.join(home, '.local', 'bin', 'tmeet'),
    path.join(home, 'Library', 'pnpm', 'tmeet'),
    '/usr/local/lib/node_modules/@tencentcloud/tmeet/tmeet',
  );
  return out.filter(Boolean);
}

/** Prefer an absolute candidate that is actually executable; fall back to a bare name for PATH to
 *  resolve. Pure, so the ordering is testable without depending on what this machine has
 *  installed.
 *
 *  Absolute probing has to come FIRST, and bare names must not short-circuit it. A packaged app
 *  launched from Finder inherits the minimal GUI PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so the
 *  location that works in a terminal is missing there — that is the whole reason the absolute
 *  candidate list exists. Testing a bare name first would always win and silently reduce this to
 *  "trust PATH", which is the bug the candidate list was written to avoid. */
function _pickBin(candidates, isExecutable) {
  for (const c of candidates) {
    // Bare names are PATH-resolved; they are the fallback below, not a probe here.
    if (!c.includes('/') && !c.includes('\\')) continue;
    if (isExecutable(c)) return c;
  }
  return candidates.find((c) => !c.includes('/') && !c.includes('\\')) || 'tmeet';
}

function tmeetBin() {
  // An explicit override is used verbatim — never silently swapped for another binary, so an
  // ENOENT names the path the user actually configured.
  if (process.env.COGSEED_TMEET_BIN) return process.env.COGSEED_TMEET_BIN;
  const cached = _RESOLVED.get('bin');
  if (cached) return cached;
  const chosen = _pickBin(_candidates(), (c) => {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  _RESOLVED.set('bin', chosen);
  return chosen;
}

/** Resolve one `tmeet` invocation into something the OS can actually execute.
 *
 *  On Windows an npm-global install is a `tmeet.cmd` shim and CreateProcess cannot execute a
 *  `.cmd`/`.bat` directly, so a bare `execFile(bin, …)` fails with ENOENT no matter how correct
 *  the path is. `cli-launch.cjs` prefers resolving the shim to the Node script it wraps (no shell,
 *  so model-supplied arguments such as a meeting id or a search term can never become shell
 *  syntax) and only falls back to `ComSpec` with escaped arguments. Off Windows this is the
 *  identity. */
function _launchFor(bin, args) {
  const launch = resolveCliLaunch(bin, args);
  const options = {};
  if (launch.envPatch) options.env = { ...process.env, ...launch.envPatch };
  if (launch.windowsVerbatimArguments) options.windowsVerbatimArguments = true;
  return { command: launch.command, args: launch.args, options };
}

function _resetBinForTest() {
  _RESOLVED.delete('bin');
}

const EXEC_TIMEOUT_MS = Number(process.env.COGSEED_TMEET_TIMEOUT_MS || 60000);
/** `record list` caps page size at 30 server-side; keep it honest instead of letting the CLI clamp. */
const MAX_PAGE_SIZE = 30;
/** `minutes get` ceilings differ by mode: transient (per-occurrence) allows far more than stable. */
const MAX_MINUTES_PAGE_TRANSIENT = 300;
const MAX_MINUTES_PAGE_STABLE = 30;
const MAX_MINUTES_SEARCH_PAGE = 50;
/** The minutes search API itself rejects queries longer than this. */
const MAX_QUERY_CHARS = 50;
/** Transcript text is the one legitimately large payload here. Keep a single call bounded. */
const MAX_TRANSCRIPT_CHARS = 200000;

// ── Tool definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_recordings',
    description:
      'List Tencent Meeting recording records the signed-in account can read. A meeting usually ' +
      'returns a `云录制` (audio/video) record and a `文字转写` (transcript) record. Each record ' +
      'carries record_files[], and ONLY records with at least one file can drive the transcript ' +
      'tools — prefer `preferred_transcript_records`, and treat `unusable_records` as a dead end. ' +
      'Supply one of: start+end, meeting_id, or meeting_code. Time ranges are capped at 31 days.',
    inputSchema: {
      type: 'object',
      properties: {
        start: {
          type: 'string',
          description: 'Query start, ISO 8601 WITH offset, e.g. "2026-03-12T14:00+08:00". Required with end unless meeting_id/meeting_code is given.',
        },
        end: {
          type: 'string',
          description: 'Query end, ISO 8601 WITH offset. Required with start unless meeting_id/meeting_code is given.',
        },
        meeting_id: { type: 'string', description: 'Meeting id (pure digits). Alternative to the time range.' },
        meeting_code: { type: 'string', description: '9-digit meeting code. Alternative to the time range.' },
        page_size: { type: 'number', description: 'Records per page, max 30 (default 30).' },
        page_token: { type: 'string', description: 'Pagination token from a previous call. Pass it back unchanged.' },
      },
    },
  },
  {
    name: 'get_transcript',
    description:
      'Get the transcript of one recording, as structured paragraphs plus a flattened text. Pass a ' +
      'record_file_id from list_recordings. Each paragraph carries pid, relative start/end clocks, ' +
      'speaker_id (stable) and speaker_name (display only), so quotes can be attributed without ' +
      'guessing. Timestamps are RELATIVE to the recording start, not absolute meeting times. ' +
      'Long transcripts paginate: pass pid/limit from a previous response to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        record_file_id: { type: 'string', description: 'A record_file_id from list_recordings. Required.' },
        pid: { type: 'string', description: 'Start paragraph id for pagination (string, per the CLI).' },
        limit: { type: 'string', description: 'Number of paragraphs to fetch (string, per the CLI).' },
      },
      required: ['record_file_id'],
    },
  },
  {
    name: 'get_transcript_paragraphs',
    description:
      'List the paragraph ids (pid + relative start/end clocks) of a transcript so a long ' +
      'transcript can be walked page by page with get_transcript. Pass a record_file_id from ' +
      'list_recordings.',
    inputSchema: {
      type: 'object',
      properties: {
        record_file_id: { type: 'string', description: 'A record_file_id from list_recordings. Required.' },
      },
      required: ['record_file_id'],
    },
  },
  {
    name: 'search_transcript',
    description:
      'Keyword-search inside one transcript. Returns matching paragraph/sentence ids and timestamps. ' +
      'Use this to locate where a topic was discussed without reading the whole transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        record_file_id: { type: 'string', description: 'The `文字转写` record file id. Required.' },
        text: { type: 'string', description: 'Search text. Required.' },
      },
      required: ['record_file_id', 'text'],
    },
  },
  {
    name: 'preview_record_permission',
    description:
      'Preview the recording-permission application for one meeting record, WITHOUT submitting it. ' +
      'Recording permission belongs to the meeting creator by default; if a meeting cannot be read ' +
      'because the account lacks recording permission, this shows what would be requested so the ' +
      'user can decide. Submitting the application is a write action and is deliberately NOT ' +
      'exposed by this connector.',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_record_id: { type: 'string', description: 'The meeting_record_id from list_recordings. Required. Note: this is NOT record_file_id.' },
      },
      required: ['meeting_record_id'],
    },
  },
  {
    name: 'get_meeting_minutes',
    description:
      'Get the platform-generated meeting summary ("Yuanbao minutes") for one meeting. This is the ' +
      'ONLY channel that works for meetings with no cloud recording — a meeting can have a summary ' +
      'while its recording list is empty, so prefer this over the transcript tools when a meeting ' +
      'cannot be found. Provide one of minute_id (a single occurrence), meeting_id (a whole ' +
      'recurring series, may return several occurrences) or meeting_code. `summary_points` is ' +
      'Markdown. `todos` is returned by the platform but is frequently EMPTY — do not treat it as a ' +
      'complete action list.',
    inputSchema: {
      type: 'object',
      properties: {
        minute_id: { type: 'string', description: 'One minute occurrence id (from the meeting list or minutes search).' },
        meeting_id: { type: 'string', description: 'Meeting id (cycle-level) — returns the series\' summaries.' },
        meeting_code: { type: 'string', description: '9-12 digit meeting code, resolved to a meeting id.' },
        sub_meeting_id: { type: 'string', description: 'Recurring-meeting instance id; omit for non-recurring meetings.' },
        short_summary: { type: 'boolean', description: 'Fetch the transient (rolling) summary. Requires minute_id.' },
        page_size: { type: 'number', description: 'Summaries per page. Max 300 with minute_id, otherwise max 30.' },
        page_token: { type: 'string', description: 'Pagination token from a previous call.' },
      },
    },
  },
  {
    name: 'search_meeting_minutes',
    description:
      'Full-text search across meeting summaries, returning matching snippets with context. Use this ' +
      'to answer "which meeting discussed X" without fetching every summary. The search runs over ' +
      'summary text, so it finds topics that were summarised rather than every word that was spoken ' +
      '— use search_transcript for word-level search inside one recording.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword, max 50 characters. Required.' },
        start: { type: 'string', description: 'Lower time bound, ISO 8601 WITH offset.' },
        end: { type: 'string', description: 'Upper time bound, ISO 8601 WITH offset.' },
        page_size: { type: 'number', description: 'Results per page, max 50 (default 20).' },
        page_token: { type: 'string', description: 'Pagination token from a previous call.' },
      },
      required: ['query'],
    },
  },
  // ── Authorization helpers ─────────────────────────────────────────────
  // These three are NOT read-only meeting tools and must never be handed to the model: they
  // open a browser-based login, poll the session, and cancel a pending attempt. They exist so the
  // connector page can drive `tmeet auth login` through this adapter — the sanctioned place where
  // the CLI may be spawned — instead of adding a third CLI-spawn site to the main process.
  //
  // They deliberately stop short of anything that would make the adapter a credential store:
  // `check_login` reports validity and the display name only, never a token value, and there is no
  // logout tool — disconnecting a connector must not silently sign the user out of a CLI that
  // every profile on the machine shares.
  {
    name: 'start_login',
    description:
      'Begin a Tencent Meeting CLI login and return the authorization URL for the host to open. ' +
      'The URL is also shown to the user, so a browser that fails to open is recoverable. ' +
      'Supersedes any previous pending attempt. Call check_login afterwards to poll.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_login',
    description:
      'Report whether the Tencent Meeting CLI currently holds a valid session. Returns ' +
      'logged_in, the display name, and token validity windows — never token values. When a login ' +
      'started by start_login has completed, this stops the pending attempt.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop_login',
    description:
      'Abandon a login started by start_login. Safe to call when none is pending. Does not sign ' +
      'the user out of an already-established session.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── tmeet invocation ──────────────────────────────────────────────────

/** Injectable so tests never spawn a real CLI. */
let _execImpl = _execTmeet;

function _setExecForTest(fn) {
  _execImpl = fn || _execTmeet;
}

function _execTmeet(args) {
  return new Promise((resolve, reject) => {
    // argv array, never a shell string: no quoting/injection surface, and the CLI's own argument
    // parsing stays the single source of truth.
    const bin = tmeetBin();
    const launch = _launchFor(bin, [...args, '--format', 'json']);
    execFile(launch.command, launch.args, { timeout: EXEC_TIMEOUT_MS, ...launch.options }, (err, stdout, stderr) => {
      if (err) {
        // `tmeet` reports "Not logged in. Please use 'tmeet auth login'." on stdout for some
        // commands and on stderr for others; surface whichever exists plus the exit code.
        const detail = String(stderr || '').trim() || String(stdout || '').trim() || err.message;
        let hint = '';
        if (err.code === 'ENOENT') {
          hint = ` (the Tencent Meeting CLI was not found at "${bin}". Install it with ` +
            '`npm install -g @tencentcloud/tmeet`, or point COGSEED_TMEET_BIN at the binary.)';
        } else if (/not logged in|auth login|user config is empty/i.test(detail)) {
          hint = ' (the Tencent Meeting account is not connected — the user must run `tmeet auth login` first)';
        }
        reject(new Error(`tmeet ${args[0]} ${args[1] || ''} failed: ${detail.slice(0, 400)}${hint}`));
        return;
      }
      try {
        resolve(stdout ? JSON.parse(stdout) : {});
      } catch {
        reject(new Error(`tmeet returned non-JSON output: ${String(stdout).slice(0, 300)}`));
      }
    });
  });
}

async function tmeet(...args) {
  return _execImpl(args.filter((a) => a !== undefined && a !== null && a !== ''));
}

/** Pair up `--flag value`; empty values are dropped by `tmeet()` above. */
function _opt(flag, value) {
  return value === undefined || value === null || value === '' ? [] : [flag, String(value)];
}

// ── Authorization (auth subcommands) ──────────────────────────────────
//
// `tmeet auth` ignores `--format json` and prints human-readable text ("Logged in", "OpenId: …"),
// so these commands cannot go through `_execTmeet`, which JSON-parses stdout. `_execTmeetText` is
// the text-mode sibling: same argv-not-shell-string contract, no JSON parsing.

/** Injectable so tests never spawn a real CLI. */
let _execTextImpl = _execTmeetText;

function _setTextExecForTest(fn) {
  _execTextImpl = fn || _execTmeetText;
}

const AUTH_STATUS_TIMEOUT_MS = Number(process.env.COGSEED_TMEET_AUTH_TIMEOUT_MS || 30000);

function _execTmeetText(args) {
  return new Promise((resolve, reject) => {
    const bin = tmeetBin();
    const launch = _launchFor(bin, args);
    execFile(launch.command, launch.args, { timeout: AUTH_STATUS_TIMEOUT_MS, ...launch.options }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').trim() || String(stdout || '').trim() || err.message;
        let hint = '';
        if (err.code === 'ENOENT') {
          hint = ` (the Tencent Meeting CLI was not found at "${bin}". Install it with ` +
            '`npm install -g @tencentcloud/tmeet`, or point COGSEED_TMEET_BIN at the binary.)';
        }
        reject(new Error(`tmeet ${args.join(' ')} failed: ${detail.slice(0, 400)}${hint}`));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function tmeetText(...args) {
  return _execTextImpl(args.filter((a) => a !== undefined && a !== null && a !== ''));
}

/** Parse `tmeet auth status` output. Shape verified against tmeet 1.0.18; the values below
 *  are synthetic illustrations rather than a captured account:
 *    Logged in
 *      OpenId:  cli_…
 *      UserName:  Example User
 *      AccessToken:  valid (expires at 2030-01-01 00:00:00, remaining 1h 0m)
 *      RefreshToken: valid (expires at 2030-02-01 00:00:00, remaining 30d 0h 0m)
 *  A signed-out CLI prints a "Not logged in"-style line instead, so absence of `Logged in` is the
 *  sign-out signal rather than a parse failure — a parse that threw here would make "not logged in"
 *  indistinguishable from a real CLI error for the caller. */
function _parseAuthStatus(text) {
  const raw = String(text || '');
  const loggedIn = /^\s*Logged\s+in\s*$/im.test(raw) && !/not\s+logged\s+in/i.test(raw);
  const field = (label) => {
    const m = raw.match(new RegExp(`^\\s*${label}:\\s*(.*)$`, 'im'));
    return m ? m[1].trim() : '';
  };
  const validity = (label) => {
    const value = field(label);
    if (!value) return { present: false, valid: false, expires_at: '', remaining: '' };
    const expires = value.match(/expires at ([^,)]+)/i);
    const remaining = value.match(/remaining ([^,)]+)/i);
    return {
      present: true,
      valid: /valid/i.test(value) && !/invalid|expired/i.test(value),
      expires_at: expires ? expires[1].trim() : '',
      remaining: remaining ? remaining[1].trim() : '',
    };
  };
  return {
    logged_in: loggedIn,
    user_name: loggedIn ? field('UserName') : '',
    access_token: validity('AccessToken'),
    refresh_token: validity('RefreshToken'),
    // `OpenId` is deliberately NOT returned: it is an account identifier the connector page never
    // displays, so handing it to main would be exposure without a consumer. Everything returned
    // here is validity metadata plus a display name.
  };
}

/** Pending `tmeet auth login` child, if any. Held at module scope because the login outlives the
 *  single tool call that starts it: the CLI waits for the user to finish in the browser, so its
 *  completion is only observable through a later `check_login` poll. */
let _pendingLogin = null;

/** Spawn injection for tests. */
let _spawnImpl = null;

function _setSpawnForTest(fn) {
  _spawnImpl = fn || null;
}

const LOGIN_URL_TIMEOUT_MS = Number(process.env.COGSEED_TMEET_LOGIN_URL_TIMEOUT_MS || 20000);
const AUTH_URL_RE = /https?:\/\/[^\s"'<>]+/;

/** Kill the pending login child, if any. `SIGTERM` then a short `SIGKILL` fallback, because the
 *  CLI may be blocked in a poll and ignore the first signal. Returns whether something was pending. */
function _stopPendingLogin() {
  const pending = _pendingLogin;
  if (!pending) return false;
  _pendingLogin = null;
  try {
    pending.child.kill('SIGTERM');
    const killer = setTimeout(() => {
      try { pending.child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 2000);
    if (typeof killer.unref === 'function') killer.unref();
  } catch { /* already gone */ }
  return true;
}

/** Start a login and resolve with the authorization URL once it appears on stdout. Rejects when the
 *  CLI exits early or never prints a URL, so the caller gets a concrete error instead of an
 *  indefinitely pending state. */
async function startLogin() {
  _stopPendingLogin();
  const bin = tmeetBin();
  // argv array, never a shell string, and `--no-browser` so this adapter controls what happens
  // next: the host decides whether to open the URL, and a browser that refuses to open still
  // leaves the user a copyable link.
  const launch = _launchFor(bin, ['auth', 'login', '--no-browser']);
  const child = (_spawnImpl || require('node:child_process').spawn)(
    launch.command,
    launch.args,
    { stdio: ['ignore', 'pipe', 'pipe'], ...launch.options },
  );
  const entry = { child, bin, started_at: Date.now() };
  _pendingLogin = entry;

  const url = await new Promise((resolve, reject) => {
    let buffered = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(
        `tmeet auth login did not print an authorization URL within ${Math.round(LOGIN_URL_TIMEOUT_MS / 1000)}s`,
      ));
    }, LOGIN_URL_TIMEOUT_MS);

    const scan = (chunk) => {
      buffered += String(chunk);
      const found = buffered.match(AUTH_URL_RE);
      if (found) finish(resolve, found[0].replace(/[.,;)]+$/, ''));
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code) => {
      // Exit before a URL appeared: the CLI failed fast, already had a session, or finished without
      // needing a browser. Report the buffered output rather than swallowing it, because that output
      // is the only diagnosis available.
      const found = buffered.match(AUTH_URL_RE);
      if (found) return finish(resolve, found[0].replace(/[.,;)]+$/, ''));
      // Observed for real (tmeet 1.0.18): when a valid session already exists, `auth login` exits
      // non-zero printing "Error: user has been login, please use 'tmeet cmd [flags] to use'" on
      // stderr. Callers are expected to `check_login` before `start_login`, so reaching this means
      // either a race or a caller bug — say so instead of passing CLI jargon through.
      const alreadySignedIn = /has been login|already logged in|user config is empty/i.test(buffered);
      const hint = alreadySignedIn
        ? ' (the CLI already holds a session — call check_login first instead of starting a login)'
        : '';
      finish(reject, new Error(
        `tmeet auth login exited (code ${code}) without printing an authorization URL: ` +
        `${buffered.trim().slice(0, 300) || '(no output)'}${hint}`,
      ));
    });
  });

  entry.authorization_url = url;
  return url;
}

async function checkLogin() {
  const { stdout } = await tmeetText('auth', 'status');
  const status = _parseAuthStatus(stdout);
  // A completed login means the pending `tmeet auth login` has done its job; stop it so the user
  // is not left with a stray process.
  if (status.logged_in) _stopPendingLogin();
  return status;
}

/** Never let a login child outlive the adapter — an orphaned `tmeet auth login` could re-open a
 *  browser after the connector page is gone. */
process.on('exit', () => { _stopPendingLogin(); });
process.on('SIGTERM', () => { _stopPendingLogin(); process.exit(0); });
process.on('SIGINT', () => { _stopPendingLogin(); process.exit(0); });

// ── Time handling ─────────────────────────────────────────────────────

const _OFFSET_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** Reject a local-time string up front: the CLI's own `--start format error` gives no hint. */
function _requireOffsetIso(value, label) {
  const s = String(value);
  if (!_OFFSET_ISO_RE.test(s)) {
    throw new Error(
      `${label} must be ISO 8601 with a UTC offset (e.g. "2026-03-12T14:00+08:00"); got "${s}". ` +
      'A bare local time is rejected by the Tencent Meeting CLI.',
    );
  }
  return s;
}

// ── Record shape helpers ──────────────────────────────────────────────

/**
 * Row-carrier keys, verified against real tmeet v1.0.18 responses:
 *   `tmeet record list`                  → data.record_meetings[]
 *   `tmeet record transcript-get`        → data.minutes.paragraphs[]
 *   `tmeet record transcript-paragraphs` → data.pids[]
 *   `tmeet minutes get` / `minutes search` → data.minutes[]   (an ARRAY here, an OBJECT for transcript-get)
 * `data` is in the list purely as a descent step (it is an object, never returned as rows).
 * The generic tail keeps an older/newer envelope from silently yielding zero rows.
 */
const _LIST_KEYS = [
  'record_meetings', 'pids', 'minutes',
  'records', 'record_list', 'recordings',
  'paragraphs', 'items', 'list', 'data',
];

/** Pull the row array out of whichever carrier the current CLI version used. */
function _rows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of _LIST_KEYS) {
    const v = payload[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const nested = _rows(v);
      if (nested.length) return nested;
    }
  }
  return [];
}

/** `data` holds the real fields; the page token lives inside it, not at the envelope top level. */
function _data(payload) {
  return payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'
    ? payload.data
    : (payload || {});
}

function _field(row, ...names) {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Pagination cursor: real key is `data.next_page_token`; `data.more`/`data.has_more` flag the end. */
function _pagination(payload) {
  const d = _data(payload);
  return {
    next_page_token: _field(d, 'next_page_token', 'page_token'),
    has_more: _field(d, 'has_more', 'more'),
    total_page: _field(d, 'total_page'),
  };
}

/**
 * `record_type` is the platform's own discriminator: `云录制` (media) vs `文字转写` (transcript).
 * VERIFIED against real data — but so is the fact that a `云录制` record's `record_file_id` can
 * ALSO return transcript content, so this must not be used to hard-reject a record.
 */
function _isTranscriptRecord(row) {
  const type = String(_field(row, 'record_type', 'recordType') || '');
  return type.includes('文字转写') || type.includes('转写');
}

/**
 * A record row carries `record_files[]` (0..n). `record_file_id` does NOT exist at row level, and
 * `record_files` is legitimately EMPTY for some records (e.g. a 转写 record with no file yet) — such
 * a record cannot drive any transcript call, so surface that explicitly instead of returning null.
 */
function _normalizeRecord(row) {
  const files = Array.isArray(row.record_files) ? row.record_files : [];
  return {
    meeting_record_id: _field(row, 'meeting_record_id'),
    record_type: _field(row, 'record_type'),
    record_file_ids: files.map((f) => _field(f, 'record_file_id')).filter(Boolean),
    record_files: files.map((f) => ({
      record_file_id: _field(f, 'record_file_id'),
      record_start_time: _field(f, 'record_start_time'),
      record_end_time: _field(f, 'record_end_time'),
      record_size: _field(f, 'record_size'),
      sharing_url: _field(f, 'sharing_url'),
    })),
    usable_for_transcript: files.length > 0,
    meeting_id: _field(row, 'meeting_id'),
    meeting_code: _field(row, 'meeting_code'),
    subject: _field(row, 'subject'),
    // The row-level clock is `media_start_time`; per-file start/end live inside record_files.
    media_start_time: _field(row, 'media_start_time'),
    state: _field(row, 'state'),
    state_int: _field(row, 'state_int'),
    host_user_id: _field(row, 'host_user_id'),
  };
}

// ── Tool dispatch ─────────────────────────────────────────────────────

async function callTool(name, args = {}) {
  if (name === 'start_login') {
    const authorization_url = await startLogin();
    return {
      authorization_url,
      started_at: Date.now(),
      note: 'The host is expected to open this URL. Poll check_login until logged_in is true.',
    };
  }
  if (name === 'check_login') {
    return await checkLogin();
  }
  if (name === 'stop_login') {
    return { cancelled: _stopPendingLogin() };
  }
  if (name === 'list_recordings') {
    const hasRange = args.start || args.end;
    if (hasRange && !(args.start && args.end)) {
      throw new Error('start and end must be supplied together (or use meeting_id / meeting_code instead).');
    }
    if (!hasRange && !args.meeting_id && !args.meeting_code) {
      throw new Error('Provide one of: start + end, meeting_id, or meeting_code.');
    }
    let pageSize;
    if (args.page_size !== undefined) {
      const n = Number(args.page_size);
      if (!Number.isFinite(n) || n < 1) throw new Error('page_size must be a positive number.');
      pageSize = Math.min(Math.floor(n), MAX_PAGE_SIZE);
    }
    const payload = await tmeet(
      'record', 'list',
      ..._opt('--start', args.start && _requireOffsetIso(args.start, 'start')),
      ..._opt('--end', args.end && _requireOffsetIso(args.end, 'end')),
      ..._opt('--meeting-id', args.meeting_id),
      ..._opt('--meeting-code', args.meeting_code),
      ..._opt('--page-size', pageSize),
      ..._opt('--page-token', args.page_token),
    );
    const rows = _rows(payload);
    const all = rows.map(_normalizeRecord);
    // Records whose `record_files` is empty cannot drive any transcript call — `usable_for_transcript`
    // marks them so the model stops retrying a dead id.
    const transcripts = all.filter((r) => _isTranscriptRecord(r) && r.usable_for_transcript);
    return {
      records: all,
      // Preference order only — a `云录制` record's file id CAN also yield transcript content
      // (verified), so this is a hint, not a gate.
      preferred_transcript_records: transcripts,
      unusable_records: all.filter((r) => !r.usable_for_transcript).map((r) => r.meeting_record_id),
      recordCount: all.length,
      ..._pagination(payload),
      raw: payload,
    };
  }

  if (name === 'get_transcript') {
    const id = _requireArg(args, 'record_file_id');
    const payload = await tmeet(
      'record', 'transcript-get',
      '--record-file-id', id,
      ..._opt('--pid', args.pid),
      ..._opt('--limit', args.limit),
    );
    if (payload && payload.message && payload.message !== 'success' && !_data(payload).minutes) {
      throw new Error(`Tencent Meeting returned no transcript for record_file_id ${id}: ${payload.message}`);
    }
    const paragraphs = _transcriptParagraphs(payload);
    const text = _transcriptText(paragraphs);
    return {
      record_file_id: id,
      paragraphCount: paragraphs.length,
      // Structured first: speaker_id / relative timestamps are what the correction + attribution
      // pipeline needs. `text` is the same content flattened for convenience.
      paragraphs,
      text: text.length > MAX_TRANSCRIPT_CHARS ? text.slice(0, MAX_TRANSCRIPT_CHARS) : text,
      truncated: text.length > MAX_TRANSCRIPT_CHARS,
      charCount: text.length,
      keywords: (_data(payload).minutes && _data(payload).minutes.keywords) || [],
      more: _data(payload).more,
      timestamps_are_relative: true,
      raw: payload,
    };
  }

  if (name === 'get_transcript_paragraphs') {
    const id = _requireArg(args, 'record_file_id');
    const payload = await tmeet('record', 'transcript-paragraphs', '--record-file-id', id);
    const rows = _rows(payload);
    return {
      record_file_id: id,
      audio_detect: _data(payload).audio_detect,
      paragraphCount: rows.length,
      paragraphs: rows.map((r) => ({
        pid: _field(r, 'pid'),
        start_time: _field(r, 'start_time'),
        end_time: _field(r, 'end_time'),
      })),
      raw: payload,
    };
  }

  if (name === 'search_transcript') {
    const id = _requireArg(args, 'record_file_id');
    const text = _requireArg(args, 'text');
    const payload = await tmeet('record', 'transcript-search', '--record-file-id', id, '--text', text);
    const rows = _rows(payload);
    return { record_file_id: id, text, matchCount: rows.length, matches: rows, raw: payload };
  }

  if (name === 'preview_record_permission') {
    const id = _requireArg(args, 'meeting_record_id');
    const payload = await tmeet('record', 'permission-apply-prepare', '--meeting-record-id', id);
    return {
      meeting_record_id: id,
      // No `commit` path is exposed: applying is a write action the user performs themselves.
      note: 'Preview only. Submitting a recording-permission application is a write action and is not available through this connector.',
      preview: payload,
    };
  }

  if (name === 'get_meeting_minutes') {
    const minuteId = args.minute_id ? String(args.minute_id) : '';
    if (!minuteId && !args.meeting_id && !args.meeting_code) {
      throw new Error('Provide one of: minute_id, meeting_id, or meeting_code.');
    }
    if (args.short_summary && !minuteId) {
      throw new Error('short_summary requires minute_id (the transient summary is per-occurrence).');
    }
    // Page-size ceiling differs by mode: transient (minute_id) allows 300, stable allows 30.
    const cap = minuteId ? MAX_MINUTES_PAGE_TRANSIENT : MAX_MINUTES_PAGE_STABLE;
    let pageSize;
    if (args.page_size !== undefined) {
      const n = Number(args.page_size);
      if (!Number.isFinite(n) || n < 1) throw new Error('page_size must be a positive number.');
      pageSize = Math.min(Math.floor(n), cap);
    }
    const payload = await tmeet(
      'minutes', 'get',
      ..._opt('--minute-id', minuteId),
      ..._opt('--meeting-id', args.meeting_id),
      ..._opt('--meeting-code', args.meeting_code),
      ..._opt('--sub-meeting-id', args.sub_meeting_id),
      ...(args.short_summary ? ['--short-summary'] : []),
      ..._opt('--page-size', pageSize),
      ..._opt('--page-token', args.page_token),
    );
    const d = _data(payload);
    const rows = _rows(payload);
    return {
      subject: _field(d, 'subject'),
      minuteCount: rows.length,
      minutes: rows.map((m) => ({
        minute_id: _field(m, 'minute_id'),
        created_at: _field(m, 'created_at'),
        overview: _field(m, 'overview'),
        // Markdown. Platform-generated: reuse it only where the product has decided to.
        summary_points: _field(m, 'summary_points'),
        // Present in the schema but EMPTY for real meetings that plainly had action items —
        // surface it, and let the caller decide rather than trusting it as a complete list.
        todos: Array.isArray(m.todos) ? m.todos : [],
      })),
      ..._pagination(payload),
      raw: payload,
    };
  }

  if (name === 'search_meeting_minutes') {
    const query = _requireArg(args, 'query');
    if (query.length > MAX_QUERY_CHARS) {
      throw new Error(`query must be at most ${MAX_QUERY_CHARS} characters (got ${query.length}).`);
    }
    let pageSize;
    if (args.page_size !== undefined) {
      const n = Number(args.page_size);
      if (!Number.isFinite(n) || n < 1) throw new Error('page_size must be a positive number.');
      pageSize = Math.min(Math.floor(n), MAX_MINUTES_SEARCH_PAGE);
    }
    const payload = await tmeet(
      'minutes', 'search',
      '--query', query,
      ..._opt('--start', args.start && _requireOffsetIso(args.start, 'start')),
      ..._opt('--end', args.end && _requireOffsetIso(args.end, 'end')),
      ..._opt('--page-size', pageSize),
      ..._opt('--page-token', args.page_token),
    );
    const d = _data(payload);
    const rows = _rows(payload);
    return {
      query,
      matchCount: rows.length,
      total_count: _field(d, 'total_count'),
      matches: rows.map((m) => ({
        meeting_id: _field(m, 'meeting_id'),
        minute_id: _field(m, 'minute_id'),
        minute_start_time: _field(m, 'minute_start_time'),
        subject: _field(m, 'subject'),
        // `q_fields` says which field matched — currently SUMMARY_POINTS.
        matched_fields: Array.isArray(m.q_fields) ? m.q_fields : [],
        snippets: (Array.isArray(m.snippets) ? m.snippets : []).map((s) => ({
          source: _field(s, 'source'),
          text: _field(s, 'text'),
        })),
      })),
      ..._pagination(payload),
      raw: payload,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function _requireArg(args, key) {
  const v = args[key];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`${key} is required`);
  }
  return String(v);
}

/**
 * Transcript payload layout, VERIFIED against a real response:
 *
 *   data.minutes.paragraphs[] = {
 *     pid, start_time, end_time, lang,
 *     speaker: { user_id, user_name },                       // avatar_url dropped — not useful
 *     sentences: [ { sid, start_time, end_time, words: [ { wid, start_time, end_time, text } ] } ]
 *   }
 *   data.minutes.keywords[]  — platform-extracted keywords
 *   data.more                — pagination flag
 *
 * Text therefore lives THREE levels down (`paragraphs[].sentences[].words[].text`); a naive
 * "look for a `text` field" reader returns nothing. Timestamps are RELATIVE clocks (`02:45`) —
 * the same shape that already caused a real incident in this repo's transcript pipeline — so they
 * are passed through as-is and must not be presented as absolute meeting times.
 */
function _paragraphsOf(payload) {
  const d = _data(payload);
  const minutes = d.minutes && typeof d.minutes === 'object' ? d.minutes : null;
  const list = minutes && Array.isArray(minutes.paragraphs) ? minutes.paragraphs : _rows(payload);
  return Array.isArray(list) ? list : [];
}

function _paragraphText(p) {
  const sentences = Array.isArray(p.sentences) ? p.sentences : [];
  const pieces = [];
  for (const s of sentences) {
    if (typeof s === 'string') { pieces.push(s); continue; }
    const words = Array.isArray(s.words) ? s.words : null;
    if (words) {
      pieces.push(words.map((w) => (typeof w === 'string' ? w : String(_field(w, 'text') ?? ''))).join(''));
    } else {
      const t = _field(s, 'text', 'content');
      if (t) pieces.push(String(t));
    }
  }
  return pieces.join('');
}

function _transcriptParagraphs(payload) {
  return _paragraphsOf(payload).map((p) => {
    const sp = p.speaker && typeof p.speaker === 'object' ? p.speaker : {};
    return {
      pid: _field(p, 'pid'),
      start_time: _field(p, 'start_time'),
      end_time: _field(p, 'end_time'),
      // user_id is a STABLE identifier; user_name is only a display name, and the platform
      // sometimes reports a shared or room account as the speaker, so downstream attribution
      // should key on user_id rather than the name.
      speaker_id: _field(sp, 'user_id'),
      speaker_name: _field(sp, 'user_name'),
      text: _paragraphText(p),
    };
  });
}

/** Flat transcript: one line per paragraph, speaker-prefixed so a reader can attribute quotes. */
function _transcriptText(paragraphs) {
  return paragraphs
    .map((p) => {
      const who = p.speaker_name ? `${p.speaker_name}: ` : '';
      const at = p.start_time ? `[${p.start_time}] ` : '';
      return `${at}${who}${p.text}`;
    })
    .filter((line) => line.trim())
    .join('\n');
}

// ── MCP server wiring ─────────────────────────────────────────────────

async function main() {
  const server = new Server({ name: 'tencent-meeting-cli', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await callTool(name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = {
  TOOLS,
  callTool,
  tmeetBin,
  _setExecForTest,
  _resetBinForTest,
  // Pure candidate ordering — asserted directly so the "absolute before PATH" contract cannot
  // regress on a machine that happens to have the CLI only on PATH.
  _pickBin,
  // Authorization seams — tests must never spawn a real CLI or a real login process.
  _setTextExecForTest,
  _setSpawnForTest,
  _parseAuthStatus,
  _stopPendingLogin,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`tencent-meeting-mcp-server fatal: ${(err && err.message) || err}\n`);
    process.exit(1);
  });
}
