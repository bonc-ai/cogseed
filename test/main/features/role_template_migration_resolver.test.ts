import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Identity resolver：把「旧实例文件里的名字」一步解析到「catalog 当前 identity」。
 *
 * 两条不可让步的性质：
 *  - 单跳：v1 的名字和 v3 的名字都直接落到当前 id，不需要按版本顺序重放；
 *  - 歧义即失败：多个 identity 认领同一个名字时必须报错而不是挑一个 —— 猜错
 *    会把用户已经填好的值搬进别人的坑，而且事后无从分辨。
 */

const CATALOG: any[] = [];

vi.mock('../../../src/main/features/role_templates', () => ({
  getRoleTemplate: (id: string) => {
    const found = CATALOG.find((t) => t.template_id === id);
    return found ? JSON.parse(JSON.stringify(found)) : undefined;
  },
  listRoleTemplates: () => JSON.parse(JSON.stringify(CATALOG)),
}));

async function load() {
  return import('../../../src/main/features/personal_ontology_migration');
}

beforeEach(() => {
  vi.resetModules();
  CATALOG.length = 0;
});

function setCatalog(groups: any[]) {
  CATALOG.push({
    template_id: 'student',
    name: '学生',
    description: '',
    version: '2.0.0',
    preset_groups: groups,
  });
}

describe('resolver › 分节', () => {
  it('当前名解析到当前 identity', async () => {
    setCatalog([{ id: 'education', title: '教育背景', fields: [] }]);
    const { resolveSectionIdentity } = await load();
    const res = resolveSectionIdentity('student', '教育背景');
    expect(res).toEqual({ ok: true, matchedBy: 'current_name', identity: { sectionId: 'education', title: '教育背景' } });
  });

  it('历史名一步解析到当前 identity（不需要逐版本链）', async () => {
    setCatalog([{ id: 'education', title: '教育背景', previous_names: ['背景', '学习背景'], fields: [] }]);
    const { resolveSectionIdentity } = await load();
    for (const old of ['背景', '学习背景']) {
      const res = resolveSectionIdentity('student', old);
      expect(res.ok && res.identity.sectionId, old).toBe('education');
      expect(res.ok && res.matchedBy, old).toBe('previous_name');
    }
  });

  it('当前名优先于别人的历史名', async () => {
    // 产品把 old_sec 改名成「新背景」，又把一个新分节起名叫「背景」。
    setCatalog([
      { id: 'old_sec', title: '新背景', previous_names: ['背景'], fields: [] },
      { id: 'new_sec', title: '背景', fields: [] },
    ]);
    const { resolveSectionIdentity } = await load();
    const res = resolveSectionIdentity('student', '背景');
    expect(res.ok && res.identity.sectionId).toBe('new_sec');
    expect(res.ok && res.matchedBy).toBe('current_name');
  });

  it('两个 identity 认领同一个历史名 → ambiguous，不猜', async () => {
    setCatalog([
      { id: 's1', title: '教育背景', previous_names: ['背景'], fields: [] },
      { id: 's2', title: '工作背景', previous_names: ['背景'], fields: [] },
    ]);
    const { resolveSectionIdentity } = await load();
    const res = resolveSectionIdentity('student', '背景');
    expect(res).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('catalog 里没人认领 → not_found', async () => {
    setCatalog([{ id: 'education', title: '教育背景', fields: [] }]);
    const { resolveSectionIdentity } = await load();
    expect(resolveSectionIdentity('student', '用户自建分节')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('未知模板 → unknown_template', async () => {
    const { resolveSectionIdentity } = await load();
    expect(resolveSectionIdentity('nope', '背景')).toMatchObject({ ok: false, reason: 'unknown_template' });
  });
});

describe('resolver › 字段', () => {
  it('分节与字段都用历史名时仍能一步解析', async () => {
    setCatalog([
      {
        id: 'education',
        title: '教育背景',
        previous_names: ['背景'],
        fields: [{ id: 'major', name: '专业与研究方向', previous_names: ['专业'] }],
      },
    ]);
    const { resolveFieldIdentity } = await load();
    const res = resolveFieldIdentity('student', '背景', '专业');
    expect(res).toEqual({
      ok: true,
      matchedBy: 'previous_name',
      identity: { sectionId: 'education', sectionTitle: '教育背景', fieldId: 'major', name: '专业与研究方向' },
    });
  });

  it('字段解析被限定在其所属分节内', async () => {
    setCatalog([
      { id: 's1', title: 'A', fields: [{ id: 'f1', name: '技术专长' }] },
      { id: 's2', title: 'B', fields: [{ id: 'f2', name: '技术专长' }] },
    ]);
    const { resolveFieldIdentity } = await load();
    expect((await load()).resolveFieldIdentity('student', 'A', '技术专长')).toMatchObject({
      ok: true,
      identity: { fieldId: 'f1' },
    });
    expect(resolveFieldIdentity('student', 'B', '技术专长')).toMatchObject({ ok: true, identity: { fieldId: 'f2' } });
  });

  it('分节解析不出时字段解析直接继承失败原因', async () => {
    setCatalog([{ id: 'education', title: '教育背景', fields: [{ id: 'major', name: '专业' }] }]);
    const { resolveFieldIdentity } = await load();
    expect(resolveFieldIdentity('student', '不存在的分节', '专业')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('字段名歧义 → ambiguous', async () => {
    setCatalog([
      {
        id: 'education',
        title: '教育背景',
        fields: [
          { id: 'major', name: '专业与方向', previous_names: ['方向'] },
          { id: 'direction', name: '研究方向', previous_names: ['方向'] },
        ],
      },
    ]);
    const { resolveFieldIdentity } = await load();
    expect(resolveFieldIdentity('student', '教育背景', '方向')).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
});

describe('resolver › 全模板查找（只用于区分 move 与 retire）', () => {
  it('字段被移到别的分节时能在别处找到', async () => {
    setCatalog([
      { id: 's1', title: 'A', fields: [] },
      { id: 's2', title: 'B', fields: [{ id: 'major', name: '专业' }] },
    ]);
    const { findFieldIdentityAnywhere, resolveFieldIdentity } = await load();
    // 按原分节找不到（这才是「移动」）
    expect(resolveFieldIdentity('student', 'A', '专业')).toMatchObject({ ok: false, reason: 'not_found' });
    // 全模板能找到，且落在新分节上
    expect(findFieldIdentityAnywhere('student', '专业')).toMatchObject({
      ok: true,
      identity: { sectionId: 's2', fieldId: 'major' },
    });
  });

  it('彻底下架的字段在全模板里也找不到', async () => {
    setCatalog([{ id: 's1', title: 'A', fields: [{ id: 'other', name: '别的' }] }]);
    const { findFieldIdentityAnywhere } = await load();
    expect(findFieldIdentityAnywhere('student', '年级')).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('compareTemplateVersion', () => {
  it('按 major/minor/patch 比较', async () => {
    const { compareTemplateVersion } = await load();
    expect(compareTemplateVersion('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareTemplateVersion('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareTemplateVersion('1.0.0', '1.0.0')).toBe(0);
  });

  it('预发布低于同版本正式版（跨客户端同步回来的正式版不能被判成更旧）', async () => {
    const { compareTemplateVersion } = await load();
    expect(compareTemplateVersion('0.2.0-review.1', '0.2.0')).toBeLessThan(0);
    expect(compareTemplateVersion('0.2.0', '0.2.0-review.1')).toBeGreaterThan(0);
    expect(compareTemplateVersion('0.2.0-review.1', '0.2.0-review.2')).toBeLessThan(0);
    expect(compareTemplateVersion('0.2.0-review.1', '0.2.0-review.1')).toBe(0);
  });
});
