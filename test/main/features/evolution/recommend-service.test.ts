import { describe, it, expect } from 'vitest';
import { buildRecommendations } from '../../../../src/main/features/evolution/recommend-service';

describe('recommend-service', () => {
  it('从领域本体 rbox 规则 + 高ΔR episode 生成建议', async () => {
    const r = await buildRecommendations('u1', 'sk1', {
      listBindings: async () => ['onto-domain'],
      loadOntology: async (id) => id === 'onto-domain'
        ? { category: 'domain', name: '学术规范', rbox: [{ id: 'R1', name: '查重门槛', description: '相似度超30%需复审', severity: 'warning' }], tbox: [] }
        : null,
      listEpisodes: async () => ([{ id: 'ep1', task: '用户抱怨查重误报', delta_r: 0.8 }]),
    });
    const rules = r.suggestions.filter(s => s.source !== 'episode');
    const eps = r.suggestions.filter(s => s.source === 'episode');
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules[0].description).toContain('相似度');
    expect(eps.length).toBe(1);
    expect(eps[0].description).toContain('误报');
  });

  it('从个人本体 tbox 事实生成偏好建议', async () => {
    const r = await buildRecommendations('u1', 'sk1', {
      listBindings: async () => ['onto-personal'],
      loadOntology: async () => ({ category: 'personal', name: '我的偏好', rbox: [], tbox: [{ label: '语气', description: '正式书面' }] }),
      listEpisodes: async () => [],
    });
    expect(r.suggestions.some(s => s.description.includes('正式书面'))).toBe(true);
  });

  it('无绑定本体时只可能有 episode 建议，规则建议为空', async () => {
    const r = await buildRecommendations('u1', 'sk1', {
      listBindings: async () => [],
      loadOntology: async () => null,
      listEpisodes: async () => [],
    });
    expect(r.suggestions).toEqual([]);
  });

  it('低ΔR episode 不进建议（阈值 0.5）', async () => {
    const r = await buildRecommendations('u1', 'sk1', {
      listBindings: async () => [],
      loadOntology: async () => null,
      listEpisodes: async () => ([{ id: 'ep-low', task: '小问题', delta_r: 0.2 }]),
    });
    expect(r.suggestions).toEqual([]);
  });
});
