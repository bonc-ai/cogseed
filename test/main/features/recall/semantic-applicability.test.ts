import { describe, expect, it, vi } from 'vitest';
import { ambiguousRecallAssetIds, assessSemanticApplicability, parseSemanticApplicability } from '../../../../src/main/features/recall/semantic-applicability';
import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';
const { read, filter } = vi.hoisted(() => ({ read: vi.fn(), filter: vi.fn() }));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({ readAbilityAsset: read }));
vi.mock('../../../../src/main/features/recall/prompt-injection', () => ({ filterRecallAssetsForAgentRead: filter }));
const assets = [{ id: 'asset-a', version: '2', title: 'Weekly report', statement: 'Show evidence before conclusions.', applicableWhen: ['weekly project report'], status: 'active' }] as RecallAbilityAssetRecord[];
const task = '背景资料。'.repeat(600) + '这次是甲项目的临时简报，先写结论，不要沿用周报的顺序。';
const decision = { assetId: 'asset-a', version: '2', verdict: 'not_applicable', reason: 'Current explicit temporary format overrides this report default.',
  taskQuote: '这次是甲项目的临时简报，先写结论，不要沿用周报的顺序。', assetQuote: 'Show evidence before conclusions.', rank: 1 };
describe('host-qualified semantic applicability', () => {
  it('batches unknown conditions using the entire request including its late override', async () => {
    read.mockResolvedValue(assets[0]); filter.mockImplementation(async (_uid, rows) => rows);
    expect([...ambiguousRecallAssetIds(assets, task)]).toEqual(['asset-a']);
    const assess = vi.fn(async (message: string) => { expect(JSON.parse(message).currentTask).toBe(task); return JSON.stringify({ decisions: [decision] }); });
    expect(await assessSemanticApplicability('user-a', task, assets, { projectId: 'project-a' }, assess)).toEqual({ decisions: [decision], unassessed: [] });
    expect(assess).toHaveBeenCalledTimes(1);
    expect(filter.mock.calls[0][2].projectId).toBe('project-a');
  });
  it('refuses wrong versions, invented quotes, incomplete matrices and permissions revoked during the model call', async () => {
    for (const row of [{ ...decision, version: '1' }, { ...decision, taskQuote: 'invented instruction' }])
      expect(() => parseSemanticApplicability(JSON.stringify({ decisions: [row] }), task, assets)).toThrow();
    expect(() => parseSemanticApplicability('{"decisions":[]}', task, assets)).toThrow();
    filter.mockResolvedValue([]); read.mockResolvedValue(assets[0]);
    await expect(assessSemanticApplicability('user-a', task, assets, {}, async () => JSON.stringify({ decisions: [decision] }))).rejects.toThrow('snapshot');
  });
  it('retains the explicit-match fast path while detecting same-title objects and declared conflicts', () => {
    expect(ambiguousRecallAssetIds(assets, 'weekly project report').size).toBe(0);
    expect(ambiguousRecallAssetIds([...assets, { ...assets[0], id: 'asset-b', statement: 'Other project owner.' }], task).size).toBe(2);
  });
  it('does not send a candidate revoked after retrieval, and rejects revocation during assessment', async () => {
    read.mockResolvedValue(assets[0]); filter.mockResolvedValue([]);
    const assess = vi.fn(async () => JSON.stringify({ decisions: [decision] }));
    await expect(assessSemanticApplicability('user-a', task, assets, {}, assess)).rejects.toThrow('snapshot');
    expect(assess).not.toHaveBeenCalled();
    filter.mockImplementation(async (_uid, rows) => rows);
    await expect(assessSemanticApplicability('user-a', task, assets, {}, async () => {
      filter.mockResolvedValue([]); return JSON.stringify({ decisions: [decision] });
    })).rejects.toThrow('snapshot');
  });
  it('uses one batch beyond twelve and never splits a conflict group or hides the unassessed tail', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...assets[0], id: `asset-${i}`, title: `Title ${i}`, statement: `Guidance ${i}.` })) as RecallAbilityAssetRecord[];
    many[0].relations = [{ assetId: many[24].id, kind: 'conflicts_with' }];
    read.mockImplementation(async (_uid, id) => many.find(row => row.id === id));
    filter.mockImplementation(async (_uid, rows) => rows);
    const assess = vi.fn(async (message: string) => {
      const payload = JSON.parse(message);
      expect(payload.currentTask).toBe(task);
      if (payload.candidates.some((row: { assetId: string }) => row.assetId === 'asset-0'))
        expect(payload.candidates).toContainEqual(expect.objectContaining({ assetId: 'asset-24' }));
      return JSON.stringify({ decisions: payload.candidates.map((row: { assetId: string; statement: string }) => ({ ...decision, assetId: row.assetId,
        assetQuote: row.statement, verdict: row.assetId === 'asset-24' ? 'not_applicable' : 'applicable' })) });
    });
    const result = await assessSemanticApplicability('user-a', task, many, {}, assess);
    expect(assess).toHaveBeenCalledTimes(1);
    expect(result.decisions).toHaveLength(12);
    expect(result.decisions.find(row => row.assetId === 'asset-24')).toMatchObject({ verdict: 'not_applicable' });
    expect(result.unassessed).toHaveLength(13);
    expect(new Set([...result.decisions, ...result.unassessed].map(row => row.assetId)).size).toBe(25);
    expect(result.unassessed.every(row => row.reason === 'candidate_limit')).toBe(true);
  });
  it('does not call a model for an indivisible oversized conflict group or oversized task', async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...assets[0], id: `asset-${i}`, statement: `Different guidance ${i}.` }));
    const assess = vi.fn();
    const result = await assessSemanticApplicability('user-a', task, many, {}, assess);
    expect(result.decisions).toEqual([]); expect(result.unassessed).toHaveLength(13);
    expect(assess).not.toHaveBeenCalled();
    expect(await assessSemanticApplicability('user-a', 'x'.repeat(96_001), assets, {}, assess))
      .toEqual({ decisions: [], unassessed: [{ assetId: assets[0].id, version: '2', reason: 'context_limit' }] });
    expect(assess).not.toHaveBeenCalled();
  });
  it('includes an admitted conflict outside the requested top results without promoting it', async () => {
    const other = { ...assets[0], id: 'asset-b', title: 'A different title', statement: 'Conflicting guidance.',
      relations: [{ assetId: 'asset-a', kind: 'conflicts_with' as const }] };
    read.mockImplementation(async (_uid, id) => id === 'asset-a' ? assets[0] : other);
    filter.mockImplementation(async (_uid, rows) => rows);
    expect([...ambiguousRecallAssetIds(assets, 'weekly project report', [...assets, other])]).toEqual(['asset-a']);
    const assess = vi.fn(async (message: string) => {
      expect(JSON.parse(message).comparisonCandidates).toEqual([expect.objectContaining({ assetId: 'asset-b' })]);
      return JSON.stringify({ decisions: [decision] });
    });
    expect(await assessSemanticApplicability('user-a', task, assets, {}, assess, [...assets, other]))
      .toEqual({ decisions: [decision], unassessed: [] });
    expect(assess).toHaveBeenCalledTimes(1);
  });

});
