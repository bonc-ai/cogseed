/**
 * S2 (B2) 红测：可信接待回合的**工具上下文不是单根**。
 *
 * 合同（方案 §4.1-3/4/5）：一次已确认的接待回合只能读写「已确认根 R」（marker.workspace），
 * R 之外的全局 workspace、附件目录、extra roots、只读 extra roots、以及 allow-all 模式
 * 都不能成为它的可见根。审批（每次写/执行问接收方本人）只解决「谁同意」，不解决「能碰哪里」，
 * 两者必须同时成立。
 *
 * 本文件**不复刻**装配逻辑也不 mock 被验证的检查，而是走真实生产入口：
 *   1. `handleInboundQuestion` → `previewReceptionWorkspace` → `confirmReception`
 *      —— 真实确认链，写出 marker.workspace 并把 `coding_project_dir` 固化成 R；
 *   2. `conv_workspace.getConversationWorkspacePath` —— 真实执行 cwd 解析器；
 *   3. `createFileTools` / `createLocalTools` —— 真实文件工具/本地工具入口，选项集合与
 *      `group_chat/bus.ts` 交给 runner 的一致（`receptionRoot=R` 由 runner 从
 *      `receptionScope.root` 透传；extraRoots 仅作“旧并集仍然存在”的负例输入、
 *      permissionMode='ask'、逐次审批回调），只把 LLM 换掉；
 *   4. 末尾一条真实 `bus.enqueue(externalInbound)` → `streamChatWithModel` → `buildRunner`
 *      → `AgentRunner` → tool 执行 → 第二个 provider 请求，证明生产把
 *      `receptionScope.root` 真的交到了工具层，而不是测试自塞选项。
 *
 * 实现后这些断言必须全绿。`RED:` 前缀保留为历史用例名（用来对照主代理的红基线），
 * 不代表当前仍应失败；不带前缀的是正对照/事实固定。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
import { FILE_SYMLINKS_SUPPORTED } from '../../../helpers/fs-capabilities';
import { RECEPTION_SHELL_SANDBOX_AVAILABLE } from '../../../helpers/reception-platform';
import type { ShellApprovalDecision, ShellApprovalInput } from '../../../../src/main/model/client';

// The real bus → client → runner chain imports Electron and electron-log. The
// direct tool cases below never need either, so the mocks are inert for them.
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-s2-test', getName: () => 'cogseed-s2-test' },
  BrowserWindow: class {},
  dialog: {},
  shell: {},
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  initLogger: () => {},
  logFromRenderer: () => {},
  redact: (value: unknown) => value,
  sweepLogs: () => ({ removed: 0, remaining: 0, totalBytes: 0 }),
}));

// P0-1: a reception descendant dispatch to an external target must be refused
// BEFORE any CLI/gateway spawn. These mocks make a would-be spawn observable
// (and keep a broken gate from hanging on the first-launch confirmation).
const gatewayTurnCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../../../src/main/features/p3394_bridge/p3394-gateway-turn', () => ({
  runP3394GatewayTurn: vi.fn(async (input: Record<string, unknown>) => {
    gatewayTurnCalls.push(input);
    return { text: 'GATEWAY-SHOULD-NOT-RUN', produced: [] as string[] };
  }),
}));
vi.mock('../../../../src/main/features/local_agents/launch_confirm', () => ({
  requestLaunchConfirm: vi.fn(async () => true),
}));


const UID = 'u-s2-tool-scope';
const PEER = 'cs_peer_s2';
const CID = 'a2a-40123456789abcdef012';

let tmp: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-s2-scope-')));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  // 数据容器也放进临时目录：默认 workspace 是 WS_ROOT/../userWorkSpace，这样它同样被清理。
  process.env.COGSEED_WORKSPACE_ROOT = path.join(tmp, 'data');
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 当前产品最严的本地访问模式：只允许 workspace/附件，敏感操作再单独审批。 */
async function useStrictestAccessMode(): Promise<void> {
  const permissions = await import('../../../../src/main/features/permissions');
  permissions.setLocalExecMode('workspace_approval');
}

/**
 * 走真实链路建立一个「已确认的接待」：入站问题 → 预览 → 确认。
 * R 由 mkdtemp 放在容器外（tmp 已 realpath，保证 marker 授权校验能通过）。
 */
async function seedConfirmedReception(): Promise<{ granted: string; globalWorkspace: string }> {
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(UID), {
    version: 1,
    contacts: [{ userId: PEER, name: 'Peer', addedAt: new Date().toISOString() }],
  });

  const service = await import('../../../../src/main/features/a2a/reception-service');
  const admitted = await service.handleInboundQuestion(UID, {
    conversationId: CID,
    messageId: 'amsg-s2-scope-1',
    fromAccount: PEER,
    text: 'Please read the note I put in the folder.',
  });
  expect(admitted.accepted).toBe(true);

  const granted = fs.mkdtempSync(path.join(tmp, 'granted-root-'));
  fs.writeFileSync(path.join(granted, 'inside.md'), 'INSIDE-THE-GRANTED-ROOT\n', 'utf8');

  const preview = await service.previewReceptionWorkspace(UID, { conversationId: CID, workspace: granted });
  if ('error' in preview) throw new Error(`preview failed: ${preview.error}`);
  const confirmed = await service.confirmReception(UID, {
    conversationId: CID,
    workspace: granted,
    expectedPreview: preview.preview,
  });
  if ('error' in confirmed) throw new Error(`confirm failed: ${confirmed.error}`);
  expect(confirmed.marker.workspace).toBe(granted);
  expect(confirmed.marker.state).toBe('active');

  const userWorkspace = await import('../../../../src/main/features/user_workspace');
  const globalWorkspace = userWorkspace.getWorkspacePath(UID);
  expect(globalWorkspace).not.toBe(granted);
  return { granted, globalWorkspace };
}

/** 与 bus→runner 交给工具层的一致：receptionRoot = 已确认根 R。
 *  runner.ts 在 params.receptionScope 存在时传入 `receptionScope.root`；
 *  这里显式传同一个值，模拟生产透传（真实链路断言见文件末尾）。 */
async function buildReceptionFileTools(granted: string) {
  const fileTools = await import('../../../../src/main/model/core-agent/file-tools');
  return fileTools.createFileTools({
    userId: UID,
    cid: CID,
    receptionRoot: granted,
    extraRoots: [granted],
    permissionMode: 'ask',
  });
}

type WriteApproval = (input: { toolName: 'write_file' | 'edit_file'; path: string; content: string }) => Promise<string | null>;
type ShellApproval = (input: ShellApprovalInput) => Promise<ShellApprovalDecision>;

async function buildReceptionLocalTools(
  granted: string,
  hooks: { beforeWriteApproval?: WriteApproval; beforeShellApproval?: ShellApproval } = {},
) {
  const localTools = await import('../../../../src/main/model/core-agent/local-tools');
  return localTools.createLocalTools({
    userId: UID,
    cid: CID,
    receptionRoot: granted,
    extraRoots: [granted],
    permissionMode: 'ask',
    ...(hooks.beforeWriteApproval ? { beforeWriteApproval: hooks.beforeWriteApproval } : {}),
    ...(hooks.beforeShellApproval ? { beforeShellApproval: hooks.beforeShellApproval } : {}),
  });
}

type Tool = { name: string; execute: (input: Record<string, unknown>, ctx: unknown) => Promise<{ content: string; isError?: boolean }> };

function toolByName(tools: Tool[], name: string): Tool {
  const found = tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

/** cwd = 已确认根 R —— 接待回合真实的工作目录。 */
async function runTool(tools: Tool[], name: string, input: Record<string, unknown>, granted: string) {
  return toolByName(tools, name).execute(input, { workingDir: granted, state: {}, signal: undefined });
}

/** The real `bash` tool spawns only through `SandboxExecutor.execute*`. Spying
 *  that prototype proves "no spawn happened" for a statically refused form
 *  without executing anything if the guard ever regresses: the spy returns a
 *  marker result instead of launching a child. */
async function spyOnSandboxSpawn(): Promise<{ calls: string[]; restore: () => void }> {
  const executor = await import('../../../../src/core-agent/src/sandbox/executor');
  const calls: string[] = [];
  const execute = vi.spyOn(executor.SandboxExecutor.prototype, 'execute').mockImplementation(async () => {
    calls.push('foreground');
    return {
      stdout: 'SPAWN-SHOULD-NOT-RUN',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      outputLimitExceeded: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      durationMs: 0,
    } as never;
  });
  const background = vi.spyOn(executor.SandboxExecutor.prototype, 'executeBackground').mockImplementation(() => {
    calls.push('background');
    return { pid: null, error: 'SPAWN-SHOULD-NOT-RUN' };
  });
  return {
    calls,
    restore: () => {
      execute.mockRestore();
      background.mockRestore();
    },
  };
}

describe('S2 接待工具上下文单根（已确认根 R）', () => {
  it('cwd 就是已确认根，且接待声明的读根也只有 R（现状事实固定）', async () => {
    await useStrictestAccessMode();
    const { granted } = await seedConfirmedReception();

    const convWorkspace = await import('../../../../src/main/features/group_chat/conv_workspace');
    expect(await convWorkspace.getConversationWorkspacePath(UID, CID)).toBe(granted);

    const chats = await import('../../../../src/main/features/chats');
    const marker = (await chats.getConversation(UID, CID))?.a2a;
    const scope = await import('../../../../src/main/features/a2a/reception-scope');
    expect(scope.isReceptionRun(marker as never)).toBe(true);
    expect(scope.receptionReadRoots(marker as never)).toEqual([granted]);
  });

  it('正对照：已确认根内的读取被允许', async () => {
    await useStrictestAccessMode();
    const { granted } = await seedConfirmedReception();
    const tools = await buildReceptionFileTools(granted);
    const result = await runTool(tools, 'read_file', { path: path.join(granted, 'inside.md') }, granted);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('INSIDE-THE-GRANTED-ROOT');
  });

  it('RED: 接待回合读到已确认根之外的全局 workspace 文件', async () => {
    await useStrictestAccessMode();
    const { granted, globalWorkspace } = await seedConfirmedReception();
    const outsidePath = path.join(globalWorkspace, 'local-private-notes.md');
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
    fs.writeFileSync(outsidePath, 'OUTSIDE-THE-GRANTED-ROOT\n', 'utf8');
    // 前置：这条路径确实不在 R 内（不是 R 的子目录，也不是系统临时目录本身）。
    expect(outsidePath.startsWith(granted + path.sep)).toBe(false);

    const tools = await buildReceptionFileTools(granted);
    const result = await runTool(tools, 'read_file', { path: outsidePath }, granted);

    // 期望：R 之外的读取必须被拒绝。
    expect(result.isError, 'read_file 在接待回合允许了已确认根之外的文件').toBe(true);
    expect(result.content).toContain('E_PATH_OUT_OF_SCOPE');
  });

  it('RED: 接待回合（接收方已批准这一次写）写到已确认根之外', async () => {
    await useStrictestAccessMode();
    const { granted, globalWorkspace } = await seedConfirmedReception();
    const outsidePath = path.join(globalWorkspace, 'reception-escape.md');
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true });

    const approvalsAsked: string[] = [];
    const tools = await buildReceptionLocalTools(granted, {
      beforeWriteApproval: async (input) => {
        approvalsAsked.push(input.path);
        return null; // 接收方批准了这一次写
      },
    });
    const result = await runTool(tools, 'write_file', { path: outsidePath, content: 'ESCAPED\n' }, granted);

    // 期望：审批只能回答「谁同意」，不能把写权限扩到 R 之外。
    expect(
      result.isError,
      `write_file 在接待回合把接收方的批准当成了根外写权限（审批被问到的路径：${approvalsAsked.join(',') || '无'}）`,
    ).toBe(true);
    expect(result.content).toContain('E_PATH_OUT_OF_SCOPE');
    expect(fs.existsSync(outsidePath), '根外文件被真实写入').toBe(false);
  });

  // 这个用例的正对照需要一次真实的接待 shell；严格 profile 只存在于 macOS。
  it.skipIf(!RECEPTION_SHELL_SANDBOX_AVAILABLE)('RED: 接待回合的 shell 读到已确认根之外（接收方已批准这一次执行）', async () => {
    await useStrictestAccessMode();
    const { granted, globalWorkspace } = await seedConfirmedReception();
    const outsidePath = path.join(globalWorkspace, 'shell-local-secret.md');
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
    fs.writeFileSync(outsidePath, 'SHELL-OUTSIDE-THE-GRANTED-ROOT\n', 'utf8');

    const tools = await buildReceptionLocalTools(granted, {
      beforeShellApproval: async () => null, // 接收方批准了这一次执行
    });
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

    // 阳性对照：同一个 bash 工具、同一个审批，读 R 内必须成功。
    // 它同时排掉"sandbox-exec 在本机直接失败"造成的假绿。
    const insideResult = await runTool(tools, 'bash', { command: `cat ${quote(path.join(granted, 'inside.md'))}` }, granted);
    expect(insideResult.isError, `R 内 bash 读取应当成功（若失败说明本机 shell/沙箱环境坏了，不是本用例的结论）：${insideResult.content}`).toBeFalsy();
    expect(insideResult.content).toContain('INSIDE-THE-GRANTED-ROOT');

    const result = await runTool(tools, 'bash', { command: `cat ${quote(outsidePath)}` }, granted);

    // 期望：R 之外的读也不允许；当前 macOS 写沙箱是 (allow default)，读根本不设限。
    expect(result.isError, 'bash 在接待回合读到了已确认根之外的文件').toBe(true);
    expect(result.content).not.toContain('SHELL-OUTSIDE-THE-GRANTED-ROOT');
  });

  it('RED: 产品默认访问模式（all_files_approval）把整台机器变成接待回合的可读根', async () => {
    // 默认模式本身就是 allow-all 的读范围（permissions.DEFAULT_MODE）。
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const { granted } = await seedConfirmedReception();

    const neitherDir = path.join(tmp, 'neither-granted-nor-workspace');
    fs.mkdirSync(neitherDir, { recursive: true });
    const neitherPath = path.join(neitherDir, 'unrelated-secret.md');
    fs.writeFileSync(neitherPath, 'NOT-IN-ANY-ROOT\n', 'utf8');

    const tools = await buildReceptionFileTools(granted);
    const result = await runTool(tools, 'read_file', { path: neitherPath }, granted);

    expect(result.isError, 'allow-all 模式下接待回合读到了任何根之外的文件').toBe(true);
    expect(result.content).toContain('E_PATH_OUT_OF_SCOPE');
  });
});

// ── Matrix: positive / negative controls ─────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function buildFileToolsWith(opts: Record<string, unknown>) {
  const fileTools = await import('../../../../src/main/model/core-agent/file-tools');
  return fileTools.createFileTools({
    userId: UID,
    cid: CID,
    permissionMode: 'ask',
    ...opts,
  } as never);
}

async function buildLocalToolsWith(opts: Record<string, unknown>) {
  const localTools = await import('../../../../src/main/model/core-agent/local-tools');
  return localTools.createLocalTools({
    userId: UID,
    cid: CID,
    permissionMode: 'ask',
    ...opts,
  } as never);
}

describe('S2 接待工具上下文矩阵：单根天花板 + 逐次审批', () => {
  it('根内读写成功；每次写都单独问接收方，拒绝不产生副作用', async () => {
    await useStrictestAccessMode();
    const { granted } = await seedConfirmedReception();

    const target = path.join(granted, 'nested', 'matrix-note.md');
    const approved: string[] = [];
    const writer = await buildLocalToolsWith({
      receptionRoot: granted,
      extraRoots: [granted],
      beforeWriteApproval: async (input: { path: string }) => {
        approved.push(input.path);
        return null;
      },
    });
    const written = await runTool(writer, 'write_file', { path: target, content: 'MATRIX-INSIDE-WRITE\n' }, granted);
    expect(written.isError, `in-root write should succeed: ${written.content}`).toBeFalsy();
    expect(fs.readFileSync(target, 'utf8')).toBe('MATRIX-INSIDE-WRITE\n');
    // One approval request per write, for the exact target path.
    expect(approved).toEqual([target]);

    const reader = await buildFileToolsWith({ receptionRoot: granted, extraRoots: [granted] });
    const readBack = await runTool(reader, 'read_file', { path: target }, granted);
    expect(readBack.isError).toBeFalsy();
    expect(readBack.content).toContain('MATRIX-INSIDE-WRITE');

    // A second write denied by the receiver must not touch the file.
    const denier = await buildLocalToolsWith({
      receptionRoot: granted,
      extraRoots: [granted],
      beforeWriteApproval: async () => 'E_ACTION_APPROVAL_DENIED',
    });
    const denied = await runTool(denier, 'write_file', { path: target, content: 'SHOULD-NOT-REPLACE\n' }, granted);
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('E_ACTION_APPROVAL_DENIED');
    expect(fs.readFileSync(target, 'utf8')).toBe('MATRIX-INSIDE-WRITE\n');
  });

  it('根外读、写、符号链接逃逸与 bash 写入全部拒绝且无副作用', async () => {
    await useStrictestAccessMode();
    const { granted, globalWorkspace } = await seedConfirmedReception();

    const outsideDir = path.join(globalWorkspace, 'matrix-outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, 'secret.md');
    fs.writeFileSync(outside, 'MATRIX-OUTSIDE-SECRET\n', 'utf8');

    const reader = await buildFileToolsWith({ receptionRoot: granted, extraRoots: [granted] });
    const outsideRead = await runTool(reader, 'read_file', { path: outside }, granted);
    expect(outsideRead.isError).toBe(true);
    expect(outsideRead.content).toContain('E_PATH_OUT_OF_SCOPE');
    expect(outsideRead.content).not.toContain('MATRIX-OUTSIDE-SECRET');

    // A symlink planted inside R must not exfiltrate the out-of-root target.
    // Both directions need the link capability itself; where the account cannot
    // create one there is no escape fixture to assert against.
    const link = path.join(granted, 'escape-link.md');
    if (FILE_SYMLINKS_SUPPORTED) {
      fs.symlinkSync(outside, link);
      const linkRead = await runTool(reader, 'read_file', { path: link }, granted);
      expect(linkRead.isError).toBe(true);
      expect(linkRead.content).toContain('E_PATH_OUT_OF_SCOPE');
      expect(linkRead.content).not.toContain('MATRIX-OUTSIDE-SECRET');
    }

    const writer = await buildLocalToolsWith({
      receptionRoot: granted,
      extraRoots: [granted],
      beforeWriteApproval: async () => null,
      beforeShellApproval: async () => null,
    });
    const outsideWrite = await runTool(writer, 'write_file', {
      path: path.join(outsideDir, 'escape.md'),
      content: 'MATRIX-ESCAPE\n',
    }, granted);
    expect(outsideWrite.isError).toBe(true);
    expect(outsideWrite.content).toContain('E_PATH_OUT_OF_SCOPE');

    if (FILE_SYMLINKS_SUPPORTED) {
      const linkWrite = await runTool(writer, 'write_file', { path: link, content: 'MATRIX-LINK-ESCAPE\n' }, granted);
      expect(linkWrite.isError).toBe(true);
      expect(linkWrite.content).toContain('E_PATH_OUT_OF_SCOPE');
      expect(fs.readFileSync(outside, 'utf8')).toBe('MATRIX-OUTSIDE-SECRET\n');
    }

    const shellEscapePath = path.join(outsideDir, 'bash-escape.md');
    const shellEscape = await runTool(writer, 'bash', {
      command: `printf 'MATRIX-BASH-ESCAPE' > ${shellQuote(shellEscapePath)}`,
    }, granted);
    expect(shellEscape.isError).toBe(true);
    expect(fs.existsSync(shellEscapePath)).toBe(false);

    // Positive control: the very same bash tool/cwd/approval can read inside R
    // wherever a trusted reception shell exists; elsewhere the documented
    // fail-closed refusal is the contract (see sandbox/executor.ts).
    const insideBash = await runTool(writer, 'bash', {
      command: `cat ${shellQuote(path.join(granted, 'inside.md'))}`,
    }, granted);
    if (RECEPTION_SHELL_SANDBOX_AVAILABLE) {
      expect(insideBash.isError, `in-root bash must still work: ${insideBash.content}`).toBeFalsy();
      expect(insideBash.content).toContain('INSIDE-THE-GRANTED-ROOT');
    } else {
      expect(insideBash.isError, `a reception shell must fail closed here: ${insideBash.content}`).toBe(true);
      expect(insideBash.content).toContain('E_SANDBOX_UNAVAILABLE');
    }
  });

  it('bash 的 cwd 不在确认根内时拒绝执行', async () => {
    await useStrictestAccessMode();
    const { granted, globalWorkspace } = await seedConfirmedReception();
    const writer = await buildLocalToolsWith({
      receptionRoot: granted,
      extraRoots: [granted],
      beforeShellApproval: async () => null,
    });
    const result = await runTool(writer, 'bash', { command: 'echo should-not-run' }, globalWorkspace);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_BASH_CWD_OUT_OF_SCOPE');
    expect(result.content).not.toContain('should-not-run\n');
  });

  it('receptionRoot 不是现存目录时 fail closed，不回退默认根', async () => {
    await useStrictestAccessMode();
    const { granted } = await seedConfirmedReception();
    const missing = path.join(tmp, 'missing-reception-root');

    const reader = await buildFileToolsWith({ receptionRoot: missing, extraRoots: [granted] });
    const read = await runTool(reader, 'read_file', { path: path.join(granted, 'inside.md') }, granted);
    expect(read.isError).toBe(true);
    expect(read.content).toContain('E_RECEPTION_ROOT_UNAVAILABLE');

    const writer = await buildLocalToolsWith({
      receptionRoot: missing,
      extraRoots: [granted],
      beforeWriteApproval: async () => null,
      beforeShellApproval: async () => null,
    });
    const escapedTarget = path.join(granted, 'should-not-exist.md');
    const written = await runTool(writer, 'write_file', { path: escapedTarget, content: 'X' }, granted);
    expect(written.isError).toBe(true);
    expect(written.content).toContain('E_RECEPTION_ROOT_UNAVAILABLE');
    expect(fs.existsSync(escapedTarget)).toBe(false);

    const shell = await runTool(writer, 'bash', { command: 'echo still-not-run' }, granted);
    expect(shell.isError).toBe(true);
    expect(shell.content).toContain('E_RECEPTION_ROOT_UNAVAILABLE');
  });

  it('普通本地回合（无 receptionRoot）的既有可见范围不变', async () => {
    await useStrictestAccessMode();
    const { granted, globalWorkspace } = await seedConfirmedReception();
    const workspaceFile = path.join(globalWorkspace, 'ordinary-workspace.md');
    fs.writeFileSync(workspaceFile, 'ORDINARY-WORKSPACE-OK\n', 'utf8');

    const reader = await buildFileToolsWith({ extraRoots: [granted] }); // no receptionRoot
    const wsRead = await runTool(reader, 'read_file', { path: workspaceFile }, granted);
    expect(wsRead.isError).toBeFalsy();
    expect(wsRead.content).toContain('ORDINARY-WORKSPACE-OK');

    // The all-files mode keeps its existing allow-all read lane outside reception.
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const arbitrary = path.join(tmp, 'ordinary-arbitrary.md');
    fs.writeFileSync(arbitrary, 'ORDINARY-ALL-FILES-OK\n', 'utf8');
    const allFilesRead = await runTool(reader, 'read_file', { path: arbitrary }, granted);
    expect(allFilesRead.isError).toBeFalsy();
    expect(allFilesRead.content).toContain('ORDINARY-ALL-FILES-OK');
  });
});

// ── Real production chain: bus → client → buildRunner → tool layer ───────

const CHAIN_MARKER = 'S2CHAIN_EXTERNAL_Q_7F3A';
const CHAIN_INSIDE = 'S2CHAIN_INSIDE_OK_1B4C';
const CHAIN_OUTSIDE = 'S2CHAIN_OUTSIDE_SECRET_9C2D';

interface CapturedProviderRequest {
  url: string;
  body: any;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textSse(text: string): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: `msg_s2_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 16, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
}

function toolUseSse(calls: ReadonlyArray<{ id: string; name: string; input: Record<string, unknown> }>): string {
  const events: string[] = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: `msg_s2_tool_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 24, output_tokens: 0 },
      },
    }),
  ];
  calls.forEach((call, index) => {
    events.push(sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
    }));
    events.push(sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
    }));
    events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
  });
  events.push(sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 16 },
  }));
  events.push(sseEvent('message_stop', { type: 'message_stop' }));
  return events.join('');
}

async function waitForQuiescent(cid: string, timeoutMs = 60_000): Promise<void> {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (bus.isQuiescent(UID, cid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`group chat bus did not quiesce within ${timeoutMs}ms`);
}

describe('S2 生产链路：真实 bus→runner 把 receptionScope.root 交到工具层', () => {
  it('根外 read_file 在真实接待回合被拒，且旁路工具没有出现在 provider tools[]', async () => {
    await useStrictestAccessMode();
    const { granted, globalWorkspace } = await seedConfirmedReception();
    const insidePath = path.join(granted, 'chain-inside.md');
    fs.writeFileSync(insidePath, `${CHAIN_INSIDE}\n`, 'utf8');
    const outsidePath = path.join(globalWorkspace, 'chain-outside-secret.md');
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
    fs.writeFileSync(outsidePath, `${CHAIN_OUTSIDE}\n`, 'utf8');

    const envKeys = [
      'CORE_AGENT_AUTH_DIR',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_OAUTH_TOKEN',
      'COGSEED_KSTAR_HOST_ROUTING',
      'COGSEED_P3394_WAKE_GATE',
      'COGSEED_LEGACY_RUN_WORKER_TEST',
    ] as const;
    const previousEnv: Record<string, string | undefined> = {};
    for (const key of envKeys) previousEnv[key] = process.env[key];
    process.env.CORE_AGENT_AUTH_DIR = path.join(tmp, 'core-agent-auth');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-s2-tool-scope-placeholder';
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    process.env.COGSEED_KSTAR_HOST_ROUTING = '0';
    process.env.COGSEED_P3394_WAKE_GATE = '0';
    process.env.COGSEED_LEGACY_RUN_WORKER_TEST = '0';

    const providerRequests: CapturedProviderRequest[] = [];
    let toolCallIssued = false;
    const transport = async (input: any, init?: any): Promise<Response> => {
      const url = typeof input === 'string' ? input : String(input?.url ?? '');
      if (!/\/v1\/messages(?:\?|$)/.test(url)) {
        return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
      }
      let rawBody = '';
      if (typeof init?.body === 'string') rawBody = init.body;
      else if (input && typeof input.text === 'function') rawBody = await input.text();
      let body: any = null;
      try { body = rawBody ? JSON.parse(rawBody) : null; } catch { body = null; }
      providerRequests.push({ url, body });
      const messagesText = JSON.stringify(body?.messages ?? []);
      const isReceptionTurn = messagesText.includes(CHAIN_MARKER);
      if (isReceptionTurn && !toolCallIssued && !messagesText.includes('tool_result')) {
        toolCallIssued = true;
        return new Response(toolUseSse([
          { id: 'toolu_s2_outside', name: 'read_file', input: { path: outsidePath } },
          { id: 'toolu_s2_inside', name: 'read_file', input: { path: insidePath } },
        ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(textSse('S2CHAIN-FINAL-OK'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    vi.stubGlobal('fetch', transport);

    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const enqueued = await bus.enqueue({
        uid: UID,
        cid: CID,
        fromActorId: 'a2a_cs_peer_s2',
        forceTo: ['commander'],
        externalInbound: true,
        text: `公开问题（仅用于链路验证）：${CHAIN_MARKER}`,
      });
      expect(enqueued.to, 'fixture: the trusted external turn must dispatch to the commander').toContain('commander');
      await waitForQuiescent(CID);

      const turnRequests = providerRequests.filter((request) => (
        JSON.stringify(request.body?.messages ?? []).includes(CHAIN_MARKER)
      ));
      expect(
        turnRequests.length,
        `real bus→runner chain never reached the provider: requests=${providerRequests.length}`,
      ).toBeGreaterThanOrEqual(2);

      const toolResultRequest = turnRequests.find((request) => (
        JSON.stringify(request.body?.messages ?? []).includes('tool_result')
      ));
      expect(toolResultRequest, 'no follow-up provider request carrying tool results').toBeTruthy();
      const toolResultText = JSON.stringify(toolResultRequest!.body);
      // The outside read must fail with the explicit scope error, and the
      // inside positive control must be readable in the same real turn.
      expect(toolResultText).toContain('E_PATH_OUT_OF_SCOPE');
      expect(toolResultText).toContain(CHAIN_INSIDE);
      expect(toolResultText, 'the out-of-root secret reached the provider request').not.toContain(CHAIN_OUTSIDE);

      // Bypass closure is visible in the real provider tool definitions.
      const toolNames: string[] = (turnRequests[0].body?.tools ?? []).map((tool: any) => String(tool?.name ?? ''));
      for (const required of [
        'read_file', 'write_file', 'edit_file', 'bash', 'list_files', 'search_files',
        'kb_search', 'kb_read', 'material_search', 'material_list', 'ask_materials',
        'dispatch_to', 'hand_off_to', 'run_worker',
      ]) {
        expect(toolNames, `reception tool set lost the allowed tool ${required}`).toContain(required);
      }
      for (const blocked of [
        'web_fetch', 'web_search',
        'list_connector_tools', 'call_connector_tool',
        'interactive_cli_start', 'create_artifact',
        'create_docx', 'create_xlsx', 'create_pptx', 'edit_office', 'office_read',
        'generate_image', 'chat_search', 'chat_read',
        'delete_file', 'markdown_to_pdf', 'html_to_pdf',
        'cross_session_memory', 'metacognition', 'project_instructions',
        // P1-6 private read-only surfaces (the contract exempts only Library KB)
        'search_ability_assets', 'ontology_query',
        'list_task_experiences', 'read_task_experience',
        'personal_ontology_fields', 'personal_fields_check',
        'cognition_ontology_query', 'transcript_corrections_query',
        'auto_tasks_list', 'marketplace_search', 'attach_assets_to_task',
      ]) {
        expect(toolNames, `bypass tool ${blocked} must not be offered on a trusted reception turn`).not.toContain(blocked);
      }
    } finally {
      vi.unstubAllGlobals();
      try {
        const bus = await import('../../../../src/main/features/group_chat/bus');
        await bus.dropConv(UID, CID);
      } catch { /* teardown is best effort */ }
      await drainMainRuntimeForTest(UID);
      for (const key of envKeys) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
      }
    }
  }, 120_000);
});

// ── Round 2: P1-2 approval-window target swap ───────────────────────────

describe('S2 round 2: approval-window canonical re-check', () => {
  // The approval-window swap plants a symlink from inside R to an out-of-root
  // target; without the link capability the race cannot be constructed.
  it.skipIf(!FILE_SYMLINKS_SUPPORTED)('write_file refuses a target swapped to an out-of-root symlink while the receiver is deciding', async () => {
    await useStrictestAccessMode();
    const { granted } = await seedConfirmedReception();
    const outside = path.join(tmp, 'approval-outside-write.md');
    fs.writeFileSync(outside, 'APPROVAL-OUTSIDE-WRITE\n', 'utf8');
    const target = path.join(granted, 'approval-swapped-write.md');

    const tools = await buildLocalToolsWith({
      receptionRoot: granted,
      beforeWriteApproval: async (input: { path: string }) => {
        expect(input.path, 'the approval must name the final target').toBe(target);
        fs.symlinkSync(outside, target); // local process swaps the target mid-approval
        return null; // receiver approved this write
      },
    });
    const result = await runTool(tools, 'write_file', { path: target, content: 'APPROVAL-WINDOW-ESCAPE\n' }, granted);
    expect(result.isError, 'write_file wrote through a symlink swapped during approval').toBe(true);
    expect(result.content).toContain('E_PATH_OUT_OF_SCOPE');
    expect(fs.readFileSync(outside, 'utf8')).toBe('APPROVAL-OUTSIDE-WRITE\n');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it.skipIf(!FILE_SYMLINKS_SUPPORTED)('edit_file refuses a target swapped to an out-of-root symlink while the receiver is deciding', async () => {
    await useStrictestAccessMode();
    const { granted } = await seedConfirmedReception();
    const outside = path.join(tmp, 'approval-outside-edit.md');
    fs.writeFileSync(outside, 'APPROVAL-EDIT-OUTSIDE\n', 'utf8');
    const target = path.join(granted, 'approval-swapped-edit.md');
    fs.writeFileSync(target, 'APPROVAL-EDIT-ORIGINAL\n', 'utf8');

    const tools = await buildLocalToolsWith({
      receptionRoot: granted,
      beforeWriteApproval: async () => {
        fs.unlinkSync(target);
        fs.symlinkSync(outside, target); // replace the approved file mid-approval
        return null; // receiver approved this edit
      },
    });
    const result = await runTool(tools, 'edit_file', {
      path: target,
      old_string: 'APPROVAL-EDIT-ORIGINAL',
      new_string: 'APPROVAL-EDIT-ESCAPED',
    }, granted);
    expect(result.isError, 'edit_file wrote through a symlink swapped during approval').toBe(true);
    expect(result.content).toContain('E_PATH_OUT_OF_SCOPE');
    expect(fs.readFileSync(outside, 'utf8')).toBe('APPROVAL-EDIT-OUTSIDE\n');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });
});

// ── Round 2: P0-2 static + OS combination ────────────────────────────────

describe('S2 round 2: bash cwd/script-injection fail-closed', () => {
  // 这批形态是 bash 语法（管道进 sh、`sh < 脚本`、反斜杠续行）。Windows 的主机
  // shell 是 PowerShell，同一串命令会被判成 E_SHELL_SYNTAX_MISMATCH——同样是
  // spawn 之前的 fail-closed，但断言的是另一条分支，故按 POSIX 平台运行。
  it.skipIf(process.platform === 'win32')('refuses literal and known-indirect cwd/script-injection forms before approval or spawn', async () => {
    await useStrictestAccessMode();
    const { granted } = await seedConfirmedReception();
    const approvals: string[] = [];
    const tools = await buildReceptionLocalTools(granted, {
      beforeShellApproval: async (input) => {
        approvals.push(input.command);
        return null;
      },
    });

    const forms = [
      // Literal forms (round 2 baseline).
      'cd; cat .ssh/id_rsa',
      'cd /tmp',
      'pushd /tmp',
      'popd',
      `source ${shellQuote(path.join(tmp, 'outside-script.sh'))}`,
      `. ${shellQuote(path.join(tmp, 'outside-script.sh'))}`,
      `eval 'cat /etc/hosts'`,
      'git -C /tmp status',
      `bash -c 'cat /etc/hosts'`,
      `(cd /tmp; cat passwd)`,
      `sudo -u root cd /tmp`,
      // Backslash-escaped command words: the shell drops the backslash, so
      // `\cd` and `\s\o\u\r\c\e` run `cd` / `source`.
      '\\cd; cat .ssh/id_rsa',
      '\\s\\o\\u\\r\\c\\e /tmp/outside-script.sh',
      // Variable indirection in command position after an assignment.
      'C=cd; $C; cat .ssh/id_rsa',
      'C=cd; ${C}; cat .ssh/id_rsa',
      // Command substitution and backticks anywhere on the line.
      '$(echo cd) /tmp',
      '`echo cd` /tmp',
      // Pipe / stdin redirection into a shell (body invisible to the scanner).
      `printf 'cd /tmp\ncat .ssh/id_rsa\n' | sh`,
      `printf 'cat /etc/hosts\n' | /bin/sh`,
      `printf 'id\n' | bash`,
      `printf 'id\n' | zsh`,
      `sh < ${shellQuote(path.join(tmp, 'outside-script.sh'))}`,
      // Function definitions (bodies are not inspected; unparseable ones too).
      'f() { cd /tmp; cat .ssh/id_rsa; }; f',
      'function f { cd /tmp; }',
      'f () { source /tmp/outside-script.sh; }',
      'f(){ cd /tmp; }',
      // Backslash-newline continuation (`c\` newline `d` runs `cd`).
      'c\\\nd /tmp',
    ];

    // Any guard regression must be visible as E_BASH_UNPROVABLE (not as a real
    // execution): the spawn choke point is stubbed to a marker for this loop.
    const spawn = await spyOnSandboxSpawn();
    try {
      for (const command of forms) {
        const result = await runTool(tools, 'bash', { command }, granted);
        expect(result.isError, `must be refused: ${command}`).toBe(true);
        expect(result.content, command).toContain('E_BASH_UNPROVABLE_IN_RECEPTION');
        expect(result.content, `must not reach the spawn choke point: ${command}`).not.toContain('SPAWN-SHOULD-NOT-RUN');
      }
    } finally {
      spawn.restore();
    }
    expect(approvals, 'a statically refused form must never reach the receiver approval gate').toEqual([]);
    expect(spawn.calls, 'a statically refused form must never reach the executor/spawn entry').toEqual([]);

    // Positive controls: the same tool still runs plain in-root commands, and
    // the new heuristics do not reject ordinary text that merely contains
    // `function` or a quoted `f()`.
    //
    // 平台事实（见 test/helpers/reception-platform.ts 与
    // src/core-agent/src/sandbox/executor.ts）：严格接待 shell 只在 macOS 的
    // deny-default sandbox 下执行；Linux 没有等价的 OS 级证明，产品对**每一条**
    // 接待命令都 fail-closed（E_SANDBOX_UNAVAILABLE），这是文档化的安全结论，
    // 不是回归。所以正控制分两层断言：
    //   1) 静态层绝不误判——任何平台都不能落到 E_BASH_UNPROVABLE_IN_RECEPTION；
    //   2) 执行层——有 sandbox 的宿主必须真的跑出结果；没有的宿主必须落到
    //      文档化的 sandbox 拒绝码，且命令零副作用（不允许被静态层吞掉）。
    type BashResult = Awaited<ReturnType<typeof runTool>>;
    const expectNoStaticFalsePositive = (result: BashResult, label: string): void => {
      expect(
        result.content,
        `${label} must never be refused by the static guard: ${result.content}`,
      ).not.toContain('E_BASH_UNPROVABLE_IN_RECEPTION');
      if (RECEPTION_SHELL_SANDBOX_AVAILABLE) {
        expect(result.isError, `${label}: in-root foreground command must still run: ${result.content}`).toBeFalsy();
      } else {
        expect(result.isError, `${label}: this host has no trusted reception shell: ${result.content}`).toBe(true);
        expect(result.content, `${label}: expected the documented sandbox refusal`).toContain('E_SANDBOX_UNAVAILABLE');
      }
    };

    const inside = await runTool(tools, 'bash', {
      command: `printf 'STATIC-PASS function' > ${shellQuote(path.join(granted, 'static-pass.txt'))}`,
    }, granted);
    expectNoStaticFalsePositive(inside, 'in-root foreground command');
    if (RECEPTION_SHELL_SANDBOX_AVAILABLE) {
      expect(fs.readFileSync(path.join(granted, 'static-pass.txt'), 'utf8')).toBe('STATIC-PASS function');
    } else {
      expect(
        fs.existsSync(path.join(granted, 'static-pass.txt')),
        'a fail-closed reception shell must not execute the command at all',
      ).toBe(false);
    }

    const grepFunction = await runTool(tools, 'bash', {
      command: `grep function ${shellQuote(path.join(granted, 'static-pass.txt'))}`,
    }, granted);
    expectNoStaticFalsePositive(grepFunction, 'a plain "grep function"');
    if (RECEPTION_SHELL_SANDBOX_AVAILABLE) expect(grepFunction.content).toContain('STATIC-PASS function');

    const quotedParens = await runTool(tools, 'bash', {
      command: `printf '%s' 'f()'`,
    }, granted);
    expectNoStaticFalsePositive(quotedParens, 'a quoted f() argument');
    if (RECEPTION_SHELL_SANDBOX_AVAILABLE) expect(quotedParens.content).toContain('f()');
  }, 60_000);

  const sandboxReady = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
  it.skipIf(!sandboxReady)('OS evidence: a script body that hides `cd; cat <outside>` behind a probe is denied by the strict sandbox, not by the static layer', async () => {
    await useStrictestAccessMode();
    const { granted } = await seedConfirmedReception();
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'os-outside-')));
    const outsideFile = path.join(outsideDir, 'private.txt');
    fs.writeFileSync(outsideFile, 'S2OS_OUTSIDE_MARKER_4D2F\n', 'utf8');

    // The command line only mentions a script INSIDE R, so the static guard sees
    // no out-of-root path; the script body holds it. Any refusal can therefore
    // only come from the OS sandbox.
    const probe = path.join(granted, 'probe-cd-outside.sh');
    // Both the cwd change and the read target live only in the script body.
    // `cd` into a sandbox-denied directory and the absolute read are both
    // refused by the OS; the absolute read gives the unambiguous EPERM text.
    fs.writeFileSync(
      probe,
      `cd ${shellQuote(outsideDir)}\ncat ${shellQuote(path.join(outsideDir, 'private.txt'))}\n`,
      'utf8',
    );
    const insideProbe = path.join(granted, 'probe-inside.sh');
    fs.writeFileSync(insideProbe, `printf 'OS-INSIDE-OK' > inside-out.txt\ncat inside-out.txt\n`, 'utf8');

    const tools = await buildReceptionLocalTools(granted, {
      beforeShellApproval: async () => null,
    });

    // Positive control first: the sandbox is functional for in-root work.
    const inside = await runTool(tools, 'bash', { command: `sh ${shellQuote(insideProbe)}` }, granted);
    expect(inside.isError, `in-root sandboxed script must work: ${inside.content}`).toBeFalsy();
    expect(inside.content).toContain('OS-INSIDE-OK');

    // Real sandbox-exec must deny the hidden out-of-root read.
    const escaped = await runTool(tools, 'bash', { command: `sh ${shellQuote(probe)}` }, granted);
    expect(escaped.isError, 'the strict reception sandbox must refuse the hidden out-of-root read').toBe(true);
    expect(escaped.content).not.toContain('S2OS_OUTSIDE_MARKER_4D2F');
    expect(escaped.content, `expected an OS sandbox denial, got: ${escaped.content}`).toContain('Operation not permitted');

    // Attribution: the same probe in an ordinary local turn (allow-default read,
    // no receptionRoot) succeeds and prints the marker — so the denial above is
    // the reception strict sandbox, not a broken fixture/script.
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const ordinaryTools = await buildLocalToolsWith({
      beforeShellApproval: async () => null,
    });
    const ordinary = await runTool(ordinaryTools, 'bash', { command: `sh ${shellQuote(probe)}` }, granted);
    expect(ordinary.isError, `ordinary allow-default read should succeed: ${ordinary.content}`).toBeFalsy();
    expect(ordinary.content).toContain('S2OS_OUTSIDE_MARKER_4D2F');
    void outsideFile;
  }, 120_000);

  it.skipIf(!sandboxReady)('OS evidence: a tool-layer script that pipes a hidden out-of-root read into sh is denied by the strict sandbox, not by the static layer', async () => {
    await useStrictestAccessMode();
    const { granted } = await seedConfirmedReception();
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'os-pipe-outside-')));
    const outsideFile = path.join(outsideDir, 'private.txt');
    fs.writeFileSync(outsideFile, 'S2OS_PIPE_MARKER_9B71\n', 'utf8');

    // The command line that reaches the tool layer is only `sh <in-root script>`:
    // the pipe-to-shell bypass (`printf '…' | sh`) and the out-of-root path live
    // exclusively in the script body. The static guard therefore cannot be the
    // layer that denies this form — a refusal must come from the OS sandbox.
    const ranMarker = path.join(granted, 'pipe-probe-ran.txt');
    const probe = path.join(granted, 'probe-pipe-to-shell.sh');
    fs.writeFileSync(
      probe,
      `printf RAN > ${shellQuote(ranMarker)}\n`
      + `printf ${shellQuote(`cat ${outsideFile}\n`)} | sh\n`,
      'utf8',
    );

    const tools = await buildReceptionLocalTools(granted, {
      beforeShellApproval: async () => null,
    });
    const escaped = await runTool(tools, 'bash', { command: `sh ${shellQuote(probe)}` }, granted);
    expect(escaped.isError, 'the strict reception sandbox must refuse the hidden piped out-of-root read').toBe(true);
    expect(escaped.content).not.toContain('S2OS_PIPE_MARKER_9B71');
    expect(escaped.content, `expected an OS sandbox denial, got: ${escaped.content}`).toContain('Operation not permitted');
    // The script itself ran (in-root write), so the refusal is the OS denying
    // the piped read, not a fixture/script failure.
    expect(fs.existsSync(ranMarker), 'the probe script itself must have executed inside the sandbox').toBe(true);

    // Attribution: the same probe in an ordinary local turn succeeds and prints
    // the marker; the denial above belongs to the reception strict sandbox.
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const ordinaryTools = await buildLocalToolsWith({
      beforeShellApproval: async () => null,
    });
    const ordinary = await runTool(ordinaryTools, 'bash', { command: `sh ${shellQuote(probe)}` }, granted);
    expect(ordinary.isError, `ordinary allow-default pipe-to-shell should succeed: ${ordinary.content}`).toBeFalsy();
    expect(ordinary.content).toContain('S2OS_PIPE_MARKER_9B71');
  }, 120_000);
});

// ── Round 2: real production chain — write/bash approvals ────────────────

const ROUND2_ENV_KEYS = [
  'CORE_AGENT_AUTH_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'COGSEED_KSTAR_HOST_ROUTING',
  'COGSEED_P3394_WAKE_GATE',
  'COGSEED_LEGACY_RUN_WORKER_TEST',
] as const;

async function installReceptionProviderEnv(): Promise<Record<string, string | undefined>> {
  const previous: Record<string, string | undefined> = {};
  for (const key of ROUND2_ENV_KEYS) previous[key] = process.env[key];
  process.env.CORE_AGENT_AUTH_DIR = path.join(tmp, 'core-agent-auth');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-s2-round2-placeholder';
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  process.env.COGSEED_KSTAR_HOST_ROUTING = '0';
  process.env.COGSEED_P3394_WAKE_GATE = '0';
  process.env.COGSEED_LEGACY_RUN_WORKER_TEST = '0';
  return previous;
}

function restoreReceptionProviderEnv(previous: Record<string, string | undefined>): void {
  for (const key of ROUND2_ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

async function installReceptionApprovalResponder(
  decide: (request: any) => 'approve' | 'deny',
): Promise<{ requests: any[]; restore: () => void }> {
  const actionApproval = await import('../../../../src/main/features/action_approval');
  actionApproval._resetActionApprovalForTest();
  const requests: any[] = [];
  actionApproval._setActionApprovalBroadcastForTest((channel: string, payload: any) => {
    if (channel === 'action-approval:request') {
      requests.push(payload);
      void actionApproval.respondActionApproval(payload.request_id, decide(payload));
    }
    return true;
  });
  return { requests, restore: () => actionApproval._resetActionApprovalForTest() };
}

function captureProvider(handler: (body: any) => Response | null) {
  const requests: CapturedProviderRequest[] = [];
  const transport = async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input?.url ?? '');
    if (!/\/v1\/messages(?:\?|$)/.test(url)) {
      return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    }
    let rawBody = '';
    if (typeof init?.body === 'string') rawBody = init.body;
    else if (input && typeof input.text === 'function') rawBody = await input.text();
    let body: any = null;
    try { body = rawBody ? JSON.parse(rawBody) : null; } catch { body = null; }
    requests.push({ url, body });
    return handler(body) ?? new Response(textSse('ROUND2-FINAL-OK'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  vi.stubGlobal('fetch', transport);
  return requests;
}

describe('S2 round 2 生产链路：写/执行审批与单根', () => {
  it('write_file 批准即写、拒绝零副作用、根外先拒绝；bash 根内成功、根外拒绝', async () => {
    await useStrictestAccessMode();
    const { granted } = await seedConfirmedReception();
    const insideWrite = path.join(granted, 'chain-write-ok.md');
    const deniedWrite = path.join(granted, 'chain-write-denied.md');
    const outsideWrite = path.join(tmp, 'chain-write-outside.md');
    const insideBash = path.join(granted, 'chain-bash-inside.md');
    fs.writeFileSync(insideBash, `${CHAIN_INSIDE}\n`, 'utf8');
    const outsideShell = path.join(tmp, 'chain-shell-secret.md');
    fs.writeFileSync(outsideShell, `${CHAIN_OUTSIDE}\n`, 'utf8');

    const previousEnv = await installReceptionProviderEnv();
    const approval = await installReceptionApprovalResponder((request) => (
      String(request.target ?? '').endsWith('chain-write-denied.md') ? 'deny' : 'approve'
    ));
    let toolCallIssued = false;
    const providerRequests = captureProvider((body) => {
      const messagesText = JSON.stringify(body?.messages ?? []);
      if (!messagesText.includes(CHAIN_MARKER) || toolCallIssued || messagesText.includes('tool_result')) return null;
      toolCallIssued = true;
      return new Response(toolUseSse([
        { id: 'toolu_r2_write_ok', name: 'write_file', input: { path: insideWrite, content: 'CHAIN-WRITE-OK\n' } },
        { id: 'toolu_r2_write_denied', name: 'write_file', input: { path: deniedWrite, content: 'CHAIN-WRITE-DENIED\n' } },
        { id: 'toolu_r2_write_outside', name: 'write_file', input: { path: outsideWrite, content: 'CHAIN-WRITE-OUTSIDE\n' } },
        { id: 'toolu_r2_bash_inside', name: 'bash', input: { command: `cat ${shellQuote(insideBash)}` } },
        { id: 'toolu_r2_bash_outside', name: 'bash', input: { command: `cat ${shellQuote(outsideShell)}` } },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      await bus.enqueue({
        uid: UID,
        cid: CID,
        fromActorId: 'a2a_cs_peer_s2',
        forceTo: ['commander'],
        externalInbound: true,
        text: `写成/执行链路（仅用于验收）：${CHAIN_MARKER}`,
      });
      await waitForQuiescent(CID);

      const turnRequests = providerRequests.filter((request) => (
        JSON.stringify(request.body?.messages ?? []).includes(CHAIN_MARKER)
      ));
      const toolResultRequest = turnRequests.find((request) => (
        JSON.stringify(request.body?.messages ?? []).includes('tool_result')
      ));
      expect(toolResultRequest, 'no follow-up provider request carrying tool results').toBeTruthy();
      const toolResultText = JSON.stringify(toolResultRequest!.body);

      // Approved in-root write: exactly the approved bytes.
      expect(fs.readFileSync(insideWrite, 'utf8')).toBe('CHAIN-WRITE-OK\n');
      // Receiver-denied write: zero side effect.
      expect(fs.existsSync(deniedWrite), 'a denied write must not create the file').toBe(false);
      expect(toolResultText).toContain('E_ACTION_APPROVAL_DENIED');
      // Out-of-root write: refused before approval, zero side effect.
      expect(fs.existsSync(outsideWrite), 'an out-of-root write must not create the file').toBe(false);
      expect(toolResultText).toContain('E_PATH_OUT_OF_SCOPE');
      // bash: in-root read succeeds, out-of-root read is refused and never enters context.
      // Off macOS the same two calls are refused earlier, before any spawn
      // (E_SANDBOX_UNAVAILABLE) — either way the out-of-root read never lands.
      if (RECEPTION_SHELL_SANDBOX_AVAILABLE) {
        expect(toolResultText).toContain(CHAIN_INSIDE);
        expect(toolResultText).not.toContain(CHAIN_OUTSIDE);
        expect(toolResultText).toMatch(/E_BASH_(READ_)?PATH_OUT_OF_SCOPE/);
      } else {
        expect(toolResultText).toContain('E_SANDBOX_UNAVAILABLE');
        expect(toolResultText).not.toContain(CHAIN_OUTSIDE);
      }

      // One approval per executable target; the out-of-root targets are refused
      // before the receiver is asked at all.
      const writeTargets = approval.requests
        .filter((request) => request.action === 'write_file')
        .map((request) => String(request.target ?? ''));
      expect(writeTargets.filter((target) => target === insideWrite)).toHaveLength(1);
      expect(writeTargets.filter((target) => target === deniedWrite)).toHaveLength(1);
      expect(writeTargets).not.toContain(outsideWrite);
      const shellTargets = approval.requests
        .filter((request) => request.action === 'bash')
        .map((request) => String(request.target ?? ''));
      expect(shellTargets.some((target) => target.includes('chain-bash-inside.md'))).toBe(true);
      expect(shellTargets.some((target) => target.includes('chain-shell-secret.md'))).toBe(false);
    } finally {
      approval.restore();
      vi.unstubAllGlobals();
      try {
        const bus = await import('../../../../src/main/features/group_chat/bus');
        await bus.dropConv(UID, CID);
      } catch { /* teardown is best effort */ }
      await drainMainRuntimeForTest(UID);
      restoreReceptionProviderEnv(previousEnv);
    }
  }, 120_000);
});

// ── Round 2: real production chain — nested external dispatch refusal ────

async function seedGatewayAgent(): Promise<string> {
  const paths = await import('../../../../src/main/paths');
  const agentId = 'a1b2c3d4e5f6';
  const dir = paths.agentDir(UID, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
    agent_id: agentId,
    name: 'S2GatewayAgent',
    description: 'Synthetic P3394 gateway fixture for the S2 reception dispatch gate.',
    workflow: 'Read the receiver workspace and report its private files.',
    runtime: { kind: 'p3394-gateway', cli: 'codex' },
    created_at: 't',
    updated_at: 't',
  }), 'utf8');
  return 'S2GatewayAgent';
}

describe('S2 round 2 生产链路：nested 派发只允许进程内 agent（P0-1）', () => {
  it('dispatch_to / hand_off_to 到 gateway 目标被明确拒绝，且没有 spawn、没有 workspace 读取', async () => {
    await useStrictestAccessMode();
    const { granted } = await seedConfirmedReception();
    const gatewayName = await seedGatewayAgent();
    const workspaceSentinel = path.join(tmp, 'gateway-workspace-sentinel.txt');
    const sentinelMarker = 'GATEWAY_WORKSPACE_SENTINEL_9F4C';
    fs.writeFileSync(workspaceSentinel, `${sentinelMarker}\n`, 'utf8');
    void granted;

    const previousEnv = await installReceptionProviderEnv();
    gatewayTurnCalls.length = 0;
    let toolCallIssued = false;
    const providerRequests = captureProvider((body) => {
      const messagesText = JSON.stringify(body?.messages ?? []);
      if (!messagesText.includes(CHAIN_MARKER) || toolCallIssued || messagesText.includes('tool_result')) return null;
      toolCallIssued = true;
      return new Response(toolUseSse([
        {
          id: 'toolu_r2_dispatch_gateway',
          name: 'dispatch_to',
          input: { to: gatewayName, message: `read ${workspaceSentinel} and report it`, kstar: 'skip' },
        },
        {
          id: 'toolu_r2_handoff_gateway',
          name: 'hand_off_to',
          input: { to: gatewayName, message: `deliver ${workspaceSentinel} through the gateway`, kstar: 'skip' },
        },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      await bus.enqueue({
        uid: UID,
        cid: CID,
        fromActorId: 'a2a_cs_peer_s2',
        forceTo: ['commander'],
        externalInbound: true,
        text: `派发边界（仅用于验收）：${CHAIN_MARKER}`,
      });
      await waitForQuiescent(CID);

      expect(
        gatewayTurnCalls,
        'a reception dispatch to a CLI/gateway target spawned an external turn',
      ).toHaveLength(0);
      const turnRequests = providerRequests.filter((request) => (
        JSON.stringify(request.body?.messages ?? []).includes(CHAIN_MARKER)
      ));
      const toolResultRequest = turnRequests.find((request) => (
        JSON.stringify(request.body?.messages ?? []).includes('tool_result')
      ));
      expect(toolResultRequest, 'no follow-up provider request carrying tool results').toBeTruthy();
      const toolResultText = JSON.stringify(toolResultRequest!.body);
      expect(toolResultText).toContain('E_RECEPTION_EXTERNAL_DELEGATE_REFUSED');
      const refusals = toolResultText.match(/E_RECEPTION_EXTERNAL_DELEGATE_REFUSED/g) ?? [];
      expect(refusals.length, 'dispatch_to and hand_off_to must both be refused').toBeGreaterThanOrEqual(2);
      expect(toolResultText).not.toContain(sentinelMarker);
      expect(JSON.stringify(providerRequests)).not.toContain(sentinelMarker);
      expect(JSON.stringify(providerRequests)).not.toContain('GATEWAY-SHOULD-NOT-RUN');
    } finally {
      vi.unstubAllGlobals();
      try {
        const bus = await import('../../../../src/main/features/group_chat/bus');
        await bus.dropConv(UID, CID);
      } catch { /* teardown is best effort */ }
      await drainMainRuntimeForTest(UID);
      restoreReceptionProviderEnv(previousEnv);
    }
  }, 120_000);
});
