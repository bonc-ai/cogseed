import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  CLI_SHIM_MARKER,
  CliShimConflictError,
  buildCliShim,
  cliCommandStatus,
  cliShimFileName,
  defaultCliInstallDir,
  installCliCommand,
  isDirOnPath,
  uninstallCliCommand,
} from '../../../src/main/util/cli_command';

/**
 * `cogseed` 命令的生成与安装。
 *
 * 重点是**跨平台内容**与**不越界**：Windows 的 `.cmd` 内容在 macOS 上也要被夹具钉住
 * （否则只有 Windows CI 才覆盖，而真机验收已经证明这类缺口会存活很久），
 * 且安装器只能覆盖/删除自己写的文件。
 */

let tmpDir: string;

/**
 * 夹具平台必须与"被测平台"一致：安装/卸载/冲突检查三者一旦混用
 * （例如 install 用 darwin、uninstall 用 process.platform），在 Windows 上
 * 安装写 `cogseed` 而卸载找 `cogseed.cmd`，用例会静默测不到东西——
 * 这正是真机验收抓到的三处测试缺陷。
 */
const TEST_PLATFORM: string = process.platform;

function shimPath(dir: string, platform: NodeJS.Platform | string = TEST_PLATFORM): string {
  return path.join(dir, cliShimFileName('cogseed', platform));
}

function spec(dir: string, overrides: Record<string, unknown> = {}) {
  return {
    platform: TEST_PLATFORM,
    appRoot: '/opt/cogseed/app',
    runtimeBin: '/opt/cogseed/runtime/Electron',
    workspaceRoot: '/Users/me/.cogseed/data',
    uid: '76419206',
    dir,
    ...overrides,
  } as Parameters<typeof installCliCommand>[0];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cli-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('cli_command · shim 内容', () => {
  it('posix：以 Electron Node 模式 exec 入口，并固定 PC_DIR / 数据根 / uid', () => {
    const shim = buildCliShim({
      platform: 'darwin',
      appRoot: '/opt/cogseed/app',
      runtimeBin: '/opt/cogseed/runtime/Electron',
      workspaceRoot: '/Users/me/.cogseed/data',
      uid: '76419206',
    });
    expect(shim.startsWith('#!/bin/sh\n')).toBe(true);
    expect(shim).toContain(CLI_SHIM_MARKER);
    expect(shim).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(shim).toContain('COGSEED_PC_DIR="/opt/cogseed/app"');
    expect(shim).toContain('COGSEED_WORKSPACE_ROOT="/Users/me/.cogseed/data"');
    expect(shim).toContain('COGSEED_UID="76419206"');
    expect(shim).toContain('/opt/cogseed/app/bin/cogseed-pkg.cjs');
    // 必须把用户参数原样透传，且用 exec 免留一层 shell
    expect(shim.trimEnd().endsWith('"$@"')).toBe(true);
    expect(shim).toContain('exec env');
  });

  it('posix：省略 workspaceRoot/uid 时不留空变量', () => {
    const shim = buildCliShim({ platform: 'linux', appRoot: '/a', runtimeBin: '/r' });
    expect(shim).not.toContain('COGSEED_WORKSPACE_ROOT');
    expect(shim).not.toContain('COGSEED_UID');
    expect(shim).toContain('COGSEED_PC_DIR="/a"');
  });

  it('win32：CRLF + set 形式，参数用 %*，路径里的 % 要转义', () => {
    const shim = buildCliShim({
      platform: 'win32',
      appRoot: 'C:\\Program Files\\CogSeed\\app.asar',
      runtimeBin: 'C:\\Program Files\\CogSeed\\CogSeed.exe',
      workspaceRoot: 'C:\\Users\\me\\.cogseed\\data',
      uid: '76419206',
    });
    expect(shim.split('\r\n').length).toBeGreaterThan(4);
    expect(shim).not.toContain('\n\n');
    expect(shim).toContain(`REM ${CLI_SHIM_MARKER}`);
    expect(shim).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(shim).toContain('set "COGSEED_PC_DIR=C:\\Program Files\\CogSeed\\app.asar"');
    expect(shim).toContain('set "COGSEED_UID=76419206"');
    expect(shim).toContain('C:\\Program Files\\CogSeed\\app.asar\\bin\\cogseed-pkg.cjs');
    // 末尾的 `%*` 是刻意的参数透传
    expect(shim.trimEnd().endsWith('%*')).toBe(true);
    // 路径里的字面 % 必须写成 %% ，否则 cmd 会当成变量展开
    const literalPercent = buildCliShim({
      platform: 'win32',
      appRoot: 'C:\\100%\\CogSeed\\app.asar',
      runtimeBin: 'C:\\100%\\CogSeed.exe',
    });
    expect(literalPercent).toContain('set "COGSEED_PC_DIR=C:\\100%%\\CogSeed\\app.asar"');
    expect(literalPercent).toContain('"C:\\100%%\\CogSeed.exe"');
    // 除 `%*` 与已成对的 %% 外，不应再出现落单的 %
    const withoutPassthrough = shim.replace(/%\*\s*$/, '');
    expect(withoutPassthrough.replace(/%%/g, '')).not.toContain('%');
  });

  it('文件名：Windows 需要 .cmd 才能被 PATHEXT 解析', () => {
    expect(cliShimFileName('cogseed', 'win32')).toBe('cogseed.cmd');
    expect(cliShimFileName('cogseed', 'darwin')).toBe('cogseed');
  });
});

describe('cli_command · 安装位置', () => {
  it('选用户级目录（不需要提权，且与宿主平台无关）', () => {
    // 关键：在 Windows 主机上也要返回 posix 路径（曾用宿主 path.join → `\Users\me\.local\bin`）
    expect(defaultCliInstallDir('darwin', { HOME: '/Users/me' } as NodeJS.ProcessEnv)).toBe('/Users/me/.local/bin');
    expect(defaultCliInstallDir('darwin', { HOME: '/Users/me' } as NodeJS.ProcessEnv)).not.toContain('\\');
    expect(defaultCliInstallDir('linux', { HOME: '/home/me' } as NodeJS.ProcessEnv)).toBe('/home/me/.local/bin');
    expect(defaultCliInstallDir('linux', { HOME: '/home/me', XDG_BIN_HOME: '/home/me/bin' } as NodeJS.ProcessEnv)).toBe('/home/me/bin');
    expect(defaultCliInstallDir('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } as NodeJS.ProcessEnv))
      .toBe(path.win32.join('C:\\Users\\me\\AppData\\Local', 'CogSeed', 'bin'));
  });

  it('PATH 判定区分平台分隔符与大小写', () => {
    expect(isDirOnPath('/Users/me/.local/bin', { PATH: '/usr/bin:/Users/me/.local/bin' } as NodeJS.ProcessEnv, 'darwin')).toBe(true);
    expect(isDirOnPath('/Users/me/.local/bin', { PATH: '/usr/bin' } as NodeJS.ProcessEnv, 'darwin')).toBe(false);
    expect(isDirOnPath('C:\\Tools\\bin', { Path: 'C:\\Windows;C:\\Tools\\Bin\\' } as NodeJS.ProcessEnv, 'win32')).toBe(true);
  });
});

describe('cli_command · 安装 / 卸载 / 状态', () => {
  it('安装 → 幂等 → 过期 → 卸载，且只删自己写的文件', () => {
    const first = installCliCommand(spec(tmpDir));
    expect(first.changed).toBe(true);
    expect(fs.existsSync(first.path)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(first.path).mode & 0o111).toBeGreaterThan(0);
    }

    // 幂等：内容一致不重写
    expect(installCliCommand(spec(tmpDir)).changed).toBe(false);

    const fresh = cliCommandStatus(spec(tmpDir));
    expect(fresh).toMatchObject({ installed: true, stale: false, conflict: false });

    // 应用被移动 → 过期（提示重装），而不是静默继续用旧路径
    const stale = cliCommandStatus(spec(tmpDir, { appRoot: '/opt/cogseed/app-moved' }));
    expect(stale.installed).toBe(true);
    expect(stale.stale).toBe(true);

    const removed = uninstallCliCommand({ dir: tmpDir, platform: TEST_PLATFORM });
    expect(removed.removed).toEqual([first.path]);
    expect(fs.existsSync(first.path)).toBe(false);
    // 再卸载一次是 no-op
    expect(uninstallCliCommand({ dir: tmpDir, platform: TEST_PLATFORM }).removed).toEqual([]);
  });

  it('目标已存在且不是 CogSeed 写的 → 拒绝覆盖，也不删', () => {
    const foreign = shimPath(tmpDir);
    fs.writeFileSync(foreign, '#!/bin/sh\necho someone-elses-script\n');
    expect(() => installCliCommand(spec(tmpDir))).toThrow(CliShimConflictError);
    expect(fs.readFileSync(foreign, 'utf8')).toContain('someone-elses-script');
    expect(cliCommandStatus(spec(tmpDir))).toMatchObject({ installed: false, conflict: true });
    expect(uninstallCliCommand({ dir: tmpDir, platform: TEST_PLATFORM }).removed).toEqual([]);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('未安装时状态明确为未安装（不报错）', () => {
    const status = cliCommandStatus(spec(path.join(tmpDir, 'nope')));
    expect(status.installed).toBe(false);
    expect(status.conflict).toBe(false);
  });

  it.runIf(process.platform === 'win32')('安装出的 .cmd 真的能被 cmd 执行（第三轮真机验收项）', () => {
    const appRoot = tmpDir;
    const entry = path.join(appRoot, 'bin', 'cogseed-pkg.cjs');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "|" + process.env.COGSEED_UID);');
    const dir = path.join(tmpDir, 'cli-bin');
    const installed = installCliCommand({
      platform: 'win32',
      appRoot,
      runtimeBin: process.execPath,
      workspaceRoot: path.join(tmpDir, 'ws'),
      uid: 'u-42',
      dir,
    } as Parameters<typeof installCliCommand>[0]);
    expect(installed.path.endsWith('cogseed.cmd')).toBe(true);

    // .cmd 必须经 ComSpec 执行（CreateProcess 不能直接跑脚本）
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${installed.path}" list`], {
      encoding: 'utf8',
      // 不带这个标志，libuv 会把内嵌引号转义成 \" ，cmd 收到 \"C:\…\cogseed.cmd\" →
      // "不是内部或外部命令"。仓库自己的 resolveCliCommand 正是为此显式设置该标志。
      windowsVerbatimArguments: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('["list"]|u-42');
  });

  it.runIf(process.platform !== 'win32')('安装出的 shim 真的能被 shell 执行（脚本语法正确）', () => {
    const target = path.join(tmpDir, 'fake-cli.js');
    fs.writeFileSync(target, 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "|" + process.env.COGSEED_UID);');
    // 用当前 Node 当运行时，验证的是 shim 的语法与传参，不依赖 Electron
    const installed = installCliCommand(spec(tmpDir, {
      appRoot: tmpDir,
      runtimeBin: process.execPath,
      uid: 'u-42',
    }));
    const pkgEntry = path.join(tmpDir, 'bin', 'cogseed-pkg.cjs');
    fs.mkdirSync(path.dirname(pkgEntry), { recursive: true });
    fs.copyFileSync(target, pkgEntry);

    const result = spawnSync(installed.path, ['list', 'a b', '含空格'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('["list","a b","含空格"]|u-42');
  });
});
