import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 查重金字塔（2026-09-19 合并实施）：findSemanticDuplicate 在"≥0.85 重复"之外
// 必须同时报出 0.70–0.85 的最佳相关命中（related），供 L2 质量差分档与 L3
// 归族取用。embedQuery 故意 mock 成抛错：缓存注入命中时不触发，意外走到真实
// embedding 会直接报错暴露，测试只依赖注入的向量。
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async () => { throw new Error('embedding model unavailable'); },
}));

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'sim-related';

const QUERY = '周报必须按固定格式发送给上级。';
const DUP = '周报要按固定格式发给上级。';          // 与 QUERY 夹角小 → ≥0.85
const RELATED = '汇报材料需要附带通俗解释说明。';    // 中等相近 → 0.70–0.85
const UNRELATED = '数据库迁移脚本必须先备份再执行。'; // 无关 → <0.70

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-sim-related-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loaded() {
  const similarity = await import('../../../../src/main/features/recall/similarity');
  // 向量全部二维：query=[1,0]；dup≈[0.99,0.141]（cos≈0.99）；
  // related=[0.8,0.6]（cos=0.8）；unrelated=[0.5,0.866]（cos=0.5）。
  similarity._injectEmbeddingForTest(UID, QUERY, [1, 0]);
  similarity._injectEmbeddingForTest(UID, DUP, [0.99, 0.141]);
  similarity._injectEmbeddingForTest(UID, RELATED, [0.8, 0.6]);
  similarity._injectEmbeddingForTest(UID, UNRELATED, [0.5, 0.866]);
  return similarity;
}

describe('findSemanticDuplicate related layer', () => {
  it('reports the best related asset alongside a duplicate match', async () => {
    const similarity = await loaded();
    const outcome = await similarity.findSemanticDuplicate(UID, {
      text: QUERY,
      candidateTexts: [],
      assetTexts: [
        { id: 'aa-dup', text: DUP },
        { id: 'aa-related', text: RELATED },
        { id: 'aa-unrelated', text: UNRELATED },
      ],
    });

    expect(outcome.status).toBe('match');
    if (outcome.status !== 'match') return;
    expect(outcome.match.id).toBe('aa-dup');
    expect(outcome.match.score).toBeGreaterThanOrEqual(similarity.SEMANTIC_DUP_THRESHOLD);
    expect(outcome.related?.id).toBe('aa-related');
    expect(outcome.related?.score).toBeGreaterThanOrEqual(similarity.SEMANTIC_RELATED_THRESHOLD);
    expect(outcome.related?.score).toBeLessThan(similarity.SEMANTIC_DUP_THRESHOLD);
  });

  it('reports related on no_match when the best hit is only related', async () => {
    const similarity = await loaded();
    const outcome = await similarity.findSemanticDuplicate(UID, {
      text: QUERY,
      candidateTexts: [],
      assetTexts: [
        { id: 'aa-related', text: RELATED },
        { id: 'aa-unrelated', text: UNRELATED },
      ],
    });

    expect(outcome.status).toBe('no_match');
    if (outcome.status !== 'no_match') return;
    expect(outcome.related?.id).toBe('aa-related');
    expect(outcome.related?.kind).toBe('asset');
  });

  it('omits related when nothing clears the related threshold', async () => {
    const similarity = await loaded();
    const outcome = await similarity.findSemanticDuplicate(UID, {
      text: QUERY,
      candidateTexts: [],
      assetTexts: [{ id: 'aa-unrelated', text: UNRELATED }],
    });

    expect(outcome.status).toBe('no_match');
    if (outcome.status !== 'no_match') return;
    expect(outcome.related).toBeUndefined();
  });

  it('keeps related across the candidate pool too', async () => {
    const similarity = await loaded();
    const outcome = await similarity.findSemanticDuplicate(UID, {
      text: QUERY,
      candidateTexts: [{ id: 'cand-related', text: RELATED }],
      assetTexts: [],
    });

    expect(outcome.status).toBe('no_match');
    if (outcome.status !== 'no_match') return;
    expect(outcome.related?.id).toBe('cand-related');
    expect(outcome.related?.kind).toBe('candidate');
  });
});
