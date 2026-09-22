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

  it('顺序意图写进范围块，方向沿用点名顺序', () => {
    const block = buildMemberScopeBlock({
      template: TEMPLATE,
      msg: msg({ ...snapshot, requires_sequential: true, mention_order: ['agent-task-2', 'agent-codex-1'] }),
      recipientId: 'commander',
      isExternal: false,
      nameOf: names,
    });
    expect(block).toContain('Sequential requirement');
    expect(block).toContain('集成验证Agent → Codex');
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

describe('member scope › 顺序强约束校验（设计 §4.4）', () => {
  const steps = (list: Array<[string, string, string[]]>) => list.map(([step_id, agent_id, depends_on]) => ({
    step_id, agent_id, depends_on,
  }));

  it('未命中顺序意图 / 单成员时不校验（保持并行现状）', () => {
    expect(verifySequentialPlan({ requiresSequential: false, mentionOrder: ['a', 'b'], steps: [] }).ok).toBe(true);
    expect(verifySequentialPlan({
      requiresSequential: true, mentionOrder: ['a'], steps: steps([['s1', 'a', []]]),
    }).ok).toBe(true);
  });

  it('依赖方向与点名顺序一致＝通过（含链式多步）', () => {
    const verdict = verifySequentialPlan({
      requiresSequential: true,
      mentionOrder: ['a', 'b', 'c'],
      steps: steps([['s1', 'a', []], ['s2', 'b', ['s1']], ['s3', 'c', ['s2']]]),
    });
    expect(verdict.ok).toBe(true);
  });

  it('并行派发（缺依赖）被拦，并说明是谁缺依赖', () => {
    const verdict = verifySequentialPlan({
      requiresSequential: true,
      mentionOrder: ['a', 'b'],
      steps: steps([['s1', 'a', []], ['s2', 'b', []]]),
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'missing_dependency', detail: 'b<-a' });
    expect(sequentialViolationMessage(verdict, ['a', 'b'])).toContain('不要并行派发');
  });

  it('被点名成员没被派发＝missing_member', () => {
    const verdict = verifySequentialPlan({
      requiresSequential: true,
      mentionOrder: ['a', 'b'],
      steps: steps([['s1', 'a', []]]),
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'missing_member', detail: 'b' });
  });

  it('依赖方向反了＝wrong_order（后一步被前一步依赖）', () => {
    const verdict = verifySequentialPlan({
      requiresSequential: true,
      mentionOrder: ['a', 'b'],
      steps: steps([['s1', 'a', ['s2']], ['s2', 'b', []]]),
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'wrong_order' });
  });

  it('依赖成环被拦', () => {
    const verdict = verifySequentialPlan({
      requiresSequential: true,
      mentionOrder: ['a', 'b'],
      steps: steps([['s1', 'a', ['s2']], ['s2', 'b', ['s1']]]),
    });
    expect(verdict.ok).toBe(false);
    expect(['cycle', 'wrong_order']).toContain((verdict as { reason: string }).reason);
  });

  it('通过时不产出纠正文案', () => {
    expect(sequentialViolationMessage({ ok: true }, ['a', 'b'])).toBe('');
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

describe('member scope › 逐步启动校验（复盘 21:34 误拦后）', () => {
  const steps = (list: Array<[string, string, string[]]>) => list.map(([step_id, agent_id, depends_on]) => ({
    step_id, agent_id, depends_on,
  }));
  const start = (o: { order: string[]; steps: ReturnType<typeof steps>; step: [string, string, string[]]; seq?: boolean }) =>
    verifySequentialStepStart({
      requiresSequential: o.seq ?? true,
      mentionOrder: o.order,
      steps: o.steps,
      stepToStart: steps([o.step])[0],
    });

  it('首位成员放行（哪怕后序成员还没计划）——修 21:34 误拦', () => {
    expect(start({ order: ['a', 'b'], steps: steps([['s1', 'a', []]]), step: ['s1', 'a', []] }).ok).toBe(true);
    expect(start({ order: ['a', 'b'], steps: [], step: ['s1', 'b', []] }).ok).toBe(false); // 第二位在前序没派发时仍要拦
  });

  it('非首位成员：前序步骤存在且被依赖 → 放行', () => {
    expect(start({
      order: ['a', 'b'],
      steps: steps([['s1', 'a', []], ['s2', 'b', ['s1']]]),
      step: ['s2', 'b', ['s1']],
    }).ok).toBe(true);
    // 间接依赖也算
    expect(start({
      order: ['a', 'b', 'c'],
      steps: steps([['s1', 'a', []], ['s2', 'b', ['s1']], ['s3', 'c', ['s2']]]),
      step: ['s3', 'c', ['s2']],
    }).ok).toBe(true);
  });

  it('缺前序 / 缺依赖 → 拦下并说明', () => {
    const v1 = start({ order: ['a', 'b'], steps: steps([['s1', 'a', []]]), step: ['s2', 'b', []] });
    expect(v1).toMatchObject({ ok: false, reason: 'missing_dependency' });
    const v2 = start({ order: ['a', 'b'], steps: steps([['s1', 'a', []], ['s2', 'b', []]]), step: ['s2', 'b', []] });
    expect(v2).toMatchObject({ ok: false, reason: 'missing_dependency' });
  });

  it('依赖了更靠后的成员且其步骤已存在（顺序打乱）→ wrong_order', () => {
    const v = start({
      order: ['a', 'b'],
      steps: steps([['s1', 'a', ['s2']], ['s2', 'b', []]]),
      step: ['s1', 'a', ['s2']],
    });
    expect(v).toMatchObject({ ok: false, reason: 'wrong_order' });
  });

  it('依赖了更靠后的成员但其步骤尚不存在（只是还没开始）→ 不判打乱', () => {
    // 前序在启动时带有对后序的依赖声明，但后序步骤对象还没建——不拦。
    expect(start({ order: ['b', 'a'], steps: steps([['sX', 'b', ['sY']]]), step: ['sX', 'b', ['sY']] }).ok).toBe(true);
  });

  it('非顺序运行 / 单点名 / 名单外成员 → 一律放行', () => {
    expect(start({ seq: false, order: ['a', 'b'], steps: [], step: ['s1', 'b', []] }).ok).toBe(true);
    expect(start({ order: ['a'], steps: [], step: ['s1', 'b', []] }).ok).toBe(true);
    expect(start({ order: ['a', 'b'], steps: [], step: ['s1', 'x', []] }).ok).toBe(true); // 未点名成员
  });
});
