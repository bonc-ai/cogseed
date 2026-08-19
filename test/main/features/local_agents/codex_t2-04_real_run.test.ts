/**
 * T2-04 Evidence script — REAL Codex CLI, fresh `thread/start` session.
 *
 * NOT a CI/regression test — this is a one-off Evidence-collection run that
 * requires a real, logged-in `codex` CLI on the host machine and makes a
 * real network call. It spawns the actual `codex` binary and drives one
 * real turn end to end, with zero mocking of the backend/protocol layer —
 * satisfying T2-04's "no internal state machine or mock substitute"
 * requirement. Skip in normal CI and ordinary `npm test`; set
 * RUN_REAL_CODEX_EVIDENCE=1 to opt in.
 *
 * Run directly with:
 *   npx vitest run test/main/features/local_agents/codex_t2-04_real_run.test.ts
 *
 * Produces on disk (not committed, for local Evidence collection only):
 *   /tmp/t2-04-codex-verify/workdir/NOTES.md  — the file Codex is asked to create
 *   /tmp/t2-04-codex-verify/events.jsonl      — every raw LocalEvent emitted
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { codexBackend } from '../../../../src/main/features/local_agents/backends/codex';
import type { LocalEvent } from '../../../../src/main/features/local_agents/backends/base';

const describeIfLocal = process.env.CI || process.env.RUN_REAL_CODEX_EVIDENCE !== '1' ? describe.skip : describe;

describeIfLocal('T2-04 evidence: real fresh Codex session', () => {
  it('runs one real thread/start turn against the installed codex CLI and captures real status/log/artifact events', async () => {
    const codexPath = execSync('which codex').toString().trim();
    expect(codexPath.length).toBeGreaterThan(0);

    const workDir = '/tmp/t2-04-codex-verify/workdir';
    fs.mkdirSync(workDir, { recursive: true });
    // Fresh-session proof: no pre-existing NOTES.md before this run.
    const notesPath = path.join(workDir, 'NOTES.md');
    if (fs.existsSync(notesPath)) fs.unlinkSync(notesPath);

    const events: LocalEvent[] = [];
    const controller = new AbortController();

    const prompt = 'Using a shell command (not the patch/apply tool), run a command like `printf` or `echo` with output redirection to create a file named NOTES.md in the current directory containing the single line: "T2-04 real Codex session evidence".';

    await codexBackend.run({
      binPath: codexPath,
      prompt,
      cwd: workDir,
      signal: controller.signal,
      onEvent: (e) => { events.push(e); },
      timeoutMs: 120_000,
    });

    fs.writeFileSync(
      '/tmp/t2-04-codex-verify/events.jsonl',
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );

    // ── Real status events ────────────────────────────────────────────
    const statusEvents = events.filter((e) => e.type === 'status');
    expect(statusEvents.length).toBeGreaterThan(0);

    // ── Real done/terminal event with a real threadId (fresh session) ──
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect((done as any)?.sessionId).toBeTruthy();
    expect((done as any)?.status).toBe('completed');

    // ── Real artifact: the file Codex was asked to create actually exists ──
    expect(fs.existsSync(notesPath)).toBe(true);
    const content = fs.readFileSync(notesPath, 'utf8');
    expect(content.length).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(`[T2-04 evidence] threadId=${(done as any)?.sessionId} events=${events.length} artifact=${notesPath}`);
    // eslint-disable-next-line no-console
    console.log(`[T2-04 evidence] file-change events: ${JSON.stringify(events.filter((e) => e.type === 'file-change'))}`);
  }, 130_000);
});
