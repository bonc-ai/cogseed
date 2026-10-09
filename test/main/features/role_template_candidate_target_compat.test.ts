import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 候选「建议字段」在 schema 迁移之后的消费兼容。
 *
 * `- 建议字段:` 是一个**长期躺在 candidates.md 里的裸字段名**（候选生成那一刻的
 * schema）。候选没确认、角色模板先做了 rename / move 迁移时，旧名字必须仍能映射到
 * 同一个 stable identity，否则预选无声失效、值退回流水区。
 *
 * 两条口径上的边界，测试里都钉死：
 *  1. **不改候选文件**——换算只发生在消费侧，candidates.md 一个字节都不重写；
 *  2. **跨分节只对签发时校验过的搭配开放**——候选的建议字段是个没跟分节一起校验过
 *     的裸名字，用户显式选了分节时不许把落点偷偷挪到别的分节去（与 tf ref 不同，
 *     那种 ref 由 buildRoleTemplateFieldRef 签发，搭配一定成立过）。
 *
 * 已知的上游现状（本轮不改）：candidate.target_field 目前没有被桥接进
 * ConfirmDestinations.targetField，所以这里跟生产调用方一样，在确认时把那个名字
 * 显式传进去 —— 断言的是消费侧的换算，不假装桥已经接上。
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
const UID = 'test-user-cand-target';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cand-target-'));
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
const loadCand = () => import('../../../src/main/features/personal_ontology_candidates');

function candidatesMdPath(): string {
  return path.join(tmpDir, UID, 'local', 'ontology_candidates', 'candidates.md');
}

/** 在候选池里落一条带「建议字段」的候选（就是技能产出的那种形状）。 */
async function seedCandidate(id: string, targetField: string, text = '这条候选的值') {
  const poc = await loadCand();
  const file = candidatesMdPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, poc.serializeCandidatesMarkdown([{
    candidate_id: id,
    kind: 'preference',
    confidence: 'high',
    summary: '摘要',
    memory_scope: 'user',
    memory_text: text,
    target_field: targetField,
    source_memory_refs: [],
  }]));
  return poc;
}

async function installProbe(): Promise<string> {
  const t = await loadFiles();
  expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
  return t.readGroups(UID).find((g) => g.template_id === 'probe')!.group_id;
}

async function migrate() {
  const { applyRoleTemplateMigration } = await loadMig();
  expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);
}

/** 文件里某分节下某字段的值行。 */
async function valuesOf(section: string, fieldName: string): Promise<string[]> {
  const t = await loadFiles();
  const content = t.parseTemplateContent(t.readTemplateFileText(UID, 'probe')!);
  const sec = content.sections.find((s: any) => s.title === section);
  if (!sec) return [];
  const raw = (sec.fields as any)[fieldName];
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((v: any) => (typeof v === 'string' ? v : v.value));
}

// ── schema v2 变体 ─────────────────────────────────────────────────────────
function v2FieldRename() {
  CATALOG = catalogV1();
  CATALOG[0].version = '2.0.0';
  CATALOG[0].preset_groups[0].fields[0] = { id: 'major', name: '专业与研究方向', previous_names: ['专业'] };
}
function v2SectionRename() {
  CATALOG = catalogV1();
  CATALOG[0].version = '2.0.0';
  CATALOG[0].preset_groups[0].title = '教育与研究';
  CATALOG[0].preset_groups[0].previous_names = ['学习背景'];
}
function v2FieldMove() {
  CATALOG = catalogV1();
  CATALOG[0].version = '2.0.0';
  CATALOG[0].preset_groups[0].fields = [{ id: 'grade', name: '年级' }];
  CATALOG[0].preset_groups[1].fields.push({ id: 'major', name: '专业' });
}
function v2RenameAndMove() {
  CATALOG = catalogV1();
  CATALOG[0].version = '2.0.0';
  CATALOG[0].preset_groups[0].fields = [{ id: 'grade', name: '年级' }];
  CATALOG[0].preset_groups[1].fields.push({ id: 'major', name: '专业与研究方向', previous_names: ['专业'] });
}
function v2Retire() {
  CATALOG = catalogV1();
  CATALOG[0].version = '2.0.0';
  CATALOG[0].preset_groups[0].fields = [{ id: 'major', name: '专业' }];
  CATALOG[0].preset_groups[0].retired_fields = [
    { id: 'grade', previous_names: ['年级'], retired_in: '2.0.0' },
  ];
}
function v2Ambiguous() {
  CATALOG = catalogV1();
  CATALOG[0].version = '2.0.0';
  CATALOG[0].preset_groups[0].fields = [
    { id: 'major_a', name: '主修', previous_names: ['专业'] },
    { id: 'major_b', name: '辅修', previous_names: ['专业'] },
  ];
}

describe('候选建议字段 › 跨时序：v1 建候选 → 迁移 → 确认', () => {
  it('v1 存下的建议字段，迁移到 v2 之后仍落到 v2 的当前字段', async () => {
    // 1) v1 下装模板、生成候选，建议字段是 v1 那一刻的名字
    const groupId = await installProbe();
    await seedCandidate('cand-cross', '专业');

    // 2) candidates.md 里存的确实是 v1 的名字
    const persisted = (await loadCand()).parseCandidatesMarkdown(
      fs.readFileSync(candidatesMdPath(), 'utf8'),
    );
    expect(persisted[0].target_field).toBe('专业');

    // 3) schema 升到 v2：分节改名 + 字段改名
    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].title = '教育与研究';
    CATALOG[0].preset_groups[0].previous_names = ['学习背景'];
    CATALOG[0].preset_groups[0].fields[0] = { id: 'major', name: '专业与研究方向', previous_names: ['专业'] };
    await migrate();
    expect((await loadFiles()).readTemplateFileText(UID, 'probe')).toContain('## 教育与研究');

    // 4) 现在才确认这条旧候选，落点交给模板整组
    const poc = await loadCand();
    const res = await poc.confirmCandidate(UID, 'cand-cross', {
      toGlobalMemory: false,
      toGroupIds: [groupId],
      targetField: persisted[0].target_field,
    });

    // 5) 值落在 v2 的当前分节 + 当前字段名上
    expect(res.ok).toBe(true);
    expect(res.fieldWrites).toEqual([{
      groupId,
      fieldName: '专业',
      ok: true,
      targetStatus: 'historical_name_resolved',
      resolvedFieldName: '专业与研究方向',
    }]);
    expect(await valuesOf('教育与研究', '专业与研究方向')).toContain('这条候选的值');
    // 没有回退流水区，也没有把旧名字重新建成一个坑
    expect(res.groups).toBeUndefined();
    expect((await loadFiles()).readTemplateFileText(UID, 'probe')).not.toContain('### 专业\n');
  });
});

describe('候选建议字段 › 各类 schema 变化', () => {
  it('当前名字：行为不变，走 current_name', async () => {
    const groupId = await installProbe();
    const poc = await seedCandidate('c1', '专业');
    const res = await poc.confirmCandidate(UID, 'c1', {
      toGlobalMemory: false, toGroupIds: [groupId], targetField: '专业',
    });
    expect(res.ok).toBe(true);
    expect(res.fieldWrites).toEqual([{ groupId, fieldName: '专业', ok: true, targetStatus: 'current_name' }]);
    expect(await valuesOf('学习背景', '专业')).toContain('这条候选的值');
  });

  it('字段改名：旧建议字段恢复到新字段名', async () => {
    const groupId = await installProbe();
    const poc = await seedCandidate('c2', '专业');
    v2FieldRename();
    await migrate();

    const res = await poc.confirmCandidate(UID, 'c2', {
      toGlobalMemory: false, toGroupIds: [groupId], targetField: '专业',
    });
    expect(res.fieldWrites?.[0]).toMatchObject({
      ok: true, targetStatus: 'historical_name_resolved', resolvedFieldName: '专业与研究方向',
    });
    expect(await valuesOf('学习背景', '专业与研究方向')).toContain('这条候选的值');
  });

  it('分节改名：旧建议字段恢复到新分节', async () => {
    const groupId = await installProbe();
    const poc = await seedCandidate('c3', '专业');
    v2SectionRename();
    await migrate();

    const res = await poc.confirmCandidate(UID, 'c3', {
      toGlobalMemory: false, toGroupIds: [groupId], targetField: '专业',
    });
    expect(res.fieldWrites?.[0]).toMatchObject({ ok: true, targetStatus: 'current_name' });
    expect(await valuesOf('教育与研究', '专业')).toContain('这条候选的值');
  });

  it('字段移到别的分节：靠 field identity 找到新分节', async () => {
    const groupId = await installProbe();
    const poc = await seedCandidate('c4', '专业');
    v2FieldMove();
    await migrate();

    const res = await poc.confirmCandidate(UID, 'c4', {
      toGlobalMemory: false, toGroupIds: [groupId], targetField: '专业',
    });
    expect(res.fieldWrites?.[0]).toMatchObject({ ok: true, targetStatus: 'current_name' });
    expect(await valuesOf('基本信息', '专业')).toContain('这条候选的值');
    expect(await valuesOf('学习背景', '专业')).toEqual([]);
  });

  it('改名 + 移动：仍恢复预选', async () => {
    const groupId = await installProbe();
    const poc = await seedCandidate('c5', '专业');
    v2RenameAndMove();
    await migrate();

    const res = await poc.confirmCandidate(UID, 'c5', {
      toGlobalMemory: false, toGroupIds: [groupId], targetField: '专业',
    });
    expect(res.fieldWrites?.[0]).toMatchObject({
      ok: true, targetStatus: 'historical_name_resolved', resolvedFieldName: '专业与研究方向',
    });
    expect(await valuesOf('基本信息', '专业与研究方向')).toContain('这条候选的值');
  });
});

describe('候选建议字段 › 恢复不了时说得清原因', () => {
  it('退役字段：不可写，报 retired_target 而不是笼统的没找到', async () => {
    const groupId = await installProbe();
    const poc = await seedCandidate('c6', '年级');
    v2Retire();
    await migrate();

    const res = await poc.confirmCandidate(UID, 'c6', {
      toGlobalMemory: false, toGroupIds: [groupId], targetField: '年级',
    });
    expect(res.fieldWrites).toEqual([{
      groupId, fieldName: '年级', ok: false, error: 'field not found', targetStatus: 'retired_target',
    }]);
    // 产品行为不变：回退首个分节流水区，值不丢
    expect(res.ok).toBe(true);
    expect(res.groups?.[0]).toMatchObject({ groupId, ok: true });
    // 退役字段没有被复活成可写落点
    expect(await valuesOf('学习背景', '年级')).toEqual([]);
  });

  it('歧义：多个 identity 认领同一个历史名 → 不猜，报 ambiguous_target', async () => {
    const groupId = await installProbe();
    const poc = await seedCandidate('c7', '专业');
    v2Ambiguous();

    const res = await poc.confirmCandidate(UID, 'c7', {
      toGlobalMemory: false, toGroupIds: [groupId], targetField: '专业',
    });
    expect(res.fieldWrites).toEqual([{
      groupId, fieldName: '专业', ok: false, error: 'field not found', targetStatus: 'ambiguous_target',
    }]);
    expect(await valuesOf('学习背景', '主修')).toEqual([]);
    expect(await valuesOf('学习背景', '辅修')).toEqual([]);
  });

  it('认不出的名字（用户自建字段）：报 missing_target，不得顺手建坑', async () => {
    const groupId = await installProbe();
    const poc = await seedCandidate('c8', '我的私有字段');

    const res = await poc.confirmCandidate(UID, 'c8', {
      toGlobalMemory: false, toGroupIds: [groupId], targetField: '我的私有字段',
    });
    expect(res.fieldWrites).toEqual([{
      groupId, fieldName: '我的私有字段', ok: false, error: 'field not found', targetStatus: 'missing_target',
    }]);
    expect(await valuesOf('学习背景', '我的私有字段')).toEqual([]);
  });

  it('用户显式选了分节时，不把落点偷偷挪到别的分节', async () => {
    const groupId = await installProbe();
    const t = await loadFiles();
    const sectionRef = t.buildContentRef(groupId, '学习背景');
    // 研究方向是模板里真实存在的字段，但它长在「基本信息」，不在用户选的分节里
    const poc = await seedCandidate('c9', '研究方向');

    const res = await poc.confirmCandidate(UID, 'c9', {
      toGlobalMemory: false, toGroupIds: [sectionRef], targetField: '研究方向',
    });
    expect(res.fieldWrites).toEqual([{
      groupId: sectionRef, fieldName: '研究方向', ok: false, error: 'field not found', targetStatus: 'missing_target',
    }]);
    expect(await valuesOf('基本信息', '研究方向')).toEqual([]);
  });
});

describe('候选建议字段 › 候选文件与新候选', () => {
  it('换算不重写 candidates.md：确认之前文件一个字节都不动', async () => {
    const groupId = await installProbe();
    await seedCandidate('c10', '专业');
    const before = fs.readFileSync(candidatesMdPath(), 'utf8');

    v2FieldRename();
    await migrate();

    // 迁移本身不碰候选池
    expect(fs.readFileSync(candidatesMdPath(), 'utf8')).toBe(before);
    expect(before).toContain('- 建议字段: 专业');

    // 读一遍候选也不重写
    const poc = await loadCand();
    await poc.listCandidates(UID);
    expect(fs.readFileSync(candidatesMdPath(), 'utf8')).toBe(before);

    // 确认之后这条候选才从池里消失（既有行为），且不留旧名字
    const res = await poc.confirmCandidate(UID, 'c10', {
      toGlobalMemory: false, toGroupIds: [groupId], targetField: '专业',
    });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(candidatesMdPath(), 'utf8')).not.toContain('- 建议字段: 专业');
  });

  it('新写入的候选存的是当前 schema 的名字，不复制历史名', async () => {
    await installProbe();
    v2FieldRename();
    await migrate();

    const poc = await loadCand();
    fs.mkdirSync(path.dirname(candidatesMdPath()), { recursive: true });
    fs.writeFileSync(candidatesMdPath(), poc.serializeCandidatesMarkdown([{
      candidate_id: 'c11',
      kind: 'preference',
      confidence: 'high',
      summary: '摘要',
      memory_scope: 'user',
      memory_text: '新候选',
      target_field: '专业与研究方向',
      source_memory_refs: [],
    }]));
    const text = fs.readFileSync(candidatesMdPath(), 'utf8');
    expect(text).toContain('- 建议字段: 专业与研究方向');
    expect(text).not.toContain('- 建议字段: 专业\n');
  });
});
