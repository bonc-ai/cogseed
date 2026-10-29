/**
 * 候选池并发写串行化回归（写路径使用 fileEditLock）：并发驳回、
 * 驳回与回流新增交错，池状态始终等于串行世界的某个顺序结果——无复活、
 * 无丢写。旧确认入口退役后的只读对照保留。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, emit: () => {}, off: () => {} },
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

describe('候选池并发写串行化', () => {
  it('并发驳回两条候选：双双成功，池清空，无复活', async () => {
    await seedPool(['cand-a', 'cand-b']);
    const cands = await loadCands();

    // 模拟渲染层连点两张卡的驳回按钮（两个 IPC 在主进程并发执行）。
    const [ra, rb] = await Promise.all([
      cands.rejectCandidate(UID, 'cand-a', '不要'),
      cands.rejectCandidate(UID, 'cand-b', '不要'),
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);

    // 串行世界的正确结果：0 条。锁化后读改写在锁内拿新鲜池——后写者不再把
    // 先写者删掉的行带回来（复活消失）。
    const after = await cands.listCandidates(UID);
    expect(after.candidate_updates.length).toBe(0);
    // 驳回不写记忆。
    expect(fs.existsSync(userMd())).toBe(false);
  });

  it('并发驳回 + 回流新增：驳回不被新增回写复活，新增不被驳回吞掉', async () => {
    await seedPool(['cand-c', 'cand-d']);
    const cands = await loadCands();

    const [rejectRes, addRes] = await Promise.all([
      cands.rejectCandidate(UID, 'cand-c', '不要'),
      cands.addCandidate(UID, {
        candidate_id: 'asset-backflow-y1',
        kind: 'rule',
        summary: '回流候选',
        memory_text: '回流内容',
      }),
    ]);
    expect(rejectRes.ok).toBe(true);
    expect(addRes.ok).toBe(true);

    // 串行世界应为 [cand-d, 回流]：被驳回的 cand-c 不复活，回流新增不丢。
    const after = await cands.listCandidates(UID);
    expect(after.candidate_updates.map((c) => c.candidate_id).sort())
      .toEqual(['asset-backflow-y1', 'cand-d']);
  });

  // 串行对照保留旧入口退役后的读取与持久化边界。
  it('对照组：旧确认writer已退役，读取保留原池且不写记忆', async () => {
    await seedPool(['cand-e', 'cand-f']);
    const cands = await loadCands();
    const before = fs.readFileSync(candidatesMd(), 'utf8');
    expect(cands).not.toHaveProperty('confirmCandidate');
    expect((await cands.listCandidates(UID)).candidate_updates.map(c => c.candidate_id)).toEqual(['cand-e', 'cand-f']);
    expect(fs.readFileSync(candidatesMd(), 'utf8')).toBe(before);
    expect(fs.existsSync(userMd())).toBe(false);
  });
});
