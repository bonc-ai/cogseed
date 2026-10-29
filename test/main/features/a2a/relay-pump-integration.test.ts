import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'u1';
const ACCOUNT = 'cs_bob';
const PEER = 'cs_alice';
const CID = 'a2a-0123456789abcdef0123';
let tmp: string;
let previous: string | undefined;

function message(overrides = {}) {
  return { messageId: 'm1', conversationId: CID, fromAccount: PEER, toAccount: ACCOUNT,
    text: 'original question', kind: 'question' as const, createdAt: new Date().toISOString(), ...overrides };
}

async function signIn(account = ACCOUNT) {
  const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
  saveHubSession(USER, { session_id: `session-${account}`, access_token: 'normal-session-fixture', refresh_token: 'refresh',
    access_expires_at: new Date(Date.now() + 3600_000).toISOString(), refresh_expires_at: new Date(Date.now() + 7200_000).toISOString() });
  writeHubAccountState(USER, { account_id: account });
}

async function setup() {
  const pump = await import('../../../../src/main/features/a2a/relay-pump');
  const inbox = await import('../../../../src/main/features/a2a/relay-inbox-store');
  const service = await import('../../../../src/main/features/a2a/reception-service');
  const events: any[] = [];
  const poll = vi.fn(async (_since?: string) => [] as ReturnType<typeof message>[]);
  const deps = { activeUserId: () => USER, poll, onEvent: (event: any) => events.push(event) };
  const stage = (input = message()) => inbox.stageInboundMessages(USER, [{ ...input, receivedAt: input.createdAt }]);
  return { ...pump, ...inbox, stage, service, events, poll, deps };
}

beforeEach(async () => {
  // 授权校验要求持久化根是 canonical 路径；macOS 的 tmpdir 是 /var → /private/var，
  // 夹具必须先 realpath，否则合法 grant 会被当成不可用（环境问题，不是产品断言）。
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pump-integration-')));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
  vi.doMock('../../../../src/main/features/a2a/reception-service', async () => {
    const actual = await vi.importActual<any>('../../../../src/main/features/a2a/reception-service');
    return {
      ...actual,
      handleInboundQuestion: vi.fn(actual.handleInboundQuestion),
      expireStaleReceptions: vi.fn(actual.expireStaleReceptions),
    };
  });
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(USER), { version: 1, contacts: [{ userId: PEER, name: 'Alice', addedAt: new Date().toISOString() }] });
  await signIn();
});

afterEach(async () => {
  const { resetReceptionNudges } = await import('../../../../src/main/features/a2a/reception-nudge');
  resetReceptionNudges();
  vi.doUnmock('../../../../src/main/features/a2a/reception-service');
  vi.doUnmock('node:fs/promises');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('relay persisted inbound recovery', () => {
  it.each(['inbox', 'ledger'])('quality corrupt reader privacy preserves %s without leaking parser payload', async (kind) => {
    const logger = await import('../../../../src/main/logger');
    const createLogger = logger.createLogger;
    const warnings: unknown[][] = [];
    vi.spyOn(logger, 'createLogger').mockImplementation((scope) => {
      const actual = createLogger(scope);
      return { ...actual, warn: (message, ...args) => { warnings.push([scope, message, ...args]); actual.warn(message, ...args); } };
    });
    const h = await setup();
    const input = message();
    await h.stage(input);
    const paths = await import('../../../../src/main/paths');
    const file = kind === 'inbox' ? paths.userA2ARelayInboxFile(USER) : paths.userA2AReceptionLedgerFile(USER);
    const marker = 'PRIVATE';
    const malformed = `{"${marker}":!}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, malformed);
    const read = kind === 'inbox'
      ? () => h.listWaitingInbox(USER, { toAccount: ACCOUNT })
      : () => import('../../../../src/main/features/a2a/reception-ledger').then((ledger) => ledger.readReceptionLedger(USER));
    let failure: unknown;
    try { await read(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(marker);
    if (kind === 'inbox') await h.pumpOnce(h.deps);
    await h.receiveRelayMessage(USER, input, h.deps);
    expect(warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(warnings)).not.toContain(marker);
    expect(h.poll).not.toHaveBeenCalled();
    expect(h.events).toEqual(kind === 'inbox' ? [] : [expect.objectContaining({ type: 'ignored', reason: 'decision_failed' })]);
    expect(JSON.stringify(h.events)).not.toContain(marker);
    expect(await (await import('../../../../src/main/features/chats')).getConversation(USER, CID)).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(malformed);
    if (kind === 'inbox') expect(h.service.handleInboundQuestion).not.toHaveBeenCalled();
  });

  it.each(['text', 'fromAccount', 'toAccount', 'conversationId', 'receivedAt', 'payloadDigest', 'canonical'])('quality inbox digest recovery rejects syntactically valid tamper: %s', async (field) => {
    const h = await setup();
    await h.stage();
    const { userA2ARelayInboxFile } = await import('../../../../src/main/paths');
    const file = userA2ARelayInboxFile(USER);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (field !== 'canonical') {
      const row = data.entries[0];
      if (field === 'receivedAt') {
        row.receivedAt = new Date(Date.parse(row.receivedAt) + 1).toISOString();
        row.expiresAt = new Date(Date.parse(row.receivedAt) + 600_000).toISOString();
      } else row[field] = field === 'conversationId' ? 'a2a-0123456789abcdef0999' : field === 'text' ? 'changed plaintext' : 'cs_changed';
      fs.writeFileSync(file, JSON.stringify(data));
    }
    const before = fs.readFileSync(file, 'utf8');
    await h.pumpOnce(h.deps);
    if (field === 'canonical') {
      expect(h.service.handleInboundQuestion).toHaveBeenCalledTimes(1);
      expect(h.events.filter((event) => event.type === 'question')).toHaveLength(1);
    } else {
      expect(h.service.handleInboundQuestion).not.toHaveBeenCalled();
      expect(h.poll).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    }
  });

  it.each(['network', 'tmp_commit', 'session_refresh'])('quality inbound refresh ceiling prevents effects after active uid changes during %s', async (boundary) => {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    if (boundary === 'tmp_commit') {
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs/promises')>();
        let paused = false;
        return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
          await actual.writeFile(...args);
          if (!paused && String(args[0]).includes('contacts.json.') && String(args[0]).endsWith('.tmp')) {
            paused = true; entered(); await gate;
          }
        } };
      });
      vi.resetModules();
    }
    const h = await setup();
    const { userContactsFile, userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');
    fs.writeFileSync(userContactsFile(USER), JSON.stringify({ version: 1, contacts: [] }));
    const before = fs.readFileSync(userContactsFile(USER), 'utf8');
    const chats = await import('../../../../src/main/features/chats');
    const otherCid = 'a2a-0123456789abcdef0888';
    await chats.createConversation(USER, { conversationId: otherCid, title: 'existing orphan exchange' });
    await chats.updateConversation(USER, otherCid, { a2a: { inbound: true, peer_user_id: 'cs_orphan', state: 'active', exchange_id: otherCid } });
    const conversation = await chats.getConversation(USER, otherCid);
    let active = USER; h.deps.activeUserId = () => active;
    const get = vi.fn(async () => {
      if (boundary === 'network') { entered(); await gate; }
      return { ok: true, json: async () => ({ ok: true, data: { contacts: [{ accountId: PEER, name: 'Alice', online: true }] } }) };
    });
    vi.stubGlobal('fetch', get);
    const tokens = await import('../../../../src/main/features/hub_account/tokens');
    if (boundary === 'session_refresh') {
      tokens.saveHubSession(USER, { ...tokens.loadHubSession(USER)!, access_expires_at: new Date(Date.now() - 1000).toISOString() });
      const { setSharedHubClient } = await import('../../../../src/main/features/hub_account/client');
      setSharedHubClient({ refresh: async () => {
        entered(); await gate;
        return { access_token: 'rotated', refresh_token: 'rotated-refresh',
          access_expires_at: new Date(Date.now() + 3600_000).toISOString(), refresh_expires_at: new Date(Date.now() + 7200_000).toISOString() };
      } } as any);
    }
    const pending = h.receiveRelayMessage(USER, message(), h.deps);
    await started;
    active = 'u2';
    expect(tokens.loadHubSession(USER)).not.toBeNull();
    release(); await pending;
    expect(fs.readFileSync(userContactsFile(USER), 'utf8')).toBe(before);
    expect(await chats.getConversation(USER, otherCid)).toEqual(conversation);
    expect(await chats.getConversation(USER, CID)).toBeNull();
    expect(fs.existsSync(userA2AReceptionLedgerFile(USER))).toBe(false);
    expect(h.events).toEqual([]);
    if (boundary === 'session_refresh') expect(get).not.toHaveBeenCalled();
  });

  it('quality inbound refresh coalescing does not reuse a stale account lifecycle task', async () => {
    const h = await setup();
    const { userContactsFile } = await import('../../../../src/main/paths');
    fs.writeFileSync(userContactsFile(USER), JSON.stringify({ version: 1, contacts: [] }));
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const get = vi.fn(async () => {
      if (++calls === 1) { entered(); await gate; }
      return { ok: true, json: async () => ({ ok: true, data: { contacts: [{ accountId: PEER, name: 'current peer', online: true }] } }) };
    });
    vi.stubGlobal('fetch', get);
    const { currentHubIdentity, isHubIdentityCurrent } = await import('../../../../src/main/features/hub_account/transport');
    const old = currentHubIdentity(USER)!;
    const pending = h.service.handleInboundQuestion(USER, message(), { isCurrent: () => isHubIdentityCurrent(USER, old) });
    await started;
    (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    await signIn('cs_new');
    const current = currentHubIdentity(USER)!;
    const next = h.service.handleInboundQuestion(USER, message({ messageId: 'new-lifecycle', toAccount: 'cs_new' }), { isCurrent: () => isHubIdentityCurrent(USER, current) });
    try { await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2)); }
    finally { release(); await Promise.all([pending, next]); }
    expect((await pending).accepted).toBe(false);
    expect((await next).accepted).toBe(true);
  });

  it.each(['switched', 'unchanged'])('real relay poll refresh ceiling keeps messages unconsumed when active uid is %s', async (mode) => {
    const h = await setup();
    const { poll: _fixturePoll, ...deps } = h.deps;
    let active = USER;
    deps.activeUserId = () => active;
    const seed = message({ messageId: 'cursor-seed', kind: 'answer', createdAt: new Date(Date.now() - 1000).toISOString() });
    const queued = [message({ messageId: 'after-refresh' })];
    let getCount = 0;
    const get = vi.fn(async (_url: string) => {
      const messages = ++getCount === 1 ? [seed] : queued.splice(0);
      return { ok: true, json: async () => ({ ok: true, data: { messages } }) };
    });
    vi.stubGlobal('fetch', get);
    await h.pumpOnce(deps);
    expect(get).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([]);
    const { loadHubSession, saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    saveHubSession(USER, { ...loadHubSession(USER)!, access_expires_at: new Date(Date.now() - 1000).toISOString() });
    const { setSharedHubClient } = await import('../../../../src/main/features/hub_account/client');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const refresh = vi.fn(async () => {
      entered(); await gate;
      return { access_token: 'rotated', refresh_token: 'rotated-refresh',
        access_expires_at: new Date(Date.now() + 3600_000).toISOString(), refresh_expires_at: new Date(Date.now() + 7200_000).toISOString() };
    });
    setSharedHubClient({ refresh } as any);
    const pending = h.pumpOnce(deps);
    await started;
    if (mode === 'switched') active = 'u2';
    release();
    expect(await pending).toBe(mode === 'switched' ? 0 : 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    if (mode === 'switched') {
      expect(get).toHaveBeenCalledTimes(1);
      expect(queued).toHaveLength(1);
      expect(h.events).toEqual([]);
      active = USER;
      await h.pumpOnce(deps);
    }
    expect(get).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain(`?since=${encodeURIComponent(seed.createdAt)}`);
    expect(queued).toEqual([]);
    expect(h.events.filter((event) => event.type === 'question')).toHaveLength(1);
    setSharedHubClient(null);
  });

  it.each(['logout', 'active_user', 'ttl'])('fences a prepared ledger write after real lock waiting: %s', async (change) => {
    const h = await setup();
    const { fileEditLock } = await import('../../../../src/main/util/locks');
    const { userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');
    const lock = fileEditLock(userA2AReceptionLedgerFile(USER));
    const release = await lock.acquire();
    const acquire = vi.spyOn(lock, 'runExclusive');
    let active = USER;
    h.deps.activeUserId = () => active;
    const input = message();
    const pending = h.receiveRelayMessage(USER, input, h.deps);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
    if (change === 'logout') (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    if (change === 'active_user') active = 'u2';
    if (change === 'ttl') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(input.createdAt) + 600_000);
    release();
    await pending;
    expect(fs.existsSync(userA2AReceptionLedgerFile(USER))).toBe(false);
    expect(h.events).toEqual([]);
  });

  it.each(['logout', 'ttl'])('fences the committed ledger write after real lock waiting: %s', async (change) => {
    const h = await setup();
    const { fileEditLock } = await import('../../../../src/main/util/locks');
    const { userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');
    const ledgerFile = userA2AReceptionLedgerFile(USER);
    const lock = fileEditLock(ledgerFile);
    const actual = vi.mocked(h.service.handleInboundQuestion).getMockImplementation()!;
    let release!: () => void;
    let acquire: any;
    vi.mocked(h.service.handleInboundQuestion).mockImplementationOnce((uid, q, deps) => actual(uid, q, {
      ...deps, afterStage: async () => { release = await lock.acquire(); acquire = vi.spyOn(lock, 'runExclusive'); },
    }));
    const input = message();
    const pending = h.receiveRelayMessage(USER, input, h.deps);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
    const before = fs.readFileSync(ledgerFile, 'utf8');
    if (change === 'logout') (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    else vi.spyOn(Date, 'now').mockReturnValue(Date.parse(input.createdAt) + 600_000);
    release();
    await pending;
    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(before);
    expect(h.events).toEqual([]);
  });

  it.each(['account_mismatch', 'unscoped', 'expired'])('startup cannot promote a prepared %s receipt', async (kind) => {
    const h = await setup();
    const { journalReception } = await import('../../../../src/main/features/a2a/reception-ledger');
    const { recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
    const { userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');
    await journalReception(USER, { messageId: 'prepared', conversationId: CID, peerUserId: PEER, text: 'prepared question',
      generation: 'generation-1', ...(kind === 'unscoped' ? {} : { toAccount: kind === 'account_mismatch' ? 'cs_other' : ACCOUNT,
        createdAt: new Date(Date.now() - (kind === 'expired' ? 600_000 : 0)).toISOString() }) } as any);
    const before = fs.readFileSync(userA2AReceptionLedgerFile(USER), 'utf8');
    const run = vi.fn();
    expect(await recoverClaimedReceptions(USER, { run, activeUserId: () => USER })).toEqual({ scheduled: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(fs.readFileSync(userA2AReceptionLedgerFile(USER), 'utf8')).toBe(before);
    expect(await (await import('../../../../src/main/features/chats')).getConversation(USER, CID)).toBeNull();
  });

  it.each(['logout', 'account_change', 'active_user'])('fences incoming answer behind the real conversation queue: %s', async (change) => {
    const h = await setup();
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(USER, { conversationId: CID, title: 'outgoing' });
    await chats.updateConversation(USER, CID, { a2a: { role: 'initiator', peer_user_id: PEER, state: 'active', exchange_id: CID } });
    const before = await chats.getConversation(USER, CID);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = chats.updateConversationAtomic(USER, CID, async () => { entered(); await gate; return null; });
    await started;
    const queued = vi.spyOn(chats, 'updateConversationAtomic');
    let active = USER; h.deps.activeUserId = () => active;
    const pending = h.receiveRelayMessage(USER, message({ kind: 'answer' }), h.deps);
    await vi.waitFor(() => expect(queued).toHaveBeenCalled());
    if (change === 'active_user') active = 'u2';
    else (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    if (change === 'account_change') await signIn('cs_other');
    release(); await blocker; await pending;
    expect(await chats.getConversation(USER, CID)).toEqual(before);
    const { listHistory } = await import('../../../../src/main/features/contacts/store');
    expect(await listHistory(USER, PEER)).toEqual([]);
    expect(await chats.getMessages(USER, CID)).toEqual([]);
    const { readMembers } = await import('../../../../src/main/features/group_chat/state');
    expect((await readMembers(USER, CID)).actors).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('fences incoming answer waiting on the actual message line lock', async () => {
    const h = await setup();
    await import('../../../../src/main/features/group_chat/bus');
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(USER, { conversationId: CID, title: 'outgoing' });
    await chats.updateConversation(USER, CID, { a2a: { outgoing: true, peer_user_id: PEER, state: 'active', exchange_id: CID } });
    const { conversationLayout } = await import('../../../../src/main/util/project-layout');
    const storage = await import('../../../../src/main/storage');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = storage.withJsonlLineLock(conversationLayout(USER, CID).messageFile, async () => { entered(); await gate; });
    await started;
    const append = vi.spyOn(storage, 'appendJsonlByIdIdempotent');
    const pending = h.receiveRelayMessage(USER, message({ kind: 'answer' }), h.deps);
    await vi.waitFor(() => expect(append).toHaveBeenCalled());
    (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    release(); await blocker; await pending;
    expect(await chats.getMessages(USER, CID)).toEqual([]);
    const { listHistory } = await import('../../../../src/main/features/contacts/store');
    expect(await listHistory(USER, PEER)).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it.each(['logout', 'account_change', 'active_user'])('fences a run waiting on the real run lock: %s', async (change) => {
    const h = await setup();
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(USER, { conversationId: CID, title: 'active reception' });
    await chats.updateConversation(USER, CID, { a2a: { role: 'receiver', peer_user_id: PEER, state: 'active', exchange_id: CID, workspace: tmp } });
    const running = await import('../../../../src/main/features/a2a/reception-run');
    const { fileEditLock } = await import('../../../../src/main/util/locks');
    const { userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');
    const lock = fileEditLock(`${userA2AReceptionLedgerFile(USER)}:${CID}`);
    const release = await lock.acquire();
    const acquire = vi.spyOn(lock, 'runExclusive');
    const enqueue = vi.fn(async () => undefined);
    const actual = running.runReception;
    let completed!: Promise<any>;
    vi.spyOn(running, 'runReception').mockImplementation((uid, q, deps) => {
      completed = actual(uid, q, { ...deps, enqueue, addMember: async () => true, subscribe: async () => () => {}, timeoutMs: 1 });
      return completed;
    });
    let active = USER; h.deps.activeUserId = () => active;
    await h.receiveRelayMessage(USER, message(), h.deps);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
    const before = fs.readFileSync(userA2AReceptionLedgerFile(USER), 'utf8');
    h.events.length = 0;
    if (change === 'active_user') active = 'u2';
    else (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    if (change === 'account_change') await signIn('cs_other');
    release(); await completed;
    expect(enqueue).not.toHaveBeenCalled();
    expect(fs.readFileSync(userA2AReceptionLedgerFile(USER), 'utf8')).toBe(before);
    expect(h.events).toEqual([]);
  });

  it('rechecks the normal session after a pre-enqueue wait without writing another receipt', async () => {
    const h = await setup();
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(USER, { conversationId: CID, title: 'active reception' });
    await chats.updateConversation(USER, CID, { a2a: { inbound: true, peer_user_id: PEER, state: 'active', exchange_id: CID, workspace: tmp } });
    const running = await import('../../../../src/main/features/a2a/reception-run');
    const { userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const enqueue = vi.fn(async () => undefined);
    const actual = running.runReception;
    let completed!: Promise<any>;
    vi.spyOn(running, 'runReception').mockImplementation((uid, q, deps) => {
      completed = actual(uid, q, { ...deps, enqueue, addMember: async () => true, subscribe: async () => () => {},
        afterStage: async (stage) => { if (stage === 'dispatching') { entered(); await gate; } } });
      return completed;
    });
    await h.receiveRelayMessage(USER, message(), h.deps);
    await started;
    const before = fs.readFileSync(userA2AReceptionLedgerFile(USER), 'utf8');
    h.events.length = 0;
    (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    release(); await completed;
    expect(enqueue).not.toHaveBeenCalled();
    expect(fs.readFileSync(userA2AReceptionLedgerFile(USER), 'utf8')).toBe(before);
    expect(h.events).toEqual([]);
  });

  it('does not apply waiting TTL again to a committed reception during startup', async () => {
    const h = await setup();
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(USER, { conversationId: CID, title: 'admitted reception' });
    await chats.updateConversation(USER, CID, { a2a: { inbound: true, peer_user_id: PEER, state: 'active', exchange_id: CID, workspace: tmp } });
    const input = message();
    expect(await h.service.handleInboundQuestion(USER, input)).toMatchObject({ accepted: true });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(input.createdAt) + 600_001);
    const { recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
    const run = vi.fn(async () => ({ status: 'answered' as const }));
    expect(await recoverClaimedReceptions(USER, { run, activeUserId: () => USER })).toEqual({ scheduled: 1 });
    expect(run).toHaveBeenCalledWith(USER, expect.objectContaining({ toAccount: ACCOUNT, createdAt: input.createdAt }));
  });
  it.each(['signed_out', 'wrong_recipient', 'inactive_user'])('rejects direct %s delivery before staging', async (reason) => {
    const h = await setup();
    const input = message();
    if (reason === 'signed_out') {
      const { clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
      clearHubSession(USER);
    } else if (reason === 'wrong_recipient') input.toAccount = 'cs_other';
    else h.deps.activeUserId = () => 'u2';
    await h.receiveRelayMessage(USER, input, h.deps);
    expect(h.service.handleInboundQuestion).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(fs.existsSync(path.join(tmp, USER, 'local', 'a2a-relay-inbox.json'))).toBe(false);
  });

  it('keeps the cursor through ordinary refresh and resets it for a new login lifecycle', async () => {
    const h = await setup();
    const original = message();
    h.poll.mockResolvedValueOnce([original]);
    await h.pumpOnce(h.deps);
    const { loadHubSession, saveHubSession, clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    saveHubSession(USER, { ...loadHubSession(USER)!, access_token: 'rotated', refresh_token: 'rotated' });
    await h.pumpOnce(h.deps);
    expect(h.poll).toHaveBeenLastCalledWith(original.createdAt);
    clearHubSession(USER);
    await signIn();
    await h.pumpOnce(h.deps);
    expect(h.poll).toHaveBeenLastCalledWith(undefined);
  });
  it.each(['expired', 'capacity', 'conflict', 'stage_failed', 'oversize', 'invalid_time'])('%s never reaches admission through raw fallback', async (reason) => {
    const h = await setup();
    let input = message();
    if (reason === 'expired') input = message({ createdAt: new Date(Date.now() - 600_000).toISOString() });
    if (reason === 'capacity') {
      for (let index = 0; index < 50; index++) await h.stage(message({ messageId: `full-${index}` }));
    }
    if (reason === 'conflict') {
      await h.stage();
      input = message({ text: 'conflicting question' });
    }
    if (reason === 'stage_failed') fs.writeFileSync(path.join(tmp, USER, 'local', 'a2a-relay-inbox.json'), '{broken');
    if (reason === 'oversize') input = message({ text: 'x'.repeat(4001) });
    if (reason === 'invalid_time') input = message({ createdAt: 'invalid' });
    await h.receiveRelayMessage(USER, input, h.deps);
    expect(h.service.handleInboundQuestion).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    if (reason === 'conflict') {
      await h.pumpOnce(h.deps);
      expect(h.service.handleInboundQuestion).toHaveBeenCalledTimes(1);
      expect(h.service.handleInboundQuestion).toHaveBeenCalledWith(USER,
        expect.objectContaining({ text: 'original question' }), expect.anything());
    }
  });

  it('does not admit when writing the staging file fails', async () => {
    const h = await setup();
    const storage = await import('../../../../src/main/storage');
    const actualWrite = storage.writeJson;
    vi.spyOn(storage, 'writeJson').mockImplementation(async (file, data) => {
      if (file.endsWith('a2a-relay-inbox.json')) throw new Error('disk unavailable');
      return actualWrite(file, data);
    });
    await h.receiveRelayMessage(USER, message(), h.deps);
    expect(h.service.handleInboundQuestion).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it.each(['logout', 'account_change', 'active_user_change'])('rechecks %s during an awaited admission dependency', async (change) => {
    const h = await setup();
    let active = USER;
    h.deps.activeUserId = () => active;
    const contacts = await import('../../../../src/main/features/contacts/store');
    const actualRead = contacts.getCachedContact;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(contacts, 'getCachedContact').mockImplementationOnce(async (...args) => {
      const contact = await actualRead(...args);
      entered(); await gate;
      return contact;
    });
    const pending = h.receiveRelayMessage(USER, message(), h.deps);
    await started;
    const { clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    if (change === 'active_user_change') active = 'u2';
    else clearHubSession(USER);
    if (change === 'account_change') await signIn('cs_other');
    release();
    await pending;
    expect(h.events).toEqual([]);
    const { getConversation } = await import('../../../../src/main/features/chats');
    expect(await getConversation(USER, CID)).toBeNull();
  });

  it('recovers the persisted canonical payload once with its original time, including concurrent duplicate delivery', async () => {
    const h = await setup();
    const original = message({ createdAt: new Date(Date.now() - 1000).toISOString() });
    await h.stage(original);
    await h.pumpOnce(h.deps);
    await Promise.all([h.receiveRelayMessage(USER, original, h.deps), h.receiveRelayMessage(USER, original, h.deps)]);
    await h.pumpOnce(h.deps);
    expect(h.service.handleInboundQuestion).toHaveBeenCalledTimes(1);
    expect(h.service.handleInboundQuestion).toHaveBeenCalledWith(USER, expect.objectContaining({ text: original.text, createdAt: original.createdAt }), expect.anything());
    expect(h.events.filter((event) => event.type === 'question')).toHaveLength(1);
    expect(await h.listWaitingInbox(USER)).toEqual([]);
  });

  it('keeps unknown relations waiting and recovers on the existing next poll', async () => {
    const h = await setup();
    vi.mocked(h.service.handleInboundQuestion).mockResolvedValueOnce({ accepted: false, reason: 'unknown_relation' });
    await h.receiveRelayMessage(USER, message(), h.deps);
    expect(await h.listWaitingInbox(USER)).toHaveLength(1);
    await h.pumpOnce(h.deps);
    expect(h.events.filter((event) => event.type === 'question')).toHaveLength(1);
    expect(await h.listWaitingInbox(USER)).toEqual([]);
  });

  it.each(['signed_out', 'account_mismatch', 'legacy_unscoped'])('does not recover %s records', async (reason) => {
    const h = await setup();
    await h.stage();
    if (reason === 'signed_out') {
      const { clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
      clearHubSession(USER);
    } else if (reason === 'account_mismatch') await signIn('cs_other');
    else {
      const file = path.join(tmp, USER, 'local', 'a2a-relay-inbox.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete raw.entries[0].toAccount;
      fs.writeFileSync(file, JSON.stringify(raw));
    }
    await h.pumpOnce(h.deps);
    expect(h.service.handleInboundQuestion).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    if (reason === 'signed_out') expect(h.poll).not.toHaveBeenCalled();
  });

  it('does not poll destructively when inbox recovery cannot read the file', async () => {
    const h = await setup();
    const file = path.join(tmp, USER, 'local', 'a2a-relay-inbox.json');
    fs.writeFileSync(file, '{broken');
    await h.pumpOnce(h.deps);
    expect(h.poll).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('discards late polls across logout and re-login, including the old cursor', async () => {
    const h = await setup();
    let release!: (messages: ReturnType<typeof message>[]) => void;
    let entered!: () => void;
    const pollEntered = new Promise<void>((resolve) => { entered = resolve; });
    h.poll.mockImplementationOnce(async () => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const pending = h.pumpOnce(h.deps);
    await pollEntered;
    const { clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    clearHubSession(USER);
    await signIn();
    release([message()]);
    expect(await pending).toBe(0);
    expect(h.events).toEqual([]);
    expect(h.service.handleInboundQuestion).not.toHaveBeenCalled();
    h.poll.mockResolvedValue([]);
    await h.pumpOnce(h.deps);
    expect(h.poll).toHaveBeenLastCalledWith(undefined);
  });

  it('sweeps stale reception staging at most once per user per minute on the existing tick', async () => {
    const h = await setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);

    await h.pumpOnce(h.deps);
    expect(h.service.expireStaleReceptions).toHaveBeenCalledTimes(1);

    // 同一分钟内的后续轮询不再付费做全量会话扫描。
    clock.mockReturnValue(now + 30_000);
    await h.pumpOnce(h.deps);
    expect(h.service.expireStaleReceptions).toHaveBeenCalledTimes(1);

    // 满 60 秒后复用同一次轮询 tick 再扫一次；没有新增定时器。
    clock.mockReturnValue(now + 60_000);
    await h.pumpOnce(h.deps);
    expect(h.service.expireStaleReceptions).toHaveBeenCalledTimes(2);
  });
});
