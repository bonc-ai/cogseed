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

  it('never changes asset ownership or accepts mutable identity fields', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Prefer local evidence.', suggestedType: 'personal', suggestedScope: 'personal', sourceRefs: [{ kind: 'memory', id: 'mem-a' }] });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });

    await expect(assets.updateAbilityAsset('user-a', asset.id, { id: 'aa-other' } as never)).rejects.toThrow(/identity/i);
    await expect(assets.readAbilityAsset('user-b', asset.id)).rejects.toThrow(/not found/i);
  });



  it('requires user governance metadata for promotion and user asset mutations', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep decision records with evidence.',
      suggestedType: 'rule',
      suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-governance' }],
    });

    // `actor` now defaults to 'user' for upward-compatible promotion; the
    // governance check lives on user asset mutations, not on promote itself.
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id);

    await expect(assets.updateAbilityAsset('user-a', asset.id, {
      statement: 'Keep architecture decision records with source evidence.',
      reason: 'Refine the verified rule.',
    } as never)).rejects.toThrow(/user actor/i);
    await expect(assets.updateAbilityAsset('user-a', asset.id, {
      statement: 'Keep architecture decision records with source evidence.',
      actor: 'user',
    } as never)).rejects.toThrow(/reason/i);
    await expect(assets.pauseAbilityAsset('user-a', asset.id, { actor: 'system', reason: 'automated pause' } as never)).rejects.toThrow(/user actor/i);
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
