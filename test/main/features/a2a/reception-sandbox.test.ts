/**
 * S2b：macOS 严格沙箱（deny-default）只对「可信接待回合」opt-in。
 *
 * 合同（方案 §4.1-7/8/9、§4.2「实际macOS Shell」行）：
 *   - 只有 `receptionRoot` 已确认的那一次 bash 调用带严格 profile；
 *   - 普通本地回合保持现有 `(allow default)+(deny file-write*)` 行为；
 *   - 平台不支持 / sandbox-exec 缺失 / 严格 profile 自检失败 / root 不可证明时
 *     fail closed，**绝不**回退到无沙箱或 allow-default；
 *   - 接待回合的 TMPDIR/HOME 落在 ROOT 内，后台日志也在可写根内；
 *   - 前台与后台子进程都继承拒绝面（本轮补后台读写探针与 broker 探针）。
 *
 * 本文件用**真实** `sandbox-exec`（不 mock）与真实生产入口：
 *   `createLocalTools({receptionRoot})`（runner 真实透传方式）→ `bash` 工具 →
 *   `SandboxExecutor` → `sandbox-exec -p <deny-default profile>`。
 * 负例用「ROOT 内脚本 + 命令只引用脚本」的形态，绕过应用层路径启发式，确保
 * 拒绝来自 OS 沙箱而不是参数解析；同一条脚本在普通本地回合里仍可成功，作为
 * 「拒绝确由 sandbox 造成」的对照。
 *
 * 后台证据分两层（当前 S2 工具层策略，2026-10-27 第三轮更正）：
 *   1. 生产可达面：darwin 且 `/usr/bin/sandbox-exec` 存在时，S2 的
 *      `guardBashReceptionBackground()` 放行接待 `run_in_background=true`
 *      （只拒绝 `&`/`nohup`/`setsid` 等绕过 executor 日志/scratch 契约的
 *      shell 自后台化形式）；其它平台或 sandbox-exec 缺失时工具层 fail closed
 *      返回 `E_RECEPTION_BACKGROUND_SHELL_UNAVAILABLE`。因此后台证据必须从
 *      `createLocalTools({receptionRoot})` → `bash` → `executeBackground`
 *      的真实工具层链路取证（tool-layer background 用例），不能只测 executor。
 *   2. 纵深防御：直接驱动 executor 的 `executeBackground` + 严格 env，证明
 *      即使该路径被调用，后台子进程也只拿到 ROOT/SCRATCH 的读写面，根外读写
 *      EPERM；同一探针在普通回合后台成功，作为归因。
 *   后台生命周期无上界、`run-*` scratch 保留，是已知限制（报告 §9.9/§13）。
 *
 * 不宣称的边界（与诊断报告一致）：Windows/Linux 无强隔离；python3/npm/brew
 * 在基线下不可用；HOME 在接待回合被指到 ROOT 内 scratch；TOCTOU 不在此列；
 * launchd bootstrap 端口仍可达（见报告 §9）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  E_SANDBOX_SCOPE,
  E_SANDBOX_UNAVAILABLE,
  STRICT_SANDBOX_ENV,
  buildStrictReceptionSandboxProfile,
  resolveStrictReceptionSandbox,
} from '../../../../src/core-agent/src/sandbox/executor';

// local-tools 的传递依赖里有 Electron 与 electron-log；直接工具用例不需要它们。
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-s2b-test', getName: () => 'cogseed-s2b-test' },
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

const UID = 'u-s2b-sandbox';
const CID = 'a2a-s2b0000000000000000';

/**
 * 环境依赖（他机可能 skip 或假红；完整矩阵见报告 §13.4）：
 *   - 非 darwin 或没有 `/usr/bin/sandbox-exec`：整组 skip（不是通过）；
 *   - 没有 `nc`（/usr/bin、/usr/sbin、/bin）：只用例级 skip 出站网络探针；
 *   - `REAL_HOME` 取 `$HOME`：若运行器把 HOME 指到 ROOT 内，`~/.ssh` metadata
 *     用例会假红（`.ssh` 是否存在不影响，metadata 先被拒）；
 *   - broker 用例硬编码 `/usr/bin/security`，错误文本随 SecurityServer 版本变化
 *     （`unknown error -50` vs `Operation not permitted`）；
 *   - 后台用例轮询 10s（`waitForLogText` / `vi.waitFor`），detached 子进程在高
 *     负载 CI 上可能超时；结束只 kill 探针 pid（best-effort），不做强保证；
 *   - `permissions.setLocalExecMode` 是模块级全局状态：`beforeEach` 的
 *     `vi.resetModules()` 产生新模块代，`afterEach` 再把产品默认值写回；
 *   - 用例只依赖 macOS 系统自带的 `sh`/`cat`/`mktemp`/`sandbox-exec`；
 *     `launchctl`/`log show` 是报告里的手工证据，不在本文件自动复现。
 */
const MAC_SANDBOX_AVAILABLE = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
const NC_BIN = ['/usr/bin/nc', '/usr/sbin/nc', '/bin/nc'].find((p) => fs.existsSync(p));
const REAL_HOME = process.env.HOME || os.homedir();

const OUTSIDE_READ_MARKER = 'PRIVATE-MARKER-DO-NOT-READ';
const INSIDE_MARKER = 'INSIDE-THE-GRANTED-ROOT';

let tmp: string;
let ROOT: string;
let SCRATCH: string;
let OUTSIDE: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-s2b-sandbox-')));
  ROOT = path.join(tmp, 'granted-root');
  SCRATCH = path.join(ROOT, '.cogseed-scratch');
  OUTSIDE = path.join(tmp, 'outside-root');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'inside.md'), `${INSIDE_MARKER}\n`, 'utf8');
  fs.writeFileSync(path.join(OUTSIDE, 'private.txt'), `${OUTSIDE_READ_MARKER}\n`, 'utf8');

  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  // 数据容器也放进临时目录：默认 workspace 是 WS_ROOT/../userWorkSpace。
  process.env.COGSEED_WORKSPACE_ROOT = path.join(tmp, 'data');
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  // 有少数用例把本地访问模式改成 workspace_approval；它在模块内是全局状态。
  // 先把产品默认值写回（写入仍落在本次临时数据目录），再清目录/还原环境。
  try {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
  } catch { /* best-effort: the temp user dir may already be gone */ }
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Tool = {
  name: string;
  execute: (input: Record<string, unknown>, ctx: unknown) => Promise<{ content: string; isError?: boolean }>;
};

function toolByName(tools: Tool[], name: string): Tool {
  const found = tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

/** 与 bus→runner 交给工具层一致：receptionRoot = 已确认根 R，逐次 shell 审批已批准。
 *  生产 runner 在接待回合不传 `extraRoots`（`runner.ts:936`），这里也不传，避免测试
 *  把 extra roots 当成 ceiling 的合法来源。 */
async function buildReceptionTools(root: string): Promise<Tool[]> {
  const localTools = await import('../../../../src/main/model/core-agent/local-tools');
  return localTools.createLocalTools({
    userId: UID,
    cid: CID,
    receptionRoot: root,
    permissionMode: 'ask',
    beforeShellApproval: async () => null,
  } as never) as unknown as Tool[];
}

/** 普通本地回合：不带 receptionRoot，与今日产品普通路径一致。 */
async function buildLocalTools(): Promise<Tool[]> {
  const localTools = await import('../../../../src/main/model/core-agent/local-tools');
  return localTools.createLocalTools({
    cid: CID,
    permissionMode: 'ask',
    beforeShellApproval: async () => null,
  } as never) as unknown as Tool[];
}

/**
 * `vi.resetModules()` 之后 local-tools 会重新加载 executor；必须在同一代模块里
 * 取 executor，工具层与测试才共享同一个类（spy/实例断言依赖这一点）。
 */
async function loadExecutorModule(): Promise<typeof import('../../../../src/core-agent/src/sandbox/executor')> {
  return import('../../../../src/core-agent/src/sandbox/executor');
}

async function runBash(
  tools: Tool[],
  command: string,
  workingDir: string,
  state: Record<string, unknown> = {},
): Promise<{ content: string; isError?: boolean }> {
  return toolByName(tools, 'bash').execute(
    { command },
    { workingDir, state, signal: undefined },
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 写入 ROOT 内的探针脚本：bash 命令只出现脚本路径，路径启发式看不见脚本正文，
 *  因此正文里的根外访问只能由 OS 沙箱拒绝。 */
function writeProbe(name: string, body: string): string {
  const file = path.join(ROOT, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function writeAllProbes(): void {
  writeProbe('probe-read-outside.sh', `#!/bin/sh\n/bin/cat ${shellQuote(path.join(OUTSIDE, 'private.txt'))}\n`);
  // 先在根内留下「脚本已执行」标记，再尝试根外写：区分「未执行」与「执行后被 OS 拒绝」。
  writeProbe(
    'probe-write-outside.sh',
    `#!/bin/sh\nprintf RAN > ${shellQuote(path.join(ROOT, 'write-probe-ran.txt'))}\nprintf ESCAPED > ${shellQuote(path.join(OUTSIDE, 'escaped.txt'))}\n`,
  );
  writeProbe('probe-ssh-metadata.sh', `#!/bin/sh\n/bin/ls -d ${shellQuote(path.join(REAL_HOME, '.ssh'))}\n`);
  // broker（keychain/SecurityServer）探针：只列 keychain 搜索列表，不读任何条目内容。
  writeProbe('probe-keychain-broker.sh', '#!/bin/sh\n/usr/bin/security list-keychains\n');
  if (NC_BIN) {
    writeProbe('probe-network.sh', `#!/bin/sh\n${NC_BIN} -vz -w 1 127.0.0.1 1\n`);
  }
}

function strictEnvFor(root: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [STRICT_SANDBOX_ENV.mode]: '1',
    [STRICT_SANDBOX_ENV.root]: root,
    [STRICT_SANDBOX_ENV.scratch]: path.join(root, '.cogseed-scratch'),
    ...overrides,
  };
}

async function strictExecutor(overrides: Record<string, string> = {}, workingDir = ROOT) {
  const { SandboxExecutor } = await loadExecutorModule();
  return new SandboxExecutor({
    workingDir,
    allowedDirs: [ROOT],
    env: strictEnvFor(ROOT, overrides),
    timeoutMs: 20_000,
  });
}

/** 轮询后台日志直到出现期望文本或超时；返回最后读到的内容。 */
async function waitForLogText(logPath: string, expected: string | RegExp, timeoutMs = 10_000): Promise<string> {
  let text = '';
  await vi.waitFor(() => {
    text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    if (expected instanceof RegExp) expect(text).toMatch(expected);
    else expect(text).toContain(expected);
  }, { timeout: timeoutMs, interval: 50 });
  return text;
}

function isInside(root: string, target: string): boolean {
  const realRoot = fs.realpathSync.native(root);
  const realTarget = fs.existsSync(target) ? fs.realpathSync.native(target) : path.join(
    fs.realpathSync.native(path.dirname(target)),
    path.basename(target),
  );
  return realTarget === realRoot || realTarget.startsWith(`${realRoot}${path.sep}`);
}

// 非 darwin 或没有 sandbox-exec 时整组 skip：无法用真实 OS 沙箱取证。
describe.skipIf(!MAC_SANDBOX_AVAILABLE)(
  'S2b macOS strict reception sandbox (skipped: needs darwin + /usr/bin/sandbox-exec)',
  () => {
    it('positive: in-root read/write, sh -c echo, and TMPDIR/HOME inside ROOT succeed', async () => {
      const tools = await buildReceptionTools(ROOT);

      const write = await runBash(tools, "printf 'IN-ROOT\\n' > in.txt && cat in.txt", ROOT);
      expect(write.isError, `in-root write/read should succeed: ${write.content}`).toBeFalsy();
      expect(write.content).toContain('IN-ROOT');
      expect(fs.readFileSync(path.join(ROOT, 'in.txt'), 'utf8')).toBe('IN-ROOT\n');

      // 直接断言 exit code 0（工具层只暴露 isError）。S2 的接待静态门禁止
      // `sh -c '…'`（脚本正文不可静态检查），所以嵌套解释器只走 executor 直连；
      // 接待工具层允许 `sh probe.sh` 的脚本文件形态（下面的负例使用）。
      const executor = await strictExecutor();
      const result = await executor.execute("sh -c 'echo hi'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hi');
      expect(result.stderr.trim()).toBe('');

      // 接待回合的 TMPDIR/HOME 必须落在 ROOT 内的 scratch，且可写。
      const envProbe = await runBash(tools, 'printf "%s\\n%s\\n" "$TMPDIR" "$HOME"; mktemp', ROOT);
      expect(envProbe.isError, `TMPDIR/HOME probe should succeed: ${envProbe.content}`).toBeFalsy();
      const [tmpDir, homeDir, mktempPath] = envProbe.content.trim().split('\n');
      expect(tmpDir.startsWith(`${SCRATCH}${path.sep}`)).toBe(true);
      expect(homeDir).toBe(tmpDir);
      expect(mktempPath.startsWith(`${SCRATCH}${path.sep}`)).toBe(true);
    });

    it('negative: outside read/write, symlink escape, and ~/.ssh metadata are denied by the OS sandbox', async () => {
      writeAllProbes();
      fs.symlinkSync(path.join(OUTSIDE, 'private.txt'), path.join(ROOT, 'link-out'));
      writeProbe('probe-symlink-escape.sh', '#!/bin/sh\n/bin/cat link-out\n');
      const tools = await buildReceptionTools(ROOT);

      const outsideRead = await runBash(tools, 'sh probe-read-outside.sh', ROOT);
      expect(outsideRead.isError, 'out-of-root read must fail').toBe(true);
      expect(outsideRead.content).not.toContain(OUTSIDE_READ_MARKER);
      expect(outsideRead.content).toContain('Operation not permitted');

      const outsideWrite = await runBash(tools, 'sh probe-write-outside.sh', ROOT);
      expect(outsideWrite.isError, 'out-of-root write must fail').toBe(true);
      // 写负例必须由 OS 拒绝，而不是脚本没跑：根内标记 + 根外文件缺失 + EPERM。
      expect(outsideWrite.content).toContain('Operation not permitted');
      expect(fs.existsSync(path.join(ROOT, 'write-probe-ran.txt')), 'the write probe must have executed').toBe(true);
      expect(fs.existsSync(path.join(OUTSIDE, 'escaped.txt'))).toBe(false);

      const symlinkEscape = await runBash(tools, 'sh probe-symlink-escape.sh', ROOT);
      expect(symlinkEscape.isError, 'symlink escape must fail').toBe(true);
      expect(symlinkEscape.content).not.toContain(OUTSIDE_READ_MARKER);
      expect(symlinkEscape.content).toContain('Operation not permitted');

      const sshMetadata = await runBash(tools, 'sh probe-ssh-metadata.sh', ROOT);
      expect(sshMetadata.isError, '~/.ssh metadata read must fail').toBe(true);
      expect(sshMetadata.content).toContain('Operation not permitted');
    });

    // 单独成例：缺少 nc 时在测试输出里显示 skipped（而不是让网络证据静默变绿）。
    it.skipIf(!NC_BIN)(
      'negative: outbound network is denied by the strict profile (skipped: no nc on this host)',
      async () => {
        writeProbe('probe-network.sh', `#!/bin/sh\n${NC_BIN} -vz -w 1 127.0.0.1 1\n`);
        const network = await runBash(await buildReceptionTools(ROOT), 'sh probe-network.sh', ROOT);
        expect(network.isError, 'network-outbound must fail').toBe(true);
        expect(network.content).toContain('Operation not permitted');
        expect(network.content.toLowerCase()).not.toContain('succeeded');
      },
    );

    it('broker probe: keychain/SecurityServer is unreachable inside the strict profile, reachable in an ordinary turn', async () => {
      writeAllProbes();
      const permissions = await import('../../../../src/main/features/permissions');
      permissions.setLocalExecMode('workspace_approval');

      const strict = await runBash(await buildReceptionTools(ROOT), 'sh probe-keychain-broker.sh', ROOT);
      expect(strict.isError, `keychain broker must be denied under deny-default: ${strict.content}`).toBe(true);
      // 未读到真实 keychain 搜索列表；`security` 在 sandbox 内返回 -50（SecurityServer
      // mach-lookup 被拒），对照无沙箱的 -25300/正常列表。
      expect(strict.content).not.toContain('login.keychain-db');
      expect(strict.content).not.toContain('/Library/Keychains');
      expect(strict.content).toMatch(/Operation not permitted|unknown error/);

      // 归因：同一探针在普通回合可访问 SecurityServer（security 正常列出 keychain 路径）。
      const ordinary = await runBash(await buildLocalTools(), 'sh probe-keychain-broker.sh', ROOT);
      expect(ordinary.isError, `ordinary turn must reach the keychain broker: ${ordinary.content}`).toBeFalsy();
      expect(ordinary.content).toContain('keychain');
    });

    it('background strict profile: out-of-root read/write EPERM, in-root background work succeeds', async () => {
      writeProbe('probe-bg-read-outside.sh', `#!/bin/sh\n/bin/cat ${shellQuote(path.join(OUTSIDE, 'private.txt'))}\n`);
      writeProbe(
        'probe-bg-write-outside.sh',
        `#!/bin/sh\nprintf RAN > ${shellQuote(path.join(ROOT, 'bg-write-ran.txt'))}\nprintf ESCAPED > ${shellQuote(path.join(OUTSIDE, 'bg-escaped.txt'))}\n`,
      );
      writeProbe(
        'probe-bg-inside.sh',
        `#!/bin/sh\nprintf BG-INSIDE > ${shellQuote(path.join(ROOT, 'bg-inside.txt'))}\n/bin/cat ${shellQuote(path.join(ROOT, 'inside.md'))}\n`,
      );

      // 后台根外读：日志在 ROOT 内，子进程读根外必须 EPERM 且没有 marker。
      const readLog = path.join(ROOT, 'bg-read.log');
      const readStart = (await strictExecutor()).executeBackground('sh probe-bg-read-outside.sh', readLog);
      expect(readStart.pid, `background read probe must start: ${readStart.error ?? ''}`).toBeTypeOf('number');
      const readText = await waitForLogText(readLog, 'Operation not permitted');
      expect(readText).not.toContain(OUTSIDE_READ_MARKER);
      expect(isInside(ROOT, readLog), 'the background log must stay inside ROOT').toBe(true);

      // 后台根外写：根内标记证明脚本执行，根外文件必须不存在。
      const writeLog = path.join(ROOT, 'bg-write.log');
      const writeStart = (await strictExecutor()).executeBackground('sh probe-bg-write-outside.sh', writeLog);
      expect(writeStart.pid, `background write probe must start: ${writeStart.error ?? ''}`).toBeTypeOf('number');
      await waitForLogText(writeLog, 'Operation not permitted');
      expect(fs.existsSync(path.join(ROOT, 'bg-write-ran.txt')), 'the background write probe must have executed').toBe(true);
      expect(fs.existsSync(path.join(OUTSIDE, 'bg-escaped.txt'))).toBe(false);

      // 正对照：ROOT 内后台读写成功，日志也在 ROOT 内。
      const insideLog = path.join(ROOT, 'bg-inside.log');
      const insideStart = (await strictExecutor()).executeBackground('sh probe-bg-inside.sh', insideLog);
      expect(insideStart.pid, `background inside probe must start: ${insideStart.error ?? ''}`).toBeTypeOf('number');
      await vi.waitFor(() => {
        expect(fs.existsSync(path.join(ROOT, 'bg-inside.txt'))).toBe(true);
      }, { timeout: 10_000, interval: 50 });
      expect(fs.readFileSync(path.join(ROOT, 'bg-inside.txt'), 'utf8')).toBe('BG-INSIDE');
      await waitForLogText(insideLog, INSIDE_MARKER);
      expect(isInside(ROOT, insideLog)).toBe(true);
    });

    it('background attribution: the same out-of-root read succeeds for an ordinary (no receptionRoot) turn', async () => {
      writeProbe('probe-bg-read-outside.sh', `#!/bin/sh\n/bin/cat ${shellQuote(path.join(OUTSIDE, 'private.txt'))}\n`);
      const permissions = await import('../../../../src/main/features/permissions');
      // 普通回合证据只在 workspace_approval 下成立；默认 all_files_approval 下
      // allowedDirs 为空、本来就不套写沙箱（既有行为，见报告 §9.1）。
      permissions.setLocalExecMode('workspace_approval');

      const bg = await toolByName(await buildLocalTools(), 'bash').execute(
        { command: 'sh probe-bg-read-outside.sh', run_in_background: true },
        { workingDir: ROOT, state: {}, signal: undefined },
      );
      expect(bg.isError, `ordinary background read should start: ${bg.content}`).toBeFalsy();
      const logLine = /^log: (.+)$/m.exec(bg.content);
      expect(logLine, `background output must report a log path: ${bg.content}`).not.toBeNull();
      const logPath = logLine![1].trim();
      expect(logPath.startsWith(`${ROOT}${path.sep}`)).toBe(true);

      const text = await waitForLogText(logPath, OUTSIDE_READ_MARKER);
      expect(text).toContain(OUTSIDE_READ_MARKER);
    });

    it('tool-layer background: reception bash carries the strict triple into executeBackground and the OS denies out-of-root read/write', async () => {
      // 探针正文持有根外路径，命令行只出现脚本名：应用层路径启发式看不到，
      // 拒绝只能来自 OS 沙箱。脚本先读根外，再写一根内标记，最后写根外。
      writeProbe(
        'probe-tool-bg-outside.sh',
        '#!/bin/sh\n'
        + `/bin/cat ${shellQuote(path.join(OUTSIDE, 'private.txt'))}\n`
        + `printf RAN > ${shellQuote(path.join(ROOT, 'tool-bg-ran.txt'))}\n`
        + `printf ESCAPED > ${shellQuote(path.join(OUTSIDE, 'tool-bg-escaped.txt'))}\n`,
      );
      const tools = await buildReceptionTools(ROOT);
      const { SandboxExecutor } = await loadExecutorModule();
      const backgroundSpy = vi.spyOn(SandboxExecutor.prototype, 'executeBackground');
      const foregroundSpy = vi.spyOn(SandboxExecutor.prototype, 'execute');
      let pid: number | null = null;
      try {
        const result = await toolByName(tools, 'bash').execute(
          { command: 'sh probe-tool-bg-outside.sh', run_in_background: true },
          { workingDir: ROOT, state: {}, signal: undefined },
        );
        expect(result.isError, `reception background must start: ${result.content}`).toBeFalsy();
        // 真实工具层走的是后台入口（不是前台 execute），这是本用例相对
        // executor 直连探针新增的覆盖。
        expect(foregroundSpy).not.toHaveBeenCalled();
        expect(backgroundSpy).toHaveBeenCalledTimes(1);
        const instance = backgroundSpy.mock.instances[0] as unknown as {
          config: { env?: Record<string, string>; allowedDirs?: string[] };
        };
        const env = instance.config.env ?? {};
        expect(env[STRICT_SANDBOX_ENV.mode]).toBe('1');
        expect(env[STRICT_SANDBOX_ENV.root]).toBe(fs.realpathSync.native(ROOT));
        expect(env[STRICT_SANDBOX_ENV.scratch]).toBe(fs.realpathSync.native(SCRATCH));
        expect(instance.config.allowedDirs).toEqual([fs.realpathSync.native(ROOT)]);

        const pidLine = /^pid: (\d+)$/m.exec(result.content);
        const logLine = /^log: (.+)$/m.exec(result.content);
        expect(pidLine, `background pid missing: ${result.content}`).not.toBeNull();
        expect(logLine, `background log path missing: ${result.content}`).not.toBeNull();
        pid = Number(pidLine![1]);
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        const logPath = logLine![1].trim();
        expect(isInside(ROOT, logPath), 'the background log must stay inside ROOT').toBe(true);

        // 脚本正文里有两次根外访问（读 + 写）：日志里应有两条 EPERM，且绝不
        // 出现根外 marker；根内「已执行」标记证明脚本真的跑过。
        let text = '';
        await vi.waitFor(() => {
          text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
          expect((text.match(/Operation not permitted/g) ?? []).length).toBeGreaterThanOrEqual(2);
        }, { timeout: 10_000, interval: 50 });
        expect(text).not.toContain(OUTSIDE_READ_MARKER);
        expect(fs.existsSync(path.join(ROOT, 'tool-bg-ran.txt')), 'the background script must have executed').toBe(true);
        expect(fs.existsSync(path.join(OUTSIDE, 'tool-bg-escaped.txt'))).toBe(false);
        // 供证据附件引用的实测摘要（不包含任何根外内容）。
        console.log(
          `[s2b/tool-bg] execute=${foregroundSpy.mock.calls.length}`
          + ` executeBackground=${backgroundSpy.mock.calls.length}`
          + ` strict=${env[STRICT_SANDBOX_ENV.mode]}`
          + ` allowedDirs=${JSON.stringify(instance.config.allowedDirs)}`
          + ` logInsideROOT=true`
          + ` eperm=${(text.match(/Operation not permitted/g) ?? []).length}`
          + ` markerPresent=${text.includes(OUTSIDE_READ_MARKER)}`
          + ` ran=${fs.existsSync(path.join(ROOT, 'tool-bg-ran.txt'))}`
          + ` outsideWrite=${fs.existsSync(path.join(OUTSIDE, 'tool-bg-escaped.txt'))}`
          + ` pid=${pid}`,
        );
      } finally {
        foregroundSpy.mockRestore();
        backgroundSpy.mockRestore();
        if (pid != null) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* probe already exited */ }
        }
      }
    });

    it('tool-layer background attribution: without receptionRoot the same background script reads out of root', async () => {
      writeProbe('probe-tool-bg-read.sh', `#!/bin/sh\n/bin/cat ${shellQuote(path.join(OUTSIDE, 'private.txt'))}\n`);
      const permissions = await import('../../../../src/main/features/permissions');
      permissions.setLocalExecMode('workspace_approval');
      const tools = await buildLocalTools();
      const { SandboxExecutor } = await loadExecutorModule();
      const backgroundSpy = vi.spyOn(SandboxExecutor.prototype, 'executeBackground');
      let pid: number | null = null;
      try {
        const result = await toolByName(tools, 'bash').execute(
          { command: 'sh probe-tool-bg-read.sh', run_in_background: true },
          { workingDir: ROOT, state: {}, signal: undefined },
        );
        expect(result.isError, `ordinary background must start: ${result.content}`).toBeFalsy();
        expect(backgroundSpy).toHaveBeenCalledTimes(1);
        const instance = backgroundSpy.mock.instances[0] as unknown as {
          config: { env?: Record<string, string> };
        };
        // 归因：同一条工具路径，没有接待根就没有严格标记。
        expect((instance.config.env ?? {})[STRICT_SANDBOX_ENV.mode]).toBeUndefined();

        const pidLine = /^pid: (\d+)$/m.exec(result.content);
        const logLine = /^log: (.+)$/m.exec(result.content);
        expect(pidLine, `background pid missing: ${result.content}`).not.toBeNull();
        expect(logLine, `background log path missing: ${result.content}`).not.toBeNull();
        pid = Number(pidLine![1]);
        const logPath = logLine![1].trim();
        expect(isInside(ROOT, logPath)).toBe(true);
        const text = await waitForLogText(logPath, OUTSIDE_READ_MARKER);
        expect(text).toContain(OUTSIDE_READ_MARKER);
        console.log(
          `[s2b/tool-bg-ordinary] executeBackground=${backgroundSpy.mock.calls.length}`
          + ` strict=${(instance.config.env ?? {})[STRICT_SANDBOX_ENV.mode]}`
          + ` markerPresent=${text.includes(OUTSIDE_READ_MARKER)}`
          + ` logInsideROOT=true pid=${pid}`,
        );
      } finally {
        backgroundSpy.mockRestore();
        if (pid != null) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* probe already exited */ }
        }
      }
    });

    it('background log final component: an out-of-root symlink is refused and the target is never created', async () => {
      const link = path.join(ROOT, 'bg-log-link');
      const outsideTarget = path.join(OUTSIDE, 'symlinked-bg.log');
      fs.symlinkSync(outsideTarget, link);

      const executor = await strictExecutor();
      const refused = executor.executeBackground('printf PWNED > bg-symlink-should-not-run.txt', link);
      expect(refused.pid).toBeNull();
      expect(refused.error).toContain(E_SANDBOX_SCOPE);
      expect(fs.existsSync(outsideTarget), 'the parent must not create the symlink target').toBe(false);
      expect(fs.existsSync(path.join(ROOT, 'bg-symlink-should-not-run.txt'))).toBe(false);
    });

    it('background spawn failure: ENOENT/EACCES return pid:null and the asynchronous error event is handled', async () => {
      // spawn() 对 ENOENT/EACCES 返回无 pid，并在下一个 tick 触发 'error' 事件。
      // 没有 listener 时该事件会变成未捕获异常（整个测试文件失败）；有 listener
      // 时只记录 warn，调用方拿到的仍是同步的 {pid:null,error}。严格分支的
      // sandbox-exec 在 spawn 前已被 resolver stat/access 校验，故这里用普通
      // 分支的 `shell` 注入来覆盖这两种 errno（strict 侧不可注入该竞态）。
      const missingShell = path.join(tmp, 'missing-shell');
      const nonExecutableShell = path.join(tmp, 'not-executable-shell');
      fs.writeFileSync(nonExecutableShell, '#!/bin/sh\nexit 0\n', 'utf8');
      fs.chmodSync(nonExecutableShell, 0o644);
      const { SandboxExecutor } = await loadExecutorModule();
      const cases: Array<[string, string]> = [
        ['ENOENT', missingShell],
        ['EACCES', nonExecutableShell],
      ];
      // 直接观测未捕获异常：去掉 listener 的临时红证明里，这两个 errno 会以
      // "Uncaught Exception" 形式逃逸（见报告 §13.3 的红→绿证据）。
      const escaped: unknown[] = [];
      const onUncaught = (err: unknown) => { escaped.push(err); };
      process.on('uncaughtException', onUncaught);
      try {
        for (const [name, shell] of cases) {
          const executor = new SandboxExecutor({
            workingDir: ROOT,
            allowedDirs: [],
            env: {},
            shell,
            timeoutMs: 5_000,
          });
          const started = executor.executeBackground(
            'printf PWNED > spawn-should-not-run.txt',
            path.join(ROOT, `spawn-${name.toLowerCase()}.log`),
          );
          expect(started.pid, `${name} must not produce a pid`).toBeNull();
          expect(started.error, `${name} must report the failed start`).toContain('did not produce a process id');
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(fs.existsSync(path.join(ROOT, 'spawn-should-not-run.txt')), `${name} must not execute the command`).toBe(false);
        }
      } finally {
        process.off('uncaughtException', onUncaught);
      }
      expect(escaped, 'the asynchronous spawn error must not escape as an uncaught exception').toEqual([]);
      console.log(`[s2b/spawn-error] cases=${cases.map(([name]) => name).join('+')} pid=null commandRan=false uncaught=${escaped.length}`);
    });

    it('executor scope: a working directory outside the confirmed root is refused before spawn', async () => {
      const executor = await strictExecutor({}, OUTSIDE);
      const result = await executor.execute('printf PWNED > cwd-escape.txt');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(E_SANDBOX_SCOPE);
      expect(fs.existsSync(path.join(OUTSIDE, 'cwd-escape.txt'))).toBe(false);
    });

    it('attribution + ordinary local turn (workspace_approval): the same probes behave as today without receptionRoot', async () => {
      writeAllProbes();
      const permissions = await import('../../../../src/main/features/permissions');
      permissions.setLocalExecMode('workspace_approval');
      const tools = await buildLocalTools();

      // 普通本地回合仍走 allow-default：根外读成功（CI/生产现状，不是本次要改的行为）。
      const localRead = await runBash(tools, 'sh probe-read-outside.sh', ROOT);
      expect(localRead.isError, `ordinary local read should still work: ${localRead.content}`).toBeFalsy();
      expect(localRead.content).toContain(OUTSIDE_READ_MARKER);

      // allow-default + deny-write 的写侧仍然生效：根外写被 OS 拒绝。
      // 仅 workspace_approval 模式如此；默认 all_files_approval 下 allowedDirs=[]
      // 不套写沙箱（既有行为，报告 §9.1）。
      const localWrite = await runBash(tools, 'sh probe-write-outside.sh', ROOT);
      expect(localWrite.isError, 'ordinary local turn keeps deny-write outside the workspace').toBe(true);
      expect(localWrite.content).toContain('Operation not permitted');
      expect(fs.existsSync(path.join(OUTSIDE, 'escaped.txt'))).toBe(false);

      // 普通本地回合的 ROOT 内读写照旧成功。
      const localInside = await runBash(tools, "printf NORMAL > normal.txt && cat normal.txt", ROOT);
      expect(localInside.isError, `ordinary local in-root write should work: ${localInside.content}`).toBeFalsy();
      expect(localInside.content.trim()).toBe('NORMAL');
    });

    it('tool→executor marker propagation: the reception bash call carries the strict triple', async () => {
      const tools = await buildReceptionTools(ROOT);
      const { SandboxExecutor } = await loadExecutorModule();
      const spy = vi.spyOn(SandboxExecutor.prototype, 'execute');
      try {
        const res = await runBash(tools, 'printf MARKER > marker.txt', ROOT);
        expect(res.isError, `reception bash should succeed: ${res.content}`).toBeFalsy();
        expect(spy).toHaveBeenCalledTimes(1);
        const instance = spy.mock.instances[0] as unknown as { config: { env?: Record<string, string> } };
        const env = instance.config.env ?? {};
        expect(env[STRICT_SANDBOX_ENV.mode]).toBe('1');
        expect(env[STRICT_SANDBOX_ENV.root]).toBe(fs.realpathSync.native(ROOT));
        expect(env[STRICT_SANDBOX_ENV.scratch]).toBe(
          fs.realpathSync.native(path.join(ROOT, '.cogseed-scratch')),
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('fail closed: unavailable sandbox-exec refuses the reception shell without spawning a child', async () => {
      const missingExec = path.join(tmp, 'missing-sandbox-exec');
      const tools = await buildReceptionTools(ROOT);

      const res = await runBash(tools, 'printf PWNED > fail-closed-tool.txt', ROOT, {
        sandboxEnv: { [STRICT_SANDBOX_ENV.execPath]: missingExec },
      });
      expect(res.isError, 'reception shell must be refused').toBe(true);
      expect(res.content).toContain(E_SANDBOX_UNAVAILABLE);
      expect(fs.existsSync(path.join(ROOT, 'fail-closed-tool.txt'))).toBe(false);
    });

    it('fail closed: a sandbox-exec that cannot pass the profile self-check is refused, not degraded', async () => {
      // /usr/bin/false 是可执行文件，但 `sandbox-exec -p profile /usr/bin/true` 不会成功。
      const tools = await buildReceptionTools(ROOT);
      const res = await runBash(tools, 'printf PWNED > fail-closed-selfcheck.txt', ROOT, {
        sandboxEnv: { [STRICT_SANDBOX_ENV.execPath]: '/usr/bin/false' },
      });
      expect(res.isError).toBe(true);
      expect(res.content).toContain(E_SANDBOX_UNAVAILABLE);
      expect(res.content).toContain('self-check');
      expect(fs.existsSync(path.join(ROOT, 'fail-closed-selfcheck.txt'))).toBe(false);

      const failure = resolveStrictReceptionSandbox({
        env: strictEnvFor(ROOT, { [STRICT_SANDBOX_ENV.execPath]: path.join(tmp, 'missing-sandbox-exec') }),
        allowedDirs: [ROOT],
        platform: 'darwin',
      });
      expect(failure.kind).toBe('refused');
      if (failure.kind === 'refused') expect(failure.failure.code).toBe(E_SANDBOX_UNAVAILABLE);
    });

    it('fail closed: non-darwin, empty allowedDirs, unproven root, filesystem-root root, and out-of-root scratch', () => {
      const baseEnv = strictEnvFor(ROOT);

      expect(resolveStrictReceptionSandbox({ env: {}, allowedDirs: [ROOT] })).toEqual({ kind: 'none' });

      const nonDarwin = resolveStrictReceptionSandbox({ env: baseEnv, allowedDirs: [ROOT], platform: 'linux' });
      expect(nonDarwin.kind).toBe('refused');

      const oddMarker = resolveStrictReceptionSandbox({
        env: { ...baseEnv, [STRICT_SANDBOX_ENV.mode]: '0' },
        allowedDirs: [ROOT],
        platform: 'darwin',
      });
      expect(oddMarker.kind).toBe('refused');

      const emptyDirs = resolveStrictReceptionSandbox({ env: baseEnv, allowedDirs: [], platform: 'darwin' });
      expect(emptyDirs.kind).toBe('refused');

      const unprovenRoot = resolveStrictReceptionSandbox({
        env: baseEnv,
        allowedDirs: [OUTSIDE],
        platform: 'darwin',
      });
      expect(unprovenRoot.kind).toBe('refused');

      // P2-6：拒绝**恰好**是文件系统根的「/」（上游回归时的纵深防御）。
      // 注意：`/Volumes/X` 这类挂载点根仍会被接受为已确认根（其
      // `path.parse(...).root` 也是 "/"），本包不宣称拒绝挂载点根。
      const rootLevel = resolveStrictReceptionSandbox({
        env: strictEnvFor('/'),
        allowedDirs: ['/'],
        platform: 'darwin',
      });
      expect(rootLevel.kind).toBe('refused');
      if (rootLevel.kind === 'refused') {
        expect(rootLevel.failure.message).toContain('filesystem root');
      }

      const outsideScratch = resolveStrictReceptionSandbox({
        env: { ...baseEnv, [STRICT_SANDBOX_ENV.scratch]: path.join(OUTSIDE, 'scratch') },
        allowedDirs: [ROOT],
        platform: 'darwin',
      });
      expect(outsideScratch.kind).toBe('refused');
    });

    it('fail closed: a partial strict marker (root/scratch without mode) is refused, never ordinary', () => {
      const partialRootScratch = resolveStrictReceptionSandbox({
        env: {
          [STRICT_SANDBOX_ENV.root]: ROOT,
          [STRICT_SANDBOX_ENV.scratch]: SCRATCH,
        },
        allowedDirs: [ROOT],
        platform: 'darwin',
      });
      expect(partialRootScratch.kind).toBe('refused');
      if (partialRootScratch.kind === 'refused') {
        expect(partialRootScratch.failure.message).toContain('partial strict sandbox marker');
        expect(partialRootScratch.failure.message).toContain(STRICT_SANDBOX_ENV.mode);
      }

      const partialExecPath = resolveStrictReceptionSandbox({
        env: { [STRICT_SANDBOX_ENV.execPath]: '/usr/bin/false' },
        allowedDirs: [ROOT],
        platform: 'darwin',
      });
      expect(partialExecPath.kind).toBe('refused');

      // 单键 partial 组合也必须 fail closed，而不是静默走 allow-default。
      for (const partial of [
        { [STRICT_SANDBOX_ENV.root]: ROOT },
        { [STRICT_SANDBOX_ENV.scratch]: SCRATCH },
      ]) {
        const result = resolveStrictReceptionSandbox({ env: partial, allowedDirs: [ROOT], platform: 'darwin' });
        expect(result.kind).toBe('refused');
        if (result.kind === 'refused') {
          expect(result.failure.message).toContain('partial strict sandbox marker');
        }
      }
      // mode=1 但 root 缺失：refused（missing/not absolute），不是 none。
      const modeOnly = resolveStrictReceptionSandbox({
        env: { [STRICT_SANDBOX_ENV.mode]: '1' },
        allowedDirs: [ROOT],
        platform: 'darwin',
      });
      expect(modeOnly.kind).toBe('refused');
      if (modeOnly.kind === 'refused') {
        expect(modeOnly.failure.message).toContain('missing or is not an absolute path');
      }

      // 普通回合（完全无严格键）仍返回 none，不误伤。
      expect(resolveStrictReceptionSandbox({ env: { COGSEED_OUTPUT_DIR: ROOT }, allowedDirs: [ROOT] }))
        .toEqual({ kind: 'none' });
    });

    it('fail closed at the spawn point: no marker file appears for refused executor calls', async () => {
      const oracle = path.join(tmp, 'oracle');
      fs.mkdirSync(oracle, { recursive: true });

      const { SandboxExecutor } = await loadExecutorModule();
      const missing = new SandboxExecutor({
        workingDir: oracle,
        allowedDirs: [oracle],
        env: strictEnvFor(oracle, { [STRICT_SANDBOX_ENV.execPath]: path.join(tmp, 'missing-sandbox-exec') }),
        timeoutMs: 20_000,
      });
      const missingResult = await missing.execute('printf PWNED > pwned-missing.txt');
      expect(missingResult.exitCode).toBe(1);
      expect(missingResult.stderr).toContain(E_SANDBOX_UNAVAILABLE);
      expect(fs.existsSync(path.join(oracle, 'pwned-missing.txt'))).toBe(false);

      const noDirs = new SandboxExecutor({
        workingDir: oracle,
        allowedDirs: [],
        env: strictEnvFor(oracle),
        timeoutMs: 20_000,
      });
      const noDirsResult = await noDirs.execute('printf PWNED > pwned-nodirs.txt');
      expect(noDirsResult.exitCode).toBe(1);
      expect(noDirsResult.stderr).toContain(E_SANDBOX_UNAVAILABLE);
      expect(noDirsResult.stderr).toContain('no proven allowed directory');
      expect(fs.existsSync(path.join(oracle, 'pwned-nodirs.txt'))).toBe(false);
    });

    it('background log scope: a log path outside the writable roots is refused without running the command', async () => {
      const executor = await strictExecutor();
      const refused = executor.executeBackground(
        'printf PWNED > should-not-run.txt',
        path.join(OUTSIDE, 'bg-outside.log'),
      );
      expect(refused.pid).toBeNull();
      expect(refused.error).toContain(E_SANDBOX_SCOPE);
      expect(fs.existsSync(path.join(OUTSIDE, 'bg-outside.log'))).toBe(false);
      expect(fs.existsSync(path.join(ROOT, 'should-not-run.txt'))).toBe(false);
    });

    it('profile contract: exact deny-default rule set; no home/full-disk read or network allow', () => {
      const profile = buildStrictReceptionSandboxProfile({ root: ROOT, scratch: SCRATCH });
      const operations = profile
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith(';;'));

      // 结构化断言：逐条精确匹配（不是子串），后加任何 home/全盘/network/broker
      // allow 行都会让这里变红，而不是被 `toContain` 放过。
      expect(operations).toEqual([
        '(version 1)',
        '(deny default)',
        '(allow process-exec)',
        '(allow process-fork)',
        '(allow sysctl-read)',
        '(allow file-read-data (literal "/"))',
        '(allow file-read-metadata (subpath "/bin") (subpath "/usr/bin"))',
        `(allow file-read* (subpath "${ROOT}") (subpath "${SCRATCH}") (literal "/System/Library/OpenSSL/openssl.cnf") (literal "/dev/null") (literal "/private/var/select/sh"))`,
        `(allow file-write* (subpath "${ROOT}") (subpath "${SCRATCH}") (literal "/dev/null"))`,
      ]);
      expect(operations.filter((line) => line.startsWith('(deny '))).toEqual(['(deny default)']);
      expect(operations.some((line) => line.startsWith('(allow default'))).toBe(false);

      const subpaths = [...new Set(
        [...profile.matchAll(/\(subpath "((?:[^"\\]|\\.)*)"\)/g)]
          .map((match) => match[1].replace(/\\(["\\])/g, '$1')),
      )];
      expect(subpaths.sort()).toEqual([ROOT, SCRATCH, '/bin', '/usr/bin'].sort());
      for (const forbidden of ['/', '/Users', '/private/var/folders', '/tmp']) {
        expect(subpaths).not.toContain(forbidden);
      }
      expect(profile).not.toMatch(/\(allow\s+(network|mach|ipc)/);
      expect(profile).not.toContain('network-outbound');
    });
  },
);
