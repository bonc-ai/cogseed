/**
 * plugin-platform-url.ts —— 平台基址解析（模块 A · 客户端侧）
 *
 * 两个**不同语义**的解析必须分开，混用会静默 404（2026-09-15 踩过）：
 *
 *   · `validatePlatformServerUrl(raw)` → 返回 **origin**，只用于"这个地址合不合法"的
 *     校验语义。**不能**拿它的返回值当 API 基址：那会丢掉子路径 `/edu`。
 *   · `platformApiBase(raw)` → 返回 `origin + pathname`（去掉尾部斜杠），
 *     这才是拼 API 路径用的基址。
 *
 * 生产上平台挂在官网域名的 `/edu` 子路径下（nginx 原样透传、不剥前缀），
 * 所以 `https://cogseed-open.bonc.com.cn/edu/api/oauth/token` 才是真实路径。
 */
import { resolveBuildIdentity } from '../util/build-identity';
import { selectedPlatformBase } from './service_origins';

/** 平台（EduSeed）在官网域名下的挂载子路径。 */
export const EDU_BASE_PATH = '/edu';

/** 校验用：只保留 origin（协议/主机/端口合法即通过，丢弃路径/查询/片段）。 */
export function validatePlatformServerUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  let u: URL;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  if (u.search || u.hash) return null;
  return u.origin;
}

/** API 基址：保留子路径（`/edu`），这是拼接口路径要用的那个。 */
export function platformApiBase(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  let u: URL;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  if (u.search || u.hash) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** 把基址与接口路径拼起来（基址可带子路径，路径以 `/` 开头）。 */
export function joinApiUrl(base: string, apiPath: string): string {
  const cleanBase = base.replace(/\/+$/, '');
  const cleanPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  return cleanBase + cleanPath;
}

export const RELEASE_EDUSEED_BASE = 'https://cogseed-open.bonc.com.cn/edu';
export const DEV_EDUSEED_BASE = 'http://localhost:3000/edu';

/**
 * 解析平台基址。
 *
 * 优先级：
 *   ① 调用方给的具体地址（已存的 `server_url` —— 来自 v2 密钥自带地址或上次授权，
 *      是**权威**：密钥在哪个服务器生成就指向哪个服务器）
 *   ② 环境变量 `EDUSEED_PLATFORM_BASE_URL`（部署覆盖 / 本地联调）
 *   ③ 构建通道默认值：release / packaged-dev → 生产；dev → 本地
 *
 * 返回 null 表示"没有可用的平台地址"，调用方必须把它当失败处理，不能猜一个。
 */
export function resolveEduSeedBase(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromExplicit = explicit ? platformApiBase(explicit) : null;
  if (fromExplicit) return fromExplicit;

  const fromEnv = env.EDUSEED_PLATFORM_BASE_URL ? platformApiBase(env.EDUSEED_PLATFORM_BASE_URL) : null;
  if (fromEnv) return fromEnv;

  // ③ 启动时的"生产优先 / 本地兜底"选择结果（features/service_origins.ts）。
  //    只在解析完成后生效；测试与未探测场景保持 null，继续走下面的通道默认值。
  const selected = selectedPlatformBase();
  if (selected) return platformApiBase(selected);

  const { channel } = resolveBuildIdentity({ env });
  if (channel === 'release' || channel === 'packaged-dev') return RELEASE_EDUSEED_BASE;
  return DEV_EDUSEED_BASE;
}
