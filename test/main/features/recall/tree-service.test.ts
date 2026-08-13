import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-tree-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, usage, tree, store] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/usage-service'),
    import('../../../../src/main/features/recall/tree-service'),
    import('../../../../src/main/features/recall/store'),
  ]);
  return { candidates, assets, usage, tree, store };
}

async function seedAsset(
  userId: string,
  judgment: string,
  sourceRef: { kind: 'conversation' | 'memory'; id: string },
) {
  const { candidates } = await modules();
  const candidate = await candidates.saveRecallCandidate(userId, {
    judgment,
    suggestedType: 'rule',
    suggestedScope: 'review',
    sourceRefs: [sourceRef],
  });
  const { asset } = await candidates.promoteRecallCandidate(userId, candidate.id);
  return { candidate, asset };
}

describe('cognition tree asset relation contract', () => {
  it('projects only formal assets and their declared relations', async () => {
    const { assets, usage, tree } = await modules();
    const base = await seedAsset(
      'u',
      'Use explicit contracts for persisted relationships.',
      { kind: 'memory', id: 'mem-a' },
    );
    const refinement = await seedAsset(
      'u',
      'Version persisted relationship contracts explicitly.',
      { kind: 'conversation', id: 'conv-a' },
    );
    const updated = await assets.updateAbilityAsset('u', refinement.asset.id, {
      relations: [{ kind: 'refines', assetId: base.asset.id, note: 'Narrows the storage boundary.' }],
      derivedFrom: [base.asset.id],
    });
    await usage.recordRecallUsage('u', {
      assetId: updated.id,
      assetVersion: updated.version,
      taskRunId: 'task-a',
      outcome: 'better',
    });

    const graph = await tree.rebuildCognitionTree('u');

    expect(graph).toMatchObject({
      contract: 'ability_asset_relations',
      contractVersion: 1,
      ownerId: 'u',
      id: 'graph',
    });
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([
      `asset:${base.asset.id}`,
      `asset:${updated.id}`,
    ].sort());
    expect(graph.nodes.every((node) => node.type === 'asset')).toBe(true);
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: `asset:${updated.id}`,
      assetType: 'rule',
      status: 'active',
      maturity: 'seed',
      version: '2',
    }));
    expect(graph.edges).toEqual([{
      from: `asset:${updated.id}`,
      to: `asset:${base.asset.id}`,
      type: 'asset_relation',
      kind: 'refines',
      note: 'Narrows the storage boundary.',
    }]);

    // Provenance stays on the asset; it is not converted into tree nodes/edges.
    const stored = await assets.readAbilityAsset('u', updated.id);
    expect(stored.derivedFrom).toEqual([base.asset.id]);
    expect(stored.sourceSessionIds).toEqual(['conv-a']);
    expect(JSON.stringify(graph)).not.toContain('source:');
    expect(JSON.stringify(graph)).not.toContain('candidate:');
    expect(JSON.stringify(graph)).not.toContain('usage:');
    expect(JSON.stringify(graph)).not.toContain('derived_from');

    expect(await tree.readCognitionTree('u')).toEqual(graph);
  });

  it('preserves a declared relation when its target asset is not locally present', async () => {
    const { assets, tree } = await modules();
    const source = await seedAsset(
      'u-dangling',
      'Keep declared relationships available for later resolution.',
      { kind: 'memory', id: 'mem-b' },
    );
    await assets.updateAbilityAsset('u-dangling', source.asset.id, {
      relations: [{ kind: 'depends_on', assetId: 'asset-from-another-snapshot' }],
    });

    const graph = await tree.rebuildCognitionTree('u-dangling');

    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([{
      from: `asset:${source.asset.id}`,
      to: 'asset:asset-from-another-snapshot',
      type: 'asset_relation',
      kind: 'depends_on',
    }]);
  });

  it('rebuilds a persisted pre-contract lifecycle graph on read', async () => {
    const { tree, store } = await modules();
    const current = await seedAsset(
      'u-legacy',
      'Only formal assets belong in the relationship graph.',
      { kind: 'memory', id: 'mem-legacy' },
    );
    await store.writeRecallJsonRecord('u-legacy', 'tree', 'graph', {
      schemaVersion: 1,
      ownerId: 'u-legacy',
      id: 'graph',
      nodes: [
        { id: 'source:memory:mem-legacy', type: 'source', label: 'memory:mem-legacy' },
        { id: `candidate:${current.candidate.id}`, type: 'candidate', label: current.candidate.judgment },
      ],
      edges: [{
        from: 'source:memory:mem-legacy',
        to: `candidate:${current.candidate.id}`,
        type: 'evidence',
      }],
      updatedAt: new Date().toISOString(),
    });

    const graph = await tree.readCognitionTree('u-legacy');

    expect(graph?.contract).toBe('ability_asset_relations');
    expect(graph?.nodes).toEqual([expect.objectContaining({
      id: `asset:${current.asset.id}`,
      type: 'asset',
    })]);
    expect(graph?.edges).toEqual([]);
  });

  it('rejects a malformed current asset relation contract', async () => {
    const { tree, store } = await modules();
    await store.writeRecallJsonRecord('u-malformed', 'tree', 'graph', {
      schemaVersion: 2,
      ownerId: 'u-malformed',
      id: 'graph',
      contract: 'ability_asset_relations',
      contractVersion: 1,
      nodes: [],
      edges: [{
        from: 'asset:missing-source',
        to: 'asset:unresolved-target',
        type: 'asset_relation',
        kind: 'related_to',
      }],
      updatedAt: new Date().toISOString(),
    });

    await expect(tree.readCognitionTree('u-malformed'))
      .rejects.toThrow('malformed cognition tree asset relation contract');
  });
});
