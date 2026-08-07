import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Controlled workspace root for cwd-sandbox tests. isPathAllowed (real) uses
// realpath, so we need a real directory on disk.
let workspaceRoot = '';

vi.mock('../../../../src/main/features/user_workspace', () => ({
  getWorkspacePath: (_uid: string) => workspaceRoot,
}));
vi.mock('../../../../src/main/features/granted_roots', () => ({
  grantedRootsForSandbox: (_uid: string) => [] as string[],
}));

import {
  startTerminalSession,
  writeTerminalInput,
  resizeTerminal,
  closeTerminalSession,
  listTerminalSessions,
  terminalEvents,
  _resetTerminalSessionsForTest,
  _setNodePtyForTest,
  _sessionCountForTest,
} from '../../../../src/main/features/terminal/pty-sessions';

// ── Fake node-pty ────────────────────────────────────────────────────────
interface FakePty {
  pid: number;
  written: string[];
  cols: number;
  rows: number;
  killed: string | null;
  _dataCb: ((d: string) => void) | null;
  _exitCb: ((e: { exitCode: number; signal?: number }) => void) | null;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(sig?: string): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  emitData(d: string): void;
  emitExit(code: number): void;
}

let lastSpawn: { file: string; args: string[] | string; opts: any } | null = null;
let fakePtys: FakePty[] = [];

function makeFakePtyModule() {
  return {
    spawn(file: string, args: string[] | string, opts: any): FakePty {
      const p: FakePty = {
        pid: 4242 + fakePtys.length,
        written: [],
        cols: opts.cols,
        rows: opts.rows,
        killed: null,
        _dataCb: null,
        _exitCb: null,
        write(d) { this.written.push(d); },
        resize(c, r) { this.cols = c; this.rows = r; },
        kill(sig) { this.killed = sig || 'SIGTERM'; },
        onData(cb) { this._dataCb = cb; },
        onExit(cb) { this._exitCb = cb; },
        emitData(d) { this._dataCb?.(d); },
        emitExit(code) { this._exitCb?.({ exitCode: code }); },
      };
      lastSpawn = { file, args, opts };
      fakePtys.push(p);
      return p;
    },
  };
}

describe('terminal PTY sessions', () => {
  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'term-ws-'));
    fakePtys = [];
    lastSpawn = null;
    _setNodePtyForTest(makeFakePtyModule() as any);
  });

  afterEach(() => {
    _resetTerminalSessionsForTest();
    _setNodePtyForTest(null);
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('starts a session with the workspace as default cwd and a real TERM', () => {
    const view = startTerminalSession({ uid: 'u1', cols: 100, rows: 30 });
    expect(view.status).toBe('running');
    expect(view.cols).toBe(100);
    expect(view.rows).toBe(30);
    // cwd defaults to workspace (realpath-normalized, so compare via realpath)
    expect(fs.realpathSync(view.cwd)).toBe(fs.realpathSync(workspaceRoot));
    expect(lastSpawn?.opts.name).toBe('xterm-256color');
    expect(lastSpawn?.opts.env.TERM).toBe('xterm-256color');
  });

  it('rejects a cwd outside the allowed workspace', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'term-outside-'));
    try {
      expect(() => startTerminalSession({ uid: 'u1', cwd: outside, cols: 80, rows: 24 }))
        .toThrow(/outside the allowed workspace/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('accepts a cwd inside the workspace', () => {
    const sub = path.join(workspaceRoot, 'proj');
    fs.mkdirSync(sub);
    const view = startTerminalSession({ uid: 'u1', cwd: sub, cols: 80, rows: 24 });
    expect(fs.realpathSync(view.cwd)).toBe(fs.realpathSync(sub));
  });

  it('routes write/resize to the pty', () => {
    const view = startTerminalSession({ uid: 'u1', cols: 80, rows: 24 });
    writeTerminalInput('u1', view.session_id, 'ls\n');
    expect(fakePtys[0].written).toEqual(['ls\n']);
    resizeTerminal('u1', view.session_id, 120, 40);
    expect(fakePtys[0].cols).toBe(120);
    expect(fakePtys[0].rows).toBe(40);
  });

  it('emits output events for the owning session', () => {
    const view = startTerminalSession({ uid: 'u1', cols: 80, rows: 24 });
    const seen: string[] = [];
    const listener = (ev: { userId: string; sessionId: string; chunk: string }) => {
      if (ev.sessionId === view.session_id) seen.push(ev.chunk);
    };
    terminalEvents.on('data', listener);
    fakePtys[0].emitData('hello\r\n');
    terminalEvents.off('data', listener);
    expect(seen).toEqual(['hello\r\n']);
  });

  it('close signals the pty (graceful SIGTERM)', () => {
    const view = startTerminalSession({ uid: 'u1', cols: 80, rows: 24 });
    closeTerminalSession('u1', view.session_id);
    expect(fakePtys[0].killed).toBe('SIGTERM');
  });

  it('marks exited and records exit code on pty exit', () => {
    const view = startTerminalSession({ uid: 'u1', cols: 80, rows: 24 });
    fakePtys[0].emitExit(7);
    const list = listTerminalSessions('u1');
    // still present briefly after exit
    const found = list.find((s) => s.session_id === view.session_id);
    expect(found?.status).toBe('exited');
    expect(found?.exit_code).toBe(7);
  });

  it('isolates sessions by user', () => {
    const a = startTerminalSession({ uid: 'u1', cols: 80, rows: 24 });
    startTerminalSession({ uid: 'u2', cols: 80, rows: 24 });
    expect(listTerminalSessions('u1').length).toBe(1);
    expect(listTerminalSessions('u2').length).toBe(1);
    // u2 cannot touch u1's session
    expect(() => writeTerminalInput('u2', a.session_id, 'x')).toThrow(/not found/);
    expect(() => closeTerminalSession('u2', a.session_id)).toThrow(/not found/);
  });

  it('shutdownAll kills every live pty and clears the map', () => {
    startTerminalSession({ uid: 'u1', cols: 80, rows: 24 });
    startTerminalSession({ uid: 'u2', cols: 80, rows: 24 });
    expect(_sessionCountForTest()).toBe(2);
    _resetTerminalSessionsForTest();
    expect(_sessionCountForTest()).toBe(0);
    expect(fakePtys.every((p) => p.killed === 'SIGKILL')).toBe(true);
  });
});
