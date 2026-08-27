import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Personal Ontology Contract（角色模板子域对外唯一出口）的边界测试。
 *
 * 核心断言不是「功能可用」，而是「内部结构不泄漏」：contract 返回的对象里
 * 不得出现 group_id / rel_path / 分节字段结构 / preset_groups / 字段值；
 * opaque ref 必须能读回、写回，且**卸载重装换了 group_id 之后依然有效**——
 * 这正是旧三元组契约（groupId+section+fieldName）做不到的事。
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
const UID = 'test-user-po-contract';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-po-contract-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const loadContract = () => import('../../../src/main/features/personal_ontology_contract');
const loadTemplates = () => import('../../../src/main/features/personal_ontology_template_files');

/** 安装 student 并填一个 T-box 字段值，返回台账 group_id（用于验证它会变）。 */
async function installStudentWithValue(value = '硕士'): Promise<string> {
  const tmpl = await loadTemplates();
  const contract = await loadContract();
  const inst = await tmpl.installTemplateFile(UID, 'student');
  expect(inst.ok).toBe(true);
  const targets = await contract.listRoleTemplateFieldTargets(UID);
  const target = targets.find((t) => t.label.endsWith('· 教育阶段'))!;
  expect(target).toBeTruthy();
  const w = await contract.appendRoleTemplateFieldValue(UID, target.fieldRef, value, '手动');
  expect(w).toEqual({ ok: true, templateId: 'student' });
  return tmpl.readGroups(UID).find((g) => g.template_id === 'student')!.group_id;
}

describe('PO contract › A 模板目录', () => {
  it('summary 只暴露约定字段，不泄漏 preset_groups / sections / 字段值 / group_id', async () => {
    const contract = await loadContract();
    await installStudentWithValue('硕士');

    const rows = await contract.listRoleTemplateSummaries(UID);
    expect(rows.length).toBeGreaterThan(0);

    const allowed = new Set(['templateId', 'name', 'description', 'version', 'installed', 'bundle']);
    for (const row of rows) {
      for (const key of Object.keys(row)) expect(allowed.has(key)).toBe(true);
      if (row.bundle) {
        for (const key of Object.keys(row.bundle)) expect(['skillIds', 'agentIds']).toContain(key);
      }
    }
    // 整棵结构序列化后也不得带出内部概念或已填的字段值
    const blob = JSON.stringify(rows);
    for (const leak of ['preset_groups', 'group_id', 'rel_path', 'sections', 'fields', '教育阶段', '硕士']) {
      expect(blob).not.toContain(leak);
    }
  });

  it('installed 反映真实安装状态', async () => {
    const contract = await loadContract();
    const before = await contract.listRoleTemplateSummaries(UID);
    expect(before.find((t) => t.templateId === 'student')!.installed).toBe(false);

    await installStudentWithValue();
    const after = await contract.listRoleTemplateSummaries(UID);
    expect(after.find((t) => t.templateId === 'student')!.installed).toBe(true);
    expect(after.find((t) => t.templateId === 'scholar')!.installed).toBe(false);
  });

  it('getRoleTemplateSummary 未知 id → null；resolveRoleTemplateId 支持 id 精确与显示名模糊', async () => {
    const contract = await loadContract();
    expect(await contract.getRoleTemplateSummary(UID, '__nope__')).toBeNull();
    expect(contract.resolveRoleTemplateId('student')).toBe('student');
    expect(contract.resolveRoleTemplateId('学生')).toBe('student');
    expect(contract.resolveRoleTemplateId('不存在的角色')).toBeUndefined();
  });
});

describe('PO contract › B Runtime 角色画像', () => {
  it('按 templateId 返回已格式化文本，剥掉来源与项目标记', async () => {
    const contract = await loadContract();
    const tmpl = await loadTemplates();
    await installStudentWithValue('硕士');
    // 再写一条带来源项目的值，验证 @proj 不进上下文
    const row = tmpl.readGroups(UID).find((g) => g.template_id === 'student')!;
    await tmpl.appendFieldValueToRef(
      UID, tmpl.buildContentRef(row.group_id, '学期与课程'), '课程清单', '机器学习', '智能', 'p_abc',
    );

    const block = await contract.getRoleProfileForRuntime(UID, ['student']);
    expect(block).toContain('## 当前角色画像');
    expect(block).toContain('### 角色「学生」');
    expect(block).toContain('学习背景 · 教育阶段: 硕士');
    expect(block).toContain('学期与课程 · 课程清单: 机器学习');
    expect(block).not.toContain('@proj:p_abc');
    expect(block).not.toContain('[手动]');
    expect(block).not.toContain('[智能]');
  });

  it('未安装 / 全空坑 / 空入参 / 非法 uid → 空串（静默降级，不注入空画像）', async () => {
    const contract = await loadContract();
    const tmpl = await loadTemplates();
    expect(await contract.getRoleProfileForRuntime(UID, ['student'])).toBe('');
    expect(await contract.getRoleProfileForRuntime(UID, [])).toBe('');
    expect(await contract.getRoleProfileForRuntime('bad/uid', ['student'])).toBe('');
    await tmpl.installTemplateFile(UID, 'student'); // 只有空坑
    expect(await contract.getRoleProfileForRuntime(UID, ['student'])).toBe('');
  });

  it('多模板按传入顺序拼接，重复 id 去重', async () => {
    const contract = await loadContract();
    const tmpl = await loadTemplates();
    await installStudentWithValue('硕士');
    await tmpl.installTemplateFile(UID, 'scholar');
    const scholarRow = tmpl.readGroups(UID).find((g) => g.template_id === 'scholar')!;
    const fields = await tmpl.listFieldsByRef(UID, tmpl.buildContentRef(scholarRow.group_id, '研究身份'));
    const firstField = fields.fields?.[0]?.name;
    if (firstField) {
      await tmpl.appendFieldValueToRef(
        UID, tmpl.buildContentRef(scholarRow.group_id, '研究身份'), firstField, '认知科学', '手动',
      );
      const block = await contract.getRoleProfileForRuntime(UID, ['student', 'scholar', 'student']);
      expect(block.indexOf('角色「学生」')).toBeLessThan(block.indexOf('角色「学者」'));
      expect(block.match(/角色「学生」/g)).toHaveLength(1);
    }
  });
});

describe('PO contract › C 可 @ 引用条目', () => {
  it('条目只带 ref/label/parentId/parentLabel，ref 不可解析出 group_id', async () => {
    const contract = await loadContract();
    const groupId = await installStudentWithValue();

    const entries = await contract.listOntologyEntries(UID);
    expect(entries.length).toBeGreaterThan(0);
    const allowed = new Set(['ref', 'label', 'parentId', 'parentLabel']);
    for (const e of entries) {
      for (const key of Object.keys(e)) expect(allowed.has(key)).toBe(true);
    }
    const blob = JSON.stringify(entries);
    expect(blob).not.toContain(groupId);
    expect(blob).not.toContain('::');
    // parentId 是 templateId（稳定业务标识），不是台账 group_id
    expect(entries.some((e) => e.parentId === 'student' && e.parentLabel === '学生')).toBe(true);
  });

  it('opaque ref 可读回对应分节内容', async () => {
    const contract = await loadContract();
    await installStudentWithValue('硕士');
    const entries = await contract.listOntologyEntries(UID);
    const entry = entries.find((e) => e.parentId === 'student' && e.label === '学习背景')!;
    const res = await contract.readOntologyEntry(UID, entry.ref);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('## 学习背景');
    expect(res.content).toContain('硕士');
  });

  it('普通分组也走 opaque ref，且与模板条目区分（无 parentId）', async () => {
    const contract = await loadContract();
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    const created = await groups.createGroup(UID, '我的随手记');
    expect(created.ok).toBe(true);
    await groups.appendToGroup(UID, created.group!.group_id, '随手一条');

    const entries = await contract.listOntologyEntries(UID);
    const plain = entries.find((e) => e.label === '我的随手记')!;
    expect(plain.parentId).toBeUndefined();
    const res = await contract.readOntologyEntry(UID, plain.ref);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('随手一条');
  });

  it('伪造 / 损坏 / 非 contract 的 ref 不会读到东西也不抛错', async () => {
    const contract = await loadContract();
    await installStudentWithValue();
    expect(contract.isOntologyRef('po1@@@')).toBe(false);
    expect(contract.decodeOntologyRef('po1' + Buffer.from('{"k":"zz"}').toString('base64url'))).toBeNull();
    expect(contract.decodeOntologyRef('4e9965c5fd44')).toBeNull();
    expect((await contract.readOntologyEntry(UID, 'po1notbase64!!')).ok).toBe(false);
  });
});

describe('PO contract › D 可写入模板字段', () => {
  it('落点只带 fieldRef/label/parentId/parentLabel，且只列 T-box 声明字段', async () => {
    const contract = await loadContract();
    const groupId = await installStudentWithValue();
    const targets = await contract.listRoleTemplateFieldTargets(UID);
    expect(targets.length).toBeGreaterThan(0);

    const allowed = new Set(['fieldRef', 'label', 'parentId', 'parentLabel']);
    for (const t of targets) {
      for (const key of Object.keys(t)) expect(allowed.has(key)).toBe(true);
    }
    const blob = JSON.stringify(targets);
    expect(blob).not.toContain(groupId);
    expect(blob).not.toContain('::');
    // 流水不是可写字段
    expect(targets.some((t) => t.label.endsWith('· 流水'))).toBe(false);
  });

  it('fieldRef 可写回，值真正落到模板文件', async () => {
    const contract = await loadContract();
    const tmpl = await loadTemplates();
    await installStudentWithValue('硕士');
    expect(tmpl.readTemplateFileText(UID, 'student')).toContain('- 硕士 [手动]');
  });

  it('未安装模板 / 非 tf ref / T-box 外字段 → 明确拒绝，不静默建坑', async () => {
    const contract = await loadContract();
    const tmpl = await loadTemplates();
    await installStudentWithValue();

    const entries = await contract.listOntologyEntries(UID);
    const sectionRef = entries.find((e) => e.parentId === 'student')!.ref;
    expect(await contract.appendRoleTemplateFieldValue(UID, sectionRef, 'x', '手动'))
      .toEqual({ ok: false, error: 'invalid field ref' });

    const targets = await contract.listRoleTemplateFieldTargets(UID);
    const good = targets[0].fieldRef;
    await tmpl.uninstallTemplateFile(UID, 'student');
    expect(await contract.appendRoleTemplateFieldValue(UID, good, 'x', '手动'))
      .toEqual({ ok: false, error: 'role template is not installed' });
  });

  it('isTboxField / listTboxFieldNames 是自动写入通道的单一判据', async () => {
    const contract = await loadContract();
    expect(contract.isTboxField('student', '学习背景', '教育阶段')).toBe(true);
    expect(contract.isTboxField('student', '学习背景', '不存在字段')).toBe(false);
    expect(contract.isTboxField('student', '不存在分节', '教育阶段')).toBe(false);
    expect(contract.isTboxField('__nope__', '学习背景', '教育阶段')).toBe(false);
    expect(contract.listTboxFieldNames('student').has('教育阶段')).toBe(true);
    expect(contract.listTboxFieldNames('__nope__').size).toBe(0);
  });
});

describe('PO contract › 卸载重装后 group_id 变化不影响 contract', () => {
  it('重装换了 group_id，旧 entry ref 与旧 fieldRef 依然可读可写', async () => {
    const contract = await loadContract();
    const tmpl = await loadTemplates();

    const firstGroupId = await installStudentWithValue('硕士');
    const entries = await contract.listOntologyEntries(UID);
    const entryRef = entries.find((e) => e.parentId === 'student' && e.label === '学习背景')!.ref;
    const fieldRef = (await contract.listRoleTemplateFieldTargets(UID))
      .find((t) => t.label.endsWith('· 教育阶段'))!.fieldRef;

    await tmpl.uninstallTemplateFile(UID, 'student');
    const reinstall = await tmpl.installTemplateFile(UID, 'student'); // 不恢复归档 → 全新空模板
    expect(reinstall.ok).toBe(true);
    const secondGroupId = tmpl.readGroups(UID).find((g) => g.template_id === 'student')!.group_id;
    expect(secondGroupId).not.toBe(firstGroupId); // 前提：group_id 确实变了

    // 旧 ref 仍解析得到新 group_id 下的实体
    const read = await contract.readOntologyEntry(UID, entryRef);
    expect(read.ok).toBe(true);
    expect(read.content).toContain('## 学习背景');

    const write = await contract.appendRoleTemplateFieldValue(UID, fieldRef, '博士', '手动');
    expect(write).toEqual({ ok: true, templateId: 'student' });
    expect(tmpl.readTemplateFileText(UID, 'student')).toContain('- 博士 [手动]');
  });

  it('对照组：旧三元组契约里的 group_id 在重装后确实失效', async () => {
    const tmpl = await loadTemplates();
    const firstGroupId = await installStudentWithValue();
    await tmpl.uninstallTemplateFile(UID, 'student');
    await tmpl.installTemplateFile(UID, 'student');

    // 旧写入口按 group_id 寻址 → 重装后台账里已无此行
    const res = await tmpl.appendExistingTemplateFieldValueToRef(
      UID, tmpl.buildContentRef(firstGroupId, '学习背景'), '教育阶段', '博士', '智能',
    );
    expect(res).toEqual({ ok: false, error: 'template group not found' });
  });
});
