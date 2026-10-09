import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  cogseedRuntimeRoot,
  cogseedRuntimeSessionFile,
} from '../../../paths';
import { appendJsonl, safeId, writeJson } from '../../../storage';

export interface NativeRuntimeSessionHeader {
  type: 'session_header';
  version: 1;
  kernel: 'cogseed-agent-native';
  runtime_session_id: string;
  created_at: string;
}

export interface NativeRuntimeTurnRecord {
  type: 'turn';
  request_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  created_at: string;
}

export type NativeRuntimeSessionRecord = NativeRuntimeSessionHeader | NativeRuntimeTurnRecord;

export interface NativeRuntimeSessionReadResult {
  header: NativeRuntimeSessionHeader;
  records: NativeRuntimeSessionRecord[];
}

interface RequestLedgerEntry {
  request_id: string;
  runtime_session_id: string;
  run_id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  claimed_at: string;
}

type RequestLedger = Record<string, RequestLedgerEntry>;

type RuntimeRequestClaimResult =
  | { claimed: true }
  | { claimed: false; existingRunId: string; status: RequestLedgerEntry['status'] };

const NATIVE_RUNTIME_KERNEL = 'cogseed-agent-native';
const LEGACY_RUNTIME_SESSION_ERROR = 'legacy core-agent runtime session cannot be read as native history';
const VALID_TURN_ROLES = new Set(['user', 'assistant', 'tool', 'system']);
const VALID_LEDGER_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);
const ledgerTails = new Map<string, Promise<unknown>>();
const sessionCreateTails = new Map<string, Promise<unknown>>();

export function runtimeRequestLedgerFile(uid: string): string {
  return path.join(cogseedRuntimeRoot(uid), 'request-ledger.json');
}

export async function claimRuntimeRequest(
  uid: string,
  runtimeSessionId: string,
  requestId: string,
  runId: string,
  claimedAt: string,
): Promise<RuntimeRequestClaimResult> {
  assertRuntimeSessionId(runtimeSessionId);
  assertRequestId(requestId);
  assertRunId(runId);

  const ledgerFile = runtimeRequestLedgerFile(uid);
  return withLedgerQueue(ledgerFile, async () => {
    const ledger = await readRequestLedger(ledgerFile);
    const existing = ledger[requestId];
    if (isRequestLedgerEntry(existing)) {
      return {
        claimed: false,
        existingRunId: existing.run_id,
        status: existing.status,
      };
    }

    ledger[requestId] = {
      request_id: requestId,
      runtime_session_id: runtimeSessionId,
      run_id: runId,
      status: 'running',
      claimed_at: claimedAt,
    };
    await writeJson(ledgerFile, ledger);
    return { claimed: true };
  });
}

export async function createNativeRuntimeSession(
  uid: string,
  runtimeSessionId: string,
  createdAt: string,
): Promise<void> {
  assertRuntimeSessionId(runtimeSessionId);

  const file = cogseedRuntimeSessionFile(uid, runtimeSessionId);
  return withSessionCreateQueue(file, async () => {
    try {
      await readNativeRuntimeSession(uid, runtimeSessionId);
      return;
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }

    const header: NativeRuntimeSessionHeader = {
      type: 'session_header',
      version: 1,
      kernel: NATIVE_RUNTIME_KERNEL,
      runtime_session_id: runtimeSessionId,
      created_at: createdAt,
    };
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(header) + '\n', { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if (!isEexist(err)) throw err;
      await readNativeRuntimeSession(uid, runtimeSessionId);
    }
  });
}

export async function appendNativeSessionRecord(
  uid: string,
  runtimeSessionId: string,
  record: NativeRuntimeTurnRecord,
): Promise<void> {
  assertRuntimeSessionId(runtimeSessionId);
  assertNativeTurnRecord(record);
  await readNativeRuntimeSession(uid, runtimeSessionId);
  await appendJsonl(cogseedRuntimeSessionFile(uid, runtimeSessionId), record);
}

export async function readNativeRuntimeSession(
  uid: string,
  runtimeSessionId: string,
): Promise<NativeRuntimeSessionReadResult> {
  assertRuntimeSessionId(runtimeSessionId);

  const file = cogseedRuntimeSessionFile(uid, runtimeSessionId);
  const text = await fs.readFile(file, 'utf8');
  return parseNativeSessionRecords(text, runtimeSessionId);
}

function assertRuntimeSessionId(runtimeSessionId: string): void {
  if (!runtimeSessionId.startsWith('mruntime-') || !safeId(runtimeSessionId)) {
    throw new Error('invalid runtime session id');
  }
}

function assertRequestId(requestId: string): void {
  if (!requestId.startsWith('req-') || !safeId(requestId)) {
    throw new Error('invalid runtime request id');
  }
}

function assertRunId(runId: string): void {
  if (!safeId(runId)) {
    throw new Error('invalid runtime run id');
  }
}

function assertNativeTurnRecord(record: NativeRuntimeTurnRecord): void {
  if (!record || record.type !== 'turn') {
    throw new Error('invalid native runtime turn record');
  }
  assertRequestId(record.request_id);
  if (!VALID_TURN_ROLES.has(record.role)) {
    throw new Error('invalid native runtime turn role');
  }
  if (typeof record.content !== 'string' || typeof record.created_at !== 'string') {
    throw new Error('invalid native runtime turn record');
  }
}

function parseNativeSessionRecords(text: string, runtimeSessionId: string): NativeRuntimeSessionReadResult {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const header = lines[0] ? parseNativeSessionJsonLine(lines[0], LEGACY_RUNTIME_SESSION_ERROR) : undefined;
  if (!isNativeRuntimeSessionHeader(header)) {
    throw new Error(LEGACY_RUNTIME_SESSION_ERROR);
  }
  if (header.runtime_session_id !== runtimeSessionId) {
    throw new Error('native runtime session header id mismatch');
  }

  const records: NativeRuntimeSessionRecord[] = [header];
  for (const line of lines.slice(1)) {
    const record = parseNativeSessionJsonLine(line, 'invalid native runtime session record');
    if (!isNativeRuntimeTurnRecord(record)) {
      throw new Error('invalid native runtime session record');
    }
    records.push(record);
  }
  return { header, records };
}

function parseNativeSessionJsonLine(line: string, message: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(message);
  }
}

function isNativeRuntimeSessionHeader(value: unknown): value is NativeRuntimeSessionHeader {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<NativeRuntimeSessionHeader>;
  return record.type === 'session_header'
    && record.version === 1
    && record.kernel === NATIVE_RUNTIME_KERNEL
    && typeof record.runtime_session_id === 'string'
    && typeof record.created_at === 'string';
}

function isNativeRuntimeTurnRecord(value: unknown): value is NativeRuntimeTurnRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<NativeRuntimeTurnRecord>;
  return record.type === 'turn'
    && typeof record.request_id === 'string'
    && record.request_id.startsWith('req-')
    && safeId(record.request_id)
    && typeof record.role === 'string'
    && VALID_TURN_ROLES.has(record.role)
    && typeof record.content === 'string'
    && typeof record.created_at === 'string';
}

async function readRequestLedger(filePath: string): Promise<RequestLedger> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid runtime request ledger');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid runtime request ledger');
  }

  const ledger: RequestLedger = {};
  for (const [requestId, entry] of Object.entries(parsed)) {
    if (!isRequestLedgerEntry(entry) || entry.request_id !== requestId) {
      throw new Error('invalid runtime request ledger');
    }
    ledger[requestId] = entry;
  }
  return ledger;
}

function isRequestLedgerEntry(value: unknown): value is RequestLedgerEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<RequestLedgerEntry>;
  return typeof entry.request_id === 'string'
    && entry.request_id.startsWith('req-')
    && safeId(entry.request_id)
    && typeof entry.runtime_session_id === 'string'
    && entry.runtime_session_id.startsWith('mruntime-')
    && safeId(entry.runtime_session_id)
    && typeof entry.run_id === 'string'
    && safeId(entry.run_id)
    && typeof entry.claimed_at === 'string'
    && typeof entry.status === 'string'
    && VALID_LEDGER_STATUSES.has(entry.status);
}

function withLedgerQueue<T>(ledgerFile: string, work: () => Promise<T>): Promise<T> {
  return withPromiseQueue(ledgerTails, ledgerFile, work);
}

function withSessionCreateQueue<T>(sessionFile: string, work: () => Promise<T>): Promise<T> {
  return withPromiseQueue(sessionCreateTails, sessionFile, work);
}

function withPromiseQueue<T>(tails: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  const tail = current.catch(() => undefined);
  tails.set(key, tail);

  return current.finally(() => {
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  });
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}
