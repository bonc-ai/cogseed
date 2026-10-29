/**
 * A2A contacts — local cache, requests and history.
 *
 * Authority for the relationship itself is the Hub (decision D-1: built inside the
 * account service), but the MVP runs against the local stack first (D-11), so this
 * module owns a local store behind the same shapes the Hub API will return. Moving
 * to the Hub client later replaces the source functions only; callers and IPC keep
 * their contract.
 *
 * Two rules from the PRD shape this module:
 * - 往来记录只存本机 (D-8 / FR-07) — history is an append-only local jsonl and is
 *   never sent anywhere;
 * - 手机号查找只回三个布尔 (H-02) — `lookupPhone` returns
 *   `{registered, discoverable, is_contact}` and never profile fields.
 */

import { appendJsonl, readJson, safeId, writeJson } from '../../storage';
import { createLogger } from '../../logger';
import { currentHubIdentity, isHubIdentityCurrent } from '../hub_account/transport';
import {
  userContactHistoryFile,
  userContactDeletionFencesFile,
  userContactRequestsFile,
  userContactsFile,
} from '../../paths';
import type { HubContact } from './hub-client';
import {
  hubConfigured,
  hubDecideRequest,
  hubListContacts,
  hubListRequests,
  hubLookupPhone,
  hubRemoveContact,
  hubSendRequestDetailed,
} from './hub-client';
import { endExchangesWithPeer, reconcileExchangesWithContacts } from '../a2a/end-exchange';
import {
  beginContactReAdd,
  beginContactDeletionFence,
  cancelContactReAdd,
  completeContactReAdd,
  completeContactDeletionCleanup,
  listContactReAdds,
  listPendingContactDeletionFences,
  readContactDeletionFence,
} from './deletion-fence';

const log = createLogger('contacts-store');

export interface ContactRecord {
  /** The other side's account id (`cs_...`), stable across renders and renames. */
  userId: string;
  name: string;
  /** Server-side masked phone (`138****1234`); full numbers never reach the client. */
  phoneMasked?: string;
  /** Presence from the Hub heartbeat window; absent means unknown, not offline. */
  online?: boolean;
  /** The assistant that receives this contact's A2A questions (D-01). */
  assistantAgentId?: string;
  /** Default reception scope offered in the request dialog (FR-06). */
  defaultAgentId?: string;
  defaultWorkspace?: string;
  addedAt: string;
}

export type ContactRequestState = 'pending' | 'accepted' | 'rejected' | 'expired';
export type ContactRequestDirection = 'in' | 'out';

export interface ContactRequestRecord {
  id: string;
  direction: ContactRequestDirection;
  peerUserId?: string;
  peerName?: string;
  phoneMasked?: string;
  note?: string;
  state: ContactRequestState;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
}

export interface ContactHistoryEntry {
  contactUserId: string;
  direction: 'out' | 'in';
  summary: string;
  at: string;
}

interface ContactsFile { version: 1; contacts: ContactRecord[] }
interface RequestsFile { version: 1; requests: ContactRequestRecord[] }

const CONTACTS_VERSION = 1 as const;

/** 对话请求 30 分钟未处理即作废（D-20）。 */
export const CONTACT_REQUEST_TTL_MS = 30 * 60 * 1000;

/** Hub 明确拒绝（而不是暂时不可达）的错误码：这些必须让用户看到原因。 */
const EXPLICIT_REQUEST_REFUSALS = new Set(['NOT_DISCOVERABLE', 'ALREADY_CONTACT', 'NOT_REGISTERED', 'SELF_REQUEST']);

/** 申请被 Hub 拒绝时给界面看的原因（渲染层按 code 本地化，文本只是兜底）。 */
export function requestAddFailureMessage(code: string): string {
  const normalized = String(code || '').toUpperCase();
  if (normalized === 'NOT_DISCOVERABLE') return '对方不接受新的联系人申请';
  if (normalized === 'ALREADY_CONTACT') return '你们已经是联系人了';
  if (normalized === 'NOT_REGISTERED') return '该手机号还没有注册';
  if (normalized === 'SELF_REQUEST') return '不能添加自己';
  return '发起申请失败，请稍后重试';
}

/** Three booleans, nothing else (H-02). */
export interface PhoneLookupResult {
  registered: boolean;
  discoverable: boolean;
  is_contact: boolean;
}

/**
 * The phone → account probe. The Hub answers this (H-02: a new, login-only,
 * quota-limited endpoint); the MVP injects a local implementation so the client
 * can be built and demonstrated before the endpoint exists.
 */
export type PhoneLookup = (userId: string, phone: string) => Promise<PhoneLookupResult>;

function assertUserId(userId: string): string {
  if (!userId || !safeId(userId)) throw new Error('invalid user id');
  return userId;
}

/** 手机号脱敏：只留前 3 后 4，中间打码；完整号码从不落盘（H-02 精神）。 */
export function maskPhone(phone: string): string {
  const digits = normalizePhone(phone);
  if (digits.length <= 7) return digits;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function normalizePhone(raw: string): string {
  return String(raw || '').replace(/[^\d]/g, '');
}

/** The MVP stand-in: nobody is registered until the Hub exists. */
const unavailableLookup: PhoneLookup = async () => ({ registered: false, discoverable: false, is_contact: false });

let phoneLookup: PhoneLookup = unavailableLookup;

/** 新申请到达时的观察者（主进程据此弹系统通知，AC-01/FR-11）。 */
export type ContactRequestArrived = (userId: string, request: ContactRequestRecord) => void;
const requestObservers: ContactRequestArrived[] = [];

export function onContactRequestArrived(observer: ContactRequestArrived): () => void {
  requestObservers.push(observer);
  return () => {
    const index = requestObservers.indexOf(observer);
    if (index >= 0) requestObservers.splice(index, 1);
  };
}

function notifyRequestArrived(userId: string, request: ContactRequestRecord): void {
  for (const observer of [...requestObservers]) {
    try {
      observer(userId, request);
    } catch { /* 观察者失败不影响入库 */ }
  }
}

/** 测试用：清空观察者。 */
export function resetContactRequestObservers(): void {
  requestObservers.length = 0;
}

/** Swap the phone probe (tests, and the Hub client once it lands). */
export function setPhoneLookup(lookup: PhoneLookup | null): void {
  phoneLookup = lookup || unavailableLookup;
}

async function readContactsFile(userId: string): Promise<ContactsFile> {
  const raw = await readJson<ContactsFile>(userContactsFile(assertUserId(userId)));
  const contacts = Array.isArray(raw?.contacts) ? raw.contacts : [];
  return {
    version: CONTACTS_VERSION,
    contacts: contacts.filter((row) => row && typeof row.userId === 'string'),
  };
}

async function writeContactsFile(userId: string, contacts: ContactRecord[], isCurrent?: () => boolean): Promise<void> {
  await writeJson(userContactsFile(assertUserId(userId)), { version: CONTACTS_VERSION, contacts }, isCurrent);
}

async function readRequestsFile(userId: string): Promise<RequestsFile> {
  const raw = await readJson<RequestsFile>(userContactRequestsFile(assertUserId(userId)));
  const requests = Array.isArray(raw?.requests) ? raw.requests : [];
  return {
    version: CONTACTS_VERSION,
    requests: requests.filter((row) => row && typeof row.id === 'string'),
  };
}

async function writeRequestsFile(userId: string, requests: ContactRequestRecord[]): Promise<void> {
  await writeJson(userContactRequestsFile(assertUserId(userId)), { version: CONTACTS_VERSION, requests });
}

/** Merge one authoritative Hub snapshot into the local cache. Extracted so the
 *  inbound admission path can refresh without a second roster read. */
async function applyRemoteContacts(
  userId: string,
  remote: HubContact[],
  isCurrent: () => boolean,
): Promise<ContactRecord[] | null> {
  // 关系来自 Hub，但「默认接待范围」只是本机偏好——Hub 不存它。直接覆盖会把
  // 用户选的 agent/工作区清空（下次接待只剩默认值），所以按 userId 合并回来。
  const cached = await readContactsFile(userId).catch(() => ({ version: CONTACTS_VERSION, contacts: [] as ContactRecord[] }));
  if (!isCurrent()) return null;
  const preferences = new Map(cached.contacts.map((row) => [row.userId, row]));
  const remoteIds = new Set(remote.map((row) => row.accountId));
  const removedPeers = cached.contacts
    .map((row) => row.userId)
    .filter((peerUserId) => !remoteIds.has(peerUserId));
  const removalFences = new Map<string, Awaited<ReturnType<typeof beginContactDeletionFence>>>();
  for (const peerUserId of removedPeers) {
    if (!isCurrent()) return null;
    removalFences.set(peerUserId, await beginContactDeletionFence(userId, peerUserId, isCurrent));
  }
  const contacts = remote.map((row) => {
    const previous = preferences.get(row.accountId);
    return {
      userId: row.accountId,
      name: row.name || row.accountId,
      online: row.online === true,
      addedAt: previous?.addedAt || new Date().toISOString(),
      ...(previous?.assistantAgentId ? { assistantAgentId: previous.assistantAgentId } : {}),
      ...(previous?.defaultAgentId ? { defaultAgentId: previous.defaultAgentId } : {}),
      ...(previous?.defaultWorkspace ? { defaultWorkspace: previous.defaultWorkspace } : {}),
    };
  });
  for (const contact of contacts) {
    const fence = await readContactDeletionFence(userId, contact.userId);
    if (!isCurrent()) return null;
    if (fence?.fenced && fence.state !== 'readding') {
      await beginContactReAdd(userId, contact.userId, contact, 'hub', isCurrent);
    }
  }
  if (!isCurrent()) return null;
  try {
    await writeContactsFile(userId, contacts, isCurrent);
  } catch (error) {
    // The storage commit may revoke a snapshot after mkdir/tmp write or a
    // rename retry. Preserve the current cache and the ordinary I/O error path.
    if (!isCurrent()) return null;
    throw error;
  }
  if (!isCurrent()) return null;
  for (const peerUserId of removedPeers) {
    if (!isCurrent()) return null;
    const fence = removalFences.get(peerUserId);
    if (fence) await cleanupDeletedContact(userId, peerUserId, fence.generation, isCurrent).catch(() => null);
  }
  if (!isCurrent()) return null;
  await retryPendingContactCleanup(userId, remoteIds, isCurrent);
  if (!isCurrent()) return null;
  try {
    await reconcileExchangesWithContacts(userId, contacts.map((row) => row.userId), isCurrent);
  } catch {
    log.warn('a2a exchange reconciliation failed', { contactCount: contacts.length });
  }
  if (!isCurrent()) return null;
  // Names are presentation only; never rejoin a removed actor or rewrite a
  // historical recipient_name snapshot. Existing T3 deletion cleanup runs first.
  const { refreshContactNamesInMembers } = await import('../group_chat/state');
  if (!isCurrent()) return null;
  await refreshContactNamesInMembers(userId,
    contacts.map(row => ({ accountId: row.userId, name: row.name })), isCurrent);
  return isCurrent() ? contacts.sort((a, b) => String(a.name).localeCompare(String(b.name))) : null;
}

export async function listContacts(userId: string): Promise<ContactRecord[]> {
  const scope = currentHubIdentity(userId);
  const isCurrent = () => !!scope && isHubIdentityCurrent(userId, scope);
  // Hub 是关系权威（D-1）：配了就用服务端结果，同时把它写回本机缓存供离线读。
  const remote = await hubListContacts(userId, { isCurrent });
  if (remote && scope) {
    const applied = await applyRemoteContacts(userId, remote, isCurrent).catch((error) => {
      if (!isCurrent()) return null;
      throw error;
    });
    if (applied) return applied;
  }
  const file = await readContactsFile(userId);
  return file.contacts.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Authoritative relation refresh for inbound admission (T3.2).
 *
 * Returns false when Hub could not answer at all. `false` means "still unknown",
 * not "not a contact": the caller must not drop the message as unauthorised
 * merely because the roster cache was stale or the network was down.
 */
export async function refreshContactsFromHub(userId: string, options: { isCurrent?: () => boolean } = {}): Promise<boolean> {
  const scope = currentHubIdentity(userId);
  const isCurrent = () => !!scope && isHubIdentityCurrent(userId, scope) && (!options.isCurrent || options.isCurrent());
  if (!isCurrent()) return false;
  const remote = await hubListContacts(userId, { isCurrent });
  if (!remote || !scope) return false;
  try {
    return !!(await applyRemoteContacts(userId, remote, isCurrent));
  } catch (error) {
    if (!isCurrent()) return false;
    throw error;
  }
}

/**
 * Read one contact from the local cache only (no Hub round trip).
 *
 * Used on a hot path — every inbound A2A question — where the answer must be
 * synchronous with the message and a 5 s Hub timeout would stall the reception.
 * The cache is refreshed whenever the roster is listed (contacts page, accepting a
 * request), which is exactly when a relationship can appear.
 */
export async function getCachedContact(userId: string, contactUserId: string): Promise<ContactRecord | null> {
  const target = String(contactUserId || '').trim();
  if (!target) return null;
  try {
    if ((await readContactDeletionFence(userId, target))?.fenced) return null;
  } catch (error) {
    log.warn('contact deletion fence read failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const file = await readContactsFile(assertUserId(userId)).catch(() => null);
  if (!file) return null;
  return file.contacts.find((row) => row.userId === target) || null;
}

export async function lookupPhone(userId: string, phone: string): Promise<PhoneLookupResult> {
  const normalized = normalizePhone(phone);
  if (!normalized) return { registered: false, discoverable: false, is_contact: false };
  // 配了 Hub 就先问服务端（权威数据）；Hub 未配置或不可用时回落到本地实现。
  const fromHub = await hubLookupPhone(userId, normalized);
  if (fromHub) return fromHub;
  return phoneLookup(assertUserId(userId), normalized);
}

export async function requestAdd(
  userId: string,
  input: { phone: string; note?: string; peerUserId?: string; peerName?: string },
): Promise<ContactRequestRecord> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error('phone is required');
  const file = await readRequestsFile(userId);
  const duplicate = file.requests.find((row) => (
    row.direction === 'out'
    && row.state === 'pending'
    && (input.peerUserId
      ? row.peerUserId === input.peerUserId
      : row.phoneMasked === maskPhone(phone))
  ));
  if (duplicate) return duplicate;
  // Hub 是申请权威：配置了就由服务端去重、校验「已联系/不可被搜」。
  // 服务端**明确拒绝**必须原样抛给用户（AC-06 的「开关关闭直接拒」）；只有送不达
  // （Hub 不可达/5xx）才沿用既有回落，避免把离线误报成对方拒绝。
  if (hubConfigured(userId)) {
    const remote = await hubSendRequestDetailed(userId, phone, input.note);
    if (remote.ok === false) {
      // 服务端明确拒绝 → 原样告诉用户（AC-06：开关关闭就直接拒）。
      // 只是送不达（网络/5xx）→ 沿用既有「回落本地」的行为，不把离线说成被拒。
      if (EXPLICIT_REQUEST_REFUSALS.has(String(remote.code || '').toUpperCase())) {
        throw Object.assign(new Error(requestAddFailureMessage(remote.code)), { code: remote.code });
      }
    } else {
      const file = await readRequestsFile(userId);
      const record: ContactRequestRecord = {
        id: remote.requestId,
        direction: 'out',
        phoneMasked: maskPhone(phone),
        ...(input.note ? { note: input.note } : {}),
        state: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CONTACT_REQUEST_TTL_MS).toISOString(),
      };
      await writeRequestsFile(userId, [...file.requests, record]);
      return record;
    }
  }
  const now = new Date().toISOString();
  const masked = maskPhone(phone);
  const record: ContactRequestRecord = {
    id: `creq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    direction: 'out',
    phoneMasked: masked,
    ...(input.peerUserId ? { peerUserId: input.peerUserId } : {}),
    ...(input.peerName ? { peerName: input.peerName } : {}),
    ...(input.note ? { note: input.note } : {}),
    state: 'pending',
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + CONTACT_REQUEST_TTL_MS).toISOString(),
  };
  await writeRequestsFile(userId, [...file.requests, record]);
  notifyRequestArrived(userId, record);
  return record;
}

export async function listRequests(userId: string): Promise<ContactRequestRecord[]> {
  // Hub 优先：服务端已经按视角投影好 direction 与过期状态。
  const remote = await hubListRequests(userId);
  if (remote) {
    const rows: ContactRequestRecord[] = remote.map((row) => ({
      id: row.requestId,
      direction: row.direction,
      peerUserId: row.peerAccountId,
      ...(row.peerName ? { peerName: row.peerName } : {}),
      phoneMasked: row.phoneMasked,
      ...(row.note ? { note: row.note } : {}),
      state: row.state,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }));
    await writeRequestsFile(userId, rows);
    return rows;
  }
  const file = await readRequestsFile(userId);
  const now = Date.now();
  return file.requests
    // 读时惰性判过期：不依赖定时器，客户端离线期间也正确（D-20）。
    .map((row) => (isRequestExpired(row, now) ? { ...row, state: 'expired' as const } : row))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 30 分钟未处理即过期（D-20），惰性判定，离线客户端也正确。 */
export function isRequestExpired(request: ContactRequestRecord, now = Date.now()): boolean {
  if (request.state !== 'pending') return false;
  if (!request.expiresAt) return false;
  const at = Date.parse(request.expiresAt);
  return Number.isFinite(at) && at <= now;
}

export interface ContactMutationDeps {
  afterReAddStage?: (stage: 'journal' | 'cleanup' | 'contact' | 'clear') => Promise<void>;
}

export async function acceptRequest(
  userId: string,
  requestId: string,
  deps: ContactMutationDeps = {},
): Promise<ContactRequestRecord | null> {
  if (await hubDecideRequest(userId, requestId, true)) {
    const before = new Set((await readContactsFile(userId)).contacts.map((row) => row.userId));
    await listContacts(userId).catch(() => []);
    const after = await readContactsFile(userId);
    for (const contact of after.contacts) {
      if (before.has(contact.userId)) continue;
      const currentFence = await readContactDeletionFence(userId, contact.userId);
      const transition = currentFence?.state === 'readding'
        ? currentFence
        : currentFence?.fenced
          ? await beginContactReAdd(userId, contact.userId, contact, 'hub')
          : null;
      // listContacts owns the authoritative roster reconciliation. If it
      // already completed this generation, accepting the request must not
      // manufacture a second relationship generation.
      if (!transition) continue;
      await deps.afterReAddStage?.('journal');
      await retryContactCleanup(userId, contact.userId);
      await deps.afterReAddStage?.('cleanup');
      await completeContactReAdd(userId, contact.userId, transition.generation);
      await deps.afterReAddStage?.('clear');
    }
    return { id: requestId, direction: 'in', state: 'accepted', createdAt: new Date().toISOString() };
  }
  const file = await readRequestsFile(userId);
  const request = file.requests.find((row) => row.id === requestId);
  if (!request) return null;
  if (request.state !== 'pending' || isRequestExpired(request)) {
    return { ...request, state: request.state === 'pending' ? 'expired' : request.state };
  }
  const now = new Date().toISOString();
  const updated: ContactRequestRecord = { ...request, state: 'accepted', updatedAt: now };
  await writeRequestsFile(userId, file.requests.map((row) => (row.id === requestId ? updated : row)));
  if (request.peerUserId) {
    const contacts = await readContactsFile(userId);
    const contact: ContactRecord = {
      userId: request.peerUserId,
      name: request.peerName || request.peerUserId,
      ...(request.phoneMasked ? { phoneMasked: request.phoneMasked } : {}),
      addedAt: now,
    };
    const transition = await beginContactReAdd(userId, request.peerUserId, contact);
    await deps.afterReAddStage?.('journal');
    await retryContactCleanup(userId, request.peerUserId);
    await deps.afterReAddStage?.('cleanup');
    if (!contacts.contacts.some((row) => row.userId === request.peerUserId)) {
      await writeContactsFile(userId, [...contacts.contacts, contact]);
    }
    await deps.afterReAddStage?.('contact');
    await completeContactReAdd(userId, request.peerUserId, transition.generation);
    await deps.afterReAddStage?.('clear');
  }
  return updated;
}

export async function rejectRequest(userId: string, requestId: string): Promise<ContactRequestRecord | null> {
  if (await hubDecideRequest(userId, requestId, false)) {
    return { id: requestId, direction: 'in', state: 'rejected', createdAt: new Date().toISOString() };
  }
  const file = await readRequestsFile(userId);
  const request = file.requests.find((row) => row.id === requestId);
  if (!request) return null;
  const updated: ContactRequestRecord = { ...request, state: 'rejected', updatedAt: new Date().toISOString() };
  await writeRequestsFile(userId, file.requests.map((row) => (row.id === requestId ? updated : row)));
  return updated;
}

async function cleanupDeletedContact(
  userId: string,
  contactUserId: string,
  expectedGeneration: number,
  isCurrent?: () => boolean,
): Promise<{ ended: number; cleanupPending: boolean }> {
  try {
    if (isCurrent && !isCurrent()) return { ended: 0, cleanupPending: true };
    const ended = await endExchangesWithPeer(userId, contactUserId, isCurrent);
    if (isCurrent && !isCurrent()) return { ended, cleanupPending: true };
    await completeContactDeletionCleanup(userId, contactUserId, expectedGeneration, isCurrent);
    return { ended, cleanupPending: false };
  } catch (error) {
    log.warn('contact deletion cleanup pending', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ended: 0, cleanupPending: true };
  }
}

async function retryContactCleanup(userId: string, contactUserId: string, isCurrent?: () => boolean): Promise<boolean> {
  const fence = await readContactDeletionFence(userId, contactUserId);
  if (isCurrent && !isCurrent()) return false;
  if (!fence?.fenced || fence.cleanup !== 'pending') return true;
  return !(await cleanupDeletedContact(userId, contactUserId, fence.generation, isCurrent)).cleanupPending;
}

async function recoverContactReAdds(
  userId: string,
  authoritativePeerIds: ReadonlySet<string> | null | undefined,
  isCurrent?: () => boolean,
): Promise<number> {
  let recovered = 0;
  for (const transition of await listContactReAdds(userId)) {
    if (isCurrent && !isCurrent()) return recovered;
    if (transition.cleanup !== 'complete' || !transition.pendingContact) continue;
    if (transition.readdAuthority === 'hub') {
      if (authoritativePeerIds === null) continue;
      if (!authoritativePeerIds?.has(transition.peerUserId)) {
        await cancelContactReAdd(userId, transition.peerUserId, transition.generation, isCurrent);
        continue;
      }
    }
    const file = await readContactsFile(userId);
    if (isCurrent && !isCurrent()) return recovered;
    if (!file.contacts.some((row) => row.userId === transition.peerUserId)) {
      await writeContactsFile(userId, [...file.contacts, transition.pendingContact], isCurrent);
    }
    const completed = await completeContactReAdd(userId, transition.peerUserId, transition.generation, isCurrent);
    if (completed.applied) recovered += 1;
  }
  return recovered;
}

export async function retryPendingContactCleanup(
  userId: string,
  knownAuthoritativePeerIds?: ReadonlySet<string>,
  isCurrent?: () => boolean,
): Promise<{ completed: number; pending: number }> {
  let authoritativePeerIds: ReadonlySet<string> | null | undefined = knownAuthoritativePeerIds;
  if (authoritativePeerIds === undefined && hubConfigured(userId)) {
    const remote = await hubListContacts(userId, { isCurrent });
    authoritativePeerIds = remote ? new Set(remote.map((row) => row.accountId)) : null;
  }
  let completed = 0;
  let pending = 0;
  for (const fence of await listPendingContactDeletionFences(userId)) {
    if (isCurrent && !isCurrent()) return { completed, pending };
    if (await retryContactCleanup(userId, fence.peerUserId, isCurrent)) completed += 1;
    else pending += 1;
  }
  if (isCurrent && !isCurrent()) return { completed, pending };
  completed += await recoverContactReAdds(userId, authoritativePeerIds, isCurrent);
  return { completed, pending };
}

export async function isContactDeletionFenced(userId: string, contactUserId: string): Promise<boolean> {
  return (await readContactDeletionFence(userId, contactUserId))?.fenced === true;
}

export { readContactDeletionFence };

/** Persist the security fence before removing the relation, then finish every exchange. */
export async function deleteContact(
  userId: string,
  contactUserId: string,
): Promise<{ removed: boolean; ended: number; cleanupPending: boolean }> {
  const peer = String(contactUserId || '').trim();
  if (!safeId(peer)) return { removed: false, ended: 0, cleanupPending: false };
  const file = await readContactsFile(userId);
  const hadLocalContact = file.contacts.some((row) => row.userId === peer);
  if (!hadLocalContact && !hubConfigured(userId)) return { removed: false, ended: 0, cleanupPending: false };
  const fence = await beginContactDeletionFence(userId, peer);
  const removedRemotely = await hubRemoveContact(userId, peer);
  const next = file.contacts.filter((row) => row.userId !== peer);
  const removed = removedRemotely || next.length !== file.contacts.length;
  if (!removed) return { removed: false, ended: 0, cleanupPending: true };
  await writeContactsFile(userId, next);
  const cleanup = await cleanupDeletedContact(userId, peer, fence.generation);
  return { removed: true, ...cleanup };
}

/** Compatibility shape for feature callers; deletion still uses the fenced workflow. */
export async function removeContact(userId: string, contactUserId: string): Promise<boolean> {
  return (await deleteContact(userId, contactUserId)).removed;
}

export async function setDefaultScope(
  userId: string,
  contactUserId: string,
  scope: { agentId?: string; workspace?: string },
): Promise<ContactRecord | null> {
  const file = await readContactsFile(userId);
  let updated: ContactRecord | null = null;
  const next = file.contacts.map((row) => {
    if (row.userId !== contactUserId) return row;
    const next: ContactRecord = { ...row };
    // 空字符串表示「按接待时选择」＝清除该默认值，不能用 falsy 判断跳过。
    if (scope.agentId !== undefined) {
      if (scope.agentId) next.defaultAgentId = scope.agentId;
      else delete next.defaultAgentId;
    }
    if (scope.workspace !== undefined) {
      if (scope.workspace) next.defaultWorkspace = scope.workspace;
      else delete next.defaultWorkspace;
    }
    updated = next;
    return next;
  });
  if (!updated) return null;
  await writeContactsFile(userId, next);
  return updated;
}

export async function appendHistory(userId: string, entry: ContactHistoryEntry, isCurrent?: () => boolean): Promise<void> {
  await appendJsonl(userContactHistoryFile(assertUserId(userId)), entry, isCurrent);
}

export async function listHistory(userId: string, contactUserId?: string): Promise<ContactHistoryEntry[]> {
  const text = await readTextSafe(userContactHistoryFile(assertUserId(userId)));
  const rows: ContactHistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ContactHistoryEntry;
      if (!parsed || typeof parsed.summary !== 'string') continue;
      if (contactUserId && parsed.contactUserId !== contactUserId) continue;
      rows.push(parsed);
    } catch { /* 单行损坏不影响其余记录 */ }
  }
  return rows;
}

async function readTextSafe(file: string): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** 测试用：清空本机三份数据。 */
export async function resetContactsStore(userId: string): Promise<void> {
  await writeContactsFile(userId, []);
  await writeRequestsFile(userId, []);
}

export const __paths = {
  contacts: userContactsFile,
  requests: userContactRequestsFile,
  history: userContactHistoryFile,
  deletionFences: userContactDeletionFencesFile,
};
