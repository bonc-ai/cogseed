// 协作范围注入（设计 §4.2）——谁看到什么，是这条能力的全部风险所在。
//
// 不变量：
//   - 外接实例（cli / p3394-gateway）**什么都不注入**：既看不到成员名单，也看不到点名
//   - commander 拿到完整块：可协作范围、必须执行者、顺序要求、交付要求
//   - 内进程被点名成员只拿到「本条点名是你」，未点名成员什么都不拿
//   - 没有成员快照（单接收者/旧路径）时完全不注入，行为与改动前一致
//   - 顺序意图检测保守：并列/无关文本不误判

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildMemberScopeBlock,
  isExternalRecipient,
  MEMBER_SCOPE_PLACEHOLDER,
  MEMBER_SCOPE_TEMPLATE,
  detectSequentialIntent,
  verifySequentialPlan,
  verifySequentialStepStart,
  sequentialViolationMessage,
  shouldDeferToCommanderForOrder,
} from '../../../../src/main/features/group_chat/member_scope';

const TEMPLATE = `STATIC RULES\n\n## Runtime injection\n\n{{scope_lines}}\n`;

function msg(snapshot: Record<string, unknown> | null) {
  return { member_snapshot: snapshot as never } as never;
}

const snapshot = {
  member_agent_ids: ['agent-codex-1', 'agent-task-2'],
  mention_agent_ids: ['agent-codex-1'],
  mention_order: ['agent-codex-1'],
  external_agent_ids: ['agent-codex-1'],
};

const names = (id: string) => ({ 'agent-codex-1': 'Codex', 'agent-task-2': '集成验证Agent' }[id] || '');

describe('member scope › 谁能看到范围', () => {
  it('commander 拿到完整块：范围 + 必须执行者', () => {
    const block = buildMemberScopeBlock({
      template: TEMPLATE, msg: msg(snapshot), recipientId: 'commander', isExternal: false, nameOf: names,
    });
    expect(block).toContain('STATIC RULES');
    expect(block).toContain('Available collaborators: Codex、集成验证Agent');
    expect(block).toContain('Required executors: Codex');
    expect(block).not.toContain(MEMBER_SCOPE_PLACEHOLDER);
  });

  it('外接实例什么都不注入（连自己的名字也不提）', () => {
    const block = buildMemberScopeBlock({
      template: TEMPLATE, msg: msg(snapshot), recipientId: 'agent-codex-1', isExternal: true, nameOf: names,
    });
    expect(block).toBe('');
    // 即使调用方忘了传 isExternal，快照里的 external_agent_ids 也会兜住。
    expect(buildMemberScopeBlock({
      template: TEMPLATE, msg: msg(snapshot), recipientId: 'agent-codex-1', isExternal: false, nameOf: names,
    })).toBe('');
    expect(isExternalRecipient(msg(snapshot), 'agent-codex-1')).toBe(true);
  });

  it('内进程被点名成员只拿到一行；未点名成员不注入', () => {
    const mentioned = buildMemberScopeBlock({
      template: TEMPLATE, msg: msg(snapshot), recipientId: 'agent-task-3', isExternal: false, nameOf: names,
    });
    expect(mentioned).toBe('');
    const named = buildMemberScopeBlock({
      template: TEMPLATE,
      msg: msg({ ...snapshot, mention_agent_ids: ['agent-task-3'] }),
      recipientId: 'agent-task-3',
      isExternal: false,
      nameOf: names,
    });
    expect(named).toContain('本条点名对象是你');
    // 不泄露完整成员名单与静态规则。
    expect(named).not.toContain('Available collaborators');
    expect(named).not.toContain('STATIC RULES');
  });

  it('没有成员快照 / 空成员 / 空模板时不注入（旧路径行为不变）', () => {
    expect(buildMemberScopeBlock({
      template: TEMPLATE, msg: msg(null), recipientId: 'commander', isExternal: false, nameOf: names,
    })).toBe('');
    expect(buildMemberScopeBlock({
      template: TEMPLATE,
      msg: msg({ member_agent_ids: [] }),
      recipientId: 'commander',
      isExternal: false,
      nameOf: names,
    })).toBe('');
    expect(buildMemberScopeBlock({
      template: '', msg: msg(snapshot), recipientId: 'commander', isExternal: false, nameOf: names,
    })).toBe('');
  });


  it('无点名时明确告知「没有点名对象」（而不是留空让人猜）', () => {
    const block = buildMemberScopeBlock({
      template: TEMPLATE,
      msg: msg({ member_agent_ids: ['agent-task-2'] }),
      recipientId: 'commander',
      isExternal: false,
      nameOf: names,
    });
    expect(block).toContain('Required executors: none named');
  });

  it('取不到显示名时回落 agent_id，不产生空名单', () => {
    const block = buildMemberScopeBlock({
      template: TEMPLATE, msg: msg(snapshot), recipientId: 'commander', isExternal: false,
    });
    expect(block).toContain('agent-codex-1');
  });
});

describe('member scope › 顺序意图检测（保守）', () => {
  it.each([
    '先做方案，再让集成验证Agent 验证',
    '第一步梳理接口，第二步补测试',
    '把这三件事依次做完',
    '先跑一遍然后我们再决定',
  ])('命中顺序意图：%s', (text) => {
    expect(detectSequentialIntent(text)).toBe(true);
  });

  it.each([
    '并行分析这两个模块，最后一起汇总',
    '先不用管这个，直接改配置',
    '我想先看看现状',
    '先不用管这个，后面再说',
    '先别动它，之后统一处理',
    '',
  ])('不误判：%s', (text) => {
    expect(detectSequentialIntent(text)).toBe(false);
  });
});

describe('member scope › prompt 源文件约定', () => {
  it('模板存在、含运行期占位符，且运行期字段集中在末尾 Runtime injection 段', () => {
    const file = path.resolve(__dirname, '../../../../src/main/prompts/member_scope.md');
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain(MEMBER_SCOPE_PLACEHOLDER);
    const injectionAt = body.indexOf('## Runtime injection');
    expect(injectionAt).toBeGreaterThan(0);
    // 占位符必须出现在 Runtime injection 段之后（静态规则在前，缓存前缀稳定）。
    expect(body.indexOf(MEMBER_SCOPE_PLACEHOLDER)).toBeGreaterThan(injectionAt);
    expect(MEMBER_SCOPE_TEMPLATE).toBe('member_scope');
  });
});

describe('member scope › 顺序约束只来自任务分工（PRD FR-017；验收报告 MA-03）', () => {
  const steps = (list: Array<[string, string, string[]]>) => list.map(([step_id, agent_id, depends_on]) => ({
    step_id, agent_id, depends_on,
  }));

  it('未命中顺序意图时不校验（保持并行现状）', () => {
    expect(verifySequentialPlan({ requiresSequential: false, requiredAgentIds: ['a', 'b'], steps: [] }).ok).toBe(true);
  });

  it('点名排列与任务要求的先后相反时，任务要求的首位不被拦截（MA-03 隔离复现）', () => {
    // 真机/隔离复现：依次选 A、B，正文为「先让 B 生成方案，再让 A 验证」。
    // 旧实现按点名顺序强制 A→B，回 missing_dependency: b<-a；顺序只能来自任务分工。
    expect(verifySequentialStepStart({
      requiresSequential: true,
      steps: [],
      stepToStart: { step_id: 's-b', agent_id: 'b', depends_on: [] },
    }).ok).toBe(true);
    // 反过来 A 依赖 B 也自洽。
    expect(verifySequentialStepStart({
      requiresSequential: true,
      steps: steps([['s-b', 'b', []]]),
      stepToStart: { step_id: 's-a', agent_id: 'a', depends_on: ['s-b'] },
    }).ok).toBe(true);
  });

  it('并行派发不再被拦（顺序不由选择/点名排列推导）', () => {
    expect(verifySequentialPlan({
      requiresSequential: true,
      requiredAgentIds: ['a', 'b'],
      steps: steps([['s1', 'a', []], ['s2', 'b', []]]),
    }).ok).toBe(true);
    expect(verifySequentialStepStart({
      requiresSequential: true,
      steps: steps([['s1', 'a', []]]),
      stepToStart: { step_id: 's2', agent_id: 'b', depends_on: [] },
    }).ok).toBe(true);
  });

  it('被点名成员没有被派发＝missing_member（不静默忽略本条点名）', () => {
    const verdict = verifySequentialPlan({
      requiresSequential: true,
      requiredAgentIds: ['a', 'b'],
      steps: steps([['s1', 'a', []]]),
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'missing_member', detail: 'b' });
    expect(sequentialViolationMessage(verdict)).toContain('b');
  });

  it('依赖成环被拦（与谁先谁后无关的一致性错误）', () => {
    expect(verifySequentialPlan({
      requiresSequential: true,
      requiredAgentIds: ['a', 'b'],
      steps: steps([['s1', 'a', ['s2']], ['s2', 'b', ['s1']]]),
    })).toMatchObject({ ok: false, reason: 'cycle' });
    expect(verifySequentialStepStart({
      requiresSequential: true,
      steps: steps([['s1', 'a', ['s2']], ['s2', 'b', ['s1']]]),
      stepToStart: { step_id: 's1', agent_id: 'a', depends_on: ['s2'] },
    })).toMatchObject({ ok: false, reason: 'cycle' });
  });

  it('通过时不产出纠正文案', () => {
    expect(sequentialViolationMessage({ ok: true })).toBe('');
  });
});

describe('member scope › 范围块给依赖指引（不把选择顺序当执行顺序）', () => {
  it('顺序意图下要求按任务描述声明依赖，且不出现由点名顺序推导的箭头', () => {
    const block = buildMemberScopeBlock({
      template: TEMPLATE,
      msg: msg({ ...snapshot, requires_sequential: true, mention_order: ['agent-task-2', 'agent-codex-1'] }),
      recipientId: 'commander',
      isExternal: false,
      nameOf: names,
    });
    expect(block).toContain('Sequential requirement');
    expect(block).not.toContain('集成验证Agent → Codex');
    expect(block).toContain('task description');
  });
});

describe('member scope › 顺序协作转交协调者（决策 A）', () => {
  it('顺序意图 + 多点名 → 交给协调者编排（不能直接并行派发）', () => {
    expect(shouldDeferToCommanderForOrder({ requiresSequential: true, mentionIds: ['a', 'b'] })).toBe(true);
    expect(shouldDeferToCommanderForOrder({ requiresSequential: true, mentionIds: ['a', 'b', 'c'] })).toBe(true);
  });

  it('没有顺序意图 / 只点一个 → 保持原直接派发语义', () => {
    expect(shouldDeferToCommanderForOrder({ requiresSequential: false, mentionIds: ['a', 'b'] })).toBe(false);
    expect(shouldDeferToCommanderForOrder({ requiresSequential: true, mentionIds: ['a'] })).toBe(false);
    expect(shouldDeferToCommanderForOrder({ requiresSequential: true, mentionIds: [] })).toBe(false);
  });
});

describe('member scope › 步骤启动边界（与顺序来源无关）', () => {
  const steps = (list: Array<[string, string, string[]]>) => list.map(([step_id, agent_id, depends_on]) => ({
    step_id, agent_id, depends_on,
  }));
  const start = (o: { steps: ReturnType<typeof steps>; step: [string, string, string[]]; seq?: boolean }) =>
    verifySequentialStepStart({
      requiresSequential: o.seq ?? true,
      steps: o.steps,
      stepToStart: steps([o.step])[0],
    });

  it('非顺序运行 / 无依赖步骤：一律放行（不论点名位次）', () => {
    expect(start({ seq: false, steps: [], step: ['s1', 'b', []] }).ok).toBe(true);
    expect(start({ steps: [], step: ['s1', 'b', []] }).ok).toBe(true);
    expect(start({ steps: steps([['s0', 'a', []]]), step: ['s1', 'b', []] }).ok).toBe(true);
  });

  it('依赖尚未建立的步骤不判环（前序还没开始是正常状态）', () => {
    expect(start({ steps: [], step: ['s2', 'b', ['s1']] }).ok).toBe(true);
    expect(start({ steps: steps([['s1', 'a', []]]), step: ['s2', 'b', ['s1']] }).ok).toBe(true);
  });
});
