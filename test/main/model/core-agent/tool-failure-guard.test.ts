import { describe, expect, it } from 'vitest';

import {
  classifyToolFailure,
  createToolFailureGuard,
  describeToolFailure,
} from '../../../../src/main/model/core-agent/tool-failure-guard';

/**
 * Fixtures are real messages recovered from this machine's runtime (see
 * `CogSeed-材料自采报告-20261013.md`): the ontology guard, a tool-arg contract
 * error, the bash dynamic-path guard and a network failure. They are the exact
 * dead ends the breaker has to separate.
 */
const ONTOLOGY_NO_TEMPLATE = '用户尚未安装任何角色模板，没有可填字段。不要猜测字段名。'
  + '这是确定性错误：换字段名或重试都不会成功；请改走规则与偏好资产通道，或先请用户安装角色模板后再写入个人本体。';
const PLAN_ONE_IN_PROGRESS = 'manage_execution_plan allows at most one in_progress step';
const BASH_DYNAMIC_PATH = 'E_BASH_DYNAMIC_PATH_UNSUPPORTED: bash cat target "$V/$f" uses an unresolved variable';
const POLICY_DENIED = 'E_LOCAL_ACCESS_DENIED: 沙箱路径不在允许范围内';
const NETWORK = 'fetch failed';

describe('tool failure classification', () => {
  it('classifies deterministic failures by kind and code', () => {
    expect(classifyToolFailure(ONTOLOGY_NO_TEMPLATE)).toEqual({ kind: 'missing_dependency', code: 'missing_dependency' });
    expect(classifyToolFailure(PLAN_ONE_IN_PROGRESS)).toEqual({ kind: 'invalid_args', code: 'invalid_args' });
    expect(classifyToolFailure(BASH_DYNAMIC_PATH)).toEqual({ kind: 'invalid_args', code: 'invalid_args' });
    expect(classifyToolFailure(POLICY_DENIED)).toEqual({ kind: 'policy_denied', code: 'policy_denied' });
  });

  it('keeps network-shaped failures out of the deterministic classes', () => {
    expect(classifyToolFailure(NETWORK).kind).toBe('transient');
    expect(classifyToolFailure('Request timed out.').kind).toBe('transient');
    expect(classifyToolFailure('HTTP 503 from provider').kind).toBe('transient');
  });

  it('never throws and falls back to an unclassified, still-counted kind', () => {
    expect(classifyToolFailure('')).toEqual({ kind: 'unclassified', code: 'tool_error_unclassified' });
    expect(classifyToolFailure(undefined as unknown as string).kind).toBe('unclassified');
  });
});

describe('tool failure guard', () => {
  const fail = (tool: string, content: string) => ({ tool, content, isError: true });
  const ok = (tool: string, content = 'ok') => ({ tool, content, isError: false });

  it('trips on the third consecutive same-kind failure', () => {
    const guard = createToolFailureGuard();
    expect(guard.observe(fail('personal_ontology_fields', ONTOLOGY_NO_TEMPLATE)).action).toBe('continue');
    expect(guard.observe(fail('personal_ontology_fields', ONTOLOGY_NO_TEMPLATE)).action).toBe('continue');

    const decision = guard.observe(fail('personal_ontology_fields', ONTOLOGY_NO_TEMPLATE));
    expect(decision.action).toBe('endTurn');
    if (decision.action !== 'endTurn') throw new Error('unreachable');
    expect(decision.kind).toBe('missing_dependency');
    expect(decision.countedFailures).toBe(3);
  });

  it('trips on accumulated failures of different kinds', () => {
    const guard = createToolFailureGuard({ maxSameKind: 99, maxTotal: 4 });
    expect(guard.observe(fail('a', ONTOLOGY_NO_TEMPLATE)).action).toBe('continue');
    expect(guard.observe(fail('b', PLAN_ONE_IN_PROGRESS)).action).toBe('continue');
    expect(guard.observe(fail('c', POLICY_DENIED)).action).toBe('continue');
    expect(guard.observe(fail('d', 'something else went wrong')).action).toBe('endTurn');
  });

  it('never trips on transient network failures, however many arrive', () => {
    const guard = createToolFailureGuard();
    for (let i = 0; i < 10; i += 1) {
      expect(guard.observe(fail('search_web', NETWORK)).action).toBe('continue');
    }
    expect(guard.snapshot()).toMatchObject({ countedFailures: 0, sameKindStreak: 0 });
  });

  it('never trips on persisted-result retrieval control errors', () => {
    const guard = createToolFailureGuard();
    const budgetError = '<tool-error code="E_RESULT_READ_BUDGET">The 4K-token persisted-result read budget for this model step is exhausted.</tool-error>';
    for (let i = 0; i < 5; i += 1) {
      expect(guard.observe(fail('tool_result_read_chunk', budgetError)).action).toBe('continue');
    }
    expect(guard.snapshot()).toMatchObject({ countedFailures: 0, sameKindStreak: 0 });
  });

  it('resets the streak after any successful observation', () => {
    const guard = createToolFailureGuard();
    guard.observe(fail('a', ONTOLOGY_NO_TEMPLATE));
    guard.observe(fail('b', ONTOLOGY_NO_TEMPLATE));
    expect(guard.snapshot().sameKindStreak).toBe(2);

    expect(guard.observe(ok('read_file', 'report.md')).action).toBe('continue');
    expect(guard.snapshot().sameKindStreak).toBe(0);

    // Two more failures stay below the same-kind threshold again.
    expect(guard.observe(fail('c', ONTOLOGY_NO_TEMPLATE)).action).toBe('continue');
    expect(guard.observe(fail('d', ONTOLOGY_NO_TEMPLATE)).action).toBe('continue');
  });

  it('switching kind restarts the same-kind streak but keeps the total', () => {
    const guard = createToolFailureGuard({ maxSameKind: 3, maxTotal: 99 });
    guard.observe(fail('a', ONTOLOGY_NO_TEMPLATE));
    guard.observe(fail('b', ONTOLOGY_NO_TEMPLATE));
    expect(guard.observe(fail('c', PLAN_ONE_IN_PROGRESS)).action).toBe('continue');
    expect(guard.snapshot()).toMatchObject({ sameKindStreak: 1, countedFailures: 3 });
  });

  it('carries cause, last progress and recovery in the tripped reason', () => {
    const guard = createToolFailureGuard();
    guard.observe(ok('read_file', '日报规则.md'));
    guard.observe(fail('personal_ontology_fields', ONTOLOGY_NO_TEMPLATE));
    guard.observe(fail('personal_ontology_fields', ONTOLOGY_NO_TEMPLATE));
    const decision = guard.observe(fail('personal_ontology_fields', ONTOLOGY_NO_TEMPLATE));
    if (decision.action !== 'endTurn') throw new Error('expected endTurn');

    expect(decision.reason).toContain('连续 3 次同类确定性失败');
    expect(decision.reason).toContain('最近一次有效进展：read_file 成功：日报规则.md');
    expect(decision.reason).toContain('建议：');
    expect(decision.reason).toContain('未包含网络类重试');
  });

  it('describes recovery per kind so the message is actionable', () => {
    const base = { tool: 't', content: 'x', sameKindStreak: 3, countedFailures: 3, lastProgress: 'none' };
    expect(describeToolFailure({ ...base, kind: 'missing_dependency', code: 'missing_dependency' }))
      .toContain('安装角色模板');
    expect(describeToolFailure({ ...base, kind: 'invalid_args', code: 'invalid_args' }))
      .toContain('按报错修正参数');
    expect(describeToolFailure({ ...base, kind: 'policy_denied', code: 'policy_denied' }))
      .toContain('放开所需权限');
  });
});

describe('guardToolsWithFailureBreaker', () => {
  type AnyTool = {
    name: string;
    executionMode?: 'sequential' | 'parallel';
    execute(input: never, ctx: never): Promise<unknown>;
  };

  function tool(name: string, results: unknown[], executionMode?: 'sequential' | 'parallel'): AnyTool {
    let i = 0;
    return {
      name,
      ...(executionMode ? { executionMode } : {}),
      async execute() { return results[Math.min(i++, results.length - 1)]; },
    };
  }

  const failing = { content: ONTOLOGY_NO_TEMPLATE, isError: true };

  it('ends the turn on the third sequential deterministic failure', async () => {
    const { guardToolsWithFailureBreaker } = await import('../../../../src/main/model/core-agent/tool-failure-guard');
    const trips: string[] = [];
    const guard = createToolFailureGuard();
    const [wrapped] = guardToolsWithFailureBreaker([tool('personal_ontology_fields', [failing])], {
      guard,
      onTrip: (event) => trips.push(event.code),
    }) as [AnyTool];

    await wrapped.execute({} as never, {} as never);
    await wrapped.execute({} as never, {} as never);
    const third = await wrapped.execute({} as never, {} as never) as { endTurn?: boolean; isError?: boolean; content?: string };

    expect(third.endTurn).toBe(true);
    expect(third.isError).toBe(true);
    expect(third.content).toContain('建议：');
    expect(trips).toEqual(['missing_dependency']);
  });

  it('never ends the turn early for parallel tools but still counts', async () => {
    const { guardToolsWithFailureBreaker } = await import('../../../../src/main/model/core-agent/tool-failure-guard');
    const trips: string[] = [];
    const guard = createToolFailureGuard();
    const [wrapped] = guardToolsWithFailureBreaker([tool('search_files', [failing], 'parallel')], {
      guard,
      onTrip: (event) => trips.push(event.code),
    }) as [AnyTool];

    for (let i = 0; i < 4; i += 1) {
      const result = await wrapped.execute({} as never, {} as never) as { endTurn?: boolean };
      expect(result.endTurn).toBeUndefined();
    }
    expect(trips.length).toBeGreaterThan(0);   // reported, not early-terminated
    expect(guard.snapshot().countedFailures).toBe(4);
  });

  it('leaves successful results untouched', async () => {
    const { guardToolsWithFailureBreaker } = await import('../../../../src/main/model/core-agent/tool-failure-guard');
    const guard = createToolFailureGuard();
    const okResult = { content: 'done', isError: false };
    const [wrapped] = guardToolsWithFailureBreaker([tool('read_file', [okResult])], { guard }) as [AnyTool];

    await expect(wrapped.execute({} as never, {} as never)).resolves.toBe(okResult);
    expect(guard.snapshot().sameKindStreak).toBe(0);
  });
});
