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

// ── 召回通道并入扫描（specs/013 T015/T016/T017，FR-012 前半）──────────────────
describe('扫描并入召回通道', () => {
  /** spy 转发 transcript_recall.recallCandidates，记录调用次数。 */
  function spyRecall() {
    const state = { calls: 0 };
    vi.doMock('../../../src/main/features/transcript_recall', async () => {
      const actual = await vi.importActual<any>('../../../src/main/features/transcript_recall');
      return {
        ...actual,
        recallCandidates: (...args: unknown[]) => {
          state.calls += 1;
          return actual.recallCandidates(...args);
        },
      };
    });
    return state;
  }

  it('T015①：不传 includeRecall 时一次召回都不调（含 includeReview 组合；不点不花钱）', async () => {
    const spy = spyRecall();
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'd1' }, ctx());
    expect(spy.calls).toBe(0);
    expect(scan.recall).toBeUndefined();
    // 开了模型复核但没开召回：仍然一次都不调
    await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'd1', includeReview: true }, ctx());
    expect(spy.calls).toBe(0);
  });

  it('T015②/T016：includeRecall 时候选含 channel:"recall" 且全部 confidence < 1；同 span 并入字面行', async () => {
    const glossary = await import('../../../src/main/features/transcript_glossary');
    // K star（词条）vs K-STAR（转写形态）：字面通道匹配不到（折叠后空格≠连字符），
    // 只有召回的归一化通道能兜住（recall.test.ts 既有先例的同款形态）
    glossary.upsertEntry(TEST_UID, { wrong: 'K star', correct: 'KSTAR', scope: { docIds: [], scenarioTags: [], global: true } });
    const text = '用 coxy 上课，这块用的是 K-STAR 的记录';
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text, docId: 'd1', includeRecall: true }, ctx());

    const recallRows = scan.candidates.filter((c: any) => c.channel === 'recall');
    expect(recallRows.length).toBeGreaterThanOrEqual(1);
    const kstar = recallRows.find((c: any) => c.wrong === 'K-STAR');
    expect(kstar).toMatchObject({ correct: 'KSTAR', channel: 'recall' });
    // 绝不自动替换：召回候选全部 confidence < 1（对齐 MAX_RECALL_CONFIDENCE = 0.99）
    for (const row of recallRows) expect(row.confidence).toBeLessThan(1);
    expect(kstar.confidence).toBeLessThanOrEqual(0.99);
    // 召回行带词条依据与 review 分级（脱域不给 suggest）
    expect(kstar.refs[0]).toMatchObject({ source: 'glossary', entryId: kstar.entryRef });
    expect(kstar.disposition).toBe('review');

    // T016 集成：coxy 的 span 被字面与召回同时命中 → 只有一行、channel exact，
    // 召回结果并入该行（同词条幂等），统计里 merged 如实透出
    const atCoxy = text.indexOf('coxy');
    const coxyRows = scan.candidates.filter((c: any) => c.span.start === atCoxy);
    expect(coxyRows).toHaveLength(1);
    expect(coxyRows[0].channel).toBe('exact');
    expect(scan.recall.merged).toBeGreaterThanOrEqual(1);
    // stats.byChannel 按最终清单分桶（exact 1 + recall 1）
    expect(scan.stats.byChannel).toEqual({ exact: 1, recall: 1, model: 0 });
    expect(scan.stats.candidates).toBe(2);
  });

  it('T017：recall 段四键齐全、abandoned 与 recallCandidates 的 residual 对应、truncated 沿用', async () => {
    const text = '用 coxy 上课，roadmap 的排期也要过一下';
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text, docId: 'd1', includeRecall: true }, ctx());
    expect(Object.keys(scan.recall.byChannel).sort()).toEqual(['edit', 'normalized', 'phonetic', 'weak']);
    // abandoned = 兜不住的孤立形态（residual，只报形态不给映射）
    const recall = await import('../../../src/main/features/transcript_recall');
    const glossary = await import('../../../src/main/features/transcript_glossary');
    const direct = recall.recallCandidates(text, glossary.listEntries(TEST_UID, { status: 'active' }), { domainTerms: [] });
    expect(scan.recall.abandoned).toEqual(direct.stats.residual);
    expect(scan.recall.abandoned.some((x: any) => x.surface === 'roadmap')).toBe(true);
    // truncated 沿用既有语义（远未打满上限 → false）
    expect(scan.stats.truncated).toBe(false);
  });
});

// ── 引例闸端到端 + apply 侧（specs/013 T018/T019/T022，FR-011）────────────────
describe('引例闸：scan 只读提示行与 apply 默认最安全', () => {
  const ACCIDENT = '一会儿叫 coxy，一会儿叫别的';

  it('T018/T019：事故句扫描 ⇒ 零可勾选候选，candidates 出 disposition:"quoted_example" 只读行（可读出命中词）', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: ACCIDENT, docId: 'd1' }, ctx());
    const checkable = scan.candidates.filter((c: any) => c.disposition !== 'quoted_example');
    expect(checkable).toHaveLength(0);
    const row = scan.candidates.find((c: any) => c.disposition === 'quoted_example');
    expect(row).toBeDefined();
    expect(row.quotedBy).toBe('一会儿叫');
    expect(row.refs[0]).toMatchObject({ source: 'glossary', entryId: row.entryRef });
    // 只读行不是候选：stats 口径不含它，另有 quotedExample 计数
    expect(scan.stats.candidates).toBe(0);
    expect(scan.stats.quotedExample).toBe(1);
    // denied 里留有可追溯记录（reason + 命中词）
    expect(scan.denied[0]).toMatchObject({ reason: 'quoted_example', deniedBy: '一会儿叫' });
  });

  it('T022：apply 缺省（不传 excludeQuoted）时引例位不被替换；显式 false 才允许', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const at = ACCIDENT.indexOf('coxy');
    const models = [{ start: at, wrong: 'coxy', correct: 'Cogseed', confidence: 0.9, reason: '模型建议' }];
    // 缺省：模型建议落在引例位 → 一律不接受（即使被勾选）
    const blocked = await (invokeHandlers['transcript.correct.apply'] as any)({
      text: ACCIDENT, docId: 'd1', models, acceptedIds: ['model_0'],
    }, ctx());
    expect(blocked.result.text).toBe(ACCIDENT);
    expect(blocked.droppedModels).toBe(1); // 被引例闸挡掉，如实计数
    expect(blocked.glossaryWrites.created).toBe(0); // 被挡的不算确认，不进词表
    // 显式 excludeQuoted:false → 才允许（并且是显式的）
    const allowed = await (invokeHandlers['transcript.correct.apply'] as any)({
      text: ACCIDENT, docId: 'd1', models, acceptedIds: ['model_0'], excludeQuoted: false,
    }, ctx());
    expect(allowed.result.text).toContain('一会儿叫 Cogseed');
    expect(allowed.droppedModels).toBe(0);
  });
});

// ── 情景信号与降级标注（specs/013 T020/T021，FR-012 后半）────────────────────
describe('情景信号进扫描与降级如实标注', () => {
  /** spy 转发 scanText，记录每次调用的 options。 */
  function spyScanOptions() {
    const log: Array<Record<string, unknown>> = [];
    vi.doMock('../../../src/main/features/transcript_auto_correct', async () => {
      const actual = await vi.importActual<any>('../../../src/main/features/transcript_auto_correct');
      return {
        ...actual,
        scanText: (text: string, entries: unknown[], options: Record<string, unknown> = {}) => {
          log.push(options);
          return actual.scanText(text, entries, options);
        },
      };
    });
    return log;
  }

  it('T020：有块头的稿子 options.speakers 非空（主进程现算）；topic 透传；不参与作用域', async () => {
    const log = spyScanOptions();
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const text = '张磊 00:01:00\n用 coxy 上课';
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text, docId: 'd1', topic: '季度对齐' }, ctx());
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0].speakers).toEqual(['张磊']);
    expect(log[0].topic).toBe('季度对齐');
    // 扫描本身照常返回（speakers 只是展示信号，不改命中行为）
    expect(scan.candidates).toHaveLength(1);
  });

  it('T020：无块头的稿子 speakers 缺省且不报错（不编造说话人）', async () => {
    const log = spyScanOptions();
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'd1' }, ctx());
    expect(log[0].speakers).toBeUndefined();
    expect(scan.candidates).toHaveLength(1);
  });

  it('T021：三种缺失在返回体 degraded 各自出现；补齐后消失', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    // 无块头 + 无场景标签 + 该文档没跑过纠错 run ⇒ 三条齐
    const bare = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'd1' }, ctx());
    expect(bare.degraded).toEqual(['no_speakers', 'no_scenario_tags', 'no_transcript_run']);
    // 跑一次 apply（落 run）+ 传场景标签 + 带块头文本 ⇒ 降级消失
    await (invokeHandlers['transcript.correct.apply'] as any)({ text: TEXT, docId: 'd1' }, ctx());
    const healed = await (invokeHandlers['transcript.correct.scan'] as any)({
      text: '张磊 00:01:00\n用 coxy 上课', docId: 'd1', scenarioTags: ['组会'],
    }, ctx());
    expect(healed.degraded).toEqual([]);
  });
});

// ── 资产规范名进纠错依据（specs/013 T027，FR-001）──────────────────────────────
describe('资产规范名进纠错依据（T027 端到端）', () => {
  /** mock 资产库（meeting_refs 与 scan 组装处都经 readAbilityAsset 读它）。 */
  function mockAssetStore() {
    const assets = new Map<string, Record<string, unknown>>();
    vi.doMock('../../../src/main/features/recall/asset-service', async () => ({
      readAbilityAsset: vi.fn(async (_uid: string, assetId: string) => {
        const record = assets.get(assetId);
        if (!record) throw new Error('recall ability asset not found');
        return record;
      }),
    }));
    return assets;
  }

  /** active + 过准入的最小资产（形态照 meeting_refs.test 的 assetRecord）。 */
  function activeAsset(id: string, over: Record<string, unknown> = {}) {
    return {
      maturity: 'effectiveness_validated',
      lifecycleStatus: 'user_confirmed_unverified',
      status: 'active',
      scope: 'personal',
      type: 'personal',
      title: '术语资产',
      version: '3',
      id,
      ...over,
    };
  }

  it('挂载后重扫：候选 refs 含 source:"asset" 且 version 等于挂载时的冻结版（不是当前版）', async () => {
    const assets = mockAssetStore();
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const meetingRefs = await import('../../../src/main/features/meeting_refs');
    assets.set('ast_term', activeAsset('ast_term', { statement: 'Cogseed' }));
    await meetingRefs.attachMeetingAsset(TEST_UID, 'kb/m.md', 'ast_term');
    // 会议后资产升版到 v9：引用包冻结的仍是 v3
    assets.set('ast_term', activeAsset('ast_term', { statement: 'Cogseed', activeVersion: '9', title: '术语资产（新）' }));
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'kb/m.md' }, ctx());
    expect(scan.candidates).toHaveLength(1);
    const refs = scan.candidates[0].refs;
    expect(refs[0]).toMatchObject({ source: 'glossary', entryId: scan.candidates[0].entryRef });
    expect(refs).toContainEqual({ source: 'asset', assetId: 'ast_term', version: '3', title: '术语资产' });
  });

  it('未挂载的文档：refs 不含 asset 来源（既有行为零变化）', async () => {
    mockAssetStore();
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'd1' }, ctx());
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].refs.some((r: any) => r.source === 'asset')).toBe(false);
  });

  it('挂载的资产被删除后重扫：该 asset 依据如实消失（宁少不多，不造依据）', async () => {
    const assets = mockAssetStore();
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const meetingRefs = await import('../../../src/main/features/meeting_refs');
    assets.set('ast_term', activeAsset('ast_term', { statement: 'Cogseed' }));
    await meetingRefs.attachMeetingAsset(TEST_UID, 'kb/m.md', 'ast_term');
    assets.delete('ast_term'); // 彻底删除
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'kb/m.md' }, ctx());
    expect(scan.candidates[0].refs.some((r: any) => r.source === 'asset')).toBe(false);
  });
});

// ── 拒绝回执 / 不再重复建议 / 可撤销（specs/013 T028/T029/T032，FR-001）────────
describe('拒绝回执与不再重复建议（T028/T029/T032 端到端）', () => {
  /** 被测词条（beforeEach 建的 coxy→Cogseed）的 entryRef。 */
  async function coxyEntryId(): Promise<string> {
    const glossary = await import('../../../src/main/features/transcript_glossary');
    const entry = glossary.listEntries(TEST_UID, { status: 'active' }).find((e: any) => e.wrong === 'coxy');
    if (!entry) throw new Error('coxy entry missing');
    return entry.id;
  }

  async function decisionsOf(targetRef: string) {
    const { listReviewDecisions } = await import('../../../src/main/features/cognition/review-decision');
    return listReviewDecisions(TEST_UID, targetRef);
  }

  it('T028：拒绝后账本恰一条 reject（idempotencyKey 含 runId）；被拒形态不被替换；不存在的 id 不写账', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const entryId = await coxyEntryId();
    const applied = await (invokeHandlers['transcript.correct.apply'] as any)({
      text: TEXT, docId: 'kb/r.md', acceptedIds: [], rejectedIds: [entryId, 'g_no_such'],
    }, ctx());
    expect(applied.result.text).toBe(TEXT);            // 被拒的不替换（coxy 原样）
    expect(applied.result.applied).toHaveLength(0);
    expect(applied.receipts).toHaveLength(1);           // 不存在的 id 不写账
    const targetRef = `meeting:kb/r.md:${entryId}`;
    const decisions = await decisionsOf(targetRef);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision_type: 'reject', target_ref: targetRef, actor: 'user' });
    expect(decisions[0].idempotency_key).toContain(applied.run.runId);   // 幂等键含 runId
    // 账本文件真实落盘（验收原文口径：账本文件出现一条）
    const { reviewDecisionLogPath } = await import('../../../src/main/features/cognition/review-decision');
    const { readJsonl } = await import('../../../src/main/storage');
    const onDisk = await readJsonl<any>(reviewDecisionLogPath(TEST_UID, targetRef), 100);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].decision_type).toBe('reject');
  });

  it('T028：重试同动作（receiptRunId 复用原 run）不产生第二条；不同 run 的再次拒绝是新的一条', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const entryId = await coxyEntryId();
    const first = await (invokeHandlers['transcript.correct.apply'] as any)({
      text: TEXT, docId: 'kb/r.md', acceptedIds: [], rejectedIds: [entryId],
    }, ctx());
    const targetRef = `meeting:kb/r.md:${entryId}`;
    // 重试同一动作：传原 run 的 runId ⇒ 幂等命中，返回同一 decisionId
    const retry = await (invokeHandlers['transcript.correct.apply'] as any)({
      text: TEXT, docId: 'kb/r.md', acceptedIds: [], rejectedIds: [entryId], receiptRunId: first.run.runId,
    }, ctx());
    expect(retry.receipts[0].decisionId).toBe(first.receipts[0].decisionId);
    expect(await decisionsOf(targetRef)).toHaveLength(1);            // 仍只有一条
    // 不同 run（不同文本）的再次拒绝 = 新动作 ⇒ 追加一条（T032④ 的前提）
    await (invokeHandlers['transcript.correct.apply'] as any)({
      text: `${TEXT} `, docId: 'kb/r.md', acceptedIds: [], rejectedIds: [entryId],
    }, ctx());
    expect(await decisionsOf(targetRef)).toHaveLength(2);
  });

  it('T029：拒绝后重扫同一文本该形态不再出现（stats.suppressed 如实）；跨进程重启仍生效（账本落盘）；其他文档不受影响', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const entryId = await coxyEntryId();
    await (invokeHandlers['transcript.correct.apply'] as any)({
      text: TEXT, docId: 'kb/r.md', acceptedIds: [], rejectedIds: [entryId],
    }, ctx());
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'kb/r.md' }, ctx());
    expect(scan.candidates.filter((c: any) => c.wrong === 'coxy')).toHaveLength(0);
    expect(scan.stats.suppressed).toBeGreaterThanOrEqual(1);
    // 跨"进程重启"：重置模块后重新加载（词表与账本都落盘在 workspace）
    vi.resetModules();
    const users = await import('../../../src/main/features/users');
    users.activateUser(TEST_UID);
    const { invokeHandlers: handlers2 } = await import('../../../src/main/ipc/transcript');
    const rescanned = await (handlers2['transcript.correct.scan'] as any)({ text: TEXT, docId: 'kb/r.md' }, ctx());
    expect(rescanned.candidates.filter((c: any) => c.wrong === 'coxy')).toHaveLength(0);
    // 抑制的 target_ref 绑定会议文档：别的文档同形态照常建议
    const otherDoc = await (handlers2['transcript.correct.scan'] as any)({ text: TEXT, docId: 'kb/other.md' }, ctx());
    expect(otherDoc.candidates.filter((c: any) => c.wrong === 'coxy')).toHaveLength(1);
  });

  it('T029：新决定覆盖（既有末条判定口径）⇒ 重新出现——不新写第二套判据', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const { writeReviewDecision } = await import('../../../src/main/features/cognition/review-decision');
    const entryId = await coxyEntryId();
    await (invokeHandlers['transcript.correct.apply'] as any)({
      text: TEXT, docId: 'kb/r.md', acceptedIds: [], rejectedIds: [entryId],
    }, ctx());
    // 既有口径：末条决定为 accept ⇒ 不再抑制（与 isCandidateSuppressed 同一处判据）
    await writeReviewDecision(TEST_UID, {
      targetRef: `meeting:kb/r.md:${entryId}`, decisionType: 'accept', decision: 'new evidence',
    });
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'kb/r.md' }, ctx());
    expect(scan.candidates.filter((c: any) => c.wrong === 'coxy')).toHaveLength(1);
  });

  it('T032：撤销 ⇒ 重扫重新出现；撤销追加一条回执（append-only、不新增决定类型）；重复撤销幂等；撤销后再次拒绝仍生效', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const entryId = await coxyEntryId();
    const targetRef = `meeting:kb/r.md:${entryId}`;
    await (invokeHandlers['transcript.correct.apply'] as any)({
      text: TEXT, docId: 'kb/r.md', acceptedIds: [], rejectedIds: [entryId],
    }, ctx());
    // 拒绝 ⇒ 重扫不出（T032①）
    const suppressedScan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'kb/r.md' }, ctx());
    expect(suppressedScan.candidates.filter((c: any) => c.wrong === 'coxy')).toHaveLength(0);

    // 撤销（对齐词表侧 setIgnored 的可逆口径）⇒ 追加一条 accept 回执（T032②③）
    const before = await decisionsOf(targetRef);
    const undone = await (invokeHandlers['transcript.correct.unreject'] as any)({
      docId: 'kb/r.md', ids: [entryId],
    }, ctx());
    expect(undone.undone).toHaveLength(1);
    const after = await decisionsOf(targetRef);
    expect(after).toHaveLength(before.length + 1);       // append-only：只增不减
    const undoDecision = after[after.length - 1];
    expect(undoDecision.decision_type).toBe('accept');   // 既有 7 值之一，不新增决定类型
    expect(undoDecision.decision).toBe('unreject');
    expect(undoDecision.supersedes_ref).toBe(before[before.length - 1].decision_id);
    // 撤销 ⇒ 重扫重新出现（T032②）
    const recoveredScan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'kb/r.md' }, ctx());
    expect(recoveredScan.candidates.filter((c: any) => c.wrong === 'coxy')).toHaveLength(1);

    // 重复撤销：末条已非抑制态 ⇒ 幂等跳过（对齐 setIgnored 重复调用无操作），账本不增
    const again = await (invokeHandlers['transcript.correct.unreject'] as any)({
      docId: 'kb/r.md', ids: [entryId],
    }, ctx());
    expect(again.undone).toEqual([]);
    expect(await decisionsOf(targetRef)).toHaveLength(after.length);

    // 撤销后再次拒绝仍生效（T032④）：新 run 的新拒绝 ⇒ 末条回到 reject ⇒ 又被抑制
    await (invokeHandlers['transcript.correct.apply'] as any)({
      text: `${TEXT} `, docId: 'kb/r.md', acceptedIds: [], rejectedIds: [entryId],
    }, ctx());
    const finalScan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'kb/r.md' }, ctx());
    expect(finalScan.candidates.filter((c: any) => c.wrong === 'coxy')).toHaveLength(0);
  });
});
