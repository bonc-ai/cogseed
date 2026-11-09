import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedStoredAbilityAsset } from '../../../helpers/stored-ability-asset';

const mocks = vi.hoisted(() => ({ requestCaptureReformation: vi.fn() }));
vi.setConfig({ testTimeout: 15_000 });

vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));
vi.mock('../../../../src/main/features/recall/capture-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/recall/capture-service')>();
  return { ...actual, requestCaptureReformation: mocks.requestCaptureReformation };
});

const USER_BASE = 'user-related-overflow';
let USER = USER_BASE;
let CAPTURE = 'capture-overflow';
let RELATED_IDS = ['asset-one', 'asset-two', 'asset-three', 'asset-four', 'asset-five', 'asset-six', 'asset-seven'];
const NOW = '2026-10-28T03:00:00.000Z';

let tmpDir: string;
let previousRoot: string | undefined;
let sequence = 0;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-related-overflow-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterAll(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  sequence += 1;
  USER = `${USER_BASE}-${sequence}`;
  CAPTURE = `capture-overflow-${sequence}`;
  RELATED_IDS = ['asset-one', 'asset-two', 'asset-three', 'asset-four', 'asset-five', 'asset-six', 'asset-seven'];
  mocks.requestCaptureReformation.mockResolvedValue({
    ok: true,
    capture: { id: CAPTURE, status: 'queued' },
    supersededCandidateIds: [],
  });
});
afterEach(() => {
  vi.clearAllMocks();
});

async function modules() {
  const [service, store] = await Promise.all([
    import('../../../../src/main/features/recall/related-overflow-service'),
    import('../../../../src/main/features/recall/store'),
  ]);
  return { service, store };
}

async function seedAsset(id: string, input: { type?: string; status?: string; title?: string; version?: string } = {}) {
  const reviewId = `rd_${id.replace(/[^a-z0-9]/gi, '').slice(0, 8).padEnd(8, 'x')}`;
  return seedStoredAbilityAsset(USER, {
    schemaVersion: 2,
    ownerId: USER,
    id,
    candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`],
    reviewDecisionId: reviewId,
    type: input.type || 'personal',
    title: input.title || `关联条目 ${id}`,
    statement: `关联正文 ${id}。`,
    evidenceRefs: [],
    scope: 'general',
    status: input.status || 'active',
    lifecycleStatus: 'user_confirmed_unverified',
    maturity: 'bud',
    version: input.version || '1',
    createdAt: NOW,
    updatedAt: NOW,
  }, { actor: 'user', reason: 'related overflow seed' });
}

async function seedCapture(patch: Record<string, unknown> = {}) {
  const { store } = await modules();
  await store.writeRecallJsonRecord(USER, 'captures', CAPTURE, {
    schemaVersion: 2,
    ownerId: USER,
    id: CAPTURE,
    taxonomyVersion: 2,
    status: 'review_ready',
    executionPolicy: 'manual',
    conversationId: 'conv-overflow',
    conversationTitle: '季度复盘',
    terminalRunId: 'turn-overflow',
    anchorMessageId: 'msg-overflow',
    messageIds: ['msg-overflow'],
    candidateIds: [],
    attempt: 1,
    createdAt: NOW,
    updatedAt: NOW,
    candidateSupportUnavailable: [{
      candidateIndex: 0,
      stage: 'grounding',
      reason: 'related_assets_overflow',
      candidateHash: 'a'.repeat(64),
      relatedAssetIds: RELATED_IDS,
    }],
    formationCheckpoint: {
      sourceProposalVersion: 1,
      sourceScope: { projectId: 'project-a', workspaceId: 'space-a' },
      groups: [],
      parsedCount: 1,
      emittedCount: 0,
    },
    ...patch,
  });
}

async function seedSweep(patch: Record<string, unknown> = {}) {
  const { store } = await modules();
  await store.writeRecallJsonRecord(USER, 'capture-sweep', 'nightly', {
    schemaVersion: 2,
    ownerId: USER,
    id: 'nightly',
    baselineAt: NOW,
    cursors: {},
    lastRunAt: NOW,
    lastResult: {
      pipelineVersion: 3,
      reviewDay: '2026-10-27',
      ranForWindow: NOW,
      finishedAt: NOW,
      scanned: 1,
      queued: 1,
      deferred: 0,
      retried: 0,
      skipped: 0,
      failed: 1,
    },
    receipt: {
      runId: 'run-overflow',
      captureIds: [CAPTURE],
      candidateIds: [],
      findingKeys: [],
      items: [{
        captureId: CAPTURE,
        conversationId: 'conv-overflow',
        status: 'failed',
        errorCode: 'related_assets_overflow',
        candidateIds: [],
        relatedAssetIds: RELATED_IDS,
        failures: [{ candidateIndex: 0, stage: 'grounding', reason: 'related_assets_overflow', relatedAssetIds: RELATED_IDS }],
      }],
    },
    ...patch,
  });
}

async function seedSevenAssets() {
  for (const id of RELATED_IDS.slice(0, 6)) await seedAsset(id, id === 'asset-two' ? { version: '2' } : {});
  await seedAsset('asset-seven', { status: 'paused' });
}

describe('关联超过上限清单与处置', () => {
  it('列出 7 条关联资产名称与在用版本，并标出不可读取项', async () => {
    await seedSevenAssets();
    await seedCapture();
    await seedSweep();
    const { service } = await modules();
    const listed = await service.listRelatedOverflow(USER, { runId: 'run-overflow' });
    expect(listed.runId).toBe('run-overflow');
    expect(listed.items).toHaveLength(1);
    const item = listed.items[0];
    expect(item).toMatchObject({ captureId: CAPTURE, conversationId: 'conv-overflow', conversationTitle: '季度复盘', candidateIndex: 0 });
    expect(item.relatedAssetIds).toEqual(RELATED_IDS);
    expect(item.assets).toHaveLength(7);
    expect(item.assets.map(asset => asset.title)).toEqual(RELATED_IDS.map(id => `关联条目 ${id}`));
    expect(item.assets.find(asset => asset.id === 'asset-two')?.version).toBe('2');
    expect(item.assets.find(asset => asset.id === 'asset-seven')).toMatchObject({ status: 'paused', readable: false });
    expect(item.assets.filter(asset => asset.readable).map(asset => asset.id)).toEqual(RELATED_IDS.slice(0, 6));
    // 不泄露正文
    expect(JSON.stringify(listed)).not.toContain('关联正文');
    expect(item.reformation.status).toBe('none');
  });

  it('合并兼容内容，跨类型项跳过，并记录处置与重判请求', async () => {
    await seedSevenAssets();
    await seedAsset('asset-rule', { type: 'rule', title: '规则条目' });
    await seedCapture({
      candidateSupportUnavailable: [{
        candidateIndex: 0, stage: 'grounding', reason: 'related_assets_overflow', candidateHash: 'a'.repeat(64),
        relatedAssetIds: [...RELATED_IDS.slice(0, 6), 'asset-rule'],
      }],
    });
    await seedSweep();
    const { service, store } = await modules();
    const assets = await import('../../../../src/main/features/recall/asset-service');

    const result = await service.resolveRelatedOverflow(USER, {
      captureId: CAPTURE, candidateIndex: 0, action: 'merge', targetAssetId: 'asset-one',
    });
    expect(result.ok).toBe(true);
    expect(result.merge?.merged).toBe(5);
    expect(result.merge?.skipped).toBe(1);
    expect(result.merge?.receipts.find(row => row.sourceAssetId === 'asset-rule')).toMatchObject({ status: 'skipped', reason: 'type_mismatch' });
    expect(result.reformation.status).toBe('running');
    expect(mocks.requestCaptureReformation).toHaveBeenCalledWith(USER, CAPTURE, {
      groupIndexes: [0], reason: 'related_overflow', runNow: false,
    });
    expect((await assets.readAbilityAsset(USER, 'asset-two')).mergedIntoAssetId).toBe('asset-one');
    expect((await assets.readAbilityAsset(USER, 'asset-rule')).status).toBe('active');

    const capture = await store.readRecallJsonRecord(USER, 'captures', CAPTURE) as any;
    const resolution = capture?.candidateSupportUnavailable?.[0]?.relatedResolution;
    expect(resolution).toMatchObject({ action: 'merged', targetAssetId: 'asset-one' });
    expect(resolution?.receipts).toHaveLength(6);
    expect(JSON.stringify(resolution)).not.toContain('关联正文');
  });

  it('保留全部只写处置，不合并也不建候选', async () => {
    await seedSevenAssets();
    await seedCapture();
    await seedSweep();
    const { service, store } = await modules();
    const assets = await import('../../../../src/main/features/recall/asset-service');

    const result = await service.resolveRelatedOverflow(USER, { captureId: CAPTURE, candidateIndex: 0, action: 'keep' });
    expect(result.ok).toBe(true);
    expect(result.alreadyResolved).toBe(false);
    expect(result.resolution?.action).toBe('kept');
    expect(mocks.requestCaptureReformation).not.toHaveBeenCalled();
    expect((await assets.readAbilityAsset(USER, 'asset-two')).status).toBe('active');
    const capture = await store.readRecallJsonRecord(USER, 'captures', CAPTURE) as any;
    expect(capture?.candidateIds).toEqual([]);
    expect(capture?.candidateSupportUnavailable?.[0]?.relatedResolution).toMatchObject({ action: 'kept' });

    const repeated = await service.resolveRelatedOverflow(USER, { captureId: CAPTURE, candidateIndex: 0, action: 'keep' });
    expect(repeated).toMatchObject({ ok: true, alreadyResolved: true });
    expect(mocks.requestCaptureReformation).not.toHaveBeenCalled();
  });

  it('合并后重判失败可重试，且不会重复合并', async () => {
    await seedSevenAssets();
    await seedCapture();
    await seedSweep();
    const { service } = await modules();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    mocks.requestCaptureReformation.mockRejectedValueOnce(new Error('capture is not in a reformable state'));

    const first = await service.resolveRelatedOverflow(USER, {
      captureId: CAPTURE, candidateIndex: 0, action: 'merge', targetAssetId: 'asset-one',
    });
    expect(first.ok).toBe(true);
    expect(first.reformation.status).toBe('failed');
    const targetAfterFirst = await assets.readAbilityAsset(USER, 'asset-one');
    const stored = await (await modules()).store.readRecallJsonRecord(USER, 'captures', CAPTURE) as any;
    const resolutionAfterFirst = stored?.candidateSupportUnavailable?.[0]?.relatedResolution;
    expect(resolutionAfterFirst?.action).toBe('merged');

    const listed = await service.listRelatedOverflow(USER);
    expect(listed.items[0].reformation).toMatchObject({ status: 'failed', error: 'reformation_not_completed' });

    mocks.requestCaptureReformation.mockResolvedValueOnce({
      ok: true, capture: { id: CAPTURE, status: 'queued' }, supersededCandidateIds: [],
    });
    const retried = await service.resolveRelatedOverflow(USER, {
      captureId: CAPTURE, candidateIndex: 0, action: 'merge', targetAssetId: 'asset-one',
    });
    expect(retried).toMatchObject({ ok: true, alreadyResolved: true, reformation: { status: 'running' } });
    expect(retried.merge).toBeUndefined();
    expect((await assets.readAbilityAsset(USER, 'asset-one')).version).toBe(targetAfterFirst.version);
    expect(mocks.requestCaptureReformation).toHaveBeenCalledTimes(2);
  });

  it('校验合并目标必须在清单内且可读', async () => {
    await seedSevenAssets();
    await seedCapture();
    await seedSweep();
    const { service } = await modules();

    await expect(service.resolveRelatedOverflow(USER, {
      captureId: CAPTURE, candidateIndex: 0, action: 'merge', targetAssetId: 'asset-unlisted',
    })).rejects.toMatchObject({ code: 'target_not_listed' });
    await expect(service.resolveRelatedOverflow(USER, {
      captureId: CAPTURE, candidateIndex: 0, action: 'merge', targetAssetId: 'asset-seven',
    })).rejects.toMatchObject({ code: 'target_unreadable' });
    expect(mocks.requestCaptureReformation).not.toHaveBeenCalled();
  });

  it('runId 不匹配时不把旧回执当成待处理项', async () => {
    await seedSevenAssets();
    await seedCapture();
    await seedSweep();
    const { service } = await modules();
    const listed = await service.listRelatedOverflow(USER, { runId: 'run-previous' });
    expect(listed).toMatchObject({ runId: 'run-overflow', items: [], stale: true });
  });

  it('没有冻结源提案的旧捕获只能保留，合并前就拒绝且零写入', async () => {
    await seedSevenAssets();
    // 旧版本的检查点没有 sourceProposalVersion，无法重判合并后的建议。
    await seedCapture({ formationCheckpoint: {
      sourceScope: { projectId: 'project-a', workspaceId: 'space-a' },
      groups: [], parsedCount: 1, emittedCount: 0,
    } });
    await seedSweep();
    const { service } = await modules();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const before = await assets.readAbilityAssets(USER, ['asset-one', 'asset-two', 'asset-three']);
    const listed = await service.listRelatedOverflow(USER);
    expect(listed.items[0]).toMatchObject({ reformable: false });
    await expect(service.resolveRelatedOverflow(USER, {
      captureId: CAPTURE, candidateIndex: 0, action: 'merge', targetAssetId: 'asset-one',
    })).rejects.toMatchObject({ code: 'capture_not_reformable' });
    expect(mocks.requestCaptureReformation).not.toHaveBeenCalled();
    const after = await assets.readAbilityAssets(USER, ['asset-one', 'asset-two', 'asset-three']);
    expect(after.map(asset => [asset.id, asset.status, asset.version]))
      .toEqual(before.map(asset => [asset.id, asset.status, asset.version]));
  });
});
