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
// 2. ONE MEETING, TWO RECORDS. A meeting yields a `云录制` (audio/video) record and a
//    `文字转写` (transcript) record. Transcript commands only work with the `文字转写` one's
//    `record_file_id`; passing the `云录制` id fails. `list_recordings` splits them out.
//
// ── Time format ──────────────────────────────────────────────────────────────
// `record list` takes ISO 8601 *with an offset* (`--start 2026-03-12T14:00+08:00`). A bare local
// time is rejected by the CLI with `--start format error`, which is a confusing dead end for the
// model, so `_requireOffsetIso` fails fast with a message that says what to add.

const { execFile } = require('node:child_process');
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

/** First candidate that is either an absolute executable or a bare name we let PATH resolve. */
function tmeetBin() {
  // An explicit override is used verbatim — never silently swapped for another binary, so an
  // ENOENT names the path the user actually configured.
  if (process.env.COGSEED_TMEET_BIN) return process.env.COGSEED_TMEET_BIN;
  const cached = _RESOLVED.get('bin');
  if (cached) return cached;
  let chosen = 'tmeet';
  for (const c of _candidates()) {
    if (!c.includes('/') && !c.includes('\\')) { chosen = c; break; }
    try {
      fs.accessSync(c, fs.constants.X_OK);
      chosen = c;
      break;
    } catch { /* keep probing */ }
  }
  _RESOLVED.set('bin', chosen);
  return chosen;
}

function _resetBinForTest() {
  _RESOLVED.delete('bin');
}

const EXEC_TIMEOUT_MS = Number(process.env.COGSEED_TMEET_TIMEOUT_MS || 60000);
/** `record list` caps page size at 30 server-side; keep it honest instead of letting the CLI clamp. */
const MAX_PAGE_SIZE = 30;
/** Transcript text is the one legitimately large payload here. Keep a single call bounded. */
const MAX_TRANSCRIPT_CHARS = 200000;

// ── Tool definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_recordings',
    description:
      'List Tencent Meeting recording records the signed-in account can read. Each meeting usually ' +
      'returns two records: a `云录制` (audio/video) record and a `文字转写` (transcript) record. ' +
      'ONLY the `文字转写` record\'s record_file_id works with the transcript tools — use the ' +
      '`transcript_records` array this tool returns, not `records`. Supply one of: start+end, ' +
      'meeting_id, or meeting_code.',
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
      'Get the full transcript of one recording. Needs the `文字转写` record\'s record_file_id from ' +
      'list_recordings. Large transcripts are paginated: pass `pid` and `limit` from a previous ' +
      'response to continue. Returned text is the source transcript — it is NOT corrected, and any ' +
      'speaker/timestamp fields present are only what the platform actually provides.',
    inputSchema: {
      type: 'object',
      properties: {
        record_file_id: { type: 'string', description: 'The `文字转写` record file id from list_recordings. Required.' },
        pid: { type: 'string', description: 'Start paragraph id for pagination (string, per the CLI).' },
        limit: { type: 'string', description: 'Number of paragraphs to fetch (string, per the CLI).' },
      },
      required: ['record_file_id'],
    },
  },
  {
    name: 'get_transcript_paragraphs',
    description:
      'List the paragraph ids of a transcript so a long transcript can be walked page by page with ' +
      'get_transcript. Needs the `文字转写` record\'s record_file_id.',
    inputSchema: {
      type: 'object',
      properties: {
        record_file_id: { type: 'string', description: 'The `文字转写` record file id. Required.' },
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
    execFile(bin, [...args, '--format', 'json'], { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
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
 * The CLI's JSON envelope keys are INFERRED, not verified: this adapter was written without an
 * authenticated Tencent Meeting account, so no real response could be captured. Accept every
 * plausible carrier rather than betting on one — and re-check this list against a real
 * `tmeet record list` / `transcript-get` response before trusting the field mapping.
 */
const _LIST_KEYS = [
  'records', 'record_list', 'recording_list', 'recordings',
  'paragraphs', 'paragraph_list', 'sentences',
  'items', 'list', 'data',
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

function _field(row, ...names) {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** `record_type` is the field the platform uses: `云录制` (media) vs `文字转写` (transcript). */
function _isTranscriptRecord(row) {
  const type = String(_field(row, 'record_type', 'recordType', 'type_name') || '');
  if (type) return type.includes('文字转写') || type.includes('转写');
  // Fallback: transcript records are the ones transcript commands accept.
  return Boolean(_field(row, 'record_file_id', 'recordFileId'));
}

function _normalizeRecord(row) {
  return {
    meeting_record_id: _field(row, 'meeting_record_id', 'meetingRecordId', 'record_id'),
    record_file_id: _field(row, 'record_file_id', 'recordFileId'),
    record_type: _field(row, 'record_type', 'recordType'),
    meeting_id: _field(row, 'meeting_id', 'meetingId'),
    meeting_code: _field(row, 'meeting_code', 'meetingCode'),
    subject: _field(row, 'subject', 'meeting_subject', 'title'),
    start_time: _field(row, 'start_time', 'startTime', 'meeting_start_time'),
    end_time: _field(row, 'end_time', 'endTime', 'meeting_end_time'),
  };
}

// ── Tool dispatch ─────────────────────────────────────────────────────

async function callTool(name, args = {}) {
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
    const transcripts = all.filter((r) => _isTranscriptRecord(r) && r.record_file_id);
    return {
      // `records` keeps every record; `transcript_records` is the only subset the transcript
      // tools accept — the split exists so the model stops passing a 云录制 id to them.
      records: all,
      transcript_records: transcripts,
      recordCount: all.length,
      transcriptRecordCount: transcripts.length,
      page_token: _field(payload, 'page_token', 'pageToken', 'next_page_token'),
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
    const text = _transcriptText(payload);
    return {
      record_file_id: id,
      text: text.length > MAX_TRANSCRIPT_CHARS ? text.slice(0, MAX_TRANSCRIPT_CHARS) : text,
      truncated: text.length > MAX_TRANSCRIPT_CHARS,
      charCount: text.length,
      pid: _field(payload, 'pid', 'paragraph_id'),
      raw: payload,
    };
  }

  if (name === 'get_transcript_paragraphs') {
    const id = _requireArg(args, 'record_file_id');
    const payload = await tmeet('record', 'transcript-paragraphs', '--record-file-id', id);
    const rows = _rows(payload);
    return { record_file_id: id, paragraphCount: rows.length, paragraphs: rows, raw: payload };
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

  throw new Error(`Unknown tool: ${name}`);
}

function _requireArg(args, key) {
  const v = args[key];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`${key} is required`);
  }
  return String(v);
}

/** Transcript payloads are either a plain string or an object holding a list of paragraphs. */
function _transcriptText(payload) {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return '';
  for (const key of ['transcript', 'text', 'content', 'full_text']) {
    const v = payload[key];
    if (typeof v === 'string' && v) return v;
  }
  const rows = _rows(payload);
  if (rows.length) {
    return rows
      .map((r) => (typeof r === 'string' ? r : _field(r, 'text', 'content', 'sentence', 'paragraph') || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
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

module.exports = { TOOLS, callTool, tmeetBin, _setExecForTest, _resetBinForTest };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`tencent-meeting-mcp-server fatal: ${(err && err.message) || err}\n`);
    process.exit(1);
  });
}
