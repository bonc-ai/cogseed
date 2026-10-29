/**
 * Decision 2 · real gateway process, two-phase background relay.
 *
 * A fake CLI emits the promotion sentinel, then keeps working. The gateway must
 * answer `extensions.background.accepted` before that work finishes, push
 * `background.finished` to the saved reply_endpoint/reply_token afterwards, and
 * hold the independent 60-minute ceiling (scaled down here).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GATEWAY = path.join(process.cwd(), 'p3394-gateway', 'gateway.cjs');
const TOKEN = 'bg-gateway-token';

let tmpDir: string;
const children: ChildProcess[] = [];
const servers: http.Server[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-bg-gateway-'));
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 8_000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await sleep(intervalMs);
  }
}

interface BackgroundFrame {
  phase: 'accepted' | 'finished';
  job_id: string;
  outcome?: string;
  summary?: string;
  error?: { code?: string; message?: string };
}

interface Stub {
  endpoint: string;
  envelopes: Array<Record<string, unknown>>;
  backgroundFrames(): BackgroundFrame[];
}

async function startStub(): Promise<Stub> {
  const envelopes: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed && parsed.envelope) envelopes.push(parsed.envelope);
      } catch { /* hello/ack frames are not envelopes */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const endpoint = 'http://127.0.0.1:' + (server.address() as net.AddressInfo).port;
  const readFrames = () => envelopes
    .map((envelope) => (envelope as { extensions?: { background?: BackgroundFrame } }).extensions?.background)
    .filter((frame): frame is BackgroundFrame => !!frame && (frame.phase === 'accepted' || frame.phase === 'finished'));
  return {
    endpoint,
    envelopes,
    backgroundFrames: readFrames,
  };
}

function writeSilentSlowCli(): string {
  const file = path.join(tmpDir, 'silent-slow-cli.cjs');
  fs.writeFileSync(file, [
    "'use strict';",
    "const delay = Number(process.env.FAKE_DELAY_MS || 0);",
    "process.stdout.write('working quietly...\\n');",
    "setTimeout(() => { process.stdout.write('LATE_RESULT\\n'); process.exit(0); }, delay);",
  ].join('\n'));
  return file;
}

/** Same silent/slow shape, but leaves its exit timestamp on disk so the test can
 *  prove phase 2 was sent after the CLI ended (not at promotion time). */
function writeSilentSlowCliWithExitStamp(): { file: string; stampFile: string } {
  const file = path.join(tmpDir, 'silent-slow-cli-sscli.cjs');
  const stampFile = path.join(tmpDir, 'silent-slow-cli-sscli.exit');
  fs.writeFileSync(file, [
    "'use strict';",
    "const fs = require('fs');",
    "const delay = Number(process.env.FAKE_DELAY_MS || 0);",
    "process.stdout.write('working quietly...\\n');",
    "setTimeout(() => {",
    "  fs.writeFileSync(" + JSON.stringify(stampFile) + ", String(Date.now()));",
    "  process.stdout.write('LATE_RESULT\\n');",
    "  process.exit(0);",
    "}, delay);",
  ].join('\n'));
  return { file, stampFile };
}

function writeFakeCli(delayMs: number): string {
  const file = path.join(tmpDir, 'fake-cli.cjs');
  fs.writeFileSync(file, [
    "'use strict';",
    "const delay = Number(process.env.FAKE_DELAY_MS || 0);",
    "process.stdout.write('[[p3394:background]] ' + JSON.stringify({ eta_seconds: 12 }) + '\\n');",
    "process.stdout.write('working...\\n');",
    "setTimeout(() => { process.stdout.write('DONE\\n'); process.exit(0); }, delay);",
  ].join('\n'));
  return file;
}

interface SpawnedGateway {
  port: number;
  home: string;
  child: ChildProcess;
  output: () => string;
}

async function spawnGateway(opts: {
  stub: Stub;
  fakeCli: string;
  jobDeadlineMs?: number;
  home?: string;
  deliverMs?: number;
  /** Scales the agent deadline down so a promotion can be exercised quickly. */
  agentTimeoutMs?: number;
  /** Decision 2 wiring: promote on the agent deadline instead of killing. */
  promoteOnDeadline?: boolean;
  /** 'sscli' routes through sscli-shim.cjs; default is the oneshot backend. */
  agentMode?: 'oneshot' | 'sscli';
}): Promise<SpawnedGateway> {
  const port = await freePort();
  const home = opts.home ?? path.join(tmpDir, 'gateway-home');
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ELECTRON_RUN_AS_NODE: '1',
    P3394_GATEWAY_PORT: String(port),
    P3394_GATEWAY_HOST: '127.0.0.1',
    P3394_ADVERTISE_ENDPOINT: 'http://127.0.0.1:' + port,
    P3394_GATEWAY_HOME: home,
    COGSEED_ENDPOINT: opts.stub.endpoint,
    COGSEED_TOKEN: TOKEN,
    P3394_HEARTBEAT_MS: '0',
    P3394_AGENT: 'fake',
    P3394_AGENT_ID: 'fake',
    P3394_AGENT_CLI: process.execPath,
    P3394_AGENT_CLI_ARGS: opts.fakeCli,
    P3394_AGENT_MODE: opts.agentMode ?? 'oneshot',
    P3394_AGENT_TIMEOUT_MS: String(opts.agentTimeoutMs ?? 30_000),
    ...(opts.promoteOnDeadline ? { P3394_PROMOTE_ON_DEADLINE: '1' } : {}),
    P3394_DISABLE_ONESHOT_STREAM: '1',
    P3394_BACKGROUND_JOB_DEADLINE_MS: String(opts.jobDeadlineMs ?? 5000),
    FAKE_DELAY_MS: String(opts.deliverMs ?? 700),
  };
  const child = spawn(process.execPath, [GATEWAY], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { output += chunk; });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { output += chunk; });
  // Poll the health endpoint rather than guessing at a fixed startup delay.
  await waitFor(() => new Promise<boolean>((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/p3394/health', timeout: 300 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  }), 10_000, 50);
  return { port, home, child, output: () => output };
}

async function postEnvelope(port: number, envelope: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/p3394/envelope',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => { res.resume(); res.on('end', () => resolve()); });
    req.on('error', reject);
    req.end(JSON.stringify({ envelope }));
  });
}

function taskEnvelope(stub: Stub): Record<string, unknown> {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-bg-gw-1',
    session_id: 'ses-bg-gw-1',
    task_id: 'tsk-bg-gw-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'cogseed' },
    recipients: [{ agent_id: 'fake' }],
    payload: { parts: [{ type: 'text', text: 'run the long task' }] },
    extensions: { reply_endpoint: stub.endpoint, reply_token: TOKEN },
    idempotency_key: 'idem-bg-gw-1',
  };
}

function readJobFile(home: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'background-jobs.json'), 'utf8'));
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

describe('p3394 gateway › two-phase background relay', () => {
  it('answers phase 1 before completion and pushes phase 2 to the saved reply target', async () => {
    const stub = await startStub();
    const fakeCli = writeFakeCli(900);
    const gateway = await spawnGateway({ stub, fakeCli, jobDeadlineMs: 5000 });
    const started = Date.now();
    await postEnvelope(gateway.port, taskEnvelope(stub));

    const accepted = await waitFor(() => stub.backgroundFrames().find((frame) => frame.phase === 'accepted'))
    .catch((error) => { throw new Error(String(error) + '\n--- gateway output ---\n' + gateway.output()); });
    const acceptedAt = Date.now() - started;
    expect(accepted).toMatchObject({ phase: 'accepted', job_id: 'bg-cogseed-tsk-bg-gw-1' });
    // The fake CLI sleeps 900 ms; phase 1 must not wait for it.
    expect(acceptedAt).toBeLessThan(800);

    const finished = await waitFor(() => stub.backgroundFrames().find((frame) => frame.phase === 'finished'));
    expect(finished).toMatchObject({ phase: 'finished', job_id: 'bg-cogseed-tsk-bg-gw-1', outcome: 'completed' });
    expect(finished.summary).toContain('DONE');

    const jobs = await waitFor(() => {
      const rows = readJobFile(gateway.home);
      return rows.length && rows.every((row) => row.state === 'delivered') ? rows : null;
    });
    expect(jobs[0]).toMatchObject({
      job_id: 'bg-cogseed-tsk-bg-gw-1',
      peer: 'cogseed',
      state: 'delivered',
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(gateway.home, 'background-jobs.json')).mode & 0o777).toBe(0o600);
    }
  }, 20_000);

  it('reports timeout at the independent job ceiling (not the agent timeout)', async () => {
    const stub = await startStub();
    const fakeCli = writeFakeCli(10_000);
    const gateway = await spawnGateway({ stub, fakeCli, jobDeadlineMs: 250 });
    await postEnvelope(gateway.port, taskEnvelope(stub));

    await waitFor(() => stub.backgroundFrames().find((frame) => frame.phase === 'accepted'));
    const finished = await waitFor(() => stub.backgroundFrames().find((frame) => frame.phase === 'finished'));
    expect(finished).toMatchObject({ phase: 'finished', job_id: 'bg-cogseed-tsk-bg-gw-1', outcome: 'timeout' });
    expect(finished.error?.code).toBe('p3394_background_timeout');
  }, 20_000);

  it('replays a finished-but-undelivered job exactly once across restarts', async () => {
    const stub = await startStub();
    const fakeCli = writeFakeCli(1);
    const home = path.join(tmpDir, 'replay-home');
    fs.mkdirSync(home, { recursive: true });
    const now = new Date();
    fs.writeFileSync(path.join(home, 'background-jobs.json'), JSON.stringify({
      schema_version: 1,
      jobs: [
        {
          job_id: 'bg-replay-gw-1',
          peer: 'cogseed',
          reply_endpoint: stub.endpoint,
          reply_token: TOKEN,
          deadline: new Date(now.getTime() + 60_000).toISOString(),
          state: 'finished',
          accepted_at: now.toISOString(),
          updated_at: now.toISOString(),
          session_id: 'ses-replay-gw-1',
          task_id: 'tsk-replay-gw-1',
          message_id: 'msg-replay-gw-1',
          phase1_delivered: true,
          result: {
            phase: 'finished',
            job_id: 'bg-replay-gw-1',
            outcome: 'completed',
            summary: 'replayed result',
          },
        },
        {
          job_id: 'bg-replay-expired',
          peer: 'cogseed',
          reply_endpoint: stub.endpoint,
          reply_token: TOKEN,
          deadline: new Date(now.getTime() - 60_000).toISOString(),
          state: 'pending',
          accepted_at: new Date(now.getTime() - 61 * 60_000).toISOString(),
          updated_at: new Date(now.getTime() - 61 * 60_000).toISOString(),
          session_id: 'ses-replay-gw-2',
          task_id: 'tsk-replay-gw-2',
          message_id: 'msg-replay-gw-2',
          phase1_delivered: true,
        },
      ],
    }, null, 2));

    const first = await spawnGateway({ stub, fakeCli, home });
    await waitFor(() => stub.backgroundFrames().find((frame) => frame.phase === 'finished' && frame.job_id === 'bg-replay-gw-1'));
    await waitFor(() => stub.backgroundFrames().find((frame) => frame.phase === 'finished' && frame.job_id === 'bg-replay-expired'));
    const firstFrames = stub.backgroundFrames().filter((frame) => frame.phase === 'finished');
    expect(firstFrames.map((frame) => frame.job_id).sort()).toEqual(['bg-replay-expired', 'bg-replay-gw-1']);
    expect(firstFrames.find((frame) => frame.job_id === 'bg-replay-expired')?.outcome).toBe('timeout');
    await waitFor(() => {
      const rows = readJobFile(home);
      return rows.length === 2 && rows.every((row) => row.state === 'delivered') ? rows : null;
    });

    first.child.kill('SIGKILL');
    await sleep(150);
    // Restart with the same ledger: delivered rows must not replay.
    await spawnGateway({ stub, fakeCli, home });
    await sleep(700);
    expect(stub.backgroundFrames().filter((frame) => frame.phase === 'finished')).toHaveLength(2);
  }, 25_000);

it('promotes at the agent deadline when enabled, without a CLI sentinel', async () => {
  const stub = await startStub();
  const fakeCli = writeSilentSlowCli();
  const gateway = await spawnGateway({
    stub,
    fakeCli,
    agentTimeoutMs: 400,
    promoteOnDeadline: true,
    deliverMs: 2_500,
    jobDeadlineMs: 20_000,
  });

  await postEnvelope(gateway.port, taskEnvelope(stub));

  // Phase 1 must come from the deadline path (~400ms), not from a CLI marker.
  const accepted = await waitFor(() => stub.backgroundFrames().find((frame) => frame.phase === 'accepted'));
  expect(accepted.job_id).toBe('bg-cogseed-tsk-bg-gw-1');

  // The child was NOT killed at the deadline: it finishes later and the gateway
  // pushes phase 2 with that result.
  const finished = await waitFor(() => stub.backgroundFrames().find((frame) => frame.phase === 'finished'), 8_000);
  expect(finished.job_id).toBe(accepted.job_id);
  expect(finished.outcome).toBe('completed');
  expect(String(finished.summary) + '\n--- gateway ---\n' + gateway.output()).toContain('LATE_RESULT');

  await waitFor(() => {
    const rows = readJobFile(gateway.home);
    return rows.length === 1 && rows[0].state === 'delivered' ? rows : null;
  });
}, 25_000);


it('promotes through the sscli shim too, carrying the CLI text into phase 2', async () => {
  const stub = await startStub();
  const { file: fakeCli, stampFile } = writeSilentSlowCliWithExitStamp();
  const gateway = await spawnGateway({
    stub,
    fakeCli,
    agentMode: 'sscli',
    agentTimeoutMs: 400,
    promoteOnDeadline: true,
    deliverMs: 2_500,
    jobDeadlineMs: 20_000,
  });

  await postEnvelope(gateway.port, taskEnvelope(stub));

  // Phase 1 comes from the sscli deadline path (the shim's own deadline is
  // TIMEOUT_MS + 5s, so the CLI outlives the promotion).
  const accepted = await waitFor(
    () => stub.backgroundFrames().find((frame) => frame.phase === 'accepted'),
    8_000,
  );
  expect(accepted).toMatchObject({ phase: 'accepted', job_id: 'bg-cogseed-tsk-bg-gw-1' });
  // The promote ack echoes the deliver's request_id. If the gateway resolves the
  // deliver on that ack, this frame lands within milliseconds — long before the
  // CLI exits — and the summary is empty.
  expect(stub.backgroundFrames().some((frame) => frame.phase === 'finished')).toBe(false);

  const finished = await waitFor(
    () => stub.backgroundFrames().find((frame) => frame.phase === 'finished'),
    10_000,
  );
  const finishedAt = Date.now();
  expect(finished).toMatchObject({
    phase: 'finished',
    job_id: accepted.job_id,
    outcome: 'completed',
  });
  expect(finished.summary).toContain('LATE_RESULT');

  const exitStamp = Number(fs.readFileSync(stampFile, 'utf8'));
  // Phase 2 must follow the CLI's own exit, not the promotion instant.
  expect(finishedAt).toBeGreaterThanOrEqual(exitStamp);
  expect(finishedAt - exitStamp).toBeLessThan(2_000);

  const rows = await waitFor(() => {
    const jobs = readJobFile(gateway.home);
    return jobs.length === 1 && jobs[0].state === 'delivered' ? jobs : null;
  });
  expect(rows[0]).toMatchObject({ job_id: accepted.job_id, state: 'delivered' });
}, 25_000);

});
