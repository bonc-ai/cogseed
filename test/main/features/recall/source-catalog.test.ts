import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  getMessages: vi.fn(),
  listContextsTreeForUser: vi.fn(),
  listExecutions: vi.fn(),
  listConnectors: vi.fn(),
  listTeachingSignals: vi.fn(),
  readArtifactMeta: vi.fn(),
}));

vi.mock('../../../../src/main/features/chats', () => ({
  listConversations: mocks.listConversations,
  getConversation: mocks.getConversation,
  getMessages: mocks.getMessages,
}));
vi.mock('../../../../src/main/features/contexts', () => ({
  listContextsTreeForUser: mocks.listContextsTreeForUser,
}));
vi.mock('../../../../src/main/features/execution-records', () => ({ list: mocks.listExecutions }));
vi.mock('../../../../src/main/features/chat_artifacts', () => ({ readArtifactMeta: mocks.readArtifactMeta }));
vi.mock('../../../../src/main/features/connectors', () => ({ listInstances: mocks.listConnectors }));
vi.mock('../../../../src/main/features/connectors/types', () => ({
  isConnectorUsable: (status: { kind?: string }) => status?.kind === 'connected' || status?.kind === 'degraded',
}));
vi.mock('../../../../src/main/features/recall/teaching-service', () => ({
  listUserTeachingSignals: mocks.listTeachingSignals,
}));

import {
  COGNITION_CATALOG_KINDS,
  cognitionArtifactSourceId,
  cognitionMessageSourceId,
  listCognitionSources,
} from '../../../../src/main/features/recall/source-catalog';

const conversation = {
  conversation_id: 'conv-a',
  title: 'Planning session',
  kind: 'normal',
  agent_id: '',
  skill_id: '',
  session_id: 'gconv-conv-a',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:10:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listConversations.mockResolvedValue([conversation]);
  mocks.getConversation.mockResolvedValue(conversation);
  mocks.getMessages.mockResolvedValue([
    {
      id: 'raw-message-id',
      ts: '2026-08-01T00:01:00.000Z',
      from: 'user',
      to: ['commander'],
      text: 'token=do-not-copy',
      attachments: ['/private/absolute/file.txt'],
      process: [{ type: 'progress', text: 'secret process output' }],
      artifacts: [{ id: 'artifact-a', title: 'Result board', agent_id: 'commander' }],
    },
  ]);
  mocks.listContextsTreeForUser.mockReturnValue([
    { name: 'private.md', path: 'folder/private.md', type: 'file', bytes: 10, mtime: 1 },
  ]);
  mocks.listExecutions.mockResolvedValue([
    {
      executionId: 'exec-a',
      uid: 'user-a',
      kind: 'core-agent',
      sessionId: 'gconv-conv-a',
      conversationId: 'conv-a',
      status: 'completed',
      boundary: 'real',
      permissionMode: 'default',
      artifactIds: [],
      startedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:02:00.000Z',
    },
  ]);
  mocks.listConnectors.mockReturnValue([
    { id: 'github-work', display_name: 'GitHub Work', status: { kind: 'connected', since: 1 }, tools_cached_at: 2 },
  ]);
  mocks.listTeachingSignals.mockResolvedValue([
    { id: 'teach-a', conversationId: 'conv-a', messageId: 'raw-message-id', intent: 'remember', scope: 'personal', status: 'active', summary: 'Use concise replies', candidateIds: ['cand-a'], createdAt: '2026-08-01T00:02:00.000Z' },
  ]);
  mocks.readArtifactMeta.mockReturnValue({ title: 'Result board', agentId: 'commander', createdAt: '' });
});

describe('Recall cognition source catalog', () => {
  it('lists every non-KSTAR adapter with stable metadata-only references', async () => {
    const groups = await listCognitionSources('user-a', { limit: 25 });

    expect(groups.map((group) => group.kind)).toEqual([...COGNITION_CATALOG_KINDS]);
    expect(groups.every((group) => group.status === 'ready')).toBe(true);
    expect(groups).toHaveLength(5);
    expect(groups.find((group) => group.kind === 'conversation')?.items.find((item) => item.subtype === 'message')?.id)
      .toBe(cognitionMessageSourceId('conv-a', 'raw-message-id'));
    expect(groups.find((group) => group.kind === 'artifact_file')?.items.find((item) => item.subtype === 'artifact')?.id)
      .toBe(cognitionArtifactSourceId('conv-a', 'artifact-a'));
    expect(groups.find((group) => group.kind === 'authorized_external_system')?.items[0])
      .toMatchObject({ subtype: 'connector_record', authorizationRef: expect.stringMatching(/^auth-/) });

    const serialized = JSON.stringify(groups);
    expect(serialized).not.toContain('do-not-copy');
    expect(serialized).not.toContain('/private/absolute');
    expect(serialized).not.toContain('folder/private.md');
    expect(serialized).not.toContain('secret process output');
    expect(groups.some((group) => group.kind === ('memory' as never))).toBe(false);
    expect(groups.some((group) => group.kind === ('ontology' as never))).toBe(false);
  });

  it('applies conversation filtering only to conversation-bound adapters', async () => {
    const groups = await listCognitionSources('user-a', {
      conversationId: 'conv-a',
      kinds: ['conversation', 'execution_evaluation', 'user_teaching_signal'],
      limit: 5,
    });

    expect(mocks.getConversation).toHaveBeenCalledWith('user-a', 'conv-a');
    expect(groups.find((group) => group.kind === 'conversation')?.count).toBe(2);
    expect(groups.find((group) => group.kind === 'execution_evaluation')?.count).toBe(2);
    expect(groups.find((group) => group.kind === 'user_teaching_signal')?.count).toBe(1);
  });

  it('exposes only authorized usable connector instances with authorization refs', async () => {
    mocks.listConnectors.mockReturnValueOnce([
      { id: 'connected', display_name: 'Connected', status: { kind: 'connected', since: 1 }, tools_cached_at: 2 },
      { id: 'degraded', display_name: 'Degraded', status: { kind: 'degraded', message: 'temporary', at: 2 }, tools_cached_at: 1 },
      { id: 'disconnected', display_name: 'Disconnected', status: { kind: 'disconnected' }, tools_cached_at: 0 },
      { id: 'connecting', display_name: 'Connecting', status: { kind: 'connecting' }, tools_cached_at: 0 },
      { id: 'unauthorized', display_name: 'Unauthorized', status: { kind: 'error', message: 'connector_unauthorized', at: 3 }, tools_cached_at: 0 },
    ]);

    const [external] = await listCognitionSources('user-a', { kinds: ['authorized_external_system'] });

    expect(external.items).toHaveLength(2);
    expect(external.items.every((item) => item.authorizationRef?.startsWith('auth-'))).toBe(true);
    expect(JSON.stringify(external)).not.toContain('Disconnected');
    expect(JSON.stringify(external)).not.toContain('Connecting');
    expect(JSON.stringify(external)).not.toContain('Unauthorized');
  });

  it('degrades one failed adapter without suppressing healthy source groups', async () => {
    mocks.listConnectors.mockImplementationOnce(() => { throw new Error('unreadable connector index'); });
    const groups = await listCognitionSources('user-a', { kinds: ['authorized_external_system', 'artifact_file'] });

    expect(groups).toEqual([
      { kind: 'authorized_external_system', status: 'degraded', count: 0, items: [], reason: 'source_unavailable' },
      expect.objectContaining({ kind: 'artifact_file', status: 'ready', count: 2 }),
    ]);
  });
});
