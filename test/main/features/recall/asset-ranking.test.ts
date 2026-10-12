import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// specs/012 T021：排序不变量单测（US-202）。
// Phase 1 暂挂在 ability-tag.test.ts 的 T006（排序唯一处）/T007（权重模块）
// 用例已**平移**到本文件（移动 + 删除原位置，断言未改）；本文件再补
// T016~T018 的主进程接线用例：采用口径（被带入不计分 / applied 计分）、
// 同 id 回执不双计、标签不进分、只排不裁、scene 接线、读盘原文（隐私边界）。

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-asset-ranking-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function activate(userId: string): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(userId);
}

function decisionIdOf(assetId: string): string {
  const stem = assetId.replace(/[^A-Za-z0-9]/g, '').padEnd(8, '0').slice(0, 40);
  return `rd_${stem}`;
}

interface SeedOverrides {
  id: string;
  maturity?: 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated';
  spaceId?: string;
  scopePolicy?: { projectIds?: string[]; workspaceIds?: string[] };
  updatedAt?: string;
  tags?: string[];
  statement?: string;
}

/** 建一条 v1、active 的资产（形状对齐 ability-tag.test.ts 先例，可指定排序相关字段）。 */
async function seedAsset(userId: string, overrides: SeedOverrides): Promise<void> {
  const { createAbilityAsset } = await import('../../../../src/main/features/recall/asset-service');
  const now = overrides.updatedAt ?? new Date().toISOString();
  await createAbilityAsset(userId, {
    schemaVersion: 2,
    ownerId: userId,
    id: overrides.id,
    candidateId: `cand-${overrides.id}`,
    sourceCandidateIds: [`cand-${overrides.id}`],
    reviewDecisionId: decisionIdOf(overrides.id),
    type: 'personal',
    title: `条目${overrides.id}`,
    statement: overrides.statement ?? `内容 ${overrides.id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${overrides.id}` }],
    scope: 'general',
    status: 'active',
    lifecycleStatus: 'user_confirmed_unverified',
    maturity: overrides.maturity ?? 'bud',
    version: '1',
    createdAt: now,
    updatedAt: now,
    ...(overrides.spaceId ? { spaceId: overrides.spaceId } : {}),
    ...(overrides.scopePolicy ? { scopePolicy: overrides.scopePolicy } : {}),
    ...(overrides.tags ? { tags: overrides.tags } : {}),
  }, { actor: 'user', reason: 'ranking test seed' });
}

/** 与真实链路同序：先落注入回执（usage 回执的外键），再落 usage 回执。
 *  （夹具与 adoption-evidence.test.ts 同款——specs/015 的唯一采用口径。） */
type UsageStatus = 'applied' | 'considered_not_applicable' | 'available_no_opportunity' | 'contradicted' | 'usage_unknown';

async function recordUsageReceipt(
  userId: string,
  input: {
    taskRunId: string; assetId: string; assetVersion?: string; projectionId?: string;
    status: UsageStatus; boundary?: 'real' | 'degraded' | 'test-double';
  },
): Promise<void> {
  const injections = await import('../../../../src/main/features/recall/injection-receipt');
  const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
  const assetVersion = input.assetVersion ?? '1';
  const projectionId = input.projectionId ?? 'proj-1';
  const boundary = input.boundary ?? 'real';
  const injection = await injections.recordInjectionReceipt(userId, {
    taskRunId: input.taskRunId, projectionId, assetId: input.assetId, assetVersion,
    boundary, status: 'injected', messageId: `message-${input.taskRunId}`,
  });
  await usage.recordAssetUsageReceipt(userId, {
    taskRunId: input.taskRunId, projectionId, assetId: input.assetId, assetVersion,
    injectionReceiptId: injection.id, status: input.status,
    evidenceKind: 'tool_call', evidenceRefs: [{ kind: 'conversation', id: `conv-${input.taskRunId}` }],
    boundary,
  });
}

/** 目录文本（无任务文本 → 相关度缺席、无 60s 缓存歧义；每次重置缓存重算）。 */
async function catalogText(
  userId: string,
  scene?: { turnProjectId?: string; turnSpaceId?: string },
): Promise<string> {
  const hint = await import('../../../../src/main/features/recall/asset-catalog-hint');
  hint.resetAssetCatalogHintCacheForTest();
  return hint.assetCatalogForPrompt(userId, 'conv-ranking', Date.now(), '', scene);
}

/** 目录行 id 的出现顺序（`N. [asset:xx]` / `N. ★[asset:xx]`）。 */
function catalogIds(text: string): string[] {
  return [...text.matchAll(/^\d+\.\s(?:★)?\[asset:([^\]]+)\]/gm)].map((match) => match[1]);
}

function jsonlLines(userId: string, stream: string): string[] {
  const file = path.join(root, userId, 'cloud', 'recall', 'jsonl', stream, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

describe('asset-ranking（T006：排序唯一处）', () => {
  const W = { relevance: 1, adoption: 1, scene: 0.8, maturity: 0.4 };
  const NOW = Date.parse('2026-09-25T12:00:00Z');
  const mk = (overrides: {
    id: string;
    maturity?: 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated';
    spaceId?: string;
    scopePolicy?: { projectIds?: string[]; workspaceIds?: string[] };
    updatedAt?: string;
  }) => ({
    id: overrides.id,
    maturity: overrides.maturity ?? 'bud',
    updatedAt: overrides.updatedAt ?? '2026-09-01T00:00:00Z',
    ...(overrides.spaceId ? { spaceId: overrides.spaceId } : {}),
    ...(overrides.scopePolicy ? { scopePolicy: overrides.scopePolicy } : {}),
  });
  const ids = (rows: Array<{ assetId: string }>) => rows.map((row) => row.assetId);

  it('只排不裁：输出集合与输入逐条相等（只是顺序）', async () => {
    const { rankAssets } = await import('../../../../src/main/features/recall/asset-ranking');
    const assets = [mk({ id: 'aa-c' }), mk({ id: 'aa-a' }), mk({ id: 'aa-b' })];
    const ranked = rankAssets({ assets, weights: W, now: NOW });
    expect(ranked).toHaveLength(3);
    expect(new Set(ids(ranked))).toEqual(new Set(['aa-a', 'aa-b', 'aa-c']));
  });

  it('确定性：同输入两次排序逐位相同；全同分兜底 id 字典序', async () => {
    const { rankAssets } = await import('../../../../src/main/features/recall/asset-ranking');
    const assets = [mk({ id: 'aa-z' }), mk({ id: 'aa-y' }), mk({ id: 'aa-x' })];
    const input = { assets, weights: W, now: NOW };
    expect(JSON.stringify(rankAssets(input))).toBe(JSON.stringify(rankAssets(input)));
    expect(ids(rankAssets(input))).toEqual(['aa-x', 'aa-y', 'aa-z']);
  });

  it('因子闭集无 tags：RANKING_FACTORS 逐字等于四因子', async () => {
    const { RANKING_FACTORS } = await import('../../../../src/main/features/recall/asset-ranking');
    expect([...RANKING_FACTORS]).toEqual(['relevance', 'adoption', 'scene', 'maturity']);
  });

  it('无显式场景关联时 scene 缺席：通用资产不会因项目会话被负向降权', async () => {
    const { rankAssets } = await import('../../../../src/main/features/recall/asset-ranking');
    const assets = [
      mk({ id: 'aa-hot', updatedAt: '2026-09-24T00:00:00Z' }),
      mk({ id: 'aa-cold', updatedAt: '2026-08-01T00:00:00Z' }),
    ];
    // 会话无项目/空间归属 → scene 整体缺席。
    const absent = rankAssets({ assets, weights: W, scene: {}, now: NOW });
    expect(absent.every((row) => row.excluded.includes('scene'))).toBe(true);
    expect(absent.every((row) => row.sceneExcludedReason === 'no_scene_context')).toBe(true);
    expect(absent.every((row) => !row.factors.some((factor) => factor.name === 'scene'))).toBe(true);
    // 项目/空间会话下，未记录场景关联的通用资产仍按其余因素排序。
    const projectTurn = rankAssets({ assets, weights: W, scene: { turnSpaceId: 'sp-current' }, now: NOW });
    expect(projectTurn.every((row) => row.excluded.includes('scene'))).toBe(true);
    expect(projectTurn.every((row) => row.sceneExcludedReason === 'no_matching_association')).toBe(true);
    expect(projectTurn.map((row) => [row.assetId, row.score])).toEqual(absent.map((row) => [row.assetId, row.score]));
  });

  it('scene 正向命中分层：空间命中 1.0、项目/工作区命中 0.8；未命中缺席', async () => {
    const { rankAssets } = await import('../../../../src/main/features/recall/asset-ranking');
    const assets = [
      mk({ id: 'aa-space', spaceId: 'sp-1' }),
      mk({ id: 'aa-proj', scopePolicy: { projectIds: ['pj-1'] } }),
      mk({ id: 'aa-ws', scopePolicy: { workspaceIds: ['sp-1'] } }),
      mk({ id: 'aa-other', scopePolicy: { projectIds: ['pj-other'] } }),
      mk({ id: 'aa-none' }),
    ];
    const ranked = rankAssets({ assets, weights: W, scene: { turnProjectId: 'pj-1', turnSpaceId: 'sp-1' }, now: NOW });
    const rawOf = new Map(ranked.flatMap((row) => row.factors.filter((f) => f.name === 'scene').map((f) => [row.assetId, f.raw])));
    expect(rawOf.get('aa-space')).toBe(1);
    expect(rawOf.get('aa-proj')).toBe(0.8);
    expect(rawOf.get('aa-ws')).toBe(0.8);
    expect(rawOf.has('aa-other')).toBe(false);
    expect(rawOf.has('aa-none')).toBe(false);
  });

  it('adoption：中性先验、饱和上限与平滑近度；零次仍是在场信号', async () => {
    const { rankAssets } = await import('../../../../src/main/features/recall/asset-ranking');
    const assets = [mk({ id: 'aa-0' }), mk({ id: 'aa-3' }), mk({ id: 'aa-8' }), mk({ id: 'aa-100' })];
    const stats = new Map([
      ['aa-3', { appliedCount: 3, lastAppliedAt: '2026-08-01T00:00:00Z' }],
      ['aa-8', { appliedCount: 8, lastAppliedAt: new Date(NOW - 86_400_000).toISOString() }],
      ['aa-100', { appliedCount: 100 }],
    ]);
    const ranked = rankAssets({ assets, weights: W, adoptionStats: stats, now: NOW });
    const rawOf = new Map(ranked.flatMap((row) => row.factors.filter((f) => f.name === 'adoption').map((f) => [row.assetId, f.raw])));
    expect(rawOf.get('aa-0')).toBe(0.5);
    expect(rawOf.get('aa-3')).toBeGreaterThan(0.8);
    expect(rawOf.get('aa-8')).toBeGreaterThan(0.9);
    expect(rawOf.get('aa-100')).toBe(0.9);
    // 零次资产 adoption 在场（factors 里有），不在 excluded 里。
    const zero = ranked.find((row) => row.assetId === 'aa-0')!;
    expect(zero.factors.some((f) => f.name === 'adoption')).toBe(true);
    expect(zero.excluded).not.toContain('adoption');
  });

  it('明确 contradicted 才降低质量分；负信号与采用次数分开计算且始终有限', async () => {
    const { rankAssets } = await import('../../../../src/main/features/recall/asset-ranking');
    const assets = [mk({ id: 'aa-new' }), mk({ id: 'aa-corrected' }), mk({ id: 'aa-used' })];
    const stats = new Map([
      ['aa-corrected', { appliedCount: 0, contradictedCount: 1, lastContradictedAt: new Date(NOW).toISOString() }],
      ['aa-used', { appliedCount: 1, lastAppliedAt: new Date(NOW).toISOString() }],
    ]);
    const ranked = rankAssets({ assets, adoptionStats: stats, weights: W, now: NOW });
    const raw = (id: string) => ranked.find((row) => row.assetId === id)!.factors.find((factor) => factor.name === 'adoption')!.raw;
    expect(raw('aa-corrected')).toBeLessThan(raw('aa-new'));
    expect(raw('aa-used')).toBeGreaterThan(raw('aa-new'));
    expect(ranked.every((row) => Number.isFinite(row.score))).toBe(true);
  });

  it('maturity 分层：validated 1.0 / bud 0.5 / seed 0.3；relevance 缺席 = 因子缺席', async () => {
    const { rankAssets } = await import('../../../../src/main/features/recall/asset-ranking');
    const assets = [
      mk({ id: 'aa-seed', maturity: 'seed' }),
      mk({ id: 'aa-bud', maturity: 'bud' }),
      mk({ id: 'aa-tv', maturity: 'transfer_validated' }),
      mk({ id: 'aa-ev', maturity: 'effectiveness_validated' }),
    ];
    const ranked = rankAssets({ assets, weights: W, now: NOW });
    const rawOf = (factor: string, id: string) => ranked
      .find((row) => row.assetId === id)!.factors.find((f) => f.name === factor)!.raw;
    expect(rawOf('maturity', 'aa-seed')).toBe(0.3);
    expect(rawOf('maturity', 'aa-bud')).toBe(0.5);
    expect(rawOf('maturity', 'aa-tv')).toBe(1);
    expect(rawOf('maturity', 'aa-ev')).toBe(1);
    // relevance map 缺该 id → 因子缺席（embedding 不可用的既有降级口径）。
    expect(ranked.every((row) => row.excluded.includes('relevance'))).toBe(true);
    const withRelevance = rankAssets({
      assets: assets.slice(0, 1),
      weights: W,
      relevance: new Map([['aa-seed', 0.62]]),
      now: NOW,
    });
    expect(withRelevance[0].excluded).not.toContain('relevance');
  });

  it('explainRanking：只透传因子名与数值（无正文/任务文本/路径），缺席因子不出现', async () => {
    const { rankAssets, explainRanking } = await import('../../../../src/main/features/recall/asset-ranking');
    const ranked = rankAssets({
      assets: [mk({ id: 'aa-x', spaceId: 'sp-1' })],
      weights: W,
      scene: { turnSpaceId: 'sp-1' },
      weightsSource: 'configured',
      now: NOW,
    });
    const explanation = explainRanking(ranked[0]);
    expect(explanation.weightsSource).toBe('configured');
    expect(explanation.excluded).toEqual(['relevance']);
    expect(explanation.factors.map((factor) => factor.name)).toEqual(['adoption', 'scene', 'maturity']);
    const serialized = JSON.stringify(explanation);
    expect(serialized).not.toContain('statement');
    expect(serialized).not.toContain('内容');
    expect(serialized).not.toContain('/');
  });
});

describe('catalog-ranking-weights（T007：权重模块）', () => {
  it('未配置 → default；写入合法 → configured 且部分更新保持未给因子现值', async () => {
    await activate('user-w-default');
    const weights = await import('../../../../src/main/features/recall/catalog-ranking-weights');
    const initial = await weights.getRankingWeights('user-w-default');
    expect(initial.source).toBe('default');
    expect(initial.weights).toEqual({ relevance: 2, adoption: 0.3, scene: 0.5, maturity: 0.2 });
    await weights.setRankingWeights('user-w-default', { scene: 2 });
    const configured = await weights.getRankingWeights('user-w-default');
    expect(configured.source).toBe('configured');
    expect(configured.weights.scene).toBe(2);
    expect(configured.weights.relevance).toBe(2);
    // 无进程内长缓存：改动立刻可读（下一轮构建即生效）。
    await weights.setRankingWeights('user-w-default', { scene: 3 });
    expect((await weights.getRankingWeights('user-w-default')).weights.scene).toBe(3);
  });

  it('四类非法各自被拒且原值保持：未知因子 / 负数 / 非有限数 / 合并后全零', async () => {
    await activate('user-w-invalid');
    const weights = await import('../../../../src/main/features/recall/catalog-ranking-weights');
    await weights.setRankingWeights('user-w-invalid', { relevance: 5 });
    await expect(weights.setRankingWeights('user-w-invalid', { tags: 1 } as never)).rejects.toThrow('unknown ranking factor');
    await expect(weights.setRankingWeights('user-w-invalid', { relevance: -1 })).rejects.toThrow('within 0..10');
    await expect(weights.setRankingWeights('user-w-invalid', { relevance: 11 })).rejects.toThrow('within 0..10');
    await expect(weights.setRankingWeights('user-w-invalid', { relevance: Number.NaN })).rejects.toThrow('finite number');
    await expect(weights.setRankingWeights('user-w-invalid', { relevance: 0, adoption: 0, scene: 0, maturity: 0 }))
      .rejects.toThrow('all zero');
    const after = await weights.getRankingWeights('user-w-invalid');
    expect(after.source).toBe('configured');
    expect(after.weights.relevance).toBe(5);
  });

  it('盘上非法 → 用默认但 source=invalid-fallback 且带 invalidReason（不静默回退）', async () => {
    await activate('user-w-corrupt');
    const weights = await import('../../../../src/main/features/recall/catalog-ranking-weights');
    const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    await writeRecallJsonRecord('user-w-corrupt', 'catalog-ranking-weights', 'weights', {
      schemaVersion: 1,
      ownerId: 'user-w-corrupt',
      id: 'weights',
      weights: { relevance: 99, extra: 1 },
      updatedAt: new Date().toISOString(),
    } as never);
    const snapshot = await weights.getRankingWeights('user-w-corrupt');
    expect(snapshot.source).toBe('invalid-fallback');
    expect(snapshot.weights).toEqual({ relevance: 2, adoption: 0.3, scene: 0.5, maturity: 0.2 });
    expect(snapshot.invalidReason).toBeTruthy();
    // 读取不修盘：坏配置仍在（"没生效"的证据不能被销毁）。
    const again = await weights.getRankingWeights('user-w-corrupt');
    expect(again.source).toBe('invalid-fallback');
    expect(again.invalidReason).toBe(snapshot.invalidReason);
  });
});

describe('排序接线不变量（T016/T017：真实链路）', () => {
  it('采用口径：被带入（injected/agent_read/dispatched 流水与回执）不改分数；补一条 applied&&real 后名次上升', async () => {
    await activate('user-rank-adopt');
    await seedAsset('user-rank-adopt', { id: 'aa-hot', updatedAt: '2026-09-24T00:00:00Z' });
    await seedAsset('user-rank-adopt', { id: 'aa-cold', updatedAt: '2026-09-01T00:00:00Z' });
    // 「被带入」证据铺满三渠道：usage 流水（outcome）+ 注入回执（status/channel，
    // 覆盖自动注入 projection、自取 agent_read、派发 dispatched 三种带入方式）。
    const usageService = await import('../../../../src/main/features/recall/usage-service');
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const carriedIn: Array<{ outcome: string; channel?: 'projection' | 'agent_read'; status: 'injected' | 'dispatched' }> = [
      { outcome: 'injected', channel: 'projection', status: 'injected' },
      { outcome: 'agent_read', channel: 'agent_read', status: 'injected' },
      { outcome: 'dispatched', status: 'dispatched' },
    ];
    for (const [index, carried] of carriedIn.entries()) {
      await usageService.recordRecallUsage('user-rank-adopt', {
        assetId: 'aa-hot', assetVersion: '1', taskRunId: `turn-carry-${index}`,
        outcome: carried.outcome, boundary: 'real',
      });
      await injections.recordInjectionReceipt('user-rank-adopt', {
        assetId: 'aa-hot', assetVersion: '1', taskRunId: `turn-carry-${index}`,
        messageId: `msg-carry-${index}`, boundary: 'real', status: carried.status,
        ...(carried.channel ? { channel: carried.channel } : {}),
      });
    }
    // 被带入不进采用统计 → 排序仍由兜底序（updatedAt）决定：hot 在前。
    const catalog = await import('../../../../src/main/features/recall/asset-catalog');
    const stats = await catalog.loadAssetAdoptionStats('user-rank-adopt');
    expect(stats.has('aa-hot')).toBe(false);
    const before = await catalogText('user-rank-adopt');
    expect(catalogIds(before)).toEqual(['aa-hot', 'aa-cold']);
    // 展示与排序都按实际采用记账，带入不显示成「用过」。
    expect(before).not.toContain('用3次');
    expect(before).toContain('没用过');

    // 一条 applied && boundary='real' 的 usage 回执 → cold 名次上升到第一。
    await recordUsageReceipt('user-rank-adopt', { taskRunId: 'turn-apply-1', assetId: 'aa-cold', status: 'applied' });
    const after = await catalogText('user-rank-adopt');
    expect(catalogIds(after)).toEqual(['aa-cold', 'aa-hot']);
    // 只排不裁：两条都在，条目集合不变。
    expect(new Set(catalogIds(after))).toEqual(new Set(['aa-hot', 'aa-cold']));
  });

  it('同 id 回执不双计：幂等重写不加计；负反馈覆盖取末条（applied→contradicted 回落到 0）', async () => {
    await activate('user-rank-idem');
    await seedAsset('user-rank-idem', { id: 'aa-plain', updatedAt: '2026-09-24T00:00:00Z' });
    await seedAsset('user-rank-idem', { id: 'aa-twice', updatedAt: '2026-09-01T00:00:00Z' });
    await recordUsageReceipt('user-rank-idem', { taskRunId: 'turn-idem-1', assetId: 'aa-twice', status: 'applied' });
    // 同键再写一次：幂等（同 id 一行、不双计）。
    await recordUsageReceipt('user-rank-idem', { taskRunId: 'turn-idem-1', assetId: 'aa-twice', status: 'applied' });
    const jsonl = jsonlLines('user-rank-idem', 'asset-usage-receipts');
    expect(jsonl).toHaveLength(1);
    const catalog = await import('../../../../src/main/features/recall/asset-catalog');
    expect((await catalog.loadAssetAdoptionStats('user-rank-idem')).get('aa-twice')?.appliedCount).toBe(1);
    expect(catalogIds(await catalogText('user-rank-idem'))).toEqual(['aa-twice', 'aa-plain']);
    // 负反馈覆盖 append 同 id 第二行；读取取末条（contradicted）→ 不再计分。
    await recordUsageReceipt('user-rank-idem', { taskRunId: 'turn-idem-1', assetId: 'aa-twice', status: 'contradicted' });
    expect(jsonlLines('user-rank-idem', 'asset-usage-receipts')).toHaveLength(2);
    expect((await catalog.loadAssetAdoptionStats('user-rank-idem')).get('aa-twice')).toMatchObject({ appliedCount: 0, contradictedCount: 1 });
    expect(catalogIds(await catalogText('user-rank-idem'))).toEqual(['aa-plain', 'aa-twice']);
  });

  it('标签不进分（I2）：仅改盘上 tags（其它字段逐字不动）→ 目录文本逐位相同', async () => {
    await activate('user-rank-tags');
    const sameAt = '2026-09-10T00:00:00Z';
    await seedAsset('user-rank-tags', { id: 'aa-tagged', updatedAt: sameAt, tags: ['发布流程'] });
    await seedAsset('user-rank-tags', { id: 'aa-bare', updatedAt: sameAt });
    const before = await catalogText('user-rank-tags');
    // 直接改盘：只动 tags 键（updateAbilityAsset 会刷 updatedAt——那是"其它因子
    // 输入变了"，不构成本不变量的反例；I2 的字面 = 仅 tags 变、其它一切不变）。
    const { updateRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    await updateRecallJsonRecord('user-rank-tags', 'ability-assets', 'aa-tagged', (current) => ({
      ...(current || {}),
      tags: ['完全不同的标签'],
    } as never));
    const after = await catalogText('user-rank-tags');
    expect(after).toBe(before);
    // 纯函数级同证：输入带 tags（多余字段）逐位不影响输出。
    const { rankAssets } = await import('../../../../src/main/features/recall/asset-ranking');
    const W = { relevance: 1, adoption: 1, scene: 0.8, maturity: 0.4 };
    const base = [
      { id: 'aa-p', maturity: 'bud' as const, updatedAt: '2026-09-01T00:00:00Z' },
      { id: 'aa-q', maturity: 'seed' as const, updatedAt: '2026-09-02T00:00:00Z' },
    ];
    const withTags = base.map((asset, index) => ({ ...asset, tags: [`标签${index}`] }));
    expect(JSON.stringify(rankAssets({ assets: withTags, weights: W })))
      .toBe(JSON.stringify(rankAssets({ assets: base, weights: W })));
  });

  it('scene 接线（T017）：项目命中资产靠前；未匹配场景时无关联资产按其他因子排序', async () => {
    await activate('user-rank-scene');
    const sameAt = '2026-09-10T00:00:00Z';
    await seedAsset('user-rank-scene', { id: 'aa-a-plain', updatedAt: sameAt });
    await seedAsset('user-rank-scene', {
      id: 'aa-b-scoped', updatedAt: sameAt, scopePolicy: { projectIds: ['pj-alpha'] },
    });
    // 项目 A 会话：scopePolicy 命中的资产 scene=0.8 → 靠前；两条都在（只排不裁）。
    const inProject = await catalogText('user-rank-scene', { turnProjectId: 'pj-alpha' });
    expect(catalogIds(inProject)).toEqual(['aa-b-scoped', 'aa-a-plain']);
    expect(new Set(catalogIds(inProject))).toEqual(new Set(['aa-a-plain', 'aa-b-scoped']));
    // 无项目归属：项目限制不满足，只有通用资产可用。
    const noScene = await catalogText('user-rank-scene');
    expect(catalogIds(noScene)).toEqual(['aa-a-plain']);
    // 项目 B 同样不可读取项目 A 限定的资产；通用资产仍可用。
    const otherProject = await catalogText('user-rank-scene', { turnProjectId: 'pj-other' });
    expect(catalogIds(otherProject)).toEqual(['aa-a-plain']);

    // 纯排序仍只处理给定集合：项目匹配只增加 scene 因子，不制造负分。
    const { rankAssets } = await import('../../../../src/main/features/recall/asset-ranking');
    expect(rankAssets({ assets: [
      { id: 'aa-a-plain', maturity: 'bud', updatedAt: sameAt },
      { id: 'aa-b-scoped', maturity: 'bud', updatedAt: sameAt, scopePolicy: { projectIds: ['pj-alpha'] } },
    ], weights: { relevance: 1, adoption: 1, scene: 0.8, maturity: 0.4 } })
      .map((item) => item.assetId)).toEqual(['aa-a-plain', 'aa-b-scoped']);
  });

  it('读盘原文（III1）：排序构建与因子拆解不把正文/任务文本/路径写进任何回执流', async () => {
    await activate('user-rank-privacy');
    const sentinel = 'SENTINEL-RANKING-正文不得落回执';
    await seedAsset('user-rank-privacy', { id: 'aa-priv-1', statement: `${sentinel} 的资产正文。`, spaceId: 'sp-priv' });
    await recordUsageReceipt('user-rank-privacy', { taskRunId: 'turn-priv-1', assetId: 'aa-priv-1', status: 'applied' });
    const text = await catalogText('user-rank-privacy', { turnSpaceId: 'sp-priv' });
    expect(catalogIds(text)).toEqual(['aa-priv-1']);
    // 因子拆解只存因子名与数值：不含正文哨兵、不含路径分隔符。
    const { rankAssets, explainRanking } = await import('../../../../src/main/features/recall/asset-ranking');
    const explanation = explainRanking(rankAssets({
      assets: [{ id: 'aa-priv-1', maturity: 'bud', spaceId: 'sp-priv', updatedAt: '2026-09-01T00:00:00Z' }],
      adoptionStats: new Map([['aa-priv-1', { appliedCount: 1 }]]),
      scene: { turnSpaceId: 'sp-priv' },
      weights: { relevance: 1, adoption: 1, scene: 0.8, maturity: 0.4 },
    })[0]);
    const serialized = JSON.stringify(explanation);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain('/');
    // 读盘原文断言：排序链路（usage 回执 / 注入回执 / 使用流水）零额外落盘，
    // 原文不含资产正文。注入回执的 ranking 字段（T019）落地后，其原文断言在
    // 该任务的测试里补——本用例先钉死"现状不新增任何含正文的持久化"。
    for (const stream of ['asset-usage-receipts', 'injection-receipts', 'usage-records']) {
      for (const line of jsonlLines('user-rank-privacy', stream)) {
        expect(line).not.toContain(sentinel);
        expect(line).not.toContain('ranking');
      }
    }
  });

  it('采用统计按回合缓存（T016）：同回合复用快照，新回合重算，无回合直读', async () => {
    await activate('user-rank-cache');
    await seedAsset('user-rank-cache', { id: 'aa-cache-1' });
    const catalog = await import('../../../../src/main/features/recall/asset-catalog');
    catalog.resetAssetAdoptionStatsCacheForTest();
    const first = await catalog.loadAssetAdoptionStatsCached('user-rank-cache', 'turn-rk-1');
    expect(first.has('aa-cache-1')).toBe(false);
    await recordUsageReceipt('user-rank-cache', { taskRunId: 'turn-rk-2', assetId: 'aa-cache-1', status: 'applied' });
    // 同一回合：复用快照（不重扫）；新回合：重算，算上刚写入的那条；无回合直读。
    expect((await catalog.loadAssetAdoptionStatsCached('user-rank-cache', 'turn-rk-1')).has('aa-cache-1')).toBe(false);
    expect((await catalog.loadAssetAdoptionStatsCached('user-rank-cache', 'turn-rk-2')).get('aa-cache-1')?.appliedCount).toBe(1);
    expect((await catalog.loadAssetAdoptionStatsCached('user-rank-cache')).get('aa-cache-1')?.appliedCount).toBe(1);
  });
});
