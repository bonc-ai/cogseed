#!/usr/bin/env node
/**
 * A2A 本地演示（dev only）：对着真实 Hub account-service 跑一遍完整流程。
 *
 * 前置：
 *   1) Hub 仓克隆后起账号服务（PGlite，无需 Docker）：
 *        NODE_ENV=test HUB_ENABLED=true HUB_ACCOUNT_DATABASE_URL=:memory: \
 *        HUB_INTERNAL_ADMIN_KEY=<key> HUB_ACCOUNT_OPERATIONS_KEY=<key> \
 *        node --import tsx src/account-service/tests/browser-fixture.ts
 *   2) 本脚本默认连 http://127.0.0.1:4202（可用 A2A_HUB_URL 覆盖）。
 *
 * 演示内容：两个真实账号登录 → 查号 → 发申请 → 越权拦截 → 通过 → 双向联系人
 *          → 心跳与在线 → 对话请求 → 接受 → 未知号查找。
 * 全部走真实令牌与真实数据库，不是 mock。
 */
const BASE = process.env.A2A_HUB_URL || 'http://127.0.0.1:4202';
const log = (...a) => console.log('  ', ...a);

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function login(phone, name) {
  // state 必须由 /auth/login 签发（服务端校验未消费且未过期）。
  const stateRes = await call('/api/v1/auth/login?provider=web&redirect_uri=cogseed://account/callback');
  const state = stateRes.json?.data?.state;
  if (!state) throw new Error(`no state ${JSON.stringify(stateRes.json).slice(0, 160)}`);
  let r = await call('/api/v1/auth/sms/send', { method: 'POST', body: { country_code: 'CN', phone, agree: true, state } });
  if (!r.json.ok) throw new Error(`send failed ${JSON.stringify(r.json)}`);
  let smsCode = '';
  for (const candidate of [phone, `+86${phone}`]) {
    const codeRes = await (await fetch(`${BASE}/__fixture/code?phone=${encodeURIComponent(candidate)}`)).json();
    if (codeRes.code) { smsCode = codeRes.code; break; }
  }
  if (!smsCode) throw new Error('no sms code captured');
  r = await call('/api/v1/auth/sms/verify', { method: 'POST', body: { country_code: 'CN', phone, code: smsCode, state } });
  if (!r.json.ok) throw new Error(`verify failed ${JSON.stringify(r.json)}`);
  const exchange = r.json.data.code;
  const accountId = r.json.data.account_id;
  r = await call('/api/v1/auth/callback', { method: 'POST', body: { code: exchange, state, device_name: name, device_os: 'macOS' } });
  if (!r.json.ok) throw new Error(`callback failed ${JSON.stringify(r.json)}`);
  const token = r.json.data?.session?.access_token;
  if (!token) throw new Error(`no access token ${JSON.stringify(r.json).slice(0, 200)}`);
  return { token, accountId, phone };
}

// 每次演示用新号码：服务端是常驻内存库，复用旧号码会命中"已经是联系人"。
const stamp = String(Date.now()).slice(-8);
const phoneOf = (prefix) => `${prefix}${stamp}`;
const A = await login(phoneOf('138'), 'A');
const B = await login(phoneOf('139'), 'B');
log('A 登录', A.accountId);
log('B 登录', B.accountId);

// 1) A 查 B 手机号 → 三布尔
let r = await call('/api/v1/a2a/lookup', { method: 'POST', token: A.token, body: { phone: B.phone } });
log('A 查号 →', JSON.stringify(r.json.data));

// 2) A 发申请
r = await call('/api/v1/a2a/contacts/requests', { method: 'POST', token: A.token, body: { phone: B.phone, note: 'A2A demo' } });
log('A 发申请 →', JSON.stringify(r.json.data));
if (!r.json.ok) throw new Error(`发起申请失败 ${JSON.stringify(r.json.error)}`);
const requestId = r.json.data.requestId || r.json.data.request_id;

// 3) B 看到收到
r = await call('/api/v1/a2a/contacts/requests', { token: B.token });
log('B 收到的申请 →', JSON.stringify(r.json.data.requests.map(x => ({ dir: x.direction, state: x.state }))));

// 4) A 越权通过（应 403）
r = await call(`/api/v1/a2a/contacts/requests/${requestId}/accept`, { method: 'POST', token: A.token });
log('A 替 B 通过 →', r.status, JSON.stringify(r.json.error));

// 5) B 通过
r = await call(`/api/v1/a2a/contacts/requests/${requestId}/accept`, { method: 'POST', token: B.token });
log('B 通过 →', JSON.stringify(r.json.data));

// 6) 双方联系人
r = await call('/api/v1/a2a/contacts', { token: A.token });
log('A 的联系人 →', JSON.stringify(r.json.data.contacts));
r = await call('/api/v1/a2a/contacts', { token: B.token });
log('B 的联系人 →', JSON.stringify(r.json.data.contacts));

// 7) 在线状态
r = await call('/api/v1/a2a/presence', { method: 'POST', token: B.token });
log('B 心跳 →', JSON.stringify(r.json.data));
r = await call(`/api/v1/a2a/presence?ids=${B.accountId}`, { token: A.token });
log('A 查 B 在线 →', JSON.stringify(r.json.data.presence));

// 8) 对话请求：A 发起 → B 收到 → B 接受
r = await call('/api/v1/a2a/requests', { method: 'POST', token: A.token, body: { to: B.accountId } });
log('A 发起对话 →', JSON.stringify(r.json.data));
const convId = r.json.data.requestId || r.json.data.request_id;
r = await call(`/api/v1/a2a/requests/${convId}/accept`, { method: 'POST', token: B.token });
log('B 接受对话 →', JSON.stringify(r.json.data));

// 9) 配额与版本闸门
r = await call('/api/v1/a2a/lookup', { method: 'POST', token: A.token, body: { phone: '13700000000' } });
log('A 查未知号 →', JSON.stringify(r.json.data));
