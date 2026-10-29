/**
 * 已安装 Agent 的依赖状态：停用与不支持优先、缺失只提示、存量写法不误伤。
 * 判定是纯函数，直接表驱动；读盘版本用真实临时目录验证"读到了什么"。
 */
import { describe, expect, it } from 'vitest';

import { dependencyStateFromPlan, withUserDisabledDependencies } from '../../../src/main/features/agent_dependency_state';
import { planAgentDependencies, type LocalSkillState } from '../../../src/main/features/marketplace_agent_deps';

const none = new Set<string>();
const localFrom = (table: Record<string, Partial<LocalSkillState>>) => (id: string): LocalSkillState => ({
  present: false, disabled: false, ...(table[id] ?? {}),
});
const stateOf = (list: string[], priv: string[], local: Record<string, Partial<LocalSkillState>>) =>
  dependencyStateFromPlan(planAgentDependencies(list, new Set(priv), localFrom(local)));

describe('dependencyStateFromPlan', () => {
  it('全部就绪（复用 + 随包）→ ready', () => {
    expect(stateOf(['a3f09c21b7e4', 'invoice-ocr'], ['invoice-ocr'], { a3f09c21b7e4: { present: true } }))
      .toEqual({ status: 'ready', ids: [] });
  });

  it('没有依赖 → ready', () => {
    expect(dependencyStateFromPlan(planAgentDependencies([], none, localFrom({})))).toEqual({ status: 'ready', ids: [] });
    expect(dependencyStateFromPlan(planAgentDependencies(undefined, none, localFrom({})))).toEqual({ status: 'ready', ids: [] });
  });

  it('依赖被 Hub 停用 → deps_blocked，并指出是哪个', () => {
    expect(stateOf(['a3f09c21b7e4', '9b27f4a1c0e6'], [], { a3f09c21b7e4: { present: true }, '9b27f4a1c0e6': { present: true, disabled: true } }))
      .toEqual({ status: 'deps_blocked', ids: ['9b27f4a1c0e6'] });
  });

  it('引用内置能力：本机具备 → ready；不具备 → deps_blocked', () => {
    const plan = (available: boolean) => dependencyStateFromPlan(planAgentDependencies(['builtin:coding'], none, localFrom({}), () => available));
    expect(plan(true)).toEqual({ status: 'ready', ids: [] });
    expect(plan(false)).toEqual({ status: 'deps_blocked', ids: ['builtin:coding'] });
  });

  it('本机缺少依赖 → deps_missing（只提示，不是 blocked）', () => {
    expect(stateOf(['5e1c8a02d9b3'], [], {})).toEqual({ status: 'deps_missing', ids: ['5e1c8a02d9b3'] });
  });

  it('停用优先于缺失：两者并存时按 blocked 处理', () => {
    expect(stateOf(['5e1c8a02d9b3', '9b27f4a1c0e6'], [], { '9b27f4a1c0e6': { present: true, disabled: true } }))
      .toEqual({ status: 'deps_blocked', ids: ['9b27f4a1c0e6'] });
  });

  it('随包私有 Skill 即使本机有同名且被停用的 Skill，也不会被误判停用', () => {
    expect(stateOf(['invoice-ocr'], ['invoice-ocr'], { 'invoice-ocr': { present: true, disabled: true } }))
      .toEqual({ status: 'ready', ids: [] });
  });
});

describe('withUserDisabledDependencies（S4：用户停用的依赖也阻断，FR-027）', () => {
  const ready = { status: 'ready' as const, ids: [] as string[] };
  // 返回被停用技能的 id（不是布尔），以便 `reasons` 始终按真实 id 记。
  const disabled = (ids: string[]) => (ref: string) => (ids.includes(ref) ? ref : '');

  it('依赖被用户停用 → deps_blocked，原因 user_disabled', () => {
    expect(withUserDisabledDependencies(ready, ['a', 'b'], new Set(), disabled(['b'])))
      .toEqual({ status: 'deps_blocked', ids: ['b'], reasons: { b: 'user_disabled' } });
  });

  it('都正常 → 原样返回', () => {
    expect(withUserDisabledDependencies(ready, ['a'], new Set(), disabled([]))).toBe(ready);
  });

  it('Hub 停用的保留在前，不被标成 user_disabled', () => {
    const hub = { status: 'deps_blocked' as const, ids: ['h'] };
    expect(withUserDisabledDependencies(hub, ['h', 'u'], new Set(), disabled(['u'])))
      .toEqual({ status: 'deps_blocked', ids: ['h', 'u'], reasons: { u: 'user_disabled' } });
  });

  it('缺失依赖 + 用户停用 → 停用优先', () => {
    const missing = { status: 'deps_missing' as const, ids: ['m'] };
    expect(withUserDisabledDependencies(missing, ['m', 'u'], new Set(), disabled(['u'])).status).toBe('deps_blocked');
  });

  it('builtin: 引用与随包私有技能不受用户停用名单影响', () => {
    expect(withUserDisabledDependencies(ready, ['builtin:coding', 'priv'], new Set(['priv']), (ref) => ref)).toBe(ready);
  });

  it('skill_list 写的是技能名：按解析出的 id 记，同一技能名和 id 都写了也只算一次', () => {
    const byName: Record<string, string> = { 发票抽取: 'invoice-extract', 'invoice-extract': 'invoice-extract' };
    expect(withUserDisabledDependencies(ready, ['发票抽取', 'invoice-extract', 'other'], new Set(), (ref) => byName[ref] || ''))
      .toEqual({ status: 'deps_blocked', ids: ['invoice-extract'], reasons: { 'invoice-extract': 'user_disabled' } });
  });
});
