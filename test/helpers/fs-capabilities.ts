import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const DIRECTORY_LINK_TYPE: fs.symlink.Type = process.platform === 'win32'
  ? 'junction'
  : 'dir';

function probeSymlink(type: fs.symlink.Type): boolean {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-symlink-probe-'));
  const target = path.join(root, type === 'file' ? 'target.txt' : 'target');
  const link = path.join(root, 'link');
  try {
    if (type === 'file') fs.writeFileSync(target, 'probe');
    else fs.mkdirSync(target);
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (['EACCES', 'EINVAL', 'ENOSYS', 'EPERM'].includes(String(code))) return false;
    throw error;
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function probeFileModeBits(): boolean {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-file-mode-probe-'));
  const file = path.join(root, 'private.txt');
  try {
    fs.writeFileSync(file, 'probe', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return (fs.statSync(file).mode & 0o777) === 0o600;
  } catch {
    return false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** Whether this test worker can create file symlinks with its current token. */
export const FILE_SYMLINKS_SUPPORTED = probeSymlink('file');

/** Whether this test worker can create the native directory-link fixture. */
export const DIRECTORY_LINKS_SUPPORTED = probeSymlink(DIRECTORY_LINK_TYPE);

/** Whether chmod/stat expose enforceable POSIX permission bits on this filesystem. */
export const FILE_MODE_BITS_SUPPORTED = probeFileModeBits();
