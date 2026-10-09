/** Baseline/treatment orchestration over an injected existing dispatch boundary. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { userLocalRoot } from '../../paths';
import { safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import {
  createLifecycleSink,
  type ExecutionArtifactRef,
  type ExecutionBoundary,
  type ExecutionKind,
  type ExecutionStatus,
} from '../execution-records';
import { completeReceipt, readReceipt } from './context-reuse-receipt';

const MAX_ID = 160;
const MAX_TASK = 100_000;
const MAX_ATTACHMENTS = 100;

export type ContrastMode = 'baseline' | 'treatment';

export interface BehaviorContrast {
  contrastId: string;
  baselineExecutionId: string;
  treatmentExecutionId: string;
  sameInputHash: string;
  baseline: { status: string; outputHash: string; artifactIds: string[] };
  treatment: { status: string; outputHash: string; artifactIds: string[] };
  changed: boolean;
  receiptId: string;
  boundary: ExecutionBoundary;
  createdAt: string;
}

export interface BehaviorContrastDispatchRequest {
  executionId: string;
  contextMode: ContrastMode;
  task: string;
  attachmentIds: string[];
  reusedRefs: string[];
  omittedRefs: string[];
  permissionMode: string;
  allowedScopes: string[];
  targetSessionId: string;
  targetContextId?: string;
  receiptId: string;
}

export interface BehaviorContrastDispatchResult {
  status: Exclude<ExecutionStatus, 'queued' | 'running'>;
  output?: string;
  artifacts?: ExecutionArtifactRef[];
}

export type BehaviorContrastExecutor = (
  request: BehaviorContrastDispatchRequest,
) => Promise<BehaviorContrastDispatchResult>;

export interface RunBehaviorContrastInput {
  contrastId?: string;
  receiptExecutionId: string;
  task: string;
  attachmentIds: string[];
  conversationId: string;
  agentId?: string;
  executionKind: ExecutionKind;
  boundary: ExecutionBoundary;
}

let configuredExecutor: { executor: BehaviorContrastExecutor; boundary: ExecutionBoundary } | null = null;

export function configureBehaviorContrastExecutor(
  executor: BehaviorContrastExecutor | null,
  boundary: Exclude<ExecutionBoundary, 'test-double'> = 'real',
): void {
  configuredExecutor = executor ? { executor, boundary } : null;
}

export function _setBehaviorContrastExecutorForTest(executor: BehaviorContrastExecutor | null): void {
  configuredExecutor = executor ? { executor, boundary: 'test-double' } : null;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > MAX_ID || !safeId(value)) throw new Error(`invalid ${field}`);
  return value;
}

function normalizeTask(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid task');
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > MAX_TASK) throw new Error('invalid task');
  return normalized;
}

function normalizeAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error('invalid attachment ids');
  return Array.from(new Set(value.map((id) => requireId(id, 'attachment id')))).sort();
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function behaviorContrastPath(userId: string, contrastId: string): string {
  return path.join(userLocalRoot(userId), 'kstar', 'executions', 'contrasts', `${requireId(contrastId, 'contrast id')}.json`);
}

function parseContrast(raw: string): BehaviorContrast {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('behavior contrast is malformed'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('behavior contrast is malformed');
  const row = value as Partial<BehaviorContrast>;
  requireId(row.contrastId, 'contrast id');
  requireId(row.baselineExecutionId, 'baseline execution id');
  requireId(row.treatmentExecutionId, 'treatment execution id');
  if (typeof row.sameInputHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.sameInputHash)) throw new Error('behavior contrast is malformed');
  if (!row.baseline || !row.treatment || typeof row.receiptId !== 'string' || typeof row.changed !== 'boolean') throw new Error('behavior contrast is malformed');
  if (row.boundary !== 'real' && row.boundary !== 'degraded' && row.boundary !== 'test-double') throw new Error('behavior contrast is malformed');
  return row as BehaviorContrast;
}

export async function readBehaviorContrast(userId: string, contrastId: string): Promise<BehaviorContrast> {
  try { return parseContrast(await fs.readFile(behaviorContrastPath(userId, contrastId), 'utf8')); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('behavior contrast not found');
    throw err;
  }
}

async function runOne(
  userId: string,
  input: RunBehaviorContrastInput,
  request: BehaviorContrastDispatchRequest,
  executor: BehaviorContrastExecutor,
): Promise<{ status: string; outputHash: string; artifactIds: string[] }> {
  const lifecycle = createLifecycleSink(userId, {
    executionId: request.executionId,
    kind: input.executionKind,
    conversationId: input.conversationId,
    agentId: input.agentId,
    contextId: request.targetContextId,
    receiptId: request.receiptId,
    boundary: input.boundary,
    permissionMode: request.permissionMode,
    sessionId: request.targetSessionId,
  });
  const start = {
    kind: input.executionKind,
    sessionId: request.targetSessionId,
    conversationId: input.conversationId,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(request.targetContextId ? { contextId: request.targetContextId } : {}),
    receiptId: request.receiptId,
  };
  await lifecycle.queued(start);
  await lifecycle.started(start);
  await lifecycle.event('event', {
    eventType: 'context_mode',
    contextMode: request.contextMode,
    reusedRefCount: request.reusedRefs.length,
    omittedRefCount: request.omittedRefs.length,
    attachmentCount: request.attachmentIds.length,
  });

  let result: BehaviorContrastDispatchResult;
  try {
    result = await executor(request);
  } catch {
    result = { status: 'failed', output: '', artifacts: [] };
  }
  const artifacts = result.artifacts || [];
  for (const artifact of artifacts) await lifecycle.artifact(artifact);
  await lifecycle.terminal({
    status: result.status,
    sessionId: request.targetSessionId,
    ...(result.output !== undefined ? { output: result.output } : {}),
  });
  return {
    status: result.status,
    outputHash: hashText(result.output || ''),
    artifactIds: artifacts.map((artifact) => artifact.artifactId),
  };
}

export async function runBehaviorContrast(
  userId: string,
  input: RunBehaviorContrastInput,
  executor: BehaviorContrastExecutor,
): Promise<BehaviorContrast> {
  const contrastId = input.contrastId ? requireId(input.contrastId, 'contrast id') : `contrast-${randomUUID()}`;
  const receiptExecutionId = requireId(input.receiptExecutionId, 'receipt execution id');
  const task = normalizeTask(input.task);
  const attachmentIds = normalizeAttachmentIds(input.attachmentIds);
  requireId(input.conversationId, 'conversation id');
  if (input.agentId) requireId(input.agentId, 'agent id');
  if (!['core-agent', 'codex', 'local-agent', 'openclaw'].includes(input.executionKind)) throw new Error('invalid execution kind');
  if (!['real', 'degraded', 'test-double'].includes(input.boundary)) throw new Error('invalid execution boundary');

  const receipt = await readReceipt(userId, receiptExecutionId);
  if (receipt.status !== 'prepared') throw new Error('context reuse receipt is already finalized');
  const baselineExecutionId = `baseline-${randomUUID()}`;
  const treatmentExecutionId = `treatment-${randomUUID()}`;
  const shared = {
    task,
    attachmentIds,
    omittedRefs: [...receipt.omittedRefs],
    permissionMode: receipt.permissionMode,
    allowedScopes: [...receipt.allowedScopes],
    targetSessionId: receipt.targetSessionId,
    ...(receipt.targetContextId ? { targetContextId: receipt.targetContextId } : {}),
    receiptId: receipt.receiptId,
  };
  const baseline = await runOne(userId, input, {
    ...shared,
    executionId: baselineExecutionId,
    contextMode: 'baseline',
    reusedRefs: [],
  }, executor);
  const treatment = await runOne(userId, input, {
    ...shared,
    executionId: treatmentExecutionId,
    contextMode: 'treatment',
    reusedRefs: [...receipt.reusedRefs],
  }, executor);

  const contrast: BehaviorContrast = {
    contrastId,
    baselineExecutionId,
    treatmentExecutionId,
    sameInputHash: hashText(JSON.stringify({ task, attachmentIds })),
    baseline,
    treatment,
    changed: baseline.status !== treatment.status
      || baseline.outputHash !== treatment.outputHash
      || !sameStrings(baseline.artifactIds, treatment.artifactIds),
    receiptId: receipt.receiptId,
    boundary: input.boundary,
    createdAt: new Date().toISOString(),
  };
  const target = behaviorContrastPath(userId, contrastId);
  await fileEditLock(target).runExclusive(async () => {
    try { await fs.access(target); throw new Error('behavior contrast already exists'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    await writeJson(target, contrast);
  });
  await completeReceipt(userId, receiptExecutionId, {
    status: baseline.status === 'completed' && treatment.status === 'completed' ? 'completed' : 'degraded',
    baselineExecutionId,
    treatmentExecutionId,
  });
  return contrast;
}

export async function runConfiguredBehaviorContrast(
  userId: string,
  input: Omit<RunBehaviorContrastInput, 'boundary'>,
): Promise<BehaviorContrast> {
  if (!configuredExecutor) throw new Error('behavior contrast executor unavailable');
  return runBehaviorContrast(userId, { ...input, boundary: configuredExecutor.boundary }, configuredExecutor.executor);
}
