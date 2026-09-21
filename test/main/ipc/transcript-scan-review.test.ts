/**
 * 扫描 × 模型复核（合并后）：`transcript.correct.scan { includeReview: true }`
 *
 * 这是"让模型给候选跟扫描合并"的落点——一个候选清单、一种勾选方式：
 *   - 词表命中在前，模型建议追加在后，形状一致（都是 CorrectionCandidate）；
 *   - 模型建议带 `fromModel`、`entryRef: model_<i>`、`riskLevel: 'medium'`
 *      ⇒ 面板只预勾 low，所以模型建议**永不预勾**，但也进不了"未处理高危"；
 *   - 不传 includeReview 时**一次模型都不调用**（默认不花钱）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uScanReview';
const TEXT = '用 coxy 上课，另外付平老师说要改排期。';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-scan-review-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const glossary = await import('../../../src/main/features/transcript_glossary');
  glossary.upsertEntry(TEST_UID, { wrong: 'coxy', correct: 'Cogseed', scope: { docIds: [], scenarioTags: [], global: true } });
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx() {
  return { userId: TEST_UID, user: { user_id: TEST_UID, created_at: new Date(0).toISOString() }, sender: {} };
}

/** 注入模型：记录被调用次数，返回一条"付平 → 傅平"的建议。 */
function mockReview() {
  const calls: Array<{ systemPrompt: string; message: string }> = [];
  vi.doMock('../../../src/main/features/transcript_llm_candidates', async () => {
    const actual = await vi.importActual<any>('../../../src/main/features/transcript_llm_candidates');
    return {
      ...actual,
      generateReviewCandidates: async (_uid: string, text: string, opts: any) => {
        const at = text.indexOf('付平');
        return {
          candidates: at >= 0
            ? [{
              wrong: '付平', correct: '傅平', confidence: 0.95, reason: '姓氏同音',
              start: at, pending: false, inAllowlist: (opts?.knownTargets ?? []).includes('傅平'),
            }]
            : [],
          rejected: [], outsideAllowlist: 0,
          chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0,
        };
      },
    };
  });
  return { calls };
}

describe('扫描并入模型复核', () => {
  it('默认（不传 includeReview）不调用模型，只返回词表命中', async () => {
    let called = false;
    vi.doMock('../../../src/main/features/transcript_llm_candidates', async () => {
      const actual = await vi.importActual<any>('../../../src/main/features/transcript_llm_candidates');
      return { ...actual, generateReviewCandidates: async () => { called = true; return { candidates: [], rejected: [], outsideAllowlist: 0, chunksScanned: 0, chunksTotal: 0, truncated: false, failedChunks: 0 }; } };
    });
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'd1' }, ctx());
    expect(called).toBe(false);
    expect(scan.review).toBeNull();
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({ wrong: 'coxy', correct: 'Cogseed' });
  });

  it('includeReview：模型建议并进同一个列表，且形状/风险等级/来源标记都齐', async () => {
    mockReview();
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'd1', includeReview: true }, ctx());
    // 词表命中在前、模型建议在后
    expect(scan.candidates).toHaveLength(2);
    expect(scan.candidates[0]).toMatchObject({ wrong: 'coxy', correct: 'Cogseed' });
    expect(scan.candidates[0].fromModel).not.toBe(true); // 词表命中不带模型来源标记
    const model = scan.candidates[1];
    expect(model).toMatchObject({
      entryRef: 'model_0', wrong: '付平', correct: '傅平',
      riskLevel: 'medium', fromModel: true, action: 'replace',
    });
    // span 指向原文，位置正确
    expect(TEXT.slice(model.span.start, model.span.end)).toBe('付平');
    // 统计口径合并后的总数
    expect(scan.stats.candidates).toBe(2);
    // 复核元信息如实回传（面板据此说明"读到哪了"）
    expect(scan.review).toMatchObject({ modelCandidates: 1, chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0 });
  });

  it('模型说没有 / 调用失败时也如实回传，不伪装成"扫描没结果"', async () => {
    vi.doMock('../../../src/main/features/transcript_llm_candidates', async () => {
      const actual = await vi.importActual<any>('../../../src/main/features/transcript_llm_candidates');
      return {
        ...actual,
        generateReviewCandidates: async () => ({
          candidates: [], rejected: [], outsideAllowlist: 0,
          chunksScanned: 0, chunksTotal: 2, truncated: false, failedChunks: 2, skipped: 'model_failed',
        }),
      };
    });
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'd1', includeReview: true }, ctx());
    expect(scan.candidates).toHaveLength(1); // 词表命中仍在
    expect(scan.review).toMatchObject({ modelCandidates: 0, failedChunks: 2, skipped: 'model_failed' });
  });

  it('合并后的清单能被 apply 直接使用：勾 model_0 才替换，且记入词表', async () => {
    mockReview();
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'd1', includeReview: true }, ctx());
    const model = scan.candidates.find((c: any) => c.entryRef === 'model_0');
    const applied = await (invokeHandlers['transcript.correct.apply'] as any)({
      text: TEXT, docId: 'd1',
      models: [{ start: model.span.start, wrong: '付平', correct: '傅平', confidence: 0.95, reason: '姓氏同音' }],
      acceptedIds: ['model_0'],
    }, ctx());
    expect(applied.result.text).toContain('傅平');
    expect(applied.glossaryWrites).toMatchObject({ created: 1 });
    const glossary = await import('../../../src/main/features/transcript_glossary');
    // 复核建议落成了词表规则（本文档作用域），词表命中那条不受影响
    const entries = glossary.listEntries(TEST_UID, { status: 'active' });
    expect(entries.map((e: any) => [e.wrong, e.correct, e.source])).toEqual([
      ['coxy', 'Cogseed', 'manual'],
      ['付平', '傅平', 'meeting_accept'],
    ]);
  });
});
