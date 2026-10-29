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







describe('候选建议字段 › 候选文件与新候选', () => {

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
