/**
 * 多条关联内容的一次性处置：合并旧资产后由所属整理任务重判，或保留全部。
 *
 * 这里守的是写操作最贵的那几条不变量：版本/类型/授权边界在第一次写入前整体
 * 预检（allowPartial:false → 任何冲突零写入）；合并成功后候选仍是待处理，
 * 新建议保存时才取代旧候选；重判失败时旧候选与归并结果都原样保留并可重试。
 * 整理任务的重判由 capture-service 承担（本文件只替换它的读写边界，真实存储与
 * 资产归并都走实现）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { seedStoredAbilityAsset } from '../../../helpers/stored-ability-asset';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

const captureMock = vi.hoisted(() => ({
  records: new Map<string, any>(),
  request: vi.fn(),
}));

vi.mock('../../../../src/main/features/recall/capture-service', () => ({
  readRecallCapture: async (userId: string, captureId: string) => {
    const row = captureMock.records.get(`${userId}:${captureId}`);
    if (!row) throw new Error('recall capture not found');
    return row;
  },
  requestCaptureReformation: (userId: string, captureId: string, options: unknown) => (
    captureMock.request(userId, captureId, options)
  ),
}));

const UID = 'user-related-group';
let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  captureMock.records.clear();
  captureMock.request.mockResolvedValue({ ok: true, supersededCandidateIds: [] });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-related-group-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(async () => {
  await drainMainRuntimeForTest(UID);
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  return { candidates, assets };
}

async function seedAsset(id: string, statement: string, over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`, sourceCandidateIds: [],
    reviewDecisionId: `rd_${id.replace(/[^A-Za-z0-9]/g, '')}0000`,
    type: 'rule', title: `旧内容 ${id}`, statement, evidenceRefs: [],
    scope: 'general', status: 'active', lifecycleStatus: 'user_confirmed_unverified',
    maturity: 'seed', version: '1', createdAt: now, updatedAt: now,
    ...over,
  } as never, { actor: 'user', reason: 'synthetic related group asset' });
}

function captureFor(candidateId: string, captureId: string, over: Record<string, unknown> = {}) {
  return {
    id: captureId,
    status: 'review_ready',
    candidateIds: [candidateId],
    formationCheckpoint: { sourceProposalVersion: 1, groups: [], parsedCount: 0, emittedCount: 0 },
    ...over,
  };
}

async function ambiguousCandidate(assetIds: Array<{ assetId: string; version: string }>) {
  return createNightlyCandidateFixture(UID, {
    judgment: '确认合并后的旧内容仍适用于同一套发布核对流程。',
    value: '合并后仍按同一套核对流程执行。',
    summary: '合并后的发布核对',
    suggestedType: 'rule',
    suggestedScope: 'general',
    suggestedAction: 'create',
    sourceRefs: [{ kind: 'memory', id: 'mem-related-group' }],
    formationComparison: {
      relation: 'ambiguous',
      reason: '这条建议同时涉及多条已有内容，需要先决定是否合并。',
      relatedAssets: assetIds,
    },
  } as never);
}

async function setup() {
  await modules();
  const first = await seedAsset('aa-related-first', '发布前先确认上线范围。');
  const second = await seedAsset('aa-related-second', '发布前先确认上线范围再执行。');
  const third = await seedAsset('aa-related-third', '发布前先确认上线范围并记录。');
  const groups = [
    { assetId: first.id, version: first.version },
    { assetId: second.id, version: second.version },
    { assetId: third.id, version: third.version },
  ];
  const candidate = await ambiguousCandidate(groups);
  const captureId = String(candidate.captureProvenance?.captureId);
  captureMock.records.set(`${UID}:${captureId}`, captureFor(candidate.id, captureId));
  return { first, second, third, groups, candidate, captureId };
}

describe('resolveRelatedFormationCandidate', () => {
  it('合并其余旧内容为一份版本组，候选保持待处理并请求后台重判', async () => {
    const { candidates, assets } = await modules();
    const { first, second, third, candidate, captureId } = await setup();

    const result = await candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: first.id,
    });

    expect(result.resolved).toBe(true);
    expect(result.resolution).toBe('merged');
    expect(result.receipts.map(row => row.status).sort()).toEqual(['merged', 'merged']);
    expect((await assets.readAbilityAsset(UID, second.id)).status).toBe('archived');
    expect((await assets.readAbilityAsset(UID, third.id)).status).toBe('archived');
    expect((await assets.readAbilityAsset(UID, first.id)).version).not.toBe(first.version);
    const stored = await candidates.readRecallCandidate(UID, candidate.id);
    expect(stored.status).toBe('pending_review');
    expect(stored.relatedResolution).toMatchObject({ action: 'merged', targetAssetId: first.id });
    expect(captureMock.request).toHaveBeenCalledTimes(1);
    expect(captureMock.request).toHaveBeenCalledWith(UID, captureId, {
      candidateIds: [candidate.id], reason: 'related_merge', runNow: false,
    });
    expect(result.reformation?.status).toBe('completed');
  });

  it('重复合并幂等：不再次归并资产，也不重复请求重判', async () => {
    const { candidates, assets } = await modules();
    const { first, second, candidate } = await setup();
    const firstResult = await candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: first.id,
    });
    const targetVersion = (await assets.readAbilityAsset(UID, first.id)).version;
    const secondResult = await candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: first.id,
    });
    expect(secondResult.resolution).toBe('merged');
    expect(secondResult.receipts).toEqual(firstResult.receipts);
    expect((await assets.readAbilityAsset(UID, first.id)).version).toBe(targetVersion);
    expect((await assets.readAbilityAsset(UID, second.id)).status).toBe('archived');
    expect(captureMock.request).toHaveBeenCalledTimes(1);
    expect((await candidates.readRecallCandidate(UID, candidate.id)).status).toBe('pending_review');
  });

  it('保留全部：不写资产、不请求重判，重复调用幂等', async () => {
    const { candidates, assets } = await modules();
    const { first, second, third, candidate } = await setup();
    const before = (await assets.listAbilityAssets(UID)).map(asset => [asset.id, asset.version, asset.status]);
    const firstResult = await candidates.resolveRelatedFormationCandidate(UID, candidate.id, { action: 'keep' });
    const secondResult = await candidates.resolveRelatedFormationCandidate(UID, candidate.id, { action: 'keep' });
    expect(firstResult.resolution).toBe('kept');
    expect(firstResult.receipts).toEqual([]);
    expect(secondResult.candidate.relatedResolution?.at).toBe(firstResult.candidate.relatedResolution?.at);
    expect(secondResult.candidate.relatedResolution?.action).toBe('kept');
    expect(captureMock.request).not.toHaveBeenCalled();
    expect((await assets.listAbilityAssets(UID)).map(asset => [asset.id, asset.version, asset.status])).toEqual(before);
    for (const asset of [first, second, third]) {
      expect((await assets.readAbilityAsset(UID, asset.id)).status).toBe('active');
    }
    expect((await candidates.readRecallCandidate(UID, candidate.id)).status).toBe('pending_review');
  });

  it('版本冲突整体零写入：逐条回报原因，不写决定、不请求重判', async () => {
    const { candidates, assets } = await modules();
    const { first, second, candidate } = await setup();
    const stale = candidate.formationComparison!.relatedAssets!.map(item => (
      item.assetId === second.id ? { ...item, version: '9' } : item
    ));
    // 直接改写落盘比较证据（编辑保存会清掉比较，故用存储边界写入测试快照）。
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord(UID, 'candidates', candidate.id, current => ({
      ...current!,
      formationComparison: { ...(current!.formationComparison as object), relatedAssets: stale },
    }));
    const result = await candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: first.id,
    });
    expect(result.resolved).toBe(false);
    expect(result.resolution).toBeUndefined();
    expect(result.receipts).toEqual([{ sourceAssetId: second.id, status: 'skipped', reason: 'version_conflict' }]);
    expect((await assets.readAbilityAsset(UID, first.id)).version).toBe(first.version);
    expect((await assets.readAbilityAsset(UID, second.id)).status).toBe('active');
    expect((await candidates.readRecallCandidate(UID, candidate.id)).relatedResolution).toBeUndefined();
    expect(captureMock.request).not.toHaveBeenCalled();
  });

  it('类型或授权边界不一致时零写入并给出逐条原因', async () => {
    const { candidates, assets } = await modules();
    const { first, second, third, candidate } = await setup();
    const foreignType = await seedAsset('aa-related-floating', '另一类内容。', { type: 'personal' });
    const foreignBoundary = await seedAsset('aa-related-other-scope', '同一内容但范围不同。', { scope: 'project' });
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord(UID, 'candidates', candidate.id, current => ({
      ...current!,
      formationComparison: { ...(current!.formationComparison as object), relatedAssets: [
        { assetId: first.id, version: first.version },
        { assetId: second.id, version: second.version },
        { assetId: third.id, version: third.version },
        { assetId: foreignType.id, version: foreignType.version },
        { assetId: foreignBoundary.id, version: foreignBoundary.version },
      ] },
    }));
    const result = await candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: first.id,
    });
    expect(result.resolved).toBe(false);
    expect(result.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceAssetId: foreignType.id, reason: 'type_mismatch' }),
      expect.objectContaining({ sourceAssetId: foreignBoundary.id, reason: 'boundary_mismatch' }),
    ]));
    for (const asset of [first, second, third]) {
      expect((await assets.readAbilityAsset(UID, asset.id)).status).toBe('active');
    }
    expect((await candidates.readRecallCandidate(UID, candidate.id)).relatedResolution).toBeUndefined();
    expect(captureMock.request).not.toHaveBeenCalled();
  });

  it('目标不在关联组内、终态候选、跨捕获都安全拒绝', async () => {
    const { candidates } = await modules();
    const { first, candidate, captureId } = await setup();
    await expect(candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: 'aa-not-in-group',
    })).rejects.toMatchObject({ code: 'recall_candidate_related_group_unavailable' });
    expect(captureMock.request).not.toHaveBeenCalled();

    captureMock.records.set(`${UID}:${captureId}`, captureFor('cand-other', captureId));
    await expect(candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: first.id,
    })).rejects.toMatchObject({ code: 'recall_candidate_related_group_unavailable' });

    captureMock.records.set(`${UID}:${captureId}`, captureFor(candidate.id, captureId));
    await candidates.rejectRecallCandidate(UID, candidate.id, 'synthetic rejection');
    await expect(candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: first.id,
    })).rejects.toMatchObject({ code: 'recall_candidate_terminal' });
  });

  it('所属整理任务不能重判时，合并前就拒绝（资产零改动）', async () => {
    const { candidates, assets } = await modules();
    const { first, second, candidate, captureId } = await setup();
    captureMock.records.set(`${UID}:${captureId}`, captureFor(candidate.id, captureId, { status: 'extracting' }));
    await expect(candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: first.id,
    })).rejects.toMatchObject({ code: 'recall_candidate_related_group_unavailable' });
    expect((await assets.readAbilityAsset(UID, first.id)).version).toBe(first.version);
    expect((await assets.readAbilityAsset(UID, second.id)).status).toBe('active');
    expect(captureMock.request).not.toHaveBeenCalled();
  });

  it('重判请求失败：归并结果与旧候选都保留，可再次重试', async () => {
    const { candidates, assets } = await modules();
    const { first, second, candidate } = await setup();
    captureMock.request.mockRejectedValueOnce(new Error('capture has no source-proposal formation checkpoint'));
    const failed = await candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: first.id,
    });
    expect(failed.resolved).toBe(true);
    expect(failed.reformation).toMatchObject({ status: 'failed', error: 'capture_reformation_unavailable', retryable: true });
    const stored = await candidates.readRecallCandidate(UID, candidate.id);
    expect(stored.status).toBe('pending_review');
    expect(stored.relatedResolution?.reformation?.error).toBe('capture_reformation_unavailable');
    expect((await assets.readAbilityAsset(UID, second.id)).status).toBe('archived');

    const retried = await candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: first.id,
    });
    expect(retried.reformation).toMatchObject({ status: 'completed' });
    expect((await candidates.readRecallCandidate(UID, candidate.id)).relatedResolution?.reformation?.error).toBeUndefined();
    expect(captureMock.request).toHaveBeenCalledTimes(2);
    // 重试只重发重判请求，不会再归并一次。
    expect((await assets.readAbilityAsset(UID, second.id)).status).toBe('archived');
  });

  it('重判成功时新建议取代旧候选；再次处置按终态安全拒绝', async () => {
    const { candidates } = await modules();
    const { first, candidate } = await setup();
    captureMock.request.mockImplementationOnce(async () => {
      await candidates.supersedeRecallCandidate(UID, candidate.id, 'cand-fresh-rejudgement', '被重新核对取代');
      return { ok: true, supersededCandidateIds: [candidate.id] };
    });
    const result = await candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'merge', targetAssetId: first.id,
    });
    expect(result.resolution).toBe('merged');
    const stored = await candidates.readRecallCandidate(UID, candidate.id);
    expect(['ignored', 'superseded']).toContain(stored.status);
    expect(stored.mergedInto).toBe('cand-fresh-rejudgement');
    await expect(candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'keep',
    })).rejects.toMatchObject({ code: 'recall_candidate_terminal' });
  });

  it('相关资产只有一条或缺少整理来源时不接受处置', async () => {
    const { candidates } = await modules();
    const { first, candidate } = await setup();
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord(UID, 'candidates', candidate.id, current => ({
      ...current!,
      formationComparison: { ...(current!.formationComparison as object), relatedAssets: [{ assetId: first.id, version: first.version }] },
    }));
    await expect(candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'keep',
    })).rejects.toMatchObject({ code: 'recall_candidate_related_group_unavailable' });

    await store.updateRecallJsonRecord(UID, 'candidates', candidate.id, current => ({
      ...current!,
      formationComparison: { ...(current!.formationComparison as object), relatedAssets: [
        { assetId: first.id, version: first.version }, { assetId: 'aa-related-second', version: '1' },
      ] },
      captureProvenance: undefined,
    }));
    await expect(candidates.resolveRelatedFormationCandidate(UID, candidate.id, {
      action: 'keep',
    })).rejects.toMatchObject({ code: 'recall_candidate_related_group_unavailable' });
  });
});
