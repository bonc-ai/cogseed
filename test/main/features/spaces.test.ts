import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// listSpaces 内部动态 import('./agents')/('./skills') 构造真实有效集合；
// 用可变 fixture 模拟「当前用户可见资源」，验证失效数非空集合假阳性（P3394 回归）。
const visibleSkillIds = vi.hoisted(() => new Set<string>());
const visibleAgentIds = vi.hoisted(() => new Set<string>());

vi.mock('../../../src/main/features/skills', () => ({
  listSkillCatalog: async () => Array.from(visibleSkillIds).map((id) => ({ id, name: id })),
}));
vi.mock('../../../src/main/features/agents', () => ({
  listAgents: async () => Array.from(visibleAgentIds).map((agent_id) => ({ agent_id, name: agent_id })),
}));

// 纯函数直接静态导入（无 WS_ROOT 依赖）
import {
  resolveSpaceResources,
  parseTemplateFileBundle,
  type Space,
} from '../../../src/main/features/spaces';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uSpc';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-spaces-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSpaces() {
  return import('../../../src/main/features/spaces');
}

function makeSpace(over: Partial<Space> = {}): Space {
  return {
    space_id: 'sp_test',
    name: '测试空间',
    extra_skills: [],
    extra_agents: [],
    secondary_template_ids: [],
    created_at: '2026-08-06T00:00:00',
    updated_at: '2026-08-06T00:00:00',
    ...over,
  };
}

const validAll = {
  skills: new Set(['sk-a', 'sk-b', 'sk-c']),
  agents: new Set(['ag-1', 'ag-2']),
};

describe('spaces › resolveSpaceResources（纯函数）', () => {
  it('模板 bundle ∪ 空间 extra 并集、去重、保序', () => {
    const space = makeSpace({
      template_id: 'student', // student bundle: 5 cogseed skills + 3 cogseed agents
      extra_skills: ['sk-a', 'sk-b'],
      extra_agents: ['ag-1'],
    });
    // 注入 valid 使 student bundle 的 id 全有效
    const valid = {
      skills: new Set(['0e847fc8685e', '3def7f0eb34a', '4a8054f512e9', '4bb1813c8335', 'aef5bf07573f', 'sk-a', 'sk-b']),
      agents: new Set(['3bf780cd23be', '54f102b6c1ee', '5a5fe1598ed0', 'ag-1']),
    };
    const r = resolveSpaceResources(space, valid);
    expect(r.template?.template_id).toBe('student');
    expect(r.effective_skills).toEqual(['0e847fc8685e', '3def7f0eb34a', '4a8054f512e9', '4bb1813c8335', 'aef5bf07573f', 'sk-a', 'sk-b']);
    expect(r.effective_agents).toEqual(['3bf780cd23be', '54f102b6c1ee', '5a5fe1598ed0', 'ag-1']);
    expect(r.invalid_refs.skills).toEqual([]);
    expect(r.invalid_refs.agents).toEqual([]);
  });

  it('失效引用被过滤并归入 invalid_refs，不进 effective', () => {
    const space = makeSpace({
      template_id: 'student',
      extra_skills: ['sk-a', '__gone__'],
      extra_agents: ['__gone_agent__'],
    });
    const valid = {
      skills: new Set(['0e847fc8685e', '3def7f0eb34a', '4a8054f512e9', '4bb1813c8335', 'aef5bf07573f', 'sk-a']),
      agents: new Set(['3bf780cd23be', '54f102b6c1ee', '5a5fe1598ed0']),
    };
    const r = resolveSpaceResources(space, valid);
    expect(r.effective_skills).toEqual(['0e847fc8685e', '3def7f0eb34a', '4a8054f512e9', '4bb1813c8335', 'aef5bf07573f', 'sk-a']);
    expect(r.effective_agents).toEqual(['3bf780cd23be', '54f102b6c1ee', '5a5fe1598ed0']);
    expect(r.invalid_refs.skills).toEqual(['__gone__']);
    expect(r.invalid_refs.agents).toEqual(['__gone_agent__']);
  });

  it('无模板（template_id 缺省）→ template null，effective = extra 过滤后', () => {
    const space = makeSpace({ template_id: undefined, extra_skills: ['sk-a', '__gone__'] });
    const r = resolveSpaceResources(space, validAll);
    expect(r.template).toBeNull();
    expect(r.effective_skills).toEqual(['sk-a']);
    expect(r.invalid_refs.skills).toEqual(['__gone__']);
  });

  it('模板存在但无 bundle（旧模板兼容）→ 仅 extra', () => {
    // template_id 指向 fde（v1.1.0 有 bundle），这里直接构造无 bundle 的 space 用未知模板 id
    const space = makeSpace({ template_id: '__no_bundle_tpl__', extra_skills: ['sk-a'] });
    const r = resolveSpaceResources(space, validAll);
    expect(r.template).toBeNull();
    expect(r.effective_skills).toEqual(['sk-a']);
    expect(r.effective_agents).toEqual([]);
  });

  it('空配置（无模板无 extra）→ 全空数组（调用方据此判定全局可见）', () => {
    const r = resolveSpaceResources(makeSpace(), validAll);
    expect(r.effective_skills).toEqual([]);
    expect(r.effective_agents).toEqual([]);
    expect(r.invalid_refs.skills).toEqual([]);
  });

  it('base_agent 映射的成员进 effective_agents（基础 Agent 与指挥官同层，必须可派发）', () => {
    const r = resolveSpaceResources(makeSpace(), validAll, { baseAgentAgentIds: ['ag-2'] });
    expect(r.effective_agents).toEqual(['ag-2']);
  });

  it('base_agent 映射成员与 extra 重复 → 去重不重复计数', () => {
    const r = resolveSpaceResources(
      makeSpace({ extra_agents: ['ag-2'] }),
      validAll,
      { baseAgentAgentIds: ['ag-2'] },
    );
    expect(r.effective_agents).toEqual(['ag-2']);
  });

  it('base_agent 映射的成员不在有效集 → 归 invalid_refs（与 extra 同语义）', () => {
    const r = resolveSpaceResources(makeSpace(), validAll, { baseAgentAgentIds: ['__gone_base__'] });
    expect(r.effective_agents).toEqual([]);
    expect(r.invalid_refs.agents).toEqual(['__gone_base__']);
  });

  it('base_agent 映射兼容 p3394-gateway 外接 CLI（Hermes）——源码契约', () => {
    // Hermes 的外接 runtime.kind 是 'p3394-gateway'（经 P3394 网关协作），
    // 不是 'cli'。baseAgentToAgentId 若只认 'cli'，空间 base_agents 选了
    // Hermes 也映射不到成员 → effective_agents 缺它 → 空间会话 @ tab 看不到
    // （回归：2026-08-17 实机）。此处做源码级契约保护。
    const source = fs.readFileSync(path.join(__dirname, '../../../src/main/features/spaces.ts'), 'utf8');
    const start = source.indexOf('function baseAgentToAgentId');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 1200);
    expect(body).toContain("a.runtime.kind === 'cli' || a.runtime.kind === 'p3394-gateway'");
  });

  it('extra 与 bundle 重复的 id 去重（保留模板优先序）', () => {
    const space = makeSpace({
      template_id: 'student',
      extra_skills: ['0e847fc8685e', 'sk-b'], // 0e847fc8685e 与 bundle 重复
    });
    const valid = {
      skills: new Set(['0e847fc8685e', '3def7f0eb34a', '4a8054f512e9', '4bb1813c8335', 'aef5bf07573f', 'sk-b']),
      agents: new Set(['3bf780cd23be', '54f102b6c1ee', '5a5fe1598ed0']),
    };
    const r = resolveSpaceResources(space, valid);
    const seen = new Set<string>();
    for (const s of r.effective_skills) {
      expect(seen.has(s)).toBe(false); // 无重复
      seen.add(s);
    }
    expect(r.effective_skills.filter((s) => s === '0e847fc8685e').length).toBe(1);
  });

  it('多模板（主+副）：主+副 bundle ∪ extra 并集去重', () => {
    // 主模板 student (5 skills, 3 agents) + 副模板 scholar (5 skills, 3 agents)
    const space = makeSpace({
      primary_template_id: 'student',
      secondary_template_ids: ['scholar'],
      extra_skills: ['sk-extra'],
    });
    const valid = {
      skills: new Set([
        '0e847fc8685e','3def7f0eb34a','4a8054f512e9','4bb1813c8335','aef5bf07573f', // student
        '17b2d5e85d87','2b7f7c8621d5','4ff31e1cab6f','6c5609e76cf0','86cea925e282', // scholar
        'sk-extra',
      ]),
      agents: new Set([
        '3bf780cd23be','54f102b6c1ee','5a5fe1598ed0', // student
        '37054bcc1740','57f6f828af9f','a37e8dbcc57e', // scholar
      ]),
    };
    const r = resolveSpaceResources(space, valid);
    expect(r.template?.template_id).toBe('student');
    expect(r.secondary_templates.length).toBe(1);
    expect(r.secondary_templates[0].template_id).toBe('scholar');
    // 两模板 skill 并集 (5+5+1=11) 全部有效
    expect(r.effective_skills.length).toBe(11);
    // 两模板 agent 并集 (3+3=6) 全部有效
    expect(r.effective_agents.length).toBe(6);
  });

  it('多模板：副模板与主模板同 id → 去重跳过', () => {
    const space = makeSpace({
      primary_template_id: 'student',
      secondary_template_ids: ['student', 'scholar'],
    });
    const valid = {
      skills: new Set([
        '0e847fc8685e','3def7f0eb34a','4a8054f512e9','4bb1813c8335','aef5bf07573f',
        '17b2d5e85d87','2b7f7c8621d5','4ff31e1cab6f','6c5609e76cf0','86cea925e282',
      ]),
      agents: new Set([
        '3bf780cd23be','54f102b6c1ee','5a5fe1598ed0',
        '37054bcc1740','57f6f828af9f','a37e8dbcc57e',
      ]),
    };
    const r = resolveSpaceResources(space, valid);
    // secondary_templates 不含同 id 的主模板
    expect(r.secondary_templates.length).toBe(1);
    expect(r.secondary_templates[0].template_id).toBe('scholar');
    // 不重复计数
    expect(r.effective_skills.length).toBe(10);
  });

  it('兼容旧 template_id 字段 = primary_template_id', () => {
    // 旧数据只有 template_id，无 primary
    const space = makeSpace({ template_id: 'student', extra_skills: ['sk-a'] });
    const valid = {
      skills: new Set(['0e847fc8685e','3def7f0eb34a','4a8054f512e9','4bb1813c8335','aef5bf07573f','sk-a']),
      agents: new Set(['3bf780cd23be','54f102b6c1ee','5a5fe1598ed0']),
    };
    const r = resolveSpaceResources(space, valid);
    expect(r.template?.template_id).toBe('student');
    expect(r.secondary_templates).toEqual([]);
    expect(r.effective_skills.length).toBe(6);
  });
});

describe('spaces › parseTemplateFileBundle（自定义模板捆绑声明）', () => {
  it('解析 `> 捆绑技能:` / `> 捆绑智能体:` 声明行', () => {
    const text = [
      '> 模板: my-tpl@1.0.0',
      '> 捆绑技能: sk-a, sk-b',
      '> 捆绑智能体: ag-1',
      '',
      '## 课程',
      '### 课程名称',
    ].join('\n');
    const b = parseTemplateFileBundle(text);
    expect(b).toEqual({ skill_ids: ['sk-a', 'sk-b'], agent_ids: ['ag-1'] });
  });

  it('无声明行 → 空捆绑', () => {
    const b = parseTemplateFileBundle('## 课程\n### 课程名称\n');
    expect(b).toEqual({ skill_ids: [], agent_ids: [] });
  });

  it('声明行值带逗号/空白被拆分与 trim', () => {
    const text = '> 捆绑技能:  sk-a ,  sk-b  \n> 捆绑智能体: ag-1, ag-2';
    const b = parseTemplateFileBundle(text);
    expect(b.skill_ids).toEqual(['sk-a', 'sk-b']);
    expect(b.agent_ids).toEqual(['ag-1', 'ag-2']);
  });
});

describe('spaces › CRUD', () => {
  it('create → list → get → update → delete 全链路', async () => {
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: '毕业论文' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sid = created.space.space_id;
    expect(sid).toMatch(/^sp_[0-9a-f]{12}$/);
    expect(created.space.name).toBe('毕业论文');

    const list = await spaces.listSpaces(TEST_UID);
    expect(list.length).toBe(1);
    expect(list[0].space_id).toBe(sid);
    expect(list[0].template_name).toBeUndefined();
    expect(list[0].skill_count).toBe(0);

    const got = await spaces.getSpace(TEST_UID, sid);
    expect(got?.space_id).toBe(sid);

    const renamed = await spaces.updateSpace(TEST_UID, sid, { name: '论文 v2' });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.space.name).toBe('论文 v2');
    expect(renamed.space.updated_at >= created.space.created_at).toBe(true);

    const del = await spaces.deleteSpace(TEST_UID, sid);
    expect(del.ok).toBe(true);
    expect((await spaces.listSpaces(TEST_UID)).length).toBe(0);
  });

  it('create 拒绝空名 / 重名', async () => {
    const spaces = await loadSpaces();
    const r1 = await spaces.createSpace(TEST_UID, { name: '  ' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe('name_empty');

    const ok = await spaces.createSpace(TEST_UID, { name: 'Alpha' });
    expect(ok.ok).toBe(true);
    const dup = await spaces.createSpace(TEST_UID, { name: 'alpha' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toBe('name_dup');
  });

  it('create 可带 primary_template_id + secondary_template_ids；兼容旧字段归一化', async () => {
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, {
      name: '多角色空间',
      primary_template_id: 'student',
      secondary_template_ids: ['scholar', 'fde'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.space.primary_template_id).toBe('student');
    expect(created.space.template_id).toBe('student'); // 同步兼容字段
    expect(created.space.secondary_template_ids).toEqual(['scholar', 'fde']);

    // 旧 template_id 兼容 create
    const oldStyle = await spaces.createSpace(TEST_UID, { name: '旧款空间', template_id: 'scholar' });
    expect(oldStyle.ok).toBe(true);
    if (!oldStyle.ok) return;
    expect(oldStyle.space.primary_template_id).toBe('scholar');
    expect(oldStyle.space.template_id).toBe('scholar');
    expect(oldStyle.space.secondary_template_ids).toEqual([]);

    // update 换主+副模板
    const swapped = await spaces.updateSpace(TEST_UID, created.space.space_id, {
      primary_template_id: 'product_manager',
      secondary_template_ids: [],
    });
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;
    expect(swapped.space.primary_template_id).toBe('product_manager');
    expect(swapped.space.secondary_template_ids).toEqual([]);
  });

  it('create 可带 template_id + icon；update 可换模板且保留 extra', async () => {
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: '学生空间', template_id: 'student', icon: '📘' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.space.template_id).toBe('student');
    expect(created.space.icon).toBe('📘');

    await spaces.addSpaceResource(TEST_UID, created.space.space_id, 'skill', 'sk-a');
    const swapped = await spaces.updateSpace(TEST_UID, created.space.space_id, { template_id: 'scholar' });
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;
    expect(swapped.space.template_id).toBe('scholar');
    expect(swapped.space.extra_skills).toEqual(['sk-a']); // 换模板保留 extra
  });

  it('资源增删：去重追加 / 移除', async () => {
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: 'R' });
    if (!created.ok) throw new Error('create failed');
    const sid = created.space.space_id;

    const a1 = await spaces.addSpaceResource(TEST_UID, sid, 'skill', 'sk-a');
    expect(a1.ok).toBe(true);
    const a2 = await spaces.addSpaceResource(TEST_UID, sid, 'skill', 'sk-a'); // 去重
    if (!a2.ok) throw new Error('add failed');
    expect(a2.resources.extra_skills).toEqual(['sk-a']);

    const r = await spaces.removeSpaceResource(TEST_UID, sid, 'skill', 'sk-a');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resources.extra_skills).toEqual([]);
  });

  it('deleteSpace 删除带资产绑定的空间（路线 A 引用不阻碍删除）', async () => {
    const spaces = await loadSpaces();
    const space = await spaces.createSpace(TEST_UID, { name: 'S' });
    if (!space.ok) throw new Error('create failed');
    const bind = await spaces.bindSpaceAsset(TEST_UID, space.space.space_id, {
      asset_id: 'asset-a',
      version: '1.0.0',
    });
    expect(bind.ok).toBe(true);

    const del = await spaces.deleteSpace(TEST_UID, space.space.space_id);
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(await spaces.getSpace(TEST_UID, space.space.space_id)).toBeNull();
    expect((await spaces.listSpaces(TEST_UID)).some((s) => s.space_id === space.space.space_id)).toBe(false);
  });

  it('deleteSpace 清空该空间会话的 space_id（会话落到最近任务，不残留）', async () => {
    const spaces = await loadSpaces();
    const chats = await import('../../../src/main/features/chats');
    const created = await spaces.createSpace(TEST_UID, { name: '待删空间' });
    if (!created.ok) throw new Error('create failed');
    const sid = created.space.space_id;
    // 两条会话绑定到该空间
    const c1 = await chats.createConversation(TEST_UID, { title: 'a', spaceId: sid });
    const c2 = await chats.createConversation(TEST_UID, { title: 'b', spaceId: sid });
    expect((await chats.listSpaceConversations(TEST_UID, sid)).length).toBe(2);

    const del = await spaces.deleteSpace(TEST_UID, sid);
    expect(del.ok).toBe(true);

    // 会话 space_id 已清空（落到最近任务），不再归属已删空间
    const back1 = await chats.getConversation(TEST_UID, c1.conversation_id);
    const back2 = await chats.getConversation(TEST_UID, c2.conversation_id);
    expect(back1?.space_id).toBeUndefined();
    expect(back2?.space_id).toBeUndefined();
    expect((await chats.listSpaceConversations(TEST_UID, sid)).length).toBe(0);
  });

  it('pruneInvalidSpaceResources 清理失效引用', async () => {
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: 'P' });
    if (!created.ok) throw new Error('create failed');
    await spaces.addSpaceResource(TEST_UID, created.space.space_id, 'skill', '__gone__');
    await spaces.addSpaceResource(TEST_UID, created.space.space_id, 'skill', 'sk-a');

    const pruned = await spaces.pruneInvalidSpaceResources(TEST_UID, created.space.space_id, validAll);
    expect(pruned.ok).toBe(true);
    if (!pruned.ok) return;
    expect(pruned.removed).toEqual(['__gone__']);
    const got = await spaces.getSpace(TEST_UID, created.space.space_id);
    expect(got?.extra_skills).toEqual(['sk-a']);
  });

  it('空间文件损坏 → getSpace 返回 null（降级不抛错）', async () => {
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: 'X' });
    if (!created.ok) throw new Error('create failed');
    const meta = path.join(tmpDir, TEST_UID, 'cloud', 'spaces', `${created.space.space_id}.json`);
    fs.writeFileSync(meta, '{ broken json', 'utf-8');
    const got = await spaces.getSpace(TEST_UID, created.space.space_id);
    expect(got).toBeNull();
    // listSpaces 跳过坏文件
    const list = await spaces.listSpaces(TEST_UID);
    expect(list.length).toBe(0);
  });
});

describe('spaces › resolveSpaceScope（会话作用域，T4.1）', () => {
  it('spaceId 空 → null（全局可见）', async () => {
    const spaces = await loadSpaces();
    expect(await spaces.resolveSpaceScope(TEST_UID, null)).toBeNull();
    expect(await spaces.resolveSpaceScope(TEST_UID, '')).toBeNull();
    expect(await spaces.resolveSpaceScope(TEST_UID, undefined)).toBeNull();
  });

  it('空间不存在 → null（降级全局可见）', async () => {
    const spaces = await loadSpaces();
    expect(await spaces.resolveSpaceScope(TEST_UID, 'sp_nonexistent')).toBeNull();
  });

  it('空配置（无模板无 extra）→ null（裁决 S1：全局可见）', async () => {
    visibleSkillIds.clear();
    visibleAgentIds.clear();
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: '空空间' });
    if (!created.ok) throw new Error('create failed');
    expect(await spaces.resolveSpaceScope(TEST_UID, created.space.space_id)).toBeNull();
  });

  it('有有效 extra 技能/智能体 → 严格作用域 {skills, agents}', async () => {
    visibleSkillIds.clear();
    visibleAgentIds.clear();
    visibleSkillIds.add('sk-a');
    visibleAgentIds.add('ag-1');
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: '作用域空间' });
    if (!created.ok) throw new Error('create failed');
    await spaces.addSpaceResource(TEST_UID, created.space.space_id, 'skill', 'sk-a');
    await spaces.addSpaceResource(TEST_UID, created.space.space_id, 'agent', 'ag-1');
    const scope = await spaces.resolveSpaceScope(TEST_UID, created.space.space_id);
    expect(scope).toEqual({ skills: ['sk-a'], agents: ['ag-1'] });
  });

  it('全部引用失效 → null（派生集全空 → 全局可见，S1）', async () => {
    visibleSkillIds.clear();
    visibleAgentIds.clear();
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: '失效空间' });
    if (!created.ok) throw new Error('create failed');
    await spaces.addSpaceResource(TEST_UID, created.space.space_id, 'skill', '__gone__');
    expect(await spaces.resolveSpaceScope(TEST_UID, created.space.space_id)).toBeNull();
  });
});

describe('spaces › listSpaces 失效数（真实有效集合，P3394 假阳性回归）', () => {
  // student bundle: 5 cogseed skills + 3 cogseed agents
  const BUNDLE_SKILLS = ['0e847fc8685e', '3def7f0eb34a', '4a8054f512e9', '4bb1813c8335', 'aef5bf07573f'];
  const BUNDLE_AGENTS = ['3bf780cd23be', '54f102b6c1ee', '5a5fe1598ed0'];

  beforeEach(() => {
    visibleSkillIds.clear();
    visibleAgentIds.clear();
  });

  it('引用全部有效 → invalid_count = 0（空集合假阳性回归）', async () => {
    BUNDLE_SKILLS.forEach((id) => visibleSkillIds.add(id));
    BUNDLE_AGENTS.forEach((id) => visibleAgentIds.add(id));
    visibleSkillIds.add('sk-a');
    visibleAgentIds.add('ag-1');

    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: '有效空间', template_id: 'student' });
    if (!created.ok) throw new Error('create failed');
    await spaces.addSpaceResource(TEST_UID, created.space.space_id, 'skill', 'sk-a');
    await spaces.addSpaceResource(TEST_UID, created.space.space_id, 'agent', 'ag-1');

    const list = await spaces.listSpaces(TEST_UID);
    const me = list.find((s) => s.space_id === created.space.space_id);
    expect(me).toBeDefined();
    expect(me?.skill_count).toBe(6); // bundle 5 + extra 1
    expect(me?.agent_count).toBe(4); // bundle 3 + extra 1
    expect(me?.invalid_count).toBe(0); // 全有效 → 不误报失效
  });

  it('失效引用计入 invalid_count，有效引用不误报', async () => {
    BUNDLE_SKILLS.forEach((id) => visibleSkillIds.add(id));
    BUNDLE_AGENTS.forEach((id) => visibleAgentIds.add(id));
    // sk-a 有效、__gone__ 无效
    visibleSkillIds.add('sk-a');

    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: '混合空间', template_id: 'student' });
    if (!created.ok) throw new Error('create failed');
    await spaces.addSpaceResource(TEST_UID, created.space.space_id, 'skill', 'sk-a');
    await spaces.addSpaceResource(TEST_UID, created.space.space_id, 'skill', '__gone__');
    await spaces.addSpaceResource(TEST_UID, created.space.space_id, 'agent', '__gone_agent__');

    const list = await spaces.listSpaces(TEST_UID);
    const me = list.find((s) => s.space_id === created.space.space_id);
    expect(me).toBeDefined();
    expect(me?.skill_count).toBe(7); // bundle 5 + extra 2（含失效）
    expect(me?.agent_count).toBe(4); // bundle 3 + extra 1（含失效）
    expect(me?.invalid_count).toBe(2); // 仅 2 个真失效
  });
});

describe('spaces › listSpaces 最近活跃会话（last_conversation_*）', () => {
  beforeEach(() => {
    visibleSkillIds.clear();
    visibleAgentIds.clear();
  });

  it('有会话 → 取最近活跃会话标题/时间；无会话 → 字段缺省', async () => {
    const spaces = await loadSpaces();
    const empty = await spaces.createSpace(TEST_UID, { name: '空会话空间' });
    if (!empty.ok) throw new Error('create failed');
    const busy = await spaces.createSpace(TEST_UID, { name: '有会话空间' });
    if (!busy.ok) throw new Error('create failed');

    const chats = await import('../../../src/main/features/chats');
    await chats.createConversation(TEST_UID, { spaceId: busy.space.space_id, title: '第一条旧任务' });
    const c2 = await chats.createConversation(TEST_UID, { spaceId: busy.space.space_id, title: '最近任务' });
    // nowIso 秒级精度：用 bump 把 c2 活动时间往后拨 1 秒，保证最近活跃序稳定
    const later = new Date(Date.now() + 1000);
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const laterTs = `${later.getFullYear()}-${pad2(later.getMonth() + 1)}-${pad2(later.getDate())}T${pad2(later.getHours())}:${pad2(later.getMinutes())}:${pad2(later.getSeconds())}`;
    await chats.bumpConversationActivity(TEST_UID, c2.conversation_id, laterTs);

    const list = await spaces.listSpaces(TEST_UID);
    const meEmpty = list.find((s) => s.space_id === empty.space.space_id);
    const meBusy = list.find((s) => s.space_id === busy.space.space_id);
    expect(meEmpty?.last_conversation_title).toBeUndefined();
    expect(meEmpty?.last_conversation_at).toBeUndefined();
    expect(meBusy?.last_conversation_title).toBe('最近任务');
    expect(meBusy?.last_conversation_at).toBeTruthy();
  });
});
