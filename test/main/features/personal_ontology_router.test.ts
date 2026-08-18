import { describe, it, expect } from 'vitest';

/**
 * personal_ontology_router.ts — 候选确认的 LLM 对号入座路由。
 * 核心契约：LLM 失败/垃圾输出/字段不在清单内 → 一律 flow，绝不外抛、不阻塞确认。
 * 阶段 D：字段清单来自模板文件 catalog（分节.字段），`group_title` = 分节名。
 */

async function loadModule() {
  return import('../../../src/main/features/personal_ontology_router');
}

function fakeCatalog() {
  return [
    {
      group_id: 'g1',
      template_id: 'student',
      name: '学生',
      version: '1.0.0',
      sections: [
        { title: '课程', fields: ['课程名称', '学校'] },
        { title: '偏好', fields: ['沟通风格', '工具偏好'] },
      ],
    },
  ] as any[];
}

function fakeBuildRunner(reply: string | (() => Promise<string>)) {
  const runner = {
    runReflection: async () => (typeof reply === 'function' ? reply() : reply),
  };
  return async () => ({ runner });
}

describe('personal_ontology_router › parseRouteDecision', () => {
  it('parses a valid field decision (confidence 缺省视为 low)', async () => {
    const r = await loadModule();
    expect(r.parseRouteDecision('{"action":"field","group_title":"课程","field_name":"课程名称"}'))
      .toEqual({ action: 'field', group_title: '课程', field_name: '课程名称', confidence: 'low' });
  });

  it('parses field decision with explicit confidence', async () => {
    const r = await loadModule();
    expect(r.parseRouteDecision('{"action":"field","group_title":"课程","field_name":"课程名称","confidence":"high"}'))
      .toEqual({ action: 'field', group_title: '课程', field_name: '课程名称', confidence: 'high' });
  });

  it('parses flow', async () => {
    const r = await loadModule();
    expect(r.parseRouteDecision('{"action":"flow"}')).toEqual({ action: 'flow' });
  });

  it('extracts JSON embedded in prose (LLM often adds text)', async () => {
    const r = await loadModule();
    expect(r.parseRouteDecision('好的，这条应填入课程组：\n{"action":"field","group_title":"课程","field_name":"学校","confidence":"high"}\n完毕'))
      .toEqual({ action: 'field', group_title: '课程', field_name: '学校', confidence: 'high' });
  });

  it('returns null for garbage / missing / invalid JSON', async () => {
    const r = await loadModule();
    expect(r.parseRouteDecision('')).toBeNull();
    expect(r.parseRouteDecision('不是 JSON')).toBeNull();
    expect(r.parseRouteDecision('{"action":"unknown"}')).toBeNull();
    expect(r.parseRouteDecision('{"action":"field"}')).toBeNull(); // 缺 group/field
    expect(r.parseRouteDecision('{"action":"field","group_title":"课程"}')).toBeNull();
  });
});

describe('personal_ontology_router › buildRoutePrompt', () => {
  it('includes the installed-template section/field catalog and the candidate text', async () => {
    const r = await loadModule();
    const prompt = r.buildRoutePrompt('喜欢用大白话解释', fakeCatalog());
    expect(prompt).toContain('课程: [课程名称, 学校]');
    expect(prompt).toContain('偏好: [沟通风格, 工具偏好]');
    expect(prompt).toContain('喜欢用大白话解释');
  });
});

describe('personal_ontology_router › routeCandidateToField', () => {
  it('uses the allowed one-shot reflection session kind', async () => {
    const r = await loadModule();
    let buildInput: any;
    await r.routeCandidateToField('u1', '喜欢大白话', fakeCatalog(), {
      buildRunnerFn: (async (input: any) => {
        buildInput = input;
        return fakeBuildRunner('{"action":"flow"}')();
      }) as any,
    });
    expect(buildInput).toMatchObject({ userId: 'u1' });
    expect(buildInput.sessionId).toMatch(/^reflect-ontology-route-/);
  });

  it('returns a validated field decision when LLM output is high-confidence and in the catalog', async () => {
    const r = await loadModule();
    const decision = await r.routeCandidateToField('u1', '喜欢大白话', fakeCatalog(), {
      buildRunnerFn: fakeBuildRunner('{"action":"field","group_title":"偏好","field_name":"沟通风格","confidence":"high"}') as any,
    });
    expect(decision).toEqual({ action: 'field', group_title: '偏好', field_name: '沟通风格', confidence: 'high' });
  });

  it('returns a legitimate flow without marking it as a routing failure', async () => {
    const r = await loadModule();
    const decision = await r.routeCandidateToField('u1', '今天是周一', fakeCatalog(), {
      buildRunnerFn: fakeBuildRunner('{"action":"flow"}') as any,
    });
    expect(decision).toEqual({ action: 'flow' });
    expect(decision.failure).toBeUndefined();
  });

  it('flow when LLM is only medium/low confidence (置信度门禁：防误填污染画像)', async () => {
    const r = await loadModule();
    const d1 = await r.routeCandidateToField('u1', '可能喜欢大白话', fakeCatalog(), {
      buildRunnerFn: fakeBuildRunner('{"action":"field","group_title":"偏好","field_name":"沟通风格","confidence":"medium"}') as any,
    });
    expect(d1).toEqual({ action: 'flow' });
    const d2 = await r.routeCandidateToField('u1', 'x', fakeCatalog(), {
      buildRunnerFn: fakeBuildRunner('{"action":"field","group_title":"偏好","field_name":"沟通风格","confidence":"low"}') as any,
    });
    expect(d2).toEqual({ action: 'flow' });
    // 缺 confidence 字段也视为 low → flow（旧格式回复不自动填坑）
    const d3 = await r.routeCandidateToField('u1', 'x', fakeCatalog(), {
      buildRunnerFn: fakeBuildRunner('{"action":"field","group_title":"偏好","field_name":"沟通风格"}') as any,
    });
    expect(d3).toEqual({ action: 'flow' });
  });

  it('marks a hallucinated section/field as invalid_response', async () => {
    const r = await loadModule();
    const decision = await r.routeCandidateToField('u1', 'x', fakeCatalog(), {
      buildRunnerFn: fakeBuildRunner('{"action":"field","group_title":"不存在的分节","field_name":"不存在的字段","confidence":"high"}') as any,
    });
    expect(decision).toEqual({ action: 'flow', failure: 'invalid_response' });
  });

  it('marks empty and malformed model output as invalid_response without throwing', async () => {
    const r = await loadModule();
    const d1 = await r.routeCandidateToField('u1', 'x', fakeCatalog(), {
      buildRunnerFn: fakeBuildRunner('') as any,
    });
    expect(d1).toEqual({ action: 'flow', failure: 'invalid_response' });

    const d2 = await r.routeCandidateToField('u1', 'x', fakeCatalog(), {
      buildRunnerFn: fakeBuildRunner('这不是合法路由结果') as any,
    });
    expect(d2).toEqual({ action: 'flow', failure: 'invalid_response' });

  });

  it('marks provider/build failures as model_unavailable without throwing', async () => {
    const r = await loadModule();
    const decision = await r.routeCandidateToField('u1', 'x', fakeCatalog(), {
      buildRunnerFn: (async () => { throw new Error('provider down'); }) as any,
    });
    expect(decision).toEqual({ action: 'flow', failure: 'model_unavailable' });
  });

  it('flow when catalog is empty (no installed templates)', async () => {
    const r = await loadModule();
    const decision = await r.routeCandidateToField('u1', 'x', [], {
      buildRunnerFn: fakeBuildRunner('{"action":"field","group_title":"课程","field_name":"课程名称","confidence":"high"}') as any,
    });
    expect(decision).toEqual({ action: 'flow' });
  });
});
