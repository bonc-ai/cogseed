/**
 * T2-07 Spike Evidence script — REAL OpenCode CLI, real run.
 *
 * NOT a CI/regression test — one-off Evidence-collection run for the
 * "跨Agent Spike: 验证OpenClaw或本地Task Agent的Context注入、结果回收、权限和
 * 可复现性" backlog item, chosen backend = OpenCode. Requires a real,
 * logged-in `opencode` CLI + provider credentials on the host. Skip in CI and
 * during ordinary `npm test`; set RUN_REAL_OPENCODE_EVIDENCE=1 to opt in.
 *
 * Produces on disk (not committed, Evidence collection only):
 *   /tmp/t2-07-opencode-verify/workdir/probe.txt        — Context-injection probe file
 *   /tmp/t2-07-opencode-verify/workdir/result2.json      — Result-recovery artifact
 *   /tmp/t2-07-opencode-verify/context-injection.jsonl   — raw events, run 1 (context)
 *   /tmp/t2-07-opencode-verify/result-recovery.jsonl     — raw events, run 2 (artifact)
 *   /tmp/t2-07-opencode-verify/reproducibility-run-a.jsonl
 *   /tmp/t2-07-opencode-verify/reproducibility-run-b.jsonl
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { opencodeBackend } from '../../../../src/main/features/local_agents/backends/opencode';
import type { LocalEvent } from '../../../../src/main/features/local_agents/backends/base';

const describeIfLocal = process.env.CI || process.env.RUN_REAL_OPENCODE_EVIDENCE !== '1' ? describe.skip : describe;
const MODEL = 'deepseek/deepseek-chat';
const EVIDENCE_DIR = '/tmp/t2-07-opencode-verify';
const WORK_DIR = path.join(EVIDENCE_DIR, 'workdir');

function dumpEvents(name: string, events: LocalEvent[]): void {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, name),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

describeIfLocal('T2-07 evidence: real OpenCode CLI run', () => {
  it('confirms Context injection reaches the CLI process (probe-file readback)', async () => {
    const opencodePath = execSync('which opencode').toString().trim();
    expect(opencodePath.length).toBeGreaterThan(0);

    fs.mkdirSync(WORK_DIR, { recursive: true });
    const probeToken = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(path.join(WORK_DIR, 'probe.txt'), `PROBE_TOKEN=${probeToken}\n`);

    const events: LocalEvent[] = [];
    const controller = new AbortController();

    await opencodeBackend.run({
      binPath: opencodePath,
      cwd: WORK_DIR,
      prompt: '读取当前目录下的 probe.txt 文件，把里面的内容原样输出。',
      model: MODEL,
      signal: controller.signal,
      onEvent: (e) => { events.push(e); },
      timeoutMs: 60_000,
    });

    dumpEvents('context-injection.jsonl', events);

    const textOut = events
      .filter((e) => e.type === 'text-delta')
      .map((e: any) => e.text)
      .join('');
    const doneEvent = events.find((e) => e.type === 'done') as any;

    // Real Evidence: the CLI process only knows the probe token because
    // we injected it via the real filesystem cwd we passed to spawnCli.
    expect(textOut.includes(probeToken) || String(doneEvent?.output || '').includes(probeToken)).toBe(true);
    expect(doneEvent?.status).toBe('completed');
  }, 90_000);

  it('confirms result recovery: real produced artifact + file-change event', async () => {
    const opencodePath = execSync('which opencode').toString().trim();
    const resultPath = path.join(WORK_DIR, 'result2.json');
    if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);

    const events: LocalEvent[] = [];
    const controller = new AbortController();

    await opencodeBackend.run({
      binPath: opencodePath,
      cwd: WORK_DIR,
      prompt: '创建一个文件 result2.json，内容为 {"status": "ok2"}，然后告诉我完成了。',
      model: MODEL,
      signal: controller.signal,
      onEvent: (e) => { events.push(e); },
      timeoutMs: 60_000,
    });

    dumpEvents('result-recovery.jsonl', events);

    // Real Evidence: file genuinely landed on disk with the requested content.
    expect(fs.existsSync(resultPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(onDisk.status).toBe('ok2');

    // Real Evidence: our own event stream reported it too (structured
    // `write` tool-event and/or fallback file-change sweep).
    const toolEvents = events.filter((e) => e.type === 'tool-event');
    const fileChangeEvents = events.filter((e) => e.type === 'file-change');
    const sawResultViaTool = toolEvents.some((e: any) =>
      JSON.stringify(e.input || '').includes('result2.json') || JSON.stringify(e.output || '').includes('result2.json'));
    const sawResultViaFileChange = fileChangeEvents.some((e: any) =>
      (e.paths || []).some((p: string) => p.includes('result2.json')));
    expect(sawResultViaTool || sawResultViaFileChange).toBe(true);

    const doneEvent = events.find((e) => e.type === 'done') as any;
    expect(doneEvent?.status).toBe('completed');
  }, 90_000);

  it('confirms reproducibility: same prompt + cwd yields consistent tool behavior across two runs', async () => {
    const opencodePath = execSync('which opencode').toString().trim();
    const prompt = '创建一个文件 repro.txt，内容为一行文字 "reproducibility check"，然后告诉我完成了。';

    async function runOnce(): Promise<LocalEvent[]> {
      const events: LocalEvent[] = [];
      const controller = new AbortController();
      const reproPath = path.join(WORK_DIR, 'repro.txt');
      if (fs.existsSync(reproPath)) fs.unlinkSync(reproPath);
      await opencodeBackend.run({
        binPath: opencodePath,
        cwd: WORK_DIR,
        prompt,
        model: MODEL,
        signal: controller.signal,
        onEvent: (e) => { events.push(e); },
        timeoutMs: 60_000,
      });
      return events;
    }

    const runA = await runOnce();
    dumpEvents('reproducibility-run-a.jsonl', runA);
    const runB = await runOnce();
    dumpEvents('reproducibility-run-b.jsonl', runB);

    const toolNamesA = runA.filter((e) => e.type === 'tool-event').map((e: any) => e.tool);
    const toolNamesB = runB.filter((e) => e.type === 'tool-event').map((e: any) => e.tool);
    const doneA = runA.find((e) => e.type === 'done') as any;
    const doneB = runB.find((e) => e.type === 'done') as any;

    // Real Evidence: core tool-use behavior (which tool, how many calls)
    // is stable across two independent real runs of the same prompt/cwd.
    expect(doneA?.status).toBe('completed');
    expect(doneB?.status).toBe('completed');
    expect(toolNamesA).toEqual(toolNamesB);
    expect(fs.existsSync(path.join(WORK_DIR, 'repro.txt'))).toBe(true);
  }, 150_000);
});
