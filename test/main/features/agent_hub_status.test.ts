import { describe, expect, it } from 'vitest';

import { effectiveAgentEnabled, isHubDisabledMarketplaceAgent } from '../../../src/main/features/agent_hub_status';

describe('isHubDisabledMarketplaceAgent', () => {
  it.each([
    [{ source: 'marketplace', status: 'disabled' }, true],
    [{ source: 'builtin', status: 'disabled' }, true],       // 预置的市场内容同样受 Hub 治理
    [{ source: 'marketplace', status: 'published' }, false],
    [{ source: 'marketplace', status: 'approved' }, false],
    [{ source: 'marketplace', state: 'disabled' }, true],    // 旧字段 state
    [{ source: 'marketplace', status: ' Disabled ' }, true], // 大小写与空白不敏感
    [{ source: 'custom', status: 'disabled' }, false],       // 自建 Agent 的 status 是本机写的，不受 Hub 治理
    [{ source: 'marketplace' }, false],
  ])('%j → %s', (agent, expected) => {
    expect(isHubDisabledMarketplaceAgent(agent)).toBe(expected);
  });

  it('布尔 disabled 不作数，以 status 字符串为准', () => {
    expect(isHubDisabledMarketplaceAgent({ source: 'marketplace', status: 'published', disabled: true } as never)).toBe(false);
  });
});

describe('effectiveAgentEnabled', () => {
  const none = new Set<string>();
  it('用户没停用、Hub 没停用 → 可用', () => {
    expect(effectiveAgentEnabled({ agent_id: 'a', source: 'marketplace', status: 'published' }, none)).toBe(true);
  });
  it('Hub 停用 → 不可用，即使用户从没停用过', () => {
    expect(effectiveAgentEnabled({ agent_id: 'a', source: 'marketplace', status: 'disabled' }, none)).toBe(false);
  });
  it('用户自己停用 → 不可用，与 Hub 状态无关', () => {
    expect(effectiveAgentEnabled({ agent_id: 'a', source: 'marketplace', status: 'published' }, new Set(['a']))).toBe(false);
    expect(effectiveAgentEnabled({ agent_id: 'a', source: 'custom' }, new Set(['a']))).toBe(false);
  });
  it('Hub 恢复后自动恢复可用（用户偏好不被改写）', () => {
    expect(effectiveAgentEnabled({ agent_id: 'a', source: 'marketplace', status: 'disabled' }, none)).toBe(false);
    expect(effectiveAgentEnabled({ agent_id: 'a', source: 'marketplace', status: 'published' }, none)).toBe(true);
  });
});
