/**
 * Persistent opencode runtime — REAL CLI evidence run.
 *
 * NOT a CI/regression test — real-machine acceptance for
 * feat/persistent-cli-runtime phase 2. Requires a real, logged-in
 * `opencode` CLI. Set RUN_REAL_PERSISTENT_EVIDENCE=1 to opt in.
 *
 * Acceptance coverage:
 *   a. same conversation: turn 2+ does NOT respawn (single
 *      persistent process-info, same pid);
 *   c. COGSEED_PERSISTENT=0 → behavior identical to today (one-shot
 *      spawn path, no persistent process-info);
 *   d. killing the serve process mid-conversation: the next turn
 *      recovers (server restart, session resumed or rebuilt) and the
 *      turn itself completes;
 *   + context continuity inside the window (turn 2 recalls turn 1);
 *   + wall-clock comparison one-shot vs persistent turn 2.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { opencodeBackend } from '../../../../src/main/features/local_agents/backends/opencode';
import { getPersistentRuntimeManager } from '../../../../src/main/features/local_agents/persistent/manager';
import type { LocalEvent } from '../../../../src/main/features/local_agents/backends/base';

const describeIfLocal = process.env.CI || process.env.RUN_REAL_PERSISTENT_EVIDENCE !== '1' ? describe.skip : describe;
const MODEL = process.env.PERSISTENT_EVIDENCE_MODEL || 'opencode-go/deepseek-v4-flash';
const EVIDENCE_DIR = '/tmp/persistent-opencode-evidence';
const WORK_DIR = path.join(EVIDENCE_DIR, 'workdir');

const TOKEN = `alpha-${Date.now().toString(36)}`;

function collect(): { events: LocalEvent[]; onEvent: (e: LocalEvent) => void } {
  const events: LocalEvent[] = [];
  return { events, onEvent: e => events.push(e) };
}

const doneOf = (events: LocalEvent[]) => events.find(e => e.type === 'done') as any;
const textOf = (events: LocalEvent[]) =>
  events.filter(e => e.type === 'text-delta').map((e: any) => e.text).join('');

async function run(prompt: string, over: Record<string, unknown> = {}) {
  const opencodePath = execSync('which opencode').toString().trim();
  const { events, onEvent } = collect();
  const startedAt = Date.now();
  await opencodeBackend.run({
    binPath: opencodePath,
    cwd: WORK_DIR,
    prompt,
    model: MODEL,
    signal: new AbortController().signal,
    onEvent,
    timeoutMs: 120_000,
    ...over,
  } as any);
  return { events, elapsedMs: Date.now() - startedAt };
}

describeIfLocal('persistent opencode runtime: real CLI evidence', () => {
  afterEach(() => {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  });

  it('turn 2 reuses the window: one spawn, context continuity, faster', async () => {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    delete process.env.COGSEED_PERSISTENT;

    const r1 = await run(`Remember this secret token for later: ${TOKEN}. Reply with exactly: OK`);
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'turn1.jsonl'), r1.events.map(e => JSON.stringify(e)).join('\n'));
    const done1 = doneOf(r1.events);
    expect(done1?.status).toBe('completed');
    expect(typeof done1?.sessionId).toBe('string');
    const sid = done1.sessionId as string;
    const proc1 = r1.events.find(e => e.type === 'process-info') as any;
    expect(proc1?.persistent).toBe(true);

    const r2 = await run('What was the secret token I gave you? Reply with the token only.', { resumeSessionId: sid });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'turn2.jsonl'), r2.events.map(e => JSON.stringify(e)).join('\n'));
    const done2 = doneOf(r2.events);
    expect(done2?.status).toBe('completed');
    // (a) no respawn on the reused turn: no second process-info.
    const procInfos = r2.events.filter(e => e.type === 'process-info');
    expect(procInfos).toHaveLength(0);
    // context continuity inside the window.
    expect(textOf(r2.events) || String(done2?.output || '')).toContain(TOKEN);
    // timing evidence (informational, not a hard gate).
    fs.appendFileSync(
      path.join(EVIDENCE_DIR, 'timing.txt'),
      `persistent turn1 (cold window): ${r1.elapsedMs}ms\npersistent turn2 (reused window): ${r2.elapsedMs}ms\n`,
    );
  }, 300_000);

  it('switch OFF (COGSEED_PERSISTENT=0) behaves like today: one-shot spawn', async () => {
    process.env.COGSEED_PERSISTENT = '0';
    try {
      const r = await run('Reply with exactly: PONG');
      fs.writeFileSync(path.join(EVIDENCE_DIR, 'switch-off.jsonl'), r.events.map(e => JSON.stringify(e)).join('\n'));
      const done = doneOf(r.events);
      expect(done?.status).toBe('completed');
      // one-shot path: process-info WITHOUT the persistent marker.
      const proc = r.events.find(e => e.type === 'process-info') as any;
      expect(proc && proc.persistent).toBeFalsy();
      fs.appendFileSync(path.join(EVIDENCE_DIR, 'timing.txt'), `one-shot (switch off): ${r.elapsedMs}ms\n`);
    } finally {
      delete process.env.COGSEED_PERSISTENT;
    }
  }, 300_000);

  it('survives a serve crash: next turn recovers and completes', async () => {
    delete process.env.COGSEED_PERSISTENT;
    // Fresh cwd → fresh server, so this turn carries its own
    // process-info (the shared-cwd server from case 1 is reused and
    // wouldn't re-emit one).
    const crashDir = path.join(EVIDENCE_DIR, 'crash-workdir');
    fs.mkdirSync(crashDir, { recursive: true });
    const r1 = await run('Reply with exactly: OK', { cwd: crashDir });
    const done1 = doneOf(r1.events);
    expect(done1?.status).toBe('completed');
    const sid = done1.sessionId as string;
    const pid = (r1.events.find(e => e.type === 'process-info') as any)?.pid as number;
    expect(typeof pid).toBe('number');

    // Kill the resident server outright.
    process.kill(pid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 500));

    const r2 = await run('Reply with exactly: ALIVE', { cwd: crashDir, resumeSessionId: sid });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'crash-recovery.jsonl'), r2.events.map(e => JSON.stringify(e)).join('\n'));
    const done2 = doneOf(r2.events);
    // (d) the turn is not lost: completed, with a fresh process-info
    // for the restarted server.
    expect(done2?.status).toBe('completed');
    const proc2 = r2.events.find(e => e.type === 'process-info') as any;
    expect(proc2?.persistent).toBe(true);
    expect(proc2?.pid).not.toBe(pid);

    getPersistentRuntimeManager().shutdownAll();
  }, 300_000);
});
