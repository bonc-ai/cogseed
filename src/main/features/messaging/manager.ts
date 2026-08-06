import { Mutex } from 'async-mutex';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import * as groupChat from '../group_chat';
import { subscribe, type GroupEvent } from '../group_chat/bus';
import * as projects from '../projects';
import * as registry from './registry';
import * as bindings from './bindings';
import * as ledger from './ledger';
import { evaluateInboundPolicy, stripBotMention } from './policy';
import { createAdapter } from './adapters';
import type {
  AdapterCallbacks,
  InboundEnvelope,
  MessagingAdapter,
  MessagingInboundResult,
  MessagingInstance,
  MessagingInstanceClient,
  MessagingInstanceStatus,
  MessagingPlatformCatalogEntry,
  WorkspaceScope,
} from './types';

const log = createLogger('messaging:manager');

interface RuntimeInstance {
  instanceId: string;
  adapter: MessagingAdapter;
  controller: AbortController;
  started: Promise<void>;
  listeners: Map<string, () => void>;
  outboundDeliveries: Set<Promise<void>>;
  active: boolean;
  statusWrite: Promise<void>;
}

interface OutboundMessage {
  id?: string;
  from?: string;
  text?: string;
  dispatch?: boolean;
}

const runtimes = new Map<string, Map<string, RuntimeInstance>>();
const liveStatuses = new Map<string, Map<string, MessagingInstanceStatus>>();
const lifecycleLocks = new Map<string, Mutex>();

export const PLATFORM_CATALOG: readonly MessagingPlatformCatalogEntry[] = [
  {
    platform: 'telegram',
    displayName: 'Telegram',
    description: 'Telegram Bot API，支持双向对话和长轮询。',
    available: true,
    twoWay: true,
  },
  {
    platform: 'feishu_lark',
    displayName: '飞书 / Lark',
    description: '飞书开放平台事件订阅，支持双向对话。',
    available: true,
    twoWay: true,
  },
  {
    platform: 'wechat_personal',
    displayName: '个人微信',
    description: '官方双向机器人能力不可用，暂不提供登录或扫码。',
    available: false,
    twoWay: false,
  },
  {
    platform: 'wecom',
    displayName: '企业微信',
    description: '企业微信智能机器人官方扫码创建，使用 WebSocket 长连接双向对话。',
    available: true,
    twoWay: true,
  },
];

function assertUserId(uid: string): void {
  if (!safeId(uid)) throw new Error('invalid user id');
}

function assertInstanceId(instanceId: string): void {
  if (!registry.isValidInstanceId(instanceId)) throw new Error('invalid messaging instance id');
}

function runtimeMap(uid: string): Map<string, RuntimeInstance> {
  let map = runtimes.get(uid);
  if (!map) {
    map = new Map();
    runtimes.set(uid, map);
  }
  return map;
}

function lifecycleLock(uid: string, instanceId: string): Mutex {
  const key = `${uid}:${instanceId}`;
  let lock = lifecycleLocks.get(key);
  if (!lock) {
    lock = new Mutex();
    lifecycleLocks.set(key, lock);
  }
  return lock;
}

async function withLifecycle<T>(uid: string, instanceId: string, operation: () => Promise<T>): Promise<T> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  return lifecycleLock(uid, instanceId).runExclusive(operation);
}

function cloneStatus(status: MessagingInstanceStatus): MessagingInstanceStatus {
  return {
    kind: status.kind,
    checkedAt: status.checkedAt,
    ...(status.message ? { message: status.message } : {}),
    ...(status.connectedAt ? { connectedAt: status.connectedAt } : {}),
  };
}

function setLiveStatus(uid: string, instanceId: string, status: MessagingInstanceStatus): void {
  let statuses = liveStatuses.get(uid);
  if (!statuses) {
    statuses = new Map();
    liveStatuses.set(uid, statuses);
  }
  statuses.set(instanceId, cloneStatus(status));
}

function clearLiveStatus(uid: string, instanceId: string): void {
  const statuses = liveStatuses.get(uid);
  if (!statuses) return;
  statuses.delete(instanceId);
  if (!statuses.size) liveStatuses.delete(uid);
}

function isCurrentRuntime(uid: string, runtime: RuntimeInstance): boolean {
  return runtime.active && runtimes.get(uid)?.get(runtime.instanceId) === runtime;
}

function withLiveStatus(uid: string, instance: MessagingInstanceClient): MessagingInstanceClient {
  const runtime = runtimes.get(uid)?.get(instance.id);
  const live = runtime && runtime.active ? liveStatuses.get(uid)?.get(instance.id) : undefined;
  return {
    ...instance,
    status: live ? cloneStatus(live) : cloneStatus(instance.status),
  };
}

function queueRuntimeStatus(uid: string, runtime: RuntimeInstance, nextStatus: MessagingInstanceStatus): void {
  if (!isCurrentRuntime(uid, runtime)) return;
  const snapshot = cloneStatus(nextStatus);
  setLiveStatus(uid, runtime.instanceId, snapshot);
  runtime.statusWrite = runtime.statusWrite
    .then(async () => {
      if (!isCurrentRuntime(uid, runtime)) return;
      await registry.updateStatus(uid, runtime.instanceId, snapshot);
    })
    .catch((error) => {
      log.warn('messaging status persistence failed', {
        instanceId: runtime.instanceId,
        error: (error as Error).message,
      });
    });
}

function isMessageEvent(event: GroupEvent): event is Extract<GroupEvent, { type: 'message' }> {
  return event.type === 'message';
}

function messageFromEvent(event: Extract<GroupEvent, { type: 'message' }>): OutboundMessage {
  return event.msg as OutboundMessage;
}

async function deliverGroupMessage(
  uid: string,
  runtime: RuntimeInstance,
  instance: MessagingInstance,
  binding: { externalChatId: string },
  message: OutboundMessage,
): Promise<void> {
  if (!isCurrentRuntime(uid, runtime)) return;
  const sourceMessageId = typeof message.id === 'string' && message.id ? message.id : '';
  const text = typeof message.text === 'string' ? message.text.trim().slice(0, 12_000) : '';
  if (!sourceMessageId || !text || message.dispatch || message.from === 'user') return;
  const key = ledger.deliveryKey(instance.id, sourceMessageId);
  const begun = await ledger.beginDelivery(uid, {
    key,
    instanceId: instance.id,
    externalChatId: binding.externalChatId,
    sourceMessageId,
    textHash: ledger.textHash(text),
  });
  if (begun.duplicate) return;
  if (!isCurrentRuntime(uid, runtime) || runtime.controller.signal.aborted) {
    await ledger.finishDelivery(uid, key, {
      status: 'cancelled',
      error: 'delivery cancelled because messaging instance stopped',
    });
    return;
  }
  try {
    const receipt = await runtime.adapter.sendMessage(binding.externalChatId, text, runtime.controller.signal);
    await ledger.finishDelivery(uid, key, {
      status: 'sent',
      ...(receipt.deliveryId ? { externalDeliveryId: receipt.deliveryId } : {}),
    });
  } catch (error) {
    if (!isCurrentRuntime(uid, runtime) || runtime.controller.signal.aborted) {
      await ledger.finishDelivery(uid, key, {
        status: 'cancelled',
        error: 'delivery cancelled because messaging instance stopped',
      });
      return;
    }
    const messageText = (error as Error).message || 'delivery failed';
    await ledger.finishDelivery(uid, key, { status: 'failed', error: messageText });
    log.warn('messaging delivery failed', { instanceId: instance.id, sourceMessageId, error: messageText });
  }
}

function trackOutboundDelivery(
  uid: string,
  runtime: RuntimeInstance,
  instance: MessagingInstance,
  binding: { externalChatId: string },
  message: OutboundMessage,
): void {
  const delivery = deliverGroupMessage(uid, runtime, instance, binding, message);
  runtime.outboundDeliveries.add(delivery);
  void delivery.then(
    () => {
      runtime.outboundDeliveries.delete(delivery);
    },
    (error) => {
      runtime.outboundDeliveries.delete(delivery);
      log.warn('messaging delivery callback failed', {
        instanceId: instance.id,
        error: (error as Error).message,
      });
    },
  );
}

async function waitForOutboundDeliveries(runtime: RuntimeInstance): Promise<void> {
  // Listeners are removed before this wait starts, but loop defensively in
  // case a callback that was already queued registers its delivery first.
  while (runtime.outboundDeliveries.size) {
    await Promise.allSettled(Array.from(runtime.outboundDeliveries));
  }
}

async function attachBindingListener(
  uid: string,
  runtime: RuntimeInstance,
  instance: MessagingInstance,
  binding: { key: string; cid: string; externalChatId: string },
): Promise<void> {
  if (!isCurrentRuntime(uid, runtime) || runtime.listeners.has(binding.key)) return;
  const unsubscribe = subscribe(uid, binding.cid, (event: GroupEvent) => {
    if (!isCurrentRuntime(uid, runtime) || !isMessageEvent(event) || event.turn_end !== true) return;
    trackOutboundDelivery(uid, runtime, instance, binding, messageFromEvent(event));
  });
  runtime.listeners.set(binding.key, unsubscribe);
}

async function handleInbound(uid: string, envelope: InboundEnvelope): Promise<MessagingInboundResult> {
  assertUserId(uid);
  const loaded = await registry.getInstanceWithSecret(uid, envelope.instanceId);
  if (!loaded || loaded.instance.platform !== envelope.platform) {
    return { accepted: false, duplicate: false, reason: 'instance_not_found' };
  }
  const instance = loaded.instance;
  if (!instance.enabled) return { accepted: false, duplicate: false, reason: 'instance_disabled' };
  const key = ledger.inboundKey(instance.id, envelope.externalMessageId);
  const reservation = await ledger.reserveInbound(uid, key, envelope.receivedAt);
  if (reservation.duplicate) return { accepted: false, duplicate: true, cid: reservation.entry.cid };
  const decision = evaluateInboundPolicy(instance, envelope);
  if (!decision.allowed) {
    await ledger.completeInbound(uid, key, { status: 'rejected', reason: decision.reason || 'policy_rejected' });
    return { accepted: false, duplicate: false, reason: decision.reason };
  }
  const text = stripBotMention(envelope.text).slice(0, 12_000);
  if (!text) {
    await ledger.completeInbound(uid, key, { status: 'rejected', reason: 'empty_message' });
    return { accepted: false, duplicate: false, reason: 'empty_message' };
  }
  try {
    const binding = await bindings.resolveOrCreateBinding(uid, instance, envelope);
    const runtime = runtimes.get(uid)?.get(instance.id);
    if (runtime) await attachBindingListener(uid, runtime, instance, binding);
    const result = await groupChat.send({ userId: uid, cid: binding.cid, text });
    if (!result.ok) throw new Error(result.error || 'group chat enqueue failed');
    await ledger.completeInbound(uid, key, { status: 'accepted', cid: binding.cid });
    return { accepted: true, duplicate: false, cid: binding.cid };
  } catch (error) {
    const message = (error as Error).message || 'messaging inbound dispatch failed';
    await ledger.completeInbound(uid, key, { status: 'failed', reason: message });
    throw new Error(`messaging inbound dispatch failed: ${message}`);
  }
}

async function startRuntime(uid: string, instanceId: string): Promise<void> {
  const map = runtimeMap(uid);
  if (map.has(instanceId)) return;
  const loaded = await registry.getInstanceWithSecret(uid, instanceId);
  if (!loaded || !loaded.instance.enabled) {
    clearLiveStatus(uid, instanceId);
    return;
  }
  let adapter: MessagingAdapter;
  try {
    adapter = createAdapter(loaded.instance, loaded.secret);
  } catch (error) {
    const message = (error as Error).message || 'messaging adapter initialization failed';
    await registry.updateStatus(uid, instanceId, { kind: 'error', message, checkedAt: new Date().toISOString() });
    throw new Error(`messaging adapter initialization failed: ${message}`);
  }

  const runtime: RuntimeInstance = {
    instanceId,
    adapter,
    controller: new AbortController(),
    started: Promise.resolve(),
    listeners: new Map(),
    outboundDeliveries: new Set(),
    active: true,
    statusWrite: Promise.resolve(),
  };
  const callbacks: AdapterCallbacks = {
    onInbound: async (envelope) => {
      if (!isCurrentRuntime(uid, runtime)) return;
      await handleInbound(uid, envelope);
    },
    onStatus: async (nextStatus) => {
      queueRuntimeStatus(uid, runtime, nextStatus);
    },
  };

  map.set(instanceId, runtime);
  queueRuntimeStatus(uid, runtime, { kind: 'connecting', checkedAt: new Date().toISOString() });
  runtime.started = Promise.resolve()
    .then(() => adapter.start(runtime.controller.signal, callbacks))
    .catch(async (error) => {
      if (!isCurrentRuntime(uid, runtime)) return;
      const message = (error as Error).message || 'messaging adapter stopped unexpectedly';
      queueRuntimeStatus(uid, runtime, { kind: 'error', message, checkedAt: new Date().toISOString() });
      await runtime.statusWrite;
      log.warn('messaging runtime stopped unexpectedly', { instanceId, error: message });
    })
    .finally(async () => {
      await runtime.statusWrite;
      if (runtimes.get(uid)?.get(instanceId) === runtime) {
        runtimes.get(uid)?.delete(instanceId);
        if (!runtimes.get(uid)?.size) runtimes.delete(uid);
        clearLiveStatus(uid, instanceId);
      }
    });

  try {
    const existingBindings = await bindings.listBindings(uid);
    for (const binding of existingBindings) {
      if (binding.instanceId === instanceId) await attachBindingListener(uid, runtime, loaded.instance, binding);
    }
  } catch (error) {
    log.warn('messaging binding listener restore failed', {
      instanceId,
      error: (error as Error).message,
    });
  }
}

async function stopRuntime(uid: string, instanceId: string): Promise<void> {
  const map = runtimes.get(uid);
  const runtime = map?.get(instanceId);
  if (!runtime) {
    clearLiveStatus(uid, instanceId);
    return;
  }
  runtime.active = false;
  map?.delete(instanceId);
  if (!map?.size) runtimes.delete(uid);

  let stopFailure: Error | null = null;
  try {
    runtime.controller.abort();
    await runtime.adapter.stop();
  } catch (error) {
    stopFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    for (const unsubscribe of runtime.listeners.values()) {
      try {
        unsubscribe();
      } catch (error) {
        log.warn('messaging binding listener cleanup failed', {
          instanceId,
          error: (error as Error).message,
        });
      }
    }
    runtime.listeners.clear();
    try {
      await waitForOutboundDeliveries(runtime);
      await runtime.started;
      await runtime.statusWrite;
    } finally {
      clearLiveStatus(uid, instanceId);
    }
  }
  if (stopFailure) throw new Error(`messaging adapter stop failed: ${stopFailure.message}`);
}

async function startInstance(uid: string, instanceId: string): Promise<void> {
  await withLifecycle(uid, instanceId, () => startRuntime(uid, instanceId));
}

async function stopInstance(uid: string, instanceId: string): Promise<void> {
  await withLifecycle(uid, instanceId, () => stopRuntime(uid, instanceId));
}

function sameWorkspace(left: WorkspaceScope, right: WorkspaceScope): boolean {
  return left.type === right.type && left.projectId === right.projectId;
}

async function assertWorkspaceAvailable(uid: string, workspace: WorkspaceScope | undefined): Promise<void> {
  if (!workspace || workspace.type === 'default') return;
  if (!workspace.projectId || !safeId(workspace.projectId) || !await projects.projectExists(uid, workspace.projectId)) {
    throw new Error('messaging workspace project not found');
  }
}

async function existingClient(uid: string, instanceId: string): Promise<MessagingInstanceClient> {
  const instance = (await registry.listInstances(uid)).find((item) => item.id === instanceId);
  if (!instance) throw new Error('messaging instance not found');
  return withLiveStatus(uid, instance);
}

export async function createInstance(uid: string, input: registry.CreateMessagingInstanceInput): Promise<MessagingInstanceClient> {
  assertUserId(uid);
  await assertWorkspaceAvailable(uid, input.workspace);
  return registry.createInstance(uid, input);
}

export async function startForUser(uid: string): Promise<void> {
  assertUserId(uid);
  const instances = await registry.listInstances(uid);
  await Promise.all(instances.filter((instance) => instance.enabled).map((instance) => startInstance(uid, instance.id).catch((error) => {
    log.warn('messaging instance start failed', { instanceId: instance.id, error: (error as Error).message });
  })));
}

export async function stopForUser(uid: string): Promise<void> {
  assertUserId(uid);
  const instanceIds = Array.from(runtimes.get(uid)?.keys() || []);
  await Promise.all(instanceIds.map((instanceId) => stopInstance(uid, instanceId)));
  runtimes.delete(uid);
  liveStatuses.delete(uid);
}

export async function restartInstance(uid: string, instanceId: string): Promise<void> {
  await withLifecycle(uid, instanceId, async () => {
    const instance = await registry.getInstance(uid, instanceId);
    if (!instance) throw new Error('messaging instance not found');
    if (!(await registry.getInstanceWithSecret(uid, instanceId))) {
      throw new Error('messaging credentials required before restarting');
    }
    await stopRuntime(uid, instanceId);
    await startRuntime(uid, instanceId);
  });
}

export async function updateInstance(
  uid: string,
  instanceId: string,
  input: registry.UpdateMessagingInstanceInput,
): Promise<MessagingInstanceClient> {
  return withLifecycle(uid, instanceId, async () => {
    const current = await registry.getInstance(uid, instanceId);
    if (!current) throw new Error('messaging instance not found');
    await assertWorkspaceAvailable(uid, input.workspace);
    const nextEnabled = typeof input.enabled === 'boolean' ? input.enabled : current.enabled;
    const existingCredentials = await registry.getInstanceWithSecret(uid, instanceId);
    const willHaveCredentials = !input.clearSecret && (input.secret !== undefined || !!existingCredentials);
    if (nextEnabled && !willHaveCredentials) {
      throw new Error('messaging credentials required before enabling');
    }
    const workspaceChanged = !!input.workspace && !sameWorkspace(current.workspace, input.workspace);
    if (workspaceChanged) await bindings.removeBindingsForInstance(uid, instanceId);

    const updated = await registry.updateInstance(uid, instanceId, input);
    if (!nextEnabled) {
      if (current.enabled) {
        try {
          await stopRuntime(uid, instanceId);
        } finally {
          await registry.updateStatus(uid, instanceId, { kind: 'disabled', checkedAt: new Date().toISOString() });
        }
        return { ...updated, status: { kind: 'disabled', checkedAt: new Date().toISOString() } };
      }
      return withLiveStatus(uid, updated);
    }
    if (current.enabled) await stopRuntime(uid, instanceId);
    await startRuntime(uid, instanceId);
    return existingClient(uid, instanceId);
  });
}

export async function setEnabled(uid: string, instanceId: string, enabled: boolean): Promise<MessagingInstanceClient> {
  if (typeof enabled !== 'boolean') throw new Error('invalid enabled value');
  return updateInstance(uid, instanceId, { enabled });
}

export async function unbindInstance(uid: string, instanceId: string): Promise<MessagingInstanceClient> {
  return withLifecycle(uid, instanceId, async () => {
    const current = await registry.getInstance(uid, instanceId);
    if (!current) throw new Error('messaging instance not found');
    const client = await registry.updateInstance(uid, instanceId, { enabled: false, clearSecret: true });
    try {
      await stopRuntime(uid, instanceId);
    } finally {
      await registry.updateStatus(uid, instanceId, {
        kind: 'disconnected',
        checkedAt: new Date().toISOString(),
        message: 'credentials removed',
      });
    }
    return {
      ...client,
      status: { kind: 'disconnected', checkedAt: new Date().toISOString(), message: 'credentials removed' },
    };
  });
}

export async function deleteInstance(uid: string, instanceId: string): Promise<boolean> {
  return withLifecycle(uid, instanceId, async () => {
    const current = await registry.getInstance(uid, instanceId);
    if (current?.enabled) await registry.updateInstance(uid, instanceId, { enabled: false });
    try {
      await stopRuntime(uid, instanceId);
    } catch (error) {
      log.warn('messaging instance stopped with cleanup error during deletion', {
        instanceId,
        error: (error as Error).message,
      });
    }

    const results = await Promise.allSettled([
      bindings.removeBindingsForInstance(uid, instanceId),
      ledger.removeEntriesForInstance(uid, instanceId),
      registry.deleteInstance(uid, instanceId),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (failures.length) throw new Error(`messaging instance cleanup incomplete: ${failures.join('; ')}`);
    clearLiveStatus(uid, instanceId);
    return true;
  });
}

export async function listInstances(uid: string): Promise<MessagingInstanceClient[]> {
  assertUserId(uid);
  const instances = await registry.listInstances(uid);
  return instances.map((instance) => withLiveStatus(uid, instance));
}

export async function health(uid: string, instanceId: string): Promise<MessagingInstanceStatus> {
  return withLifecycle(uid, instanceId, async () => {
    const loaded = await registry.getInstanceWithSecret(uid, instanceId);
    if (!loaded) throw new Error('messaging credentials required before checking connection');
    const runtime = runtimes.get(uid)?.get(instanceId);
    const result = runtime && isCurrentRuntime(uid, runtime)
      ? await runtime.adapter.checkHealth()
      : await createAdapter(loaded.instance, loaded.secret).checkHealth();
    if (runtime && isCurrentRuntime(uid, runtime)) {
      queueRuntimeStatus(uid, runtime, result);
      await runtime.statusWrite;
    } else {
      await registry.updateStatus(uid, instanceId, result);
    }
    return cloneStatus(result);
  });
}

export async function ingestInbound(uid: string, envelope: InboundEnvelope): Promise<MessagingInboundResult> {
  assertUserId(uid);
  if (!envelope || typeof envelope !== 'object') throw new Error('invalid inbound envelope');
  if (!envelope.instanceId || !envelope.externalMessageId || !envelope.externalChatId || !envelope.externalUserId || !envelope.text) {
    throw new Error('inbound envelope missing required fields');
  }
  return handleInbound(uid, envelope);
}

export const _managerTestHooks = {
  runtimeMap,
  handleInbound,
  stopInstance,
  liveStatuses,
};
