/**
 * 智能体卡片上与贡献/来源相关的判定：谁能被贡献、谁带「社区贡献」标识。
 * 只测纯判定函数；DOM 渲染由真实页面验证。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');

function load(): any {
  const window: any = { addEventListener() {}, removeEventListener() {}, cogseed: { invoke() {} } };
  window.window = window;
  const context: any = {
    window, document: {}, createLogger: () => ({ warn() {}, error() {}, info() {} }),
    t: (key: string) => ({
      'agents.update_failed_hint': 'HINT target={target} keep={version} why={reason}',
      'agents.update_failed_hint_no_version': 'HINT-NOVER target={target} why={reason}',
      'agents.update_failed_reason.network': 'NETWORK',
      'agents.update_failed_reason.unknown': 'UNKNOWN',
    } as Record<string, string>)[key] ?? key, setTimeout, clearTimeout, console,
    escapeHtml: (v: string) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'agents.js' });
  return context;
}

describe('谁能被贡献', () => {
  const isContributable = (a: unknown) => vm.runInContext('_isAgentContributable', load())(a) as boolean;

  it('只有用户自建的普通智能体可以', () => {
    expect(isContributable({ agent_id: 'my-expense', source: 'custom' })).toBe(true);
  });

  it('市场安装的、指挥官、外接 CLI、宿主专有的都不可以', () => {
    expect(isContributable({ agent_id: 'x', source: 'marketplace' })).toBe(false);
    expect(isContributable({ agent_id: 'commander', source: 'custom' })).toBe(false);
    expect(isContributable({ agent_id: 'cli', source: 'custom', runtime: { kind: 'cli', cli: 'codex' } })).toBe(false);
    expect(isContributable({ agent_id: 'h1', source: 'custom', management_surface: 'expense' })).toBe(false);
    expect(isContributable({ agent_id: 'h2', source: 'custom', reimbursement_entry_role: 'submitter' })).toBe(false);
  });

  it('空值不抛错', () => {
    expect(isContributable(null)).toBe(false);
    expect(isContributable(undefined)).toBe(false);
    expect(isContributable({})).toBe(false);
  });
});

describe('「社区贡献」标识', () => {
  const chips = (a: unknown) => vm.runInContext('_agentPlatformStatusChipsHtml', load())(a) as string;

  it('社区贡献的智能体显示标识', () => {
    expect(chips({ author_tier: 'community' })).toContain('agents.community_chip');
  });

  it('官方、没有作者信息的都不显示（不猜）', () => {
    expect(chips({ author_tier: 'official' })).toBe('');
    expect(chips({})).toBe('');
    expect(chips(null)).toBe('');
  });
});

describe('更新失败提示', () => {
  const text = (a: unknown) => vm.runInContext('_agentUpdateFailureText', load())(a) as { chip: string; hint: string } | null;
  const chips = (a: unknown) => vm.runInContext('_agentPlatformStatusChipsHtml', load())(a) as string;
  const failed = { version: '1.0.0', update_failure: { target_version: '2.0.0', at: 1, reason: 'network' } };

  it('带出没能更新到的版本、仍可使用的版本和原因', () => {
    expect(text(failed)?.hint).toBe('HINT target=2.0.0 keep=1.0.0 why=NETWORK');
    expect(text(failed)?.chip).toBe('agents.update_failed_chip');
  });

  it('认不出的原因退回「出了点问题」，不显示原始代码', () => {
    expect(text({ ...failed, update_failure: { ...failed.update_failure, reason: 'weird-code' } })?.hint).toContain('why=UNKNOWN');
  });

  it('没有本机版本时用另一句，不留 undefined', () => {
    const noVersion = text({ update_failure: failed.update_failure });
    expect(noVersion?.hint).toBe('HINT-NOVER target=2.0.0 why=NETWORK');
    expect(noVersion?.hint).not.toContain('undefined');
  });

  it('没有更新失败记录：不提示；记录形态不对也不抛错', () => {
    expect(text({ version: '1.0.0' })).toBeNull();
    expect(text(null)).toBeNull();
    expect(text({ update_failure: 'oops' })).toBeNull();
  });

  it('卡片上显示「更新失败」标识，带完整说明作为提示；与「社区贡献」可同时出现', () => {
    const out = chips({ ...failed, author_tier: 'community' });
    expect(out).toContain('agents.update_failed_chip');
    expect(out).toContain('HINT target=2.0.0');
    expect(out).toContain('agents.community_chip');
  });

  it('没失败时卡片上没有这个标识', () => {
    expect(chips({ version: '1.0.0' })).not.toContain('update_failed');
  });
});
