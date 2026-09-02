/**
 * Plugin-provided UI — the second half of the external-package story.
 *
 * An external package may ship a UI directory (declared in manifest.json as
 * `ui.entry`, e.g. "ui/index.html"). CogSeed serves it over the
 * `cogseed-plugin://<pkgName>/<relpath>` custom protocol (see
 * registerPluginProtocol in main/index.ts) inside a sandboxed iframe that
 * never sees `window.cogseed`. The page talks to its runtime through the
 * injected bridge (`window.cogseedPlugin`, served at the reserved virtual
 * path `__cogseed/plugin-bridge.js`), which posts
 * `{ __cogseedPlugin: true, type: 'invoke', id, method, params }` messages
 * to the host renderer. The renderer forwards them over the
 * `packages.ui.invoke` IPC and the result travels back the same chain.
 *
 * Backend surface (v1):
 *   - get-info    → package row + manifest summary + masked runtime config.
 *   - runtime     → run one of the plugin's own skill runtime commands
 *                   (manifest `ui.commands` allowlist) via bin/run-skill.cjs,
 *                   with the package's platform config injected from the
 *                   per-package secrets file (machine-private).
 *   - save-config → store the plugin's runtime credentials. The api_key is
 *                   never returned to the renderer afterwards; only a masked
 *                   `configured` flag is.
 *
 * Security invariants:
 *   - `ui.entry` and every served path resolves inside `<pkg>/<uiRoot>/`
 *     (symlink-resolved), regular files only, extension allowlist.
 *   - The bridge exposes no `window.cogseed`; only the allowlisted invoke
 *     methods exist, and every payload is validated field-by-field.
 *   - runtime commands are constrained to skills living inside the package's
 *     own skill_roots AND the manifest `ui.commands` allowlist. Credentials
 *     are injected from main only; the iframe/renderer never receives them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  userPackageDir,
  userPackageSecretsDir,
  PC_ROOT,
} from '../paths';
import { createLogger } from '../logger';
import {
  readPackagesRegistry,
  readPackageManifest,
  listPackageSkills,
  buildPackageCommandEnv,
  runPackageProcessForTest,
} from './packages';

const log = createLogger('plugin-ui');

// ── Bridge (served at the reserved virtual path, not from disk) ──────────

export const PLUGIN_BRIDGE_RELPATH = '__cogseed/plugin-bridge.js';

export const PLUGIN_BRIDGE_JS = `(function(){
  var pending = {};
  var seq = 0;
  function post(type, extra){
    try { parent.postMessage(Object.assign({ __cogseedPlugin: true, type: type }, extra || {}), '*'); }
    catch (e) {}
  }
  function invoke(method, params){
    return new Promise(function(resolve, reject){
      var id = 'p' + (++seq) + '-' + Date.now();
      pending[id] = { resolve: resolve, reject: reject };
      post('invoke', { id: id, method: String(method || ''), params: params });
      setTimeout(function(){
        if (!pending[id]) return;
        delete pending[id];
        reject(new Error('plugin invoke timeout: ' + method));
      }, 120000);
    });
  }
  function onMessage(ev){
    var data = ev && ev.data;
    if (!data || typeof data !== 'object' || data.__cogseedPlugin !== true) return;
    if (data.type === 'invoke-result' && data.id && pending[data.id]) {
      var p = pending[data.id];
      delete pending[data.id];
      if (data.ok) p.resolve(data.result);
      else p.reject(new Error(data.error || 'plugin invoke failed'));
    }
  }
  function resize(px){
    var n = Number(px);
    post('resize', { height: (isFinite(n) && n > 0) ? n : 0 });
  }
  function reportHeight(){
    try {
      var h = Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0
      );
      if (h > 0) resize(h);
    } catch (e) {}
  }
  try {
    window.addEventListener('message', onMessage);
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', reportHeight);
    else setTimeout(reportHeight, 0);
    window.addEventListener('load', reportHeight);
    if (typeof ResizeObserver !== 'undefined') {
      try { new ResizeObserver(reportHeight).observe(document.documentElement); } catch (e) {}
    } else {
      setInterval(reportHeight, 1000);
    }
  } catch (e) {}
  window.cogseedPlugin = {
    invoke: invoke,
    resize: resize,
    openExternal: function(url){ post('open-external', { url: String(url || '') }); }
  };
})();
`;

// ── UI serving resolution ────────────────────────────────────────────────

const PLUGIN_UI_EXTENSIONS = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.txt', '.md',
]);

const PLUGIN_UI_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function isSafePackageName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

/** A relpath with no traversal, absolute, drive, or backslash components. */
function isSafeUiRelPath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/')) return false;
  const segments = rel.split('/');
  return segments.every((s) => s && s !== '.' && s !== '..' && !s.includes('\\') && !s.includes('\0'));
}

export interface PluginUiManifestInfo {
  uiRoot: string;
  entry: string;
  commands: string[];
}

/**
 * Resolve a package's UI manifest (`ui` section). Returns null when the
 * package is not installed, disabled, or ships no UI entry. Package-name
 * matching is case-insensitive (URL hosts are lowercased by the parser;
 * registry names may contain uppercase letters).
 */
export function resolvePluginUiInfo(uid: string, name: string): PluginUiManifestInfo | null {
  if (!isSafePackageName(name)) return null;
  const reg = readPackagesRegistry(uid);
  const want = name.toLowerCase();
  const pkg = reg.packages.find((p) => p.name.toLowerCase() === want);
  if (!pkg || !pkg.enabled) return null;
  const manifest = readPackageManifest(uid, name);
  const ui = manifest?.ui;
  if (!ui || typeof ui.entry !== 'string' || !isSafeUiRelPath(ui.entry)) return null;
  const uiRoot = path.posix.dirname(ui.entry);
  const commands = Array.isArray(ui.commands)
    ? ui.commands.filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c))
    : [];
  return { uiRoot, entry: ui.entry, commands };
}

export interface PluginUiResolvedFile {
  ok: boolean;
  absPath?: string;
  mime?: string;
  code?: string;
  error?: string;
}

/** Resolve a requested relpath inside the package's UI root (symlink-safe).
 *  The URL path is relative to the PACKAGE root (the workbench iframe uses the
 *  full `ui.entry`, e.g. `cogseed-plugin://pkg/ui/index.html`), and page-relative
 *  asset URLs resolve against it; containment inside `uiRoot` is enforced after
 *  resolution, so `../` segments can never escape the UI subtree. */
export function resolvePluginUiFile(uid: string, name: string, relPath: string): PluginUiResolvedFile {
  const info = resolvePluginUiInfo(uid, name);
  if (!info) return { ok: false, code: 'no_ui', error: 'package has no enabled UI' };
  if (relPath === PLUGIN_BRIDGE_RELPATH) {
    return { ok: false, code: 'reserved', error: 'reserved virtual path must be served separately' };
  }
  if (!isSafeUiRelPath(relPath)) return { ok: false, code: 'bad_path', error: 'unsafe path' };

  // URL host is lowercased by the URL parser — resolve the registry's
  // canonical package name before touching the filesystem.
  const canonical = readPackagesRegistry(uid).packages.find(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  )?.name;
  if (!canonical) return { ok: false, code: 'no_ui', error: 'package not installed' };
  const pkgDir = userPackageDir(uid, canonical);
  const uiRootAbs = path.resolve(pkgDir, info.uiRoot);
  const candidate = path.resolve(pkgDir, relPath);
  if (candidate !== uiRootAbs && !candidate.startsWith(uiRootAbs + path.sep)) {
    return { ok: false, code: 'bad_path', error: 'path escapes UI root' };
  }
  const ext = path.extname(candidate).toLowerCase();
  if (!PLUGIN_UI_EXTENSIONS.has(ext)) {
    return { ok: false, code: 'bad_ext', error: `extension not allowed: ${ext || '(none)'}` };
  }
  let real: string;
  let st: fs.Stats;
  try {
    real = fs.realpathSync(candidate);
    st = fs.statSync(real);
  } catch {
    return { ok: false, code: 'not_found', error: 'file not found' };
  }
  if (!st.isFile()) return { ok: false, code: 'not_file', error: 'not a regular file' };
  // The realpath must still live inside the (symlink-resolved) UI root.
  const realRoot = (() => {
    try { return fs.realpathSync(uiRootAbs); } catch { return uiRootAbs; }
  })();
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    return { ok: false, code: 'bad_path', error: 'symlink escapes UI root' };
  }
  return { ok: true, absPath: real, mime: PLUGIN_UI_MIME[ext] || 'application/octet-stream' };
}

// ── Runtime config (machine-private, main-only) ──────────────────────────

export interface PluginRuntimeConfig {
  server_url?: string;
  api_key?: string;
  student_id?: string;
  role?: string;
  cohort?: string;
  course_id?: string;
}

const CONFIG_KEY_WHITELIST: Array<keyof PluginRuntimeConfig> = [
  'server_url', 'api_key', 'student_id', 'role', 'cohort', 'course_id',
];

function pluginSecretsFile(uid: string, name: string): string {
  return path.join(userPackageSecretsDir(uid), `${name}.json`);
}

/** Read a package's stored runtime config (empty when absent/corrupt). */
export function readPluginRuntimeConfig(uid: string, name: string): PluginRuntimeConfig {
  if (!isSafePackageName(name)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(pluginSecretsFile(uid, name), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const out: PluginRuntimeConfig = {};
    for (const key of CONFIG_KEY_WHITELIST) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export interface SaveConfigResult {
  ok: boolean;
  error?: string;
  identity?: { resolved: boolean; role?: string; person_id?: string; error?: string };
}

/** Validate a platform base URL for outbound calls with the api key:
 *  http(s) only, hostname required, no embedded credentials (userinfo), no
 *  fragments/query. Rejects URL shapes that could exfiltrate the key or
 *  smuggle credentials. */
function validatePlatformServerUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  let u: URL;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  if (u.search || u.hash) return null;
  return u.origin;
}

/** 凭 API Key 从平台反查身份（`GET /api/agent/whoami`，身份由平台按 key
 *  绑定，不可伪造）。返回 null 表示平台返回了无法识别的身份。 */
export async function resolveIdentityFromPlatform(
  serverUrl: string,
  apiKey: string,
): Promise<{ role: string; person_id: string } | null> {
  const base = validatePlatformServerUrl(serverUrl);
  if (!base) throw new Error('平台地址不合法（仅支持 http/https，且不含账号密码/查询参数）');
  const res = await fetch(`${base}/api/agent/whoami`, {
    method: 'GET',
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean; role?: unknown; person_id?: unknown;
  } | null;
  if (!data || data.ok !== true) return null;
  const role = typeof data.role === 'string' ? data.role : '';
  const personId = typeof data.person_id === 'string' ? data.person_id : '';
  if (role !== 'student' && role !== 'teacher') return null;
  if (!personId) return null;
  return { role, person_id: personId };
}

/** Store a package's runtime config. The api_key is write-only from the UI's
 *  perspective: never surfaced by get-info or any other read path. When the
 *  caller supplies an api_key but no role/student_id, identity is resolved
 *  from the platform (`whoami`) so the user only ever has to paste the key. */
export async function savePluginRuntimeConfig(
  uid: string,
  name: string,
  raw: unknown,
): Promise<SaveConfigResult> {
  if (!isSafePackageName(name)) return { ok: false, error: 'invalid package name' };
  const pkg = readPackagesRegistry(uid).packages.find((p) => p.name === name);
  if (!pkg) return { ok: false, error: 'package not installed' };
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid config' };
  const input = raw as Record<string, unknown>;

  // 一键粘贴支持两种自带地址的形式：
  //   1) v2 密钥前缀 `eduseed1.<base64url(平台地址)>.<随机>` —— 平台生成时写入
  //      自己服务器的地址（换服务器自动换），这里拆出地址；整串仍是 api_key
  //      （平台认证对整串做哈希）。
  //   2) JSON 接入信息 {"server":"…","api_key":"…"}（/companion 兼容形式）。
  if (typeof input.api_key === 'string') {
    const pasted = input.api_key.trim();
    if (pasted.startsWith('{')) {
      try {
        const blob = JSON.parse(pasted) as Record<string, unknown>;
        const blobKey = typeof blob.api_key === 'string' && blob.api_key.trim() ? blob.api_key.trim() : '';
        const blobServer = typeof blob.server === 'string' && blob.server.trim() ? blob.server.trim() : '';
        if (!blobKey || !blobServer) {
          return { ok: false, error: '接入信息格式不正确（需要 {"server":"…","api_key":"…"}）' };
        }
        input.api_key = blobKey;
        if (typeof input.server_url !== 'string' || !input.server_url.trim()) {
          input.server_url = blobServer;
        }
      } catch {
        return { ok: false, error: '接入信息格式不正确（需要合法 JSON）' };
      }
    } else if (pasted.startsWith('eduseed1.')) {
      const rest = pasted.slice('eduseed1.'.length);
      const dot = rest.indexOf('.');
      if (dot <= 0) {
        return { ok: false, error: '密钥格式不正确（eduseed1 前缀不完整）' };
      }
      try {
        const origin = Buffer.from(rest.slice(0, dot), 'base64url').toString('utf8');
        if (!validatePlatformServerUrl(origin)) {
          return { ok: false, error: '密钥内嵌的平台地址不合法' };
        }
        if (typeof input.server_url !== 'string' || !input.server_url.trim()) {
          input.server_url = origin;
        }
      } catch {
        return { ok: false, error: '密钥内嵌的平台地址无法解析' };
      }
    }
  }

  // Merge over the stored config so an omitted key (e.g. the write-only
  // api_key left blank in the form) keeps its existing value.
  const out: PluginRuntimeConfig = { ...readPluginRuntimeConfig(uid, name) };
  for (const key of CONFIG_KEY_WHITELIST) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return { ok: false, error: `config.${key} must be a string` };
    const trimmed = value.trim();
    // The api key is write-only from the UI: an empty value means "keep the
    // stored key", never "clear it" (the form cannot display the current one).
    if (key === 'api_key' && !trimmed) continue;
    if (trimmed) out[key] = trimmed.slice(0, 2048);
    else delete out[key];
  }
  const explicitRole = (out.role || '').toLowerCase();
  if (explicitRole && explicitRole !== 'student' && explicitRole !== 'teacher') {
    return { ok: false, error: 'role must be student or teacher' };
  }
  out.role = explicitRole || undefined;
  if (out.server_url && !validatePlatformServerUrl(out.server_url)) {
    return { ok: false, error: '平台地址不合法（仅支持 http/https，且不含账号密码/查询参数）' };
  }

  // 零配置识别：身份以 key 为准。凡是本次提交了新 key，一律按新 key 重新
  // 识别（覆盖表单预填/已存的旧身份——换 key 就必须换身份，防止学生 key
  // 配上教师 ID 之类的错位）；未提交新 key 但缺角色/ID 时也自动识别。
  const keyProvided = typeof input.api_key === 'string' && input.api_key.trim() !== '';
  if (out.api_key && (keyProvided || !out.role || !out.student_id)) {
    const serverUrl = out.server_url || 'http://localhost:3000';
    try {
      const identity = await resolveIdentityFromPlatform(serverUrl, out.api_key);
      if (!identity) {
        // 平台可达但拒绝/无法解析 → key 大概率无效，硬拒（不能拿旧身份配新 key）。
        return {
          ok: false,
          error: '无法识别身份：请检查 API Key 是否正确（建议使用平台最新生成的新版密钥）',
        };
      }
      out.role = identity.role;
      out.student_id = identity.person_id;
      // 换 key 后身份可能换人：清掉旧身份遗留的班级字段（班级由平台侧掌握）。
      if (keyProvided) delete out.cohort;
    } catch (err) {
      // 平台不可达（离线/维护）：仅当本次显式给了角色+ID 才允许落盘兜底，
      // 否则拒绝（缺身份的配置会导致运行时必填项缺失）。
      const explicitRole = typeof input.role === 'string' && input.role.trim() !== '';
      const explicitId = typeof input.student_id === 'string' && input.student_id.trim() !== '';
      if (!explicitRole || !explicitId) {
        log.warn('plugin identity resolve failed', {
          package_name: name,
          error: (err as Error).message,
        });
        return {
          ok: false,
          error: `无法连接平台识别身份（${(err as Error).message}）：请检查密钥对应的平台是否在线`,
        };
      }
      log.warn('plugin identity resolve failed — saving explicit fallback', {
        package_name: name,
        error: (err as Error).message,
      });
    }
  }

  try {
    const dir = userPackageSecretsDir(uid);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = pluginSecretsFile(uid, name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on win32 */ }
  } catch (err) {
    log.warn('plugin config save failed', { package_name: name, error: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
  log.info('plugin config saved', { package_name: name, keys: Object.keys(out).length });
  return { ok: true, identity: { resolved: true, role: out.role, person_id: out.student_id } };
}

// ── Invoke surface (bridge → IPC → here) ─────────────────────────────────

export interface PluginUiInfoResult {
  name: string;
  display_name?: string;
  kind: string;
  enabled: boolean;
  version?: string;
  latest_version?: string;
  min_version?: string;
  roles?: string[];
  license?: { model?: string; unit?: string };
  skill_count: number;
  skills: string[];
  ui?: { entry: string; commands: string[] };
  config: {
    configured: boolean;
    key_format?: 'v2' | 'legacy';
    server_url?: string;
    role?: string;
    student_id?: string;
    cohort?: string;
    course_id?: string;
  };
}

/** get-info: package facts + manifest summary + masked config status.
 *  附带平台版本公告的最新版本（凭已存 key 查询，5 分钟缓存；失败静默省略）。 */
const _versionAnnounceCache = new Map<string, { ts: number; latest?: string; min?: string }>();
const VERSION_ANNOUNCE_TTL_MS = 5 * 60 * 1000;

async function fetchVersionAnnouncement(serverUrl: string, apiKey: string): Promise<{ latest?: string; min?: string }> {
  const base = validatePlatformServerUrl(serverUrl);
  if (!base) return {};
  const cacheKey = `${base}`;
  const cached = _versionAnnounceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < VERSION_ANNOUNCE_TTL_MS) return cached;
  const out: { latest?: string; min?: string } = {};
  try {
    const res = await fetch(`${base}/api/plugin/version`, {
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        latest_version?: unknown; min_version?: unknown;
      } | null;
      const norm = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().replace(/^v/, '') : '');
      out.latest = norm(data?.latest_version) || undefined;
      out.min = norm(data?.min_version) || undefined;
      if (out.latest) _versionAnnounceCache.set(cacheKey, { ts: Date.now(), ...out });
    }
  } catch {
    /* 离线/平台不可达：静默省略版本信息，不打断界面 */
  }
  return out;
}

export async function pluginUiInfo(uid: string, name: string): Promise<{ ok: boolean; info?: PluginUiInfoResult; error?: string }> {
  if (!isSafePackageName(name)) return { ok: false, error: 'invalid package name' };
  const pkg = readPackagesRegistry(uid).packages.find((p) => p.name === name);
  if (!pkg) return { ok: false, error: 'package not installed' };
  const manifest = readPackageManifest(uid, name);
  const config = readPluginRuntimeConfig(uid, name);
  const uiInfo = resolvePluginUiInfo(uid, name);
  const announce = (config.api_key && config.server_url)
    ? await fetchVersionAnnouncement(config.server_url, config.api_key)
    : {};
  const info: PluginUiInfoResult = {
    name: pkg.name,
    ...(manifest?.name?.zh || manifest?.name?.en ? { display_name: manifest.name.zh || manifest.name.en } : {}),
    kind: pkg.kind,
    enabled: pkg.enabled !== false,
    ...(manifest?.version ? { version: manifest.version } : {}),
    ...(announce.latest ? { latest_version: announce.latest } : {}),
    ...(announce.min ? { min_version: announce.min } : {}),
    ...(manifest?.audience_roles?.length ? { roles: manifest.audience_roles } : {}),
    ...(manifest?.license ? { license: manifest.license } : {}),
    skill_count: listPackageSkills(uid, pkg).length,
    skills: listPackageSkills(uid, pkg),
    ...(uiInfo ? { ui: { entry: uiInfo.entry, commands: uiInfo.commands } } : {}),
    config: {
      configured: !!config.api_key,
      // v2 密钥自带平台地址 → 前端隐藏地址输入框；老格式 key 才显示。
      key_format: (config.api_key || '').startsWith('eduseed1.') ? 'v2' : 'legacy',
      ...(config.server_url ? { server_url: config.server_url } : {}),
      ...(config.role ? { role: config.role } : {}),
      ...(config.student_id ? { student_id: config.student_id } : {}),
      ...(config.cohort ? { cohort: config.cohort } : {}),
      ...(config.course_id ? { course_id: config.course_id } : {}),
    },
  };
  return { ok: true, info };
}

export interface PluginRuntimeInvoke {
  ok: boolean;
  stdout?: string;
  result?: unknown;
  error?: string;
}

function lastJsonLine(stdout: string): { parsed: unknown; raw: string } | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try { return { parsed: JSON.parse(line), raw: line }; } catch { /* keep scanning */ }
  }
  return null;
}

const RUNTIME_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const RUNTIME_COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Run one of the plugin's own runtime commands through bin/run-skill.cjs.
 * The command must be in the manifest `ui.commands` allowlist and the skill
 * must live inside the package's own skill_roots. Credentials come from the
 * per-package secrets file; they never enter the renderer.
 */
export async function invokePluginRuntime(
  uid: string,
  name: string,
  method: string,
  params: unknown,
): Promise<PluginRuntimeInvoke> {
  if (method !== 'runtime') {
    return { ok: false, error: `unsupported method: ${method}` };
  }
  if (!isSafePackageName(name)) return { ok: false, error: 'invalid package name' };
  const pkg = readPackagesRegistry(uid).packages.find((p) => p.name === name);
  if (!pkg || !pkg.enabled) return { ok: false, error: 'package not installed or disabled' };
  const uiInfo = resolvePluginUiInfo(uid, name);
  if (!uiInfo) return { ok: false, error: 'package UI not available' };
  if (!(params && typeof params === 'object')) return { ok: false, error: 'params required' };
  const input = params as Record<string, unknown>;
  const skill = typeof input.skill === 'string' ? input.skill : '';
  const command = typeof input.command === 'string' ? input.command : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skill)) return { ok: false, error: 'invalid skill' };
  if (!uiInfo.commands.includes(command)) return { ok: false, error: `command not allowed: ${command}` };
  const skills = listPackageSkills(uid, pkg);
  if (!skills.includes(skill)) return { ok: false, error: `skill not in package: ${skill}` };
  let argsJson = '';
  if (input.args !== undefined) {
    try { argsJson = JSON.stringify(input.args); } catch { return { ok: false, error: 'args must be JSON-serializable' }; }
    if (Buffer.byteLength(argsJson, 'utf8') > 512 * 1024) return { ok: false, error: 'args too large' };
  }

  const config = readPluginRuntimeConfig(uid, name);
  if (!config.api_key) return { ok: false, error: 'plugin not configured (missing api key)' };

  let pcDir = PC_ROOT;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { app } = require('electron') as typeof import('electron');
    if (app && app.isPackaged) pcDir = PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked');
  } catch { /* not in electron (tests) */ }
  const script = path.join(pcDir, 'bin', 'run-skill.cjs');
  if (!fs.existsSync(script)) return { ok: false, error: 'run-skill.cjs not found' };

  const env = buildPackageCommandEnv(uid, pcDir);
  // Platform credentials injected from main only (renderer/iframe never see
  // the key). Both EDUSEED_* and legacy NSEAP_* names are exported so either
  // generation of the plugin runtime reads them.
  const injected: Record<string, string> = {
    EDUSEED_SERVER_URL: config.server_url || 'http://localhost:3000',
    EDUSEED_API_KEY: config.api_key,
    NSEAP_SERVER_URL: config.server_url || 'http://localhost:3000',
    NSEAP_API_KEY: config.api_key,
  };
  if (config.student_id) {
    injected.EDUSEED_STUDENT_ID = config.student_id;
    injected.NSEAP_STUDENT_ID = config.student_id;
  }
  if (config.role) {
    injected.EDUSEED_ROLE = config.role;
    injected.NSEAP_ROLE = config.role;
  }
  if (config.cohort) injected.EDUSEED_COHORT = config.cohort;
  if (config.course_id) injected.EDUSEED_COURSE_ID = config.course_id;
  Object.assign(env, injected);

  const args = [script, skill, 'runtime', '--', command];
  if (argsJson) args.push(argsJson);

  const node = process.env.COGSEED_TEST_NODE || process.execPath;
  log.info('plugin runtime invoke', { package_name: name, skill, command });
  const result = await runPackageProcessForTest(node, args, {
    env,
    timeoutMs: RUNTIME_COMMAND_TIMEOUT_MS,
    maxOutputBytes: RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  });
  if (result.error) return { ok: false, stdout: result.stdout, error: result.error };
  if (result.code === 0) {
    const parsed = lastJsonLine(result.stdout);
    return { ok: true, stdout: result.stdout, result: parsed ? parsed.parsed : null };
  }
  const parsedErr = lastJsonLine(result.stderr || result.stdout);
  const error = parsedErr && typeof parsedErr.parsed === 'object'
    ? String((parsedErr.parsed as Record<string, unknown>).error || parsedErr.raw)
    : (result.stderr.trim() || `run-skill exited ${result.code}`);
  return { ok: false, stdout: result.stdout, error: error.slice(0, 4096) };
}

/**
 * Dispatch a bridge invoke call. v1 methods: get-info / runtime / save-config.
 * save-config is routed through the renderer's native config form, but the
 * bridge may also write config when the plugin UI hosts its own onboarding.
 */
export async function dispatchPluginUiInvoke(
  uid: string,
  name: string,
  method: string,
  params: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  switch (method) {
    case 'get-info': {
      const info = await pluginUiInfo(uid, name);
      return info.ok ? { ok: true, result: info.info } : info;
    }
    case 'runtime':
      return invokePluginRuntime(uid, name, method, params);
    case 'save-config': {
      const saved = await savePluginRuntimeConfig(uid, name, params);
      return saved.ok ? { ok: true, result: { saved: true, identity: saved.identity } } : saved;
    }
    default:
      return { ok: false, error: `unsupported method: ${method}` };
  }
}
