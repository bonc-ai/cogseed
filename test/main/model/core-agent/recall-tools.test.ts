import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * search_ability_assets 工具契约测试。kb_embed 被 mock（不加载 ONNX），
 * recall 资产服务用真实实现（tmp 工作区）。
 */

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'recalltools';

const embedState = vi.hoisted(() => ({ fail: false }));
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => {
    if (embedState.fail) throw new Error('embed unavailable');
    return texts.map(() => new Array(512).fill(0));
  },
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recalltools-'));
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
  opts: { spaceId?: string; scope?: string; pause?: boolean } = {},
) {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  _seedSeq += 1;
  const candidate = await candidates.saveRecallCandidate(TEST_UID, {
    judgment,
    summary: judgment.slice(0, 12),
    suggestedType: 'rule',
    applicableWhen: ['正式评审与架构决策时'],
    forbiddenWhen: ['内部快速对齐'],
    suggestedScope: opts.scope || 'general',
    ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
    sourceRefs: [{ kind: 'execution', id: `exec-seed-${_seedSeq}` }],
  });
  const promoted = await candidates.promoteRecallCandidate(TEST_UID, candidate.id, { actor: 'user' });
  if (opts.pause) {
    await assets.pauseAbilityAsset(TEST_UID, promoted.asset.id, { actor: 'user', reason: 'not ready' });
  }
  return promoted.asset;
}

describe('recall search_ability_assets tool', () => {
  it('searches the GLOBAL pool (all spaces + general assets) and returns citation format', async () => {
    await seedAsset('发布类公告应包含背景、变更点、影响范围、生效时间、联系方式五段。', { spaceId: 'sp_a', scope: 'space' });
    await seedAsset('竞品调研应先明确可比维度（范围/功能/定价/体验）再收集证据。', { spaceId: 'sp_b', scope: 'space' });
    await seedAsset('番茄工作法：25 分钟专注加 5 分钟休息。', { scope: 'general' });

    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });
    const result = await tool.execute({ query: '竞品调研' }, {} as never);

    expect(result.isError).not.toBe(true);
    const content = result.content;
    // 全局池全量可见：sp_a / sp_b / general 的资产都能搜到
    expect(content).toContain('发布类公告');
    expect(content).toContain('竞品调研');
    expect(content).toContain('番茄工作法');
    // 引用格式与元信息
    expect(content).toContain('[asset:');
    expect(content).toContain('引用格式');
    expect(content).toContain('空间:sp_a');
  });

  it('supports scope / spaceId filters and excludes non-active assets', async () => {
    const spA = await seedAsset('只在本空间使用的经验。', { spaceId: 'sp_a', scope: 'space' });
    await seedAsset('另一个空间的经验。', { spaceId: 'sp_b', scope: 'space' });
    await seedAsset('已停用的经验。', { spaceId: 'sp_a', scope: 'space', pause: true });

    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });

    const filtered = await tool.execute({ query: '经验', spaceId: 'sp_a' }, {} as never);
    expect(filtered.content).toContain('只在本空间使用');
    expect(filtered.content).not.toContain('另一个空间');
    expect(filtered.content).not.toContain('已停用');
    expect(filtered.content).toContain(`[asset:${spA.id}]`);

    const scopeFiltered = await tool.execute({ query: '经验', scope: 'space' }, {} as never);
    expect(scopeFiltered.content).toContain('只在本空间使用');
    expect(scopeFiltered.content).not.toContain('番茄工作法');
  });

  it('目录模式（2026-09-18）：不给 query 也不给 assetIds 时返回全量目录，含判断适配需要的字段', async () => {
    const a = await seedAsset('发布类公告应包含背景、变更点、影响范围、生效时间、联系方式五段。', { spaceId: 'sp_a', scope: 'space' });
    await seedAsset('已停用的经验。', { spaceId: 'sp_a', scope: 'space', pause: true });
    await seedAsset('番茄工作法：25 分钟专注加 5 分钟休息。', { scope: 'general' });

    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });

    const catalog = await tool.execute({}, {} as never);
    expect(catalog.isError).not.toBe(true);
    // 目录是"在用资产的全量"：未停用的两条都在，停用的不在。
    expect(catalog.content).toContain('认知资产目录');
    expect(catalog.content).toContain('发布类公告');
    expect(catalog.content).toContain('番茄工作法');
    expect(catalog.content).not.toContain('已停用的经验');
    expect(catalog.content).toContain(`[asset:${a.id}]`);
    // 模型据此判断适配所需的字段（2026-09-18 压缩为短标签两行制）：
    // 标题 — 一句话 / 类型·范围·成熟度·版本·使用次数 ｜ 适用首条。
    expect(catalog.content).toContain('规则');
    expect(catalog.content).toContain('space');
    expect(catalog.content).toMatch(/v\d/);
    expect(catalog.content).toContain('已确认');   // bud 的短标签
    expect(catalog.content).toContain('没用过');
    expect(catalog.content).toContain('适用:正式评审与架构决策时');
    // 禁用场景不进目录（由服务端硬闸执行；读取与注入块里完整给出）。
    expect(catalog.content).not.toContain('内部快速对齐');
    // 取用指引：按需取正文 + 引用格式。
    expect(catalog.content).toContain('assetIds');
    expect(catalog.content).toContain('[asset:<id>]');

    // 过滤与分页
    const byType = await tool.execute({ type: 'rule' }, {} as never);
    expect(byType.content).toContain('过滤：type=rule');
    const byScope = await tool.execute({ scope: 'space', spaceId: 'sp_a' }, {} as never);
    expect(byScope.content).toContain('发布类公告');
    expect(byScope.content).not.toContain('番茄工作法');
    const page = await tool.execute({ k: 1, offset: 0 }, {} as never);
    expect(page.content).toContain('本页 1-1 条');
    expect(page.content).toMatch(/还有 \d+ 条：用 offset=1/);
    const page2 = await tool.execute({ k: 1, offset: 1 }, {} as never);
    expect(page2.content).toContain('本页 2-2 条');
  });

  it('正文模式（2026-09-18）：按 id 取正文，过准入门，并写 agent_read 注入回执 + 使用流水', async () => {
    const live = await seedAsset('性能类提问需用真实日志做分层归因，先给链路再给瓶颈。', { scope: 'general' });
    const paused = await seedAsset('已停用的经验。', { scope: 'general', pause: true });

    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/usage-service');
    const [tool] = createRecallTools({ userId: TEST_UID, turnId: 'turn-read0001' });

    const read = await tool.execute({ assetIds: [live.id] }, {} as never);
    expect(read.isError).not.toBe(true);
    expect(read.content).toContain('已取出 1 条资产正文');
    expect(read.content).toContain(`[asset:${live.id}]`);
    expect(read.content).toContain('正文:');
    expect(read.content).toContain('先给链路再给瓶颈');
    expect(read.content).toMatch(/版本:v\d/);
    expect(read.content).toContain('生命周期:');

    // 留痕：模型自己取用也算一次真实带入（否则自选资产进不了升档链）。
    const rows = await receipts.listInjectionReceipts(TEST_UID, 'turn-read0001');
    expect(rows.map((row) => `${row.channel}:${row.assetId}`)).toEqual([`agent_read:${live.id}`]);
    expect(rows[0].boundary).toBe('real');
    expect(rows[0].status).toBe('injected');
    const used = await usage.listRecallUsage(TEST_UID, live.id);
    expect(used.map((row) => row.outcome)).toEqual(['agent_read']);
    expect(used[0].taskRunId).toBe('turn-read0001');

    // 同一回合重复取用：不重复刷使用次数（回执幂等 + 使用按回合计一次）。
    await tool.execute({ assetIds: [live.id] }, {} as never);
    expect(await usage.listRecallUsage(TEST_UID, live.id)).toHaveLength(1);
    expect(await receipts.listInjectionReceipts(TEST_UID, 'turn-read0001')).toHaveLength(1);

    // 准入被拦的资产：如实说明原因，不返回正文、不写留痕。
    const blocked = await tool.execute({ assetIds: [paused.id] }, {} as never);
    expect(blocked.content).toContain('当前不可使用');
    expect(blocked.content).toContain('已暂停/归档/撤销');
    expect(blocked.content).not.toContain('正文:');
    expect((await receipts.listInjectionReceipts(TEST_UID, 'turn-read0001')).some((row) => row.assetId === paused.id)).toBe(false);

    // 不存在的 id：如实说未找到。
    const missing = await tool.execute({ assetIds: ['aa-doesnotexist0001'] }, {} as never);
    expect(missing.content).toContain('未找到');
  });

  it('正文模式：单次取用上限 6 条，超出部分提示忽略；没有 turnId 时不记账', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const asset = await seedAsset(`第 ${i} 条经验：用于验证正文模式的条数上限。`, { scope: 'general' });
      ids.push(asset.id);
    }
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    const [tool] = createRecallTools({ userId: TEST_UID, turnId: 'turn-read0002' });
    const read = await tool.execute({ assetIds: ids }, {} as never);
    expect(read.content).toContain('已取出 6 条资产正文');
    expect(read.content).toContain('单次最多 6 条');
    expect(await receipts.listInjectionReceipts(TEST_UID, 'turn-read0002')).toHaveLength(6);

    // 缺 turnId（没有回合并定位）：只读不记账，绝不写脏回执。
    const [noTurn] = createRecallTools({ userId: TEST_UID });
    const readNoTurn = await noTurn.execute({ assetIds: [ids[0]] }, {} as never);
    expect(readNoTurn.isError).not.toBe(true);
    expect(await receipts.listInjectionReceipts(TEST_UID)).toHaveLength(6);
  });

  it('语义检索模式同样记 agent_read（检索结果进了上下文就算带入）', async () => {
    const asset = await seedAsset('竞品调研应先明确可比维度（范围/功能/定价/体验）再收集证据。', { scope: 'general' });
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    const [tool] = createRecallTools({ userId: TEST_UID, turnId: 'turn-search001' });
    const result = await tool.execute({ query: '竞品调研' }, {} as never);
    expect(result.content).toContain('竞品调研');
    const rows = await receipts.listInjectionReceipts(TEST_UID, 'turn-search001');
    expect(rows.some((row) => row.assetId === asset.id && row.channel === 'agent_read')).toBe(true);
  });

  it('searches profile memory with an explicit source label (T1.3 画像进池)', async () => {
    const paths = await import('../../../../src/main/paths');
    const profileFile = paths.userProfileFile(TEST_UID);
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(profileFile, '用户是本程序的开发人员，技术问题按内部排查口径处理。', 'utf8');

    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });

    const result = await tool.execute({ query: '开发人员' }, {} as never);
    expect(result.isError).not.toBe(true);
    // 画像可被检索到，且带来源与等级标注——LLM 必须能区分记忆与经验。
    expect(result.content).toContain('用户是本程序的开发人员');
    expect(result.content).toMatch(/\[asset:onto-/);
    expect(result.content).toContain('来源:画像记忆(user_profile)，未经确认，仅供参考');
    expect(result.content).toContain('画像记忆 1');
    // spaceId 过滤把画像排除（记忆无空间归属）。
    const filtered = await tool.execute({ query: '开发人员', spaceId: 'sp_a' }, {} as never);
    expect(filtered.content).not.toContain('用户是本程序的开发人员');
    // scope 精确过滤：画像 scope=general，按值参与过滤。
    const scopeKept = await tool.execute({ query: '开发人员', scope: 'general' }, {} as never);
    expect(scopeKept.content).toContain('用户是本程序的开发人员');
  });

  /**
   * 输出预算（2026-09-18 质量门）：目录是索引不是正文。"可用高效"的第一层
   * 含义就是"模型读得起"——这里把预算写成断言，任何一条超了都说明目录正在
   * 长回"又一坨正文"。
   */
  it('目录预算：每条平均 ≤ 110 字符，一句话不残缺（不以标点结尾）', async () => {
    const filler = '先给结论、再给依据、最后给下一步动作；遇到数据缺口时先说明缺口而不是硬给结论。'.repeat(3);
    const longBody = `这是一条用于压测目录预算的资产正文，它刻意写得比较长以便观察目录输出是否仍然便宜：${filler}`;
    for (let index = 0; index < 8; index += 1) {
      await seedAsset(`${longBody}（第 ${index + 1} 条）`, { scope: 'general' });
    }
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });
    const catalog = await tool.execute({ k: 30 }, {} as never);

    const lines = catalog.content.split('\n');
    const entryHeads = lines.filter((line) => /^\d+\. \[asset:/.test(line));
    const entryChars = lines
      .filter((line) => /^\d+\. \[asset:/.test(line) || /^ \S/.test(line))
      .reduce((sum, line) => sum + line.length + 1, 0);
    const wrapperChars = catalog.content.length - entryChars;
    // eslint-disable-next-line no-console
    console.log(`[budget] 8 条目录：每条平均=${Math.round(entryChars / Math.max(1, entryHeads.length))}，页眉页脚=${wrapperChars}，总计=${catalog.content.length}`);
    expect(entryHeads).toHaveLength(8);
    expect(entryChars / entryHeads.length).toBeLessThanOrEqual(110);
    // 页眉页脚也要便宜：30 条页 ≈ 30×110 + 页眉页脚 ≤ 4000。
    expect(wrapperChars).toBeLessThanOrEqual(250);

    // 一句话 = 正文首句（压缩后紧跟在标题后用 ` — ` 引出），必须切得干净：
    // 不以逗号/顿号/分号/破折号收尾，且 ≤ 80 字。
    const headLine = catalog.content.split('\n').find((line) => /^\d+\. \[asset:/.test(line)) || '';
    const oneLine = headLine.split(' — ')[1] || '';
    expect(oneLine.length).toBeGreaterThan(0);
    expect(/[，、；：,;:\-—]$/.test(oneLine)).toBe(false);
    expect(oneLine.length).toBeLessThanOrEqual(80);
  });

  it('使用次数口径（O5）：目录"用N次"与流水一致；同回合重复取用只记一次，跨回合各记一次', async () => {
    const asset = await seedAsset('口径核对：目录里的使用次数必须与使用流水一致。', { scope: 'general' });
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const usage = await import('../../../../src/main/features/recall/usage-service');

    const [tool] = createRecallTools({ userId: TEST_UID, turnId: 'turn-count0001' });
    await tool.execute({ assetIds: [asset.id] }, {} as never);
    await tool.execute({ assetIds: [asset.id] }, {} as never);   // 同回合第二次取用
    const catalog1 = await tool.execute({ k: 30 }, {} as never);
    expect(catalog1.content).toContain('用1次');
    expect(await usage.listRecallUsage(TEST_UID, asset.id)).toHaveLength(1);

    const [nextTurn] = createRecallTools({ userId: TEST_UID, turnId: 'turn-count0002' });
    await nextTurn.execute({ assetIds: [asset.id] }, {} as never);
    const catalog2 = await nextTurn.execute({ k: 30 }, {} as never);
    expect(catalog2.content).toContain('用2次');
    expect(await usage.listRecallUsage(TEST_UID, asset.id)).toHaveLength(2);
  });

  it('目录边界（可用性）：offset 越界给"已到末尾+总数"，k 超上限被夹住，过滤无匹配说清 0 条', async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedAsset(`分页用例第 ${index + 1} 条经验。`, { scope: 'space' });
    }
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });

    const beyond = await tool.execute({ offset: 99 }, {} as never);
    expect(beyond.isError).not.toBe(true);
    expect(beyond.content).toContain('已到目录末尾');
    expect(beyond.content).toContain('共 3 条');

    const capped = await tool.execute({ k: 999 }, {} as never);
    const heads = capped.content.split('\n').filter((line) => /^\d+\. \[asset:/.test(line)).length;
    expect(heads).toBe(3);

    const noMatch = await tool.execute({ type: 'skill_method' }, {} as never);
    expect(noMatch.content).toContain('共 0 条');

    const byScope = await tool.execute({ scope: 'space' }, {} as never);
    expect(byScope.content).toContain('过滤：scope=space');
    expect(byScope.content.split('\n').filter((line) => /^\d+\. \[asset:/.test(line))).toHaveLength(3);
  });

  it('读取硬闸（可用性）：命中禁用场景的资产被拒且给原因；暂停资产同样被拒', async () => {
    const forbidden = await seedAsset('这条资产声明了禁用场景：只在内部快速对齐时不可用。', { scope: 'general' });
    const paused = await seedAsset('这条资产已暂停。', { scope: 'general', pause: true });
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID, taskText: '内部快速对齐：先对齐口径' });

    const blocked = await tool.execute({ assetIds: [forbidden.id] }, {} as never);
    expect(blocked.content).toContain('当前不可使用');
    expect(blocked.content).toContain('禁用场景');
    expect(blocked.content).not.toContain('正文:');

    const pausedRead = await tool.execute({ assetIds: [paused.id] }, {} as never);
    expect(pausedRead.content).toContain('已暂停/归档/撤销');
  });

  it('读取去重与非法 id（可用性）：重复 id 只取一次；不存在与非安全 id 各给明确提示', async () => {
    const asset = await seedAsset('去重用例：同一条资产传两次只应返回一份正文。', { scope: 'general' });
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID, turnId: 'turn-dedup0001' });
    const usage = await import('../../../../src/main/features/recall/usage-service');

    const dup = await tool.execute({ assetIds: [asset.id, asset.id] }, {} as never);
    expect(dup.content).toContain('已取出 1 条资产正文');
    expect(await usage.listRecallUsage(TEST_UID, asset.id)).toHaveLength(1);

    const mixed = await tool.execute({ assetIds: [asset.id, 'aa-doesnotexist00', '../etc/passwd'] }, {} as never);
    expect(mixed.content).toContain('未找到');
    expect(mixed.content).toContain('不是合法的资产 id');
    expect(mixed.content).toContain('已取出 1 条资产正文');
  });

  it('关键词降级（健壮性）：embedding 不可用时仍按关键词命中，不报错', async () => {
    await seedAsset('竞品调研维度：范围、功能、定价、体验四层先定清楚。', { scope: 'general' });
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });
    embedState.fail = true;
    try {
      const result = await tool.execute({ query: '竞品调研' }, {} as never);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('竞品调研');
    } finally {
      embedState.fail = false;
    }
  });

  it('画像记忆不写 agent_read 账（口径）：检索命中画像也不产生资产使用记录', async () => {
    const paths = await import('../../../../src/main/paths');
    const profileFile = paths.userProfileFile(TEST_UID);
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(profileFile, '用户的画像记忆：偏好结论先行。', 'utf8');
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    const [tool] = createRecallTools({ userId: TEST_UID, turnId: 'turn-profile001' });
    const result = await tool.execute({ query: '画像记忆' }, {} as never);
    expect(result.content).toMatch(/\[asset:onto-/);
    const rows = await receipts.listInjectionReceipts(TEST_UID, 'turn-profile001');
    expect(rows.filter((row) => String(row.assetId).startsWith('onto-'))).toHaveLength(0);
  });

  it('归档/已删除资产不进目录，目录头计数与实际条目一致', async () => {
    const kept = await seedAsset('保留资产：会出现在目录里。', { scope: 'general' });
    const archived = await seedAsset('归档资产：不该出现在目录里。', { scope: 'general' });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.archiveAbilityAsset(TEST_UID, archived.id, { actor: 'user', reason: 'merge target' });

    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });
    const catalog = await tool.execute({ k: 30 }, {} as never);
    expect(catalog.content).toContain('保留资产');
    expect(catalog.content).not.toContain('归档资产');
    expect(catalog.content).toContain(`[asset:${kept.id}]`);
    const heads = catalog.content.split('\n').filter((line) => /^\d+\. \[asset:/.test(line)).length;
    expect(catalog.content).toContain(`在用 1 条`);
    expect(heads).toBe(1);
  });

  it('模式优先级（契约）：同时给 query 与 assetIds 走正文模式；只给 k 走目录模式', async () => {
    const asset = await seedAsset('模式优先级：assetIds 优先于 query。', { scope: 'general' });
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });
    const both = await tool.execute({ query: '模式优先级', assetIds: [asset.id] }, {} as never);
    expect(both.content).toContain('已取出 1 条资产正文');
    expect(both.content).not.toContain('返回最相关的');
    const catalogOnly = await tool.execute({ k: 5 }, {} as never);
    expect(catalogOnly.content).toContain('认知资产目录');
  });

  it('目录体量 ≤ 正文注入上限的三分之一（同批资产对照）', async () => {
    const filler = '数据缺口时先说明缺口，不要编造计时数字。'.repeat(6);
    const body = `性能类提问必须用真实日志做分层归因：先拆链路、再定位瓶颈、最后只给一个可优化项。${filler}`;
    for (let index = 0; index < 8; index += 1) await seedAsset(`${body}（第 ${index + 1} 条）`, { scope: 'general' });

    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const [tool] = createRecallTools({ userId: TEST_UID });
    const catalog = await tool.execute({ k: 30 }, {} as never);
    const ids = (await assets.listAbilityAssets(TEST_UID)).slice(0, 6).map((asset) => asset.id);
    const fullText = await tool.execute({ assetIds: ids }, {} as never);
    // eslint-disable-next-line no-console
    console.log(`[budget] 目录字符=${catalog.content.length}；6 条正文字符=${fullText.content.length}；正文块上限=14000`);
    // 注入块整块上限 14000 字：8 条资产的目录必须显著低于它，否则目录化没有意义。
    expect(catalog.content.length * 3).toBeLessThanOrEqual(14000);
    expect(fullText.content.length).toBeGreaterThan(catalog.content.length);
  });
});
