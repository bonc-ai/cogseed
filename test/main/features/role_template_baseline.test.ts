import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Role Template 收归的行为基线。
 *
 * 这些断言不是「新功能」，而是收归前必须钉住的现状事实——contract 迁移
 * 不得改变它们：
 *  - B1 预发布版本号（`0.2.0-review.1`）的模板文件仍被识别为模板文件，
 *    `listGroupFields` 走模板分支（跨分节字段汇总 + isCustom 标注），
 *    不会退化成普通组双区解析。两处 meta 正则必须对同一批版本号同判。
 *  - B2 来源标记的解析兼容：枚举外来源（历史手工/技能写入）读得回来，
 *    带空格的标记按裸值降级——收归后统一写入口不得让旧文件读不出来。
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
const UID = 'test-user-rt-baseline';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-rt-baseline-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const loadTemplates = () => import('../../../src/main/features/personal_ontology_template_files');
const loadGroups = () => import('../../../src/main/features/personal_ontology_groups');
const loadRegistry = () => import('../../../src/main/features/role_templates');

describe('role-template baseline › B1 预发布版本号的模板识别', () => {
  it('内置模板确实带预发布版本号（基线前提，版本改了这条要重新评估）', async () => {
    const { listRoleTemplates } = await loadRegistry();
    const versions = listRoleTemplates().map((t) => t.version);
    expect(versions.some((v) => /-/.test(v))).toBe(true);
  });

  it('listGroupFields 对预发布版本模板走模板分支：跨分节汇总 + 空坑全在 + isCustom 标注', async () => {
    const tmpl = await loadTemplates();
    const groups = await loadGroups();
    const registry = await loadRegistry();

    const student = registry.getRoleTemplate('student')!;
    expect(student.version).toContain('-'); // 预发布号，这条断言的意义所在

    const inst = await tmpl.installTemplateFile(UID, 'student');
    expect(inst.ok).toBe(true);
    const row = tmpl.readGroups(UID).find((g) => g.template_id === 'student')!;

    const res = await groups.listGroupFields(UID, row.group_id);
    expect(res.ok).toBe(true);

    // 模板分支的判据：跨分节汇总出全部 T-box 字段（空坑也在），且不含「流水」
    const names = res.fields!.map((f) => f.name);
    const tboxNames = student.preset_groups.flatMap((p) => p.fields.map((f) => f.name));
    for (const n of tboxNames) expect(names).toContain(n);
    expect(names).not.toContain('流水');

    // 普通组双区分支不会产生 isCustom；模板分支一定标注
    expect(res.fields!.every((f) => f.isCustom === false)).toBe(true);
  });

  it('两处 meta 正则对全部内置模板版本同判（防止未来一处收紧一处不收紧）', async () => {
    const registry = await loadRegistry();
    // template_files.ts 的权威式（锚定到行尾，带可选「已安装」段）
    const AUTHORITATIVE = /^>\s*模板:\s*([a-z0-9_-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s*\|\s*已安装:\s*(.+))?$/;
    // groups.ts 的轻量式（无行尾锚点，靠前缀匹配）
    const LIGHTWEIGHT = /^>\s*模板:\s*([a-z0-9_-]+)@(\d+\.\d+\.\d+)/m;

    for (const t of registry.listRoleTemplates()) {
      const line = `> 模板: ${t.template_id}@${t.version} | 已安装: 2026-01-01T00:00:00.000Z`;
      expect(
        AUTHORITATIVE.test(line.trim()),
        `authoritative regex must match ${t.template_id}@${t.version}`,
      ).toBe(true);
      expect(
        LIGHTWEIGHT.test(line),
        `lightweight regex must match ${t.template_id}@${t.version}`,
      ).toBe(true);
    }
  });
});

describe('role-template baseline › B2 枚举外来源标记的解析兼容', () => {
  it('无空格的枚举外来源原样读回（如历史 [已生效]）', async () => {
    const groups = await loadGroups();
    const parsed = groups.parseFieldValueLine('- 我在读硕士 [已生效]');
    expect(parsed).toEqual({ value: '我在读硕士', source: '已生效' });
  });

  it('带空格的标记按裸值降级，不丢内容（如 [候选池: cand-x]）', async () => {
    const groups = await loadGroups();
    const parsed = groups.parseFieldValueLine('- 我在读硕士 [候选池: cand-x]');
    // 来源捕获组不允许空格 → 整行落到裸值分支，来源归一为「手动」，正文零丢失
    expect(parsed).toEqual({ value: '我在读硕士 [候选池: cand-x]', source: '手动' });
  });

  it('模板文件里的枚举外来源可 parse → serialize 往返不丢', async () => {
    const tmpl = await loadTemplates();
    const text = [
      '# 学生（模板）',
      '',
      '> 模板: student@0.2.0-review.1 | 已安装: 2026-01-01T00:00:00.000Z',
      '',
      '## 学习背景',
      '',
      '### 教育阶段',
      '- 硕士 [已生效]',
      '',
      '### 流水',
      '',
    ].join('\n');
    const content = tmpl.parseTemplateContent(text);
    expect(content.sections[0].fields['教育阶段']).toEqual([{ value: '硕士', source: '已生效' }]);
    expect(tmpl.serializeTemplateContent(content)).toContain('- 硕士 [已生效]');
  });
});
