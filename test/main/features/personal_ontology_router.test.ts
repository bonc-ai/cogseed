import { describe, it, expect } from 'vitest';

/**
 * personal_ontology_router.ts — 候选确认的 LLM 对号入座路由。
 * 核心契约：LLM 失败/垃圾输出/字段不在清单内 → 一律 flow，绝不外抛、不阻塞确认。
 */

async function loadModule() {
  return import('../../../src/main/features/personal_ontology_router');
}

function fakeTemplates() {
  return [
    {
      template_id: 'student',
      name: '学生',
      version: '1.0.0',
      installed: true,
      gaps: [],
      installed_groups: [],
      preset_groups: [
        { title: '课程', fields: [{ name: '课程名称' }, { name: '学校' }] },
        { title: '偏好', fields: [{ name: '沟通风格' }, { name: '工具偏好' }] },
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
  it('parses a valid field decision', async () => {
    const r = await loadModule();
    expect(r.parseRouteDecision('{"action":"field","group_title":"课程","field_name":"课程名称"}'))
      .toEqual({ action: 'field', group_title: '课程', field_name: '课程名称' });
  });

  it('parses flow', async () => {
    const r = await loadModule();
    expect(r.parseRouteDecision('{"action":"flow"}')).toEqual({ action: 'flow' });
  });

  it('extracts JSON embedded in prose (LLM often adds text)', async () => {
    const r = await loadModule();
    expect(r.parseRouteDecision('好的，这条应填入课程组：\n{"action":"field","group_title":"课程","field_name":"学校"}\n完毕'))
      .toEqual({ action: 'field', group_title: '课程', field_name: '学校' });
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
  it('includes the installed-template field catalog and the candidate text', async () => {
    const r = await loadModule();
    const prompt = r.buildRoutePrompt('喜欢用大白话解释', fakeTemplates());
    expect(prompt).toContain('课程: [课程名称, 学校]');
    expect(prompt).toContain('偏好: [沟通风格, 工具偏好]');
    expect(prompt).toContain('喜欢用大白话解释');
  });
});

describe('personal_ontology_router › routeCandidateToField', () => {
  it('returns a validated field decision when LLM output is in the catalog', async () => {
    const r = await loadModule();
    const decision = await r.routeCandidateToField('u1', '喜欢大白话', fakeTemplates(), {
      buildRunnerFn: fakeBuildRunner('{"action":"field","group_title":"偏好","field_name":"沟通风格"}') as any,
    });
    expect(decision).toEqual({ action: 'field', group_title: '偏好', field_name: '沟通风格' });
  });

  it('flow when LLM says flow', async () => {
    const r = await loadModule();
    const decision = await r.routeCandidateToField('u1', '今天是周一', fakeTemplates(), {
      buildRunnerFn: fakeBuildRunner('{"action":"flow"}') as any,
    });
    expect(decision).toEqual({ action: 'flow' });
  });

  it('flow when LLM hallucinates a field not in the catalog', async () => {
    const r = await loadModule();
    const decision = await r.routeCandidateToField('u1', 'x', fakeTemplates(), {
      buildRunnerFn: fakeBuildRunner('{"action":"field","group_title":"不存在的组","field_name":"不存在的字段"}') as any,
    });
    expect(decision).toEqual({ action: 'flow' });
  });

  it('flow when LLM throws / returns empty — never throws to caller', async () => {
    const r = await loadModule();
    const d1 = await r.routeCandidateToField('u1', 'x', fakeTemplates(), {
      buildRunnerFn: fakeBuildRunner('') as any,
    });
    expect(d1).toEqual({ action: 'flow' });
    const d2 = await r.routeCandidateToField('u1', 'x', fakeTemplates(), {
      buildRunnerFn: (async () => { throw new Error('provider down'); }) as any,
    });
    expect(d2).toEqual({ action: 'flow' });
  });

  it('flow when no template is installed', async () => {
    const r = await loadModule();
    const noInstalled = [{ ...fakeTemplates()[0], installed: false }] as any[];
    const decision = await r.routeCandidateToField('u1', 'x', noInstalled, {
      buildRunnerFn: fakeBuildRunner('{"action":"field","group_title":"课程","field_name":"课程名称"}') as any,
    });
    expect(decision).toEqual({ action: 'flow' });
  });
});
