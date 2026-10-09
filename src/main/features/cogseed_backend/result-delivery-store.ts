// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { nowIso, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import {
  assertCogSeedAgentId,
  assertCogSeedConversationId,
  assertCogSeedSessionId,
  assertCogSeedTaskId,
  assertCogSeedUserId,
  cogseedPendingResultDeliveriesDirectory,
  cogseedPendingResultDeliveryFile,
  cogseedUndeliverableResultFile,
} from './paths';
import type { CogSeedProjectionEvent } from './group-chat-projection';

const RESULT_DELIVERY_SCHEMA_VERSION = 2 as const;
const LEGACY_RESULT_DELIVERY_SCHEMA_VERSION = 1 as const;
const UNDELIVERABLE_RESULT_SCHEMA_VERSION = 1 as const;
const MAX_PENDING_PAYLOAD_CHARS = 5_000_000;
const MAX_REASON_CHARS = 120;

export type CogSeedTerminalProjectionEvent = CogSeedProjectionEvent & {
  type: 'task.completed' | 'task.failed';
};

interface CogSeedPendingResultDeliveryBase {
  ownerId: string;
  taskId: string;
  executionId: string;
  conversationId: string;
  agentId: string;
  sessionId: string;
  event: CogSeedTerminalProjectionEvent;
  createdAt: string;
  updatedAt: string;
}

export interface CogSeedPendingResultDeliveryV1 extends CogSeedPendingResultDeliveryBase {
  schemaVersion: typeof LEGACY_RESULT_DELIVERY_SCHEMA_VERSION;
}

export interface CogSeedPendingResultDelivery extends CogSeedPendingResultDeliveryBase {
  schemaVersion: typeof RESULT_DELIVERY_SCHEMA_VERSION;
  destinationGeneration: string;
}

export type CogSeedReadablePendingResultDelivery =
  | CogSeedPendingResultDeliveryV1
  | CogSeedPendingResultDelivery;

type CogSeedPendingResultDeliveryInput = Omit<
  CogSeedPendingResultDelivery,
  'schemaVersion' | 'ownerId' | 'createdAt' | 'updatedAt'
>;

export interface CogSeedPendingResultFile {
  fileName: string;
  executionId: string | null;
}

export interface CogSeedUndeliverableResultArchive {
  schemaVersion: typeof UNDELIVERABLE_RESULT_SCHEMA_VERSION;
  ownerId: string;
  archiveId: string;
  sourceFileName: string;
  executionId?: string;
  reason: string;
  quarantinedAt: string;
  payload?: unknown;
  rawPayload?: string;
}

export interface CogSeedResultDeliveryStore {
  save(userId: string, input: CogSeedPendingResultDeliveryInput): Promise<CogSeedPendingResultDelivery>;
  read(userId: string, executionId: string): Promise<CogSeedReadablePendingResultDelivery | null>;
  remove(userId: string, executionId: string): Promise<void>;
  removePendingFile(userId: string, fileName: string): Promise<void>;
  listPendingFiles(userId: string): Promise<CogSeedPendingResultFile[]>;
  quarantine(userId: string, fileName: string, reason: string): Promise<CogSeedUndeliverableResultArchive>;
  clearForConversation(userId: string, conversationId: string): Promise<void>;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function assertExecutionId(executionId: string): string {
  if (!/^cogseed-exec-[A-Za-z0-9_-]+$/.test(executionId)) throw new Error('invalid CogSeed execution id');
  return executionId;
}

function assertDestinationGeneration(value: string): string {
  if (!/^cogseed-generation-[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('invalid CogSeed destination generation');
  }
  return value;
}

function assertReason(value: string): string {
  if (!value || value.length > MAX_REASON_CHARS || !/^[a-z0-9-]+$/.test(value)) {
    throw new Error('invalid CogSeed undeliverable result reason');
  }
  return value;
}

function validateEvent(value: unknown): CogSeedTerminalProjectionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed pending result delivery');
  const event = value as Record<string, unknown>;
  if (typeof event.eventId !== 'string' || !/^cogseed-event-[A-Za-z0-9_-]+$/.test(event.eventId)
    || (event.type !== 'task.completed' && event.type !== 'task.failed')
    || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new Error('malformed CogSeed pending result delivery');
  }
  const encoded = JSON.stringify(event.payload);
  if (encoded.length > MAX_PENDING_PAYLOAD_CHARS) throw new Error('CogSeed pending result exceeds limit');
  return JSON.parse(JSON.stringify(event)) as CogSeedTerminalProjectionEvent;
}

function validateRecord(
  userId: string,
  executionId: string,
  value: unknown,
): CogSeedReadablePendingResultDelivery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed pending result delivery');
  const row = value as Record<string, unknown>;
  if ((row.schemaVersion !== RESULT_DELIVERY_SCHEMA_VERSION && row.schemaVersion !== LEGACY_RESULT_DELIVERY_SCHEMA_VERSION)
    || row.ownerId !== userId || row.executionId !== executionId
    || typeof row.taskId !== 'string' || typeof row.conversationId !== 'string' || typeof row.agentId !== 'string'
    || typeof row.sessionId !== 'string' || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') {
    throw new Error('malformed CogSeed pending result delivery');
  }
  assertCogSeedTaskId(row.taskId);
  assertCogSeedConversationId(row.conversationId);
  assertCogSeedAgentId(row.agentId);
  assertCogSeedSessionId(row.sessionId);
  const event = validateEvent(row.event);
  if (row.schemaVersion === RESULT_DELIVERY_SCHEMA_VERSION) {
    if (typeof row.destinationGeneration !== 'string') throw new Error('malformed CogSeed pending result delivery');
    assertDestinationGeneration(row.destinationGeneration);
    return { ...(row as unknown as CogSeedPendingResultDelivery), event };
  }
  return { ...(row as unknown as CogSeedPendingResultDeliveryV1), event };
}

function validateInput(
  executionId: string,
  input: CogSeedPendingResultDeliveryInput,
): CogSeedPendingResultDeliveryInput {
  return {
    taskId: assertCogSeedTaskId(input.taskId),
    executionId,
    conversationId: assertCogSeedConversationId(input.conversationId),
    agentId: assertCogSeedAgentId(input.agentId),
    sessionId: assertCogSeedSessionId(input.sessionId),
    destinationGeneration: assertDestinationGeneration(input.destinationGeneration),
    event: validateEvent(input.event),
  };
}

function isSameDelivery(
  prior: CogSeedReadablePendingResultDelivery,
  input: CogSeedPendingResultDeliveryInput,
): boolean {
  return prior.schemaVersion === RESULT_DELIVERY_SCHEMA_VERSION
    && prior.taskId === input.taskId
    && prior.executionId === input.executionId
    && prior.conversationId === input.conversationId
    && prior.agentId === input.agentId
    && prior.sessionId === input.sessionId
    && prior.destinationGeneration === input.destinationGeneration
    && isDeepStrictEqual(prior.event, input.event);
}

function mutationLock(userId: string) {
  return fileEditLock(cogseedPendingResultDeliveriesDirectory(userId));
}

async function readUnlocked(userId: string, executionId: string): Promise<CogSeedReadablePendingResultDelivery | null> {
  try {
    return validateRecord(
      userId,
      executionId,
      JSON.parse(await fs.readFile(cogseedPendingResultDeliveryFile(userId, executionId), 'utf8')),
    );
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed pending result delivery');
    throw error;
  }
}

async function removeUnlocked(userId: string, executionId: string): Promise<void> {
  try {
    await fs.unlink(cogseedPendingResultDeliveryFile(userId, executionId));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

function archiveIdFor(fileName: string, executionId: string | null): string {
  return executionId || `malformed-${createHash('sha256').update(fileName).digest('hex').slice(0, 24)}`;
}

async function readExistingArchive(userId: string, archiveId: string): Promise<CogSeedUndeliverableResultArchive | null> {
  try {
    return JSON.parse(await fs.readFile(cogseedUndeliverableResultFile(userId, archiveId), 'utf8')) as CogSeedUndeliverableResultArchive;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export const cogseedResultDeliveryStore: CogSeedResultDeliveryStore = {
  async save(userId, input) {
    assertCogSeedUserId(userId);
    const executionId = assertExecutionId(input.executionId);
    const validatedInput = validateInput(executionId, input);
    return mutationLock(userId).runExclusive(async () => {
      if (await readExistingArchive(userId, executionId)) {
        throw new Error('CogSeed result delivery is already closed');
      }
      const prior = await readUnlocked(userId, executionId);
      if (prior) {
        if (!isSameDelivery(prior, validatedInput)) {
          throw new Error('conflicting CogSeed pending result delivery');
        }
        return prior as CogSeedPendingResultDelivery;
      }
      const timestamp = nowIso();
      const record = validateRecord(userId, executionId, {
        schemaVersion: RESULT_DELIVERY_SCHEMA_VERSION,
        ownerId: userId,
        ...validatedInput,
        createdAt: timestamp,
        updatedAt: timestamp,
      }) as CogSeedPendingResultDelivery;
      await writeJson(cogseedPendingResultDeliveryFile(userId, executionId), record);
      return record;
    });
  },

  async read(userId, executionId) {
    assertCogSeedUserId(userId);
    return readUnlocked(userId, assertExecutionId(executionId));
  },

  async remove(userId, executionId) {
    assertCogSeedUserId(userId);
    const id = assertExecutionId(executionId);
    await mutationLock(userId).runExclusive(() => removeUnlocked(userId, id));
  },

  async removePendingFile(userId, fileName) {
    assertCogSeedUserId(userId);
    if (!fileName.endsWith('.json') || fileName.includes('/') || fileName.includes('\\')) {
      throw new Error('invalid CogSeed pending result filename');
    }
    await mutationLock(userId).runExclusive(async () => {
      try {
        await fs.unlink(path.join(cogseedPendingResultDeliveriesDirectory(userId), fileName));
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
    });
  },

  async listPendingFiles(userId) {
    assertCogSeedUserId(userId);
    let names: string[];
    try {
      names = await fs.readdir(cogseedPendingResultDeliveriesDirectory(userId));
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((fileName) => {
        const match = /^(cogseed-exec-[A-Za-z0-9_-]+)\.json$/.exec(fileName);
        return { fileName, executionId: match?.[1] ?? null };
      });
  },

  async quarantine(userId, fileName, reason) {
    assertCogSeedUserId(userId);
    const safeReason = assertReason(reason);
    if (!fileName.endsWith('.json') || fileName.includes('/') || fileName.includes('\\')) {
      throw new Error('invalid CogSeed pending result filename');
    }
    return mutationLock(userId).runExclusive(async () => {
      const match = /^(cogseed-exec-[A-Za-z0-9_-]+)\.json$/.exec(fileName);
      const executionId = match?.[1] ?? null;
      const archiveId = archiveIdFor(fileName, executionId);
      const existing = await readExistingArchive(userId, archiveId);
      if (existing) return existing;
      const raw = await fs.readFile(path.join(cogseedPendingResultDeliveriesDirectory(userId), fileName), 'utf8');
      let payload: unknown;
      let parsed = false;
      try {
        payload = JSON.parse(raw);
        parsed = true;
      } catch { /* preserve malformed input verbatim */ }
      const archive: CogSeedUndeliverableResultArchive = {
        schemaVersion: UNDELIVERABLE_RESULT_SCHEMA_VERSION,
        ownerId: userId,
        archiveId,
        sourceFileName: fileName,
        ...(executionId ? { executionId } : {}),
        reason: safeReason,
        quarantinedAt: nowIso(),
        ...(parsed ? { payload } : { rawPayload: raw }),
      };
      await writeJson(cogseedUndeliverableResultFile(userId, archiveId), archive);
      return archive;
    });
  },

  async clearForConversation(userId, conversationId) {
    assertCogSeedUserId(userId);
    const safeConversationId = assertCogSeedConversationId(conversationId);
    await mutationLock(userId).runExclusive(async () => {
      let names: string[];
      try {
        names = await fs.readdir(cogseedPendingResultDeliveriesDirectory(userId));
      } catch (error) {
        if (isEnoent(error)) return;
        throw error;
      }
      for (const name of names) {
        const match = /^(cogseed-exec-[A-Za-z0-9_-]+)\.json$/.exec(name);
        if (!match) continue;
        const record = await readUnlocked(userId, match[1]);
        if (record?.conversationId === safeConversationId) await removeUnlocked(userId, match[1]);
      }
    });
  },
};
