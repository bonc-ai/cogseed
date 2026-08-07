import { createHash } from 'node:crypto';

import { safeId } from '../../storage';
import * as chatArtifacts from '../chat_artifacts';
import * as chats from '../chats';
import { listInstances } from '../connectors';
import { isConnectorUsable } from '../connectors/types';
import { listContextsTreeForUser, type ContextNode } from '../contexts';
import * as executionRecords from '../execution-records';
import type { GroupMessage } from '../group_chat/visibility';
import {
  COGNITION_SOURCE_TYPES,
  normalizeCognitionSourceRef,
  type CognitionSourceInput,
  type CognitionSourceRef,
  type CognitionSourceType,
} from './source-service';
import { listUserTeachingSignals } from './teaching-service';

export const COGNITION_CATALOG_KINDS = COGNITION_SOURCE_TYPES;

export type CognitionCatalogKind = CognitionSourceType;
export type CognitionSourceGroupStatus = 'ready' | 'empty' | 'degraded';

export interface ListCognitionSourcesQuery {
  kinds?: CognitionCatalogKind[];
  conversationId?: string;
  limit?: number;
}

export interface CognitionSourceGroup {
  kind: CognitionCatalogKind;
  status: CognitionSourceGroupStatus;
  count: number;
  items: CognitionSourceRef[];
  reason?: string;
}

type SourceAdapter = (
  userId: string,
  query: Required<Pick<ListCognitionSourcesQuery, 'limit'>> & Pick<ListCognitionSourcesQuery, 'conversationId'>,
) => Promise<CognitionSourceRef[]>;

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
  return `${prefix}-${digest}`;
}

function sourceRef(input: CognitionSourceInput): CognitionSourceRef {
  const ref = normalizeCognitionSourceRef(input);
  if (!ref) throw new Error('invalid cognition source metadata');
  return ref;
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

export function cognitionEvaluationSourceId(executionId: string): string {
  return stableId('eval', executionId);
}

function usefulMessage(message: GroupMessage): boolean {
  return !message.deleted_at
    && !message.dispatch
    && !message.system_kind
    && !message.failure_kind
    && typeof message.text === 'string'
    && Boolean(message.text.trim());
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
): Promise<Array<{ conversation: chats.Conversation; message: GroupMessage }>> {
  const conversations = await selectedConversations(userId, conversationId);
  const rows: Array<{ conversation: chats.Conversation; message: GroupMessage }> = [];
  for (const conversation of conversations) {
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

async function conversationSources(userId: string, query: Parameters<SourceAdapter>[1]): Promise<CognitionSourceRef[]> {
  const conversations = await selectedConversations(userId, query.conversationId);
  const sessions = conversations.slice(0, query.limit).map((conversation) => sourceRef({
    kind: 'conversation',
    subtype: 'session',
    scope: 'conversation',
    id: conversation.conversation_id,
    title: conversation.title,
    sourceVersion: conversation.updated_at,
  }));
  if (sessions.length >= query.limit) return sessions;
  const messages = await loadRecentMessages(userId, query.conversationId, query.limit - sessions.length);
  return [
    ...sessions,
    ...messages.map(({ conversation, message }) => sourceRef({
      kind: 'conversation',
      subtype: 'message',
      scope: 'conversation',
      id: cognitionMessageSourceId(conversation.conversation_id, message.id),
      sourceVersion: message.ts,
    })),
  ];
}

async function artifactFileSources(userId: string, query: Parameters<SourceAdapter>[1]): Promise<CognitionSourceRef[]> {
  const files: ContextNode[] = [];
  const visit = (nodes: ContextNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'file') files.push(node);
      if (node.children?.length) visit(node.children);
    }
  };
  visit(listContextsTreeForUser(userId));
  const contexts = files.slice(0, query.limit).map((node) => sourceRef({
    kind: 'artifact_file',
    subtype: 'context_file',
    scope: 'personal',
    id: cognitionContextFileSourceId(node.path),
    title: node.name,
    sourceVersion: String(node.mtime),
  }));
  if (contexts.length >= query.limit) return contexts;

  const rows = await loadRecentMessages(
    userId,
    query.conversationId,
    Math.min(2_000, Math.max(100, (query.limit - contexts.length) * 20)),
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
      items.push(sourceRef({
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

const adapters: Record<CognitionCatalogKind, SourceAdapter> = {
  conversation: conversationSources,
  artifact_file: artifactFileSources,
  execution_evaluation: async (userId, query) => (await executionRecords.list(userId))
    .filter((record) => !query.conversationId || record.conversationId === query.conversationId)
    .flatMap((record) => [
      sourceRef({
        kind: 'execution_evaluation',
        subtype: 'execution',
        scope: record.conversationId ? 'conversation' : 'personal',
        id: record.executionId,
        sourceVersion: record.updatedAt,
        ...(record.boundary === 'degraded' ? { degraded: true, reason: 'degraded_execution' } : {}),
      }),
      ...(record.status === 'completed' || record.receiptId || record.resultRef ? [sourceRef({
        kind: 'execution_evaluation',
        subtype: 'evaluation',
        scope: record.conversationId ? 'conversation' : 'personal',
        id: cognitionEvaluationSourceId(record.executionId),
        sourceVersion: record.completedAt || record.updatedAt,
        ...(record.boundary === 'degraded' ? { degraded: true, reason: 'degraded_evaluation' } : {}),
      })] : []),
    ])
    .slice(0, query.limit),
  user_teaching_signal: async (userId, query) => (await listUserTeachingSignals(userId, {
    ...(query.conversationId ? { conversationId: query.conversationId } : {}),
    limit: query.limit,
  })).map((signal) => sourceRef({
    kind: 'user_teaching_signal',
    subtype: 'teaching',
    scope: signal.scope,
    id: signal.id,
    sourceVersion: signal.revokedAt || signal.createdAt,
    ...(signal.status === 'revoked' ? { degraded: true, reason: 'teaching_revoked' } : {}),
  })),
  authorized_external_system: async (userId, query) => listInstances(userId)
    .filter((instance) => isConnectorUsable(instance.status))
    .slice(0, query.limit)
    .map((instance) => sourceRef({
      kind: 'authorized_external_system',
      subtype: 'connector_record',
      scope: 'external',
      id: stableId('ext', instance.id),
      title: instance.display_name || instance.id,
      sourceVersion: String(instance.tools_cached_at || 0),
      authorizationRef: stableId('auth', instance.id),
      ...(instance.status.kind === 'degraded' ? { degraded: true, reason: 'connector_degraded' } : {}),
    })),
};

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

  return Promise.all(selected.map(async (kind): Promise<CognitionSourceGroup> => {
    try {
      const items = await adapters[kind](userId, {
        limit,
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      });
      return {
        kind,
        status: items.some((item) => item.degraded) ? 'degraded' : items.length ? 'ready' : 'empty',
        count: items.length,
        items,
        ...(items.some((item) => item.degraded) ? { reason: 'source_partially_degraded' } : {}),
      };
    } catch {
      return {
        kind,
        status: 'degraded',
        count: 0,
        items: [],
        reason: 'source_unavailable',
      };
    }
  }));
}
