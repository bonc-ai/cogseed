import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/main/features/recall/store-events', () => ({ notifyCognitionWrite: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const userId = 'po-candidate-transfer-user';
let root: string, previousRoot: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-po-candidate-transfer-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('旧个人本体候选仅保留历史，不再转入认知生产链', () => {
  it('旧确认与转移导出不存在，读取不会消费候选或生成新认知', async () => {
    const po = await import('../../../src/main/features/personal_ontology_candidates');
    const recall = await import('../../../src/main/features/recall/candidate-service');
    const candidate = { candidate_id: 'legacy-po-relation', kind: 'relation' as const, confidence: 'high' as const,
      summary: '项目负责人', memory_scope: 'shared' as const, memory_text: '项目负责人需核对来源。', source_memory_refs: ['source-note-1'] };
    await po.addCandidate(userId, candidate);
    const before = fs.readFileSync(po.candidatesMdPath(userId), 'utf8');
    expect(po).not.toHaveProperty('confirmCandidate');
    expect(po).not.toHaveProperty('transferCandidateToRecall');
    expect((await po.listCandidates(userId)).candidate_updates[0].candidate_id).toBe(candidate.candidate_id);
    expect(fs.readFileSync(po.candidatesMdPath(userId), 'utf8')).toBe(before);
    expect(await recall.listRecallCandidates(userId)).toEqual([]);
    expect(await (await import('../../../src/main/features/recall/asset-service')).listAbilityAssets(userId)).toEqual([]);
  });

  it('legacy JSON所有状态原样保留，只读历史不补写memory、不rename源文件', async () => {
    const po = await import('../../../src/main/features/personal_ontology_candidates');
    const recall = await import('../../../src/main/features/recall/candidate-service');
    const paths = await import('../../../src/main/paths');
    const legacyFile = path.join(path.dirname(po.candidatesMdPath(userId)), 'candidates.json');
    const legacy = { candidate_updates: ['pending', 'confirmed', 'rejected'].map(status => ({ candidate_id: 'legacy-'+status,
      kind: 'preference', confidence: 'high', status, diff_summary: '旧版偏好原文 '+status, identity_scope_decision: 'personal_global' })) };
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    const before = JSON.stringify(legacy, null, 2); fs.writeFileSync(legacyFile, before);
    expect((await po.listCandidates(userId)).candidate_updates.map(row => row.candidate_id)).toEqual(['legacy-pending', 'legacy-confirmed', 'legacy-rejected']);
    expect(fs.readFileSync(legacyFile, 'utf8')).toBe(before);
    expect(fs.existsSync(legacyFile+'.bak')).toBe(false);
    expect(fs.existsSync(po.candidatesMdPath(userId))).toBe(false);
    expect(fs.existsSync(paths.userProfileFile(userId))).toBe(false);
    expect(fs.existsSync(paths.userMemoryFile(userId))).toBe(false);
    expect(await (await import('../../../src/main/features/recall/asset-service')).listAbilityAssets(userId)).toEqual([]);
  });
  it('旧个人上下文审批与拒绝函数明确关闭，不走任何候选写回', async () => {
    const application = await import('../../../src/main/features/personal_context/application');
    await expect(application.approveReviewItem(userId, 'old-candidate')).rejects.toThrow('legacy_candidate_approval_retired');
    await expect(application.rejectReviewItem(userId, 'old-candidate')).rejects.toThrow('legacy_candidate_review_retired');
  });

});
