import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 首问竞态（T3 / C01）：好友刚被接受，接收端的联系人缓存仍是空的，对方的
 * 第一条问题就到了。缓存未命中必须先去查一次权威关系，再把消息判成「不是
 * 联系人」——否则这条问题会被静默丢掉，用户只能重发，也就是现场看到的
 * 「首问要发两次」。
 *
 * 这里用可控的 Hub 替身固定三种时序：缓存先更新、首问先到、刷新与首问交错。
 * 不用 sleep，也不依赖真实网络。
 */
const ME = 'cs_self';
const PEER = 'cs_alice';
const USER = 'u1';
const CID = 'a2a-0123456789abcdef0c01';

let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-first-question-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
  const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
  saveHubSession(USER, { session_id: 'first-question-fixture', access_token: 'fixture', refresh_token: 'fixture',
    access_expires_at: new Date(Date.now() + 3600_000).toISOString(), refresh_expires_at: new Date(Date.now() + 7200_000).toISOString() });
  writeHubAccountState(USER, { account_id: ME });
});

afterEach(() => {
  vi.doUnmock('../../../../src/main/features/contacts/hub-client');
  vi.doUnmock('../../../../src/main/features/hub_account/auth-flow');
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Local roster cache as it is right after the friend request was accepted. */
async function seedEmptyRoster() {
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(USER), { version: 1, contacts: [] });
}

async function mockHubRoster(remote: Array<{ accountId: string; name: string }>, options: {
  delay?: Promise<void>;
} = {}) {
  vi.doMock('../../../../src/main/features/contacts/hub-client', async () => {
    const actual = await vi.importActual<any>('../../../../src/main/features/contacts/hub-client');
    let calls = 0;
    return {
      ...actual,
      hubConfigured: () => true,
      hubListContacts: async () => {
        calls += 1;
        if (options.delay) await options.delay;
        return remote;
      },
      _hubCalls: () => calls,
    };
  });
}

function inbound(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: CID,
    messageId: 'amsg-first-question',
    fromAccount: PEER,
    fromName: 'Alice',
    text: '你们的标准折扣是多少？',
    ...overrides,
  } as any;
}

describe('a2a first question › stale roster cache', () => {
  it('accepts the first question when the authoritative roster already has the friend', async () => {
    await seedEmptyRoster();
    await mockHubRoster([{ accountId: PEER, name: 'Alice' }]);
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');

    const decision = await handleInboundQuestion(USER, inbound());

    expect(decision.accepted).toBe(true);
    if (!decision.accepted) return;
    expect(decision.outcome.awaitingConfirmation).toBe(true);
    expect(decision.outcome.conversationId).toBe(CID);
  });

  it('persists the refreshed roster so the next message is served from cache', async () => {
    await seedEmptyRoster();
    await mockHubRoster([{ accountId: PEER, name: 'Alice' }]);
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const { getCachedContact } = await import('../../../../src/main/features/contacts/store');

    await handleInboundQuestion(USER, inbound());
    await expect(getCachedContact(USER, PEER)).resolves.toMatchObject({ userId: PEER, name: 'Alice' });
  });

  it('still rejects a sender the authoritative roster does not contain', async () => {
    await seedEmptyRoster();
    await mockHubRoster([{ accountId: 'cs_stranger', name: 'Stranger' }]);
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');

    const decision = await handleInboundQuestion(USER, inbound());

    expect(decision).toEqual({ accepted: false, reason: 'not_contact' });
  });

  it('coalesces concurrent first questions from the same new friend into one refresh', async () => {
    await seedEmptyRoster();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await mockHubRoster([{ accountId: PEER, name: 'Alice' }], { delay: gate });
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');

    const first = handleInboundQuestion(USER, inbound({ conversationId: 'a2a-0123456789abcdef0c01' }));
    const second = handleInboundQuestion(USER, inbound({ conversationId: 'a2a-0123456789abcdef0c02' }));
    release();
    const [a, b] = await Promise.all([first, second]);

    const hub = await import('../../../../src/main/features/contacts/hub-client') as any;
    // One authoritative round trip for the burst, not one per message.
    expect(hub._hubCalls()).toBe(1);
    expect(a.accepted || b.accepted).toBe(true);
  });

  it('reports an unreachable Hub as unknown instead of an authoritative rejection', async () => {
    await seedEmptyRoster();
    vi.doMock('../../../../src/main/features/contacts/hub-client', async () => {
      const actual = await vi.importActual<any>('../../../../src/main/features/contacts/hub-client');
      return {
        ...actual,
        hubConfigured: () => true,
        // Hub down: the answer is "unknown", not "not a contact".
        hubListContacts: async () => null,
      };
    });
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');

    const decision = await handleInboundQuestion(USER, inbound());

    // Nothing is fabricated: no conversation, no reception. The reason is
    // "still unknown", which keeps the staged entry waiting for the next poll
    // instead of dropping it as unauthorised.
    expect(decision).toEqual({ accepted: false, reason: 'unknown_relation' });
  });
});
