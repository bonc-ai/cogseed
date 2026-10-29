/**
 * Decision 2 · outbound hub two-phase relay contract.
 *
 * Phase 1 (`extensions.background.phase === 'accepted'`) must resolve the
 * waiting turn immediately — the old reply timeout is the exact window a
 * promoted run exceeds. Phase 2 (`phase === 'finished'`) must use its own
 * channel, idempotent by job_id, and never match a reply waiter.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { P3394OutboundHub } from '../../../../src/main/features/p3394_bridge/outbound-hub';
import { backgroundJobsFile, loadBackgroundJobs, putBackgroundJob } from '../../../../src/main/features/p3394_bridge/background-job-store';
import { p3394StateFile } from '../../../../src/main/features/p3394_bridge/runtime-paths';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';
import type { P3394PeerRecord } from '../../../../src/main/features/p3394_bridge/registry';
import type { P3394BackgroundFinished } from '../../../../src/main/features/p3394_bridge/background-jobs';

const MANIFEST = {
  spec_version: 'p3394/1.0',
  identity: { agent_id: 'hermes', display_name: 'Hermes' },
  runtime: { kind: 'in_process' },
  capability_profile: {
    agent_id: 'hermes',
    runtime_kind: 'cogseed-native',
    capabilities: ['handle_message'],
    supported_performatives: ['request', 'response'],
    supports_streaming: false,
  },
};

let previousVariant: string | undefined;
let variantName: string;
let uid: string;

function envelope(overrides: Record<string, unknown> = {}): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-bg-out-1',
    session_id: 'ses-bg-out-1',
    task_id: 'tsk-bg-out-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'cogseed' },
    recipients: [{ agent_id: 'hermes' }],
    payload: { parts: [{ type: 'text', text: 'long task' }] },
    extensions: { reply_endpoint: 'http://127.0.0.1:9', reply_token: 'reply-token' },
    idempotency_key: 'idem-bg-out-1',
    ...overrides,
  } as never;
}

function acceptedEnvelope(overrides: Record<string, unknown> = {}): P3394Envelope {
  return envelope({
    message_id: 'msg-bg-accepted-1',
    kind: 'message',
    performative: 'inform',
    sender: { agent_id: 'hermes' },
    recipients: [{ agent_id: 'cogseed' }],
    reply_to: 'msg-bg-out-1',
    payload: { parts: [{ type: 'text', text: 'accepted note' }] },
    extensions: { background: { phase: 'accepted', job_id: 'bg-hermes-tsk-bg-out-1', eta_seconds: 900 } },
    idempotency_key: 'idem-bg-accepted-1',
    ...overrides,
  } as never);
}

function finishedEnvelope(overrides: Record<string, unknown> = {}): P3394Envelope {
  return envelope({
    message_id: 'msg-bg-finished-1',
    kind: 'message',
    performative: 'inform',
    sender: { agent_id: 'hermes' },
    recipients: [{ agent_id: 'cogseed' }],
    reply_to: 'msg-bg-out-1',
    payload: { parts: [{ type: 'text', text: 'done: report.md' }] },
    extensions: {
      background: {
        phase: 'finished',
        job_id: 'bg-hermes-tsk-bg-out-1',
        outcome: 'completed',
        summary: 'done: report.md',
        artifacts: ['report.md'],
      },
    },
    idempotency_key: 'idem-bg-finished-1',
    ...overrides,
  } as never);
}

beforeEach(() => {
  previousVariant = process.env.COGSEED_RUNTIME_VARIANT;
  variantName = 'p3394-bg-hub-' + Math.random().toString(36).slice(2, 8);
  process.env.COGSEED_RUNTIME_VARIANT = variantName;
  uid = 'bghub-' + Math.random().toString(36).slice(2, 10);
  try { fs.unlinkSync(p3394StateFile('p3394-outbox.jsonl')); } catch { /* absent */ }
});

afterEach(() => {
  if (previousVariant === undefined) delete process.env.COGSEED_RUNTIME_VARIANT;
  else process.env.COGSEED_RUNTIME_VARIANT = previousVariant;
  try { fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName), { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(path.dirname(path.dirname(backgroundJobsFile(uid))), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('P3394OutboundHub › two-phase background relay', () => {
  let servers: http.Server[] = [];
  let received: P3394Envelope[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    received = [];
  });

  async function startPeer(): Promise<string> {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/p3394/manifest')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, manifest: MANIFEST }));
        return;
      }
      if (req.url?.startsWith('/p3394/envelope') && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try { received.push(JSON.parse(body).envelope); } catch { /* ignore */ }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message_id: 'msg-bg-out-1' }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  }

  function hubFor(endpoint: string, overrides: Partial<ConstructorParameters<typeof P3394OutboundHub>[0]> = {}): P3394OutboundHub {
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      endpoints: [endpoint],
      updated_at: new Date().toISOString(),
    };
    return new P3394OutboundHub({
      listPeers: () => [peer],
      userId: () => uid,
      replyTimeoutMs: 60_000,
      ...overrides,
    });
  }

  async function waitForReceived(count: number): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (received.length < count) {
      if (Date.now() > deadline) throw new Error('peer did not receive the outbound envelope');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('resolves phase 1 immediately (not at replyTimeoutMs) and records the job', async () => {
    const endpoint = await startPeer();
    const hub = hubFor(endpoint);
    const started = Date.now();
    const pending = hub.sendAndWait('hermes', envelope());
    await waitForReceived(1);
    expect(hub.tryResolveReply(acceptedEnvelope())).toBe(true);
    const reply = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reply.kind).toBe('background');
    expect(reply.background).toMatchObject({ phase: 'accepted', job_id: 'bg-hermes-tsk-bg-out-1' });
    expect(reply.text).toBe('accepted note');

    const jobs = loadBackgroundJobs(uid);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_id: 'bg-hermes-tsk-bg-out-1',
      peer: 'hermes',
      state: 'pending',
      session_id: 'ses-bg-out-1',
      reply_endpoint: 'http://127.0.0.1:9',
    });
    expect(jobs[0].deadline > new Date().toISOString()).toBe(true);
    // Phase 1 is the terminal acknowledgement: duplicate acks are swallowed.
    expect(hub.tryResolveReply(acceptedEnvelope({ message_id: 'msg-bg-accepted-dup' } as never))).toBe(true);
    await hub.close();
  });

  it('delivers phase 2 once by job_id, even when the same result is pushed twice', async () => {
    const endpoint = await startPeer();
    const delivered: P3394BackgroundFinished[] = [];
    const hub = hubFor(endpoint, {
      deliverBackgroundResult: async ({ result }) => { delivered.push(result); return 'delivered'; },
    });
    const pending = hub.sendAndWait('hermes', envelope());
    await waitForReceived(1);
    hub.tryResolveReply(acceptedEnvelope());
    await pending;

    expect(hub.deliverBackgroundResult(finishedEnvelope())).toBe(true);
    await hub.flushBackgroundDeliveries();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ outcome: 'completed', summary: 'done: report.md' });

    // Duplicate phase 2 after delivery: consumed, never delivered twice.
    expect(hub.deliverBackgroundResult(finishedEnvelope({ message_id: 'msg-bg-finished-dup' } as never))).toBe(true);
    await hub.flushBackgroundDeliveries();
    expect(delivered).toHaveLength(1);
    expect(loadBackgroundJobs(uid)[0].state).toBe('delivered');
    await hub.close();
  });

  it('rejects malformed background results and leaves ordinary envelopes alone', async () => {
    const endpoint = await startPeer();
    const delivered: unknown[] = [];
    const hub = hubFor(endpoint, {
      deliverBackgroundResult: async ({ result }) => { delivered.push(result); return 'delivered'; },
    });
    expect(hub.deliverBackgroundResult(finishedEnvelope({
      extensions: { background: { phase: 'finished', outcome: 'completed' } },
    } as never))).toBe(false);
    expect(hub.deliverBackgroundResult(finishedEnvelope({
      extensions: { background: { phase: 'finished', job_id: 'bg-x-y', outcome: 'cancelled' } },
    } as never))).toBe(false);
    expect(hub.deliverBackgroundResult(envelope())).toBe(false);
    await hub.flushBackgroundDeliveries();
    expect(delivered).toHaveLength(0);
    await hub.close();
  });

  it('synthesizes timeout at the independent ceiling when the gateway never reports', async () => {
    const endpoint = await startPeer();
    const delivered: P3394BackgroundFinished[] = [];
    const hub = hubFor(endpoint, {
      backgroundJobDeadlineMs: 80,
      deliverBackgroundResult: async ({ result }) => { delivered.push(result); return 'delivered'; },
    });
    const pending = hub.sendAndWait('hermes', envelope());
    await waitForReceived(1);
    hub.tryResolveReply(acceptedEnvelope());
    await pending;

    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 3_000 });
    expect(delivered[0]).toMatchObject({
      outcome: 'timeout',
      job_id: 'bg-hermes-tsk-bg-out-1',
      error: { code: 'p3394_background_timeout' },
    });
    expect(loadBackgroundJobs(uid)[0].state).toBe('delivered');
    await hub.close();
  });

  it('boot replay: finished once, expired pending as timeout, delivered not resent', async () => {
    const endpoint = await startPeer();
    const delivered: P3394BackgroundFinished[] = [];
    const hub = hubFor(endpoint, {
      deliverBackgroundResult: async ({ result }) => { delivered.push(result); return 'delivered'; },
    });
    const now = Date.now();
    putBackgroundJob(uid, {
      job_id: 'bg-replay-finished',
      peer: 'hermes',
      reply_endpoint: endpoint,
      reply_token: 't',
      deadline: new Date(now + 60_000).toISOString(),
      state: 'finished',
      accepted_at: new Date(now - 1000).toISOString(),
      updated_at: new Date(now - 1000).toISOString(),
      session_id: 'ses-replay-1',
      result: { phase: 'finished', job_id: 'bg-replay-finished', outcome: 'completed', summary: 'replayed' },
    });
    putBackgroundJob(uid, {
      job_id: 'bg-replay-timeout',
      peer: 'hermes',
      reply_endpoint: endpoint,
      reply_token: 't',
      deadline: new Date(now - 1000).toISOString(),
      state: 'pending',
      accepted_at: new Date(now - 61 * 60 * 1000).toISOString(),
      updated_at: new Date(now - 61 * 60 * 1000).toISOString(),
      session_id: 'ses-replay-2',
    });
    putBackgroundJob(uid, {
      job_id: 'bg-replay-delivered',
      peer: 'hermes',
      reply_endpoint: endpoint,
      reply_token: 't',
      deadline: new Date(now + 60_000).toISOString(),
      state: 'delivered',
      accepted_at: new Date(now - 1000).toISOString(),
      updated_at: new Date(now - 1000).toISOString(),
      session_id: 'ses-replay-3',
      result: { phase: 'finished', job_id: 'bg-replay-delivered', outcome: 'completed', summary: 'already there' },
    });

    const first = await hub.replayBackgroundJobs();
    await hub.flushBackgroundDeliveries();
    expect(first).toMatchObject({ replayed: 1, timedOut: 1, delivered: 2 });
    expect(delivered.map((entry) => entry.job_id).sort()).toEqual(['bg-replay-finished', 'bg-replay-timeout']);
    expect(delivered.find((entry) => entry.job_id === 'bg-replay-timeout')?.outcome).toBe('timeout');

    // A second boot must not deliver anything again (job_id idempotency).
    const second = await hub.replayBackgroundJobs();
    await hub.flushBackgroundDeliveries();
    expect(second.replayed).toBe(0);
    expect(second.timedOut).toBe(0);
    expect(delivered).toHaveLength(2);
    await hub.close();
  });
});
