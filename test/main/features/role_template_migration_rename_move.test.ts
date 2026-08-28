import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Phase 2：rename / move 的正式迁移语义。
 *
 * 三件事必须同时成立，缺一条这个功能就不该开：
 *  1. identity 由 field_id / section_id 认定，不靠名字猜；
 *  2. 值连同 source / project 标记原样跟着 identity 走，一条不丢不改；
 *  3. 迁移完之后新名字立刻可读、可签 fieldRef、可写，旧名字不再是可写落点。
 */

let CATALOG: any[] = [];

vi.mock('../../../src/main/features/role_templates', () => ({
  listRoleTemplates: () => JSON.parse(JSON.stringify(CATALOG)),
  getRoleTemplate: (id: string) => {
    const found = CATALOG.find((t) => t.template_id === id);
    return found ? JSON.parse(JSON.stringify(found)) : undefined;
  },
  listScenarios: () => [],
  getScenario: () => undefined,
}));
vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-rename-move';

/** v1：学习背景[专业, 年级] + 基本信息[研究方向]。 */
function catalogV1() {
  return [{
    template_id: 'probe',
    name: '探针角色',
    description: '',
    version: '1.0.0',
    preset_groups: [
      {
        id: 'background',
        title: '学习背景',
        fields: [{ id: 'major', name: '专业' }, { id: 'grade', name: '年级' }],
      },
      { id: 'basic', title: '基本信息', fields: [{ id: 'research_direction', name: '研究方向' }] },
    ],
    bundle: { skill_ids: [], agent_ids: [] },
  }];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-rename-move-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  CATALOG = catalogV1();
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const loadFiles = () => import('../../../src/main/features/personal_ontology_template_files');
const loadMig = () => import('../../../src/main/features/personal_ontology_migration');
const loadContract = () => import('../../../src/main/features/personal_ontology_contract');

function fileVersion(text: string): string | undefined {
  return /^>\s*模板:\s*probe@([^\s|]+)/m.exec(text)?.[1];
}

/** 装 v1 并填数据：专业 两条值（含 project 标记）、年级 一条、研究方向 一条、流水一条、自建字段一个。 */
async function installWithData() {
  const t = await loadFiles();
  expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
  const groupId = t.readGroups(UID).find((g) => g.template_id === 'probe')!.group_id;
  const bg = t.buildContentRef(groupId, '学习背景');
  const basic = t.buildContentRef(groupId, '基本信息');

  expect((await t.appendExistingTemplateFieldValueToRef(UID, bg, '专业', '软件工程', '手动')).ok).toBe(true);
  expect((await t.appendExistingTemplateFieldValueToRef(UID, bg, '专业', '认知科学', '智能', '毕设')).ok).toBe(true);
  expect((await t.appendExistingTemplateFieldValueToRef(UID, bg, '年级', '大三', '手动')).ok).toBe(true);
  expect((await t.appendExistingTemplateFieldValueToRef(UID, basic, '研究方向', '知识图谱', '手动')).ok).toBe(true);
  expect((await t.appendFlowEntryToRef(UID, bg, '一条流水')).ok).toBe(true);
  expect((await t.appendFlowEntryToRef(UID, bg, '我的私货')).ok).toBe(true);
  expect((await t.promoteEntryToRef(UID, bg, '我的私货', '私有备注')).ok).toBe(true);
  return { t, groupId, bg, basic };
}

/** 读某个分节某个字段的值（含 source/project），便于逐条比对。 */
function fieldValues(t: any, section: string, name: string) {
  const parsed = t.parseTemplateContent(t.readTemplateFileText(UID, 'probe'));
  const sec = parsed.sections.find((s: any) => s.title === section);
  return sec?.fields[name];
}

describe('field rename', () => {
  it('旧值连同 source / project 完整迁到新名字，且不产生重复字段', async () => {
    const { t } = await installWithData();
    const before = fieldValues(t, '学习背景', '专业');

    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].fields[0] = {
      id: 'major', name: '专业与研究方向', previous_names: ['专业'],
    };

    const { applyRoleTemplateMigration } = await loadMig();
    const res = await applyRoleTemplateMigration(UID, 'probe');
    expect(res).toMatchObject({ ok: true, outcome: 'migrated', renamedFields: 1 });

    const after = fieldValues(t, '学习背景', '专业与研究方向');
    expect(after).toEqual(before);
    expect(after.map((v: any) => v.value)).toEqual(['软件工程', '认知科学']);
    expect(after[1]).toMatchObject({ source: '智能', project: '毕设' });

    // 旧名字彻底消失，没有留下一个同内容的副本
    expect(fieldValues(t, '学习背景', '专业')).toBeUndefined();
    const text = t.readTemplateFileText(UID, 'probe');
    expect(text.match(/^### 专业与研究方向$/gm)!.length).toBe(1);
    expect(text).not.toMatch(/^### 专业$/m);
  });

  it('改名后的字段不会被误判成 custom', async () => {
    await installWithData();
    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].fields[0] = {
      id: 'major', name: '专业与研究方向', previous_names: ['专业'],
    };
    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    const contract = await loadContract();
    expect(contract.roleTemplateFieldStatus('probe', '学习背景', '专业与研究方向')).toBe('active');
  });

  it('新名字可签 fieldRef 且可写；旧名字不再是可写落点', async () => {
    await installWithData();
    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].fields[0] = {
      id: 'major', name: '专业与研究方向', previous_names: ['专业'],
    };
    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    const contract = await loadContract();
    const ref = await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '专业与研究方向');
    expect(ref).toBeTruthy();
    expect(await contract.appendRoleTemplateFieldValue(UID, ref!, '人机交互', '智能')).toMatchObject({ ok: true });

    expect(await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '专业')).toBeNull();
    const labels = (await contract.listRoleTemplateFieldTargets(UID)).map((x) => x.label);
    expect(labels).toContain('探针角色 · 学习背景 · 专业与研究方向');
    expect(labels).not.toContain('探针角色 · 学习背景 · 专业');
  });

  it('跨多个历史名单跳成功（v1 名字直达 v3 identity）', async () => {
    await installWithData();
    CATALOG = catalogV1();
    CATALOG[0].version = '3.0.0';
    CATALOG[0].preset_groups[0].fields[0] = {
      id: 'major', name: '专业方向与研究领域', previous_names: ['专业', '专业与研究方向'],
    };
    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    const t = await loadFiles();
    expect(fieldValues(t, '学习背景', '专业方向与研究领域').map((v: any) => v.value))
      .toEqual(['软件工程', '认知科学']);
  });

  it('多个 identity 认领同一个 previous_name → 拆分，拒绝且不猜', async () => {
    const { t } = await installWithData();
    const before = t.readTemplateFileText(UID, 'probe');

    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].fields = [
      { id: 'major', name: '专业甲', previous_names: ['专业'] },
      { id: 'major2', name: '专业乙', previous_names: ['专业'] },
      { id: 'grade', name: '年级' },
    ];

    const { applyRoleTemplateMigration } = await loadMig();
    const res = await applyRoleTemplateMigration(UID, 'probe');
    expect(res).toMatchObject({ ok: false, outcome: 'refused' });
    expect(res.refusal!.unsupportedChanges.map((c) => c.kind)).toContain('split_field');
    expect(t.readTemplateFileText(UID, 'probe')).toBe(before);
  });
});

describe('section rename', () => {
  it('只改分节标题，节内字段 / 值 / 流水一个不丢', async () => {
    const { t } = await installWithData();
    const beforeParsed = t.parseTemplateContent(t.readTemplateFileText(UID, 'probe'));
    const beforeSec = beforeParsed.sections.find((s: any) => s.title === '学习背景')!;

    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].title = '教育与研究';
    CATALOG[0].preset_groups[0].previous_names = ['学习背景'];

    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe'))).toMatchObject({
      ok: true, outcome: 'migrated', renamedSections: 1,
    });

    const afterParsed = t.parseTemplateContent(t.readTemplateFileText(UID, 'probe'));
    const afterSec = afterParsed.sections.find((s: any) => s.title === '教育与研究')!;
    expect(afterSec).toBeTruthy();
    expect(afterParsed.sections.some((s: any) => s.title === '学习背景')).toBe(false);

    expect(Object.keys(afterSec.fields)).toEqual(Object.keys(beforeSec.fields));
    expect(afterSec.fields).toEqual(beforeSec.fields);
    expect(afterSec.flowEntries).toEqual(beforeSec.flowEntries);
  });

  it('分节改名后 writable targets 不为空（Phase 1 的整表变哑不再发生）', async () => {
    await installWithData();
    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].title = '教育与研究';
    CATALOG[0].preset_groups[0].previous_names = ['学习背景'];

    const contract = await loadContract();
    // 迁移前：catalog 用新名、文件用旧名，两边对不上 → 落点为空，这正是要修的状态
    const beforeTargets = await contract.listRoleTemplateFieldTargets(UID);
    expect(beforeTargets.filter((x) => x.label.includes('教育与研究'))).toEqual([]);

    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    const afterTargets = await contract.listRoleTemplateFieldTargets(UID);
    expect(afterTargets.length).toBeGreaterThan(0);
    expect(afterTargets.map((x) => x.label)).toContain('探针角色 · 教育与研究 · 专业');
    // 列出来的每一个都真写得进去
    for (const target of afterTargets) {
      expect(await contract.appendRoleTemplateFieldValue(UID, target.fieldRef, `值-${target.label}`, '智能'))
        .toMatchObject({ ok: true });
    }
  });

  it('分节顺序按 catalog 当前顺序 reconcile', async () => {
    await installWithData();
    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    // catalog 把两节顺序调换
    CATALOG[0].preset_groups = [CATALOG[0].preset_groups[1], CATALOG[0].preset_groups[0]];

    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    const t = await loadFiles();
    const titles = t.parseTemplateContent(t.readTemplateFileText(UID, 'probe')).sections.map((s: any) => s.title);
    expect(titles).toEqual(['基本信息', '学习背景']);
  });
});

describe('field move', () => {
  it('字段整体搬到目标分节，值完整、原位置不再有它、目标不重复', async () => {
    const { t } = await installWithData();
    const before = fieldValues(t, '基本信息', '研究方向');

    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    // research_direction 从「基本信息」搬到「学习背景」
    CATALOG[0].preset_groups[0].fields.push({ id: 'research_direction', name: '研究方向' });
    CATALOG[0].preset_groups[1].fields = [];

    const { applyRoleTemplateMigration } = await loadMig();
    expect(await applyRoleTemplateMigration(UID, 'probe')).toMatchObject({
      ok: true, outcome: 'migrated', movedFields: 1, addedFields: 0,
    });

    expect(fieldValues(t, '学习背景', '研究方向')).toEqual(before);
    expect(fieldValues(t, '基本信息', '研究方向')).toBeUndefined();
    const text = t.readTemplateFileText(UID, 'probe');
    expect(text.match(/^### 研究方向$/gm)!.length).toBe(1);
  });

  it('move 靠 field_id 认定，不靠名字：目标分节同时改了名也认得出', async () => {
    const { t } = await installWithData();
    const before = fieldValues(t, '基本信息', '研究方向');

    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].title = '学术背景';
    CATALOG[0].preset_groups[0].previous_names = ['学习背景'];
    CATALOG[0].preset_groups[0].fields.push({ id: 'research_direction', name: '研究方向' });
    CATALOG[0].preset_groups[1].fields = [];

    const { applyRoleTemplateMigration } = await loadMig();
    expect(await applyRoleTemplateMigration(UID, 'probe')).toMatchObject({ ok: true, outcome: 'migrated' });
    expect(fieldValues(t, '学术背景', '研究方向')).toEqual(before);
  });

  it('move + rename 在一个 plan 内完成，不拒绝', async () => {
    const { t } = await installWithData();
    const before = fieldValues(t, '学习背景', '专业');

    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    // 学习背景 → 教育与研究；专业 → 专业与研究方向，并搬到「基本信息」
    CATALOG[0].preset_groups[0].title = '教育与研究';
    CATALOG[0].preset_groups[0].previous_names = ['学习背景'];
    CATALOG[0].preset_groups[0].fields = [{ id: 'grade', name: '年级' }];
    CATALOG[0].preset_groups[1].fields = [
      { id: 'research_direction', name: '研究方向' },
      { id: 'major', name: '专业与研究方向', previous_names: ['专业'] },
    ];

    const { applyRoleTemplateMigration } = await loadMig();
    const res = await applyRoleTemplateMigration(UID, 'probe');
    expect(res).toMatchObject({
      ok: true, outcome: 'migrated', renamedSections: 1, renamedFields: 1, movedFields: 1,
    });

    expect(fieldValues(t, '基本信息', '专业与研究方向')).toEqual(before);
    expect(fieldValues(t, '教育与研究', '年级').map((v: any) => v.value)).toEqual(['大三']);
    expect(fieldValues(t, '教育与研究', '专业')).toBeUndefined();
    expect(fileVersion(t.readTemplateFileText(UID, 'probe'))).toBe('2.0.0');
  });

  it('搬到靠前分节时不会既搬走又留下一份', async () => {
    const { t } = await installWithData();
    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    // grade 从第 0 节搬到第 1 节，major 从第 0 节保留 —— 顺序上先处理来源节
    CATALOG[0].preset_groups[0].fields = [{ id: 'major', name: '专业' }];
    CATALOG[0].preset_groups[1].fields.push({ id: 'grade', name: '年级' });

    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    const text = t.readTemplateFileText(UID, 'probe');
    expect(text.match(/^### 年级$/gm)!.length).toBe(1);
    expect(fieldValues(t, '基本信息', '年级').map((v: any) => v.value)).toEqual(['大三']);
    expect(fieldValues(t, '学习背景', '年级')).toBeUndefined();
  });
});

describe('rename / move 的原子性与幂等', () => {
  it('迁移是幂等的：第二次为 noop', async () => {
    await installWithData();
    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].title = '教育与研究';
    CATALOG[0].preset_groups[0].previous_names = ['学习背景'];
    CATALOG[0].preset_groups[0].fields[0] = { id: 'major', name: '专业与研究方向', previous_names: ['专业'] };

    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).outcome).toBe('migrated');
    expect((await applyRoleTemplateMigration(UID, 'probe')).outcome).toBe('noop');
  });

  it('用户自建字段与流水在 rename + move 之后仍在原分节', async () => {
    const { t } = await installWithData();
    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].title = '教育与研究';
    CATALOG[0].preset_groups[0].previous_names = ['学习背景'];

    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    const parsed = t.parseTemplateContent(t.readTemplateFileText(UID, 'probe'));
    const sec = parsed.sections.find((s: any) => s.title === '教育与研究')!;
    expect(sec.fields['私有备注'].map((v: any) => v.value)).toEqual(['我的私货']);
    expect(sec.flowEntries).toEqual(['一条流水']);
  });

  it('validation 失败时不写盘（catalog 版本非法 semver）', async () => {
    const { t } = await installWithData();
    const before = t.readTemplateFileText(UID, 'probe');

    CATALOG = catalogV1();
    CATALOG[0].version = '2.0'; // 不是合法 semver，写进台账会让模板行整行失效
    CATALOG[0].preset_groups[0].fields[0] = { id: 'major', name: '专业与研究方向', previous_names: ['专业'] };

    const { applyRoleTemplateMigration } = await loadMig();
    const res = await applyRoleTemplateMigration(UID, 'probe');
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe('failed');
    expect(t.readTemplateFileText(UID, 'probe')).toBe(before);
  });
});
