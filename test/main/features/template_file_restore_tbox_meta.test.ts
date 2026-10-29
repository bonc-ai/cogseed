import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 模板归档恢复与原文编辑回存按分节和字段名补齐 catalog 元数据。
 * schema 身份、关系标记和说明保留；catalog 外自建字段仍是 user，字段值不丢失。 */

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
const UID = 'test-user-tbox-meta';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-tbox-meta-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  CATALOG = [{
    template_id: 'probe',
    name: '探针角色',
    description: '',
    version: '1.0.0',
    preset_groups: [{
      id: 'bg',
      title: '学习背景',
      fields: [
        { id: 'major', name: '专业', description: '当前就读专业' },
        { id: 'partner', name: '协作对象', isRelation: true },
      ],
    }],
    bundle: { skill_ids: [], agent_ids: [] },
  }];
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  return import('../../../src/main/features/personal_ontology_template_files');
}

function fieldOf(group: any, name: string): any {
  return group.fields.find((f: any) => f.name === name);
}

/** 装模板并给「专业」填一条值（保证归档/回存文本里该字段有存在感）。 */
async function installWithMajorValue() {
  const m = await loadMod();
  expect((await m.installTemplateFile(UID, 'probe')).ok).toBe(true);
  const { loadPoDocSync } = await import('../../../src/main/features/po/store');
  const group = loadPoDocSync(UID).groups.find((g: any) => g.kind === 'template');
  const ref = m.buildContentRef(group.id, '学习背景');
  expect((await m.appendFieldValueToRef(UID, ref, '专业', '软件工程', '手动')).ok).toBe(true);
  return { m, groupId: group.id };
}

describe('catalog 元数据回填 › 归档恢复入口', () => {
  it('卸载→重装恢复：T-box 字段 origin/isRelation/description 按 catalog 回填', async () => {
    const { m, groupId } = await installWithMajorValue();
    const { loadPoDocSync } = await import('../../../src/main/features/po/store');

    expect((await m.uninstallTemplateFile(UID, 'probe')).ok).toBe(true);
    const re = await m.installTemplateFile(UID, 'probe', true);
    expect(re.ok).toBe(true);
    expect(re.restored_from_archive).toBe(true);

    const restored = loadPoDocSync(UID).groups.find((g: any) => g.id === groupId || g.kind === 'template');
    // 「专业」：schema 身份 + 描述回填，值原样恢复。
    const major = fieldOf(restored, '专业');
    expect(major.origin).toBe('schema');
    expect(major.description).toBe('当前就读专业');
    expect(restored.values.some((v: any) => v.fieldId === major.id && v.text === '软件工程')).toBe(true);
    // 「协作对象」：schema 身份 + R-box 标记回填（空坑也回填）。
    const partner = fieldOf(restored, '协作对象');
    expect(partner.origin).toBe('schema');
    expect(partner.isRelation).toBe(true);
  });

  it('恢复后只读守卫生效：schema 字段改名被拒（origin 已回填，不再裸 user）', async () => {
    const { m, groupId } = await installWithMajorValue();
    await m.uninstallTemplateFile(UID, 'probe');
    await m.installTemplateFile(UID, 'probe', true);

    const { loadPoDocSync } = await import('../../../src/main/features/po/store');
    const group = loadPoDocSync(UID).groups.find((g: any) => g.kind === 'template');
    const { poRenameField } = await import('../../../src/main/features/po/api');
    const res = await poRenameField(UID, group.id, fieldOf(group, '专业').id, '新专业名');
    expect(res).toMatchObject({ ok: false, error: 'template field is read-only' });
  });
});

describe('catalog 元数据回填 › raw editor 保存入口', () => {
  it('原样回存方言文本：schema 身份与 isRelation/description 不丢', async () => {
    const { m, groupId } = await installWithMajorValue();
    // 用户先经升格建一个自建字段（catalog 外），验证回存后仍保持 user。
    const ref = m.buildContentRef(groupId, '学习背景');
    expect((await m.appendFlowEntryToRef(UID, ref, '自建内容')).ok).toBe(true);
    expect((await m.promoteEntryToRef(UID, ref, '自建内容', '我的自建字段')).isOk ?? true).toBe(true);

    // 「原文」视图原样回存（生产 raw editor 的保存路径）。
    const text = m.readTemplateFileText(UID, 'probe');
    const saved = await m.writeTemplateFileContent(UID, groupId, text);
    expect(saved.ok).toBe(true);

    const { loadPoDocSync } = await import('../../../src/main/features/po/store');
    const after = loadPoDocSync(UID).groups.find((g: any) => g.id === groupId);
    expect(fieldOf(after, '专业').origin).toBe('schema');
    expect(fieldOf(after, '专业').description).toBe('当前就读专业');
    expect(fieldOf(after, '协作对象').origin).toBe('schema');
    expect(fieldOf(after, '协作对象').isRelation).toBe(true);
    // catalog 外的用户自建字段保持 user 身份。
    expect(fieldOf(after, '我的自建字段').origin).toBe('user');
    // 值不丢。
    const majorId = fieldOf(after, '专业').id;
    expect(after.values.some((v: any) => v.fieldId === majorId && v.text === '软件工程')).toBe(true);
  });
});
