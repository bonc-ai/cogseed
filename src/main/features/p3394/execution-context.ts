import * as path from 'node:path';
import { safeId } from '../../storage';
import { isPathAllowed } from '../../util/path-sandbox';
import { readReceipt } from './context-reuse-receipt';
import { authoritativeSessionSource } from './session-source';

export interface PreparedExecutionContext {
  executionId: string;
  sessionId: string;
  contextId?: string;
  prompt: string;
  readOnlyRoots: string[];
  writableRoots: string[];
  permissionMode: string;
  receiptId: string;
}
export interface PrepareExecutionContextInput extends PreparedExecutionContext { receiptExecutionId: string; }
export type PrepareExecutionContextResult =
  | { ok: true; context: PreparedExecutionContext }
  | { ok: false; status: 'blocked'; event: { type: 'context-denied'; reason: string } };

const denied = (reason: string): PrepareExecutionContextResult => ({ ok: false, status: 'blocked', event: { type: 'context-denied', reason } });
function validId(value: unknown): value is string { return typeof value === 'string' && value.length <= 160 && safeId(value); }
function rootsWithin(values: unknown, approved: string[]): string[] | null {
  if (!Array.isArray(values) || values.length > 64) return null;
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !isPathAllowed(value, approved)) return null;
    out.push(path.resolve(value));
  }
  return Array.from(new Set(out));
}

export async function prepareExecutionContext(
  uid: string,
  input: PrepareExecutionContextInput,
  expected: { approvedReadOnlyRoots: string[]; approvedWritableRoots: string[] },
): Promise<PrepareExecutionContextResult> {
  if (!validId(input.executionId) || !validId(input.sessionId) || !validId(input.receiptId) || !validId(input.receiptExecutionId)) return denied('invalid_identity');
  if (input.contextId !== undefined && !validId(input.contextId)) return denied('invalid_context');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 100_000) return denied('invalid_prompt');
  const [receipt, session] = await Promise.all([
    readReceipt(uid, input.receiptExecutionId),
    authoritativeSessionSource.resolve(uid, input.sessionId),
  ]);
  if (!session.valid) return denied('session_unavailable');
  if (receipt.status !== 'prepared' || receipt.receiptId !== input.receiptId) return denied('receipt_unavailable');
  if (receipt.targetSessionId !== input.sessionId || receipt.targetContextId !== input.contextId) return denied('target_context_mismatch');
  if (receipt.permissionMode !== input.permissionMode) return denied('permission_mode_mismatch');
  const readOnlyRoots = rootsWithin(input.readOnlyRoots, expected.approvedReadOnlyRoots);
  const writableRoots = rootsWithin(input.writableRoots, expected.approvedWritableRoots);
  if (!readOnlyRoots || !writableRoots) return denied('root_scope_violation');
  if (input.permissionMode === 'read-only' && writableRoots.length) return denied('write_scope_denied');
  return { ok: true, context: {
    executionId: input.executionId, sessionId: input.sessionId,
    ...(input.contextId ? { contextId: input.contextId } : {}),
    prompt: input.prompt.trim(), readOnlyRoots, writableRoots,
    permissionMode: input.permissionMode, receiptId: input.receiptId,
  } };
}
