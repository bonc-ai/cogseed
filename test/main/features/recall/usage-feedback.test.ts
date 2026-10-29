import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
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

  it('accepts ontology-derived citations from Semantica feedback cards', async () => {
    await appendMessage('cid-ontology', {
      id: 'msg-ontology',
      ts: new Date().toISOString(),
      from: 'commander',
      to: ['user'],
      turn_id: 'turn-ontology',
      text: 'Answer',
      recall_citations: [{
        asset_id: 'asset-ontology',
        title: 'Relation-expanded rule',
        type: 'rule',
        version: '1',
        scope: 'general',
        projection_id: 'proj-ontology',
        match_method: 'ontology',
      }],
    });
    const feedback = await import('../../../../src/main/features/recall/usage-feedback-service');
    const result = await feedback.recordRecallMessageFeedback('user-a', {
      cid: 'cid-ontology',
      messageId: 'msg-ontology',
      feedback: 'positive',
    });

    expect(result).toMatchObject({ feedback: 'positive', citationCount: 1, recordedCount: 1 });
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
    const candidate = await createNightlyCandidateFixture('user-a', {
      judgment: 'Prefer concise answers.', summary: 'Concise answer habit', suggestedType: 'personal',
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

  it('per-asset feedback records only the target asset; sibling citations stay untouched', async () => {
    await appendMessage('cid-scope', {
      id: 'msg-scope', ts: new Date().toISOString(), from: 'commander', to: ['user'],
      turn_id: 'turn-scope', text: 'Answer',
      recall_citations: [
        { asset_id: 'asset-target', title: 'Target rule', type: 'rule', version: '1', scope: 'global', projection_id: 'proj-t', match_method: 'semantic' },
        { asset_id: 'asset-bystander', title: 'Bystander rule', type: 'rule', version: '2', scope: 'global', projection_id: 'proj-b', match_method: 'semantic' },
      ],
    });
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    for (const [assetId, projectionId] of [['asset-target', 'proj-t'], ['asset-bystander', 'proj-b']] as const) {
      await injections.recordInjectionReceipt('user-a', {
        taskRunId: 'turn-scope', projectionId, assetId, assetVersion: assetId === 'asset-target' ? '1' : '2',
        boundary: 'real', status: 'injected', messageId: 'msg-scope',
      });
    }
    const feedback = await import('../../../../src/main/features/recall/usage-feedback-service');
    const usage = await import('../../../../src/main/features/recall/usage-service');
    const usageReceipts = await import('../../../../src/main/features/recall/asset-usage-receipt');

    const result = await feedback.recordRecallMessageFeedback('user-a', {
      cid: 'cid-scope', messageId: 'msg-scope', feedback: 'negative', assetId: 'asset-target',
    });

    expect(result).toMatchObject({ citationCount: 1, recordedCount: 1 });
    expect(await usage.listRecallUsage('user-a', 'asset-target')).toHaveLength(1);
    expect(await usage.listRecallUsage('user-a', 'asset-bystander')).toEqual([]);
    const receipts = await usageReceipts.listAssetUsageReceipts('user-a', 'turn-scope');
    expect(receipts.map((receipt) => receipt.assetId)).toEqual(['asset-target']);
    expect(receipts[0]).toMatchObject({ status: 'contradicted' });
    // 重复点同一资产的反馈幂等；隔壁资产依旧零记录。
    const retry = await feedback.recordRecallMessageFeedback('user-a', {
      cid: 'cid-scope', messageId: 'msg-scope', feedback: 'negative', assetId: 'asset-target',
    });
    expect(retry.recordedCount).toBe(0);
    expect(await usage.listRecallUsage('user-a', 'asset-bystander')).toEqual([]);
  });

  it('per-asset feedback counts only that asset toward the pause-recommendation threshold', async () => {
    const feedback = await import('../../../../src/main/features/recall/usage-feedback-service');
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const target = await candidates.promoteRecallCandidate('user-a', (await createNightlyCandidateFixture('user-a', {
      judgment: 'Prefer tables.', summary: 'Table habit', suggestedType: 'personal',
      suggestedScope: 'general', sourceRefs: [{ kind: 'execution', id: 'exec-s1' }],
    })).id, { actor: 'user' });
    const bystander = await candidates.promoteRecallCandidate('user-a', (await createNightlyCandidateFixture('user-a', {
      judgment: 'Prefer lists.', summary: 'List habit', suggestedType: 'personal',
      suggestedScope: 'general', sourceRefs: [{ kind: 'execution', id: 'exec-s2' }],
    })).id, { actor: 'user' });
    for (const [messageId, turnId] of [['msg-s1', 'turn-s1'], ['msg-s2', 'turn-s2']] as const) {
      await appendMessage('cid-scope2', {
        id: messageId, ts: new Date().toISOString(), from: 'commander', to: ['user'],
        turn_id: turnId, text: 'Answer',
        recall_citations: [
          { asset_id: target.asset.id, title: 'Target', type: 'personal', version: '1', scope: 'general', projection_id: 'proj-st', match_method: 'semantic' },
          { asset_id: bystander.asset.id, title: 'Bystander', type: 'personal', version: '1', scope: 'general', projection_id: 'proj-sb', match_method: 'semantic' },
        ],
      });
      await injections.recordInjectionReceipt('user-a', {
        taskRunId: turnId, projectionId: 'proj-st', assetId: target.asset.id, assetVersion: '1',
        boundary: 'real', status: 'injected', messageId,
      });
    }
    // 同一资产两次定向负反馈才触发暂停建议； bystander 只是同消息出现，不累计。
    await feedback.recordRecallMessageFeedback('user-a', { cid: 'cid-scope2', messageId: 'msg-s1', feedback: 'negative', assetId: target.asset.id });
    expect((await assets.readAbilityAsset('user-a', target.asset.id)).recommendedAction).toBeUndefined();
    await feedback.recordRecallMessageFeedback('user-a', { cid: 'cid-scope2', messageId: 'msg-s2', feedback: 'negative', assetId: target.asset.id });
    expect((await assets.readAbilityAsset('user-a', target.asset.id)).recommendedAction).toBe('pause');
    expect((await assets.readAbilityAsset('user-a', bystander.asset.id)).recommendedAction).toBeUndefined();
  });

  it('rejects per-asset feedback for an asset the message does not cite', async () => {
    await appendMessage('cid-uncited', {
      id: 'msg-uncited', ts: new Date().toISOString(), from: 'commander', to: ['user'],
      turn_id: 'turn-uncited', text: 'Answer',
      recall_citations: [{
        asset_id: 'asset-a', title: 'Rule', type: 'rule', version: '1', scope: 'global',
        projection_id: 'proj-a', match_method: 'semantic',
      }],
    });
    const feedback = await import('../../../../src/main/features/recall/usage-feedback-service');
    const usage = await import('../../../../src/main/features/recall/usage-service');

    await expect(feedback.recordRecallMessageFeedback('user-a', {
      cid: 'cid-uncited', messageId: 'msg-uncited', feedback: 'positive', assetId: 'asset-not-cited',
    })).rejects.toThrow(/not cited/i);
    expect(await usage.listRecallUsage('user-a', 'asset-a')).toEqual([]);
  });

  it.each(['two-old', 'mixed-then-two-current'] as const)('差评建议严格属于实际引用版本：%s', async scenario => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const feedback = await import('../../../../src/main/features/recall/usage-feedback-service');
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/usage-service');
    const candidate = await createNightlyCandidateFixture('user-a', { judgment: '复杂问题先给结论，再说明理由。', value: '表达顺序偏好。', summary: '复杂问题结论先行', suggestedType: 'cognition', contentCategory: 'preference', suggestedScope: 'general' });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    const append = async (key: string, version: string) => {
      const messageId = 'message-' + key, turn = 'turn-' + key, projection = 'projection-' + key;
      await appendMessage('version-feedback-chat', { id: messageId, ts: new Date().toISOString(), from: 'commander', to: ['user'], turn_id: turn, text: '隔离测试中已保存的回答',
        recall_citations: [{ asset_id: asset.id, title: asset.title, type: 'cognition', version, scope: 'general', projection_id: projection, match_method: 'manual' }] });
      await injections.recordInjectionReceipt('user-a', { taskRunId: turn, projectionId: projection, assetId: asset.id, assetVersion: version, boundary: 'real', status: 'injected', channel: 'projection', messageId });
      return () => feedback.recordRecallMessageFeedback('user-a', { cid: 'version-feedback-chat', messageId, feedback: 'negative' });
    };
    const oldFirst = await append('old-first', '1'), oldSecond = await append('old-second', '1');
    if (scenario === 'mixed-then-two-current') await oldFirst();
    await assets.updateAbilityAsset('user-a', asset.id, { statement: '复杂问题先说明假设，再给结论及原因。', actor: 'user', reason: '实际修改用户偏好正文', expectedVersion: '1', expectedActiveVersion: '1' });
    const auditBefore = await assets.listAbilityAssetAudit('user-a', asset.id);
    if (scenario === 'two-old') {
      await oldFirst(); await oldSecond();
      expect((await usage.listRecallUsage('user-a', asset.id)).filter(row => row.outcome === 'feedback_negative')).toHaveLength(2);
      expect((await assets.readAbilityAsset('user-a', asset.id)).recommendedAction).toBeUndefined();
      expect(await assets.listAbilityAssetAudit('user-a', asset.id)).toEqual(auditBefore);
    } else {
      await (await append('new-first', '2'))();
      expect((await assets.readAbilityAsset('user-a', asset.id)).recommendedAction).toBeUndefined();
      await (await append('new-second', '2'))();
      expect(await assets.readAbilityAsset('user-a', asset.id)).toMatchObject({ version: '2', recommendedAction: 'pause', status: 'active' });
      const versions = (await usage.listRecallUsage('user-a', asset.id)).filter(row => row.outcome === 'feedback_negative').map(row => row.assetVersion);
      expect(versions).toEqual(['1', '2', '2']);
    }
  });

});
