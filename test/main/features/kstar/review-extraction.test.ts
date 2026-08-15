import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-review-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
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
  it('maps CJK task goals to short scope tags (scopeForTask)', async () => {
    const { scopeForTask } = await import('../../../../src/main/features/kstar/extraction-service');
    expect(scopeForTask('审查 Group Chat 消息路由')).toBe('review');
    expect(scopeForTask('修复 OAuth 回调函数缺陷')).toBe('code');
    expect(scopeForTask('生成一份架构审查报告')).toBe('report');
    expect(scopeForTask('随便聊聊')).toBe('general');
  });
});