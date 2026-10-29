import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 入站暂存（T3.3）：relay 投递即删除，所以拉到的正文必须先落盘再校验关系。
 *
 * 这里钉住四件事：重复投递幂等、同 id 异载荷隔离（不动原消息）、有效期自
 * **原消息时间**起算且重启不续期、容量与过期都必须留下不带正文的终止原因。
 */
const USER = 'u1';
let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-relay-inbox-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function message(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'amsg-1',
    conversationId: 'a2a-0123456789abcdef0d01',
    fromAccount: 'cs_alice',
    toAccount: 'cs_bob',
    receivedAt: new Date().toISOString(),
    fromName: 'Alice',
    text: '你们的标准折扣是多少？',
    ...overrides,
  };
}

async function store() {
  return import('../../../../src/main/features/a2a/relay-inbox-store');
}

describe('a2a relay inbox › staging', () => {
  it.each(['stage', 'list', 'settle'])('inbox commit ceiling preserves the file after logout during actual tmp write: %s', async (operation) => {
    let enabled = false;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
        await actual.writeFile(...args);
        if (enabled && String(args[0]).includes('a2a-relay-inbox.json.') && String(args[0]).endsWith('.tmp')) {
          enabled = false; entered(); await gate;
        }
      } };
    });
    const { saveHubSession, clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
    saveHubSession(USER, { session_id: 'normal-session', access_token: 'fixture', refresh_token: 'refresh',
      access_expires_at: new Date(Date.now() + 3600_000).toISOString(), refresh_expires_at: new Date(Date.now() + 7200_000).toISOString() });
    writeHubAccountState(USER, { account_id: 'cs_bob' });
    const { currentHubIdentity, isHubIdentityCurrent } = await import('../../../../src/main/features/hub_account/transport');
    const scope = currentHubIdentity(USER)!;
    const isCurrent = () => isHubIdentityCurrent(USER, scope);
    const { stageInboundMessages, listWaitingInbox, settleInboxEntry } = await store();
    const input = message();
    await stageInboundMessages(USER, [input]);
    const { userA2ARelayInboxFile } = await import('../../../../src/main/paths');
    const file = userA2ARelayInboxFile(USER);
    const before = fs.readFileSync(file, 'utf8');
    enabled = true;
    const pending = (operation === 'stage'
      ? stageInboundMessages(USER, [message({ messageId: 'new' })], { isCurrent })
      : operation === 'list' ? listWaitingInbox(USER, { isCurrent, now: Date.parse(input.receivedAt) + 600_000 })
        : settleInboxEntry(USER, input.messageId, 'admitted', { isCurrent }))
      .then(() => 'committed', () => 'discarded');
    await started;
    clearHubSession(USER);
    release();
    expect(await pending).toBe('discarded');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith('a2a-relay-inbox.json.') && name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps a missing-recipient tombstone readable without poisoning later valid arrivals', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    expect(await stageInboundMessages(USER, [message({ toAccount: undefined })]))
      .toMatchObject({ waiting: 0, terminated: 1 });
    expect(await listWaitingInbox(USER)).toEqual([]);
    expect(await stageInboundMessages(USER, [message({ messageId: 'valid' })]))
      .toMatchObject({ waiting: 1 });
    expect(await listWaitingInbox(USER)).toHaveLength(1);
  });
  it('preserves corrupt or structurally invalid files and refuses to stage', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    const file = path.join(tmp, USER, 'local', 'a2a-relay-inbox.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const raw of ['{broken', '{}', '{"version":1,"entries":[{}]}']) {
      fs.writeFileSync(file, raw);
      await expect(stageInboundMessages(USER, [message()])).rejects.toThrow();
      await expect(listWaitingInbox(USER)).rejects.toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    }
  });

  it('serializes concurrent stages without losing valid messages', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      stageInboundMessages(USER, [message({ messageId: `parallel-${index}` })])));
    expect(await listWaitingInbox(USER)).toHaveLength(20);
  });

  it('does not lose new arrivals when settlement and expiry maintenance interleave', async () => {
    const { stageInboundMessages, listWaitingInbox, settleInboxEntry } = await store();
    await stageInboundMessages(USER, [message({ messageId: 'settle-me' })]);
    await Promise.all([
      settleInboxEntry(USER, 'settle-me', 'admitted', { toAccount: 'cs_bob' }),
      listWaitingInbox(USER),
      ...Array.from({ length: 20 }, (_, index) => stageInboundMessages(USER, [message({ messageId: `new-${index}` })])),
    ]);
    const waiting = await listWaitingInbox(USER);
    expect(waiting).toHaveLength(20);
    expect(waiting.some((entry) => entry.messageId === 'settle-me')).toBe(false);
  });

  it('expires waiting entries before counting capacity', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    const base = Date.now();
    await stageInboundMessages(USER, Array.from({ length: 50 }, (_, index) => message({
      messageId: `old-${index}`, receivedAt: new Date(base).toISOString(),
    })), { now: base });
    const now = base + 600_000;
    expect(await stageInboundMessages(USER, [message({ receivedAt: new Date(now).toISOString() })], { now }))
      .toMatchObject({ waiting: 1, terminated: 0 });
    expect(await listWaitingInbox(USER, { now })).toHaveLength(1);
  });

  it('keeps epoch zero as the original timestamp', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    await stageInboundMessages(USER, [message({ receivedAt: new Date(0).toISOString() })], { now: 1000 });
    expect((await listWaitingInbox(USER, { now: 1000 }))[0].expiresAt).toBe(new Date(600_000).toISOString());
  });

  it.each([undefined, 'invalid'])('rejects invalid original time %s without renewing it', async (receivedAt) => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    expect(await stageInboundMessages(USER, [message({ receivedAt })])).toMatchObject({ waiting: 0, terminated: 1 });
    expect(await listWaitingInbox(USER)).toEqual([]);
    const file = JSON.parse(fs.readFileSync(path.join(tmp, USER, 'local', 'a2a-relay-inbox.json'), 'utf8'));
    expect(file.entries[0]).toMatchObject({ state: 'terminated', reason: 'invalid_timestamp', text: '' });
    expect(file.entries[0].receivedAt).toBeUndefined();
    expect(file.entries[0].expiresAt).toBeUndefined();
  });

  it('rejects oversized UTF16 payloads without truncating them into canonical duplicates', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    const prefix = 'a'.repeat(4000);
    expect(await stageInboundMessages(USER, [message({ text: prefix + 'x' })])).toMatchObject({ terminated: 1 });
    expect(await stageInboundMessages(USER, [message({ text: prefix + 'y' })])).toMatchObject({ conflict: 1, duplicate: 0 });
    expect(await listWaitingInbox(USER)).toEqual([]);
    const file = fs.readFileSync(path.join(tmp, USER, 'local', 'a2a-relay-inbox.json'), 'utf8');
    expect(file).not.toContain(prefix);
  });

  it('does not renew a duplicate deadline and bounds terminal metadata without evicting waiting entries', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    const now = Date.now();
    const original = message({ receivedAt: new Date(now).toISOString() });
    await stageInboundMessages(USER, [original], { now });
    await stageInboundMessages(USER, [original], { now: now + 1000 });
    const overflow = Array.from({ length: 600 }, (_, index) => message({
      messageId: `expired-${index}`, receivedAt: new Date(now - 600_000).toISOString(),
    }));
    await stageInboundMessages(USER, overflow, { now: now + 1000 });
    expect((await listWaitingInbox(USER, { now: now + 1000 }))[0].expiresAt).toBe(new Date(now + 600_000).toISOString());
    const file = JSON.parse(fs.readFileSync(path.join(tmp, USER, 'local', 'a2a-relay-inbox.json'), 'utf8'));
    expect(file.entries.length).toBeLessThanOrEqual(501);
  });
  it('stages a message with a ten-minute deadline from the original message time', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    const receivedAt = '2026-10-26T12:00:00.000Z';

    const result = await stageInboundMessages(USER, [message({ receivedAt })], {
      now: Date.parse(receivedAt) + 1000,
    });

    expect(result).toMatchObject({ waiting: 1, duplicate: 0, conflict: 0, terminated: 0 });
    const waiting = await listWaitingInbox(USER, { now: Date.parse(receivedAt) + 2000 });
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      messageId: 'amsg-1',
      fromAccount: 'cs_alice',
      text: '你们的标准折扣是多少？',
    });
    // 截止时间由原消息时间决定，不是落盘时间。
    expect(waiting[0].expiresAt).toBe('2026-10-26T12:10:00.000Z');
  });

  it('is idempotent for a repeated delivery of the same payload', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    const original = message();
    await stageInboundMessages(USER, [original]);
    const again = await stageInboundMessages(USER, [original]);

    expect(again).toMatchObject({ waiting: 0, duplicate: 1, conflict: 0 });
    expect(await listWaitingInbox(USER)).toHaveLength(1);
  });

  it('isolates the same id with a different payload and keeps the original intact', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    await stageInboundMessages(USER, [message()]);
    const conflict = await stageInboundMessages(USER, [message({ text: '换个说法' })]);

    expect(conflict).toMatchObject({ conflict: 1, duplicate: 0 });
    const waiting = await listWaitingInbox(USER);
    // 原消息仍在等待，仍是原来的正文；第二份没有覆盖它，也没有排队。
    expect(waiting).toHaveLength(1);
    expect(waiting[0].text).toBe('你们的标准折扣是多少？');
  });

  it('terminates an arrival that is already past the deadline, keeping a reason and no body', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    const receivedAt = '2026-10-26T12:00:00.000Z';

    const result = await stageInboundMessages(USER, [message({ receivedAt })], {
      now: Date.parse(receivedAt) + 10 * 60 * 1000,
    });

    expect(result).toMatchObject({ waiting: 0, terminated: 1 });
    expect(await listWaitingInbox(USER)).toHaveLength(0);
  });

  it('expires a waiting entry on read without extending its deadline', async () => {
    const { stageInboundMessages, listWaitingInbox } = await store();
    const receivedAt = '2026-10-26T12:00:00.000Z';
    await stageInboundMessages(USER, [message({ receivedAt })], { now: Date.parse(receivedAt) });

    const later = await listWaitingInbox(USER, { now: Date.parse(receivedAt) + 11 * 60 * 1000 });
    expect(later).toHaveLength(0);
    // 重新读一次也不会复活（终止是持久状态）。
    expect(await listWaitingInbox(USER, { now: Date.parse(receivedAt) + 12 * 60 * 1000 })).toHaveLength(0);
  });

  it('refuses new arrivals beyond the per-receiver capacity with a reason', async () => {
    const { stageInboundMessages, listWaitingInbox, RELAY_INBOX_CAPACITY } = await store();
    const base = Date.now();
    const batch = Array.from({ length: RELAY_INBOX_CAPACITY }, (_, index) => message({
      messageId: `amsg-${index}`,
      conversationId: `a2a-0123456789abcdef${String(index).padStart(4, '0')}`,
      receivedAt: new Date(base).toISOString(),
    }));

    const first = await stageInboundMessages(USER, batch, { now: base });
    expect(first.waiting).toBe(RELAY_INBOX_CAPACITY);

    const overflow = await stageInboundMessages(USER, [message({
      messageId: 'amsg-overflow',
      receivedAt: new Date(base).toISOString(),
    })], { now: base });

    expect(overflow).toMatchObject({ waiting: 0, terminated: 1 });
    expect(await listWaitingInbox(USER, { now: base })).toHaveLength(RELAY_INBOX_CAPACITY);
  });

  it('clears the body when an entry is settled', async () => {
    const { stageInboundMessages, listWaitingInbox, settleInboxEntry } = await store();
    await stageInboundMessages(USER, [message()]);
    expect(await settleInboxEntry(USER, 'amsg-1', 'admitted')).toBe(true);

    expect(await listWaitingInbox(USER)).toHaveLength(0);
    const file = JSON.parse(fs.readFileSync(
      path.join(tmp, USER, 'local', 'a2a-relay-inbox.json'), 'utf8',
    ));
    expect(file.entries[0]).toMatchObject({ messageId: 'amsg-1', state: 'terminated', reason: 'admitted', text: '' });
  });
});
