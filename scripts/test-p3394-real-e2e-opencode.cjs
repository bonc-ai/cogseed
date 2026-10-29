#!/usr/bin/env node
/**
 * Real OpenCode acceptance through the running app's managed persistent gateway.
 * Start CogSeed and connect OpenCode first. No replacement gateway is registered
 * and the app's gateway is left running. Two turns verify final delivery,
 * streaming and conversation continuity. Optional COGSEED_E2E_OPENCODE_MODEL
 * selects a provider/model; otherwise the CLI's configured default is used.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { resolveE2eBin, cogseedStateFilePath } = require('./p3394-e2e-common.cjs');

if (process.argv.includes('--list-bin')) {
  const bin = resolveE2eBin('opencode', { envKey: 'COGSEED_E2E_OPENCODE_BIN', macDefault: '/opt/homebrew/bin/opencode' });
  console.log(bin || '(not found)');
  process.exit(bin ? 0 : 1);
}

async function main() {
  const registry = JSON.parse(fs.readFileSync(cogseedStateFilePath('p3394-peers.json'), 'utf8'));
  const peer = registry.peers.find((item) => item.identity?.agent_id === 'opencode');
  if (!peer?.endpoints?.[0]) throw new Error('Start CogSeed and connect OpenCode before this check');
  const endpoint = new URL(peer.endpoints[0]);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('Expected a local managed OpenCode gateway');
  const gatewayHeaders = peer.dial_token ? { authorization: 'Bearer ' + peer.dial_token } : {};
  const inspected = await fetch(new URL('/p3394/models', endpoint), { headers: gatewayHeaders, signal: AbortSignal.timeout(30000) }).then((response) => response.json());
  if (inspected.runtime !== 'opencode-persistent' || inspected.status !== 'ready') throw new Error('The managed persistent OpenCode runtime/model catalog is not ready');
  console.log('✓ Running CogSeed managed OpenCode gateway and model catalog');

  const nonce = crypto.randomBytes(6).toString('hex');
  const sessionId = 'ses-opencode-e2e-' + nonce;
  const token = 'OC-CONTEXT-' + nonce;
  const replyToken = crypto.randomBytes(24).toString('hex');
  const pending = new Map();
  let deltaCount = 0;
  const listener = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + replyToken) { res.writeHead(401); res.end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const envelope = JSON.parse(body).envelope;
      const waiter = pending.get(envelope.reply_to);
      if (waiter && envelope.session_id === sessionId && envelope.sender?.agent_id === 'opencode') {
        if (envelope.kind === 'event' && envelope.payload?.metadata?.stream_event === 'delta') deltaCount++;
        if (envelope.kind === 'message') waiter(envelope);
      }
      res.writeHead(200); res.end('{}');
    } catch { res.writeHead(400); res.end(); }
  });
  listener.on('error', (error) => { for (const waiter of pending.values()) waiter(null, error); });
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });

  async function turn(index, text) {
    const id = 'msg-opencode-e2e-' + nonce + '-' + index;
    let timer;
    const reply = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Real OpenCode reply timed out')), 120000);
      pending.set(id, (envelope, error) => error ? reject(error) : resolve(envelope));
    });
    // Attach a rejection handler before the HTTP send, including send failures.
    void reply.catch(() => {});
    const envelope = {
      spec_version: 'p3394/1.0', message_id: id, session_id: sessionId,
      task_id: 'tsk-opencode-e2e-' + nonce + '-' + index,
      kind: 'task', performative: 'request', role: 'requester',
      sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'opencode' }],
      payload: { parts: [{ type: 'text', text }] },
      extensions: {
        reply_endpoint: 'http://127.0.0.1:' + listener.address().port, reply_token: replyToken,
        ...(process.env.COGSEED_E2E_OPENCODE_MODEL ? { execution_prefs: { model: process.env.COGSEED_E2E_OPENCODE_MODEL } } : {}),
      },
      idempotency_key: 'idem-' + id,
    };
    try {
      const response = await fetch(new URL('/p3394/envelope', endpoint), {
        method: 'POST', headers: { ...gatewayHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ envelope }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Gateway delivery HTTP ' + response.status);
      const received = await reply;
      const result = received.payload.parts.filter((part) => part.type === 'text').map((part) => part.text).join('').trim();
      if (result.startsWith('[p3394_gateway_error]')) throw new Error(result);
      return result;
    } finally { clearTimeout(timer); pending.delete(id); }
  }

  try {
    const first = await turn(1, 'Remember this token for the next turn: ' + token + '. Reply with exactly: P3394-OPENCODE-E2E-OK');
    if (first !== 'P3394-OPENCODE-E2E-OK') throw new Error('Unexpected first reply: ' + first.slice(0, 120));
    console.log('✓ Real model reply: ' + first);
    const second = await turn(2, 'What token did I ask you to remember? Reply with the token only.');
    if (second !== token) throw new Error('Conversation continuity failed: ' + second.slice(0, 120));
    console.log('✓ Second turn recalls the token without replaying the previous reply');
    if (!deltaCount) throw new Error('No text delta reached the gateway callback');
    console.log('✓ Streaming text received (' + deltaCount + ' delta events)');
    console.log('OpenCode real acceptance: 4/4 passed');
  } finally {
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  }
}
main().catch((error) => { console.error('OpenCode real acceptance failed:', error.message); process.exitCode = 1; });
