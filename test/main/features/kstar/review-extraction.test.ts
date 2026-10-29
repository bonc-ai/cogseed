import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 标题闸门（设计 3.2）后晋升链对不合规 summary 走 LLM 起标题；本文件的候选
// 由 KStar 抽取/即时直投内生生成（summary＝模板拼接或正文首句），单测无模型，
// mock 出确定性合规标题（与 asset-title-suggestion.test.ts 同一边界口径）。
vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({
  suggestAbilityAssetTitle: async () => ({ title: '模型重起的样本标题' }),
}));


let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-review-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function episode(toolCalls: Array<{ name: string; status?: 'ok' | 'error' | 'unknown' }> = []) {
  return {
    schemaVersion: 1 as const,
    ownerId: 'review-user',
    id: 'kse-run-review',
    sessionId: 'mruntime-review',
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
    s: {},
    t: { userGoal: 'Create a reliable report.', constraints: [] },
    a: { toolCalls, agentActions: [] },
    r: { status: 'completed' as const, finalText: 'Done.', producedFiles: [] },
    evidenceRefs: [{ kind: 'execution' as const, id: 'run-review' }],
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
  };
}

describe('KSTAR review and Recall bridge', () => {
  it('keeps initial review unclear when expectation or verification evidence is missing', async () => {
    const { createInitialKstarReview } = await import('../../../../src/main/features/kstar/review-service');
    expect(createInitialKstarReview(episode())).toMatchObject({
      id: 'ksr-kse-run-review',
      deltaR: 'unknown',
      deltaA: 'unknown',
      outcome: 'unclear',
      attribution: 'unclear',
      confidence: 0,
    });
  });

  it('does not extract a candidate from an unverified one-tool episode', async () => {
    const [{ createInitialKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = episode([{ name: 'read_file', status: 'ok' }]);
    expect(proposeKstarCandidates(current, createInitialKstarReview(current))).toEqual([]);
  });

  it('does not extract a skill-method proposal from a successful multi-tool workflow without a learning signal', async () => {
    const [{ createInitialKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = episode([
      { name: 'read_file', status: 'ok' },
      { name: 'write_file', status: 'ok' },
    ]);
    const proposals = proposeKstarCandidates(current, createInitialKstarReview(current));
    expect(proposals).toEqual([]);
  });

  it('does not precipitate a review whose only secondary cause is non-reusable', async () => {
    const [{ saveKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = episode([
      { name: 'read_file', status: 'ok' },
      { name: 'write_file', status: 'ok' },
    ]);
    const review = await saveKstarReview('review-user', current, {
      deltaR: -0.8,
      deltaA: -0.3,
      outcome: 'worse_than_expected',
      attribution: 'execution_gap',
      reason: 'The user denied access to the requested operation.',
      confidence: 1,
      lesson: 'Do not retry a denied operation without a new authorization decision.',
      attributionDetails: [{
        category: 'permission_blocked',
        confidence: 1,
        evidenceRefs: current.evidenceRefs,
        source: 'deterministic',
      }],
      evidenceRefs: current.evidenceRefs,
    });
    expect(proposeKstarCandidates(current, review)).toEqual([]);
  });

  it('precipitates a reasoned process-experience lesson even when attribution is unclear', async () => {
    const [{ saveKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = episode([
      { name: 'read_file', status: 'ok' },
      { name: 'write_file', status: 'ok' },
    ]);
    // Live-observed shape (北京资料 task): met_expected, delta unknown,
    // attribution defaults to 'unclear' — but a concrete reusable lesson +
    // confidence + reason IS the learning signal (the lesson text is the
    // attribution). The old hasLearningSignal gate killed it.
    const review = await saveKstarReview('review-user', current, {
      deltaR: 'unknown',
      deltaA: 'unknown',
      outcome: 'met_expected',
      attribution: 'unclear',
      reason: 'The task was completed successfully and the lesson below is reusable.',
      confidence: 0.9,
      lesson: 'For "N 字资料" requests, state the actual character count (with punctuation) and organize by 概况—历史—现状—亮点 sections so the user can add/remove blocks.',
      evidenceRefs: current.evidenceRefs,
    });
    const proposals = proposeKstarCandidates(current, review);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      suggestedType: 'rule',
      judgment: expect.stringContaining('N 字资料'),
    });
  });

  it('drops an English lesson from a Chinese task at the consumer gate (falls back to workflow template)', async () => {
    const [{ saveKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = {
      ...episode([
        { name: 'read_file', status: 'ok' },
        { name: 'write_file', status: 'ok' },
      ]),
      t: { userGoal: '帮我写一份广州城市的资料，500 字', constraints: [] },
    };
    const review = await saveKstarReview('review-user', current, {
      expectedResult: '城市资料',
      actualResult: '城市资料',
      deltaR: 'unknown',
      deltaA: 'unknown',
      outcome: 'met_expected',
      attribution: 'unclear',
      reason: '任务完成。',
      confidence: 0.9,
      lesson: 'For well-known factual city profiles, skip explicit information-gathering plan steps.',
      evidenceRefs: current.evidenceRefs,
    });
    const proposals = proposeKstarCandidates(current, review);
    // 语言不匹配的 lesson 不产候选——宁可用确定性工作流模板，也不让英文经验进池。
    expect(proposals).toHaveLength(1);
    expect(proposals[0].judgment).not.toContain('For well-known factual city profiles');
    expect(proposals[0]).toMatchObject({
      suggestedType: 'skill_method',
      judgment: expect.stringContaining('处理类似「帮我写一份广州城市的资料，500 字」的任务时'),
    });
  });

  it('extracts a skill-method proposal only when review evidence compares expected and actual results', async () => {
    const [{ saveKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = episode([
      { name: 'read_file', status: 'ok' },
      { name: 'write_file', status: 'ok' },
    ]);
    const review = await saveKstarReview('review-user', current, {
      expectedResult: 'The report includes evidence and a verification summary.',
      actualResult: 'The report includes evidence and a verification summary.',
      deltaR: 0.4,
      deltaA: 0.2,
      outcome: 'better_than_expected',
      attribution: 'unclear',
      reason: 'The verified workflow produced the expected report and verification summary.',
      confidence: 0.9,
      evidenceRefs: current.evidenceRefs,
    });
    const proposals = proposeKstarCandidates(current, review);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      suggestedType: 'skill_method',
      suggestedScope: 'report',
      learningSignal: {
        expectedResult: 'The report includes evidence and a verification summary.',
        actualResult: 'The report includes evidence and a verification summary.',
        deltaR: 0.4,
        deltaA: 0.2,
        outcome: 'better_than_expected',
      },
      sourceRefs: [expect.objectContaining({ kind: 'execution', id: current.id })],
    });
  });

  it('does not send a workflow extraction hint without an expected-versus-actual result comparison', async () => {
    const [{ createInitialKstarReview }, { buildKstarDetectionHints }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = episode([
      { name: 'read_file', status: 'ok' },
      { name: 'write_file', status: 'ok' },
    ]);

    const hints = buildKstarDetectionHints(current, createInitialKstarReview(current));

    expect(hints.hasVerifiedWorkflow).toBe(true);
    expect(hints.hasWorkflowLearningSignal).toBe(false);
    expect(hints.hints.some((hint) => hint.includes('DETECTED WORKFLOW'))).toBe(false);
  });

  it('builds KSTAR detection hints for verified workflows and reviewed gaps', async () => {
    const { buildKstarDetectionHints } = await import('../../../../src/main/features/kstar/extraction-service');
    const current = episode([
      { name: 'read_file', status: 'ok' },
      { name: 'write_file', status: 'ok' },
    ]);
    const review = {
      id: 'ksr-kse-run-review',
      episodeId: current.id,
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
      expectedResult: 'The report satisfies all acceptance criteria.',
      actualResult: 'The report omitted one required acceptance check.',
      deltaR: -0.8,
      deltaA: 0.2,
      outcome: 'worse_than_expected' as const,
      attribution: 'rule_gap' as const,
      reason: 'Check the report acceptance criteria before writing the final file.',
      confidence: 0.9,
      evidenceRefs: current.evidenceRefs,
      goal: current.t.userGoal,
    };

    const hints = buildKstarDetectionHints(current, review);
    expect(hints.hasVerifiedWorkflow).toBe(true);
    expect(hints.hasWorkflowLearningSignal).toBe(true);
    expect(hints.hasReviewGap).toBe(true);
    expect(hints.hints).toEqual(expect.arrayContaining([
      expect.stringContaining('DETECTED WORKFLOW'),
      expect.stringContaining('DETECTED GAP'),
    ]));
  });

  it('binds an outdated referenced asset to an explicit KSTAR update proposal', async () => {
    const [{ saveKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = {
      ...episode([
        { name: 'read_file', status: 'ok' },
        { name: 'write_file', status: 'ok' },
      ]),
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: ['asset-kstar-outdated'] },
    };
    const review = await saveKstarReview('review-user', current, {
      deltaR: -0.5,
      deltaA: -0.2,
      outcome: 'worse_than_expected',
      attribution: 'execution_gap',
      reason: 'The referenced rule is outdated and needs a corrected statement.',
      confidence: 0.95,
      lesson: 'Update the rule with the current verification requirement.',
      attributionDetails: [{
        category: 'asset_outdated',
        confidence: 0.95,
        evidenceRefs: current.evidenceRefs,
        source: 'deterministic',
      }],
      evidenceRefs: current.evidenceRefs,
    });

    expect(proposeKstarCandidates(current, review)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        suggestedAction: 'update',
        targetAssetId: 'asset-kstar-outdated',
      }),
    ]));
  });

  it('does not bind a mutation when multiple referenced assets make the target ambiguous', async () => {
    const [{ saveKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = {
      ...episode([
        { name: 'read_file', status: 'ok' },
        { name: 'write_file', status: 'ok' },
      ]),
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: ['asset-kstar-a', 'asset-kstar-b'] },
    };
    const review = await saveKstarReview('review-user', current, {
      deltaR: -0.5,
      deltaA: -0.2,
      outcome: 'worse_than_expected',
      attribution: 'execution_gap',
      reason: 'The referenced rule is outdated.',
      confidence: 0.95,
      lesson: 'Update the rule with the current verification requirement.',
      attributionDetails: [{
        category: 'asset_outdated',
        confidence: 0.95,
        evidenceRefs: current.evidenceRefs,
        source: 'deterministic',
      }],
      evidenceRefs: current.evidenceRefs,
    });

    expect(proposeKstarCandidates(current, review).every((proposal) => proposal.suggestedAction !== 'update'))
      .toBe(true);
  });

  it('maps an explicitly non-applicable referenced asset to a scope-limiting proposal', async () => {
    const [{ saveKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = {
      ...episode([
        { name: 'read_file', status: 'ok' },
        { name: 'write_file', status: 'ok' },
      ]),
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: ['asset-kstar-scope'] },
    };
    const review = await saveKstarReview('review-user', current, {
      deltaR: -0.5,
      deltaA: -0.2,
      outcome: 'worse_than_expected',
      attribution: 'execution_gap',
      reason: 'The referenced rule does not apply to this task scope.',
      confidence: 0.95,
      lesson: 'Restrict the rule to the report tasks where it was verified.',
      attributionDetails: [{
        category: 'asset_not_applicable',
        confidence: 0.9,
        evidenceRefs: current.evidenceRefs,
        source: 'deterministic',
      }],
      evidenceRefs: current.evidenceRefs,
    });

    expect(proposeKstarCandidates(current, review)).toEqual(expect.arrayContaining([
      expect.objectContaining({ suggestedAction: 'limit_scope', targetAssetId: 'asset-kstar-scope' }),
    ]));
  });
  it('maps CJK task goals to short scope tags (scopeForTask)', async () => {
    const { scopeForTask } = await import('../../../../src/main/features/recall/experience-taxonomy');
    expect(scopeForTask('审查 Group Chat 消息路由')).toBe('review');
    expect(scopeForTask('修复 OAuth 回调函数缺陷')).toBe('code');
    expect(scopeForTask('生成一份架构审查报告')).toBe('report');
    expect(scopeForTask('随便聊聊')).toBe('general');
  });

  it('asset-mutation proposals carry the version the task actually used（2026-09-16 版本组契约）', async () => {
    const [{ createInitialKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = {
      ...episode([{ name: 'read_file', status: 'ok' }]),
      t: { userGoal: '生成一份架构审查报告。', constraints: [] },
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: ['asset-x'], abilityAssetVersions: { 'asset-x': '2' } },
    };
    const review = {
      ...createInitialKstarReview(current),
      attribution: 'knowledge_gap',
      confidence: 0.9,
      lesson: '接口变更后要同步更新文档，避免下游引用失效。',
      attributionDetails: [{ category: 'asset_outdated' }],
    };
    const proposals = proposeKstarCandidates(current, review);
    const mutation = proposals.find((p) => p.suggestedAction === 'update');
    expect(mutation).toMatchObject({ targetAssetId: 'asset-x', targetVersionUsed: '2' });
    // episode 无版本映射（老数据）：targetVersionUsed 缺省，不阻断提案。
    const legacy = { ...current, k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: ['asset-x'] } };
    const legacyProposals = proposeKstarCandidates(legacy, review);
    expect(legacyProposals.find((p) => p.suggestedAction === 'update')).toMatchObject({ targetAssetId: 'asset-x' });
    expect(legacyProposals.find((p) => p.suggestedAction === 'update')).not.toHaveProperty('targetVersionUsed');
  });
});

describe('lessonTitleCore（2026-10-15 残片修复回归）', () => {
  it('剥离「回答X时」引导前缀，不再产出「回答…时，」残片', async () => {
    const { lessonTitleCore } = await import('../../../../src/main/features/kstar/extraction-service');
    expect(lessonTitleCore('回答 GitHub 权限类问题时，优先查 token 作用域再查过期时间')).toBe('优先查 token 作用域再查过期时间');
    expect(lessonTitleCore('答复客户咨询时，先确认对方要的是结论还是过程')).toBe('先确认对方要的是结论还是过程');
  });

  it('首标点截断不再保留标点尾巴', async () => {
    const { lessonTitleCore } = await import('../../../../src/main/features/kstar/extraction-service');
    expect(lessonTitleCore('验收类任务若中途被追加落盘/建候选请求，验收对象就从「文本结构」变成「文件产出」')).toBe('验收类任务若中途被追加落盘/建候选请求');
    expect(lessonTitleCore('当模板填充报槽位错误时：先核对必填项')).toBe('先核对必填项');
    // 全部剥完仍回落「通用经验」，不产出空串或孤立标点。
    expect(lessonTitleCore('遇到同类情况时，应注意修正：')).toBe('通用经验');
  });
});
