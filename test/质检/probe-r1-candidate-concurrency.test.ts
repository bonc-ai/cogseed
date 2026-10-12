/**
 * 探针 r1（边界测试员）：个人本体候选池的并发双写 / 删除后复活。
 *
 * 推演链：confirmCandidate / rejectCandidate 对 candidates.md 是
 * 「读全文 → 改内存 → 整文件回写」（personal_ontology_candidates.ts:951/963/981），
 * 全程没有文件锁（writeCandidates 用 writeTextAtomicSync 直写）。
 * 两个并发确认各拿到同一份快照，各自删掉自己那条后回写——后写者把
 * 先写者已删除的另一条候选**复活**回池。已确认内容却已进 USER.md，
 * 复活的候选可被再次确认 → 重复写入记忆。
 *
 * 风格对齐 test/main/features/po/po-store.test.ts。
 *
 * 2026-09-30 r1 收尾（记账员）：用例 1/2 对应待议 P-r1-1（fileEditLock 包
 * 读写段 vs CAS 重读，锁范围取舍待拍板）→ it.skip；断言锁定的是「现状复活
 * 发生」，修复后反转为「池清空无复活」。用例 3（串行对照组）保留 active：
 * 锁定串行正确路径，不依赖漏洞，修复 P-r1-1 后应持续绿。见 round-1-甄别.md。
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
const UID = 'probe-r1-cand';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1c-'));
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
function userMd(): string {
  // memory.ts: user 画像 → <uid>/cloud/memory/USER.md（paths.userProfileFile）
  return path.join(tmpDir, UID, 'cloud', 'memory', 'USER.md');
}

async function loadCands() {
  return import('../../src/main/features/personal_ontology_candidates');
}

/** 用产品自己的序列化器种入 N 条待确认候选。 */
async function seedPool(ids: string[]): Promise<void> {
  const cands = await loadCands();
  const list = ids.map((id) => ({
    candidate_id: id,
    kind: 'preference' as const,
    confidence: 'high' as const,
    summary: `候选 ${id} 的摘要`,
    memory_scope: 'user' as const,
    memory_text: `确认内容-${id}`,
    source_memory_refs: [],
  }));
  fs.mkdirSync(path.dirname(candidatesMd()), { recursive: true });
  fs.writeFileSync(candidatesMd(), cands.serializeCandidatesMarkdown(list));
}

describe('probe r1 › 候选池并发双写（待议项已 skip）', () => {
  // 待议 P-r1-1：候选池并发双写复活已处理候选（读全文→改→整文件回写无锁）。
  it.skip('并发确认两条候选：池中复活一条（已写记忆的候选回到待确认）', async () => {
    await seedPool(['cand-a', 'cand-b']);
    const cands = await loadCands();

    // 模拟渲染层连点两张卡的确认按钮（两个 IPC 在主进程并发执行）
    const [ra, rb] = await Promise.all([
      cands.confirmCandidate(UID, 'cand-a'),
      cands.confirmCandidate(UID, 'cand-b'),
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);

    const after = await cands.listCandidates(UID);
    // 串行世界的正确结果：0 条。并发世界：后写者把先写者删的那条带回来了。
    const poolIds = after.candidate_updates.map((c) => c.candidate_id);
    expect(poolIds.length).toBe(1); // 复活了一条

    // 复活的候选可被再次确认（状态机倒退成「待确认」）
    const dup = await cands.confirmCandidate(UID, poolIds[0]);
    expect(dup.ok).toBe(true);
    // 记忆层：addEntry 对 user 轨按文本去重（memory.ts records.some(text===trimmed)），
    // 所以重复数据侥幸被挡住——但审查决定账本会再记一次 accept，池状态也失真
    const memory = fs.readFileSync(userMd(), 'utf8');
    const needle = `确认内容-${poolIds[0]}`;
    expect(memory.split(needle).length - 1).toBe(1); // 去重兜底生效
    expect((await cands.listCandidates(UID)).candidate_updates.length).toBe(0);
  });

  // 待议 P-r1-1（同上）：驳回可被并发确认的回写复活。
  it.skip('并发确认 + 驳回：驳回可被并发确认的回写复活（用户以为已丢弃又出现）', async () => {
    await seedPool(['cand-c', 'cand-d']);
    const cands = await loadCands();

    const [confirmRes, rejectRes] = await Promise.all([
      cands.confirmCandidate(UID, 'cand-c'),
      cands.rejectCandidate(UID, 'cand-d', '不要'),
    ]);
    expect(confirmRes.ok).toBe(true);
    expect(rejectRes.ok).toBe(true);

    const after = await cands.listCandidates(UID);
    // 串行世界应为 0 条；被驳回的 cand-d 有概率出现在池里
    expect(after.candidate_updates.length).toBe(1);
    expect(after.candidate_updates[0].candidate_id).toBe('cand-d');
  });

  // 保留 active（串行对照组）：不依赖漏洞，锁定串行正确路径；P-r1-1 修复后应持续绿。
  it('对照组（串行）：逐条确认后池清空、无复活——证明上面是并发独有', async () => {
    await seedPool(['cand-e', 'cand-f']);
    const cands = await loadCands();
    expect((await cands.confirmCandidate(UID, 'cand-e')).ok).toBe(true);
    expect((await cands.confirmCandidate(UID, 'cand-f')).ok).toBe(true);
    const after = await cands.listCandidates(UID);
    expect(after.candidate_updates.length).toBe(0);
  });
});
