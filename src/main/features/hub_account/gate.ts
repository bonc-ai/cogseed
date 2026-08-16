import { clientConfig } from '../client_config';
import { resolveBuildIdentity } from '../../util/build-identity';
import { HubApiError } from './client';

export const HUB_ACCOUNT_RELEASE_CONFIG_KEY = 'hub_account.release_enabled';

// GitHub OAuth 登录已撤除，官网账号密码登录随内部测试包开放。
clientConfig.registerDefault<boolean>(HUB_ACCOUNT_RELEASE_CONFIG_KEY, false, { effect: 'immediate' });

/**
 * 登录入口的通道默认值：内部测试包（packaged-dev）默认打开，
 * 正式 release 与源码开发默认关闭（发布口径保持 Keep Disabled 可关）。
 * 纯函数，便于测试。
 */
export function hubReleaseDefaultEnabled(channel: string): boolean {
  return channel === 'packaged-dev';
}

export function isHubAccountReleaseEnabled(): boolean {
  // 内部联调开关：显式设置 COGSEED_HUB_ENABLED 时以它为准（与 COGSEED_HUB_API_BASE 配套使用）。
  const envOverride = process.env.COGSEED_HUB_ENABLED?.trim();
  if (envOverride !== undefined && envOverride !== "") {
    return ["true", "1", "yes", "on"].includes(envOverride.toLowerCase());
  }
  const { channel } = resolveBuildIdentity();
  const fallback = hubReleaseDefaultEnabled(channel);
  return clientConfig.get<boolean>(HUB_ACCOUNT_RELEASE_CONFIG_KEY, fallback) === true;
}

export function assertHubAccountReleaseEnabled(): void {
  if (!isHubAccountReleaseEnabled()) {
    throw new HubApiError('HUB_RELEASE_GATE_CLOSED', 'Hub 账号能力尚未通过发布 Gate', 503);
  }
}
