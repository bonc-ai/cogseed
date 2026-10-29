import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DIRECTORY_SYMLINKS_SUPPORTED } from '../../../helpers/fs-capabilities';

/**
 * 接待运行（AC-04/05/16/18）：一条入站问题 → 助理回答 → relay 回传。
 *
 * 这里不跑真实 LLM，也不连 Hub：bus 与 relay 都是替身，被钉住的是**运行边界**——
 * 没接受接访不回答、一条消息只回答一次、收到的必须是「说给本人」的收尾回答、
 * 失败要回一句话、5 分钟提示只发一次。真实投递由双客户端真机走查覆盖。
 */
const B = 'cs_bob';
const A = 'cs_alice';
const CID = 'a2a-0123456789abcdef0123';
let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-reception-')));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
  vi.doMock('../../../../src/main/features/users', () => ({ getActiveUserId: () => B }));
  const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
  saveHubSession(B, { session_id: 'normal-session', access_token: 'fixture', refresh_token: 'refresh',
    access_expires_at: new Date(Date.now() + 3600_000).toISOString(), refresh_expires_at: new Date(Date.now() + 7200_000).toISOString() });
  writeHubAccountState(B, { account_id: B });
  question.createdAt = new Date().toISOString();
});

afterEach(() => {
  vi.doUnmock('../../../../src/main/features/chats');
  vi.doUnmock('../../../../src/main/features/users');
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 一个可以被测试推事件的假 bus：记录入队、把事件交给当前订阅者。 */
function createBus() {
  const listeners = new Set<(ev: unknown) => void>();
  const enqueued: any[] = [];
  return {
    enqueued,
    emit(ev: unknown) {
      for (const listener of [...listeners]) listener(ev);
    },
    deps: {
      subscribe: async (_uid: string, _cid: string, listener: (ev: any) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      enqueue: async (input: any) => {
        enqueued.push(input);
        return { id: 'm1' };
      },
      addMember: async () => true,
    },
  };
}

async function seedConversation(state: 'waiting' | 'active', extra: Record<string, unknown> = {}) {
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(B, { conversationId: CID, title: 'Alice 的来访' });
  await chats.updateConversation(B, CID, {
    a2a: {
      role: 'receiver',
      peer_user_id: A,
      peer_name: 'Alice',
      state,
      ...(state === 'active' ? { workspace: tmp } : {}),
      exchange_id: CID,
      ...extra,
    },
    ...(state === 'waiting' ? {
      a2a_pending_reception: {
        messageId: question.messageId,
        conversationId: CID,
        peerUserId: A,
        peerName: 'Alice',
        text: question.text,
        receivedAt: new Date().toISOString(),
      },
    } : {}),
  });
  return chats;
}

async function writeContacts(userId: string, peerUserIds: string[]) {
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(userId), {
    version: 1,
    contacts: peerUserIds.map((userId) => ({ userId, name: 'Alice', addedAt: new Date().toISOString() })),
  });
}

const question = {
  toAccount: B,
  createdAt: '',
  messageId: 'amsg-1',
  fromAccount: A,
  conversationId: CID,
  text: '报价能给八折吗？',
  fromName: 'Alice',
};

async function receptionLedger() {
  const { readJson } = await import('../../../../src/main/storage');
  const { userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');
  return (await readJson<{ entries: any[] }>(userA2AReceptionLedgerFile(B)))?.entries || [];
}

// Existing confirmation scenarios now pass the server preview explicitly.
async function confirmScope(userId: string, input: any, deps: any = {}) {
  const service = await import('../../../../src/main/features/a2a/reception-service');
  const resolved = await service.previewReceptionWorkspace(userId, input);
  return service.confirmReception(userId, { ...input, ...('preview' in resolved ? { expectedPreview: resolved.preview } : {}) }, deps);
}

describe('T4a granted workspace restoration', () => {
  // The `symlink` case plants a real directory symlink; without that capability
  // the fixture cannot exist, so the case is dropped rather than reported as a
  // product regression. The other three kinds stay covered everywhere.
  const grantKinds = DIRECTORY_SYMLINKS_SUPPORTED
    ? ['missing', 'deleted', 'relative', 'symlink']
    : ['missing', 'deleted', 'relative'];
  it.each(grantKinds)('fails closed on a %s grant without fallback or enqueue', async kind => {
    await writeContacts(B, [A]);
    const dir = path.join(tmp, 'grant');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    if (kind === 'symlink') fs.symlinkSync(outside, dir, 'dir');
    const workspace = kind === 'missing' ? undefined : kind === 'relative' ? 'relative' : dir;
    const chats = await seedConversation('active', { workspace });
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const { readState } = await import('../../../../src/main/features/group_chat/state');
    const before = await readState(B, CID);
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'must-not-send' }));
    expect(await runReception(B, question, { ...bus.deps, send, timeoutMs: 10 }))
      .toMatchObject({ status: 'failed', error: 'workspace grant is unavailable' });
    expect(bus.enqueued).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect((await chats.getConversation(B, CID))?.a2a?.workspace).toBe(workspace);
    expect((await readState(B, CID)).coding_project_dir).toBe(before.coding_project_dir);
    expect(fs.existsSync(path.join(tmp, 'userWorkSpace', 'alice-的来访'))).toBe(false);
  });

  it('restores exactly the marker root before enqueue even if state points elsewhere', async () => {
    await writeContacts(B, [A]);
    const root = fs.realpathSync(tmp);
    await seedConversation('active', { workspace: root });
    const state = await import('../../../../src/main/features/group_chat/state');
    await state.setCodingProjectDir(B, CID, path.join(tmp, 'other'), { explicit: false });
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const queued = runReception(B, question, { ...bus.deps, timeoutMs: 500, send: async () => ({ messageId: 'ack' }) });
    await vi.waitFor(() => expect(bus.enqueued).toHaveLength(1));
    expect(await state.readState(B, CID)).toMatchObject({ coding_project_dir: root, coding_project_dir_explicit: true });
    expect(bus.enqueued[0].model_text).toContain(root);
    bus.emit({ type: 'message', turn_end: true, turn_id: bus.enqueued[0].dispatchTurnId, msg: { from: 'commander', to: ['user'], text: 'answer' } });
    expect((await queued).status).toBe('answered');
  });

  it('never schedules recovery after the granted directory was deleted', async () => {
    await writeContacts(B, [A]);
    const workspace = fs.mkdtempSync(path.join(tmp, 'grant-'));
    await seedConversation('active', { workspace });
    const service = await import('../../../../src/main/features/a2a/reception-service');
    await service.handleInboundQuestion(B, question);
    fs.rmSync(workspace, { recursive: true });
    vi.resetModules();
    const { recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
    const run = vi.fn();
    expect(await recoverClaimedReceptions(B, { run })).toEqual({ scheduled: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(workspace)).toBe(false);
    expect((await receptionLedger())[0]).toMatchObject({ status: 'uncertain', error: 'workspace grant is unavailable' });
  });

  it('T4a live and restart previews retain the contact custom selection', async () => {
    await writeContacts(B, [A]);
    const custom = fs.mkdtempSync(path.join(tmp, 'contact-default-'));
    const contacts = await import('../../../../src/main/features/contacts/store');
    await contacts.setDefaultScope(B, A, { workspace: custom, agentId: 'chosen' });
    const { receiveRelayMessage } = await import('../../../../src/main/features/a2a/relay-pump');
    const { resetReceptionNudges } = await import('../../../../src/main/features/a2a/reception-nudge');
    const events: any[] = [];
    try {
      await receiveRelayMessage(B, { ...question, kind: 'question' }, { onEvent: event => events.push(event) });
      expect(events[0]).toMatchObject({ workspacePreview: custom, defaultWorkspace: custom, defaultAgentId: 'chosen' });
      const { listPendingReceptions } = await import('../../../../src/main/features/a2a/reception-service');
      expect(await listPendingReceptions(B)).toEqual([expect.objectContaining({ workspacePreview: custom, defaultWorkspace: custom, defaultAgentId: 'chosen' })]);
    } finally { resetReceptionNudges(); }
  });

  it('does not enqueue when restoring the exact grant fails', async () => {
    await writeContacts(B, [A]);
    await seedConversation('active', { workspace: fs.realpathSync(tmp) });
    const state = await import('../../../../src/main/features/group_chat/state');
    vi.spyOn(state, 'setCodingProjectDir').mockRejectedValueOnce(new Error('disk failure'));
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    expect(await runReception(B, question, { ...bus.deps, timeoutMs: 10 })).toMatchObject({ status: 'failed', error: 'workspace state unavailable' });
    expect(bus.enqueued).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

describe('a2a reception durable recovery', () => {
  it('retains every accepted active payload before reservation, independently of the pending slot', async () => {
    await writeContacts(B, [A]);
    await seedConversation('active', { workspace: tmp });
    const service = await import('../../../../src/main/features/a2a/reception-service');
    for (const messageId of ['active-1', 'active-2']) {
      expect(await service.handleInboundQuestion(B, { ...question, messageId })).toMatchObject({ accepted: true });
    }
    const entries = await receptionLedger();
    expect(entries.map((row) => row.messageId)).toEqual(['active-1', 'active-2']);
    expect(entries.every((row) => row.text === question.text && /^[a-f0-9]{64}$/.test(row.payloadHash))).toBe(true);
    vi.resetModules();
    const run = vi.fn(async () => ({ status: 'answered' as const }));
    const { recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
    expect(await recoverClaimedReceptions(B, { run })).toEqual({ scheduled: 2 });
  });

  it.each(['admitted', 'reserved', 'answer'] as const)('drains persisted %s A after live B without duplicating either reception', async (stage) => {
    await writeContacts(B, [A]);
    await seedConversation('active', { workspace: tmp });
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const running = await import('../../../../src/main/features/a2a/reception-run');
    const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
    await service.handleInboundQuestion(B, question);
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'ack' }));
    const answerA = { type: 'message', turn_end: true, msg: { from: 'commander', to: ['user'], text: 'answer A' } };
    const runDeps = {
      ...bus.deps, send, timeoutMs: 500,
      enqueue: async (input: any) => {
        await bus.deps.enqueue(input);
        if (input.text === question.text) bus.emit({ ...answerA, turn_id: input.dispatchTurnId });
      },
    };
    if (stage !== 'admitted') {
      await expect(running.runReception(B, question, {
        ...runDeps,
        afterStage: async (current) => { if (current === stage) throw new Error('persisted A crash'); },
      })).rejects.toThrow('persisted A crash');
    }
    const liveQuestion = { ...question, messageId: 'live-B', text: 'question B' };
    await service.handleInboundQuestion(B, liveQuestion);
    const live = running.runReception(B, liveQuestion, runDeps);
    await vi.waitFor(() => expect(bus.enqueued.filter((row) => row.text === liveQuestion.text)).toHaveLength(1));

    let snapshotRead!: () => void;
    const snapshot = new Promise<void>((resolve) => { snapshotRead = resolve; });
    const readLedger = ledger.readReceptionLedger;
    const readSpy = vi.spyOn(ledger, 'readReceptionLedger').mockImplementationOnce(async (uid) => {
      const entries = await readLedger(uid);
      snapshotRead();
      return entries;
    });
    const recovery = running.recoverClaimedReceptions(B, {
      run: (uid, recovered) => running.runReception(uid, recovered, { ...runDeps, recovery: true }), send,
    });
    await snapshot;
    readSpy.mockRestore();
    expect((await receptionLedger()).find((row) => row.messageId === liveQuestion.messageId)).toMatchObject({ status: 'running' });
    bus.emit({ type: 'message', turn_end: true, turn_id: bus.enqueued.at(-1).dispatchTurnId, msg: { from: 'commander', to: ['user'], text: 'answer B' } });
    expect(await live).toMatchObject({ status: 'answered', text: 'answer B' });
    expect(await recovery).toEqual({ scheduled: stage === 'answer' ? 0 : 1 });
    expect(await receptionLedger()).toEqual([
      expect.objectContaining({ messageId: question.messageId, status: 'answered', answer: expect.objectContaining({ text: 'answer A' }) }),
      expect.objectContaining({ messageId: liveQuestion.messageId, status: 'answered', answer: expect.objectContaining({ text: 'answer B' }) }),
    ]);
    await running.recoverClaimedReceptions(B, { run: vi.fn(), send });
    expect(bus.enqueued.filter((row) => row.text === question.text)).toHaveLength(1);
    expect(bus.enqueued.filter((row) => row.text === liveQuestion.text)).toHaveLength(1);
    expect(send.mock.calls.map(([input]) => input.text).sort()).toEqual(['answer A', 'answer B']);
  });

  it('reconciles a journal written before the conversation admission commit', async () => {
    await writeContacts(B, [A]);
    const service = await import('../../../../src/main/features/a2a/reception-service');
    await expect(service.handleInboundQuestion(B, question, {
      afterStage: async () => { throw new Error('admission crash'); },
    })).rejects.toThrow('admission crash');
    const chats = await import('../../../../src/main/features/chats');
    expect(await chats.getConversation(B, CID)).toBeNull();
    expect(await receptionLedger()).toHaveLength(1);
    vi.resetModules();
    const { recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
    const run = vi.fn();
    expect(await recoverClaimedReceptions(B, { run })).toEqual({ scheduled: 0 });
    expect(run).not.toHaveBeenCalled();
    const { listPendingReceptions } = await import('../../../../src/main/features/a2a/reception-service');
    expect(await listPendingReceptions(B)).toEqual([expect.objectContaining({ messageId: question.messageId, text: question.text })]);
  });

  it.each(['conversationId', 'fromAccount', 'text'] as const)('rejects a reused messageId with a different %s without replacing its row', async (field) => {
    await writeContacts(B, [A, 'cs_other']);
    await seedConversation('active', { workspace: tmp });
    const service = await import('../../../../src/main/features/a2a/reception-service');
    await service.handleInboundQuestion(B, question);
    const before = await receptionLedger();
    const values = { conversationId: 'a2a-11112222333344445555', fromAccount: 'cs_other', text: 'different payload' };
    expect(await service.handleInboundQuestion(B, { ...question, [field]: values[field] })).toMatchObject({ accepted: false });
    expect(await receptionLedger()).toEqual(before);
    const bus = createBus();
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    expect(await runReception(B, { ...question, [field]: values[field] }, { ...bus.deps, recovery: true, timeoutMs: 1 }))
      .not.toMatchObject({ status: 'answered' });
    expect(bus.enqueued).toHaveLength(0);
    expect(await receptionLedger()).toEqual(before);
  });

  it.each(['dispatching', 'enqueued'] as const)('retains an uncertain dispatch after %s instead of executing the model again', async (crashStage) => {
    await writeContacts(B, [A]);
    await seedConversation('active', { workspace: tmp });
    const service = await import('../../../../src/main/features/a2a/reception-service');
    await service.handleInboundQuestion(B, question);
    const running = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    await expect(running.runReception(B, question, {
      ...bus.deps,
      afterStage: async (stage) => { if (stage === crashStage) throw new Error('enqueue crash'); },
    })).rejects.toThrow('enqueue crash');
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/a2a/reception-run');
    const run = vi.fn();
    expect(await restarted.recoverClaimedReceptions(B, { run })).toEqual({ scheduled: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(await receptionLedger()).toEqual([expect.objectContaining({ status: 'uncertain', text: question.text })]);
  });

  it.each(['answer', 'sending', 'relay', 'sent', 'result'] as const)('recovers after %s persistence without rerunning the model or repeating an ambiguous send', async (crashStage) => {
    await writeContacts(B, [A]);
    await seedConversation('active', { workspace: tmp });
    const service = await import('../../../../src/main/features/a2a/reception-service');
    await service.handleInboundQuestion(B, question);
    const running = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'answer-ack' }));
    const pending = running.runReception(B, question, {
      ...bus.deps, send, timeoutMs: 500,
      afterStage: async (stage) => { if (stage === crashStage) throw new Error('answer crash'); },
    });
    const rejected = expect(pending).rejects.toThrow('answer crash');
    await vi.waitFor(() => expect(bus.enqueued).toHaveLength(1));
    bus.emit({ type: 'message', turn_end: true, turn_id: bus.enqueued.at(-1).dispatchTurnId, msg: { from: 'commander', to: ['user'], text: 'durable answer' } });
    await rejected;
    expect(await receptionLedger()).toEqual([expect.objectContaining({ answer: expect.objectContaining({ text: 'durable answer', requestId: expect.any(String) }) })]);
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/a2a/reception-run');
    const run = vi.fn();
    await restarted.recoverClaimedReceptions(B, { run, send });
    await restarted.recoverClaimedReceptions(B, { run, send });
    expect(run).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(crashStage === 'sending' ? 0 : 1);
    if (crashStage !== 'sending') expect(send).toHaveBeenCalledWith(expect.objectContaining({ requestId: expect.stringMatching(/^a2a-answer-/), text: 'durable answer' }));
    expect((await receptionLedger())[0].status).toBe(crashStage === 'relay' || crashStage === 'sending' ? 'uncertain' : 'answered');
  });

  it.each(['reserved', 'running'] as const)('recovers a provably undispatched %s receipt by replacing its identity once', async (crashStage) => {
    await writeContacts(B, [A]);
    await seedConversation('active', { workspace: tmp });
    const service = await import('../../../../src/main/features/a2a/reception-service');
    await service.handleInboundQuestion(B, question);
    const running = await import('../../../../src/main/features/a2a/reception-run');
    await expect(running.runReception(B, question, {
      ...createBus().deps, afterStage: async (stage) => { if (stage === crashStage) throw new Error('reservation crash'); },
    })).rejects.toThrow('reservation crash');
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'ack' }));
    const recovery = restarted.recoverClaimedReceptions(B, {
      run: (uid, recovered) => restarted.runReception(uid, recovered, { ...bus.deps, send, recovery: true, timeoutMs: 500 }),
    });
    await vi.waitFor(() => expect(bus.enqueued).toHaveLength(1));
    bus.emit({ type: 'message', turn_end: true, turn_id: bus.enqueued.at(-1).dispatchTurnId, msg: { from: 'commander', to: ['user'], text: 'recovered' } });
    await recovery;
    await restarted.recoverClaimedReceptions(B, { run: vi.fn() });
    expect(bus.enqueued).toHaveLength(1);
    expect(await receptionLedger()).toEqual([expect.objectContaining({ messageId: question.messageId, status: 'answered' })]);
  });

  it.each(['messageId', 'conversationId', 'peerUserId', 'text', 'payloadHash', 'generation'] as const)('does not recover a ledger with mismatched %s', async (field) => {
    await writeContacts(B, [A]);
    await seedConversation('active', { workspace: tmp });
    const service = await import('../../../../src/main/features/a2a/reception-service');
    await service.handleInboundQuestion(B, question);
    const entries = await receptionLedger();
    const values = { messageId: 'tampered', conversationId: 'a2a-11112222333344445555', peerUserId: 'cs_other', text: 'tampered', payloadHash: 'wrong', generation: 'wrong' };
    entries[0][field] = values[field];
    const { writeJson } = await import('../../../../src/main/storage');
    const { userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');
    await writeJson(userA2AReceptionLedgerFile(B), { version: 1, entries });
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/a2a/reception-run');
    const run = vi.fn();
    await restarted.recoverClaimedReceptions(B, { run });
    expect(run).not.toHaveBeenCalled();
    expect(await receptionLedger()).toHaveLength(1);
  });

  it('does not revive a declined question when a later visit is confirmed', async () => {
    await writeContacts(B, [A]);
    const service = await import('../../../../src/main/features/a2a/reception-service');
    await service.handleInboundQuestion(B, question);
    await service.declineReception(B, CID);
    await service.handleInboundQuestion(B, { ...question, messageId: 'later-visit' });
    await confirmScope(B, { conversationId: CID, workspace: tmp }, { setCodingProjectDir: async () => {} });
    const { recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
    const run = vi.fn(async () => ({ status: 'answered' as const }));
    expect(await recoverClaimedReceptions(B, { run })).toEqual({ scheduled: 1 });
    expect(run).toHaveBeenCalledWith(B, expect.objectContaining({ messageId: 'later-visit' }));
  });

  it('never resends an answer after a missing relay acknowledgement', async () => {
    await writeContacts(B, [A]);
    await seedConversation('active', { workspace: tmp });
    const { runReception, recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const send = vi.fn(async () => null);
    const pending = runReception(B, question, { ...bus.deps, send, timeoutMs: 500 });
    await vi.waitFor(() => expect(bus.enqueued).toHaveLength(1));
    bus.emit({ type: 'message', turn_end: true, turn_id: bus.enqueued.at(-1).dispatchTurnId, msg: { from: 'commander', to: ['user'], text: 'answer' } });
    expect(await pending).toMatchObject({ status: 'uncertain' });
    await recoverClaimedReceptions(B, { send });
    expect(await runReception(B, question, { ...bus.deps, send })).toMatchObject({ status: 'uncertain' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(bus.enqueued).toHaveLength(1);
  });
});

describe('a2a reception run › authorization', () => {
  it('does not run before the receiver accepted the reception (AC-16)', async () => {
    await seedConversation('waiting');
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'out-1' }));

    const result = await runReception(B, question, { ...bus.deps, send, timeoutMs: 20 });

    expect(result.status).toBe('not_active');
    expect(bus.enqueued).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('answers once the reception is active', async () => {
    await writeContacts(B, [A]);
    await seedConversation('active');
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'out-1' }));

    const pending = runReception(B, question, { ...bus.deps, send, timeoutMs: 500 });
    // 助理的回答是「说给本人」的收尾消息。
    await vi.waitFor(() => expect(bus.enqueued).toHaveLength(1));
    bus.emit({ type: 'message', turn_end: true, turn_id: bus.enqueued.at(-1).dispatchTurnId, msg: { from: 'commander', to: ['user'], text: '最多九折' } });

    const result = await pending;
    expect(result).toMatchObject({ status: 'answered', text: '最多九折' });
    expect(send).toHaveBeenCalledWith({
      to: A,
      conversationId: CID,
      kind: 'answer',
      text: '最多九折',
      requestId: expect.stringMatching(/^a2a-answer-/),
    });
    // 对端以自己的身份进入会话，而不是本人。
    expect(bus.enqueued[0]).toMatchObject({ uid: B, cid: CID, fromActorId: 'a2a_cs_alice', forceTo: ['commander'] });
  });

  it('does not enqueue work when a durable contact fence is already active', async () => {
    await writeContacts(B, [A]);
    await seedConversation('active', { workspace: tmp });
    const fences = await import('../../../../src/main/features/contacts/deletion-fence');
    await fences.beginContactDeletionFence(B, A);
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'must-not-send' }));

    await expect(runReception(B, question, { ...bus.deps, send, timeoutMs: 20 }))
      .resolves.toMatchObject({ status: 'not_active' });
    expect(bus.enqueued).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a second delivery of the same message from answering twice', async () => {
    await writeContacts(B, [A]);
    await seedConversation('active');
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'out-1' }));

    const first = runReception(B, question, { ...bus.deps, send, timeoutMs: 500 });
    await vi.waitFor(() => expect(bus.enqueued).toHaveLength(1));
    bus.emit({ type: 'message', turn_end: true, turn_id: bus.enqueued.at(-1).dispatchTurnId, msg: { from: 'commander', to: ['user'], text: '最多九折' } });
    expect((await first).status).toBe('answered');

    const second = await runReception(B, question, { ...bus.deps, send, timeoutMs: 20 });
    expect(second.status).toBe('duplicate');
    expect(bus.enqueued).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('a2a reception run › reply capture', () => {
  it.each(['live', 'recovery'] as const)('does not capture a timed-out B reply for %s A', async (entryPath) => {
    await writeContacts(B, [A]);
    await seedConversation('active', { workspace: tmp });
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const running = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const send = vi.fn(async (_input: { text: string }) => ({ messageId: 'ack' }));
    const liveB = { ...question, messageId: 'timed-out-B', text: 'question B' };
    await service.handleInboundQuestion(B, question);
    await service.handleInboundQuestion(B, liveB);
    // The reception wait expires; the synthetic bus worker still owns B's turn.
    expect(await running.runReception(B, liveB, { ...bus.deps, send, timeoutMs: 10 }))
      .toMatchObject({ status: 'failed' });
    const turnB = bus.enqueued[0].dispatchTurnId || 'unbound-B';
    const run = (uid: string, recovered: typeof question) => running.runReception(uid, recovered, {
      ...bus.deps, send, timeoutMs: 500, recovery: entryPath === 'recovery',
    });
    const pendingA = entryPath === 'recovery'
      ? running.recoverClaimedReceptions(B, { run, send }) : run(B, question);
    await vi.waitFor(() => expect(bus.enqueued).toHaveLength(2));
    const turnA = bus.enqueued[1].dispatchTurnId || 'unbound-A';
    bus.emit({ type: 'message', turn_end: true, turn_id: turnB,
      msg: { from: 'commander', to: ['user'], text: 'late answer B' } });
    bus.emit({ type: 'message', turn_end: true,
      msg: { from: 'commander', to: ['user'], text: 'unbound answer' } });
    bus.emit({ type: 'message', turn_end: true, turn_id: turnA,
      msg: { from: 'other-agent', to: ['user'], text: 'wrong actor answer' } });
    bus.emit({ type: 'message', turn_end: true, turn_id: turnA,
      msg: { from: 'commander', to: ['user'], text: 'answer A' } });
    await pendingA;
    expect(send.mock.calls.map(([input]) => input.text)).toEqual([running.receptionFailureText(), 'answer A']);
    expect(turnA).toMatch(/^turn-a2a-in-/);
    expect(turnB).not.toBe(turnA);
    expect((await receptionLedger()).find((row) => row.messageId === question.messageId))
      .toMatchObject({ status: 'answered', answer: { text: 'answer A' } });
    expect(bus.enqueued).toHaveLength(2);
  });

  it('ignores mid-turn agent reports addressed to the commander', async () => {
    await writeContacts(B, [A]);
    await seedConversation('active');
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'out-1' }));

    const pending = runReception(B, question, { ...bus.deps, send, timeoutMs: 500 });
    await vi.waitFor(() => expect(bus.enqueued).toHaveLength(1));
    // 派发出去的 Agent 汇报：to=commander，不是给对端的答案。
    bus.emit({ type: 'message', turn_end: true, turn_id: bus.enqueued.at(-1).dispatchTurnId, msg: { from: 'agent-b', to: ['commander'], text: '分析完成' } });
    bus.emit({ type: 'process', cid: CID });
    bus.emit({ type: 'message', turn_end: true, turn_id: bus.enqueued.at(-1).dispatchTurnId, msg: { from: 'commander', to: ['user'], text: '最多九折' } });

    expect(await pending).toMatchObject({ status: 'answered', text: '最多九折' });
  });

  it('answers the peer even when the run times out', async () => {
    await writeContacts(B, [A]);
    await seedConversation('active');
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'out-1' }));

    const result = await runReception(B, question, { ...bus.deps, send, timeoutMs: 10 });

    expect(result.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0][0].text)).not.toBe('');
    expect(send.mock.calls[0][0].kind).toBe('answer');
  });

  it('serializes reception scope persistence so contact deletion remains terminal', async () => {
    await writeContacts(B, [A]);
    const chats = await seedConversation('waiting');
    let markWorkspaceReady!: () => void;
    const workspaceReady = new Promise<void>((resolve) => { markWorkspaceReady = resolve; });
    let releaseWorkspace!: () => void;
    const workspaceRelease = new Promise<void>((resolve) => { releaseWorkspace = resolve; });
    let markEndedWritten!: () => void;
    const endedWritten = new Promise<void>((resolve) => { markEndedWritten = resolve; });

    vi.doMock('../../../../src/main/features/chats', () => ({
      ...chats,
      updateConversation: async (...args: Parameters<typeof chats.updateConversation>) => {
        if (args[2].a2a?.state === 'active' && args[2].a2a?.workspace) {
          markWorkspaceReady();
          await workspaceRelease;
        }
        return chats.updateConversation(...args);
      },
      updateConversationAtomic: async (...args: any[]) => {
        const mutate = args[2];
        return chats.updateConversationAtomic(args[0], args[1], async (current: any) => {
          const updates = await mutate(current);
          if (updates?.a2a?.state === 'active' && updates.a2a.workspace) {
            markWorkspaceReady();
            await workspaceRelease;
          }
          if (updates?.a2a?.state === 'ended') markEndedWritten();
          return updates;
        }, args[3]);
      },
    }));
    vi.resetModules();
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const { endExchangesWithPeer } = await import('../../../../src/main/features/a2a/end-exchange');
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'out-1' }));

    const confirming = confirmScope(B, { conversationId: CID, workspace: tmp });
    await workspaceReady;
    await writeContacts(B, []);
    const end = endExchangesWithPeer(B, A);
    const deleteReachedWrite = await Promise.race([
      endedWritten.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseWorkspace();
    await confirming;
    await end;
    const pending = runReception(B, question, { ...bus.deps, send, timeoutMs: 500 });
    expect(bus.enqueued).toHaveLength(0);
    bus.emit({ type: 'message', turn_end: true, msg: { from: 'commander', to: ['user'], text: '最多九折' } });

    await expect(pending).resolves.toMatchObject({ status: 'not_active' });
    expect(deleteReachedWrite).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect((await chats.getConversation(B, CID))?.a2a).toMatchObject({ state: 'ended' });
  });

  it('does not relay an answer when contact deletion finishes while the assistant is working', async () => {
    await writeContacts(B, [A]);
    const chats = await seedConversation('active', { workspace: tmp });
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const { endExchangesWithPeer } = await import('../../../../src/main/features/a2a/end-exchange');
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'out-1' }));

    const pending = runReception(B, { ...question, messageId: 'amsg-delete-during-run' }, {
      ...bus.deps,
      send,
      timeoutMs: 500,
    });
    await vi.waitFor(() => expect(bus.enqueued).toHaveLength(1));
    await writeContacts(B, []);
    await endExchangesWithPeer(B, A);
    bus.emit({ type: 'message', turn_end: true, turn_id: bus.enqueued.at(-1).dispatchTurnId, msg: { from: 'commander', to: ['user'], text: '最多九折' } });

    await expect(pending).resolves.toMatchObject({ status: 'not_active' });
    expect(send).not.toHaveBeenCalled();
    expect((await chats.getConversation(B, CID))?.a2a).toMatchObject({ state: 'ended' });
  });

  it('turns HTML bubbles into plain text for the peer', async () => {
    const { toRelayPlainText } = await import('../../../../src/main/features/a2a/reception-run');
    expect(await toRelayPlainText('<p>最多<b>九折</b></p>')).toBe('最多九折');
    expect(await toRelayPlainText('a<br>b')).toBe('a\nb');
    expect(await toRelayPlainText('&lt;tag&gt; &amp; more')).toBe('<tag> & more');
    expect(await toRelayPlainText('<kstar-review>{"score":1}</kstar-review>回答')).toBe('回答');
    // 宿主内部标记不得到达对端：运行结果、编排状态、给本人填的表单。
    expect(await toRelayPlainText('九折 <agent-result status="success" />')).toBe('九折');
    expect(await toRelayPlainText('稍等 <plan-interaction status="open" />')).toBe('稍等');
    expect(await toRelayPlainText('先填 <agent-input-form>{"fields":[]}</agent-input-form> 再说')).toBe('先填  再说');
  });
});

describe('a2a reception service › first visit', () => {
  it('rejects malformed A2A conversation ids before creating any storage', async () => {
    await writeContacts(B, [A]);
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');
    for (const conversationId of [
      '',
      '../bad',
      'a2a-0123456789ABCDEF0123',
      'a2a-0123456789abcdef012',
      'a2a-0123456789abcdef01234',
    ]) {
      await expect(handleInboundQuestion(B, { ...question, conversationId }))
        .resolves.toEqual({ accepted: false, reason: 'rejected' });
    }
    expect(await chats.listConversations(B)).toEqual([]);
  });

  it('rejects an ordinary conversation collision without mutating it', async () => {
    await writeContacts(B, [A]);
    const chats = await import('../../../../src/main/features/chats');
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    await chats.createConversation(B, { conversationId: CID, title: 'ordinary' });

    await expect(handleInboundQuestion(B, question))
      .resolves.toEqual({ accepted: false, reason: 'conversation_unavailable' });
    expect(await chats.getConversation(B, CID)).toMatchObject({ title: 'ordinary' });
    expect((await chats.getConversation(B, CID))?.a2a).toBeUndefined();
  });

  it('admits a concurrent duplicate only once and keeps one authoritative pending payload', async () => {
    await writeContacts(B, [A]);
    const { handleInboundQuestion, listPendingReceptions } = await import(
      '../../../../src/main/features/a2a/reception-service'
    );
    const chats = await import('../../../../src/main/features/chats');

    const outcomes = await Promise.all([
      handleInboundQuestion(B, question),
      handleInboundQuestion(B, question),
    ]);
    expect(outcomes.every((row) => row.accepted)).toBe(true);
    expect((await chats.listConversations(B)).filter((row) => row.conversation_id === CID)).toHaveLength(1);
    expect(await listPendingReceptions(B)).toEqual([expect.objectContaining({
      conversationId: CID,
      messageId: question.messageId,
      fromAccount: A,
      text: question.text,
    })]);
  });

  it('claims the stored payload for exactly one waiting conversation', async () => {
    await writeContacts(B, [A]);
    const { handleInboundQuestion } = await import(
      '../../../../src/main/features/a2a/reception-service'
    );
    const secondCid = 'a2a-1123456789abcdef0123';
    const second = { ...question, conversationId: secondCid, messageId: 'amsg-2', text: '第二个问题' };
    await handleInboundQuestion(B, question);
    await handleInboundQuestion(B, second);

    const firstClaim = await confirmScope(B, { conversationId: CID, workspace: tmp });
    expect(firstClaim).toMatchObject({
      marker: { state: 'active', peer_user_id: A },
      question: {
        conversationId: CID,
        messageId: question.messageId,
        fromAccount: A,
        text: question.text,
      },
    });
    await expect(confirmScope(B, { conversationId: CID, workspace: tmp }))
      .resolves.toMatchObject({ duplicate: true, question: { messageId: question.messageId, text: question.text } });
    const secondClaim = await confirmScope(B, { conversationId: secondCid, workspace: tmp });
    expect(secondClaim).toMatchObject({
      question: { conversationId: secondCid, messageId: 'amsg-2', text: '第二个问题' },
    });
  });

  it('keeps the first claimed workspace when a duplicate confirmation supplies another', async () => {
    await writeContacts(B, [A]);
    const firstWorkspace = fs.mkdtempSync(path.join(tmp, 'first-scope-'));
    const otherWorkspace = fs.mkdtempSync(path.join(tmp, 'other-scope-'));
    const { handleInboundQuestion } = await import(
      '../../../../src/main/features/a2a/reception-service'
    );
    await handleInboundQuestion(B, question);
    const setCodingProjectDir = vi.fn(async () => {});

    await confirmScope(B, { conversationId: CID, workspace: firstWorkspace }, { setCodingProjectDir });
    await expect(confirmScope(B, { conversationId: CID, workspace: otherWorkspace }, { setCodingProjectDir }))
      .resolves.toMatchObject({ duplicate: true, workspace: firstWorkspace });
    expect(setCodingProjectDir).toHaveBeenLastCalledWith(B, CID, firstWorkspace);
  });

  it('retains a claimed payload when workspace persistence crashes and retries the same claim', async () => {
    await writeContacts(B, [A]);
    const { handleInboundQuestion } = await import(
      '../../../../src/main/features/a2a/reception-service'
    );
    await handleInboundQuestion(B, question);
    await expect(confirmScope(B, { conversationId: CID, workspace: tmp }, {
      setCodingProjectDir: async () => { throw new Error('workspace disk failure'); },
    })).rejects.toThrow('workspace disk failure');

    await expect(confirmScope(B, { conversationId: CID, workspace: tmp }, {
      setCodingProjectDir: async () => {},
    })).resolves.toMatchObject({
      duplicate: true,
      question: { messageId: question.messageId, text: question.text },
    });
  });

  it('recovers a claimed question after restart before enqueue', async () => {
    await writeContacts(B, [A]);
    const service = await import('../../../../src/main/features/a2a/reception-service');
    await service.handleInboundQuestion(B, question);
    await confirmScope(B, { conversationId: CID, workspace: tmp }, {
      setCodingProjectDir: async () => {},
    });

    vi.resetModules();
    const restarted = await import('../../../../src/main/features/a2a/reception-run');
    const run = vi.fn(async () => ({ status: 'answered' as const }));
    await expect(restarted.recoverClaimedReceptions(B, { run }))
      .resolves.toEqual({ scheduled: 1 });
    expect(run).toHaveBeenCalledWith(B, expect.objectContaining({
      messageId: question.messageId,
      conversationId: CID,
      text: question.text,
    }));
  });

  it('restores the claimed workspace before boot recovery runs the question', async () => {
    await writeContacts(B, [A]);
    const service = await import('../../../../src/main/features/a2a/reception-service');
    await service.handleInboundQuestion(B, question);
    await expect(confirmScope(B, { conversationId: CID, workspace: tmp }, {
      setCodingProjectDir: async () => { throw new Error('crash before workspace persistence'); },
    })).rejects.toThrow('crash before workspace persistence');

    vi.resetModules();
    const restarted = await import('../../../../src/main/features/a2a/reception-run');
    const setCodingProjectDir = vi.fn(async () => {});
    const run = vi.fn(async () => ({ status: 'answered' as const }));
    await restarted.recoverClaimedReceptions(B, { run, setCodingProjectDir });

    expect(setCodingProjectDir).toHaveBeenCalledWith(B, CID, tmp);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('recovers once after durable reservation crashes before enqueue', async () => {
    await writeContacts(B, [A]);
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const running = await import('../../../../src/main/features/a2a/reception-run');
    await service.handleInboundQuestion(B, question);
    const confirmed = await confirmScope(B, { conversationId: CID, workspace: tmp }, {
      setCodingProjectDir: async () => {},
    });
    if ('error' in confirmed) throw new Error(confirmed.error);

    const beforeCrash = createBus();
    await expect(running.runReception(B, confirmed.question, {
      ...beforeCrash.deps,
      send: async () => ({ messageId: 'unused' }),
      afterStage: async (stage) => {
        if (stage === 'reserved') throw new Error('crash before enqueue');
      },
    })).rejects.toThrow('crash before enqueue');
    expect(beforeCrash.enqueued).toHaveLength(0);

    vi.resetModules();
    const restarted = await import('../../../../src/main/features/a2a/reception-run');
    const recoveredBus = createBus();
    const send = vi.fn(async () => ({ messageId: 'answer-after-restart' }));
    const recovery = restarted.recoverClaimedReceptions(B, {
      run: (userId, recoveredQuestion) => restarted.runReception(userId, recoveredQuestion, {
        ...recoveredBus.deps,
        send,
        timeoutMs: 500,
        recovery: true,
      }),
    });
    await vi.waitFor(() => expect(recoveredBus.enqueued).toHaveLength(1));
    recoveredBus.emit({
      type: 'message',
      turn_end: true,
      turn_id: recoveredBus.enqueued.at(-1).dispatchTurnId,
      msg: { from: 'commander', to: ['user'], text: '恢复后的回答' },
    });

    await expect(recovery).resolves.toEqual({ scheduled: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(restarted.recoverClaimedReceptions(B, { run: vi.fn() }))
      .resolves.toEqual({ scheduled: 0 });
  });

  it('drops a question from someone who is not a contact', async () => {
    const contacts = await import('../../../../src/main/features/contacts/store');
    // Explicit authoritative empty roster, rather than a signed-out fixture.
    vi.spyOn(contacts, 'refreshContactsFromHub').mockResolvedValueOnce(true);
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const decision = await handleInboundQuestion(B, question);
    expect(decision).toEqual({ accepted: false, reason: 'not_contact' });
  });

  it('uses the same 4000-character inbound question boundary before storage', async () => {
    await writeContacts(B, [A]);
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');
    const acceptedCid = 'a2a-2223456789abcdef0123';
    const rejectedCid = 'a2a-3223456789abcdef0123';
    const accepted = await handleInboundQuestion(B, {
      ...question,
      conversationId: acceptedCid,
      messageId: 'amsg-text-4000',
      text: 'x'.repeat(4_000),
    });
    expect(accepted.accepted).toBe(true);
    expect((await chats.getConversation(B, acceptedCid))?.a2a_pending_reception?.text)
      .toHaveLength(4_000);

    await expect(handleInboundQuestion(B, {
      ...question,
      conversationId: rejectedCid,
      messageId: 'amsg-text-4001',
      text: 'y'.repeat(4_001),
    })).resolves.toEqual({ accepted: false, reason: 'rejected' });
    expect(await chats.getConversation(B, rejectedCid)).toBeNull();
  });

  it('asks the receiver first, then runs without asking again (D-04/D-11)', async () => {
    const { writeJson } = await import('../../../../src/main/storage');
    const { userContactsFile } = await import('../../../../src/main/paths');
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');
    const contacts = await import('../../../../src/main/features/contacts/store');
    await writeJson(userContactsFile(B), {
      version: 1,
      contacts: [{ userId: A, name: 'Alice', addedAt: new Date().toISOString() }],
    });

    const first = await handleInboundQuestion(B, question);
    expect(first.accepted).toBe(true);
    if (first.accepted === false) throw new Error('unreachable');
    expect(first.outcome.awaitingConfirmation).toBe(true);
    expect(first.outcome.marker.state).toBe('waiting');
    // 会话出现在列表里，且标成接访侧。
    const created = await chats.getConversation(B, CID);
    expect(created).not.toBeNull();

    const workspace = fs.mkdtempSync(path.join(tmp, 'scope-'));
    const confirmed = await confirmScope(B, { conversationId: CID, workspace });
    expect('error' in confirmed).toBe(false);
    if ('error' in confirmed) return;
    expect(confirmed.marker.state).toBe('active');
    expect(confirmed.marker.workspace).toBe(workspace);
    const { toAccount: _recipient, createdAt: _originalTime, ...confirmedPayload } = question;
    expect(confirmed.question).toMatchObject(confirmedPayload);

    // 追问：不再需要确认（AC-05）。
    const followUp = await handleInboundQuestion(B, { ...question, messageId: 'amsg-2', text: '那九折呢' });
    expect(followUp.accepted).toBe(true);
    if (followUp.accepted === false) return;
    expect(followUp.outcome.awaitingConfirmation).toBe(false);

    // 删除联系人 → 交换结束；之后再问不重开（AC-10）。
    await chats.updateConversation(B, CID, {
      a2a: { ...(await chats.getConversation(B, CID))!.a2a, state: 'ended' },
    });
    const afterRemove = await handleInboundQuestion(B, { ...question, messageId: 'amsg-3', text: '在吗' });
    expect(afterRemove.accepted).toBe(false);
    // 关系仍在本地缓存里：挡住这次重开的是「交换已结束」，不是「不是联系人」。
    expect(await contacts.getCachedContact(B, A)).toMatchObject({ name: 'Alice' });
  });
});

describe('a2a reception service › 5-minute nudge (AC-18)', () => {
  it('tells the peer once that the receiver is still deciding', async () => {
    await writeContacts(B, [A]);
    const chats = await seedConversation('waiting');
    const { scheduleReceptionNudge, receptionPendingReplyText, resetReceptionNudges } = await import(
      '../../../../src/main/features/a2a/reception-nudge'
    );
    resetReceptionNudges();
    const send = vi.fn(async () => ({ messageId: 'out-1' }));
    const scheduled: Array<() => void> = [];

    scheduleReceptionNudge(B, CID, A, {
      send,
      setTimeoutFn: (handler: () => void) => {
        scheduled.push(handler);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
    });
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const stored = await chats.getConversation(B, CID);
    expect(stored?.a2a).toMatchObject({ state: 'waiting', nudged: true });
    expect(send.mock.calls[0][0]).toMatchObject({ to: A, conversationId: CID, kind: 'answer' });
    expect(send.mock.calls[0][0].text).toBe(receptionPendingReplyText());
  });

  it('sends no nudge when contact deletion completes after the initial read', async () => {
    await writeContacts(B, [A]);
    const chats = await seedConversation('waiting');
    let releaseInitialRead!: () => void;
    const initialReadRelease = new Promise<void>((resolve) => { releaseInitialRead = resolve; });
    let markInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => { markInitialRead = resolve; });
    let firstOperation: 'get' | 'atomic' | null = null;
    let markNudgeDone!: () => void;
    const nudgeDone = new Promise<void>((resolve) => { markNudgeDone = resolve; });

    vi.doMock('../../../../src/main/features/chats', () => ({
      ...chats,
      getConversation: async (...args: Parameters<typeof chats.getConversation>) => {
        const result = await chats.getConversation(...args);
        if (!firstOperation) {
          firstOperation = 'get';
          markInitialRead();
          await initialReadRelease;
        }
        return result;
      },
      updateConversation: async (...args: Parameters<typeof chats.updateConversation>) => {
        try {
          return await chats.updateConversation(...args);
        } finally {
          if (firstOperation === 'get') markNudgeDone();
        }
      },
      updateConversationAtomic: async (...args: Parameters<typeof chats.updateConversationAtomic>) => {
        const isNudgeOperation = !firstOperation;
        if (isNudgeOperation) {
          firstOperation = 'atomic';
          markInitialRead();
          await initialReadRelease;
        }
        try {
          return await chats.updateConversationAtomic(...args);
        } finally {
          if (isNudgeOperation) markNudgeDone();
        }
      },
    }));
    vi.resetModules();
    const { scheduleReceptionNudge, resetReceptionNudges } = await import('../../../../src/main/features/a2a/reception-nudge');
    const { endExchangesWithPeer } = await import('../../../../src/main/features/a2a/end-exchange');
    resetReceptionNudges();
    const send = vi.fn(async () => ({ messageId: 'out-1' }));
    const scheduled: Array<() => void> = [];
    scheduleReceptionNudge(B, CID, A, {
      send,
      setTimeoutFn: (handler: () => void) => {
        scheduled.push(handler);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
    });

    scheduled[0]();
    await initialRead;
    await writeContacts(B, []);
    await endExchangesWithPeer(B, A);
    releaseInitialRead();
    await nudgeDone;

    expect(send).not.toHaveBeenCalled();
    expect((await chats.getConversation(B, CID))?.a2a).toMatchObject({ state: 'ended' });
  });

  it('stays silent when the receiver already accepted', async () => {
    await seedConversation('active');
    const { scheduleReceptionNudge, resetReceptionNudges } = await import('../../../../src/main/features/a2a/reception-nudge');
    resetReceptionNudges();
    const send = vi.fn(async () => ({ messageId: 'out-1' }));
    const scheduled: Array<() => void> = [];

    scheduleReceptionNudge(B, CID, A, {
      send,
      setTimeoutFn: (handler: () => void) => {
        scheduled.push(handler);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
    });
    scheduled[0]();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('a2a relay pump › single consumer', () => {
  const identity = () => ({ accountId: B, sessionId: 'trusted-pump-fixture', generation: 1 });
  const activeUserId = () => B;
  const relayQuestion = {
    messageId: 'amsg-pump-1',
    fromAccount: A,
    toAccount: B,
    conversationId: CID,
    kind: 'question' as const,
    text: '报价能给八折吗？',
    createdAt: '2026-10-22T10:00:00.000Z',
  };

  it('advances one cursor per account and hands every message on once', async () => {
    const { resetRelayPumpForTest, pumpOnce } = await import('../../../../src/main/features/a2a/relay-pump');
    resetRelayPumpForTest();
    const poll = vi.fn(async (since?: string) => (
      since ? [] : [relayQuestion, { ...relayQuestion, messageId: 'amsg-pump-2', kind: 'answer' as const }]
    ));
    const delivered: string[] = [];
    const deps = {
      poll,
      identity,
      activeUserId,
      receive: async (_uid: string, message: { messageId: string }) => { delivered.push(message.messageId); },
    };

    expect(await pumpOnce(deps)).toBe(2);
    expect(delivered).toEqual(['amsg-pump-1', 'amsg-pump-2']);
    // 第二轮用最新一条的 createdAt 作 since：对端不会再收到一次。
    expect(await pumpOnce(deps)).toBe(0);
    expect(poll).toHaveBeenLastCalledWith('2026-10-22T10:00:00.000Z');
  });

  it('skips the round until there is an active user', async () => {
    const { resetRelayPumpForTest, pumpOnce } = await import('../../../../src/main/features/a2a/relay-pump');
    resetRelayPumpForTest();
    const poll = vi.fn(async () => [relayQuestion]);
    expect(await pumpOnce({ poll, activeUserId: () => null })).toBe(0);
    expect(poll).not.toHaveBeenCalled();
  });

  it('emits an accepted answer only after it is persisted', async () => {
    await writeContacts(B, [A]);
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(B, { conversationId: CID, title: 'outgoing' });
    await chats.updateConversation(B, CID, {
      a2a: { outgoing: true, peer_user_id: A, state: 'active', exchange_id: CID },
    });
    const { receiveRelayMessage } = await import('../../../../src/main/features/a2a/relay-pump');
    const events: Array<{ type: string }> = [];
    await receiveRelayMessage(B, { ...relayQuestion, kind: 'answer', text: '最多九折' }, {
      identity,
      activeUserId,
      onEvent: (event) => events.push({ type: event.type }),
    });
    expect(events).toEqual([{ type: 'message' }]);
  });

  it('does not emit an answer rejected by a terminal exchange', async () => {
    await writeContacts(B, [A]);
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(B, { conversationId: CID, title: 'ended outgoing' });
    await chats.updateConversation(B, CID, {
      a2a: { outgoing: true, peer_user_id: A, state: 'ended', exchange_id: CID },
    });
    const { receiveRelayMessage } = await import('../../../../src/main/features/a2a/relay-pump');
    const events: Array<{ type: string }> = [];

    await receiveRelayMessage(B, { ...relayQuestion, kind: 'answer', text: '迟到的回答' }, {
      identity,
      activeUserId,
      onEvent: (event) => events.push({ type: event.type }),
    });

    expect(events).toEqual([]);
  });

  it('reports a waiting reception and asks nothing of the assistant (D-04)', async () => {
    const { writeJson } = await import('../../../../src/main/storage');
    const { userContactsFile } = await import('../../../../src/main/paths');
    await writeJson(userContactsFile(B), {
      version: 1,
      contacts: [{ userId: A, name: 'Alice', addedAt: new Date().toISOString() }],
    });
    const { receiveRelayMessage } = await import('../../../../src/main/features/a2a/relay-pump');
    const { resetReceptionNudges } = await import('../../../../src/main/features/a2a/reception-nudge');
    resetReceptionNudges();
    const events: Array<{ type: string; awaitingConfirmation?: boolean }> = [];

    await receiveRelayMessage(B, { ...relayQuestion, createdAt: new Date().toISOString() }, { identity, activeUserId, onEvent: (event) => events.push(event) });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'question', awaitingConfirmation: true });
  });
});

describe('a2a reception run › what the model sees', () => {
  it('prepends the reception rules and keeps the visitor wording', async () => {
    const { buildReceptionModelText } = await import('../../../../src/main/features/a2a/reception-run');
    const modelText = await buildReceptionModelText({
      userId: B,
      conversationId: CID,
      peerName: 'Alice',
      question: '报价能给八折吗？',
      workspace: '/tmp/granted-ws',
    });

    expect(modelText).toContain('报价能给八折吗？');
    expect(modelText).toContain('/tmp/granted-ws');
    // 规则来自提示词文件，而不是散落在代码里的长文案。
    expect(modelText).toContain('Reception scope');
    // 对端原话包在明确的来访块里，模型不会把它当成本人的消息。
    expect(modelText).toContain('a2a-visitor-message');
  });

  it('carries the receiver private instructions into the run only', async () => {
    await seedConversation('active');
    const instructions = await import('../../../../src/main/features/a2a/instructions');
    await instructions.appendInstruction(B, CID, '不要透露我方底价');
    const { buildReceptionModelText } = await import('../../../../src/main/features/a2a/reception-run');

    const modelText = await buildReceptionModelText({
      userId: B, conversationId: CID, peerName: 'Alice', question: '底价多少？',
    });
    expect(modelText).toContain('不要透露我方底价');

    // 同样的指示不会进入一个还没接受接访的会话（AC-16）。
    await seedConversation('waiting');
    const notYet = await buildReceptionModelText({
      userId: B, conversationId: CID, peerName: 'Alice', question: '底价多少？',
    });
    expect(notYet).not.toContain('不要透露我方底价');
  });
});

describe('a2a reception service › a deleted conversation is not a dead end', () => {
  it('revives the exchange the user deleted (only removing the contact ends it)', async () => {
    const { writeJson } = await import('../../../../src/main/storage');
    const { userContactsFile } = await import('../../../../src/main/paths');
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');
    await writeJson(userContactsFile(B), {
      version: 1,
      contacts: [{ userId: A, name: 'Alice', addedAt: new Date().toISOString() }],
    });

    // 会话被用户删掉（软删除 → 回收站），但关系仍在。
    await chats.createConversation(B, { conversationId: CID, title: 'Alice 的来访' });
    await chats.updateConversation(B, CID, {
      a2a: { role: 'receiver', peer_user_id: A, state: 'waiting', exchange_id: CID },
    });
    await chats.deleteConversation(B, CID);
    expect(await chats.getConversation(B, CID)).toBeNull();

    const decision = await handleInboundQuestion(B, { ...question, messageId: 'amsg-revive' });
    expect(decision.accepted).toBe(true);
    const revived = await chats.getConversation(B, CID);
    expect(revived).not.toBeNull();
    expect(revived?.a2a).toMatchObject({ role: 'receiver', peer_user_id: A });
  });

  it('does not revive an ended tombstone after the contact is re-added', async () => {
    await writeContacts(B, [A]);
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(B, { conversationId: CID, title: 'ended incoming' });
    await chats.updateConversation(B, CID, {
      a2a: { role: 'receiver', peer_user_id: A, state: 'active', exchange_id: CID },
    });
    const contacts = await import('../../../../src/main/features/contacts/store');
    await expect(contacts.deleteContact(B, A)).resolves.toMatchObject({
      removed: true, ended: 1, cleanupPending: false,
    });
    await chats.deleteConversation(B, CID);
    const request = await contacts.requestAdd(B, {
      phone: '13800001234', peerUserId: A, peerName: 'Alice',
    });
    await contacts.acceptRequest(B, request.id);
    const indexFile = path.join(tmp, B, 'cloud', 'chats', '_index.json');
    const before = fs.readFileSync(indexFile, 'utf8');

    await expect(handleInboundQuestion(B, { ...question, messageId: 'amsg-ended-tombstone' }))
      .resolves.toEqual({ accepted: false, reason: 'conversation_unavailable' });
    expect(await chats.getConversation(B, CID)).toBeNull();
    expect(fs.readFileSync(indexFile, 'utf8')).toBe(before);
  });
});

describe('a2a reception service › who answers', () => {
  it('falls back to the built-in assistant for an unknown or external agent', async () => {
    const { resolveReceptionAssistant } = await import('../../../../src/main/features/a2a/reception-run');
    // 没有这个 Agent：回落 commander，而不是把来访派给一个不存在的收件人。
    expect(await resolveReceptionAssistant(B, 'agent-that-does-not-exist')).toBe('commander');
    expect(await resolveReceptionAssistant(B, '')).toBe('commander');
    expect(await resolveReceptionAssistant(B, null)).toBe('commander');
  });

  it('stores the chosen assistant on the marker and refuses one that cannot receive', async () => {
    await writeContacts(B, [A]);
    const chats = await seedConversation('waiting');

    const refused = await confirmScope(B, { conversationId: CID, assistantAgentId: 'agent-that-does-not-exist' });
    expect(refused).toEqual({ error: 'assistant_unavailable' });
    // 拒绝不改变状态：会话仍在等本人确认。
    expect((await chats.getConversation(B, CID))?.a2a).toMatchObject({ state: 'waiting' });

    const workspace = fs.mkdtempSync(path.join(tmp, 'scope-'));
    const confirmed = await confirmScope(B, { conversationId: CID, workspace });
    expect('error' in confirmed).toBe(false);
    if ('error' in confirmed) return;
    expect(confirmed.marker.state).toBe('active');
    expect(confirmed.marker.assistant_agent_id).toBeUndefined();
  });

  it('does not confirm a waiting reception after contact authority disappears', async () => {
    const chats = await seedConversation('waiting');
    await writeContacts(B, []);

    await expect(confirmScope(B, { conversationId: CID, workspace: tmp }))
      .resolves.toEqual({ error: 'contact not found' });
    expect((await chats.getConversation(B, CID))?.a2a).toMatchObject({ state: 'waiting' });
  });
});

describe('a2a instructions › what counts as a private instruction (FR-32)', () => {
  it('remembers a plain message in a reception conversation, and nothing else', async () => {
    const chats = await seedConversation('active');
    const instructions = await import('../../../../src/main/features/a2a/instructions');

    const recorded = await instructions.rememberReceiverInstruction(B, CID, '不要透露我方底价', false);
    expect(recorded).toMatchObject({ conversationId: CID, text: '不要透露我方底价' });

    // 带点名＝发给某个收件人的任务，不是口径。
    expect(await instructions.rememberReceiverInstruction(B, CID, '@某agent 帮我看下', true)).toBeNull();
    // 发起方会话 / 普通会话里的聊天与对端无关。
    await chats.updateConversation(B, CID, {
      a2a: { role: 'initiator', peer_user_id: A, state: 'active', exchange_id: CID },
    });
    expect(await instructions.rememberReceiverInstruction(B, CID, '随便聊聊', false)).toBeNull();
    expect(await instructions.rememberReceiverInstruction(B, 'no-such-cid', '随便聊聊', false)).toBeNull();
  });
});

describe('a2a exchange lifecycle › removing a contact ends its exchanges (AC-10)', () => {
  it('reconciles every live marker against the authoritative roster without ending current contacts', async () => {
    const { reconcileExchangesWithContacts } = await import('../../../../src/main/features/a2a/end-exchange');
    const chats = await import('../../../../src/main/features/chats');
    await seedConversation('active');
    const retainedCid = 'a2a-11112222333344445555';
    await chats.createConversation(B, { conversationId: retainedCid, title: 'retained peer' });
    await chats.updateConversation(B, retainedCid, {
      a2a: { role: 'receiver', peer_user_id: 'cs_retained', state: 'waiting', exchange_id: retainedCid },
    });

    expect(await reconcileExchangesWithContacts(B, ['cs_retained'])).toBe(1);
    expect((await chats.getConversation(B, CID))?.a2a).toMatchObject({ state: 'ended' });
    expect((await chats.getConversation(B, retainedCid))?.a2a).toMatchObject({ state: 'waiting' });
    expect(await reconcileExchangesWithContacts(B, ['cs_retained'])).toBe(0);
  });

  it('ends every conversation with that peer and leaves other peers alone', async () => {
    const { endExchangesWithPeer } = await import('../../../../src/main/features/a2a/end-exchange');
    const chats = await import('../../../../src/main/features/chats');
    await seedConversation('active');                        // CID ↔ A（接访）
    await chats.createConversation(B, { conversationId: 'a2a-abcdefabcdefabcdef01', title: '与 Alice 的对话' });
    await chats.updateConversation(B, 'a2a-abcdefabcdefabcdef01', {
      a2a: { role: 'initiator', peer_user_id: A, state: 'active', exchange_id: 'a2a-abcdefabcdefabcdef01' },
    });
    await chats.createConversation(B, { conversationId: 'a2a-11112222333344445555', title: '别人的来访' });
    await chats.updateConversation(B, 'a2a-11112222333344445555', {
      a2a: { role: 'receiver', peer_user_id: 'cs_other', state: 'waiting', exchange_id: 'a2a-11112222333344445555' },
    });

    expect(await endExchangesWithPeer(B, A)).toBe(2);
    expect((await chats.getConversation(B, CID))?.a2a).toMatchObject({ state: 'ended' });
    expect((await chats.getConversation(B, 'a2a-abcdefabcdefabcdef01'))?.a2a).toMatchObject({ state: 'ended' });
    // 别的联系人的交换完全不受影响。
    expect((await chats.getConversation(B, 'a2a-11112222333344445555'))?.a2a).toMatchObject({ state: 'waiting' });
    // 幂等：再收尾一次不报错、也不多算。
    expect(await endExchangesWithPeer(B, A)).toBe(0);
  });

  it('does not reopen an ended exchange when the peer asks again', async () => {
    const { endExchangesWithPeer } = await import('../../../../src/main/features/a2a/end-exchange');
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const { writeJson } = await import('../../../../src/main/storage');
    const { userContactsFile } = await import('../../../../src/main/paths');
    await writeJson(userContactsFile(B), {
      version: 1,
      contacts: [{ userId: A, name: 'Alice', addedAt: new Date().toISOString() }],
    });
    await seedConversation('active');
    await endExchangesWithPeer(B, A);

    const decision = await handleInboundQuestion(B, { ...question, messageId: 'amsg-after-remove' });
    expect(decision).toEqual({ accepted: false, reason: 'conversation_unavailable' });
  });
});

describe('a2a reception service › expired tombstone is never run again', () => {
  it('skips a late run directly from the tombstone without entering the recovery chain', async () => {
    await writeContacts(B, [A]);
    await seedConversation('active', { workspace: tmp });
    const service = await import('../../../../src/main/features/a2a/reception-service');
    await expect(service.handleInboundQuestion(B, question)).resolves.toMatchObject({ accepted: true });

    const { expireReceptionEntries } = await import('../../../../src/main/features/a2a/reception-ledger');
    expect(await expireReceptionEntries(B, [{
      messageId: question.messageId, conversationId: CID, peerUserId: A,
    }])).toBe(1);

    // 直接调用运行入口（不经过 recoverClaimedReceptions）：墓碑必须被安静跳过。
    const { runReception } = await import('../../../../src/main/features/a2a/reception-run');
    const bus = createBus();
    const send = vi.fn(async () => ({ messageId: 'must-not-send' }));
    await expect(runReception(B, question, { ...bus.deps, send, timeoutMs: 10 }))
      .resolves.toEqual({ status: 'skipped', error: 'reception expired' });
    expect(bus.enqueued).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
});
