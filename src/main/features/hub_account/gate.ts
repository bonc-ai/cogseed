import { clientConfig } from '../client_config';
import { HubApiError } from './client';

export const HUB_ACCOUNT_RELEASE_CONFIG_KEY = 'hub_account.release_enabled';

clientConfig.registerDefault<boolean>(HUB_ACCOUNT_RELEASE_CONFIG_KEY, false, { effect: 'immediate' });

export function isHubAccountReleaseEnabled(): boolean {
  return clientConfig.get<boolean>(HUB_ACCOUNT_RELEASE_CONFIG_KEY, false) === true;
}

export function assertHubAccountReleaseEnabled(): void {
  if (!isHubAccountReleaseEnabled()) {
    throw new HubApiError('HUB_RELEASE_GATE_CLOSED', 'Hub 账号能力尚未通过发布 Gate', 503);
  }
}
