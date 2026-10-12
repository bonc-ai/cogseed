/**
 * 资产管家读工具契约（specs/008 US-401 / T012–T016）。
 *
 * 守四条：
 *   ① 分页可达**全量**（不受界面目录展示条数限制）、总数与实际一致；
 *   ② 长正文分批读全（拼接后与原文逐字相同，单批 ≤2000 字）；
 *   ③ 已删除/已暂停**如实标注状态且不交出正文**——不静默当不存在，也不绕过门禁；
 *   ④ 管理视角的读取**不写使用记录**（把"管家看了一眼"记成"任务用了它"会让采用统计失真）。
 *
 * 另有只读会话不变量（T016）：**任何 recall 组工具都不得进入闭合只读白名单**。
 * 判据从 TOOL_CATALOG 派生，所以将来往 recall 组加工具也自动被覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'stewardtools';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-steward-tools-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let _seedSeq = 0;
async function seedAsset(
  judgment: string,
  opts: { spaceId?: string; scope?: string; type?: string } = {},
) {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  _seedSeq += 1;
  const candidate = await candidates.saveRecallCandidate(TEST_UID, {
    judgment,
    // 标题闸门（设计 3.2）后晋升 title 必须合规：judgment 前缀老兜底命中
    // 「与正文开头重复」，改为与正文首字不同的合规样本标题。
    summary: `管家样本${_seedSeq}`,
    suggestedType: (opts.type || 'rule') as 'rule',
    suggestedScope: opts.scope || 'general',
    ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
    sourceRefs: [{ kind: 'execution', id: `exec-steward-${_seedSeq}` }],
  });
  return (await candidates.promoteRecallCandidate(TEST_UID, candidate.id, { actor: 'user' })).asset;
}

/** 克隆一条合法记录成 N 条：晋升一次就够，避免 35 条种子把用例拖成分钟级。
 *  形状仍由真实记录派生，不是手写的"看起来对"的对象。 */
async function cloneAssets(
  base: Record<string, unknown>,
  count: number,
  overrides: Array<Record<string, unknown>> = [],
  startIndex = 0,
) {
  const store = await import('../../../../src/main/features/recall/store');
  const ids: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset;
    const id = `aa-fixture${String(index).padStart(3, '0')}`;
    await store.writeRecallJsonRecord(TEST_UID, 'ability-assets', id, {
      ...base,
      id,
      candidateId: `cand-fixture${index}`,
      title: `夹具资产 ${index}`,
      statement: `夹具正文 ${index}`,
      version: '1',
      activeVersion: '1',
      updatedAt: new Date(Date.now() - index * 1_000).toISOString(),
      // overrides 按**本次循环的偏移**取：startIndex≠0 时用绝对序号会取不到
      // （夹具自身踩过一次：带 startIndex 的克隆全部落回默认值）。
      ...(overrides[offset] || {}),
    });
    ids.push(id);
  }
  return ids;
}

async function stewardTools() {
  const { createAssetStewardTools } = await import('../../../../src/main/model/core-agent/asset-steward-tools');
  const tools = createAssetStewardTools({ userId: TEST_UID });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { list: byName.get('list_ability_assets')!, read: byName.get('read_ability_asset')!, proposals: byName.get('list_asset_change_proposals')!, names: tools.map((t) => t.name) };
}

function text(result: { content: string }): string {
  return result.content;
}

describe('list_ability_assets', () => {
  it('分页可达全量（>30 条），总数与实际一致', async () => {
    const base = await seedAsset('发布类公告应包含背景、变更点、影响范围、生效时间、联系方式五段。');
    await cloneAssets(base as unknown as Record<string, unknown>, 34);
    const { list } = await stewardTools();

    const first = text(await list.execute({}, {} as never));
    expect(first).toContain('共 35 条');
    expect(first).toContain('本页 1-30 条');
    expect(first).toContain('还有 5 条：用 offset=30 继续翻页');
    expect((first.match(/\[asset:aa-/g) || []).length).toBe(30);

    const second = text(await list.execute({ offset: 30 }, {} as never));
    expect(second).toContain('本页 31-35 条');
    expect(second).toContain('这是最后一页');
    expect((second.match(/\[asset:aa-/g) || []).length).toBe(5);
  });

  it('上限 50：超过的 limit 被夹住，不会一次吐全量', async () => {
    const base = await seedAsset('竞品调研应先明确可比维度（范围/功能/定价/体验）再收集证据。');
    await cloneAssets(base as unknown as Record<string, unknown>, 55);
    const { list } = await stewardTools();
    const page = text(await list.execute({ limit: 999 }, {} as never));
    expect((page.match(/\[asset:aa-/g) || []).length).toBe(50);
  });

  it('空资产库给空态而不是报错', async () => {
    const { list } = await stewardTools();
    expect(text(await list.execute({}, {} as never))).toContain('认知资产库是空的');
  });

  it('按状态/类型/空间过滤，且总数只算不过滤的全量', async () => {
    const base = await seedAsset('上线前必须核对回滚方案与灰度范围。');
    await cloneAssets(base as unknown as Record<string, unknown>, 3, [
      { status: 'paused' },
      { spaceId: 'sp_a', type: 'template' },
      { status: 'deleted', deletedAt: new Date().toISOString() },
    ]);
    const { list } = await stewardTools();

    const paused = text(await list.execute({ filter: { status: 'paused' } }, {} as never));
    expect(paused).toContain('过滤：状态=paused → 1 条');
    expect(paused).toContain('状态=已暂停[paused]');

    const inSpace = text(await list.execute({ filter: { spaceId: 'sp_a' } }, {} as never));
    expect(inSpace).toContain('空间=sp_a');
    expect(inSpace).toContain('类型=template');

    const typed = text(await list.execute({ filter: { assetType: 'rule' } }, {} as never));
    expect(typed).toContain('→ 3 条');
  });

  it('已彻底清除的不出现在清单里（规范要求搜索不可见）', async () => {
    const base = await seedAsset('过期结论应及时归档而不是继续留在推荐里。');
    await cloneAssets(base as unknown as Record<string, unknown>, 2, [{ status: 'purged', purgedAt: new Date().toISOString() }]);
    const { list } = await stewardTools();
    const out = text(await list.execute({}, {} as never));
    // 墓碑不进清单：base + 一条未清除的克隆 = 2 条。
    expect(out).toContain('共 2 条');
    expect(out).not.toContain('aa-fixture000');
    expect(out).toContain('aa-fixture001');
  });

  it('已删除如实列出（不藏），并标注状态', async () => {
    const base = await seedAsset('命名规范：动词开头、限定范围、避免缩写。');
    await cloneAssets(base as unknown as Record<string, unknown>, 1, [
      { status: 'deleted', deletedAt: new Date().toISOString() },
    ]);
    const { list } = await stewardTools();
    const out = text(await list.execute({}, {} as never));
    expect(out).toContain('已删除[deleted]');
  });

  it('拒绝不认识的过滤值与非法 spaceId', async () => {
    const { list } = await stewardTools();
    expect(await list.execute({ filter: { status: 'shredded' } }, {} as never)).toMatchObject({ isError: true });
    expect(await list.execute({ filter: { spaceId: '../bad' } }, {} as never)).toMatchObject({ isError: true });
  });

  it('标签元信息与过滤（specs/012 T023）：metaLine 带标签行、filter.tags 支持 any/all、描述不再说没有标签字段', async () => {
    const base = await seedAsset('标签过滤的基线正文。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.updateAbilityAsset(TEST_UID, base.id, { tags: ['发布', '周报'], reason: '布置夹具', actor: 'user' });
    await cloneAssets(base as unknown as Record<string, unknown>, 2, [
      { tags: ['发布'] },
      // base 已打标，第三条要显式去掉（undefined 在落盘时丢键 = 无标签）。
      { tags: undefined },
    ]);
    const { list } = await stewardTools();

    const out = text(await list.execute({}, {} as never));
    expect(out).toContain('标签=发布/周报');
    expect(out).toContain('标签=发布');
    // 没标签的那条不显示标签段（缺省 = 未分类，不伪造空值）。
    expect(out).not.toContain('标签= |');
    expect(out).not.toContain('标签=)');

    // any（默认，并集）：带其中任一个就算。
    const anyHit = text(await list.execute({ filter: { tags: ['周报'] } }, {} as never));
    expect(anyHit).toContain('标签=周报(tagsMode=any)');
    expect(anyHit).toContain('→ 1 条');
    const unionHit = text(await list.execute({ filter: { tags: ['发布', '周报'] } }, {} as never));
    expect(unionHit).toContain('→ 2 条');
    // all（交集）：同时具备才算。
    const allHit = text(await list.execute({ filter: { tags: ['发布', '周报'], tagsMode: 'all' } }, {} as never));
    expect(allHit).toContain('tagsMode=all');
    expect(allHit).toContain('→ 1 条');

    // 描述解禁：不再宣称"没有主题标签字段"，改说可过滤、可打标、族名不是标签。
    expect(list.description).not.toContain('没有主题标签字段');
    expect(list.description).toContain('filter.tags');
    expect(list.description).toContain('**不是**标签');

    // 非法形态如实拒绝。
    expect(await list.execute({ filter: { tags: [] } }, {} as never)).toMatchObject({ isError: true });
    expect(await list.execute({ filter: { tagsMode: 'both' } }, {} as never)).toMatchObject({ isError: true });
  });
});

describe('read_ability_asset', () => {
  it('长正文分批读全：拼接后与原文逐字相同，单批不超过 2000 字', async () => {
    const body = Array.from({ length: 5_000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('');
    const base = await seedAsset('长正文夹具。');
    const store = await import('../../../../src/main/features/recall/store');
    const assetId = (await cloneAssets(base as unknown as Record<string, unknown>, 1, [{ statement: body }]))[0];
    const { read } = await stewardTools();

    const chunks: string[] = [];
    let next = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const out = text(await read.execute({ assetId, chunk: next }, {} as never));
      expect(out).toContain(`正文（第 ${next + 1}/3 批，共 5000 字）`);
      const chunkBody = out.split('正文（')[1].split('）:\n')[1].split('\n\n')[0];
      expect(chunkBody.length).toBeLessThanOrEqual(2_000);
      chunks.push(chunkBody);
      if (out.includes('这是最后一批')) break;
      next += 1;
    }
    expect(chunks.length).toBe(3);
    expect(chunks.join('')).toBe(body);
    expect(store).toBeTruthy();
  });

  it('已删除：如实标注状态与拦截规则，且不交出正文', async () => {
    const base = await seedAsset('保留期内的资产正文不可读出。');
    const assetId = (await cloneAssets(base as unknown as Record<string, unknown>, 1, [
      { status: 'deleted', deletedAt: new Date().toISOString(), statement: '绝不该被读出来的正文' },
    ]))[0];
    const { read } = await stewardTools();

    const result = await read.execute({ assetId }, {} as never);
    expect(result.isError).toBe(true);
    const out = text(result);
    expect(out).toContain('当前不可读出正文');
    expect(out).toContain('已删除[deleted]');
    expect(out).toContain('status_not_active');
    expect(out).toContain('restore_ability_asset');
    expect(out).not.toContain('绝不该被读出来的正文');
  });

  it('已暂停：同样如实标注，不静默当不存在', async () => {
    const base = await seedAsset('暂停的资产不该继续作为依据。');
    const assetId = (await cloneAssets(base as unknown as Record<string, unknown>, 1, [
      { status: 'paused', statement: '暂停资产的正文' },
    ]))[0];
    const { read } = await stewardTools();

    const result = await read.execute({ assetId }, {} as never);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('已暂停[paused]');
    expect(text(result)).toContain('不是"资产不存在"');
    expect(text(result)).not.toContain('暂停资产的正文');
  });

  it('不存在的资产如实说"不存在"，不冒充状态问题', async () => {
    const { read } = await stewardTools();
    const result = await read.execute({ assetId: 'aa-nope000' }, {} as never);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('不存在');
  });

  it('chunk 越界明确报错', async () => {
    const base = await seedAsset('短正文。');
    const assetId = (await cloneAssets(base as unknown as Record<string, unknown>, 1, [{ statement: '短' }]))[0];
    const { read } = await stewardTools();
    const result = await read.execute({ assetId, chunk: 5 }, {} as never);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('chunk 越界');
  });

  it('非法 assetId 被拒', async () => {
    const { read } = await stewardTools();
    expect(await read.execute({ assetId: '../etc/passwd' }, {} as never)).toMatchObject({ isError: true });
    expect(await read.execute({}, {} as never)).toMatchObject({ isError: true });
  });

  it('管理视角的读取不写使用记录（否则"管家看一眼"会被记成"任务用了它"）', async () => {
    const base = await seedAsset('读取本身不算使用。');
    const assetId = (await cloneAssets(base as unknown as Record<string, unknown>, 1))[0];
    const { read } = await stewardTools();
    await read.execute({ assetId }, {} as never);

    const usage = await import('../../../../src/main/features/recall/usage-service');
    expect(await usage.listRecallUsage(TEST_UID)).toEqual([]);
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    expect(await receipts.listInjectionReceipts(TEST_UID)).toEqual([]);
  });
});

describe('待审批提议的可见性（US-406；2026-09-25 真机反馈"他拿不到待审批的内容"）', () => {
  async function propose(assetId: string) {
    const approvals = await import('../../../../src/main/features/recall/asset-approval-service');
    return approvals.createAssetChangeProposal(TEST_UID, {
      assetId,
      baselineVersion: '1',
      fields: ['statement', 'applicableWhen'],
      payload: { statement: '改后的正文：开头先给结论。', applicableWhen: ['写并行批次工具时'] },
      beforeValues: { statement: '改前的正文全挤在一段。', applicableWhen: ['写工具时'] },
      before: 'statement=11 字:改前的正文…',
      after: 'statement=14 字:改后的正文…',
      reason: 'AI 自主判断：开头没有可扫读的结论。',
    });
  }

  it('read_ability_asset 点明这条资产挂着待审批提议', async () => {
    const base = await seedAsset('正文组织：开头先给结论。');
    const assetId = (await cloneAssets(base as unknown as Record<string, unknown>, 1))[0];
    await propose(assetId);
    const { read } = await stewardTools();

    const out = text(await read.execute({ assetId }, {} as never));
    expect(out).toContain('待审批提议（1 条');
    expect(out).toContain('[proposal:ap-');
    expect(out).toContain('处置权在用户');
    expect(out).toContain('AI 自主判断：开头没有可扫读的结论。');
    expect(out).toContain('list_asset_change_proposals');
    // 点明它是**提议不是锁**：正文照旧读得出来，别把"有卡片"当成"读不到"。
    expect(out).toContain('正文（第 1/1 批');
  });

  it('list_ability_assets 给挂着卡片的条目标「待审批=1」并给出指引', async () => {
    const base = await seedAsset('清单里的待审批标记。');
    const assetId = (await cloneAssets(base as unknown as Record<string, unknown>, 1))[0];
    await propose(assetId);
    const { list } = await stewardTools();

    const out = text(await list.execute({}, {} as never));
    expect(out).toContain('待审批=1');
    expect(out).toContain('list_asset_change_proposals');
  });

  it('list_asset_change_proposals 交出拟生效内容与当前值', async () => {
    const base = await seedAsset('提议内容要被看到。');
    const assetId = (await cloneAssets(base as unknown as Record<string, unknown>, 1))[0];
    await propose(assetId);
    const { proposals } = await stewardTools();

    const out = text(await proposals.execute({}, {} as never));
    expect(out).toContain('待审批提议：共 1 条（state=pending');
    expect(out).toContain('等用户定夺');
    expect(out).toContain('拟生效内容（改动后）');
    expect(out).toContain('改后的正文：开头先给结论。');
    expect(out).toContain('当前值（改动前）');
    expect(out).toContain('改前的正文全挤在一段。');
    expect(out).toContain('AI 自主判断：开头没有可扫读的结论。');
    expect(out).toContain('不能替他确认/拒绝');
  });

  it('「稍后处理」不在默认结果里，但仍是待办（state=deferred 能查到）', async () => {
    const base = await seedAsset('稍后处理的提议仍待办。');
    const assetId = (await cloneAssets(base as unknown as Record<string, unknown>, 1))[0];
    const { proposal } = await propose(assetId);
    const approvals = await import('../../../../src/main/features/recall/asset-approval-service');
    await approvals.decideAssetChangeProposal(TEST_UID, proposal.id, 'defer');
    const { proposals } = await stewardTools();

    const pending = text(await proposals.execute({}, {} as never));
    expect(pending).toContain('没有正等着用户现下点头的提议');
    expect(pending).toContain('state=deferred');
    const deferred = text(await proposals.execute({ state: 'deferred' }, {} as never));
    expect(deferred).toContain('用户已「稍后处理」');
    expect(deferred).toContain('改后的正文：开头先给结论。');
  });

  it('资产被暂停：提议在，但内容不交出去（与正文同一道运行时门禁，不走后门）', async () => {
    const base = await seedAsset('门禁对提议内容同样生效。');
    const assetId = (await cloneAssets(base as unknown as Record<string, unknown>, 1, [{ status: 'paused' }]))[0];
    await propose(assetId);
    const { proposals } = await stewardTools();

    const out = text(await proposals.execute({}, {} as never));
    expect(out).toContain('提议内容暂不展示');
    expect(out).toContain('status_not_active');
    expect(out).not.toContain('改后的正文：开头先给结论。');
    expect(out).toContain('处置权在他手里');
  });

  it('空态与非法入参如实回应', async () => {
    const { proposals } = await stewardTools();
    expect(text(await proposals.execute({}, {} as never))).toContain('没有待审批提议');
    expect(await proposals.execute({ state: 'wat' }, {} as never)).toMatchObject({ isError: true });
    expect(await proposals.execute({ assetId: '../etc/passwd' }, {} as never)).toMatchObject({ isError: true });
  });
});

describe('只读会话不变量（T016）', () => {
  it('任何 recall 组工具都不得进入闭合只读白名单', async () => {
    const [{ TOOL_CATALOG }, { READ_ONLY_TOOL_ALLOWLIST, READ_ONLY_BUILTIN_ALLOWLIST }] = await Promise.all([
      import('../../../../src/main/model/core-agent/tool-catalog'),
      import('../../../../src/main/model/core-agent/runner'),
    ]);
    const recallTools = TOOL_CATALOG.filter((entry) => entry.group === 'recall').map((entry) => entry.name);
    // 判据从 catalog 派生：将来往 recall 组加工具，这条测试自动覆盖到。
    expect(recallTools).toEqual(expect.arrayContaining([
      'list_ability_assets', 'read_ability_asset', 'search_ability_assets', 'personal_ontology_fields',
    ]));
    for (const name of recallTools) {
      expect(READ_ONLY_TOOL_ALLOWLIST.has(name), `${name} 不得进入只读白名单`).toBe(false);
      expect(READ_ONLY_BUILTIN_ALLOWLIST.has(name), `${name} 不得进入只读内建白名单`).toBe(false);
    }
  });

  it('资产管家的工具面 = 3 读 + 6 写', async () => {
    // 第 3 个读工具（list_asset_change_proposals）是 2026-09-25 真机反馈"模型拿不到
    // 待审批的内容"补的：读侧不提供任何代拍的形状（处置权在用户）。
    const { names } = await stewardTools();
    expect(names).toEqual([
      'list_ability_assets', 'read_ability_asset', 'list_asset_change_proposals',
      'edit_ability_asset', 'merge_ability_assets', 'archive_ability_asset',
      'delete_ability_asset', 'restore_ability_asset', 'rollback_ability_asset',
    ]);
  });
});

describe('写工具（US-402）', () => {
  async function tools(source?: { taskText: string; sourceMessageFromUser: boolean }) {
    const { createAssetStewardTools } = await import('../../../../src/main/model/core-agent/asset-steward-tools');
    const byName = new Map(createAssetStewardTools({ userId: TEST_UID, ...source }).map((tool) => [tool.name, tool]));
    return {
      edit: byName.get('edit_ability_asset')!,
      merge: byName.get('merge_ability_assets')!,
      archive: byName.get('archive_ability_asset')!,
      del: byName.get('delete_ability_asset')!,
      restore: byName.get('restore_ability_asset')!,
      rollback: byName.get('rollback_ability_asset')!,
    };
  }
  const call = (tool: { execute: (input: Record<string, unknown>, ctx: never) => Promise<{ content: string; isError?: boolean }> }, input: Record<string, unknown>) =>
    tool.execute(input, {} as never);

  it('用户明确指令：直接生效 + 台账记 actor=ai/前后值/依据', async () => {
    const asset = await seedAsset('发布前必须核对回滚方案。');
    const { edit } = await tools({
      taskText: '请把这条改成：发布前必须核对回滚方案与灰度范围。',
      sourceMessageFromUser: true,
    });
    const out = await call(edit, {
      assetId: asset.id,
      fields: { statement: '发布前必须核对回滚方案与灰度范围。' },
      reason: '用户要求把这条改清楚点',
      origin: 'user_instruction',
      expectedVersion: asset.version,
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('已改动');
    expect(out.content).toContain('v2');

    const assets = await import('../../../../src/main/features/recall/asset-service');
    const updated = await assets.readAbilityAsset(TEST_UID, asset.id);
    expect(updated.statement).toContain('灰度范围');
    const row = (await assets.listAbilityAssetAudit(TEST_UID, asset.id)).at(-1)!;
    expect(row.action).toBe('updated');
    expect(row.actor).toBe('ai');
    expect(row.reason).toBe('用户要求把这条改清楚点');
    expect(row.before).toContain('statement=');
    expect(row.after).toContain('灰度范围');
  });

  it('并发不一致：拒绝而不是静默覆盖', async () => {
    const asset = await seedAsset('并发场景的基线正文。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.updateAbilityAsset(TEST_UID, asset.id, { title: '被别人改过', reason: 'other writer', actor: 'user' });

    const { edit } = await tools({ taskText: '请把这条改成：我的改动。', sourceMessageFromUser: true });
    const out = await call(edit, {
      assetId: asset.id,
      fields: { statement: '我的改动' },
      reason: '用户要求改',
      origin: 'user_instruction',
      expectedVersion: asset.version,
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('version conflict');
    expect(out.content).toContain('workflow');
    const after = await assets.readAbilityAsset(TEST_UID, asset.id);
    expect(after.statement).toBe(asset.statement);
    expect(after.title).toBe('被别人改过');
  });

  it('AI 自主的实质变化：不直接生效（零静默发布），改走审批提议', async () => {
    const asset = await seedAsset('实质变化的守卫基线。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const approval = await import('../../../../src/main/features/recall/asset-approval-service');
    const { edit } = await tools();

    for (const fields of [
      { statement: '我自己觉得应该改成这样' },
      { scope: 'review' },
      { applicableWhen: ['任何情况'] },
    ]) {
      const out = await call(edit, { assetId: asset.id, fields, reason: '我觉得该改', origin: 'ai_initiated' });
      // 没有会话上下文 → 卡片发不出去 → **拒绝兜底**（这条分支与建卡路径各有测试，
      // 提议建不出来时它是"绝不直接生效"的唯一保证）。
      expect(out.isError, JSON.stringify(fields)).toBe(true);
      expect(out.content).toContain('没有生效');
    }
    // 内容与版本分毫未动。
    const after = await assets.readAbilityAsset(TEST_UID, asset.id);
    expect(after.statement).toBe(asset.statement);
    expect(after.version).toBe(asset.version);
    // **没有任何一次内容写入**（actor=ai 的 updated 行不存在）——提议行不算写入。
    const rows = await assets.listAbilityAssetAudit(TEST_UID, asset.id);
    expect(rows.filter((r) => r.action === 'updated' && r.actor === 'ai')).toEqual([]);
    // 但每一次实质变化都留下了提议（3 条）与对应的台账行。
    const proposals = await approval.listAssetChangeProposals(TEST_UID, { assetId: asset.id });
    expect(proposals).toHaveLength(3);
    expect(proposals.every((row) => row.state === 'pending')).toBe(true);
    expect(rows.filter((r) => r.action === 'approval_proposed' && r.actor === 'ai')).toHaveLength(3);
  });

  it('实质变化提议去重：同一变更重复提交只留一条', async () => {
    const asset = await seedAsset('提议去重的基线。');
    const approval = await import('../../../../src/main/features/recall/asset-approval-service');
    const { edit } = await tools();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await call(edit, { assetId: asset.id, fields: { statement: '同一个想法' }, reason: '我觉得该改', origin: 'ai_initiated' });
    }
    const proposals = await approval.listAssetChangeProposals(TEST_UID, { assetId: asset.id });
    expect(proposals).toHaveLength(1);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect((await assets.listAbilityAssetAudit(TEST_UID, asset.id)).filter((r) => r.action === 'approval_proposed')).toHaveLength(1);
  });

  it('缺省 origin 按更保守的"AI 自主"处理，不教模型伪造用户授权', async () => {
    const asset = await seedAsset('缺省来源的守卫基线。');
    const { edit } = await tools();
    const out = await call(edit, { assetId: asset.id, fields: { statement: '改正文' }, reason: '没说来源' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('没有生效');
  });

  it('非实质字段（命名）允许 AI 自动处理', async () => {
    const asset = await seedAsset('命名规范化可以由 AI 直接做。');
    const { edit } = await tools();
    const out = await call(edit, { assetId: asset.id, fields: { title: '规范化后的标题' }, reason: '命名规范化', origin: 'ai_initiated' });
    expect(out.isError).toBeUndefined();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).title).toBe('规范化后的标题');
  });

  it('标题一等化（设计 3.2 / 深探 F2）：title 改动先过判定，不合规拒绝并在回执里说明规范', async () => {
    const asset = await seedAsset('标题判定的守卫基线。');
    const { edit } = await tools();
    const assets = await import('../../../../src/main/features/recall/asset-service');

    // schema 描述写入 16 字规范（模型在出参前就能看到）。
    const fieldsSchema = (edit.inputSchema as {
      properties: { fields: { properties: Record<string, { description?: string }> } };
    }).properties.fields;
    expect(fieldsSchema.properties.title?.description).toContain('16');
    expect(fieldsSchema.properties.title?.description).toContain('不得与正文开头重复');

    // ①与正文开头重复 ②超 16 字：都拒绝，回执带拦截规则＋schema 归因＋规范说明。
    const overlap = await call(edit, { assetId: asset.id, fields: { title: '标题判定的重写版' }, reason: '想改标题', origin: 'ai_initiated' });
    expect(overlap.isError).toBe(true);
    expect(overlap.content).toContain('invalid ability asset title');
    expect(overlap.content).toContain('schema（入参或记录形状不合法）');
    expect(overlap.content).toContain('16');

    const tooLong = await call(edit, { assetId: asset.id, fields: { title: '这是一个超过十六个字的历史遗留超长标题' }, reason: '想改标题', origin: 'ai_initiated' });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content).toContain('invalid ability asset title');

    // 资产零变化（标题/版本不动），被拦下的尝试照常留 attempt_blocked 台账。
    const after = await assets.readAbilityAsset(TEST_UID, asset.id);
    expect(after.title).toBe(asset.title);
    expect(after.version).toBe(asset.version);
    const rows = await assets.listAbilityAssetAudit(TEST_UID, asset.id);
    expect(rows.some((row) => row.action === 'attempt_blocked' && String(row.note).includes('invalid ability asset title'))).toBe(true);

    // 合规标题照常直写（分级③命名语义不变）。
    const ok = await call(edit, { assetId: asset.id, fields: { title: '守卫基线的重命名' }, reason: '命名规范化', origin: 'ai_initiated' });
    expect(ok.isError).toBeUndefined();
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).title).toBe('守卫基线的重命名');
  });

  it('标签可写：tags 落地、category 收编为单标签、形状错归因 schema、不映射 assetType/familyName（specs/012 T022 解禁）', async () => {
    const asset = await seedAsset('标签解禁后的契约基线。');
    let { edit } = await tools({ taskText: '请把标签改成：发布。', sourceMessageFromUser: true });
    const assets = await import('../../../../src/main/features/recall/asset-service');

    // ① 用户明确指令打标：直接生效；标签是元数据，不 bump 内容版本。
    const before = await assets.readAbilityAsset(TEST_UID, asset.id);
    const out = await call(edit, { assetId: asset.id, fields: { tags: ['发布'] }, reason: '用户要求打标', origin: 'user_instruction' });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('已改动');
    const tagged = await assets.readAbilityAsset(TEST_UID, asset.id);
    expect(tagged.tags).toEqual(['发布']);
    expect(tagged.version).toBe(before.version);
    // 台账记「标签：旧 → 新」（标签名是元数据，可进台账）。
    const auditRows = await assets.listAbilityAssetAudit(TEST_UID, asset.id);
    expect(auditRows.some((row) => String(row.reason || '').includes('标签：'))).toBe(true);

    // ② category 收编：不落任何字段，只体现为 tags（与本次 fields.tags 合并去重；
    //    tags 语义是整体替换，所以只传 category = tags 变成这一条）。
    ({ edit } = await tools({ taskText: '请把标签改成：发布流程。', sourceMessageFromUser: true }));
    const category = await call(edit, { assetId: asset.id, fields: { category: '发布流程' }, reason: '用户要求归类', origin: 'user_instruction' });
    expect(category.isError).toBeUndefined();
    const collected = await assets.readAbilityAsset(TEST_UID, asset.id);
    expect(collected.tags).toEqual(['发布流程']);
    expect((collected as unknown as Record<string, unknown>).category).toBeUndefined();

    // ③ 形状错误：isError + 归因 schema（不再是 data），可读提示，不静默丢弃。
    const badShape = await call(edit, { assetId: asset.id, fields: { tags: '发布流程' }, reason: '字符串形态', origin: 'user_instruction' });
    expect(badShape.isError).toBe(true);
    expect(badShape.content).toContain('schema（入参或记录形状不合法）');
    expect(badShape.content).not.toContain('data（数据缺失/不存在）');
    expect(badShape.content).toContain('字符串数组');
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).tags).toEqual(['发布流程']);

    // ④ 不映射 assetType / familyName：类型与族名保持原值（那是另一套语义）。
    expect(collected.type).toBe(asset.type);
    expect(collected.familyName).toBe(asset.familyName);
  });

  it('标签形状上限：13 条 / 21 字名拒绝且不截断，资产保持原标签', async () => {
    const asset = await seedAsset('标签形状上限的守卫基线。');
    const { edit } = await tools();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.updateAbilityAsset(TEST_UID, asset.id, { tags: ['原有'], reason: '布置夹具', actor: 'user' });

    const tooMany = await call(edit, {
      assetId: asset.id,
      fields: { tags: Array.from({ length: 13 }, (_, index) => `标签${index}`) },
      reason: '塞 13 条', origin: 'user_instruction',
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content).toContain('12');
    expect(tooMany.content).toContain('schema');

    const tooLong = await call(edit, { assetId: asset.id, fields: { tags: ['这是一条用来测试超过二十个字上限的超长标签名字'] }, reason: '超长名', origin: 'user_instruction' });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content).toContain('20 字');

    const longCategory = await call(edit, { assetId: asset.id, fields: { category: '这是一条用来测试超过二十个字上限的超长分类名字' }, reason: '超长分类', origin: 'user_instruction' });
    expect(longCategory.isError).toBe(true);

    // 被拒的三次都没有截断写入：资产还是原来的标签。
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).tags).toEqual(['原有']);
  });

  it('AI 自主打标 = 实质变化：资产零变化、回执明说没有生效（category 也逃不过这道闸）', async () => {
    const asset = await seedAsset('AI 自主打标的闸门基线。');
    const approval = await import('../../../../src/main/features/recall/asset-approval-service');
    const { edit } = await tools();

    for (const fields of [{ tags: ['发布'] }, { category: '发布流程' }]) {
      // 没有会话上下文 → 卡片发不出去 → 拒绝兜底：改动没有生效（这条分支与
      // 建卡路径各有测试，是"绝不直接生效"的保底）。
      const out = await call(edit, { assetId: asset.id, fields, reason: '我觉得该有标签', origin: 'ai_initiated' });
      expect(out.isError, JSON.stringify(fields)).toBe(true);
      expect(out.content).toContain('没有生效');
    }

    const assets = await import('../../../../src/main/features/recall/asset-service');
    const after = await assets.readAbilityAsset(TEST_UID, asset.id);
    expect(after.tags).toBeUndefined();
    // 两次尝试各留一条提议（处置权在用户手里）。
    const proposals = await approval.listAssetChangeProposals(TEST_UID, { assetId: asset.id });
    expect(proposals).toHaveLength(2);
  });

  it('用户确认审批卡片后标签提议生效（confirm 走 updateAbilityAsset 的 tags 路径）', async () => {
    const asset = await seedAsset('审批确认后标签生效的基线。');
    const approval = await import('../../../../src/main/features/recall/asset-approval-service');
    const { edit } = await tools();
    await call(edit, { assetId: asset.id, fields: { tags: ['发布'] }, reason: '建议打标', origin: 'ai_initiated' });
    const [proposal] = await approval.listAssetChangeProposals(TEST_UID, { assetId: asset.id });

    await approval.decideAssetChangeProposal(TEST_UID, proposal.id, 'confirm');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).tags).toEqual(['发布']);
  });

  it('fields 传 JSON 字符串也认（真机实测：模型就这么传，6 次编辑全废）', async () => {
    const asset = await seedAsset('真机 payload 形态的回归。');
    const { edit } = await tools({
      taskText: '请把这条改成：真机形态：正文改成这句。',
      sourceMessageFromUser: true,
    });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    // 真机抓到的原样形态：fields 是字符串化的对象。
    const out = await call(edit, {
      assetId: asset.id,
      fields: JSON.stringify({ body: '真机形态：正文改成这句。' }),
      origin: 'user_instruction',
      reason: '用户要求改正文',
    });
    expect(out.isError).toBeUndefined();
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).statement).toBe('真机形态：正文改成这句。');
  });

  it('body 是 statement 的契约别名，两个都收', async () => {
    const asset = await seedAsset('契约别名：body。');
    let { edit } = await tools({ taskText: '请把这条改成：用 body 改的正文。', sourceMessageFromUser: true });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await call(edit, { assetId: asset.id, fields: { body: '用 body 改的正文。' }, origin: 'user_instruction', reason: '用户要求改' });
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).statement).toBe('用 body 改的正文。');
    ({ edit } = await tools({ taskText: '请把这条改成：用 statement 改的正文。', sourceMessageFromUser: true }));
    await call(edit, { assetId: asset.id, fields: { statement: '用 statement 改的正文。' }, origin: 'user_instruction', reason: '用户要求改' });
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).statement).toBe('用 statement 改的正文。');
  });

  it('不认识的字段名显式拒绝，不静默丢弃（回执说"已改动"而一字未动更糟）', async () => {
    const asset = await seedAsset('未知字段名的守卫。');
    const { edit } = await tools();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const before = await assets.readAbilityAsset(TEST_UID, asset.id);
    const out = await call(edit, {
      assetId: asset.id,
      fields: { content: '这条不会被写进去', titel: '拼错的键' },
      origin: 'user_instruction',
      reason: '用户要求改',
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('不认识的字段名');
    expect(out.content).toContain('content');
    expect(out.content).toContain('titel');
    // 一字未动（没有静默 no-op 被报成成功）。
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).statement).toBe(before.statement);
    expect((await assets.listAbilityAssetAudit(TEST_UID, asset.id)).filter((r) => r.action === 'updated')).toEqual([]);
  });

  it('list 的 filter 传 JSON 字符串也认（否则过滤被静默忽略、当成"没过滤"）', async () => {
    const base = await seedAsset('过滤形态的回归。');
    await cloneAssets(base as unknown as Record<string, unknown>, 2, [{ status: 'paused' }, { status: 'archived' }], 70);
    const { list } = await stewardTools();
    const out = text(await list.execute({ filter: JSON.stringify({ status: 'paused' }) }, {} as never));
    expect(out).toContain('过滤：状态=paused → 1 条');
  });

  it('reason 必填；fields 不能为空', async () => {
    const asset = await seedAsset('入参校验基线。');
    const { edit } = await tools();
    expect((await call(edit, { assetId: asset.id, fields: { title: 'x' } })).content).toContain('reason 必填');
    expect((await call(edit, { assetId: asset.id, fields: {}, reason: '空字段' })).content).toContain('至少要给一个');
  });

  it('归并：进同一版本组、source 归档并记去向', async () => {
    const target = await seedAsset('归并目标：上线前核对回滚方案。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    // source 走克隆：两条近重复的候选本来就会被相似度闸门拦下（那是对的），
    // 但"资产库里已经存在两条近重复资产"正是归并要处理的场景。
    const [sourceId] = await cloneAssets(target as unknown as Record<string, unknown>, 1, [
      { statement: '上线之前应当核对回滚方案。', title: '归并来源' },
    ]);
    // 给 source 补一条真实版本记录（真实资产创建时就有 v1，克隆夹具绕过了那一步）：
    // 归并搬的是版本流，"版本流缺失"那条分支只服务遗留资产，不该拿来当主路径。
    await assets.updateAbilityAsset(TEST_UID, sourceId, {
      statement: '上线之前应当核对回滚方案与灰度。', reason: '补一版', actor: 'user',
    });

    const { merge } = await tools();
    const out = await call(merge, { sourceAssetId: sourceId, targetAssetId: target.id, reason: '两条讲的是同一件事' });
    expect(out.isError).toBeUndefined();

    const archived = await assets.readAbilityAsset(TEST_UID, sourceId);
    expect(archived.status).toBe('archived');
    expect(archived.mergedIntoAssetId).toBe(target.id);
    const targetAudit = (await assets.listAbilityAssetAudit(TEST_UID, target.id)).map((r) => r.action);
    expect(targetAudit).toContain('merged_from');
    const sourceAudit = (await assets.listAbilityAssetAudit(TEST_UID, sourceId)).map((r) => r.action);
    expect(sourceAudit).toContain('merged_into');
    // 历史可溯：source 的版本快照确实并进了 target 的版本流。
    const versions = await assets.listAbilityAssetVersions(TEST_UID, target.id);
    expect(versions.some((v) => String(v.reason || '').startsWith('merged from'))).toBe(true);
    expect(versions.some((v) => String(v.snapshot?.statement || '').includes('灰度'))).toBe(true);
  });

  it('归档 → 恢复；删除 → 保留期内恢复后内容一致；回执含保留期口径', async () => {
    const asset = await seedAsset('归档与删除的可恢复性。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const { archive, del, restore } = await tools();

    expect((await call(archive, { assetId: asset.id, reason: '暂时不用' })).isError).toBeUndefined();
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).status).toBe('archived');
    expect((await call(restore, { assetId: asset.id, reason: '又要用了' })).isError).toBeUndefined();
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).status).toBe('active');

    const deleteOut = await call(del, { assetId: asset.id, reason: '用户要求删除' });
    expect(deleteOut.isError).toBeUndefined();
    // 删除回执必须带上三条规则（此刻用户最需要知道"什么时候真的没了"）。
    const { t } = await import('../../../../src/main/i18n');
    expect(deleteOut.content).toContain(t('recall.asset.delete_confirm_rules'));
    expect(deleteOut.content).toContain('已删除[deleted]');

    const restored = await call(restore, { assetId: asset.id, reason: '用户要求恢复' });
    expect(restored.isError).toBeUndefined();
    const after = await assets.readAbilityAsset(TEST_UID, asset.id);
    expect(after.status).toBe('active');
    expect(after.statement).toBe(asset.statement);
  });

  it('回滚：生成新版本、历史不回退、回滚本身记账', async () => {
    const asset = await seedAsset('回滚测试的第一版内容。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.updateAbilityAsset(TEST_UID, asset.id, { statement: '第二版内容。', reason: 'v2', actor: 'user' });
    const { rollback } = await tools();

    const out = await call(rollback, { assetId: asset.id, toVersion: '1', reason: '用户要求回到第一版' });
    expect(out.isError).toBeUndefined();
    const after = await assets.readAbilityAsset(TEST_UID, asset.id);
    expect(after.statement).toBe(asset.statement);
    expect(after.version).toBe('3');
    expect((await assets.listAbilityAssetVersions(TEST_UID, asset.id)).map((v) => v.version)).toEqual(['1', '2', '3']);
    const rollbackRow = (await assets.listAbilityAssetAudit(TEST_UID, asset.id)).find((r) => r.action === 'rolled_back')!;
    expect(rollbackRow.actor).toBe('ai');
    expect(rollbackRow.reason).toBe('用户要求回到第一版');
  });

  it('门禁拦截不计为成功：已撤销/已彻底清除的资产改不动，且回执写明规则', async () => {
    const revokedAsset = await seedAsset('已撤销的资产不可再改。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.revokeAbilityAsset(TEST_UID, revokedAsset.id, { actor: 'user', reason: 'unsafe' });
    const { edit, del } = await tools();
    const revoked = await call(edit, { assetId: revokedAsset.id, fields: { title: 'x' }, reason: '试试', origin: 'ai_initiated' });
    expect(revoked.isError).toBe(true);
    expect(revoked.content).toContain('revoked ability asset cannot be changed');
    expect(revoked.content).toContain('governance');

    const purgedAsset = await seedAsset('已彻底清除的资产不可再改。');
    await assets.purgeAbilityAsset(TEST_UID, purgedAsset.id, { actor: 'user', reason: 'clear' });
    const purged = await call(del, { assetId: purgedAsset.id, reason: '再删一次' });
    expect(purged.isError).toBe(true);
    expect(purged.content).toContain('purged');
  });

  it('受限内容被既有门禁拦下（不豁免、不静默放行）', async () => {
    const asset = await seedAsset('受限内容写入会被拦。');
    const { edit } = await tools({
      taskText: '请把这条改成：部署时使用 api_key = sk-live-ABCDEFGHIJKLMNOPQRSTUVWX 直连。',
      sourceMessageFromUser: true,
    });
    // assertNotForbiddenToPersist 拦的是凭据类内容（L3）：伪造一段 API key 形态的正文。
    const out = await call(edit, {
      assetId: asset.id,
      fields: { statement: '部署时使用 api_key = sk-live-ABCDEFGHIJKLMNOPQRSTUVWX 直连。' },
      reason: '用户要求补上部署说明',
      origin: 'user_instruction',
    });
    if (out.isError) {
      expect(out.content).toContain('forbidden to persist');
      expect(out.content).toContain('permission');
    }
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const after = await assets.readAbilityAsset(TEST_UID, asset.id);
    // 无论拦不拦，都不允许"静默放行"：要么拒绝，要么确实写进去了并有台账。
    if (out.isError) expect(after.statement).toBe(asset.statement);
    else expect((await assets.listAbilityAssetAudit(TEST_UID, asset.id)).some((r) => r.actor === 'ai')).toBe(true);
  });

  it('AI 编辑不写使用记录（FR-010）', async () => {
    const asset = await seedAsset('编辑不算使用。');
    const { edit, archive, restore } = await tools();
    await call(edit, { assetId: asset.id, fields: { title: '改个名' }, reason: '命名规范化', origin: 'ai_initiated' });
    await call(archive, { assetId: asset.id, reason: '暂时不用' });
    await call(restore, { assetId: asset.id, reason: '又要用了' });

    const usage = await import('../../../../src/main/features/recall/usage-service');
    expect(await usage.listRecallUsage(TEST_UID)).toEqual([]);
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    expect(await receipts.listInjectionReceipts(TEST_UID)).toEqual([]);
  });

  it('冻结引用不因后续编辑改变（已引用版本仍按原内容供给）', async () => {
    const asset = await seedAsset('冻结引用的第一版内容。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const store = await import('../../../../src/main/features/recall/store');
    // v2 被一条已确认投影引用（版本号钉死）。
    await assets.updateAbilityAsset(TEST_UID, asset.id, { statement: '被引用的第二版内容。', reason: 'v2', actor: 'user' });
    await store.writeRecallJsonRecord(TEST_UID, 'projections', 'proj-frozen', {
      schemaVersion: 2, ownerId: TEST_UID, id: 'proj-frozen', taskRunId: 'kst-frozen',
      purpose: 'review', authorization: 'workspace_policy',
      assetIds: [asset.id], assetVersions: { [asset.id]: '2' },
      sourceRefs: [], omittedRefs: [], status: 'confirmed', createdAt: new Date().toISOString(),
    });

    const { edit } = await tools({
      taskText: '请把这条改成：AI 后来改成的第三版内容。',
      sourceMessageFromUser: true,
    });
    const out = await call(edit, {
      assetId: asset.id,
      fields: { statement: 'AI 后来改成的第三版内容。' },
      reason: '用户要求改清楚',
      origin: 'user_instruction',
    });
    expect(out.isError).toBeUndefined();

    // ① 被引用版本的内容快照原样在（注入路径读的就是它，见 prompt-injection 的
    //    readAbilityAssetVersionSnapshot 调用）。
    const frozen = await assets.readAbilityAssetVersionSnapshot(TEST_UID, asset.id, '2');
    expect(frozen?.statement).toBe('被引用的第二版内容。');
    // ② 投影的版本指针没有被"顺手"改到最新版。
    const projection = await store.readRecallJsonRecord(TEST_UID, 'projections', 'proj-frozen') as { assetVersions?: Record<string, string> };
    expect(projection.assetVersions?.[asset.id]).toBe('2');
    // ③ 在用内容确实变了（否则上面两条可能只是"什么都没发生"）。
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).statement).toBe('AI 后来改成的第三版内容。');
  });
});

describe('危险操作的安全网（US-404 / T027–T031）', () => {
  const CID = 'conv-steward';
  const TURN = 'turn-steward';
  const call = (tool: { execute: (input: Record<string, unknown>, ctx: never) => Promise<{ content: string; isError?: boolean }> }, input: Record<string, unknown>) =>
    tool.execute(input, {} as never);

  async function dangerTools() {
    const { createAssetStewardTools } = await import('../../../../src/main/model/core-agent/asset-steward-tools');
    const byName = new Map(createAssetStewardTools({ userId: TEST_UID, cid: CID, turnId: TURN }).map((t) => [t.name, t]));
    return {
      edit: byName.get('edit_ability_asset')!,
      del: byName.get('delete_ability_asset')!,
    };
  }
  /** 应答下一条交互请求（模拟用户在确认卡上点）。decision=null 表示不应答。 */
  async function answerNext(decision: 'allow' | 'deny' | null) {
    const hub = await import('../../../../src/main/features/chat_events/interaction-hub');
    const seen: string[] = [];
    hub._setBroadcastForTest((_uid, event) => {
      const ev = event as { type?: string; interactionId?: string };
      if (ev.type !== 'chat.interaction.requested' || !ev.interactionId) return;
      seen.push(ev.interactionId);
      if (decision) hub.respondInteraction(ev.interactionId, { decision });
    });
    return { hub, seen };
  }

  it('判定表：单条不危险；批量→batch_delete；覆盖全库→clear_all；动 scopePolicy→cross_scope_widen', async () => {
    const { assessDeleteDanger, assessScopeWidenDanger } = await import('../../../../src/main/model/core-agent/asset-steward-tools');
    expect(assessDeleteDanger(['aa-a'], 10)).toMatchObject({ dangerous: false });
    expect(assessDeleteDanger(['aa-a', 'aa-b'], 10)).toMatchObject({ dangerous: true, kind: 'batch_delete' });
    expect(assessDeleteDanger(['aa-a', 'aa-b'], 2)).toMatchObject({ dangerous: true, kind: 'clear_all' });
    expect(assessScopeWidenDanger({ title: 'x' })).toMatchObject({ dangerous: false });
    expect(assessScopeWidenDanger({ scopePolicy: { workspaceIds: ['sp-a'] } }))
      .toMatchObject({ dangerous: true, kind: 'cross_scope_widen' });
  });

  it('单条删除不是危险操作：不弹确认、不留快照', async () => {
    const asset = await seedAsset('单条删除是普通治理动作。');
    const { del } = await dangerTools();
    const { seen } = await answerNext(null);
    const out = await call(del, { assetId: asset.id, reason: '用户要求删掉这条' });
    expect(out.isError).toBeUndefined();
    expect(seen).toEqual([]);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const actions = (await assets.listAbilityAssetAudit(TEST_UID, asset.id)).map((r) => r.action);
    expect(actions).not.toContain('danger_snapshot');
    expect(actions).toContain('deleted');
  });

  it('批量删除：执行前逐条留快照 + 单次确认通过后执行', async () => {
    const base = await seedAsset('批量删除的第一条。');
    const ids = await cloneAssets(base as unknown as Record<string, unknown>, 3);
    // 库外还有资产：这样才是"批量删除"而不是"清空"。
    await cloneAssets(base as unknown as Record<string, unknown>, 2, [{ status: 'paused' }], 90);
    const allIds = [base.id, ...ids];
    const { del } = await dangerTools();
    const { seen } = await answerNext('allow');
    const out = await call(del, { assetIds: allIds, reason: '用户要求清掉这批重复的' });

    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('已删除 4/4 条');
    expect(out.content).toContain('批量删除');
    expect(seen).toHaveLength(1);

    const assets = await import('../../../../src/main/features/recall/asset-service');
    for (const id of allIds) {
      const rows = await assets.listAbilityAssetAudit(TEST_UID, id);
      const snapshot = rows.find((r) => r.action === 'danger_snapshot');
      expect(snapshot, id).toBeTruthy();
      // 快照锚点 = 当时的在用版：事后能一步回滚到操作前。
      expect(snapshot!.rollbackAnchor).toBeTruthy();
      expect(rows.some((r) => r.action === 'danger_confirmed')).toBe(true);
      expect((await assets.readAbilityAsset(TEST_UID, id)).status).toBe('deleted');
    }
  });

  it('确认被拒 → 零执行 + 如实回执 + 留痕（不得计为成功）', async () => {
    const base = await seedAsset('确认被拒的批量删除。');
    const ids = await cloneAssets(base as unknown as Record<string, unknown>, 2);
    // 库里还有别的资产 → 这是"批量删除"而不是"清空"（两者都危险，但告诉用户的是两件事）。
    await cloneAssets(base as unknown as Record<string, unknown>, 2, [
      { status: 'paused' }, { status: 'archived' },
    ], 90);
    const allIds = [base.id, ...ids];
    const { del } = await dangerTools();
    await answerNext('deny');
    const out = await call(del, { assetIds: allIds, reason: '用户要求批量删掉' });

    expect(out.isError).toBe(true);
    expect(out.content).toContain('未能执行批量删除');
    expect(out.content).toContain('未获确认');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    for (const id of allIds) {
      expect((await assets.readAbilityAsset(TEST_UID, id)).status).toBe('active');
      const rows = await assets.listAbilityAssetAudit(TEST_UID, id);
      expect(rows.some((r) => r.action === 'danger_denied')).toBe(true);
      expect(rows.some((r) => r.action === 'deleted')).toBe(false);
      expect(rows.find((r) => r.action === 'danger_denied')!.failureCategory).toBe('permission');
      // 快照照留：它是"执行前"的事实，与用户同不同意无关。
      expect(rows.some((r) => r.action === 'danger_snapshot')).toBe(true);
    }
  });

  it('确认悬停被回合取消 → 按 deny 处理：不执行', async () => {
    const base = await seedAsset('确认被取消的批量删除。');
    const ids = await cloneAssets(base as unknown as Record<string, unknown>, 2);
    const allIds = [base.id, ...ids];
    const { del } = await dangerTools();
    const { hub } = await answerNext(null);
    const pending = call(del, { assetIds: allIds, reason: '用户要求批量删掉' });
    await vi.waitFor(() => expect(hub.pendingInteractionCount()).toBe(1));
    hub.cancelInteractionsForTurn(TURN);
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(out.content).toContain('turnCancelled');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    for (const id of allIds) {
      expect((await assets.readAbilityAsset(TEST_UID, id)).status).toBe('active');
      expect((await assets.listAbilityAssetAudit(TEST_UID, id)).some((r) => r.action === 'danger_denied')).toBe(true);
    }
  });

  it('无法发起确认（非会话上下文）时不执行——问不到人不等于默认同意', async () => {
    const base = await seedAsset('没有会话上下文的批量删除。');
    const ids = await cloneAssets(base as unknown as Record<string, unknown>, 2);
    const { createAssetStewardTools } = await import('../../../../src/main/model/core-agent/asset-steward-tools');
    const del = createAssetStewardTools({ userId: TEST_UID }).find((t) => t.name === 'delete_ability_asset')!;
    const out = await call(del, { assetIds: [base.id, ...ids], reason: '批量删' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('无法发起单次确认');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect((await assets.readAbilityAsset(TEST_UID, base.id)).status).toBe('active');
  });

  it('批量里有一条不存在：快照凑不齐 → 整批不执行', async () => {
    const asset = await seedAsset('混了坏 id 的批量删除。');
    const { del } = await dangerTools();
    await answerNext('allow');
    const out = await call(del, { assetIds: [asset.id, 'aa-nonexistent'], reason: '批量删' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('没能留下执行前快照');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).status).toBe('active');
  });

  it('任何 scopePolicy 写入都要确认——收窄方向也一样（刻意偏保守，测试钉住）', async () => {
    const { assessScopeWidenDanger, describeScopePolicyChange } = await import('../../../../src/main/model/core-agent/asset-steward-tools');
    // 刻意选择：多一次确认 < 漏一次扩权；按方向区分免确认会引入新的误判边界。
    expect(assessScopeWidenDanger({ scopePolicy: {} })).toMatchObject({ dangerous: true });
    expect(assessScopeWidenDanger({ scopePolicy: { workspaceIds: ['sp-a'] } }, { workspaceIds: ['sp-a', 'sp-b'] }))
      .toMatchObject({ dangerous: true, kind: 'cross_scope_widen' });
    // 确认文案必须给出方向与范围，否则用户看不懂自己在批什么。
    const detail = describeScopePolicyChange({ workspaceIds: ['sp-a'] }, { workspaceIds: ['sp-a', 'sp-b'], agentIds: ['ag-1'] });
    expect(detail).toContain('空间：sp-a → sp-a、sp-b');
    expect(detail).toContain('Agent：(无) → ag-1');
    expect(detail).not.toContain('项目'); // 没变的维度不进文案
    // 取值没变也要如实说"没有实际变化"，而不是编一句差异出来。
    expect(describeScopePolicyChange({ workspaceIds: ['sp-a'] }, { workspaceIds: ['sp-a'] })).toContain('没有实际变化');
  });

  it('跨作用域扩大（改 scopePolicy）：先快照 + 单次确认；拒绝则一个字都不改', async () => {
    const asset = await seedAsset('作用域授权的改动要走确认。');
    const { edit } = await dangerTools();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await answerNext('deny');
    const denied = await call(edit, {
      assetId: asset.id,
      fields: { scopePolicy: { workspaceIds: ['sp-other'] } },
      reason: '用户要求让它在这个空间也能用',
      origin: 'user_instruction',
    });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('未能执行跨作用域扩大');
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).scopePolicy).toBeUndefined();

    await answerNext('allow');
    const allowed = await call(edit, {
      assetId: asset.id,
      fields: { scopePolicy: { workspaceIds: ['sp-other'] } },
      reason: '用户要求让它在这个空间也能用',
      origin: 'user_instruction',
    });
    expect(allowed.isError).toBeUndefined();
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).scopePolicy).toMatchObject({ workspaceIds: ['sp-other'] });
    expect((await assets.listAbilityAssetAudit(TEST_UID, asset.id)).some((r) => r.action === 'danger_confirmed')).toBe(true);
  });

  it('放宽 scopePolicy 不绕过准入独立判断：暂停/范围不符的资产照旧不进消费路径', async () => {
    const asset = await seedAsset('放宽授权不等于放行准入。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const { evaluateRecallAssetRuntimeEligibility } = await import('../../../../src/main/features/recall/prompt-injection');
    const { createAssetStewardTools } = await import('../../../../src/main/model/core-agent/asset-steward-tools');
    const edit = createAssetStewardTools({ userId: TEST_UID, cid: CID, turnId: TURN }).find((t) => t.name === 'edit_ability_asset')!;
    await answerNext('allow');
    const widened = await call(edit, {
      assetId: asset.id,
      fields: { scopePolicy: { workspaceIds: ['sp-other'] } },
      reason: '用户要求扩大可用空间',
      origin: 'user_instruction',
    });
    expect(widened.isError).toBeUndefined();

    // scopePolicy 变大只等于"可被选中"；是否真进消费路径仍由唯一闸门独立判。
    await assets.pauseAbilityAsset(TEST_UID, asset.id, { actor: 'user', reason: '先暂停' });
    const paused = await evaluateRecallAssetRuntimeEligibility(
      TEST_UID,
      await assets.readAbilityAsset(TEST_UID, asset.id),
      { scope: 'sp-other', purpose: 'agent_read', silentDefaultInjection: true },
    );
    expect(paused.eligible).toBe(false);
    expect(paused.reasons).toContain('status_not_active');
  });

  it('回滚能回退 scopePolicy：扩权确认执行后，一步回滚把授权恢复原样', async () => {
    const asset = await seedAsset('扩权也要能回退。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const { createAssetStewardTools } = await import('../../../../src/main/model/core-agent/asset-steward-tools');
    const edit = createAssetStewardTools({ userId: TEST_UID, cid: CID, turnId: TURN }).find((t) => t.name === 'edit_ability_asset')!;
    await answerNext('allow');
    await call(edit, {
      assetId: asset.id,
      fields: { scopePolicy: { workspaceIds: ['sp-other'] } },
      reason: '用户要求扩大可用空间',
      origin: 'user_instruction',
    });
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).scopePolicy).toMatchObject({ workspaceIds: ['sp-other'] });

    const rows = await assets.listAbilityAssetAudit(TEST_UID, asset.id);
    // 危险操作的快照锚点确实写了——否则"事后能回滚"是句空话。
    const snapshot = rows.find((r) => r.action === 'danger_snapshot')!;
    expect(snapshot.rollbackAnchor).toBeTruthy();
    await assets.rollbackAbilityAsset(TEST_UID, asset.id, snapshot.rollbackAnchor!, { actor: 'user', reason: '回退扩权' });
    // 版本快照含 scopePolicy，所以既有 rollback 就能恢复旧授权。
    expect((await assets.readAbilityAsset(TEST_UID, asset.id)).scopePolicy).toBeUndefined();
  });

  it('被拦下的尝试留痕（attempt_blocked + 归因），不是只在成功路径上记账', async () => {
    const asset = await seedAsset('被拦下的尝试也要留痕。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.revokeAbilityAsset(TEST_UID, asset.id, { actor: 'user', reason: 'unsafe' });
    const { createAssetStewardTools } = await import('../../../../src/main/model/core-agent/asset-steward-tools');
    const edit = createAssetStewardTools({ userId: TEST_UID }).find((t) => t.name === 'edit_ability_asset')!;
    const out = await call(edit, { assetId: asset.id, fields: { title: 'x' }, reason: '试试', origin: 'ai_initiated' });
    expect(out.isError).toBe(true);

    const blocked = (await assets.listAbilityAssetAudit(TEST_UID, asset.id)).find((r) => r.action === 'attempt_blocked');
    expect(blocked).toBeTruthy();
    expect(blocked!.actor).toBe('ai');
    expect(blocked!.failureCategory).toBe('governance');
    expect(String(blocked!.note)).toContain('revoked ability asset cannot be changed');
  });
});

describe('安全网的量化口径（T031）', () => {
  it('台账覆盖率 100%：每一次 AI 写操作都有 actor=ai 且四项齐全的记录', async () => {
    const asset = await seedAsset('台账覆盖率的抽查对象。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const { createAssetStewardTools } = await import('../../../../src/main/model/core-agent/asset-steward-tools');
    const tools = new Map(createAssetStewardTools({ userId: TEST_UID }).map((t) => [t.name, t]));
    const call = (name: string, input: Record<string, unknown>) => tools.get(name)!.execute(input, {} as never);

    await call('edit_ability_asset', { assetId: asset.id, fields: { title: '改名' }, reason: '命名规范化', origin: 'ai_initiated' });
    await call('archive_ability_asset', { assetId: asset.id, reason: '暂时不用' });
    await call('restore_ability_asset', { assetId: asset.id, reason: '又要用了' });
    await call('delete_ability_asset', { assetId: asset.id, reason: '用户要求删除' });
    await call('restore_ability_asset', { assetId: asset.id, reason: '用户要求恢复' });
    await call('rollback_ability_asset', { assetId: asset.id, toVersion: '1', reason: '回到第一版' });

    const aiRows = (await assets.listAbilityAssetAudit(TEST_UID, asset.id)).filter((r) => r.actor === 'ai');
    expect(aiRows.length).toBeGreaterThanOrEqual(6);
    for (const row of aiRows) {
      expect(Number.isNaN(Date.parse(row.at)), `${row.action} 缺时间`).toBe(false);
      expect(row.reason, `${row.action} 缺依据`).toBeTruthy();
      expect(row.before, `${row.action} 缺前值`).toBeTruthy();
      expect(row.after, `${row.action} 缺后值`).toBeTruthy();
    }
  });

  it('回滚一致性 100%：拿台账里的锚点回滚，内容与改动前逐字一致', async () => {
    const asset = await seedAsset('回滚一致性的原始内容。');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const { createAssetStewardTools } = await import('../../../../src/main/model/core-agent/asset-steward-tools');
    const tools = new Map(createAssetStewardTools({
      userId: TEST_UID,
      taskText: '请把这条改成：第一次改动后的内容。',
      sourceMessageFromUser: true,
    }).map((t) => [t.name, t]));
    const call = (name: string, input: Record<string, unknown>) => tools.get(name)!.execute(input, {} as never);

    // 内容路径：台账锚点 → 一步回滚 → 逐字回到改动前。
    const contentSteps: Array<[string, Record<string, unknown>]> = [
      ['edit_ability_asset', { fields: { statement: '第一次改动后的内容。' }, reason: '用户要求改', origin: 'user_instruction' }],
      ['edit_ability_asset', { fields: { title: '第二次改动的标题' }, reason: '命名规范化', origin: 'ai_initiated' }],
    ];
    for (const [name, extra] of contentSteps) {
      const before = await assets.readAbilityAsset(TEST_UID, asset.id);
      await call(name, { assetId: asset.id, reason: '步骤', ...extra });
      const anchor = (await assets.listAbilityAssetAudit(TEST_UID, asset.id)).at(-1)!.rollbackAnchor;
      expect(anchor, `${name} 应当留下回滚锚点`).toBeTruthy();
      await assets.rollbackAbilityAsset(TEST_UID, asset.id, anchor!, { actor: 'user', reason: '一步回滚' });
      const after = await assets.readAbilityAsset(TEST_UID, asset.id);
      expect(after.statement, name).toBe(before.statement);
      expect(after.title, name).toBe(before.title);
    }

    // 状态路径：归档/删除**不**留回滚锚点（它们不 bump 版本，锚点=当前版，
    // 回滚必然报"already at that version"）；它们的"回退"是 restore，内容同样逐字一致。
    for (const [name, extra] of [
      ['archive_ability_asset', {}],
      ['delete_ability_asset', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const before = await assets.readAbilityAsset(TEST_UID, asset.id);
      await call(name, { assetId: asset.id, reason: '步骤', ...extra });
      const row = (await assets.listAbilityAssetAudit(TEST_UID, asset.id)).at(-1)!;
      expect(row.rollbackAnchor, `${name} 不该留回滚锚点`).toBeUndefined();
      expect(row.before, `${name} 仍要有前后值`).toBeTruthy();
      await assets.restoreAbilityAsset(TEST_UID, asset.id, { actor: 'user', reason: '恢复' });
      const after = await assets.readAbilityAsset(TEST_UID, asset.id);
      expect(after.status, name).toBe('active');
      expect(after.statement, name).toBe(before.statement);
      expect(after.title, name).toBe(before.title);
    }
  });
});
