import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 查重金字塔：findSemanticDuplicate 在"≥0.85 重复"之外
// 必须同时报出 0.70–0.85 的最佳相关命中（related），供 L2 质量差分档与 L3
// 归族取用。embedQuery 故意 mock 成抛错：缓存注入命中时不触发，意外走到真实
// embedding 会直接报错暴露，测试只依赖注入的向量。
const embedding = vi.hoisted(() => ({ query: vi.fn(), batch: vi.fn() }));
vi.mock('../../../../src/main/features/kb_embed', () => ({ embedQuery: embedding.query, embedTexts: embedding.batch }));

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'sim-related';

const QUERY = '周报必须按固定格式发送给上级。';
const DUP = '周报要按固定格式发给上级。';          // 与 QUERY 夹角小 → ≥0.85
const RELATED = '汇报材料需要附带通俗解释说明。';    // 中等相近 → 0.70–0.85
const UNRELATED = '数据库迁移脚本必须先备份再执行。'; // 无关 → <0.70

beforeEach(() => {
  embedding.query.mockReset().mockRejectedValue(new Error('embedding model unavailable'));
  embedding.batch.mockReset().mockRejectedValue(new Error('embedding model unavailable'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-sim-related-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

it('keeps complete long bodies and owners isolated in the cache and batches all suffix-bearing chunks', async () => {
  const similarity = await import('../../../../src/main/features/recall/similarity');
  const prefix = '完整依据和判断步骤需要逐项记录。'.repeat(150);
  const first = prefix + '边界甲：仅允许人工审核。';
  const second = prefix + '边界乙：仅允许内部演练。';
  expect(first.length).toBeGreaterThan(2000);
  expect(first.length).toBeLessThanOrEqual(4000);
  embedding.query.mockResolvedValue([1, 0]);
  embedding.batch.mockImplementation(async (texts: string[]) => texts.map(text => text.includes('边界乙') ? [0, 1] : [1, 0]));
  const a = await similarity.embedForDedup(UID, first);
  const b = await similarity.embedForDedup(UID, second);
  expect(a).not.toBeNull(); expect(b).not.toEqual(a);
  expect(embedding.batch).toHaveBeenCalledTimes(2);
  expect(embedding.batch.mock.calls[0][0].some((text: string) => text.includes('边界甲：仅允许人工审核。'))).toBe(true);
  expect(embedding.batch.mock.calls[1][0].some((text: string) => text.includes('边界乙：仅允许内部演练。'))).toBe(true);
  expect(embedding.query).not.toHaveBeenCalled();
  expect(await similarity.embedForDedup(UID, first)).toEqual(a);
  expect(embedding.batch).toHaveBeenCalledTimes(2);
  await similarity.embedForDedup('other-owner', first);
  expect(embedding.batch).toHaveBeenCalledTimes(3);
});

it('keeps the established single-query embedding for short text and rejects incomplete long batches without caching partial support', async () => {
  const similarity = await import('../../../../src/main/features/recall/similarity');
  embedding.query.mockResolvedValue([0.6, 0.8]);
  expect(await similarity.embedForDedup(UID, QUERY)).toEqual([0.6, 0.8]);
  expect(embedding.query).toHaveBeenCalledWith(QUERY);
  expect(embedding.batch).not.toHaveBeenCalled();
  const text = '长正文需要完整保留其全部适用边界。'.repeat(150);
  for (const broken of [[], [[1, 0]], undefined]) {
    if (broken) embedding.batch.mockResolvedValueOnce(broken);
    else embedding.batch.mockRejectedValueOnce(new Error('one batch failed'));
    expect(await similarity.embedForDedup(UID, text)).toBeNull();
  }
  embedding.batch.mockImplementation(async (chunks: string[]) => chunks.map(() => [1, 0]));
  expect(await similarity.embedForDedup(UID, text)).toEqual([1, 0]);
  expect(embedding.batch).toHaveBeenCalledTimes(4);
});

it('fits real bundled BGE tokenization for complete ordinary Chinese, English, Japanese and Portuguese long bodies without model inference', async () => {
  const { Tokenizer } = await import('@anush008/tokenizers');
  const { embeddingModelDir } = await import('../../../../src/main/paths');
  const dir = path.join(embeddingModelDir(), 'fast-bge-small-zh-v1.5');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer_config.json'), 'utf8'));
  expect(config.model_max_length).toBe(512);
  const tokenizer = Tokenizer.fromFile(path.join(dir, 'tokenizer.json'));
  tokenizer.disableTruncation(); tokenizer.disablePadding();
  const similarity = await import('../../../../src/main/features/recall/similarity');
  embedding.batch.mockImplementation(async (chunks: string[]) => chunks.map(() => [1, 0]));
  const samples = [
    '分析问题时先明确已观察到的证据、判断范围和未经验证的部分。',
    'For each analysis preserve the observed evidence, applicable limits and unverified assumptions. ',
    '問題を分析するときは観察した根拠と適用範囲を保ち、不明な点を明記してください。',
    'Ao analisar um problema, preserve as evidências observadas e os limites; declare o que falta verificar. ',
  ];
  for (const sample of samples) {
    const text = sample.repeat(100).slice(0, 3950) + '\nFINAL_BOUNDARY: no permission to publish.';
    expect((await tokenizer.encode(text)).getLength()).toBeGreaterThan(512);
    expect(await similarity.embedForDedup(UID, text)).not.toBeNull();
    const chunks = embedding.batch.mock.calls.at(-1)![0] as string[];
    expect(chunks.some(chunk => chunk.includes('FINAL_BOUNDARY: no permission to publish.'))).toBe(true);
    expect(chunks.length).toBeLessThanOrEqual(16);
    for (const chunk of chunks) expect((await tokenizer.encode(chunk)).getLength()).toBeLessThanOrEqual(512);
  }
  expect(embedding.batch).toHaveBeenCalledTimes(4);
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

  it('treats unequal vector dimensions as unmeasured instead of comparing a shared prefix', async () => {
    const similarity = await import('../../../../src/main/features/recall/similarity');
    expect(similarity.cosineScore([1, 0], [1, 0, 0])).toBeNaN();
    expect(similarity.cosineScore([1, 0], [1, 0])).toBe(1);
  });

  it('does not serve a cached vector from a previous embedding dimension after the model changes', async () => {
    const similarity = await import('../../../../src/main/features/recall/similarity');
    similarity.clearEmbedCacheForTest();
    similarity._injectEmbeddingForTest(UID, 'old-space text', [1, 0]);
    expect(await similarity.embedForDedup(UID, 'old-space text')).toEqual([1, 0]);
    expect(embedding.query).not.toHaveBeenCalled();
    embedding.query.mockResolvedValue([1, 0, 0]);
    embedding.batch.mockResolvedValue([[1, 0, 0]]);
    expect(await similarity.embedForDedup(UID, 'new-space text')).toEqual([1, 0, 0]);
    expect(await similarity.embedForDedup(UID, 'old-space text')).toEqual([1, 0, 0]);
    expect(embedding.query).toHaveBeenCalledWith('old-space text');
  });
});
