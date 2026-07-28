import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/main/features/evolution/engine-loader', () => {
  class FakeSkillCreator {
    captureIntent(opts: any) {
      return {
        skill_id: 'skill_x',
        intent: { purpose: opts.purpose, trigger_contexts: opts.trigger_contexts, output_format: opts.output_format, needs_test_cases: true, edge_cases: [], dependencies: [], examples: [] },
        questions: ['触发场景还有哪些?', '输出格式是否固定?'],
      };
    }
  }
  return { loadEngine: async () => ({ SkillCreator: FakeSkillCreator }) };
});

import { captureSkillIntent, createSkillFromDraft } from '../../../../src/main/features/evolution/create-wizard';

describe('create-wizard', () => {
  it('captureSkillIntent 返回结构化意图 + 访谈问题', async () => {
    const r = await captureSkillIntent('u1', {
      name: '论文查重', purpose: '检测学术论文重复率', trigger_contexts: ['提交论文'], output_format: 'report',
    });
    expect(r.intent.purpose).toBe('检测学术论文重复率');
    expect(r.questions.length).toBeGreaterThan(0);
  });

  it('createSkillFromDraft 委托注入的 create 函数建技能', async () => {
    const created: Array<{ name: string; description: string; category: string }> = [];
    const r = await createSkillFromDraft('u1', {
      name: '论文查重', description: '检测重复率', category: 'academic',
    }, async (name, description, category) => { created.push({ name, description, category }); return { id: 'sk-new', name }; });
    expect(r.skill.id).toBe('sk-new');
    expect(created[0]).toEqual({ name: '论文查重', description: '检测重复率', category: 'academic' });
  });

  it('createSkillFromDraft 缺 name 抛错', async () => {
    await expect(createSkillFromDraft('u1', { name: '', description: 'x', category: '' }, async () => ({ id: 'x', name: '' })))
      .rejects.toThrow();
  });
});
