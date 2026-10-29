/**
 * Hub 停用的市场 Agent，本机已装的也不可用。
 *
 * 与 Skill 一致：Hub 治理独立于用户自己的启用偏好（`shared/hub-content-status.js` FR-004）。
 * 只对来自市场的 Agent 生效（含随包预置的市场内容）；自建 Agent 的 `status` 是本机写的，不受 Hub 治理。
 * 状态以 `status` / `state` 字符串为准，布尔 `disabled` 不作数。
 */
import { isHubContentDisabled } from '../../shared/hub-content-status';

type StatusRow = { status?: unknown; state?: unknown };

/** 来自市场且被 Hub 停用。`source` 取 `marketplace` 或 `builtin`（预置的市场内容）。 */
export function isHubDisabledMarketplaceAgent(agent: StatusRow & { source?: unknown }): boolean {
  const marketplace = agent.source === 'marketplace' || agent.source === 'builtin';
  return marketplace && isHubContentDisabled(agent);
}

/** 生效的启用状态：用户没停用，且没有被 Hub 停用。 */
export function effectiveAgentEnabled(
  agent: StatusRow & { agent_id: string; source?: unknown },
  userDisabledIds: ReadonlySet<string>,
): boolean {
  return !userDisabledIds.has(agent.agent_id) && !isHubDisabledMarketplaceAgent(agent);
}
