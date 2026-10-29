// service_origins.ts —— Hub / 教育平台的**服务地址选择**（生产优先、本地兜底）
//
// 为什么需要这个文件（2026-10-26）
// ------------------------------
// 源码运行时，Hub 与教育平台的地址都只有"通道默认值"：
//   · Hub      → `http://localhost:3000`（本机根本没有 Hub 实现 → 登录必然失败）
//   · 平台     → `http://localhost:3000/edu`（端口还被别的服务占着）
// 于是每个新同事 `git clone` 完第一次点「登录 CogSeed 账号」都会卡住，
// 而报错只有一句"无法连接 Hub 服务"，不告诉他该改哪个变量。
//
// 现在的策略（按产品要求：两个服务各自独立、可任意组合）
// --------------------------------------------------------
//   ① 显式环境变量最优先（`COGSEED_HUB_API_BASE` / `EDUSEED_PLATFORM_BASE_URL`），不探测；
//   ② 否则探**生产**：能用就用生产；
//   ③ 生产不可用 → 探**本地候选**（仅 dev / unknown 通道）；
//   ④ 都不通 → 仍返回生产地址，并标记 `unreachable`，让上层报错能说清"两边都试过了"。
//
// 四条设计红线（改这个文件前先读）
// ------------------------------
//   1. **显式配置永远优先**，永不被探测结果覆盖（否则联调时无法强制指定）；
//   2. **只在启动时探一次**并缓存 —— 这两个解析函数在几十处被同步调用，
//      逐次探测会把授权流程变成一个会抖动的网络调用；
//   3. **一次授权流程内不切换**：缓存一旦写入就固定，流程中途绝不改（state 会错位）；
//   4. **release / packaged-dev 不做本地兜底**：发给用户的正式包如果"连不上生产就
//      偷偷连本机端口"，那台机器上跑的是什么没人知道。本地兜底只服务开发者。
//
// 关于"什么算走不通"（这条很容易做错）
// ----------------------------------
//   · Hub：`200` 或 `401` 都算可用 —— 401 说明"服务在、路由在，只差令牌"；
//   · 平台：**404 算不可用**（这台实例没部署插件授权路由），5xx 算不可用，其余算可用。
//     只探"健康检查"是不够的：生产的 `/api/health` 是 200，但
//     `/api/oauth/authorize` 是 404 —— 只看健康检查会选中一个"活着但没这功能"的生产。
import { createLogger } from '../logger';
import { resolveBuildIdentity } from '../util/build-identity';

const log = createLogger('service_origins');

/** 生产 Hub（账号服务）。内部部署地址，随仓库分发，供同事拉取后开箱可用。 */
export const PRODUCTION_HUB_BASE = 'https://cogseed-open.bonc.com.cn';
/** 生产教育平台。 */
export const PRODUCTION_PLATFORM_BASE = 'https://cogseed-open.bonc.com.cn/edu';

/** 本地 Hub 候选：3000 = 源码 dev 默认；4202 = packaged-dev 的本机账号服务。 */
export const LOCAL_HUB_CANDIDATES = ['http://127.0.0.1:3000', 'http://127.0.0.1:4202'] as const;
/** 本地平台候选：3001 = 当前启用的源码 dev 平台；3000 = 更早的构建。 */
export const LOCAL_PLATFORM_CANDIDATES = ['http://127.0.0.1:3001/edu', 'http://127.0.0.1:3000/edu'] as const;

/** 单次探测超时。取 1.8s：既够跨公网握手，又不至于让人干等。 */
export const PROBE_TIMEOUT_MS = 1800;

/** 探测用的固定 state（只用于识别日志，不参与任何授权语义）。 */
export const PROBE_STATE = 'connectivity-probe';

export type ServiceSource = 'env' | 'production' | 'local' | 'unreachable';

export type ServiceChoice = {
  /** 最终选定的基址（`unreachable` 时是生产地址，便于报错里给出"应该连哪"）。 */
  base: string;
  source: ServiceSource;
  /** 依次试过的地址（诊断用，不含凭据；只放 origin/路径）。 */
  probed: string[];
};

export type ServiceSelection = {
  hub: ServiceChoice;
  platform: ServiceChoice;
  /** 解析时的构建通道，界面上要显示"你现在连的是哪一档"。 */
  channel: string;
};

export type Probe = (url: string) => Promise<number | null>;

const stripTrailingSlash = (v: string): string => v.replace(/\/+$/, '');

/** Hub 可用性探测地址（账号 `/me`：不需要令牌，没令牌返回 401）。 */
export function hubProbeUrl(base: string): string {
  return `${stripTrailingSlash(base)}/api/v1/account/me`;
}

/** Hub 是否可用：`200` 有令牌、`401` 没令牌 —— 两者都说明服务与路由都在。 */
export function hubReachable(status: number | null): boolean {
  return status === 200 || status === 401;
}

/**
 * 平台可用性探测地址。
 *
 * 🔴 刻意用一个**不存在的 client_id**：授权路由的参数校验在写库之前，
 *    所以这次探测会拿到 400 而**不会插入 state 行**（无副作用）。
 *    用合法 client_id 探测会每次启动往 state 表塞一行垃圾。
 */
export function platformProbeUrl(base: string): string {
  const q = new URLSearchParams({
    client_id: '__connectivity_probe__',
    redirect_uri: 'cogseed://plugin/authorize/callback',
    response_type: 'code',
    code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256',
    state: PROBE_STATE,
  });
  return `${stripTrailingSlash(base)}/api/oauth/authorize?${q.toString()}`;
}

/**
 * 平台是否可用。
 *
 * 🔴 `404` 必须判为不可用 —— 这正是当前生产的状态：
 *    平台活着（`/api/health` = 200），但插件授权路由还没部署。
 *    只看"服务活着"会选中一个功能缺失的生产环境。
 */
export function platformReachable(status: number | null): boolean {
  if (status === null) return false; // 连不上 / 超时
  if (status === 404) return false; // 路由没部署
  return status < 500; // 400（参数不合法）、200、401（要登录）都算路由存在
}

/** 只有 dev / unknown 允许本地兜底；release 与 packaged-dev 不做。 */
export function channelAllowsLocalFallback(channel: string): boolean {
  return channel === 'dev' || channel === 'unknown';
}

/** 默认探测实现：拿到 HTTP 状态码，任何异常一律 `null`（= 不可用）。 */
export const probeHttpStatus: Probe = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 纯选择逻辑（探测函数可注入，便于单测；不做任何缓存与全局状态）。
 *
 * 顺序：env → 生产 → 本地候选 → 生产（标记 unreachable）
 */
export async function selectServices(input: {
  channel: string;
  envHub?: string | undefined;
  envPlatform?: string | undefined;
  probe: Probe;
  localHub?: readonly string[];
  localPlatform?: readonly string[];
  /** 是否允许本地兜底，默认按通道判定（单测可直接指定） */
  allowLocal?: boolean;
}): Promise<ServiceSelection> {
  const allowLocal = input.allowLocal ?? channelAllowsLocalFallback(input.channel);
  const localHub = input.localHub ?? LOCAL_HUB_CANDIDATES;
  const localPlatform = input.localPlatform ?? LOCAL_PLATFORM_CANDIDATES;

  const pick = async (opts: {
    production: string;
    envValue: string | undefined;
    candidates: readonly string[];
    probeUrl: (base: string) => string;
    reachable: (status: number | null) => boolean;
  }): Promise<ServiceChoice> => {
    const envValue = (opts.envValue ?? '').trim();
    if (envValue) {
      // ① 显式配置：直接用，不探测（联调要能强制指定）
      return { base: stripTrailingSlash(envValue), source: 'env', probed: [] };
    }
    const probed: string[] = [];
    // ② 生产
    probed.push(opts.production);
    if (opts.reachable(await input.probe(opts.probeUrl(opts.production)))) {
      return { base: opts.production, source: 'production', probed };
    }
    // ③ 本地候选（仅开发者通道）
    if (allowLocal) {
      for (const base of opts.candidates) {
        probed.push(base);
        if (opts.reachable(await input.probe(opts.probeUrl(base)))) {
          return { base: stripTrailingSlash(base), source: 'local', probed };
        }
      }
    }
    // ④ 都不通：回生产地址 + 标记，让上层报错能说清"两边都试过"
    return { base: opts.production, source: 'unreachable', probed };
  };

  const [hub, platform] = await Promise.all([
    pick({
      production: PRODUCTION_HUB_BASE,
      envValue: input.envHub,
      candidates: localHub,
      probeUrl: hubProbeUrl,
      reachable: hubReachable,
    }),
    pick({
      production: PRODUCTION_PLATFORM_BASE,
      envValue: input.envPlatform,
      candidates: localPlatform,
      probeUrl: platformProbeUrl,
      reachable: platformReachable,
    }),
  ]);

  return { hub, platform, channel: input.channel };
}

// ---------------------------------------------------------------------------
// 运行时缓存（启动时写入一次，之后只读）
// ---------------------------------------------------------------------------

let cached: ServiceSelection | null = null;
let inflight: Promise<ServiceSelection | null> | null = null;

/** 已解析的选择结果（未解析或通道不适用时为 null）。 */
export function selectedServices(): ServiceSelection | null {
  return cached;
}

/** 选定的 Hub 基址；未解析返回 null（调用方回落到既有逻辑）。 */
export function selectedHubBase(): string | null {
  return cached?.hub.base ?? null;
}

/** 选定的平台基址；未解析返回 null（调用方回落到既有逻辑）。 */
export function selectedPlatformBase(): string | null {
  return cached?.platform.base ?? null;
}

/**
 * 启动时调用一次：探测并缓存。重复调用复用同一 Promise。
 *
 * 返回 null 表示"本通道不使用本机制"（release / packaged-dev），
 * 调用方应继续使用既有的通道默认值。
 */
export async function resolveServicesOnce(
  env: Record<string, string | undefined> = process.env,
  probe: Probe = probeHttpStatus,
): Promise<ServiceSelection | null> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async (): Promise<ServiceSelection | null> => {
    try {
      const { channel } = resolveBuildIdentity({ env });
      if (!channelAllowsLocalFallback(channel)) {
        // release / packaged-dev：沿用既有语义，不引入本地兜底
        return null;
      }
      const selection = await selectServices({
        channel,
        envHub: env.COGSEED_HUB_API_BASE,
        envPlatform: env.EDUSEED_PLATFORM_BASE_URL,
        probe,
      });
      cached = selection;
      log.info('service origins selected', selection);
      notifyResolved(selection);
      return selection;
    } catch (err) {
      // 探测失败绝不能拖垮启动：保持 null，调用方回落到既有逻辑
      log.warn('service origins selection failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * 保证"已解析"的入口（幂等）。
 *
 * 🔴 必须在**授权流程开始前** await 它：一次流程内不允许换服务器，
 *    否则 state / 授权码会对不上另一台机器的库。
 *    调用点只有两处：`startPluginAuthorization`（教育平台授权）与 `startLogin`（Hub 登录）。
 */
export function ensureServiceOriginsResolved(
  env: Record<string, string | undefined> = process.env,
): Promise<ServiceSelection | null> {
  return resolveServicesOnce(env);
}

type SelectionListener = (selection: ServiceSelection | null) => void;
const listeners: SelectionListener[] = [];

/**
 * 注册"解析完成"回调（只用一次，用于把已绑定的共享客户端作废重建）。
 *
 * 🔴 为什么需要：某些模块会在启动早期就 `createClient(base)` 缓存实例；
 *    如果那时探测还没完成，实例会被绑在旧地址上。解析完成后清掉缓存即可，
 *    下一次使用自然重绑 —— 这仍然发生在用户点击之前，不构成"流程内切换"。
 */
export function onServiceOriginsResolved(listener: SelectionListener): void {
  if (cached) {
    listener(cached);
    return;
  }
  listeners.push(listener);
}

function notifyResolved(selection: ServiceSelection | null): void {
  for (const fn of listeners.splice(0)) {
    try {
      fn(selection);
    } catch {
      /* 监听者异常不影响启动 */
    }
  }
}

// 启动期自动解析：注册到 boot_init 的 immediate 阶段（替代 map 里的裸 setTimeout）。
// 失败无副作用：解析失败时 cached 保持 null，各解析函数回落到既有通道默认值。
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const boot = require('../util/boot_init') as {
    registerImmediate?: (name: string, fn: () => Promise<unknown> | void) => void;
  };
  boot.registerImmediate?.('service-origins', () => resolveServicesOnce());
} catch {
  /* boot_init 不可用（极早期或测试环境）：不注册，首次使用时仍会按需解析 */
}

/** 测试用：清空缓存（避免用例之间互相污染）。 */
export function __resetServiceSelectionForTests(): void {
  cached = null;
  inflight = null;
}

/** 测试用：直接注入选择结果。 */
export function __setServiceSelectionForTests(selection: ServiceSelection | null): void {
  cached = selection;
  inflight = null;
}
