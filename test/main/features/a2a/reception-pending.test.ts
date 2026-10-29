import { describe, expect, it } from 'vitest';
import * as chats from '../../../../src/main/features/chats';
import { listPendingReceptions } from '../../../../src/main/features/a2a/reception-service';
import { rememberPendingReception } from '../../../../src/main/features/a2a/reception-run';

/**
 * 重启后仍在等本人确认的来访（收件箱是渲染层内存，重启就丢）。
 * 重建依据只有两处持久状态：会话 marker 和会话记录。
 */
describe('a2a reception › pending after restart', () => {
  it('rebuilds a waiting visit from the marker and the local ledger', async () => {
    const cid = 'a2a-0123456789abcdef0124';
    await chats.createConversation('u1', { conversationId: cid, title: '来访' });
    await chats.updateConversation('u1', cid, {
      a2a: {
        role: 'receiver', peer_user_id: 'cs_alice', peer_name: 'Alice', state: 'waiting', exchange_id: cid,
      },
    });
    // 等待期间的原文只进会话的主进程绑定（消息记录要等开跑入队时才写）。
    await rememberPendingReception('u1', {
      conversationId: cid,
      messageId: 'amsg-pending-1',
      peerUserId: 'cs_alice',
      peerName: 'Alice',
      text: '你们的标准折扣是多少？',
    });

    const pending = await listPendingReceptions('u1');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      conversationId: cid,
      messageId: 'amsg-pending-1',
      // 恢复出来的待确认来访必须带对端账号：确认后开跑要用它认「谁在问」。
      fromAccount: 'cs_alice',
      peerName: 'Alice',
      text: '你们的标准折扣是多少？',
    });
  });

  it('ignores an active (already confirmed) visit and the initiator side', async () => {
    const active = 'a2a-0123456789abcdef0125';
    await chats.createConversation('u2', { conversationId: active, title: '已接待' });
    await chats.updateConversation('u2', active, {
      a2a: { role: 'receiver', peer_user_id: 'cs_bob', state: 'active', exchange_id: active },
    });
    await rememberPendingReception('u2', {
      conversationId: active, messageId: 'amsg-active', peerUserId: 'cs_bob', text: 'hi',
    });

    const own = 'a2a-0123456789abcdef0126';
    await chats.createConversation('u2', { conversationId: own, title: '我发起的' });
    await chats.updateConversation('u2', own, {
      a2a: { role: 'initiator', peer_user_id: 'cs_bob', state: 'waiting', exchange_id: own },
    });
    await rememberPendingReception('u2', {
      conversationId: own, messageId: 'amsg-own', peerUserId: 'cs_bob', text: 'answer',
    });

    expect(await listPendingReceptions('u2')).toEqual([]);
  });
});
