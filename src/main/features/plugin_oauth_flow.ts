/**
 * plugin_oauth_flow.ts —— 插件授权流程（模块 A · 客户端侧）
 *
 * 契约：
 *   · `specs/001-plugin-oauth-auth/contracts/authorization-endpoints.md`（v1.0.1）
 *   · `specs/001-plugin-oauth-auth/contracts/callback-protocol.md` §1–§4
 *
 * 流程（三步，全部在 main 进程）：
 *   ① `startPluginAuthorization()` —— 生成 state + PKCE(S256)，把待处理流程
 *      落盘（含 code_verifier），打开系统浏览器到 `/api/oauth/authorize`
 *   ② 用户在浏览器里登录 Hub → 确认课程身份 → 同意
 *   ③ OS 把 `cogseed://plugin/authorize/callback?code=…&state=…` 交回本进程
 *      → `handlePluginAuthorizeCallbackUrl()` 校验 state / verifier / 超时
 *      → 换令牌 → 落盘 → 通知界面
 *
 * 🔴 三条不能妥协的地方：
 *   ① **state 必须与本地待处理流程逐字节相等**（防 CSRF）。不匹配就中止，
 *      且**不消费** code —— 让用户能重试而不是被一个伪造回调废掉流程。
 *   ② **code_verifier 只在本地**，只出现在换令牌的请求体里；不进日志、不进界面。
 *   ③ **hub_token 每次刷新都要重新取**（DECISION-2）：平台的 `/api/oauth/refresh`
 *      会拿它去 Hub 复验身份，以支持"Hub 撤销设备 → EduSeed 授权联动失效"。
 *      拿不到 Hub 令牌就**不刷新**（fail-closed），而不是拿旧令牌硬刷。
 */
import * as fs from 'node:fs';

import { createLogger } from '../logger';
import { normalizeDeepLink } from '../brand';
import { userPackageSecretsDir } from '../paths';
import { getActiveUserId } from './users';
import { getOrCreateDeviceId } from '../util/device_identity';
import { readPackagesRegistry } from './packages';
import { HubApiError } from './hub_account/client';
import { ensureFreshSession } from './hub_account/auth-flow';
import { loadHubSession } from './hub_account/tokens';
import {
  type PluginOAuthRecord,
  clearPluginOAuth,
  clearRuntimeCredential,
  generatePkce,
  pluginOAuthFile,
  readPluginOAuth,
  writePluginOAuth,
  writeRuntimeCredential,
  sweepStaleRuntimeCredentials,
} from './plugin_oauth_store';
import { joinApiUrl, resolveEduSeedBase } from './plugin_platform_url';
import { ensureServiceOriginsResolved } from './service_origins';
import {
  type InjectionFailureReason,
  type OAuthTokenState,
  type RefreshResult,
  createSingleFlightRunner,
  describeAuthForDisplay,
  resolveAccessToken,
} from './plugin_oauth_tokens';

const log = createLogger('plugin-oauth-flow');

/** 固定客户端标识（必须与平台 `ALLOWED_CLIENTS` 一致）。 */
export const PLUGIN_CLIENT_ID = 'cogseed-desktop';
/** 固定回调地址（必须与平台 `ALLOWED_REDIRECT_URIS` **精确**一致）。 */
export const PLUGIN_REDIRECT_URI = 'cogseed://plugin/authorize/callback';
/** 深链 host / path（契约 §1.1）。 */
export const PLUGIN_CALLBACK_HOST = 'plugin';
export const PLUGIN_CALLBACK_PATH = '/authorize/callback';
/** 待处理流程的有效期：10 分钟（契约 §2 规则 8）。 */
export const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

// ── 深链识别与解析 ────────────────────────────────────────────────────────

/** 是本流程的深链吗？是则返回规范化后的完整 URL，否则 null（静默忽略）。 */
export function pluginAuthorizeCallbackUrl(rawUrl: string): string | null {
  const normalized = normalizeDeepLink(rawUrl);
  if (!normalized) return null;
  const parsed = normalized.url;
  if (parsed.host.toLowerCase() !== PLUGIN_CALLBACK_HOST) return null;
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (pathname !== PLUGIN_CALLBACK_PATH) return null;
  return normalized.href;
}

export type ParsedPluginCallback =
  | { ok: true; url: string; code: string; state: string }
  // `url` 在**形状合法但内容不合法**时仍然给出：调用方需要它去读 `state`
  // 以定位是哪个包的流程（否则失败回调只能被丢弃，待处理流程永远留在盘上）。
  | { ok: false; error: string; url?: string };

/**
 * 解析回调（契约 §2 规则 2–5）。
 *
 * 与 `hub_account::parseAccountCallback` 同构 —— 同样的参数形状就该有同样的
 * 校验强度，不因为"是另一个流程"而放宽。
 */
export function parsePluginCallback(rawUrl: string): ParsedPluginCallback {
  const url = pluginAuthorizeCallbackUrl(rawUrl);
  if (!url) return { ok: false, error: 'not_a_plugin_callback' };
  const parsed = new URL(url);

  // 平台可能用 error= 深链回来（用户拒绝 / 无资格）——先认它，别当成缺 code。
  //
  // 🔴 形状校验（安全审计 2026-09-21）：本机**任何应用**都能注册 `cogseed://` 并投递回调，
  //    而 `error` 会被原样写进授权记录（`last_error.code`）并回读给渲染层。
  //    此前不校验长度与字符集 ⇒ 一个抢注者可以塞进任意长/含控制字符的串，
  //    造成磁盘与界面膨胀。平台侧的错误码只可能是 `[A-Za-z0-9_]`，按此收口即可。
  const errorParam = parsed.searchParams.get('error');
  if (errorParam) {
    if (errorParam.length > 64 || !/^[A-Za-z0-9_]+$/.test(errorParam)) {
      return { ok: false, error: 'invalid_error_param', url };
    }
    return { ok: false, error: `platform_error:${errorParam}`, url };
  }

  const codes = parsed.searchParams.getAll('code');
  const states = parsed.searchParams.getAll('state');
  if (codes.length > 1) return { ok: false, error: 'duplicate_code', url };
  if (states.length > 1) return { ok: false, error: 'duplicate_state', url };
  const code = codes[0] || '';
  const state = states[0] || '';
  if (!code) return { ok: false, error: 'missing_code', url };
  if (!state) return { ok: false, error: 'missing_state', url };
  if (code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) return { ok: false, error: 'invalid_code', url };
  if (state.length > 512 || /[\u0000-\u001f\u007f]/.test(state)) return { ok: false, error: 'invalid_state', url };
  return { ok: true, url, code, state };
}

// ── 待处理流程的定位 ──────────────────────────────────────────────────────

export interface PendingMatch {
  name: string;
  pending: NonNullable<PluginOAuthRecord['pending']>;
  record: PluginOAuthRecord;
}

/**
 * 按 `state` 找到发起该流程的包。
 *
 * 深链里只有 `code`/`state`，没有包名，所以必须扫。
 *
 * 🔴 扫的是**密钥目录里的文件**，不是"已安装包注册表"。
 *    这个区别是实测发现的（`npm run verify:plugin-auth` 的真实失败回调）：
 *    按注册表扫时，只要包在"发起授权"与"回调到达"之间被卸载/禁用，
 *    或者流程由非注册路径发起，回调就**匹配不到**任何待处理流程 ——
 *    于是 code 不被消费、pending 永远留在盘上、界面停在"去浏览器确认"。
 *    而 pending 本来就是写在 `<包名>.oauth.json` 里的：**目录才是权威**。
 *
 * state 是 32 字节随机串，扫到别人流程的概率可以忽略；"包名"不是秘密。
 */
export function findPendingByState(uid: string, state: string): PendingMatch | null {
  if (!state) return null;
  for (const name of listOAuthRecordNames(uid)) {
    const { record } = readPluginOAuth(uid, name);
    if (record.pending && record.pending.state === state) {
      return { name, pending: record.pending, record };
    }
  }
  return null;
}

/**
 * 列出该用户下所有存在授权记录文件的包名。
 *
 * 优先扫目录（权威）；目录不存在时回退到"已安装包注册表"，
 * 这样在极少见的"密钥目录被清掉但注册表还在"的情况下仍能工作。
 */
export function listOAuthRecordNames(uid: string): string[] {
  const names = new Set<string>();
  try {
    const dir = userPackageSecretsDir(uid);
    for (const entry of fs.readdirSync(dir)) {
      const m = /^(.+)\.oauth\.json$/.exec(entry);
      if (m && m[1]) names.add(m[1]);
    }
  } catch { /* 目录不存在（从未授权过）→ 落到注册表回退 */ }
  if (names.size === 0) {
    try {
      for (const p of readPackagesRegistry(uid).packages) names.add(p.name);
    } catch (err) {
      log.warn('packages registry unreadable', { error: (err as Error).message });
    }
  }
  return [...names];
}

// ── 平台调用 ──────────────────────────────────────────────────────────────

/** 平台失败封套解析：实现是 `{ok:false,error:"文本",code:"CODE"}`，
 *  但契约历史版本写过 `error:{code,message}` —— 跨仓边界两种都容忍。 */
export function parsePlatformFailure(body: unknown, status: number): { code: string; message: string } {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const rawErr = b.error;
    if (typeof rawErr === 'string' && rawErr) {
      return { code: typeof b.code === 'string' ? b.code : `HTTP_${status}`, message: rawErr };
    }
    if (rawErr && typeof rawErr === 'object') {
      const e = rawErr as Record<string, unknown>;
      return {
        code: typeof e.code === 'string' ? e.code : (typeof b.code === 'string' ? b.code : `HTTP_${status}`),
        message: typeof e.message === 'string' ? e.message : '',
      };
    }
    if (typeof b.code === 'string') return { code: b.code, message: typeof b.message === 'string' ? b.message : '' };
  }
  return { code: `HTTP_${status}`, message: '' };
}

/** 取响应封套里的 `data`（成功时）。 */
export function unwrapData(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const data = b.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 一次平台 POST（JSON）。
 *
 * 统一把网络异常与平台错误码收敛成 `{ok:false, code, message, status}`，
 * 调用方不必再分辨 fetch 抛错与 HTTP 非 2xx 这两种完全不同的失败。
 */
async function postJson(
  url: string,
  body: Record<string, unknown>,
  opts: { bearer?: string; timeoutMs?: number } = {},
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string; status: number }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
    });
  } catch (err) {
    return { ok: false, code: 'NETWORK_ERROR', message: `无法连接平台（${(err as Error).message}）`, status: 0 };
  }
  const parsed = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const f = parsePlatformFailure(parsed, res.status);
    return { ok: false, code: f.code, message: f.message, status: res.status };
  }
  const data = unwrapData(parsed);
  if (!data) return { ok: false, code: 'MALFORMED_RESPONSE', message: '平台响应格式不正确', status: res.status };
  return { ok: true, data };
}

/** 一次平台 GET（JSON，Bearer）。 */
async function getJson(
  url: string,
  opts: { bearer?: string; timeoutMs?: number } = {},
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string; status: number }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 10000) });
  } catch (err) {
    return { ok: false, code: 'NETWORK_ERROR', message: `无法连接平台（${(err as Error).message}）`, status: 0 };
  }
  const parsed = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const f = parsePlatformFailure(parsed, res.status);
    return { ok: false, code: f.code, message: f.message, status: res.status };
  }
  const data = unwrapData(parsed);
  if (!data) return { ok: false, code: 'MALFORMED_RESPONSE', message: '平台响应格式不正确', status: res.status };
  return { ok: true, data };
}

// ── ① 发起授权 ────────────────────────────────────────────────────────────

export interface StartResult {
  ok: boolean;
  authorizeUrl?: string;
  state?: string;
  error?: string;
  /** 面向用户的中文说明（界面直接显示，不显示技术码）。 */
  message?: string;
}

/**
 * 发起授权：落盘待处理流程 → 返回要打开的授权页地址。
 *
 * **不**在这里打开浏览器：`openExternal` 属 Electron 壳层，由调用方（IPC/renderer
 * 流程）负责，这样本函数在测试里可以完全离线跑。
 *
 * 需要 Hub 已登录：授权页要 `hub_token` 才能判定"这是谁"。未登录直接返回
 * `AUTH_REQUIRED`（界面据此先引导登录）—— 而不是让用户跳到一个必然失败的页面。
 */
export async function startPluginAuthorization(
  uid: string,
  name: string,
  opts: { serverUrl?: string; now?: () => number } = {},
): Promise<StartResult> {
  // 🔴 授权流程开始前先确定服务器（生产优先 / 本地兜底，启动时探测一次）。
  //    必须在流程**开始**时确定：中途换服务器会让 state 与授权码对不上另一台机器的库。
  await ensureServiceOriginsResolved();
  const base = resolveEduSeedBase(opts.serverUrl);
  if (!base) {
    return { ok: false, error: 'NO_PLATFORM_URL', message: '未配置平台地址，请先在插件配置里填写' };
  }

  let hubToken = '';
  try {
    hubToken = (await ensureFreshSession(uid)).access_token;
  } catch (err) {
    const code = hubCodeOf(err);
    log.warn('plugin authorize blocked: hub session unavailable', { package_name: name, code });
    return {
      ok: false,
      error: code === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : code,
      message: code === 'AUTH_REQUIRED' ? '请先登录 CogSeed 账号，再连接课程平台' : '账号服务暂时不可用，请稍后重试',
    };
  }

  const { state, codeVerifier, codeChallenge } = generatePkce();
  const nowMs = (opts.now ?? (() => Date.now()))();
  const record: PluginOAuthRecord = {
    ...readPluginOAuth(uid, name).record,
    server_url: base,
    pending: {
      state,
      code_verifier: codeVerifier,
      server_url: base,
      created_at: new Date(nowMs).toISOString(),
    },
  };
  // 🔴 重新发起就丢弃旧令牌与旧失败原因：留着旧 access_token 会让界面显示
  //    "已接入"，而用户此刻正在走新的授权 —— 状态必须只有一个真相。
  delete record.tokens;
  delete record.last_error;
  const wrote = writePluginOAuth(uid, name, record);
  if (wrote.ok === false) {
    return { ok: false, error: 'STORE_UNAVAILABLE', message: `本地保存授权信息失败：${wrote.error}` };
  }

  const url = new URL(joinApiUrl(base, '/api/oauth/authorize'));
  url.searchParams.set('client_id', PLUGIN_CLIENT_ID);
  url.searchParams.set('redirect_uri', PLUGIN_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  // hub_token 走查询参数（平台契约如此）；平台侧负责不落日志、页面渲染后清除。
  url.searchParams.set('hub_token', hubToken);

  log.info('plugin authorize started', { package_name: name, base });
  return { ok: true, authorizeUrl: url.toString(), state };
}

// ── ③ 回调处理 ────────────────────────────────────────────────────────────

export type CallbackOutcome =
  | { ok: true; name: string; personId: string; role: string }
  | { ok: false; name?: string; error: string; message: string; needsReauth: boolean };

/** 失败码 → 面向用户的话。**不出现技术码**（SC-004）。 */
function callbackMessage(error: string): { message: string; needsReauth: boolean } {
  switch (error) {
    case 'state_mismatch':
      return { message: '授权校验未通过（状态不匹配），请重新点击「连接」', needsReauth: true };
    case 'flow_timeout':
      return { message: '授权等待超时，请重新点击「连接」', needsReauth: true };
    case 'missing_verifier':
      return { message: '本地授权信息缺失，请重新点击「连接」', needsReauth: true };
    case 'duplicate_code':
    case 'duplicate_state':
    case 'invalid_code':
    case 'invalid_state':
    case 'missing_code':
    case 'missing_state':
      return { message: '授权回调参数不合法，请重新点击「连接」', needsReauth: true };
    case 'INELIGIBLE':
    case 'no_eligibility':
      return { message: '这门课需要合作账号才能使用，请联系学校开通', needsReauth: false };
    // 这个教育身份已经连到**另一个** CogSeed 账号（平台的 identity_conflict）。
    // 🔴 不能与 INELIGIBLE 合并提示：那个指向课程负责人开通席位，这个指向管理员核对账号关系。
    //    needsReauth=false —— 重试不会变好，别让用户反复点「连接」。
    case 'identity_conflict':
      return { message: '这个教育身份已经连到另一个 CogSeed 账号，请联系管理员核对', needsReauth: false };
    // 账号被停用（平台的 account_disabled，来自 Hub 的 data.account.status）。
    // 同样 needsReauth=false：重试/重新登录都解除不了，只有管理员能恢复。
    case 'account_disabled':
      return { message: '这个账号已被停用，请联系平台管理员恢复', needsReauth: false };
    // 用户主动声明"这不是我的教育账号"，平台已解除绑定。
    // 🔴 needsReauth=true：这里**该**重新连一次（用正确的账号），与前面几条"重试没用"不同。
    case 'account_switch':
      return { message: '已解除这个教育身份的连接，请用正确的账号重新连接', needsReauth: true };
    case 'invalid_request':
      return { message: '授权请求无效，请重新点击「连接」', needsReauth: true };
    case 'server_error':
      return { message: '服务暂时不可用，请稍后重试', needsReauth: false };
    case 'access_denied':
      return { message: '你取消了授权', needsReauth: false };
    case 'NETWORK_ERROR':
      return { message: '网络不通，无法完成授权，请稍后重试', needsReauth: false };
    default:
      return { message: '授权未完成，请重新点击「连接」', needsReauth: true };
  }
}

/**
 * 消费一次 `cogseed://plugin/authorize/callback` 深链。
 *
 * 校验顺序（契约 §2）：识别 → 参数形状 → 找到待处理流程 → state 相等 →
 * 未超时 → 有 verifier → 换令牌 → 落盘 → 广播。
 */
export async function handlePluginAuthorizeCallbackUrl(
  rawUrl: string,
  opts: { uid?: string; now?: () => number } = {},
): Promise<CallbackOutcome> {
  const parsed = parsePluginCallback(rawUrl);
  if (parsed.ok === false) {
    if (parsed.error === 'not_a_plugin_callback') {
      return { ok: false, error: parsed.error, message: '不是插件授权回调', needsReauth: false };
    }
    if (parsed.error.startsWith('platform_error:')) {
      const code = parsed.error.slice('platform_error:'.length);
      const mapped = callbackMessage(code);
      // 平台会用 error= 深链回来（用户拒绝 / 无课程资格 / 服务异常）。
      // 这里必须**清掉待处理流程**并记下原因：
      //   · 不清 → 用户重试时会带着旧 state 撞上"state 不匹配"，像是坏了；
      //   · 不记 → 无资格（D）会被降级成"从没连过"（A），用户反复重试
      //     一件永远不会成功的事。
      try {
        const uidForCleanup = opts.uid ?? getActiveUserId();
        const state = parsed.url ? (new URL(parsed.url).searchParams.get('state') || '') : '';
        const match = findPendingByState(uidForCleanup, state);
        if (match) {
          const next: PluginOAuthRecord = { ...match.record, server_url: match.pending.server_url || match.record.server_url };
          delete next.pending;
          delete next.tokens;
          next.last_error = { code, at: new Date((opts.now ?? (() => Date.now()))()).toISOString() };
          writePluginOAuth(uidForCleanup, match.name, next);
        }
      } catch { /* 没有活跃用户 / 读不到注册表：回调本身仍要如实返回 */ }
      log.info('plugin authorize returned error', { code });
      broadcastAuthChanged({ result: 'failure', code });
      return { ok: false, error: code, ...mapped };
    }
    const mapped = callbackMessage(parsed.error);
    broadcastAuthChanged({ result: 'failure', code: parsed.error });
    return { ok: false, error: parsed.error, ...mapped };
  }

  let uid = opts.uid;
  if (!uid) {
    try { uid = getActiveUserId(); }
    catch { return { ok: false, error: 'NO_ACTIVE_USER', message: '当前没有登录的本地用户', needsReauth: false }; }
  }
  const nowMs = (opts.now ?? (() => Date.now()))();

  const match = findPendingByState(uid, parsed.state);
  if (!match) {
    // 🔴 找不到对应流程：**不消费** code，只报错。
    //    伪造回调常见形态就是随便编个 state；此处不能顺手把任何状态改掉。
    log.warn('plugin authorize callback without pending flow');
    broadcastAuthChanged({ result: 'failure', code: 'state_mismatch' });
    return { ok: false, error: 'state_mismatch', ...callbackMessage('state_mismatch') };
  }

  const name = match.name;
  const createdMs = Date.parse(match.pending.created_at);
  if (!Number.isFinite(createdMs) || nowMs - createdMs > FLOW_TIMEOUT_MS) {
    // 超时：清掉待处理流程（留着只会让用户下次点「连接」时又被旧 state 干扰）。
    const cleared: PluginOAuthRecord = { ...match.record, server_url: match.record.server_url };
    delete cleared.pending;
    writePluginOAuth(uid, name, cleared);
    broadcastAuthChanged({ result: 'failure', code: 'flow_timeout' });
    return { ok: false, name, error: 'flow_timeout', ...callbackMessage('flow_timeout') };
  }

  const base = match.pending.server_url || match.record.server_url || resolveEduSeedBase(undefined);
  if (!base) {
    return { ok: false, name, error: 'NO_PLATFORM_URL', message: '未配置平台地址', needsReauth: false };
  }

  const exchanged = await postJson(joinApiUrl(base, '/api/oauth/token'), {
    grant_type: 'authorization_code',
    code: parsed.code,
    code_verifier: match.pending.code_verifier,
    client_id: PLUGIN_CLIENT_ID,
    redirect_uri: PLUGIN_REDIRECT_URI,
    // 🔴 设备稳定 ID（安全审计 2026-09-21）：平台把它写进会话并**在续期时校验**，
    //    用于支撑"同一账号不同设备需重新授权"的语义。此前客户端从不发送，
    //    平台那份校验因此**永远不会失败**（缺字段就代入会话自己的值）—— 等于没有。
    device_id: getOrCreateDeviceId(uid),
  });

  if (exchanged.ok === false) {
    const fatal = exchanged.code === 'INVALID_GRANT' || exchanged.code === 'INVALID_CLIENT';
    // 🔴 写回前**重读最新记录**（安全审计 2026-09-21）。
    //    原实现用网络请求**之前**读到的 `match.record` 写回，而它没有 `tokens` 字段：
    //    同一 state 的回调被并发投递两次（或 OS 对同一 URL 触发两次）时，
    //    失败那次会把成功那次刚落盘的令牌**整段抹掉**，用户表现为"点完同意仍是未连接"。
    const latestNow = readPluginOAuth(uid, name).record;
    if (latestNow.tokens) {
      // 并发下另一个回调已经成功 → 这次失败不得覆盖它（只记日志，不动盘）
      log.warn('plugin token exchange failed, but tokens already present (concurrent success)', {
        package_name: name,
        code: exchanged.code,
      });
    } else {
      const record: PluginOAuthRecord = {
        ...latestNow,
        server_url: base,
        last_error: { code: exchanged.code, at: new Date(nowMs).toISOString() },
      };
      if (fatal) delete record.pending; // 码已被消费/无效，留着没意义
      writePluginOAuth(uid, name, record);
    }
    const classified = callbackMessage(exchanged.code);
    log.warn('plugin token exchange failed', { package_name: name, code: exchanged.code, status: exchanged.status });
    broadcastAuthChanged({ result: 'failure', code: exchanged.code });
    return {
      ok: false,
      name,
      error: exchanged.code,
      // 🔴 needsReauth 由**分类**决定，不能一律 true：
      //    网络不通时让用户"重新连接"是让他白跑一趟（连不上还是连不上）。
      message: exchanged.message || classified.message,
      needsReauth: classified.needsReauth,
    };
  }

  const d = exchanged.data;
  const accessToken = typeof d.access_token === 'string' ? d.access_token : '';
  const refreshToken = typeof d.refresh_token === 'string' ? d.refresh_token : '';
  if (!accessToken || !refreshToken) {
    return { ok: false, name, error: 'MALFORMED_RESPONSE', message: '平台未返回有效令牌', needsReauth: false };
  }

  // 令牌响应**不含** binding（契约 v1.0.1 修正）→ 另查一次接入关系。
  let personId = '';
  let role = '';
  const binding = await getJson(joinApiUrl(base, '/api/oauth/binding'), { bearer: accessToken });
  if (binding.ok === true && binding.data.bound === true) {
    personId = typeof binding.data.person_id === 'string' ? binding.data.person_id : '';
    role = typeof binding.data.role === 'string' ? binding.data.role : '';
  }

  const record: PluginOAuthRecord = {
    server_url: base,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      access_expires_at: new Date(nowMs + num(d.expires_in, 3600) * 1000).toISOString(),
      refresh_expires_at: new Date(nowMs + num(d.refresh_expires_in, 2592000) * 1000).toISOString(),
      binding: personId || role ? { person_id: personId || undefined, role: role || undefined } : undefined,
    },
    // pending 用完即弃：同一 state 不能被复用第二次。
  };
  const wrote = writePluginOAuth(uid, name, record);
  if (wrote.ok === false) {
    // 🔴 令牌没落盘 → 不能对外宣称成功（否则下次命令无令牌可用）。
    log.warn('plugin oauth persist failed after exchange', { package_name: name });
    broadcastAuthChanged({ result: 'failure', code: 'STORE_UNAVAILABLE' });
    return { ok: false, name, error: 'STORE_UNAVAILABLE', message: `本地保存授权失败：${wrote.error}`, needsReauth: false };
  }

  // 🔴 授权成功就**立刻**物化运行时凭据：用户在浏览器点完同意、切回来就能直接
  //    在对话里用插件，不必先点一次插件页（那条路径才会触发 resolvePluginCredential）。
  writeRuntimeCredential(uid, name, {
    server_url: base,
    api_key: accessToken,
    student_id: personId || undefined,
    role: role || undefined,
    expires_at: record.tokens?.access_expires_at,
    source: 'oauth',
  });

  log.info('plugin authorize completed', { package_name: name, bound: !!personId });
  broadcastAuthChanged({ result: 'success', name });
  return { ok: true, name, personId, role };
}

// ── 刷新（注入路径复用） ──────────────────────────────────────────────────

/**
 * 刷新失败码 → 是否需要用户重新授权。
 *
 * 判定标准：**这个失败用户自己能解决吗？**
 *   · 令牌/绑定/登录态类 → 用户重新连接就能好 → true
 *   · 服务不可达 / 数据库不可用 / 客户端缺陷 → 重新授权也没用 → false（界面给「重试」）
 */
export function classifyRefreshFailure(code: string, status: number): { needsReauth: boolean; message: string } {
  switch (code) {
    case 'INVALID_REFRESH_TOKEN':
      return { needsReauth: true, message: '授权已失效，请重新连接' };
    case 'DEVICE_MISMATCH':
      // 安全审计 2026-09-21：设备绑定修好之后这条**才真的会发生**（换机/重装/删掉设备标识文件）。
      // 说清原因是必要的 —— 用户看到"授权已失效"会以为是自己或平台出了问题。
      return {
        needsReauth: true,
        message: '本机登录凭据与授权时的设备不一致（可能重装或换机），请重新连接',
      };
    case 'TOKEN_REPLAY_DETECTED':
      return { needsReauth: true, message: '检测到授权信息异常，已为安全起见断开全部会话，请重新连接' };
    case 'BINDING_REVOKED':
      return { needsReauth: true, message: '接入关系已解除，请重新连接' };
    case 'BINDING_REVOKED_BY_ADMIN':
      return { needsReauth: true, message: '接入关系已被管理员解除' };
    case 'HUB_SESSION_REVOKED':
      return { needsReauth: true, message: '你已在其他设备退出登录，请重新登录后再连接' };
    case 'HUB_DEVICE_REVOKED':
      return { needsReauth: true, message: '此设备的登录授权已被移除，请重新登录' };
    case 'HUB_IDENTITY_MISMATCH':
      return { needsReauth: true, message: '当前登录账号与授权账号不一致，请重新连接' };
    case 'HUB_TOKEN_REQUIRED':
      return { needsReauth: true, message: '缺少登录凭据，请重新登录后再连接' };
    case 'AUTH_REQUIRED':
      return { needsReauth: true, message: '请先登录 CogSeed 账号' };
    case 'ACCOUNT_SUSPENDED':
      return { needsReauth: true, message: '账号已被冻结，请联系管理员' };
    case 'ACCESS_TOKEN_INVALID':
    case 'ACCESS_TOKEN_REQUIRED':
      return { needsReauth: true, message: '授权已失效，请重新连接' };
    // 下面这些重新授权也没用：服务端/客户端的问题，界面应该给「重试」。
    case 'HUB_UNREACHABLE':
      return { needsReauth: false, message: '账号服务暂时不可用，请稍后重试' };
    case 'AUTH_DB_UNAVAILABLE':
    case 'AUTH_DB_NOT_CONFIGURED':
      return { needsReauth: false, message: '授权服务暂时不可用，请稍后重试' };
    case 'NETWORK_ERROR':
      return { needsReauth: false, message: '网络不通，请检查网络后重试' };
    case 'INVALID_CLIENT':
    case 'UNSUPPORTED_GRANT_TYPE':
    case 'INVALID_REQUEST':
      return { needsReauth: false, message: '客户端与平台版本不匹配，请更新 CogSeed' };
    default:
      return status >= 500
        ? { needsReauth: false, message: '授权服务暂时不可用，请稍后重试' }
        : { needsReauth: true, message: '授权未完成，请重新连接' };
  }
}

/**
 * Hub 错误码归一化。
 *
 * `HUB_NETWORK_ERROR`（Hub 客户端自己的网络失败码）与 `HUB_UNREACHABLE`
 * （平台侧复验 Hub 时的失败码）是**同一类**：Hub 联系不上。
 * 不归一化的话，界面文案会分叉成两套，而用户看到的现象是同一个。
 */
function normalizeHubCode(raw: string): string {
  return raw === 'HUB_NETWORK_ERROR' ? 'HUB_UNREACHABLE' : raw;
}

/** 从任意异常里取出 Hub 错误码（非 HubApiError → 视为 Hub 不可达）。 */
function hubCodeOf(err: unknown): string {
  return normalizeHubCode(err instanceof HubApiError ? err.code : 'HUB_UNREACHABLE');
}

/** 取当前 Hub 访问令牌；失败返回原因码（调用方 fail-closed）。 */
async function currentHubToken(uid: string): Promise<{ ok: true; token: string } | { ok: false; code: string }> {
  try {
    const session = await ensureFreshSession(uid);
    const token = session.access_token;
    return token ? { ok: true, token } : { ok: false, code: 'AUTH_REQUIRED' };
  } catch (err) {
    const mapped = hubCodeOf(err);
    log.warn('hub token unavailable for plugin refresh', { code: mapped });
    return { ok: false, code: mapped };
  }
}

/** 调平台 `/api/oauth/refresh`（含 DECISION-2 的 hub_token 复验）。 */
export async function refreshPluginTokens(
  uid: string,
  input: { refreshToken: string; serverUrl: string },
): Promise<RefreshResult> {
  const hub = await currentHubToken(uid);
  if (hub.ok === false) {
    const c = classifyRefreshFailure(hub.code, 0);
    return { ok: false, code: hub.code, message: c.message, needsReauth: c.needsReauth };
  }

  const base = resolveEduSeedBase(input.serverUrl);
  if (!base) return { ok: false, code: 'NO_PLATFORM_URL', message: '未配置平台地址', needsReauth: false };

  const res = await postJson(joinApiUrl(base, '/api/oauth/refresh'), {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: PLUGIN_CLIENT_ID,
    hub_token: hub.token,
    // 🔴 必须带上：平台在续期时校验设备与签发时一致（见 token 交换处的说明）
    device_id: getOrCreateDeviceId(uid),
  });

  if (res.ok === true) {
    const access = typeof res.data.access_token === 'string' ? res.data.access_token : '';
    const refresh = typeof res.data.refresh_token === 'string' ? res.data.refresh_token : '';
    if (!access || !refresh) {
      return { ok: false, code: 'MALFORMED_RESPONSE', message: '平台未返回有效令牌', needsReauth: false };
    }
    return {
      ok: true,
      access_token: access,
      refresh_token: refresh,
      expires_in: num(res.data.expires_in, 3600),
      refresh_expires_in: num(res.data.refresh_expires_in, 2592000),
    };
  }

  const c = classifyRefreshFailure(res.code, res.status);
  // 🔴 重放检测用**我们**的文案：服务端只说"重放"，用户需要知道的是
  //    "这可能是安全问题，已断开全部会话"。这条信息不能被服务端原文覆盖掉。
  const message = res.code === 'TOKEN_REPLAY_DETECTED' ? c.message : (res.message || c.message);
  return { ok: false, code: res.code, message, needsReauth: c.needsReauth };
}

// ── 注入路径（插件零改动的落点） ──────────────────────────────────────────

/** 每个（用户, 包）一个单飞闸门：并发命令不会拿同一个 refresh 刷两次。 */
const refreshGates = new Map<string, <T>(fn: () => Promise<T>) => Promise<T>>();

function gateFor(uid: string, name: string): <T>(fn: () => Promise<T>) => Promise<T> {
  const key = `${uid}\u0000${name}`;
  let gate = refreshGates.get(key);
  if (!gate) {
    gate = createSingleFlightRunner();
    refreshGates.set(key, gate);
  }
  return gate;
}

/** 仅供测试：清掉闸门缓存（否则用例之间会共享在途 Promise）。 */
export function _resetRefreshGatesForTest(): void {
  refreshGates.clear();
}

export interface ResolvedCredential {
  ok: true;
  /** 注入给插件进程的 `EDUSEED_API_KEY` 值。 */
  apiKey: string;
  serverUrl: string;
  /** 本次是否发生了刷新（诊断用，不是敏感信息）。 */
  refreshed: boolean;
  /** 'oauth' = 授权令牌；'legacy' = 用户手工粘贴的 API Key。 */
  method: 'oauth' | 'legacy';
}

export type ResolveCredentialResult =
  | ResolvedCredential
  | { ok: false; reason: InjectionFailureReason; message: string; needsReauth: boolean };

/**
 * 解析出要注入给插件进程的凭据。
 *
 * 🔴 优先级：**授权令牌 > 手工 API Key**。
 *    一旦用户完成过授权，令牌就是唯一真相；继续沿用旧的手工 Key 会让
 *    "撤销授权"失效（插件仍能用旧 Key 跑）—— 那是安全漏洞，不是兼容性。
 *    反之，没授权过的存量用户**照旧可用**手工 Key（不做破坏性升级）。
 */
export async function resolvePluginCredential(
  uid: string,
  name: string,
  legacy: { apiKey?: string; serverUrl?: string; studentId?: string; role?: string },
  opts: { now?: () => number; refresh?: (input: { refreshToken: string; serverUrl: string }) => Promise<RefreshResult> } = {},
): Promise<ResolveCredentialResult> {
  const { record, corrupt } = readPluginOAuth(uid, name);

  if (!record.tokens) {
    if (legacy.apiKey) {
      return {
        ok: true,
        apiKey: legacy.apiKey,
        serverUrl: legacy.serverUrl || resolveEduSeedBase(undefined) || '',
        refreshed: false,
        method: 'legacy',
      };
    }
    return {
      ok: false,
      reason: corrupt ? 'STORE_UNAVAILABLE' : 'NOT_AUTHORIZED',
      message: corrupt
        ? '本地授权信息已损坏，请重新连接课程平台'
        : '尚未连接课程平台，请在插件配置里点击「连接」完成授权',
      needsReauth: true,
    };
  }

  const state: OAuthTokenState = {
    access_token: record.tokens.access_token,
    refresh_token: record.tokens.refresh_token,
    access_expires_at: record.tokens.access_expires_at,
    refresh_expires_at: record.tokens.refresh_expires_at,
    binding: record.tokens.binding,
    server_url: record.server_url,
  };

  const gate = gateFor(uid, name);
  const outcome = await gate(() =>
    resolveAccessToken({
      now: opts.now,
      load: () => state,
      save: (next) => {
        // 🔴 只写令牌相关字段，保留 pending/last_error（并发下 pending 不能被抹掉）。
        const latest = readPluginOAuth(uid, name).record;
        const wrote = writePluginOAuth(uid, name, {
          ...latest,
          server_url: next.server_url ?? latest.server_url,
          tokens: {
            access_token: next.access_token,
            refresh_token: next.refresh_token,
            access_expires_at: next.access_expires_at,
            refresh_expires_at: next.refresh_expires_at,
            binding: next.binding ?? latest.tokens?.binding,
          },
        });
        // 抛错 → resolveAccessToken 归为 STORE_UNAVAILABLE 并中止命令（防重放）。
        if (wrote.ok === false) throw new Error(wrote.error);
      },
      refresh: opts.refresh ?? ((input) => refreshPluginTokens(uid, input)),
    }),
  );

  if (outcome.ok === false) {
    // 需要重新授权时把原因落盘：界面据此区分「已失效」与「无资格」。
    if (outcome.needsReauth) {
      const latest = readPluginOAuth(uid, name).record;
      writePluginOAuth(uid, name, {
        ...latest,
        last_error: { code: outcome.reason, at: new Date((opts.now ?? (() => Date.now()))()).toISOString() },
      });
      // 🔴 顺手删掉物化的明文令牌（安全审计 2026-09-21）：
      //    这条路径此前只写 last_error，**明文文件原样留着** —— 而它已经确定不可用了。
      //    不删的唯一后果就是"一枚凭据形状的字符串长期躺在盘上"。
      clearRuntimeCredential(uid, name);
    }
    return { ok: false, reason: outcome.reason, message: outcome.message, needsReauth: outcome.needsReauth };
  }

  const serverUrl = record.server_url || legacy.serverUrl || resolveEduSeedBase(undefined) || '';
  // 🔴 物化给 `bin/run-skill.cjs`（对话里让智能体调插件走的是那条路径，
  //    它读不了加密的 oauth 文件；见 plugin_oauth_store.ts 的说明）。
  //    每次解析成功都覆盖，保证它拿到的是**当前有效**的令牌。
  const latestTokens = readPluginOAuth(uid, name).record.tokens;
  writeRuntimeCredential(uid, name, {
    server_url: serverUrl,
    api_key: outcome.apiKey,
    student_id: latestTokens?.binding?.person_id || legacy.studentId || undefined,
    role: latestTokens?.binding?.role || legacy.role || undefined,
    expires_at: latestTokens?.access_expires_at || new Date((opts.now ?? (() => Date.now()))() + 3600_000).toISOString(),
    source: 'oauth',
  });
  return {
    ok: true,
    apiKey: outcome.apiKey,
    serverUrl,
    refreshed: outcome.refreshed,
    method: 'oauth',
  };
}

// ── 状态查询（界面用，只出掩码） ──────────────────────────────────────────

export type PluginAuthState = 'A' | 'B' | 'C' | 'D' | 'F';

export interface PluginAuthStatus {
  state: PluginAuthState;
  method: 'oauth' | 'legacy' | 'none';
  authorized: boolean;
  /** 只出掩码，永不含明文令牌。 */
  maskedAccess: string;
  expiresInSeconds: number;
  needsRefresh: boolean;
  personId: string;
  role: string;
  serverUrl: string;
  /** 授权已失效 / 需要用户重新连接。 */
  needsReauth: boolean;
  /** 本地记录损坏（需要重新连接，且要如实告知）。 */
  corrupt: boolean;
  lastErrorCode: string;
  /** 平台基址是否已知（未配置时界面应先让用户填/由密钥带出）。 */
  hasPlatformUrl: boolean;
  /**
   * 本地是否还有 Hub 登录会话（**只读本地文件，不发网络请求**）。
   *
   * 🔴 为什么状态查询要带这个（2026-09-21 真人验收发现的缺陷）：
   *   用户在 Hub 仍登录时点了「连接课程平台」（系统记下"等待浏览器确认"），
   *   随后**在 CogSeed 里登出了 Hub**。此时界面仍显示「**已登录**，还差一步」——
   *   因为态 B 原先只检查 `record.pending`，**完全不看 Hub 是否还在登录**。
   *   后果：用户被误导去浏览器确认，而那个待确认流程里带的是**登出前的旧凭证**，
   *   多半失败且原因对用户不可解释。
   *
   *   同项目里另外两处 Hub 状态显示（左下角账号区、设置页账号面板）都是
   *   **实时依据会话**判断的；只有这里漏了 —— 所以是本模块的缺陷，不是全局问题。
   */
  hubSignedIn: boolean;
}

/**
 * 界面状态（契约 §3 的态 A/B/C/D/F）。
 *
 * 只读、无网络 —— 界面可以随时调，不会因为平台抖动而卡住或误报。
 */
export function getPluginAuthStatus(
  uid: string,
  name: string,
  legacy: { apiKey?: string; serverUrl?: string } = {},
  nowMs: number = Date.now(),
): PluginAuthStatus {
  const { record, corrupt } = readPluginOAuth(uid, name);
  // Hub 登录态：只读本地会话文件（解密一次），**不发网络请求** ——
  // 状态查询必须能随时被界面调用而不卡顿。
  const hubSignedIn = (() => {
    try { return !!loadHubSession(uid); } catch { return false; }
  })();
  const base = resolveEduSeedBase(record.server_url || legacy.serverUrl);

  const empty = {
    method: 'none' as const,
    authorized: false,
    maskedAccess: '',
    expiresInSeconds: 0,
    needsRefresh: false,
    personId: '',
    role: '',
    serverUrl: base || '',
    corrupt,
    lastErrorCode: record.last_error?.code ?? '',
    hasPlatformUrl: !!base,
    hubSignedIn,
  };

  // 🔴 D（无课程资格）只在服务端**明确说过**时成立，本地绝不猜 ——
  //    平台用的码是 `no_eligibility`（见 authorize-flow.ts::buildErrorCallback），
  //    这里同时认历史写法，避免联调期因为拼写差异把 D 降级成 A。
  const lastError = record.last_error?.code ?? '';
  const isIneligible = lastError === 'no_eligibility' || lastError === 'INELIGIBLE'
    || lastError === 'NOT_ELIGIBLE' || lastError === 'NO_SEAT';

  if (record.tokens) {
    const display = describeAuthForDisplay(
      {
        access_token: record.tokens.access_token,
        refresh_token: record.tokens.refresh_token,
        access_expires_at: record.tokens.access_expires_at,
        refresh_expires_at: record.tokens.refresh_expires_at,
        binding: record.tokens.binding,
      },
      nowMs,
    );
    const refreshExpired = Date.parse(record.tokens.refresh_expires_at) <= nowMs;
    // 有令牌时：过期就是 F；否则就是 C（令牌在手上就是"已接入"）。
    const state: PluginAuthState = refreshExpired ? 'F' : 'C';
    return {
      ...empty,
      state,
      method: 'oauth',
      authorized: state === 'C',
      maskedAccess: display.maskedAccess,
      expiresInSeconds: display.expiresInSeconds,
      needsRefresh: display.needsRefresh,
      personId: display.personId,
      role: display.role,
      needsReauth: state !== 'C',
    };
  }

  // 顺序要紧：**进行中（B）优先于上次的失败原因**。
  // 用户点了「重新连接」之后，界面应显示"去浏览器完成确认"，
  // 而不是继续显示上一次的"无资格"。
  //
  // 🔴 但"进行中"有保质期：平台的**无资格**分支是**渲染页面**（不深链回来），
  //    用户看到"这门课需要合作账号"后关掉标签页 —— 此时永远不会有回调。
  //    若一直显示 B，界面就永远停在"去浏览器完成确认"，用户无从下手。
  //    超过流程有效期即回落 A（此处**只读不写**：清理由下一次发起授权负责）。
  if (record.pending) {
    const pendingAge = Number.isFinite(Date.parse(record.pending.created_at))
      ? nowMs - Date.parse(record.pending.created_at)
      : Number.POSITIVE_INFINITY;
    if (pendingAge > FLOW_TIMEOUT_MS) {
      return { ...empty, state: 'A', needsReauth: true };
    }
    // 🔴 Hub 已登出时**不得**再宣称"已登录"：那个待确认流程里的凭证已失效，
    //    正确动作是先去登录 Hub（而不是去浏览器确认）。
    if (!hubSignedIn) {
      return { ...empty, state: 'A', needsReauth: true };
    }
    return { ...empty, state: 'B', needsReauth: false };
  }

  if (isIneligible) {
    // D：不是故障，是资格问题 —— 必须给出路（联系开通），而不是让人重试。
    return { ...empty, state: 'D', needsReauth: false };
  }

  if (legacy.apiKey) {
    // 存量用户：手工 Key 仍在用，界面**不**呈现"未接入"。
    return { ...empty, state: 'C', method: 'legacy', authorized: true, needsReauth: false };
  }

  return { ...empty, state: 'A', needsReauth: true };
}

// ── 断开 ──────────────────────────────────────────────────────────────────

export type DisconnectResult =
  | { ok: true; revoked: number; serverRevoked: boolean }
  | { ok: false; error: string; message: string };

/**
 * 断开授权（本地清理 + 尽力通知平台撤销）。
 *
 * 🔴 顺序：**先**清本地，**再**通知平台。
 *    反过来的话，平台撤销成功但本地清理失败 → 插件仍持可用令牌（安全问题）；
 *    而当前顺序下最坏情况是"平台侧会话还活着直到自然过期"，用户可重申撤销。
 */
export async function disconnectPluginAuthorization(
  uid: string,
  name: string,
  opts: { revokeAll?: boolean } = {},
): Promise<DisconnectResult> {
  const { record } = readPluginOAuth(uid, name);
  const base = resolveEduSeedBase(record.server_url);
  const accessToken = record.tokens?.access_token ?? '';

  clearPluginOAuth(uid, name);
  // 🔴 物化文件也要删：否则 run-skill.cjs 那条路径仍能拿到已撤销的令牌
  clearRuntimeCredential(uid, name);
  refreshGates.delete(`${uid}\u0000${name}`);

  let revoked = 0;
  let serverRevoked = false;
  if (accessToken && base) {
    const res = await postJson(joinApiUrl(base, '/api/oauth/revoke'), {
      scope: opts.revokeAll ? 'all' : 'session',
      ...(record.tokens?.refresh_token ? { token: record.tokens.refresh_token } : {}),
    }, { bearer: accessToken });
    if (res.ok === true) {
      serverRevoked = true;
      revoked = typeof res.data.revoked_sessions === 'number' ? res.data.revoked_sessions : 0;
    } else {
      // 本地已清干净；平台侧撤销失败只记状态，不阻塞用户。
      log.warn('plugin revoke failed', { package_name: name, code: res.code, status: res.status });
    }
  }

  broadcastAuthChanged({ result: 'disconnected', name });
  log.info('plugin authorization disconnected', { package_name: name, server_revoked: serverRevoked });
  return { ok: true, revoked, serverRevoked };
}

// ── 界面通知 ──────────────────────────────────────────────────────────────

export interface PluginAuthChanged {
  result: 'success' | 'failure' | 'disconnected';
  name?: string;
  code?: string;
}

/**
 * 通知界面（授权是在浏览器里完成的，renderer 没在等这个结果）。
 *
 * 与 `hub_account/account-events.ts` 同一模式：懒 require 避免
 * feature → IPC 的初始化环；测试环境没有 IPC 时静默跳过（状态已落盘，
 * 丢的只是"实时刷新"）。
 */
export function broadcastAuthChanged(change: PluginAuthChanged): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    ipc.broadcastToRenderer?.('packages:auth-changed', change);
  } catch {
    /* tests / no IPC bridge */
  }
}

// 应用启动后启动后台续期（deferred 阶段：不挡首屏）。
// 与 features/marketplace.ts 的 registerDeferred 用法一致；
// 启动瞬间还没有活跃用户（activateUser 稍后执行），所以第一轮失败会被 tick 静默跳过。
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const boot = require('../util/boot_init') as {
    registerDeferred?: (name: string, fn: () => void) => void;
  };
  boot.registerDeferred?.('plugin-oauth:background-refresh', () => {
    startBackgroundCredentialRefresh(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
        const users = require('./users') as { hasActiveUser?: () => boolean; getActiveUserId: () => string };
        return users.hasActiveUser?.() ? users.getActiveUserId() : null;
      } catch {
        return null;
      }
    });
  });
  boot.registerDeferred?.('plugin-oauth:runtime-credential-sweep', () => {
    // 启动时清一次残留（安全审计 2026-09-21）：已过期的 `.runtime.json`（**明文令牌**）
    // 与原子写留下的 `*.tmp`。原实现只在"主动断开授权"时清理，过期与续期失败都不清。
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const users = require('./users') as { hasActiveUser?: () => boolean; getActiveUserId: () => string };
      if (users.hasActiveUser?.()) sweepStaleRuntimeCredentials(users.getActiveUserId());
    } catch {
      /* 维护动作，失败不影响功能 */
    }
  });
} catch {
  /* 测试环境 / 无 boot 流程：后台续期不启动，其余功能不受影响 */
}

export const _test = {
  parsePlatformFailure,
  unwrapData,
  pluginOAuthFile,
  classifyRefreshFailure,
};

// ── 后台续期（保证"对话路径"拿到的一直是新鲜令牌） ────────────────────────
//
// 🔴 为什么需要它：
//   对话里让智能体调插件走的是 `bin/run-skill.cjs`，它读的是主进程**物化**出来的
//   `<pkg>.runtime.json`（见 plugin_oauth_store.ts 的说明）。访问令牌只有约 1 小时，
//   而物化只在"插件页操作 / 授权完成"这些**用户主动动作**时发生 ——
//   用户开着一个会话聊一小时以上，令牌就会过期，表现为
//   「插件突然说没配置」，而且要看不出原因。
//
//   所以这里补一个**低频后台续期**：只要应用在跑、且有已授权的插件，
//   就定期把快到期的令牌刷新并重新物化。1 小时的令牌用 20 分钟的频率续，
//   留足余量；单次失败不影响下次（网络抖动不该让插件永久失效）。
//
// 失败处理：
//   · 刷新被拒（令牌被撤销 / 绑定解除 / Hub 登录失效）→ 记 warn 并**停止续期该包**
//     （继续重试没有意义，界面会显示"需要重新连接"）；
//   · 网络类失败 → 静默记 warn，下次继续（用户可能只是断网了）。

/** 后台续期间隔（20 分钟；访问令牌约 1 小时，留足余量）。 */
export const BACKGROUND_REFRESH_INTERVAL_MS = 20 * 60 * 1000;

let _refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 对所有已授权的包续期一次（刷新 + 重新物化）。
 *
 * 返回每个包的结果，供测试与诊断使用；**不抛错**。
 */
export async function refreshAllPluginCredentials(uid: string): Promise<Array<{ name: string; ok: boolean; reason?: string }>> {
  const out: Array<{ name: string; ok: boolean; reason?: string }> = [];
  let names: string[] = [];
  try {
    names = listOAuthRecordNames(uid);
  } catch {
    return out;
  }
  for (const name of names) {
    const { record } = readPluginOAuth(uid, name);
    // 只有真正持有令牌的包才需要续期（仅 pending / 仅 last_error 的跳过）
    if (!record.tokens) continue;
    try {
      const r = await resolvePluginCredential(uid, name, {});
      out.push(r.ok === true ? { name, ok: true } : { name, ok: false, reason: r.reason });
      if (r.ok === false && r.needsReauth) {
        // 需要用户重新连接：继续重试没有意义，只留一条可诊断的记录。
        log.warn('plugin credential needs reauth; background refresh skipped for this package', {
          package_name: name,
          reason: r.reason,
        });
      }
    } catch (err) {
      log.warn('plugin background refresh failed', { package_name: name, error: (err as Error).message });
      out.push({ name, ok: false, reason: 'THREW' });
    }
  }
  return out;
}

/**
 * 启动后台续期（幂等；应用启动时调一次）。
 *
 * 立刻跑一轮，然后按 {@link BACKGROUND_REFRESH_INTERVAL_MS} 周期执行。
 * 定时器用 `unref()`，不阻止进程退出。
 */
export function startBackgroundCredentialRefresh(getUid: () => string | null): () => void {
  const tick = async () => {
    let uid: string | null = null;
    try { uid = getUid(); } catch { uid = null; }
    if (!uid) return; // 还没有活跃用户：跳过，下一轮再看
    try {
      await refreshAllPluginCredentials(uid);
    } catch (err) {
      log.warn('plugin background refresh pass failed', { error: (err as Error).message });
    }
  };
  void tick();
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(() => { void tick(); }, BACKGROUND_REFRESH_INTERVAL_MS);
  // 后台续期不该拖住进程退出
  if (typeof (_refreshTimer as { unref?: () => void }).unref === 'function') {
    (_refreshTimer as { unref: () => void }).unref();
  }
  return () => {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  };
}

/** 仅供测试：停掉定时器。 */
export function _stopBackgroundRefreshForTest(): void {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}
