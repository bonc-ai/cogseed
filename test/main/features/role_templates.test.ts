import { describe, it, expect } from 'vitest';
import { listRoleTemplates, getRoleTemplate } from '../../../src/main/features/role_templates';

/**
 * 角色模板 bundle（工作空间一期）：
 * 模板自带 skill_ids / agent_ids 捆绑，派生时与空间级 extra、项目级 bindings 并集。
 * 纯常量模块，无需 WS_ROOT fixture。
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
