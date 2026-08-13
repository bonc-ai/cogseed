import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { capToolResult, DEFAULT_INLINE_RESULT_TOKENS, type WrapOpts } from '../../../../util/tool-result-cap';
import { mateRuntimeSessionToolResultsDir, userRoot } from '../../../../paths';
import { normalizeRuntimePath } from './permissions';
import type { RuntimeToolCallContext, RuntimeToolResult, RuntimeToolResultOptions } from './file-tools';

function formatError(code: string, message: string): RuntimeToolResult {
  return { content: `[${code}] ${message}`, isError: true };
}

async function capRuntimeResult(
  name: string,
  result: RuntimeToolResult,
  opts: RuntimeToolResultOptions,
): Promise<RuntimeToolResult> {
  const capped = capToolResult(name, result as any, { state: {} } as any, {
    maxInlineTokens: opts.maxInlineTokens ?? DEFAULT_INLINE_RESULT_TOKENS,
    toolResultsDir: mateRuntimeSessionToolResultsDir(opts.userId, opts.runtimeSessionId),
  } satisfies WrapOpts);
  return capped as RuntimeToolResult;
}

function runProcess(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
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

function validateSkillToken(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text || /[\\/]/.test(text) || text === '.' || text === '..') {
    throw Object.assign(new Error(`invalid ${label}`), { code: 'E_RUNTIME_INVALID_ID' });
  }
  return text;
}

export async function runRuntimeSkillTool(
  input: { skill_id?: string; script?: string; args?: string[]; cwd?: string; agent_id?: string },
  ctx: RuntimeToolCallContext,
  opts: RuntimeToolResultOptions,
): Promise<RuntimeToolResult> {
  if (ctx.toolPolicy.skillRun !== 'allowlisted_skills') {
    return formatError('E_RUNTIME_PERMISSION_DENIED', 'runtime skill execution is not enabled by policy');
  }
  try {
    const skillId = validateSkillToken(input.skill_id, 'skill_id');
    if (!(ctx.allowedSkillIds ?? []).includes(skillId)) {
      return formatError('E_RUNTIME_PERMISSION_DENIED', 'runtime skill is outside the persisted Agent allowlist');
    }
    const script = validateSkillToken(input.script, 'script');
    const cwd = typeof input.cwd === 'string' && input.cwd.trim()
      ? normalizeRuntimePath(input.cwd, ctx.allowedRoots)
      : (ctx.allowedRoots[0] || process.cwd());
    const args = Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : [];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ORKAS_PC_DIR: ctx.pcDir,
      ORKAS_WORKSPACE_ROOT: path.dirname(userRoot(ctx.userId)),
      ORKAS_UID: ctx.userId,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1',
      ...(input.agent_id ? { ORKAS_AGENT_ID: String(input.agent_id) } : {}),
    };
    const runSkillPath = path.join(ctx.pcDir, 'bin', 'run-skill.cjs');
    const result = await runProcess([
      runSkillPath,
      skillId,
      script,
      '--',
      ...args,
    ], cwd, env, undefined);

    if (result.timedOut) {
      return formatError('E_RUNTIME_TIMEOUT', 'runtime run_skill timed out');
    }
    if (result.code !== 0) {
      const output = result.stderr || result.stdout || `run-skill exited with code ${result.code}`;
      return capRuntimeResult('run_skill', { content: output, isError: true }, opts);
    }
    return capRuntimeResult('run_skill', { content: result.stdout }, opts);
  } catch (err) {
    return formatError((err as { code?: string }).code || 'E_RUNTIME_TOOL_FAILED', (err as Error).message);
  }
}
