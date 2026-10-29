/**
 * plugin-oauth-tokens.ts —— 插件接入的令牌管理与注入（模块 A · 客户端侧）
 *
 * 契约：`specs/001-plugin-oauth-auth/contracts/callback-protocol.md` §4（注入时序）/ §5（本地存储）
 *
 * 🔴 本模块的核心目标：**插件零改动**。
 *   插件一直读 `EDUSEED_API_KEY` 环境变量；改造后仍读这个名字，
 *   只是值从"开发者手工配的长期 API Key"换成"授权拿到的短期访问令牌"。
 *   插件进程完全无感 —— 刷新发生在**注入之前**，它只看到一个有效令牌。
 *
 * 🔴 三条不变量：
 *   ① **刷新必须发生在注入前**：命令为短命进程（硬超时 2 分钟），
 *      1 小时的访问令牌覆盖任何单次命令的生命周期，注入后不会中途失效。
 *   ② **刷新不重复**：同一时刻只允许一个刷新请求在途（互斥锁）。
 *   ③ **失败不静默**：刷新失败时命令**不执行**，界面明确提示。
 *
 * 设计：全部依赖注入（时钟、fetch、存储），因此可以完整单测，
 * 不需要真的连平台、也不需要 Electron 环境。
 */

/** 本地令牌文件的结构（并入既有 `PluginRuntimeConfig` 同一文件）。 */
export interface OAuthTokenState {
  access_token: string;
  refresh_token: string;
  /** ISO 8601 */
  access_expires_at: string;
  /** ISO 8601 */
  refresh_expires_at: string;
  binding?: { person_id?: string; role?: string };
  server_url?: string;
}

/** 访问令牌剩余有效期低于此值即提前刷新（避免"发出请求的瞬间正好过期"）。 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** 注入失败的原因分类（界面据此决定给「重新连接」还是「重试」）。 */
export type InjectionFailureReason =
  | "NOT_AUTHORIZED"
  | "REFRESH_FAILED"
  | "REFRESH_TOKEN_EXPIRED"
  | "HUB_UNREACHABLE"
  | "STORE_UNAVAILABLE";

export type InjectionOutcome =
  | { ok: true; apiKey: string; refreshed: boolean }
  | {
      ok: false;
      /** 界面据此回落对应态（见契约 §6 的态 F） */
      reason: InjectionFailureReason;
      message: string;
      /** true = 需要用户重新授权（界面提示"重新连接"） */
      needsReauth: boolean;
    };

/**
 * `/oauth/refresh` 的返回。
 *
 * 🔴 抽成具名类型是必要的：写成内联联合时 TypeScript **无法**把 `ok` 当作判别属性，
 *    于是 `if (!r.ok)` 之后取不到 `message` / `needsReauth`（踩过）。
 */
export type RefreshResult =
  | {
      ok: true;
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_expires_in: number;
    }
  | { ok: false; code: string; message: string; needsReauth?: boolean };

export type TokenDeps = {
  now?: () => number;
  /** 读本地令牌；返回 null 表示未授权。读失败请抛错（会被归为 STORE_UNAVAILABLE）。 */
  load?: () => Promise<OAuthTokenState | null> | OAuthTokenState | null;
  /** 写回新令牌（刷新成功后必须落库）。 */
  save?: (state: OAuthTokenState) => Promise<void> | void;
  /** 调平台 /oauth/refresh。返回新令牌或失败原因。 */
  refresh?: (input: { refreshToken: string; serverUrl: string }) => Promise<RefreshResult>;
};

/** 令牌是否仍可用（不需要刷新）。 */
export function isAccessTokenFresh(state: OAuthTokenState, nowMs: number): boolean {
  const exp = Date.parse(state.access_expires_at);
  if (!Number.isFinite(exp)) return false;
  return exp - nowMs > REFRESH_SKEW_MS;
}

/** 刷新令牌是否仍在有效期内。 */
export function isRefreshTokenValid(state: OAuthTokenState, nowMs: number): boolean {
  const exp = Date.parse(state.refresh_expires_at);
  if (!Number.isFinite(exp)) return false;
  return exp > nowMs;
}

/** 把平台的 refresh 响应转成本地状态。 */
export function applyRefreshResponse(
  prev: OAuthTokenState,
  resp: { access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number },
  nowMs: number,
): OAuthTokenState {
  return {
    ...prev,
    access_token: resp.access_token,
    // 🔴 必须用响应里的新 refresh（旧的可能已被轮换/单次使用）
    refresh_token: resp.refresh_token || prev.refresh_token,
    access_expires_at: new Date(nowMs + Math.max(1, resp.expires_in) * 1000).toISOString(),
    refresh_expires_at: new Date(nowMs + Math.max(1, resp.refresh_expires_in) * 1000).toISOString(),
  };
}

/**
 * 解析出可注入的访问令牌。
 *
 * 时序（契约 §4）：
 *   读本地令牌 → 剩余 > 5 分钟？直接用 : 调 /oauth/refresh
 *     → 成功：写回新令牌并用它
 *     → 失败：中止命令，返回明确原因（**不静默**）
 */
export async function resolveAccessToken(deps: TokenDeps = {}): Promise<InjectionOutcome> {
  const now = (deps.now ?? (() => Date.now()))();

  let state: OAuthTokenState | null;
  try {
    state = (await deps.load?.()) ?? null;
  } catch (err) {
    return {
      ok: false,
      reason: "STORE_UNAVAILABLE",
      message: `读取本地授权信息失败：${err instanceof Error ? err.message : String(err)}`,
      needsReauth: false,
    };
  }

  if (!state || !state.access_token || !state.refresh_token) {
    return {
      ok: false,
      reason: "NOT_AUTHORIZED",
      message: "尚未连接 EduSeed，请先在插件中完成授权",
      needsReauth: true,
    };
  }

  // ① 未过期 → 直接用（最常见路径，无网络请求）
  if (isAccessTokenFresh(state, now)) {
    return { ok: true, apiKey: state.access_token, refreshed: false };
  }

  // ② 刷新令牌本身已过期 → 必须重新授权（刷新也没用）
  if (!isRefreshTokenValid(state, now)) {
    return {
      ok: false,
      reason: "REFRESH_TOKEN_EXPIRED",
      message: "授权已过期，请重新连接 EduSeed",
      needsReauth: true,
    };
  }

  // ③ 需要刷新
  if (!deps.refresh) {
    return {
      ok: false,
      reason: "REFRESH_FAILED",
      message: "缺少刷新实现（客户端缺陷）",
      needsReauth: false,
    };
  }

  const r = await deps.refresh({ refreshToken: state.refresh_token, serverUrl: state.server_url ?? "" });
  if (r.ok === false) {
    // 用显式 === false 判别（`!r.ok` 在本仓库的 tsconfig 下收窄行为不稳定）
    const needsReauth = r.needsReauth === true;
    return {
      ok: false,
      reason: needsReauth ? "REFRESH_TOKEN_EXPIRED" : "REFRESH_FAILED",
      message: r.message || "刷新授权失败，请重新连接 EduSeed",
      needsReauth,
    };
  }

  const next = applyRefreshResponse(state, r, now);
  try {
    await deps.save?.(next);
  } catch (err) {
    // 🔴 写回失败必须中止：拿着一个没落库的令牌继续跑，
    //    下次命令会再用旧 refresh（可能已被轮换）→ 触发重放检测、把全部会话撤销。
    return {
      ok: false,
      reason: "STORE_UNAVAILABLE",
      message: `保存新授权失败，已中止本次操作：${err instanceof Error ? err.message : String(err)}`,
      needsReauth: false,
    };
  }

  return { ok: true, apiKey: next.access_token, refreshed: true };
}

/**
 * 单飞包装：同一时刻只允许一个刷新在途（契约 §4「刷新不重复」）。
 *
 * 为什么必须有：多个插件命令可能几乎同时启动，各自都发现令牌过期 →
 * 若并发刷新，第二次会用到已被轮换的 refresh —— 平台侧会判为**重放**，
 * 进而撤销该账号**全部**会话（那是安全特性，但对用户是"莫名被踢"）。
 */
export function createSingleFlightRunner(): <T>(fn: () => Promise<T>) => Promise<T> {
  let inflight: Promise<unknown> | null = null;
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    if (inflight) return inflight as Promise<T>;
    const p = (async () => {
      try {
        return await fn();
      } finally {
        inflight = null;
      }
    })();
    inflight = p;
    return p;
  };
}

/**
 * 构造注入给插件进程的环境变量。
 *
 * 🔴 `EDUSEED_API_KEY` 这个名字**必须保持**（插件零改动的关键）。
 * 🔴 任何令牌字段都**不得**写入日志或遥测。
 */
export function buildInjectedEnv(
  base: Record<string, string | undefined>,
  input: { serverUrl: string; accessToken: string; studentId?: string; role?: string; cohort?: string; courseId?: string },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  env.EDUSEED_SERVER_URL = input.serverUrl;
  env.EDUSEED_API_KEY = input.accessToken;
  if (input.studentId) env.EDUSEED_STUDENT_ID = input.studentId;
  if (input.role) env.EDUSEED_ROLE = input.role;
  if (input.cohort) env.EDUSEED_COHORT = input.cohort;
  if (input.courseId) env.EDUSEED_COURSE_ID = input.courseId;
  return env;
}

/** 供界面/日志展示：只出掩码，永不含明文令牌。 */
export function describeAuthForDisplay(state: OAuthTokenState | null, nowMs: number): {
  authorized: boolean;
  maskedAccess: string;
  expiresInSeconds: number;
  needsRefresh: boolean;
  personId: string;
  role: string;
} {
  if (!state?.access_token) {
    return { authorized: false, maskedAccess: "", expiresInSeconds: 0, needsRefresh: false, personId: "", role: "" };
  }
  const exp = Date.parse(state.access_expires_at);
  const expiresInSeconds = Number.isFinite(exp) ? Math.max(0, Math.round((exp - nowMs) / 1000)) : 0;
  const t = state.access_token;
  return {
    authorized: true,
    maskedAccess: t.length > 8 ? `${t.slice(0, 8)}${'*'.repeat(Math.min(12, t.length - 8))}` : '*'.repeat(t.length),
    expiresInSeconds,
    needsRefresh: !isAccessTokenFresh(state, nowMs),
    personId: state.binding?.person_id ?? '',
    role: state.binding?.role ?? '',
  };
}
