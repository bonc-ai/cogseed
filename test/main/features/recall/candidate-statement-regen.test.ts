import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
/** 旧候选批量改写入口兼容测试：只读检查，不调用模型、不改候选正文、状态、范围或历史。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/* hoisted mock（vi.mock 提升到文件顶，早于任何动态 import 生效）：
 * 两个可变桩按用例切换行为——改写结果与模型配置状态。 */
const rewriteMock = vi.fn(async () => ({ statement: '改写后的合规短正文。', confidence: 0.9 }));
let authConfigured = true;
vi.mock('../../../../src/main/features/recall/asset-statement-rewrite', () => ({
  suggestAbilityAssetStatement: rewriteMock,
}));
vi.mock('../../../../src/main/features/auth', () => ({
  hasConfiguredModelForUser: () => ({ configured: authConfigured }),
  getConfiguredModelOAuthExpiredMessage: () => '',
}));

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  rewriteMock.mockImplementation(async () => ({ statement: '改写后的合规短正文。', confidence: 0.9 }));
  authConfigured = true;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cand-regen-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

const UID = 'u-cand-regen';

/** 超长 rule 正文（>200 硬限触发 too_long）。两段互不相同——save 的语义
 * 查重会把同文候选并成一条（测试里 long/settled 必须用不同正文）。 */
const LONG_RULE = '这条规则正文刻意写得很长很长很长'.repeat(20);
const LONG_RULE_ALT = '另一条也超长的规则正文用于终态样本'.repeat(20);

async function seedCandidate(id: string, overrides: Record<string, unknown> = {}) {
  const { saveRecallCandidate } = await import('../../../../src/main/features/recall/candidate-service');
  const saved = await createNightlyCandidateFixture(UID, {
    judgment: String(overrides.judgment ?? LONG_RULE),
    summary: String(overrides.summary ?? `候选-${id}`),
    suggestedType: String(overrides.suggestedType ?? 'rule'),
    suggestedScope: String(overrides.suggestedScope ?? 'code'),
    suggestedAction: 'create',
    sourceRefs: [],
    evidenceRefs: [],
    // 存量语义（2026-09-29 入池闸门上线后）：治理轮圈的是闸门前进池的
    // 原样脏正文，造数须豁免闸门，否则夹具在 save 时就被改写、测不到轮。
    rawStatement: true,
    ...overrides,
  } as never);
  return saved;
}

async function runRound() {
  const { runCandidateStatementRegenCleanup } = await import('../../../../src/main/features/recall/cleanup-report-service');
  return runCandidateStatementRegenCleanup(UID, { trigger: 'user' });
}


describe('旧候选批量改写入口退役', () => {
  it('超长、合规和已拒绝候选都保留原文；旧入口只能返回检查报告', async () => {
    const { readRecallCandidate, rejectRecallCandidate } = await import('../../../../src/main/features/recall/candidate-service');
    const long = await seedCandidate('long');
    const clean = await seedCandidate('clean', { judgment: '短而合规的规则正文。', rawStatement: true });
    const settled = await seedCandidate('settled', { judgment: LONG_RULE_ALT, rawStatement: true });
    await rejectRecallCandidate(UID, settled.id);
    const before = await Promise.all([long, clean, settled].map(c => readRecallCandidate(UID, c.id)));
    rewriteMock.mockClear();
    const report = await runRound();
    expect(report.mode).toBe('report_only');
    expect(report.items.some(item => item.status === 'applied')).toBe(false);
    expect(await Promise.all([long, clean, settled].map(c => readRecallCandidate(UID, c.id)))).toEqual(before);
    expect(rewriteMock).not.toHaveBeenCalled();
  });

  it('自由文本范围不被机械改成通用范围，缺少模型也不阻断只检查', async () => {
    const { readRecallCandidate } = await import('../../../../src/main/features/recall/candidate-service');
    const dirty = await seedCandidate('dirty', { judgment: '短而合规的正文。', suggestedScope: '认知资产的检索、注入与派发环节' });
    const before = await readRecallCandidate(UID, dirty.id);
    authConfigured = false;
    rewriteMock.mockClear();
    const report = await runRound();
    expect(report.mode).toBe('report_only');
    expect(await readRecallCandidate(UID, dirty.id)).toEqual(before);
    expect(rewriteMock).not.toHaveBeenCalled();
  });
});
