import { userContactDeletionFencesFile } from '../../paths';
import { nowIso, readJson, safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';

export interface ContactDeletionFence {
  peerUserId: string;
  generation: number;
  fenced: boolean;
  cleanup: 'pending' | 'complete';
  state: 'deleting' | 'deleted' | 'readding' | 'active';
  readdAuthority?: 'local' | 'hub';
  pendingContact?: {
    userId: string;
    name: string;
    phoneMasked?: string;
    addedAt: string;
  };
  updatedAt: string;
}

interface ContactDeletionFenceFile {
  version: 1;
  entries: Record<string, ContactDeletionFence>;
}

function assertUserId(userId: string): string {
  if (!safeId(userId)) throw new Error('invalid user id');
  return userId;
}

function normalize(raw: Partial<ContactDeletionFenceFile>): ContactDeletionFenceFile {
  const entries: Record<string, ContactDeletionFence> = {};
  if (raw?.version !== 1 || !raw.entries || typeof raw.entries !== 'object') {
    return { version: 1, entries };
  }
  for (const [peerUserId, value] of Object.entries(raw.entries)) {
    if (!safeId(peerUserId) || !value || typeof value !== 'object') continue;
    const candidate = value as ContactDeletionFence;
    entries[peerUserId] = {
      peerUserId,
      generation: Number.isInteger(candidate.generation) && candidate.generation > 0
        ? candidate.generation
        : 1,
      fenced: candidate.fenced === true,
      cleanup: candidate.cleanup === 'pending' ? 'pending' : 'complete',
      state: candidate.state === 'readding' || candidate.state === 'active'
        || candidate.state === 'deleting' || candidate.state === 'deleted'
        ? candidate.state
        : candidate.fenced === true
          ? (candidate.cleanup === 'pending' ? 'deleting' : 'deleted')
          : 'active',
      ...(candidate.state === 'readding'
        ? { readdAuthority: candidate.readdAuthority === 'hub' ? 'hub' as const : 'local' as const }
        : {}),
      ...(candidate.pendingContact && candidate.pendingContact.userId === peerUserId
        ? { pendingContact: candidate.pendingContact }
        : {}),
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : nowIso(),
    };
  }
  return { version: 1, entries };
}

async function readFile(userId: string): Promise<ContactDeletionFenceFile> {
  return normalize(await readJson<Partial<ContactDeletionFenceFile>>(
    userContactDeletionFencesFile(assertUserId(userId)),
  ));
}

async function mutateFence(
  userId: string,
  peerUserId: string,
  mutate: (current: ContactDeletionFence | undefined) => ContactDeletionFence,
  isCurrent?: () => boolean,
): Promise<ContactDeletionFence> {
  const peer = String(peerUserId || '').trim();
  if (!safeId(peer)) throw new Error('invalid contact user id');
  const file = userContactDeletionFencesFile(assertUserId(userId));
  return fileEditLock(file).runExclusive(async () => {
    const data = await readFile(userId);
    if (isCurrent && !isCurrent()) throw new Error('contact lifecycle changed');
    const next = mutate(data.entries[peer]);
    data.entries[peer] = next;
    await writeJson(file, data, isCurrent);
    return next;
  });
}

export async function readContactDeletionFence(
  userId: string,
  peerUserId: string,
): Promise<ContactDeletionFence | null> {
  const peer = String(peerUserId || '').trim();
  if (!safeId(peer)) return null;
  return (await readFile(userId)).entries[peer] || null;
}

export async function listPendingContactDeletionFences(userId: string): Promise<ContactDeletionFence[]> {
  return Object.values((await readFile(userId)).entries)
    .filter((entry) => entry.fenced && entry.cleanup === 'pending');
}

export async function listContactReAdds(userId: string): Promise<ContactDeletionFence[]> {
  return Object.values((await readFile(userId)).entries)
    .filter((entry) => entry.state === 'readding' && !!entry.pendingContact);
}

export async function beginContactDeletionFence(
  userId: string,
  peerUserId: string,
  isCurrent?: () => boolean,
): Promise<ContactDeletionFence> {
  return mutateFence(userId, peerUserId, (current) => ({
    peerUserId: String(peerUserId).trim(),
    generation: current?.generation || 1,
    fenced: true,
    cleanup: current?.fenced && current.cleanup === 'complete' ? 'complete' : 'pending',
    state: current?.fenced && current.cleanup === 'complete' ? 'deleted' : 'deleting',
    updatedAt: nowIso(),
  }), isCurrent);
}

export async function completeContactDeletionCleanup(
  userId: string,
  peerUserId: string,
  expectedGeneration: number,
  isCurrent?: () => boolean,
): Promise<{ applied: boolean; fence: ContactDeletionFence | null }> {
  const peer = String(peerUserId || '').trim();
  if (!safeId(peer)) throw new Error('invalid contact user id');
  const file = userContactDeletionFencesFile(assertUserId(userId));
  return fileEditLock(file).runExclusive(async () => {
    const data = await readFile(userId);
    if (isCurrent && !isCurrent()) throw new Error('contact lifecycle changed');
    const current = data.entries[peer];
    if (!current || current.generation !== expectedGeneration || !current.fenced) {
      return { applied: false, fence: current || null };
    }
    const next: ContactDeletionFence = {
      ...current,
      cleanup: 'complete',
      state: current.state === 'readding' ? 'readding' : 'deleted',
      updatedAt: nowIso(),
    };
    data.entries[peer] = next;
    await writeJson(file, data, isCurrent);
    return { applied: true, fence: next };
  });
}

export async function beginContactReAdd(
  userId: string,
  peerUserId: string,
  contact: { userId: string; name: string; phoneMasked?: string; addedAt: string },
  authority: 'local' | 'hub' = 'local',
  isCurrent?: () => boolean,
): Promise<ContactDeletionFence> {
  return mutateFence(userId, peerUserId, (current) => ({
    peerUserId: String(peerUserId).trim(),
    generation: current?.generation || 1,
    fenced: true,
    cleanup: current?.cleanup || 'complete',
    state: 'readding',
    readdAuthority: authority,
    pendingContact: contact,
    updatedAt: nowIso(),
  }), isCurrent);
}

export async function cancelContactReAdd(
  userId: string,
  peerUserId: string,
  expectedGeneration: number,
  isCurrent?: () => boolean,
): Promise<{ applied: boolean; fence: ContactDeletionFence | null }> {
  const peer = String(peerUserId || '').trim();
  if (!safeId(peer)) throw new Error('invalid contact user id');
  const file = userContactDeletionFencesFile(assertUserId(userId));
  return fileEditLock(file).runExclusive(async () => {
    const data = await readFile(userId);
    if (isCurrent && !isCurrent()) throw new Error('contact lifecycle changed');
    const current = data.entries[peer];
    if (!current || current.generation !== expectedGeneration || current.state !== 'readding') {
      return { applied: false, fence: current || null };
    }
    const next: ContactDeletionFence = {
      peerUserId: peer,
      generation: current.generation,
      fenced: true,
      cleanup: 'complete',
      state: 'deleted',
      updatedAt: nowIso(),
    };
    data.entries[peer] = next;
    await writeJson(file, data, isCurrent);
    return { applied: true, fence: next };
  });
}

export async function completeContactReAdd(
  userId: string,
  peerUserId: string,
  expectedGeneration: number,
  isCurrent?: () => boolean,
): Promise<{ applied: boolean; fence: ContactDeletionFence | null }> {
  const peer = String(peerUserId || '').trim();
  if (!safeId(peer)) throw new Error('invalid contact user id');
  const file = userContactDeletionFencesFile(assertUserId(userId));
  return fileEditLock(file).runExclusive(async () => {
    const data = await readFile(userId);
    if (isCurrent && !isCurrent()) throw new Error('contact lifecycle changed');
    const current = data.entries[peer];
    if (!current || current.generation !== expectedGeneration || current.state !== 'readding'
      || current.cleanup !== 'complete') return { applied: false, fence: current || null };
    const next: ContactDeletionFence = {
      peerUserId: peer,
      generation: current.generation + 1,
      fenced: false,
      cleanup: 'complete',
      state: 'active',
      updatedAt: nowIso(),
    };
    data.entries[peer] = next;
    await writeJson(file, data, isCurrent);
    return { applied: true, fence: next };
  });
}
