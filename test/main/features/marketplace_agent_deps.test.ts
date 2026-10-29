/**
 * Agent 依赖规划：表驱动覆盖"复用 / 安装 / 随包 / 阻断"的组合。
 * 重点是几条不变量：不升级已有 Skill、随包 Skill 不被本机同名 Skill 吞掉、阻断项不触发下载。
 */
import { describe, expect, it } from 'vitest';

import {
  agentReadiness, planAgentDependencies, resolveExistingDependency, type LocalSkillState,
} from '../../../src/main/features/marketplace_agent_deps';

const HUB_A = 'a3f09c21b7e4';
const HUB_B = '5e1c8a02d9b3';
const HUB_C = '9b27f4a1c0e6';

const localFrom = (table: Record<string, Partial<LocalSkillState>>) => (id: string): LocalSkillState => ({
  present: false, disabled: false, ...(table[id] ?? {}),
});
const none = new Set<string>();

describe('版本策略（可替换的单个函数）', () => {
  it('本机已有且可用 → 复用，不升级；已停用 → 阻断', () => {
    expect(resolveExistingDependency({ present: true, disabled: false })).toBe('reuse');
    expect(resolveExistingDependency({ present: true, disabled: true })).toBe('blocked_disabled');
  });
});

describe('planAgentDependencies', () => {
  it('混合：预置已具备复用、Hub 缺失要装、随包 Skill 随包', () => {
    const plan = planAgentDependencies([HUB_A, HUB_B, 'invoice-ocr'], new Set(['invoice-ocr']), localFrom({ [HUB_A]: { present: true } }));
    expect(plan.items.map((i) => [i.id, i.action])).toEqual([[HUB_A, 'reuse'], [HUB_B, 'install'], ['invoice-ocr', 'bundled']]);
    expect(plan.toInstall).toEqual([HUB_B]);
    expect(plan.reused).toEqual([HUB_A]);
    expect(plan.bundled).toEqual(['invoice-ocr']);
    expect(plan.blocked).toEqual([]);
  });

  it('已有的 Skill 只复用，永远不进安装清单（不因装 Agent 而升级）', () => {
    const plan = planAgentDependencies([HUB_A], none, localFrom({ [HUB_A]: { present: true } }));
    expect(plan.toInstall).toEqual([]);
    expect(plan.reused).toEqual([HUB_A]);
  });

  it('本机有但被 Hub 停用 → 阻断，且不进安装清单', () => {
    const plan = planAgentDependencies([HUB_C, HUB_B], none, localFrom({ [HUB_C]: { present: true, disabled: true } }));
    expect(plan.blocked.map((i) => [i.id, i.action])).toEqual([[HUB_C, 'blocked_disabled']]);
    expect(plan.toInstall).toEqual([HUB_B]);
    expect(agentReadiness(plan)).toBe('deps_blocked');
  });

  it('随包 Skill 与本机同名 Skill 不是一回事：优先按随包处理，不被"本机已有"吞掉', () => {
    const plan = planAgentDependencies(['invoice-ocr'], new Set(['invoice-ocr']), localFrom({ 'invoice-ocr': { present: true, disabled: true } }));
    expect(plan.items).toEqual([{ id: 'invoice-ocr', kind: 'bundled', action: 'bundled' }]);
    expect(plan.blocked).toEqual([]);
  });

  it('builtin: 本机具备 → 直接使用，不下载；不具备 → 阻断，也不下载', () => {
    const have = planAgentDependencies(['builtin:coding'], none, localFrom({}), (name) => name === 'coding');
    expect(have.items).toEqual([{ id: 'builtin:coding', kind: 'builtin', action: 'builtin' }]);
    expect(have.builtin).toEqual(['builtin:coding']);
    expect(have.toInstall).toEqual([]);
    expect(have.blocked).toEqual([]);

    const lack = planAgentDependencies(['builtin:coding'], none, localFrom({}), () => false);
    expect(lack.blocked.map((i) => i.action)).toEqual(['blocked_builtin_unsupported']);
    expect(lack.toInstall).toEqual([]);
  });

  it('builtin: 没传可用性判断时一律不具备（失败关闭）', () => {
    const plan = planAgentDependencies(['builtin:grounded-material-qa'], none, localFrom({}));
    expect(plan.blocked.map((i) => i.action)).toEqual(['blocked_builtin_unsupported']);
  });

  it('形态不对的 builtin: 引用即使"可用性"恒真也不放行', () => {
    const plan = planAgentDependencies(['builtin:Bad Name'], none, localFrom({}), () => true);
    expect(plan.blocked.map((i) => i.action)).toEqual(['blocked_builtin_unsupported']);
  });

  it('存量写法（既非十六进制也不在包内的名字）保持旧行为：按 Hub Skill 处理', () => {
    const plan = planAgentDependencies(['seo-crawl'], none, localFrom({}));
    expect(plan.items).toEqual([{ id: 'seo-crawl', kind: 'hub', action: 'install' }]);
  });

  it('缺省/空/重复/空白条目：不产生多余项', () => {
    expect(planAgentDependencies(undefined, none, localFrom({})).items).toEqual([]);
    expect(planAgentDependencies([], none, localFrom({})).items).toEqual([]);
    const plan = planAgentDependencies([HUB_A, HUB_A, '  ', HUB_B], none, localFrom({}));
    expect(plan.items.map((i) => i.id)).toEqual([HUB_A, HUB_B]);
  });

  it('保持 skill_list 的顺序', () => {
    const plan = planAgentDependencies([HUB_C, HUB_A, HUB_B], none, localFrom({}));
    expect(plan.toInstall).toEqual([HUB_C, HUB_A, HUB_B]);
  });
});

describe('agentReadiness', () => {
  it('全部就绪才算可用：有待安装或阻断都不是 ready', () => {
    expect(agentReadiness(planAgentDependencies([HUB_A, 'x-priv'], new Set(['x-priv']), localFrom({ [HUB_A]: { present: true } })))).toBe('ready');
    expect(agentReadiness(planAgentDependencies([HUB_B], none, localFrom({})))).toBe('deps_blocked');
    expect(agentReadiness(planAgentDependencies([], none, localFrom({})))).toBe('ready');
  });
});
