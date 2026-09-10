import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

function works(candidate: string): boolean {
  const result = spawnSync(candidate, ['version'], { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}

function gitBundledOpenSsl(): string | null {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  const execPath = String(result.stdout || '').trim();
  if (!execPath) return null;
  const candidate = path.resolve(execPath, '..', '..', 'bin', 'openssl.exe');
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveOpenSsl(): string | null {
  const candidates = [process.env.OPENSSL, 'openssl', gitBundledOpenSsl()]
    .filter((candidate): candidate is string => !!candidate);
  for (const candidate of candidates) {
    if (works(candidate)) return candidate;
  }
  return null;
}

/** OpenSSL usable for generating ephemeral self-signed TLS test certificates. */
export const OPENSSL_EXECUTABLE = resolveOpenSsl();
