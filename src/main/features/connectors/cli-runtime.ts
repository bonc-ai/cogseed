/**
 * On-demand, app-owned vendor runtimes. Only pinned archives from the checked-in manifest are
 * accepted. No package manager, install scripts, shells, or arbitrary archive paths are executed.
 * A verified staging directory is promoted atomically; a failed/cancelled attempt can be retried.
 * Archive and executable hashes are pinned together; a child process is not an OS sandbox.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { t as listTar } from 'tar';
import AdmZip from 'adm-zip';
import { userConnectorRuntimeDir, userConnectorCliStateDir } from '../../paths';
import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import manifest from './cli-runtime-manifest.json';
import type { Transport } from './types';

interface Asset {
  urls: string[]; integrity: string; binarySha256: string; format: 'tar' | 'zip'; binary: string; files: string[];
  nested?: string; nestedFormat?: 'tar' | 'zip';
}
interface Runtime { version: string; env: string; assets: Record<string, Asset> }
export interface RuntimeProgress {
  phase: 'downloading' | 'verifying' | 'installing'; percent?: number;
}
const runtimes = manifest as Record<string, Runtime>;
const MAX_BYTES = 160 * 1024 * 1024;
const log = createLogger('connector-cli-runtime');
const jobs = new Map<string, { controller: AbortController; promise: Promise<{ ready: true }>; progress: RuntimeProgress }>();
const verified = new Map<string, string>();

function failure(code: string): Error { return Object.assign(new Error(code), { code }); }
function validateUid(uid: string): void {
  if (!safeId(uid)) throw failure('invalid_user_id');
}
function runtime(id: string): Runtime | undefined { return Object.hasOwn(runtimes, id) ? runtimes[id] : undefined; }
function assetFor(id: string): Asset | undefined { return runtime(id)?.assets[`${process.platform}-${process.arch}`]; }
function destination(uid: string, id: string): string {
  validateUid(uid);
  const spec = runtime(id);
  if (!spec || !assetFor(id)) throw failure('connector_runtime_unsupported');
  return path.join(userConnectorRuntimeDir(uid), id, `${spec.version}-${process.platform}-${process.arch}`);
}
export function canPrepareConnectorRuntime(id: string): boolean { return !!assetFor(id); }
export function connectorRuntimeProgress(uid: string, id: string): RuntimeProgress | undefined {
  if (!canPrepareConnectorRuntime(id)) return undefined;
  return jobs.get(destination(uid, id))?.progress;
}

/** Filesystem-only readiness. Never download on startup, discovery, or a model tool call. */
export function managedConnectorBinary(uid: string, id: string): string | null {
  const asset = assetFor(id);
  if (!asset) return null;
  const dir = destination(uid, id);
  const binary = path.join(dir, asset.binary);
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return null;
    const stat = fs.lstatSync(binary);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return null;
    fs.accessSync(binary, fs.constants.X_OK);
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (verified.get(binary) === stamp) return binary;
    if (asset.binarySha256 !== createHash('sha256').update(fs.readFileSync(binary)).digest('hex')) return null;
    verified.set(binary, stamp);
    return binary;
  } catch { return null; }
}

async function download(asset: Asset, target: string, signal: AbortSignal, progress: (value: RuntimeProgress) => void): Promise<void> {
  for (let i = 0; i < asset.urls.length; i++) {
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(10 * 60_000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    try {
      const response = await fetch(asset.urls[i], { signal: requestSignal });
      if (!response.ok || !response.body) throw failure('connector_runtime_download_failed');
      const total = Number(response.headers.get('content-length'));
      if (total > MAX_BYTES) { await response.body.cancel(); throw failure('connector_runtime_archive_invalid'); }
      const file = await fs.promises.open(target, 'w', 0o600);
      const reader = response.body.getReader();
      let bytes = 0;
      let last = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > MAX_BYTES) throw failure('connector_runtime_archive_invalid');
          await file.writeFile(value);
          if (Date.now() - last > 250) {
            progress({ phase: 'downloading', ...(total > 0 ? { percent: Math.min(99, Math.floor(bytes / total * 100)) } : {}) });
            last = Date.now();
          }
        }
      } finally { await reader.cancel().catch(() => {}); await file.close(); }
      progress({ phase: 'verifying' });
      const [algorithm, expected] = asset.integrity.split('-');
      const hash = createHash(algorithm);
      for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
      if (hash.digest('base64') !== expected) throw failure('connector_runtime_integrity_failed');
      return;
    } catch (error) {
      if (signal.aborted) throw failure('connector_runtime_cancelled');
      // A checksum mismatch never silently falls back to another source.
      if ((error as { code?: string }).code === 'connector_runtime_integrity_failed') throw error;
      if (i === asset.urls.length - 1) throw failure('connector_runtime_download_failed');
    }
  }
}

/** Read only exact, normal-file members into bounded buffers. Never extract an archive to disk. */
async function members(file: string, format: 'tar' | 'zip', names: string[]): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  let invalid = false;
  if (format === 'zip') {
    const zip = new AdmZip(file);
    for (const name of names) {
      const entries = zip.getEntries().filter(e => e.entryName === name || e.entryName === `./${name}`);
      const e = entries[0];
      if (entries.length !== 1 || !e || e.isDirectory || e.header.size > MAX_BYTES || ((e.attr >>> 16) & 0xf000) === 0xa000) throw failure('connector_runtime_archive_invalid');
      const data = e.getData();
      if (data.length > MAX_BYTES) throw failure('connector_runtime_archive_invalid');
      found.set(name, data);
    }
  } else {
    await listTar({ file, strict: true, onReadEntry(entry) {
      const name = entry.path.replace(/^\.\//, '');
      if (!names.includes(name)) { entry.resume(); return; }
      if (found.has(name) || entry.type !== 'File' || entry.size > MAX_BYTES) { invalid = true; entry.resume(); return; }
      // Reserve the name before data arrives so duplicate entries cannot override it.
      found.set(name, Buffer.alloc(0));
      const chunks: Buffer[] = [];
      let bytes = 0;
      entry.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) invalid = true;
        else chunks.push(chunk);
      });
      entry.on('end', () => { if (!invalid) found.set(name, Buffer.concat(chunks)); });
    } });
  }
  if (invalid || names.some(name => !found.get(name)?.length)) throw failure('connector_runtime_archive_invalid');
  return found;
}

function notify(uid: string, id: string, progress: RuntimeProgress): void {
  const job = jobs.get(destination(uid, id));
  if (job) job.progress = progress;
  try {
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    ipc.broadcastToRenderer?.('connectors:runtime-progress', { user_id: uid, catalog_id: id, ...progress });
  } catch { /* Catalog also carries in-flight progress after a view reload. */ }
}

async function install(uid: string, id: string, signal: AbortSignal): Promise<{ ready: true }> {
  const dir = destination(uid, id);
  const asset = assetFor(id)!;
  if (managedConnectorBinary(uid, id)) return { ready: true };
  const parent = path.dirname(dir);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = await fs.promises.mkdtemp(path.join(parent, '.prepare-'));
  let backup: string | undefined;
  try {
    const archive = path.join(stage, 'download');
    await download(asset, archive, signal, value => notify(uid, id, value));
    signal.throwIfAborted();
    notify(uid, id, { phase: 'installing' });
    let source = archive;
    let format = asset.format;
    if (asset.nested) {
      const nested = await members(archive, format, [asset.nested]);
      source = path.join(stage, 'native-archive');
      await fs.promises.writeFile(source, nested.get(asset.nested)!);
      format = asset.nestedFormat!;
    }
    const files = await members(source, format, asset.files);
    const ready = path.join(stage, 'ready');
    await fs.promises.mkdir(ready, { mode: 0o700 });
    for (const [name, data] of files) await fs.promises.writeFile(path.join(ready, path.posix.basename(name)), data, { mode: name.endsWith(asset.binary) ? 0o700 : 0o600 });
    const binary = files.get(asset.files.find(name => name.endsWith(asset.binary))!)!;
    if (createHash('sha256').update(binary).digest('hex') !== asset.binarySha256) throw failure('connector_runtime_integrity_failed');
    signal.throwIfAborted();
    if (fs.existsSync(dir)) {
      backup = `${dir}.old-${randomUUID()}`;
      await fs.promises.rename(dir, backup);
    }
    try { await fs.promises.rename(ready, dir); }
    catch (err) { if (backup) await fs.promises.rename(backup, dir); throw err; }
    if (backup) await fs.promises.rm(backup, { recursive: true, force: true });
    if (!managedConnectorBinary(uid, id)) throw failure('connector_runtime_archive_invalid');
    return { ready: true };
  } catch (error) {
    const code = signal.aborted ? 'connector_runtime_cancelled' : ((error as { code?: string }).code || 'connector_runtime_install_failed');
    log.warn('runtime preparation failed', { connector_id: id, code });
    throw failure(code.startsWith('connector_runtime_') ? code : 'connector_runtime_install_failed');
  } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
}

/** Deduplicate double-clicks and multiple windows for the same user and pinned version. */
export function prepareConnectorRuntime(uid: string, id: string): Promise<{ ready: true }> {
  const key = destination(uid, id);
  const existing = jobs.get(key);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const promise = Promise.resolve().then(() => install(uid, id, controller.signal)).finally(() => {
    jobs.delete(key);
    try {
      const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
      ipc.broadcastToRenderer?.('connectors:changed', {});
    } catch { /* The initiating IPC response still refreshes the view. */ }
  });
  jobs.set(key, { controller, promise, progress: { phase: 'downloading' } });
  return promise;
}
export function cancelConnectorRuntime(uid: string, id: string): { cancelled: boolean } {
  const job = jobs.get(destination(uid, id));
  job?.controller.abort();
  return { cancelled: !!job };
}

/** Resolve the same managed binary and credential home for authorization, reconnect, and tools. */
export function scopeManagedCliTransport(uid: string, id: string, transport: Transport): Transport {
  if (!runtime(id)) return transport;
  const binary = managedConnectorBinary(uid, id);
  if (!binary) return transport; // Preserve explicitly configured / externally installed CLIs.
  if (transport.kind !== 'stdio') throw failure('connector_runtime_transport_invalid');
  const home = userConnectorCliStateDir(uid, id);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // `dws` stores its token key in the macOS login keychain through `security`. HOME is redirected
  // to the private state dir, where no default keychain exists, so after a *successful* web
  // authorization it failed with "store DEK in macOS Keychain: exit status 154". File-DEK storage
  // keeps the credential inside that same per-user state dir instead.
  const cliEnv: Record<string, string> = id === 'dingtalk' ? { DWS_DISABLE_KEYCHAIN: '1' } : {};
  return { ...transport, cwd: home, env: { ...transport.env, ...cliEnv,
    [runtime(id)!.env]: binary, HOME: home, USERPROFILE: home, COGSEED_CONNECTOR_AUTH_DIR: path.join(home, 'auth'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  } };
}
