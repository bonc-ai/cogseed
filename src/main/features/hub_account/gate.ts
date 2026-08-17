import { clientConfig } from '../client_config';
import { resolveBuildIdentity } from '../../util/build-identity';
import { HubApiError } from './client';

export const HUB_ACCOUNT_RELEASE_CONFIG_KEY = 'hub_account.release_enabled';

// 发布 Gate 默认打开：所有通道（dev / packaged-dev / release）默认放行登录。
// 服务端 client_config 可显式下发 false 关闭（回滚口径）；本地可用
// COGSEED_HUB_ENABLED 环境变量强制覆盖。
clientConfig.registerDefault<boolean>(HUB_ACCOUNT_RELEASE_CONFIG_KEY, true, { effect: 'immediate' });

/**
 * 登录入口的通道默认值：发布 Gate 默认打开，所有通道返回 true。
 * 纯函数，便于测试。
 */
export function hubReleaseDefaultEnabled(_channel: string): boolean {
  return true;
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
