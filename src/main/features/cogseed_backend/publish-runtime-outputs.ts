/**
 * `publish_outputs` for the native Runtime.
 *
 * The meeting Agent's workflow declares its four deliverables through
 * `publish_outputs`; the core-agent runtime implements it, but the native
 * Runtime mapping deferred the tool. That left the documented precipitation
 * path dead for every `cogseed-native` meeting task.
 *
 * This host implementation keeps the security property of the core-agent
 * version — only files this Agent actually wrote are accepted — by verifying
 * against the **host-owned runtime session records** rather than trusting the
 * model's arguments. It then awaits knowledge-base precipitation and returns a
 * per-file outcome, so the Agent can report exactly what was archived.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { isPathAllowed } from '../../util/path-sandbox';
import { readNativeRuntimeSession } from '../cogseed_runtime/kernel/session-store';
import {
  precipitatePublishedOutputs,
  type PublishedPrecipitationResult,
} from '../meeting_kb_precipitate';
import type { CogSeedHostToolResult } from './office-adapter';
import { listCogSeedTasks, readCogSeedTaskByRequestId } from './task-store';
import { collectRuntimeWrittenPaths } from './runtime-written-paths';

const log = createLogger('cogseed-backend:publish-outputs');

const MAX_PATHS = 50;
/** Precipitation is local file copies plus a ledger append; 10s is generous. */
const PRECIPITATE_TIMEOUT_MS = 5_000;

export type PublishEntryStatus =
  | 'added'
  | 'skipped'
  | 'failed'
  | 'not_written'
  | 'missing'
  | 'outside_roots'
  | 'timeout';

export interface PublishEntryResult {
  path: string;
  status: PublishEntryStatus;
  reason?: string;
  artifactKind?: string;
  meetingKey?: string;
  target?: PublishedPrecipitationResult['target'];
  added?: string[];
  skipped?: PublishedPrecipitationResult['skipped'];
  failed?: PublishedPrecipitationResult['failed'];
}

export interface PublishRuntimeOutputsInput {
  userId: string;
  requestId: string;
  runtimeSessionId: string;
  workingDir?: string;
  writableRoots: readonly string[];
  input: Record<string, unknown>;
}

function errorResult(content: string): CogSeedHostToolResult {
  return { content, isError: true };
}

function resolveRequested(raw: unknown, workingDir: string | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const base = workingDir || process.cwd();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw.slice(0, MAX_PATHS)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const abs = path.resolve(base, value.trim());
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/** Paths a host-owned tool record proves were written by this session. */
async function readWrittenPaths(
  userId: string,
  runtimeSessionId: string,
  workingDir: string | undefined,
): Promise<Set<string>> {
  const session = await readNativeRuntimeSession(userId, runtimeSessionId);
  return collectRuntimeWrittenPaths(session.records, workingDir);
}

/**
 * Resolve the owning task even when the current call is a follow-up turn.
 * A resumed request gets a new request id; the task still owns the runtime
 * session, so the session is the durable lookup key. Requiring the original
 * request id would reject every post-confirmation publish.
 */
async function resolvePublishTask(
  userId: string,
  requestId: string,
  runtimeSessionId: string,
): Promise<import('./types').CogSeedTaskRecord | null> {
  const byRequest = await readCogSeedTaskByRequestId(userId, requestId).catch(() => null);
  if (byRequest?.runtimeSessionId === runtimeSessionId) return byRequest;
  const bySession = (await listCogSeedTasks(userId))
    .filter((task) => task.runtimeSessionId === runtimeSessionId);
  return bySession.length === 1 ? bySession[0] : null;
}

async function isRegularFile(absPath: string): Promise<boolean> {
  try {
    return (await fs.stat(absPath)).isFile();
  } catch {
    return false;
  }
}

type DeadlineResult<T> = { ok: true; value: T } | { ok: false };

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<DeadlineResult<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false }), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve({ ok: true, value }); },
      () => { clearTimeout(timer); resolve({ ok: false }); },
    );
  });
}

/**
 * Handle one host call. Never throws: every failure is a typed per-call or
 * per-file result so the Agent can report it and the meeting flow continues.
 */
export async function runPublishRuntimeOutputs(
  params: PublishRuntimeOutputsInput,
): Promise<CogSeedHostToolResult> {
  const task = await resolvePublishTask(params.userId, params.requestId, params.runtimeSessionId);
  if (!task) {
    return errorResult('[E_RUNTIME_HOST_TOOL_SCOPE] publish_outputs task scope mismatch');
  }

  const requested = resolveRequested(params.input.paths, params.workingDir);
  if (!Array.isArray(params.input.paths)) {
    return errorResult('[E_BAD_INPUT] `paths` must be an array');
  }
  if (params.input.paths.length > 0 && requested.length === 0) {
    return errorResult('[E_BAD_INPUT] `paths` must be empty or contain valid file paths');
  }

  let written: Set<string>;
  try {
    written = await readWrittenPaths(params.userId, params.runtimeSessionId, params.workingDir);
  } catch (error) {
    log.warn('publish_outputs could not read runtime session', { error: logErrorRef(error) });
    return errorResult('[E_OUTPUT_PUBLICATION_UNAVAILABLE] this session has no readable write records');
  }

  const accepted: string[] = [];
  const results: PublishEntryResult[] = [];
  for (const absPath of requested) {
    if (!written.has(absPath)) {
      results.push({ path: absPath, status: 'not_written', reason: 'no successful write in this Agent session' });
      continue;
    }
    if (params.writableRoots.length && !isPathAllowed(absPath, params.writableRoots)) {
      results.push({ path: absPath, status: 'outside_roots' });
      continue;
    }
    if (!await isRegularFile(absPath)) {
      results.push({ path: absPath, status: 'missing' });
      continue;
    }
    accepted.push(absPath);
  }

  if (requested.length > 0 && accepted.length === 0) {
    return {
      content: JSON.stringify({ published: 0, requested: requested.length, results }),
      isError: true,
    };
  }

  // Empty declaration is valid: it means "this turn exposes no file deliverable".
  if (accepted.length === 0) {
    return { content: JSON.stringify({ published: 0, inLibrary: 0, requested: 0, results: [] }) };
  }

  const settled = await withDeadline(
    precipitatePublishedOutputs(params.userId, task.conversationId, accepted),
    PRECIPITATE_TIMEOUT_MS,
  );
  if (!settled.ok) {
    for (const absPath of accepted) {
      results.push({ path: absPath, status: 'timeout', reason: 'precipitation still running; retry or check the ledger' });
    }
    return { content: JSON.stringify({ published: 0, requested: requested.length, results }) };
  }

  for (const outcome of settled.value) {
    const status: PublishEntryStatus = outcome.notIndexable
      ? 'skipped'
      : outcome.failed.length
        ? 'failed'
        : outcome.added.length
          ? 'added'
          : 'skipped';
    results.push({
      path: outcome.absPath,
      status,
      ...(outcome.notIndexable ? { reason: 'not_indexable' } : {}),
      artifactKind: outcome.artifactKind,
      meetingKey: outcome.meetingKey,
      ...(outcome.target ? { target: outcome.target } : {}),
      ...(outcome.added.length ? { added: outcome.added } : {}),
      ...(outcome.skipped.length ? { skipped: outcome.skipped } : {}),
      ...(outcome.failed.length ? { failed: outcome.failed } : {}),
    });
  }

  const published = results.filter((entry) => entry.status === 'added').length;
  // `published` counts newly added files; a repeat declaration is a no-op for
  // an already-archived file. `inLibrary` lets the Agent say "4 份已在库"
  // instead of misreporting "0 份入库".
  const inLibrary = results.filter((entry) => entry.status === 'added'
    || (entry.status === 'skipped' && (entry.reason === undefined || entry.reason === 'exists'))).length;
  log.info('runtime publish_outputs', {
    requested: requested.length,
    published,
    failed: results.filter((entry) => entry.status === 'failed').length,
  });
  return {
    content: JSON.stringify({ published, inLibrary, requested: requested.length, results }),
  };
}
