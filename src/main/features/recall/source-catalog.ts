import { createHash } from 'node:crypto';

import { safeId } from '../../storage';
import * as chatArtifacts from '../chat_artifacts';
import * as chats from '../chats';
import { listInstances } from '../connectors';
import { isConnectorUsable, type ConnectorStatus } from '../connectors/types';
import { listContextsTreeForUser, type ContextNode } from '../contexts';
import * as executionRecords from '../execution-records';
import type { GroupMessage } from '../group_chat/visibility';
import { isRecallAssistantMessage, isRecallConversationMessage } from './conversation-message-policy';
import {
  clearCognitionSourceFailure,
  listCognitionSourceControls,
  markCognitionSourceFailure,
  pauseCognitionSource as pauseSourceControl,
  previewCognitionSourceRemoval as previewSourceRemoval,
  reconnectCognitionSource as reconnectSourceControl,
  removeCognitionSource as removeSourceControl,
  resumeCognitionSource as resumeSourceControl,
  type CognitionSourceAvailability,
  type CognitionSourceControlRecord,
  type CognitionSourceRemovalImpact,
  type RemoveCognitionSourceResult,
} from './source-control';
import {
  COGNITION_SOURCE_TYPES,
  cognitionSourceRefKey,
  normalizeCognitionSourceRef,
  type CognitionSourceInput,
  type CognitionSourceRef,
  type CognitionSourceType,
} from './source-service';
import { listUserTeachingSignals } from './teaching-service';

export const COGNITION_CATALOG_KINDS = COGNITION_SOURCE_TYPES;

export type CognitionCatalogKind = CognitionSourceType;
export type CognitionSourceLifecycleStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'paused';
export type CognitionSourceGroupStatus = CognitionSourceLifecycleStatus | 'empty';
export type CognitionSourceAction = 'pause' | 'resume' | 'retry' | 'remove' | 'reconnect' | 'manage_connector';
export type CognitionSourceNextAction = 'wait' | 'use_source' | 'retry' | 'resume' | 'reconnect' | 'manage_connector' | 'none';

export interface ListCognitionSourcesQuery {
  kinds?: CognitionCatalogKind[];
  conversationId?: string;
  limit?: number;
}

export interface CognitionCatalogSource extends CognitionSourceRef {
  kind: CognitionCatalogKind;
  status: CognitionSourceLifecycleStatus;
  availability: CognitionSourceAvailability;
  /** Session-only preflight used by the manual capture picker. */
  captureReady?: boolean;
  statusReason?: string;
  actions: CognitionSourceAction[];
  nextAction: CognitionSourceNextAction;
}

export interface CognitionSourceGroup {
  kind: CognitionCatalogKind;
  status: CognitionSourceGroupStatus;
  count: number;
  statusCounts: Record<CognitionSourceLifecycleStatus, number>;
  items: CognitionCatalogSource[];
  reason?: string;
}

interface DiscoveredSource extends CognitionSourceRef {
  kind: CognitionCatalogKind;
  status: CognitionSourceLifecycleStatus;
  captureReady?: boolean;
  statusReason?: string;
}

interface SourceAdapterQuery {
  limit: number;
  conversationId?: string;
  disabledConversationIds?: ReadonlySet<string>;
}

type SourceAdapter = (
  userId: string,
  query: SourceAdapterQuery,
) => Promise<DiscoveredSource[]>;

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
  return `${prefix}-${digest}`;
}

function sourceRef(input: CognitionSourceInput): CognitionSourceRef & { kind: CognitionCatalogKind } {
  const ref = normalizeCognitionSourceRef(input);
  if (!ref || ref.taxonomyVersion !== 2 || !COGNITION_SOURCE_TYPES.includes(ref.kind as CognitionCatalogKind)) {
    throw new Error('invalid cognition source metadata');
  }
  return ref as CognitionSourceRef & { kind: CognitionCatalogKind };
}

function discovered(
  input: CognitionSourceInput,
  status: CognitionSourceLifecycleStatus = 'ready',
  statusReason?: string,
): DiscoveredSource {
  return { ...sourceRef(input), status, ...(statusReason ? { statusReason } : {}) };
}

export function cognitionMessageSourceId(conversationId: string, messageId: string): string {
  return stableId('msg', conversationId, messageId);
}

export function cognitionArtifactSourceId(conversationId: string, artifactId: string): string {
  return stableId('art', conversationId, artifactId);
}

export function cognitionContextFileSourceId(relativePath: string): string {
  return stableId('ctx', relativePath);
}

export function cognitionConnectorSourceId(instanceId: string): string {
  return stableId('ext', instanceId);
}

export function cognitionEvaluationSourceId(executionId: string): string {
  return stableId('eval', executionId);
}

function usefulMessage(message: GroupMessage): boolean {
  return isRecallConversationMessage(message);
}

async function selectedConversations(
  userId: string,
  conversationId: string | undefined,
): Promise<chats.Conversation[]> {
  if (conversationId) {
    const conversation = await chats.getConversation(userId, conversationId);
    return conversation ? [conversation] : [];
  }
  return (await chats.listConversations(userId))
    .filter((conversation) => !conversation.deleted_at)
    .sort((left, right) => (
      right.last_active_at || right.updated_at
    ).localeCompare(left.last_active_at || left.updated_at));
}

async function loadRecentMessages(
  userId: string,
  conversationId: string | undefined,
  limit: number,
  disabledConversationIds: ReadonlySet<string> = new Set(),
): Promise<Array<{ conversation: chats.Conversation; message: GroupMessage }>> {
  const conversations = await selectedConversations(userId, conversationId);
  const rows: Array<{ conversation: chats.Conversation; message: GroupMessage }> = [];
  for (const conversation of conversations) {
    if (disabledConversationIds.has(conversation.conversation_id)) continue;
    const remaining = limit - rows.length;
    if (remaining <= 0) break;
    const fetchLimit = Math.min(2_000, Math.max(50, remaining * 4));
    const messages = await chats.getMessages(userId, conversation.conversation_id, fetchLimit);
    for (const message of messages.filter(usefulMessage).slice(-remaining)) {
      rows.push({ conversation, message });
    }
  }
  return rows.sort((left, right) => right.message.ts.localeCompare(left.message.ts)).slice(0, limit);
}

function conversationStatus(conversation: chats.Conversation): Pick<DiscoveredSource, 'status' | 'statusReason'> {
  return conversation.processing
    ? { status: 'processing', statusReason: 'conversation_processing' }
    : { status: 'ready' };
}

/** A manual capture must never offer an unfinished conversation as runnable.
 * Keep this as a small metadata preflight: message bodies are not returned in
 * the catalog, and the capture service still performs the authoritative check
 * immediately before creating a task. */
async function conversationCaptureReadiness(userId: string, conversationId: string): Promise<boolean | undefined> {
  try {
    const readinessFrom = (input: GroupMessage[]): boolean | undefined => {
      const messages = input
        .filter(usefulMessage)
        .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
      let lastUserIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].from === 'user') {
          lastUserIndex = index;
          break;
        }
      }
      if (lastUserIndex < 0) return undefined;
      return messages.slice(lastUserIndex + 1).some(isRecallAssistantMessage);
    };
    const recent = await chats.getMessages(userId, conversationId, 50);
    const recentReadiness = readinessFrom(recent);
    if (recentReadiness !== undefined) return recentReadiness;
    const messages = (await chats.getMessages(userId, conversationId, 2_000))
      .filter(usefulMessage)
      .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
    return readinessFrom(messages) ?? false;
  } catch {
    // An unreadable source remains actionable through the normal source error
    // path; do not claim that it is complete based on missing data.
    return undefined;
  }
}

async function conversationSources(userId: string, query: Parameters<SourceAdapter>[1]): Promise<DiscoveredSource[]> {
  const conversations = await selectedConversations(userId, query.conversationId);
  const sessions = await Promise.all(conversations.slice(0, query.limit).map(async (conversation) => {
    const status = conversationStatus(conversation);
    const source = discovered({
      kind: 'conversation',
      subtype: 'session',
      scope: 'conversation',
      id: conversation.conversation_id,
      title: conversation.title,
      sourceVersion: conversation.updated_at,
    }, status.status, status.statusReason);
    const captureReady = conversation.processing || query.disabledConversationIds?.has(conversation.conversation_id)
      ? undefined
      : await conversationCaptureReadiness(userId, conversation.conversation_id);
    return captureReady === undefined ? source : { ...source, captureReady };
  }));
  if (sessions.length >= query.limit) return sessions;
  const messages = await loadRecentMessages(
    userId,
    query.conversationId,
    query.limit - sessions.length,
    query.disabledConversationIds,
  );
  return [
    ...sessions,
    ...messages.map(({ conversation, message }) => discovered({
      kind: 'conversation',
      subtype: 'message',
      scope: 'conversation',
      id: cognitionMessageSourceId(conversation.conversation_id, message.id),
      sourceVersion: message.ts,
    }, conversationStatus(conversation).status, conversationStatus(conversation).statusReason)),
  ];
}

async function contextFilesForUser(userId: string): Promise<ContextNode[]> {
  const files: ContextNode[] = [];
  const visit = (nodes: ContextNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'file') files.push(node);
      if (node.children?.length) visit(node.children);
    }
  };
  visit(await listContextsTreeForUser(userId));
  return files;
}

async function contextFileStatuses(userId: string): Promise<Map<string, { status: CognitionSourceLifecycleStatus; reason?: string }>> {
  try {
    const kb = await import('../kb_vector');
    return new Map(kb.listFiles(userId).map((row) => [row.rel_path, {
      status: row.status === 'processing' ? 'processing'
        : row.status === 'failed' ? 'failed'
          : row.status === 'ready' ? 'ready'
            : 'pending',
      ...(row.status === 'failed' ? { reason: 'file_index_failed' } : {}),
    }]));
  } catch {
    return new Map();
  }
}

async function artifactFileSources(userId: string, query: Parameters<SourceAdapter>[1]): Promise<DiscoveredSource[]> {
  const files = await contextFilesForUser(userId);
  const statuses = await contextFileStatuses(userId);
  const contexts = files.slice(0, query.limit).map((node) => {
    const lifecycle = statuses.get(node.path) || { status: 'pending' as const, reason: 'file_index_pending' };
    return discovered({
      kind: 'artifact_file',
      subtype: 'context_file',
      scope: 'personal',
      id: cognitionContextFileSourceId(node.path),
      title: node.name,
      sourceVersion: String(node.mtime),
    }, lifecycle.status, lifecycle.reason);
  });
  if (contexts.length >= query.limit) return contexts;

  const rows = await loadRecentMessages(
    userId,
    query.conversationId,
    Math.min(2_000, Math.max(100, (query.limit - contexts.length) * 20)),
    query.disabledConversationIds,
  );
  const items = [...contexts];
  const seen = new Set(items.map((item) => item.id));
  for (const { conversation, message } of rows) {
    for (const artifact of message.artifacts || []) {
      const sourceConversationId = artifact.source_cid || conversation.conversation_id;
      const id = cognitionArtifactSourceId(sourceConversationId, artifact.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = chatArtifacts.readArtifactMeta(userId, sourceConversationId, artifact.id);
      items.push(discovered({
        kind: 'artifact_file',
        subtype: 'artifact',
        scope: 'conversation',
        id,
        title: meta?.title || artifact.title || 'Artifact',
        sourceVersion: message.ts,
      }));
      if (items.length >= query.limit) return items;
    }
  }
  return items;
}

function executionLifecycle(status: executionRecords.ExecutionStatus): { status: CognitionSourceLifecycleStatus; reason?: string } {
  if (status === 'queued') return { status: 'pending', reason: 'execution_queued' };
  if (status === 'running') return { status: 'processing', reason: 'execution_running' };
  if (status === 'completed') return { status: 'ready' };
  return { status: 'failed', reason: `execution_${status}` };
}

function connectorLifecycle(status: ConnectorStatus): { status: CognitionSourceLifecycleStatus; reason?: string } {
  if (status.kind === 'connected') return { status: 'ready' };
  if (status.kind === 'connecting') return { status: 'processing', reason: 'connector_connecting' };
  if (status.kind === 'disconnected') return { status: 'paused', reason: 'connector_disconnected' };
  return { status: 'failed', reason: status.kind === 'degraded' ? 'connector_degraded' : 'connector_error' };
}

const adapters: Record<CognitionCatalogKind, SourceAdapter> = {
  conversation: conversationSources,
  artifact_file: artifactFileSources,
  execution_evaluation: async (userId, query) => (await executionRecords.list(userId))
    .filter((record) => !query.conversationId || record.conversationId === query.conversationId)
    .flatMap((record) => {
      const lifecycle = record.boundary === 'degraded'
        ? { status: 'failed' as const, reason: 'degraded_execution' }
        : executionLifecycle(record.status);
      return [
        discovered({
          kind: 'execution_evaluation',
          subtype: 'execution',
          scope: record.conversationId ? 'conversation' : 'personal',
          id: record.executionId,
          sourceVersion: record.updatedAt,
        }, lifecycle.status, lifecycle.reason),
        ...(record.status === 'completed' || record.receiptId || record.resultRef ? [discovered({
          kind: 'execution_evaluation',
          subtype: 'evaluation',
          scope: record.conversationId ? 'conversation' : 'personal',
          id: cognitionEvaluationSourceId(record.executionId),
          sourceVersion: record.completedAt || record.updatedAt,
        }, lifecycle.status, lifecycle.reason)] : []),
      ];
    })
    .slice(0, query.limit),
  user_teaching_signal: async (userId, query) => (await listUserTeachingSignals(userId, {
    ...(query.conversationId ? { conversationId: query.conversationId } : {}),
    limit: query.limit,
  })).map((signal) => discovered({
    kind: 'user_teaching_signal',
    subtype: 'teaching',
    scope: signal.scope,
    id: signal.id,
    sourceVersion: signal.revokedAt || signal.createdAt,
  }, signal.status === 'revoked' ? 'paused' : 'ready', signal.status === 'revoked' ? 'teaching_revoked' : undefined)),
  authorized_external_system: async (userId, query) => listInstances(userId)
    .slice(0, query.limit)
    .map((instance) => {
      const lifecycle = connectorLifecycle(instance.status);
      return discovered({
        kind: 'authorized_external_system',
        subtype: 'connector_record',
        scope: 'external',
        id: cognitionConnectorSourceId(instance.id),
        title: instance.display_name || instance.id,
        sourceVersion: String(instance.tools_cached_at || 0),
        ...(isConnectorUsable(instance.status) ? { authorizationRef: stableId('auth', instance.id) } : {}),
      }, lifecycle.status, lifecycle.reason);
    }),
};

function controlSourceRef(control: CognitionSourceControlRecord): CognitionSourceRef & { kind: CognitionCatalogKind } {
  return sourceRef({
    kind: control.kind,
    id: control.sourceId,
    subtype: control.subtype,
    scope: control.scope,
    title: control.title,
    sourceVersion: control.sourceVersion,
  });
}

function sourceActions(
  source: DiscoveredSource,
  control: CognitionSourceControlRecord | undefined,
): Pick<CognitionCatalogSource, 'availability' | 'status' | 'statusReason' | 'actions' | 'nextAction'> {
  if (control?.availability === 'removed') {
    return {
      availability: 'removed',
      status: 'paused',
      statusReason: control.lastErrorCode || 'source_removed',
      actions: ['reconnect'],
      nextAction: 'reconnect',
    };
  }
  if (control?.availability === 'paused') {
    return {
      availability: 'paused',
      status: 'paused',
      statusReason: control.lastErrorCode || 'source_paused',
      actions: ['resume', 'remove'],
      nextAction: 'resume',
    };
  }
  const status = control?.lastErrorCode ? 'failed' : source.status;
  const statusReason = control?.lastErrorCode || source.statusReason;
  const connectorActions: CognitionSourceAction[] = source.kind === 'authorized_external_system'
    ? ['manage_connector']
    : [];
  const supportsRetry = source.kind === 'artifact_file' && source.subtype === 'context_file';
  const actions: CognitionSourceAction[] = status === 'failed'
    ? [...connectorActions, ...(supportsRetry ? ['retry' as const] : []), 'remove']
    : status === 'processing'
      ? [...connectorActions, 'pause', 'remove']
      : status === 'pending'
        ? [...connectorActions, 'pause', ...(supportsRetry ? ['retry' as const] : []), 'remove']
        : status === 'paused' && source.kind === 'authorized_external_system'
          ? ['manage_connector', 'remove']
          : [...connectorActions, 'pause', 'remove'];
  const nextAction: CognitionSourceNextAction = status === 'failed'
    ? source.kind === 'authorized_external_system' ? 'manage_connector' : supportsRetry ? 'retry' : 'none'
    : status === 'processing' || status === 'pending' ? 'wait'
      : status === 'paused' && source.kind === 'authorized_external_system' ? 'manage_connector'
        : 'use_source';
  return {
    availability: 'active',
    status,
    ...(statusReason ? { statusReason } : {}),
    actions: [...new Set(actions)],
    nextAction,
  };
}

function emptyStatusCounts(): Record<CognitionSourceLifecycleStatus, number> {
  return { pending: 0, processing: 0, ready: 0, failed: 0, paused: 0 };
}

function groupStatus(items: CognitionCatalogSource[]): CognitionSourceGroupStatus {
  if (!items.length) return 'empty';
  if (items.some((item) => item.status === 'failed')) return 'failed';
  if (items.some((item) => item.status === 'processing')) return 'processing';
  if (items.some((item) => item.status === 'pending')) return 'pending';
  if (items.every((item) => item.status === 'paused')) return 'paused';
  return 'ready';
}

async function discoverSelectedSources(
  userId: string,
  kind: CognitionCatalogKind,
  query: SourceAdapterQuery,
): Promise<DiscoveredSource[]> {
  const items = await adapters[kind](userId, query);
  const unique = new Map<string, DiscoveredSource>();
  for (const item of items) unique.set(cognitionSourceRefKey(item), item);
  return [...unique.values()];
}

export async function listCognitionSources(
  userId: string,
  query: ListCognitionSourcesQuery = {},
): Promise<CognitionSourceGroup[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 25)));
  if (query.conversationId !== undefined && !safeId(query.conversationId)) {
    throw new Error('invalid conversation id');
  }
  const kinds = query.kinds?.length ? query.kinds : [...COGNITION_CATALOG_KINDS];
  const selected = [...new Set(kinds)];
  if (selected.some((kind) => !COGNITION_CATALOG_KINDS.includes(kind))) {
    throw new Error('invalid cognition source kind');
  }
  const controls = await listCognitionSourceControls(userId);
  const controlsByKey = new Map(controls.map((control) => [
    cognitionSourceRefKey({ kind: control.kind, id: control.sourceId }),
    control,
  ]));
  const disabledConversationIds = new Set(controls
    .filter((control) => control.kind === 'conversation' && control.availability !== 'active')
    .map((control) => control.sourceId));

  return Promise.all(selected.map(async (kind): Promise<CognitionSourceGroup> => {
    try {
      const discoveredItems = await discoverSelectedSources(userId, kind, {
        limit,
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        disabledConversationIds,
      });
      if (!query.conversationId) {
        const discoveredKeys = new Set(discoveredItems.map(cognitionSourceRefKey));
        for (const control of controls.filter((item) => item.kind === kind && item.availability === 'removed')) {
          const ref = controlSourceRef(control);
          if (!discoveredKeys.has(cognitionSourceRefKey(ref))) {
            discoveredItems.push({ ...ref, status: 'paused', statusReason: 'source_removed' });
          }
        }
      }
      const items = discoveredItems.slice(0, limit).map((source): CognitionCatalogSource => ({
        ...source,
        ...sourceActions(source, controlsByKey.get(cognitionSourceRefKey(source))),
      }));
      const statusCounts = emptyStatusCounts();
      for (const item of items) statusCounts[item.status] += 1;
      return {
        kind,
        status: groupStatus(items),
        count: items.length,
        statusCounts,
        items,
      };
    } catch {
      return {
        kind,
        status: 'failed',
        count: 0,
        statusCounts: { ...emptyStatusCounts(), failed: 1 },
        items: [],
        reason: 'source_unavailable',
      };
    }
  }));
}

/**
 * **存在性**查询：这个 kind + id 是不是一个真实来源。
 *
 * 与 `listCognitionSources` 职责分开，这一点是有意的：
 *  - `listCognitionSources` 回答「给用户看哪些可选来源」，所以它有展示窗口
 *    （limit 上限 100），而且窗口是在 adapter **内部**生效的
 *    （`conversations.slice(0, query.limit)`、`files.slice(0, query.limit)`）。
 *  - 这里回答「这一条到底存不存在」，**不能有窗口**。拿列表窗口当存在性判据，
 *    来源超过窗口时合法的第 101 条会被判成不存在——把展示分页伪装成真实性结论。
 *
 * 所以这里按 kind 全量枚举后精确匹配 id，不设上限。多数来源 id 是单向哈希
 * （`stableId('msg', conversationId, messageId)`），无法从 id 反解出原始键，
 * 因此没有比枚举更精确的做法；真要做到 O(1) 得先给来源建索引，那是另一件事。
 *
 * 另外：有控制记录（暂停/移除过）的来源一律算存在——它确实存在过，只是当前
 * 不可用。可用性由 `isCognitionSourceEnabled` 另行判断，两个问题不要混。
 */
export async function cognitionExistingSourceIds(
  userId: string,
  kind: CognitionCatalogKind,
  sourceIds: readonly string[],
): Promise<Set<string>> {
  const wanted = new Set(sourceIds.filter((id) => safeId(id)));
  const found = new Set<string>();
  if (!COGNITION_CATALOG_KINDS.includes(kind) || !wanted.size) return found;
  const controls = await listCognitionSourceControls(userId);
  for (const control of controls) {
    if (control.kind === kind && wanted.has(control.sourceId)) found.add(control.sourceId);
  }
  // 控制记录已经答完的就不必再枚举了——这是"尽早返回"的第一档。
  if (found.size === wanted.size) return found;
  const disabledConversationIds = new Set(controls
    .filter((control) => control.kind === 'conversation' && control.availability !== 'active')
    .map((control) => control.sourceId));
  try {
    // **一个 kind 只枚举一次**，把这一批 id 一起判掉。逐条调用会让一次
    // candidate update 新增 N 条同类引用时全量扫 N 遍。
    const items = await discoverSelectedSources(userId, kind, {
      limit: Number.MAX_SAFE_INTEGER,
      disabledConversationIds,
    });
    for (const item of items) {
      if (wanted.has(item.id)) {
        found.add(item.id);
        if (found.size === wanted.size) break;   // 这一批都齐了，不必扫完
      }
    }
  } catch {
    // 来源不可读时不要武断说"不存在"——那会把一次读故障变成一条永久拒绝。
    // 调用方按"无法确认"处理（当前是放行已有引用、拒绝新增）。
  }
  return found;
}

/** 单条形态。内部走同一条批量实现，不另写一份判据。 */
export async function cognitionSourceExists(
  userId: string,
  kind: CognitionCatalogKind,
  sourceId: string,
): Promise<boolean> {
  return (await cognitionExistingSourceIds(userId, kind, [sourceId])).has(sourceId);
}

async function resolveCognitionSource(
  userId: string,
  kind: CognitionCatalogKind,
  sourceId: string,
): Promise<CognitionSourceRef & { kind: CognitionCatalogKind }> {
  if (!COGNITION_CATALOG_KINDS.includes(kind) || !safeId(sourceId)) throw new Error('invalid cognition source');
  const controls = await listCognitionSourceControls(userId);
  const disabledConversationIds = new Set(controls
    .filter((control) => control.kind === 'conversation' && control.availability !== 'active')
    .map((control) => control.sourceId));
  const items = await discoverSelectedSources(userId, kind, { limit: 100, disabledConversationIds });
  const discoveredSource = items.find((item) => item.id === sourceId);
  if (discoveredSource) return discoveredSource;
  const control = controls.find((item) => item.kind === kind && item.sourceId === sourceId);
  if (control) return controlSourceRef(control);
  throw new Error('cognition source not found');
}

export async function pauseCognitionSource(userId: string, kind: CognitionCatalogKind, sourceId: string): Promise<CognitionSourceControlRecord> {
  return pauseSourceControl(userId, await resolveCognitionSource(userId, kind, sourceId));
}

export async function resumeCognitionSource(userId: string, kind: CognitionCatalogKind, sourceId: string): Promise<CognitionSourceControlRecord> {
  return resumeSourceControl(userId, await resolveCognitionSource(userId, kind, sourceId));
}

export async function reconnectCognitionSource(userId: string, kind: CognitionCatalogKind, sourceId: string): Promise<CognitionSourceControlRecord> {
  return reconnectSourceControl(userId, await resolveCognitionSource(userId, kind, sourceId));
}

export async function removeCognitionSource(
  userId: string,
  kind: CognitionCatalogKind,
  sourceId: string,
  revokeAssets: boolean,
): Promise<RemoveCognitionSourceResult> {
  return removeSourceControl(userId, await resolveCognitionSource(userId, kind, sourceId), revokeAssets);
}

/**
 * Write a source tombstone from a durable reference when the backing object
 * has already been deleted. The catalog resolver intentionally only discovers
 * live objects, so deletion workflows must use this narrow path after a
 * successful delete rather than guessing from a now-missing source.
 */
export async function removeCognitionSourceRef(
  userId: string,
  source: CognitionSourceInput,
  revokeAssets: boolean,
): Promise<RemoveCognitionSourceResult> {
  return removeSourceControl(userId, sourceRef(source), revokeAssets);
}

export async function previewCognitionSourceRemoval(
  userId: string,
  kind: CognitionCatalogKind,
  sourceId: string,
): Promise<CognitionSourceRemovalImpact> {
  return previewSourceRemoval(userId, await resolveCognitionSource(userId, kind, sourceId));
}

export async function retryCognitionSource(userId: string, kind: CognitionCatalogKind, sourceId: string): Promise<CognitionSourceControlRecord> {
  const source = await resolveCognitionSource(userId, kind, sourceId);
  if (source.kind !== 'artifact_file' || source.subtype !== 'context_file') {
    throw new Error('cognition source retry is not supported');
  }
  try {
    const node = (await contextFilesForUser(userId)).find((file) => cognitionContextFileSourceId(file.path) === source.id);
    if (!node) throw new Error('source_missing');
    const indexer = await import('../kb_indexer');
    indexer.enqueue(userId, node.path, 'upsert', { reason: 'manual' });
    return await clearCognitionSourceFailure(userId, source);
  } catch {
    await markCognitionSourceFailure(userId, source, 'source_retry_failed');
    throw new Error('cognition source retry failed');
  }
}
