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
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))',
  ];
  for (const root of writable) lines.push(`(allow file-write* (subpath ${quote(root)}))`);
  for (const protectedPath of protectedPaths) {
    lines.push(`(deny file-write* (subpath ${quote(protectedPath)}))`);
  }
  return lines.join('\n');
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
    const writable = uniqueCanonical([
      ...(policy.workspaceRoot ? [policy.workspaceRoot] : []),
      ...(policy.writableRoots || []),
      ...(policy.tempRoots || []),
    ]);
    const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
    for (const root of writable) args.push('--bind', root, root);
    args.push('--', '/bin/sh', '-c', command);
    return {
      file: opts.executable || 'bwrap',
      args,
      enforcement: 'os-full',
    };
  }
  return null;
}
