import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { c as createTar } from 'tar';
import AdmZip from 'adm-zip';

import { FILE_SYMLINKS_SUPPORTED } from '../../../helpers/fs-capabilities';

vi.mock('../../../../src/main/ipc', () => ({ broadcastToRenderer: vi.fn() }));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
let root: string;
let bytes: Buffer;
let spec: any;
let api: typeof import('../../../../src/main/features/connectors/cli-runtime');
const target = `${process.platform}-${process.arch}`;

async function boot(format: 'tar' | 'zip' = 'tar', nested = false) {
  const input = path.join(root, 'input');
  fs.mkdirSync(input, { recursive: true });
  fs.writeFileSync(path.join(input, 'vendor'), 'native executable fixture');
  fs.writeFileSync(path.join(input, 'LICENSE'), 'license fixture');
  const archive = path.join(root, format === 'tar' ? 'native.tgz' : 'native.zip');
  if (format === 'tar') await createTar({ cwd: input, file: archive, gzip: true }, ['vendor', 'LICENSE']);
  else { const zip = new AdmZip(); zip.addLocalFile(path.join(input, 'vendor')); zip.addLocalFile(path.join(input, 'LICENSE')); zip.writeZip(archive); }
  let final = archive;
  if (nested) {
    fs.copyFileSync(archive, path.join(input, 'nested.zip'));
    final = path.join(root, 'outer.tgz');
    await createTar({ cwd: input, file: final, gzip: true }, ['nested.zip']);
  }
  bytes = fs.readFileSync(final);
  spec = { version: '1.2.3', env: 'VENDOR_BIN', assets: { [target]: {
    urls: ['https://vendor.example/pinned'], integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    binarySha256: createHash('sha256').update('native executable fixture').digest('hex'),
    format: nested ? 'tar' : format, ...(nested ? { nested: 'nested.zip', nestedFormat: 'zip' } : {}), binary: 'vendor', files: ['vendor', 'LICENSE'],
  } } };
  vi.doMock('../../../../src/main/features/connectors/cli-runtime-manifest.json', () => ({ default: { feishu: spec, dingtalk: spec } }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } })));
  api = await import('../../../../src/main/features/connectors/cli-runtime');
}

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-runtime-test-'));
  vi.stubEnv('COGSEED_WORKSPACE_ROOT', root);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.doUnmock('../../../../src/main/features/connectors/cli-runtime-manifest.json'); fs.rmSync(root, { recursive: true, force: true }); });

describe('managed connector preparation', () => {
  it.each([['tar', false], ['zip', false], ['zip', true]] as const)('verifies and installs %s nested=%s without executing package scripts', async (format, nested) => {
    await boot(format, nested);
    expect(api.managedConnectorBinary('alice', 'feishu')).toBeNull();
    const first = api.prepareConnectorRuntime('alice', 'feishu');
    expect(api.prepareConnectorRuntime('alice', 'feishu')).toBe(first);
    await expect(first).resolves.toEqual({ ready: true });
    const binary = api.managedConnectorBinary('alice', 'feishu')!;
    expect(fs.readFileSync(binary, 'utf8')).toBe('native executable fixture');
    expect(fs.readFileSync(path.join(path.dirname(binary), 'LICENSE'), 'utf8')).toBe('license fixture');
    expect(api.managedConnectorBinary('bob', 'feishu')).toBeNull();
    await api.prepareConnectorRuntime('alice', 'feishu');
    expect(fetch).toHaveBeenCalledTimes(1);
    const transport = api.scopeManagedCliTransport('alice', 'feishu', { kind: 'stdio', command: 'node', args: [] });
    expect(transport.kind).toBe('stdio');
    if (transport.kind !== 'stdio') throw new Error('stdio required');
    expect(transport.env!.VENDOR_BIN).toBe(binary);
    expect(transport.env!.HOME).toContain(path.join('alice', 'local'));
    expect(transport.cwd).toBe(transport.env!.HOME);
    expect(transport.env!.COGSEED_CONNECTOR_AUTH_DIR).toBe(path.join(transport.cwd!, 'auth'));
  });

  it('keeps the DingTalk CLI credential out of the macOS keychain, which does not exist under the private HOME', async () => {
    await boot();
    await api.prepareConnectorRuntime('alice', 'dingtalk');
    await api.prepareConnectorRuntime('alice', 'feishu');
    const env = (id: string) => {
      const t = api.scopeManagedCliTransport('alice', id, { kind: 'stdio', command: 'node', args: [] });
      if (t.kind !== 'stdio') throw new Error('stdio required');
      return t.env!;
    };
    expect(env('dingtalk').DWS_DISABLE_KEYCHAIN).toBe('1');
    expect(env('feishu').DWS_DISABLE_KEYCHAIN).toBeUndefined();
  });

  it('rejects a corrupt download, never marks it ready, and permits retry', async () => {
    await boot();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('tampered'));
    await expect(api.prepareConnectorRuntime('alice', 'feishu')).rejects.toMatchObject({ code: 'connector_runtime_integrity_failed' });
    expect(api.managedConnectorBinary('alice', 'feishu')).toBeNull();
    await api.prepareConnectorRuntime('alice', 'feishu');
    const binary = api.managedConnectorBinary('alice', 'feishu')!;
    fs.writeFileSync(binary, 'corrupt installed executable');
    expect(api.managedConnectorBinary('alice', 'feishu')).toBeNull();
    await api.prepareConnectorRuntime('alice', 'feishu');
    expect(fs.readFileSync(api.managedConnectorBinary('alice', 'feishu')!, 'utf8')).toBe('native executable fixture');
  });

  it('falls back on network failure but never accepts mismatched bytes from a mirror', async () => {
    await boot();
    spec.assets[target].urls.push('https://registry.example/pinned');
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network unavailable'));
    await expect(api.prepareConnectorRuntime('alice', 'feishu')).resolves.toEqual({ ready: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('tampered mirror'));
    await expect(api.prepareConnectorRuntime('bob', 'feishu')).rejects.toMatchObject({ code: 'connector_runtime_integrity_failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // The fixture itself is a symlink member: without the link privilege there is
  // no archive to inspect, so the case is environment-skipped rather than failed.
  it.skipIf(!FILE_SYMLINKS_SUPPORTED)('does not follow symlink members even when the archive digest matches', async () => {
    await boot();
    const input = path.join(root, 'input');
    fs.unlinkSync(path.join(input, 'vendor'));
    fs.symlinkSync('../outside', path.join(input, 'vendor'));
    const file = path.join(root, 'evil.tgz');
    await createTar({ cwd: input, file, gzip: true }, ['vendor', 'LICENSE']);
    bytes = fs.readFileSync(file);
    spec.assets[target].integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    await expect(api.prepareConnectorRuntime('alice', 'feishu')).rejects.toMatchObject({ code: 'connector_runtime_archive_invalid' });
    expect(fs.existsSync(path.join(root, 'outside'))).toBe(false);
    expect(api.managedConnectorBinary('alice', 'feishu')).toBeNull();
  });

  it('cancels an in-flight download for only its owning user and can restart', async () => {
    await boot();
    let started!: () => void;
    const downloading = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(fetch).mockImplementationOnce(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      started();
    }));
    const first = api.prepareConnectorRuntime('alice', 'feishu');
    const failure = expect(first).rejects.toMatchObject({ code: 'connector_runtime_cancelled' });
    await downloading;
    expect(api.cancelConnectorRuntime('bob', 'feishu')).toEqual({ cancelled: false });
    expect(api.cancelConnectorRuntime('alice', 'feishu')).toEqual({ cancelled: true });
    await failure;
    expect(api.connectorRuntimeProgress('alice', 'feishu')).toBeUndefined();
    await expect(api.prepareConnectorRuntime('alice', 'feishu')).resolves.toEqual({ ready: true });
  });

  it('rejects unlisted providers and unsafe account segments before touching disk or network', async () => {
    await boot();
    expect(() => api.prepareConnectorRuntime('alice', '../feishu')).toThrow('connector_runtime_unsupported');
    expect(() => api.prepareConnectorRuntime('../bob', 'feishu')).toThrow('invalid_user_id');
    expect(() => api.prepareConnectorRuntime('', 'feishu')).toThrow('invalid_user_id');
    expect(fetch).not.toHaveBeenCalled();
  });
});
