import { getRecallCandidateCapabilities } from './candidate-capabilities';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { safeId } from '../../storage';
import {
  readRecallCandidate,
  rejectRecallCandidate,
  saveRecallCandidate,
} from './candidate-service';
import { removeCognitionSource } from './source-control';
import { recallJsonRecordPath } from './paths';
import { updateRecallJsonRecord, readRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';

const TEACHING_COLLECTION = 'teaching-signals';

export type UserTeachingIntent = 'remember' | 'prefer' | 'avoid' | 'correct';
export type UserTeachingScope = 'personal' | 'project' | 'agent';
export type UserTeachingStatus = 'active' | 'revoked';

export interface UserTeachingSignalRecord extends RecallJsonRecord {
  taxonomyVersion: 2;
  conversationId: string;
  messageId: string;
  intent: UserTeachingIntent;
  scope: UserTeachingScope;
  status: UserTeachingStatus;
  summary: string;
  memoryRef?: string;
  candidateIds: string[];
  createdAt: string;
  revokedAt?: string;
}

export interface RecordTeachingSignalInput {
  conversationId: string;
  messageId: string;
  userMessage: string;
  memoryContent: string;
  memoryScope: UserTeachingScope;
  memoryRef?: string;
}

function teachingDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, TEACHING_COLLECTION, 'placeholder'));
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
  return `${prefix}-${digest}`;
}

function compact(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`invalid teaching ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) throw new Error(`invalid teaching ${field}`);
  return text;
}

function requireSafeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !safeId(value)) throw new Error(`invalid teaching ${field}`);
  return value;
}

function requireIntent(value: unknown): UserTeachingIntent {
  if (value === 'remember' || value === 'prefer' || value === 'avoid' || value === 'correct') return value;
  throw new Error('invalid teaching intent');
}

function requireScope(value: unknown): UserTeachingScope {
  if (value === 'personal' || value === 'project' || value === 'agent') return value;
  throw new Error('invalid teaching scope');
}

function requireStatus(value: unknown): UserTeachingStatus {
  if (value === 'active' || value === 'revoked') return value;
  throw new Error('invalid teaching status');
}

function asTeachingSignal(value: RecallJsonRecord): UserTeachingSignalRecord {
  const conversationId = requireSafeId(value.conversationId, 'conversation id');
  const messageId = requireSafeId(value.messageId, 'message id');
  const intent = requireIntent(value.intent);
  const scope = requireScope(value.scope);
  const status = requireStatus(value.status);
  const summary = compact(value.summary, 'summary', 240);
  if (
    !Array.isArray(value.candidateIds)
    || value.candidateIds.some((id) => typeof id !== 'string' || !safeId(id))
    || typeof value.createdAt !== 'string'
    || (value.memoryRef !== undefined && (typeof value.memoryRef !== 'string' || !safeId(value.memoryRef)))
    || (value.revokedAt !== undefined && typeof value.revokedAt !== 'string')
  ) throw new Error('malformed teaching signal');
  return {
    ...value,
    taxonomyVersion: 2,
    conversationId,
    messageId,
    intent,
    scope,
    status,
    summary,
    candidateIds: [...new Set(value.candidateIds as string[])],
  } as UserTeachingSignalRecord;
}

export function classifyTeachingIntent(userMessage: string): UserTeachingIntent | undefined {
  const text = String(userMessage || '').trim();
  if (!text) return undefined;
  if (/纠正|更正|不是.{0,30}(?:而是|是)|\b(?:correct|correction|actually)\b|訂正|corrig/i.test(text)) return 'correct';
  if (/避免|不要再|别再|請勿|\b(?:avoid|do not|don't|never)\b|避け|não\s+(?:faça|use)/i.test(text)) return 'avoid';
  if (/偏好|更喜欢|我喜欢|\b(?:prefer|preference)\b|好み|prefir/i.test(text)) return 'prefer';
  if (/记住|記住|请记|請記|\bremember\b|覚えて|lembre/i.test(text)) return 'remember';
  return undefined;
}

export function teachingSignalId(input: Pick<RecordTeachingSignalInput, 'conversationId' | 'messageId' | 'memoryContent'> & { intent: UserTeachingIntent }): string {
  return stableId('teach', input.conversationId, input.messageId, input.intent, input.memoryContent.trim());
}

export function teachingMemoryRef(scope: string, content: string): string {
  return stableId('mem', scope, content.trim());
}

export async function recordTeachingSignalAfterMemoryWrite(
  userId: string,
  input: RecordTeachingSignalInput,
): Promise<UserTeachingSignalRecord | undefined> {
  const intent = classifyTeachingIntent(input.userMessage);
  if (!intent) return undefined;
  const conversationId = requireSafeId(input.conversationId, 'conversation id');
  const messageId = requireSafeId(input.messageId, 'message id');
  const memoryContent = compact(input.memoryContent, 'memory content', 4_000);
  const scope = requireScope(input.memoryScope);
  const memoryRef = input.memoryRef || teachingMemoryRef(scope, memoryContent);
  requireSafeId(memoryRef, 'memory ref');
  const id = teachingSignalId({ conversationId, messageId, memoryContent, intent });
  const summary = memoryContent.length <= 240 ? memoryContent : `${memoryContent.slice(0, 239)}…`;

  const candidate = await saveRecallCandidate(userId, {
    judgment: memoryContent,
    summary,
    suggestedType: intent === 'remember' ? 'personal' : 'rule',
    suggestedScope: scope,
    captureKey: `teaching-${id}`,
    sourceRefs: [
      { kind: 'conversation', id: conversationId, subtype: 'session', scope: 'conversation' },
      { kind: 'conversation', id: stableId('msg', conversationId, messageId), subtype: 'message', scope: 'conversation' },
      { kind: 'user_teaching_signal', id, subtype: 'teaching', scope },
    ],
  });
  const now = new Date().toISOString();
  const record: UserTeachingSignalRecord = {
    schemaVersion: 1,
    taxonomyVersion: 2,
    ownerId: userId,
    id,
    conversationId,
    messageId,
    intent,
    scope,
    status: 'active',
    summary,
    memoryRef,
    candidateIds: [candidate.id],
    createdAt: now,
  };
  return asTeachingSignal(await updateRecallJsonRecord(
    userId,
    TEACHING_COLLECTION,
    id,
    (current) => current || record,
  ));
}

export async function readUserTeachingSignal(userId: string, signalId: string): Promise<UserTeachingSignalRecord> {
  if (!safeId(signalId)) throw new Error('invalid teaching signal id');
  const record = await readRecallJsonRecord(userId, TEACHING_COLLECTION, signalId);
  if (!record) throw new Error('teaching signal not found');
  return asTeachingSignal(record);
}

export interface ListUserTeachingSignalsQuery {
  conversationId?: string;
  status?: UserTeachingStatus;
  limit?: number;
}

export interface UserTeachingSignalPage {
  items: UserTeachingSignalRecord[];
  /** 满足查询条件的**真实**条数，不受 limit 影响。
   *
   *  「待我处理」的「教学回执」指标此前取的是 `list(...).length`，而 list 的
   *  limit 默认 20、上限 100——超过 20 条时那个数字就是错的，且错得不可见。
   *  计数必须来自截断之前。 */
  total: number;
}

/** 读 + 过滤 + 排序，**不截断**。两个出口共用，避免 total 与 items 走两套过滤
 *  条件——那样 total 会和列表对不上，比没有 total 更难查。 */
async function readSortedTeachingSignals(
  userId: string,
  query: ListUserTeachingSignalsQuery,
): Promise<UserTeachingSignalRecord[]> {
  const conversationId = query.conversationId === undefined
    ? undefined
    : requireSafeId(query.conversationId, 'conversation id');
  const status = query.status === undefined ? undefined : requireStatus(query.status);
  let names: string[];
  try {
    names = await fs.readdir(teachingDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => readRecallJsonRecord(userId, TEACHING_COLLECTION, name.slice(0, -5))));
  return records
    .filter((record): record is RecallJsonRecord => Boolean(record))
    .map(asTeachingSignal)
    .filter((signal) => !conversationId || signal.conversationId === conversationId)
    .filter((signal) => !status || signal.status === status)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function listUserTeachingSignals(
  userId: string,
  query: ListUserTeachingSignalsQuery = {},
): Promise<UserTeachingSignalRecord[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 20)));
  return (await readSortedTeachingSignals(userId, query)).slice(0, limit);
}

/** 同一批数据的分页读口：`items` 受 limit 截断，`total` 不受。 */
export async function listUserTeachingSignalPage(
  userId: string,
  query: ListUserTeachingSignalsQuery = {},
): Promise<UserTeachingSignalPage> {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 20)));
  const all = await readSortedTeachingSignals(userId, query);
  return { items: all.slice(0, limit), total: all.length };
}

export async function revokeUserTeachingSignal(userId: string, signalId: string): Promise<UserTeachingSignalRecord> {
  if (!safeId(signalId)) throw new Error('invalid teaching signal id');
  const updated = asTeachingSignal(await updateRecallJsonRecord(userId, TEACHING_COLLECTION, signalId, (raw) => {
    if (!raw) throw new Error('teaching signal not found');
    const current = asTeachingSignal(raw);
    if (current.status === 'revoked') return current;
    return {
      ...current,
      status: 'revoked',
      revokedAt: new Date().toISOString(),
    };
  }));
  await Promise.all(updated.candidateIds.map(async (candidateId) => {
    try {
      const candidate = await readRecallCandidate(userId, candidateId);
      // 教学信号被撤回时，凡是用户还能拒绝的候选都一并拒绝——判据取 capability，
      // 否则 weak_observation 候选会被留在池子里，来源却已经没了。
      if (getRecallCandidateCapabilities(candidate).canReject) {
        await rejectRecallCandidate(userId, candidateId, 'teaching_signal_revoked');
      }
    } catch {
      // Revocation remains authoritative even if a legacy candidate is missing.
    }
  }));
  await removeCognitionSource(userId, {
    kind: 'user_teaching_signal',
    id: updated.id,
    taxonomyVersion: 2,
    subtype: 'teaching',
    scope: updated.scope,
    title: updated.summary,
  }, false);
  return updated;
}
