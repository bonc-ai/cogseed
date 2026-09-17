import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const RULE_BOUNDARY = { applicableWhen: ['performing governed work'], forbiddenWhen: ['outside the governed scope'] };
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-assets-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function modules() {
  const [candidates, assets] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
  ]);
  return { candidates, assets };
}

describe('Recall ability assets', () => {
  it('updates immutable-id assets with append-only snapshots and lifecycle audit events', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Keep decision records with evidence.', suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });

    const updated = await assets.updateAbilityAsset('user-a', asset.id, { statement: 'Keep architecture decision records with source evidence.', scope: 'architecture-review', reason: 'Keep the newest architecture review version.', actor: 'user' });
    expect(updated.id).toBe(asset.id);
    expect(updated.version).toBe('2');
    expect(updated.statement).toContain('architecture decision');

    const paused = await assets.pauseAbilityAsset('user-a', asset.id, { actor: 'user', reason: 'needs review' });
    expect(paused.status).toBe('paused');
    const revoked = await assets.revokeAbilityAsset('user-a', asset.id, { actor: 'user', reason: 'unsafe' });
    expect(revoked.status).toBe('revoked');

    const versions = await assets.listAbilityAssetVersions('user-a', asset.id);
    expect(versions.map((entry) => entry.version)).toEqual(['1', '2']);
    expect(versions[0].snapshot.statement).toBe(asset.statement);
    expect(versions[1].snapshot.scope).toBe('architecture-review');

    const audit = await assets.listAbilityAssetAudit('user-a', asset.id);
    expect(audit.map((entry) => entry.action)).toEqual(['created', 'updated', 'paused', 'revoked']);
  });

  it('keeps learning provenance in immutable version snapshots', async () => {
    const { candidates, assets } = await modules();
    const learningProvenance = {
      projectionId: 'proj-a', forecastId: 'wf-a', episodeId: 'kse-a',
      ruleRefs: ['rule:asset-a:1'], attribution: 'knowledge_gap' as const,
    };
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Load the exact committed knowledge before execution.',
      suggestedType: 'personal', suggestedScope: 'project',
      sourceRefs: [{ kind: 'execution', id: 'kse-a' }], learningProvenance,
    });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    await assets.updateAbilityAsset('user-a', asset.id, {
      statement: 'Load the exact committed knowledge version before execution.',
      actor: 'user', reason: 'clarify version boundary',
    });

    const versions = await assets.listAbilityAssetVersions('user-a', asset.id);
    expect(versions[0].snapshot.learningProvenance).toEqual(learningProvenance);
    expect(versions[1].snapshot.learningProvenance).toEqual(learningProvenance);
  });

  it('never changes asset ownership or accepts mutable identity fields', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Prefer local evidence.', suggestedType: 'personal', suggestedScope: 'personal', sourceRefs: [{ kind: 'memory', id: 'mem-a' }] });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });

    await expect(assets.updateAbilityAsset('user-a', asset.id, { id: 'aa-other' } as never)).rejects.toThrow(/identity/i);
    await expect(assets.readAbilityAsset('user-b', asset.id)).rejects.toThrow(/not found/i);
  });



  it('requires an actor for asset mutations and a review handoff for system mutations', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep decision records with evidence.',
      suggestedType: 'rule',
      ...RULE_BOUNDARY,
      suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-governance' }],
    });

    await expect(candidates.promoteRecallCandidate('user-a', candidate.id)).rejects.toThrow(/user actor/i);
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });

    await expect(assets.updateAbilityAsset('user-a', asset.id, {
      statement: 'Keep architecture decision records with source evidence.',
      reason: 'Refine the verified rule.',
    } as never)).rejects.toThrow(/user actor/i);
    await expect(assets.updateAbilityAsset('user-a', asset.id, {
      statement: 'Keep architecture decision records with source evidence.',
      actor: 'user',
    } as never)).rejects.toThrow(/reason/i);
    await expect(assets.pauseAbilityAsset('user-a', asset.id, { actor: 'system', reason: 'automated pause' } as never))
      .rejects.toThrow(/review handoff/i);
  });

  it('rejects L3 credentials from asset edits without creating a new version', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Use the approved service client for requests.',
      suggestedType: 'rule',
      ...RULE_BOUNDARY,
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'execution', id: 'exec-secret-edit' }],
    });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });

    await expect(assets.updateAbilityAsset('user-a', asset.id, {
      statement: 'Use api_key=sk-123456789012345678901234 for requests.',
      actor: 'user',
      reason: 'Attempt to persist a credential.',
    })).rejects.toThrow(/forbidden to persist/i);

    await expect(assets.readAbilityAsset('user-a', asset.id)).resolves.toMatchObject({ version: '1' });
    await expect(assets.listAbilityAssetVersions('user-a', asset.id)).resolves.toHaveLength(1);
  });

  it('rejects credentials in learning signals at the formal asset boundary', async () => {
    const { assets } = await modules();
    const now = new Date().toISOString();
    await expect(assets.createAbilityAsset('user-a', {
      schemaVersion: 2,
      ownerId: 'user-a',
      id: 'aa-direct-secret-signal',
      candidateId: 'cand-direct-secret-signal',
      sourceCandidateIds: ['cand-direct-secret-signal'],
      reviewDecisionId: 'rd_direct_secret_signal',
      type: 'rule',
      title: 'Direct asset boundary test',
      statement: 'Persist only safe learning signals.',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-direct-secret-signal' }],
      learningSignal: {
        expectedResult: 'Use api_key=sk-123456789012345678901234',
        actualResult: 'Request completed.',
        deltaR: 'unknown',
        deltaA: 'unknown',
        outcome: 'met_expected',
        confidence: 0.8,
        source: 'review',
      },
      scope: 'project',
      status: 'active',
      lifecycleStatus: 'user_confirmed_unverified',
      maturity: 'bud',
      version: '1',
      createdAt: now,
      updatedAt: now,
    }, { actor: 'user', reason: 'review_decision:rd_direct_secret_signal' }))
      .rejects.toThrow(/forbidden to persist/i);
    await expect(assets.listAbilityAssets('user-a')).resolves.toEqual([]);
  });

  it('stores structured scope policy alongside legacy scope text and version snapshots', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Use PRM notes for architecture reviews.',
      suggestedType: 'rule',
      ...RULE_BOUNDARY,
      suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-scope' }],
    });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, {
      actor: 'user',
      scopePolicy: {
        purposeTags: ['architecture', 'review'],
        workspaceIds: ['workspace-a'],
        conversationKinds: ['gconv'],
      },
    } as never);

    expect(asset.scope).toBe('architecture');
    expect(asset.scopePolicy).toEqual({
      purposeTags: ['architecture', 'review'],
      workspaceIds: ['workspace-a'],
      conversationKinds: ['gconv'],
    });

    const updated = await assets.updateAbilityAsset('user-a', asset.id, {
      scope: 'architecture-review',
      scopePolicy: { purposeTags: ['architecture-review'], fileKinds: ['md'] },
      reason: 'Narrow reuse to architecture review markdown workflows.',
      actor: 'user',
    } as never);
    expect(updated.version).toBe('2');
    expect(updated.scopePolicy).toEqual({ purposeTags: ['architecture-review'], fileKinds: ['md'] });

    const versions = await assets.listAbilityAssetVersions('user-a', asset.id);
    expect(versions[0].snapshot.scopePolicy).toEqual({
      purposeTags: ['architecture', 'review'],
      workspaceIds: ['workspace-a'],
      conversationKinds: ['gconv'],
    });
    expect(versions[1]).toMatchObject({ reason: 'Narrow reuse to architecture review markdown workflows.', actor: 'user' });
    expect(versions[1].snapshot.scopePolicy).toEqual({ purposeTags: ['architecture-review'], fileKinds: ['md'] });
  });

  it('records advisory rework without mutating behavior and requires an explicit user revision to clear it', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Use a decision log before changing architecture.',
      suggestedType: 'rule',
      ...RULE_BOUNDARY,
      suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-rework' }],
    });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });

    const recommended = await assets.recommendAbilityAssetAction('user-a', asset.id, {
      action: 'rework',
      reason: 'The reused rule produced a worse-than-expected result.',
      actor: 'system',
    } as never);
    expect(recommended).toMatchObject({
      status: 'active',
      version: '1',
      statement: asset.statement,
      recommendedAction: 'rework',
      recommendationReason: 'The reused rule produced a worse-than-expected result.',
    });

    const repeated = await assets.recommendAbilityAssetAction('user-a', asset.id, {
      action: 'rework',
      reason: 'The reused rule produced a worse-than-expected result.',
      actor: 'system',
    } as never);
    expect(repeated.updatedAt).toBe(recommended.updatedAt);

    const revised = await assets.updateAbilityAsset('user-a', asset.id, {
      statement: 'Use a decision log and validate assumptions before changing architecture.',
      reason: 'Rework after a negative transfer outcome.',
      actor: 'user',
      acknowledgeRecommendation: true,
    });
    expect(revised.version).toBe('2');
    expect(revised.recommendedAction).toBeUndefined();
    expect(revised.recommendationReason).toBeUndefined();

    const audit = await assets.listAbilityAssetAudit('user-a', asset.id);
    expect(audit.map((entry) => entry.action)).toEqual(['created', 'rework_recommended', 'updated', 'recommendation_cleared']);
  });

  it('keeps pause recommendations advisory until the user pauses the asset and blocks revoked asset changes', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Prefer reversible experiments.',
      suggestedType: 'rule',
      ...RULE_BOUNDARY,
      suggestedScope: 'experiments',
      sourceRefs: [{ kind: 'execution', id: 'exec-pause' }],
    });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    const recommended = await assets.recommendAbilityAssetAction('user-a', asset.id, {
      action: 'pause',
      reason: 'The latest transfer created a regression.',
      actor: 'system',
    } as never);
    expect(recommended.status).toBe('active');
    expect(recommended.recommendedAction).toBe('pause');

    const paused = await assets.pauseAbilityAsset('user-a', asset.id, { actor: 'user', reason: 'Pause after regression.' } as never);
    expect(paused.status).toBe('paused');
    expect(paused.recommendedAction).toBeUndefined();

    const revoked = await assets.revokeAbilityAsset('user-a', asset.id, { actor: 'user', reason: 'Unsafe across repeated runs.' } as never);
    await expect(assets.updateAbilityAsset('user-a', revoked.id, {
      statement: 'Attempt to mutate a revoked rule.',
      reason: 'No mutation after revoke.',
      actor: 'user',
    } as never)).rejects.toThrow(/revoked/i);
  });

  it('preserves legacy kinds while normalizing evidence metadata at asset boundaries', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep source compatibility explicit.',
      suggestedType: 'rule',
      ...RULE_BOUNDARY,
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'message', id: 'msg-a' }],
    });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('user-a', 'ability-assets', asset.id, (current) => ({
      ...current!,
      evidenceRefs: [
        { kind: 'message', id: 'msg-a' },
        { kind: 'context', id: 'context-a' },
        { kind: 'memory', id: 'memory-a' },
      ],
    }));

    const legacy = await assets.readAbilityAsset('user-a', asset.id);
    expect(legacy.evidenceRefs).toEqual([
      expect.objectContaining({ kind: 'message', subtype: 'message', id: 'msg-a', taxonomyVersion: 1 }),
      expect.objectContaining({ kind: 'context', subtype: 'context_file', id: 'context-a', taxonomyVersion: 1 }),
      expect.objectContaining({ kind: 'memory', subtype: 'teaching', id: 'memory-a', taxonomyVersion: 1, degraded: true, reason: 'legacy_memory_untraceable' }),
    ]);

    const updated = await assets.updateAbilityAsset('user-a', asset.id, {
      evidenceRefs: [{ kind: 'execution', id: 'exec-a' } as never],
      reason: 'Update the evidence set.',
      actor: 'user',
    });
    expect(updated.evidenceRefs).toEqual([
      expect.objectContaining({ kind: 'execution', subtype: 'execution', id: 'exec-a', taxonomyVersion: 1 }),
    ]);
  });

  it('preserves legacy evidence kinds in historical asset snapshots', async () => {
    const { assets } = await modules();
    const store = await import('../../../../src/main/features/recall/store');
    await store.appendRecallJsonlRecord('user-a', 'ability-asset-versions', 'aa-legacy', {
      schemaVersion: 1,
      ownerId: 'user-a',
      id: 'aa-legacy-v1',
      assetId: 'aa-legacy',
      version: '1',
      at: '2026-01-01T00:00:00.000Z',
      snapshot: {
        title: 'Legacy asset',
        statement: 'Legacy evidence remains readable.',
        type: 'rule',
        scope: 'project',
        evidenceRefs: [
          { kind: 'message', id: 'msg-legacy' },
          { kind: 'ontology', id: 'ontology-legacy' },
        ],
        status: 'active',
        maturity: 'seed',
        version: '1',
      },
    });

    const [version] = await assets.listAbilityAssetVersions('user-a', 'aa-legacy');
    expect(version.snapshot.evidenceRefs).toEqual([
      expect.objectContaining({ kind: 'message', subtype: 'message', id: 'msg-legacy', taxonomyVersion: 1 }),
      expect.objectContaining({ kind: 'ontology', subtype: 'artifact', id: 'ontology-legacy', taxonomyVersion: 1, degraded: true, reason: 'legacy_ontology_asset_ref' }),
    ]);
  });
});

describe('治理状态模型', () => {
  async function seedAsset(uid: string) {
    const { candidates } = await modules();
    const candidate = await candidates.saveRecallCandidate(uid, {
      judgment: 'Record governance decisions with their evidence.',
      suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov' }],
    });
    return (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
  }

  it('接受规范 22.1 的全部治理状态，并拒绝编造的状态', async () => {
    const { assets } = await modules();
    const { updateRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    const asset = await seedAsset('user-gov');

    for (const status of ['active', 'paused', 'archived', 'deleted', 'purged', 'revoked'] as const) {
      await updateRecallJsonRecord('user-gov', 'ability-assets', asset.id, (raw) => ({
        ...raw!, status, ...(status === 'deleted' ? { deletedAt: new Date().toISOString() } : {}),
      }));
      expect((await assets.readAbilityAsset('user-gov', asset.id)).status).toBe(status);
    }

    await updateRecallJsonRecord('user-gov', 'ability-assets', asset.id, (raw) => ({ ...raw!, status: 'shredded' }));
    await expect(assets.readAbilityAsset('user-gov', asset.id)).rejects.toThrow('malformed recall ability asset');
  });

  it('旧记录不带 deletedAt 也能照常读出', async () => {
    // 向后兼容：本次只是放宽白名单，存量记录里没有任何新状态和新字段。
    const { assets } = await modules();
    const asset = await seedAsset('user-legacy');
    const loaded = await assets.readAbilityAsset('user-legacy', asset.id);
    expect(loaded.status).toBe('active');
    expect(loaded.deletedAt).toBeUndefined();
  });

  it('Evidence 撤销将验证成熟度退回 bud，且 seed、bud 与无关 Evidence 幂等不变', async () => {
    const { assets } = await modules();
    for (const maturity of ['transfer_validated', 'effectiveness_validated'] as const) {
      const uid = `user-evidence-${maturity}`;
      const asset = await seedAsset(uid);
      await assets.setAbilityAssetMaturity(uid, asset.id, maturity);

      const result = await assets.downgradeAbilityAssetMaturityForRevokedEvidence(uid, asset.id, {
        kind: 'execution', id: 'exec-gov',
      });

      expect(result.downgraded).toBe(true);
      expect(result.asset.maturity).toBe('bud');
    }

    for (const maturity of ['seed', 'bud'] as const) {
      const uid = `user-evidence-unchanged-${maturity}`;
      const asset = await seedAsset(uid);
      if (maturity === 'seed') {
        const { updateRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
        await updateRecallJsonRecord(uid, 'ability-assets', asset.id, (raw) => ({ ...raw!, maturity }));
      } else {
        await assets.setAbilityAssetMaturity(uid, asset.id, maturity);
      }
      await expect(assets.downgradeAbilityAssetMaturityForRevokedEvidence(uid, asset.id, {
        kind: 'execution', id: 'exec-gov',
      })).resolves.toMatchObject({ downgraded: false, asset: { maturity } });
    }

    const seed = await seedAsset('user-evidence-unrelated');
    await assets.setAbilityAssetMaturity('user-evidence-unrelated', seed.id, 'transfer_validated');
    await expect(assets.downgradeAbilityAssetMaturityForRevokedEvidence('user-evidence-unrelated', seed.id, {
      kind: 'execution', id: 'exec-other',
    })).resolves.toMatchObject({ downgraded: false, asset: { maturity: 'transfer_validated' } });
  });

  it('普通成熟度接口只允许升档，降级必须走专用证据撤销流程', async () => {
    const { assets } = await modules();
    const asset = await seedAsset('user-maturity-monotonic');
    await assets.setAbilityAssetMaturity('user-maturity-monotonic', asset.id, 'transfer_validated');
    await expect(assets.setAbilityAssetMaturity('user-maturity-monotonic', asset.id, 'bud'))
      .rejects.toThrow(/cannot move backwards/i);
    await expect(assets.readAbilityAsset('user-maturity-monotonic', asset.id))
      .resolves.toMatchObject({ maturity: 'transfer_validated' });
    await expect(assets.listAbilityAssetAudit('user-maturity-monotonic', asset.id))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'maturity_advanced', note: 'bud->transfer_validated' }),
      ]));
  });

  it('普通成熟度接口在写盘前拒绝非法运行时值', async () => {
    const { assets } = await modules();
    const asset = await seedAsset('user-maturity-invalid');

    await expect(assets.setAbilityAssetMaturity(
      'user-maturity-invalid',
      asset.id,
      'stable' as never,
    )).rejects.toThrow(/invalid ability asset maturity/i);
    await expect(assets.readAbilityAsset('user-maturity-invalid', asset.id))
      .resolves.toMatchObject({ maturity: 'bud' });
    await expect(assets.listAbilityAssetAudit('user-maturity-invalid', asset.id))
      .resolves.not.toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'maturity_advanced' }),
      ]));
  });

  it('保留期按 deletedAt 现算，不依赖预存的到期时间', async () => {
    // 存事实不存政策：保留期天数改了也不需要迁移已有记录。
    const { assets } = await modules();
    const { ABILITY_ASSET_DELETION_RETENTION_DAYS, isWithinDeletionRetention } = assets;
    const day = 86_400_000;
    const now = new Date('2026-09-01T00:00:00.000Z');
    const justDeleted = new Date(now.getTime() - day).toISOString();
    const longGone = new Date(now.getTime() - (ABILITY_ASSET_DELETION_RETENTION_DAYS + 1) * day).toISOString();

    expect(isWithinDeletionRetention({ status: 'deleted', deletedAt: justDeleted }, now)).toBe(true);
    expect(isWithinDeletionRetention({ status: 'deleted', deletedAt: longGone }, now)).toBe(false);
    // 缺 deletedAt 的已删除记录不声称可恢复；非 deleted 状态压根不适用保留期。
    expect(isWithinDeletionRetention({ status: 'deleted' }, now)).toBe(false);
    expect(isWithinDeletionRetention({ status: 'deleted', deletedAt: 'not-a-date' }, now)).toBe(false);
    expect(isWithinDeletionRetention({ status: 'archived', deletedAt: justDeleted }, now)).toBe(false);
  });

  it('非 active 状态一律挡在投影之外', async () => {
    // 下游用 `status !== 'active'` 拒绝式判断，新增状态必须天然被排除，
    // 否则一条已删除的资产会被带进任务。
    const { assets } = await modules();
    const { updateRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    const workspaceRefs = await import('../../../../src/main/features/recall/workspace-refs');
    const asset = await seedAsset('user-gate');

    for (const status of ['paused', 'archived', 'deleted', 'purged', 'revoked'] as const) {
      await updateRecallJsonRecord('user-gate', 'ability-assets', asset.id, (raw) => ({ ...raw!, status }));
      await expect(workspaceRefs.addWorkspaceAssetReference('user-gate', {
        assetId: asset.id, workspaceId: 'ws-1', scope: 'project',
      })).rejects.toThrow('ability asset is not active');
    }
  });
});

describe('治理动作', () => {
  const userAction = (reason: string) => ({ actor: 'user' as const, reason });

  async function seed(uid: string) {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate(uid, {
      judgment: 'Prefer append-only audit trails.',
      suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-act' }],
    });
    const asset = (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
    return { assets, asset };
  }

  it('归档与删除各自留下自己的审计动作，而不是都记成撤销', async () => {
    const { assets, asset } = await seed('user-act');
    await assets.archiveAbilityAsset('user-act', asset.id, userAction('暂时不用'));
    expect((await assets.readAbilityAsset('user-act', asset.id)).status).toBe('archived');

    const deleted = await assets.deleteAbilityAsset('user-act', asset.id, userAction('进入删除保留期'));
    expect(deleted.status).toBe('deleted');
    expect(deleted.deletedAt).toBeTruthy();

    const actions = (await assets.listAbilityAssetAudit('user-act', asset.id)).map((row) => row.action);
    expect(actions).toContain('archived');
    expect(actions).toContain('deleted');
    expect(actions).not.toContain('revoked');
  });

  it('重复删除不刷新保留期计时', async () => {
    // 否则用户点两次删除就把保留期悄悄延长了。
    const { assets, asset } = await seed('user-redelete');
    const first = await assets.deleteAbilityAsset('user-redelete', asset.id, userAction('delete'));
    const again = await assets.deleteAbilityAsset('user-redelete', asset.id, userAction('delete again'));
    expect(again.deletedAt).toBe(first.deletedAt);
  });

  it('恢复能把归档和保留期内的删除放回 active', async () => {
    const { assets, asset } = await seed('user-restore');
    await assets.archiveAbilityAsset('user-restore', asset.id, userAction('archive'));
    expect((await assets.restoreAbilityAsset('user-restore', asset.id, userAction('restore archive'))).status).toBe('active');

    await assets.deleteAbilityAsset('user-restore', asset.id, userAction('delete'));
    const restored = await assets.restoreAbilityAsset('user-restore', asset.id, userAction('restore deleted asset'));
    expect(restored.status).toBe('active');
    expect(restored.deletedAt).toBeUndefined();
  });

  it('保留期已过就不再给恢复', async () => {
    // 过期后系统对外声称的就是「已经没了」，再让它复活等于那个承诺不作数。
    const { assets, asset } = await seed('user-expired');
    const { updateRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    const stale = new Date(Date.now() - (assets.ABILITY_ASSET_DELETION_RETENTION_DAYS + 1) * 86_400_000);
    await assets.deleteAbilityAsset('user-expired', asset.id, userAction('delete'));
    await updateRecallJsonRecord('user-expired', 'ability-assets', asset.id, (raw) => ({
      ...raw!, deletedAt: stale.toISOString(),
    }));
    await expect(assets.restoreAbilityAsset('user-expired', asset.id, userAction('restore')))
      .rejects.toThrow('retention window has expired');
  });

  it('彻底清除留下墓碑：内容与版本清空，id 与时间线保留', async () => {
    // Receipt 里写着 asset:<id>@v<version>，记录整个消失会让历史回执指向虚空。
    const { assets, asset } = await seed('user-purge');
    await assets.updateAbilityAsset('user-purge', asset.id, {
      title: 'Second version', reason: 'Create a second version.', actor: 'user',
    });
    expect((await assets.listAbilityAssetVersions('user-purge', asset.id)).length).toBeGreaterThan(1);

    const tombstone = await assets.purgeAbilityAsset('user-purge', asset.id, userAction('用户要求彻底清除'));
    expect(tombstone.status).toBe('purged');
    expect(tombstone.id).toBe(asset.id);
    expect(tombstone.candidateId).toBe(asset.candidateId);
    expect(tombstone.purgedAt).toBeTruthy();
    expect(tombstone.title).toBe('');
    expect(tombstone.statement).toBe('');
    expect(tombstone.evidenceRefs).toEqual([]);

    // 版本快照同样含正文，留着就不算「删除内容和版本」。
    expect(await assets.listAbilityAssetVersions('user-purge', asset.id)).toEqual([]);
    // 审计流保留：只有动作名和时间戳，属于允许保留的不可识别最小项。
    expect((await assets.listAbilityAssetAudit('user-purge', asset.id)).map((r) => r.action)).toContain('purged');
    // 墓碑仍然读得出来，不会被当成损坏记录。
    expect((await assets.readAbilityAsset('user-purge', asset.id)).status).toBe('purged');
  });

  it('彻底清除是终态，任何后续治理动作都被拒绝', async () => {
    const { assets, asset } = await seed('user-terminal');
    await assets.purgeAbilityAsset('user-terminal', asset.id, userAction('purge'));
    for (const call of [
      () => assets.restoreAbilityAsset('user-terminal', asset.id, userAction('restore')),
      () => assets.archiveAbilityAsset('user-terminal', asset.id, userAction('archive')),
      () => assets.pauseAbilityAsset('user-terminal', asset.id, userAction('pause')),
      () => assets.deleteAbilityAsset('user-terminal', asset.id, userAction('delete')),
      () => assets.rollbackAbilityAsset('user-terminal', asset.id, '1', userAction('rollback')),
    ]) {
      await expect(call()).rejects.toThrow('ability asset has been purged');
    }
  });

  it('回滚生成新版本而不改写历史，且不动治理状态与成熟度', async () => {
    // 规范 10.4：回滚只影响后续默认引用；已引用旧版本的 TaskRun 仍指向当时的版本。
    const { assets, asset } = await seed('user-rollback');
    await assets.updateAbilityAsset('user-rollback', asset.id, {
      title: 'Renamed in v2', reason: 'Rename for v2.', actor: 'user',
    });
    await assets.setAbilityAssetMaturity('user-rollback', asset.id, 'transfer_validated');
    await assets.pauseAbilityAsset('user-rollback', asset.id, userAction('pause'));

    const rolled = await assets.rollbackAbilityAsset('user-rollback', asset.id, '1', userAction('rollback to v1'));
    expect(rolled.title).toBe(asset.title);
    expect(rolled.version).toBe('3');            // 新版本，不是退回 v1
    expect(rolled.status).toBe('paused');         // 治理状态不因回滚复活
    expect(rolled.maturity).toBe('transfer_validated');

    const versions = await assets.listAbilityAssetVersions('user-rollback', asset.id);
    expect(versions.map((v) => v.version)).toEqual(['1', '2', '3']);
    expect(versions.find((v) => v.version === '2')?.snapshot.title).toBe('Renamed in v2');
    expect((await assets.listAbilityAssetAudit('user-rollback', asset.id)).map((r) => r.action)).toContain('rolled_back');
  });

  it('回滚到不存在的版本或原地版本都被拒绝', async () => {
    const { assets, asset } = await seed('user-rollback-bad');
    await expect(assets.rollbackAbilityAsset('user-rollback-bad', asset.id, '99', userAction('rollback')))
      .rejects.toThrow('version not found');
    await expect(assets.rollbackAbilityAsset('user-rollback-bad', asset.id, asset.version, userAction('rollback')))
      .rejects.toThrow('already at that version');
  });

  it('选用历史版本（在用指针，2026-09-16 版本组）：内容同步、版本号不动、不产生新快照', async () => {
    // 版本组语义：select = 切「在用」指针——资产内容回到所选版本快照，但
    // version 计数不变、不追加版本记录（区别于 rollback 生成新版本）。
    // 历史任务引用的版本不受影响（注入回放按投影冻结版本号）。
    const { assets, asset } = await seed('user-select');
    await assets.updateAbilityAsset('user-select', asset.id, {
      title: 'Renamed in v2', reason: 'Rename for v2.', actor: 'user',
    });
    await assets.pauseAbilityAsset('user-select', asset.id, userAction('pause'));

    const selected = await assets.selectAbilityAssetVersion('user-select', asset.id, '1', userAction('use v1'));
    expect(selected.title).toBe(asset.title);          // 内容回到 v1
    expect(selected.version).toBe('2');                 // 版本号不动
    expect(selected.activeVersion).toBe('1');           // 在用指针
    expect(selected.status).toBe('paused');             // 治理状态不受影响

    // 不追加版本记录；审计记录选用动作。
    const versions = await assets.listAbilityAssetVersions('user-select', asset.id);
    expect(versions.map((v) => v.version)).toEqual(['1', '2']);
    expect((await assets.listAbilityAssetAudit('user-select', asset.id)).map((r) => r.action)).toContain('version_selected');

    // 选用后内容更新：bump 到 v3，指针跟随最新（不锁定旧版）。
    const updated = await assets.updateAbilityAsset('user-select', asset.id, {
      title: 'Edited on v1 base', reason: 'edit', actor: 'user',
    });
    expect(updated.version).toBe('3');
    expect(updated.activeVersion).toBe('3');
    expect(updated.title).toBe('Edited on v1 base');
  });

  it('选用不存在/当前在用版本被拒绝；purge 后拒绝', async () => {
    const { assets, asset } = await seed('user-select-bad');
    await expect(assets.selectAbilityAssetVersion('user-select-bad', asset.id, '99', userAction('x')))
      .rejects.toThrow('version not found');
    // 默认在用=最新内容版；选当前在用版是幂等空操作 → 拒绝（与 rollback 原地语义一致）。
    await expect(assets.selectAbilityAssetVersion('user-select-bad', asset.id, asset.version, userAction('x')))
      .rejects.toThrow('already selected');
    await assets.purgeAbilityAsset('user-select-bad', asset.id, userAction('purge'));
    await expect(assets.selectAbilityAssetVersion('user-select-bad', asset.id, '1', userAction('x')))
      .rejects.toThrow('ability asset has been purged');
  });

  it('选用旧版不把 legacy scope 倒退回主记录（2026-09-17 修）：迁移不再重复 bump', async () => {    const uid = 'user-select-scope';
    const { candidates, assets } = await modules();
    // v1 快照带词表化之前的自由文本 scope（实机 aa-34b688 场景：scope='personal'）。
    const candidate = await candidates.saveRecallCandidate(uid, {
      judgment: 'Prefer concise direct answers.',
      suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'personal',
      sourceRefs: [{ kind: 'execution', id: 'exec-scope' }],
    });
    const asset = (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
    await assets.updateAbilityAsset(uid, asset.id, { statement: 'Prefer concise direct answers with reasons.', reason: 'v2', actor: 'user' });
    // 选用 v1（快照 scope='personal'）：主记录 scope 必须保持词表值，不能被
    // 旧快照写回——否则下次启动 legacy scope 迁移又垫一个内容不变的新版本。
    const selected = await assets.selectAbilityAssetVersion(uid, asset.id, '1', userAction('back to v1'));
    expect(selected.scope).not.toBe('personal');
    expect(selected.statement).toBe(asset.statement);
    expect((await assets.listAbilityAssetVersions(uid, asset.id)).map((v) => v.version)).toEqual(['1', '2']);
    // 迁移扫描零命中（修复前这里会命中 'personal' 再迁一遍）。
    expect(await assets.migrateLegacyFreeTextScopes(uid)).toBe(0);
  });

  it('已删除资产不可被 update（2026-09-17 守卫对齐）：与 select/rollback/merge 同口径', async () => {
    const uid = 'user-upd-guard';
    const { assets, asset } = await seed(uid);
    await assets.deleteAbilityAsset(uid, asset.id, userAction('进入删除保留期'));
    await expect(assets.updateAbilityAsset(uid, asset.id, { statement: 'edit after delete.', reason: 'edit', actor: 'user' }))
      .rejects.toThrow('deleted ability asset cannot be changed');
  });

  it('归并两条同义资产为版本组（2026-09-16）：版本链续接、较新内容为在用、来源归档', async () => {
    const { candidates, assets } = await modules();
    // 两条"同一认知"的资产：target 旧、source 新（各自有一版历史）。
    const tCand = await candidates.saveRecallCandidate('user-merge', {
      judgment: '用户身份：本程序开发人员。', summary: '用户身份A', suggestedType: 'personal',
      suggestedScope: 'general', sourceRefs: [{ kind: 'conversation', id: 'conv-m1' }],
    });
    const tAsset = await candidates.promoteRecallCandidate('user-merge', tCand.id, { actor: 'user', forceCreateSimilar: true });
    await assets.updateAbilityAsset('user-merge', tAsset.asset.id, { statement: '用户身份：本程序开发人员（开发者）。', reason: 'refine', actor: 'user' });
    const sCand = await candidates.saveRecallCandidate('user-merge', {
      judgment: '用户身份：CogSeed 开发者，参与认知资产开发。', summary: '用户身份B', suggestedType: 'personal',
      suggestedScope: 'general', sourceRefs: [{ kind: 'conversation', id: 'conv-m2' }],
    });
    const sAsset = await candidates.promoteRecallCandidate('user-merge', sCand.id, { actor: 'user', forceCreateSimilar: true });

    const merged = await assets.mergeAbilityAssets('user-merge', sAsset.asset.id, tAsset.asset.id, userAction('merge dup'));
    // 版本链：target 原 2 版 + source 的 1 版续接 = 3 版；较新（source）内容为在用。
    const versions = await assets.listAbilityAssetVersions('user-merge', tAsset.asset.id);
    expect(versions.map((v) => v.version)).toEqual(['1', '2', '3']);
    expect(merged.version).toBe('3');
    expect(merged.activeVersion).toBe('3');
    expect(merged.statement).toContain('CogSeed 开发者');
    // 来源条目归档 + 记录去向，不再出现在活跃列表。
    const source = await assets.readAbilityAsset('user-merge', sAsset.asset.id);
    expect(source.status).toBe('archived');
    expect((source as { mergedIntoAssetId?: string }).mergedIntoAssetId).toBe(tAsset.asset.id);
    // 审计双向留痕。
    const actions = (await assets.listAbilityAssetAudit('user-merge', tAsset.asset.id)).map((r) => r.action);
    expect(actions).toContain('merged_from');
  });

  it('版本链带按版本的使用效果聚合（2026-09-16 M8）：applied/contradicted 计数', async () => {
    const { candidates, assets } = await modules();
    const receipts = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const cCand = await candidates.saveRecallCandidate('user-usage-agg', {
      judgment: 'Usage aggregation rule.', summary: 'Usage rule', suggestedType: 'rule',
      suggestedScope: 'general', sourceRefs: [{ kind: 'conversation', id: 'conv-ua' }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-usage-agg', cCand.id, { actor: 'user', forceCreateSimilar: true });
    const assetId = promoted.asset.id;
    await assets.updateAbilityAsset('user-usage-agg', assetId, { statement: 'Usage aggregation rule v2.', reason: 'bump', actor: 'user' });
    // v1 被"实际采用"2 次、被否定 1 次；v2 采用 1 次（外键需要注入回执）。
    const injection = await import('../../../../src/main/features/recall/injection-receipt');
    const mk = async (run: string, version: string, status: string) => {
      const inj = await injection.recordInjectionReceipt('user-usage-agg', {
        taskRunId: run, projectionId: 'proj-ua', assetId, assetVersion: version, boundary: 'real', status: 'injected', channel: 'projection',
      } as never);
      await receipts.recordAssetUsageReceipt('user-usage-agg', {
        taskRunId: run, projectionId: 'proj-ua', assetId, assetVersion: version,
        injectionReceiptId: inj.id, status, evidenceRefs: [{ kind: 'conversation', id: 'conv-ua' }], evidenceKind: 'final_output', boundary: 'real',
      } as never);
    };
    await mk('turn-ua-1', '1', 'applied');
    await mk('turn-ua-2', '1', 'applied');
    await mk('turn-ua-3', '1', 'contradicted');
    await mk('turn-ua-4', '2', 'applied');

    const summary = await assets.listAbilityAssetVersionsWithUsage('user-usage-agg', assetId);
    const byVersion = Object.fromEntries((summary.usage || []).map((u) => [u.version, u]));
    expect(byVersion['1']).toMatchObject({ applied: 2, contradicted: 1 });
    expect(byVersion['2']).toMatchObject({ applied: 1 });
  });

  it('归并的检修回归（2026-09-16 审查）：版本号一致性/旧版在用/幂等/revoked 守卫', async () => {
    const { assets } = await modules();
    const U = 'user-mrg-x';
    let seq = 0;
    const mk = async (judgment: string, summary: string) => {
      const assets2 = await import('../../../../src/main/features/recall/asset-service');
      void assets2;
      const now = new Date().toISOString();
      seq += 1;
      const assetId = `aa-mrgprobe-${String(seq).padStart(2, '0')}xxxxxxxxxxxxxxxx`;
      const created = await assets.createAbilityAsset(U, {
        schemaVersion: 2, ownerId: U, id: assetId, candidateId: `cand-mrg-${seq}`,
        sourceCandidateIds: [`cand-mrg-${seq}`], reviewDecisionId: `rd_mrgprobe_${String(seq).padStart(4, '0')}`,
        type: 'rule', title: summary, statement: judgment,
        evidenceRefs: [{ kind: 'conversation', id: `conv-mrg-${seq}` }], scope: 'general', status: 'active',
        lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
        createdAt: now, updatedAt: now,
      }, { actor: 'user', reason: 'merge regression seed' });
      return { asset: created };
    };
    // P0-2（source 较新且曾 select 旧版）：merge 后在用内容必须与 activeVersion
    // 指向的快照一致（额外 append 一条在用内容快照，不指向 source 末版）。
    const src = await mk('较新的身份陈述，含新信息。', '身份A');
    await assets.updateAbilityAsset(U, src.asset.id, { statement: '第二版内容。', reason: 'bump', actor: 'user' });
    await assets.selectAbilityAssetVersion(U, src.asset.id, '1', userAction('use old'));
    const tgtOld = await mk('目标条目的旧内容。', '身份B');
    await assets.updateAbilityAsset(U, tgtOld.asset.id, { statement: '更旧的目标。', reason: 'aged', actor: 'user' });
    // 再动一次 source，让它的 updatedAt 晚于 target（sourceNewer=true）。
    await assets.updateAbilityAsset(U, src.asset.id, { statement: '第一版内容的修订。', reason: 'refresh', actor: 'user' });
    const merged = await assets.mergeAbilityAssets(U, src.asset.id, tgtOld.asset.id, userAction('merge'));
    const { readAbilityAssetVersionSnapshot } = await import('../../../../src/main/features/recall/asset-service');
    const activeSnapshot = await readAbilityAssetVersionSnapshot(U, tgtOld.asset.id, String(merged.activeVersion));
    expect(activeSnapshot?.statement).toBe(merged.statement);
    expect(merged.statement).toBe('第一版内容的修订。');
    // P0-1：merge 后再更新——版本号不与并入的快照撞号（链内版本唯一）。
    const updated = await assets.updateAbilityAsset(U, tgtOld.asset.id, { statement: '归并后的新修订。', reason: 'post-merge edit', actor: 'user' });
    const versions = await assets.listAbilityAssetVersions(U, tgtOld.asset.id);
    expect(new Set(versions.map((v) => v.version)).size).toBe(versions.length);
    expect(updated.activeVersion).toBe(updated.version);
    // P0-1（source 较旧方向）：计数器推进且在用内容/指针不漂移。
    const srcOld = await mk('更旧的一条内容。', '身份E');
    const tgtNew = await mk('新目标，晚于 source 创建。', '身份F');
    const mergedOld = await assets.mergeAbilityAssets(U, srcOld.asset.id, tgtNew.asset.id, userAction('merge old'));
    expect(mergedOld.statement).toBe('新目标，晚于 source 创建。');
    // 在用钉在 target 原版（v1），计数器推进到并入后的 2——内容与指针不分叉。
    expect(mergedOld.activeVersion).toBe('1');
    expect(Number(mergedOld.version)).toBeGreaterThan(1);
    const oldActiveSnapshot = await readAbilityAssetVersionSnapshot(U, tgtNew.asset.id, String(mergedOld.activeVersion));
    expect(oldActiveSnapshot?.statement).toBe(mergedOld.statement);
    // P1-1：二次 merge 同一 source 被拒（幂等守卫）。
    await expect(assets.mergeAbilityAssets(U, src.asset.id, tgtOld.asset.id, userAction('again')))
      .rejects.toThrow('already been merged');
    // P1-1/P2-2：revoked 资产不可 merge/select/rollback。
    const rev = await mk('将被撤回的条目。', '身份C');
    await assets.revokeAbilityAsset(U, rev.asset.id, userAction('revoke'));
    const other = await mk('另一条。', '身份D');
    await expect(assets.mergeAbilityAssets(U, other.asset.id, rev.asset.id, userAction('x')))
      .rejects.toThrow('revoked ability asset cannot be changed');
    await expect(assets.selectAbilityAssetVersion(U, rev.asset.id, '1', userAction('x')))
      .rejects.toThrow('revoked ability asset cannot be changed');
    await expect(assets.rollbackAbilityAsset(U, rev.asset.id, '1', userAction('x')))
      .rejects.toThrow('revoked ability asset cannot be changed');
  });

  it('归并去重空版本（2026-09-16 修）：源资产的迁移垫版不占新号', async () => {
    const { assets } = await modules();
    const U = 'user-mrg-dedup';
    const now = new Date().toISOString();
    const mk = async (seq: number, statement: string) => assets.createAbilityAsset(U, {
      schemaVersion: 2, ownerId: U, id: `aa-dedup-${String(seq).padStart(2, '0')}xxxxxxxxxxxxxxxx`,
      candidateId: `cand-dedup-${seq}`, sourceCandidateIds: [`cand-dedup-${seq}`],
      reviewDecisionId: `rd_dedup_${String(seq).padStart(4, '0')}`,
      type: 'rule', title: `dedup-${seq}`, statement,
      evidenceRefs: [{ kind: 'conversation', id: `conv-dedup-${seq}` }], scope: 'general', status: 'active',
      lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
      createdAt: now, updatedAt: now,
    }, { actor: 'user', reason: 'dedup seed' });
    const src = await mk(1, '第一段真实内容。');
    // 模拟迁移垫版：内容一字不变，scope 迁移 bump（真实数据 09-13 的形态）。
    await assets.updateAbilityAsset(U, src.id, { scope: 'general', reason: 'legacy free-text scope migration', actor: 'user' });
    const srcStmts = (await assets.listAbilityAssetVersions(U, src.id)).map((v) => v.snapshot.statement);
    expect(new Set(srcStmts).size).toBe(1);
    const tgt = await mk(2, '另一段内容。');
    await assets.updateAbilityAsset(U, src.id, { statement: '第一段真实内容。（更新让它较新）', reason: 'newer', actor: 'user' });
    const merged = await assets.mergeAbilityAssets(U, src.id, tgt.id, userAction('dedup merge'));
    // 源的 v1/v2 同内容 → 只并入一版；随后在用内容（v3=更新版）只占一号。
    const versions = await assets.listAbilityAssetVersions(U, tgt.id);
    const stmts = versions.map((v) => v.snapshot.statement);
    expect(new Set(stmts).size).toBe(stmts.length);
    expect(merged.version).toBe('3');
    expect(merged.activeVersion).toBe('3');
  });

  it('归并的守卫：跨类型/同条目/不存在被拒', async () => {
    const { candidates, assets } = await modules();
    const aCand = await candidates.saveRecallCandidate('user-merge-bad', {
      judgment: 'Rule one for merging.', summary: 'Rule', suggestedType: 'rule',
      suggestedScope: 'general', sourceRefs: [{ kind: 'conversation', id: 'conv-mb1' }],
    });
    const a = await candidates.promoteRecallCandidate('user-merge-bad', aCand.id, { actor: 'user', forceCreateSimilar: true });
    const pCand = await candidates.saveRecallCandidate('user-merge-bad', {
      judgment: 'Personal one for merging.', summary: 'Personal', suggestedType: 'personal',
      suggestedScope: 'general', sourceRefs: [{ kind: 'conversation', id: 'conv-mb2' }],
    });
    const p = await candidates.promoteRecallCandidate('user-merge-bad', pCand.id, { actor: 'user', forceCreateSimilar: true });
    await expect(assets.mergeAbilityAssets('user-merge-bad', p.asset.id, a.asset.id, userAction('x')))
      .rejects.toThrow('same type');
    await expect(assets.mergeAbilityAssets('user-merge-bad', a.asset.id, a.asset.id, userAction('x')))
      .rejects.toThrow('into itself');
    await expect(assets.mergeAbilityAssets('user-merge-bad', a.asset.id, 'aa-nonexistent', userAction('x')))
      .rejects.toThrow('not found');
  });
});

describe('版本真删（2026-09-17）：物理删除 + 引用快照冻结', () => {
  const userAction = (reason: string) => ({ actor: 'user' as const, reason });

  /** 三版资产（v1/v2/v3，在用=最新）；projectOnVersion 给定时再写一个引用该
   * 版本的 confirmed 投影（模拟"已确认注入契约冻结了该版本"）。 */
  async function seedVersioned(uid: string, projectOnVersion?: string) {
    const [candidates, assets, store, projections, paths] = await Promise.all([
      import('../../../../src/main/features/recall/candidate-service'),
      import('../../../../src/main/features/recall/asset-service'),
      import('../../../../src/main/features/recall/store'),
      import('../../../../src/main/features/recall/context-projection'),
      import('../../../../src/main/features/recall/paths'),
    ]);
    const candidate = await candidates.saveRecallCandidate(uid, {
      judgment: 'Prefer append-only audit trails.',
      suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-vdel' }],
    });
    const asset = (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
    await assets.updateAbilityAsset(uid, asset.id, { statement: 'v2 statement for deletion tests.', reason: 'v2', actor: 'user' });
    await assets.updateAbilityAsset(uid, asset.id, { statement: 'v3 statement for deletion tests.', reason: 'v3', actor: 'user' });
    if (projectOnVersion) {
      await store.writeRecallJsonRecord(uid, 'projections', 'proj-del-1', {
        schemaVersion: 2, ownerId: uid, id: 'proj-del-1', taskRunId: 'kst-del-1',
        purpose: 'review', authorization: 'workspace_policy',
        assetIds: [asset.id], assetVersions: { [asset.id]: projectOnVersion },
        sourceRefs: [], omittedRefs: [], status: 'confirmed', createdAt: new Date().toISOString(),
      });
    }
    return { assets, store, projections, paths, asset };
  }

  it('物理删除历史版本：列表/按号读快照都拿不到、磁盘行数减少、审计留痕、在用内容不受影响', async () => {
    const uid = 'user-vdel';
    const { assets, paths, asset } = await seedVersioned(uid);
    await assets.deleteAbilityAssetVersion(uid, asset.id, '1', userAction('clean migration noise'));
    // 列表与按号读取都拿不到了（真删，非隐藏）。
    expect((await assets.listAbilityAssetVersions(uid, asset.id)).map((v) => v.version)).toEqual(['2', '3']);
    expect(await assets.readAbilityAssetVersionSnapshot(uid, asset.id, '1')).toBeNull();
    // 磁盘上的版本流确实少了那一行。
    const streamText = fs.readFileSync(paths.recallJsonlPath(uid, 'ability-asset-versions', asset.id), 'utf8');
    expect(streamText.trim().split('\n')).toHaveLength(2);
    // 审计只记动作（version_deleted），资产本体与在用内容不动。
    expect((await assets.listAbilityAssetAudit(uid, asset.id)).map((r) => r.action)).toContain('version_deleted');
    const after = await assets.readAbilityAsset(uid, asset.id);
    expect(after.version).toBe('3');
    expect(after.statement).toContain('v3 statement');
    // 版本号不回退：后续更新继续 v4。
    const updated = await assets.updateAbilityAsset(uid, asset.id, { statement: 'v4 statement after deletion.', reason: 'v4', actor: 'user' });
    expect(updated.version).toBe('4');
  });

  it('删除被已确认投影引用的版本：删除前把快照冻结进投影，注入引用继续可用', async () => {
    const uid = 'user-vdel-proj';
    const { assets, store, projections, asset } = await seedVersioned(uid, '2');
    await assets.deleteAbilityAssetVersion(uid, asset.id, '2', userAction('delete referenced version'));
    expect((await assets.listAbilityAssetVersions(uid, asset.id)).map((v) => v.version)).toEqual(['1', '3']);
    // 投影带上冻结的内容副本：版本已删，注入按副本继续供给原内容。
    const raw = await store.readRecallJsonRecord(uid, 'projections', 'proj-del-1');
    const cached = (raw as { assetVersionSnapshots?: Record<string, { version: string; snapshot: { statement?: string } }> }).assetVersionSnapshots?.[asset.id];
    expect(cached?.version).toBe('2');
    expect(cached?.snapshot.statement).toBe('v2 statement for deletion tests.');
    // 经 sanitize 读回（注入路径）缓存仍在——缓存字段不会在校验时被剥掉。
    const listed = (await projections.listContextProjections(uid)).find((p) => p.id === 'proj-del-1');
    expect(listed?.assetVersionSnapshots?.[asset.id]?.version).toBe('2');
    expect(listed?.assetVersionSnapshots?.[asset.id]?.snapshot.statement).toContain('v2 statement');
  });

  it('删未被投影引用的版本：不往投影写缓存', async () => {
    const uid = 'user-vdel-noref';
    const { assets, store, asset } = await seedVersioned(uid, '2');
    await assets.deleteAbilityAssetVersion(uid, asset.id, '1', userAction('delete unreferenced'));
    const raw = await store.readRecallJsonRecord(uid, 'projections', 'proj-del-1');
    expect((raw as { assetVersionSnapshots?: unknown }).assetVersionSnapshots).toBeUndefined();
  });

  it('守卫：在用版本不可删；不存在/重复删被拒；purge 后拒绝；select 已删版本被拒', async () => {
    const uid = 'user-vdel-guard';
    const { assets, asset } = await seedVersioned(uid);
    await expect(assets.deleteAbilityAssetVersion(uid, asset.id, '3', userAction('active'))).rejects.toThrow('active version');
    await expect(assets.deleteAbilityAssetVersion(uid, asset.id, '99', userAction('missing'))).rejects.toThrow('not found');
    await assets.deleteAbilityAssetVersion(uid, asset.id, '2', userAction('first delete'));
    await expect(assets.deleteAbilityAssetVersion(uid, asset.id, '2', userAction('repeat'))).rejects.toThrow('not found');
    // 已删版本无法被选用为在用（活链守卫）。
    await expect(assets.selectAbilityAssetVersion(uid, asset.id, '2', userAction('select deleted'))).rejects.toThrow('version not found');
    await assets.purgeAbilityAsset(uid, asset.id, userAction('purge'));
    await expect(assets.deleteAbilityAssetVersion(uid, asset.id, '1', userAction('after purge'))).rejects.toThrow('purged');
  });
});

describe('存量自由文本 scope 迁移（A 轨道 2026-09-13）', () => {
  async function seedWithScope(uid: string, scope: string) {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate(uid, {
      judgment: 'Keep architecture decisions in a decision log.',
      suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: scope,
      sourceRefs: [{ kind: 'execution', id: 'exec-scope-mig' }],
    });
    const asset = (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
    return { assets, asset };
  }

  it('可归一的自由文本 scope 改写为词表值并递增版本；词表值幂等跳过；不可归一的保留', async () => {
    const { assets, asset } = await seedWithScope('user-scope-mig', '用户全局画像');
    expect(asset.scope).toBe('用户全局画像');

    const first = await assets.migrateLegacyFreeTextScopes('user-scope-mig');
    expect(first).toBe(1);
    const migrated = await assets.readAbilityAsset('user-scope-mig', asset.id);
    expect(migrated.scope).toBe('general');
    expect(migrated.version).toBe('2');
    // 版本快照与审计留痕（迁移走与 updateAbilityAsset 同一机制）。
    expect((await assets.listAbilityAssetVersions('user-scope-mig', asset.id)).map((v) => v.version)).toEqual(['1', '2']);
    expect((await assets.listAbilityAssetAudit('user-scope-mig', asset.id)).map((r) => r.action)).toContain('updated');

    // 幂等：已是词表值，再跑空转。
    expect(await assets.migrateLegacyFreeTextScopes('user-scope-mig')).toBe(0);

    // 不可归一的自由文本保留原值（软着陆——token 软匹配兜底）。
    const { assets: assets2, asset: asset2 } = await seedWithScope('user-scope-keep', '仅产品工作空间');
    expect(await assets2.migrateLegacyFreeTextScopes('user-scope-keep')).toBe(0);
    expect((await assets2.readAbilityAsset('user-scope-keep', asset2.id)).scope).toBe('仅产品工作空间');
  });

  it('迁移 bump 版本后同步刷新仍存活 committed 投影的版本快照（2026-09-14 修复）', async () => {
    // 背景：committed 注入路径在读快照之前强校验 assetVersions——迁移只 bump
    // 不刷新的话，requirement 存续期内每回合注入整体失败
    // （projection_asset_version_changed）且无回退。
    const uid = 'user-scope-committed';
    const { assets, asset } = await seedWithScope(uid, '用户全局画像');
    const store = await import('../../../../src/main/features/recall/store');
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const projection = {
      schemaVersion: 2,
      ownerId: uid,
      id: 'proj-scope-mig-committed',
      status: 'confirmed',
      purpose: 'task_execution',
      authorization: 'user_confirmed',
      assetIds: [asset.id],
      assetVersions: { [asset.id]: '1' },
      sourceRefs: [],
      taskRunId: 'run-scope-mig',
      omittedRefs: [],
      createdAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      decidedAt: new Date().toISOString(),
      expiresAt: future,
    };
    await store.writeRecallJsonRecord(uid, 'projections', projection.id, projection);

    expect(await assets.migrateLegacyFreeTextScopes(uid)).toBe(1);
    const projections = await import('../../../../src/main/features/recall/context-projection');
    const refreshed = await projections.readContextProjection(uid, projection.id);
    expect(refreshed.assetVersions?.[asset.id]).toBe('2');
    // committed 校验器随新版本快照通过（不再 version_changed）。
    await expect(projections.validateCommittedProjectionAssetVersions(uid, refreshed))
      .resolves.toMatchObject({ [asset.id]: '2' });

    // 已过期的 committed 投影不刷新（保持冻结现场，与确认时一致）。
    const expired = { ...projection, id: 'proj-scope-mig-expired', expiresAt: new Date(Date.now() - 1000).toISOString() };
    await store.writeRecallJsonRecord(uid, 'projections', expired.id, expired);
    // 手工把资产 scope 改回自由文本（模拟又一条脏数据）再迁移一次。
    await store.updateRecallJsonRecord(uid, 'ability-assets', asset.id, (raw: Record<string, unknown>) => {
      raw.scope = '用户全局画像';
      return raw;
    });
    expect(await assets.migrateLegacyFreeTextScopes(uid)).toBe(1);
    const stillFrozen = await projections.readContextProjection(uid, expired.id);
    expect(stillFrozen.assetVersions?.[asset.id]).toBe('1');
  });
});
