import { beforeEach, describe, expect, it, vi } from 'vitest';
const pages = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/features/chats', () => ({ getMessagesPage: pages }));
import { findConversationMessage, findConversationMessageById } from '../../../../src/main/features/recall/conversation-message-lookup';
beforeEach(() => pages.mockReset());
describe('durable conversation message lookup', () => {
  it('finds the exact old result beyond the newest 1000 without substituting a newer answer', async () => {
    pages.mockResolvedValueOnce({ history: [{ id: 'new', from: 'commander', text: 'new answer' }], nextCursor: 200 })
      .mockResolvedValueOnce({ history: [{ id: 'old', from: 'commander', text: 'old answer' }], nextCursor: null });
    expect(await findConversationMessageById('alice', 'conversation', 'old')).toMatchObject({ id: 'old' });
    expect(pages.mock.calls).toEqual([['alice', 'conversation', 1000, undefined], ['alice', 'conversation', 1000, 200]]);
  });
  it('supports a legacy turn identity across pages and returns missing rather than unrelated text', async () => {
    pages.mockResolvedValue({ history: [{ id: 'new', turn_id: 'different', from: 'commander', text: 'new answer' }], nextCursor: null });
    expect(await findConversationMessage('alice', 'conversation', row => row.turn_id === 'old-task')).toBeUndefined();
  });
});
