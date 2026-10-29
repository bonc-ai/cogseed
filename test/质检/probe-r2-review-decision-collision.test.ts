/**
 * 不同 targetRef 的决定账本文件身份隔离与抑制状态独立性：
 * 文件名折叠同名（`:` 与 `/` 都净化成 `_`）时，账本行按真实 target_ref
 * 精确过滤——B 的决定不改写 A 的抑制状态，历史清单不串档。
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

describe('决定账本折叠隔离', () => {
  it('targetRef 折叠同名 → 行级隔离：B 的决定不改写 A 的抑制状态，清单不串档', async () => {
    const rd = await loadRd();
    const targetA = 'recall_candidate:abc';
    const targetB = 'recall_candidate/abc'; // 折叠后与 A 同名（: 与 / 都 → _）

    // A 拒绝（应被抑制，不再提示）。
    await rd.writeReviewDecision(UID, {
      targetRef: targetA,
      decisionType: 'reject',
      decision: '不要',
      antecedentRef: 'cand-abc',
    });
    expect(await rd.isCandidateSuppressed(UID, targetA)).toBe(true);

    // B 接受（B 是另一个候选，与 A 无关）。
    await rd.writeReviewDecision(UID, {
      targetRef: targetB,
      decisionType: 'accept',
      decision: '采用',
      antecedentRef: 'cand-abc2',
    });

    // A 的抑制不被 B 的 accept 解除（行级 target_ref 过滤）。
    expect(await rd.isCandidateSuppressed(UID, targetA)).toBe(true);
    // B 按其最近决定（accept）不被抑制。
    expect(await rd.isCandidateSuppressed(UID, targetB)).toBe(false);

    // 清单互不串档：A 的历史不混进 B 的清单，反之亦然。
    const listOfB = await rd.listReviewDecisions(UID, targetB);
    expect(listOfB.every((d) => d.target_ref === targetB)).toBe(true);
    const listOfA = await rd.listReviewDecisions(UID, targetA);
    expect(listOfA.every((d) => d.target_ref === targetA)).toBe(true);
    expect(listOfA.length).toBe(1);
    expect(listOfB.length).toBe(1);

    // 磁盘上两个 target 共用一个折叠账本文件（存储布局不变；隔离靠行级
    // 自描述 target_ref，而不是拆文件）。
    const { cogseedAgentReviewDecisionsDir } = await import('../../src/main/paths');
    const files = fs.readdirSync(cogseedAgentReviewDecisionsDir(UID));
    expect(files.filter((n) => n.endsWith('.jsonl')).length).toBe(1);

    // 跨候选「已处理历史」视图仍能看到两者各自的决定（独立条目）。
    const recent = await rd.listRecentReviewDecisions(UID, { limit: 50 });
    expect(recent.total).toBe(2);
  });
});
