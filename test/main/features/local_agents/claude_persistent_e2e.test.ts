/**
 * Persistent claude runtime — REAL CLI evidence run.
 *
 * NOT a CI/regression test — real-machine acceptance for
 * feat/persistent-cli-runtime phase 3 (stream-json duplex window).
 * Requires a logged-in `claude` CLI. Set RUN_REAL_PERSISTENT_EVIDENCE=1.
 *
 * Acceptance coverage:
 *   - one resident process across turns (single process-info, no
 *     respawn on turn 2), context continuity inside the window;
 *   - SIGKILL the process → next turn recovers (--resume rebuild)
 *     and completes;
 *   - COGSEED_PERSISTENT=0 → one-shot spawn path, no persistent
 *     process-info.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { claudeBackend } from '../../../../src/main/features/local_agents/backends/claude';
import { getPersistentRuntimeManager } from '../../../../src/main/features/local_agents/persistent/manager';
import type { LocalEvent } from '../../../../src/main/features/local_agents/backends/base';

const describeIfLocal = process.env.CI || process.env.RUN_REAL_PERSISTENT_EVIDENCE !== '1' ? describe.skip : describe;
const EVIDENCE_DIR = '/tmp/persistent-claude-evidence';
const WORK_DIR = path.join(EVIDENCE_DIR, 'workdir');
const TOKEN = `emerald-${Date.now().toString(36)}`;

const doneOf = (events: LocalEvent[]) => events.find(e => e.type === 'done') as any;
const textOf = (events: LocalEvent[]) =>
  events.filter(e => e.type === 'text-delta').map((e: any) => e.text).join('');

async function run(prompt: string, over: Record<string, unknown> = {}) {
  const claudePath = execSync('which claude').toString().trim();
  const events: LocalEvent[] = [];
  const startedAt = Date.now();
  await claudeBackend.run({
    binPath: claudePath,
    cwd: WORK_DIR,
    prompt,
    signal: new AbortController().signal,
    onEvent: e => events.push(e),
    timeoutMs: 180_000,
    ...over,
  } as any);
  return { events, elapsedMs: Date.now() - startedAt };
}

describeIfLocal('persistent claude runtime: real CLI evidence', () => {
  it('turn 2 reuses the duplex window: one spawn, context continuity', async () => {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    delete process.env.COGSEED_PERSISTENT;

    const r1 = await run(`Note for our conversation: my favorite color code is ${TOKEN}. Reply with exactly: OK`);
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'turn1.jsonl'), r1.events.map(e => JSON.stringify(e)).join('\n'));
    const done1 = doneOf(r1.events);
    expect(done1?.status).toBe('completed');
    expect(typeof done1?.sessionId).toBe('string');
    const sid = done1.sessionId as string;
    const proc1 = r1.events.find(e => e.type === 'process-info') as any;
    expect(proc1?.persistent).toBe(true);

    const r2 = await run('In this conversation, what is my favorite color code? Reply with the code only.', { resumeSessionId: sid });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'turn2.jsonl'), r2.events.map(e => JSON.stringify(e)).join('\n'));
    const done2 = doneOf(r2.events);
    expect(done2?.status).toBe('completed');
    expect(r2.events.filter(e => e.type === 'process-info')).toHaveLength(0);
    expect(textOf(r2.events) || String(done2?.output || '')).toContain(TOKEN);
    fs.appendFileSync(
      path.join(EVIDENCE_DIR, 'timing.txt'),
      `claude persistent turn1 (cold window): ${r1.elapsedMs}ms\nclaude persistent turn2 (reused window): ${r2.elapsedMs}ms\n`,
    );
  }, 400_000);

  it('switch OFF (COGSEED_PERSISTENT=0) behaves like today: one-shot spawn', async () => {
    process.env.COGSEED_PERSISTENT = '0';
    try {
      const r = await run('Reply with exactly: PONG');
      fs.writeFileSync(path.join(EVIDENCE_DIR, 'switch-off.jsonl'), r.events.map(e => JSON.stringify(e)).join('\n'));
      expect(doneOf(r.events)?.status).toBe('completed');
      const proc = r.events.find(e => e.type === 'process-info') as any;
      expect(proc && proc.persistent).toBeFalsy();
      fs.appendFileSync(path.join(EVIDENCE_DIR, 'timing.txt'), `claude one-shot (switch off): ${r.elapsedMs}ms\n`);
    } finally {
      delete process.env.COGSEED_PERSISTENT;
    }
  }, 400_000);

  it('survives a process crash: next turn recovers and completes', async () => {
    delete process.env.COGSEED_PERSISTENT;
    const crashDir = path.join(EVIDENCE_DIR, 'crash-workdir');
    fs.mkdirSync(crashDir, { recursive: true });
    const r1 = await run('Reply with exactly: OK', { cwd: crashDir });
    const done1 = doneOf(r1.events);
    expect(done1?.status).toBe('completed');
    const sid = done1.sessionId as string;
    const pid = (r1.events.find(e => e.type === 'process-info') as any)?.pid as number;
    expect(typeof pid).toBe('number');

    process.kill(pid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 500));

    const r2 = await run('Reply with exactly: ALIVE', { cwd: crashDir, resumeSessionId: sid });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'crash-recovery.jsonl'), r2.events.map(e => JSON.stringify(e)).join('\n'));
    const done2 = doneOf(r2.events);
    expect(done2?.status).toBe('completed');
    const proc2 = r2.events.find(e => e.type === 'process-info') as any;
    expect(proc2?.persistent).toBe(true);
    expect(proc2?.pid).not.toBe(pid);

    getPersistentRuntimeManager().shutdownAll();
  }, 400_000);
});
