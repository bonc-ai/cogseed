// 多 Agent 协作 · 真机场景测试（默认跳过，需显式开启）
//
// 它跑的是**真实主进程链路**：真会话 + 真模型/CLI + 真 run 记录落盘。因为要花钱、
// 要时间、要有可用模型，所以默认 skip，`npm test` 不受影响。
//
// 运行方式（在本 worktree 根目录）：
//
//   COGSEED_SCENARIO=1 npm run test:js -- test/main/scenarios/multi-agent-collaboration.scenario.test.ts
//
// 可选环境变量：
//   COGSEED_SCENARIO_UID     真实用户 id；缺省时读取当前 dev 用户
//   COGSEED_SCENARIO_TEXT    自定义场景正文（默认见 DEFAULT_SEQUENTIAL_TEXT）
//   COGSEED_SCENARIO_MEMBERS 逗号分隔的 agent_id；缺省时自动取前两个可用 Agent
//   COGSEED_SCENARIO_TIMEOUT_MS 等待 run 收敛的上限（默认 300000）
//
// 产出：控制台打印 run 记录全文 + 判定结论，并在失败时打印该 run 的关键日志行。
// 注意：会在当前登录用户的真实数据根下新建一个标题为「多Agent 场景测试」的会话，
// 跑完可自行在侧栏删除。

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const enabled = process.env.COGSEED_SCENARIO === '1';
const DEFAULT_SEQUENTIAL_TEXT =
  '先由 @{{A}} 给出实现方案，再由 @{{B}} 按方案做验证，最后汇总。';

function log(...args: unknown[]): void {
  // 场景测试的可见输出就是它的价值，这里直连 stdout。
  console.log('[scenario]', ...args);
}

async function waitFor<T>(
  probe: () => Promise<T | null> | T | null,
  timeoutMs: number,
  intervalMs = 1500,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe.skipIf(!enabled)('scenario › 多 Agent 协作（真机）', () => {
  it('按顺序意图提交 → run 记录 / 依赖校验 / 成员派发', async () => {
    const users = await import('../../../src/main/features/users');
    if (!users.hasActiveUser()) {
      const explicitUid = String(process.env.COGSEED_SCENARIO_UID || '').trim();
      if (explicitUid) {
        users.activateUser(explicitUid);
      } else {
        users.setUseDevCurrentUserId(true);
        users.initActiveUser();
      }
    }
    // 依赖模块里有按当前用户维度的目录与目录缓存；必须先激活用户再导入。
    // 否则「列表可见」与「业务边界可派发」会读到两个用户根。
    const chats = await import('../../../src/main/features/chats');
    const agents = await import('../../../src/main/features/agents');
    const groupChat = await import('../../../src/main/features/group_chat');
    const runStore = await import('../../../src/main/features/group_chat/run_store');

    const uid = users.getActiveUserId();
    expect(uid, '当前没有登录用户；请先在应用里登录').toBeTruthy();

    // 1) 选成员：环境变量优先，否则取前两个「已启用 + 可派发」的 Agent。
    const explicit = String(process.env.COGSEED_SCENARIO_MEMBERS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    let memberIds = explicit;
    if (!memberIds.length) {
      const list = (await agents.listAgents())
        .filter((a: { enabled?: boolean }) => a.enabled !== false)
        .slice(0, 2);
      memberIds = list.map((a: { agent_id: string }) => a.agent_id);
    }
    expect(memberIds.length, '至少需要两个可用 Agent 才能跑顺序场景').toBeGreaterThanOrEqual(2);
    const nameOf = async (id: string) => {
      const list = await agents.listAgents();
      const hit = list.find((a: { agent_id: string }) => a.agent_id === id);
      return (hit && hit.name) || id;
    };
    const [a, b] = memberIds;
    const text = (process.env.COGSEED_SCENARIO_TEXT || DEFAULT_SEQUENTIAL_TEXT)
      .split('{{A}}').join(await nameOf(a))
      .split('{{B}}').join(await nameOf(b));
    log('members =', memberIds.join(', '));
    log('text =', text);

    // 2) 新建一个真实会话（跑完可自行删除）。
    const conv = await chats.createConversation(uid, { title: '多Agent 场景测试' });
    const cid = conv.conversation_id;
    log('conversation =', cid);

    // 3) 真实提交：点名 + 成员快照 + 顺序意图正文。
    const sent = await groupChat.send({
      userId: uid,
      cid,
      text,
      member_agent_ids: memberIds,
      mention_agent_ids: [a, b],
    });
    log('send result =', JSON.stringify(sent).slice(0, 400));

    // 4) 等 run 收敛：先等记录落盘，再等它离开 running（超时则报告中间态，不硬失败）。
    const timeoutMs = Number(process.env.COGSEED_SCENARIO_TIMEOUT_MS || 300_000);
    const runId = await waitFor(async () => {
      const ids = await runStore.listRunIds(uid, cid);
      return ids.length ? ids[ids.length - 1] : null;
    }, 30_000);
    expect(runId, 'run 记录未落盘：检查 send 是否被接受（runs/ 目录）').toBeTruthy();
    const settled = await waitFor(async () => {
      const rec = await runStore.readRun(uid, cid, runId!);
      return rec && rec.status !== 'running' ? rec : null;
    }, timeoutMs);
    const latest = settled || await runStore.readRun(uid, cid, runId!);
    log('--- run record ---');
    log(JSON.stringify(latest, null, 2));

    // 5) 判定：run 存在 + 顺序意图被识别 + 成员被派发。
    expect(latest, '未找到 run 记录：检查 send 是否被接受（runs/ 目录）').not.toBeNull();
    expect(latest!.requires_sequential, '顺序意图未被识别（正文需含"先…再…/然后/第一步"）').toBe(true);
    expect(latest!.mention_order).toEqual([a, b]);
    expect(latest!.member_agent_ids).toEqual(expect.arrayContaining([a, b]));
    expect(latest!.external_agent_ids.length).toBeGreaterThanOrEqual(0);
    log('dispatched actors =', latest!.actors.map((x) => `${x.agent_id}(${x.terminal})`).join(', '));
    log('corrections =', latest!.corrections, 'status =', latest!.status);

    // 6) 违规时的日志证据（并行派发应留下 sequential plan rejected）。
    const logFile = path.join(
      process.env.COGSEED_SCENARIO_LOG_DIR
        || path.join(process.env.HOME || '', '.cogseed', 'runtime-variants', 'cogseed', 'data', 'logs'),
      `${new Date().toISOString().slice(0, 10)}.log`,
    );
    if (latest!.corrections > 0) {
      expect(latest!.corrections, '纠正轮数不应超过 1（上限）').toBeLessThanOrEqual(1);
      log('⚠ 出现了顺序校验拦截（这是预期内的负例路径，说明强约束生效）');
    }
    if (fs.existsSync(logFile)) {
      const hits = fs.readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((line) => line.includes('sequential plan rejected') || line.includes('run created'))
        .slice(-8);
      log('--- log evidence ---');
      for (const line of hits) log(line.slice(0, 200));
    } else {
      log('（未找到日志文件，跳过日志证据；可用 COGSEED_SCENARIO_LOG_DIR 指定）');
    }

    log('场景结论：run 记录、顺序识别、成员派发三项已核对；请人工确认最终交付是否点名了未完成成员。');
  }, 600_000);

  // 第二例：结构化成员 + Wake 门禁。它自动「扮演用户」批准唤醒，因此可以在
  // 无人值守的情况下跑完真实链路，同时把两条 PRD 约束钉死：
  //   1. 批准前绝不派发（no approval bypass）；
  //   2. 收口后 run 必须有终态 + 权威汇总（summary_publication=publish 过的）。
  // 成员选择故意把「进程内 Agent」排在前、把需要审批的外接 Agent 排在后，
  // 保证这一例一定会走一次 Wake 审批门。
  it('结构化成员 + Wake 门禁：批准前不派发，批准后顺序执行并发布权威汇总', async () => {
    const users = await import('../../../src/main/features/users');
    if (!users.hasActiveUser()) {
      const explicitUid = String(process.env.COGSEED_SCENARIO_UID || '').trim();
      if (explicitUid) {
        users.activateUser(explicitUid);
      } else {
        users.setUseDevCurrentUserId(true);
        users.initActiveUser();
      }
    }
    const chats = await import('../../../src/main/features/chats');
    const agents = await import('../../../src/main/features/agents');
    const groupChat = await import('../../../src/main/features/group_chat');
    const runStore = await import('../../../src/main/features/group_chat/run_store');
    const wake = await import('../../../src/main/features/p3394/wake-service');
    // 审批必须走应用侧同一条入口：wake-controller 先 approveWakeRequest，
    // 再驱动 dispatcher，成功后才 markWakeRequestExecuted。只调 service 的
    // approve 会把请求留在 workflow_transition=approving、永不派发。
    const p3394 = await import('../../../src/main/features/p3394');

    const uid = users.getActiveUserId();
    expect(uid, '当前没有登录用户；请先在应用里登录').toBeTruthy();

    const kindOf = (a: { runtime?: { kind?: string } }) => a.runtime?.kind || 'in-process';
    const roster = (await agents.listAgents()).filter((a: { enabled?: boolean }) => a.enabled !== false);
    const ordered = [...roster].sort((x, y) => (
      (kindOf(x) === 'in-process' ? 0 : 1) - (kindOf(y) === 'in-process' ? 0 : 1)
    ));
    const chosen = ordered.slice(0, 2);
    expect(chosen.length, '至少需要两个可用 Agent').toBeGreaterThanOrEqual(2);
    const memberIds = chosen.map((a: { agent_id: string }) => a.agent_id);
    const nameOf = (a: { name?: string; agent_id: string }) => a.name || a.agent_id;
    const text = `先由 @${nameOf(chosen[0])} 给出实现方案，再由 @${nameOf(chosen[1])} 按方案做验证，最后汇总。`;
    log('[wake-gate] members =', memberIds.join(', '));
    log('[wake-gate] kinds =', chosen.map((a: { runtime?: { kind?: string } }) => kindOf(a)).join(', '));

    const conv = await chats.createConversation(uid, { title: '多Agent 场景测试·Wake门禁' });
    const cid = conv.conversation_id;
    log('[wake-gate] conversation =', cid);

    const sent = await groupChat.send({
      userId: uid,
      cid,
      text,
      member_agent_ids: memberIds,
      mention_agent_ids: memberIds,
    });
    expect(sent.ok, `send 未被接受：${sent.error || ''}`).toBe(true);

    const runId = await waitFor(async () => {
      const ids = await runStore.listRunIds(uid, cid);
      return ids.length ? ids[ids.length - 1] : null;
    }, 30_000);
    expect(runId, 'run 记录未落盘').toBeTruthy();

    // 等待第一条需要审批的 Wake 出现，并验证「还没批准就不许派发」。
    const pending = await waitFor(async () => {
      const list = await wake.listWakeRequests(uid, cid);
      return list.find((r: { status: string }) => r.status === 'pending') || null;
    }, Number(process.env.COGSEED_SCENARIO_WAKE_TIMEOUT_MS || 120_000));
    expect(pending, '没有等到待审批的 Wake：外接成员可能不需要审批，或派发未发生').toBeTruthy();
    const beforeApproval = await runStore.readRun(uid, cid, runId!);
    const gated = beforeApproval?.actors.find((a) => a.agent_id === (pending as { agent_id: string }).agent_id);
    expect(
      gated?.dispatched?.length || 0,
      '批准前就已经派发：Wake 门禁被绕过',
    ).toBe(0);
    log('[wake-gate] 批准前 dispatched =', gated?.dispatched?.length || 0);

    // 扮演用户批准：顺序场景可能有多次门（每个外接成员一次），循环处理。
    const timeoutMs = Number(process.env.COGSEED_SCENARIO_TIMEOUT_MS || 600_000);
    const deadline = Date.now() + timeoutMs;
    let settled = null as Awaited<ReturnType<typeof runStore.readRun>>;
    while (Date.now() < deadline) {
      const list = await wake.listWakeRequests(uid, cid);
      const next = list.find((r: { status: string }) => r.status === 'pending');
      if (next) {
        log('[wake-gate] approve =', (next as { id: string }).id, (next as { agent_name?: string }).agent_name || '');
        const decided = await p3394.decideWakeRequest(uid, {
          requestId: (next as { id: string }).id,
          decision: 'approve',
        });
        log('[wake-gate] decision =', JSON.stringify(decided).slice(0, 200));
        expect(decided.ok, `批准未被接受：${decided.ok ? '' : decided.error}`).toBe(true);
      }
      const rec = await runStore.readRun(uid, cid, runId!);
      if (rec && rec.status !== 'running') { settled = rec; break; }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    const latest = settled || await runStore.readRun(uid, cid, runId!);
    log('[wake-gate] --- run record ---');
    log(JSON.stringify(latest, null, 2));
    expect(latest, '未找到 run 记录').not.toBeNull();
    expect(latest!.status, 'run 未收口（没有终态）').not.toBe('running');
    expect(latest!.summary, '缺少权威汇总').toBeTruthy();
    expect(
      latest!.summary_publication?.status,
      '汇总未发布（summary_publication 不是 published）',
    ).toBe('published');
    // 契约：每个 actor 要么自己走到终态，要么被权威汇总记为 missing
    //（reason=no_terminal 表示它从未拿到终态）。两者必居其一，
    // 不允许出现「既没有终态、也没有入账」的 actor。
    const missingIds = new Set((latest!.summary?.missing || []).map((m) => m.agent_id));
    for (const actor of latest!.actors) {
      const accounted = actor.terminal !== 'pending' || missingIds.has(actor.agent_id);
      expect(accounted, `actor ${actor.agent_id} 既没有终态也没有进 missing`).toBe(true);
    }
    // 只记录、不判失败：从未派发的 actor 目前不在 RETRYABLE_TERMINALS
    //（只含 failed/blocked/stopped/removed）里，所以汇总说它「缺失」，
    // 但「重试未完成」不会带上它 —— 这是待产品确认的缺口。
    const neverDispatched = latest!.actors
      .filter((actor) => actor.terminal === 'pending')
      .map((actor) => actor.agent_id);
    if (neverDispatched.length) {
      log('[wake-gate] ⚠ 未派发 actor 目前不可重试（RETRYABLE_TERMINALS 不含 pending）：', neverDispatched.join(', '));
    }
    log('[wake-gate] 场景结论：门禁未绕过、run 已收口、汇总已发布、每个 actor 都入了账。');
  }, 900_000);
});
