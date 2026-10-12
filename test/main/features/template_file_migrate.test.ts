import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * v1 遗留模板组迁移测试（2026-09-29 随 v2 存储重构改写）。
 *
 * 旧式形态（阶段 B/C）：一个模板 = 多个独立组文件（UUID 名，双区格式），
 * groups.md 台账行带 `- 模板: student@1.0.0`。v2 的 po/migrate 在导入时把
 * 它们并进该模板的模板组：值/来源/流水按组标题对号入座，目录没有种子时
 * 从 catalog 建空模板；数据零丢失、幂等。
 *
 * 种子方式改为直写 v1 目录（groups.md + 组文件），走真实的导入路径——
 * 不再需要 writeGroups（v2 已无台账写入口）。
 */

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
const UID = 'test-user-migrate';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-tmpl-migrate-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadTmpl() {
  return import('../../../src/main/features/personal_ontology_template_files');
}

function groupsDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
}

/** 直写 v1 目录：一个 legacy 模板组（双区组文件 + 台账模板行）。 */
function seedLegacyGroup(title: string, fields: Array<[string, string, string]>, entries: string[]): string {
  const dir = groupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const gid = `legacy${Math.random().toString(16).slice(2, 9)}`;
  const lines: string[] = [];
  if (fields.length) {
    lines.push('## 字段区', '');
    for (const [f, v, src] of fields) {
      lines.push(`### ${f}`, `- ${v} [${src}]`, '');
    }
    lines.push('---', '');
  }
  lines.push('## 流水区');
  if (entries.length) lines.push('', entries.join('\n§\n'));
  fs.writeFileSync(path.join(dir, `${gid}.md`), lines.join('\n'), 'utf8');

  const ledger = path.join(dir, 'groups.md');
  const row = [
    `### ${gid}`,
    `- 标题: ${title}`,
    `- 文件: .personal_ontology_groups/${gid}.md`,
    '- 创建时间: 2026-09-01T00:00:00',
    '- 更新时间: 2026-09-02T00:00:00',
    '- 模板: student@1.0.0',
    '',
  ].join('\n');
  fs.appendFileSync(ledger, (fs.existsSync(ledger) ? '\n' : '# 记忆分组\n\n') + row, 'utf8');
  return gid;
}

function readStudentFile(): string {
  return fs.readFileSync(path.join(groupsDir(), 'student.md'), 'utf8');
}

describe('migrateLegacyTemplateGroups（v2 导入路径上的阶段 B 合并）', () => {
  it('merges legacy template groups into one template group (values + sources + flow preserved)', async () => {
    const g1 = seedLegacyGroup('学习背景', [['教育阶段', '硕士', '智能'], ['专业与学习方向', '人工智能', '手动']], ['参加了数学建模竞赛']);
    seedLegacyGroup('学期与课程', [['课程清单', '机器学习', '智能']], []);

    const tmpl = await loadTmpl();
    const res = await tmpl.migrateLegacyTemplateGroups(UID);
    expect(res.ok).toBe(true);

    // 模板组已生成：分节对号入座 + 空坑保全
    const rendered = tmpl.readTemplateFileText(UID, 'student');
    expect(rendered).toContain('# 学生（模板）');
    expect(rendered).toContain('> 模板: student@0.2.0-review.1');
    expect(rendered).toContain('## 学习背景');
    expect(rendered).toContain('### 教育阶段\n- 硕士 [智能]');
    expect(rendered).toContain('### 专业与学习方向\n- 人工智能 [手动]');
    expect(rendered).toContain('## 学期与课程');
    expect(rendered).toContain('### 课程清单\n- 机器学习 [智能]');
    expect(rendered).toContain('参加了数学建模竞赛');
    // 目录种子的空坑（学习目标等）保全
    expect(rendered).toContain('### 学习目标');
    void g1;
  });

  it('keeps custom fields not declared in the seed, into the matching section', async () => {
    seedLegacyGroup('课程', [['我的自定义字段', '值甲', '手动']], []);

    const tmpl = await loadTmpl();
    await tmpl.migrateLegacyTemplateGroups(UID);
    const rendered = tmpl.readTemplateFileText(UID, 'student');
    expect(rendered).toContain('### 我的自定义字段\n- 值甲 [手动]');
  });

  it('renamed group (title not in seed) becomes its own section, data preserved', async () => {
    seedLegacyGroup('课题组', [['课题名', '知识图谱', '手动']], ['一条流水']);

    const tmpl = await loadTmpl();
    await tmpl.migrateLegacyTemplateGroups(UID);
    const rendered = tmpl.readTemplateFileText(UID, 'student');
    expect(rendered).toContain('## 课题组');
    expect(rendered).toContain('### 课题名\n- 知识图谱 [手动]');
    expect(rendered).toContain('一条流水');
  });

  it('replaces legacy rows: exactly one template row remains, no stray legacy groups', async () => {
    seedLegacyGroup('课程', [], []);
    seedLegacyGroup('项目', [], []);

    const tmpl = await loadTmpl();
    await tmpl.migrateLegacyTemplateGroups(UID);
    const all = tmpl.readGroups(UID);
    expect(all.filter((g) => g.template_id === 'student')).toHaveLength(1);
    const row = all.find((g) => g.template_id === 'student')!;
    expect(row.title).toBe('学生');
    expect(row.rel_path).toBe('.personal_ontology_groups/student.md');
    // 旧式课程/项目组行已被并入模板组，不再以普通组存在
    expect(all.some((g) => g.title === '课程' && !g.template_id)).toBe(false);
    expect(all.some((g) => g.title === '项目' && !g.template_id)).toBe(false);
  });

  it('moves the v1 dir into a local backup (not deleted)', async () => {
    const gid = seedLegacyGroup('课程', [['课程名称', '高等数学', '智能']], []);

    const tmpl = await loadTmpl();
    await tmpl.migrateLegacyTemplateGroups(UID);
    const localDir = path.join(tmpDir, UID, 'local');
    const backups = fs.readdirSync(localDir).filter((f) => f.startsWith('ontology-v1-backup-'));
    expect(backups.length).toBe(1);
    // 旧组文件原样保留在备份里
    expect(fs.readdirSync(path.join(localDir, backups[0]))).toContain(`${gid}.md`);
    // 渲染副本在（模板文件化产物）
    expect(fs.existsSync(path.join(groupsDir(), 'student.md'))).toBe(true);
  });

  it('is idempotent: second run migrates nothing', async () => {
    seedLegacyGroup('课程', [], []);
    const tmpl = await loadTmpl();
    const first = await tmpl.migrateLegacyTemplateGroups(UID);
    expect(first.ok).toBe(true);
    const again = await tmpl.migrateLegacyTemplateGroups(UID);
    expect(again.ok).toBe(true);
    expect(again.migrated).toBe(0);
    expect(again.groups_moved).toBe(0);
  });

  it('no legacy groups → migrated 0, no-op', async () => {
    const tmpl = await loadTmpl();
    const res = await tmpl.migrateLegacyTemplateGroups(UID);
    expect(res.ok).toBe(true);
    expect(res.migrated).toBe(0);
    expect(res.groups_moved).toBe(0);
  });
});
