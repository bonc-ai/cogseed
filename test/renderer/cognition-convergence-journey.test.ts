import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNightlyCandidateFixture } from '../helpers/nightly-formation-fixture';
import { loadCognitionAssets, renderCognition } from './helpers/cognition-renderer';

let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-convergence-journey-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

// Real persistence/admission services with an isolated user. Model effectiveness is deliberately not invented.
describe('明确保存到任务读取再暂停的完整链路', () => {
  it('renderer action saves once, task records the exact version, pause blocks subsequent reads while history survives', async () => {
    const candidates = await import('../../src/main/features/recall/candidate-service');
    const assets = await import('../../src/main/features/recall/asset-service');
    const admission = await import('../../src/main/features/recall/prompt-injection');
    const accounting = await import('../../src/main/features/recall/agent-read-accounting');
    const injections = await import('../../src/main/features/recall/injection-receipt');
    const usage = await import('../../src/main/features/recall/asset-usage-receipt');
    const uid = 'journey-user';
    const candidate = await createNightlyCandidateFixture(uid, { summary: '报告文件格式', judgment: '团队报告统一使用 Markdown 格式。',
      value: '后续报告沿用统一格式', suggestedType: 'fact', suggestedScope: 'general', suggestedAction: 'create', sourceRefs: [] });
    const invoke = vi.fn(async (channel: string, args: any) => {
      if (channel === 'recall.candidates.promote') return { ok: true, ...await candidates.promoteRecallCandidate(uid, args.candidateId, { actor: 'user' }) };
      return { ok: true };
    });
    const loaded = loadCognitionAssets({ candidates: [{ ...candidate, capabilities: { countsAsPending: true, canEdit: true, canPromote: true, canReject: true } }] }, { name: 'activity', candidateId: candidate.id }, { cogseed: { invoke } });
    loaded.ns.reload = async () => {};
    await loaded.ns.actions.adoptCandidate(candidate.id);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'recall.candidates.promote')).toHaveLength(1);
    const assetId = (await candidates.readRecallCandidate(uid, candidate.id)).promotedAssetId!;
    expect(assetId).toBeTruthy();
    const asset = await assets.readAbilityAsset(uid, assetId);
    expect(asset.statement).toBe('团队报告统一使用 Markdown 格式。');
    expect((await candidates.listRecallCandidates(uid)).filter(c => c.status === 'confirmed')).toHaveLength(1);
    expect(await admission.filterRecallAssetsForAgentRead(uid, [asset], { taskText: '准备团队报告' })).toHaveLength(1);
    await accounting.recordAssetAgentReads({ userId: uid, turnId: 'turn-journey' }, [{ assetId, assetVersion: asset.activeVersion || asset.version }]);
    const reads = await injections.listInjectionReceipts(uid, 'turn-journey');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ assetId, assetVersion: asset.activeVersion || asset.version, channel: 'agent_read', status: 'injected' });
    expect(await usage.listAssetUsageReceipts(uid, 'turn-journey')).toEqual([]);
    await assets.pauseAbilityAsset(uid, assetId, { actor: 'user', reason: '暂停后续使用' });
    const paused = await assets.readAbilityAsset(uid, assetId);
    expect(await admission.filterRecallAssetsForAgentRead(uid, [paused], { taskText: '准备团队报告' })).toEqual([]);
    expect((await injections.listInjectionReceipts(uid, 'turn-journey'))[0].assetVersion).toBe(reads[0].assetVersion);
    expect(await assets.listAbilityAssetVersions(uid, assetId)).not.toHaveLength(0);
  });
});

describe('检查报告与来源状态的真实页面契约', () => {
  it('current reports state that nothing changed; historical applied reports retain recovery controls', () => {
    const current = renderCognition({ name: 'cleanup' }, { cleanupReports: { reports: [{ id: 'new-check', mode: 'report_only', round: 'rules', createdAt: '2026-10-08T00:00:00Z', items: [], uncertain: [] }] } });
    expect(current).toContain('没有修改资产或候选');
    expect(current).not.toContain('本轮自动完成');
    const historical = renderCognition({ name: 'cleanup' }, { cleanupReports: { reports: [{ id: 'old-check', round: 'full', createdAt: '2026-09-29T00:00:00Z', items: [{ assetId: 'asset-old', kind: 'title_normalized', status: 'applied', before: '旧', after: '新', reason: '历史', rollbackAnchor: '1' }], uncertain: [] }] } });
    expect(historical).toContain('data-act="rollback-cleanup-item"');
    expect(historical).toContain('本轮自动完成');
  });

  it('unknown source does not claim that a parent conversation was deleted', () => {
    const html = renderCognition({ name: 'review', candidateId: 'candidate-source' }, { candidates: [{ id: 'candidate-source', status: 'pending_review', suggestedType: 'fact', judgment: '团队报告统一使用 Markdown 格式。', summary: '报告格式', suggestedScope: 'general', evidenceRefs: [{ kind: 'conversation', id: 'message-unresolved' }], capabilities: { countsAsPending: true, canConfirm: true, canEdit: true } }] });
    expect(html).toContain('来源待核对');
    expect(html).not.toContain('来源已删');
    expect(html).not.toContain('来源记录已被删除');
  });
});
