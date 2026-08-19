import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'test-user-rd';
const MOD = '../../../../src/main/features/cognition/review-decision';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-review-decision-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules(); // paths.ts WS_ROOT 模块加载时求值
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  return import(MOD);
}

describe('review-decision › 写入与读取', () => {
  it('四决定可写入并读回，账本按候选分区', async () => {
    const m = await loadMod();
    for (const type of ['accept', 'modify', 'defer', 'reject'] as const) {
      const rd = await m.writeReviewDecision(UID, {
        targetRef: `p3394_experience:cand-001`,
        decisionType: type,
        decision: type,
        antecedentRef: 'cand-001',
        scope: 'workspace:sp_x',
      });
      expect(rd.decision_id).toMatch(/^rd_/);
      expect(rd.target_ref).toBe('p3394_experience:cand-001');
      expect(rd.decision_type).toBe(type);
    }
    const list = await m.listReviewDecisions(UID, 'p3394_experience:cand-001');
    expect(list.length).toBe(4);
    expect(list.map((d) => d.decision_type)).toEqual(['accept', 'modify', 'defer', 'reject']);
  });

  it('短确认语缺 antecedent_ref → 拒绝写入（FR-REV-03 资产零变化）', async () => {
    const m = await loadMod();
    await expect(m.writeReviewDecision(UID, {
      targetRef: 'p3394_experience:cand-002',
      decisionType: 'accept',
      decision: '采用', // 短确认语
    })).rejects.toThrow('short confirmation requires antecedent_ref');
    // 账本无记录
    expect((await m.listReviewDecisions(UID, 'p3394_experience:cand-002')).length).toBe(0);
  });

  it('非短确认语（带解释）无 antecedent 可写入', async () => {
    const m = await loadMod();
    const rd = await m.writeReviewDecision(UID, {
      targetRef: 'p3394_experience:cand-003',
      decisionType: 'reject',
      decision: '这个规则只适用于客户 A 的项目，不通用',
      reason: 'scope too narrow',
    });
    expect(rd.decision_id).toBeDefined();
  });

  it('非法 decision_type 抛错', async () => {
    const m = await loadMod();
    await expect(m.writeReviewDecision(UID, {
      targetRef: 'x:cand-004', decisionType: 'maybe' as never, decision: 'maybe',
    })).rejects.toThrow('invalid review decision type');
  });

  it('modify 记录 modified_content', async () => {
    const m = await loadMod();
    const rd = await m.writeReviewDecision(UID, {
      targetRef: 'p3394_patch:cand-005',
      decisionType: 'modify',
      decision: 'modify',
      modifiedContent: '把适用范围改为国内市场团队',
    });
    expect(rd.modified_content).toBe('把适用范围改为国内市场团队');
  });
});

describe('review-decision › 抑制语义（FR-EXT-07）', () => {
  it('defer/reject 后抑制；accept 覆盖后解除；无记录不抑制', async () => {
    const m = await loadMod();
    expect(await m.isCandidateSuppressed(UID, 'p3394_experience:cand-010')).toBe(false);

    await m.writeReviewDecision(UID, { targetRef: 'p3394_experience:cand-010', decisionType: 'defer', decision: 'defer' });
    expect(await m.isCandidateSuppressed(UID, 'p3394_experience:cand-010')).toBe(true);

    // accept 覆盖 → 解除抑制
    await m.writeReviewDecision(UID, { targetRef: 'p3394_experience:cand-010', decisionType: 'accept', decision: 'accept', antecedentRef: 'cand-010' });
    expect(await m.isCandidateSuppressed(UID, 'p3394_experience:cand-010')).toBe(false);
  });

  it('reject 后同样抑制', async () => {
    const m = await loadMod();
    await m.writeReviewDecision(UID, { targetRef: 'p3394_experience:cand-011', decisionType: 'reject', decision: 'reject', reason: 'not reusable' });
    expect(await m.isCandidateSuppressed(UID, 'p3394_experience:cand-011')).toBe(true);
  });
});

/**
 * G-4 「已处理历史」读口。
 *
 * 存储是一个 targetRef 一个 jsonl，既有的 `listReviewDecisions` 只能按 targetRef
 * 单读，回答不了"我一共处理过什么"。这组用例钉的是**跨候选合并**这件事本身，
 * 以及 items/total 的分离语义。
 */
describe('review-decision › 已处理历史（listRecentReviewDecisions）', () => {
  async function seed(count: number) {
    const mod = await loadMod();
    for (let i = 0; i < count; i += 1) {
      await mod.writeReviewDecision(UID, {
        targetRef: `p3394_experience:cand-${i}`,
        decisionType: i % 2 === 0 ? 'accept' : 'reject',
        decision: `决定 ${i}`,
        actor: 'user',
        scope: 'default',
      });
      // 时间戳同秒会让倒序不稳定，拉开一点。
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return mod;
  }

  it('跨候选合并，按处理时间倒序', async () => {
    const mod = await seed(4);
    const page = await mod.listRecentReviewDecisions(UID, {});
    expect(page.total).toBe(4);
    expect(page.items).toHaveLength(4);
    const targets = page.items.map((item: any) => item.target_ref);
    expect(new Set(targets).size).toBe(4);
    const times = page.items.map((item: any) => item.timestamp);
    expect([...times].sort().reverse()).toEqual(times);
  });

  /** Contract：limit 截断 items，但 total 必须是真实总数。 */
  it('limit 截断 items，total 不受影响', async () => {
    const mod = await seed(7);
    const page = await mod.listRecentReviewDecisions(UID, { limit: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(7);
    expect(page.items.length).toBeLessThanOrEqual(3);
  });

  /** 同一 decision_id 的 outcome 回填后，历史里应当只出现终态那一条。 */
  it('同一决定只出现一次，且是回填 outcome 之后的终态', async () => {
    const mod = await loadMod();
    const written = await mod.writeReviewDecision(UID, {
      targetRef: 'p3394_experience:cand-outcome',
      decisionType: 'accept',
      // 短确认语（"确认"/"好"）要求 antecedent_ref，这里用完整表述避开那条规则
      // ——本用例测的是 outcome 回填，不是短确认解析。
      decision: '确认把这条候选保存为正式资产',
      actor: 'user',
    });
    await mod.recordReviewDecisionOutcome(UID, 'p3394_experience:cand-outcome', written.decision_id, {
      assetId: 'aa-1',
    });

    const page = await mod.listRecentReviewDecisions(UID, {});
    const rows = page.items.filter((item: any) => item.decision_id === written.decision_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('asset_created');
    expect(rows[0].asset_id).toBe('aa-1');
    expect(page.total).toBe(1);
  });

  /** 没有任何决定时是真空，不是报错，也不能凭空补记录。 */
  it('没有落账记录时返回空页而不是报错', async () => {
    const mod = await loadMod();
    const page = await mod.listRecentReviewDecisions(UID, {});
    expect(page).toEqual({ items: [], total: 0 });
  });

  /**
   * Persistence：历史不能靠调用方内存维持。重新 import 模块（模拟重载）后
   * 同一批记录必须还在。
   */
  it('重新加载模块后历史仍然完整', async () => {
    await seed(3);
    vi.resetModules();
    const reloaded = await loadMod();
    const page = await reloaded.listRecentReviewDecisions(UID, {});
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(3);
  });
});
