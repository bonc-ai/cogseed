import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Detection + Plan：比对实例文件结构与 catalog schema，输出结构化结果。
 *
 * 本轮的核心安全性质：**识别到 rename / move 时必须拒绝自动执行**。
 * 把改名当成「删一个 + 加一个」会让用户已经填好的值留在一个失去 T-box 身份的
 * 坑里，同时新坑是空的——数据没丢，但画像整段变哑，而且事后无从分辨。
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

function setCatalog(version: string, groups: any[]) {
  CATALOG.push({ template_id: 'student', name: '学生', description: '', version, preset_groups: groups });
}

/** 实例结构投影：`{ 分节名: [字段名 或 [字段名, 值条数]] }`。 */
function installed(version: string, shape: Record<string, Array<string | [string, number]>>) {
  return {
    version,
    sections: Object.entries(shape).map(([title, fields]) => ({
      title,
      fields: fields.map((f) => (Array.isArray(f) ? { name: f[0], valueCount: f[1] } : { name: f, valueCount: 0 })),
    })),
  };
}

const V1_CATALOG = [
  { id: 'background', title: '学习背景', fields: [{ id: 'major', name: '专业' }] },
];

describe('detection › 纯新增', () => {
  it('catalog 新增字段被识别为 additive migration', async () => {
    setCatalog('2.0.0', [
      {
        id: 'background',
        title: '学习背景',
        fields: [
          { id: 'major', name: '专业' },
          { id: 'direction', name: '当前研究方向' },
        ],
      },
    ]);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', { 学习背景: [['专业', 1]] }));

    expect(det.needsMigration).toBe(true);
    expect(det.fromVersion).toBe('1.0.0');
    expect(det.toVersion).toBe('2.0.0');
    expect(det.additions.fields).toEqual([
      { sectionId: 'background', sectionTitle: '学习背景', fieldId: 'direction', name: '当前研究方向' },
    ]);
    expect(det.additions.sections).toEqual([]);
    expect(det.conflicts).toEqual([]);

    const plan = planRoleTemplateMigration(det);
    expect(plan.canAutoApply).toBe(true);
    expect(plan.unsupportedChanges).toEqual([]);
    expect(plan.versionOnly).toBe(false);
  });

  it('catalog 新增整个分节被识别，且带回插入位置', async () => {
    setCatalog('2.0.0', [
      { id: 'background', title: '学习背景', fields: [{ id: 'major', name: '专业' }] },
      { id: 'pace', title: '目标与节奏', fields: [{ id: 'goal', name: '学习目标' }] },
    ]);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', { 学习背景: ['专业'] }));

    expect(det.additions.sections).toEqual([
      { sectionId: 'pace', title: '目标与节奏', catalogIndex: 1, fields: [{ fieldId: 'goal', name: '学习目标' }] },
    ]);
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(true);
  });

  it('执行骨架按 catalog 顺序排列字段，新坑落在正确位置', async () => {
    setCatalog('2.0.0', [
      {
        id: 'background',
        title: '学习背景',
        fields: [
          { id: 'stage', name: '教育阶段' },
          { id: 'major', name: '专业' },
          { id: 'direction', name: '研究方向' },
        ],
      },
    ]);
    const { detectRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', { 学习背景: ['专业'] }));

    // 顺序由 target 骨架给定（catalog 顺序），apply 直接照着建，不用再算插入点
    expect(det.target).toEqual([{
      sectionId: 'background',
      title: '学习背景',
      fromTitle: '学习背景',
      fields: [
        { fieldId: 'stage', name: '教育阶段' },
        { fieldId: 'major', name: '专业', from: { sectionTitle: '学习背景', name: '专业' } },
        { fieldId: 'direction', name: '研究方向' },
      ],
    }]);
  });
});

describe('detection › noop 与版本自愈', () => {
  it('schema 与版本都一致 → 不需要迁移', async () => {
    setCatalog('1.0.0', V1_CATALOG);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', { 学习背景: ['专业'] }));
    expect(det.needsMigration).toBe(false);
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(false);
  });

  it('结构一致但版本落后 → versionOnly（崩溃自愈 / 纯文案变更）', async () => {
    setCatalog('2.0.0', V1_CATALOG);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', { 学习背景: ['专业'] }));
    const plan = planRoleTemplateMigration(det);
    expect(plan.canAutoApply).toBe(true);
    expect(plan.versionOnly).toBe(true);
    expect(plan.additions).toEqual({ sections: [], fields: [] });
  });

  it('用户自建字段不阻断新增迁移（只要该分节没有缺失的坑）', async () => {
    setCatalog('2.0.0', [
      { id: 'background', title: '学习背景', fields: [{ id: 'major', name: '专业' }] },
      { id: 'pace', title: '目标与节奏', fields: [{ id: 'goal', name: '学习目标' }] },
    ]);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', {
      学习背景: ['专业', ['我自己加的字段', 3]],
    }));
    expect(det.unknownInFile.fields).toEqual([
      { sectionTitle: '学习背景', name: '我自己加的字段', valueCount: 3 },
    ]);
    expect(det.conflicts).toEqual([]);
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(true);
  });
});

describe('detection › rename / move 被认出来并可自动执行（Phase 2）', () => {
  it('已声明的字段改名 → rename_field，且不被当成 delete + add', async () => {
    setCatalog('2.0.0', [
      {
        id: 'background',
        title: '学习背景',
        fields: [{ id: 'major', name: '专业与研究方向', previous_names: ['专业'] }],
      },
    ]);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', { 学习背景: [['专业', 2]] }));

    expect(det.renamedFields).toEqual([
      { sectionId: 'background', sectionTitle: '学习背景', fieldId: 'major', from: '专业', to: '专业与研究方向' },
    ]);
    // 关键：没有被当成「删『专业』+ 加『专业与研究方向』」
    expect(det.additions.fields).toEqual([]);

    const plan = planRoleTemplateMigration(det);
    expect(plan.canAutoApply).toBe(true);
    expect(plan.unsupportedChanges).toEqual([]);
    // 骨架把旧名指向新名，值由 apply 整块搬过去
    expect(plan.target[0].fields[0]).toEqual({
      fieldId: 'major', name: '专业与研究方向', from: { sectionTitle: '学习背景', name: '专业' },
    });
  });

  it('已声明的分节改名 → rename_section，整节不被当成 delete + add', async () => {
    setCatalog('2.0.0', [
      { id: 'background', title: '教育背景', previous_names: ['学习背景'], fields: [{ id: 'major', name: '专业' }] },
    ]);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', { 学习背景: ['专业'] }));

    expect(det.renamedSections).toEqual([{ sectionId: 'background', from: '学习背景', to: '教育背景' }]);
    expect(det.additions.sections).toEqual([]);
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(true);
    expect(det.target[0]).toMatchObject({ title: '教育背景', fromTitle: '学习背景' });
  });

  it('字段被移到别的分节 → move_field，不当成 delete + add', async () => {
    setCatalog('2.0.0', [
      { id: 'background', title: '学习背景', fields: [] },
      { id: 'pace', title: '目标与节奏', fields: [{ id: 'major', name: '专业' }] },
    ]);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', {
      学习背景: [['专业', 1]],
      目标与节奏: [],
    }));

    expect(det.movedFields).toEqual([{
      fieldId: 'major',
      name: '专业',
      fromSectionId: 'background',
      fromSectionTitle: '学习背景',
      toSectionId: 'pace',
      toSectionTitle: '目标与节奏',
    }]);
    expect(det.unknownInFile.fields).toEqual([]);
    // 关键：移动过去的字段不能同时又被记成目标分节的「新增空坑」
    expect(det.additions.fields).toEqual([]);
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(true);
  });

  it('字段层的疑似未声明改名只报告、不阻断（与用户自建字段无法区分）', async () => {
    setCatalog('2.0.0', [
      { id: 'background', title: '学习背景', fields: [{ id: 'major', name: '专业与方向' }] },
    ]);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    // 作者把「专业」改成「专业与方向」却忘了声明 previous_names。
    // 这在数据上与「用户自建了『专业』+ catalog 新增『专业与方向』」完全同形，
    // 而后者是常态 —— 拿它去拦住已判定安全的补坑，代价是所有用过升格建坑的
    // 用户永远收不到新字段。补空坑不动旧值，所以按报告处理。
    const det = detectRoleTemplateMigration('student', installed('1.0.0', { 学习背景: [['专业', 1]] }));

    expect(det.suspectedFieldRenames).toEqual([
      { sectionTitle: '学习背景', unknown: ['专业'], missing: ['专业与方向'] },
    ]);
    expect(det.conflicts).toEqual([]);
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(true);
    // 旧字段不在 additions 里，也不会被删——它只是留在文件里变成 custom
    expect(det.additions.fields.map((f) => f.name)).toEqual(['专业与方向']);
    expect(det.unknownInFile.fields).toEqual([
      { sectionTitle: '学习背景', name: '专业', valueCount: 1 },
    ]);
  });

  it('用户自建字段 + catalog 新增字段（同一分节）仍然照常补坑', async () => {
    setCatalog('2.0.0', [
      {
        id: 'background',
        title: '学习背景',
        fields: [
          { id: 'major', name: '专业' },
          { id: 'direction', name: '当前研究方向' },
        ],
      },
    ]);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', {
      学习背景: [['专业', 1], ['我的自建字段', 2]],
    }));
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(true);
    expect(det.additions.fields.map((f) => f.name)).toEqual(['当前研究方向']);
  });

  it('分节层的疑似未声明改名仍然阻断（用户造不出模板分节）', async () => {
    setCatalog('2.0.0', [
      { id: 'background', title: '教育背景', fields: [{ id: 'major', name: '专业' }] },
    ]);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', { 学习背景: ['专业'] }));
    expect(det.conflicts.map((c) => c.kind)).toContain('possible_undeclared_rename');
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(false);
  });

});

describe('detection › 阻断条件', () => {
  it('未知模板 → unknown_template，不迁移', async () => {
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('nope', installed('1.0.0', { A: ['x'] }));
    expect(det.conflicts.map((c) => c.kind)).toEqual(['unknown_template']);
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(false);
  });

  it('文件解析不出版本/分节 → file_unparsable', async () => {
    setCatalog('2.0.0', V1_CATALOG);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    for (const bad of [{ version: '', sections: [] }, { version: '1.0.0', sections: [] }]) {
      const det = detectRoleTemplateMigration('student', bad as any);
      expect(det.conflicts.map((c) => c.kind)).toContain('file_unparsable');
      expect(planRoleTemplateMigration(det).canAutoApply).toBe(false);
    }
  });

  it('文件版本高于 catalog → version_ahead，不降级', async () => {
    setCatalog('1.0.0', V1_CATALOG);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('3.0.0', { 学习背景: ['专业'] }));
    expect(det.conflicts.map((c) => c.kind)).toEqual(['version_ahead']);
    expect(det.additions).toEqual({ sections: [], fields: [] });
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(false);
  });

  it('catalog 缺 id / id 非法 → malformed_catalog_identity，直接拒绝', async () => {
    // 一批 undefined id 会把所有坑折叠成同一个 identity：于是「每个坑都已匹配」，
    // 检测不出任何缺失，migration 静默什么都不做 —— 必须在这里就断掉。
    setCatalog('2.0.0', [
      { title: '学习背景', fields: [{ name: '专业' }, { name: '当前研究方向' }] } as any,
    ]);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', { 学习背景: ['专业'] }));
    expect(det.conflicts.map((c) => c.kind)).toEqual(['malformed_catalog_identity']);
    expect(det.additions).toEqual({ sections: [], fields: [] });
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(false);
  });

  it('一个旧分节名被多个 catalog 分节认领 = 拆分 → split_section，拒绝', async () => {
    setCatalog('2.0.0', [
      { id: 's1', title: '教育背景', previous_names: ['背景'], fields: [{ id: 'f1', name: 'x' }] },
      { id: 's2', title: '工作背景', previous_names: ['背景'], fields: [{ id: 'f2', name: 'y' }] },
    ]);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('1.0.0', { 背景: ['x'] }));
    expect(det.unsupportedChanges.map((c) => c.kind)).toContain('split_section');
    expect(planRoleTemplateMigration(det).canAutoApply).toBe(false);
  });

  it('台账版本与文件版本分叉 → 文件为权威，且这本身就需要一次自愈', async () => {
    setCatalog('2.0.0', V1_CATALOG);
    const { detectRoleTemplateMigration, planRoleTemplateMigration } = await load();
    const det = detectRoleTemplateMigration('student', installed('2.0.0', { 学习背景: ['专业'] }), '1.0.0');
    expect(det.fromVersion).toBe('2.0.0'); // 文件是权威
    expect(det.ledgerVersion).toBe('1.0.0');
    // 结构与版本都已到位，只有台账缓存落后：不做成 needsMigration 的话，
    // 「文件已写、台账未更新」的崩溃窗口永远修不回来。
    expect(det.needsMigration).toBe(true);
    const plan = planRoleTemplateMigration(det);
    expect(plan.versionOnly).toBe(true);
    expect(plan.canAutoApply).toBe(true);
  });
});
