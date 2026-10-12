import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 经验工具面契约（specs/016 T021 / T024，US-802）：
 *   ① 工具面 = **2 读 + 0 写**，名字恰为 list_task_experiences / read_task_experience；
 *   ② 工具名 ⊆ TOOL_CATALOG 的 recall 组、无 localExec、不按 agent 收窄；
 *   ③ 不进只读会话闭合白名单（READ_ONLY_TOOL_ALLOWLIST / READ_ONLY_BUILTIN_ALLOWLIST）
 *      ——只读会话不开放资产/经验工具是已钉死口径（决策口径 7）；
 *   ④ 行为契约：清单行不含正文、无关任务类型零出现（AC1）、正文 ≤2000 字分批、
 *      读正文写 agent_read 回执与使用流水（口径同 search_ability_assets）、
 *      不写任何经验记录（读工具对经验集合零写入）。
 */

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'exptools';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-experience-tools-'));
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

interface SeedSpec {
  id: string;
  taskType: 'report' | 'code' | 'review' | 'product' | 'general';
  taskGoal?: string;
  body: string;
  title?: string;
  experienceType?: 'lesson' | 'workflow' | 'gap' | 'uncategorized';
  status?: 'active' | 'paused' | 'archived' | 'merged';
  forbiddenWhen?: string[];
  updatedAt?: string;
}

/** 种子经验（形状走真实 createExperience 校验，不是手写的"看起来对"）。 */
async function seedExperience(spec: SeedSpec) {
  const service = await import('../../../../src/main/features/recall/experience-service');
  const now = spec.updatedAt || new Date().toISOString();
  return service.createExperience(TEST_UID, {
    id: spec.id,
    source: {
      episodeId: `kse-${spec.id}`,
      taskGoal: spec.taskGoal || `来源任务-${spec.id}`,
      taskType: spec.taskType,
      taskStatus: 'confirmed',
    },
    experienceType: spec.experienceType || 'lesson',
    title: spec.title || `经验-${spec.id}`,
    body: spec.body,
    scope: spec.taskType,
    verification: {
      state: 'confirmed' as const,
      outcome: 'better_than_expected' as const,
      deltaR: 0.3,
      confidence: 0.8,
    },
    evidenceRefs: [{ kind: 'conversation' as const, id: `conv-${spec.id}` }],
    learningProvenance: {
      projectionId: `prj-${spec.id}`,
      episodeId: `kse-${spec.id}`,
      ruleRefs: [],
      attribution: 'execution_gap' as const,
    },
    ...(spec.forbiddenWhen ? { forbiddenWhen: spec.forbiddenWhen } : {}),
    status: spec.status || 'active' as const,
    createdAt: now,
    updatedAt: now,
  });
}

/** 相关度可控的 embedding 注入（与 experience-catalog.test.ts 同一套注入口）：
 *  不注入的文本会走本地 ONNX 真实嵌入，测试里全部注入以保证分数可精确控制。 */
async function injectEmbeddings(pairs: Array<[string, number[]]>): Promise<void> {
  const similarity = await import('../../../../src/main/features/recall/similarity');
  similarity.clearEmbedCacheForTest();
  for (const [text, vector] of pairs) similarity._injectEmbeddingForTest(TEST_UID, text, vector);
}

async function experienceTools(opts: { turnId?: string; taskText?: string; spaceId?: string } = {}) {
  const { createExperienceTools } = await import('../../../../src/main/model/core-agent/experience-tools');
  const tools = createExperienceTools({ userId: TEST_UID, ...opts });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    names: tools.map((tool) => tool.name),
    list: byName.get('list_task_experiences')!,
    read: byName.get('read_task_experience')!,
  };
}

function text(result: { content: string }): string {
  return result.content;
}

// ── ①②③ 工具面不变量（T021 的字面验收点） ────────────────────────────────

describe('经验工具面不变量（T021）', () => {
  it('工具面 = 2 读 + 0 写：恰为 list_task_experiences 与 read_task_experience', async () => {
    const { names } = await experienceTools();
    expect([...names].sort()).toEqual(['list_task_experiences', 'read_task_experience']);
    // 0 写的派生判据：工具名里不得出现任何写动词（edit/merge/archive/delete/
    // create/set/attach/write）——将来有人往这个工厂里加写工具，先撞这里。
    for (const name of names) {
      expect(/edit|merge|archive|delete|create|set|attach|write|update|restore/i.test(name), `${name} 疑似写工具`).toBe(false);
    }
  });

  it('工具名 ⊆ TOOL_CATALOG：recall 组、无 localExec、不按 agent 收窄', async () => {
    const [{ TOOL_CATALOG }, { names }] = await Promise.all([
      import('../../../../src/main/model/core-agent/tool-catalog'),
      experienceTools(),
    ]);
    const catalogNames = new Set(TOOL_CATALOG.map((entry) => entry.name));
    for (const name of names) {
      expect(catalogNames.has(name), `${name} 缺 TOOL_CATALOG 行（反漂移）`).toBe(true);
      const entry = TOOL_CATALOG.find((row) => row.name === name)!;
      expect(entry.group, name).toBe('recall');
      expect(entry.permission, `${name} 不得要求 localExec`).toBeUndefined();
      expect(entry.ownerAgent, `${name} 不得按 agent 收窄`).toBeUndefined();
    }
  });

  it('不进只读会话闭合白名单（精确断言 + 派生判据，与 asset-steward 同口径）', async () => {
    const [{ TOOL_CATALOG }, { READ_ONLY_TOOL_ALLOWLIST, READ_ONLY_BUILTIN_ALLOWLIST }] = await Promise.all([
      import('../../../../src/main/model/core-agent/tool-catalog'),
      import('../../../../src/main/model/core-agent/runner'),
    ]);
    // 精确断言：两个经验工具逐一确认。
    for (const name of ['list_task_experiences', 'read_task_experience']) {
      expect(READ_ONLY_TOOL_ALLOWLIST.has(name), `${name} 不得进入只读白名单`).toBe(false);
      expect(READ_ONLY_BUILTIN_ALLOWLIST.has(name), `${name} 不得进入只读内建白名单`).toBe(false);
    }
    // 派生断言：recall 组整体不进白名单——将来往 recall 组加工具自动被覆盖
    // （与 asset-steward-tools.test.ts 的判据同源，两处同时绿才是真绿）。
    const recallTools = TOOL_CATALOG.filter((entry) => entry.group === 'recall').map((entry) => entry.name);
    expect(recallTools).toEqual(expect.arrayContaining([
      'list_task_experiences', 'read_task_experience',
      'list_ability_assets', 'read_ability_asset', 'search_ability_assets', 'personal_ontology_fields',
    ]));
    for (const name of recallTools) {
      expect(READ_ONLY_TOOL_ALLOWLIST.has(name), `${name} 不得进入只读白名单`).toBe(false);
      expect(READ_ONLY_BUILTIN_ALLOWLIST.has(name), `${name} 不得进入只读内建白名单`).toBe(false);
    }
  });
});

// ── list_task_experiences 行为契约 ────────────────────────────────────────

describe('list_task_experiences', () => {
  const TASK_TEXT = '修复登录函数的缺陷';

  it('任务文本模式：同类型出现、无关类型与低相关通用条目零出现、清单行不含正文', async () => {
    const codeBody = '遇到登录超时先查会话过期与网络重试两个源头，再改代码。';
    await seedExperience({ id: 'exp-code-0001', taskType: 'code', body: codeBody, title: '登录超时先查源头' });
    await seedExperience({ id: 'exp-report-01', taskType: 'report', body: '报告类正文不应出现。', title: '无关类型的报告经验' });
    await seedExperience({ id: 'exp-general-1', taskType: 'general', body: '通用但与本轮无关的经验正文。', title: '低相关通用经验' });
    await injectEmbeddings([
      [TASK_TEXT, [1, 0, 0]],
      [codeBody, [1, 0, 0]],           // 相关度 1.00 → ★
      ['报告类正文不应出现。', [0, 1, 0]],
      ['通用但与本轮无关的经验正文。', [0, 1, 0]],  // 相关度 0 < 0.40 → 缺席
    ]);

    const { list } = await experienceTools({ taskText: TASK_TEXT });
    const out = text(await list.execute({}, {} as never));
    expect(out).toContain('任务经验目录');
    expect(out).toContain('[exp:exp-code-0001]');
    expect(out).toContain('登录超时先查源头');
    expect(out).toContain('★');
    // 无关任务类型零出现（AC1）；通用条目相关度不达标也不出现。
    expect(out).not.toContain('无关类型的报告经验');
    expect(out).not.toContain('低相关通用经验');
    // 受限正文边界：清单行、日志一律不含正文（正文只在模型显式读取时给）。
    expect(out).not.toContain(codeBody);
    expect(out).not.toContain('通用但与本轮无关的经验正文');
    // 取用指引：正文要自取。
    expect(out).toContain('read_task_experience');
  });

  it('入参 taskText 优先于装配时带回的消息文本；两者都没有时浏览全量在用经验', async () => {
    await seedExperience({ id: 'exp-code-0002', taskType: 'code', body: '代码类经验正文。' });
    await seedExperience({ id: 'exp-review-01', taskType: 'review', body: '审查类经验正文。' });
    await injectEmbeddings([
      ['审查一份架构设计文档', [1, 0, 0]],
      ['代码类经验正文。', [0, 1, 0]],
      ['审查类经验正文。', [1, 0, 0]],
    ]);

    const { list } = await experienceTools({ taskText: TASK_TEXT });
    // 模型显式传 taskText：按它做类型推断（审查类文本 → review）。
    const byInput = text(await list.execute({ taskText: '审查一份架构设计文档' }, {} as never));
    expect(byInput).toContain('[exp:exp-review-01]');
    expect(byInput).not.toContain('[exp:exp-code-0002]');

    // 无任何任务文本：浏览模式，在用经验全量可见（近度序）。
    const bare = await experienceTools();
    const browse = text(await bare.list.execute({}, {} as never));
    expect(browse).toContain('[exp:exp-code-0002]');
    expect(browse).toContain('[exp:exp-review-01]');
  });

  it('taskType 浏览模式 + type 过滤 + 分页；空态与越界给明确语义', async () => {
    await seedExperience({ id: 'exp-rep-a0001', taskType: 'report', body: '报告甲。', experienceType: 'workflow' });
    await seedExperience({ id: 'exp-rep-a0002', taskType: 'report', body: '报告乙。', experienceType: 'lesson' });
    await seedExperience({ id: 'exp-code-0003', taskType: 'code', body: '代码丙。', experienceType: 'lesson' });
    const { list } = await experienceTools();

    const byTaskType = text(await list.execute({ taskType: 'report' }, {} as never));
    expect(byTaskType).toContain('[exp:exp-rep-a0001]');
    expect(byTaskType).toContain('[exp:exp-rep-a0002]');
    expect(byTaskType).not.toContain('[exp:exp-code-0003]');

    const byType = text(await list.execute({ taskType: 'report', type: 'workflow' }, {} as never));
    expect(byType).toContain('[exp:exp-rep-a0001]');
    expect(byType).not.toContain('[exp:exp-rep-a0002]');

    const page = text(await list.execute({ taskType: 'report', limit: 1 }, {} as never));
    expect(page).toContain('本页 1-1 条');
    expect(page).toMatch(/还有 1 条：用 offset=1/);
    const page2 = text(await list.execute({ taskType: 'report', limit: 1, offset: 1 }, {} as never));
    expect(page2).toContain('这是最后一页');

    // 工具是模型的显式查询：空态如实说 0 条（与提示词 hint 的"缺席不说 0"不同口径）。
    const empty = text(await list.execute({ taskType: 'product' }, {} as never));
    expect(empty).toContain('共 0 条');
    const beyond = text(await list.execute({ taskType: 'report', offset: 99 }, {} as never));
    expect(beyond).toContain('已到目录末尾');
    expect(beyond).toContain('共 2 条');
  });
});

// ── read_task_experience 行为契约 ─────────────────────────────────────────

describe('read_task_experience', () => {
  it('正文分批：单批 ≤2000 字、拼接与原文逐字一致、给下一批提示', async () => {
    const longBody = `性能类提问必须用真实日志做分层归因：先拆链路、再定位瓶颈、最后只给一个可优化项。${'数据缺口时先说明缺口，不要编造计时数字。'.repeat(150)}`;
    const seeded = await seedExperience({ id: 'exp-long-0001', taskType: 'code', body: longBody, title: '长正文分批用例' });
    expect(longBody.length).toBeGreaterThan(2_000);
    expect(longBody.length).toBeLessThanOrEqual(4_000);

    const { read } = await experienceTools();
    const first = await read.execute({ experienceId: seeded.id }, {} as never);
    expect(first.isError).not.toBe(true);
    expect(first.content).toContain('[exp:exp-long-0001]');
    expect(first.content).toContain('第 1/2 批');
    expect(first.content).toContain('用 chunk=1 继续');
    const second = await read.execute({ experienceId: seeded.id, chunk: 1 }, {} as never);
    expect(second.content).toContain('这是最后一批');

    // 拼接逐字一致：分批不得丢字、改字（正文无换行，标记行的下一行即整批）。
    const chunkLineAfter = (out: string, batchNo: number): string => {
      const lines = out.split('\n');
      const markerIdx = lines.findIndex((line) => new RegExp(`^正文（第 ${batchNo}/\\d+ 批，共 \\d+ 字）:$`).test(line));
      expect(markerIdx, `找不到第 ${batchNo} 批的正文标记行`).toBeGreaterThan(-1);
      return lines[markerIdx + 1];
    };
    expect(chunkLineAfter(first.content, 1)).toBe(longBody.slice(0, 2_000));
    expect(chunkLineAfter(second.content, 2)).toBe(longBody.slice(2_000));
    // 越界批次：明确报错而不是空批。
    const beyond = await read.execute({ experienceId: seeded.id, chunk: 2 }, {} as never);
    expect(beyond.isError).toBe(true);
    expect(beyond.content).toContain('chunk 越界');
  });

  it('准入被拦：如实报拦截规则、不交正文、不写回执与流水', async () => {
    const paused = await seedExperience({ id: 'exp-paused-01', taskType: 'code', body: '已暂停经验的正文不得交出。', status: 'paused' });
    const forbidden = await seedExperience({
      id: 'exp-forbid-01', taskType: 'code', body: '命中禁用场景的经验正文不得交出。', forbiddenWhen: ['内部快速对齐'],
    });
    const { read } = await experienceTools({ turnId: 'turn-exp-blk1', taskText: '内部快速对齐：先对齐口径' });
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/usage-service');

    const pausedRead = await read.execute({ experienceId: paused.id }, {} as never);
    expect(pausedRead.isError).toBe(true);
    expect(pausedRead.content).toContain('当前不可');
    expect(pausedRead.content).toContain('status_not_active');
    expect(pausedRead.content).not.toContain('已暂停经验的正文不得交出');

    const forbiddenRead = await read.execute({ experienceId: forbidden.id }, {} as never);
    expect(forbiddenRead.isError).toBe(true);
    expect(forbiddenRead.content).toContain('forbidden_context');
    expect(forbiddenRead.content).not.toContain('命中禁用场景的经验正文不得交出');

    const rows = await receipts.listInjectionReceipts(TEST_UID, 'turn-exp-blk1');
    expect(rows.filter((row) => row.assetId === paused.id || row.assetId === forbidden.id)).toHaveLength(0);
    expect(await usage.listRecallUsage(TEST_UID, paused.id)).toHaveLength(0);
    expect(await usage.listRecallUsage(TEST_UID, forbidden.id)).toHaveLength(0);
  });

  it('留痕口径同 search_ability_assets：agent_read 回执 + 使用流水；同回合重复读只记一次', async () => {
    const seeded = await seedExperience({ id: 'exp-read-0001', taskType: 'code', body: '读正文要写回执与流水的用例正文。' });
    const { read } = await experienceTools({ turnId: 'turn-exp-read1' });
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/usage-service');

    const out = await read.execute({ experienceId: seeded.id }, {} as never);
    expect(out.isError).not.toBe(true);

    const rows = await receipts.listInjectionReceipts(TEST_UID, 'turn-exp-read1');
    expect(rows.map((row) => `${row.channel}:${row.assetId}`)).toEqual([`agent_read:exp-read-0001`]);
    expect(rows[0].boundary).toBe('real');
    expect(rows[0].status).toBe('injected');
    const used = await usage.listRecallUsage(TEST_UID, seeded.id);
    expect(used.map((row) => row.outcome)).toEqual(['agent_read']);
    expect(used[0].taskRunId).toBe('turn-exp-read1');

    // 同一回合重复读：回执幂等 + 使用按回合计一次。
    await read.execute({ experienceId: seeded.id }, {} as never);
    expect(await usage.listRecallUsage(TEST_UID, seeded.id)).toHaveLength(1);
    expect(await receipts.listInjectionReceipts(TEST_UID, 'turn-exp-read1')).toHaveLength(1);

    // 跨回合各记一次（新回合计新账）。
    const nextTurn = await experienceTools({ turnId: 'turn-exp-read2' });
    await nextTurn.read.execute({ experienceId: seeded.id }, {} as never);
    expect(await usage.listRecallUsage(TEST_UID, seeded.id)).toHaveLength(2);
  });

  it('没有 turnId 只读不记账；非法 id 与不存在的 id 各给明确提示；零写经验记录', async () => {
    const seeded = await seedExperience({ id: 'exp-noturn-01', taskType: 'code', body: '没有回合上下文时不记账。' });
    const service = await import('../../../../src/main/features/recall/experience-service');
    const before = JSON.stringify((await service.listExperiences(TEST_UID)).map((item) => ({ ...item })));
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');

    const noTurn = await experienceTools();
    const out = await noTurn.read.execute({ experienceId: seeded.id }, {} as never);
    expect(out.isError).not.toBe(true);
    expect(await receipts.listInjectionReceipts(TEST_UID)).toHaveLength(0);

    const badId = await noTurn.read.execute({ experienceId: '../etc/passwd' }, {} as never);
    expect(badId.isError).toBe(true);
    expect(badId.content).toContain('不是合法的经验 id');
    const wrongPrefix = await noTurn.read.execute({ experienceId: 'aa-foreign-0001' }, {} as never);
    expect(wrongPrefix.isError).toBe(true);
    expect(wrongPrefix.content).toContain('不是合法的经验 id');
    const missing = await noTurn.read.execute({ experienceId: 'exp-missing-99' }, {} as never);
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('未找到');

    // 0 写：读与列都不改经验集合（记录数与内容逐字不变——留痕落在回执/流水
    // 集合，那是口径内的记账，不是业务写）。
    const listOut = await noTurn.list.execute({}, {} as never);
    expect(listOut.isError).not.toBe(true);
    const after = JSON.stringify((await service.listExperiences(TEST_UID)).map((item) => ({ ...item })));
    expect(after).toBe(before);
  });
});
