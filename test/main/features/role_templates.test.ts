import { describe, it, expect } from 'vitest';

/**
 * role_templates.ts — 内置角色模板注册表。
 * 模板 = 预置分组 + 每组的字段清单（挖空表单的"空坑"来源）。
 * T-box = 模板字段清单；R-box = isRelation 字段（值用 A → B 格式）。
 */

async function loadModule() {
  return import('../../../src/main/features/role_templates');
}

describe('role_templates › registry integrity', () => {
  it('every template_id is unique', async () => {
    const rt = await loadModule();
    const ids = rt.listRoleTemplates().map((t) => t.template_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every template has a semver version (^\\d+\\.\\d+\\.\\d+$)', async () => {
    const rt = await loadModule();
    for (const t of rt.listRoleTemplates()) {
      expect(t.version, t.template_id).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('every preset group has a title and a non-empty field list', async () => {
    const rt = await loadModule();
    for (const t of rt.listRoleTemplates()) {
      expect(t.preset_groups.length).toBeGreaterThan(0);
      for (const g of t.preset_groups) {
        expect(g.title.trim()).toBeTruthy();
        expect(g.fields.length).toBeGreaterThan(0);
      }
    }
  });

  it('getRoleTemplate hits known ids and misses unknown ones', async () => {
    const rt = await loadModule();
    expect(rt.getRoleTemplate('student')?.name).toBe('学生');
    expect(rt.getRoleTemplate('scholar')?.name).toBe('学者');
    expect(rt.getRoleTemplate('fde')?.name).toBe('FDE');
    expect(rt.getRoleTemplate('doctor')).toBeUndefined();
    expect(rt.getRoleTemplate('')).toBeUndefined();
  });
});

describe('role_templates › built-in v1.0.0 field lists (strict)', () => {
  it('student: 4 preset groups with exact field names + isRelation declarations', async () => {
    const rt = await loadModule();
    const t = rt.getRoleTemplate('student');
    expect(t?.version).toBe('1.0.0');
    expect(t?.preset_groups.map((g) => g.title)).toEqual(['课程', '项目', '技能', '偏好']);

    const byTitle = Object.fromEntries(t!.preset_groups.map((g) => [g.title, g.fields.map((f) => ({ name: f.name, isRelation: !!f.isRelation }))]));
    expect(byTitle['课程']).toEqual([
      { name: '课程名称', isRelation: false },
      { name: '学校', isRelation: false },
      { name: '专业', isRelation: false },
      { name: '入学年份', isRelation: false },
    ]);
    expect(byTitle['项目']).toEqual([
      { name: '项目名称', isRelation: false },
      { name: '角色', isRelation: false },
      { name: '状态', isRelation: false },
      { name: '所属课程', isRelation: true },
    ]);
    expect(byTitle['技能']).toEqual([
      { name: '技能名', isRelation: false },
      { name: '熟练度', isRelation: false },
    ]);
    expect(byTitle['偏好']).toEqual([
      { name: '沟通风格', isRelation: false },
      { name: '工具偏好', isRelation: false },
    ]);
  });

  it('scholar: 4 preset groups with exact field names + isRelation declarations', async () => {
    const rt = await loadModule();
    const t = rt.getRoleTemplate('scholar');
    expect(t?.version).toBe('1.0.0');
    expect(t?.preset_groups.map((g) => g.title)).toEqual(['研究方向', '论文', '合作者', '数据集']);

    const byTitle = Object.fromEntries(t!.preset_groups.map((g) => [g.title, g.fields.map((f) => ({ name: f.name, isRelation: !!f.isRelation }))]));
    expect(byTitle['研究方向']).toEqual([
      { name: '方向', isRelation: false },
      { name: '关键词', isRelation: false },
    ]);
    expect(byTitle['论文']).toEqual([
      { name: '题目', isRelation: false },
      { name: '状态', isRelation: false },
      { name: '合作者', isRelation: true },
    ]);
    expect(byTitle['合作者']).toEqual([
      { name: '姓名', isRelation: false },
      { name: '机构', isRelation: false },
      { name: '角色', isRelation: false },
    ]);
    expect(byTitle['数据集']).toEqual([
      { name: '名称', isRelation: false },
      { name: '用途', isRelation: false },
      { name: '来源', isRelation: false },
    ]);
  });

  it('fde: 4 preset groups with exact field names + isRelation declarations', async () => {
    const rt = await loadModule();
    const t = rt.getRoleTemplate('fde');
    expect(t?.version).toBe('1.0.0');
    expect(t?.preset_groups.map((g) => g.title)).toEqual(['项目', '技术栈', '编码规范', '交付物']);

    const byTitle = Object.fromEntries(t!.preset_groups.map((g) => [g.title, g.fields.map((f) => ({ name: f.name, isRelation: !!f.isRelation }))]));
    expect(byTitle['项目']).toEqual([
      { name: '项目名称', isRelation: false },
      { name: '角色', isRelation: false },
      { name: '技术栈', isRelation: false },
      { name: '所属仓库', isRelation: true },
    ]);
    expect(byTitle['技术栈']).toEqual([
      { name: '技术', isRelation: false },
      { name: '熟练度', isRelation: false },
      { name: '用途', isRelation: false },
    ]);
    expect(byTitle['编码规范']).toEqual([
      { name: '规范', isRelation: false },
      { name: '适用范围', isRelation: false },
    ]);
    expect(byTitle['交付物']).toEqual([
      { name: '名称', isRelation: false },
      { name: '类型', isRelation: false },
      { name: '位置', isRelation: false },
    ]);
  });
});
