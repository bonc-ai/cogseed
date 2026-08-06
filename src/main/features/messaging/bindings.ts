import { Mutex } from 'async-mutex';

import { nowIso, readJson, safeId, writeJson } from '../../storage';
import { userMessagingBindingsFile } from '../../paths';
import * as chats from '../chats';
import * as projects from '../projects';
import type { InboundEnvelope, MessagingBinding, MessagingBindingsFile, MessagingInstance } from './types';

const EMPTY: MessagingBindingsFile = { version: 1, bindings: {} };
const locks = new Map<string, Mutex>();

function assertUserId(uid: string): void {
  if (!safeId(uid)) throw new Error('invalid user id');
}

function lockFor(uid: string): Mutex {
  let lock = locks.get(uid);
  if (!lock) {
    lock = new Mutex();
    locks.set(uid, lock);
  }
  return lock;
}

function assertExternalId(value: string, field: string): string {
  const result = value.trim();
  if (!result || result.length > 512 || result.includes('\0')) throw new Error(`invalid ${field}`);
  return result;
}

export function bindingKey(instanceId: string, externalChatId: string): string {
  if (!safeId(instanceId)) throw new Error('invalid messaging instance id');
  return `${instanceId}:${encodeURIComponent(assertExternalId(externalChatId, 'external chat id'))}`;
}

async function readBindings(uid: string): Promise<MessagingBindingsFile> {
  assertUserId(uid);
  const raw = await readJson<Partial<MessagingBindingsFile>>(userMessagingBindingsFile(uid));
  if (raw.version !== 1 || !raw.bindings || typeof raw.bindings !== 'object') return { ...EMPTY };
  const bindings: Record<string, MessagingBinding> = {};
  for (const [key, value] of Object.entries(raw.bindings)) {
    const item = value as MessagingBinding;
    if (!item || typeof item.cid !== 'string' || !safeId(item.cid) || typeof item.instanceId !== 'string' || !safeId(item.instanceId)) continue;
    if (typeof item.externalChatId !== 'string' || !item.externalChatId.trim()) continue;
    bindings[key] = {
      key,
      instanceId: item.instanceId,
      externalChatId: item.externalChatId,
      ...(typeof item.externalChatTitle === 'string' && item.externalChatTitle ? { externalChatTitle: item.externalChatTitle.slice(0, 240) } : {}),
      cid: item.cid,
      ...(typeof item.projectId === 'string' && safeId(item.projectId) ? { projectId: item.projectId } : {}),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : nowIso(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
    };
  }
  return { version: 1, bindings };
}

async function writeBindings(uid: string, data: MessagingBindingsFile): Promise<void> {
  assertUserId(uid);
  await writeJson(userMessagingBindingsFile(uid), data);
}

export async function getBinding(uid: string, instanceId: string, externalChatId: string): Promise<MessagingBinding | null> {
  assertUserId(uid);
  const key = bindingKey(instanceId, externalChatId);
  const data = await readBindings(uid);
  return data.bindings[key] ? { ...data.bindings[key] } : null;
}

export async function listBindings(uid: string): Promise<MessagingBinding[]> {
  assertUserId(uid);
  const data = await readBindings(uid);
  return Object.values(data.bindings).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

export async function resolveOrCreateBinding(
  uid: string,
  instance: MessagingInstance,
  envelope: InboundEnvelope,
): Promise<MessagingBinding> {
  assertUserId(uid);
  const key = bindingKey(instance.id, envelope.externalChatId);
  return lockFor(uid).runExclusive(async () => {
    const data = await readBindings(uid);
    let projectId: string | undefined;
    if (instance.workspace.type === 'project') {
      const configuredProjectId = instance.workspace.projectId;
      if (!configuredProjectId || !safeId(configuredProjectId) || !await projects.projectExists(uid, configuredProjectId)) {
        throw new Error('messaging workspace project not found');
      }
      projectId = configuredProjectId;
    }
    const existing = data.bindings[key];
    if (existing && existing.projectId === projectId) {
      existing.updatedAt = nowIso();
      if (envelope.externalChatTitle) existing.externalChatTitle = envelope.externalChatTitle.slice(0, 240);
      await writeBindings(uid, data);
      return { ...existing };
    }
    if (existing) {
      delete data.bindings[key];
      await writeBindings(uid, data);
    }
    const chatLabel = envelope.externalChatTitle?.trim() || envelope.externalChatId;
    const title = `${instance.displayName} · ${chatLabel}`.slice(0, 120);
    const conversation = await chats.createConversation(uid, {
      title,
      ...(projectId ? { projectId } : {}),
    });
    const now = nowIso();
    const binding: MessagingBinding = {
      key,
      instanceId: instance.id,
      externalChatId: envelope.externalChatId,
      ...(envelope.externalChatTitle ? { externalChatTitle: envelope.externalChatTitle.slice(0, 240) } : {}),
      cid: conversation.conversation_id,
      ...(projectId ? { projectId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    data.bindings[key] = binding;
    await writeBindings(uid, data);
    return { ...binding };
  });
}

export async function removeBindingsForInstance(uid: string, instanceId: string): Promise<number> {
  assertUserId(uid);
  if (!safeId(instanceId)) throw new Error('invalid messaging instance id');
  return lockFor(uid).runExclusive(async () => {
    const data = await readBindings(uid);
    let removed = 0;
    for (const [key, binding] of Object.entries(data.bindings)) {
      if (binding.instanceId === instanceId) {
        delete data.bindings[key];
        removed += 1;
      }
    }
    if (removed) await writeBindings(uid, data);
    return removed;
  });
}

export const _bindingsTestHooks = { bindingKey, readBindings };
