import { describe, it, expect } from 'vitest';
import { listRoleTemplates, getRoleTemplate, listScenarios, getScenario } from '../../../src/main/features/role_templates';

/**
 * 角色模板 bundle（情境空间一期）：
 * 模板自带 skill_ids / agent_ids 捆绑，派生时与空间级 extra、项目级 bindings 并集。
 * 纯常量模块，无需 WS_ROOT fixture。
 *
 * M2 新增：场景（Scenario）= 情境入口，推荐角色模板组合。
 */

describe('role_templates › bundle', () => {
  it('所有内置模板带 bundle 字段（v1.1.0），skill_ids/agent_ids 为字符串数组', () => {
    const templates = listRoleTemplates();
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(t.bundle, `template ${t.template_id} missing bundle`).toBeDefined();
      expect(Array.isArray(t.bundle!.skill_ids)).toBe(true);
      expect(Array.isArray(t.bundle!.agent_ids)).toBe(true);
      for (const s of t.bundle!.skill_ids) expect(typeof s).toBe('string');
      for (const a of t.bundle!.agent_ids) expect(typeof a).toBe('string');
    }
  });

  it('student 模板带非空占位 bundle（一期占位，海运调研后填真值）', () => {
    const t = getRoleTemplate('student');
    expect(t).toBeDefined();
    expect(t!.bundle!.skill_ids.length).toBeGreaterThan(0);
    expect(t!.bundle!.agent_ids.length).toBeGreaterThan(0);
  });

  it('getRoleTemplate 返回防御性拷贝：改 bundle 不影响内部注册表', () => {
    const t1 = getRoleTemplate('student')!;
    t1.bundle!.skill_ids.push('__hacked__');
    const t2 = getRoleTemplate('student')!;
    expect(t2.bundle!.skill_ids.includes('__hacked__')).toBe(false);
  });

  it('listRoleTemplates 返回防御性拷贝：改数组不影响后续读取', () => {
    const first = listRoleTemplates();
    first[0].bundle!.skill_ids = [];
    const second = listRoleTemplates();
    expect(second[0].bundle!.skill_ids.length).toBeGreaterThan(0);
  });

  it('getRoleTemplate 未知 id 返回 undefined', () => {
    expect(getRoleTemplate('__nonexistent__')).toBeUndefined();
  });
});

describe('role_templates › scenarios（M2 情境入口）', () => {
  it('listScenarios 返回 4 个场景（教育/写作/职场/自定义）', () => {
    const scenarios = listScenarios();
    expect(scenarios.length).toBe(4);
    const ids = scenarios.map((s) => s.scenario_id).sort();
    expect(ids).toEqual(['custom', 'education', 'workplace', 'writing']);
  });

  it('每个场景必有 scenario_id / name / icon / description', () => {
    for (const s of listScenarios()) {
      expect(typeof s.scenario_id).toBe('string');
      expect(s.scenario_id.length).toBeGreaterThan(0);
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.icon).toBe('string');
      expect(s.icon.length).toBeGreaterThan(0);
      expect(typeof s.description).toBe('string');
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it('教育场景建议主模板 student + 副模板 scholar', () => {
    const s = getScenario('education')!;
    expect(s.suggested_primary_template_id).toBe('student');
    expect(s.suggested_secondary_template_ids).toEqual(['scholar']);
  });

  it('写作用场景建议主模板 technical_writer，无副模板', () => {
    const s = getScenario('writing')!;
    expect(s.suggested_primary_template_id).toBe('technical_writer');
    expect(s.suggested_secondary_template_ids).toEqual([]);
  });

  it('职场场景建议主模板 product_manager + 副模板 project_manager + fde', () => {
    const s = getScenario('workplace')!;
    expect(s.suggested_primary_template_id).toBe('product_manager');
    expect(s.suggested_secondary_template_ids).toEqual(['project_manager', 'fde']);
  });

  it('自定义场景无建议主模板', () => {
    const s = getScenario('custom')!;
    expect(s.suggested_primary_template_id).toBeUndefined();
    expect(s.suggested_secondary_template_ids).toEqual([]);
  });

  it('listScenarios 返回防御性拷贝：改数组不影响后续读取', () => {
    const first = listScenarios();
    first[0].suggested_secondary_template_ids.push('__hacked__');
    const second = listScenarios();
    expect(second[0].suggested_secondary_template_ids.includes('__hacked__')).toBe(false);
  });

  it('getScenario 未知 id 返回 undefined', () => {
    expect(getScenario('__none__')).toBeUndefined();
  });
});
