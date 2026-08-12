import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { mateRuntimeContextsDir } from '../../../../paths';
import { genId12, nowIso, safeId, writeJson } from '../../../../storage';
import { normalizeRuntimePath } from '../tools/permissions';

export interface RuntimeImportedContextFile {
  contextId: string;
  path: string;
  sourcePath: string;
  bytes: number;
  createdAt: string;
}

function assertContextId(contextId: string): string {
  if (!safeId(contextId)) throw new Error('invalid runtime context id');
  return contextId;
}

function safeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[\\/:\0]/g, '_').trim();
  return base || 'context.txt';
}

export function runtimeContextImportDir(uid: string, contextId: string): string {
  return path.join(mateRuntimeContextsDir(uid), 'imports', assertContextId(contextId));
}

export function runtimeContextImportFile(uid: string, contextId: string, fileName: string): string {
  return path.join(runtimeContextImportDir(uid, contextId), safeFileName(fileName));
}

export async function importRuntimeContextFile(
  uid: string,
  sourcePath: string,
  opts: { allowedRoots: readonly string[]; contextId?: string; fileName?: string } = { allowedRoots: [] },
): Promise<RuntimeImportedContextFile> {
  const normalizedSource = normalizeRuntimePath(sourcePath, opts.allowedRoots);
  const contextId = assertContextId(opts.contextId || `ctx-${genId12()}`);
  const destination = runtimeContextImportFile(uid, contextId, opts.fileName || path.basename(normalizedSource));
  const stat = await fs.stat(normalizedSource);
  if (!stat.isFile()) throw new Error('runtime context source must be a file');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(normalizedSource, destination);
  const createdAt = nowIso();
  const out: RuntimeImportedContextFile = {
    contextId,
    path: destination,
    sourcePath: normalizedSource,
    bytes: stat.size,
    createdAt,
  };
  await writeJson(path.join(runtimeContextImportDir(uid, contextId), 'meta.json'), {
    context_id: contextId,
    source_path: normalizedSource,
    file_name: path.basename(destination),
    bytes: stat.size,
    created_at: createdAt,
  });
  return out;
}
