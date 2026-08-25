/**
 * T2b 应用中心 — 注册表与任务模板。
 */
import { describe, expect, it } from 'vitest';
import {
  APP_CENTER_APPS, APP_TASK_TEMPLATES, appCenterAvailability, appTaskMessage,
} from '../../../../src/main/features/app_center/registry';

describe('app center registry (T2b)', () => {
  it('registers four apps covering image + office trio with unique ids', () => {
    const ids = APP_CENTER_APPS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('ai-canvas');
    expect(ids).toContain('doc-writer');
    expect(ids).toContain('ppt-maker');
    expect(ids).toContain('sheet-builder');
    // 画图是 direct（直连 service），文档三件套是 agent_task（模板驱动）。
    const byId = Object.fromEntries(APP_CENTER_APPS.map((a) => [a.id, a]));
    expect(byId['ai-canvas'].kind).toBe('direct');
    expect(byId['doc-writer'].kind).toBe('agent_task');
    expect(byId['ppt-maker'].kind).toBe('agent_task');
    expect(byId['sheet-builder'].kind).toBe('agent_task');
  });

  it('availability covers every registered app', () => {
    const availability = appCenterAvailability();
    for (const app of APP_CENTER_APPS) {
      expect(availability[app.id]).toBeDefined();
      expect(typeof availability[app.id].available).toBe('boolean');
      // 不可用时必须带 i18n reasonKey（渲染层徽章文案）。
      if (!availability[app.id].available) {
        expect(availability[app.id].reasonKey).toMatch(/^apps\./);
      }
    }
  });

  it('task templates mention the office tool and carry the user goal', () => {
    const msg = appTaskMessage('ppt-maker', '产品季度汇报，6 页');
    expect(msg).toContain('create_pptx');
    expect(msg).toContain('产品季度汇报，6 页');
    // 每个模板都有 {goal} 占位符被替换（不留裸占位符）。
    for (const appId of Object.keys(APP_TASK_TEMPLATES)) {
      const out = appTaskMessage(appId, 'X');
      expect(out).toBeTruthy();
      expect(out).not.toContain('{goal}');
    }
  });

  it('task message rejects unknown app or empty goal', () => {
    expect(appTaskMessage('no-such-app', 'goal')).toBeNull();
    expect(appTaskMessage('doc-writer', '   ')).toBeNull();
  });
});
