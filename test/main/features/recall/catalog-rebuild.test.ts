import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: 0,
  blocked: new Set<string>(),
}));

vi.mock('../../../../src/main/features/recall/asset-service', () => ({
  listAbilityAssets: async () => {
    state.calls += 1;
    return [
      { id: 'aa-release', title: '发版检查', statement: '发版前核对版本和回退方案', type: 'rule', status: 'active', maturity: 'bud', version: '1', updatedAt: '2026-09-01T00:00:00Z' },
      { id: 'aa-writing', title: '写作规范', statement: '文章先给结论再给依据', type: 'rule', status: 'active', maturity: 'bud', version: '1', updatedAt: '2026-09-01T00:00:00Z' },
      { id: 'aa-blocked', title: '内部秘密', statement: '不可见内容', type: 'rule', status: 'active', maturity: 'bud', version: '1', updatedAt: '2026-09-01T00:00:00Z' },
    ];
  },
}));

vi.mock('../../../../src/main/features/recall/prompt-injection', () => ({
  filterRecallAssetsForAgentRead: async (_userId: string, assets: Array<{ id: string }>) =>
    assets.filter((asset) => !state.blocked.has(asset.id)),
}));

vi.mock('../../../../src/main/features/recall/catalog-vector-cache', () => ({
  pruneCatalogVectors: async () => undefined,
  catalogVectors: async () => ({ query: null, byId: new Map() }),
}));

vi.mock('../../../../src/main/features/recall/asset-catalog', () => ({
  loadAssetAdoptionStatsCached: async () => new Map(),
  formatCatalogEntry: (asset: { id: string; title: string }, _stat: unknown, index: number, marked: boolean) => `${index}. ${marked ? '★' : ''}[asset:${asset.id}] ${asset.title}`,
}));

vi.mock('../../../../src/main/features/recall/catalog-ranking-weights', () => ({
  DEFAULT_RANKING_WEIGHTS: { relevance: 2, adoption: 0.3, scene: 0.5, maturity: 0.2 },
  getRankingWeights: async () => ({ weights: { relevance: 2, adoption: 0.3, scene: 0.5, maturity: 0.2 }, source: 'default' }),
}));

beforeEach(() => {
  state.calls = 0;
  state.blocked = new Set(['aa-blocked']);
});

describe('turn-scoped asset catalog', () => {
  it('keeps concurrent conversations separate and coalesces the same turn build', async () => {
    const engine = await import('../../../../src/main/features/recall/catalog-engine');
    engine.resetCatalogEngineForTest();
    const input = { cid: 'conv-a', turnId: 'turn-a', taskText: '发版检查' };
    const [first, repeated] = await Promise.all([
      engine.catalogSnapshot('catalogtest', input),
      engine.catalogSnapshot('catalogtest', input),
    ]);
    expect(first).toBe(repeated);
    expect(state.calls).toBe(1);
    const second = await engine.catalogSnapshot('catalogtest', { cid: 'conv-b', turnId: 'turn-b', taskText: '写作规范' });
    expect(second).not.toBe(first);
    expect(engine.catalogRankedForTurn('catalogtest', 'conv-a', 'turn-a').size).toBe(2);
    expect(engine.catalogRankedForTurn('catalogtest', 'conv-b', 'turn-b').size).toBe(2);
    expect(engine.catalogRankedForTurn('catalogtest', 'conv-a', 'turn-b').size).toBe(0);
    expect(first.assets.some((asset) => asset.id === 'aa-blocked')).toBe(false);
  });

  it('rechecks admission before a tool page even when its rank snapshot exists', async () => {
    const engine = await import('../../../../src/main/features/recall/catalog-engine');
    engine.resetCatalogEngineForTest();
    const input = { cid: 'conv-a', turnId: 'turn-a', taskText: '发版检查' };
    const snapshot = await engine.catalogSnapshot('catalogtest', input);
    state.blocked.add('aa-writing');
    const ordered = await engine.catalogOrderedToolPool('catalogtest', input, snapshot.assets);
    expect(ordered.map((asset) => asset.id)).toEqual(['aa-release']);
  });

  it('keeps the active task for a short continuation without pinning the first message forever', async () => {
    const engine = await import('../../../../src/main/features/recall/catalog-engine');
    engine.resetCatalogEngineForTest();
    const first = await engine.catalogSnapshot('catalogtest', { cid: 'conv-a', turnId: 'turn-1', taskText: '发版检查' });
    const continued = await engine.catalogSnapshot('catalogtest', { cid: 'conv-a', turnId: 'turn-2', taskText: '继续' });
    expect(continued.matches.get('aa-release')?.score).toBe(first.matches.get('aa-release')?.score);
    const changed = await engine.catalogSnapshot('catalogtest', { cid: 'conv-a', turnId: 'turn-3', taskText: '写作规范' });
    expect(changed.matches.get('aa-writing')!.score).toBeGreaterThan(changed.matches.get('aa-release')!.score);
  });

  it('keeps prompt marks within a bounded excerpt and never marks blocked assets', async () => {
    const engine = await import('../../../../src/main/features/recall/catalog-engine');
    const hint = await import('../../../../src/main/features/recall/asset-catalog-hint');
    engine.resetCatalogEngineForTest();
    const snapshot = await engine.catalogSnapshot('catalogtest', { cid: 'conv-a', turnId: 'turn-a', taskText: '发版检查' });
    const rendered = hint.renderCatalogPrompt(snapshot);
    expect(rendered.text).toContain('[asset:aa-release]');
    expect(rendered.text).not.toContain('aa-blocked');
    expect(rendered.shown.length).toBeLessThanOrEqual(hint.INLINE_CATALOG_MAX_ENTRIES);
    expect([...rendered.relevantIds].every((id) => rendered.shown.some((row) => row.id === id))).toBe(true);
  });

  it('本轮已注入的资产在目录行尾标注 [attached]，标注不删除条目（修3）', async () => {
    const engine = await import('../../../../src/main/features/recall/catalog-engine');
    const hint = await import('../../../../src/main/features/recall/asset-catalog-hint');
    engine.resetCatalogEngineForTest();
    const snapshot = await engine.catalogSnapshot('catalogtest', { cid: 'conv-att', turnId: 'turn-att', taskText: '发版检查' });
    const rendered = hint.renderCatalogPrompt(snapshot, { attachedAssetIds: new Set(['aa-release']) });
    const attachedLine = rendered.text.split('\n').find((line) => line.includes('[asset:aa-release]'));
    const plainLine = rendered.text.split('\n').find((line) => line.includes('[asset:aa-writing]'));
    expect(attachedLine).toContain('[attached]');
    expect(plainLine).not.toContain('[attached]');
    // 标注而非删除：目录仍是「可用全集」的截断视图，已注入条目照常在列。
    expect(rendered.shown.map((row) => row.id)).toContain('aa-release');
  });

  it('目录头行如实披露截断：N 条可用、只列前 M 条（修4）', async () => {
    const hint = await import('../../../../src/main/features/recall/asset-catalog-hint');
    const assets = Array.from({ length: 15 }, (_, index) => ({
      id: `aa-header-${index}`, title: `资产${index}`, statement: `陈述 ${index}`,
      type: 'rule', status: 'active', maturity: 'bud', version: '1', updatedAt: '2026-09-01T00:00:00Z',
    }));
    const ranked = assets.map((asset) => ({ assetId: asset.id, score: 1, factors: [], excluded: [] }));
    const snapshot = {
      userId: 'catalogtest', cid: 'conv-header', turnId: 'turn-header', at: 0,
      assets, ranked,
      byId: new Map(ranked.map((row) => [row.assetId, row])),
      matches: new Map(), stars: new Set(), adoption: new Map(),
    } as unknown as Parameters<typeof hint.renderCatalogPrompt>[0];
    const rendered = hint.renderCatalogPrompt(snapshot);
    expect(rendered.shown.length).toBeLessThan(assets.length);
    expect(rendered.text).toContain(`${assets.length} assets are available`);
    expect(rendered.text).toContain(`top ${rendered.shown.length} are listed`);
    // 全量列齐时不多说截断（header 保持原句式）。
    const full = hint.renderCatalogPrompt({
      ...snapshot, assets: assets.slice(0, 2), ranked: ranked.slice(0, 2),
      byId: new Map(ranked.slice(0, 2).map((row) => [row.assetId, row])),
    } as unknown as Parameters<typeof hint.renderCatalogPrompt>[0]);
    expect(full.text).toContain('2 assets are available');
    expect(full.text).not.toContain('are listed');
  });
});

describe('retrieval and replay', () => {
  it('finds exact titles and works when embeddings are unavailable; tags cannot change the profile', async () => {
    const { catalogMatches, catalogAssetProfile } = await import('../../../../src/main/features/recall/catalog-relevance');
    const assets = [
      { id: 'aa-a', title: 'KSTAR 回退流程', statement: '故障时恢复上一版本' },
      { id: 'aa-b', title: '通用写作', statement: '先给结论与依据' },
    ];
    const scores = await catalogMatches('catalogtest', 'KSTAR 回退', assets);
    expect(scores.get('aa-a')!.score).toBeGreaterThan(scores.get('aa-b')!.score);
    expect(scores.get('aa-a')!.strong).toBe(true);
    expect(catalogAssetProfile({ ...assets[0], tags: ['A'] } as never))
      .toBe(catalogAssetProfile({ ...assets[0], tags: ['B'] } as never));
    expect([...scores.values()].every((row) => row.score >= 0 && row.score <= 1)).toBe(true);
  });

  it('词面通道有入场下限：泛词级重合不再被 RRF 名次放大成高分（P7）', async () => {
    const { catalogMatches } = await import('../../../../src/main/features/recall/catalog-relevance');
    const assets = [
      { id: 'aa-floor-relevant', title: 'KSTAR 回退流程', statement: '故障时恢复上一版本的具体操作步骤' },
      { id: 'aa-floor-junk', title: '露营装备准备', statement: '帐篷炉具食物清单，疲劳后的恢复与补水安排' },
    ];
    const scores = await catalogMatches('catalogtest', 'KSTAR 回退流程：故障时恢复上一版本的步骤', assets);
    // 相关条目照常命中（词面+精确双通道）。
    expect(scores.get('aa-floor-relevant')!.score).toBeGreaterThan(0.5);
    expect(scores.get('aa-floor-relevant')!.strong).toBe(true);
    // 泛词条目只与查询共享个别二元组（如「恢复」），词面覆盖远低于入场下限
    // ——不得进词面通道，融合分为 0（此前 rank-1/2 的 RRF 名次会把它放大到
    // 近满分，P7「没问露营却排前」的放大机制正在这里）。★ 不亮、分不涨。
    expect(scores.get('aa-floor-junk')!.score).toBe(0);
    expect(scores.get('aa-floor-junk')!.strong).toBe(false);
  });

  it('scores labelled tasks without treating old applied receipts as ground truth', async () => {
    const { evaluateCatalogRuns } = await import('../../../../src/main/features/recall/catalog-evaluation');
    const result = evaluateCatalogRuns(
      [{ id: 'task-a', relevantIds: ['aa-good'], harmfulIds: ['aa-bad'] }],
      [{ caseId: 'task-a', rankedIds: ['aa-good', 'aa-bad'], shownIds: ['aa-good', 'aa-bad'], appliedIds: ['aa-good'] }],
    );
    expect(result).toMatchObject({ cases: 1, relevantCases: 1, recallAt5: 1, mrrAt10: 1, harmfulShownRate: 0.5, relevantAppliedRate: 1 });
  });
});
