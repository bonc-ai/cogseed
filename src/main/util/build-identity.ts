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
  if (options.packagedInfoPath) {
    try {
      const raw = (options.readFile || ((p) => fs.readFileSync(p, 'utf8')))(options.packagedInfoPath);
      const parsed = JSON.parse(raw);
      return {
        channel: channelOf(parsed?.channel),
        commit: text(parsed?.commit),
        dirty: dirtyOf(parsed?.dirty),
        builtAt: text(parsed?.builtAt),
      };
    } catch { /* missing/malformed build metadata */ }
  }
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
