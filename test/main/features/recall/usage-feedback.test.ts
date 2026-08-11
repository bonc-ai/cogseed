import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-recall-usage-feedback-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
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
});
