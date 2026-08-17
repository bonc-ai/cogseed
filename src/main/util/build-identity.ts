import * as fs from 'node:fs';

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
  const envHasIdentity = !!(env.ORKAS_BUILD_CHANNEL || env.ORKAS_BUILD_COMMIT || env.ORKAS_BUILD_TIME || env.ORKAS_BUILD_DIRTY);
  if (envHasIdentity) {
    return {
      channel: channelOf(env.ORKAS_BUILD_CHANNEL),
      commit: text(env.ORKAS_BUILD_COMMIT),
      dirty: dirtyOf(env.ORKAS_BUILD_DIRTY),
      builtAt: text(env.ORKAS_BUILD_TIME),
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
  // ORKAS_BUILD_*（electron-builder 产物没有 run.sh 注入环境变量）。此时从
  // app 资源根读打包时写入的 .build/build-info.json，保证 packaged-dev 渠道、
  // Hub API 默认地址与发布 Gate 判定正确。dev 源码模式由 run.sh 的环境变量
  // 分支先行命中，不走到这里。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { app } = require('electron') as { app?: { isPackaged: boolean; getAppPath: () => string } };
    if (app && app.isPackaged) {
      const candidate = require('node:path').join(app.getAppPath(), '.build', 'build-info.json');
      const fromApp = readBuildInfo(candidate);
      if (fromApp) return fromApp;
    }
  } catch { /* not running under electron */ }
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
