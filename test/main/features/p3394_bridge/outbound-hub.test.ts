import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { P3394OutboundHub, p3394EnvelopeReplyText } from '../../../../src/main/features/p3394_bridge/outbound-hub';
import { outboxListForReplay, outboxRecordSubmitted } from '../../../../src/main/features/p3394_bridge/outbound-outbox';
import { p3394StateFile } from '../../../../src/main/features/p3394_bridge/runtime-paths';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';
import type { P3394PeerRecord } from '../../../../src/main/features/p3394_bridge/registry';

// 测试隔离：sendAndWait 会把 outbox 写到 p3394StateFile，必须走一次性
// variant，避免污染真实 cogseed variant 的 outbox（含转发 token 字段）。
let previousVariant: string | undefined;
let variantName: string;
beforeEach(() => {
  previousVariant = process.env.ORKAS_RUNTIME_VARIANT;
  variantName = 'p3394-out-' + Math.random().toString(36).slice(2, 8);
  process.env.ORKAS_RUNTIME_VARIANT = variantName;
});
afterEach(() => {
  if (previousVariant === undefined) delete process.env.ORKAS_RUNTIME_VARIANT;
  else process.env.ORKAS_RUNTIME_VARIANT = previousVariant;
  try { fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName), { recursive: true, force: true }); } catch { /* best effort */ }
});

function envelope(overrides: Record<string, unknown> = {}): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-out-1',
    session_id: 'ses-out-1',
    task_id: 'tsk-out-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'cogseed' },
    recipients: [{ agent_id: 'hermes' }],
    payload: { parts: [{ type: 'text', text: 'hello hermes' }] },
    idempotency_key: 'idem-out-1',
    ...overrides,
  } as never;
}

function replyEnvelope(): P3394Envelope {
  return envelope({
    message_id: 'msg-out-reply-1',
    sender: { agent_id: 'hermes' },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: 'hello cogseed, reply here' }] },
    idempotency_key: 'idem-out-reply-1',
  } as never);
}

function streamEnvelope(text: string, sequence: number, kind: 'delta' | 'progress' = 'delta'): P3394Envelope {
  return envelope({
    message_id: 'msg-out-stream-' + sequence,
    kind: 'event',
    performative: 'inform',
    sender: { agent_id: 'hermes' },
    recipients: [{ agent_id: 'cogseed' }],
    payload: {
      parts: [{ type: 'text', text }],
      metadata: { stream_event: kind, stream_seq: sequence },
    },
    idempotency_key: 'idem-out-stream-' + sequence,
  } as never);
}

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

describe('P3394OutboundHub (real HTTP against a mock peer)', () => {
  let servers: http.Server[] = [];
  const replayFile = p3394StateFile('p3394-outbox.jsonl');
  let endpoints: string[] = [];

  afterEach(async () => {
    for (const server of servers) server.close();
    servers = [];
    endpoints = [];
    try { fs.unlinkSync(replayFile); } catch { /* absent */ }
  });

  function startPeer(): Promise<string> {
    return new Promise((resolve) => {
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message_id: 'msg-out-1' }));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(0, '127.0.0.1', () => {
        servers.push(server);
        const address = server.address() as AddressInfo;
        resolve('http://127.0.0.1:' + address.port);
      });
    });
  }

  function hubFor(peers: P3394PeerRecord[], timeoutMs?: number): P3394OutboundHub {
    return new P3394OutboundHub({ listPeers: () => peers, replyTimeoutMs: timeoutMs ?? 5000 });
  }

  it('sends to a registered peer and resolves its inbound reply by session id', async () => {
    const endpoint = await startPeer();
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      endpoints: [endpoint],
      updated_at: new Date().toISOString(),
    };
    const hub = hubFor([peer]);
    const sendPromise = hub.sendAndWait('hermes', envelope());
    const reply = await hub.tryResolveReply(replyEnvelope());
    expect(reply).toBe(true);
    const result = await sendPromise;
    expect(result.text).toBe('hello cogseed, reply here');
    expect(p3394EnvelopeReplyText(replyEnvelope())).toBe('hello cogseed, reply here');
  });

  it('S-04: does not consume a same-session inbound when reply_to points elsewhere (no swallowed new task)', async () => {

    const endpoint = await startPeer();
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      endpoints: [endpoint],
      updated_at: new Date().toISOString(),
    };
    const hub = hubFor([peer]);
    const sendPromise = hub.sendAndWait('hermes', envelope());
    // 同 session、但 reply_to 指向其它消息 → 不被当回复消费（防误吞新 task）。
    const newTask = envelope({
      message_id: 'msg-new-task-1',
      session_id: 'ses-out-1',
      task_id: 'tsk-new-task-1',
      reply_to: 'msg-still-elsewhere',
      performative: 'request',
      sender: { agent_id: 'hermes' },
      recipients: [{ agent_id: 'cogseed' }],
    } as never);
    expect(await hub.tryResolveReply(newTask)).toBe(false);
    // waiter 仍在：与 outboundMessageId 匹配的 reply_to 才被消费。
    const matching = replyEnvelope({ reply_to: 'msg-out-1' } as never);
    expect(await hub.tryResolveReply(matching)).toBe(true);
    const result = await sendPromise;
    expect(result.text).toBe('hello cogseed, reply here');
  });

  it('forwards stream events without resolving or executing the terminal waiter', async () => {

    const endpoint = await startPeer();
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      endpoints: [endpoint],
      updated_at: new Date().toISOString(),
    };
    const hub = hubFor([peer]);
    const chunks: string[] = [];
    const sendPromise = hub.sendAndWait('hermes', envelope(), (event) => chunks.push(event.text));
    expect(hub.tryResolveReply(streamEnvelope('hello ', 1))).toBe(true);
    expect(hub.tryResolveReply(streamEnvelope('hello ', 1))).toBe(true);
    expect(hub.tryResolveReply(streamEnvelope('world', 2))).toBe(true);
    expect(hub.tryResolveReply(replyEnvelope())).toBe(true);
    const result = await sendPromise;
    expect(chunks).toEqual(['hello ', 'world']);
    expect(result.text).toBe('hello cogseed, reply here');
  });

  it('forwards progress frames to the process rail without resolving the waiter', async () => {
    const endpoint = await startPeer();
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      endpoints: [endpoint],
      updated_at: new Date().toISOString(),
    };
    const hub = hubFor([peer]);
    const events: Array<{ kind: string; text: string }> = [];
    const sendPromise = hub.sendAndWait('hermes', envelope(), (event) => events.push({ kind: event.kind, text: event.text }));
    // openclaw 网关的过程日志帧（[skills]/[tools]）→ kind: progress。
    expect(hub.tryResolveReply(streamEnvelope('[tools] run bash build', 1, 'progress'))).toBe(true);
    expect(hub.tryResolveReply(streamEnvelope('[skills] web_search', 2, 'progress'))).toBe(true);
    expect(hub.tryResolveReply(replyEnvelope())).toBe(true);
    const result = await sendPromise;
    expect(events).toEqual([
      { kind: 'progress', text: '[tools] run bash build' },
      { kind: 'progress', text: '[skills] web_search' },
    ]);
    // progress 帧不消费终态 waiter：终态回复仍正常 resolve。
    expect(result.text).toBe('hello cogseed, reply here');
  });

  it('replays a submitted envelope after the peer becomes available', async () => {
    const pending = envelope({ message_id: 'msg-recover-1', session_id: 'ses-recover-1', task_id: 'tsk-recover-1', idempotency_key: 'idem-recover-1' });
    outboxRecordSubmitted(pending, 'hermes');
    expect(outboxListForReplay()).toHaveLength(1);
    const endpoint = await startPeer();
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [], manifest: MANIFEST as never, endpoints: [endpoint], updated_at: new Date().toISOString(),
    };
    const hub = hubFor([peer]);
    const result = await hub.replayOutbox();
    expect(result).toEqual({ replayed: 1, failed: 0 });
    expect(outboxListForReplay()).toMatchObject([{ message_id: 'msg-recover-1', status: 'sent' }]);
  });

  it('keeps a failed replay eligible after a temporary peer outage', async () => {
    const pending = envelope({ message_id: 'msg-deferred-1', session_id: 'ses-deferred-1', task_id: 'tsk-deferred-1', idempotency_key: 'idem-deferred-1' });
    outboxRecordSubmitted(pending, 'hermes');
    const unavailable = hubFor([]);
    await expect(unavailable.replayOutbox()).resolves.toEqual({ replayed: 0, failed: 1 });
    expect(outboxListForReplay()).toMatchObject([{ message_id: 'msg-deferred-1', status: 'submitted' }]);

    const endpoint = await startPeer();
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [], manifest: MANIFEST as never, endpoints: [endpoint], updated_at: new Date().toISOString(),
    };
    await expect(hubFor([peer]).replayOutbox()).resolves.toEqual({ replayed: 1, failed: 0 });
    expect(outboxListForReplay()).toMatchObject([{ message_id: 'msg-deferred-1', status: 'sent' }]);
  });

  it('rejects unknown peers and peers without endpoints', async () => {
    const hub = hubFor([]);
    await expect(hub.sendAndWait('unknown', envelope())).rejects.toThrow('p3394_peer_not_registered');
    const noEndpoint: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      updated_at: new Date().toISOString(),
    };
    await expect(hubFor([noEndpoint]).sendAndWait('hermes', envelope())).rejects.toThrow('p3394_peer_has_no_endpoint');
  });

  it('times out when no reply arrives', async () => {
    const endpoint = await startPeer();
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      endpoints: [endpoint],
      updated_at: new Date().toISOString(),
    };
    const hub = hubFor([peer], 120);
    await expect(hub.sendAndWait('hermes', envelope())).rejects.toThrow('p3394_reply_timeout');
  });

  it('reports a busy session and waits for it to drain (second-turn queueing)', async () => {
    const endpoint = await startPeer();
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      endpoints: [endpoint],
      updated_at: new Date().toISOString(),
    };
    const hub = hubFor([peer], 5000);
    const sendPromise = hub.sendAndWait('hermes', envelope());

    // 上一轮信封在途：同 session 视为 busy，且第二次 sendAndWait 会冲突。
    expect(hub.isSessionBusy('ses-out-1')).toBe(true);
    await expect(hub.sendAndWait('hermes', envelope())).rejects.toThrow('p3394_session_conflict');

    // 等上一轮排空：回复到达前 waitForSessionFree 未结束，到达后立刻放行。
    const waitPromise = hub.waitForSessionFree('ses-out-1');
    expect(await hub.tryResolveReply(replyEnvelope())).toBe(true);
    expect(await sendPromise).toMatchObject({ text: 'hello cogseed, reply here' });
    expect(await waitPromise).toBe(true);
    expect(hub.isSessionBusy('ses-out-1')).toBe(false);
  });

  it('waitForSessionFree returns false when the session never drains within the cap', async () => {
    const endpoint = await startPeer();
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      endpoints: [endpoint],
      updated_at: new Date().toISOString(),
    };
    const hub = hubFor([peer], 5000);
    const sendPromise = hub.sendAndWait('hermes', envelope());
    expect(hub.isSessionBusy('ses-out-1')).toBe(true);

    const start = Date.now();
    const drained = await hub.waitForSessionFree('ses-out-1', 80);
    expect(drained).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(60);

    // 收尾：清掉 waiter，避免残留计时器。
    const reply = replyEnvelope();
    expect(await hub.tryResolveReply(reply)).toBe(true);
    await sendPromise;
  });

  it('waitForSessionFree returns false immediately when the caller aborts', async () => {
    const endpoint = await startPeer();
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      endpoints: [endpoint],
      updated_at: new Date().toISOString(),
    };
    const hub = hubFor([peer], 5000);
    const sendPromise = hub.sendAndWait('hermes', envelope());
    expect(hub.isSessionBusy('ses-out-1')).toBe(true);

    // 用户取消：等待必须立即放行，而不是拖满超时窗口。
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const drained = await hub.waitForSessionFree('ses-out-1', 5_000, controller.signal);
    expect(drained).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);

    // 收尾：清掉 waiter，避免残留计时器。
    const reply = replyEnvelope();
    expect(await hub.tryResolveReply(reply)).toBe(true);
    await sendPromise;
  });

  it('P1-3: sendOnce delivers and completes the outbox record — no pending waiter, no replay residue', async () => {
    const endpoint = await startPeer();
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      endpoints: [endpoint],
      updated_at: new Date().toISOString(),
    };
    const hub = hubFor([peer], 5000);

    await hub.sendOnce('hermes', envelope({ message_id: 'msg-fire-1', session_id: 'ses-fire-1', task_id: 'tsk-fire-1', idempotency_key: 'idem-fire-1' }));

    // 送达回执即终态：记录 completed → 离开重放集，重启后不会被再次发送。
    expect(outboxListForReplay()).not.toContainEqual(expect.objectContaining({ message_id: 'msg-fire-1' }));
    // 没有登记回复 waiter：收到同 session 的「回复」不会命中任何 pending
    // （清理断言——旧的 sendAndWait 中继会遗留一个完整超时周期的 waiter）。
    expect(hub.tryResolveReply(replyEnvelope({ message_id: 'msg-fire-reply-1', session_id: 'ses-fire-1', reply_to: 'msg-fire-1' }))).toBe(false);
  });

  it('P1-3: sendOnce fails closed — a delivery error is surfaced, not swallowed', async () => {
    const peer: P3394PeerRecord = {
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      aliases: [],
      manifest: MANIFEST as never,
      // 拒绝连接的端点：dial 立即失败（ECONNREFUSED）。
      endpoints: ['http://127.0.0.1:1'],
      updated_at: new Date().toISOString(),
    };
    const hub = hubFor([peer], 2000);

    await expect(hub.sendOnce('hermes', envelope({ message_id: 'msg-fire-fail-1', session_id: 'ses-fire-fail-1', task_id: 'tsk-fire-fail-1', idempotency_key: 'idem-fire-fail-1' })))
      .rejects.toThrow();
    // 失败后记录被标记 failed → 同样离开重放集（不会在重启后无限重发）。
    expect(outboxListForReplay()).not.toContainEqual(expect.objectContaining({ message_id: 'msg-fire-fail-1' }));
  });
});
