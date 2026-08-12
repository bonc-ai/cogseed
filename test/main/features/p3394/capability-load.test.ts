import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'test-user-cpl';
const MOD = '../../../../src/main/features/p3394/capability-load';
const RECEIPT = '../../../../src/main/features/p3394/context-reuse-receipt';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-capability-load-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules(); // paths.ts WS_ROOT 模块加载时求值
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  return import(MOD);
}

const mainSkill = { asset_id: 'sk-handoff', version: '1.0.0', content_hash: 'a'.repeat(64) };

/** 真实落盘一个未过期能力包，返回 pack。 */
async function buildPack(over: Record<string, unknown> = {}) {
  const cap = await import('../../../../src/main/features/p3394/capability-pack');
  return cap.buildCapabilityPack(UID, {
    purpose: 'Spike 目标端加载',
    mainSkillRef: mainSkill,
    ruleRefs: ['rule:sk-rule-1'],
    templateRefs: ['template:sk-tpl-1'],
    targetAgent: 'agent-b',
    scope: 'workspace:sp_x',
    ...over,
  });
}

const AVAILABLE_CLI = { type: 'hermes' as const, path: '/fake/hermes', version: '1.0.0', available: true };
const MISSING_CLI = { type: 'hermes' as const, path: null, version: null, available: false, error: 'not_found' as const };

const GOOD_ACTION_PLAN = `任务理解：使用能力包资产完成交付。
ACTION_PLAN:
- 步骤 1: 读取 Main Skill 并确认约束
- 步骤 2: 按模板生成交付物
- 步骤 3: 按规则校验并输出结果
`;

function fakeDeps(over: Record<string, unknown> = {}) {
  return {
    detectCli: async () => AVAILABLE_CLI,
    runCli: async () => ({ runId: 'run-fake-001', status: 'completed', output: GOOD_ACTION_PLAN }),
    ...over,
  };
}

describe('capability-load › 纯函数', () => {
  it('extractActionPlan：合法块通过（标记 + ≥3 步骤）', async () => {
    const m = await loadMod();
    const plan = m.extractActionPlan(GOOD_ACTION_PLAN);
    expect(plan).toContain('步骤 1');
    expect(plan).toContain('步骤 3');
  });

  it('extractActionPlan：Markdown 变体（## ACTION_PLAN + 加粗步骤）通过', async () => {
    const m = await loadMod();
    const hermesStyle = `## 任务理解\n\n我需要使用能力包中的资产。\n\n## ACTION_PLAN\n\n- **步骤 1**: 提取项目元数据\n- **步骤 2**: 检查可运行性\n- **步骤 3**: 撰写交接文档\n- **步骤 4**: 保存产出物\n\n需要我开始执行吗？`;
    const plan = m.extractActionPlan(hermesStyle);
    expect(plan).toContain('步骤 1');
    expect(plan).toContain('步骤 4');
  });

  it('extractActionPlan：加粗冒号变体（**ACTION_PLAN:**）通过', async () => {
    const m = await loadMod();
    const boldStyle = `## 任务理解\n\n我的策略是先加载技能。\n\n---\n\n**ACTION_PLAN:**\n\n- 步骤 1: 加载技能正文\n- 步骤 2: 套用模板填充\n- 步骤 3: 对照规则校验\n\n---\n\n需要我开始执行吗？`;
    const plan = m.extractActionPlan(boldStyle);
    expect(plan).toContain('步骤 3');
  });

  it('extractActionPlan：缺标记 / 缺步骤数 / 空输出 → null', async () => {
    const m = await loadMod();
    expect(m.extractActionPlan('没有行动计划')).toBeNull();
    expect(m.extractActionPlan('ACTION_PLAN:\n- 步骤 1\n- 步骤 2')).toBeNull(); // 只有 2 步
    expect(m.extractActionPlan('')).toBeNull();
  });

  it('buildCapabilityLoadPrompt：只装引用清单、不装资产正文', async () => {
    const m = await loadMod();
    const pack = await buildPack();
    const prompt = m.buildCapabilityLoadPrompt(pack, '生成交付方案');
    expect(prompt).toContain('sk-handoff@1.0.0');      // Main Skill 引用
    expect(prompt).toContain('rule:sk-rule-1');        // 规则引用
    expect(prompt).toContain('ACTION_PLAN:');          // 要求输出块
    expect(prompt).not.toContain('capabilityStatement'); // 无正文（AC-06）
    expect(prompt).not.toContain('SKILL.md');
  });
});

describe('capability-load › 前置拒绝（不 spawn）', () => {
  it('能力包不存在 → pack_not_found', async () => {
    const m = await loadMod();
    const runCli = vi.fn();
    const res = await m.loadCapabilityPackToTarget(UID, {
      packId: 'cp_missing', targetAgentId: 'target-x', cli: 'hermes',
      taskPrompt: '干活', cwd: tmpDir, allowedRoots: [tmpDir],
    }, fakeDeps({ runCli }));
    expect(res).toMatchObject({ ok: false, reason: 'pack_not_found', boundary: 'degraded' });
    expect(runCli).not.toHaveBeenCalled();
  });

  it('能力包过期 → expired，不 spawn', async () => {
    const m = await loadMod();
    const pack = await buildPack();
    // 直接改写 expires_at 为过去时间
    const cap = await import('../../../../src/main/features/p3394/capability-pack');
    const p = await cap.readCapabilityPack(UID, pack.pack_id);
    p!.expires_at = new Date(Date.now() - 1000).toISOString();
    await fs.promises.writeFile(cap.capabilityPackPath(UID, pack.pack_id), JSON.stringify(p));
    const runCli = vi.fn();
    const res = await m.loadCapabilityPackToTarget(UID, {
      packId: pack.pack_id, targetAgentId: 'target-x', cli: 'hermes',
      taskPrompt: '干活', cwd: tmpDir, allowedRoots: [tmpDir],
    }, fakeDeps({ runCli }));
    expect(res).toMatchObject({ ok: false, reason: 'expired', boundary: 'degraded' });
    expect(runCli).not.toHaveBeenCalled();
  });

  it('目标 CLI 缺失 → missing_cli，不 spawn（不冒充 real）', async () => {
    const m = await loadMod();
    const pack = await buildPack();
    const runCli = vi.fn();
    const res = await m.loadCapabilityPackToTarget(UID, {
      packId: pack.pack_id, targetAgentId: 'target-x', cli: 'hermes',
      taskPrompt: '干活', cwd: tmpDir, allowedRoots: [tmpDir],
    }, fakeDeps({ detectCli: async () => MISSING_CLI, runCli }));
    expect(res).toMatchObject({ ok: false, reason: 'missing_cli', boundary: 'degraded' });
    expect(runCli).not.toHaveBeenCalled();
  });

  it('cwd 越出沙箱 → cwd_denied', async () => {
    const m = await loadMod();
    const pack = await buildPack();
    const res = await m.loadCapabilityPackToTarget(UID, {
      packId: pack.pack_id, targetAgentId: 'target-x', cli: 'hermes',
      taskPrompt: '干活', cwd: '/etc', allowedRoots: [tmpDir],
    }, fakeDeps({}));
    expect(res).toMatchObject({ ok: false, reason: 'cwd_denied', boundary: 'degraded' });
  });
});

describe('capability-load › 执行与收尾', () => {
  it('成功：completed + ACTION_PLAN → ok:true boundary:real，回执 completed，事件落账', async () => {
    const m = await loadMod();
    const pack = await buildPack();
    const res = await m.loadCapabilityPackToTarget(UID, {
      packId: pack.pack_id, targetAgentId: 'target-x', cli: 'hermes',
      taskPrompt: '生成交付方案', cwd: tmpDir, allowedRoots: [tmpDir],
    }, fakeDeps({}));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.boundary).toBe('real');
    expect(res.actionPlan).toContain('步骤 1');
    expect(res.executionId).toBeTruthy();

    // 回执 completed
    const receipt = await import(RECEIPT);
    const r = await receipt.readReceipt(UID, res.executionId!);
    expect(r.status).toBe('completed');
    expect(r.boundary).toBe('real');
    expect(r.reusedRefs).toContain('sk-handoff');

    // 执行事件流含 capability_loaded
    const executions = await import('../../../../src/main/features/execution-records');
    const events = await executions.readEvents(UID, res.executionId!);
    const loaded = events.find((e: { type: string }) => e.type === 'capability_loaded');
    expect(loaded).toBeDefined();
    expect(loaded?.metadata?.packId).toBe(pack.pack_id);
    expect(loaded?.metadata?.boundary).toBe('real');
  });

  it('执行完成但无 Action Plan → no_action_plan，回执 degraded', async () => {
    const m = await loadMod();
    const pack = await buildPack();
    const res = await m.loadCapabilityPackToTarget(UID, {
      packId: pack.pack_id, targetAgentId: 'target-x', cli: 'hermes',
      taskPrompt: '干活', cwd: tmpDir, allowedRoots: [tmpDir],
    }, fakeDeps({ runCli: async () => ({ runId: 'run-fake-002', status: 'completed', output: '我干完了，但没有行动计划' }) }));

    expect(res).toMatchObject({ ok: false, reason: 'no_action_plan', boundary: 'degraded' });
    const receipt = await import(RECEIPT);
    const r = await receipt.readReceipt(UID, res.executionId!);
    expect(r.status).toBe('degraded');
  });

  it('执行失败 → execution_failed，回执 degraded', async () => {
    const m = await loadMod();
    const pack = await buildPack();
    const res = await m.loadCapabilityPackToTarget(UID, {
      packId: pack.pack_id, targetAgentId: 'target-x', cli: 'hermes',
      taskPrompt: '干活', cwd: tmpDir, allowedRoots: [tmpDir],
    }, fakeDeps({ runCli: async () => ({ runId: 'run-fake-003', status: 'failed', error: 'CLI crashed' }) }));

    expect(res).toMatchObject({ ok: false, reason: 'execution_failed', boundary: 'degraded' });
    const receipt = await import(RECEIPT);
    const r = await receipt.readReceipt(UID, res.executionId!);
    expect(r.status).toBe('degraded');
  });

  it('取消 → cancelled', async () => {
    const m = await loadMod();
    const pack = await buildPack();
    const res = await m.loadCapabilityPackToTarget(UID, {
      packId: pack.pack_id, targetAgentId: 'target-x', cli: 'hermes',
      taskPrompt: '干活', cwd: tmpDir, allowedRoots: [tmpDir],
    }, fakeDeps({ runCli: async () => ({ runId: 'run-fake-004', status: 'cancelled' }) }));

    expect(res).toMatchObject({ ok: false, reason: 'cancelled', boundary: 'degraded' });
  });
});
