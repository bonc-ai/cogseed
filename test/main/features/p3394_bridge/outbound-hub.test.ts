import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { P3394OutboundHub, p3394EnvelopeReplyText } from '../../../../src/main/features/p3394_bridge/outbound-hub';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';
import type { P3394PeerRecord } from '../../../../src/main/features/p3394_bridge/registry';

function envelope(overrides: Record<string, unknown> = {}): P3394Envelope {
  return {
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
  let endpoints: string[] = [];

  afterEach(async () => {
    for (const server of servers) server.close();
    servers = [];
    endpoints = [];
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
});
