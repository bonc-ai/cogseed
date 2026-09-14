import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-recall-usage-feedback-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function appendMessage(cid: string, message: Record<string, unknown>) {
  const [storage, layout] = await Promise.all([
    import('../../../../src/main/storage'),
    import('../../../../src/main/util/project-layout'),
  ]);
  const file = layout.conversationMessageFile('user-a', cid);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await storage.appendJsonlAtomic(file, message);
}

describe('Recall message usage feedback', () => {
  it('records host-verified citations once for repeated identical feedback', async () => {
    await appendMessage('cid-a', {
      id: 'msg-assistant',
      ts: new Date().toISOString(),
      from: 'commander',
      to: ['user'],
      turn_id: 'turn-a',
      text: 'Answer',
      recall_citations: [{
        asset_id: 'asset-a',
        title: 'OAuth review rule',
        type: 'rule',
        version: '1',
        scope: 'global',
        projection_id: 'proj-a',
        match_score: 0.9,
        match_method: 'semantic',
      }],
    });
    const feedback = await import('../../../../src/main/features/recall/usage-feedback-service');
    const usage = await import('../../../../src/main/features/recall/usage-service');

    const first = await feedback.recordRecallMessageFeedback('user-a', {
      cid: 'cid-a',
      messageId: 'msg-assistant',
      feedback: 'positive',
    });
    const retry = await feedback.recordRecallMessageFeedback('user-a', {
      cid: 'cid-a',
      messageId: 'msg-assistant',
      feedback: 'positive',
    });
    const records = await usage.listRecallUsage('user-a', 'asset-a');

    expect(first).toMatchObject({ feedback: 'positive', citationCount: 1, recordedCount: 1 });
    expect(retry).toMatchObject({ feedback: 'positive', citationCount: 1, recordedCount: 0 });
    expect(records).toEqual([
      expect.objectContaining({
        assetId: 'asset-a',
        assetVersion: '1',
        taskRunId: 'turn-a',
        projectionId: 'proj-a',
        messageId: 'msg-assistant',
        boundary: 'real',
        outcome: 'feedback_positive',
      }),
    ]);
  });

  it('rejects messages without verified assistant citations', async () => {
    await appendMessage('cid-a', {
      id: 'msg-no-citations', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'Answer',
    });
    await appendMessage('cid-a', {
      id: 'msg-user', ts: new Date().toISOString(), from: 'user', to: ['commander'], text: 'Question',
      recall_citations: [{
        asset_id: 'asset-a', title: 'Forged', type: 'rule', version: '1', scope: 'global',
        projection_id: 'proj-a', match_method: 'semantic',
      }],
    });
    const feedback = await import('../../../../src/main/features/recall/usage-feedback-service');

    await expect(feedback.recordRecallMessageFeedback('user-a', {
      cid: 'cid-a', messageId: 'msg-no-citations', feedback: 'negative',
    })).rejects.toThrow(/does not contain Recall citations/i);
    await expect(feedback.recordRecallMessageFeedback('user-a', {
      cid: 'cid-a', messageId: 'msg-user', feedback: 'negative',
    })).rejects.toThrow(/assistant message/i);
  });

  it('negative feedback writes a contradicted usage receipt when the injection receipt exists (T2.2)', async () => {
    await appendMessage('cid-neg', {
      id: 'msg-neg', ts: new Date().toISOString(), from: 'commander', to: ['user'],
      turn_id: 'turn-neg', text: 'Answer',
      recall_citations: [{
        asset_id: 'asset-neg', title: 'Rule', type: 'rule', version: '1', scope: 'global',
        projection_id: 'proj-neg', match_method: 'semantic',
      }],
    });
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    await injections.recordInjectionReceipt('user-a', {
      taskRunId: 'turn-neg', projectionId: 'proj-neg', assetId: 'asset-neg', assetVersion: '1',
      boundary: 'real', status: 'injected', messageId: 'msg-neg',
    });
    const feedback = await import('../../../../src/main/features/recall/usage-feedback-service');
    const usageReceipts = await import('../../../../src/main/features/recall/asset-usage-receipt');

    await feedback.recordRecallMessageFeedback('user-a', {
      cid: 'cid-neg', messageId: 'msg-neg', feedback: 'negative',
    });

    const receipts = await usageReceipts.listAssetUsageReceipts('user-a', 'turn-neg');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: 'contradicted',
      assetId: 'asset-neg',
      evidenceKind: 'agent_action',
      injectionReceiptId: expect.stringMatching(/^inj-/),
    });
  });

  it('a second negative feedback on the same asset raises a pause recommendation (T2.2)', async () => {
    const feedback = await import('../../../../src/main/features/recall/usage-feedback-service');
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    // 真实资产（治理建议写在资产记录上，不能用裸 id）。
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Prefer concise answers.', suggestedType: 'personal',
      suggestedScope: 'general', sourceRefs: [{ kind: 'execution', id: 'exec-neg' }],
    });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    for (const [messageId, turnId] of [['msg-n1', 'turn-n1'], ['msg-n2', 'turn-n2']] as const) {
      await appendMessage('cid-neg2', {
        id: messageId, ts: new Date().toISOString(), from: 'commander', to: ['user'],
        turn_id: turnId, text: 'Answer',
        recall_citations: [{
          asset_id: asset.id, title: 'Rule', type: 'personal', version: '1', scope: 'general',
          projection_id: 'proj-n', match_method: 'semantic',
        }],
      });
      await injections.recordInjectionReceipt('user-a', {
        taskRunId: turnId, projectionId: 'proj-n', assetId: asset.id, assetVersion: '1',
        boundary: 'real', status: 'injected', messageId,
      });
    }

    await feedback.recordRecallMessageFeedback('user-a', { cid: 'cid-neg2', messageId: 'msg-n1', feedback: 'negative' });
    let current = await assets.readAbilityAsset('user-a', asset.id);
    expect(current.recommendedAction).toBeUndefined();

    await feedback.recordRecallMessageFeedback('user-a', { cid: 'cid-neg2', messageId: 'msg-n2', feedback: 'negative' });
    current = await assets.readAbilityAsset('user-a', asset.id);
    expect(current.recommendedAction).toBe('pause');
    expect(current.recommendationReason).toContain('负反馈');
    // 建议非停用：治理状态仍是 active，由人在治理页决定。
    expect(current.status).toBe('active');
  });
});
