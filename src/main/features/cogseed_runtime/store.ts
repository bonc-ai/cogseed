import * as fs from 'node:fs/promises';

import {
  mateRuntimeRunEventsFile,
  mateRuntimeRunMetaFile,
} from '../../paths';
import { appendJsonl, readJson, safeId, writeJson } from '../../storage';
import type { RuntimeEventEnvelope, RuntimeStatus } from './protocol';

export interface RuntimeRunMeta {
  run_id: string;
  request_id: string;
  runtime_session_id: string;
  status: RuntimeStatus | 'running';
  created_at: string;
  updated_at?: string;
  error?: string;
}

function assertRuntimeRunId(runId: string): string {
  if (!safeId(runId)) throw new Error('invalid runtime run id');
  return runId;
}

export function runtimeRunMetaFile(uid: string, runId: string): string {
  return mateRuntimeRunMetaFile(uid, assertRuntimeRunId(runId));
}

export function runtimeRunEventsFile(uid: string, runId: string): string {
  return mateRuntimeRunEventsFile(uid, assertRuntimeRunId(runId));
}

export async function writeRuntimeRunMeta(uid: string, runId: string, meta: RuntimeRunMeta): Promise<void> {
  assertRuntimeRunId(runId);
  await writeJson(runtimeRunMetaFile(uid, runId), meta);
}

export async function readRuntimeRunMeta(uid: string, runId: string): Promise<RuntimeRunMeta | null> {
  assertRuntimeRunId(runId);
  const data = await readJson<RuntimeRunMeta>(runtimeRunMetaFile(uid, runId));
  return data && typeof data === 'object' && typeof data.run_id === 'string' ? data : null;
}

export async function appendRuntimeRunEvent(uid: string, runId: string, event: RuntimeEventEnvelope): Promise<void> {
  assertRuntimeRunId(runId);
  await appendJsonl(runtimeRunEventsFile(uid, runId), event);
}

export async function readRuntimeRunEvents(uid: string, runId: string): Promise<RuntimeEventEnvelope[]> {
  assertRuntimeRunId(runId);
  try {
    const text = await fs.readFile(runtimeRunEventsFile(uid, runId), 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
