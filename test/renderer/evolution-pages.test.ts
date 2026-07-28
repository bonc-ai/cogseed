import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const P = require('../../src/renderer/modules/evolution/pages.js') as {
  renderDashboard: (d: any) => string;
  renderKstarTimeline: (r: any) => string;
  renderPatchList: (p: any[]) => string;
  renderOntologyBindings: (refs: string[]) => string;
  renderSkillVersions: (versions: any[]) => string;
  renderCreateForm: () => string;
  renderInterviewQuestions: (questions: string[]) => string;
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
  it('renderOntologyBindings 渲染已绑定 id + 解绑按钮 + 绑定表单', () => {
    const html = P.renderOntologyBindings(['onto-a', 'onto-b']);
    expect(html).toContain('onto-a');
    expect(html).toContain('evo-onto-unbind');
    expect(html).toContain('evo-onto-bind-btn');
  });
  it('renderOntologyBindings 空绑定显示空态但仍有绑定表单', () => {
    const html = P.renderOntologyBindings([]);
    expect(html).toContain('暂无绑定本体');
    expect(html).toContain('evo-onto-bind-btn');
  });
  it('renderSkillVersions 渲染版本列表', () => {
    const html = P.renderSkillVersions([{ version: '0.1.2', at: '2026-07-28', note: '改进' }, { version: '0.1.1', at: '2026-07-27' }]);
    expect(html).toContain('v0.1.2');
    expect(html).toContain('v0.1.1');
    expect(html).toContain('改进');
  });
  it('renderSkillVersions 空列表显示空态', () => {
    expect(P.renderSkillVersions([])).toContain('暂无版本记录');
  });
  it('renderCreateForm 含名称/用途输入 + 捕获意图/创建草稿按钮', () => {
    const html = P.renderCreateForm();
    expect(html).toContain('evo-create-name');
    expect(html).toContain('evo-create-intent-btn');
    expect(html).toContain('evo-create-draft-btn');
  });
  it('renderInterviewQuestions 渲染访谈问题列表', () => {
    const html = P.renderInterviewQuestions(['触发场景?', '输出格式?']);
    expect(html).toContain('触发场景?');
    expect(html).toContain('访谈问题');
  });
});
