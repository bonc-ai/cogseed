import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Space, SpaceAssetRef } from '../../../src/main/features/spaces';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uP3394';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-spaces-p3394-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // paths.ts 的 WS_ROOT 是模块加载时求值常量——不重置缓存会让所有用例写进第一个 tmpDir
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSpaces() {
  return import('../../../src/main/features/spaces');
}

const skillRef: SpaceAssetRef = { asset_id: 'sk-handoff', version: '1.0.0', content_hash: 'a'.repeat(64) };

describe('spaces › P3394 字段（创建默认值）', () => {
  it('缺省 space_type=complex_project、gate_status=not_checked、其余字段缺省', async () => {
    const { createSpace } = await loadSpaces();
    const r = await createSpace(TEST_UID, { name: '默认空间' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.space.space_type).toBe('complex_project');
    expect(r.space.gate_status).toBe('not_checked');
    expect(r.space.sustained_outcome).toBeUndefined();
    expect(r.space.main_skill_ref).toBeUndefined();
  });

  it('创建时指定 space_type/sustained_outcome/main_skill_ref 正确落盘', async () => {
    const { createSpace, getSpace } = await loadSpaces();
    const r = await createSpace(TEST_UID, {
      name: '交付空间',
      space_type: 'complex_project',
      sustained_outcome: '跨 Agent 项目交付',
      main_skill_ref: skillRef,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = await getSpace(TEST_UID, r.space.space_id);
    expect(s?.space_type).toBe('complex_project');
    expect(s?.sustained_outcome).toBe('跨 Agent 项目交付');
    expect(s?.main_skill_ref).toEqual(skillRef);
  });

  it('非法 space_type → invalid_space_type；超长 sustained_outcome → too_long', async () => {
    const { createSpace } = await loadSpaces();
    const bad = await createSpace(TEST_UID, { name: 'x', space_type: 'galaxy' as never });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toBe('invalid_space_type');
    const long = await createSpace(TEST_UID, { name: 'y', sustained_outcome: '长'.repeat(201) });
    expect(long.ok).toBe(false);
    if (long.ok) return;
    expect(long.error).toBe('too_long');
  });
});

describe('spaces › P3394 字段（旧数据兼容读）', () => {
  it('旧空间文件（无新字段）读取后默认值正确，不重写文件', async () => {
    const { createSpace, getSpace } = await loadSpaces();
    const r = await createSpace(TEST_UID, { name: '旧空间' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 手工构造旧格式文件（去掉新字段），模拟旧数据
    const { spaceMetaFile } = await import('../../../src/main/paths');
    const f = spaceMetaFile(TEST_UID, r.space.space_id);
    const old = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete old.space_type;
    delete old.sustained_outcome;
    delete old.gate_status;
    delete old.main_skill_ref;
    fs.writeFileSync(f, JSON.stringify(old));
    const s = await getSpace(TEST_UID, r.space.space_id);
    expect(s?.space_type).toBe('complex_project');
    expect(s?.gate_status).toBe('not_checked');
    expect(s?.main_skill_ref).toBeUndefined();
    // 文件未被重写（内容仍是旧格式）
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(raw.space_type).toBeUndefined();
  });

  it('读时归一化：非法 main_skill_ref 被丢弃', async () => {
    const { createSpace, getSpace } = await loadSpaces();
    const r = await createSpace(TEST_UID, { name: '归一化' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { spaceMetaFile } = await import('../../../src/main/paths');
    const f = spaceMetaFile(TEST_UID, r.space.space_id);
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    raw.main_skill_ref = { asset_id: 'sk-x' }; // 缺 version → 非法
    fs.writeFileSync(f, JSON.stringify(raw));
    const s = await getSpace(TEST_UID, r.space.space_id);
    expect(s?.main_skill_ref).toBeUndefined();
  });
});

describe('spaces › P3394 字段（update）', () => {
  it('更新 gate_status / space_type / sustained_outcome / main_skill_ref', async () => {
    const { createSpace, updateSpace } = await loadSpaces();
    const r = await createSpace(TEST_UID, { name: '更新测试' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.space.space_id;
    const u1 = await updateSpace(TEST_UID, sid, {
      gate_status: 'passed',
      space_type: 'professional_work',
      sustained_outcome: '产品需求澄清',
      main_skill_ref: skillRef,
    });
    expect(u1.ok).toBe(true);
    if (!u1.ok) return;
    expect(u1.space.gate_status).toBe('passed');
    expect(u1.space.space_type).toBe('professional_work');
    expect(u1.space.sustained_outcome).toBe('产品需求澄清');
    expect(u1.space.main_skill_ref).toEqual(skillRef);
  });

  it('null 清除语义：main_skill_ref=null → undefined；gate_status=null → not_checked', async () => {
    const { createSpace, updateSpace } = await loadSpaces();
    const r = await createSpace(TEST_UID, { name: '清除测试', main_skill_ref: skillRef, gate_status: 'passed' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.space.space_id;
    const u = await updateSpace(TEST_UID, sid, { main_skill_ref: null, gate_status: null });
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.space.main_skill_ref).toBeUndefined();
    expect(u.space.gate_status).toBe('not_checked');
  });

  it('update 非法 space_type / gate_status → invalid_space_type', async () => {
    const { createSpace, updateSpace } = await loadSpaces();
    const r = await createSpace(TEST_UID, { name: '非法更新' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bad = await updateSpace(TEST_UID, r.space.space_id, { space_type: 'galaxy' as never });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toBe('invalid_space_type');
  });
});

describe('spaces › P3394 字段（list 透传）', () => {
  it('listSpaces 透传新字段（SpaceWithMeta 继承 Space）', async () => {
    const { createSpace, updateSpace, listSpaces } = await loadSpaces();
    const r = await createSpace(TEST_UID, {
      name: '透传测试',
      space_type: 'recurring_routine',
      sustained_outcome: '管理周报',
      main_skill_ref: skillRef,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await updateSpace(TEST_UID, r.space.space_id, { gate_status: 'passed' }); // Gate 评估通过由 update 写入
    const list = await listSpaces(TEST_UID);
    expect(list.length).toBe(1);
    expect(list[0].space_type).toBe('recurring_routine');
    expect(list[0].sustained_outcome).toBe('管理周报');
    expect(list[0].gate_status).toBe('passed');
    expect(list[0].main_skill_ref).toEqual(skillRef);
  });
});

// 类型编译护栏：Space 新字段为可选，旧构造仍合法（防止未来误改必填）
const _typeGuard: Space = {
  space_id: 'sp_x',
  name: 'n',
  extra_skills: [],
  extra_agents: [],
  secondary_template_ids: [],
  created_at: '2026-08-10T00:00:00',
  updated_at: '2026-08-10T00:00:00',
};
void _typeGuard;

describe('spaces › createSpaceFromDraft（构建师草稿校验）', () => {
  it('最小合法草稿（仅名字）→ 创建成功，缺省字段正确', async () => {
    const { createSpaceFromDraft } = await loadSpaces();
    const r = await createSpaceFromDraft(TEST_UID, { name: '我的空间' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.space.space_type).toBe('complex_project');
    expect(r.space.primary_template_id).toBeUndefined();
    expect(r.space.extra_skills).toEqual([]);
    expect(r.space.extra_agents).toEqual([]);
  });

  it('模板不存在 → 忽略 + correction，空间照建（不卡 invalid_draft）', async () => {
    const { createSpaceFromDraft, listSpaces } = await loadSpaces();
    const r = await createSpaceFromDraft(TEST_UID, {
      name: '坏模板空间',
      primary_template_id: 'tpl_not_exist',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.space.primary_template_id).toBeUndefined();
    expect((r as any).corrections?.some((c: string) => c.includes('tpl_not_exist'))).toBe(true);
    expect((await listSpaces(TEST_UID)).length).toBe(1); // 空间已创建
  });

  it('主技能不存在 → 忽略 + correction，空间照建', async () => {
    const { createSpaceFromDraft, getSpace } = await loadSpaces();
    const r = await createSpaceFromDraft(TEST_UID, {
      name: '坏技能空间',
      main_skill_ref: { asset_id: 'sk_not_exist', version: '1.0.0' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.space.main_skill_ref).toBeUndefined();
    expect((r as any).corrections?.some((c: string) => c.includes('sk_not_exist'))).toBe(true);
    const loaded = await getSpace(TEST_UID, r.space.space_id);
    expect(loaded?.main_skill_ref).toBeUndefined();
  });

  it('extra 技能不存在 → 忽略 + correction，空间照建', async () => {
    const { createSpaceFromDraft, listSpaces } = await loadSpaces();
    const r = await createSpaceFromDraft(TEST_UID, {
      name: '坏额外空间',
      extra_skill_ids: ['sk_not_exist'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.space.extra_skills).toEqual([]);
    expect((r as any).corrections?.some((c: string) => c.includes('sk_not_exist'))).toBe(true);
    expect((await listSpaces(TEST_UID)).length).toBe(1); // 空间已创建
  });

  it('模板按显示名解析（LLM 用名当 id 兜底）→ 解析为真实 id', async () => {
    const { createSpaceFromDraft } = await loadSpaces();
    const r = await createSpaceFromDraft(TEST_UID, {
      name: '名称解析空间',
      primary_template_id: 'FDE 交付', // 显示名 → 真实 id 'fde'
      secondary_template_ids: ['软件工程师'], // 显示名 → 真实 id 'software_engineer'
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.space.primary_template_id).toBe('fde');
    expect(r.space.secondary_template_ids).toEqual(['software_engineer']);
    expect((r as any).corrections?.length).toBe(2);
  });

  it('拒绝：space_type 非法 / 目标超长', async () => {
    const { createSpaceFromDraft } = await loadSpaces();
    const r1 = await createSpaceFromDraft(TEST_UID, { name: 's1', space_type: 'evil_type' });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.details?.some((d) => d.includes('space_type'))).toBe(true);
    const r2 = await createSpaceFromDraft(TEST_UID, { name: 's2', sustained_outcome: 'x'.repeat(201) });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.details?.some((d) => d.includes('200'))).toBe(true);
  });

  it('拒绝：重名 → name_dup', async () => {
    const { createSpaceFromDraft } = await loadSpaces();
    await createSpaceFromDraft(TEST_UID, { name: '重复名' });
    const r = await createSpaceFromDraft(TEST_UID, { name: '重复名' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('name_dup');
  });

  it('主+副模板草稿 → 空间落盘 secondary_template_ids，bundle 并入去重（对接新管线）', async () => {
    const { createSpaceFromDraft, getSpace } = await loadSpaces();
    const r = await createSpaceFromDraft(TEST_UID, {
      name: '主副模板空间',
      primary_template_id: 'product_manager',
      secondary_template_ids: ['project_manager', 'fde'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.space.primary_template_id).toBe('product_manager');
    expect(r.space.secondary_template_ids).toEqual(['project_manager', 'fde']);
    // 落盘可读
    const loaded = await getSpace(TEST_UID, r.space.space_id);
    expect(loaded?.secondary_template_ids).toEqual(['project_manager', 'fde']);
  });

  it('副模板不存在 → 忽略 + correction；超 2 个 → 仅取前 2 + correction，空间照建', async () => {
    const { createSpaceFromDraft } = await loadSpaces();
    const r1 = await createSpaceFromDraft(TEST_UID, {
      name: '坏副模板空间',
      primary_template_id: 'product_manager',
      secondary_template_ids: ['tpl_not_exist'],
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.space.secondary_template_ids).toEqual([]);
    expect((r1 as any).corrections?.some((c: string) => c.includes('tpl_not_exist'))).toBe(true);

    const r2 = await createSpaceFromDraft(TEST_UID, {
      name: '副模板超限空间',
      primary_template_id: 'product_manager',
      secondary_template_ids: ['fde', 'student', 'scholar'],
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.space.secondary_template_ids).toEqual(['fde', 'student']);
    expect((r2 as any).corrections?.some((c: string) => c.includes('前 2 个'))).toBe(true);
  });
});
