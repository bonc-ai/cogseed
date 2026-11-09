/**
 * OS-level file-effect sandbox for the runtime bash tool.
 *
 * Phase 3 starts with macOS Seatbelt (`sandbox-exec`), which is available on
 * stock macOS. Linux Landlock/bwrap remain a follow-up backend. The wrapper is
 * opt-in (`COGSEED_OS_SANDBOX=1`) until the rollout gates pass; the in-process
 * path sandbox remains the always-on first layer.
 */

import { canonicalizePath } from '../../../../util/path-sandbox';

export interface OsSandboxPolicy {
  workspaceRoot?: string;
  writableRoots?: readonly string[];
  protectedPaths?: readonly string[];
  tempRoots?: readonly string[];
  /** Full-access mode still protects CogSeed private stores. */
  allowAllWrites?: boolean;
}

export interface WrappedBashCommand {
  file: string;
  args: string[];
  enforcement: 'os-full' | 'os-partial';
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function uniqueCanonical(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values || []) {
    if (!value || typeof value !== 'string') continue;
    const canonical = canonicalizePath(value);
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

export function buildSeatbeltProfile(policy: OsSandboxPolicy): string {
  const writable = uniqueCanonical([
    ...(policy.workspaceRoot ? [policy.workspaceRoot] : []),
    ...(policy.writableRoots || []),
    ...(policy.tempRoots || []),
  ]);
  const protectedPaths = uniqueCanonical(policy.protectedPaths);
  const lines = [
    '(version 1)',
    '(allow default)',
  ];
  if (!policy.allowAllWrites) {
    lines.push('(deny file-write*)', '(allow file-write* (literal "/dev/null"))');
    for (const root of writable) lines.push(`(allow file-write* (subpath ${quote(root)}))`);
  }
  for (const protectedPath of protectedPaths) {
    lines.push(`(deny file-read* (subpath ${quote(protectedPath)}))`);
    lines.push(`(deny file-write* (subpath ${quote(protectedPath)}))`);
  }
  return lines.join('\n');
}

/** Wrap a direct process (not a shell command) with the same OS sandbox.
 *  Returns null when the backend is unavailable for the target platform. */
export function wrapProcessForOsSandbox(
  file: string,
  args: readonly string[],
  policy: OsSandboxPolicy,
  opts: { platform?: NodeJS.Platform; executable?: string } = {},
): WrappedBashCommand | null {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    return {
      file: opts.executable || '/usr/bin/sandbox-exec',
      args: ['-p', buildSeatbeltProfile(policy), file, ...args],
      enforcement: 'os-full',
    };
  }
  if (platform === 'linux') {
    const wrapped = buildLinuxArgs(policy, file, args);
    return { file: opts.executable || 'bwrap', args: wrapped, enforcement: 'os-full' };
  }
  return null;
}

function buildLinuxArgs(policy: OsSandboxPolicy, file: string, args: readonly string[]): string[] {
  const writable = uniqueCanonical([
    ...(policy.workspaceRoot ? [policy.workspaceRoot] : []),
    ...(policy.writableRoots || []),
    ...(policy.tempRoots || []),
  ]);
  const protectedPaths = uniqueCanonical(policy.protectedPaths);
  const out = policy.allowAllWrites
    ? ['--dev-bind', '/', '/']
    : ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
  if (!policy.allowAllWrites) {
    for (const root of writable) out.push('--bind', root, root);
  }
  for (const protectedPath of protectedPaths) out.push('--tmpfs', protectedPath);
  out.push('--', file, ...args);
  return out;
}

/** Wrap a shell command for the current platform, or return null when the
 *  backend is unavailable/disabled. Callers must still keep the in-process
 *  path checks enabled. */
export function wrapBashForOsSandbox(
  command: string,
  policy: OsSandboxPolicy,
  opts: { platform?: NodeJS.Platform; executable?: string } = {},
): WrappedBashCommand | null {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    const executable = opts.executable || '/usr/bin/sandbox-exec';
    return {
      file: executable,
      args: ['-p', buildSeatbeltProfile(policy), '/bin/sh', '-c', command],
      enforcement: 'os-full',
    };
  }
  if (platform === 'linux') {
    return {
      file: opts.executable || 'bwrap',
      args: buildLinuxArgs(policy, '/bin/sh', ['-c', command]),
      enforcement: 'os-full',
    };
  }
  return null;
}
