/**
 * WorkBuddy REAL end-to-end smoke test (opt-in / gated).
 *
 * This is NOT a mocked unit test. It drives the two shipped features through
 * production code against the REAL WorkBuddy install on this machine:
 *
 *   Feature 1 — 接入 AI 团队 (connect):
 *     detectOne('workbuddy') → real binary discovery, then
 *     workbuddyBackend.run() → REAL spawn of codebuddy, REAL stream-json
 *     parse, capturing the live session_id / assistant text / usage.
 *
 *   Feature 2 — 导入最近会话 (import):
 *     listWorkbuddySessions() → real ~/.workbuddy scan, then
 *     importWorkbuddySession() → REAL read → parse → extract → materialize
 *     → route of an actual on-disk session file.
 *
 * It is gated behind COGSEED_WORKBUDDY_LIVE=1 so the normal suite never spends
 * credits or touches the real install. Run with:
 *
 *   COGSEED_WORKBUDDY_LIVE=1 node scripts/run-tests.mjs run \
 *     test/main/features/local_agents/workbuddy_live_smoke.test.ts
 *
 * HOME stays REAL (so the reader/scanner see the real ~/.workbuddy), but
 * COGSEED_WORKSPACE_ROOT is redirected to a temp dir so the import writes into
 * a throwaway workspace and never pollutes real user data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LIVE = process.env.COGSEED_WORKBUDDY_LIVE === '1';
const d = LIVE ? describe : describe.skip;

let tmpWorkspace: string;
let prevWs: string | undefined;

beforeAll(() => {
  tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-wb-live-ws-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpWorkspace;
});

afterAll(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  try { fs.rmSync(tmpWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
});

d('WorkBuddy live smoke — UI surfacing: localAgents.list marks workbuddy available', () => {
  it('the exact IPC call both onboarding steps make returns workbuddy as available (not masked out)', async () => {
    // Both onboarding steps do: invoke('localAgents.list') then
    // list.filter(e => e.available). Regression guard: the DISPATCHABLE
    // mask used to force workbuddy → available:false, so it never rendered.
    const { invokeHandlers } = await import('../../../../src/main/ipc/local_agents');
    const res: any = await (invokeHandlers as any)['localAgents.list']({ force: true });
    const wb = (res.entries as any[]).find(e => e.type === 'workbuddy');
    // eslint-disable-next-line no-console
    console.log('[live] localAgents.list workbuddy entry =>', JSON.stringify(wb));
    expect(wb).toBeTruthy();
    // Must survive maskUnsupported — this is what the UI filter keys on.
    expect(wb.available).toBe(true);
    expect(wb.errorDetail).not.toBe('backend not yet implemented in CogSeed');
  }, 60_000);
});

d('WorkBuddy live smoke — Feature 1: connect (real CLI execution)', () => {
  it('detects the real codebuddy binary', async () => {
    const { detectOne } = await import('../../../../src/main/features/local_agents/registry');
    const entry = await detectOne('workbuddy');
    // eslint-disable-next-line no-console
    console.log('[live] detectOne(workbuddy) =>', JSON.stringify(entry));
    expect(entry.available).toBe(true);
    expect(entry.path && entry.path.length).toBeTruthy();
    expect(entry.version && entry.version.length).toBeTruthy();
  }, 60_000);

  it('really runs codebuddy through the production backend and captures a live session_id + reply + usage', async () => {
    const { detectOne } = await import('../../../../src/main/features/local_agents/registry');
    const { workbuddyBackend } = await import('../../../../src/main/features/local_agents/backends/workbuddy');

    const entry = await detectOne('workbuddy');
    expect(entry.available).toBe(true);
    const binPath = entry.path as string;

    const events: any[] = [];
    let textOut = '';
    let sawUsageStream = false;
    let doneEvent: any;

    const controller = new AbortController();
    await workbuddyBackend.run({
      binPath,
      prompt: '只回复两个字：OK',
      cwd: os.tmpdir(),
      signal: controller.signal,
      timeoutMs: 5 * 60_000,
      onEvent: (e: any) => {
        events.push(e);
        if (e.type === 'text-delta' && typeof e.text === 'string') textOut += e.text;
        if (e.type === 'status' && e.status === 'usage') sawUsageStream = true;
        if (e.type === 'done') doneEvent = e;
      },
    });

    // eslint-disable-next-line no-console
    console.log('[live] connect done =>', JSON.stringify({
      status: doneEvent?.status,
      sessionId: doneEvent?.sessionId,
      durationMs: doneEvent?.durationMs,
      usage: doneEvent?.usage,
      reply: (doneEvent?.output ?? textOut).slice(0, 120),
      sawUsageStream,
    }));

    // Real completion contract from the production backend.
    expect(doneEvent).toBeTruthy();
    expect(doneEvent.status).toBe('completed');
    // A real external session id (uuid-ish) proves the CLI actually ran.
    expect(typeof doneEvent.sessionId).toBe('string');
    expect((doneEvent.sessionId as string).length).toBeGreaterThan(8);
    // Real reply text arrived (either streamed deltas or terminal output).
    const reply = (doneEvent.output as string) || textOut;
    expect(reply.length).toBeGreaterThan(0);
    // Real token accounting from the model.
    expect(doneEvent.usage).toBeTruthy();
  }, 6 * 60_000);
});

d('WorkBuddy live smoke — Feature 2: import (real on-disk session)', () => {
  it('scans and imports a REAL WorkBuddy session through the production pipeline', async () => {
    const { activateUser } = await import('../../../../src/main/features/users');
    const { listWorkbuddySessions } = await import(
      '../../../../src/main/features/local_agents/workbuddy_sessions'
    );
    const { importWorkbuddySession } = await import(
      '../../../../src/main/features/session_import/asset-router'
    );

    const uid = 'wb-live-user';
    activateUser(uid);

    const sessions = await listWorkbuddySessions();
    // eslint-disable-next-line no-console
    console.log('[live] listWorkbuddySessions => count', sessions.length,
      sessions[0] ? JSON.stringify({
        sessionId: sessions[0].sessionId,
        projectPath: sessions[0].projectPath,
        firstMessage: (sessions[0].firstMessage || '').slice(0, 80),
        timestamp: sessions[0].timestamp,
      }) : '(none)');

    expect(sessions.length).toBeGreaterThan(0);
    const target = sessions[0];
    expect(target.filePath.endsWith('.jsonl')).toBe(true);

    const result = await importWorkbuddySession({
      userId: uid,
      filePath: target.filePath,
      titleHint: target.firstMessage,
      projectPath: target.projectPath,
    });

    // eslint-disable-next-line no-console
    console.log('[live] importWorkbuddySession =>', JSON.stringify({
      ok: result.ok,
      degraded: result.degraded,
      truncated: result.truncated,
      reason: result.reason,
      conversationId: result.conversationId,
      cognitions: result.cognitions,
    }));

    // The real session file was read and materialized into a real conversation,
    // whether or not a model was configured to distill cognitions. A degraded
    // extraction (no model) still materializes real turns — we assert the
    // pipeline ran on real data, and report the cognition counts honestly.
    expect(result.conversationId && result.conversationId.length).toBeTruthy();
    expect(result.cognitions).toBeTruthy();
    expect(typeof result.cognitions.personal).toBe('number');
    expect(typeof result.cognitions.rule).toBe('number');
    expect(typeof result.cognitions.template).toBe('number');
  }, 5 * 60_000);
});
