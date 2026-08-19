import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-role-profile-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSpaces() {
  return import('../../../src/main/features/spaces');
}
async function loadTmpl() {
  return import('../../../src/main/features/personal_ontology_template_files');
}

describe('spaces › formatRoleProfileForSystemPrompt（空间内角色画像自动注入）', () => {
  /** 建学生空间 + 模板文件安装 + 填两个字段值。 */
  async function makeStudentSpace() {
    const spaces = await loadSpaces();
    const tmpl = await loadTmpl();
    const created = await spaces.createSpace(UID, { name: '学生', template_id: 'student' });
    if (!created.ok) throw new Error('create space failed');
    await tmpl.installTemplateFile(UID, 'student');
    const row = tmpl.readGroups(UID).find((g) => g.template_id === 'student')!;
    await tmpl.appendFieldValueToRef(UID, tmpl.buildContentRef(row.group_id, '学习背景'), '教育阶段', '硕士', '手动');
    await tmpl.appendFieldValueToRef(UID, tmpl.buildContentRef(row.group_id, '学期与课程'), '课程清单', '机器学习', '智能', 'p_abc');
    return { spaces, sid: created.space.space_id };
  }

  it('套模板空间 + 模板文件有值 → 角色画像块（分节 · 字段: 值），来源标记剥离', async () => {
    const { spaces, sid } = await makeStudentSpace();
    const block = await spaces.formatRoleProfileForSystemPrompt(UID, sid);
    expect(block).toContain('角色画像');
    expect(block).toContain('学生');
    expect(block).toContain('学习背景 · 教育阶段: 硕士');
    expect(block).toContain('学期与课程 · 课程清单: 机器学习');
    expect(block).not.toContain('@proj:p_abc'); // 来源项目标记不注入上下文
  });

  it('无模板空间 → 空串（不注入）', async () => {
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(UID, { name: '无模板' });
    if (!created.ok) throw new Error('create failed');
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, created.space.space_id)).toBe('');
  });

  it('无 spaceId → 空串', async () => {
    const spaces = await loadSpaces();
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, null)).toBe('');
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, '')).toBe('');
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, undefined)).toBe('');
  });

  it('套模板空间但模板文件未安装 → 空串（降级不炸）', async () => {
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(UID, { name: '学生', template_id: 'student' });
    if (!created.ok) throw new Error('create failed');
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, created.space.space_id)).toBe('');
  });

  it('模板文件只有空坑（无值）→ 空串（不注入空画像）', async () => {
    const spaces = await loadSpaces();
    const tmpl = await loadTmpl();
    const created = await spaces.createSpace(UID, { name: '学生', template_id: 'student' });
    if (!created.ok) throw new Error('create failed');
    await tmpl.installTemplateFile(UID, 'student'); // 只有空坑
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, created.space.space_id)).toBe('');
  });

  it('空间不存在 → 空串（降级）', async () => {
    const spaces = await loadSpaces();
    expect(await spaces.formatRoleProfileForSystemPrompt(UID, 'space_nope')).toBe('');
  });
});
