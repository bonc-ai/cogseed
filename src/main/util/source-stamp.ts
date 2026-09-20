/**
 * 主进程源码指纹 —— 用来发现「这个 Electron 进程加载的是磁盘上已经不存在的旧代码」。
 *
 * 背景（真机事故 2026-09-16）：`bootstrap.cjs` 用 `tsx` 在**进程启动那一刻**加载
 * `src/main/**\/*.ts`（dev 无编译步骤），而渲染层是普通 `.js`，**每次刷新窗口都会
 * 重读磁盘**。于是出现半更新：界面已是新代码、主进程还是旧代码。界面把新参数
 * （如 kb.mindmap 的 `doc`）发给旧主进程，旧主进程不认识就静默忽略、退回整库读取，
 * 用户拿到一张"别的文件拼出来的脑图"且完全看不出来（详见 kb_mindmap.ts 里的
 * scope 回执注释）。
 *
 * 这里为启动通道（IPC `cogseed.env`）提供两个事实：**进程启动时刻**与**磁盘上
 * src/main 的最新 mtime**。前者早于后者 ⇒ 有改动没生效。渲染层据此显示横幅并
 * 提供一键重启，把"忘记重启"从静默故障变成显式提示。
 *
 * 纯 dev 关注项：打包版跑的是 bundle，walk 不到 `.ts` 源码 → 返回 null，检测自动关闭
 * （打包产物里 main 与 renderer 同批构建，本来就不存在这种错配）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SourceStamp {
  /** 参与统计的文件数（0 表示没扫到源码，调用方应视为"不可用"）。 */
  files: number;
  /** 这些文件里最新的 mtime（毫秒）。 */
  maxMtimeMs: number;
}

/** 只看源码：编译产物 / 依赖 / VCS 目录都不参与。 */
const SOURCE_EXT = new Set(['.ts', '.cts', '.mts', '.js', '.cjs', '.mjs']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.build', 'coverage', '__pycache__', '.cache']);

/**
 * 递归统计 roots（文件或目录）里源码文件的数量与最新 mtime。纯函数式：不读全局
 * 配置、不缓存，便于单测用临时目录直接验证。
 *
 * 返回 null 表示"扫不到任何源码"（打包环境、路径不存在）——此时调用方必须
 * **不要**据此报警，否则打包版会误报。
 */
export function computeSourceStamp(roots: Array<string | null | undefined>): SourceStamp | null {
  let files = 0;
  let maxMtimeMs = 0;
  const visit = (p: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return; // 权限/竞态导致的读失败：跳过，不算错
    }
    for (const ent of entries) {
      const abs = path.join(p, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIR.has(ent.name)) continue;
        visit(abs);
        continue;
      }
      if (!ent.isFile() || !SOURCE_EXT.has(path.extname(ent.name))) continue;
      try {
        const st = fs.statSync(abs);
        files += 1;
        if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
      } catch { /* 文件在遍历中被删：忽略 */ }
    }
  };

  for (const root of roots) {
    if (!root) continue;
    let st: fs.Stats | null = null;
    try { st = fs.statSync(root); } catch { st = null; }
    if (!st) continue;
    if (st.isDirectory()) {
      visit(root);
    } else if (st.isFile() && SOURCE_EXT.has(path.extname(root))) {
      files += 1;
      if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
    }
  }

  return files > 0 ? { files, maxMtimeMs } : null;
}

/**
 * 判定"主进程代码已过期"。
 *
 * `toleranceMs` 用来吸收两个无关噪声：文件系统 mtime 粒度、以及启动瞬间
 * 恰好有工具在写文件。默认 2s 足够大（人的编辑动作与进程启动不会在 2s 内混同），
 * 又足够小（真出问题时 mtime 会比启动时刻晚几分钟到几小时）。
 */
export function isMainSourceStale(
  stamp: SourceStamp | null,
  startedAtMs: number,
  toleranceMs = 2000,
): boolean {
  if (!stamp || !Number.isFinite(startedAtMs) || startedAtMs <= 0) return false;
  return stamp.maxMtimeMs > startedAtMs + toleranceMs;
}

/** 进程启动时刻（本进程加载 main 代码的时刻）。 */
export function processStartedAtMs(now = Date.now(), uptimeSec = process.uptime()): number {
  return Math.round(now - uptimeSec * 1000);
}

/**
 * 生产包装：解析本仓库的 main 侧源码根并统计。
 * `pcRoot` 由调用方注入（`paths.PC_ROOT`），避免本模块依赖 paths（便于单测）。
 */
export function resolveMainSourceStamp(pcRoot: string): SourceStamp | null {
  return computeSourceStamp([path.join(pcRoot, 'src', 'main'), path.join(pcRoot, 'bootstrap.cjs')]);
}

/** `cogseed.env` 里关于"主进程代码是否过期"的那几个字段。 */
export interface StaleMainReport {
  /** 本进程加载 main 代码的时刻（epoch ms）。 */
  processStartedAtMs: number;
  /** 参与统计的 main 侧源码文件数；null = 不适用（打包版 / 扫不到）。 */
  mainSourceFiles: number | null;
  /** 磁盘上 main 源码的最新 mtime（ISO）；null = 不适用。 */
  mainSourceChangedAt: string | null;
  /** 磁盘上的 main 源码比本进程启动更新 ⇒ 有改动没生效。 */
  mainSourceStale: boolean;
}

/**
 * 组装启动通道用的检测结果（纯函数，便于用**真实事故时刻**做回归）。
 * 打包版直接返回"不适用"，绝不在生产里误报。
 */
export function buildStaleMainReport(opts: {
  pcRoot: string;
  isPackaged: boolean;
  startedAtMs?: number;
  now?: number;
  uptimeSec?: number;
}): StaleMainReport {
  const startedAtMs = opts.startedAtMs ?? processStartedAtMs(opts.now, opts.uptimeSec);
  if (opts.isPackaged) {
    return { processStartedAtMs: startedAtMs, mainSourceFiles: null, mainSourceChangedAt: null, mainSourceStale: false };
  }
  const stamp = resolveMainSourceStamp(opts.pcRoot);
  return {
    processStartedAtMs: startedAtMs,
    mainSourceFiles: stamp ? stamp.files : null,
    mainSourceChangedAt: stamp ? new Date(stamp.maxMtimeMs).toISOString() : null,
    mainSourceStale: isMainSourceStale(stamp, startedAtMs),
  };
}
