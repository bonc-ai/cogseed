import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const storageMocks = vi.hoisted(() => ({
  appendJsonlAtomic: vi.fn(),
  rewriteJsonlRecords: vi.fn(),
}));

vi.mock('../../../../src/main/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/storage')>();
  return {
    ...actual,
    appendJsonlAtomic: (...args: Parameters<typeof actual.appendJsonlAtomic>) => (
      storageMocks.appendJsonlAtomic(...args)
    ),
    rewriteJsonlRecords: (...args: Parameters<typeof actual.rewriteJsonlRecords>) => (
      storageMocks.rewriteJsonlRecords(...args)
    ),
  };
});

let tmpDir: string;
let previousWorkspace: string | undefined;
const UID = 'u-run-finalize';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-run-finalize-'));
  previousWorkspace = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  storageMocks.appendJsonlAtomic.mockReset();
  storageMocks.rewriteJsonlRecords.mockReset();
  const storage = await vi.importActual<typeof import('../../../../src/main/storage')>(
    '../../../../src/main/storage',
  );
  storageMocks.appendJsonlAtomic.mockImplementation(storage.appendJsonlAtomic);
  storageMocks.rewriteJsonlRecords.mockImplementation(storage.rewriteJsonlRecords);
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('group_chat › durable run finalization (FR-018)', () => {
  it('总结 append 故障保留 pending outbox，重启后重试并只落一条消息', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Run finalization once' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const run = await store.createRun({
      uid: UID,
      cid,
      submittedText: '请失败成员给出结果',
      memberAgentIds: ['agent-failed'],
      mentionAgentIds: ['agent-failed'],
    });
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-failed', {
      terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
    });

    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    let injected = false;
    storageMocks.appendJsonlAtomic.mockImplementation(async (file, record) => {
      if (!injected && (record as any)?.run_summary?.run_id === run!.run_id) {
        injected = true;
        throw new Error('injected summary append failure');
      }
      return actualStorage.appendJsonlAtomic(file, record);
    });

    const groupChat = await import('../../../../src/main/features/group_chat');
    await groupChat.reconcileRun(UID, cid, run!.run_id);
    expect(await store.readRun(UID, cid, run!.run_id)).toMatchObject({
      status: 'failed',
      summary_publication: {
        status: 'pending',
        message_id: `run-summary-${run!.run_id}`,
      },
    });
    expect((await groupChat.readMessages(UID, cid))
      .filter((message) => message.run_summary?.run_id === run!.run_id)).toHaveLength(0);

    const restartTrigger = await store.createRun({
      uid: UID,
      cid,
      submittedText: 'restart reconciliation trigger',
      memberAgentIds: [],
      mentionAgentIds: [],
    });
    await store.stopRun(UID, cid, restartTrigger!.run_id);
    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.dropConv(UID, cid);
    vi.resetModules();
    storageMocks.appendJsonlAtomic.mockImplementation(actualStorage.appendJsonlAtomic);
    (await import('../../../../src/main/features/users')).activateUser(UID);
    const restartedGroupChat = await import('../../../../src/main/features/group_chat');
    // The pending run is intentionally not re-added by id. Reconciling any
    // run after restart must discover the pending outbox by scanning run files.
    await restartedGroupChat.reconcileRun(UID, cid, restartTrigger!.run_id);

    const messages = await restartedGroupChat.readMessages(UID, cid);
    const summaries = messages.filter((message) => message.run_summary?.run_id === run!.run_id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: `run-summary-${run!.run_id}`,
      from: 'commander',
      to: ['user'],
      text: '',
      run_id: run!.run_id,
      run_summary: {
        run_id: run!.run_id,
        status: 'failed',
        contributed: [],
        missing: [{
          agent_id: 'agent-failed', terminal: 'failed', reason: 'runtime_failed',
        }],
      },
    });
    expect(await (await import('../../../../src/main/features/group_chat/run_store'))
      .readRun(UID, cid, run!.run_id)).toMatchObject({
      summary_publication: {
        status: 'published',
        message_id: `run-summary-${run!.run_id}`,
      },
    });
  });

  it('并发 reconciler 共用确定性消息 id，不重复追加 summary', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Concurrent run reconcilers' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const run = await store.createRun({
      uid: UID,
      cid,
      submittedText: '请并发收口',
      memberAgentIds: ['agent-done'],
      mentionAgentIds: ['agent-done'],
    });
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-done', {
      terminal: 'done', messages: 1, artifacts: [],
    });
    await store.finalizeRun(UID, cid, run!.run_id);

    const groupChat = await import('../../../../src/main/features/group_chat');
    await Promise.all([
      groupChat.reconcileRun(UID, cid, run!.run_id),
      groupChat.reconcileRun(UID, cid, run!.run_id),
      groupChat.reconcileRun(UID, cid, run!.run_id),
    ]);

    const summaries = (await groupChat.readMessages(UID, cid))
      .filter((message) => message.run_summary?.run_id === run!.run_id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(`run-summary-${run!.run_id}`);
    expect(await store.readRun(UID, cid, run!.run_id)).toMatchObject({
      summary_publication: {
        status: 'published',
        message_id: `run-summary-${run!.run_id}`,
      },
    });
  });

  it('重建 loader 前后的两个 reconciler 并发发布时仍只落一条 summary', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Dual loader reconcilers' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const run = await store.createRun({
      uid: UID,
      cid,
      submittedText: '跨 loader 并发收口',
      memberAgentIds: ['agent-loader'],
      mentionAgentIds: ['agent-loader'],
    });
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-loader', {
      terminal: 'done', messages: 1, artifacts: [],
    });
    await store.finalizeRun(UID, cid, run!.run_id);

    const firstLoader = await import('../../../../src/main/features/group_chat');
    vi.resetModules();
    (await import('../../../../src/main/features/users')).activateUser(UID);
    const secondLoader = await import('../../../../src/main/features/group_chat');

    await Promise.all([
      firstLoader.reconcileRun(UID, cid, run!.run_id),
      secondLoader.reconcileRun(UID, cid, run!.run_id),
    ]);

    const summaries = (await secondLoader.readMessages(UID, cid))
      .filter((message) => message.id === `run-summary-${run!.run_id}`);
    expect(summaries).toHaveLength(1);
    expect(await (await import('../../../../src/main/features/group_chat/run_store'))
      .readRun(UID, cid, run!.run_id)).toMatchObject({
      summary_publication: {
        status: 'published',
        message_id: `run-summary-${run!.run_id}`,
      },
    });
  });

  it('两个重建 run_store loader 并发发布同一 outbox 时只执行一个 publisher', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Dual loader run-store publishers' });
    const cid = conversation.conversation_id;
    const firstStore = await import('../../../../src/main/features/group_chat/run_store');
    const run = await firstStore.createRun({
      uid: UID,
      cid,
      submittedText: '跨 loader 直接竞争 outbox',
      memberAgentIds: ['agent-outbox'],
      mentionAgentIds: ['agent-outbox'],
    });
    await firstStore.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-outbox', {
      terminal: 'done', messages: 1, artifacts: [],
    });
    const finalized = await firstStore.finalizeRun(UID, cid, run!.run_id);
    const publicationId = finalized!.summary_publication!.publication_id;
    const messageId = `run-summary-${run!.run_id}`;

    vi.resetModules();
    const secondStore = await import('../../../../src/main/features/group_chat/run_store');
    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    const durableOutput = path.join(tmpDir, 'dual-loader-summary.jsonl');
    let firstPublisherCalls = 0;
    let secondPublisherCalls = 0;
    let notifyFirstPublisherStarted!: () => void;
    const firstPublisherStarted = new Promise<void>((resolve) => {
      notifyFirstPublisherStarted = resolve;
    });
    let notifySecondCallStarted!: () => void;
    const secondCallStarted = new Promise<void>((resolve) => {
      notifySecondCallStarted = resolve;
    });

    const firstPublish = firstStore.publishPendingRunSummary(
      UID,
      cid,
      run!.run_id,
      publicationId,
      async (current) => {
        firstPublisherCalls += 1;
        notifyFirstPublisherStarted();
        // Keep the first loader inside its publisher until the second loader
        // has entered the same public API with the same pending generation.
        await secondCallStarted;
        await actualStorage.appendJsonlAtomic(durableOutput, {
          id: current.summary_publication!.message_id,
          run_id: current.run_id,
          publication_id: current.summary_publication!.publication_id,
        });
      },
    );
    await firstPublisherStarted;

    const secondPublish = secondStore.publishPendingRunSummary(
      UID,
      cid,
      run!.run_id,
      publicationId,
      async (current) => {
        secondPublisherCalls += 1;
        await actualStorage.appendJsonlAtomic(durableOutput, {
          id: current.summary_publication!.message_id,
          run_id: current.run_id,
          publication_id: current.summary_publication!.publication_id,
        });
      },
    );
    notifySecondCallStarted();
    await Promise.all([firstPublish, secondPublish]);

    expect(firstPublisherCalls).toBe(1);
    expect(secondPublisherCalls).toBe(0);
    expect(await actualStorage.readJsonl(durableOutput, 0)).toEqual([{
      id: messageId,
      run_id: run!.run_id,
      publication_id: publicationId,
    }]);
    expect(await secondStore.readRun(UID, cid, run!.run_id)).toMatchObject({
      status: 'completed',
      summary_publication: {
        status: 'published',
        message_id: messageId,
        publication_id: publicationId,
      },
    });
  });

  it('兼容 legacy v1 pending/published outbox，并继续严格拒绝坏状态与坏消息 id', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Legacy summary publications' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');

    const pendingRun = await store.createRun({
      uid: UID,
      cid,
      submittedText: 'legacy pending summary',
      memberAgentIds: ['agent-legacy-pending'],
      mentionAgentIds: ['agent-legacy-pending'],
    });
    await store.recordRunActorTerminal(UID, cid, pendingRun!.run_id, 'agent-legacy-pending', {
      terminal: 'done', messages: 1, artifacts: [],
    });
    await store.finalizeRun(UID, cid, pendingRun!.run_id);
    const pendingFile = store.runFileOf(UID, cid, pendingRun!.run_id);
    const legacyPending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    delete legacyPending.summary_publication.publication_id;
    fs.writeFileSync(pendingFile, JSON.stringify(legacyPending), 'utf8');

    const decodedPending = await store.readRun(UID, cid, pendingRun!.run_id);
    const decodedPendingAgain = await store.readRun(UID, cid, pendingRun!.run_id);
    expect(decodedPending).toMatchObject({ summary_publication: { status: 'pending' } });
    expect(decodedPending!.summary_publication!.publication_id)
      .toBe(decodedPendingAgain!.summary_publication!.publication_id);
    expect(decodedPending!.summary_publication!.publication_id).toMatch(/^[A-Za-z0-9_-]+$/);
    let pendingPublisherCalls = 0;
    await store.publishPendingRunSummary(
      UID,
      cid,
      pendingRun!.run_id,
      decodedPending!.summary_publication!.publication_id,
      async () => { pendingPublisherCalls += 1; },
    );
    expect(pendingPublisherCalls).toBe(1);
    expect(await store.readRun(UID, cid, pendingRun!.run_id)).toMatchObject({
      summary_publication: {
        status: 'published',
        publication_id: decodedPending!.summary_publication!.publication_id,
      },
    });

    const publishedRun = await store.createRun({
      uid: UID,
      cid,
      submittedText: 'legacy published summary',
      memberAgentIds: ['agent-legacy-published'],
      mentionAgentIds: ['agent-legacy-published'],
    });
    await store.recordRunActorTerminal(UID, cid, publishedRun!.run_id, 'agent-legacy-published', {
      terminal: 'done', messages: 1, artifacts: [],
    });
    const finalizedPublished = await store.finalizeRun(UID, cid, publishedRun!.run_id);
    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    const legacyPublishedOutput = path.join(tmpDir, 'legacy-published-summary.jsonl');
    let durablePublishes = 0;
    await store.publishPendingRunSummary(
      UID,
      cid,
      publishedRun!.run_id,
      finalizedPublished!.summary_publication!.publication_id,
      async (current) => {
        durablePublishes += 1;
        await actualStorage.appendJsonlAtomic(legacyPublishedOutput, {
          id: current.summary_publication!.message_id,
        });
      },
    );
    const publishedFile = store.runFileOf(UID, cid, publishedRun!.run_id);
    const legacyPublished = JSON.parse(fs.readFileSync(publishedFile, 'utf8'));
    delete legacyPublished.summary_publication.publication_id;
    fs.writeFileSync(publishedFile, JSON.stringify(legacyPublished), 'utf8');

    const decodedPublished = await store.readRun(UID, cid, publishedRun!.run_id);
    expect(decodedPublished).toMatchObject({ summary_publication: { status: 'published' } });
    await store.publishPendingRunSummary(
      UID,
      cid,
      publishedRun!.run_id,
      decodedPublished!.summary_publication!.publication_id,
      async () => { durablePublishes += 1; },
    );
    expect(durablePublishes).toBe(1);
    expect(await actualStorage.readJsonl(legacyPublishedOutput, 0)).toEqual([{
      id: `run-summary-${publishedRun!.run_id}`,
    }]);

    const malformed = JSON.parse(fs.readFileSync(publishedFile, 'utf8'));
    malformed.summary_publication.status = 'unknown';
    fs.writeFileSync(publishedFile, JSON.stringify(malformed), 'utf8');
    expect(await store.readRun(UID, cid, publishedRun!.run_id)).toBeNull();
    malformed.summary_publication.status = 'published';
    malformed.summary_publication.message_id = 'wrong-summary-message';
    fs.writeFileSync(publishedFile, JSON.stringify(malformed), 'utf8');
    expect(await store.readRun(UID, cid, publishedRun!.run_id)).toBeNull();
  });

  it('重试重新收口时原地替换已发布 summary，不保留旧失败内容', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Replace stale run summary' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const run = await store.createRun({
      uid: UID,
      cid,
      submittedText: '先失败再重试成功',
      memberAgentIds: ['agent-retry'],
      mentionAgentIds: ['agent-retry'],
    });
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-retry', {
      terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
    });
    const groupChat = await import('../../../../src/main/features/group_chat');
    await groupChat.reconcileRun(UID, cid, run!.run_id);

    await store.prepareRunRetry(UID, cid, run!.run_id, ['agent-retry'], 'retry-summary-replace');
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-retry', {
      terminal: 'done', messages: 1, artifacts: ['retry-result'],
    });
    await store.finalizeRun(UID, cid, run!.run_id);
    await groupChat.reconcileRun(UID, cid, run!.run_id);

    const summaries = (await groupChat.readMessages(UID, cid))
      .filter((message) => message.id === `run-summary-${run!.run_id}`);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].run_summary).toEqual({
      run_id: run!.run_id,
      status: 'completed',
      contributed: [{ agent_id: 'agent-retry', messages: 1, artifacts: ['retry-result'] }],
      missing: [],
    });
    expect(await store.readRun(UID, cid, run!.run_id)).toMatchObject({
      status: 'completed',
      summary_publication: { status: 'published' },
    });
  });

  it('重试重发 summary 时原地更新 commander visibility slice，不保留旧卡片', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Replace summary visibility' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const run = await store.createRun({
      uid: UID,
      cid,
      submittedText: 'visibility summary retry',
      memberAgentIds: ['agent-slice'],
      mentionAgentIds: ['agent-slice'],
    });
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-slice', {
      terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
    });
    const groupChat = await import('../../../../src/main/features/group_chat');
    await groupChat.reconcileRun(UID, cid, run!.run_id);

    await store.prepareRunRetry(UID, cid, run!.run_id, ['agent-slice'], 'retry-summary-slice');
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-slice', {
      terminal: 'done', messages: 1, artifacts: [],
    });
    await store.finalizeRun(UID, cid, run!.run_id);
    await groupChat.reconcileRun(UID, cid, run!.run_id);

    const { readSlice } = await import('../../../../src/main/features/group_chat/visibility');
    const summaries = (await readSlice(UID, cid, 'commander', 0))
      .filter((message) => message.id === `run-summary-${run!.run_id}`);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].run_summary).toEqual({
      run_id: run!.run_id,
      status: 'completed',
      contributed: [{ agent_id: 'agent-slice', messages: 1, artifacts: [] }],
      missing: [],
    });
  });

  it('summary revision 用 reload broadcast 通知已打开 renderer，且不重复 emit message', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Live summary revision' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const run = await store.createRun({
      uid: UID,
      cid,
      submittedText: 'live summary retry',
      memberAgentIds: ['agent-live'],
      mentionAgentIds: ['agent-live'],
    });
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-live', {
      terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
    });
    const groupChat = await import('../../../../src/main/features/group_chat');
    await groupChat.reconcileRun(UID, cid, run!.run_id);

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const broadcasts: Array<Record<string, unknown>> = [];
    const events: Array<{ type: string; msg?: { id?: string } }> = [];
    const unsubscribe = bus.subscribe(UID, cid, (event) => events.push(event));
    bus.setGroupChatMessageBroadcaster((info) => broadcasts.push(info));
    try {
      await store.prepareRunRetry(UID, cid, run!.run_id, ['agent-live'], 'retry-summary-live');
      await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-live', {
        terminal: 'done', messages: 1, artifacts: [],
      });
      await store.finalizeRun(UID, cid, run!.run_id);
      await groupChat.reconcileRun(UID, cid, run!.run_id);

      const messageId = `run-summary-${run!.run_id}`;
      expect(broadcasts).toContainEqual(expect.objectContaining({
        uid: UID,
        cid,
        revisionOf: messageId,
      }));
      const revision = broadcasts.find((entry) => entry.revisionOf === messageId);
      expect(revision).not.toHaveProperty('msgId');
      expect(events.filter((event) => event.type === 'message' && event.msg?.id === messageId))
        .toHaveLength(0);
    } finally {
      bus.setGroupChatMessageBroadcaster(null);
      unsubscribe();
    }
  });

  it('main summary 已更新但 slice 投影失败时保持 pending，重试先修复投影再发布', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Repair partial summary projection' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const run = await store.createRun({
      uid: UID,
      cid,
      submittedText: 'repair partial summary projection',
      memberAgentIds: ['agent-partial'],
      mentionAgentIds: ['agent-partial'],
    });
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-partial', {
      terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
    });
    const groupChat = await import('../../../../src/main/features/group_chat');
    await groupChat.reconcileRun(UID, cid, run!.run_id);
    await store.prepareRunRetry(UID, cid, run!.run_id, ['agent-partial'], 'retry-summary-partial');
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-partial', {
      terminal: 'done', messages: 1, artifacts: [],
    });
    await store.finalizeRun(UID, cid, run!.run_id);

    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    let injected = false;
    storageMocks.rewriteJsonlRecords.mockImplementation(async (file, mutate) => {
      if (!injected && file.endsWith(`${path.sep}visibility${path.sep}commander.jsonl`)) {
        injected = true;
        return { ok: false, error: 'injected commander slice rewrite failure' };
      }
      return actualStorage.rewriteJsonlRecords(file, mutate);
    });
    await groupChat.reconcileRun(UID, cid, run!.run_id);

    const messageId = `run-summary-${run!.run_id}`;
    expect((await groupChat.readMessages(UID, cid)).find((message) => message.id === messageId)
      ?.run_summary?.status).toBe('completed');
    const { readSlice } = await import('../../../../src/main/features/group_chat/visibility');
    expect((await readSlice(UID, cid, 'commander', 0)).find((message) => message.id === messageId)
      ?.run_summary?.status).toBe('failed');
    expect(await store.readRun(UID, cid, run!.run_id)).toMatchObject({
      summary_publication: { status: 'pending' },
    });

    storageMocks.rewriteJsonlRecords.mockImplementation(actualStorage.rewriteJsonlRecords);
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const broadcasts: Array<Record<string, unknown>> = [];
    bus.setGroupChatMessageBroadcaster((info) => broadcasts.push(info));
    try {
      await groupChat.reconcileRun(UID, cid, run!.run_id);
      const repaired = (await readSlice(UID, cid, 'commander', 0))
        .filter((message) => message.id === messageId);
      expect(repaired).toHaveLength(1);
      expect(repaired[0].run_summary?.status).toBe('completed');
      expect(broadcasts).toContainEqual(expect.objectContaining({ revisionOf: messageId }));
      expect(await store.readRun(UID, cid, run!.run_id)).toMatchObject({
        summary_publication: { status: 'published' },
      });
    } finally {
      bus.setGroupChatMessageBroadcaster(null);
    }
  });

  it('summary 替换失败时 outbox 保持 pending，下次 reconcile 再完成发布', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Retry failed summary rewrite' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const run = await store.createRun({
      uid: UID,
      cid,
      submittedText: '替换失败后重试',
      memberAgentIds: ['agent-rewrite'],
      mentionAgentIds: ['agent-rewrite'],
    });
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-rewrite', {
      terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
    });
    const groupChat = await import('../../../../src/main/features/group_chat');
    await groupChat.reconcileRun(UID, cid, run!.run_id);
    await store.prepareRunRetry(UID, cid, run!.run_id, ['agent-rewrite'], 'retry-summary-rewrite');
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-rewrite', {
      terminal: 'done', messages: 1, artifacts: [],
    });
    await store.finalizeRun(UID, cid, run!.run_id);

    storageMocks.rewriteJsonlRecords.mockResolvedValueOnce({
      ok: false,
      error: 'injected summary rewrite failure',
    });
    await groupChat.reconcileRun(UID, cid, run!.run_id);
    expect(await store.readRun(UID, cid, run!.run_id)).toMatchObject({
      summary_publication: { status: 'pending' },
    });

    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    storageMocks.rewriteJsonlRecords.mockImplementation(actualStorage.rewriteJsonlRecords);
    await groupChat.reconcileRun(UID, cid, run!.run_id);
    const summaries = (await groupChat.readMessages(UID, cid))
      .filter((message) => message.id === `run-summary-${run!.run_id}`);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].run_summary?.status).toBe('completed');
    expect(await store.readRun(UID, cid, run!.run_id)).toMatchObject({
      summary_publication: { status: 'published' },
    });
  });

  it('发布快照 append 前 run 被重试重开时，不得把旧失败 summary 当成当前结果', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Run summary publish race' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const run = await store.createRun({
      uid: UID,
      cid,
      submittedText: '发布时被重试重开',
      memberAgentIds: ['agent-race'],
      mentionAgentIds: ['agent-race'],
    });
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-race', {
      terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
    });
    await store.finalizeRun(UID, cid, run!.run_id);

    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let notifyAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => { notifyAppendStarted = resolve; });
    let blocked = false;
    storageMocks.appendJsonlAtomic.mockImplementation(async (file, record) => {
      if (!blocked
        && (record as any)?.run_summary?.run_id === run!.run_id
        && (record as any)?.run_summary?.status === 'failed') {
        blocked = true;
        notifyAppendStarted();
        await appendGate;
      }
      return actualStorage.appendJsonlAtomic(file, record);
    });

    const originalStore = store;
    vi.resetModules();
    (await import('../../../../src/main/features/users')).activateUser(UID);
    const groupChat = await import('../../../../src/main/features/group_chat');
    const stalePublish = groupChat.reconcileRun(UID, cid, run!.run_id);
    await appendStarted;
    const reopen = (async () => {
      await originalStore.prepareRunRetry(UID, cid, run!.run_id, ['agent-race'], 'retry-summary-race');
      await originalStore.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-race', {
        terminal: 'done', messages: 1, artifacts: [],
      });
      await originalStore.finalizeRun(UID, cid, run!.run_id);
    })();
    // Give an unlocked mutation enough event-loop turns to overtake the
    // blocked append. A correct publisher holds the run lock, so reopen waits.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseAppend();
    await Promise.all([stalePublish, reopen]);

    storageMocks.appendJsonlAtomic.mockImplementation(actualStorage.appendJsonlAtomic);
    await groupChat.reconcileRun(UID, cid, run!.run_id);

    const summaries = (await groupChat.readMessages(UID, cid))
      .filter((message) => message.id === `run-summary-${run!.run_id}`);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].run_summary).toMatchObject({
      status: 'completed',
      contributed: [{ agent_id: 'agent-race', messages: 1, artifacts: [] }],
      missing: [],
    });
    expect(await originalStore.readRun(UID, cid, run!.run_id)).toMatchObject({
      status: 'completed',
      summary_publication: { status: 'published' },
    });
  });

  it('已发布 completed summary 后停止 run，原地替换为权威 stopped 状态', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Stop after summary publication' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const run = await store.createRun({
      uid: UID,
      cid,
      submittedText: '发布后停止',
      memberAgentIds: ['agent-stop'],
      mentionAgentIds: ['agent-stop'],
    });
    await store.recordRunActorTerminal(UID, cid, run!.run_id, 'agent-stop', {
      terminal: 'done', messages: 1, artifacts: [],
    });
    const groupChat = await import('../../../../src/main/features/group_chat');
    await groupChat.reconcileRun(UID, cid, run!.run_id);

    await store.stopRun(UID, cid, run!.run_id);
    await groupChat.reconcileRun(UID, cid, run!.run_id);

    const summaries = (await groupChat.readMessages(UID, cid))
      .filter((message) => message.id === `run-summary-${run!.run_id}`);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].run_summary).toMatchObject({
      status: 'stopped',
      contributed: [{ agent_id: 'agent-stop', messages: 1, artifacts: [] }],
      missing: [],
    });
    expect(await store.readRun(UID, cid, run!.run_id)).toMatchObject({
      status: 'stopped',
      summary_publication: { status: 'published' },
    });
  });

  it('会话激活会恢复 all-terminal running orphan，但不收口仍有 pending actor 的 run', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Recover orphan run on activation' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const orphan = await store.createRun({
      uid: UID,
      cid,
      submittedText: 'terminal before finalize crash',
      memberAgentIds: ['agent-orphan'],
      mentionAgentIds: ['agent-orphan'],
    });
    await store.recordRunActorTerminal(UID, cid, orphan!.run_id, 'agent-orphan', {
      terminal: 'done', messages: 1, artifacts: [],
    });
    const stillPending = await store.createRun({
      uid: UID,
      cid,
      submittedText: 'must remain pending',
      memberAgentIds: ['agent-still-pending'],
      mentionAgentIds: ['agent-still-pending'],
    });
    expect(await store.readRun(UID, cid, orphan!.run_id)).toMatchObject({
      status: 'running',
      actors: [{ terminal: 'done' }],
    });

    const oldBus = await import('../../../../src/main/features/group_chat/bus');
    await oldBus.dropConv(UID, cid);
    vi.resetModules();
    (await import('../../../../src/main/features/users')).activateUser(UID);
    const restartedBus = await import('../../../../src/main/features/group_chat/bus');
    const restartedGroupChat = await import('../../../../src/main/features/group_chat');
    const restartedStore = await import('../../../../src/main/features/group_chat/run_store');
    const unsubscribe = restartedBus.subscribe(UID, cid, () => {});
    try {
      let summaries = [] as Awaited<ReturnType<typeof restartedGroupChat.readMessages>>;
      let recovered = await restartedStore.readRun(UID, cid, orphan!.run_id);
      const deadline = Date.now() + 2_000;
      do {
        summaries = (await restartedGroupChat.readMessages(UID, cid))
          .filter((message) => message.run_summary?.run_id === orphan!.run_id);
        recovered = await restartedStore.readRun(UID, cid, orphan!.run_id);
        if (summaries.length && recovered?.summary_publication?.status === 'published') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);

      expect(summaries).toHaveLength(1);
      expect(summaries[0].run_summary?.status).toBe('completed');
      expect(recovered).toMatchObject({
        status: 'completed',
        summary_publication: { status: 'published' },
      });
      expect(await restartedStore.readRun(UID, cid, stillPending!.run_id)).toMatchObject({
        status: 'running',
        actors: [{ terminal: 'pending' }],
      });
      expect((await restartedGroupChat.readMessages(UID, cid))
        .some((message) => message.run_summary?.run_id === stillPending!.run_id)).toBe(false);
    } finally {
      unsubscribe();
      await restartedBus.dropConv(UID, cid);
    }
  });

  it('抑制无 actor 的普通单 Agent 空汇总，但协调者作为 actor 时使用权威 run 状态', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const conversation = await chats.createConversation(UID, { title: 'Suppress empty run summaries' });
    const cid = conversation.conversation_id;
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const emptyRun = await store.createRun({
      uid: UID,
      cid,
      submittedText: '普通默认消息',
      memberAgentIds: [],
      mentionAgentIds: [],
    });
    const commanderRun = await store.createRun({
      uid: UID,
      cid,
      submittedText: '协调者产出结果',
      memberAgentIds: [],
      mentionAgentIds: [],
    });
    await store.recordRunActorTerminal(UID, cid, commanderRun!.run_id, 'commander', {
      terminal: 'done', messages: 1, artifacts: [],
    });
    await store.stopRun(UID, cid, commanderRun!.run_id);

    const groupChat = await import('../../../../src/main/features/group_chat');
    await groupChat.reconcileRun(UID, cid, emptyRun!.run_id);
    await groupChat.reconcileRun(UID, cid, commanderRun!.run_id);

    const messages = await groupChat.readMessages(UID, cid);
    expect(messages.some((message) => message.run_summary?.run_id === emptyRun!.run_id)).toBe(false);
    expect(messages.find((message) => message.run_summary?.run_id === commanderRun!.run_id))
      .toMatchObject({
        id: `run-summary-${commanderRun!.run_id}`,
        run_summary: {
          run_id: commanderRun!.run_id,
          status: 'stopped',
          contributed: [{ agent_id: 'commander', messages: 1, artifacts: [] }],
          missing: [],
        },
      });
    expect(await store.readRun(UID, cid, emptyRun!.run_id)).toMatchObject({
      status: 'failed',
      summary_publication: { status: 'published' },
    });
  });
});
