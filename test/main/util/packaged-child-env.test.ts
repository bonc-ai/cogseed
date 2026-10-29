import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  childWorkerScriptPath,
  esbuildBinaryPath,
  typescriptChildEnv,
  unpackedResourcePath,
} from '../../../src/main/util/packaged-child-env';

/**
 * 这个模块存在的唯一理由，是打包态里 **两个根不是同一个**：
 *   - `bin/**` 与原生二进制在 `app.asar.unpacked`
 *   - `.ts` 入口在 `app.asar`
 * 把它俩指到同一个根，就是 1.2.0 出厂版里 KB 嵌入 worker 永远起不来的原因
 * （子进程去 `app.asar.unpacked/src/main/features/kb_embed_worker_entry.ts`
 * 找 TS 源，而那里没有源码 → `exited (code 1)` → 永久回落主进程）。
 *
 * 所以本用例锁的不是"函数能跑"，而是**两个根必须分开**这条不变量。
 */

const temps: string[] = [];

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-packaged-'));
  temps.push(dir);
  return dir;
}

/**
 * 当前 runner 上 `esbuildBinaryPath()` 真正会解析到的 payload 形状
 * （对齐 `src/main/util/packaged-child-env.ts` 的 `ESBUILD_PLATFORM_PACKAGES`）。
 *
 * 之前这里把 `darwin-arm64` 写死：只有 macOS arm64 runner 能过，Linux/Windows
 * runner 上 `typescriptChildEnv()` 按自身 platform/arch 找不到 payload，于是
 * `ESBUILD_BINARY_PATH` 是 undefined，断言把平台差异报成了回归。夹具按运行平台
 * 生成，断言再从同一份 payload 推出期望路径。
 */
function currentEsbuildPayload(): string[] {
  const packageName = `${process.platform}-${process.arch}`;
  return process.platform === 'win32'
    ? ['@esbuild', packageName, 'esbuild.exe']
    : ['@esbuild', packageName, 'bin', 'esbuild'];
}

/**
 * Electron 的 asar fs 包装器在 **Windows** 上把任何 `*.asar/<child>` 的 `mkdir`
 * 直接判成 `ENOTDIR, not a directory`（asar-fs-wrapper 的 win32 分支：
 * `if (isAsar && filePath.length) throw createError('NOT_DIR')`），即使
 * `app.asar` 只是这里临时造的空目录。夹具是纯路径树、不是真归档，所以建树期间
 * 用 Electron 的 `process.noAsar` 关掉拦截，建完立刻恢复，避免影响同文件的其它
 * 断言（`existsSync`/`rmSync` 走真实磁盘路径）。
 */
function createFakeAsarTree(build: () => void): void {
  const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
  const previous = electronProcess.noAsar;
  electronProcess.noAsar = true;
  try {
    build();
  } finally {
    electronProcess.noAsar = previous;
  }
}

/** 造一个最小的"打包态"目录：app.asar 与 app.asar.unpacked 并存。 */
function makePackagedLayout(options: { esbuild?: string[] } = {}): { asarRoot: string } {
  const base = makeTempRoot();
  const asarRoot = path.join(base, 'app.asar');
  const unpacked = path.join(base, 'app.asar.unpacked');
  fs.mkdirSync(path.join(unpacked, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'bin', 'cogseed-embed-worker.cjs'), '// worker\n');
  fs.writeFileSync(path.join(unpacked, 'bin', 'child-electron-stub.cjs'), '// stub\n');
  // `.ts` 入口只存在于 asar 内（打包时不进 asarUnpack）。
  createFakeAsarTree(() => {
    fs.mkdirSync(path.join(asarRoot, 'src', 'main', 'features'), { recursive: true });
    fs.writeFileSync(path.join(asarRoot, 'src', 'main', 'features', 'kb_embed_worker_entry.ts'), '// entry\n');
  });
  if (options.esbuild) {
    const bin = path.join(unpacked, 'node_modules', ...options.esbuild);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\n');
  }
  return { asarRoot };
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true });
});

describe('packaged child env', () => {
  it('splits the two roots: script from asar.unpacked, COGSEED_PC_DIR on the asar root', () => {
    const { asarRoot } = makePackagedLayout({ esbuild: currentEsbuildPayload() });
    const script = childWorkerScriptPath('cogseed-embed-worker.cjs', asarRoot);
    const env = typescriptChildEnv(asarRoot);

    expect(script).toBe(path.join(unpackedResourcePath(asarRoot), 'bin', 'cogseed-embed-worker.cjs'));
    expect(script).toContain(`app.asar.unpacked${path.sep}bin${path.sep}`);
    // 关键不变量：入口根必须是 asar 本身，绝不能是 unpacked。
    expect(env.COGSEED_PC_DIR).toBe(asarRoot);
    expect(env.COGSEED_PC_DIR).not.toContain('app.asar.unpacked');
    // 两者指向同一根 = 1.2.0 的缺陷形态，这里显式排除。
    expect(path.dirname(path.dirname(script))).not.toBe(env.COGSEED_PC_DIR);
  });

  it('points ESBUILD_BINARY_PATH at the unpacked esbuild binary', () => {
    const { asarRoot } = makePackagedLayout({ esbuild: currentEsbuildPayload() });
    const env = typescriptChildEnv(asarRoot);
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.ESBUILD_BINARY_PATH).toBe(
      path.join(unpackedResourcePath(asarRoot), 'node_modules', ...currentEsbuildPayload()),
    );
    expect(fs.existsSync(env.ESBUILD_BINARY_PATH as string)).toBe(true);
  });

  it('omits ESBUILD_BINARY_PATH instead of emitting an empty string when esbuild is absent', () => {
    const { asarRoot } = makePackagedLayout();
    const env = typescriptChildEnv(asarRoot);
    expect(env).not.toHaveProperty('ESBUILD_BINARY_PATH');
    expect(Object.values(env).every((v) => v.length > 0)).toBe(true);
  });

  it('maps per-platform esbuild payload names, and returns undefined for unsupported platforms', () => {
    const { asarRoot } = makePackagedLayout({ esbuild: ['@esbuild', 'win32-x64', 'esbuild.exe'] });
    expect(esbuildBinaryPath(asarRoot, 'win32', 'x64')).toBe(
      path.join(unpackedResourcePath(asarRoot), 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    );
    // 该平台上没有对应 payload → undefined（而不是抛错或返回错路径）。
    expect(esbuildBinaryPath(asarRoot, 'darwin', 'arm64')).toBeUndefined();
    expect(esbuildBinaryPath(asarRoot, 'sunos', 'sparc')).toBeUndefined();
    expect(esbuildBinaryPath(asarRoot, 'win32', 'ia32')).toBeUndefined();
  });

  it('is a no-op for dev roots that contain no asar segment', () => {
    const dev = makeTempRoot();
    fs.mkdirSync(path.join(dev, 'bin'), { recursive: true });
    expect(unpackedResourcePath(dev)).toBe(dev);
    expect(childWorkerScriptPath('cogseed-embed-worker.cjs', dev)).toBe(
      path.join(dev, 'bin', 'cogseed-embed-worker.cjs'),
    );
    expect(typescriptChildEnv(dev).COGSEED_PC_DIR).toBe(dev);
  });

  it('keeps both TS child scripts reading the entry from COGSEED_PC_DIR with the electron alias armed first', () => {
    // 半边契约：spawn 侧给对了根，子进程脚本侧还得按同一个根去 require 入口，
    // 并且在 require 入口之前把 `electron` 裸导入接管掉（devDependency 不随包）。
    for (const name of ['cogseed-embed-worker.cjs', 'cogseed-runtime-worker.cjs']) {
      const src = fs.readFileSync(path.join(process.cwd(), 'bin', name), 'utf8');
      const entryRequire = src.indexOf("require(path.join(pcDir, 'src/main/features/");
      const stubAlias = src.indexOf("if (request === 'electron') return electronStub;");
      expect(src, name).toContain('process.env.COGSEED_PC_DIR');
      expect(entryRequire, name).toBeGreaterThan(-1);
      expect(stubAlias, name).toBeGreaterThan(-1);
      // 别名必须早于入口 require，否则入口图里的 electron 导入已经先失败了。
      expect(stubAlias, name).toBeLessThan(entryRequire);
      // 入口路径必须来自 pcDir（运行时给定的根），而不是 __dirname 推断。
      expect(src.slice(entryRequire, entryRequire + 40), name).toContain('pcDir');
    }
  });
});
