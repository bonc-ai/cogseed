import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 历史 opaque ref 的兼容。
 *
 * 聊天草稿里的 `ts` token 会长期存活，里面存的是当初那一刻的分节名。分节改名
 * 迁移之后文件里已经是新标题——旧 token 必须仍然解析得到同一段内容，而且
 * **渲染层不需要知道 previous_names**：它只把 opaque ref 原样传回来。
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
const UID = 'test-user-ref-compat';

function catalogV1() {
  return [{
    template_id: 'probe',
    name: '探针角色',
    description: '',
    version: '1.0.0',
    preset_groups: [{ id: 'background', title: '学习背景', fields: [{ id: 'major', name: '专业' }] }],
    bundle: { skill_ids: [], agent_ids: [] },
  }];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ref-compat-'));
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

async function installWithValue() {
  const t = await loadFiles();
  expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
  const groupId = t.readGroups(UID).find((g) => g.template_id === 'probe')!.group_id;
  const ref = t.buildContentRef(groupId, '学习背景');
  expect((await t.appendExistingTemplateFieldValueToRef(UID, ref, '专业', '软件工程', '手动')).ok).toBe(true);
  return { t, groupId };
}

/** 拿一个「当年」的 ts token（草稿里存的就是这种字符串）。 */
async function tokenForSection(): Promise<string> {
  const contract = await loadContract();
  const entries = await contract.listOntologyEntries(UID);
  const entry = entries.find((e) => e.label === '学习背景');
  expect(entry).toBeTruthy();
  return entry!.ref;
}

/** 把 catalog 升到把分节改名的 v2。 */
function renameSectionInCatalog() {
  CATALOG = catalogV1();
  CATALOG[0].version = '2.0.0';
  CATALOG[0].preset_groups[0].title = '教育与研究';
  CATALOG[0].preset_groups[0].previous_names = ['学习背景'];
}

describe('ts token 兼容 › 分节改名之后', () => {
  it('旧 token 仍能读到同一段内容（不需要批量重写草稿）', async () => {
    await installWithValue();
    const oldToken = await tokenForSection();

    const beforeRead = await (await loadContract()).readOntologyEntry(UID, oldToken);
    expect(beforeRead.ok).toBe(true);
    expect(beforeRead.content).toContain('软件工程');

    renameSectionInCatalog();
    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    // 文件里已经是新标题
    const t = await loadFiles();
    expect(t.readTemplateFileText(UID, 'probe')).toContain('## 教育与研究');

    // 但当年那个 token 原样回传仍然读得到
    const afterRead = await (await loadContract()).readOntologyEntry(UID, oldToken);
    expect(afterRead.ok).toBe(true);
    expect(afterRead.content).toContain('软件工程');
  });

  it('内部寻址串换算到当前标题，而不是死抠 token 里的旧名', async () => {
    const { groupId } = await installWithValue();
    const oldToken = await tokenForSection();

    renameSectionInCatalog();
    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    const contract = await loadContract();
    expect(contract.resolveRefToInternalId(UID, oldToken)).toBe(`${groupId}::教育与研究`);
  });

  it('迁移之前旧 token 照常走字面名，不因为多这一跳而变坏', async () => {
    await installWithValue();
    const oldToken = await tokenForSection();
    const { groupId } = { groupId: (await loadFiles()).readGroups(UID).find((g) => g.template_id === 'probe')!.group_id };

    // catalog 已改名但迁移还没跑：文件里仍是旧标题
    renameSectionInCatalog();
    const contract = await loadContract();
    expect(contract.resolveRefToInternalId(UID, oldToken)).toBe(`${groupId}::学习背景`);
    const read = await contract.readOntologyEntry(UID, oldToken);
    expect(read.ok).toBe(true);
  });

  it('新签发的 token 用的是迁移后的当前标题', async () => {
    await installWithValue();
    renameSectionInCatalog();
    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    const contract = await loadContract();
    const entries = await contract.listOntologyEntries(UID);
    expect(entries.map((e) => e.label)).toContain('教育与研究');
    expect(entries.map((e) => e.label)).not.toContain('学习背景');
  });

  it('认不出的名字原样透传，行为与改动前一致', async () => {
    const { groupId } = await installWithValue();
    const contract = await loadContract();
    // 手工构造一个指向不存在分节的 ts ref（历史脏数据）
    const forged = 'po1' + Buffer.from(JSON.stringify(
      { k: 'ts', t: 'probe', s: '根本没有这个分节' },
    )).toString('base64url');
    expect(contract.resolveRefToInternalId(UID, forged)).toBe(`${groupId}::根本没有这个分节`);
    expect((await contract.readOntologyEntry(UID, forged)).ok).toBe(false);
  });
});

describe('ts token 兼容 › 渲染层不需要知道 rename chain', () => {
  it('渲染层拿到的条目只有 opaque ref 和标签，没有历史名', async () => {
    await installWithValue();
    renameSectionInCatalog();
    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    const contract = await loadContract();
    const entries = await contract.listOntologyEntries(UID);
    const serialized = JSON.stringify(entries);
    for (const leak of ['previous_names', '学习背景', 'section_id', 'background']) {
      expect(serialized, `条目不得泄漏 ${leak}`).not.toContain(leak);
    }
  });
});
