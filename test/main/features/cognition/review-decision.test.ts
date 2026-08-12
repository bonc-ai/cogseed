import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'test-user-rd';
const MOD = '../../../../src/main/features/cognition/review-decision';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-review-decision-'));
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
