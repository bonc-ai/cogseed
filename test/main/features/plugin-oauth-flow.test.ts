/**
 * 模块 A 客户端侧：授权流程的状态机、校验与注入时序。
 *
 * 这个文件专测"出事会很难查"的那几条：
 *   · state 不匹配 / 超时 / 参数重复 → 必须中止，且**不消费** code
 *   · 换令牌响应形状（平台把数据包在 `data` 里，失败封套是**扁平**的）
 *   · 刷新必须带 hub_token（DECISION-2），拿不到 Hub 令牌时不刷新
 *   · 注入优先级：授权令牌 > 手工 Key（否则"撤销授权"形同虚设）
 *   · 令牌只在授权记录里，界面只拿到掩码
 *
 * 全程不连网：`fetch` 被替换成受控桩，Hub 会话也用注入的桩。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  hubSession: null as null | { access_token: string },
  hubError: null as null | Error,
}));

// 用例必须显式设置 hubSession 或 hubError —— 未设置时抛错而不是静默给一个假会话，
// 否则"忘了登录"的用例会假通过。错误对象由用例用**真实的 HubApiError** 构造，
// 因为生产代码靠 `instanceof HubApiError` 取错误码。
vi.mock('../../../src/main/features/hub_account/auth-flow', () => ({
  ensureFreshSession: async () => {
    if (mocks.hubError) throw mocks.hubError;
    if (!mocks.hubSession) throw new Error('test setup: hubSession/hubError not set');
    return mocks.hubSession;
  },
}));

// 状态查询会读本地 Hub 会话（判断"是否还说已登录"）——测试里用同一个开关控制
vi.mock('../../../src/main/features/hub_account/tokens', () => ({
  loadHubSession: () => mocks.hubSession,
  saveHubSession: () => undefined,
  clearHubSession: () => undefined,
}));

vi.mock('../../../src/main/features/packages', () => ({
  readPackagesRegistry: () => ({ packages: [{ name: 'demo-pkg' }, { name: 'other-pkg' }] }),
}));

import {
  FLOW_TIMEOUT_MS,
  PLUGIN_CLIENT_ID,
  PLUGIN_REDIRECT_URI,
  classifyRefreshFailure,
  handlePluginAuthorizeCallbackUrl,
  parsePluginCallback,
  pluginAuthorizeCallbackUrl,
  resolvePluginCredential,
  startPluginAuthorization,
  getPluginAuthStatus,
  disconnectPluginAuthorization,
  _resetRefreshGatesForTest,
} from '../../../src/main/features/plugin_oauth_flow';
import {
  clearPluginOAuth,
  generatePkce,
  readPluginOAuth,
  writePluginOAuth,
  type PluginOAuthRecord,
} from '../../../src/main/features/plugin_oauth_store';
import { HubApiError } from '../../../src/main/features/hub_account/client';

const UID = 'test-uid-oauth-flow';
const NAME = 'demo-pkg';
const BASE = 'https://platform.example.test/edu';
const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const now = () => NOW;

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

let fetchCalls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
let fetchStub: FetchStub = async () => new Response('{}', { status: 500 });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  fetchCalls = [];
  mocks.hubSession = { access_token: 'hub-token-1' };
  mocks.hubError = null;
  _resetRefreshGatesForTest();
  clearPluginOAuth(UID, NAME);
  clearPluginOAuth(UID, 'other-pkg');
  (globalThis as unknown as { fetch: FetchStub }).fetch = async (url, init) => {
    const headers = (init?.headers || {}) as Record<string, string>;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>; } catch { /* GET */ }
    fetchCalls.push({ url: String(url), body, headers });
    return fetchStub(String(url), init);
  };
});

afterEach(() => {
  clearPluginOAuth(UID, NAME);
  clearPluginOAuth(UID, 'other-pkg');
});

// ---------------------------------------------------------------------------
// 深链识别与解析
// ---------------------------------------------------------------------------

describe('pluginAuthorizeCallbackUrl', () => {
  it('识别本流程的深链', () => {
    expect(pluginAuthorizeCallbackUrl('cogseed://plugin/authorize/callback?code=a&state=b')).toBeTruthy();
  });

  it('🔴 不误吞其它流程的深链（账号 / 连接器各走各的）', () => {
    for (const other of [
      'cogseed://account/callback?code=a&state=b',
      'cogseed://connectors/oauth/callback?code=a&state=b',
      'cogseed://connectors/oauth/dcr-callback?code=a',
      'cogseed://plugin/authorize/callback/extra?code=a',
      'cogseed://plugin/other?code=a',
      'https://evil.test/plugin/authorize/callback?code=a',
      'not a url',
      '',
    ]) {
      expect(pluginAuthorizeCallbackUrl(other), other).toBeNull();
    }
  });

  it('🔴 尾部斜杠不放过（`/callback/` 也是本流程）', () => {
    expect(pluginAuthorizeCallbackUrl('cogseed://plugin/authorize/callback/?code=a&state=b')).toBeTruthy();
  });
});

describe('parsePluginCallback', () => {
  it('正常回调解出 code/state', () => {
    const r = parsePluginCallback('cogseed://plugin/authorize/callback?code=abc&state=xyz');
    expect(r.ok === true && r.code).toBe('abc');
    expect(r.ok === true && r.state).toBe('xyz');
  });

  it('🔴 code/state 重复出现 → 拒绝（同一参数出现两次是攻击形状，不是"取第一个"）', () => {
    expect(parsePluginCallback('cogseed://plugin/authorize/callback?code=a&code=b&state=s')).toEqual(
      expect.objectContaining({ ok: false, error: 'duplicate_code' }),
    );
    expect(parsePluginCallback('cogseed://plugin/authorize/callback?code=a&state=s&state=t')).toEqual(
      expect.objectContaining({ ok: false, error: 'duplicate_state' }),
    );
  });

  it('缺 code / 缺 state → 拒绝', () => {
    expect(parsePluginCallback('cogseed://plugin/authorize/callback?state=s')).toEqual(expect.objectContaining({ ok: false, error: 'missing_code' }));
    expect(parsePluginCallback('cogseed://plugin/authorize/callback?code=a')).toEqual(expect.objectContaining({ ok: false, error: 'missing_state' }));
  });

  it('🔴 控制字符 → 拒绝（防止把换行/空字节塞进日志或下游）', () => {
    expect(parsePluginCallback('cogseed://plugin/authorize/callback?code=a%0Ab&state=s')).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid_code' }),
    );
    expect(parsePluginCallback('cogseed://plugin/authorize/callback?code=a&state=s%00x')).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid_state' }),
    );
  });

  it('超长参数 → 拒绝', () => {
    const long = 'a'.repeat(5000);
    expect(parsePluginCallback(`cogseed://plugin/authorize/callback?code=${long}&state=s`)).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid_code' }),
    );
  });

  it('平台 error= 回调单独识别（用户拒绝 / 无资格），不当成"缺 code"', () => {
    const r = parsePluginCallback('cogseed://plugin/authorize/callback?error=access_denied&state=s');
    expect(r.ok === false && r.error).toBe('platform_error:access_denied');

    // 🔴 形状收口（安全审计 2026-09-21）：本机任何应用都能抢注 cogseed:// 并投递回调，
    //    而 error 会被写进授权记录并回读给渲染层。超长/含控制字符的串一律拒绝，
    //    避免磁盘与界面被塞爆。
    const longErr = parsePluginCallback(
      `cogseed://plugin/authorize/callback?error=${'A'.repeat(200)}&state=${'s'.repeat(20)}`,
    );
    expect(longErr.ok).toBe(false);
    expect(longErr.ok === false && longErr.error).toBe('invalid_error_param');
    const weirdErr = parsePluginCallback(
      `cogseed://plugin/authorize/callback?error=bad%20code%21&state=${'s'.repeat(20)}`,
    );
    expect(weirdErr.ok === false && weirdErr.error).toBe('invalid_error_param');
    // 失败也要带上 url：调用方要靠它读 state 定位是哪个包的流程。
    expect(r.ok === false && r.url).toContain('state=s');
  });
});

// ---------------------------------------------------------------------------
// 发起授权
// ---------------------------------------------------------------------------

describe('startPluginAuthorization', () => {
  it('🔴 授权 URL 带齐契约要求的参数（少一个平台就 400）', async () => {
    const r = await startPluginAuthorization(UID, NAME, { serverUrl: BASE, now });
    expect(r.ok).toBe(true);
    const url = new URL(r.authorizeUrl!);
    expect(url.origin + url.pathname).toBe('https://platform.example.test/edu/api/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(PLUGIN_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(PLUGIN_REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBe(r.state);
  });

  it('🔴 hub_token 随 URL 下发（平台用它判定"这是谁"）', async () => {
    const r = await startPluginAuthorization(UID, NAME, { serverUrl: BASE, now });
    expect(new URL(r.authorizeUrl!).searchParams.get('hub_token')).toBe('hub-token-1');
  });

  it('🔴 code_verifier 只落本地、绝不进 URL（进 URL 等于把 PKCE 白送）', async () => {
    const r = await startPluginAuthorization(UID, NAME, { serverUrl: BASE, now });
    const record = readPluginOAuth(UID, NAME).record;
    const verifier = record.pending!.code_verifier;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.authorizeUrl!).not.toContain(verifier);
  });

  it('🔴 未登录 Hub → 不发请求、不进浏览器，明确让用户先登录', async () => {
    mocks.hubSession = null;
    mocks.hubError = new HubApiError('AUTH_REQUIRED', '未登录', 401);
    const r = await startPluginAuthorization(UID, NAME, { serverUrl: BASE, now });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AUTH_REQUIRED');
    expect(r.message).toContain('请先登录');
    expect(r.authorizeUrl).toBeUndefined();
    // 不能留下待处理流程（否则用户登录后界面显示"还差一步"却无从完成）。
    expect(readPluginOAuth(UID, NAME).record.pending).toBeUndefined();
  });

  it('Hub 不可达 → 明确告知稍后重试（不是"请先登录"）', async () => {
    mocks.hubError = new HubApiError('HUB_NETWORK_ERROR', '网络不通', 0);
    const r = await startPluginAuthorization(UID, NAME, { serverUrl: BASE, now });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('HUB_UNREACHABLE');
    expect(r.message).toContain('稍后重试');
  });

  it('🔴 重新发起会清掉旧令牌与旧失败原因（状态只能有一个真相）', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_old', refresh_token: 'prt_old',
        access_expires_at: new Date(NOW + 3600_000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
      },
      last_error: { code: 'INVALID_REFRESH_TOKEN', at: '2026-09-20T11:00:00.000Z' },
    });
    await startPluginAuthorization(UID, NAME, { serverUrl: BASE, now });
    const record = readPluginOAuth(UID, NAME).record;
    expect(record.tokens).toBeUndefined();
    expect(record.last_error).toBeUndefined();
    expect(record.pending).toBeTruthy();
  });

  it('🔴 非法地址不会被当作可用地址（回落到默认平台，而不是拼出一个坏 URL）', async () => {
    const r = await startPluginAuthorization(UID, NAME, { serverUrl: 'not a url', now });
    expect(r.ok).toBe(true);
    // 回落链条：显式地址（非法，跳过）→ 环境变量（未设）→ 通道默认。
    expect(r.authorizeUrl).toContain('/edu/api/oauth/authorize');
    expect(r.authorizeUrl).not.toContain('not a url');
  });
});

// ---------------------------------------------------------------------------
// 回调 → 换令牌
// ---------------------------------------------------------------------------

async function seedPending(): Promise<{ state: string; verifier: string }> {
  const { state, codeVerifier } = generatePkce();
  writePluginOAuth(UID, NAME, {
    server_url: BASE,
    pending: { state, code_verifier: codeVerifier, server_url: BASE, created_at: new Date(NOW).toISOString() },
  });
  return { state, verifier: codeVerifier };
}

describe('handlePluginAuthorizeCallbackUrl', () => {
  it('🔴 正常回调：换令牌 → 落盘（含绑定身份）→ 返回成功', async () => {
    const { state, verifier } = await seedPending();
    fetchStub = async (url) => {
      if (url.endsWith('/api/oauth/token')) {
        return json(200, {
          ok: true,
          data: { access_token: 'pat_new', refresh_token: 'prt_new', token_type: 'Bearer', expires_in: 3312, refresh_expires_in: 2592000 },
        });
      }
      if (url.endsWith('/api/oauth/binding')) {
        return json(200, { ok: true, data: { bound: true, binding_id: 'b1', person_id: '2025abc', role: 'student', bound_at: '2026-09-20T12:00:00.000Z' } });
      }
      return json(404, { ok: false, error: 'not found', code: 'NOT_FOUND' });
    };

    const r = await handlePluginAuthorizeCallbackUrl(`cogseed://plugin/authorize/callback?code=abc&state=${state}`, { uid: UID, now });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.name).toBe(NAME);

    const tokenCall = fetchCalls.find((c) => c.url.endsWith('/api/oauth/token'))!;
    expect(tokenCall.body.code_verifier).toBe(verifier);
    expect(tokenCall.body.redirect_uri).toBe(PLUGIN_REDIRECT_URI);
    expect(tokenCall.body.client_id).toBe(PLUGIN_CLIENT_ID);

    const record = readPluginOAuth(UID, NAME).record;
    expect(record.tokens?.access_token).toBe('pat_new');
    expect(record.tokens?.binding?.person_id).toBe('2025abc');
    // 🔴 到期时间必须用响应里的**实际值**（平台含 ±10% 抖动），不能写死 3600。
    expect(Date.parse(record.tokens!.access_expires_at) - NOW).toBe(3312 * 1000);
    // pending 用完即弃：同一个 state 不能再用第二次。
    expect(record.pending).toBeUndefined();
  });

  it('🔴 并发回调：失败那次不得抹掉已经落盘的令牌（写回前必须重读最新）', async () => {
    // 安全审计 2026-09-21：原实现用**网络请求之前**读到的快照写回，而那个快照没有 tokens 字段。
    // 同一 state 的回调被投递两次时（OS 对同一 URL 触发两次 open-url / second-instance），
    // 失败那次会把成功那次刚写入的令牌整段抹掉 —— 用户表现为"点完同意仍是未连接"。
    const { state } = await seedPending();
    const before = readPluginOAuth(UID, NAME).record;
    // 🔴 关键：令牌必须在**这次换令牌请求进行中**被写入，才是真正的竞态。
    //    若在调用之前就写好，旧代码手里的快照也已经包含它们，测不出问题。
    fetchStub = async () => {
      writePluginOAuth(UID, NAME, {
        ...before,
        tokens: {
          access_token: 'pat_concurrent_success',
          refresh_token: 'prt_concurrent_success',
          access_expires_at: new Date(NOW + 3600_000).toISOString(),
          refresh_expires_at: new Date(NOW + 2592000_000).toISOString(),
          binding: { person_id: '2025abc', role: 'student' },
        },
      });
      throw new Error('network down');
    };

    const r = await handlePluginAuthorizeCallbackUrl(
      `cogseed://plugin/authorize/callback?code=abc&state=${state}`,
      { uid: UID, now },
    );
    expect(r.ok).toBe(false);

    const after = readPluginOAuth(UID, NAME).record;
    expect(after.tokens?.access_token).toBe('pat_concurrent_success');
    expect(after.tokens?.refresh_token).toBe('prt_concurrent_success');
  });

  it('🔴 state 不匹配 → 中止，且**不消费** code（伪造回调不能废掉用户的流程）', async () => {
    const { state } = await seedPending();
    fetchStub = async () => json(200, { ok: true, data: { access_token: 'pat_x', refresh_token: 'prt_x', expires_in: 3600, refresh_expires_in: 100 } });

    const r = await handlePluginAuthorizeCallbackUrl('cogseed://plugin/authorize/callback?code=abc&state=WRONG', { uid: UID, now });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe('state_mismatch');
    expect(fetchCalls).toHaveLength(0);
    // 真正的待处理流程还在（用户仍可用正确的 state 完成授权）。
    expect(readPluginOAuth(UID, NAME).record.pending?.state).toBe(state);
  });

  it('🔴 超时（10 分钟）→ 中止并清掉待处理流程', async () => {
    const { state } = await seedPending();
    fetchStub = async () => json(200, { ok: true, data: {} });
    const late = NOW + FLOW_TIMEOUT_MS + 1;
    const r = await handlePluginAuthorizeCallbackUrl(`cogseed://plugin/authorize/callback?code=abc&state=${state}`, { uid: UID, now: () => late });
    expect(r.ok === false && r.error).toBe('flow_timeout');
    expect(fetchCalls).toHaveLength(0);
    expect(readPluginOAuth(UID, NAME).record.pending).toBeUndefined();
  });

  it('🔴 恰好在超时边界内仍可用（不能把 9:59 的用户挡在外面）', async () => {
    const { state } = await seedPending();
    fetchStub = async (url) => (url.endsWith('/api/oauth/token')
      ? json(200, { ok: true, data: { access_token: 'pat_new', refresh_token: 'prt_new', expires_in: 3600, refresh_expires_in: 86400 } })
      : json(200, { ok: true, data: { bound: false, reason: 'BINDING_REVOKED' } }));
    const almost = NOW + FLOW_TIMEOUT_MS - 1;
    const r = await handlePluginAuthorizeCallbackUrl(`cogseed://plugin/authorize/callback?code=abc&state=${state}`, { uid: UID, now: () => almost });
    expect(r.ok).toBe(true);
  });

  it('🔴 令牌响应不含 binding（契约 v1.0.1）→ 另查 /api/oauth/binding 拿身份', async () => {
    const { state } = await seedPending();
    fetchStub = async (url) => (url.endsWith('/api/oauth/token')
      ? json(200, { ok: true, data: { access_token: 'pat_new', refresh_token: 'prt_new', expires_in: 3600, refresh_expires_in: 86400 } })
      : json(200, { ok: true, data: { bound: true, person_id: '2025zzz', role: 'teacher' } }));
    await handlePluginAuthorizeCallbackUrl(`cogseed://plugin/authorize/callback?code=abc&state=${state}`, { uid: UID, now });
    expect(fetchCalls.some((c) => c.url.endsWith('/api/oauth/binding'))).toBe(true);
    expect(readPluginOAuth(UID, NAME).record.tokens?.binding?.role).toBe('teacher');
  });

  it('🔴 失败封套是**扁平**的（error 是字符串）→ 文案要取到，不能是 undefined', async () => {
    const { state } = await seedPending();
    fetchStub = async () => json(401, { ok: false, error: '授权码无效或已使用', code: 'INVALID_GRANT' });
    const r = await handlePluginAuthorizeCallbackUrl(`cogseed://plugin/authorize/callback?code=abc&state=${state}`, { uid: UID, now });
    expect(r.ok === false && r.error).toBe('INVALID_GRANT');
    expect(r.ok === false && r.message).toBe('授权码无效或已使用');
    // 码已被消费/无效 → 待处理流程没有保留价值。
    expect(readPluginOAuth(UID, NAME).record.pending).toBeUndefined();
  });

  it('平台 error 深链 → 记下原因并清掉待处理流程（用户可重试，不是"卡住"）', async () => {
    const { state } = await seedPending();
    const r = await handlePluginAuthorizeCallbackUrl(`cogseed://plugin/authorize/callback?error=no_eligibility&state=${state}`, { uid: UID, now });
    expect(r.ok === false && r.error).toBe('no_eligibility');
    expect(r.ok === false && r.message).toContain('合作账号');
    const record = readPluginOAuth(UID, NAME).record;
    expect(record.pending).toBeUndefined();
    expect(record.last_error?.code).toBe('no_eligibility');
  });

  it('🔴 平台未返回令牌 → 失败，且不落盘半个记录', async () => {
    const { state } = await seedPending();
    fetchStub = async () => json(200, { ok: true, data: { token_type: 'Bearer' } });
    const r = await handlePluginAuthorizeCallbackUrl(`cogseed://plugin/authorize/callback?code=abc&state=${state}`, { uid: UID, now });
    expect(r.ok === false && r.error).toBe('MALFORMED_RESPONSE');
    expect(readPluginOAuth(UID, NAME).record.tokens).toBeUndefined();
  });

  it('网络不通 → 明确报网络问题（不是"授权失败"这种没法行动的错）', async () => {
    const { state } = await seedPending();
    fetchStub = async () => { throw new Error('connect ECONNREFUSED'); };
    const r = await handlePluginAuthorizeCallbackUrl(`cogseed://plugin/authorize/callback?code=abc&state=${state}`, { uid: UID, now });
    expect(r.ok === false && r.error).toBe('NETWORK_ERROR');
    expect(r.ok === false && r.needsReauth).toBe(false);
  });

  it('🔴 待处理流程按**密钥目录**定位，不依赖"已安装包注册表"', async () => {
    // 实测发现（npm run verify:plugin-auth 的真实失败回调）：
    // 早先按 readPackagesRegistry 枚举包名，于是只要包在"发起授权"与"回调到达"
    // 之间被卸载/禁用，回调就匹配不到任何 pending —— code 不被消费、
    // pending 永远留在盘上、界面停在"去浏览器完成确认"。
    // pending 本来就写在 `<包名>.oauth.json` 里，**目录才是权威**。
    const { state } = await seedPending();
    // 用例的包名不在被 mock 的注册表里（注册表只有 demo-pkg / other-pkg），
    // 但密钥目录里有它 —— 修复后必须仍能匹配到。
    fetchStub = async () => json(401, { ok: false, error: '授权码无效或已使用', code: 'INVALID_GRANT' });
    const r = await handlePluginAuthorizeCallbackUrl(`cogseed://plugin/authorize/callback?code=abc&state=${state}`, { uid: UID, now });
    expect(r.ok).toBe(false);
    // 关键断言：命中的是"码无效"，而不是"state 不匹配"（后者说明没找到 pending）。
    expect(r.ok === false && r.error).toBe('INVALID_GRANT');
    expect(readPluginOAuth(UID, NAME).record.pending).toBeUndefined();
  });

  it('不是本流程的深链 → 明确区分（调用方据此静默忽略）', async () => {
    const r = await handlePluginAuthorizeCallbackUrl('cogseed://account/callback?code=a&state=b', { uid: UID, now });
    expect(r.ok === false && r.error).toBe('not_a_plugin_callback');
  });
});

// ---------------------------------------------------------------------------
// 凭据解析（注入路径）
// ---------------------------------------------------------------------------

describe('resolvePluginCredential', () => {
  it('🔴 没授权但有手工 Key → 用手工 Key（存量用户不被破坏性升级）', async () => {
    const r = await resolvePluginCredential(UID, NAME, { apiKey: 'legacy-key', serverUrl: BASE }, { now });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.apiKey).toBe('legacy-key');
    expect(r.ok === true && r.method).toBe('legacy');
  });

  it('🔴 有授权令牌时**不用**手工 Key（否则"撤销授权"形同虚设）', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_oauth', refresh_token: 'prt_oauth',
        access_expires_at: new Date(NOW + 3600_000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
      },
    });
    const r = await resolvePluginCredential(UID, NAME, { apiKey: 'legacy-key', serverUrl: BASE }, { now });
    expect(r.ok === true && r.apiKey).toBe('pat_oauth');
    expect(r.ok === true && r.method).toBe('oauth');
  });

  it('既没授权也没手工 Key → NOT_AUTHORIZED + 需要用户操作', async () => {
    const r = await resolvePluginCredential(UID, NAME, {}, { now });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('NOT_AUTHORIZED');
    expect(r.ok === false && r.needsReauth).toBe(true);
  });

  it('🔴 令牌新鲜 → 不刷新、不发请求（最常见路径必须零网络）', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_fresh', refresh_token: 'prt_fresh',
        access_expires_at: new Date(NOW + 3600_000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
      },
    });
    const r = await resolvePluginCredential(UID, NAME, {}, { now });
    expect(r.ok === true && r.apiKey).toBe('pat_fresh');
    expect(r.ok === true && r.refreshed).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it('🔴 临期 → 刷新；刷新请求必带 hub_token（DECISION-2）', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_expiring', refresh_token: 'prt_expiring',
        access_expires_at: new Date(NOW + 1000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
      },
    });
    fetchStub = async () => json(200, {
      ok: true,
      data: { access_token: 'pat_refreshed', refresh_token: 'prt_rotated', expires_in: 3000, refresh_expires_in: 86400 },
    });
    const r = await resolvePluginCredential(UID, NAME, {}, { now });
    expect(r.ok === true && r.apiKey).toBe('pat_refreshed');
    expect(r.ok === true && r.refreshed).toBe(true);

    const refreshCall = fetchCalls.find((c) => c.url.endsWith('/api/oauth/refresh'))!;
    expect(refreshCall.body.hub_token).toBe('hub-token-1');
    expect(refreshCall.body.grant_type).toBe('refresh_token');
    expect(refreshCall.body.client_id).toBe(PLUGIN_CLIENT_ID);
    expect(refreshCall.body.refresh_token).toBe('prt_expiring');

    // 🔴 新 refresh 必须落盘（旧的已被轮换，再用就触发重放检测）。
    const record = readPluginOAuth(UID, NAME).record;
    expect(record.tokens?.refresh_token).toBe('prt_rotated');
    expect(record.tokens?.access_token).toBe('pat_refreshed');
  });

  it('🔴 拿不到 Hub 令牌 → **不刷新**（fail-closed，不拿旧令牌硬刷）', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_expiring', refresh_token: 'prt_expiring',
        access_expires_at: new Date(NOW + 1000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
      },
    });
    mocks.hubError = new HubApiError('AUTH_SESSION_REVOKED', '登录已失效', 401);
    const r = await resolvePluginCredential(UID, NAME, {}, { now });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.needsReauth).toBe(true);
    // 关键：一个刷新请求都没发出去（平台侧因此看不到"无 hub_token 的续期尝试"）。
    expect(fetchCalls).toHaveLength(0);
  });

  it('🔴 刷新被重放检测拒绝 → 明确提示安全问题 + 需要重新连接', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_expiring', refresh_token: 'prt_expiring',
        access_expires_at: new Date(NOW + 1000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
      },
    });
    fetchStub = async () => json(401, { ok: false, error: '检测到刷新令牌重放，已撤销全部会话，请重新授权', code: 'TOKEN_REPLAY_DETECTED' });
    const r = await resolvePluginCredential(UID, NAME, {}, { now });
    expect(r.ok === false && r.reason).toBe('REFRESH_TOKEN_EXPIRED');
    expect(r.ok === false && r.needsReauth).toBe(true);
    expect(r.ok === false && r.message).toContain('安全');
    // 失败原因落盘，界面才能说清"为什么突然断开"。
    expect(readPluginOAuth(UID, NAME).record.last_error?.code).toBe('REFRESH_TOKEN_EXPIRED');
  });

  it('刷新令牌本身已过期 → 不发请求，直接要求重新授权', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_old', refresh_token: 'prt_old',
        access_expires_at: new Date(NOW - 1000).toISOString(),
        refresh_expires_at: new Date(NOW - 1000).toISOString(),
      },
    });
    const r = await resolvePluginCredential(UID, NAME, {}, { now });
    expect(r.ok === false && r.reason).toBe('REFRESH_TOKEN_EXPIRED');
    expect(fetchCalls).toHaveLength(0);
  });

  it('🔴 并发命令只刷新一次（两次刷新会用同一个已轮换的 refresh → 全设备被踢）', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_expiring', refresh_token: 'prt_expiring',
        access_expires_at: new Date(NOW + 1000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
      },
    });
    fetchStub = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return json(200, { ok: true, data: { access_token: 'pat_refreshed', refresh_token: 'prt_rotated', expires_in: 3000, refresh_expires_in: 86400 } });
    };
    const results = await Promise.all([
      resolvePluginCredential(UID, NAME, {}, { now }),
      resolvePluginCredential(UID, NAME, {}, { now }),
      resolvePluginCredential(UID, NAME, {}, { now }),
    ]);
    expect(fetchCalls.filter((c) => c.url.endsWith('/api/oauth/refresh'))).toHaveLength(1);
    expect(results.every((r) => r.ok === true && r.apiKey === 'pat_refreshed')).toBe(true);
  });

  it('🔴 写回失败 → 中止命令（不能用未落库的令牌继续跑）', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_expiring', refresh_token: 'prt_expiring',
        access_expires_at: new Date(NOW + 1000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
      },
    });
    fetchStub = async () => json(200, { ok: true, data: { access_token: 'pat_refreshed', refresh_token: 'prt_rotated', expires_in: 3000, refresh_expires_in: 86400 } });

    // 制造真实的写失败（不用 mock）：把临时文件名占成一个**目录**，
    // 原子写的第一步 writeFileSync 就会 EISDIR。这样测的是真代码路径。
    const { pluginOAuthFile } = await import('../../../src/main/features/plugin_oauth_store');
    const target = pluginOAuthFile(UID, NAME);
    const tmp = `${target}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const r = await resolvePluginCredential(UID, NAME, {}, { now });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe('STORE_UNAVAILABLE');
      expect(r.ok === false && r.message).toContain('中止');
      // 🔴 关键：磁盘上的 refresh 仍是**旧的**，没有被覆盖成新的。
      //    （若这里被写坏成"新 refresh 已落库"，下次命令就会用旧 refresh → 重放检测。）
      expect(readPluginOAuth(UID, NAME).record.tokens?.refresh_token).toBe('prt_expiring');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('本地记录损坏 → STORE_UNAVAILABLE（如实告知损坏，而不是"从没连过"）', async () => {
    const { pluginOAuthFile } = await import('../../../src/main/features/plugin_oauth_store');
    const target = pluginOAuthFile(UID, NAME);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ v: 1, oauth_enc: 'garbage' }));
    const r = await resolvePluginCredential(UID, NAME, {}, { now });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('STORE_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// 状态映射（界面态 A/B/C/D/F）
// ---------------------------------------------------------------------------

describe('getPluginAuthStatus', () => {
  it('A：什么都没配', () => {
    const s = getPluginAuthStatus(UID, NAME, {}, NOW);
    expect(s.state).toBe('A');
    expect(s.method).toBe('none');
    expect(s.needsReauth).toBe(true);
  });

  it('B：已发起授权、等浏览器确认（且 Hub 仍登录）', () => {
    mocks.hubSession = { access_token: 'hub-token-1' };
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      pending: { state: 's', code_verifier: 'v', server_url: BASE, created_at: new Date(NOW).toISOString() },
    });
    const s = getPluginAuthStatus(UID, NAME, {}, NOW);
    expect(s.state).toBe('B');
    expect(s.needsReauth).toBe(false);
  });

  it('C：令牌有效 → 已接入，只出掩码', () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_abcdefghijklmnop', refresh_token: 'prt_x',
        access_expires_at: new Date(NOW + 3600_000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
        binding: { person_id: '2025abc', role: 'student' },
      },
    });
    const s = getPluginAuthStatus(UID, NAME, {}, NOW);
    expect(s.state).toBe('C');
    expect(s.authorized).toBe(true);
    expect(s.personId).toBe('2025abc');
    expect(s.role).toBe('student');
    expect(s.maskedAccess).toContain('*');
    expect(JSON.stringify(s)).not.toContain('pat_abcdefghijklmnop');
  });

  it('D：平台明确说无资格 → 给出路，不要求重新连接', () => {
    writePluginOAuth(UID, NAME, { server_url: BASE, last_error: { code: 'no_eligibility', at: new Date(NOW).toISOString() } });
    const s = getPluginAuthStatus(UID, NAME, {}, NOW);
    expect(s.state).toBe('D');
    expect(s.needsReauth).toBe(false);
    expect(s.lastErrorCode).toBe('no_eligibility');
  });

  it('🔴 Hub 已登出时不得再宣称"已登录"（真人验收发现的缺陷）', () => {
    // 场景：用户在 Hub 登录时点了「连接课程平台」→ 本地留下 pending；
    //       随后他在 CogSeed 里**登出了 Hub**。
    // 原实现只看 pending 就说「已登录，还差一步」——**假信息**：
    //   那个 pending 里的凭证已失效，点「去浏览器确认」多半失败且原因不可解释。
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      pending: { state: 's', code_verifier: 'v', server_url: BASE, created_at: new Date(NOW).toISOString() },
    });
    mocks.hubSession = { access_token: 'hub-token-1' };
    expect(getPluginAuthStatus(UID, NAME, {}, NOW).state).toBe('B');
    // 登出后：必须回落 A（界面据此提示"请先登录"，而不是"去浏览器确认"）
    mocks.hubSession = null;
    const after = getPluginAuthStatus(UID, NAME, {}, NOW);
    expect(after.state).toBe('A');
    expect(after.hubSignedIn).toBe(false);
    // pending 本身**不清**：用户登录回来后仍可继续（不必重新点按钮）
    expect(readPluginOAuth(UID, NAME).record.pending).toBeTruthy();
  });

  it('🔴 B 会过期：平台只渲染"无资格"页不深链回来 → 用户关掉标签页后不能永远停在"去浏览器确认"', () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      pending: { state: 's', code_verifier: 'v', server_url: BASE, created_at: new Date(NOW).toISOString() },
    });
    // 有效期内 → B（Hub 仍登录）
    mocks.hubSession = { access_token: 'hub-token-1' };
    expect(getPluginAuthStatus(UID, NAME, {}, NOW + FLOW_TIMEOUT_MS).state).toBe('B');
    // 超过有效期 → 回落 A（用户能看到「重新连接」并真的重新发起）
    const stale = getPluginAuthStatus(UID, NAME, {}, NOW + FLOW_TIMEOUT_MS + 1);
    expect(stale.state).toBe('A');
    expect(stale.needsReauth).toBe(true);
    // 只读：状态查询不得改写磁盘（清理由下一次发起授权负责）
    expect(readPluginOAuth(UID, NAME).record.pending).toBeTruthy();
  });

  it('🔴 B 优先于 D：用户点了重新连接后，界面不该还显示"无资格"', () => {
    mocks.hubSession = { access_token: 'hub-token-1' };
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      last_error: { code: 'no_eligibility', at: new Date(NOW).toISOString() },
      pending: { state: 's', code_verifier: 'v', server_url: BASE, created_at: new Date(NOW).toISOString() },
    });
    expect(getPluginAuthStatus(UID, NAME, {}, NOW).state).toBe('B');
  });

  it('F：刷新令牌过期 → 已失效', () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_old', refresh_token: 'prt_old',
        access_expires_at: new Date(NOW - 1000).toISOString(),
        refresh_expires_at: new Date(NOW - 1000).toISOString(),
      },
    });
    const s = getPluginAuthStatus(UID, NAME, {}, NOW);
    expect(s.state).toBe('F');
    expect(s.needsReauth).toBe(true);
  });

  it('C(legacy)：手工 Key 仍算"已配置"，不呈现未接入（存量用户零变化）', () => {
    const s = getPluginAuthStatus(UID, NAME, { apiKey: 'legacy', serverUrl: BASE }, NOW);
    expect(s.state).toBe('C');
    expect(s.method).toBe('legacy');
    expect(s.authorized).toBe(true);
  });

  it('带出平台地址与"是否已知平台地址"', () => {
    const s = getPluginAuthStatus(UID, NAME, { apiKey: 'legacy', serverUrl: BASE }, NOW);
    expect(s.serverUrl).toBe(BASE);
    expect(s.hasPlatformUrl).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 断开
// ---------------------------------------------------------------------------

describe('disconnectPluginAuthorization', () => {
  it('🔴 先清本地再通知平台：本地一定干净，即使平台撤销失败', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_live', refresh_token: 'prt_live',
        access_expires_at: new Date(NOW + 3600_000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
      },
    });
    fetchStub = async () => json(200, { ok: true, data: { revoked_sessions: 1 } });
    const r = await disconnectPluginAuthorization(UID, NAME);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.serverRevoked).toBe(true);
    expect(readPluginOAuth(UID, NAME).record.tokens).toBeUndefined();
    expect(getPluginAuthStatus(UID, NAME, {}, NOW).state).toBe('A');

    const revokeCall = fetchCalls.find((c) => c.url.endsWith('/api/oauth/revoke'))!;
    expect(revokeCall.headers.authorization).toBe('Bearer pat_live');
    expect(revokeCall.body.token).toBe('prt_live');
  });

  it('平台撤销失败不阻塞用户（本地已干净，如实报告 serverRevoked=false）', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_live', refresh_token: 'prt_live',
        access_expires_at: new Date(NOW + 3600_000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
      },
    });
    fetchStub = async () => json(500, { ok: false, error: '服务内部错误', code: 'INTERNAL' });
    const r = await disconnectPluginAuthorization(UID, NAME);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.serverRevoked).toBe(false);
    expect(readPluginOAuth(UID, NAME).record.tokens).toBeUndefined();
  });

  it('从未授权时断开也成功（幂等）', async () => {
    const r = await disconnectPluginAuthorization(UID, NAME);
    expect(r.ok).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it('revokeAll → scope=all（"在所有设备退出"）', async () => {
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_live', refresh_token: 'prt_live',
        access_expires_at: new Date(NOW + 3600_000).toISOString(),
        refresh_expires_at: new Date(NOW + 86400_000).toISOString(),
      },
    });
    fetchStub = async () => json(200, { ok: true, data: { revoked_sessions: 3 } });
    await disconnectPluginAuthorization(UID, NAME, { revokeAll: true });
    expect(fetchCalls.find((c) => c.url.endsWith('/api/oauth/revoke'))!.body.scope).toBe('all');
  });
});

// ---------------------------------------------------------------------------
// 刷新失败分类
// ---------------------------------------------------------------------------

describe('classifyRefreshFailure：DEVICE_MISMATCH（安全审计 2026-09-21）', () => {
  it('🔴 设备不一致要单独说清原因，不能笼统说"授权已失效"', () => {
    // 设备绑定修好之后这条**才真的会发生**（换机/重装/删掉设备标识文件）。
    // 用户看到"授权已失效"会以为是自己或平台出了问题 —— 必须说明是设备变了。
    const r = classifyRefreshFailure('DEVICE_MISMATCH', 401);
    expect(r.needsReauth).toBe(true);
    expect(r.message).toContain('设备');
    expect(r.message).not.toBe(classifyRefreshFailure('INVALID_REFRESH_TOKEN', 401).message);
  });
});

describe('classifyRefreshFailure', () => {
  it('🔴 用户能自己解决的 → 建议重新连接', () => {
    for (const code of ['INVALID_REFRESH_TOKEN', 'TOKEN_REPLAY_DETECTED', 'BINDING_REVOKED', 'HUB_SESSION_REVOKED', 'HUB_DEVICE_REVOKED', 'AUTH_REQUIRED', 'ACCOUNT_SUSPENDED']) {
      expect(classifyRefreshFailure(code, 401).needsReauth, code).toBe(true);
    }
  });

  it('🔴 重新授权也没用的 → 建议重试（别让用户白跑一趟）', () => {
    for (const code of ['HUB_UNREACHABLE', 'AUTH_DB_UNAVAILABLE', 'AUTH_DB_NOT_CONFIGURED', 'NETWORK_ERROR', 'INVALID_CLIENT']) {
      expect(classifyRefreshFailure(code, 503).needsReauth, code).toBe(false);
    }
  });

  it('未知码按状态码兜底：5xx 是服务端问题（重试），4xx 是授权问题（重连）', () => {
    expect(classifyRefreshFailure('SOMETHING_NEW', 503).needsReauth).toBe(false);
    expect(classifyRefreshFailure('SOMETHING_NEW', 400).needsReauth).toBe(true);
  });

  it('每条都带中文说明（界面直接显示，不暴露技术码）', () => {
    for (const code of ['INVALID_REFRESH_TOKEN', 'HUB_UNREACHABLE', 'TOKEN_REPLAY_DETECTED', 'WHATEVER']) {
      const r = classifyRefreshFailure(code, 500);
      expect(r.message.length).toBeGreaterThan(0);
      expect(r.message).not.toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// 对话路径的凭据桥（物化文件）+ 后台续期
//
// 🔴 真机实测的第七个缺口：对话里让智能体调插件走 `bin/run-skill.cjs`，
//    它读的是 `<pkg>.json`（旧手工配置）与主进程物化出来的
//    `<pkg>.runtime.json`。**只做 OAuth 授权、不物化**，
//    结果就是"插件页显示已连接，用户一问『我的挑战有哪些』却被告知没配置"。
// ---------------------------------------------------------------------------

describe('运行时凭据物化（给 run-skill.cjs 读）', () => {
  it('🔴 解析成功后必须写出物化文件，字段与 run-skill 期望一致', async () => {
    const { pluginRuntimeCredentialFile } = await import('../../../src/main/features/plugin_oauth_store');
    const { writePluginOAuth, clearRuntimeCredential } = await import('../../../src/main/features/plugin_oauth_store');
    const now = Date.now();
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_dialogue_path', refresh_token: 'prt_x',
        access_expires_at: new Date(now + 3600_000).toISOString(),
        refresh_expires_at: new Date(now + 86400_000).toISOString(),
        binding: { person_id: '2023108600023', role: 'student' },
      },
    });
    const r = await resolvePluginCredential(UID, NAME, {}, { now: () => now });
    expect(r.ok).toBe(true);

    const file = pluginRuntimeCredentialFile(UID, NAME);
    expect(fs.existsSync(file)).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.api_key).toBe('pat_dialogue_path');
    expect(written.server_url).toBe(BASE);
    // 身份三件套：对话路径依赖它们确定"我是谁"
    expect(written.student_id).toBe('2023108600023');
    expect(written.role).toBe('student');
    // 过期时间必须有，run-skill 据此判断是否还能用
    expect(typeof written.expires_at).toBe('string');
    expect(Date.parse(written.expires_at)).toBeGreaterThan(now);
    expect(written.source).toBe('oauth');
    clearRuntimeCredential(UID, NAME);
  });

  it('🔴 断开授权必须删掉物化文件（否则插件仍能用已撤销的令牌跑）', async () => {
    const { pluginRuntimeCredentialFile, clearRuntimeCredential } = await import('../../../src/main/features/plugin_oauth_store');
    const now = Date.now();
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_to_revoke', refresh_token: 'prt_x',
        access_expires_at: new Date(now + 3600_000).toISOString(),
        refresh_expires_at: new Date(now + 86400_000).toISOString(),
      },
    });
    await resolvePluginCredential(UID, NAME, {}, { now: () => now });
    const file = pluginRuntimeCredentialFile(UID, NAME);
    expect(fs.existsSync(file)).toBe(true);

    fetchStub = async () => json(200, { ok: true, data: { revoked_sessions: 1 } });
    await disconnectPluginAuthorization(UID, NAME);
    expect(fs.existsSync(file)).toBe(false);
    void clearRuntimeCredential;
  });

  it('🔴 授权成功后立刻物化（用户点完同意切回来就能直接用，不必先点插件页）', async () => {
    const { pluginRuntimeCredentialFile } = await import('../../../src/main/features/plugin_oauth_store');
    const { state } = await seedPending();
    fetchStub = async (url) => (url.endsWith('/api/oauth/token')
      ? json(200, { ok: true, data: { access_token: 'pat_after_consent', refresh_token: 'prt_new', expires_in: 3600, refresh_expires_in: 86400 } })
      : json(200, { ok: true, data: { bound: true, person_id: '2023108600023', role: 'student' } }));
    const r = await handlePluginAuthorizeCallbackUrl(`cogseed://plugin/authorize/callback?code=abc&state=${state}`, { uid: UID, now });
    expect(r.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(pluginRuntimeCredentialFile(UID, NAME), 'utf8'));
    expect(written.api_key).toBe('pat_after_consent');
    expect(written.student_id).toBe('2023108600023');
  });

  it('物化文件的权限是 0600（含明文令牌，机器私有）', async () => {
    if (process.platform === 'win32') return;
    const { pluginRuntimeCredentialFile } = await import('../../../src/main/features/plugin_oauth_store');
    const now = Date.now();
    writePluginOAuth(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_perm', refresh_token: 'prt_x',
        access_expires_at: new Date(now + 3600_000).toISOString(),
        refresh_expires_at: new Date(now + 86400_000).toISOString(),
      },
    });
    await resolvePluginCredential(UID, NAME, {}, { now: () => now });
    const mode = fs.statSync(pluginRuntimeCredentialFile(UID, NAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('后台续期', () => {
  it('🔴 只对真正持有令牌的包续期（仅有 pending / 仅有失败记录的跳过）', async () => {
    const { refreshAllPluginCredentials } = await import('../../../src/main/features/plugin_oauth_flow');
    const { writePluginOAuth: write, clearRuntimeCredential } = await import('../../../src/main/features/plugin_oauth_store');
    const now = Date.now();
    // 有令牌 → 应被续期
    write(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_bg', refresh_token: 'prt_bg',
        access_expires_at: new Date(now + 3600_000).toISOString(),
        refresh_expires_at: new Date(now + 86400_000).toISOString(),
      },
    });
    // 只有 pending → 不该被续期（还没授权成功）
    write(UID, 'other-pkg', {
      server_url: BASE,
      pending: { state: 's', code_verifier: 'v', server_url: BASE, created_at: new Date(now).toISOString() },
    });

    const results = await refreshAllPluginCredentials(UID);
    expect(results.some((r) => r.name === NAME && r.ok)).toBe(true);
    expect(results.some((r) => r.name === 'other-pkg')).toBe(false);
    clearRuntimeCredential(UID, NAME);
  });

  it('🔴 需要重新授权时不再重试该包（继续重试没有意义）', async () => {
    const { refreshAllPluginCredentials } = await import('../../../src/main/features/plugin_oauth_flow');
    const { writePluginOAuth: write } = await import('../../../src/main/features/plugin_oauth_store');
    const now = Date.now();
    write(UID, NAME, {
      server_url: BASE,
      tokens: {
        access_token: 'pat_dead', refresh_token: 'prt_dead',
        // refresh 已过期 → 直接判 REFRESH_TOKEN_EXPIRED，不需要网络
        access_expires_at: new Date(now - 1000).toISOString(),
        refresh_expires_at: new Date(now - 1000).toISOString(),
      },
    });
    const results = await refreshAllPluginCredentials(UID);
    const mine = results.find((r) => r.name === NAME);
    expect(mine?.ok).toBe(false);
    expect(mine?.reason).toBe('REFRESH_TOKEN_EXPIRED');
    // 关键：不发任何网络请求（refresh 已过期不需要试）
    expect(fetchCalls.filter((c) => c.url.includes('/api/oauth/')).length).toBe(0);
  });

  it('后台续期不抛错（单包失败不影响其它包与调用方）', async () => {
    const { refreshAllPluginCredentials } = await import('../../../src/main/features/plugin_oauth_flow');
    await expect(refreshAllPluginCredentials('nonexistent-uid-for-bg')).resolves.toEqual([]);
  });
});
