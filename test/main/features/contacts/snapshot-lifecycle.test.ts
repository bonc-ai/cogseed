import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'snapshot-user';
const PEER = 'cs_alice';
let tmp: string;
let previous: string | undefined;

async function signIn(account: string) {
  const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
  saveHubSession(USER, { session_id: `session-${account}`, access_token: 'normal-session-fixture', refresh_token: 'refresh',
    access_expires_at: new Date(Date.now() + 3600_000).toISOString(), refresh_expires_at: new Date(Date.now() + 7200_000).toISOString() });
  writeHubAccountState(USER, { account_id: account });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-snapshot-lifecycle-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('contacts snapshot commit ceiling', () => {
  for (const boundary of ['tmp_write', 'rename_retry'] as const) {
    it.each(['logout', 'account_change'])(`preserves the current cache across ${boundary}: %s`, async (change) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let paused = false;
      let oldTemp = '';
      let oldRenameAttempts = 0;
      // Forward every actual filesystem operation. Pause only the old snapshot's
      // completed tmp write / failed rename, so production commit guards run.
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs/promises')>();
        return { ...actual,
          writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
            await actual.writeFile(...args);
            if (boundary === 'tmp_write' && !paused && String(args[0]).includes('contacts.json.') && String(args[0]).endsWith('.tmp')) {
              paused = true; oldTemp = String(args[0]); entered(); await gate;
            }
          },
          rename: async (...args: Parameters<typeof actual.rename>) => {
            if (boundary === 'rename_retry' && !paused && String(args[1]).endsWith('contacts.json')) {
              paused = true; oldTemp = String(args[0]); oldRenameAttempts += 1;
              entered(); await gate;
              throw Object.assign(new Error('controlled rename contention'), { code: 'EPERM' });
            }
            if (String(args[0]) === oldTemp) oldRenameAttempts += 1;
            await actual.rename(...args);
          },
        };
      });
      await signIn('cs_original');
      const { userContactsFile } = await import('../../../../src/main/paths');
      const file = userContactsFile(USER);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 1, contacts: [{ userId: PEER, name: 'initial cache', addedAt: '2026-10-27T00:00:00Z' }] }));
      let snapshotName = 'old account snapshot';
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true,
        data: { contacts: [{ accountId: PEER, name: snapshotName, online: true }] } }) })));
      const { refreshContactsFromHub, getCachedContact } = await import('../../../../src/main/features/contacts/store');
      const pending = refreshContactsFromHub(USER);
      await started;
      const { clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
      clearHubSession(USER);
      if (change === 'account_change') {
        await signIn('cs_new');
        snapshotName = 'new account snapshot';
        // Positive control: a real current-account refresh may commit while
        // the old account's tmp file is still waiting to rename.
        expect(await refreshContactsFromHub(USER)).toBe(true);
        expect(await getCachedContact(USER, PEER)).toMatchObject({ name: snapshotName });
      }
      const currentBytes = fs.readFileSync(file, 'utf8');
      release();
      expect(await pending).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe(currentBytes);
      expect(await getCachedContact(USER, PEER)).toMatchObject({ name: change === 'account_change' ? 'new account snapshot' : 'initial cache' });
      expect(fs.existsSync(oldTemp)).toBe(false);
      if (boundary === 'rename_retry') expect(oldRenameAttempts).toBe(1);
    });
  }
});

describe('quality refresh nested effects', () => {
  const CID = 'a2a-0123456789abcdef0456';
  async function seed(withContact = true) {
    await signIn('cs_original');
    const paths = await import('../../../../src/main/paths');
    const file = paths.userContactsFile(USER);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, contacts: withContact
      ? [{ userId: PEER, name: 'initial cache', addedAt: new Date().toISOString() }] : [] }));
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(USER, { conversationId: CID, title: 'existing exchange' });
    await chats.updateConversation(USER, CID, { a2a: { inbound: true, peer_user_id: PEER, state: 'active', exchange_id: CID } });
    const contacts = await import('../../../../src/main/features/contacts/store');
    await contacts.appendHistory(USER, { contactUserId: PEER, direction: 'in', summary: 'authoritative existing history', at: new Date().toISOString() });
    return { paths, file, chats, contacts };
  }

  it.each(['fence_lock', 'fence_commit'])('cannot fence the new account peer after waiting on actual %s', async (boundary) => {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    if (boundary === 'fence_commit') {
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs/promises')>();
        let paused = false;
        return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
          await actual.writeFile(...args);
          if (!paused && String(args[0]).includes('contact-deletion-fences.json.') && String(args[0]).endsWith('.tmp')) {
            paused = true; entered(); await gate;
          }
        } };
      });
    }
    const h = await seed();
    let remote: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: { contacts: remote } }) })));
    let unlock = () => {};
    let waiting: any;
    if (boundary === 'fence_lock') {
      const { fileEditLock } = await import('../../../../src/main/util/locks');
      const lock = fileEditLock(h.paths.userContactDeletionFencesFile(USER));
      unlock = await lock.acquire();
      waiting = vi.spyOn(lock, 'runExclusive');
    }
    const pending = h.contacts.refreshContactsFromHub(USER).catch(() => false);
    if (boundary === 'fence_lock') await vi.waitFor(() => expect(waiting).toHaveBeenCalled());
    else await started;
    (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    await signIn('cs_new');
    remote = [{ accountId: PEER, name: 'new account peer', online: true }];
    expect(await h.contacts.refreshContactsFromHub(USER)).toBe(true);
    const before = fs.readFileSync(h.file, 'utf8');
    const history = fs.readFileSync(h.paths.userContactHistoryFile(USER), 'utf8');
    release(); unlock();
    expect(await pending).toBe(false);
    expect(await h.contacts.getCachedContact(USER, PEER)).toMatchObject({ name: 'new account peer' });
    expect(fs.existsSync(h.paths.userContactDeletionFencesFile(USER))).toBe(false);
    expect(fs.readFileSync(h.file, 'utf8')).toBe(before);
    expect(fs.readFileSync(h.paths.userContactHistoryFile(USER), 'utf8')).toBe(history);
    expect((await h.chats.getConversation(USER, CID))?.a2a?.state).toBe('active');
  });

  it.each(['cleanup', 'reconcile'])('stops nested %s after the actual conversation queue wait and preserves history', async (kind) => {
    const h = await seed(kind === 'cleanup');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: { contacts: [] } }) })));
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = h.chats.updateConversationAtomic(USER, CID, async () => { entered(); await gate; return null; });
    await started;
    const queued = vi.spyOn(h.chats, 'updateA2AMarkersIncludingDeletedAtomic');
    const pending = h.contacts.refreshContactsFromHub(USER).catch(() => false);
    await vi.waitFor(() => expect(queued).toHaveBeenCalled());
    const fences = h.paths.userContactDeletionFencesFile(USER);
    const beforeFence = fs.existsSync(fences) ? fs.readFileSync(fences, 'utf8') : null;
    const beforeHistory = fs.readFileSync(h.paths.userContactHistoryFile(USER), 'utf8');
    const beforeConversation = await h.chats.getConversation(USER, CID);
    (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    release(); await blocker; await pending;
    expect(await h.chats.getConversation(USER, CID)).toEqual(beforeConversation);
    expect(fs.existsSync(fences) ? fs.readFileSync(fences, 'utf8') : null).toBe(beforeFence);
    expect(fs.readFileSync(h.paths.userContactHistoryFile(USER), 'utf8')).toBe(beforeHistory);
  });
});
