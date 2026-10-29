import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'u-receiver';
const PEER = 'cs_sender';
const CID = 'a2a-0123456789abcdef0123';
let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-end-race-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../../src/main/features/chats');
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function seedWaitingConversation() {
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(USER, { conversationId: CID, title: 'incoming' });
  await chats.updateConversation(USER, CID, {
    a2a: { role: 'receiver', peer_user_id: PEER, state: 'waiting', exchange_id: CID },
    a2a_pending_reception: {
      messageId: 'amsg-pending',
      conversationId: CID,
      peerUserId: PEER,
      text: 'pending question',
      receivedAt: new Date().toISOString(),
    },
  });
  return chats;
}

async function seedContact() {
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(USER), {
    version: 1,
    contacts: [{ userId: PEER, name: 'Sender', addedAt: new Date().toISOString() }],
  });
}

describe('a2a exchange lifecycle concurrency', () => {
  it('does not authorize a newly created inbound conversation after the contact disappears', async () => {
    await seedContact();
    const chats = await import('../../../../src/main/features/chats');
    let markCreated!: () => void;
    const created = new Promise<void>((resolve) => { markCreated = resolve; });
    let releaseCreated!: () => void;
    const createdRelease = new Promise<void>((resolve) => { releaseCreated = resolve; });

    vi.doMock('../../../../src/main/features/chats', () => ({
      ...chats,
      admitInboundA2AConversationAtomic: async (...args: Parameters<typeof chats.admitInboundA2AConversationAtomic>) => {
        const result = await chats.admitInboundA2AConversationAtomic(...args);
        markCreated();
        await createdRelease;
        return result;
      },
    }));
    vi.resetModules();
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const { writeJson } = await import('../../../../src/main/storage');
    const { userContactsFile } = await import('../../../../src/main/paths');
    const inbound = handleInboundQuestion(USER, {
      messageId: 'amsg-new-after-delete',
      fromAccount: PEER,
      conversationId: CID,
      text: 'new question',
    });
    await created;
    await writeJson(userContactsFile(USER), { version: 1, contacts: [] });
    releaseCreated();

    await expect(inbound).resolves.toEqual({ accepted: false, reason: 'not_contact' });
    expect((await chats.getConversation(USER, CID))?.a2a).toMatchObject({ state: 'ended' });
  });

  it('does not let an inbound merge resurrect an exchange ended by contact deletion', async () => {
    await seedContact();
    const chats = await seedWaitingConversation();
    await chats.updateConversation(USER, CID, {
      a2a: { role: 'receiver', peer_user_id: PEER, state: 'active', exchange_id: CID },
      a2a_pending_reception: undefined,
    });
    let markMergeReady!: () => void;
    const mergeReady = new Promise<void>((resolve) => { markMergeReady = resolve; });
    let releaseMerge!: () => void;
    const mergeRelease = new Promise<void>((resolve) => { releaseMerge = resolve; });
    let markEndedWritten!: () => void;
    const endedWritten = new Promise<void>((resolve) => { markEndedWritten = resolve; });

    vi.doMock('../../../../src/main/features/chats', () => ({
      ...chats,
      admitInboundA2AConversationAtomic: async (...args: Parameters<typeof chats.admitInboundA2AConversationAtomic>) => {
        const input = args[1];
        return chats.admitInboundA2AConversationAtomic(args[0], {
          ...input,
          decide: async (...decideArgs: Parameters<typeof input.decide>) => {
            const decision = await input.decide(...decideArgs);
            if (decision?.marker.state === 'active') {
              markMergeReady();
              await mergeRelease;
            }
            return decision;
          },
        });
      },
      updateConversationAtomic: async (...args: any[]) => (
        chats.updateConversationAtomic(args[0], args[1], async (current: any) => {
          const updates = await args[2](current);
          if (updates?.a2a?.state === 'active') {
            markMergeReady();
            await mergeRelease;
          }
          if (updates?.a2a?.state === 'ended') markEndedWritten();
          return updates;
        }, args[3])
      ),
      updateA2AMarkersIncludingDeletedAtomic: async (...args: any[]) => (
        chats.updateA2AMarkersIncludingDeletedAtomic(args[0], async (marker: any) => {
          const next = await args[1](marker);
          if (next?.state === 'ended') markEndedWritten();
          return next;
        })
      ),
    }));
    vi.resetModules();

    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const { endExchangesWithPeer } = await import('../../../../src/main/features/a2a/end-exchange');
    const inbound = handleInboundQuestion(USER, {
      messageId: 'amsg-racing-inbound',
      fromAccount: PEER,
      conversationId: CID,
      text: 'follow up',
    });
    await mergeReady;
    const end = endExchangesWithPeer(USER, PEER);
    const deleteReachedWrite = await Promise.race([
      endedWritten.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseMerge();
    await Promise.all([inbound, end]);

    expect(deleteReachedWrite).toBe(false);
    expect((await chats.getConversation(USER, CID))?.a2a).toMatchObject({ state: 'ended' });
  });

  it('does not let decline replace an exchange ended by contact deletion', async () => {
    const chats = await seedWaitingConversation();
    let markDeclineReady!: () => void;
    const declineReady = new Promise<void>((resolve) => { markDeclineReady = resolve; });
    let releaseDecline!: () => void;
    const declineRelease = new Promise<void>((resolve) => { releaseDecline = resolve; });
    let markEndedWritten!: () => void;
    const endedWritten = new Promise<void>((resolve) => { markEndedWritten = resolve; });

    vi.doMock('../../../../src/main/features/chats', () => ({
      ...chats,
      updateConversation: async (...args: Parameters<typeof chats.updateConversation>) => {
        if (args[2].a2a?.state === 'refused') {
          markDeclineReady();
          await declineRelease;
        }
        return chats.updateConversation(...args);
      },
      updateConversationAtomic: async (...args: any[]) => {
        const mutate = args[2];
        return chats.updateConversationAtomic(args[0], args[1], async (current: any) => {
          const updates = await mutate(current);
          if (updates?.a2a?.state === 'refused') {
            markDeclineReady();
            await declineRelease;
          }
          if (updates?.a2a?.state === 'ended') markEndedWritten();
          return updates;
        }, args[3]);
      },
      updateA2AMarkersIncludingDeletedAtomic: async (...args: any[]) => (
        chats.updateA2AMarkersIncludingDeletedAtomic(args[0], async (marker: any) => {
          const next = await args[1](marker);
          if (next?.state === 'ended') markEndedWritten();
          return next;
        })
      ),
    }));
    vi.resetModules();

    const { declineReception } = await import('../../../../src/main/features/a2a/reception-service');
    const { endExchangesWithPeer } = await import('../../../../src/main/features/a2a/end-exchange');
    const decline = declineReception(USER, CID);
    await declineReady;
    const end = endExchangesWithPeer(USER, PEER);
    const deleteReachedWrite = await Promise.race([
      endedWritten.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseDecline();
    await Promise.all([decline, end]);

    expect(deleteReachedWrite).toBe(false);
    expect((await chats.getConversation(USER, CID))?.a2a).toMatchObject({ state: 'ended' });
  });

  it('serializes confirm and contact deletion so ended can never be overwritten', async () => {
    await seedContact();
    const chats = await seedWaitingConversation();
    let markActiveReady!: () => void;
    const activeReady = new Promise<void>((resolve) => { markActiveReady = resolve; });
    let releaseActive!: () => void;
    const activeRelease = new Promise<void>((resolve) => { releaseActive = resolve; });
    let markEndedWritten!: () => void;
    const endedWritten = new Promise<void>((resolve) => { markEndedWritten = resolve; });

    vi.doMock('../../../../src/main/features/chats', () => ({
      ...chats,
      updateConversation: async (...args: Parameters<typeof chats.updateConversation>) => {
        const updates = args[2];
        if (updates.a2a?.state === 'active') {
          markActiveReady();
          await activeRelease;
        }
        const result = await chats.updateConversation(...args);
        if (updates.a2a?.state === 'ended') markEndedWritten();
        return result;
      },
      updateConversationAtomic: async (...args: any[]) => {
        const actual = (chats as any).updateConversationAtomic;
        if (typeof actual !== 'function') throw new Error('atomic conversation update unavailable');
        const mutate = args[2];
        return actual(args[0], args[1], async (current: any) => {
          const updates = await mutate(current);
          if (updates?.a2a?.state === 'active') {
            markActiveReady();
            await activeRelease;
          }
          if (updates?.a2a?.state === 'ended') markEndedWritten();
          return updates;
        }, args[3]);
      },
      updateA2AMarkersIncludingDeletedAtomic: async (...args: any[]) => (
        chats.updateA2AMarkersIncludingDeletedAtomic(args[0], async (marker: any) => {
          const next = await args[1](marker);
          if (next?.state === 'ended') markEndedWritten();
          return next;
        })
      ),
    }));
    vi.resetModules();

    const { confirmReception, previewReceptionWorkspace } = await import('../../../../src/main/features/a2a/reception-service');
    const { endExchangesWithPeer } = await import('../../../../src/main/features/a2a/end-exchange');
    const resolved = await previewReceptionWorkspace(USER, { conversationId: CID, workspace: tmp });
    if ('error' in resolved) throw new Error(resolved.error);
    const confirm = confirmReception(USER, { conversationId: CID, workspace: tmp, expectedPreview: resolved.preview });
    await activeReady;
    const end = endExchangesWithPeer(USER, PEER);

    const deleteReachedWrite = await Promise.race([
      endedWritten.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseActive();
    await Promise.all([confirm, end]);

    expect(deleteReachedWrite).toBe(false);
    expect((await chats.getConversation(USER, CID))?.a2a).toMatchObject({ state: 'ended' });

    await chats.updateConversation(USER, CID, {
      a2a: { role: 'receiver', peer_user_id: PEER, state: 'waiting', exchange_id: CID },
    });
    await endExchangesWithPeer(USER, PEER);
    await expect(confirmReception(USER, { conversationId: CID, workspace: tmp }))
      .resolves.toEqual({ error: 'reception is not waiting' });
    expect((await chats.getConversation(USER, CID))?.a2a).toMatchObject({ state: 'ended' });
  });

  it('does not let outbound completion overwrite an ended existing exchange', async () => {
    await seedContact();
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(USER, { conversationId: CID, title: 'outgoing' });
    await chats.updateConversation(USER, CID, {
      a2a: { outgoing: true, peer_user_id: PEER, state: 'active', exchange_id: CID },
    });
    let markActiveReady!: () => void;
    const activeReady = new Promise<void>((resolve) => { markActiveReady = resolve; });
    let releaseActive!: () => void;
    const activeRelease = new Promise<void>((resolve) => { releaseActive = resolve; });
    let markEndedWritten!: () => void;
    const endedWritten = new Promise<void>((resolve) => { markEndedWritten = resolve; });

    vi.doMock('../../../../src/main/features/chats', () => ({
      ...chats,
      admitOutboundA2AConversationAtomic: async (
        userId: string,
        input: Parameters<typeof chats.admitOutboundA2AConversationAtomic>[1],
      ) => chats.admitOutboundA2AConversationAtomic(userId, {
        ...input,
        decide: async (marker) => {
          const next = await input.decide(marker);
          if (next?.outgoing && next.state === 'active') {
            markActiveReady();
            await activeRelease;
          }
          if (next?.state === 'ended') markEndedWritten();
          return next;
        },
      }),
      updateConversation: async (...args: Parameters<typeof chats.updateConversation>) => {
        const updates = args[2];
        if (updates.a2a?.outgoing && updates.a2a.state === 'active') {
          markActiveReady();
          await activeRelease;
        }
        const result = await chats.updateConversation(...args);
        if (updates.a2a?.state === 'ended') markEndedWritten();
        return result;
      },
      updateConversationAtomic: async (...args: any[]) => {
        const actual = (chats as any).updateConversationAtomic;
        const mutate = args[2];
        return actual(args[0], args[1], async (current: any) => {
          const updates = await mutate(current);
          if (updates?.a2a?.outgoing && updates.a2a.state === 'active') {
            markActiveReady();
            await activeRelease;
          }
          if (updates?.a2a?.state === 'ended') markEndedWritten();
          return updates;
        }, args[3]);
      },
      updateA2AMarkersIncludingDeletedAtomic: async (...args: any[]) => (
        chats.updateA2AMarkersIncludingDeletedAtomic(args[0], async (marker: any) => {
          const next = await args[1](marker);
          if (next?.state === 'ended') markEndedWritten();
          return next;
        })
      ),
    }));
    vi.resetModules();

    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const { endExchangesWithPeer } = await import('../../../../src/main/features/a2a/end-exchange');
    const outbound = sendA2AQuestion(USER, {
      contactUserId: PEER,
      text: 'in flight',
      mode: 'continue',
      conversationId: CID,
    }, {
      selfAccountId: async () => 'cs_self',
      send: async () => ({ messageId: 'delivered' }),
      record: async () => {},
    });
    await activeReady;
    const end = endExchangesWithPeer(USER, PEER);
    const deleteReachedWrite = await Promise.race([
      endedWritten.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseActive();
    const [result] = await Promise.all([outbound, end]);

    expect(deleteReachedWrite).toBe(false);
    expect(result).toMatchObject({ sent: false, conversationId: CID, error: 'not_contact' });
    expect((await chats.getConversation(USER, CID))?.a2a).toMatchObject({ state: 'ended' });
  });

  it('serializes a delayed answer behind exchange termination', async () => {
    await seedContact();
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(USER, { conversationId: CID, title: 'outgoing' });
    await chats.updateConversation(USER, CID, {
      a2a: { outgoing: true, peer_user_id: PEER, state: 'active', exchange_id: CID },
    });
    let markEnding!: () => void;
    const ending = new Promise<void>((resolve) => { markEnding = resolve; });
    let releaseEnding!: () => void;
    const endingRelease = new Promise<void>((resolve) => { releaseEnding = resolve; });

    vi.doMock('../../../../src/main/features/chats', () => ({
      ...chats,
      updateConversationAtomic: async (...args: any[]) => chats.updateConversationAtomic(
        args[0],
        args[1],
        async (current: any) => {
          const updates = await args[2](current);
          if (updates?.a2a?.state === 'ended') {
            markEnding();
            await endingRelease;
          }
          return updates;
        },
        args[3],
      ),
      updateA2AMarkersIncludingDeletedAtomic: async (...args: any[]) => (
        chats.updateA2AMarkersIncludingDeletedAtomic(args[0], async (marker: any) => {
          const next = await args[1](marker);
          if (next?.state === 'ended') {
            markEnding();
            await endingRelease;
          }
          return next;
        })
      ),
    }));
    vi.resetModules();

    const { endExchangesWithPeer } = await import('../../../../src/main/features/a2a/end-exchange');
    const { appendIncomingAnswer } = await import('../../../../src/main/features/a2a/outbound');
    const contacts = await import('../../../../src/main/features/contacts/store');
    const record = vi.fn(async () => {});
    const end = endExchangesWithPeer(USER, PEER);
    await ending;
    const answer = appendIncomingAnswer(USER, {
      messageId: 'amsg-delayed-answer',
      fromAccount: PEER,
      toAccount: 'cs_self',
      conversationId: CID,
      kind: 'answer',
      text: 'too late',
    }, { record });
    await Promise.resolve();
    expect(record).not.toHaveBeenCalled();
    releaseEnding();

    await expect(end).resolves.toBe(1);
    await expect(answer).resolves.toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(await contacts.listHistory(USER, PEER)).toEqual([]);
    expect((await chats.getConversation(USER, CID))?.a2a).toMatchObject({ state: 'ended' });
  });
});
