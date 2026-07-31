import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { userLocalRoot } from '../../paths';
import { safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize';

const MAX_ID_LENGTH = 160;
const MAX_REF_LENGTH = 512;
const MAX_REFS = 100;
const MAX_SCOPES = 32;
const PROMPT_VALUE_RE = /\b((?:system|user)?_?prompt)(\s*[:=]\s*)([^,;&\n]+)/gi;
const PERMISSION_TAG_RE = /^[A-Za-z0-9_.:/-]+$/;

export type ContextReuseReceiptStatus = 'prepared' | 'completed' | 'rejected' | 'degraded';
export type ContextReuseBoundary = 'real' | 'degraded' | 'test-double';

export interface ContextReuseReceipt {
  receiptId: string;
  executionId: string;
  sourceSessionId?: string;
  sourceContextId?: string;
  targetSessionId: string;
  targetContextId?: string;
  reusedRefs: string[];
  omittedRefs: string[];
  permissionMode: string;
  allowedScopes: string[];
  baselineExecutionId?: string;
  treatmentExecutionId?: string;
  status: ContextReuseReceiptStatus;
  boundary: ContextReuseBoundary;
  createdAt: string;
  completedAt?: string;
}

export interface PrepareContextReuseReceiptInput {
  receiptId?: string;
  executionId: string;
  sourceSessionId?: string;
  sourceContextId?: string;
  targetSessionId: string;
  targetContextId?: string;
  reusedRefs: string[];
  omittedRefs: string[];
  permissionMode: string;
  allowedScopes: string[];
  boundary: ContextReuseBoundary;
}

export interface ReceiptTargetExpectation {
  sessionId: string;
  contextId?: string;
}

export interface CompleteContextReuseReceiptInput {
  status: Exclude<ContextReuseReceiptStatus, 'prepared'>;
  baselineExecutionId?: string;
  treatmentExecutionId?: string;
  sourceSessionId?: string;
  sourceContextId?: string;
  targetSessionId?: string;
  targetContextId?: string;
  reusedRefs?: string[];
  omittedRefs?: string[];
  permissionMode?: string;
  allowedScopes?: string[];
}

function requireId(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_ID_LENGTH ||
    !safeId(value)
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireId(value, field);
}

function requireBoundary(value: unknown): ContextReuseBoundary {
  if (value === 'real' || value === 'degraded' || value === 'test-double') return value;
  throw new Error('invalid context reuse boundary');
}

function requirePermissionTag(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_ID_LENGTH ||
    !PERMISSION_TAG_RE.test(value)
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function requirePermissionMode(value: unknown): string {
  return requirePermissionTag(value, 'permission mode');
}

function requireCompletionStatus(
  value: unknown,
): Exclude<ContextReuseReceiptStatus, 'prepared'> {
  if (value === 'completed' || value === 'rejected' || value === 'degraded') return value;
  throw new Error('invalid completion status');
}

function redactReference(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid context reference');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REF_LENGTH) throw new Error('invalid context reference');
  return sanitizeLogTextForUpload(trimmed)
    .replace(PROMPT_VALUE_RE, (_match, field: string, separator: string) => (
      `${field}${separator}[REDACTED]`
    ));
}

function normalizeRefs(values: unknown, field: string): string[] {
  if (!Array.isArray(values) || values.length > MAX_REFS) throw new Error(`invalid ${field}`);
  return Array.from(new Set(values.map(redactReference)));
}

function normalizeScopes(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > MAX_SCOPES) {
    throw new Error('invalid allowed scopes');
  }
  return Array.from(new Set(values.map((value) => requirePermissionTag(value, 'allowed scope'))));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertTargetMatches(
  input: Pick<PrepareContextReuseReceiptInput, 'targetSessionId' | 'targetContextId'>,
  expected: ReceiptTargetExpectation,
): void {
  const expectedSessionId = requireId(expected.sessionId, 'expected target session id');
  const targetSessionId = requireId(input.targetSessionId, 'target session id');
  if (targetSessionId !== expectedSessionId) throw new Error('target session mismatch');

  const targetContextId = optionalId(input.targetContextId, 'target context id');
  const expectedContextId = optionalId(expected.contextId, 'expected target context id');
  if (targetContextId !== expectedContextId) throw new Error('target context mismatch');
}

export function contextReuseReceiptPath(userId: string, executionId: string): string {
  const safeExecutionId = requireId(executionId, 'execution id');
  return path.join(
    userLocalRoot(userId),
    'kstar',
    'executions',
    safeExecutionId,
    'context-reuse-receipt.json',
  );
}

function parseStoredReceipt(raw: string): ContextReuseReceipt {
  let receipt: unknown;
  try {
    receipt = JSON.parse(raw);
  } catch {
    throw new Error('context reuse receipt is malformed');
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('context reuse receipt is malformed');
  }
  const row = receipt as Partial<ContextReuseReceipt>;
  if (
    typeof row.receiptId !== 'string' ||
    typeof row.executionId !== 'string' ||
    typeof row.targetSessionId !== 'string' ||
    !Array.isArray(row.reusedRefs) ||
    !Array.isArray(row.omittedRefs) ||
    typeof row.permissionMode !== 'string' ||
    !Array.isArray(row.allowedScopes) ||
    typeof row.status !== 'string' ||
    typeof row.boundary !== 'string' ||
    typeof row.createdAt !== 'string'
  ) {
    throw new Error('context reuse receipt is malformed');
  }
  return row as ContextReuseReceipt;
}

export async function readReceipt(
  userId: string,
  executionId: string,
): Promise<ContextReuseReceipt> {
  const receiptPath = contextReuseReceiptPath(userId, executionId);
  try {
    return parseStoredReceipt(await fs.readFile(receiptPath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('context reuse receipt not found');
    }
    throw err;
  }
}

export async function prepareReceipt(
  userId: string,
  input: PrepareContextReuseReceiptInput,
  expectedTarget: ReceiptTargetExpectation,
): Promise<ContextReuseReceipt> {
  assertTargetMatches(input, expectedTarget);
  const executionId = requireId(input.executionId, 'execution id');
  const receiptPath = contextReuseReceiptPath(userId, executionId);

  return fileEditLock(receiptPath).runExclusive(async () => {
    try {
      await fs.access(receiptPath);
      throw new Error('context reuse receipt already exists');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const receipt: ContextReuseReceipt = {
      receiptId: input.receiptId
        ? requireId(input.receiptId, 'receipt id')
        : `receipt-${randomUUID()}`,
      executionId,
      ...(input.sourceSessionId
        ? { sourceSessionId: requireId(input.sourceSessionId, 'source session id') }
        : {}),
      ...(input.sourceContextId
        ? { sourceContextId: requireId(input.sourceContextId, 'source context id') }
        : {}),
      targetSessionId: requireId(input.targetSessionId, 'target session id'),
      ...(input.targetContextId
        ? { targetContextId: requireId(input.targetContextId, 'target context id') }
        : {}),
      reusedRefs: normalizeRefs(input.reusedRefs, 'reused refs'),
      omittedRefs: normalizeRefs(input.omittedRefs, 'omitted refs'),
      permissionMode: requirePermissionMode(input.permissionMode),
      allowedScopes: normalizeScopes(input.allowedScopes),
      status: 'prepared',
      boundary: requireBoundary(input.boundary),
      createdAt: new Date().toISOString(),
    };

    await writeJson(receiptPath, receipt);
    return receipt;
  });
}

function assertImmutableCompletionFields(
  receipt: ContextReuseReceipt,
  input: CompleteContextReuseReceiptInput,
): void {
  if (
    input.sourceSessionId !== undefined &&
    requireId(input.sourceSessionId, 'source session id') !== receipt.sourceSessionId
  ) throw new Error('source session is immutable');
  if (
    input.sourceContextId !== undefined &&
    requireId(input.sourceContextId, 'source context id') !== receipt.sourceContextId
  ) throw new Error('source context is immutable');
  if (
    input.targetSessionId !== undefined &&
    requireId(input.targetSessionId, 'target session id') !== receipt.targetSessionId
  ) throw new Error('target session is immutable');
  if (
    input.targetContextId !== undefined &&
    requireId(input.targetContextId, 'target context id') !== receipt.targetContextId
  ) throw new Error('target context is immutable');
  if (
    input.reusedRefs !== undefined &&
    !sameStrings(normalizeRefs(input.reusedRefs, 'reused refs'), receipt.reusedRefs)
  ) throw new Error('reused refs are immutable');
  if (
    input.omittedRefs !== undefined &&
    !sameStrings(normalizeRefs(input.omittedRefs, 'omitted refs'), receipt.omittedRefs)
  ) throw new Error('omitted refs are immutable');
  if (
    input.permissionMode !== undefined &&
    requirePermissionMode(input.permissionMode) !== receipt.permissionMode
  ) throw new Error('permission mode is immutable');
  if (
    input.allowedScopes !== undefined &&
    !sameStrings(normalizeScopes(input.allowedScopes), receipt.allowedScopes)
  ) throw new Error('allowed scopes are immutable');
}

export async function completeReceipt(
  userId: string,
  executionId: string,
  input: CompleteContextReuseReceiptInput,
): Promise<ContextReuseReceipt> {
  const receiptPath = contextReuseReceiptPath(userId, executionId);
  const status = requireCompletionStatus(input.status);
  return fileEditLock(receiptPath).runExclusive(async () => {
    const receipt = await readReceipt(userId, executionId);
    if (receipt.status !== 'prepared') throw new Error('context reuse receipt already finalized');
    assertImmutableCompletionFields(receipt, input);

    const next: ContextReuseReceipt = {
      ...receipt,
      status,
      completedAt: new Date().toISOString(),
      ...(input.baselineExecutionId
        ? { baselineExecutionId: requireId(input.baselineExecutionId, 'baseline execution id') }
        : {}),
      ...(input.treatmentExecutionId
        ? { treatmentExecutionId: requireId(input.treatmentExecutionId, 'treatment execution id') }
        : {}),
    };
    await writeJson(receiptPath, next);
    return next;
  });
}
