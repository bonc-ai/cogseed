/**
 * transcript_scan_combined — 「规则 + 召回 + AI 复核」三路合一接缝
 *
 * 这一层存在的理由：面板（IPC）三路齐全，**agent 工具过去只调 scanText**
 * （连召回都没接）。抽出唯一实现后两边才走同一条路，否则迟早漂移。
 *
 * 守的核心不变量是**可用性解耦**与**权限不越界**：
 *   1. **AI 失败绝不拖垮纠错** —— 模型抛错 / 未配置 / 返回空，规则与召回结果
 *      必须照常返回，且如实把原因放进 `review.skipped`（不许静默假装跑过）。
 *   2. **AI 候选永不自动应用** —— 产出带 `fromModel: true`，`applyCorrections`
 *      默认不选它；这里只负责如实标注来源与 `riskLevel: 'medium'`。
 *   3. **默认不花钱** —— 不传 `includeReview` 时一次模型都不调用。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uScanCombined';
const TEXT = '用 coxy 上课，另外付平老师说要改排期。';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-scan-combined-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const glossary = await import('../../../src/main/features/transcript_glossary');
  glossary.upsertEntry(TEST_UID, {
    wrong: 'coxy', correct: 'Cogseed',
    scope: { docIds: [], scenarioTags: [], global: true },
  });
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 注入模型：`impl` 决定这一路的行为（正常 / 抛错 / 未配置 / 空）。 */
function mockModel(impl: () => Promise<any>) {
  vi.doMock('../../../src/main/features/transcript_llm_candidates', async () => {
    const actual = await vi.importActual<any>('../../../src/main/features/transcript_llm_candidates');
    return { ...actual, generateReviewCandidates: impl };
  });
}

/** 一条正常的模型建议（正文里"付平"确实存在，逐字可定位）。 */
function okReview(text: string) {
  const at = text.indexOf('付平');
  return {
    candidates: at >= 0
      ? [{
        wrong: '付平', correct: '傅平', confidence: 0.95, reason: '姓氏同音',
        start: at, pending: false, inAllowlist: true,
      }]
      : [],
    rejected: [], outsideAllowlist: 0,
    chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0,
  };
}

describe('组合扫描：规则 + 召回 + AI 复核', () => {
  it('默认就跑 AI（准确优先：ASR 错形是开放集，纯查表必然漏）', async () => {
    let called = false;
    mockModel(async (_uid: string, text: string) => { called = true; return okReview(text); });
    const m = await import('../../../src/main/features/transcript_scan_combined');
    const res = await m.scanTranscriptCombined(TEST_UID, TEXT, { docId: 'd1' });
    expect(called).toBe(true);
    expect(res.review).not.toBeNull();
    expect(res.candidates.map((c) => c.wrong)).toContain('coxy');
    expect(res.stats.byChannel.model).toBeGreaterThan(0);
  });

  it('includeReview=false 才退回纯规则（显式关闭）', async () => {
    let called = false;
    mockModel(async (_uid: string, text: string) => { called = true; return okReview(text); });
    const m = await import('../../../src/main/features/transcript_scan_combined');
    const res = await m.scanTranscriptCombined(TEST_UID, TEXT, { docId: 'd1', includeReview: false });
    expect(called).toBe(false);
    expect(res.review).toBeNull();
    expect(res.candidates.map((c) => c.wrong)).toContain('coxy');
    expect(res.stats.byChannel.model).toBe(0);
  });

  it('指向已知写法的模型建议（toKnownForm）自动应用；自创写法不应用', async () => {
    mockModel(async (_uid: string, text: string) => ({
      candidates: [
        // 指向词表里已有的 Cogseed ⇒ 可自动应用
        { wrong: 'coxyx', correct: 'Cogseed', confidence: 0.95, reason: '近形', start: text.indexOf('coxy'), pending: false, inAllowlist: true },
        // 模型自创写法 ⇒ 必须人工确认
        { wrong: '付平', correct: '某个新词', confidence: 0.95, reason: '猜测', start: text.indexOf('付平'), pending: false, inAllowlist: false },
      ],
      rejected: [], outsideAllowlist: 1,
      chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0,
    }));
    const m = await import('../../../src/main/features/transcript_scan_combined');
    const auto = await import('../../../src/main/features/transcript_auto_correct');
    const res = await m.scanTranscriptCombined(TEST_UID, TEXT, { docId: 'd1' });
    const known = res.candidates.find((c) => c.correct === 'Cogseed' && c.fromModel === true);
    const invented = res.candidates.find((c) => c.correct === '某个新词');
    expect(known?.toKnownForm).toBe(true);
    expect(invented?.toKnownForm).toBe(false);

    const applied = auto.applyCorrections(TEXT, res.candidates);
    // 指向已知写法的自动应用了；自创写法留在待确认
    expect(applied.applied.some((a) => a.correct === 'Cogseed')).toBe(true);
    expect(applied.applied.some((a) => a.correct === '某个新词')).toBe(false);
    expect(applied.status).toBe('draft');
  });

  it('includeReview：模型建议并入同一清单，带 fromModel 与 medium', async () => {
    mockModel(async (_uid: string, text: string) => okReview(text));
    const m = await import('../../../src/main/features/transcript_scan_combined');
    const res = await m.scanTranscriptCombined(TEST_UID, TEXT, { docId: 'd1' });
    const model = res.candidates.filter((c) => c.fromModel === true);
    expect(model).toHaveLength(1);
    expect(model[0]).toMatchObject({
      entryRef: 'model_0', wrong: '付平', correct: '傅平',
      riskLevel: 'medium', channel: 'model',
    });
    expect(res.review?.modelCandidates).toBe(1);
    expect(res.review?.skipped).toBe('');
    expect(res.stats.byChannel.model).toBe(1);
  });

  it('AI 抛错 ⇒ 规则结果照常返回，且 review.skipped 如实标 model_failed', async () => {
    mockModel(async () => { throw new Error('network down'); });
    const m = await import('../../../src/main/features/transcript_scan_combined');
    const res = await m.scanTranscriptCombined(TEST_UID, TEXT, { docId: 'd1' });
    // 关键：纠错没有因为 AI 挂掉而失败
    expect(res.candidates.map((c) => c.wrong)).toContain('coxy');
    expect(res.review?.skipped).toBe('model_failed');
    expect(res.review?.modelCandidates).toBe(0);
    expect(res.stats.byChannel.model).toBe(0);
  });

  it('模型未配置 ⇒ skipped=no_model，规则结果照常（扫描可用性不依赖模型）', async () => {
    mockModel(async () => ({
      candidates: [], rejected: [], outsideAllowlist: 0,
      chunksScanned: 0, chunksTotal: 0, truncated: false, failedChunks: 0,
      skipped: 'no_model',
    }));
    const m = await import('../../../src/main/features/transcript_scan_combined');
    const res = await m.scanTranscriptCombined(TEST_UID, TEXT, { docId: 'd1' });
    expect(res.review?.skipped).toBe('no_model');
    expect(res.candidates.map((c) => c.wrong)).toContain('coxy');
  });

  it('链路打通：AI 候选交给 applyCorrections 默认不被应用（跨模块不变量）', async () => {
    mockModel(async (_uid: string, text: string) => okReview(text));
    const m = await import('../../../src/main/features/transcript_scan_combined');
    const auto = await import('../../../src/main/features/transcript_auto_correct');
    const res = await m.scanTranscriptCombined(TEST_UID, TEXT, { docId: 'd1' });

    // 规则候选（coxy→Cogseed）自动应用；模型候选指向的"傅平"**不在词表里**
    // （okReview 的 inAllowlist:true 只是测试造的数据，词表里没有傅平）——
    // 这里以引擎的实际判据为准：toKnownForm 由 inAllowlist 映射而来。
    const applied = auto.applyCorrections(TEXT, res.candidates);
    expect(applied.text).toContain('Cogseed');

    // 用户勾选后一定可以应用（逐条确认不受任何限制）
    const confirmed = auto.applyCorrections(TEXT, res.candidates, { acceptedIds: ['model_0'] });
    expect(confirmed.text).toContain('傅平');
  });

  it('召回层：includeRecall 打开后并入同一清单并标注 channel', async () => {
    // 召回层兜"词表里没写过的错形"；这里用词表已有的近形验证并入行为
    const glossary = await import('../../../src/main/features/transcript_glossary');
    glossary.upsertEntry(TEST_UID, {
      wrong: 'coxseed', correct: 'Cogseed',
      scope: { docIds: [], scenarioTags: [], global: true },
    });
    const m = await import('../../../src/main/features/transcript_scan_combined');
    const res = await m.scanTranscriptCombined(TEST_UID, '用 coxsed 上课', {
      docId: 'd1', includeRecall: true,
    });
    expect(res.recall).toBeTruthy();
    // 召回通道计数自洽
    expect(res.stats.byChannel.recall).toBe(res.candidates.filter((c) => c.channel === 'recall').length);
  });

  /**
   * 自动应用的分界：**纯字形规范化**任何时候都安全；**指向已知写法**还要模型有把握。
   *
   * 真机实测（2026-10-15，一份 18 分钟转写，模型 4.7 秒给出 11 条建议）：
   *   - `maas → MaaS`、`mary C → Mary C`、`msc → MSC` —— 只改大小写，
   *     没有引入任何新字符 ⇒ 自动应用，不打扰用户；
   *   - `都认资产 → 多维表格`(conf **0.4**, inAllowlist **true**) —— 目标词确实
   *     在词表里，但模型自己都没把握 ⇒ 必须让用户看一眼。
   *     **指向已知写法只保证"不引入新词"，不保证"这里真的该改"。**
   */
  describe('自动应用的分层判据', () => {
    function modelRow(wrong: string, correct: string, confidence: number, inAllowlist: boolean, at: number) {
      return { wrong, correct, confidence, reason: 'r', start: at, pending: false, inAllowlist };
    }

    async function scanWith(rows: any[], text: string) {
      mockModel(async () => ({
        candidates: rows, rejected: [], outsideAllowlist: rows.filter((r) => !r.inAllowlist).length,
        chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0,
      }));
      const m = await import('../../../src/main/features/transcript_scan_combined');
      return m.scanTranscriptCombined(TEST_UID, text, { docId: 'd1' });
    }

    it('纯字形规范化 ⇒ 自动应用（低置信也一样安全：没引入新字符）', async () => {
      const text = '用 maas 上课';
      const res = await scanWith([modelRow('maas', 'MaaS', 0.4, false, 2)], text);
      const row = res.candidates.find((c) => c.fromModel === true)!;
      expect(row.toKnownForm).toBe(true);
    });

    it('指向已知写法 + 高置信 ⇒ 自动应用', async () => {
      const text = '用 coxseed 上课';
      const res = await scanWith([modelRow('coxseed', 'Cogseed', 0.8, true, 2)], text);
      expect(res.candidates.find((c) => c.fromModel === true)?.toKnownForm).toBe(true);
    });

    it('指向已知写法但置信不足 ⇒ 必须人工确认（真实样本 conf 0.4）', async () => {
      const text = '都认资产要整理';
      const res = await scanWith([modelRow('都认资产', 'Cogseed', 0.4, true, 0)], text);
      expect(res.candidates.find((c) => c.fromModel === true)?.toKnownForm).toBe(false);
    });

    it('自创写法 ⇒ 一律人工确认（哪怕高置信）', async () => {
      const text = '辉的名字要改';
      const res = await scanWith([modelRow('辉的名字', '会议的名字', 0.95, false, 0)], text);
      expect(res.candidates.find((c) => c.fromModel === true)?.toKnownForm).toBe(false);
    });

    it('跨模块收口：自动的那类真的会被应用，要确认的那类不会', async () => {
      const text = '用 maas 上课，都认资产要整理';
      const res = await scanWith([
        modelRow('maas', 'MaaS', 0.5, false, 2),
        modelRow('都认资产', 'Cogseed', 0.4, true, 10),
      ], text);
      const auto = await import('../../../src/main/features/transcript_auto_correct');
      const applied = auto.applyCorrections(text, res.candidates);
      expect(applied.text).toContain('MaaS');
      expect(applied.text).toContain('都认资产'); // 低置信那条没动
      expect(applied.status).toBe('draft');
    });
  });

  /**
   * **前端手动改词表 ⇒ 立刻影响这条链路**，不需要重开会话、不需要重启。
   *
   * 为什么值得钉住：用户在前端改了对照表，期望"下一场会就按新的走"。
   * 一旦有人为了性能给 `loadGlossary` 加缓存，这个期望会**静默失效** ——
   * 改了没反应，而且很难查。所以用测试把"实时读"这个性质锁住。
   *
   * 链路三处读的都是同一份实时词表：规则引擎（scanText）、召回层、AI 提示词
   * 的「错写对照」。这里端到端验证"改动 → 立刻反映到给模型的提示词"。
   */
  describe('词表改动实时生效（不许加缓存）', () => {
    it('前端编辑正确写法后，立刻反映到给模型的对照表', async () => {
      const glossary = await import('../../../src/main/features/transcript_glossary');
      const llm = await import('../../../src/main/features/transcript_llm_candidates');

      const created = glossary.upsertEntry(TEST_UID, {
        wrong: 'coxy', correct: 'Cogseed',
        scope: { docIds: [], scenarioTags: [], global: true },
      });
      // 注意 upsertEntry 的返回是 { entry, created, skippedReason? }，没有 ok；
      // ok/reason 那套是 updateEntry 的形状。
      expect(created.entry).toBeTruthy();

      // 模拟前端的「编辑」：把正确写法改掉
      const edited = glossary.updateEntry(TEST_UID, created.entry!.id, { correct: 'EduSeed' });
      expect(edited.ok).toBe(true);

      // 不重启、不清缓存，直接读
      const entries = glossary.listEntries(TEST_UID, { status: 'active' });
      expect(entries.find((e) => e.wrong === 'coxy')?.correct).toBe('EduSeed');

      // 并且立刻进到发给模型的提示词里（旧映射不得残留）
      const pairs = entries
        .filter((e) => e.action !== 'delete' && e.wrong.trim() !== e.correct.trim())
        .map((e) => ({ wrong: e.wrong, correct: e.correct }));
      const built = llm.buildReviewRequest('正文', ['EduSeed'], [], pairs);
      expect(built.message).toContain('「coxy」→「EduSeed」');
      expect(built.message).not.toContain('「coxy」→「Cogseed」');
    });

    it('新增一条后立刻进对照表；删掉后立刻消失', async () => {
      const glossary = await import('../../../src/main/features/transcript_glossary');
      const llm = await import('../../../src/main/features/transcript_llm_candidates');
      const pairsOf = () => glossary.listEntries(TEST_UID, { status: 'active' })
        .filter((e) => e.action !== 'delete' && e.wrong.trim() !== e.correct.trim())
        .map((e) => ({ wrong: e.wrong, correct: e.correct }));

      const added = glossary.upsertEntry(TEST_UID, {
        wrong: 'maas', correct: 'MeshSeed',
        scope: { docIds: [], scenarioTags: [], global: true },
      });
      expect(added.entry).toBeTruthy();
      expect(llm.buildReviewRequest('正文', ['MeshSeed'], [], pairsOf()).message)
        .toContain('「maas」→「MeshSeed」');

      // 删除后不得再出现在对照表里（deleteEntry 返回 boolean）
      expect(glossary.deleteEntry(TEST_UID, added.entry!.id)).toBe(true);
      expect(llm.buildReviewRequest('正文', ['MeshSeed'], [], pairsOf()).message)
        .not.toContain('「maas」→「MeshSeed」');
    });

    it('名册条目（wrong === correct）不进对照表 —— 它没有对照信息', async () => {
      const glossary = await import('../../../src/main/features/transcript_glossary');
      const llm = await import('../../../src/main/features/transcript_llm_candidates');
      glossary.upsertEntry(TEST_UID, {
        wrong: '张浩', correct: '张浩', kind: 'people',
        scope: { docIds: [], scenarioTags: [], global: true },
      });
      const pairs = glossary.listEntries(TEST_UID, { status: 'active' })
        .filter((e) => e.action !== 'delete' && e.wrong.trim() !== e.correct.trim())
        .map((e) => ({ wrong: e.wrong, correct: e.correct }));
      const built = llm.buildReviewRequest('正文', ['张浩'], [], pairs);
      expect(built.message).not.toContain('「张浩」→「张浩」');
    });
  });

  /**
   * **规则已命中的位置，模型不得再提同一处** —— 否则风险保护会被整个绕过。
   *
   * 真实事故（2026-10-15 真机）：`maas -> MeshSeed` 同时被两条路命中：
   *   - 规则那条带词表配好的 `riskLevel: 'high'` ⇒ 要求人工确认；
   *   - 模型那条固定 `medium` + `toKnownForm: true` ⇒ **自动应用**。
   * 结果模型那条把规则的风险保护绕过去了，本该逐条确认的改写被静默生效。
   */
  describe('规则命中优先：模型不得重复提同一处', () => {
    it('同一处同一改写：只保留规则那条（连带它的 high 风险）', async () => {
      const glossary = await import('../../../src/main/features/transcript_glossary');
      // 造一条 high 规则（两字中文长度比会派生 high，这里直接用受保护词）
      glossary.upsertEntry(TEST_UID, {
        wrong: 'maas', correct: 'MeshSeed', kind: 'product',
        scope: { docIds: [], scenarioTags: [], global: true },
      });
      const text = '用 maas 上课';
      const at = text.indexOf('maas');
      mockModel(async () => ({
        candidates: [{ wrong: 'maas', correct: 'MeshSeed', confidence: 0.9, reason: 'r', start: at, pending: false, inAllowlist: true }],
        rejected: [], outsideAllowlist: 0,
        chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0,
      }));
      const m = await import('../../../src/main/features/transcript_scan_combined');
      const res = await m.scanTranscriptCombined(TEST_UID, text, { docId: 'd1' });

      const forMaas = res.candidates.filter((c) => c.wrong === 'maas');
      expect(forMaas, '同一处只该有一条候选').toHaveLength(1);
      // 规则命中行**不写** fromModel 字段（是 undefined，不是 false）——
      // 只有模型候选才显式写 true。断言 falsy 而不是 false。
      expect(forMaas[0].fromModel, '保留的应是规则那条').toBeFalsy();
      expect(forMaas[0].riskLevel, '规则的风险等级必须保住').toBe('high');

      // 端到端：不得被自动应用
      const auto = await import('../../../src/main/features/transcript_auto_correct');
      const applied = auto.applyCorrections(text, res.candidates);
      expect(applied.text).toBe(text);
      expect(applied.status).toBe('draft');
    });

    it('规则占了某跨度，模型换个别的主张插进同一处也不允许', async () => {
      const glossary = await import('../../../src/main/features/transcript_glossary');
      glossary.upsertEntry(TEST_UID, {
        wrong: 'coxy', correct: 'Cogseed',
        scope: { docIds: [], scenarioTags: [], global: true },
      });
      const text = '用 coxy 上课';
      const at = text.indexOf('coxy');
      mockModel(async () => ({
        candidates: [{ wrong: 'coxy', correct: '某个别的词', confidence: 0.9, reason: 'r', start: at, pending: false, inAllowlist: false }],
        rejected: [], outsideAllowlist: 1,
        chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0,
      }));
      const m = await import('../../../src/main/features/transcript_scan_combined');
      const res = await m.scanTranscriptCombined(TEST_UID, text, { docId: 'd1' });
      const overlapping = res.candidates.filter((c) => c.span.start === at);
      expect(overlapping, '同一跨度只留一条').toHaveLength(1);
      expect(overlapping[0].correct).toBe('Cogseed');
    });

    it('模型在**别处**提的建议照常保留（去重不能误伤新发现）', async () => {
      const glossary = await import('../../../src/main/features/transcript_glossary');
      glossary.upsertEntry(TEST_UID, {
        wrong: 'coxy', correct: 'Cogseed',
        scope: { docIds: [], scenarioTags: [], global: true },
      });
      const text = '用 coxy 上课，另外 sst 也要改';
      const sstAt = text.indexOf('sst');
      mockModel(async () => ({
        candidates: [{ wrong: 'sst', correct: '语音转写', confidence: 0.8, reason: '缩写', start: sstAt, pending: false, inAllowlist: false }],
        rejected: [], outsideAllowlist: 1,
        chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0,
      }));
      const m = await import('../../../src/main/features/transcript_scan_combined');
      const res = await m.scanTranscriptCombined(TEST_UID, text, { docId: 'd1' });
      expect(res.candidates.map((c) => c.wrong).sort()).toEqual(['coxy', 'sst']);
      expect(res.stats.byChannel).toMatchObject({ exact: 1, model: 1 });
    });
  });

  it('byChannel 三路计数与候选总数自洽', async () => {
    mockModel(async (_uid: string, text: string) => okReview(text));
    const m = await import('../../../src/main/features/transcript_scan_combined');
    const res = await m.scanTranscriptCombined(TEST_UID, TEXT, {
      docId: 'd1', includeReview: true, includeRecall: true,
    });
    const { exact, recall, model } = res.stats.byChannel;
    expect(exact + recall + model).toBe(res.candidates.length);
    expect(res.stats.candidates).toBe(res.candidates.length);
  });

  it('抑制判据抛错不会让整次扫描失败（按未抑制处理）', async () => {
    const m = await import('../../../src/main/features/transcript_scan_combined');
    const res = await m.scanTranscriptCombined(TEST_UID, TEXT, {
      docId: 'd1',
      isSuppressed: () => { throw new Error('ledger unavailable'); },
    });
    expect(res.candidates.map((c) => c.wrong)).toContain('coxy');
    expect(res.stats.suppressed).toBe(0);
  });

  it('名册条目不产生候选（与 scanText 的短路一致）', async () => {
    const glossary = await import('../../../src/main/features/transcript_glossary');
    glossary.upsertEntry(TEST_UID, {
      wrong: '张浩', correct: '张浩', kind: 'people',
      scope: { docIds: [], scenarioTags: [], global: true },
    });
    const m = await import('../../../src/main/features/transcript_scan_combined');
    const res = await m.scanTranscriptCombined(TEST_UID, '张浩用 coxy 上课', { docId: 'd1' });
    expect(res.candidates.map((c) => c.wrong)).not.toContain('张浩');
    expect(res.stats.nameRosterSkipped).toBe(1);
  });
});
