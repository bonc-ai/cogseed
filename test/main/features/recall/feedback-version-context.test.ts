import { describe, expect, it, vi } from 'vitest';
import { readFeedbackVersionContext } from '../../../../src/main/features/recall/feedback-version-context';
const { read, snapshot, filter } = vi.hoisted(() => ({ read: vi.fn(), snapshot: vi.fn(), filter: vi.fn() }));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({ readAbilityAsset: read, readAbilityAssetVersionSnapshot: snapshot }));
vi.mock('../../../../src/main/features/chats', () => ({ getConversation: async () => ({ project_id: 'project-a' }) }));
vi.mock('../../../../src/main/features/recall/prompt-injection', () => ({ filterRecallAssetsForAgentRead: filter }));
const observation = { id: 'nf-a', messageId: 'reply-a', assetId: 'asset-a', assetVersion: '1', taskRunId: 'task-a', feedback: 'negative' as const, updatedAt: '2026-10-15T00:00:00Z' };
it('compares feedback about the actual old version with the already corrected current version, without declaring the current rule wrong', async () => {
  read.mockResolvedValue({ id: 'asset-a', version: '2', statement: 'Keep default; temporary brief uses the exception.', status: 'active', evidenceRefs: [] });
  snapshot.mockImplementation(async (_uid, _id, version) => ({ statement: version === '1' ? 'Always use the full report.' : 'Keep default; temporary brief uses the exception.' }));
  filter.mockImplementation(async (_uid, rows) => rows);
  const [result] = await readFeedbackVersionContext('user-a', 'conv-a', [observation]);
  expect(result).toMatchObject({ assetVersion: '1', versionContext: { status: 'historical', evaluated: { version: '1', statement: 'Always use the full report.' }, current: { version: '2', statement: 'Keep default; temporary brief uses the exception.' } } });
  expect(filter.mock.calls.every(call => call[2].projectId === 'project-a')).toBe(true);
  filter.mockResolvedValue([]);
  expect(await readFeedbackVersionContext('user-a', 'conv-a', [observation])).toEqual([{ ...observation, versionContext: { status: 'unavailable' } }]);
});
