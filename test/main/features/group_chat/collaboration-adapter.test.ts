import { expect, it, vi } from 'vitest';
import { createGroupChatCollaborationStore } from '../../../../src/main/features/group_chat/collaboration-store-adapter';

it('maps opaque control-plane scope to the existing Group Chat storage domain', async () => {
  const deps: any = { withConversationLock: vi.fn(async (_u: string, _c: string, fn: any) => fn()), readRun: vi.fn(async () => null), writeRun: vi.fn(), readContext: vi.fn(async () => null), writeContext: vi.fn(), appendEvent: vi.fn(), readEvents: vi.fn(async () => []) };
  const store = createGroupChatCollaborationStore(deps); const scope = { ownerId: 'u1', domain: 'group_chat' as const, scopeId: 'cid-1' };
  await store.withLock(scope, async () => store.readRun(scope, 'run-1'));
  expect(deps.withConversationLock).toHaveBeenCalledWith('u1', 'cid-1', expect.any(Function));
  expect(deps.readRun).toHaveBeenCalledWith('u1', 'cid-1', 'run-1');
  expect(() => store.readRun({ ...scope, domain: 'cogseed' }, 'run-1')).toThrow(/group_chat domain/);
});
