import * as fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Shallow directory identity: metadata alone can miss adjacent Windows writes.
 * Includes child names/types, without reading file contents or recursing. */
export async function directoryEntryStamp(dir: string): Promise<string> {
  try {
    const st = await fsp.stat(dir);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const names = entries.map((entry) => [entry.name,
      entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'link' : 'other',
    ]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const digest = createHash('sha256').update(JSON.stringify(names)).digest('hex');
    return `${st.mtimeMs}:${st.size}:${digest}`;
  } catch {
    return 'missing';
  }
}
