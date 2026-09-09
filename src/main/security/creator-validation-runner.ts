import * as fs from 'node:fs';
import * as path from 'node:path';

import { getActiveUserId } from '../features/users';
import { getWorkspacePath } from '../features/user_workspace';
import { canonicalizePath } from '../util/path-sandbox';
import { sanitizeCreatorStructuredOutput } from '../features/creator/schema';

const MAX_OUTPUT_BYTES = 8_000;
const VALIDATION_SCRIPTS = {
  typecheck: 'typecheck',
  test: 'test',
  lint: 'lint',
  smoke: 'smoke',
} as const;

export type CreatorValidationCheckId = keyof typeof VALIDATION_SCRIPTS;

export interface CreatorValidationPlan {
  readonly checkId: CreatorValidationCheckId;
  readonly command: 'npm';
  readonly args: readonly ['run', string];
  readonly cwd: string;
  readonly shell: false;
  readonly timeoutMs: 120_000;
  readonly maxOutputBytes: typeof MAX_OUTPUT_BYTES;
}

export interface CreatorValidationExecution {
  exitCode: number | null;
  stdout?: unknown;
  stderr?: unknown;
  timedOut?: boolean;
}

export interface CreatorValidationDependencies {
  /** Approved executor supplied by the isolated host integration. */
  execute(plan: Readonly<CreatorValidationPlan>, signal?: AbortSignal): Promise<CreatorValidationExecution>;
  getActiveUserId?: () => string;
  getWorkspacePath?: (userId: string) => string;
  now?: () => number;
}

export interface CreatorValidationInput {
  checkId: string;
}

export interface CreatorValidationResult {
  check_id: CreatorValidationCheckId;
  status: 'passed' | 'failed' | 'timed_out';
  exit_code: number | null;
  duration_ms: number;
  output: string;
}

function requireCheckId(checkId: unknown): CreatorValidationCheckId {
  if (typeof checkId !== 'string' || !Object.prototype.hasOwnProperty.call(VALIDATION_SCRIPTS, checkId)) {
    throw new Error('creator_validation_check_invalid');
  }
  return checkId as CreatorValidationCheckId;
}

export function creatorValidationScript(checkId: string): string {
  const validated = requireCheckId(checkId);
  return `npm run ${VALIDATION_SCRIPTS[validated]}`;
}

function trustedWorkspace(userId: string, deps: CreatorValidationDependencies): string {
  let activeUserId: string;
  try {
    activeUserId = (deps.getActiveUserId ?? getActiveUserId)();
  } catch {
    throw new Error('creator_user_not_active');
  }
  if (!userId || activeUserId !== userId) throw new Error('creator_user_not_active');

  let configured: string;
  try {
    configured = (deps.getWorkspacePath ?? getWorkspacePath)(userId);
  } catch {
    throw new Error('creator_validation_workspace_invalid');
  }
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) {
    throw new Error('creator_validation_workspace_invalid');
  }
  const canonical = canonicalizePath(configured);
  try {
    if (!fs.statSync(canonical).isDirectory()) throw new Error('not_directory');
  } catch {
    throw new Error('creator_validation_workspace_invalid');
  }
  return canonical;
}

function createCreatorValidationPlan(
  checkId: CreatorValidationCheckId,
  workingDir: string,
): Readonly<CreatorValidationPlan> {
  return Object.freeze({
    checkId,
    command: 'npm',
    args: Object.freeze(['run', VALIDATION_SCRIPTS[checkId]]) as readonly ['run', string],
    cwd: workingDir,
    shell: false,
    timeoutMs: 120_000,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
}

function bounded(value: unknown): string {
  return sanitizeCreatorStructuredOutput(value, MAX_OUTPUT_BYTES);
}

function normalizedExecution(value: unknown): CreatorValidationExecution | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const execution = value as Record<string, unknown>;
    const exitCode = execution.exitCode;
    const timedOut = execution.timedOut;
    if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode))) return null;
    if (timedOut !== undefined && typeof timedOut !== 'boolean') return null;
    return {
      exitCode: exitCode as number | null,
      stdout: execution.stdout,
      stderr: execution.stderr,
      timedOut: timedOut as boolean | undefined,
    };
  } catch {
    return null;
  }
}

/** Dispatches one fixed check for the active user's trusted host workspace. */
export async function runCreatorValidation(
  userId: string,
  input: CreatorValidationInput,
  deps: CreatorValidationDependencies,
  signal?: AbortSignal,
): Promise<CreatorValidationResult> {
  const checkId = requireCheckId(input?.checkId);
  const plan = createCreatorValidationPlan(checkId, trustedWorkspace(userId, deps));
  const now = deps.now ?? Date.now;
  const started = now();
  let rawExecution: unknown;
  try {
    rawExecution = await deps.execute(plan, signal);
  } catch {
    throw new Error('creator_validation_execution_failed');
  }
  const execution = normalizedExecution(rawExecution);
  if (!execution) {
    return {
      check_id: plan.checkId,
      status: 'failed',
      exit_code: null,
      duration_ms: Math.max(0, now() - started),
      output: 'creator_validation_execution_invalid',
    };
  }
  const stdout = bounded(execution.stdout);
  const stderr = bounded(execution.stderr);
  const output = stdout === stderr ? stdout : bounded(`${stdout}${stderr}`);
  return {
    check_id: plan.checkId,
    status: execution.timedOut ? 'timed_out' : execution.exitCode === 0 ? 'passed' : 'failed',
    exit_code: execution.exitCode,
    duration_ms: Math.max(0, now() - started),
    output,
  };
}
