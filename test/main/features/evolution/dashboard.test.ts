import { describe, it, expect } from 'vitest';
import { buildDashboard } from '../../../../src/main/features/evolution/dashboard';

describe('buildDashboard', () => {
  it('聚合技能计数、待审补丁数、进化运行数', async () => {
    const dash = await buildDashboard('u1', {
      listSkills: async () => ([
        { id: 's1', name: 'A', category: 'x', enabled: true },
        { id: 's2', name: 'B', category: 'y', enabled: false },
      ] as any),
      listProjections: async () => ([
        { id: 'r1', status: 'needs_review' },
        { id: 'r2', status: 'completed' },
      ] as any),
      listRuns: async () => ([{ runId: 'e1', status: 'running' }] as any),
    });
    expect(dash.skillCount).toBe(2);
    expect(dash.enabledSkillCount).toBe(1);
    expect(dash.pendingReviewCount).toBe(1);
    expect(dash.evolutionRunCount).toBe(1);
    expect(dash.runningEvolutionCount).toBe(1);
  });

  it('依赖抛错时降级为 0 且标记 degraded，不外抛', async () => {
    const dash = await buildDashboard('u1', {
      listSkills: async () => { throw new Error('boom'); },
      listProjections: async () => [],
      listRuns: async () => [],
    });
    expect(dash.skillCount).toBe(0);
    expect(dash.degraded).toBe(true);
  });
});
