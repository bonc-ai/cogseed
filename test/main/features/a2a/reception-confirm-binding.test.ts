import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 确认/拒绝必须绑定到用户实际看到的那条 pending（P2-10）。
 *
 * P1-1 之后，过期的旧问题 Q1 会被新问题 Q2 替换并重开 waiting。用户若已经打开
 * Q1 的确认入口，旧实现只带 conversationId，主进程会去确认**当前** pending，于是
 * 对 Q1 的点击变成了对 Q2 的确认（拒绝同理）。这里钉住主进程契约：
 *
 * - 首次确认/拒绝提供 expectedMessageId 时必须等于本条 pending.messageId，
 *   否则返回 `reception_stale_pending`，且在任何联系人/预览/mkdir/写入之前拒绝；
 * - 已 claimed 的重复确认仍可恢复，但提供的 id 不一致同样拒绝；
 * - 缺省 expectedMessageId 保持旧调用方兼容（不绑定）。
 */
const U = 'cs_receiver_binding';
const PEER = 'cs_alice';
const CID = 'a2a-0123456789abcdef0301';
const Q1 = 'amsg-binding-old';
const Q2 = 'amsg-binding-new';
const Q1_TEXT = '旧问题：这周还能下单吗？';
const Q2_TEXT = '新问题：过期之后的价格还有效吗？';
const MINUTE = 60 * 1000;

let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-binding-')));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(U), {
    version: 1,
    contacts: [{ userId: PEER, name: 'Alice', addedAt: new Date().toISOString() }],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 会话里直接种一条等待确认的来访（Q1）。 */
async function seedWaiting(messageId: string, receivedAt: string, text: string): Promise<void> {
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(U, { conversationId: CID, title: 'Alice 的来访' });
  await chats.updateConversation(U, CID, {
    a2a: { inbound: true, peer_user_id: PEER, peer_name: 'Alice', state: 'waiting', exchange_id: CID },
    a2a_pending_reception: {
      messageId,
      conversationId: CID,
      peerUserId: PEER,
      peerName: 'Alice',
      text,
      receivedAt,
      state: 'pending',
    },
  });
}

/** 真实 P1-1 路径：Q1 过期清理后，同 CID 再来 Q2，pending 被替换并重开 waiting。 */
async function reopenWithNewQuestion(): Promise<void> {
  const service = await import('../../../../src/main/features/a2a/reception-service');
  const oldReceivedAt = new Date(Date.now() - 11 * MINUTE).toISOString();
  await expect(service.handleInboundQuestion(U, {
    messageId: Q1, conversationId: CID, fromAccount: PEER, text: Q1_TEXT, createdAt: oldReceivedAt,
  })).resolves.toMatchObject({ accepted: true });
  expect(await service.expireStaleReceptions(U)).toEqual({ expired: 1, scrubbed: 1 });
  const newReceivedAt = new Date().toISOString();
  await expect(service.handleInboundQuestion(U, {
    messageId: Q2, conversationId: CID, fromAccount: PEER, text: Q2_TEXT, createdAt: newReceivedAt,
  })).resolves.toMatchObject({ accepted: true, outcome: { awaitingConfirmation: true } });
  const chats = await import('../../../../src/main/features/chats');
  expect((await chats.getConversation(U, CID))?.a2a_pending_reception)
    .toMatchObject({ messageId: Q2, text: Q2_TEXT, state: 'pending' });
}

async function expectedPreviewFor(cid: string) {
  const service = await import('../../../../src/main/features/a2a/reception-service');
  const preview = await service.previewReceptionWorkspace(U, { conversationId: cid });
  expect('preview' in preview).toBe(true);
  return 'preview' in preview ? preview.preview : undefined;
}

describe('a2a reception › decision binds to the pending row the user saw', () => {
  it('rejects a confirmation naming a different pending row before any side effect', async () => {
    await seedWaiting(Q1, new Date(Date.now() - MINUTE).toISOString(), Q1_TEXT);
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const { readState } = await import('../../../../src/main/features/group_chat/state');
    const { readReceptionLedger } = await import('../../../../src/main/features/a2a/reception-ledger');
    const chats = await import('../../../../src/main/features/chats');
    const setCodingProjectDir = vi.fn(async () => {});

    const result = await service.confirmReception(U, {
      conversationId: CID,
      expectedPreview: await expectedPreviewFor(CID),
      expectedMessageId: Q2,
    }, { setCodingProjectDir });

    expect(result).toEqual({ error: 'reception_stale_pending' });
    // 联系人/预览/工作区/模型之前的拒绝：授权恢复、状态写入、台账都必须为 0。
    expect(setCodingProjectDir).not.toHaveBeenCalled();
    expect((await readState(U, CID)).coding_project_dir).toBeUndefined();
    expect(await readReceptionLedger(U)).toEqual([]);
    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('waiting');
    expect(conversation?.a2a_pending_reception).toMatchObject({
      messageId: Q1, text: Q1_TEXT, state: 'pending',
    });
  });

  it('rejects the old row after a new question reopened the visit and accepts the new row once', async () => {
    await reopenWithNewQuestion();
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');
    const preview = await expectedPreviewFor(CID);
    const setCodingProjectDir = vi.fn(async () => {});

    // 用户手里是 Q1 的确认入口：不能把这次点击算到 Q2 头上。
    const stale = await service.confirmReception(U, {
      conversationId: CID, expectedPreview: preview, expectedMessageId: Q1,
    }, { setCodingProjectDir });
    expect(stale).toEqual({ error: 'reception_stale_pending' });
    expect(setCodingProjectDir).not.toHaveBeenCalled();
    expect((await chats.getConversation(U, CID))?.a2a?.state).toBe('waiting');

    // 携带 Q2 的身份才允许确认，且只成功这一次。
    const accepted = await service.confirmReception(U, {
      conversationId: CID, expectedPreview: preview, expectedMessageId: Q2,
    }, { setCodingProjectDir });
    expect(accepted).toMatchObject({
      question: { messageId: Q2, text: Q2_TEXT, fromAccount: PEER },
    });
    expect(setCodingProjectDir).toHaveBeenCalledTimes(1);
    expect((await chats.getConversation(U, CID))?.a2a?.state).toBe('active');
  });

  it('restores a claimed visit with a matching or omitted id, but never with a foreign id', async () => {
    await seedWaiting(Q1, new Date(Date.now() - MINUTE).toISOString(), Q1_TEXT);
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const preview = await expectedPreviewFor(CID);

    const first = await service.confirmReception(U, {
      conversationId: CID, expectedPreview: preview, expectedMessageId: Q1,
    }, { setCodingProjectDir: vi.fn(async () => {}) });
    expect(first).toMatchObject({ question: { messageId: Q1 } });

    // alreadyClaimed 的恢复语义：带匹配 id 仍可继续。
    expect(await service.confirmReception(U, { conversationId: CID, expectedMessageId: Q1 }))
      .toMatchObject({ duplicate: true, question: { messageId: Q1 } });
    // 旧调用方不带 id：兼容，仍按恢复处理。
    expect(await service.confirmReception(U, { conversationId: CID }))
      .toMatchObject({ duplicate: true, question: { messageId: Q1 } });
    // 已经不是当前 pending 的 id：即使是恢复也不能放行。
    expect(await service.confirmReception(U, { conversationId: CID, expectedMessageId: Q2 }))
      .toEqual({ error: 'reception_stale_pending' });
  });

  it('rejects a matching id once the staging deadline passed, without starting the visit', async () => {
    // production 形态：渲染层已总带 id；过期后即使 id 正确也只能得到 reception_expired。
    await seedWaiting(Q1, new Date(Date.now() - 11 * MINUTE).toISOString(), Q1_TEXT);
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const preview = await expectedPreviewFor(CID);

    const setCodingProjectDir = vi.fn(async () => {});
    await expect(service.confirmReception(U, {
      conversationId: CID, expectedPreview: preview, expectedMessageId: Q1,
    }, { setCodingProjectDir })).resolves.toEqual({ error: 'reception_expired' });
    // 过期路径必须在任何工作区副作用与台账写入之前返回。
    expect(setCodingProjectDir).not.toHaveBeenCalled();
    const { readReceptionLedger } = await import('../../../../src/main/features/a2a/reception-ledger');
    expect(await readReceptionLedger(U)).toEqual([]);

    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('expired');
    expect(conversation?.a2a_pending_reception).toMatchObject({ text: '', expired_reason: 'stale' });
  });

  it('checks the pending identity before the staging deadline', async () => {
    // 错误 id + 已过期：必须报 stale（身份不匹配），而不是过期——证明绑定先于 TTL。
    await seedWaiting(Q1, new Date(Date.now() - 11 * MINUTE).toISOString(), Q1_TEXT);
    const service = await import('../../../../src/main/features/a2a/reception-service');

    await expect(service.confirmReception(U, {
      conversationId: CID, expectedMessageId: 'amsg-foreign',
    })).resolves.toEqual({ error: 'reception_stale_pending' });

    const chats = await import('../../../../src/main/features/chats');
    expect((await chats.getConversation(U, CID))?.a2a?.state).toBe('waiting');
  });

  it('rejects a malformed expected id instead of silently skipping the binding', async () => {
    await seedWaiting(Q1, new Date(Date.now() - MINUTE).toISOString(), Q1_TEXT);
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');
    const setCodingProjectDir = vi.fn(async () => {});

    for (const expectedMessageId of [42, '', '   ', null, {}, []]) {
      expect(await service.confirmReception(U, {
        conversationId: CID, expectedMessageId,
      }, { setCodingProjectDir })).toEqual({ error: 'invalid expected message id' });
      expect(await service.declineReception(U, CID, { expectedMessageId }))
        .toEqual({ error: 'invalid expected message id' });
    }
    expect(setCodingProjectDir).not.toHaveBeenCalled();
    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('waiting');
    expect(conversation?.a2a_pending_reception).toMatchObject({ messageId: Q1, text: Q1_TEXT });
  });

  it('rejects a decline naming a different pending row and keeps the legacy unbound decline working', async () => {
    await seedWaiting(Q1, new Date(Date.now() - MINUTE).toISOString(), Q1_TEXT);
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');

    expect(await service.declineReception(U, CID, { expectedMessageId: Q2 }))
      .toEqual({ error: 'reception_stale_pending' });
    let conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('waiting');
    expect(conversation?.a2a_pending_reception).toMatchObject({ messageId: Q1, text: Q1_TEXT });

    // 缺省 expectedMessageId：既有调用方（恢复/旧渲染层）行为不变。
    expect(await service.declineReception(U, CID)).toMatchObject({ marker: { state: 'refused' } });
    conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('refused');
    expect(conversation?.a2a_pending_reception).toBeUndefined();
  });

  it('rejects the old row on decline after reopen and declines the new row once', async () => {
    await reopenWithNewQuestion();
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');

    expect(await service.declineReception(U, CID, { expectedMessageId: Q1 }))
      .toEqual({ error: 'reception_stale_pending' });
    let conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('waiting');
    expect(conversation?.a2a_pending_reception).toMatchObject({ messageId: Q2, text: Q2_TEXT });

    expect(await service.declineReception(U, CID, { expectedMessageId: Q2 }))
      .toMatchObject({ marker: { state: 'refused' } });
    conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a_pending_reception).toBeUndefined();
    // 已拒绝的来访不能借同一条 id 再拒绝一次。
    expect(await service.declineReception(U, CID, { expectedMessageId: Q2 }))
      .toEqual({ error: 'reception is not waiting' });
  });
});
