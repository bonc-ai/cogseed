import { clientConfig } from '../client_config';
import { HubApiError } from './client';

export const HUB_ACCOUNT_RELEASE_CONFIG_KEY = 'hub_account.release_enabled';

// GitHub OAuth 登录已撤除，官网账号密码登录尚未接回：发布 Gate 默认关闭，
// 桌面端不展示 Hub 登录入口；联调时可通过配置显式打开。
clientConfig.registerDefault<boolean>(HUB_ACCOUNT_RELEASE_CONFIG_KEY, false, { effect: 'immediate' });

export function isHubAccountReleaseEnabled(): boolean {
  return clientConfig.get<boolean>(HUB_ACCOUNT_RELEASE_CONFIG_KEY, false) === true;
}

export function assertHubAccountReleaseEnabled(): void {
  if (!isHubAccountReleaseEnabled()) {
    throw new HubApiError('HUB_RELEASE_GATE_CLOSED', 'Hub 账号能力尚未通过发布 Gate', 503);
  }
}
