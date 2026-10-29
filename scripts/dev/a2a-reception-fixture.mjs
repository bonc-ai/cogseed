#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
/**
 * A2A 接待真机走查的账号准备（dev only，不提交）：
 * 两个真实账号 + 互为联系人，打印客户端需要的 token 与账号 id。
 *
 * 用法：node scripts/dev/a2a-reception-fixture.mjs
 * 输出：JSON 一行 { A: {accountId, token, phone}, B: {...} }
 */
const BASE = process.env.A2A_HUB_URL || 'http://127.0.0.1:4202';
// 输出落在 ~/.cogseed/a2a-dev/（/tmp 会被系统清理，之前的 token 就丢过一次）。
const OUT_DIR = process.env.A2A_DEV_DIR || path.join(os.homedir(), '.cogseed', 'a2a-dev');

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
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function login(phone, name) {
  const stateRes = await call('/api/v1/auth/login?provider=web&redirect_uri=cogseed://account/callback');
  const state = stateRes?.data?.state;
  if (!state) throw new Error('no state');
  let r = await call('/api/v1/auth/sms/send', { method: 'POST', body: { country_code: 'CN', phone, agree: true, state } });
  let smsCode = '';
  for (const candidate of [phone, `+86${phone}`]) {
    const codeRes = await (await fetch(`${BASE}/__fixture/code?phone=${encodeURIComponent(candidate)}`)).json();
    if (codeRes.code) { smsCode = codeRes.code; break; }
  }
  if (!smsCode) throw new Error('no sms code');
  r = await call('/api/v1/auth/sms/verify', { method: 'POST', body: { country_code: 'CN', phone, code: smsCode, state } });
  const exchange = r.data.code;
  r = await call('/api/v1/auth/callback', { method: 'POST', body: { code: exchange, state, device_name: name, device_os: 'macOS' } });
  const token = r.data?.session?.access_token;
  if (!token) throw new Error('no token');
  return { token, accountId: r.data.account_id, phone };
}

/** 两个开关默认关（PRD FR-33）：这个 fixture 代表「两位用户都主动把开关打开了」，
 *  否则新账号既搜不到也问不了（这正是默认关的含义）。关系权威在 Hub。 */
async function ensurePair(a, b) {
  for (const who of [a, b]) {
    await call('/api/v1/consent/contacts.discoverable', { method: 'PUT', token: who.token });
    await call('/api/v1/consent/contacts.assistant_questions', { method: 'PUT', token: who.token });
  }
  const idOf = (row) => String(row.accountId || row.account_id || row.userId || '');
  const existing = await call('/api/v1/a2a/contacts', { token: a.token });
  const already = (existing.data?.contacts || []).some((row) => idOf(row) === b.accountId);
  if (!already) {
    try {
      const sent = await call('/api/v1/a2a/contacts/requests', { method: 'POST', token: a.token, body: { phone: b.phone, note: 'reception fixture' } });
      const requestId = sent.data.requestId || sent.data.request_id;
      await call(`/api/v1/a2a/contacts/requests/${requestId}/accept`, { method: 'POST', token: b.token });
    } catch (error) {
      // 已经是联系人（409 ALREADY_CONTACT）：关系已在，继续。
      if (!/ALREADY_CONTACT/.test(String(error && error.message))) throw error;
    }
  }
}

/**
 * `--relogin`：用 fixture.json 里保存的手机号重新登录同一对账号。
 *
 * Hub 撤销会话（客户端重启、同一设备再次登录等）后，旧 token 会 401，relay 轮询
 * 直接失效；重新登录拿新 token 即可，账号 id 和联系人关系都不变。
 */
const relogin = process.argv.includes('--relogin');
// `--no-contact`：只建两个账号 + 打开两个开关，不建立联系人关系——
// 用于手动从「添加好友」开始走一遍。
const skipContact = process.argv.includes('--no-contact');
let A;
let B;
if (relogin) {
  const saved = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'fixture.json'), 'utf8'));
  A = await login(saved.A.phone, 'A-reception');
  B = await login(saved.B.phone, 'B-reception');
} else {
  const stamp = String(Date.now()).slice(-8);
  A = await login(`137${stamp}`, 'A-reception');
  B = await login(`136${stamp}`, 'B-reception');
}

if (!skipContact && !relogin) await ensurePair(A, B);
if (!skipContact) {
  for (const who of [A, B]) {
    await call('/api/v1/consent/contacts.discoverable', { method: 'PUT', token: who.token });
    await call('/api/v1/consent/contacts.assistant_questions', { method: 'PUT', token: who.token });
  }
}
const aContacts = skipContact ? { data: { contacts: [] } } : await call('/api/v1/a2a/contacts', { token: A.token });
const bContacts = skipContact ? { data: { contacts: [] } } : await call('/api/v1/a2a/contacts', { token: B.token });

const payload = {
  A: { accountId: A.accountId, token: A.token, phone: A.phone },
  B: { accountId: B.accountId, token: B.token, phone: B.phone },
  aSees: aContacts.data.contacts.map((row) => row.accountId),
  bSees: bContacts.data.contacts.map((row) => row.accountId),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'fixture.json'), JSON.stringify(payload, null, 2));
console.log(JSON.stringify({
  A: { accountId: A.accountId, token: A.token, phone: A.phone },
  B: { accountId: B.accountId, token: B.token, phone: B.phone },
  ...payload,
}, null, 2));
