/**
 * `cogseed` 命令的安装/卸载/状态查询（终端侧驱动）。
 *
 *   npm run cli:install      # 安装或更新（幂等）
 *   npm run cli:status       # 状态（含是否在 PATH 上、是否已过期）
 *   npm run cli:uninstall    # 只删 CogSeed 自己写的那一个文件
 *
 * 为什么不 import `src/main/paths.ts`：它的 `WS_ROOT` 在模块加载时要求
 * `COGSEED_WORKSPACE_ROOT` 已由应用设好（`index.ts` 的 resolveInstallContainer 负责），
 * 终端脚本没有那个前置，import 即抛（Windows 验收报告里踩到过同一条）。
 * 这里自己解析，并在 shim 里把解析结果固定下来。
 *
 * 覆盖项：
 *   COGSEED_CLI_DIR      安装目录（默认 macOS/Linux `~/.local/bin`、Windows `%LOCALAPPDATA%\CogSeed\bin`）
 *   COGSEED_CLI_RUNTIME  运行时二进制（默认 dev 用 node_modules/electron，打包态用 process.execPath）
 *   COGSEED_WORKSPACE_ROOT / COGSEED_UID  数据根与活跃用户（默认按容器现状探测）
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CLI_COMMAND_NAME,
  CliShimConflictError,
  cliCommandStatus,
  defaultCliInstallDir,
  installCliCommand,
  isDirOnPath,
  uninstallCliCommand,
} from '../src/main/util/cli_command';

const REPO_ROOT = path.resolve(__dirname, '..');

/** 应用根：dev 为仓库根；打包态可用 COGSEED_PC_DIR 指到 app.asar。 */
function resolveAppRoot(): string {
  return process.env.COGSEED_PC_DIR || REPO_ROOT;
}

/** 运行时：优先显式指定；否则 dev 找 Electron 发行包，打包态用自身。 */
function resolveRuntimeBin(): string {
  if (process.env.COGSEED_CLI_RUNTIME) return process.env.COGSEED_CLI_RUNTIME;
  if (process.versions.electron) return process.execPath;
  const dist = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist');
  const candidates = process.platform === 'win32'
    ? [path.join(dist, 'electron.exe'), path.join(dist, 'CogSeed.exe')]
    : process.platform === 'darwin'
      ? [
        path.join(dist, 'CogSeed.app', 'Contents', 'MacOS', 'Electron'),
        path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron'),
      ]
      : [path.join(dist, 'electron')];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续找下一个
    }
  }
  throw new Error(`找不到 Electron 运行时（试过：${candidates.join(', ')}）。可用 COGSEED_CLI_RUNTIME 指定。`);
}

/** 数据根：显式 > 现存变体 > 默认容器。 */
function resolveWorkspaceRoot(): string {
  if (process.env.COGSEED_WORKSPACE_ROOT) return process.env.COGSEED_WORKSPACE_ROOT;
  const variant = path.join(os.homedir(), '.cogseed', 'runtime-variants', 'cogseed', 'data');
  if (fs.existsSync(path.join(variant, 'users.json'))) return variant;
  return path.join(os.homedir(), '.cogseed', 'data');
}

/** 活跃 uid：显式 > 容器 users.json（dev_current_user_id 优先）。 */
function resolveUid(workspaceRoot: string): string | undefined {
  if (process.env.COGSEED_UID) return process.env.COGSEED_UID;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'users.json'), 'utf8')) as Record<string, unknown>;
    for (const key of ['dev_current_user_id', 'current_user_id']) {
      const uid = parsed[key];
      if (typeof uid === 'string' && uid.trim()) return uid.trim();
    }
  } catch {
    // 没有容器（首次安装/全新机器）不是错误：不写 uid，交给 CLI 自行解析。
  }
  return undefined;
}

function buildSpec() {
  const appRoot = resolveAppRoot();
  const workspaceRoot = resolveWorkspaceRoot();
  return {
    platform: process.platform,
    appRoot,
    runtimeBin: resolveRuntimeBin(),
    workspaceRoot,
    uid: resolveUid(workspaceRoot),
    dir: process.env.COGSEED_CLI_DIR || defaultCliInstallDir(process.platform),
    commandName: CLI_COMMAND_NAME,
  };
}

function main(): void {
  const action = (process.argv[2] || 'status').trim();
  const spec = buildSpec();

  if (action === 'install') {
    let result;
    try {
      result = installCliCommand(spec);
    } catch (err) {
      // 冲突是"用户需要处理"的状态，不是崩溃：给一行中文并正常退出码 1。
      if (err instanceof CliShimConflictError) {
        console.log(`冲突：${err.target} 已存在且不是 CogSeed 写入的，未做改动。`);
        console.log('  如确认可以覆盖，请先自行删除该文件后重试。');
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    console.log(`${result.changed ? '已安装' : '已是最新'}：${result.path}`);
    console.log(`  运行时：${spec.runtimeBin}`);
    console.log(`  应用根：${spec.appRoot}`);
    console.log(`  数据根：${spec.workspaceRoot}${spec.uid ? `（uid ${spec.uid}）` : '（uid 未固定，交给 CLI 解析）'}`);
    if (!isDirOnPath(spec.dir)) console.log(`提示：${spec.dir} 不在 PATH 上，请加入后重开终端。`);
    console.log(`自检：${spec.commandName} list`);
    return;
  }

  if (action === 'uninstall') {
    const { removed } = uninstallCliCommand(spec);
    console.log(removed.length ? `已删除：${removed.join(', ')}` : '没有找到 CogSeed 写入的命令（未做改动）。');
    return;
  }

  const status = cliCommandStatus(spec);
  if (status.conflict) {
    console.log(`冲突：${status.path} 已存在且不是 CogSeed 写入的，未做改动。`);
    return;
  }
  console.log(
    status.installed
      ? `${status.stale ? '已安装但已过期（应用路径可能变了）→ 建议重跑 cli:install' : '已安装且是最新'}：${status.path}`
      : `未安装（目标位置：${status.path}）`,
  );
  console.log(`  安装目录在 PATH 上：${isDirOnPath(spec.dir) ? '是' : '否'}`);
  console.log(`  运行时：${spec.runtimeBin}`);
  console.log(`  应用根：${spec.appRoot}`);
}

main();
