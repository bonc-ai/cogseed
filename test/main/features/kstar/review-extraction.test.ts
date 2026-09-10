import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

  it('bridges an explicitly reviewed gap into a pending Recall candidate only', async () => {
    const [{ saveKstarReview }, { proposeKstarCandidates }, { saveKstarCandidateProposals }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
      import('../../../../src/main/features/kstar/recall-bridge'),
    ]);
    const current = episode();
    const review = await saveKstarReview('review-user', current, {
      deltaR: -0.8,
      deltaA: 0.2,
      outcome: 'worse_than_expected',
      attribution: 'rule_gap',
      reason: 'Check the report acceptance criteria before writing the final file.',
      // 缺口候选必须有推理出的 lesson：只有 reason（诊断文本）时不再产候选。
      lesson: 'Check the report acceptance criteria before writing the final file to avoid rework.',
      confidence: 0.9,
      evidenceRefs: current.evidenceRefs,
    });
    const proposals = proposeKstarCandidates(current, review).map((proposal) => ({
      ...proposal,
      learningProvenance: {
        projectionId: 'proj-review', forecastId: 'wf-review', episodeId: current.id,
        ruleRefs: ['rule:asset-review:1'], attribution: review.attribution,
      },
    }));
    const candidates = await saveKstarCandidateProposals('review-user', proposals);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      status: 'pending_review',
      suggestedType: 'rule',
      learningProvenance: {
        projectionId: 'proj-review', forecastId: 'wf-review', episodeId: current.id,
        ruleRefs: ['rule:asset-review:1'], attribution: 'rule_gap',
      },
      learningSignal: {
        deltaR: -0.8,
        deltaA: 0.2,
        outcome: 'worse_than_expected',
        confidence: 0.9,
        source: 'review',
      },
    });
    const promoted = await (await import('../../../../src/main/features/recall/candidate-service'))
      .promoteRecallCandidate('review-user', candidates[0].id, { actor: 'user' });
    expect(promoted.asset.learningProvenance).toMatchObject({
      projectionId: 'proj-review', forecastId: 'wf-review', episodeId: current.id,
      ruleRefs: ['rule:asset-review:1'], attribution: 'rule_gap',
    });
    expect(promoted.asset.causalRule).toBeUndefined();
    expect(promoted.asset.learningSignal).toMatchObject({
      deltaR: -0.8,
      deltaA: 0.2,
      outcome: 'worse_than_expected',
      confidence: 0.9,
      source: 'review',
    });
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

  it('persists an explicit KSTAR mutation action and target in the unified candidate pool', async () => {
    const { saveKstarCandidateProposals } = await import('../../../../src/main/features/kstar/recall-bridge');
    const candidates = await saveKstarCandidateProposals('review-user', [{
      judgment: 'Update the report verification rule with the current acceptance check.',
      suggestedType: 'rule',
      suggestedScope: 'report',
      suggestedAction: 'update',
      targetAssetId: 'asset-kstar-existing',
      sourceRefs: [{ kind: 'execution', id: 'exec-kstar-explicit-update' }],
    }]);

    expect(candidates[0]).toMatchObject({
      suggestedAction: 'update',
      targetAssetId: 'asset-kstar-existing',
      status: 'pending_review',
    });
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

  it('allows an explicit pause proposal only when it names a target asset', async () => {
    const { saveKstarCandidateProposals } = await import('../../../../src/main/features/kstar/recall-bridge');
    await expect(saveKstarCandidateProposals('review-user', [{
      judgment: 'Pause the obsolete report verification rule pending revalidation.',
      suggestedType: 'rule',
      suggestedScope: 'report',
      suggestedAction: 'pause',
      targetAssetId: 'asset-kstar-pause',
      sourceRefs: [{ kind: 'execution', id: 'exec-kstar-pause' }],
    }])).resolves.toMatchObject([{ suggestedAction: 'pause', targetAssetId: 'asset-kstar-pause' }]);
  });

  it('rejects an explicit KSTAR mutation without a target before writing a candidate', async () => {
    const { saveKstarCandidateProposals } = await import('../../../../src/main/features/kstar/recall-bridge');

    await expect(saveKstarCandidateProposals('review-user', [{
      judgment: 'Update the report verification rule with the current acceptance check.',
      suggestedType: 'rule',
      suggestedScope: 'report',
      suggestedAction: 'update',
      sourceRefs: [{ kind: 'execution', id: 'exec-kstar-invalid-update' }],
    }])).rejects.toThrow(/target asset/i);
  });
  it('maps CJK task goals to short scope tags (scopeForTask)', async () => {
    const { scopeForTask } = await import('../../../../src/main/features/kstar/extraction-service');
    expect(scopeForTask('审查 Group Chat 消息路由')).toBe('review');
    expect(scopeForTask('修复 OAuth 回调函数缺陷')).toBe('code');
    expect(scopeForTask('生成一份架构审查报告')).toBe('report');
    expect(scopeForTask('随便聊聊')).toBe('general');
  });
});
