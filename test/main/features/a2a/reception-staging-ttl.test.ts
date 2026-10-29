import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 接待暂存 TTL（方案 C09）：自原消息时间起 10 分钟，重启/重试/重新列出都不续期。
 *
 * 真实缺陷：等待确认的来访在 17m53s 后仍能从收件箱确认，marker 被放行到 active
 * 并真的调用了模型。这里钉住三件事：投影不返回过期项、首次确认在任何联系人/
 * 工作区/模型动作前返回 `reception_expired`、清理只留脱敏原因与原消息时间。
 */
const U = 'cs_receiver';
const PEER = 'cs_alice';
const CID = 'a2a-0123456789abcdef0201';
const MSG = 'amsg-staging-ttl';
const NEW_MSG = 'amsg-staging-ttl-new';
const TEXT = '你们的标准折扣是多少？';
const NEW_TEXT = '过期之后的新问题：还能下单吗？';
const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-10-27T08:05:26Z');

let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-staging-ttl-')));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
  await seedContact();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function seedContact(): Promise<void> {
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(U), {
    version: 1,
    contacts: [{ userId: PEER, name: 'Alice', addedAt: new Date().toISOString() }],
  });
}

/** Startup recovery needs the normal Hub identity; without it the run exits early
 *  and a test would prove nothing about the sweep. */
async function signIn(): Promise<void> {
  const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
  saveHubSession(U, {
    session_id: 'staging-ttl-recovery-session',
    access_token: 'fixture',
    refresh_token: 'refresh',
    access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 7200_000).toISOString(),
  });
  writeHubAccountState(U, { account_id: U });
}

async function seedWaiting(
  receivedAt: string,
  options: { markerState?: 'waiting' | 'expired'; state?: 'pending' | 'claimed' | 'running'; text?: string } = {},
): Promise<void> {
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(U, { conversationId: CID, title: 'Alice 的来访' });
  await chats.updateConversation(U, CID, {
    a2a: {
      inbound: true,
      peer_user_id: PEER,
      peer_name: 'Alice',
      state: options.markerState ?? 'waiting',
      exchange_id: CID,
    },
    a2a_pending_reception: {
      messageId: MSG,
      conversationId: CID,
      peerUserId: PEER,
      peerName: 'Alice',
      text: options.text ?? TEXT,
      receivedAt,
      state: options.state ?? 'pending',
    },
  });
}

async function confirmedScope(now: number, setCodingProjectDir = vi.fn(async () => {})) {
  const service = await import('../../../../src/main/features/a2a/reception-service');
  const preview = await service.previewReceptionWorkspace(U, { conversationId: CID });
  expect('preview' in preview).toBe(true);
  const result = await service.confirmReception(U, {
    conversationId: CID,
    expectedPreview: 'preview' in preview ? preview.preview : undefined,
  }, { now, setCodingProjectDir });
  return { service, result, setCodingProjectDir };
}

describe('a2a reception › staging TTL', () => {
  it('hides a waiting visit past the 10-minute deadline even before the cleanup sweep runs', async () => {
    // 11 分钟前到达：真实缺陷里这种条目一直留在收件箱并可确认。
    await seedWaiting(new Date(NOW - 11 * MINUTE).toISOString());
    const { listPendingReceptions } = await import('../../../../src/main/features/a2a/reception-service');

    expect(await listPendingReceptions(U, { now: NOW })).toEqual([]);
  });

  it('keeps a waiting visit inside the deadline visible to the inbox', async () => {
    const receivedAt = new Date(NOW - 9 * MINUTE).toISOString();
    await seedWaiting(receivedAt);
    const { listPendingReceptions } = await import('../../../../src/main/features/a2a/reception-service');

    expect(await listPendingReceptions(U, { now: NOW })).toEqual([
      expect.objectContaining({ conversationId: CID, messageId: MSG, text: TEXT, receivedAt }),
    ]);
  });

  it('rejects the first confirmation of a stale visit with reception_expired before any side effect', async () => {
    await seedWaiting(new Date(NOW - 11 * MINUTE).toISOString());
    const { readState } = await import('../../../../src/main/features/group_chat/state');
    const { readReceptionLedger } = await import('../../../../src/main/features/a2a/reception-ledger');

    const { result, setCodingProjectDir } = await confirmedScope(NOW);

    expect(result).toEqual({ error: 'reception_expired' });
    // 工作区授权/状态恢复都是模型之前会发生的副作用，必须一次都没有。
    expect(setCodingProjectDir).not.toHaveBeenCalled();
    expect((await readState(U, CID)).coding_project_dir).toBeUndefined();
    expect(await readReceptionLedger(U)).toEqual([]);

    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.getConversation(U, CID);
    // 拒绝（到期）之后由同一套清理收敛：marker 过期、绑定正文清空，不留原文。
    expect(conversation?.a2a?.state).toBe('expired');
    expect(conversation?.a2a_pending_reception).toMatchObject({ text: '', expired_reason: 'stale' });
  });

  it('refuses to decline a stale visit and tombstones it instead of keeping the question forever', async () => {
    const receivedAt = new Date(NOW - 11 * MINUTE).toISOString();
    await seedWaiting(receivedAt);
    const { declineReception } = await import('../../../../src/main/features/a2a/reception-service');
    const { journalReception, readReceptionLedger } = await import('../../../../src/main/features/a2a/reception-ledger');
    const chats = await import('../../../../src/main/features/chats');
    // 真实链路会先落台账；这里补上，才能证明「拒绝」入口也不会把原文永久留下。
    expect(await journalReception(U, {
      messageId: MSG, conversationId: CID, peerUserId: PEER, text: TEXT,
      toAccount: U, createdAt: receivedAt, generation: 'gen1',
    })).toBe(true);

    // 「拒绝」曾经能绕过 TTL：转成 refused 后 sweep 不再扫，原问题正文永久留在台账。
    expect(await declineReception(U, CID, { now: NOW })).toEqual({ error: 'reception_expired' });

    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('expired');
    expect(conversation?.a2a_pending_reception).toMatchObject({ text: '', expired_reason: 'stale' });
    expect(await readReceptionLedger(U)).toEqual([
      expect.objectContaining({ messageId: MSG, status: 'expired', text: '' }),
    ]);
  });

  it('still confirms a visit inside the deadline, and a retry restores rather than reruns it', async () => {
    await seedWaiting(new Date(NOW - 9 * MINUTE).toISOString());

    const first = await confirmedScope(NOW);
    expect(first.result).toMatchObject({
      question: { messageId: MSG, text: TEXT, fromAccount: PEER },
    });
    expect(first.setCodingProjectDir).toHaveBeenCalledTimes(1);

    // alreadyClaimed 的重复确认按既有语义恢复，不受 TTL 影响。
    const chats = await import('../../../../src/main/features/chats');
    const preview = await first.service.previewReceptionWorkspace(U, { conversationId: CID });
    const retry = await first.service.confirmReception(U, {
      conversationId: CID,
      expectedPreview: 'preview' in preview ? preview.preview : undefined,
    }, { now: NOW + 12 * MINUTE });
    expect(retry).toMatchObject({ duplicate: true, question: { messageId: MSG } });
  });

  it('cleans stale staging on the existing relay pump tick, without a new timer', async () => {
    const receivedAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    await seedWaiting(receivedAt);
    // 泵只在真实 Hub 身份下运行；这里复用既有的正常会话落库方式。
    const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
    saveHubSession(U, {
      session_id: 'staging-ttl-session',
      access_token: 'fixture',
      refresh_token: 'refresh',
      access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 7200_000).toISOString(),
    });
    writeHubAccountState(U, { account_id: U });
    const { pumpOnce } = await import('../../../../src/main/features/a2a/relay-pump');

    expect(await pumpOnce({ activeUserId: () => U, poll: async () => [] })).toBe(0);

    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('expired');
    expect(conversation?.a2a_pending_reception).toMatchObject({ text: '', expired_reason: 'stale', receivedAt });
  });

  it('expires stale staging: marker expired, text cleared, reason and original time kept', async () => {
    const receivedAt = new Date(NOW - 11 * MINUTE).toISOString();
    await seedWaiting(receivedAt);
    const { expireStaleReceptions, listPendingReceptions, confirmReception } = await import(
      '../../../../src/main/features/a2a/reception-service'
    );

    expect(await expireStaleReceptions(U, { now: NOW })).toEqual({ expired: 1, scrubbed: 1 });

    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('expired');
    expect(conversation?.a2a_pending_reception).toMatchObject({
      text: '',
      expired_reason: 'stale',
      receivedAt,
      messageId: MSG,
    });
    // 正文不能留在会话记录里的任何其它位置。
    expect(JSON.stringify(conversation)).not.toContain(TEXT);
    expect(await listPendingReceptions(U, { now: NOW })).toEqual([]);
    await expect(confirmReception(U, { conversationId: CID }, { now: NOW }))
      .resolves.toEqual({ error: 'reception_expired' });
  });

  it('scrubs a legacy expired staging record that still holds plaintext', async () => {
    const receivedAt = new Date(NOW - 30 * MINUTE).toISOString();
    await seedWaiting(receivedAt, { markerState: 'expired' });
    const { expireStaleReceptions } = await import('../../../../src/main/features/a2a/reception-service');

    expect(await expireStaleReceptions(U, { now: NOW })).toEqual({ expired: 0, scrubbed: 1 });

    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a_pending_reception).toMatchObject({
      text: '', expired_reason: 'stale', receivedAt,
    });
  });

  it('never renews the deadline across repeated listing, cleanup or a restart', async () => {
    const receivedAt = new Date(NOW - 9 * MINUTE).toISOString();
    await seedWaiting(receivedAt);
    const service = await import('../../../../src/main/features/a2a/reception-service');

    // 连续列出两次不会把 receivedAt 往后推，也不会重新起算。
    expect(await service.listPendingReceptions(U, { now: NOW })).toHaveLength(1);
    expect(await service.listPendingReceptions(U, { now: NOW })).toHaveLength(1);
    const chats = await import('../../../../src/main/features/chats');
    expect((await chats.getConversation(U, CID))?.a2a_pending_reception?.receivedAt).toBe(receivedAt);

    const deadline = Date.parse(receivedAt) + 10 * MINUTE;
    expect(await service.listPendingReceptions(U, { now: deadline - 1 })).toHaveLength(1);
    expect(await service.listPendingReceptions(U, { now: deadline })).toEqual([]);
    expect(await service.expireStaleReceptions(U, { now: deadline })).toEqual({ expired: 1, scrubbed: 1 });

    // 模拟重启：模块重新加载后仍按同一个原始截止时间判过期，不会续期。
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/a2a/reception-service');
    const restartedChats = await import('../../../../src/main/features/chats');
    expect(await restarted.expireStaleReceptions(U, { now: deadline + 5 * MINUTE }))
      .toEqual({ expired: 0, scrubbed: 0 });
    expect(await restarted.listPendingReceptions(U, { now: deadline + 5 * MINUTE })).toEqual([]);
    expect((await restartedChats.getConversation(U, CID))?.a2a_pending_reception?.receivedAt).toBe(receivedAt);
  });
});

describe('a2a reception › a new question after the previous visit expired', () => {
  it('reopens the visit with the new question and keeps the expired one as an empty terminal record', async () => {
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');
    const { readReceptionLedger } = await import('../../../../src/main/features/a2a/reception-ledger');

    // 真实入站路径：旧问题进入等待，随后过期清理成终态。
    const oldReceivedAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    await expect(service.handleInboundQuestion(U, {
      messageId: MSG, conversationId: CID, fromAccount: PEER, text: TEXT, createdAt: oldReceivedAt,
    })).resolves.toMatchObject({ accepted: true, outcome: { awaitingConfirmation: true } });
    expect(await service.expireStaleReceptions(U)).toEqual({ expired: 1, scrubbed: 1 });

    // 同 CID 的新问题：必须重新进入「等待确认」，不能被静默丢弃。
    const newReceivedAt = new Date().toISOString();
    await expect(service.handleInboundQuestion(U, {
      messageId: NEW_MSG, conversationId: CID, fromAccount: PEER, text: NEW_TEXT, createdAt: newReceivedAt,
    })).resolves.toMatchObject({ accepted: true, outcome: { awaitingConfirmation: true } });

    const reopened = await chats.getConversation(U, CID);
    expect(reopened?.a2a?.state).toBe('waiting');
    expect(reopened?.a2a_pending_reception).toMatchObject({
      messageId: NEW_MSG, conversationId: CID, peerUserId: PEER, text: NEW_TEXT,
      receivedAt: newReceivedAt, state: 'pending',
    });
    // 旧问题的正文不能在会话绑定的任何位置留下。
    expect(JSON.stringify(reopened)).not.toContain(TEXT);

    const ledger = await readReceptionLedger(U);
    expect(ledger).toHaveLength(2);
    expect(ledger.find((row) => row.messageId === MSG)).toMatchObject({
      status: 'expired', text: '', error: 'staging_expired',
      conversationId: CID, peerUserId: PEER, createdAt: oldReceivedAt,
    });
    expect(ledger.find((row) => row.messageId === NEW_MSG)).toMatchObject({
      status: 'pending', text: NEW_TEXT, conversationId: CID, createdAt: newReceivedAt,
    });

    // 收件箱重新出现这条新来访，且按新消息时间计时。
    expect(await service.listPendingReceptions(U)).toEqual([
      expect.objectContaining({
        conversationId: CID, messageId: NEW_MSG, text: NEW_TEXT, receivedAt: newReceivedAt,
      }),
    ]);

    // 重复投递同一条新消息：不再建 pending、不再加台账行，也不推进 receivedAt。
    await expect(service.handleInboundQuestion(U, {
      messageId: NEW_MSG, conversationId: CID, fromAccount: PEER, text: NEW_TEXT, createdAt: newReceivedAt,
    })).resolves.toMatchObject({ accepted: true });
    expect((await readReceptionLedger(U)).filter((row) => row.messageId === NEW_MSG)).toHaveLength(1);
    expect((await chats.getConversation(U, CID))?.a2a_pending_reception).toMatchObject({
      messageId: NEW_MSG, receivedAt: newReceivedAt,
    });

    // 新问题可以确认恰好一次；旧 messageId 不被复用、也不复活。
    const { result, setCodingProjectDir } = await confirmedScope(Date.now());
    expect(result).toMatchObject({ question: { messageId: NEW_MSG, text: NEW_TEXT, fromAccount: PEER } });
    expect(setCodingProjectDir).toHaveBeenCalledTimes(1);
    expect((await chats.getConversation(U, CID))?.a2a?.state).toBe('active');
    const afterConfirm = await readReceptionLedger(U);
    expect(afterConfirm.find((row) => row.messageId === MSG)).toMatchObject({ status: 'expired', text: '' });
    expect(afterConfirm.filter((row) => row.messageId === NEW_MSG)).toHaveLength(1);
  });

  it('does not wait for the sweep to reopen once the old deadline has passed', async () => {
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');
    const { readReceptionLedger } = await import('../../../../src/main/features/a2a/reception-ledger');

    const oldReceivedAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    await expect(service.handleInboundQuestion(U, {
      messageId: MSG, conversationId: CID, fromAccount: PEER, text: TEXT, createdAt: oldReceivedAt,
    })).resolves.toMatchObject({ accepted: true });

    // 不跑 sweep：marker 仍是 waiting，但 10 分钟已经过了（TTL 是时间事实，不是清理动作）。
    const newReceivedAt = new Date().toISOString();
    await expect(service.handleInboundQuestion(U, {
      messageId: NEW_MSG, conversationId: CID, fromAccount: PEER, text: NEW_TEXT, createdAt: newReceivedAt,
    })).resolves.toMatchObject({ accepted: true, outcome: { awaitingConfirmation: true } });

    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a_pending_reception).toMatchObject({
      messageId: NEW_MSG, text: NEW_TEXT, receivedAt: newReceivedAt,
    });
    expect(JSON.stringify(conversation)).not.toContain(TEXT);
    // 旧问题在台账里已经是过期终态，正文不保留。
    expect((await readReceptionLedger(U)).find((row) => row.messageId === MSG)).toMatchObject({
      status: 'expired', text: '', error: 'staging_expired',
    });
  });
});

describe('a2a reception › journaled plaintext and startup recovery', () => {
  it('clears the journaled plaintext on expiry and never rescans it as pending', async () => {
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const { readReceptionLedger } = await import('../../../../src/main/features/a2a/reception-ledger');
    const { userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');

    const receivedAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    await expect(service.handleInboundQuestion(U, {
      messageId: MSG, conversationId: CID, fromAccount: PEER, text: TEXT,
      createdAt: receivedAt, toAccount: U,
    })).resolves.toMatchObject({ accepted: true });
    const ledgerFile = userA2AReceptionLedgerFile(U);
    expect(fs.readFileSync(ledgerFile, 'utf8')).toContain(TEXT);

    expect(await service.expireStaleReceptions(U)).toEqual({ expired: 1, scrubbed: 1 });

    // 会话绑定与本地台账都必须收敛为「无正文的过期终态」，保留原始身份与时间。
    expect(await readReceptionLedger(U)).toEqual([expect.objectContaining({
      messageId: MSG, conversationId: CID, peerUserId: PEER, createdAt: receivedAt,
      status: 'expired', text: '', error: 'staging_expired',
    })]);
    expect(fs.readFileSync(ledgerFile, 'utf8')).not.toContain(TEXT);
    expect(JSON.stringify(await service.listPendingReceptions(U))).not.toContain(TEXT);

    // 启动恢复：过期终态不得被当成 pending 重扫、隔离或重试。
    await signIn();
    const { recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
    const run = vi.fn();
    expect(await recoverClaimedReceptions(U, { run, activeUserId: () => U })).toEqual({ scheduled: 0 });
    const afterFirstRecovery = fs.readFileSync(ledgerFile, 'utf8');
    // 重复启动：不重跑、不重写台账（幂等）。
    expect(await recoverClaimedReceptions(U, { run, activeUserId: () => U })).toEqual({ scheduled: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(afterFirstRecovery);
    expect((await readReceptionLedger(U))[0]).toMatchObject({ status: 'expired', text: '' });
  });

  it('expires stale staging at startup recovery before anything can be scheduled', async () => {
    const receivedAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    await seedWaiting(receivedAt);
    await signIn();
    const { recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
    const run = vi.fn();

    expect(await recoverClaimedReceptions(U, { run, activeUserId: () => U })).toEqual({ scheduled: 0 });
    expect(run).not.toHaveBeenCalled();

    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('expired');
    expect(conversation?.a2a_pending_reception).toMatchObject({
      text: '', expired_reason: 'stale', receivedAt,
    });
  });

  it('never derives the staging deadline from the retry clock when the original time is missing', async () => {
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');

    await expect(service.handleInboundQuestion(U, {
      messageId: MSG, conversationId: CID, fromAccount: PEER, text: TEXT,
    })).resolves.toMatchObject({ accepted: true });
    const firstReceivedAt = (await chats.getConversation(U, CID))?.a2a_pending_reception?.receivedAt;
    expect(firstReceivedAt).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(service.handleInboundQuestion(U, {
      messageId: MSG, conversationId: CID, fromAccount: PEER, text: TEXT,
    })).resolves.toMatchObject({ accepted: true });
    // 旧实现写 Date.now()：重复投递会把截止时间往后推。锚点必须保持不变。
    expect((await chats.getConversation(U, CID))?.a2a_pending_reception?.receivedAt)
      .toBe(firstReceivedAt);
  });

  it('anchors the legacy pending helper on the original message time instead of the retry clock', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const { rememberPendingReception } = await import('../../../../src/main/features/a2a/reception-run');

    await chats.createConversation(U, { conversationId: CID, title: 'Alice 的来访' });
    await chats.updateConversation(U, CID, {
      a2a: { inbound: true, peer_user_id: PEER, peer_name: 'Alice', state: 'waiting', exchange_id: CID },
    });
    const original = new Date(Date.now() - 2 * MINUTE).toISOString();
    await rememberPendingReception(U, {
      conversationId: CID, messageId: MSG, peerUserId: PEER, text: TEXT, createdAt: original,
    });
    expect((await chats.getConversation(U, CID))?.a2a_pending_reception).toMatchObject({ receivedAt: original });

    await new Promise((resolve) => setTimeout(resolve, 25));
    await rememberPendingReception(U, {
      conversationId: CID, messageId: MSG, peerUserId: PEER, text: TEXT, createdAt: original,
    });
    expect((await chats.getConversation(U, CID))?.a2a_pending_reception?.receivedAt).toBe(original);
  });
});
