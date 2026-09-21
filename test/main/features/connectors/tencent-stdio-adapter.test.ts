import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const requireCjs = createRequire(import.meta.url);

type Adapter = {
  TOOLS: Array<{ name: string; description: string; inputSchema: { required?: string[] } }>;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;
  tmeetBin: () => string;
  _setExecForTest: (fn: ((args: string[]) => Promise<unknown>) | null) => void;
  _resetBinForTest: () => void;
};

function loadAdapter(): Adapter {
  const full = path.join(process.cwd(), 'bin', 'tencent-meeting-mcp-server.cjs');
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
  it('exposes exactly the 5 read-only tools, without starting the stdio server', () => {
    const adapter = loadAdapter();
    expect(adapter.TOOLS.map((t) => t.name).sort()).toEqual([
      'get_transcript',
      'get_transcript_paragraphs',
      'list_recordings',
      'preview_record_permission',
      'search_transcript',
    ]);
    expect(typeof adapter.callTool).toBe('function');
  });

  it('exposes NO write tool — no create/update/cancel/commit path can reach the CLI', () => {
    const adapter = loadAdapter();
    // COGSEED-314.4 is 只读接入适配. Tencent's docs require a self-built agent to implement write
    // confirmation itself; shipping no write tool satisfies that by construction, and keeps the
    // (agent, connector)-scoped bridge always-allow grant from silently covering a mutation.
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

  it('splits 云录制 from 文字转写 so the model cannot feed a media id to the transcript tools', async () => {
    const { adapter, calls } = stubTmeet(() => ({
      records: [
        { meeting_record_id: '7001', record_file_id: '5001', record_type: '云录制', subject: '周会' },
        { meeting_record_id: '7001', record_file_id: '5002', record_type: '文字转写', subject: '周会' },
      ],
      page_token: 'next-1',
    }));

    const res = await adapter.callTool('list_recordings', {
      start: '2026-03-12T00:00+08:00',
      end: '2026-03-12T23:59+08:00',
    });

    expect(res.recordCount).toBe(2);
    expect(res.transcriptRecordCount).toBe(1);
    expect(res.transcript_records).toEqual([
      expect.objectContaining({ record_file_id: '5002', record_type: '文字转写' }),
    ]);
    expect(res.page_token).toBe('next-1');
    expect(calls[0]).toEqual([
      'record', 'list',
      '--start', '2026-03-12T00:00+08:00',
      '--end', '2026-03-12T23:59+08:00',
    ]);
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

  it('passes pid/limit through as strings and reports the transcript text with pagination info', async () => {
    const { adapter, calls } = stubTmeet(() => ({
      paragraphs: [{ text: '第一段' }, { text: '第二段' }],
      pid: '120',
    }));

    const res = await adapter.callTool('get_transcript', { record_file_id: '5002', pid: '100', limit: '50' });

    expect(calls[0]).toEqual([
      'record', 'transcript-get',
      '--record-file-id', '5002',
      '--pid', '100',
      '--limit', '50',
    ]);
    expect(res.text).toBe('第一段\n第二段');
    expect(res.pid).toBe('120');
  });

  it('requires record_file_id for every transcript tool, and text for search', async () => {
    const { adapter } = stubTmeet(() => ({}));

    await expect(adapter.callTool('get_transcript', {})).rejects.toThrow(/record_file_id is required/);
    await expect(adapter.callTool('get_transcript_paragraphs', {})).rejects.toThrow(/record_file_id is required/);
    await expect(adapter.callTool('search_transcript', { record_file_id: '5002' })).rejects.toThrow(/text is required/);
  });

  it('stops a runaway transcript at the char cap and flags the truncation', async () => {
    const huge = 'x'.repeat(250000);
    const { adapter } = stubTmeet(() => ({ transcript: huge }));

    const res = await adapter.callTool('get_transcript', { record_file_id: '5002' });
    expect(res.truncated).toBe(true);
    expect(res.charCount).toBe(250000);
    expect(res.text.length).toBe(200000);
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
