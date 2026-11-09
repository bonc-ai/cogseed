import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Transport } from './types';

export function isAppleMcp(id: string): boolean {
  return id === 'apple-reminders' || id === 'apple-notes';
}

function executable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveBinary(name: string, overrideVariable: string, preferredDirectories: string[] = []): string | undefined {
  const override = process.env[overrideVariable];
  if (override) return path.isAbsolute(override) && executable(override) ? override : undefined;
  const home = os.homedir();
  const directories = [
    ...preferredDirectories,
    ...(process.env.PATH || '').split(path.delimiter).filter(directory => path.isAbsolute(directory)),
    path.join(home, 'bin'), path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
  ];
  const versions = path.join(home, '.nvm', 'versions', 'node');
  if (fs.existsSync(versions)) {
    try {
      directories.push(...fs.readdirSync(versions)
        .filter(version => /^v\d+\.\d+\.\d+$/.test(version) && Number(version.slice(1).split('.')[0]) >= 20)
        .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }))
        .map(version => path.join(versions, version, 'bin')));
    } catch {}
  }
  return directories.map(directory => path.join(directory, name)).find(executable);
}

function appleExecutables(id: string): { command: string; node?: string } | undefined {
  if (id === 'apple-reminders') {
    const command = resolveBinary('remctl', 'COGSEED_REMCTL_BIN');
    return command ? { command } : undefined;
  }
  const command = resolveBinary('npx', 'COGSEED_APPLE_NPX_BIN');
  if (!command) return undefined;
  const node = resolveBinary('node', 'COGSEED_APPLE_NODE_BIN', [path.dirname(command)]);
  return node ? { command, node } : undefined;
}

export function appleMcpDisabledReason(id: string): 'macos_only' | 'cli_missing' | undefined {
  if (!isAppleMcp(id)) throw new Error('unknown Apple connector');
  if (process.platform !== 'darwin') return 'macos_only';
  return appleExecutables(id) ? undefined : 'cli_missing';
}

export function resolveAppleMcpTransport(id: string): Transport {
  const reason = appleMcpDisabledReason(id);
  if (reason) throw Object.assign(new Error(reason === 'macos_only' ? 'apple_mcp_macos_only' : 'apple_mcp_dependency_missing'), { code: reason });
  const binaries = appleExecutables(id);
  if (!binaries) throw new Error('apple_mcp_dependency_missing');
  const { command, node } = binaries;
  return {
    kind: 'stdio', command,
    args: id === 'apple-reminders' ? ['mcp', 'serve'] : ['-y', 'apple-notes-mcp@2.15.14'],
    env: { PATH: [...(node ? [path.dirname(node)] : []), path.dirname(command), process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(path.delimiter) },
  };
}
