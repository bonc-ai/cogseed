import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

export type BuildChannel = 'dev' | 'packaged-dev' | 'release' | 'unknown';
export interface BuildIdentity {
  channel: BuildChannel;
  commit: string;
  dirty: boolean | null;
  builtAt: string;
}

function channelOf(value: unknown): BuildChannel {
  return value === 'dev' || value === 'packaged-dev' || value === 'release' ? value : 'unknown';
}
function dirtyOf(value: unknown): boolean | null {
  if (value === true || value === '1' || value === 1 || value === 'true') return true;
  if (value === false || value === '0' || value === 0 || value === 'false') return false;
  return null;
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }

export function resolveBuildIdentity(options: {
  env?: Record<string, string | undefined>;
  packagedInfoPath?: string;
  readFile?: (filePath: string) => string;
} = {}): BuildIdentity {
  const env = options.env || process.env;
  const envHasIdentity = !!(env.COGSEED_BUILD_CHANNEL || env.COGSEED_BUILD_COMMIT || env.COGSEED_BUILD_TIME || env.COGSEED_BUILD_DIRTY);
  if (envHasIdentity) {
    return {
      channel: channelOf(env.COGSEED_BUILD_CHANNEL),
      commit: text(env.COGSEED_BUILD_COMMIT),
      dirty: dirtyOf(env.COGSEED_BUILD_DIRTY),
      builtAt: text(env.COGSEED_BUILD_TIME),
    };
  }
  const readBuildInfo = (filePath: string): BuildIdentity | null => {
    try {
      const raw = (options.readFile || ((p) => fs.readFileSync(p, 'utf8')))(filePath);
      const parsed = JSON.parse(raw);
      return {
        channel: channelOf(parsed?.channel),
        commit: text(parsed?.commit),
        dirty: dirtyOf(parsed?.dirty),
        builtAt: text(parsed?.builtAt),
      };
    } catch { return null; /* missing/malformed build metadata */ }
  };
  if (options.packagedInfoPath) {
    const fromPath = readBuildInfo(options.packagedInfoPath);
    if (fromPath) return fromPath;
  }
  // 打包环境兜底：gate.ts / client.ts 等 feature 调用点不带参调用，env 里也没有
  // COGSEED_BUILD_*（electron-builder 产物没有 run.sh 注入环境变量）。此时从
  // app 资源根读打包时写入的 .build/build-info.json，保证 packaged-dev 渠道、
  // Hub API 默认地址与发布 Gate 判定正确。dev 源码模式由 run.sh 的环境变量
  // 分支先行命中，不走到这里。
  try {
    if (app && app.isPackaged) {
      const candidate = path.join(app.getAppPath(), '.build', 'build-info.json');
      const fromApp = readBuildInfo(candidate);
      if (fromApp) return fromApp;
      // 兜底:包内 package.json 的 cogseedBuildChannel(由 build.extraMetadata
      // 注入,任意 electron-builder 构建都会携带)。没有它,源码用户自行打包
      // 的产物会落回 unknown → 客户端把更新/市场等请求打到 localhost:3000。
      try {
        const pkgRaw = (options.readFile || ((p) => fs.readFileSync(p, 'utf8')))(
          path.join(app.getAppPath(), 'package.json'),
        );
        const pkg = JSON.parse(pkgRaw) as { cogseedBuildChannel?: unknown };
        const fallbackChannel = channelOf(pkg?.cogseedBuildChannel);
        if (fallbackChannel !== 'unknown') {
          return { channel: fallbackChannel, commit: '', dirty: null, builtAt: '' };
        }
      } catch { /* not found / malformed → unknown below */ }
    }
  } catch { /* not running under electron / app api missing */ }
  return { channel: 'unknown', commit: '', dirty: null, builtAt: '' };
}

export function shortBuildCommit(commit: string): string { return text(commit).slice(0, 7); }

export function formatBuildIdentityLabel(version: string, identity: BuildIdentity): string {
  const raw = text(version);
  const versionLabel = raw ? (raw.toLowerCase().startsWith('v') ? raw : `v${raw}`) : '';
  if (identity.channel === 'release' || identity.channel === 'unknown') return versionLabel;
  const commit = shortBuildCommit(identity.commit);
  const commitLabel = commit ? `${commit}${identity.dirty ? '-dirty' : ''}` : (identity.dirty ? 'dirty' : 'unknown');
  return [versionLabel, identity.channel, commitLabel].filter(Boolean).join(' · ');
}
