#!/usr/bin/env node
/**
 * Local A2A hub mock (dev only).
 *
 * The real hub is the account service plus contacts/presence/a2a modules (see
 * 《A2A通讯录MVP-需Hub确认事项》 H-01/H-04). That code is not available in this
 * checkout, so this process stands in for it while the client is built: same routes,
 * same shapes, in-memory state, no auth beyond the account header.
 *
 * It exists to make the *client* flows that need a second party testable — an
 * incoming request, an accept, a presence flip — which a single-machine local store
 * can never produce on its own.
 *
 * Usage:
 *   node scripts/dev/a2a-hub-mock.cjs --port 8790 \
 *     --user <uidA>:13800001234:Alice --user <uidB>:13900005678:Bob
 *
 * Routes (all JSON, account identified by `x-a2a-user`):
 *   POST /lookup                    {phone} -> {registered, discoverable, is_contact}
 *   GET  /contacts                  -> {contacts:[{userId,name,phoneMasked,online}]}
 *   POST /contacts/requests         {phone, note?} -> {request}
 *   GET  /contacts/requests         -> {requests:[{...,direction:'in'|'out'}]}
 *   POST /contacts/requests/:id/accept | /reject -> {request}
 *   DELETE /contacts/:userId        -> {removed:boolean}
 *   POST /presence                  -> {ok:true}
 *   GET  /health                    -> {ok:true, users:n}
 */
'use strict';

const http = require('node:http');

const ONLINE_WINDOW_MS = 120 * 1000;
const REQUEST_TTL_MS = 30 * 60 * 1000;

function parseArgs(argv) {
  const out = { port: 8790, users: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') { out.port = Number(argv[++i]) || out.port; }
    else if (arg === '--user') {
      const raw = String(argv[++i] || '');
      const [uid, phone, name] = raw.split(':');
      if (uid && phone) out.users.push({ uid, phone, name: name || uid });
    }
  }
  if (!out.users.length) {
    // Defaults let `node scripts/dev/a2a-hub-mock.cjs` be useful immediately.
    out.users.push({ uid: 'alice', phone: '13800001234', name: 'Alice' });
    out.users.push({ uid: 'bob', phone: '13900005678', name: 'Bob' });
  }
  return out;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 7 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : digits;
}

function createHub(users) {
  const byUid = new Map();
  const phoneIndex = new Map();
  for (const user of users) {
    byUid.set(user.uid, {
      uid: user.uid,
      phone: user.phone,
      name: user.name,
      discoverable: true,
      acceptQuestions: true,
      lastSeen: 0,
    });
    phoneIndex.set(String(user.phone).replace(/\D/g, ''), user.uid);
  }
  const contacts = new Set(); // "a|b" sorted
  const requests = [];
  let seq = 0;

  const pairKey = (a, b) => [a, b].sort().join('|');
  const isContact = (a, b) => contacts.has(pairKey(a, b));
  const now = () => Date.now();
  const online = (uid) => {
    const user = byUid.get(uid);
    return !!user && now() - user.lastSeen < ONLINE_WINDOW_MS;
  };

  function lookup(as, phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    const uid = phoneIndex.get(digits);
    if (!uid) return { registered: false, discoverable: false, is_contact: false };
    const user = byUid.get(uid);
    return {
      registered: true,
      discoverable: !!user.discoverable,
      is_contact: isContact(as, uid),
    };
  }

  function listContacts(as) {
    const out = [];
    for (const key of contacts) {
      const [a, b] = key.split('|');
      if (a !== as && b !== as) continue;
      const other = byUid.get(a === as ? b : a);
      if (!other) continue;
      out.push({ userId: other.uid, name: other.name, phoneMasked: maskPhone(other.phone), online: online(other.uid) });
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
  }

  function requestAdd(as, phone, note) {
    const digits = String(phone || '').replace(/\D/g, '');
    const target = phoneIndex.get(digits);
    if (!target) return { error: 'not_registered' };
    if (target === as) return { error: 'self' };
    if (isContact(as, target)) return { error: 'already_contact' };
    const pending = requests.find((row) => row.state === 'pending' && row.from === as && row.to === target);
    if (pending) return { request: pending };
    const created = {
      id: `hreq-${(seq += 1)}`,
      from: as,
      to: target,
      phoneMasked: maskPhone(digits),
      note: note ? String(note).slice(0, 200) : '',
      state: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(now() + REQUEST_TTL_MS).toISOString(),
    };
    requests.push(created);
    return { request: created };
  }

  function project(request, as) {
    const outgoing = request.from === as;
    const peer = byUid.get(outgoing ? request.to : request.from);
    const expired = request.state === 'pending' && Date.parse(request.expiresAt) <= now();
    return {
      id: request.id,
      direction: outgoing ? 'out' : 'in',
      peerUserId: peer ? peer.uid : '',
      peerName: peer ? peer.name : '',
      phoneMasked: request.phoneMasked,
      note: request.note,
      state: expired ? 'expired' : request.state,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    };
  }

  function listRequests(as) {
    return requests
      .filter((row) => row.from === as || row.to === as)
      .map((row) => project(row, as))
      .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
  }

  function decide(as, id, accept) {
    const request = requests.find((row) => row.id === id);
    if (!request) return { error: 'not_found' };
    // Only the addressee decides; the sender can never accept their own request.
    if (request.to !== as) return { error: 'not_addressee' };
    if (request.state !== 'pending') return { error: 'not_pending' };
    if (Date.parse(request.expiresAt) <= now()) {
      request.state = 'expired';
      return { error: 'expired' };
    }
    request.state = accept ? 'accepted' : 'rejected';
    if (accept) contacts.add(pairKey(request.from, request.to));
    return { request: project(request, as) };
  }

  function remove(as, userId) {
    const key = pairKey(as, userId);
    if (!contacts.has(key)) return { removed: false };
    contacts.delete(key);
    return { removed: true };
  }

  return {
    lookup,
    listContacts,
    requestAdd,
    listRequests,
    decide,
    remove,
    touch(uid) {
      const user = byUid.get(uid);
      if (user) user.lastSeen = now();
      return !!user;
    },
    stats: () => ({ users: byUid.size, contacts: contacts.size, requests: requests.length }),
  };
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function start(options) {
  const hub = createHub(options.users);
  const server = http.createServer(async (req, res) => {
    const as = String(req.headers['x-a2a-user'] || '');
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/health') return send(res, 200, { ok: true, ...hub.stats() });
    // ── 客户端契约（/api/v1/a2a/*，Bearer 令牌即账号 id）──────────────
    // 客户端 hub-client 用的是 Hub 的正式路径与 Authorization 头；这里做一层薄适配，
    // 让同一份客户端代码既能连真 Hub，也能连这个本地 mock。
    if (path.startsWith('/api/v1/a2a/')) {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const uid = bearer || as;
      if (!uid) return send(res, 401, { ok: false, error: { code: 'AUTH_MISSING_TOKEN' } });
      hub.touch(uid);
      const rest = path.slice('/api/v1/a2a'.length);
      if (rest === '/lookup' && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, { ok: true, data: hub.lookup(uid, body.phone) });
      }
      if (rest === '/contacts' && req.method === 'GET') {
        return send(res, 200, { ok: true, data: { contacts: hub.listContacts(uid) } });
      }
      if (rest === '/contacts/requests' && req.method === 'POST') {
        const body = await readBody(req);
        const result = hub.requestAdd(uid, body.phone, body.note);
        if (result.error) {
          const code = result.error.toUpperCase();
          return send(res, result.error === 'not_registered' ? 404 : 400, { ok: false, error: { code } });
        }
        return send(res, 200, { ok: true, data: { requestId: result.request.id, state: result.request.state } });
      }
      if (rest === '/contacts/requests' && req.method === 'GET') {
        const rows = hub.listRequests(uid).map((row) => ({
          requestId: row.id,
          direction: row.direction,
          peerAccountId: row.peerUserId,
          phoneMasked: row.phoneMasked,
          note: row.note,
          state: row.state,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        }));
        return send(res, 200, { ok: true, data: { requests: rows } });
      }
      const decide = rest.match(/^\/contacts\/requests\/([^/]+)\/(accept|reject)$/);
      if (decide) {
        const result = hub.decide(uid, decodeURIComponent(decide[1]), decide[2] === 'accept');
        if (result.error) {
          return send(res, result.error === 'not_addressee' ? 403 : 409, { ok: false, error: { code: result.error.toUpperCase() } });
        }
        return send(res, 200, { ok: true, data: { requestId: result.request.id, state: result.request.state } });
      }
      const del = rest.match(/^\/contacts\/([^/]+)$/);
      if (del && req.method === 'DELETE') {
        return send(res, 200, { ok: true, data: hub.remove(uid, decodeURIComponent(del[1])) });
      }
      if (rest === '/presence' && req.method === 'POST') return send(res, 200, { ok: true, data: {} });
      return send(res, 404, { ok: false, error: { code: 'NOT_FOUND' } });
    }


    if (!as) return send(res, 401, { ok: false, error: 'missing x-a2a-user' });
    hub.touch(as);

    if (path === '/presence' && req.method === 'POST') return send(res, 200, { ok: true });

    if (path === '/lookup' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, hub.lookup(as, body.phone));
    }
    if (path === '/contacts' && req.method === 'GET') {
      return send(res, 200, { contacts: hub.listContacts(as) });
    }
    if (path === '/contacts/requests' && req.method === 'POST') {
      const body = await readBody(req);
      const result = hub.requestAdd(as, body.phone, body.note);
      if (result.error) return send(res, 400, { ok: false, error: result.error });
      return send(res, 200, { request: result.request });
    }
    if (path === '/contacts/requests' && req.method === 'GET') {
      return send(res, 200, { requests: hub.listRequests(as) });
    }
    const decideMatch = path.match(/^\/contacts\/requests\/([^/]+)\/(accept|reject)$/);
    if (decideMatch) {
      const result = hub.decide(as, decodeURIComponent(decideMatch[1]), decideMatch[2] === 'accept');
      if (result.error) return send(res, 409, { ok: false, error: result.error });
      return send(res, 200, { request: result.request });
    }
    const removeMatch = path.match(/^\/contacts\/([^/]+)$/);
    if (removeMatch && req.method === 'DELETE') {
      return send(res, 200, hub.remove(as, decodeURIComponent(removeMatch[1])));
    }
    return send(res, 404, { ok: false, error: 'not_found' });
  });
  return new Promise((resolve) => {
    server.listen(options.port, '127.0.0.1', () => resolve(server));
  });
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  start(options).then(() => {
    const list = options.users.map((u) => `${u.name}(${u.uid}/${u.phone})`).join(', ');
    console.log(`[a2a-hub-mock] http://127.0.0.1:${options.port} · users: ${list}`);
  }).catch((error) => {
    console.error('[a2a-hub-mock] failed to start:', error && error.message);
    process.exit(1);
  });
}

module.exports = { start, createHub, maskPhone };
