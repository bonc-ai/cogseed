/**
 * meeting_metrics — 会议指标事件、五项口径与回执汇总（specs/013 · US-506 / T053~T056）
 *
 * 钉住的验收（tasks.md 原文）：
 *   T054 ① 五种事件各自可写可读；② 坏行不阻断；③ 不混既有 metrics.jsonl
 *        （既有 readEvents 对会议事件零可见 = 既有读口零改动的行为证据）；
 *        写入失败不炸链路。
 *   T055 五项口径逐项手算对拍；每项比率必带分母与样本数；空数据 ⇒ rate:null
 *        且样本数 0（不编数字）；撤销（unreject）不计入采纳分子分母。
 *   T053 只回会议侧回执（其余前缀被过滤）；limit 边界；返回体不含正文。
 *   T056 有 usage ⇒ 事件出现且数值一致；无 usage（模型不可用/失败）⇒ 零事件；
 *        既有 no_model / model_failed 提示口径不变。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// IPC 层用例（文末 T056 组）经 ipc/transcript.ts 间接拉起 electron 依赖链，
// 与既有 test/main/ipc/transcript-scan-review.test.ts 同一套 mock。
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
}));

import {
  readMeetingEvents,
  recordMeetingMetric,
  summarizeMeetingMetrics,
  listMeetingReceipts,
  itemIdOfTargetRef,
  type MeetingMetricEvent,
} from '../../../src/main/features/meeting_metrics';
import { readEvents as readLegacyEvents } from '../../../src/main/features/transcript_metrics';
import { writeReviewDecision, recordReviewDecisionOutcome } from '../../../src/main/features/cognition/review-decision';
import { userMeetingMetricsFile } from '../../../src/main/paths';

let uid = '';
beforeEach(() => {
  uid = `u_meeting_metrics_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  fs.rmSync(userMeetingMetricsFile(uid), { force: true });
});

function eventFile(): string {
  return userMeetingMetricsFile(uid);
}

describe('T054：指标事件与读口（新文件，不混既有 metrics.jsonl）', () => {
  it('① 五种事件各自可写可读，一行一事件', () => {
    recordMeetingMetric(uid, { kind: 'meeting_scan', docId: 'd1', candidates: 6, exact: 3, recall: 2, model: 1, quotedExample: 1, truncated: false, termCandidates: 4 });
    recordMeetingMetric(uid, { kind: 'meeting_decision', docId: 'd1', itemId: 'g_1', itemKind: 'correction', decision: 'accept', refs: 2, entryKind: 'term' });
    recordMeetingMetric(uid, { kind: 'meeting_asset_ref', docId: 'd1', assetId: 'ast_a', version: '3', via: 'conclusion' });
    recordMeetingMetric(uid, { kind: 'meeting_model_usage', docId: 'd1', operation: 'review', inputTokens: 1200, outputTokens: 80, totalTokens: 1280 });
    recordMeetingMetric(uid, { kind: 'meeting_revert', docId: 'd1', runId: 'run_9', acceptedCount: 3 });
    const events = readMeetingEvents(uid);
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.kind)).toEqual([
      'meeting_scan', 'meeting_decision', 'meeting_asset_ref', 'meeting_model_usage', 'meeting_revert',
    ]);
    expect(events[0]).toMatchObject({ docId: 'd1', candidates: 6, termCandidates: 4 });
    expect(events[1]).toMatchObject({ itemId: 'g_1', decision: 'accept', entryKind: 'term' });
    expect(events[3]).toMatchObject({ inputTokens: 1200, outputTokens: 80, totalTokens: 1280 });
    expect(events.every((e) => typeof e.at === 'number')).toBe(true);
  });

  it('① readMeetingEvents 可按 docId 过滤', () => {
    recordMeetingMetric(uid, { kind: 'meeting_scan', docId: 'd1', candidates: 1, exact: 1, recall: 0, model: 0, quotedExample: 0, truncated: false });
    recordMeetingMetric(uid, { kind: 'meeting_scan', docId: 'd2', candidates: 2, exact: 2, recall: 0, model: 0, quotedExample: 0, truncated: false });
    expect(readMeetingEvents(uid, { docId: 'd1' })).toHaveLength(1);
    expect(readMeetingEvents(uid, { docId: 'd1' })[0].docId).toBe('d1');
  });

  it('② 坏行与未知 kind 跳过，不阻断其余事件', () => {
    recordMeetingMetric(uid, { kind: 'meeting_scan', docId: 'd1', candidates: 1, exact: 1, recall: 0, model: 0, quotedExample: 0, truncated: false });
    fs.appendFileSync(eventFile(), '这不是 JSON\n', 'utf8');
    fs.appendFileSync(eventFile(), `${JSON.stringify({ kind: 'confirm_latency', ms: 10 })}\n`, 'utf8'); // 既有 kind：不该被会议读口收
    fs.appendFileSync(eventFile(), `${JSON.stringify({ kind: 'meeting_nonsense' })}\n`, 'utf8');
    recordMeetingMetric(uid, { kind: 'meeting_revert', docId: 'd1', runId: 'r1', acceptedCount: 1 });
    const events = readMeetingEvents(uid);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.kind)).toEqual(['meeting_scan', 'meeting_revert']);
  });

  it('③ 不混流：会议事件写的是 meeting-metrics.jsonl，既有 readEvents 对它零可见', () => {
    recordMeetingMetric(uid, { kind: 'meeting_scan', docId: 'd1', candidates: 1, exact: 1, recall: 0, model: 0, quotedExample: 0, truncated: false });
    recordMeetingMetric(uid, { kind: 'meeting_model_usage', docId: 'd1', operation: 'review', inputTokens: 5, outputTokens: 1 });
    // 既有读口只认 confirm_latency/retention：会议事件对它不存在（既有断言零改动）
    expect(readLegacyEvents(uid)).toEqual([]);
    // 两个文件也不同名
    expect(eventFile()).not.toContain('metrics.jsonl\n');
    expect(path.basename(eventFile())).toBe('meeting-metrics.jsonl');
  });

  it('④ 写入失败不炸链路（路径被目录占用 ⇒ 静默 warn，不 throw）', () => {
    fs.rmSync(eventFile(), { force: true });
    fs.mkdirSync(eventFile(), { recursive: true }); // 占用目标路径：append 必失败
    expect(() => recordMeetingMetric(uid, { kind: 'meeting_revert', docId: 'd1', runId: 'r1', acceptedCount: 1 })).not.toThrow();
    expect(readMeetingEvents(uid)).toEqual([]);
  });

  it('meeting_model_usage：全部读数缺失 ⇒ 不写事件（不写 0 假装测到）', () => {
    expect(() => recordMeetingMetric(uid, { kind: 'meeting_model_usage', docId: 'd1', operation: 'review' })).not.toThrow();
    expect(fs.existsSync(eventFile())).toBe(false);
    expect(readMeetingEvents(uid)).toEqual([]);
    // 部分读数也如实落（缺的字段不补 0）
    recordMeetingMetric(uid, { kind: 'meeting_model_usage', docId: 'd1', operation: 'review', outputTokens: 7 });
    const [only] = readMeetingEvents(uid);
    expect(only).toMatchObject({ kind: 'meeting_model_usage', outputTokens: 7 });
    expect('inputTokens' in only).toBe(false);
  });

  it('未知 kind 直接拒（调用方 bug 不静默吞）', () => {
    expect(() => recordMeetingMetric(uid, { kind: 'meeting_unknown' } as unknown as Parameters<typeof recordMeetingMetric>[1])).toThrow(/unknown meeting metric kind/);
  });
});

describe('T055：五项口径（手算样本对拍）', () => {
  const d = (over: Partial<Extract<MeetingMetricEvent, { kind: 'meeting_decision' }>>): MeetingMetricEvent => ({
    kind: 'meeting_decision',
    docId: over.docId ?? 'd1',
    itemId: over.itemId ?? 'g_0',
    itemKind: over.itemKind ?? 'correction',
    decision: over.decision ?? 'accept',
    refs: over.refs ?? 1,
    at: 0,
    ...(over.entryKind ? { entryKind: over.entryKind } : {}),
  });
  const scan = (termCandidates?: number, docId = 'd1'): MeetingMetricEvent => ({
    kind: 'meeting_scan', docId, candidates: 1, exact: 1, recall: 0, model: 0, quotedExample: 0, truncated: false,
    ...(termCandidates !== undefined ? { termCandidates } : {}), at: 0,
  });

  it('采纳率：accept/(accept+modify+reject+ignore)；defer 与 keep_current 不入分母；unreject 双侧剔除', () => {
    const events: MeetingMetricEvent[] = [
      d({ decision: 'accept' }),
      d({ decision: 'accept', itemId: 'g_1' }),
      d({ decision: 'modify' }),
      d({ decision: 'reject' }),
      d({ decision: 'ignore' }),
      d({ decision: 'defer' }),          // 暂缓不是决定：不入分母
      d({ decision: 'keep_current' }),   // 不在公式内
      d({ decision: 'unreject' }),       // 撤销写的 accept：分子分母都不计
    ];
    const summary = summarizeMeetingMetrics(events);
    expect(summary.adoption).toEqual({ numerator: 2, denominator: 5, rate: 2 / 5, samples: 5 });
  });

  it('误引用率：分母 = assetRefs 出现次数（同 docId+assetId 去重）；末条判不当；未评判不算错；被撤销的 reject 不计', () => {
    const assetRef = (assetId: string, docId = 'd1'): MeetingMetricEvent =>
      ({ kind: 'meeting_asset_ref', docId, assetId, version: '1', via: 'attach', at: 0 });
    const judge = (assetId: string, decision: string, docId = 'd1'): MeetingMetricEvent =>
      d({ docId, itemId: assetId, itemKind: 'asset_ref', decision });
    // 分母去重：astA 出现两次只算一条；未评判的 astC 不算错
    const events: MeetingMetricEvent[] = [
      assetRef('astA'), assetRef('astA'), assetRef('astB'), assetRef('astC'),
      judge('astA', 'reject'),   // 判为引用不当
      judge('astB', 'modify'),   // 修改引用也是"不当"信号
    ];
    const summary = summarizeMeetingMetrics(events);
    expect(summary.misReference).toEqual({ numerator: 2, denominator: 3, rate: 2 / 3, samples: 3 });
    // 撤销：reject 之后来了 unreject ⇒ 末条不再是"不当"
    const undone: MeetingMetricEvent[] = [assetRef('astA'), judge('astA', 'reject'), judge('astA', 'unreject')];
    expect(summarizeMeetingMetrics(undone).misReference).toEqual({ numerator: 0, denominator: 1, rate: 0, samples: 1 });
  });

  it('token 增量：input+output 绝对值累加（totalTokens 汇总口径 = in+out，不混存账字段）', () => {
    const events: MeetingMetricEvent[] = [
      { kind: 'meeting_model_usage', docId: 'd1', operation: 'review', inputTokens: 1200, outputTokens: 80, totalTokens: 1280, at: 0 },
      { kind: 'meeting_model_usage', docId: 'd1', operation: 'review', inputTokens: 300, outputTokens: 20, at: 0 },
    ];
    const summary = summarizeMeetingMetrics(events);
    expect(summary.token).toEqual({ inputTokens: 1500, outputTokens: 100, totalTokens: 1600, samples: 2 });
  });

  it('术语改对率：术语类 accept / 术语类候选出现次数；filler（口癖）与 modify 不进分子', () => {
    const events: MeetingMetricEvent[] = [
      scan(5), scan(3), scan(), // 第 3 次没分桶 ⇒ 不计分母（不按 0 编）
      d({ decision: 'accept', entryKind: 'term' }),
      d({ decision: 'accept', itemId: 'g_1', entryKind: 'people' }),
      d({ decision: 'accept', itemId: 'g_2', entryKind: 'filler' }), // 口癖不算术语
      d({ decision: 'modify', itemId: 'g_3', entryKind: 'product' }), // 非 accept 不进分子
    ];
    const summary = summarizeMeetingMetrics(events);
    expect(summary.entity.termFixedRate).toEqual({ numerator: 2, denominator: 8, rate: 0.25, samples: 8 });
    // 写入方从未分桶 ⇒ 分母 0 ⇒ rate:null（不编数字）
    const unbucketed = summarizeMeetingMetrics([
      scan(), d({ decision: 'accept', entryKind: 'term' }),
    ]);
    expect(unbucketed.entity.termFixedRate).toEqual({ numerator: 1, denominator: 0, rate: null, samples: 0 });
  });

  it('过纠正率：被 revertRun 撤销的 accept 条数 / accept 总数（unreject 的 accept 不进分母）', () => {
    const events: MeetingMetricEvent[] = [
      d({ decision: 'accept' }),
      d({ decision: 'accept', itemId: 'g_1' }),
      d({ decision: 'accept', itemId: 'g_2' }),
      d({ decision: 'accept', itemId: 'g_3' }),
      d({ decision: 'unreject', itemId: 'g_4' }), // 撤销不是 accept，分母不含它
      { kind: 'meeting_revert', docId: 'd1', runId: 'r1', acceptedCount: 2, at: 0 },
    ];
    const summary = summarizeMeetingMetrics(events);
    expect(summary.entity.overCorrectionRate).toEqual({ numerator: 2, denominator: 4, rate: 0.5, samples: 4 });
  });

  it('空数据 ⇒ 全部 rate:null、样本数 0、token 全 0（不编数字）；notMeasurable 至少三条', () => {
    const summary = summarizeMeetingMetrics([]);
    expect(summary.glossaryRuns).toBe(0);
    expect(summary.adoption).toEqual({ numerator: 0, denominator: 0, rate: null, samples: 0 });
    expect(summary.misReference.rate).toBeNull();
    expect(summary.misReference.samples).toBe(0);
    expect(summary.token).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, samples: 0 });
    expect(summary.entity.termFixedRate.rate).toBeNull();
    expect(summary.entity.overCorrectionRate.rate).toBeNull();
    expect(summary.notMeasurable.length).toBeGreaterThanOrEqual(3);
    expect(summary.notMeasurable.some((item) => item.includes('纪要质量'))).toBe(true);
    expect(summary.notMeasurable.some((item) => item.includes('token'))).toBe(true);
  });

  it('scope.docId：只按该文档的事件算；scope 原样回填', () => {
    const events: MeetingMetricEvent[] = [
      d({ docId: 'd1', decision: 'accept' }),
      d({ docId: 'd2', decision: 'reject' }),
      scan(2, 'd1'), scan(5, 'd2'),
    ];
    const summary = summarizeMeetingMetrics(events, { docId: 'd1' });
    expect(summary.scope).toEqual({ docId: 'd1' });
    expect(summary.adoption).toEqual({ numerator: 1, denominator: 1, rate: 1, samples: 1 });
    expect(summary.entity.termFixedRate.denominator).toBe(2);
  });
});

describe('T053：回执汇总（读既有账本过滤）', () => {
  it('只回会议侧回执（其余前缀被过滤）；itemKind 按条目 id 前缀判定', async () => {
    await writeReviewDecision(uid, { targetRef: 'meeting:d1:g_1', decisionType: 'reject', decision: '拒绝' });
    await writeReviewDecision(uid, { targetRef: 'meeting:d1:mc_x', decisionType: 'accept', decision: '纪要条目成立' });
    await writeReviewDecision(uid, { targetRef: 'meeting:d2:ma_y', decisionType: 'defer', decision: '稍后' });
    await writeReviewDecision(uid, { targetRef: 'p3394:foo', decisionType: 'accept', decision: '采纳这条建议' });
    await writeReviewDecision(uid, { targetRef: 'skill:bar', decisionType: 'reject', decision: '拒绝' });
    const receipts = await listMeetingReceipts(uid);
    expect(receipts).toHaveLength(3);
    const kinds = new Map(receipts.map((r) => [r.itemId, r.itemKind]));
    expect(kinds.get('g_1')).toBe('correction');
    expect(kinds.get('mc_x')).toBe('conclusion');
    expect(kinds.get('ma_y')).toBe('action');
    expect(receipts.every((r) => r.decisionId.startsWith('rd_'))).toBe(true);
  });

  it('docId 过滤：只回该文档的回执（docId 含冒号也不串档）', async () => {
    await writeReviewDecision(uid, { targetRef: 'meeting:kb/m.md:g_1', decisionType: 'reject', decision: '拒绝' });
    await writeReviewDecision(uid, { targetRef: 'meeting:kb/other.md:g_1', decisionType: 'reject', decision: '拒绝' });
    const receipts = await listMeetingReceipts(uid, { docId: 'kb/m.md' });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].itemId).toBe('g_1');
  });

  it('limit 边界：limit 只约束返回条数且非会议回执不占额；非法/超上限取缺省或 clamp', async () => {
    // 账本时间戳是秒级（storage.nowIso），同秒写入无法区分先后——limit 的契约
    // 是"最多回 N 条会议侧回执"，不断言具体次序（次序由时间粒度决定，不编）。
    await writeReviewDecision(uid, { targetRef: 'meeting:d1:g_1', decisionType: 'reject', decision: '拒绝' });
    await writeReviewDecision(uid, { targetRef: 'meeting:d1:mc_x', decisionType: 'accept', decision: '纪要条目成立' });
    await writeReviewDecision(uid, { targetRef: 'meeting:d2:ma_y', decisionType: 'defer', decision: '稍后' });
    await writeReviewDecision(uid, { targetRef: 'p3394:foo', decisionType: 'accept', decision: '采纳这条建议' });
    await writeReviewDecision(uid, { targetRef: 'skill:bar', decisionType: 'reject', decision: '拒绝' });
    expect((await listMeetingReceipts(uid)).length).toBe(3);               // 缺省 50：全回
    const two = await listMeetingReceipts(uid, { limit: 2 });
    expect(two).toHaveLength(2);                                           // limit:2 只回 2 条
    expect((await listMeetingReceipts(uid, { limit: 1 })).length).toBe(1); // 下界
    expect((await listMeetingReceipts(uid, { limit: 500 })).length).toBe(3); // 超上限 clamp 到 200，不放大
    expect((await listMeetingReceipts(uid, { limit: 0 })).length).toBe(3);  // 非法 → 缺省 50
    // limit 的语义：3 条会议回执全回时也只占总数 3（两条非会议前缀被过滤，不占额）
    expect(new Set(two.map((r) => [r.itemId, r.itemKind].join('|'))).size).toBe(2);
  });

  it('返回体不含正文：reason / modified_content 不进视图；refs 只带标识（asset_id 经既有 outcome 回填）', async () => {
    const written = await writeReviewDecision(uid, {
      targetRef: 'meeting:d1:g_secret', decisionType: 'reject',
      decision: '拒绝',
      reason: '这是拒绝原因里的自由文本，不该出现在回执视图',
      modifiedContent: '这是修改后的内容正文，也不该出现',
    });
    // 既有账本唯一的 asset_id 写入路径：outcome 回填（writeReviewDecision 输入无此字段）
    await recordReviewDecisionOutcome(uid, 'meeting:d1:g_secret', written.decision_id, { assetId: 'ast_ref_1' });
    const receipts = await listMeetingReceipts(uid);
    expect(receipts).toHaveLength(1);
    const serialized = JSON.stringify(receipts[0]);
    expect(serialized).not.toContain('自由文本');
    expect(serialized).not.toContain('内容正文');
    expect(serialized).not.toContain('reason');
    expect(serialized).not.toContain('modified');
    expect(receipts[0].refs).toContainEqual({ source: 'glossary', entryId: 'g_secret' });
    expect(receipts[0].refs).toContainEqual({ source: 'asset', assetId: 'ast_ref_1' });
  });

  it('空账本 ⇒ 空数组（空态，不报错）', async () => {
    expect(await listMeetingReceipts(uid)).toEqual([]);
  });

  it('itemIdOfTargetRef：docId 含冒号也能取出末段 itemId；畸形 ref 返回 null', () => {
    expect(itemIdOfTargetRef('meeting:kb/a:b.md:g_1')).toBe('g_1');
    expect(itemIdOfTargetRef('meeting:kb/m.md:mc_x')).toBe('mc_x');
    expect(itemIdOfTargetRef('meeting:only-doc')).toBeNull();
    expect(itemIdOfTargetRef('p3394:foo')).toBeNull();
  });
});

// ── T056：token 采集落点（scan 路径端到端） ────────────────────────────────
describe('T056：scan 路径的 meeting_model_usage 落点', () => {
  let tmpDir: string;
  let prevWs: string | undefined;
  const TEST_UID = 'uMeetingUsage';
  const TEXT = '用 coxy 上课，另外付平老师说要改排期。';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-meeting-usage-'));
    prevWs = process.env.COGSEED_WORKSPACE_ROOT;
    process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
    vi.resetModules();
    const users = await import('../../../src/main/features/users');
    users.activateUser(TEST_UID);
  });

  afterEach(() => {
    process.env.COGSEED_WORKSPACE_ROOT = prevWs;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.doUnmock('../../../src/main/features/transcript_llm_candidates');
  });

  function ctx() {
    return { userId: TEST_UID, user: { user_id: TEST_UID, created_at: new Date(0).toISOString() }, sender: {} };
  }

  it('有 usage ⇒ meeting_model_usage 事件出现且数值一致（docId 归属正确）', async () => {
    vi.doMock('../../../src/main/features/transcript_llm_candidates', async () => {
      const actual = await vi.importActual<typeof import('../../../src/main/features/transcript_llm_candidates')>('../../../src/main/features/transcript_llm_candidates');
      return {
        ...actual,
        generateReviewCandidates: async () => ({
          candidates: [], rejected: [], outsideAllowlist: 0,
          chunksScanned: 2, chunksTotal: 2, truncated: false, failedChunks: 0,
          usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280 },
        }),
      };
    });
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    await (invokeHandlers['transcript.correct.scan'] as (payload: Record<string, unknown>, ctx: unknown) => Promise<unknown>)(
      { text: TEXT, docId: 'kb/usage.md', includeReview: true }, ctx(),
    );
    const metrics = await import('../../../src/main/features/meeting_metrics');
    const events = metrics.readMeetingEvents(TEST_UID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'meeting_model_usage', docId: 'kb/usage.md', operation: 'review',
      inputTokens: 1200, outputTokens: 80, totalTokens: 1280,
    });
  });

  it('无 usage（模型不可用 no_model）⇒ 零事件；提示口径不变', async () => {
    vi.doMock('../../../src/main/features/transcript_llm_candidates', async () => {
      const actual = await vi.importActual<typeof import('../../../src/main/features/transcript_llm_candidates')>('../../../src/main/features/transcript_llm_candidates');
      return {
        ...actual,
        generateReviewCandidates: async () => ({
          candidates: [], rejected: [], outsideAllowlist: 0,
          chunksScanned: 0, chunksTotal: 0, truncated: false, failedChunks: 0,
          skipped: 'no_model', // 无 usage 字段
        }),
      };
    });
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as (payload: Record<string, unknown>, ctx: unknown) => Promise<any>)(
      { text: TEXT, docId: 'kb/usage.md', includeReview: true }, ctx(),
    );
    expect(scan.review.skipped).toBe('no_model'); // 面板既有提示口径不变
    const metrics = await import('../../../src/main/features/meeting_metrics');
    expect(metrics.readMeetingEvents(TEST_UID)).toEqual([]); // 零事件
    const { userMeetingMetricsFile } = await import('../../../src/main/paths');
    expect(fs.existsSync(userMeetingMetricsFile(TEST_UID))).toBe(false); // 文件根本没建
  });

  it('model_failed（全段失败）同样零事件；提示口径不变', async () => {
    vi.doMock('../../../src/main/features/transcript_llm_candidates', async () => {
      const actual = await vi.importActual<typeof import('../../../src/main/features/transcript_llm_candidates')>('../../../src/main/features/transcript_llm_candidates');
      return {
        ...actual,
        generateReviewCandidates: async () => ({
          candidates: [], rejected: [], outsideAllowlist: 0,
          chunksScanned: 0, chunksTotal: 2, truncated: false, failedChunks: 2,
          skipped: 'model_failed',
        }),
      };
    });
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as (payload: Record<string, unknown>, ctx: unknown) => Promise<any>)(
      { text: TEXT, docId: 'kb/usage.md', includeReview: true }, ctx(),
    );
    expect(scan.review.skipped).toBe('model_failed');
    expect(scan.review.failedChunks).toBe(2);
    const metrics = await import('../../../src/main/features/meeting_metrics');
    expect(metrics.readMeetingEvents(TEST_UID)).toEqual([]);
  });

  it('不点 includeReview（默认）⇒ 一次模型都不调，自然零事件', async () => {
    let called = false;
    vi.doMock('../../../src/main/features/transcript_llm_candidates', async () => {
      const actual = await vi.importActual<typeof import('../../../src/main/features/transcript_llm_candidates')>('../../../src/main/features/transcript_llm_candidates');
      return {
        ...actual,
        generateReviewCandidates: async () => { called = true; return { candidates: [], rejected: [], outsideAllowlist: 0, chunksScanned: 0, chunksTotal: 0, truncated: false, failedChunks: 0 }; },
      };
    });
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as (payload: Record<string, unknown>, ctx: unknown) => Promise<any>)(
      { text: TEXT, docId: 'kb/usage.md' }, ctx(),
    );
    expect(called).toBe(false);
    expect(scan.review).toBeNull();
    const metrics = await import('../../../src/main/features/meeting_metrics');
    expect(metrics.readMeetingEvents(TEST_UID)).toEqual([]);
  });
});
