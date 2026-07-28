import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const P = require('../../src/renderer/modules/evolution/pages.js') as {
  renderDashboard: (d: any) => string;
  renderKstarTimeline: (r: any) => string;
  renderPatchList: (p: any[]) => string;
  escapeHtml: (s: unknown) => string;
};

describe('evolution pages 纯渲染', () => {
  it('renderDashboard 渲染计数卡片', () => {
    const html = P.renderDashboard({ skillCount: 3, enabledSkillCount: 2, pendingReviewCount: 1, evolutionRunCount: 5, runningEvolutionCount: 1, degraded: false });
    expect(html).toContain('3');
    expect(html).toContain('技能');
    expect(html).not.toContain('规则降级');
  });
  it('renderDashboard degraded 时显示降级提示', () => {
    const html = P.renderDashboard({ skillCount: 0, enabledSkillCount: 0, pendingReviewCount: 0, evolutionRunCount: 0, runningEvolutionCount: 0, degraded: true });
    expect(html).toContain('规则降级');
  });
  it('renderKstarTimeline 渲染 7 步，降级步带标记', () => {
    const run = { runId: 'r1', status: 'running', currentStep: 3, steps: [
      { step: 1, name: 'Capture', status: 'done' },
      { step: 2, name: 'Attribution', status: 'done' },
      { step: 3, name: 'Propose', status: 'degraded', degraded: true },
      { step: 4, name: 'Evaluate', status: 'pending' },
      { step: 5, name: 'Govern', status: 'pending' },
      { step: 6, name: 'Apply', status: 'pending' },
      { step: 7, name: 'Evolve', status: 'pending' },
    ] };
    const html = P.renderKstarTimeline(run);
    expect((html.match(/kstar-step/g) || []).length).toBeGreaterThanOrEqual(7);
    expect(html).toContain('Propose');
    expect(html).toContain('规则降级');
  });
  it('renderPatchList 渲染补丁与风险级别', () => {
    const html = P.renderPatchList([{ id: 'p1', status: 'needs_review', risk_level: 2, description: '改进查重' }]);
    expect(html).toContain('改进查重');
    expect(html).toContain('needs_review');
  });
  it('escapeHtml 防注入', () => {
    const html = P.renderPatchList([{ id: 'x', status: 'proposed', risk_level: 0, description: '<img src=x onerror=alert(1)>' }]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
