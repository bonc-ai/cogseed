import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A2A contacts store — the local half of the MVP.
 *
 * The relationship authority is the Hub (D-1), so these tests pin only what the
 * client owns: the phone probe stays three booleans (H-02), requests expire lazily
 * (D-20), deleting is one-sided locally and keeps history (FR-08), and history is
 * append-only local data (D-8/FR-07).
 */
const USER = 'contacts-user';
let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-store-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../../src/main/features/contacts/hub-client');
  vi.doUnmock('../../../../src/main/features/a2a/end-exchange');
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function store() {
  return import('../../../../src/main/features/contacts/store');
}

describe('contacts store › phone lookup (H-02)', () => {
  it('returns exactly the three booleans and never profile fields', async () => {
    const s = await store();
    s.setPhoneLookup(async () => ({ registered: true, discoverable: true, is_contact: false }));
    const result = await s.lookupPhone(USER, '138-0000-1234');
    expect(result).toEqual({ registered: true, discoverable: true, is_contact: false });
    expect(Object.keys(result).sort()).toEqual(['discoverable', 'is_contact', 'registered']);
  });

  it('defaults to "unknown number" when no probe is wired, and rejects empty input', async () => {
    const s = await store();
    expect(await s.lookupPhone(USER, '13800001234'))
      .toEqual({ registered: false, discoverable: false, is_contact: false });
    expect(await s.lookupPhone(USER, '  '))
      .toEqual({ registered: false, discoverable: false, is_contact: false });
    // The probe receives digits only.
    const probe = vi.fn(async () => ({ registered: true, discoverable: true, is_contact: true }));
    s.setPhoneLookup(probe);
    await s.lookupPhone(USER, '+86 138-0000-1234');
    expect(probe).toHaveBeenCalledWith(USER, '8613800001234');
  });
});

describe('contacts store › requests', () => {
  it('creates one pending outgoing request and reuses it on retry', async () => {
    const s = await store();
    const first = await s.requestAdd(USER, { phone: '13800001234', note: 'hi' });
    expect(first).toMatchObject({ direction: 'out', state: 'pending', note: 'hi' });
    const again = await s.requestAdd(USER, { phone: '13800001234' });
    expect(again.id).toBe(first.id);
    expect((await s.listRequests(USER)).length).toBe(1);
  });

  it('accepting adds the contact and marks the request accepted', async () => {
    const s = await store();
    const request = await s.requestAdd(USER, { phone: '13800001234', peerUserId: 'cs_alice', peerName: 'Alice' });
    const accepted = await s.acceptRequest(USER, request.id);
    expect(accepted?.state).toBe('accepted');
    const contacts = await s.listContacts(USER);
    expect(contacts.map((row) => row.userId)).toEqual(['cs_alice']);
  });

  it('rejects without adding a contact', async () => {
    const s = await store();
    const request = await s.requestAdd(USER, { phone: '13800001234', peerUserId: 'cs_bob' });
    await s.rejectRequest(USER, request.id);
    expect(await s.listContacts(USER)).toEqual([]);
  });

  it('treats a pending request past its expiry as expired (D-20)', async () => {
    const s = await store();
    const request = await s.requestAdd(USER, { phone: '13800001234', peerUserId: 'cs_carol' });
    const requests = (await s.listRequests(USER)).map((row) => (
      row.id === request.id ? { ...row, expiresAt: new Date(Date.now() - 1000).toISOString() } : row
    ));
    const file = JSON.parse(fs.readFileSync(s.__paths.requests(USER), 'utf8'));
    fs.writeFileSync(s.__paths.requests(USER), JSON.stringify({ ...file, requests }));
    const result = await s.acceptRequest(USER, request.id);
    expect(result?.state).toBe('expired');
    expect(await s.listContacts(USER)).toEqual([]);
  });
});

describe('contacts store › relationship and history', () => {
  it('persists a deletion fence before cleanup and retries it after restart without fencing other peers', async () => {
    const endExchangesWithPeer = vi.fn()
      .mockRejectedValueOnce(new Error('fail once'))
      .mockResolvedValue(2);
    vi.doMock('../../../../src/main/features/contacts/hub-client', () => ({
      hubConfigured: () => false,
      hubSendRequestDetailed: async () => ({ ok: false, code: 'HUB_UNREACHABLE' }),
      hubLookupPhone: async () => null,
      hubListContacts: async () => null,
      hubListRequests: async () => null,
      hubDecideRequest: async () => false,
      hubRemoveContact: async () => false,
      hubSelfAccountId: async () => null,
    }));
    vi.doMock('../../../../src/main/features/a2a/end-exchange', () => ({
      endExchangesWithPeer,
      reconcileExchangesWithContacts: vi.fn(async () => 0),
    }));
    vi.resetModules();
    const s = await store();
    fs.mkdirSync(path.dirname(s.__paths.contacts(USER)), { recursive: true });
    fs.writeFileSync(s.__paths.contacts(USER), JSON.stringify({
      version: 1,
      contacts: [
        { userId: 'cs_alice', name: 'Alice', addedAt: '2026-10-25T00:00:00Z' },
        { userId: 'cs_bob', name: 'Bob', addedAt: '2026-10-25T00:00:00Z' },
      ],
    }));

    await expect(s.deleteContact(USER, 'cs_alice')).resolves.toMatchObject({
      removed: true,
      ended: 0,
      cleanupPending: true,
    });
    expect(await s.isContactDeletionFenced(USER, 'cs_alice')).toBe(true);
    expect(await s.getCachedContact(USER, 'cs_alice')).toBeNull();
    expect(await s.getCachedContact(USER, 'cs_bob')).toMatchObject({ userId: 'cs_bob' });

    // The journal is durable, not an in-memory retry flag.
    vi.resetModules();
    const restarted = await store();
    await expect(restarted.retryPendingContactCleanup(USER)).resolves.toMatchObject({ completed: 1 });
    await expect(restarted.readContactDeletionFence(USER, 'cs_alice')).resolves.toMatchObject({
      fenced: true,
      cleanup: 'complete',
      generation: 1,
    });
    expect(endExchangesWithPeer).toHaveBeenCalledTimes(2);

    // A deliberate new relationship advances generation and clears only this peer's fence.
    const request = await restarted.requestAdd(USER, {
      phone: '13800001234', peerUserId: 'cs_alice', peerName: 'Alice',
    });
    await restarted.acceptRequest(USER, request.id);
    await expect(restarted.readContactDeletionFence(USER, 'cs_alice')).resolves.toMatchObject({
      fenced: false,
      cleanup: 'complete',
      generation: 2,
    });
    expect(await restarted.isContactDeletionFenced(USER, 'cs_bob')).toBe(false);
  });

  it.each(['journal', 'cleanup', 'contact', 'clear'] as const)(
    'recovers a re-add after a crash at the %s stage',
    async (crashStage) => {
      const s = await store();
      const peer = `cs_readd_${crashStage}`;
      fs.mkdirSync(path.dirname(s.__paths.contacts(USER)), { recursive: true });
      fs.writeFileSync(s.__paths.contacts(USER), JSON.stringify({
        version: 1,
        contacts: [{ userId: peer, name: 'Peer', addedAt: '2026-10-25T00:00:00Z' }],
      }));
      await s.deleteContact(USER, peer);
      const request = await s.requestAdd(USER, {
        phone: '13800001234', peerUserId: peer, peerName: 'Peer',
      });
      let crashed = false;
      await expect(s.acceptRequest(USER, request.id, {
        afterReAddStage: async (stage) => {
          if (!crashed && stage === crashStage) {
            crashed = true;
            throw new Error(`crash after ${stage}`);
          }
        },
      })).rejects.toThrow(`crash after ${crashStage}`);

      vi.resetModules();
      const restarted = await store();
      await restarted.retryPendingContactCleanup(USER);
      expect(await restarted.getCachedContact(USER, peer)).toMatchObject({ userId: peer });
      expect(await restarted.readContactDeletionFence(USER, peer)).toMatchObject({
        fenced: false,
        cleanup: 'complete',
        state: 'active',
      });
    },
  );

  it('ignores a late cleanup completion from an older relationship generation', async () => {
    const fences = await import('../../../../src/main/features/contacts/deletion-fence');
    const deleting = await fences.beginContactDeletionFence(USER, 'cs_generation');
    await fences.completeContactDeletionCleanup(USER, 'cs_generation', deleting.generation);
    const clearing = await fences.beginContactReAdd(USER, 'cs_generation', {
      userId: 'cs_generation', name: 'Generation Two', addedAt: '2026-10-25T00:00:00Z',
    });
    await fences.completeContactReAdd(USER, 'cs_generation', clearing.generation);

    const stale = await fences.completeContactDeletionCleanup(USER, 'cs_generation', deleting.generation);
    expect(stale.applied).toBe(false);
    await expect(fences.readContactDeletionFence(USER, 'cs_generation')).resolves.toMatchObject({
      generation: deleting.generation + 1,
      fenced: false,
      state: 'active',
    });
  });

  it('removes a contact but keeps history (FR-08)', async () => {
    const s = await store();
    const request = await s.requestAdd(USER, { phone: '13800001234', peerUserId: 'cs_alice', peerName: 'Alice' });
    await s.acceptRequest(USER, request.id);
    await s.appendHistory(USER, { contactUserId: 'cs_alice', direction: 'out', summary: '问了报价', at: new Date().toISOString() });
    expect(await s.removeContact(USER, 'cs_alice')).toBe(true);
    expect(await s.removeContact(USER, 'cs_alice')).toBe(false);
    expect(await s.listContacts(USER)).toEqual([]);
    expect((await s.listHistory(USER, 'cs_alice')).map((row) => row.summary)).toEqual(['问了报价']);
  });

  it('stores the default reception scope used by the request dialog (FR-06)', async () => {
    const s = await store();
    const request = await s.requestAdd(USER, { phone: '13800001234', peerUserId: 'cs_alice', peerName: 'Alice' });
    await s.acceptRequest(USER, request.id);
    const updated = await s.setDefaultScope(USER, 'cs_alice', { agentId: 'agent-1', workspace: '/w' });
    expect(updated).toMatchObject({ defaultAgentId: 'agent-1', defaultWorkspace: '/w' });
    const [contact] = await s.listContacts(USER);
    expect(contact).toMatchObject({ defaultAgentId: 'agent-1', defaultWorkspace: '/w' });
  });

  it('ignores a corrupt history line instead of failing the whole read', async () => {
    const s = await store();
    fs.mkdirSync(path.dirname(s.__paths.history(USER)), { recursive: true });
    fs.writeFileSync(s.__paths.history(USER), '{"contactUserId":"cs_a","summary":"ok","at":"t"}\nnot json\n');
    const rows = await s.listHistory(USER);
    expect(rows.map((row) => row.summary)).toEqual(['ok']);
  });

  it('creates requests with a 30-minute expiry and reports them expired lazily', async () => {
    const s = await store();
    const created = await s.requestAdd(USER, { phone: '13800001234', peerUserId: 'cs_dan' });
    const ttl = Date.parse(created.expiresAt || '') - Date.parse(created.createdAt);
    expect(ttl).toBe(s.CONTACT_REQUEST_TTL_MS);
    expect((await s.listRequests(USER))[0].state).toBe('pending');

    const file = JSON.parse(fs.readFileSync(s.__paths.requests(USER), 'utf8'));
    const past = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(s.__paths.requests(USER), JSON.stringify({
      ...file,
      requests: file.requests.map((row: any) => (row.id === created.id ? { ...row, expiresAt: past } : row)),
    }));
    const [row] = await s.listRequests(USER);
    expect(row.state).toBe('expired');
  });

  it('clears a default scope when given an empty value', async () => {
    const s = await store();
    const request = await s.requestAdd(USER, { phone: '13800001234', peerUserId: 'cs_alice', peerName: 'Alice' });
    await s.acceptRequest(USER, request.id);
    await s.setDefaultScope(USER, 'cs_alice', { agentId: 'agent-1', workspace: '/w' });

    // 空串＝「按接待时选择」，必须真的清掉，而不是被 falsy 判断忽略。
    const cleared = await s.setDefaultScope(USER, 'cs_alice', { agentId: '', workspace: '' });
    expect(cleared && 'defaultAgentId' in cleared).toBe(false);
    expect(cleared && 'defaultWorkspace' in cleared).toBe(false);

    // 只清一个维度时，另一个保持不变。
    await s.setDefaultScope(USER, 'cs_alice', { agentId: 'agent-2', workspace: '/w2' });
    const partial = await s.setDefaultScope(USER, 'cs_alice', { agentId: '' });
    expect(partial?.defaultAgentId).toBeUndefined();
    expect(partial?.defaultWorkspace).toBe('/w2');
  });
});

describe('contacts store › the hub is authoritative for a request', () => {
  /** 让 hub-client 表现得像「已配置」并返回指定结果。 */
  async function withHub(result: { ok: true; requestId: string } | { ok: false; code: string }) {
    vi.doMock('../../../../src/main/features/contacts/hub-client', () => ({
      hubConfigured: () => true,
      hubSendRequestDetailed: async () => result,
      hubLookupPhone: async () => null,
      hubListContacts: async () => null,
      hubListRequests: async () => null,
      hubDecideRequest: async () => false,
      hubRemoveContact: async () => false,
      hubSelfAccountId: async () => null,
    }));
    vi.resetModules();
    return store();
  }

  it('surfaces an explicit refusal instead of pretending the request was sent', async () => {
    const s = await withHub({ ok: false, code: 'NOT_DISCOVERABLE' });
    await expect(s.requestAdd(USER, { phone: '13800001234' })).rejects.toThrow(/不接受/);
    // 没有留下一条"看起来已发出"的本地申请。
    expect(await s.listRequests(USER)).toEqual([]);
  });

  it('keeps the hub request id when the request is accepted', async () => {
    const s = await withHub({ ok: true, requestId: 'creq-hub-1' });
    const record = await s.requestAdd(USER, { phone: '13800001234' });
    expect(record).toMatchObject({ id: 'creq-hub-1', direction: 'out', state: 'pending' });
  });

  it('still falls back locally when the hub is merely unreachable', async () => {
    const s = await withHub({ ok: false, code: 'HUB_UNREACHABLE' });
    const record = await s.requestAdd(USER, { phone: '13800001234' });
    expect(record.id).toMatch(/^creq-/);
    expect(record.id).not.toBe('creq-hub-1');
  });

  it('advances a recovered relationship generation exactly once on hub acceptance', async () => {
    vi.doMock('../../../../src/main/features/contacts/hub-client', () => ({
      hubConfigured: () => true,
      hubSendRequestDetailed: async () => ({ ok: true as const, requestId: 'creq-hub-readd' }),
      hubLookupPhone: async () => null,
      hubListContacts: async () => [{ accountId: 'cs_hub_readd', name: 'Hub Peer', online: true }],
      hubListRequests: async () => null,
      hubDecideRequest: async () => true,
      hubRemoveContact: async () => true,
      hubSelfAccountId: async () => null,
    }));
    vi.resetModules();
    const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
    saveHubSession(USER, { session_id: 'readd-fixture', access_token: 'fixture', refresh_token: 'fixture',
      access_expires_at: new Date(Date.now() + 3600_000).toISOString(), refresh_expires_at: new Date(Date.now() + 7200_000).toISOString() });
    writeHubAccountState(USER, { account_id: 'cs_self' });
    const s = await store();
    const fences = await import('../../../../src/main/features/contacts/deletion-fence');
    const deleting = await fences.beginContactDeletionFence(USER, 'cs_hub_readd');
    await fences.completeContactDeletionCleanup(USER, 'cs_hub_readd', deleting.generation);

    await s.acceptRequest(USER, 'creq-hub-readd');

    await expect(s.readContactDeletionFence(USER, 'cs_hub_readd')).resolves.toMatchObject({
      fenced: false,
      state: 'active',
      generation: deleting.generation + 1,
    });
  });

  it('does not restore a journaled hub re-add that disappeared from the authoritative roster', async () => {
    vi.doMock('../../../../src/main/features/contacts/hub-client', () => ({
      hubConfigured: () => true,
      hubSendRequestDetailed: async () => ({ ok: false as const, code: 'HUB_UNREACHABLE' }),
      hubLookupPhone: async () => null,
      hubListContacts: async () => [],
      hubListRequests: async () => null,
      hubDecideRequest: async () => false,
      hubRemoveContact: async () => false,
      hubSelfAccountId: async () => null,
    }));
    vi.resetModules();
    const s = await store();
    const fences = await import('../../../../src/main/features/contacts/deletion-fence');
    const peer = 'cs_stale_hub_readd';
    const deleting = await fences.beginContactDeletionFence(USER, peer);
    await fences.completeContactDeletionCleanup(USER, peer, deleting.generation);
    await fences.beginContactReAdd(USER, peer, {
      userId: peer,
      name: 'Stale Hub Peer',
      addedAt: '2026-10-25T00:00:00Z',
    }, 'hub');

    await s.retryPendingContactCleanup(USER);

    expect(await s.getCachedContact(USER, peer)).toBeNull();
    await expect(s.readContactDeletionFence(USER, peer)).resolves.toMatchObject({
      fenced: true,
      cleanup: 'complete',
      state: 'deleted',
      generation: deleting.generation,
    });
  });
});
