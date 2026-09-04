import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { capToolResult, DEFAULT_INLINE_RESULT_TOKENS, type WrapOpts } from '../../../../util/tool-result-cap';
import { cogseedRuntimeSessionToolResultsDir, userRoot } from '../../../../paths';
import { userSkillsDir } from '../../../../paths';
// Imported from the feature module rather than `model/core-agent/skill-registry`
// on purpose: this runs inside the isolated Runtime worker, and the registry's
// module graph reaches `#core-agent`, which must stay dynamic-import-only
// (PC/CLAUDE.md §Boundary). `skill_reverify` depends only on quality + paths.
import { isSkillTrustedForLoadDeep } from '../../../skill_reverify';
import { normalizeRuntimePath } from './permissions';
import { captureSkillTree } from '../../../skills/snapshot-service';
import { verifySkillRuntimeSnapshot } from '../../../skills/runtime-snapshot-service';
import type { RuntimeToolCallContext, RuntimeToolResult, RuntimeToolResultOptions } from './file-tools';
import { runWithRuntimeActionApproval } from './action-approval';

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
    toolResultsDir: cogseedRuntimeSessionToolResultsDir(opts.userId, opts.runtimeSessionId),
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
    const pin = ctx.skillVersionPins?.find((item) => item.skillId === skillId);
    let pinnedSkillDir: string | undefined;
    if (pin) {
      if (pin.revisionId) {
        pinnedSkillDir = await verifySkillRuntimeSnapshot(
          ctx.userId,
          skillId,
          pin.revisionId,
          pin.manifestHash,
        );
        if (!pinnedSkillDir) {
          return formatError('E_RUNTIME_SKILL_VERSION_UNAVAILABLE', `frozen skill "${skillId}" version ${pin.version} is unavailable`);
        }
      } else {
        // Compatibility for task records created during the short manifest-only
        // pin window: they remain safe (never switch silently), but cannot run
        // after the live tree changes because no immutable revision was named.
        try {
          const current = await captureSkillTree(path.join(userSkillsDir(ctx.userId), skillId));
          if (current.manifestHash !== pin.manifestHash) {
            return formatError('E_RUNTIME_SKILL_VERSION_CHANGED', `skill "${skillId}" no longer matches frozen version ${pin.version}`);
          }
        } catch {
          return formatError('E_RUNTIME_SKILL_VERSION_CHANGED', `frozen skill "${skillId}" is unavailable`);
        }
      }
    }
    const script = validateSkillToken(input.script, 'script');
    // Security-receipt check before spawning. The Runtime worker reaches
    // `run-skill.cjs` directly, so without this a skill withheld from the
    // prompt path would still execute here. Only `blocked` stops the run —
    // `risk` / `unknown` proceed, and a thrown check proceeds too, matching the
    // deliberately fail-open load path (a scanner hiccup must not make a
    // working skill unrunnable).
    //
    // Takes `skill_id` verbatim: this tool's contract is an id, not a display
    // name, so there is no name-resolution hole to close as there is for the
    // free-form bash command path.
    if (!pinnedSkillDir) {
      try {
        const trust = await isSkillTrustedForLoadDeep(ctx.userId, skillId);
        if (!trust.trusted) {
          return formatError(
            'E_RUNTIME_SKILL_WITHHELD',
            `skill "${skillId}" failed security verification (its files changed since it was checked, or the rules were updated) and cannot run`,
          );
        }
      } catch {
        // Verification infrastructure failure is not evidence of tampering.
      }
    }
    const cwd = typeof input.cwd === 'string' && input.cwd.trim()
      ? normalizeRuntimePath(input.cwd, ctx.allowedRoots)
      : (ctx.allowedRoots[0] || process.cwd());
    const args = Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : [];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COGSEED_PC_DIR: ctx.pcDir,
      COGSEED_WORKSPACE_ROOT: path.dirname(userRoot(ctx.userId)),
      COGSEED_UID: ctx.userId,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1',
      ...(pinnedSkillDir ? { COGSEED_RUN_SKILL_DIR: pinnedSkillDir } : {}),
      ...(input.agent_id ? { COGSEED_AGENT_ID: String(input.agent_id) } : {}),
    };
    const runSkillPath = path.join(ctx.pcDir, 'bin', 'run-skill.cjs');
    const execute = async (): Promise<RuntimeToolResult> => {
      const result = await runProcess([
        runSkillPath,
        skillId,
        script,
        '--',
        ...args,
      ], cwd, env, undefined);
      if (result.timedOut) return formatError('E_RUNTIME_TIMEOUT', 'runtime run_skill timed out');
      if (result.code !== 0) {
        const output = result.stderr || result.stdout || `run-skill exited with code ${result.code}`;
        return capRuntimeResult('run_skill', { content: output, isError: true }, opts);
      }
      return capRuntimeResult('run_skill', { content: result.stdout }, opts);
    };

    return runWithRuntimeActionApproval(ctx.actionApproval, {
      action: 'run_skill',
      target: `${skillId} / ${script}`,
      scope: `仅运行该 Skill 脚本，工作目录：${cwd}`,
      auditTarget: `Skill script: ${skillId}/${script}`,
      auditScope: `argument count: ${args.length}`,
      risk: 'high',
      reasons: ['local_skill_execution'],
      execution: { skill_id: skillId, script, args, cwd, agent_id: input.agent_id || null },
    }, execute, opts.signal);
  } catch (err) {
    return formatError((err as { code?: string }).code || 'E_RUNTIME_TOOL_FAILED', (err as Error).message);
  }
}
