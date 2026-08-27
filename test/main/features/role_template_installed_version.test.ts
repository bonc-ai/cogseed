import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * installed_version 必须描述**这个实例实际是哪一版**，而不是「安装那一刻
 * catalog 是哪一版」。
 *
 * 收归后的审计发现：restoreData=true 从归档恢复时，模板文件是原样写回的
 * （保留归档自己的 `> 模板: id@ver` 行），但台账无条件写当前 catalog version，
 * 于是出现「文件 v1 / 台账 v2」的贴错标签。当前没有生产逻辑基于
 * installed_version 做升级判断，所以不是用户可见 bug；但未来任何 schema
 * migration / version mismatch 判断都会从这个撒谎的底账出发。
 *
 * 这组测试锁死三件事：新装取 catalog、跨版本 restore 取恢复文件自身、
 * 不 restore 的重新全新安装仍取 catalog（防止修 restore 误伤正常安装）。
 */

// 可变 T-box：模拟 catalog 升级。只替换目录读取，不改任何生产逻辑。
let CATALOG: Array<{
  template_id: string; name: string; description: string; version: string;
  preset_groups: Array<{ title: string; fields: Array<{ name: string }> }>;
  bundle?: { skill_ids: string[]; agent_ids: string[] };
}> = [];

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
const UID = 'test-user-installed-version';

function catalogAt(version: string, extraField?: string) {
  const fields = [{ name: '专业' }, ...(extraField ? [{ name: extraField }] : [])];
  return [{
    template_id: 'probe',
    name: '探针角色',
    description: '版本探针',
    version,
    preset_groups: [{ title: '背景', fields }],
    bundle: { skill_ids: [], agent_ids: [] },
  }];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-installed-ver-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  CATALOG = catalogAt('1.0.0');
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const loadTemplates = () => import('../../../src/main/features/personal_ontology_template_files');

/** 模板文件 meta 行里的真实版本（唯一事实来源）。 */
function fileVersion(text: string): string | undefined {
  return /^>\s*模板:\s*probe@([^\s|]+)/m.exec(text)?.[1];
}

/** 台账行记录的 installed_version。 */
async function ledgerVersion(): Promise<string | undefined> {
  const t = await loadTemplates();
  return t.readGroups(UID).find((g) => g.template_id === 'probe')?.template_version;
}

describe('installed_version › Case 1 普通安装', () => {
  it('restoreData=false → 文件与台账都取当前 catalog version', async () => {
    CATALOG = catalogAt('2.0.0');
    const t = await loadTemplates();

    const res = await t.installTemplateFile(UID, 'probe');
    expect(res.ok).toBe(true);
    expect(res.restored_from_archive).toBeFalsy();

    expect(fileVersion(t.readTemplateFileText(UID, 'probe'))).toBe('2.0.0');
    expect(await ledgerVersion()).toBe('2.0.0');

    const status = (await t.listTemplateStatus(UID)).find((s) => s.template_id === 'probe')!;
    expect(status.version).toBe('2.0.0');
    expect(status.installed_version).toBe('2.0.0');
  });
});

describe('installed_version › Case 2 跨版本 restore', () => {
  it('archive v1 + catalog v2 → 文件与台账都是 v1，且 catalog≠installed 是合法状态', async () => {
    const t = await loadTemplates();

    // v1 安装并填一条值，确保归档里有真实内容
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    const row = t.readGroups(UID).find((g) => g.template_id === 'probe')!;
    expect((await t.appendFieldValueToRef(
      UID, t.buildContentRef(row.group_id, '背景'), '专业', '认知科学', '手动',
    )).ok).toBe(true);
    expect(fileVersion(t.readTemplateFileText(UID, 'probe'))).toBe('1.0.0');

    // 卸载归档 → catalog 升到 v2（并新增一个字段，证明恢复的是旧 schema）
    expect((await t.uninstallTemplateFile(UID, 'probe')).ok).toBe(true);
    CATALOG = catalogAt('2.0.0', '当前研究方向');

    const re = await t.installTemplateFile(UID, 'probe', true);
    expect(re.ok).toBe(true);
    expect(re.restored_from_archive).toBe(true);

    const text = t.readTemplateFileText(UID, 'probe');
    // 恢复的是 v1 内容：旧值在、v2 新字段不在
    expect(text).toContain('- 认知科学 [手动]');
    expect(text).not.toContain('### 当前研究方向');

    // 核心断言：文件与台账必须一致，且都是恢复文件自身的版本
    expect(fileVersion(text)).toBe('1.0.0');
    expect(await ledgerVersion()).toBe('1.0.0');

    const status = (await t.listTemplateStatus(UID)).find((s) => s.template_id === 'probe')!;
    expect(status.installed_version).toBe('1.0.0');
    // catalog version 与 installed_version 允许真实不等 —— 这正是未来
    // version mismatch 判断需要的状态，而不是被抹平成同一个值。
    expect(status.version).toBe('2.0.0');
    expect(status.version).not.toBe(status.installed_version);

    // 两个 reader 不得再对同一实例给出不同版本
    const cat = await t.listTemplateFileCatalog(UID);
    expect(cat.find((c) => c.template_id === 'probe')?.version).toBe('1.0.0');
  });

  it('归档缺少可解析的 version meta → 退回当前 catalog version，台账模板标记不丢', async () => {
    const t = await loadTemplates();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    expect((await t.uninstallTemplateFile(UID, 'probe')).ok).toBe(true);

    // 把归档文件的 meta 行破坏掉（模拟历史/手改产物）
    const base = path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
    const backupDir = fs.readdirSync(base).find((n) => n.startsWith('_backup_'))!;
    const archived = path.join(base, backupDir, 'probe.md');
    fs.writeFileSync(archived, fs.readFileSync(archived, 'utf8').replace(/^> 模板:.*$/m, '> 模板: (损坏)'), 'utf8');

    CATALOG = catalogAt('2.0.0');
    const re = await t.installTemplateFile(UID, 'probe', true);
    expect(re.ok).toBe(true);
    expect(re.restored_from_archive).toBe(true);

    // fallback 必须是合法 semver，否则 groups.md 的 `- 模板:` 行整行写不出来，
    // 该行就不再被识别为模板行（install 幂等、uninstall、listTemplateStatus 全崩）。
    expect(await ledgerVersion()).toBe('2.0.0');
    const status = (await t.listTemplateStatus(UID)).find((s) => s.template_id === 'probe')!;
    expect(status.installed).toBe(true);
    expect(status.installed_version).toBe('2.0.0');
  });
});

describe('installed_version › Case 3 不恢复、重新全新安装', () => {
  it('restoreData=false 且存在归档 → 仍取当前 catalog version（修 restore 不误伤新装）', async () => {
    const t = await loadTemplates();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    expect((await t.uninstallTemplateFile(UID, 'probe')).ok).toBe(true);

    CATALOG = catalogAt('2.0.0', '当前研究方向');
    const re = await t.installTemplateFile(UID, 'probe', false);
    expect(re.ok).toBe(true);
    expect(re.restored_from_archive).toBeFalsy();

    const text = t.readTemplateFileText(UID, 'probe');
    expect(text).toContain('### 当前研究方向'); // 按 v2 catalog 新建
    expect(fileVersion(text)).toBe('2.0.0');
    expect(await ledgerVersion()).toBe('2.0.0');

    const status = (await t.listTemplateStatus(UID)).find((s) => s.template_id === 'probe')!;
    expect(status.version).toBe('2.0.0');
    expect(status.installed_version).toBe('2.0.0');
  });
});
