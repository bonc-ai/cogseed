import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// embedding 不可用是这条链路上唯一"查不了重"的现实情况。它必须和"查过了、
// 没有重复"区分开：两条沉淀线的 judgment 文本几乎从不逐字相同，指纹去重拦
// 不住，静默放行就会产出两条讲同一件事的正式资产。
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async () => { throw new Error('embedding model unavailable'); },
}));

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'dedup-degraded';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-dedup-degraded-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function reviewableCandidate(candidates: typeof import('../../../../src/main/features/recall/candidate-service')) {
  return candidates.saveRecallCandidate(UID, {
    judgment: '正式评审必须先讲产品模型，再谈实现细节。',
    value: '避免评审跑偏到实现细节上。',
    suggestedType: 'rule',
    applicableWhen: ['正式评审与架构决策时'],
    forbiddenWhen: ['内部快速对齐'],
    suggestedScope: 'review',
    suggestedAction: 'create',
    sourceRefs: [{ kind: 'execution', id: 'exec-dedup' }],
    evidenceRefs: [{ kind: 'execution', id: 'exec-dedup' }],
  });
}

describe('semantic dedup degradation', () => {
  it('does not require embedding when there is nothing to compare', async () => {
    const similarity = await import('../../../../src/main/features/recall/similarity');
    const outcome = await similarity.findSemanticDuplicate(UID, {
      text: '首条资产不需要执行语义查重。',
      candidateTexts: [],
      assetTexts: [],
    });

    expect(outcome).toEqual({ status: 'no_match' });
  });

  it('reports degraded rather than "no duplicate" when embedding is unavailable', async () => {
    const similarity = await import('../../../../src/main/features/recall/similarity');
    const outcome = await similarity.findSemanticDuplicate(UID, {
      text: '正式评审必须先讲产品模型。',
      candidateTexts: [{ id: 'cand-other', text: '评审要先讲产品模型再谈实现。' }],
      assetTexts: [],
    });

    expect(outcome).toEqual({ status: 'degraded', reason: 'embedding_unavailable' });
  });

  it('blocks automatic promotion instead of silently writing a possible duplicate', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    await candidates.saveRecallCandidate(UID, {
      judgment: '架构评审应先说明产品模型，再进入代码细节。',
      value: '避免架构评审过早陷入实现讨论。',
      suggestedType: 'rule',
      applicableWhen: ['正式评审与架构决策时'],
      forbiddenWhen: ['内部快速对齐'],
      suggestedScope: 'review',
      suggestedAction: 'create',
      sourceRefs: [{ kind: 'execution', id: 'exec-existing' }],
      evidenceRefs: [{ kind: 'execution', id: 'exec-existing' }],
    });
    const candidate = await reviewableCandidate(candidates);

    await expect(candidates.autoApplyRecallCandidate(UID, candidate.id))
      .rejects.toMatchObject({ code: 'semantic_dedup_unavailable' });

    // 候选没有被动过：人工确认路径仍然可用。
    const after = await candidates.readRecallCandidate(UID, candidate.id);
    expect(after.status).toBe('pending_review');
    expect(after.promotedAssetId).toBeUndefined();
  });

  it('still lets the user confirm the candidate manually', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const candidate = await reviewableCandidate(candidates);

    const { asset } = await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });
    expect(asset.type).toBe('rule');
    expect(asset.lifecycleStatus).toBe('user_confirmed_unverified');
  });

  it('opts out of the check only when the caller explicitly disables it', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const candidate = await reviewableCandidate(candidates);

    const applied = await candidates.autoApplyRecallCandidate(UID, candidate.id, { semanticDedup: false });
    expect(applied.asset?.type).toBe('rule');
  });
});
