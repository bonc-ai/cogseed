import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

const requireCjs = createRequire(import.meta.url);

// Resolve from THIS file, never `process.cwd()`: another suite sharing the worker may chdir, which
// makes cwd-relative paths pass in isolation and fail only in a full run.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

/** Real tmeet v1.0.18 responses, captured from a live account and sanitized (trace_id stripped). */
function fixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
}

type AuthSession = {
  logged_in: boolean;
  user_name: string;
  access_token: { present: boolean; valid: boolean; expires_at: string; remaining: string };
  refresh_token: { present: boolean; valid: boolean; expires_at: string; remaining: string };
};

type Adapter = {
  TOOLS: Array<{ name: string; description: string; inputSchema: { required?: string[] } }>;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;
  tmeetBin: () => string;
  _setExecForTest: (fn: ((args: string[]) => Promise<unknown>) | null) => void;
  _resetBinForTest: () => void;
  _setTextExecForTest: (fn: ((args: string[]) => Promise<unknown>) | null) => void;
  _setSpawnForTest: (fn: ((bin: string, args: string[], opts: unknown) => unknown) | null) => void;
  _parseAuthStatus: (text: string) => AuthSession;
  _stopPendingLogin: () => boolean;
};

function loadAdapter(): Adapter {
  const full = path.join(REPO_ROOT, 'bin', 'tencent-meeting-mcp-server.cjs');
  delete requireCjs.cache[full];
  current = requireCjs(full) as Adapter;
  return current;
}

/**
 * Stub the `tmeet` subprocess and return the SAME module instance the stub was installed on.
 * Calling `loadAdapter()` separately would clear the require cache and silently reset `_execImpl`,
 * letting a real CLI run — which is exactly the bug this helper exists to prevent.
 */
function stubTmeet(impl: (args: string[]) => unknown): { adapter: Adapter; calls: string[][] } {
  const adapter = loadAdapter();
  const calls: string[][] = [];
  adapter._setExecForTest(async (args: string[]) => {
    calls.push(args);
    return impl(args);
  });
  return { adapter, calls };
}

let current: Adapter | null = null;

afterEach(() => {
  delete process.env.COGSEED_TMEET_BIN;
  current?._resetBinForTest();
  current = null;
  vi.unstubAllGlobals();
});

describe('Tencent Meeting stdio CLI adapter', () => {
  it('exposes the read-only meeting tools plus the three auth-session tools, without starting the stdio server', () => {
    const adapter = loadAdapter();
    expect(adapter.TOOLS.map((t) => t.name).sort()).toEqual([
      'check_login',
      'get_meeting_minutes',
      'get_transcript',
      'get_transcript_paragraphs',
      'list_recordings',
      'preview_record_permission',
      'search_meeting_minutes',
      'search_transcript',
      'start_login',
      'stop_login',
    ]);
    expect(typeof adapter.callTool).toBe('function');
  });

  it('separates the auth-session tools from the meeting tools and ships no logout', () => {
    const adapter = loadAdapter();
    const names = adapter.TOOLS.map((t) => t.name);
    // These three drive `tmeet auth login` so the connector page can authorize without adding a
    // third CLI-spawn site to main. They are not meeting-data tools and the model must never be
    // handed them, so the description of each has to say what it is for.
    for (const name of ['start_login', 'check_login', 'stop_login']) {
      expect(names).toContain(name);
    }
    expect(adapter.TOOLS.find((t) => t.name === 'start_login')!.description).toMatch(/authorization URL/i);
    expect(adapter.TOOLS.find((t) => t.name === 'check_login')!.description).toMatch(/never token values/i);
    // Deliberately absent: signing out is a machine-wide side effect (the CLI session is shared by
    // every profile on this device), so disconnecting a connector must never trigger it.
    expect(names.filter((n) => /logout|sign_out|signout/i.test(n))).toEqual([]);
  });

  it('exposes NO write tool — no create/update/cancel/commit path can reach the CLI', () => {
    const adapter = loadAdapter();
    // COGSEED-314.4 is 只读接入适配. Tencent's docs require a self-built agent to implement write
    // confirmation itself; shipping no write tool satisfies that by construction, and keeps the
    // (agent, connector)-scoped bridge always-allow grant from silently covering a mutation.
    // The auth-session tools are the one non-read-only surface; they were named to stay clear of
    // this guard on purpose (`stop_login`, not `cancel_login`) so the guard keeps meaning
    // "no meeting mutation is reachable" rather than being widened for them.
    const WRITE_VERBS = /create|update|cancel|commit|delete|remove|replace|add|invite|control/i;
    for (const t of adapter.TOOLS) {
      expect(t.name).not.toMatch(WRITE_VERBS);
      // The one near-miss: permission application is preview-only, and the description must say so.
      if (t.name === 'preview_record_permission') {
        expect(t.description).toMatch(/preview/i);
        expect(t.description).toMatch(/NOT exposed|not available|NOT submitted/i);
      }
    }
  });

  it('reads the real data.record_meetings carrier and flags records with no record_files', async () => {
    // Real envelope: rows live at data.record_meetings, and `record_file_id` is nested inside
    // record_files[] — a row-level read returns undefined.
    const { adapter, calls } = stubTmeet(() => ({
      trace_id: 'x',
      message: 'success',
      data: {
        current_page: 1, current_size: 3, has_more: true, next_page_token: 'tok-2', total_page: 2,
        record_meetings: [
          { meeting_record_id: 'r1', record_type: '云录制', subject: 'A',
            record_files: [{ record_file_id: 'f1', record_start_time: '2030-08-18T13:58:36+08:00' }] },
          { meeting_record_id: 'r2', record_type: '文字转写', subject: '转写_A',
            record_files: [{ record_file_id: 'f2' }] },
          { meeting_record_id: 'r3', record_type: '文字转写', subject: '转写_B', record_files: [] },
        ],
      },
    }));

    const res = await adapter.callTool('list_recordings', {
      start: '2026-08-01T00:00+08:00', end: '2026-08-20T00:00+08:00',
    });

    expect(res.recordCount).toBe(3);
    expect(res.records[0].record_file_ids).toEqual(['f1']);
    // record_files is legitimately empty for some records — those cannot drive a transcript call.
    expect(res.records[2].usable_for_transcript).toBe(false);
    expect(res.unusable_records).toEqual(['r3']);
    // Preference hint only: a 云录制 file id can also yield transcript content (verified against a
    // live account), so the 文字转写 subset must not be treated as the only valid input.
    expect(res.preferred_transcript_records.map((r: any) => r.meeting_record_id)).toEqual(['r2']);
    // Pagination cursor lives at data.*, not on the envelope top level.
    expect(res.next_page_token).toBe('tok-2');
    expect(res.has_more).toBe(true);
    expect(calls[0]).toEqual([
      'record', 'list', '--start', '2026-08-01T00:00+08:00', '--end', '2026-08-20T00:00+08:00',
    ]);
  });

  it('maps a real captured record-list fixture without losing rows', async () => {
    const payload = fixture('tencent-record-list.json');
    const { adapter } = stubTmeet(() => payload);
    const res = await adapter.callTool('list_recordings', { meeting_id: '1' });
    expect(res.recordCount).toBe(payload.data.record_meetings.length);
    expect(res.records[0]).toHaveProperty('record_file_ids');
    expect(res.records[0]).toHaveProperty('media_start_time');
  });

  it('rejects a bare local time with an actionable message instead of the CLI format error', async () => {
    const { adapter } = stubTmeet(() => ({ records: [] }));

    await expect(
      adapter.callTool('list_recordings', { start: '2026-03-12T14:00', end: '2026-03-12T15:00+08:00' }),
    ).rejects.toThrow(/ISO 8601 with a UTC offset/);
  });

  it('requires a complete selector: start needs end, and meeting_id/meeting_code are alternatives', async () => {
    const { adapter } = stubTmeet(() => ({ records: [] }));

    await expect(adapter.callTool('list_recordings', { start: '2026-03-12T14:00+08:00' }))
      .rejects.toThrow(/start and end must be supplied together/);
    await expect(adapter.callTool('list_recordings', {}))
      .rejects.toThrow(/Provide one of: start \+ end, meeting_id, or meeting_code/);
  });

  it('clamps page_size to the server-side maximum of 30', async () => {
    const { adapter, calls } = stubTmeet(() => ({ records: [] }));

    await adapter.callTool('list_recordings', { meeting_id: '6953553464429888300', page_size: 500 });
    expect(calls[0]).toContain('30');
    await expect(adapter.callTool('list_recordings', { meeting_id: '1', page_size: 0 }))
      .rejects.toThrow(/page_size must be a positive number/);
  });

  it('extracts speaker + 3-level nested text from the real transcript shape', async () => {
    // Verified layout: data.minutes.paragraphs[].sentences[].words[].text, speaker per paragraph.
    const { adapter, calls } = stubTmeet(() => ({
      trace_id: 'x', message: 'success',
      data: {
        code: 0, more: false,
        minutes: {
          audio_detect: 1, lang: 'zh', keywords: ['全局共享记忆', '沉淀'],
          paragraphs: [
            { pid: '0', start_time: '00:01', end_time: '00:10', lang: 'zh',
              speaker: { user_id: '1000000000000000001', user_name: '发言人甲', avatar_url: 'https://x' },
              sentences: [{ sid: '0', start_time: '00:01', end_time: '00:10',
                words: [{ wid: '0', start_time: '00:01', end_time: '00:10', text: '（示例发言甲）' }] }] },
            { pid: '1', start_time: '00:12', end_time: '00:36', lang: 'zh',
              speaker: { user_id: '1000000000000000002', user_name: '发言人乙' },
              sentences: [
                { sid: '1', words: [{ wid: '1', text: '第一部分。' }] },
                { sid: '2', words: [{ wid: '2', text: '第二部分。' }] },
              ] },
          ],
        },
      },
    }));

    const res = await adapter.callTool('get_transcript', { record_file_id: 'f2', pid: '100', limit: '50' });

    expect(calls[0]).toEqual([
      'record', 'transcript-get', '--record-file-id', 'f2', '--pid', '100', '--limit', '50',
    ]);
    expect(res.paragraphCount).toBe(2);
    // user_id is the stable key; user_name is display-only (sometimes a shared/room account).
    expect(res.paragraphs[0]).toMatchObject({
      pid: '0', speaker_id: '1000000000000000001', speaker_name: '发言人甲', text: '（示例发言甲）',
    });
    // Multiple sentences concatenate into one paragraph.
    expect(res.paragraphs[1].text).toBe('第一部分。第二部分。');
    // avatar_url is dropped, keywords survive, relative-clock caveat is surfaced.
    expect(JSON.stringify(res.paragraphs[0])).not.toContain('avatar_url');
    expect(res.keywords).toEqual(['全局共享记忆', '沉淀']);
    expect(res.timestamps_are_relative).toBe(true);
    expect(res.text.split('\n')[0]).toBe('[00:01] 发言人甲: （示例发言甲）');
  });

  it('maps a real captured transcript fixture', async () => {
    const payload = fixture('tencent-transcript.json');
    const { adapter } = stubTmeet(() => payload);
    const res = await adapter.callTool('get_transcript', { record_file_id: 'f3' });
    expect(res.paragraphCount).toBe(payload.data.minutes.paragraphs.length);
    expect(res.charCount).toBeGreaterThan(0);
    expect(res.paragraphs[0].speaker_name).toBeTruthy();
  });

  it('requires record_file_id for every transcript tool, and text for search', async () => {
    const { adapter } = stubTmeet(() => ({}));

    await expect(adapter.callTool('get_transcript', {})).rejects.toThrow(/record_file_id is required/);
    await expect(adapter.callTool('get_transcript_paragraphs', {})).rejects.toThrow(/record_file_id is required/);
    await expect(adapter.callTool('search_transcript', { record_file_id: '5002' })).rejects.toThrow(/text is required/);
  });

  it('stops a runaway transcript at the char cap and flags the truncation', async () => {
    const huge = 'x'.repeat(250000);
    const { adapter } = stubTmeet(() => ({
      message: 'success',
      data: { minutes: { paragraphs: [{ pid: '0', sentences: [{ words: [{ text: huge }] }] }] } },
    }));

    const res = await adapter.callTool('get_transcript', { record_file_id: 'f4' });
    expect(res.truncated).toBe(true);
    expect(res.charCount).toBe(250000);
    expect(res.text.length).toBe(200000);
  });

  it('turns an empty-transcript response into a clear error instead of empty text', async () => {
    // Real failure mode: error_code 30002 "纪要无内容" for a record whose transcript never generated.
    const { adapter } = stubTmeet(() => ({ message: '纪要无内容', data: { code: 30002 } }));
    await expect(adapter.callTool('get_transcript', { record_file_id: 'f5' }))
      .rejects.toThrow(/no transcript for record_file_id f5/);
  });

  it('get_meeting_minutes reaches the channel that works without a cloud recording', async () => {
    // A real meeting was observed with `records_total_count: 0` while still exposing three
    // `minutes`, so the summary channel is the only way into those meetings — it must not require
    // a record id.
    const { adapter, calls } = stubTmeet(() => ({
      trace_id: 'x', message: 'success',
      data: { has_more: false, meeting_id: '', minute_id: 'mid-1', subject: '示例会议 A',
        minutes: [{ created_at: '2030-09-20T17:13:19+08:00', minute_id: 'mid-1',
          overview: '', summary_points: '小结\n- 示例纪要要点', todos: [] }] },
    }));

    const res = await adapter.callTool('get_meeting_minutes', { minute_id: 'mid-1' });

    expect(calls[0]).toEqual(['minutes', 'get', '--minute-id', 'mid-1']);
    expect(res.subject).toBe('示例会议 A');
    expect(res.minuteCount).toBe(1);
    expect(res.minutes[0].summary_points).toContain('示例纪要要点');
    // Platform todos are frequently empty even for meetings that plainly had action items; the
    // field is surfaced as-is rather than papered over.
    expect(res.minutes[0].todos).toEqual([]);
  });

  it('get_meeting_minutes requires a selector and applies the transient/stable page-size ceilings', async () => {
    const { adapter, calls } = stubTmeet(() => ({ message: 'success', data: { minutes: [] } }));

    await expect(adapter.callTool('get_meeting_minutes', {}))
      .rejects.toThrow(/Provide one of: minute_id, meeting_id, or meeting_code/);
    await expect(adapter.callTool('get_meeting_minutes', { meeting_id: '1', short_summary: true }))
      .rejects.toThrow(/short_summary requires minute_id/);

    // transient (minute_id) allows 300; stable (meeting_id) only 30
    await adapter.callTool('get_meeting_minutes', { minute_id: 'mid-1', page_size: 500 });
    expect(calls[0]).toContain('300');
    await adapter.callTool('get_meeting_minutes', { meeting_id: '42', page_size: 500 });
    expect(calls[1]).toContain('30');
    expect(calls[1]).toContain('--meeting-id');
  });

  it('maps the real captured minutes fixture', async () => {
    const payload = fixture('tencent-minutes-get.json');
    const { adapter } = stubTmeet(() => payload);
    const res = await adapter.callTool('get_meeting_minutes', { minute_id: 'mid-x' });
    expect(res.minuteCount).toBe(payload.data.minutes.length);
    expect(res.minutes[0]).toHaveProperty('summary_points');
    expect(Array.isArray(res.minutes[0].todos)).toBe(true);
  });

  it('search_meeting_minutes validates the query the way the API does', async () => {
    const { adapter, calls } = stubTmeet(() => ({
      message: 'success',
      data: { has_more: true, total_count: 7, next_page_token: 'tok-9',
        minutes: [{ meeting_id: '1000000000000000003', minute_id: 'mid-1',
          minute_start_time: '2030-09-21T11:46:28+08:00', subject: '例会',
          q_fields: ['SUMMARY_POINTS'],
          snippets: [{ source: 'SUMMARY_POINTS', text: '（示例检索片段，已脱敏）' }] }] },
    }));

    await expect(adapter.callTool('search_meeting_minutes', {})).rejects.toThrow(/query is required/);
    await expect(adapter.callTool('search_meeting_minutes', { query: 'x'.repeat(51) }))
      .rejects.toThrow(/at most 50 characters/);

    const res = await adapter.callTool('search_meeting_minutes', { query: '示例关键词', page_size: 999 });
    expect(calls[0]).toEqual(['minutes', 'search', '--query', '示例关键词', '--page-size', '50']);
    expect(res.total_count).toBe(7);
    expect(res.next_page_token).toBe('tok-9');
    expect(res.matches[0]).toMatchObject({ matched_fields: ['SUMMARY_POINTS'], minute_id: 'mid-1' });
    expect(res.matches[0].snippets[0].text).toContain('示例检索片段');
  });

  it('maps the real captured minutes-search fixture', async () => {
    const payload = fixture('tencent-minutes-search.json');
    const { adapter } = stubTmeet(() => payload);
    const res = await adapter.callTool('search_meeting_minutes', { query: '示例关键词' });
    expect(res.matchCount).toBe(payload.data.minutes.length);
    expect(res.matches[0].snippets.length).toBeGreaterThan(0);
  });

  it('preview_record_permission uses meeting_record_id and states that commit is unavailable', async () => {
    const { adapter, calls } = stubTmeet(() => ({ apply_required: true, reason: '录制权限归属会议创建者' }));

    const res = await adapter.callTool('preview_record_permission', { meeting_record_id: '7001' });
    expect(calls[0]).toEqual(['record', 'permission-apply-prepare', '--meeting-record-id', '7001']);
    expect(res.preview).toEqual({ apply_required: true, reason: '录制权限归属会议创建者' });
    expect(res.note).toMatch(/not available through this connector/i);

    await expect(adapter.callTool('preview_record_permission', { record_file_id: '5002' }))
      .rejects.toThrow(/meeting_record_id is required/);
  });

  it('surfaces a not-logged-in CLI failure with a connect hint', async () => {
    const adapter = loadAdapter();
    adapter._setExecForTest(async () => {
      throw new Error("tmeet record list failed: user config is empty (the Tencent Meeting account is not connected — the user must run `tmeet auth login` first)");
    });
    await expect(adapter.callTool('list_recordings', { meeting_id: '1' }))
      .rejects.toThrow(/tmeet auth login/);
  });

  it('rejects an unknown tool name', async () => {
    const { adapter } = stubTmeet(() => ({}));
    await expect(adapter.callTool('nope', {})).rejects.toThrow(/Unknown tool: nope/);
  });

  // ── Binary resolution ────────────────────────────────────────────────────
  // The SDK spawns this adapter with PATH from getDefaultEnvironment(); on macOS a
  // Finder-launched packaged app gets the minimal GUI PATH, which excludes Homebrew and
  // npm-global bin dirs. Resolution must therefore not depend on PATH alone.

  it('uses an explicit COGSEED_TMEET_BIN verbatim, so an error names the configured path', () => {
    const { adapter } = stubTmeet(() => ({}));
    process.env.COGSEED_TMEET_BIN = '/custom/place/tmeet';
    adapter._resetBinForTest();
    expect(adapter.tmeetBin()).toBe('/custom/place/tmeet');
  });

  it('falls back to an absolute global-install location when PATH alone would not find it', () => {
    const { adapter } = stubTmeet(() => ({}));
    adapter._resetBinForTest();
    const resolved = adapter.tmeetBin();
    // Either a bare name (PATH intact) or a probed absolute path — never empty, never a
    // nonexistent absolute candidate.
    expect(resolved.length).toBeGreaterThan(0);
    if (resolved.includes('/')) {
      expect(() => require('node:fs').accessSync(resolved, require('node:fs').constants.X_OK)).not.toThrow();
    }
  });

  it('turns a missing CLI into an install hint instead of a bare ENOENT', async () => {
    const { adapter } = stubTmeet(() => ({}));
    process.env.COGSEED_TMEET_BIN = '/definitely/not/here/tmeet';
    adapter._resetBinForTest();
    adapter._setExecForTest(null); // restore the real execFile so ENOENT actually happens
    await expect(adapter.callTool('list_recordings', { meeting_id: '1' }))
      .rejects.toThrow(/npm install -g @tencentcloud\/tmeet/);
  });
});

// ── Authorization session ──────────────────────────────────────────────
//
// `tmeet auth` ignores `--format json` and prints text, so `_parseAuthStatus` is the load-bearing
// piece: it must distinguish "signed out" from "CLI broken", and must never leak a token value.
// The fixtures below reproduce that shape with synthetic values: no real account name or OpenId.

const LOGGED_IN_TEXT = [
  'Logged in',
  '  OpenId:  cli_0123456789abcdef0123456789abcdef',
  '  UserName:  Example User',
  '  AccessToken:  valid (expires at 2030-01-01 00:00:00, remaining 1h 0m)',
  '  RefreshToken: valid (expires at 2030-02-01 00:00:00, remaining 30d 0h 0m)',
  '',
].join('\n');

const EXPIRED_TEXT = [
  'Logged in',
  '  OpenId:  cli_0123456789abcdef0123456789abcdef',
  '  UserName:  Example User',
  '  AccessToken:  invalid (expired at 2029-12-31 00:00:00)',
  '  RefreshToken: valid (expires at 2030-02-01 00:00:00, remaining 30d 0h 0m)',
  '',
].join('\n');

const LOGGED_OUT_TEXT = "Not logged in. Please use 'tmeet auth login' to log in.\n";

/** A fake `spawn` whose child lets the test drive stdout and exit timing. */
function fakeChild() {
  const listeners: Record<string, Array<(arg: unknown) => void>> = { data: [], error: [], exit: [] };
  const child = {
    killed: false,
    kill(signal: string) { this.killed = true; this.signals.push(signal); return true; },
    signals: [] as string[],
    stdout: { on: (ev: string, fn: (arg: unknown) => void) => { listeners[ev]?.push(fn); } },
    stderr: { on: (ev: string, fn: (arg: unknown) => void) => { listeners[ev]?.push(fn); } },
    on(ev: string, fn: (arg: unknown) => void) { listeners[ev]?.push(fn); },
    emit(ev: string, arg: unknown) { for (const fn of listeners[ev] || []) fn(arg); },
  };
  return child;
}

describe('Tencent Meeting adapter authorization session', () => {
  it('parses a signed-in status without exposing any token value', () => {
    const adapter = loadAdapter();
    const status = adapter._parseAuthStatus(LOGGED_IN_TEXT);
    expect(status).toMatchObject({ logged_in: true, user_name: 'Example User' });
    expect(status.access_token).toMatchObject({ present: true, valid: true, remaining: '1h 0m' });
    expect(status.refresh_token).toMatchObject({ present: true, valid: true, remaining: '30d 0h 0m' });
    // The returned shape IS the privacy boundary: this object crosses into main, so every field is
    // either a boolean, a display name, or a human-readable validity window. A field that could
    // carry a credential must not exist — and neither must the account's OpenId, which nothing
    // downstream displays.
    expect(Object.keys(status).sort()).toEqual([
      'access_token', 'logged_in', 'refresh_token', 'user_name',
    ]);
    for (const key of ['access_token', 'refresh_token'] as const) {
      expect(Object.keys(status[key]).sort()).toEqual(['expires_at', 'present', 'remaining', 'valid']);
    }
  });

  it('parses an expired access token as invalid but keeps the session signed in', () => {
    const adapter = loadAdapter();
    const status = adapter._parseAuthStatus(EXPIRED_TEXT);
    expect(status.logged_in).toBe(true);
    expect(status.access_token.valid).toBe(false);
    expect(status.refresh_token.valid).toBe(true);
  });

  it('treats a signed-out status as logged_in:false rather than an error', () => {
    const adapter = loadAdapter();
    const status = adapter._parseAuthStatus(LOGGED_OUT_TEXT);
    expect(status.logged_in).toBe(false);
    expect(status.user_name).toBe('');
    expect(status.access_token).toMatchObject({ present: false, valid: false });
  });

  it('keeps the auth-status fixtures synthetic, so no captured account value lands here', () => {
    // These fixtures are transcribed from `tmeet auth status`, which prints the signed-in account's
    // display name and OpenId. They once carried a real pair in this public repository, and the
    // published-repo audit could not tell them from ordinary text — it matches on key-shaped
    // secrets, not on a display name or a `cli_…` account id. So the guard has to live here: the
    // parser reads whatever the CLI prints, but the fixtures must never be a capture of a real
    // account again.
    for (const [name, text] of [['LOGGED_IN_TEXT', LOGGED_IN_TEXT], ['EXPIRED_TEXT', EXPIRED_TEXT]] as const) {
      expect(text.match(/OpenId:\s*(\S+)/)?.[1], name).toBe('cli_0123456789abcdef0123456789abcdef');
      expect(text.match(/UserName:\s*(.+)/)?.[1]?.trim(), name).toBe('Example User');
    }
  });

  it('start_login returns the authorization URL printed by --no-browser', async () => {
    const adapter = loadAdapter();
    const child = fakeChild();
    const spawned: Array<{ bin: string; args: string[] }> = [];
    adapter._setSpawnForTest((bin, args) => { spawned.push({ bin, args }); return child; });

    const pending = adapter.callTool('start_login');
    child.emit('data', 'Please open the following URL to authorize:\n');
    child.emit('data', 'https://meeting.tencent.com/ai-skill/authorize?code=abc123\n');
    const result = await pending;

    expect(result.authorization_url).toBe('https://meeting.tencent.com/ai-skill/authorize?code=abc123');
    // `--no-browser` is what makes the URL observable; without it the CLI opens the browser itself
    // and the host has nothing to fall back to when that fails.
    //
    // Assert the arguments the adapter asks the CLI to run, not the launch wrapper that carries
    // them. The wrapper is platform-specific: on Windows a `tmeet.cmd` shim has to travel through
    // ComSpec, so `args` is one escaped payload rather than the raw argv. Matching the raw argv
    // here would pass on macOS and fail on Windows for a reason unrelated to what is being tested.
    const invoked = spawned[0].args.join(' ');
    for (const part of ['auth', 'login', '--no-browser']) {
      expect(invoked).toContain(part);
    }
  });

  it('start_login strips trailing punctuation from a URL inside prose', async () => {
    const adapter = loadAdapter();
    const child = fakeChild();
    adapter._setSpawnForTest(() => child);
    const pending = adapter.callTool('start_login');
    child.emit('data', 'Open https://meeting.tencent.com/ai-skill/authorize?code=abc123)\n');
    const result = await pending;
    expect(result.authorization_url).toBe('https://meeting.tencent.com/ai-skill/authorize?code=abc123');
  });

  it('start_login rejects with the CLI output when the process exits without a URL', async () => {
    const adapter = loadAdapter();
    const child = fakeChild();
    adapter._setSpawnForTest(() => child);
    const pending = adapter.callTool('start_login');
    child.emit('exit', 3);
    await expect(pending).rejects.toThrow(/exited \(code 3\) without printing an authorization URL/);
  });

  it('explains the already-signed-in rejection instead of passing CLI jargon through', async () => {
    const adapter = loadAdapter();
    const child = fakeChild();
    adapter._setSpawnForTest(() => child);
    const pending = adapter.callTool('start_login');
    // Observed for real on tmeet 1.0.18: with a valid session, `auth login --no-browser` exits
    // non-zero with this exact stderr line and prints no URL. Callers check_login first, so hitting
    // it means a race or a caller bug — the message has to say which.
    child.emit('data', "Error: user has been login, please use 'tmeet cmd [flags]' to use\n");
    child.emit('exit', 1);
    await expect(pending).rejects.toThrow(/call check_login first instead of starting a login/);
  });

  it('start_login supersedes a previous pending attempt instead of leaking a second process', async () => {
    const adapter = loadAdapter();
    const first = fakeChild();
    const second = fakeChild();
    const children = [first, second];
    adapter._setSpawnForTest(() => children.shift()!);

    const firstPending = adapter.callTool('start_login');
    first.emit('data', 'https://meeting.tencent.com/ai-skill/authorize?code=first\n');
    await firstPending;

    const secondPending = adapter.callTool('start_login');
    second.emit('data', 'https://meeting.tencent.com/ai-skill/authorize?code=second\n');
    await secondPending;

    expect(first.killed).toBe(true);
    expect(second.killed).toBe(false);
  });

  it('check_login reports the session and stops the pending login once it succeeds', async () => {
    const adapter = loadAdapter();
    const child = fakeChild();
    adapter._setSpawnForTest(() => child);
    // Start a login first — `check_login` only has something to stop if one is pending.
    const pending = adapter.callTool('start_login');
    child.emit('data', 'https://meeting.tencent.com/ai-skill/authorize?code=abc123\n');
    await pending;

    adapter._setTextExecForTest(async (args: string[]) => {
      expect(args).toEqual(['auth', 'status']);
      return { stdout: LOGGED_IN_TEXT, stderr: '' };
    });
    const status = await adapter.callTool('check_login');

    expect(status.logged_in).toBe(true);
    expect(status.user_name).toBe('Example User');
    // A completed login must not leave `tmeet auth login` running.
    expect(child.killed).toBe(true);
  });

  it('check_login leaves a still-pending login alone while the user has not finished', async () => {
    const adapter = loadAdapter();
    const child = fakeChild();
    adapter._setSpawnForTest(() => child);
    const pending = adapter.callTool('start_login');
    child.emit('data', 'https://meeting.tencent.com/ai-skill/authorize?code=abc123\n');
    await pending;

    adapter._setTextExecForTest(async () => ({ stdout: LOGGED_OUT_TEXT, stderr: '' }));
    const status = await adapter.callTool('check_login');

    expect(status.logged_in).toBe(false);
    // The login process must survive the poll: it is waiting for the user in the browser.
    expect(child.killed).toBe(false);
    expect(adapter._stopPendingLogin()).toBe(true);
  });

  it('stop_login is a safe no-op when nothing is pending', async () => {
    const adapter = loadAdapter();
    adapter._stopPendingLogin();
    await expect(adapter.callTool('stop_login')).resolves.toEqual({ cancelled: false });
  });
});
