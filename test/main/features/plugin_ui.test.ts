import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Plugin-provided UI contract tests: manifest `ui` resolution, served-path
// validation (traversal / extension / symlink guards), the bridge invoke
// surface (get-info masking), and the machine-private runtime config store.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

function pkgsDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'packages');
}

function pkgDir(name: string): string {
  return path.join(pkgsDir(), name);
}

function writeRegistry(entries: unknown[]): void {
  fs.mkdirSync(pkgsDir(), { recursive: true });
  fs.writeFileSync(path.join(pkgsDir(), '_registry.json'), JSON.stringify({ version: 1, packages: entries }));
}

function installPkg(name: string, opts: { manifest?: unknown; ui?: Record<string, string>; skills?: string[] } = {}): void {
  const dir = pkgDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = opts.manifest ?? {
    manifest_version: '1.0',
    name: { zh: '测试插件', en: 'Test Plugin' },
    version: '0.1.0',
    audience_roles: ['student'],
    license: { model: 'per-class-paid', unit: 'student-seat' },
    ui: { entry: 'ui/index.html', commands: ['health', 'list-challenges'] },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(opts.ui || {})) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  for (const skill of opts.skills || []) {
    fs.mkdirSync(path.join(dir, 'skills', skill), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
  }
  writeRegistry([{ name, kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: true }]);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-plugin-ui-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function loadPluginUi() {
  return import('../../../src/main/features/plugin_ui');
}

describe('plugin_ui › resolvePluginUiInfo', () => {
  it('returns null when the package has no ui entry or is not installed', async () => {
    const { resolvePluginUiInfo } = await loadPluginUi();
    installPkg('plain', { manifest: { version: '1.0' } });
    expect(resolvePluginUiInfo(TEST_UID, 'plain')).toBeNull();
    expect(resolvePluginUiInfo(TEST_UID, 'missing')).toBeNull();
    expect(resolvePluginUiInfo(TEST_UID, '../evil')).toBeNull();
  });

  it('reads the ui entry and whitelists commands', async () => {
    const { resolvePluginUiInfo } = await loadPluginUi();
    installPkg('withui');
    const info = resolvePluginUiInfo(TEST_UID, 'withui');
    expect(info).not.toBeNull();
    expect(info!.uiRoot).toBe('ui');
    expect(info!.entry).toBe('ui/index.html');
    expect(info!.commands).toEqual(['health', 'list-challenges']);
  });

  it('drops unsafe ui entries and unsafe command names', async () => {
    const { resolvePluginUiInfo } = await loadPluginUi();
    installPkg('badentry', {
      manifest: { ui: { entry: '../outside/index.html', commands: ['ok', 'bad cmd', '../../x'] } },
    });
    expect(resolvePluginUiInfo(TEST_UID, 'badentry')).toBeNull();
  });
});

describe('plugin_ui › resolvePluginUiFile', () => {
  it('serves files inside the ui root (package-relative paths) and rejects escapes', async () => {
    const { resolvePluginUiFile } = await loadPluginUi();
    installPkg('withui', { ui: { 'ui/index.html': '<html></html>', 'ui/app.js': 'var a=1;' } });
    const good = resolvePluginUiFile(TEST_UID, 'withui', 'ui/index.html');
    expect(good.ok).toBe(true);
    expect(good.mime).toBe('text/html; charset=utf-8');
    expect(resolvePluginUiFile(TEST_UID, 'withui', '../package.json').ok).toBe(false);
    expect(resolvePluginUiFile(TEST_UID, 'withui', 'ui/app.js').ok).toBe(true);
    // A package-relative path that resolves outside the ui root is rejected.
    expect(resolvePluginUiFile(TEST_UID, 'withui', 'package.json').ok).toBe(false);
    expect(resolvePluginUiFile(TEST_UID, 'withui', 'ui/x.exe').ok).toBe(false);
    expect(resolvePluginUiFile(TEST_UID, 'withui', 'ui/missing.html').ok).toBe(false);
    expect(resolvePluginUiFile(TEST_UID, 'withui', '__cogseed/plugin-bridge.js').ok).toBe(false);
  });

  it('rejects symlinks escaping the ui root', async () => {
    const { resolvePluginUiFile } = await loadPluginUi();
    installPkg('withui', { ui: { 'ui/index.html': '<html></html>' } });
    const outside = path.join(tmpDir, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(pkgDir('withui'), 'ui', 'leak.html'));
    expect(resolvePluginUiFile(TEST_UID, 'withui', 'ui/leak.html').ok).toBe(false);
  });
});

describe('plugin_ui › runtime config store', () => {
  it('round-trips config, rejects bad role, and masks the api key in get-info', async () => {
    const { savePluginRuntimeConfig, readPluginRuntimeConfig, pluginUiInfo } = await loadPluginUi();
    installPkg('withui');
    const bad = await savePluginRuntimeConfig(TEST_UID, 'withui', { role: 'admin', api_key: 'k1' });
    expect(bad.ok).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, agent_id: 'teacher-companion-S-100', role: 'teacher', person_id: 'S-100' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    try {
      const ok = await savePluginRuntimeConfig(TEST_UID, 'withui', {
        server_url: 'http://localhost:3000',
        api_key: 'secret-key',
        student_id: 'S-100',
        role: 'teacher',
      });
      expect(ok.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    const stored = readPluginRuntimeConfig(TEST_UID, 'withui');
    expect(stored.api_key).toBe('secret-key');
    expect(stored.role).toBe('teacher');

    const info = pluginUiInfo(TEST_UID, 'withui');
    expect(info.ok).toBe(true);
    expect(info.info!.config.configured).toBe(true);
    expect(info.info!.config.role).toBe('teacher');
    expect(JSON.stringify(info.info)).not.toContain('secret-key');
    expect(info.info!.ui!.commands).toEqual(['health', 'list-challenges']);
    expect(info.info!.skills).toEqual([]);
  });

  it('keeps the api key on save when the input omits it', async () => {
    const { savePluginRuntimeConfig, readPluginRuntimeConfig } = await loadPluginUi();
    installPkg('withui');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, agent_id: 'student-companion-S-1', role: 'student', person_id: 'S-1' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    try {
      await savePluginRuntimeConfig(TEST_UID, 'withui', { api_key: 'k1', student_id: 'S-1', role: 'student' });
    } finally {
      vi.unstubAllGlobals();
    }
    await savePluginRuntimeConfig(TEST_UID, 'withui', { student_id: 'S-2' });
    expect(readPluginRuntimeConfig(TEST_UID, 'withui').api_key).toBe('k1');
    expect(readPluginRuntimeConfig(TEST_UID, 'withui').student_id).toBe('S-2');
  });

  it('auto-resolves role + person id from the platform when omitted (zero-config)', async () => {
    const { savePluginRuntimeConfig, readPluginRuntimeConfig } = await loadPluginUi();
    installPkg('withui');
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain('/api/agent/whoami');
      return new Response(JSON.stringify({ ok: true, agent_id: 'student-companion-S-9', role: 'student', person_id: 'S-9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await savePluginRuntimeConfig(TEST_UID, 'withui', {
        server_url: 'http://localhost:3000',
        api_key: 'k2',
      });
      expect(res.ok).toBe(true);
      expect(res.identity).toEqual({ resolved: true, role: 'student', person_id: 'S-9' });
      const stored = readPluginRuntimeConfig(TEST_UID, 'withui');
      expect(stored.role).toBe('student');
      expect(stored.student_id).toBe('S-9');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects the save when identity resolution fails and no role/id was given', async () => {
    const { savePluginRuntimeConfig } = await loadPluginUi();
    installPkg('withui');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    try {
      const res = await savePluginRuntimeConfig(TEST_UID, 'withui', {
        server_url: 'http://localhost:3000',
        api_key: 'k3',
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('无法识别身份');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('re-resolves identity whenever a NEW key is provided (identity follows the key)', async () => {
    const { savePluginRuntimeConfig, readPluginRuntimeConfig } = await loadPluginUi();
    installPkg('withui');
    // 先存一套旧身份（teacher）。
    await savePluginRuntimeConfig(TEST_UID, 'withui', {
      server_url: 'http://localhost:3000',
      api_key: 'old-key',
      student_id: 'T-1',
      role: 'teacher',
    });
    // 换新 key：即使表单还带着旧角色/ID（预填），也必须按新 key 重新识别。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, agent_id: 'student-companion-S-7', role: 'student', person_id: 'S-7' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    try {
      const res = await savePluginRuntimeConfig(TEST_UID, 'withui', {
        server_url: 'http://localhost:3000',
        api_key: 'new-key',
        student_id: 'T-1',   // 表单预填的旧值，应被覆盖
        role: 'teacher',     // 同上
      });
      expect(res.ok).toBe(true);
      const stored = readPluginRuntimeConfig(TEST_UID, 'withui');
      expect(stored.api_key).toBe('new-key');
      expect(stored.role).toBe('student');
      expect(stored.student_id).toBe('S-7');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('packages › validatePackageInstallInput', () => {
  it('accepts existing local dirs and http(s) URLs, rejects flags and bad names', async () => {
    const { validatePackageInstallInput } = await import('../../../src/main/features/packages');
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-plugin-src-'));
    try {
      expect(validatePackageInstallInput({ source: localDir, name: 'my-pkg' }).ok).toBe(true);
      expect(validatePackageInstallInput({ source: 'https://github.com/a/b.git', name: 'my-pkg' }).ok).toBe(true);
      expect(validatePackageInstallInput({ source: '/no/such/dir', name: 'my-pkg' }).ok).toBe(false);
      expect(validatePackageInstallInput({ source: '--flag', name: 'my-pkg' }).ok).toBe(false);
      expect(validatePackageInstallInput({ source: 'file:///etc', name: 'my-pkg' }).ok).toBe(false);
      expect(validatePackageInstallInput({ source: localDir, name: '../evil' }).ok).toBe(false);
      expect(validatePackageInstallInput({ source: localDir, name: 'bad name' }).ok).toBe(false);
    } finally {
      fs.rmSync(localDir, { recursive: true, force: true });
    }
  });
});
