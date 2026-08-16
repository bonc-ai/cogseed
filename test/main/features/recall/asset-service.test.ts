import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-assets-')); previousRoot = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

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
    const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Keep decision records with evidence.', suggestedType: 'rule', suggestedScope: 'architecture', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] });
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
      suggestedType: 'rule', suggestedScope: 'architecture',
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
      await assets.setAbilityAssetMaturity(uid, asset.id, maturity);
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
      suggestedType: 'rule', suggestedScope: 'architecture',
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
});
