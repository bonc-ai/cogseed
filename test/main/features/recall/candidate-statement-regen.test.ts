/**
 * 候选正文改写轮（2026-09-29 存量统一处理批）真函数级测试。
 *
 * 钉住的硬边界：
 *  - 只动可操作域候选（超长/带痕迹的 judgment 被 LLM 改写并落盘）；
 *  - 终态候选（confirmed/rejected 等）与合规候选一个字都不碰；
 *  - LLM 改写结果复检不过规范 ⇒ 不落盘（skipped），宁留原样不写坏数据；
 *  - scope 非枚举脏数据不机械归一，进 uncertain 人工定；
 *  - 写前整池备份目录落盘，报告 round/items/uncertain 形状如实。
 */
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
  const saved = await saveRecallCandidate(UID, {
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

describe('候选正文改写轮（round=candidate_statement_regen）', () => {
  it('超长可操作候选被改写落盘；合规候选与终态候选原样不动', async () => {
    const { readRecallCandidate } = await import('../../../../src/main/features/recall/candidate-service');
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const long = await seedCandidate('long');
    const clean = await seedCandidate('clean', { judgment: '短而合规的规则正文。', summary: '合规候选' });
    const settled = await seedCandidate('settled', { judgment: LONG_RULE_ALT, summary: '终态候选', sourceRefs: [{ kind: 'conversation', id: 'conv-1' }], evidenceRefs: [{ kind: 'conversation', id: 'conv-1' }] });
    // 终态不走 reject 正门（证据闸会拦测试合成数据）——直接改落盘 status，
    // 本测试只关心「轮对终态一个字不碰」这条红线。
    {
      const { userCloudRoot } = await import('../../../../src/main/paths');
      const file = path.join(userCloudRoot(UID), 'recall', 'records', 'candidates', `${settled.id}.json`);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.status = 'rejected';
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    }

    const report = await runRound();

    // 超长候选：正文被改写且复检合规（issues 归零）。
    const after = await readRecallCandidate(UID, long.id);
    expect(after.judgment).toBe('改写后的合规短正文。');
    // 合规候选：一字未动。
    const cleanAfter = await readRecallCandidate(UID, clean.id);
    expect(cleanAfter.judgment).toBe('短而合规的规则正文。');
    // 终态候选：红线——不碰（超长也留着，报告如实记 uncertain/skipped 之外不出现 applied）。
    const settledAfter = await readRecallCandidate(UID, settled.id);
    expect(settledAfter.judgment).toBe(LONG_RULE_ALT);
    expect(settledAfter.status).toBe('rejected');
    // 报告形状：applied 恰一条（long），settled 不在 applied 里；备份目录存在。
    expect(report.round).toBe('candidate_statement_regen');
    const applied = report.items.filter((item) => item.status === 'applied');
    expect(applied.map((item) => item.assetId)).toEqual([long.id]);
    expect(report.items.some((item) => item.assetId === settled.id && item.status === 'applied')).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'recall', report.backupDir!)) || fs.existsSync(report.backupDir!)).toBe(true);
  });

  it('LLM 改写复检不过规范 ⇒ skipped 不落盘；scope 脏数据进 uncertain', async () => {
    const { readRecallCandidate } = await import('../../../../src/main/features/recall/candidate-service');
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const stubborn = await seedCandidate('stubborn');
    // scope 为中文自由文本但正文合规 ⇒ 只进 uncertain，不 LLM、不改写。
    const dirtyScope = await seedCandidate('dirty', { judgment: '短而合规的正文。', suggestedScope: '认知资产的检索、注入与派发环节' });

    // 复检仍超长：mock 返回另一段超长文。
    rewriteMock.mockImplementationOnce(async () => ({ statement: LONG_RULE, confidence: 0.5 }));
    const report = await runRound();

    // 复检不过：原样保留 + skipped 记录（不写坏数据）。
    const stubbornAfter = await readRecallCandidate(UID, stubborn.id);
    expect(stubbornAfter.judgment).toBe(LONG_RULE);
    expect(report.items.find((item) => item.assetId === stubborn.id)?.status).toBe('skipped');
    // scope 脏数据：进 uncertain、候选本体未动。
    expect(report.uncertain.some((entry) => entry.assetId === dirtyScope.id)).toBe(true);
    const dirtyAfter = await readRecallCandidate(UID, dirtyScope.id);
    expect(dirtyAfter.suggestedScope).toBe('认知资产的检索、注入与派发环节');
  });

  it('模型未配置 ⇒ 整轮拒绝执行，不做静默跳过', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    authConfigured = false;
    const { runCandidateStatementRegenCleanup } = await import('../../../../src/main/features/recall/cleanup-report-service');
    await expect(runCandidateStatementRegenCleanup(UID)).rejects.toThrow('尚未配置可用模型');
  });
});
