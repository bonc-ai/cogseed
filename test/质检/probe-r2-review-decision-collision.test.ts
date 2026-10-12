/**
 * 红队探针 r2：review 决定账本文件名折叠串档——不同候选共用同一 jsonl，
 * 决定互相污染抑制判定（FR-EXT-07 拒绝/暂缓抑制失真）。
 *
 * 推演链：reviewDecisionLogPath（cognition/review-decision.ts:87-89）把
 * targetRef 的非 [A-Za-z0-9._-] 字符全部折叠成 `_`——`recall_candidate:abc`
 * 与 `recall_candidate/abc`（或 `x:y` 与 `x_y`）折叠后同名，共用一个
 * `<tail>.jsonl`。而 listReviewDecisions（:173-183）读文件**全量行**、只按
 * decision_id 去重，**不按 target_ref 过滤**；isCandidateSuppressed
 * （:249-257）取最后一条 decision_type 定抑制——B 候选的 accept 会解除
 * A 候选刚写入的 reject 抑制（或反向：B 的 reject 把 A 无辜压制）。
 * FR-EXT-07「同候选被 defer/reject 后无新 Evidence 不得重复提示」的判定
 * 基础被串档击穿。
 *
 * 2026-09-30 r2 收尾（记账员）：对应待议 P-r2-5（读回按 target_ref 过滤
 * 止血 / 文件名加短哈希去折叠根治 + 存量迁移 / 入口白名单叠加，组合策略
 * 待拍板）→ it.skip。断言锁定的是「现状串档」，拍板修复后反转。
 * 见 round-2-甄别.md toPending。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r2-rd';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r2-rd-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadRd() {
  return import('../../src/main/features/cognition/review-decision');
}

describe('probe r2 › 决定账本折叠串档（待议 P-r2-5，拍板前 skip）', () => {
  it.skip('targetRef 折叠同名 → B 的决定改写 A 的抑制状态', async () => {
    const rd = await loadRd();
    const targetA = 'recall_candidate:abc';
    const targetB = 'recall_candidate/abc'; // 折叠后与 A 同名（: 与 / 都 → _）

    // A 拒绝（应被抑制，不再提示）
    await rd.writeReviewDecision(UID, {
      targetRef: targetA,
      decisionType: 'reject',
      decision: '不要',
      antecedentRef: 'cand-abc',
    });
    expect(await rd.isCandidateSuppressed(UID, targetA)).toBe(true);

    // B 接受（B 是另一个候选，与 A 无关）
    await rd.writeReviewDecision(UID, {
      targetRef: targetB,
      decisionType: 'accept',
      decision: '采用',
      antecedentRef: 'cand-abc2',
    });

    // 串档实锤：A 的抑制被 B 的 accept 解除
    expect(await rd.isCandidateSuppressed(UID, targetA)).toBe(false);
    // 反向同样成立：A 的历史决定混进 B 的清单
    const listOfB = await rd.listReviewDecisions(UID, targetB);
    expect(listOfB.some((d) => d.target_ref === targetA)).toBe(true);

    // 磁盘上两个 target 共用一个账本文件（折叠同名的直接证据）
    const { cogseedAgentReviewDecisionsDir } = await import('../../src/main/paths');
    const files = fs.readdirSync(cogseedAgentReviewDecisionsDir(UID));
    expect(files.filter((n) => n.endsWith('.jsonl')).length).toBe(1);
  });
});
