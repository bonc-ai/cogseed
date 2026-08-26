import { Mutex } from 'async-mutex';

import { nowIso, readJson, safeId, writeJson } from '../../storage';
import { userMessagingBindingsFile } from '../../paths';
import { t } from '../../i18n';
import * as chats from '../chats';
import * as spaces from '../spaces';
import type { InboundEnvelope, MessagingBinding, MessagingBindingsFile, MessagingInstance } from './types';

const EMPTY: MessagingBindingsFile = { version: 1, bindings: {} };
const locks = new Map<string, Mutex>();

type ConversationScope = MessagingBinding['conversationScope'];

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

function legacyBindingKey(instanceId: string, externalChatId: string): string {
  if (!safeId(instanceId)) throw new Error('invalid messaging instance id');
  return `${instanceId}:${encodeURIComponent(assertExternalId(externalChatId, 'external chat id'))}`;
}

/**
 * Versioned keys make group routing include the sender identity. The old key
 * format intentionally remains readable only for direct-message migration;
 * using it for a group would reintroduce cross-user conversation sharing.
 */
export function bindingKey(
  instanceId: string,
  externalChatId: string,
  externalUserId?: string,
  isGroup = false,
): string {
  if (!safeId(instanceId)) throw new Error('invalid messaging instance id');
  const chatId = encodeURIComponent(assertExternalId(externalChatId, 'external chat id'));
  if (!isGroup) return `v2:${instanceId}:direct:${chatId}`;
  const userId = encodeURIComponent(assertExternalId(externalUserId || '', 'external user id'));
  return `v2:${instanceId}:group_sender:${chatId}:${userId}`;
}

function scopeForEnvelope(envelope: InboundEnvelope): Exclude<ConversationScope, 'legacy'> {
  return envelope.isGroup ? 'group_sender' : 'direct';
}

function keyForEnvelope(instanceId: string, envelope: InboundEnvelope): string {
  return bindingKey(instanceId, envelope.externalChatId, envelope.externalUserId, envelope.isGroup);
}

function boundedOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  if (!result || result.length > max || result.includes('\0')) return undefined;
  return result;
}

function normalizeScope(value: unknown): ConversationScope {
  if (value === 'direct' || value === 'group_sender') return value;
  return 'legacy';
}

function normalizeBinding(key: string, value: unknown): MessagingBinding | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<MessagingBinding>;
  if (typeof item.cid !== 'string' || !safeId(item.cid)
    || typeof item.instanceId !== 'string' || !safeId(item.instanceId)) return null;
  const externalChatId = boundedOptionalText(item.externalChatId, 512);
  if (!externalChatId) return null;
  const conversationScope = normalizeScope(item.conversationScope);
  const externalUserId = boundedOptionalText(item.externalUserId, 512);
  if (conversationScope === 'group_sender' && !externalUserId) return null;
  return {
    key,
    instanceId: item.instanceId,
    conversationScope,
    externalChatId,
    ...(externalUserId ? { externalUserId } : {}),
    ...(boundedOptionalText(item.externalChatTitle, 240) ? { externalChatTitle: boundedOptionalText(item.externalChatTitle, 240) } : {}),
    ...(boundedOptionalText(item.externalUserName, 240) ? { externalUserName: boundedOptionalText(item.externalUserName, 240) } : {}),
    cid: item.cid,
    ...(typeof item.spaceId === 'string' && safeId(item.spaceId) ? { spaceId: item.spaceId } : {}),
    ...(typeof item.projectId === 'string' && safeId(item.projectId) ? { projectId: item.projectId } : {}),
    ...(boundedOptionalText(item.replyToMessageId, 512) ? { replyToMessageId: boundedOptionalText(item.replyToMessageId, 512) } : {}),
    ...(boundedOptionalText(item.threadId, 512) ? { threadId: boundedOptionalText(item.threadId, 512) } : {}),
    ...(item.replyInThread === true ? { replyInThread: true } : {}),
    ...(boundedOptionalText(item.contextTokenRef, 512) ? { contextTokenRef: boundedOptionalText(item.contextTokenRef, 512) } : {}),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : nowIso(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
  };
}

async function readBindings(uid: string): Promise<MessagingBindingsFile> {
  assertUserId(uid);
  const raw = await readJson<Partial<MessagingBindingsFile>>(userMessagingBindingsFile(uid));
  if (raw.version !== 1 || !raw.bindings || typeof raw.bindings !== 'object') return { ...EMPTY };
  const bindings: Record<string, MessagingBinding> = {};
  for (const [key, value] of Object.entries(raw.bindings)) {
    const binding = normalizeBinding(key, value);
    if (binding) bindings[key] = binding;
  }
  return { version: 1, bindings };
}

async function writeBindings(uid: string, data: MessagingBindingsFile): Promise<void> {
  assertUserId(uid);
  await writeJson(userMessagingBindingsFile(uid), data);
}

function replyContextFromEnvelope(envelope: InboundEnvelope): Pick<MessagingBinding, 'replyToMessageId' | 'threadId' | 'replyInThread' | 'contextTokenRef'> {
  const replyToMessageId = boundedOptionalText(envelope.replyToMessageId, 512);
  const threadId = boundedOptionalText(envelope.threadId, 512);
  const contextTokenRef = boundedOptionalText(envelope.contextTokenRef, 512);
  return {
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(envelope.replyInThread === true ? { replyInThread: true } : {}),
    ...(contextTokenRef ? { contextTokenRef } : {}),
  };
}

function refreshBinding(binding: MessagingBinding, envelope: InboundEnvelope): MessagingBinding {
  const next: MessagingBinding = {
    ...binding,
    externalChatId: envelope.externalChatId,
    ...(envelope.externalUserId ? { externalUserId: envelope.externalUserId } : {}),
    ...(envelope.externalChatTitle ? { externalChatTitle: envelope.externalChatTitle.slice(0, 240) } : {}),
    ...(envelope.externalUserName ? { externalUserName: envelope.externalUserName.slice(0, 240) } : {}),
    ...replyContextFromEnvelope(envelope),
    updatedAt: nowIso(),
  };
  if (!envelope.replyToMessageId) delete next.replyToMessageId;
  if (!envelope.threadId) delete next.threadId;
  if (envelope.replyInThread !== true) delete next.replyInThread;
  if (!envelope.contextTokenRef) delete next.contextTokenRef;
  return next;
}

/** Human-facing conversation title for a messaging binding. Direct chats
 *  label with the peer's display name (Feishu p2p carries no chat title, so
 *  the sender's resolved name is the only human-readable handle); group
 *  chats keep chat title + sender. Never leaks the raw external chat id
 *  (oc_…/ou_…) as the user-visible label. */
export function conversationTitleForEnvelope(
  instance: MessagingInstance,
  envelope: InboundEnvelope,
): string {
  const conversationScope = scopeForEnvelope(envelope);
  const chatLabel = conversationScope === 'group_sender'
    ? (envelope.externalChatTitle?.trim() || envelope.externalChatId)
    : (envelope.externalChatTitle?.trim() || envelope.externalUserName?.trim() || t('messaging.direct_chat'));
  const senderLabel = conversationScope === 'group_sender'
    ? (envelope.externalUserName?.trim() || envelope.externalUserId)
    : '';
  return [instance.displayName, chatLabel, senderLabel].filter(Boolean).join(' · ').slice(0, 120);
}

/** One-time upgrade for conversations whose title still shows the raw
 *  external chat id (created before name enrichment reached the title
 *  builder), or the name-less fallback form once a name becomes available.
 *  Manual renames always win; anything else re-derives the title from the
 *  enriched envelope. Best-effort: a failed read/write never blocks the
 *  inbound dispatch that called it. */
async function upgradeIdTitle(
  uid: string,
  instance: MessagingInstance,
  binding: MessagingBinding,
  envelope: InboundEnvelope,
): Promise<void> {
  try {
    if (!binding.externalChatId) return;
    const hasName = !!(envelope.externalUserName?.trim() || binding.externalUserName?.trim());
    if (!hasName) return;
    const conversation = await chats.getConversation(uid, binding.cid);
    if (!conversation || conversation.title_manually_set === true) return;
    const title = conversation.title || '';
    // Only rewrite titles that still embed the raw id or the name-less
    // fallback — enriched ones ("飞书 · 张三") and user renames stay.
    const idForm = title.includes(binding.externalChatId);
    const fallbackForm = binding.conversationScope !== 'group_sender'
      && title.endsWith(`· ${t('messaging.direct_chat')}`);
    if (!idForm && !fallbackForm) return;
    const labelEnvelope: InboundEnvelope = {
      ...envelope,
      externalChatTitle: envelope.externalChatTitle || binding.externalChatTitle,
      externalUserName: envelope.externalUserName || binding.externalUserName,
    };
    const nextTitle = conversationTitleForEnvelope(instance, labelEnvelope);
    if (!nextTitle || nextTitle === title) return;
    await chats.updateConversation(uid, binding.cid, { title: nextTitle });
  } catch {
    // Title upgrade is cosmetic; never let it break message delivery.
  }
}

async function spaceForWorkspace(uid: string, instance: MessagingInstance): Promise<string | undefined> {
  if (instance.workspace.type !== 'space') return undefined;
  const configuredSpaceId = instance.workspace.spaceId;
  if (!configuredSpaceId || !safeId(configuredSpaceId) || !await spaces.spaceExists(uid, configuredSpaceId)) {
    throw new Error('messaging workspace space not found');
  }
  return configuredSpaceId;
}

function sameWorkspaceId(binding: MessagingBinding, spaceId: string | undefined): boolean {
  // 兼容期：旧 binding 记录的是 projectId（T4.5 空间化前），按同一空间语义比较。
  // 新记录统一写 spaceId。
  if (spaceId) return binding.spaceId === spaceId || binding.projectId === spaceId;
  return !binding.spaceId && !binding.projectId;
}

export async function getBinding(
  uid: string,
  instanceId: string,
  externalChatId: string,
  externalUserId?: string,
  isGroup = false,
): Promise<MessagingBinding | null> {
  assertUserId(uid);
  const key = bindingKey(instanceId, externalChatId, externalUserId, isGroup);
  const data = await readBindings(uid);
  if (data.bindings[key]) return { ...data.bindings[key] };
  if (isGroup) return null;
  const legacy = data.bindings[legacyBindingKey(instanceId, externalChatId)];
  return legacy ? { ...legacy } : null;
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
  opts: { forceNew?: boolean } = {},
): Promise<MessagingBinding> {
  assertUserId(uid);
  const conversationScope = scopeForEnvelope(envelope);
  const key = keyForEnvelope(instance.id, envelope);
  return lockFor(uid).runExclusive(async () => {
    const data = await readBindings(uid);
    const spaceId = await spaceForWorkspace(uid, instance);
    const existing = data.bindings[key];
    // forceNew rotates the bound conversation (e.g. `/new`): the historical
    // cid keeps its message file, but new inbound goes to a fresh cid.
    if (existing && !opts.forceNew && sameWorkspaceId(existing, spaceId)) {
      const refreshed = refreshBinding(existing, envelope);
      data.bindings[key] = refreshed;
      await writeBindings(uid, data);
      await upgradeIdTitle(uid, instance, refreshed, envelope);
      return { ...refreshed };
    }
    if (existing) delete data.bindings[key];

    // Direct-message bindings can safely retain their historical conversation.
    // Group bindings never consult the old chat-only key, because it could
    // belong to another sender in that group.
    if (conversationScope === 'direct') {
      const oldKey = legacyBindingKey(instance.id, envelope.externalChatId);
      const legacy = data.bindings[oldKey];
      if (legacy && legacy.conversationScope === 'legacy' && sameWorkspaceId(legacy, spaceId)) {
        const migrated: MessagingBinding = {
          ...refreshBinding(legacy, envelope),
          key,
          conversationScope: 'direct',
        };
        delete data.bindings[oldKey];
        data.bindings[key] = migrated;
        await writeBindings(uid, data);
        return { ...migrated };
      }
      if (legacy && legacy.conversationScope === 'legacy') delete data.bindings[oldKey];
    }

    const title = conversationTitleForEnvelope(instance, envelope);
    const conversation = await chats.createConversation(uid, {
      title,
      ...(spaceId ? { spaceId } : {}),
      channelPlatform: instance.platform,
    });
    const now = nowIso();
    const binding: MessagingBinding = {
      key,
      instanceId: instance.id,
      conversationScope,
      externalChatId: envelope.externalChatId,
      ...(envelope.externalUserId ? { externalUserId: envelope.externalUserId } : {}),
      ...(envelope.externalChatTitle ? { externalChatTitle: envelope.externalChatTitle.slice(0, 240) } : {}),
      ...(envelope.externalUserName ? { externalUserName: envelope.externalUserName.slice(0, 240) } : {}),
      cid: conversation.conversation_id,
      ...(spaceId ? { spaceId } : {}),
      ...replyContextFromEnvelope(envelope),
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

export const _bindingsTestHooks = { bindingKey, legacyBindingKey, readBindings };
