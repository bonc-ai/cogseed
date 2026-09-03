// 伪 provider（cli-<type>）经 auth.listModels 的出口契约：
// 全串条目、静态∪扫描同源合并、claude 别名规范化；listEntries 零污染
// （伪 provider 不是 API 凭证，绝不进入条目/凭证候选）。
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/features/users', () => ({
  // listEntries 走用户级 profiles 存储，测试环境无激活用户——mock 掉
  // user 解析即可断言条目数据源不含伪 provider。
  getActiveUserId: () => 'u-agent-provider-test',
}));

vi.mock('../../../src/main/features/p3394_bridge/external-gateways', () => ({
  inspectExternalGatewayModels: vi.fn(async (cli: string) => {
    if (cli === 'claude') {
      return {
        status: 'ready',
        // CLI /model 披露的别名（未规范化）+ 一个静态目录没有的 id。
        models: [{ id: 'sonnet', label: 'sonnet' }, { id: 'opus', label: 'opus' }, { id: 'claude-fable-5', label: 'claude-fable-5' }],
        current: 'sonnet',
        modelControllable: true,
      };
    }
    return { status: 'unavailable', models: [], reason: 'gateway_not_running' };
  }),
}));

const auth = await import('../../../src/main/features/auth');

describe('auth.listModels › pseudo CLI provider', () => {
  it('returns masked full-string ids, static ∪ scan, deduped', async () => {
    const res = await auth.listModels('cli-claude');
    const ids = res.models.map((m) => m.id);
    // 静态目录 8 条公开 id + 扫描新增 0（sonnet/opus 别名规范化后与静态
    // 目录重复被去重；fable 扫描值与静态条目同 id 去重）。
    expect(ids.every((id) => id.startsWith('cli/claude@'))).toBe(true);
    expect(ids).toContain('cli/claude@claude-sonnet-5');
    expect(ids).toContain('cli/claude@claude-fable-5[1m]');
    expect(new Set(ids).size).toBe(ids.length);
    // 静态条目携带公开规格窗口。
    expect(res.models.find((m) => m.id === 'cli/claude@claude-sonnet-5')?.contextWindow).toBe(200_000);
    // name 为可读裸名（不是全串）。
    expect(res.models.find((m) => m.id === 'cli/claude@claude-sonnet-5')?.name).toBe('claude-sonnet-5');
  });

  it('falls back to the static catalog when the scan is unavailable', async () => {
    const res = await auth.listModels('cli-workbuddy');
    expect(res.models.length).toBeGreaterThan(0);
    expect(res.models.every((m) => m.id.startsWith('cli/workbuddy@'))).toBe(true);
    expect(res.models.find((m) => m.id === 'cli/workbuddy@auto')?.name).toBe('自动（由 WorkBuddy 选择）');
  });

  it('keeps unknown providers on the existing allowlist path (pass-through contract)', async () => {
    // 非 cli-* 前缀不受影响：白名单外 provider 返回空（既有行为）。
    const res = await auth.listModels('totally-unknown-provider');
    expect(res.models).toEqual([]);
  });

  it('never leaks pseudo providers into listEntries (credential store untouched)', async () => {
    const res = await auth.listEntries();
    // 伪 provider 没有 profile/entry：listEntries 的数据源是 store.entries，
    // 伪 provider 分支只存在于 listModels。
    expect(res.entries.every((e) => !String(e.provider || '').startsWith('cli-'))).toBe(true);
  });
});
