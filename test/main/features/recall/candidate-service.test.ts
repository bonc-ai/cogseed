import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-candidates-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function service() {
  return import('../../../../src/main/features/recall/candidate-service');
}

describe('Recall candidate governance', () => {
  it('saves deduplicated candidates with normalized evidence and allows defer/resume/reject', async () => {
    const candidates = await service();
    const input = {
      judgment: '  Prefer concise answers for product decisions. ',
      summary: 'Concise decisions',
      suggestedType: 'rule' as const,
      suggestedScope: 'product',
      sourceRefs: [
        { kind: 'memory' as const, id: 'mem-a' },
        { kind: 'memory' as const, id: 'mem-a' },
        { kind: 'execution' as const, id: 'exec-a', degraded: true, reason: 'archived' },
      ],
    };

    const first = await candidates.saveRecallCandidate('user-a', input);
    const duplicate = await candidates.saveRecallCandidate('user-a', input);
    expect(duplicate.id).toBe(first.id);
    expect(first.sourceRefs).toHaveLength(2);
    expect(first.status).toBe('pending_review');

    const edited = await candidates.updateRecallCandidate('user-a', first.id, {
      ...input,
      judgment: 'Prefer concise answers with explicit decision evidence.',
      suggestedScope: 'product,review',
    });
    expect(edited.judgment).toContain('explicit decision evidence');
    expect(edited.suggestedScope).toBe('product,review');

    const deferred = await candidates.deferRecallCandidate('user-a', first.id, 'need more evidence');
    expect(deferred.status).toBe('deferred');
    expect(deferred.decisionNote).toBe('need more evidence');
    expect(deferred.cooldownUntil).toBeTruthy();

    const resumed = await candidates.resumeRecallCandidate('user-a', first.id);
    expect(resumed.status).toBe('pending_review');

    const rejected = await candidates.rejectRecallCandidate('user-a', first.id, 'not durable');
    expect(rejected.status).toBe('rejected');
    await expect(candidates.resumeRecallCandidate('user-a', first.id)).rejects.toThrow(/terminal/i);
  });

  it('imports a personal ontology candidate into the formal recall review flow without confirming it to memory', async () => {
    const candidates = await service();
    const { userLocalRoot } = await import('../../../../src/main/paths');
    const { serializeCandidatesMarkdown } = await import('../../../../src/main/features/personal_ontology_candidates');
    const folder = path.join(userLocalRoot('user-a'), 'ontology_candidates');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'candidates.md'), serializeCandidatesMarkdown([{ candidate_id: 'legacy-a', kind: 'preference', confidence: 'high', summary: 'Prefers evidence-first answers', memory_scope: 'user', memory_text: 'Prefers evidence-first answers', source_memory_refs: ['mem-a'] }]));
    const imported = await candidates.importPersonalOntologyCandidate('user-a', 'legacy-a');
    expect(imported.status).toBe('pending_review');
    expect(imported.suggestedType).toBe('personal');
    expect(imported.sourceRefs).toEqual([expect.objectContaining({
      kind: 'memory', subtype: 'teaching', id: 'mem-a', taxonomyVersion: 1,
      degraded: true, reason: 'legacy_memory_untraceable',
    })]);
  });

  it('does not persist source body text or absolute paths on a new candidate', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep source references metadata-only.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{
        kind: 'artifact_file',
        subtype: 'context_file',
        id: 'ctx-a',
        title: 'C:\\private\\context.md',
        excerpt: 'private context body',
      }],
    });

    expect(candidate.sourceRefs[0]).toMatchObject({ kind: 'artifact_file', subtype: 'context_file', id: 'ctx-a' });
    expect(candidate.sourceRefs[0]).not.toHaveProperty('title');
    expect(candidate.sourceRefs[0]).not.toHaveProperty('excerpt');
  });

  it('uses the capture key as the retry idempotency boundary', async () => {
    const candidates = await service();
    const first = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep the original extracted decision.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'message', id: 'msg-a' }],
      captureKey: 'capture-rcap-a-0',
    });
    const retried = await candidates.saveRecallCandidate('user-a', {
      judgment: 'A retry returned slightly different wording.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'message', id: 'msg-a' }],
      captureKey: 'capture-rcap-a-0',
    });

    expect(retried.id).toBe(first.id);
    expect(retried.judgment).toBe('Keep the original extracted decision.');
    expect(retried.status).toBe('pending_review');
  });

  it('promotes a pending candidate exactly once into a stable formal ability asset', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Use a decision log before changing architecture.',
      suggestedType: 'rule',
      suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-a' }],
    });

    const [first, second] = await Promise.all([
      candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' }),
      candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' }),
    ]);

    expect(first.candidate.status).toBe('confirmed');
    expect(first.candidate.promotedAssetId).toMatch(/^aa-[A-Za-z0-9_-]+$/);
    expect(second.candidate.promotedAssetId).toBe(first.candidate.promotedAssetId);
    expect(second.asset.id).toBe(first.asset.id);
    expect(first.asset.ownerId).toBe('user-a');
    expect(first.asset.type).toBe('rule');
    expect(first.asset.status).toBe('active');
    expect(first.asset.lifecycleStatus).toBe('user_confirmed_unverified');
    expect(first.asset.maturity).toBe('seed');
    expect(first.asset.version).toBe('1');
    expect(first.receipt).toEqual({
      assetId: first.asset.id,
      assetType: 'rule',
      version: '1',
      lifecycleStatus: 'user_confirmed_unverified',
      scope: 'architecture',
      sourceRefs: first.asset.evidenceRefs,
      reviewDecisionId: first.decision.decision_id,
    });

    const listed = await candidates.listRecallCandidates('user-a');
    expect(listed).toEqual([expect.objectContaining({ id: candidate.id, promotedAssetId: first.asset.id })]);
  });

  it('preserves legacy evidence identity when returning an already-promoted asset', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep legacy evidence readable.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'message', id: 'msg-a' }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('user-a', 'ability-assets', promoted.asset.id, (current) => ({
      ...current!,
      evidenceRefs: [{ kind: 'ontology', id: 'ontology-a' }],
    }));

    const repeated = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    expect(repeated.asset.evidenceRefs).toEqual([
      expect.objectContaining({
        kind: 'ontology', subtype: 'artifact', id: 'ontology-a', taxonomyVersion: 1,
        degraded: true, reason: 'legacy_ontology_asset_ref',
      }),
    ]);
  });

  it('reuses the deterministic asset when candidate confirmation is retried', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Recover the durable asset after an interrupted promotion.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'execution', id: 'exec-recovery' }],
    });
    const first = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    const recovered = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    expect(recovered.candidate).toMatchObject({ status: 'confirmed', promotedAssetId: first.asset.id });
    expect(recovered.asset.id).toBe(first.asset.id);
    const assets = await (await import('../../../../src/main/features/recall/asset-service')).listAbilityAssets('user-a');
    expect(assets.filter((asset) => asset.candidateId === candidate.id)).toHaveLength(1);
  });

  it('rejects promotion of a rejected candidate and isolates records by owner', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Use only project-local source evidence.',
      suggestedType: 'personal',
      suggestedScope: 'personal',
      sourceRefs: [{ kind: 'memory', id: 'mem-a' }],
    });
    await candidates.rejectRecallCandidate('user-a', candidate.id, 'duplicate');

    await expect(candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' })).rejects.toThrow(/terminal/i);
    await expect(candidates.readRecallCandidate('user-b', candidate.id)).rejects.toThrow(/not found/i);
  });

  it('clears a previous retryable promotion failure when the candidate is edited', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep a retryable confirmation candidate.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'message', id: 'msg-retry' }],
    });
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('user-a', 'candidates', candidate.id, (current) => ({
      ...current!,
      failureCode: 'asset_write_failed',
      failureMessage: 'disk unavailable',
      failedAt: '2026-08-11T00:00:00.000Z',
    }));

    const edited = await candidates.updateRecallCandidate('user-a', candidate.id, {
      judgment: 'Keep a retryable confirmation candidate with evidence.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'message', id: 'msg-retry' }],
    });

    expect(edited.failureCode).toBeUndefined();
    expect(edited.failureMessage).toBeUndefined();
    expect(edited.failedAt).toBeUndefined();
  });

  it('keeps incomplete extraction as a weak observation instead of a user task', async () => {
    const candidates = await service();
    const weak = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Possible reusable rule without enough provenance.',
      value: '',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [],
    });
    expect(weak).toMatchObject({ status: 'weak_observation', value: '' });
    await expect(candidates.promoteRecallCandidate('user-a', weak.id, { actor: 'user' }))
      .rejects.toThrow(/insufficient/i);
    expect((await (await import('../../../../src/main/features/recall/asset-service')).listAbilityAssets('user-a'))).toEqual([]);
  });

  it('keeps a non-create candidate without a target asset as a weak observation', async () => {
    const candidates = await service();
    const weak = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Narrow the existing review rule to this workspace.',
      value: 'Avoid applying a local exception globally.',
      suggestedType: 'rule',
      suggestedScope: 'workspace-a',
      suggestedAction: 'limit_scope',
      sourceRefs: [{ kind: 'execution_evaluation', id: 'run-missing-target' }],
    });

    expect(weak).toMatchObject({ status: 'weak_observation', suggestedAction: 'limit_scope' });
    expect(weak.targetAssetId).toBeUndefined();
    await expect(candidates.promoteRecallCandidate('user-a', weak.id, { actor: 'user' }))
      .rejects.toThrow(/insufficient/i);
  });

  it('keeps deferred candidates quiet until their cooldown expires', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep decisions traceable.',
      value: 'Reduce repeated architecture review work.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      suggestedAction: 'create',
      sourceRefs: [{ kind: 'conversation', id: 'conv-cooldown' }],
    });
    await candidates.deferRecallCandidate('user-a', candidate.id, 'review next week');
    expect(await candidates.readRecallCandidate('user-a', candidate.id)).toMatchObject({ status: 'deferred' });

    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('user-a', 'candidates', candidate.id, (current) => ({
      ...current!,
      cooldownUntil: '2020-01-01T00:00:00.000Z',
    }));

    expect(await candidates.readRecallCandidate('user-a', candidate.id)).toMatchObject({ status: 'pending_review' });
  });

  it('merges exact duplicate evidence without creating another candidate', async () => {
    const candidates = await service();
    const base = {
      judgment: 'Verify source freshness before using a fact.',
      value: 'Avoid stale decisions.',
      suggestedType: 'rule' as const,
      suggestedScope: 'project',
      suggestedAction: 'create' as const,
    };
    const first = await candidates.saveRecallCandidate('user-a', { ...base, sourceRefs: [{ kind: 'conversation', id: 'conv-a' }] });
    const second = await candidates.saveRecallCandidate('user-a', { ...base, sourceRefs: [{ kind: 'execution_evaluation', id: 'run-a' }] });
    expect(second.id).toBe(first.id);
    expect(second.evidenceRefs.map((ref) => `${ref.kind}:${ref.id}`).sort()).toEqual([
      'conversation:conv-a', 'execution_evaluation:run-a',
    ]);
  });

  it('keeps the highest risk when duplicate evidence is merged', async () => {
    const candidates = await service();
    const base = {
      judgment: 'Use the reusable workflow for release checks.',
      value: 'Reduce missed release checks.',
      suggestedType: 'skill_method' as const,
      suggestedScope: 'project',
      suggestedAction: 'create' as const,
    };
    const first = await candidates.saveRecallCandidate('user-a', {
      ...base,
      risk: 'low',
      sourceRefs: [{ kind: 'conversation', id: 'conv-risk-low' }],
    });
    const merged = await candidates.saveRecallCandidate('user-a', {
      ...base,
      risk: 'high',
      sourceRefs: [{ kind: 'execution_evaluation', id: 'run-risk-high' }],
    });

    expect(merged).toMatchObject({ id: first.id, risk: 'high' });
    await expect(candidates.promoteRecallCandidate('user-a', first.id, { actor: 'user' }))
      .rejects.toThrow(/risk gate/i);
  });

  it('creates a new gated candidate when risk increases after a terminal decision', async () => {
    const candidates = await service();
    const base = {
      judgment: 'Use the reusable workflow for deployment checks.',
      value: 'Reduce missed deployment checks.',
      suggestedType: 'skill_method' as const,
      suggestedScope: 'project',
      suggestedAction: 'create' as const,
      sourceRefs: [{ kind: 'conversation', id: 'conv-terminal-risk' }],
    };
    const first = await candidates.saveRecallCandidate('user-a', { ...base, risk: 'low' });
    await candidates.rejectRecallCandidate('user-a', first.id, 'not risky enough to retain');

    const risky = await candidates.saveRecallCandidate('user-a', { ...base, risk: 'high' });
    expect(risky).toMatchObject({ status: 'pending_review', risk: 'high' });
    expect(risky.id).not.toBe(first.id);
    await expect(candidates.promoteRecallCandidate('user-a', risky.id, { actor: 'user' }))
      .rejects.toThrow(/risk gate/i);
  });

  it('creates a fresh review candidate when rejected content receives new evidence', async () => {
    const candidates = await service();
    const base = {
      judgment: 'Check source freshness before using project facts.',
      value: 'Avoid stale project decisions.',
      suggestedType: 'rule' as const,
      suggestedScope: 'project',
      suggestedAction: 'create' as const,
    };
    const first = await candidates.saveRecallCandidate('user-a', {
      ...base,
      sourceRefs: [{ kind: 'conversation', id: 'conv-rejected-old' }],
    });
    await candidates.rejectRecallCandidate('user-a', first.id, 'not enough evidence');

    const unchanged = await candidates.saveRecallCandidate('user-a', {
      ...base,
      sourceRefs: [{ kind: 'conversation', id: 'conv-rejected-old' }],
    });
    expect(unchanged).toMatchObject({ id: first.id, status: 'rejected' });

    const reconsidered = await candidates.saveRecallCandidate('user-a', {
      ...base,
      sourceRefs: [{ kind: 'execution_evaluation', id: 'run-rejected-new' }],
    });
    expect(reconsidered.id).not.toBe(first.id);
    expect(reconsidered.status).toBe('pending_review');
  });

  it('reopens a deferred duplicate only when it receives new evidence', async () => {
    const candidates = await service();
    const base = {
      judgment: 'Keep confirmation evidence traceable.',
      value: 'Make future review decisions auditable.',
      suggestedType: 'rule' as const,
      suggestedScope: 'project',
      suggestedAction: 'create' as const,
    };
    const first = await candidates.saveRecallCandidate('user-a', {
      ...base,
      sourceRefs: [{ kind: 'conversation', id: 'conv-deferred-old' }],
    });
    await candidates.deferRecallCandidate('user-a', first.id, 'wait for evidence');

    const unchanged = await candidates.saveRecallCandidate('user-a', {
      ...base,
      sourceRefs: [{ kind: 'conversation', id: 'conv-deferred-old' }],
    });
    expect(unchanged).toMatchObject({ id: first.id, status: 'deferred' });

    const reopened = await candidates.saveRecallCandidate('user-a', {
      ...base,
      sourceRefs: [{ kind: 'execution_evaluation', id: 'run-deferred-new' }],
    });
    expect(reopened).toMatchObject({ id: first.id, status: 'pending_review' });
    expect(reopened.cooldownUntil).toBeUndefined();
  });

  it('does not let resume turn a weak observation into a reviewable candidate', async () => {
    const candidates = await service();
    const weak = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Possible reusable rule without evidence.',
      value: '',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [],
    });

    await expect(candidates.resumeRecallCandidate('user-a', weak.id)).rejects.toThrow(/deferred/i);
    await expect(candidates.deferRecallCandidate('user-a', weak.id, 'collect evidence')).rejects.toThrow(/insufficient/i);
    expect(await candidates.readRecallCandidate('user-a', weak.id)).toMatchObject({ status: 'weak_observation', value: '' });
  });

  it('moves a weak observation to review only after new evidence makes it complete', async () => {
    const candidates = await service();
    const base = {
      judgment: 'Use a source check before changing architecture.',
      value: 'Avoid unsupported architecture changes.',
      suggestedType: 'rule' as const,
      suggestedScope: 'architecture',
      suggestedAction: 'create' as const,
    };
    const weak = await candidates.saveRecallCandidate('user-a', { ...base, sourceRefs: [] });
    expect(weak.status).toBe('weak_observation');

    const completed = await candidates.saveRecallCandidate('user-a', {
      ...base,
      sourceRefs: [{ kind: 'execution_evaluation', id: 'run-weak-completed' }],
    });
    expect(completed).toMatchObject({ id: weak.id, status: 'pending_review' });
  });

  it('serializes rejection and confirmation so only one decision can win', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Require evidence before changing architecture.',
      value: 'Avoid unsupported architectural changes.',
      suggestedType: 'rule',
      suggestedScope: 'architecture',
      suggestedAction: 'create',
      sourceRefs: [{ kind: 'execution_evaluation', id: 'run-concurrent-review' }],
    });

    const outcomes = await Promise.allSettled([
      candidates.rejectRecallCandidate('user-a', candidate.id, 'not durable'),
      candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' }),
    ]);
    const finalCandidate = await candidates.readRecallCandidate('user-a', candidate.id);
    const review = await import('../../../../src/main/features/cognition/review-decision');
    const decisions = await review.listReviewDecisions('user-a', `recall_candidate:${candidate.id}`);

    expect(['rejected', 'confirmed']).toContain(finalCandidate.status);
    expect(decisions.map((decision) => decision.decision_type)).toEqual(
      finalCandidate.status === 'rejected' ? ['reject'] : ['accept'],
    );
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
  });

  it('records ignore without creating a formal asset', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Do not retain this project-only wording.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'conversation', id: 'conv-a' }],
    });
    expect(await candidates.ignoreRecallCandidate('user-a', candidate.id, 'not reusable'))
      .toMatchObject({ status: 'ignored' });
    expect((await (await import('../../../../src/main/features/recall/asset-service')).listAbilityAssets('user-a'))).toEqual([]);
  });

  it('blocks expired, revoked-source, and unacknowledged high-risk candidates', async () => {
    const candidates = await service();
    const controls = await import('../../../../src/main/features/recall/source-control');
    const expired = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Expired rule.', value: 'Old evidence.', suggestedType: 'rule', suggestedScope: 'project',
      suggestedAction: 'create', sourceRefs: [{ kind: 'conversation', id: 'conv-expired' }],
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    await expect(candidates.promoteRecallCandidate('user-a', expired.id, { actor: 'user' })).rejects.toThrow(/expired/i);
    expect(await candidates.readRecallCandidate('user-a', expired.id)).toMatchObject({ status: 'expired' });

    const revoked = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Source-controlled rule.', value: 'Keep provenance valid.', suggestedType: 'rule', suggestedScope: 'project',
      suggestedAction: 'create', sourceRefs: [{ kind: 'conversation', id: 'conv-revoked' }],
    });
    await controls.removeCognitionSource('user-a', { kind: 'conversation', id: 'conv-revoked' } as any, false);
    await expect(candidates.promoteRecallCandidate('user-a', revoked.id, { actor: 'user' })).rejects.toThrow(/source/i);
    expect(await candidates.readRecallCandidate('user-a', revoked.id)).toMatchObject({ status: 'failed', failureCode: 'source_unavailable' });

    const risky = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Run a high-impact reusable workflow.', value: 'Automate repeated work.', suggestedType: 'skill_method', suggestedScope: 'project',
      suggestedAction: 'create', risk: 'high', sourceRefs: [{ kind: 'execution_evaluation', id: 'run-risk' }],
    });
    await expect(candidates.promoteRecallCandidate('user-a', risky.id, { actor: 'user' })).rejects.toThrow(/risk gate/i);
    expect(await candidates.readRecallCandidate('user-a', risky.id)).toMatchObject({ status: 'pending_review' });
    await expect(candidates.promoteRecallCandidate('user-a', risky.id, { actor: 'user', riskAcknowledged: true }))
      .resolves.toMatchObject({ asset: { type: 'skill_method', maturity: 'seed', lifecycleStatus: 'user_confirmed_unverified' } });
  });

  it('updates a target asset once for repeated review confirmation', async () => {
    const candidates = await service();
    const original = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep review evidence.', suggestedType: 'rule', suggestedScope: 'project',
      sourceRefs: [{ kind: 'conversation', id: 'conv-original' }],
    });
    const { asset } = await candidates.promoteRecallCandidate('user-a', original.id, { actor: 'user' });
    const update = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep review evidence and record exceptions.', value: 'Reduce repeated review mistakes.',
      suggestedType: 'rule', suggestedScope: 'project', suggestedAction: 'update', targetAssetId: asset.id,
      sourceRefs: [{ kind: 'execution_evaluation', id: 'run-update' }],
    });
    const first = await candidates.promoteRecallCandidate('user-a', update.id, { actor: 'user' });
    const second = await candidates.promoteRecallCandidate('user-a', update.id, { actor: 'user' });
    expect(first.asset).toMatchObject({ id: asset.id, version: '2' });
    expect(second.asset.version).toBe('2');
    expect((await (await import('../../../../src/main/features/recall/asset-service')).listAbilityAssetVersions('user-a', asset.id)))
      .toHaveLength(2);
  });

  it('rejects L3 credentials from candidates', async () => {
    const candidates = await service();
    await expect(candidates.saveRecallCandidate('user-a', {
      judgment: 'Use api_key=sk-123456789012345678901234 for requests.',
      suggestedType: 'rule', suggestedScope: 'project', sourceRefs: [{ kind: 'conversation', id: 'conv-secret' }],
    })).rejects.toThrow(/forbidden to persist/i);
  });

  it('rejects GitLab access tokens and credentials hidden in learning signals', async () => {
    const candidates = await service();
    await expect(candidates.saveRecallCandidate('user-a', {
      judgment: 'Reuse glpat-0123456789abcdefTEST for GitLab requests.',
      suggestedType: 'rule', suggestedScope: 'project', sourceRefs: [{ kind: 'conversation', id: 'conv-gitlab-secret' }],
    })).rejects.toThrow(/forbidden to persist/i);

    await expect(candidates.saveRecallCandidate('user-a', {
      judgment: 'Compare the expected and actual integration result.',
      suggestedType: 'rule', suggestedScope: 'project', sourceRefs: [{ kind: 'conversation', id: 'conv-signal-secret' }],
      learningSignal: {
        expectedResult: 'Call with api_key=sk-123456789012345678901234',
        actualResult: 'Request completed.',
        deltaR: 'unknown',
        deltaA: 'unknown',
        outcome: 'met_expected',
        confidence: 0.8,
        source: 'review',
      },
    })).rejects.toThrow(/forbidden to persist/i);
  });

  it('replaces a failed ReviewDecision outcome when the same handoff succeeds on retry', async () => {
    const review = await import('../../../../src/main/features/cognition/review-decision');
    const targetRef = 'recall_candidate:cand-retry-outcome';
    const decision = await review.writeReviewDecision('user-a', {
      targetRef,
      decisionType: 'accept',
      decision: 'accept',
      antecedentRef: 'cand-retry-outcome',
      idempotencyKey: 'cand-retry-outcome:accept',
    });

    await expect(review.recordReviewDecisionOutcome('user-a', targetRef, decision.decision_id, {
      failureCode: 'asset_write_failed',
    })).resolves.toMatchObject({ outcome: 'asset_failed', failure_code: 'asset_write_failed' });

    const succeeded = await review.recordReviewDecisionOutcome('user-a', targetRef, decision.decision_id, {
      assetId: 'aa-retry-outcome',
    });
    expect(succeeded).toMatchObject({ outcome: 'asset_created', asset_id: 'aa-retry-outcome' });
    expect(succeeded.failure_code).toBeUndefined();
    await expect(review.listReviewDecisions('user-a', targetRef)).resolves.toEqual([succeeded]);
  });
});
