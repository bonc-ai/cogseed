/**
 * agent 侧纠错工具 × AI 复核（规则 + AI 组合的**出口验证**）
 *
 * 背景：`transcript_glossary_scan` 此前只调 `scanText`（纯规则），
 * 所以智能会议Agent 走的纠错流程**连召回层都没有**，更没有 AI 复核 ——
 * "规则加 AI"这件事面板早就有，agent 一直只有纯规则。
 *
 * 这个文件守的是**工具层的出口契约**：
 *   1. 默认（不传 `includeReview`）**一次模型都不调用** —— 不点不花钱；
 *   2. 传了之后模型建议**如实出现在输出里**，且明确标注"永不自动应用"；
 *   3. **AI 失败不影响规则结果**，且必须如实告诉模型这一路挂了（不许假装跑过）。
 *
 * 数据隔离与既有 `transcript-glossary-tools.test.ts` 一致：`test/setup-env.ts`
 * 已把 `COGSEED_WORKSPACE_ROOT` 指向本次运行的临时目录，这里再给每个用例一个
 * throwaway uid，避免用例间词表串味。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentTool } from '#core-agent';

let uid = '';
const TEXT = '用 coxy 上课，另外付平老师说要改排期。';

function mockModel(impl: () => Promise<any>) {
  vi.doMock('../../../src/main/features/transcript_llm_candidates', async () => {
    const actual = await vi.importActual<any>('../../../src/main/features/transcript_llm_candidates');
    return { ...actual, generateReviewCandidates: impl };
  });
}

async function scanTool(): Promise<AgentTool> {
  const { createTranscriptGlossaryTools } = await import(
    '../../../src/main/model/core-agent/transcript-glossary-tools'
  );
  const tools = createTranscriptGlossaryTools({ userId: uid });
  const found = tools.find((t) => t.name === 'transcript_glossary_scan');
  if (!found) throw new Error('scan tool not found');
  return found;
}

/** 工具签名要求 ctx，但本组工具只依赖构造期的 userId，这里给最小上下文。 */
async function runScan(input: Record<string, unknown>) {
  const tool = await scanTool();
  return tool.execute(input, { state: {} }) as Promise<{ content: string }>;
}

beforeEach(async () => {
  uid = `u_tool_review_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  vi.resetModules();
  const glossary = await import('../../../src/main/features/transcript_glossary');
  glossary.upsertEntry(uid, {
    wrong: 'coxy', correct: 'Cogseed',
    scope: { docIds: [], scenarioTags: [], global: true },
  });
});

describe('agent scan × AI 复核', () => {
  it('默认就跑 AI（准确优先：ASR 错形是开放集，纯查表必然漏）', async () => {
    let called = false;
    mockModel(async (_uid: string, text: string) => {
      called = true;
      const at = text.indexOf('付平');
      return {
        candidates: [{ wrong: '付平', correct: '傅平', confidence: 0.95, reason: '姓氏同音', start: at, pending: false, inAllowlist: false }],
        rejected: [], outsideAllowlist: 1,
        chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0,
      };
    });
    const res = await runScan({ text: TEXT, docId: 'd1' });
    expect(called).toBe(true);
    expect(res.content).toContain('coxy');
    expect(res.content).toContain('Proposed by model review');
  });

  it('includeReview=false ⇒ 才退回纯规则（显式关闭）', async () => {
    let called = false;
    mockModel(async () => { called = true; return { candidates: [], rejected: [], outsideAllowlist: 0, chunksScanned: 0, chunksTotal: 0, truncated: false, failedChunks: 0 }; });
    const res = await runScan({ text: TEXT, docId: 'd1', includeReview: false });
    expect(called).toBe(false);
    expect(res.content).toContain('coxy');
    expect(res.content).not.toContain('Proposed by model review');
  });

  it('默认（已开 AI）⇒ 模型建议如实列出，且写明"永不自动应用"', async () => {
    mockModel(async (_uid: string, text: string) => {
      const at = text.indexOf('付平');
      return {
        candidates: [{ wrong: '付平', correct: '傅平', confidence: 0.95, reason: '姓氏同音', start: at, pending: false, inAllowlist: true }],
        rejected: [], outsideAllowlist: 0,
        chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0,
      };
    });
    const res = await runScan({ text: TEXT, docId: 'd1' });
    const out = res.content;
    expect(out).toContain('Proposed by model review');
    expect(out).toContain('付平');
    expect(out).toContain('傅平');
    expect(out).toContain('NEVER auto-applied');
    // 执行摘要如实透出
    expect(out).toContain('Model review:');
    expect(out).toContain('chunks 1/1');
    expect(out).toContain('By channel:');
  });

  it('AI 抛错 ⇒ 规则结果照常返回，并如实说明这一路失败', async () => {
    mockModel(async () => { throw new Error('model backend down'); });
    const res = await runScan({ text: TEXT, docId: 'd1' });
    const out = res.content;
    // 纠错没因为 AI 挂掉而失败
    expect(out).toContain('coxy');
    expect(out).toContain('Cogseed');
    // 而且不假装跑过
    expect(out).toContain('SKIPPED=model_failed');
    expect(out).toContain('Rule + recall results above are unaffected');
  });

  it('模型未配置 ⇒ 明说没跑，规则结果完整', async () => {
    mockModel(async () => ({
      candidates: [], rejected: [], outsideAllowlist: 0,
      chunksScanned: 0, chunksTotal: 0, truncated: false, failedChunks: 0,
      skipped: 'no_model',
    }));
    const res = await runScan({ text: TEXT, docId: 'd1' });
    const out = res.content;
    expect(out).toContain('SKIPPED=no_model');
    expect(out).toContain('No model is configured');
    expect(out).toContain('coxy');
  });

  it('名册条目被短路时如实说明（否则用户以为丢了词条）', async () => {
    const glossary = await import('../../../src/main/features/transcript_glossary');
    glossary.upsertEntry(uid, {
      wrong: '张浩', correct: '张浩', kind: 'people',
      scope: { docIds: [], scenarioTags: [], global: true },
    });
    const res = await runScan({ text: '张浩用 coxy 上课', docId: 'd1' });
    expect(res.content).toContain('name-roster');
  });
});

describe('fuzzy recall is a review hint, not semantic evidence', () => {
  it('keeps explicit rules and supported fuzzy corrections, drops unsupported guesses', async () => {
    const glossary = await import('../../../src/main/features/transcript_glossary');
    for (const [wrong, correct] of [['contact', 'Context'], ['model', 'Moodle'], ['IDC', 'EduSeed'], ['cox', 'Cogseed']]) {
      glossary.upsertEntry(uid, { wrong, correct, kind: 'product' });
    }
    const text = 'codex 的包装逻辑，meta 信息，可以用就 ok。这个 coc 是产品。coxy 已有明确规则。';
    mockModel(async () => ({ candidates: [{ wrong: 'coc', correct: 'Cogseed', start: text.indexOf('coc'),
      confidence: 0.95, reason: 'This occurrence refers to the product', inAllowlist: true }],
      rejected: [], outsideAllowlist: 0, chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0 }));
    const { scanTranscriptCombined } = await import('../../../src/main/features/transcript_scan_combined');
    const scan = await scanTranscriptCombined(uid, text, { includeRecall: true });
    expect(scan.candidates.some(c => c.wrong === 'coc' && c.correct === 'Cogseed')).toBe(true);
    expect(scan.candidates.some(c => c.wrong === 'coxy' && c.channel === 'exact')).toBe(true);
    expect(scan.candidates.filter(c => ['codex', 'meta', 'ok'].includes(c.wrong))).toEqual([]);
  });

  it('does not interpret an incomplete review as rejection of fuzzy candidates', async () => {
    const glossary = await import('../../../src/main/features/transcript_glossary');
    glossary.upsertEntry(uid, { wrong: 'cox', correct: 'Cogseed', kind: 'product' });
    mockModel(async () => ({ candidates: [], rejected: [], outsideAllowlist: 0,
      chunksScanned: 1, chunksTotal: 2, truncated: false, failedChunks: 1 }));
    const { scanTranscriptCombined } = await import('../../../src/main/features/transcript_scan_combined');
    const scan = await scanTranscriptCombined(uid, '这里提到 coc 产品', { includeRecall: true });
    expect(scan.candidates.some(c => c.wrong === 'coc')).toBe(true);
    expect(scan.review?.failedChunks).toBe(1);
  });
});

it('keeps fuzzy choices when a model call returned no parseable review for their span', async () => {
  const glossary = await import('../../../src/main/features/transcript_glossary');
  glossary.upsertEntry(uid, { wrong: 'cox', correct: 'Cogseed', kind: 'product' });
  mockModel(async () => ({ candidates: [], reviewedRanges: [], rejected: [], outsideAllowlist: 0,
    chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0 }));
  const { scanTranscriptCombined } = await import('../../../src/main/features/transcript_scan_combined');
  const scan = await scanTranscriptCombined(uid, '这里提到 coc 产品', { includeRecall: true });
  expect(scan.candidates.some(c => c.wrong === 'coc')).toBe(true);
});
