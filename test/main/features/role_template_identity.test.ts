import { describe, it, expect } from 'vitest';
import {
  listRoleTemplates,
  validateRoleTemplateCatalog,
  type RoleTemplate,
} from '../../../src/main/features/role_templates';

/**
 * Role Template 稳定 schema identity 的守门测试。
 *
 * `id` 是跨版本认坑的唯一依据：显示名（title/name）可以随产品调整，id 一经
 * 发布不得再改、不得复用。这里钉住两件事：
 *  1. 现网 catalog 本身合法（每次改字段清单都要重新过这一条）；
 *  2. 校验器真的能抓出各类作者错误——校验器自己失灵比 catalog 出错更危险，
 *     因为它会让后续所有 migration 建立在一个没人检查过的 identity 上。
 */

/** 最小合法模板骨架；各用例只改自己要验的那一处。 */
function template(overrides: Partial<RoleTemplate> = {}): RoleTemplate {
  return {
    template_id: 'fixture',
    name: '样例',
    description: '',
    version: '1.0.0',
    preset_groups: [
      {
        id: 'background',
        title: '背景',
        fields: [
          { id: 'major', name: '专业' },
          { id: 'grade', name: '年级' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('role-template identity › 现网 catalog', () => {
  it('内置 catalog 通过全部 identity 约束', () => {
    expect(validateRoleTemplateCatalog()).toEqual([]);
  });

  it('每个分节与字段都带稳定 id，且 id 形状统一', () => {
    for (const t of listRoleTemplates()) {
      expect(t.preset_groups.length, `${t.template_id} 应有分节`).toBeGreaterThan(0);
      for (const sec of t.preset_groups) {
        expect(sec.id, `${t.template_id}/${sec.title}`).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(sec.fields.length, `${t.template_id}/${sec.id} 应有字段`).toBeGreaterThan(0);
        for (const f of sec.fields) {
          expect(f.id, `${t.template_id}/${sec.id}/${f.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
        }
      }
    }
  });

  it('section id 在模板内唯一', () => {
    for (const t of listRoleTemplates()) {
      const ids = t.preset_groups.map((s) => s.id);
      expect(new Set(ids).size, `${t.template_id} section id 重复`).toBe(ids.length);
    }
  });

  it('field id 在整个模板内唯一（跨分节移动要靠它认坑）', () => {
    for (const t of listRoleTemplates()) {
      const ids = t.preset_groups.flatMap((s) => s.fields.map((f) => f.id));
      expect(new Set(ids).size, `${t.template_id} field id 重复`).toBe(ids.length);
    }
  });

  it('没有任何 previous_names 与其它 identity 撞车', () => {
    const issues = validateRoleTemplateCatalog().filter((i) => i.kind === 'ambiguous_previous_name');
    expect(issues).toEqual([]);
  });
});

describe('role-template identity › 校验器能抓出作者错误', () => {
  it('分节 id 重复 → duplicate_section_id', () => {
    const t = template({
      preset_groups: [
        { id: 'dup', title: 'A', fields: [{ id: 'f1', name: 'x' }] },
        { id: 'dup', title: 'B', fields: [{ id: 'f2', name: 'y' }] },
      ],
    });
    expect(validateRoleTemplateCatalog([t]).map((i) => i.kind)).toContain('duplicate_section_id');
  });

  it('字段 id 跨分节重复 → duplicate_field_id', () => {
    const t = template({
      preset_groups: [
        { id: 's1', title: 'A', fields: [{ id: 'same', name: 'x' }] },
        { id: 's2', title: 'B', fields: [{ id: 'same', name: 'y' }] },
      ],
    });
    expect(validateRoleTemplateCatalog([t]).map((i) => i.kind)).toContain('duplicate_field_id');
  });

  it('历史名被两个 identity 同时声明 → ambiguous_previous_name', () => {
    const t = template({
      preset_groups: [
        {
          id: 'background',
          title: '背景',
          fields: [
            { id: 'major', name: '专业', previous_names: ['方向'] },
            { id: 'direction', name: '研究方向', previous_names: ['方向'] },
          ],
        },
      ],
    });
    expect(validateRoleTemplateCatalog([t]).map((i) => i.kind)).toContain('ambiguous_previous_name');
  });

  it('历史名与另一个 identity 的当前名撞车 → ambiguous_previous_name', () => {
    const t = template({
      preset_groups: [
        {
          id: 'background',
          title: '背景',
          fields: [
            { id: 'major', name: '专业' },
            // 「专业」是 major 的当前名，direction 不能把它当自己的历史名
            { id: 'direction', name: '研究方向', previous_names: ['专业'] },
          ],
        },
      ],
    });
    expect(validateRoleTemplateCatalog([t]).map((i) => i.kind)).toContain('ambiguous_previous_name');
  });

  it('分节历史名撞车同样被抓', () => {
    const t = template({
      preset_groups: [
        { id: 's1', title: '教育背景', previous_names: ['背景'], fields: [{ id: 'f1', name: 'x' }] },
        { id: 's2', title: '工作背景', previous_names: ['背景'], fields: [{ id: 'f2', name: 'y' }] },
      ],
    });
    expect(validateRoleTemplateCatalog([t]).map((i) => i.kind)).toContain('ambiguous_previous_name');
  });

  it('id 形状非法 → malformed_id', () => {
    const t = template({
      preset_groups: [{ id: 'Bad-Id', title: 'A', fields: [{ id: 'ok', name: 'x' }] }],
    });
    expect(validateRoleTemplateCatalog([t]).map((i) => i.kind)).toContain('malformed_id');
  });

  it('同分节内显示名重复 → duplicate_display_name（名字寻址会撞）', () => {
    const t = template({
      preset_groups: [
        {
          id: 's1',
          title: 'A',
          fields: [
            { id: 'f1', name: '专业' },
            { id: 'f2', name: '专业' },
          ],
        },
      ],
    });
    expect(validateRoleTemplateCatalog([t]).map((i) => i.kind)).toContain('duplicate_display_name');
  });

  it('不同分节里的同名字段是合法的（现网就有这种情况）', () => {
    const t = template({
      preset_groups: [
        { id: 's1', title: 'A', fields: [{ id: 'f1', name: '技术专长' }] },
        { id: 's2', title: 'B', fields: [{ id: 'f2', name: '技术专长' }] },
      ],
    });
    expect(validateRoleTemplateCatalog([t])).toEqual([]);
  });
});
