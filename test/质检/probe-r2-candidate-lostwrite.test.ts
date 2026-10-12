/**
 * 探针 r2（边界测试员 · 并发与时序）：候选池「确认窗口」丢写。
 *
 * 推演链：confirmCandidate 在 readCandidates（:951）之后、writeCandidates
 * （:964）之前有多个 await（resolveLlmRoute / writeCandidateToDestinations
 * 内部的资产轨 fs IO）。窗口内任何同步写池操作（addCandidate / addCandidates，
 * 全同步原子）写入的新候选，会被 confirm 基于旧快照的整文件回写**覆盖掉**——
 * 新候选静默消失（比 r1 的复活更糟：数据丢失而非状态倒退）。
 * 触发场景：用户在甄别页点确认的同时，资产回流 backflowAssetToOntologyPool
 * 或 onboarding 抽取 addCandidates 写池。
 *
 * 时序确定性：confirm 同步跑到第一个 await 让出 → 主线程执行同步的
 * addCandidate → 恢复 confirm。JS 单线程下该交错确定发生。
 *
 * 2026-09-30 r2 收尾（记账员）：用例 1 对应待议 P-r2-1（与 r1 P-r1-1 同根
 * 延续；写前重读 vs fileEditLock 两修法并存待拍板）→ it.skip，断言锁定的
 * 是「现状静默丢失」。用例 2/3（对照组）保留 active：锁定无交错时的正确
 * 路径，不依赖漏洞，修复后应持续绿。见 round-2-甄别.md toPending。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r2-lost';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r2b-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function candidatesMd(): string {
  return path.join(tmpDir, UID, 'local', 'ontology_candidates', 'candidates.md');
}

async function loadCands() {
  return import('../../src/main/features/personal_ontology_candidates');
}

async function seedPool(ids: string[]): Promise<void> {
  const cands = await loadCands();
  const list = ids.map((id) => ({
    candidate_id: id,
    kind: 'preference' as const,
    confidence: 'high' as const,
    summary: `候选 ${id}`,
    memory_scope: 'user' as const,
    memory_text: `内容-${id}`,
    source_memory_refs: [],
  }));
  fs.mkdirSync(path.dirname(candidatesMd()), { recursive: true });
  fs.writeFileSync(candidatesMd(), cands.serializeCandidatesMarkdown(list));
}

describe('probe r2 › 候选池确认窗口丢写（待议项已 skip）', () => {
  // 待议 P-r2-1：确认窗口丢写（合并两路发现，r1 P-r1-1 延续）。断言锁定
  // 「回流候选被旧快照回写吞掉」现状，拍板修复后反转为「不丢失」。
  it.skip('确认的 await 窗口内 addCandidate 写入的新候选被旧快照回写吞掉（静默丢失）', async () => {
    await seedPool(['cand-a', 'cand-b']);
    const cands = await loadCands();

    // 1) 发起确认：同步跑到第一个 await（resolveLlmRoute 调用点）让出主线程
    const confirming = cands.confirmCandidate(UID, 'cand-a');
    // 2) 窗口内：回流/新增候选（addCandidate 全同步，立即落盘）
    const added = await cands.addCandidate(UID, {
      candidate_id: 'asset-backflow-x1',
      kind: 'rule',
      summary: '回流候选',
      memory_text: '回流内容',
    });
    expect(added.ok).toBe(true);
    // 落盘瞬间：3 条都在
    const mid = await cands.listCandidates(UID);
    expect(mid.candidate_updates.map((c) => c.candidate_id).sort())
      .toEqual(['asset-backflow-x1', 'cand-a', 'cand-b']);
    // 3) confirm 恢复：基于 [a,b] 快照 splice → 整文件回写 [b]
    const result = await confirming;
    expect(result.ok).toBe(true);
    // 4) 回流候选凭空消失（被覆盖），确认内容却已写进记忆
    const after = await cands.listCandidates(UID);
    expect(after.candidate_updates.map((c) => c.candidate_id)).toEqual(['cand-b']);
  });

  // 保留 active（对照组）：无交错时不丢，修复 P-r2-1 后应持续绿。
  it('对照组：addCandidate 先完成再确认——不丢（证明丢失是交错独有）', async () => {
    await seedPool(['cand-c']);
    const cands = await loadCands();
    await cands.addCandidate(UID, {
      candidate_id: 'asset-backflow-x2',
      kind: 'rule',
      summary: '回流候选2',
      memory_text: '回流内容2',
    });
    expect((await cands.confirmCandidate(UID, 'cand-c')).ok).toBe(true);
    const after = await cands.listCandidates(UID);
    expect(after.candidate_updates.map((c) => c.candidate_id)).toEqual(['asset-backflow-x2']);
  });

  // 保留 active（对比证据）：reject 全同步原子无交错窗口，修复后应持续绿。
  it('rejectCandidate 全同步原子：同窗口交错不丢（与 confirm 的对比证据）', async () => {
    await seedPool(['cand-d', 'cand-e']);
    const cands = await loadCands();
    // reject 是 async 声明但函数体全同步（read→splice→write 无 await）
    const rejecting = cands.rejectCandidate(UID, 'cand-d');
    await cands.addCandidate(UID, {
      candidate_id: 'asset-backflow-x3',
      kind: 'rule',
      summary: '回流候选3',
      memory_text: '回流内容3',
    });
    await rejecting;
    const after = await cands.listCandidates(UID);
    // reject 同步完成于 addCandidate 之前，无交错窗口 → 不丢
    expect(after.candidate_updates.map((c) => c.candidate_id).sort())
      .toEqual(['asset-backflow-x3', 'cand-e']);
  });
});
