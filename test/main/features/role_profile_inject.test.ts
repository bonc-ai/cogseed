import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
const UID = 'test-role-profile';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-role-profile-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSpaces() {
  return import('../../../src/main/features/spaces');
}
async function loadProjects() {
  return import('../../../src/main/features/projects');
}
async function loadTmpl() {
  return import('../../../src/main/features/personal_ontology_template_files');
}

describe('spaces › formatRoleProfileForSystemPrompt（空间内角色画像自动注入）', () => {
  /** 建学生空间 + 项目绑定 + 模板文件安装 + 填两个字段值。 */
  async function makeStudentProject() {
    const spaces = await loadSpaces();
    const projects = await loadProjects();
    const tmpl = await loadTmpl();
    const created = await spaces.createSpace(UID, { name: '学生', template_id: 'student' });
    if (!created.ok) throw new Error('create space failed');
    const p = await projects.createProject(UID, '学生项目');
    if (!p.ok) throw new Error('create project failed');
    await projects.bindSpace(UID, p.project.project_id, created.space.space_id);
    await tmpl.installTemplateFile(UID, 'student');
    const row = tmpl.readGroups(UID).find((g) => g.template_id === 'student')!;
    await tmpl.appendFieldValueToRef(UID, tmpl.buildContentRef(row.group_id, '学习背景'), '教育阶段', '硕士', '手动');
    await tmpl.appendFieldValueToRef(UID, tmpl.buildContentRef(row.group_id, '学期与课程'), '课程清单', '机器学习', '智能', 'p_abc');
    return { spaces, p: p.project.project_id };
  }

  it('绑模板空间 + 模板文件有值 → 角色画像块（分节 · 字段: 值），来源标记剥离', async () => {
    const { spaces, p } = await makeStudentProject();
    const block = await spaces.formatRoleProfileForSystemPrompt(UID, p);
    expect(block).toContain('角色画像');
    expect(block).toContain('学生');
    expect(block).toContain('学习背景 · 教育阶段: 硕士');
    expect(block).toContain('学期与课程 · 课程清单: 机器学习');
    expect(block).not.toContain('@proj:p_abc'); // 来源项目标记不注入上下文
  });

  it('未绑空间项目 → 空串（不注入）', async () => {
    const spaces = await loadSpaces();
    const projects = await loadProjects();
    const p = await projects.createProject(UID, '孤儿');
    if (!p.ok) throw new Error('create failed');
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, p.project.project_id)).toBe('');
  });

  it('无 projectId → 空串', async () => {
    const spaces = await loadSpaces();
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, null)).toBe('');
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, '')).toBe('');
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, undefined)).toBe('');
  });

  it('绑空间但模板文件未安装 → 空串（降级不炸）', async () => {
    const spaces = await loadSpaces();
    const projects = await loadProjects();
    const created = await spaces.createSpace(UID, { name: '学生', template_id: 'student' });
    if (!created.ok) throw new Error('create failed');
    const p = await projects.createProject(UID, 'P');
    if (!p.ok) throw new Error('create failed');
    await projects.bindSpace(UID, p.project.project_id, created.space.space_id);
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, p.project.project_id)).toBe('');
  });

  it('模板文件只有空坑（无值）→ 空串（不注入空画像）', async () => {
    const spaces = await loadSpaces();
    const projects = await loadProjects();
    const tmpl = await loadTmpl();
    const created = await spaces.createSpace(UID, { name: '学生', template_id: 'student' });
    if (!created.ok) throw new Error('create failed');
    const p = await projects.createProject(UID, 'P');
    if (!p.ok) throw new Error('create failed');
    await projects.bindSpace(UID, p.project.project_id, created.space.space_id);
    await tmpl.installTemplateFile(UID, 'student'); // 只有空坑
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, p.project.project_id)).toBe('');
  });

  it('项目不存在 → 空串（降级）', async () => {
    const spaces = await loadSpaces();
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, 'p_nope')).toBe('');
  });
});
