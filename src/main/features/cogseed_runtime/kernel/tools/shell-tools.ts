import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { classifyBashCommand } from '../../../../util/bash-risk';
import { capToolResult, DEFAULT_INLINE_RESULT_TOKENS, type WrapOpts } from '../../../../util/tool-result-cap';
import { cogseedRuntimeSessionToolResultsDir, userRoot } from '../../../../paths';
import { normalizeRuntimePath } from './permissions';
import type { RuntimeToolCallContext, RuntimeToolResult, RuntimeToolResultOptions } from './file-tools';
import { runWithRuntimeActionApproval } from './action-approval';

function formatError(code: string, message: string): RuntimeToolResult {
  return { content: `[${code}] ${message}`, isError: true };
}

function escapeAttr(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function capRuntimeResult(
  name: string,
  result: RuntimeToolResult,
  opts: RuntimeToolResultOptions,
): Promise<RuntimeToolResult> {
  const capped = capToolResult(name, result as any, { state: {} } as any, {
    maxInlineTokens: opts.maxInlineTokens ?? DEFAULT_INLINE_RESULT_TOKENS,
    toolResultsDir: cogseedRuntimeSessionToolResultsDir(opts.userId, opts.runtimeSessionId),
  } satisfies WrapOpts);
  return capped as RuntimeToolResult;
}

function resolveCwd(input: unknown, ctx: RuntimeToolCallContext): string {
  const fallback = ctx.allowedRoots[0] || process.cwd();
  if (typeof input !== 'string' || !input.trim()) return fallback;
  return normalizeRuntimePath(input, ctx.allowedRoots);
}

function runProcess(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    };
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('close', (code) => finish(code));
    child.once('error', (err) => {
      stderr += err instanceof Error ? err.message : String(err);
      finish(null);
    });
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref?.();
        }, timeoutMs)
      : null;
    timer?.unref?.();
  });
}

export async function runRuntimeBashTool(
  input: { command?: string; timeoutMs?: number; working_dir?: string },
  ctx: RuntimeToolCallContext,
  opts: RuntimeToolResultOptions,
): Promise<RuntimeToolResult> {
  const command = String(input.command ?? '').trim();
  if (!command) return formatError('E_BAD_INPUT', '`command` is required');
  if (ctx.toolPolicy.shell === 'none') {
    return formatError('E_RUNTIME_PERMISSION_DENIED', 'runtime bash is not enabled by policy');
  }

  let cwd: string;
  try {
    cwd = resolveCwd(input.working_dir, ctx);
  } catch (error) {
    return formatError((error as { code?: string }).code || 'E_RUNTIME_PATH_DENIED', (error as Error).message);
  }
  const risk = classifyBashCommand(command);
  if (risk.risky && ctx.toolPolicy.shell !== 'allow_with_confirmation') {
    return formatError('E_RUNTIME_BASH_REQUIRES_APPROVAL', `runtime bash requires approval for ${risk.reasons.join(', ')}`);
  }

  const execute = async (): Promise<RuntimeToolResult> => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COGSEED_NODE: process.execPath,
      COGSEED_PC_DIR: ctx.pcDir,
      COGSEED_WORKSPACE_ROOT: path.dirname(userRoot(ctx.userId)),
      COGSEED_UID: ctx.userId,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1',
    };
    const result = await runProcess(command, cwd, env, input.timeoutMs);
    if (result.timedOut) return formatError('E_RUNTIME_TIMEOUT', 'runtime bash timed out');
    if (result.code !== 0) {
      const output = result.stderr || result.stdout || `shell exited with code ${result.code}`;
      return capRuntimeResult('bash', { content: output, isError: true }, opts);
    }
    return capRuntimeResult('bash', { content: result.stdout }, opts);
  };

  if (!risk.risky) return execute();
  return runWithRuntimeActionApproval(ctx.actionApproval, {
    action: 'bash',
    target: command,
    scope: `仅在工作目录 ${cwd} 中执行这一条命令`,
    auditTarget: 'Sensitive shell command',
    auditScope: `risk categories: ${risk.reasons.join(', ')}`,
    risk: risk.reasons.includes('destructive') || risk.reasons.includes('priv_esc') ? 'critical' : 'high',
    reasons: risk.reasons,
    execution: { command, cwd, timeoutMs: input.timeoutMs ?? null },
  }, execute, opts.signal);
}

export function formatRuntimeBashCommand(command: string): string {
  return escapeAttr(command);
}
