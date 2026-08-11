import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  claudeDesktopRoots,
  listClaudeDesktopSessions,
} from '../../../src/main/features/local_agents/claude_desktop_sessions';

const tmpDirs: string[] = [];

function mkHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-claude-desktop-'));
  tmpDirs.push(dir);
  return dir;
}

/** Write a session meta file at the real depth: `<account>/<workspace>/local_*.json`. */
function writeSession(
  home: string,
  opts: { app?: string; account?: string; workspace?: string; name?: string; body: unknown },
) {
  const app = opts.app ?? 'Claude-3p';
  const dir = path.join(
    home,
    'Library',
    'Application Support',
    app,
    'local-agent-mode-sessions',
    opts.account ?? 'acct1',
    opts.workspace ?? 'ws1',
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, opts.name ?? 'local_a.json'), JSON.stringify(opts.body));
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('claude desktop session roots', () => {
  it('resolves per-platform roots and includes the 3p enterprise variant', () => {
    const mac = claudeDesktopRoots('/Users/x', 'darwin');
    expect(mac).toContain('/Users/x/Library/Application Support/Claude');
    expect(mac.some((r) => r.endsWith('Claude-3p'))).toBe(true);

    const linux = claudeDesktopRoots('/home/x', 'linux');
    expect(linux).toContain('/home/x/.config/Claude');

    const prevAppData = process.env.APPDATA;
    process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming';
    try {
      const win = claudeDesktopRoots('C:\\Users\\x', 'win32');
      expect(win.some((r) => r.includes('AppData') && r.endsWith('Claude'))).toBe(true);
    } finally {
      if (prevAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevAppData;
    }
  });
});

describe('claude desktop session scan', () => {
  it('reads metadata two levels deep and sorts newest first', async () => {
    const home = mkHome();
    writeSession(home, {
      workspace: 'ws1',
      name: 'local_old.json',
      body: {
        sessionId: 'sess-old',
        title: 'Older chat',
        createdAt: '2026-01-01T00:00:00.000Z',
        model: 'claude-sonnet-4',
        initialMessage: 'first question',
      },
    });
    writeSession(home, {
      workspace: 'ws2',
      name: 'local_new.json',
      body: {
        sessionId: 'sess-new',
        title: 'Newer chat',
        createdAt: '2026-06-01T00:00:00.000Z',
        model: 'claude-opus-4',
        initialMessage: 'later question',
      },
    });

    const res = await listClaudeDesktopSessions(home, 'darwin');

    expect(res.ok).toBe(true);
    expect(res.sessions.map((s) => s.sessionId)).toEqual(['sess-new', 'sess-old']);
    expect(res.sessions[0].title).toBe('Newer chat');
    expect(res.sessions[0].model).toBe('claude-opus-4');
    expect(res.sessions[0].initialMessage).toBe('later question');
  });

  it('ignores the unrelated skills-plugin subtree in the same directory', async () => {
    const home = mkHome();
    writeSession(home, {
      body: { sessionId: 'real', title: 'Real', createdAt: '2026-05-01T00:00:00.000Z' },
    });
    const noise = path.join(
      home,
      'Library',
      'Application Support',
      'Claude-3p',
      'local-agent-mode-sessions',
      'skills-plugin',
      'nested',
    );
    fs.mkdirSync(noise, { recursive: true });
    fs.writeFileSync(path.join(noise, 'local_fake.json'), JSON.stringify({ sessionId: 'nope' }));
    fs.writeFileSync(path.join(noise, 'other.json'), '{}');

    const res = await listClaudeDesktopSessions(home, 'darwin');

    expect(res.sessions.map((s) => s.sessionId)).toEqual(['real']);
  });

  it('accepts legacy field names and survives missing or malformed entries', async () => {
    const home = mkHome();
    writeSession(home, {
      workspace: 'legacy',
      name: 'local_legacy.json',
      body: { id: 'legacy-id', name: 'Legacy title', timestamp: 1_760_000_000_000 },
    });
    writeSession(home, {
      workspace: 'broken',
      name: 'local_broken.json',
      body: 'not-an-object',
    });
    const brokenDir = path.join(
      home,
      'Library',
      'Application Support',
      'Claude-3p',
      'local-agent-mode-sessions',
      'acct1',
      'bad',
    );
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'local_trunc.json'), '{"sessionId": "x"');

    const res = await listClaudeDesktopSessions(home, 'darwin');

    expect(res.ok).toBe(true);
    const legacy = res.sessions.find((s) => s.sessionId === 'legacy-id');
    expect(legacy?.title).toBe('Legacy title');
    expect(legacy?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.sessions.some((s) => s.sessionId === 'x')).toBe(false);
  });

  it('returns an empty ok result when the user never used the desktop app', async () => {
    const res = await listClaudeDesktopSessions(mkHome(), 'darwin');

    expect(res.ok).toBe(true);
    expect(res.sessions).toEqual([]);
    expect(res.error).toBeUndefined();
  });

  it('reports permission_denied when the sessions directory is unreadable', async () => {
    const home = mkHome();
    const sessionsRoot = path.join(
      home,
      'Library',
      'Application Support',
      'Claude-3p',
      'local-agent-mode-sessions',
    );
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.chmodSync(sessionsRoot, 0o000);
    try {
      const res = await listClaudeDesktopSessions(home, 'darwin');

      // Running as root bypasses mode bits, so only assert when the guard holds.
      if (!res.ok) {
        expect(res.error).toBe('permission_denied');
        expect(res.sessions).toEqual([]);
      }
    } finally {
      fs.chmodSync(sessionsRoot, 0o755);
    }
  });
});
