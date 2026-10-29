import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import type { ShellApprovalDecision } from '../../../../src/main/model/client';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock('../../../../src/main/logger', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/main/logger')>(),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/**
 * 这些用例要跑**真的** `mkdir`（不是 mock），所以 timeoutMs 是「命令上限」，不是被测
 * 语义。win32 的宿主 shell 是 PowerShell（executor 的 defaultShellForPlatform），
 * CI 满载时它自己启动就可能超过 5s，把「mkdir 成功」误报成 `Command timed out`。
 * 与 test/main/model/local-tools.test.ts 的 SHELL_SUCCESS_TIMEOUT_MS 同源口径：
 * 只在需要真实 shell 成功的用例上放宽，POSIX 仍是 5s。
 */
const SHELL_COMMAND_TIMEOUT_MS = process.platform === 'win32' && process.env.CI
  ? 100_000
  : process.platform === 'win32'
    ? 15_000
    : 5_000;

let root: string;
let workspace: string;
let previousRoot: string | undefined;
const uid = 'reception-shell-user';

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reception-shell-'));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(uid);
  const ws = await import('../../../../src/main/features/user_workspace');
  ws.setWorkspacePath(uid, workspace);
});

afterEach(async () => {
  const permissions = await import('../../../../src/main/model/core-agent/bash-permissions');
  permissions._setBroadcastForTest(null);
  permissions._resetForTest();
  const sessions = await import('../../../../src/main/model/core-agent/interactive-cli-sessions');
  await sessions._resetInteractiveCliSessionsForTest();
  const approvals = await import('../../../../src/main/features/action_approval');
  approvals._resetActionApprovalForTest();
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function toolsWithApproval(beforeShellApproval?: (input: any) => Promise<ShellApprovalDecision>, permissionMode = 'ask') {
  const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
  return createLocalTools({ userId: uid, cid: 'a2a-bidirectional', permissionMode, beforeShellApproval } as any);
}

function context(signal = new AbortController().signal) {
  return { workingDir: workspace, state: {}, signal } as any;
}

describe('SDK reception shell approval', () => {
  it.each([true, false])('quality regression: cancellation after bash preflight cannot launch background execution (cwd=%s)', async (withCwd) => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.grantLocalExec();
    const spawn = vi.mocked(childProcess.spawn).mockClear();
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    const tools = createLocalTools({
      userId: uid, cid: 'a2a-bidirectional', permissionMode: 'full', beforeShellApproval: async () => null,
      beforeUnverifiedAction: async () => {
        entered();
        await new Promise<void>(resolve => { release = resolve; });
        return undefined;
      },
    });
    const ctx = context(controller.signal);
    if (!withCwd) delete ctx.workingDir;
    // Keep any red-run background logs and command effects in the disposable root.
    ctx.state.sandboxEnv = { COGSEED_OUTPUT_DIR: workspace };
    const marker = path.join(workspace, 'cancelled-background');
    const pending = tools.find(tool => tool.name === 'bash')!.execute({
      command: `mkdir ${JSON.stringify(marker)}`, run_in_background: true,
    }, ctx);
    await Promise.race([enteredPromise, pending]);
    expect(release).toBeTypeOf('function');
    expect(spawn).not.toHaveBeenCalled();
    controller.abort();
    release();
    const result = await pending;
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('E_ACTION_APPROVAL_CANCELLED') });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each(['success', 'failure', 'cancel', 'throw'] as const)('quality regression: SDK shell consumes its real grant and audits %s without private inputs', async outcome => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.grantLocalExec();
    const approvals = await import('../../../../src/main/features/action_approval');
    const { requestReceptionShellApproval } = await import('../../../../src/main/features/a2a/reception-approval');
    const paths = await import('../../../../src/main/paths');
    const controller = new AbortController();
    approvals._setActionApprovalBroadcastForTest((_channel, payload: any) => {
      void approvals.respondActionApproval(payload.request_id, 'approve');
    });
    fs.mkdirSync(path.join(workspace, 'already-exists'));
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    const tools = createLocalTools({
      userId: uid, cid: 'a2a-bidirectional', permissionMode: 'full',
      beforeShellApproval: input => requestReceptionShellApproval({
        ...input, userId: uid, requestId: 'quality-turn', runtimeSessionId: 'gchat:a2a-bidirectional',
      }),
      beforeUnverifiedAction: async () => {
        if (outcome === 'cancel') controller.abort();
        if (outcome === 'throw') throw new Error('private-preflight-detail');
        return undefined;
      },
    });
    const result = await tools.find(tool => tool.name === 'bash')!.execute({
      command: outcome === 'failure' ? 'mkdir already-exists' : 'mkdir private-audit-marker',
    }, context(controller.signal)).catch(() => ({ content: 'preflight threw', isError: true }));
    expect(Boolean(result.isError)).toBe(outcome !== 'success');
    const audit = fs.readFileSync(paths.actionApprovalAuditFile(uid), 'utf8');
    const records = audit.trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.event)).toEqual([
      'requested', 'approved', 'execution_started', outcome === 'success' ? 'execution_succeeded' : 'execution_failed',
    ]);
    expect(audit).not.toContain('private-audit-marker');
    expect(audit).not.toContain('private-preflight-detail');
    expect(audit).not.toContain(workspace);
  });

  it.each([true, false])('review regression: reception=%s never reuses start approval for stdin; ordinary stdin stays available', async (reception) => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.grantLocalExec();
    const spawn = vi.mocked(childProcess.spawn).mockClear();
    const approval = vi.fn(async () => null);
    const tools = await toolsWithApproval(reception ? approval : undefined, 'full');
    const started = await tools.find(tool => tool.name === 'interactive_cli_start')!.execute({ command: 'sh' }, context());
    expect(started.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledTimes(1);
    const child = spawn.mock.results[0].value as childProcess.ChildProcessWithoutNullStreams;
    const write = vi.spyOn(child.stdin, 'write');
    const sessionId = JSON.parse(started.content).session_id;
    const result = await tools.find(tool => tool.name === 'interactive_cli_send')!.execute({
      session_id: sessionId, input: 'mkdir stdin-bypass',
    }, context());
    if (reception) {
      expect(write).not.toHaveBeenCalled();
      expect(result).toMatchObject({ isError: true, content: expect.stringContaining('E_ACTION_APPROVAL_REQUIRED') });
      expect(approval).toHaveBeenCalledTimes(1);
    } else {
      expect(write).toHaveBeenCalledWith('mkdir stdin-bypass\n', 'utf8');
      expect(result.isError).toBeFalsy();
    }
  });

  it('review regression: abort during awaited interactive preflight cannot spawn after shell approval', async () => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.grantLocalExec();
    const spawn = vi.mocked(childProcess.spawn).mockClear();
    const controller = new AbortController();
    let entered!: () => void;
    let release!: (value: null) => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const approval = vi.fn(async () => null);
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    const tools = createLocalTools({
      userId: uid, cid: 'a2a-bidirectional', permissionMode: 'full', beforeShellApproval: approval,
      beforeUnverifiedAction: async () => {
        entered();
        return new Promise<null>(resolve => { release = resolve; });
      },
    });
    const pending = tools.find(tool => tool.name === 'interactive_cli_start')!.execute({ command: 'sh' }, context(controller.signal));
    await Promise.race([enteredPromise, pending]);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(release).toBeTypeOf('function');
    expect(spawn).not.toHaveBeenCalled();
    controller.abort();
    release(null);
    const result = await pending;
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('E_ACTION_APPROVAL_CANCELLED') });
  });

  it.each([
    ['ask', 'all_files_approval'], ['full', 'all_files_approval'], ['auto_approve', 'all_files_approval'],
    ['ask', 'all_files_auto'], ['full', 'all_files_auto'], ['auto_approve', 'all_files_auto'],
  ] as const)('holds low-risk mkdir until per-action approval in %s / %s mode', async (mode, localMode) => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode(localMode);
    let answer!: (value: string | null) => void;
    let requested!: () => void;
    const requestedPromise = new Promise<void>(resolve => { requested = resolve; });
    const approval = vi.fn(async () => {
      requested();
      return new Promise<string | null>(resolve => { answer = resolve; });
    });
    const bash = (await toolsWithApproval(approval, mode)).find(tool => tool.name === 'bash')!;
    const ctx = context();
    const pending = bash.execute({ command: 'mkdir accepted', timeoutMs: SHELL_COMMAND_TIMEOUT_MS }, ctx);
    // A missing gate must fail promptly instead of leaving the test waiting.
    await Promise.race([requestedPromise, pending]);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'bash', command: 'mkdir accepted', workingDir: workspace, signal: ctx.signal,
    }));
    expect(fs.existsSync(path.join(workspace, 'accepted'))).toBe(false);
    answer(null);
    expect((await pending).isError).toBeFalsy();
    expect(fs.existsSync(path.join(workspace, 'accepted'))).toBe(true);
  });

  it('requests a fresh approval for repeated identical commands and does not double-prompt for shell risk', async () => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const bashPermissions = await import('../../../../src/main/model/core-agent/bash-permissions');
    const riskPrompt = vi.fn((_channel: string, info: any) => bashPermissions.respond(info.request_id, 'deny'));
    bashPermissions._setBroadcastForTest(riskPrompt);
    fs.mkdirSync(path.join(workspace, 'remove-me'));
    const approval = vi.fn(async () => null);
    const bash = (await toolsWithApproval(approval)).find(tool => tool.name === 'bash')!;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await bash.execute({ command: 'rmdir remove-me; mkdir remove-me', timeoutMs: SHELL_COMMAND_TIMEOUT_MS }, context())).isError).toBeFalsy();
    }
    expect(approval).toHaveBeenCalledTimes(2);
    expect(riskPrompt).not.toHaveBeenCalled();
  });

  it.each(['deny', 'error'])('blocks both shell entry points on approval %s without executing', async (decision) => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.grantLocalExec();
    const approval = vi.fn(async () => {
      if (decision === 'error') throw new Error('private approval transport detail');
      return 'E_ACTION_APPROVAL_DENIED';
    });
    const tools = await toolsWithApproval(approval, 'full');
    for (const name of ['bash', 'interactive_cli_start']) {
      const result = await tools.find(tool => tool.name === name)!.execute({ command: 'mkdir forbidden' }, context());
      expect(result.isError).toBe(true);
      expect(result.content).toContain(decision === 'deny' ? 'E_ACTION_APPROVAL_DENIED' : 'E_ACTION_APPROVAL_UNAVAILABLE');
      expect(result.content).not.toContain('private approval transport detail');
      expect(fs.existsSync(path.join(workspace, 'forbidden'))).toBe(false);
    }
    expect(approval).toHaveBeenCalledTimes(2);
  });

  it('keeps filesystem rejection ahead of receiver approval', async () => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('workspace_approval');
    const approval = vi.fn(async () => null);
    const bash = (await toolsWithApproval(approval)).find(tool => tool.name === 'bash')!;
    const result = await bash.execute({ command: 'mkdir ../outside' }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_BASH_PATH_OUT_OF_SCOPE');
    expect(approval).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'outside'))).toBe(false);
  });

  it('uses one unified decision for a sensitive path and never falls back to shell-risk grants', async () => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const bashPermissions = await import('../../../../src/main/model/core-agent/bash-permissions');
    const riskPrompt = vi.fn((_channel: string, info: any) => bashPermissions.respond(info.request_id, 'allow_run'));
    bashPermissions._setBroadcastForTest(riskPrompt);
    const approval = vi.fn(async () => null);
    const bash = (await toolsWithApproval(approval)).find(tool => tool.name === 'bash')!;
    expect((await bash.execute({ command: 'mkdir id_rsa', timeoutMs: SHELL_COMMAND_TIMEOUT_MS }, context())).isError).toBeFalsy();
    expect(approval).toHaveBeenCalledTimes(1);
    expect(riskPrompt).not.toHaveBeenCalled();
  });

  it('cancels a pending unified receiver approval before any execution', async () => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.grantLocalExec();
    const approvals = await import('../../../../src/main/features/action_approval');
    const { requestReceptionShellApproval } = await import('../../../../src/main/features/a2a/reception-approval');
    const controller = new AbortController();
    approvals._setActionApprovalBroadcastForTest(() => { controller.abort(); });
    const hook = (input: any) => requestReceptionShellApproval({
      ...input, userId: uid, runtimeSessionId: 'gchat:a2a-bidirectional', requestId: 'turn-cancel',
    });
    const bash = (await toolsWithApproval(hook)).find(tool => tool.name === 'bash')!;
    const result = await bash.execute({ command: 'mkdir cancelled' }, context(controller.signal));
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('E_ACTION_APPROVAL_CANCELLED') });
    expect(fs.existsSync(path.join(workspace, 'cancelled'))).toBe(false);
  });

  it('keeps ordinary low-risk local execution unchanged without the reception hook', async () => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.grantLocalExec();
    const bash = (await toolsWithApproval()).find(tool => tool.name === 'bash')!;
    expect((await bash.execute({ command: 'mkdir local-own', timeoutMs: SHELL_COMMAND_TIMEOUT_MS }, context())).isError).toBeFalsy();
    expect(fs.existsSync(path.join(workspace, 'local-own'))).toBe(true);
  });

  it('retains receiver denial when the real SDK runner assembles its shell tools', async () => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.grantLocalExec();
    const auth = await import('../../../../src/main/features/auth');
    vi.spyOn(auth, 'pickChatEntryGroupForUser').mockResolvedValue([
      { entryId: 'test-entry', profileId: 'test-profile', provider: 'openai', model: 'gpt-4o', apiKey: 'synthetic-key' },
    ]);
    const { buildRunner } = await import('../../../../src/main/model/core-agent/runner');
    const approval = vi.fn(async () => 'E_ACTION_APPROVAL_DENIED');
    const built = await buildRunner({
      userId: uid, cid: 'a2a-bidirectional', sessionId: 'gconv-reception-approval',
      ephemeralSession: true, skillList: [], permissionMode: 'full', beforeShellApproval: approval,
    });
    // No inference is run: exercise the assembled SDK tool at the execution boundary.
    const bash = (built.runner as any).tools.get('bash');
    const result = await bash.execute({ command: 'mkdir runner-denied' }, context());
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('E_ACTION_APPROVAL_DENIED') });
    expect(approval).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(workspace, 'runner-denied'))).toBe(false);
  });
});
