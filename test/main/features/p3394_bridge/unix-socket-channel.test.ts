import * as fs from 'node:fs';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  P3394UnixSocketChannel,
} from '../../../../src/main/features/p3394_bridge/unix-socket-channel';

let tmpDir: string;
let counter = 0;

function socketPath(prefix: string): string {
  counter += 1;
  return path.join(tmpDir, `${prefix}-${process.pid}-${counter}.sock`);
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    spec_version: 'p3394/1.0',
    message_id: `msg-${counter}`,
    session_id: 'ses-sock-1',
    task_id: 'tsk-sock-1',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'remote-agent' },
    recipients: [{ agent_id: 'cogseed-agent' }],
    payload: { parts: [{ type: 'text', text: 'hello over socket' }] },
    idempotency_key: `idem-sock-${counter}`,
    ...overrides,
  } as never;
}

async function waitFor(probe: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-sock-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P3394UnixSocketChannel real transport', () => {
  it('completes a request-reply exchange across independent Node processes', async () => {
    const requestPath = socketPath('proc-request');
    const replyPath = socketPath('proc-reply');
    const server = new P3394UnixSocketChannel('parent-a', { socketPath: requestPath, token: 'tok-a' });
    await server.listen();

    const childScript = `
      const net = require('node:net');
      const frame = (value) => { const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); };
      const request = net.createConnection(process.env.P3394_REQUEST_PATH);
      const replyServer = net.createServer((socket) => {
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 4) {
            const size = buffer.readUInt32BE(0);
            if (buffer.length < size + 4) return;
            const incoming = JSON.parse(buffer.subarray(4, size + 4).toString());
            buffer = buffer.subarray(size + 4);
            if (incoming.t === 'envelope' && incoming.envelope.reply_to === 'proc-request-1') process.exit(0);
          }
        });
      });
      replyServer.listen(process.env.P3394_REPLY_PATH, () => {
        request.on('connect', () => {
          request.write(frame({ t: 'auth', token: 'tok-a' }));
          request.write(frame({ t: 'envelope', envelope: { spec_version: 'p3394/1.0', message_id: 'proc-request-1', session_id: 'proc-session-1', task_id: 'proc-task-1', kind: 'task', performative: 'request', sender: { agent_id: 'child-b' }, recipients: [{ agent_id: 'parent-a' }], payload: { parts: [{ type: 'text', text: 'from child' }] }, idempotency_key: 'proc-idem-1' } }));
        });
      });
      setTimeout(() => process.exit(2), 4000);
    `;
    const child = spawn(process.env.COGSEED_TEST_NODE || process.execPath, ['--input-type=commonjs', '--eval', childScript], {
      env: { ...process.env, P3394_REQUEST_PATH: requestPath, P3394_REPLY_PATH: replyPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childStderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { childStderr += chunk; });
    const request = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child request timeout: ${childStderr}`)), 5000);
      server.subscribe((e) => { clearTimeout(timer); resolve(e); });
    });
    expect(request.sender.agent_id).toBe('child-b');
    const replyClient = new P3394UnixSocketChannel('parent-a-reply', { socketPath: replyPath, token: 'tok-b' });
    await waitFor(() => fs.existsSync(replyPath));
    await replyClient.send({ spec_version: 'p3394/1.0', message_id: 'proc-reply-1', session_id: request.session_id, task_id: request.task_id, kind: 'message', performative: 'inform', sender: { agent_id: 'parent-a' }, recipients: [{ agent_id: 'child-b' }], payload: { parts: [{ type: 'text', text: 'from parent' }] }, reply_to: request.message_id, idempotency_key: 'proc-reply-idem-1' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not exit: ${childStderr}`)), 5000);
      child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${childStderr}`)); });
    });
    await replyClient.close();
    await server.close();
  });

  it('delivers envelopes across a real unix socket round trip', async () => {
    const p = socketPath('rt');
    const server = new P3394UnixSocketChannel('server', { socketPath: p, token: 'tok' });
    const client = new P3394UnixSocketChannel('client', { socketPath: p, token: 'tok', reconnectBaseMs: 50 });
    const received: string[] = [];
    server.subscribe((e) => received.push(e.message_id));
    await server.listen();
    await client.dial();
    await client.send(envelope({ message_id: 'msg-rt-1' }));
    await waitFor(() => received.includes('msg-rt-1'));
    expect(received).toContain('msg-rt-1');
    await client.close();
    await server.close();
  });

  it('rejects a peer with a wrong token (fail-closed) and keeps serving others', async () => {
    const p = socketPath('auth');
    const server = new P3394UnixSocketChannel('server', { socketPath: p, token: 'secret' });
    const received: string[] = [];
    server.subscribe((e) => received.push(e.message_id));
    await server.listen();

    // Bad token: dial succeeds at TCP level but the server destroys the socket.
    const bad = net.createConnection(p);
    const badBody = Buffer.from(JSON.stringify({ t: 'auth', token: 'wrong' }), 'utf8');
    const badHeader = Buffer.alloc(4);
    badHeader.writeUInt32BE(badBody.length, 0);
    bad.on('error', () => {}); // server destroys us mid-write → EPIPE is expected
    bad.write(Buffer.concat([badHeader, badBody]));
    const badClosed = new Promise<void>((resolve) => { bad.on('close', () => resolve()); });
    await Promise.race([badClosed, new Promise((resolve) => setTimeout(resolve, 1500))]);

    // Good token still works after the failed attempt.
    const good = new P3394UnixSocketChannel('client', { socketPath: p, token: 'secret' });
    await good.dial();
    await good.send(envelope({ message_id: 'msg-auth-ok' }));
    await waitFor(() => received.includes('msg-auth-ok'));
    expect(received).toEqual(['msg-auth-ok']);
    await good.close();
    await server.close();
  });

  it('handles a framed stream with multiple envelopes in one write (no stickiness)', async () => {
    const p = socketPath('frame');
    const server = new P3394UnixSocketChannel('server', { socketPath: p, token: 'tok' });
    const received: string[] = [];
    server.subscribe((e) => received.push(e.message_id));
    await server.listen();

    // Hand-roll three frames concatenated in a single TCP write.
    const raw = net.createConnection(p);
    const frames: Buffer[] = [];
    for (const id of ['msg-a', 'msg-b', 'msg-c']) {
      const body = Buffer.from(JSON.stringify({ t: 'envelope', envelope: envelope({ message_id: id }) }), 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length, 0);
      frames.push(header, body);
    }
    const authed = new Promise<void>((resolve) => {
      const authBody = Buffer.from(JSON.stringify({ t: 'auth', token: 'tok' }), 'utf8');
      const authHeader = Buffer.alloc(4);
      authHeader.writeUInt32BE(authBody.length, 0);
      raw.on('connect', () => {
        raw.write(Buffer.concat([authHeader, authBody]));
        setTimeout(() => resolve(), 100);
      });
    });
    await authed;
    raw.write(Buffer.concat(frames));
    await waitFor(() => received.length >= 3);
    expect(received).toEqual(['msg-a', 'msg-b', 'msg-c']);
    raw.destroy();
    await server.close();
  });

  it('fails fast when pending outbound frames reach the backpressure limit', async () => {
    const p = socketPath('backpressure');
    const server = new P3394UnixSocketChannel('server', { socketPath: p, token: 'tok' });
    await server.listen();
    const client = new P3394UnixSocketChannel('client', { socketPath: p, token: 'tok', maxPendingFrames: 1 });
    await client.dial();
    await client.send(envelope({ message_id: 'msg-pressure-1' }));
    await expect(client.send(envelope({ message_id: 'msg-pressure-2' }))).rejects.toThrow('p3394_channel_backpressure');
    await client.close();
    await server.close();
  });

  it('destroys the connection on an oversized frame', async () => {
    const p = socketPath('max');
    const server = new P3394UnixSocketChannel('server', { socketPath: p, token: 'tok', maxFrameBytes: 128 });
    await server.listen();

    const raw = net.createConnection(p);
    raw.on('error', () => {}); // server destroys us mid-write → EPIPE is expected
    const closed = new Promise<void>((resolve) => { raw.on('close', () => resolve()); });
    const authBody = Buffer.from(JSON.stringify({ t: 'auth', token: 'tok' }), 'utf8');
    const authHeader = Buffer.alloc(4);
    authHeader.writeUInt32BE(authBody.length, 0);
    raw.on('connect', () => raw.write(Buffer.concat([authHeader, authBody])));
    await waitFor(() => raw.readyState === 'open', 1500);
    // Oversized frame: header claims 10k bytes while the server caps at 128.
    const big = Buffer.alloc(10000, 1);
    const bigHeader = Buffer.alloc(4);
    bigHeader.writeUInt32BE(big.length, 0);
    raw.write(Buffer.concat([bigHeader, big]));
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1500))]);
    expect(raw.destroyed).toBe(true);
    await server.close();
  });

  /* Unflushed-frame fault injection remains disabled: a raw peer cannot
   * deterministically distinguish socket flush from peer processing.
   * The channel cache is covered by the reconnect implementation and the
   * business idempotency/replay tests. */
  /* it('replays an unflushed envelope after reconnect with the same message id', async () => {
    const p = socketPath('unflushed');
    const token = 'tok';
    let dropServer: net.Server | null = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const size = buffer.readUInt32BE(0);
          if (buffer.length < size + 4) return;
          const frame = JSON.parse(buffer.subarray(4, size + 4).toString('utf8')) as { t?: string };
          buffer = buffer.subarray(size + 4);
          if (frame.t === 'envelope') socket.destroy();
        }
      });
    });
    await new Promise<void>((resolve) => dropServer?.listen(p, resolve));
    const client = new P3394UnixSocketChannel('unflushed-client', { socketPath: p, token, reconnectBaseMs: 30 });
    await client.dial();
    const pending = envelope({ message_id: 'msg-unflushed-1', idempotency_key: 'idem-unflushed-1' });
    await client.send(pending);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise<void>((resolve) => dropServer?.close(() => resolve()));
    dropServer = null;

    const received: string[] = [];
    const server = new P3394UnixSocketChannel('unflushed-server', { socketPath: p, token });
    server.subscribe((receivedEnvelope) => received.push(receivedEnvelope.message_id));
    await server.listen();
    await waitFor(() => received.includes('msg-unflushed-1'), 6000);
    expect(received).toEqual(['msg-unflushed-1']);
    await client.close();
    await server.close();
  }); */

  it('reconnects the dialer after the server restarts', async () => {
    const p = socketPath('reconn');
    const token = 'tok';
    const server = new P3394UnixSocketChannel('server', { socketPath: p, token });
    const received: string[] = [];
    server.subscribe((e) => received.push(e.message_id));
    await server.listen();

    const client = new P3394UnixSocketChannel('client', { socketPath: p, token, reconnectBaseMs: 50 });
    await client.dial();
    await client.send(envelope({ message_id: 'msg-before' }));
    await waitFor(() => received.includes('msg-before'));

    // Stop the server (socket file removed), then restart on the same path.
    await server.close();
    const server2 = new P3394UnixSocketChannel('server2', { socketPath: p, token });
    server2.subscribe((e) => received.push(e.message_id));
    await server2.listen();
    // Client retries with backoff; poll-send until the path recovers.
    await waitFor(() => {
      void client.send(envelope({ message_id: 'msg-after' })).catch(() => {});
      return received.includes('msg-after');
    }, 6000);
    await client.close();
    await server2.close();
  });

  it('dialer shutdown preserves a shared listener socket for later peers', async () => {
    const p = socketPath('shared-lifecycle');
    const received: string[] = [];
    const server = new P3394UnixSocketChannel('server', { socketPath: p, token: 'tok' });
    server.subscribe((e) => received.push(e.message_id));
    await server.listen();
    const first = new P3394UnixSocketChannel('first-dialer', { socketPath: p, token: 'tok' });
    await first.dial();
    await first.send(envelope({ message_id: 'msg-shared-1' }));
    await waitFor(() => received.includes('msg-shared-1'));
    await first.close();
    expect(fs.existsSync(p)).toBe(true);

    const second = new P3394UnixSocketChannel('second-dialer', { socketPath: p, token: 'tok' });
    await second.dial();
    await second.send(envelope({ message_id: 'msg-shared-2' }));
    await waitFor(() => received.includes('msg-shared-2'));
    await second.close();
    expect(fs.existsSync(p)).toBe(true);
    await server.close();
    expect(fs.existsSync(p)).toBe(false);
  });

  it('graceful shutdown removes the socket file and refuses new sends', async () => {
    const p = socketPath('shutdown');
    const server = new P3394UnixSocketChannel('server', { socketPath: p, token: 'tok' });
    await server.listen();
    expect(fs.existsSync(p)).toBe(true);
    const client = new P3394UnixSocketChannel('client', { socketPath: p, token: 'tok' });
    await client.dial();
    await server.close();
    await client.close();
    expect(fs.existsSync(p)).toBe(false);
    await expect(server.send(envelope({ message_id: 'msg-late' }))).rejects.toThrow();
  });
});
