/**
 * Read the ACTIVE configuration from local CLI config files.
 *
 * This module reads the CLI's OWN config files to determine which provider
 * the user is currently using, rather than reading all providers from CC Switch.
 *
 * Supported CLIs and their config locations:
 *   - Claude Code: ~/.claude/.credentials.json (OAuth) or ~/.claude/settings.json (API key)
 *   - Codex: ~/.codex/auth.json
 *   - OpenCode: ~/.local/share/opencode/auth.json
 *
 * Security: These config files contain sensitive credentials. Reading them
 * requires user authorization in the onboarding flow or settings.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as net from 'node:net';
import type { LocalCliType } from './registry.js';
import { createLogger } from '../../logger.js';

const log = createLogger('active-config');

export interface ActiveCliConfig {
  /** The CLI type this config belongs to */
  cli: LocalCliType;
  /** Base URL for the API (empty string means official endpoint) */
  baseUrl: string;
  /** API key or OAuth token */
  apiKey: string;
  /** Auth mode: 'oauth' (official account) or 'api' (raw key) */
  mode: 'oauth' | 'api';
  /** Config source file path (for logging/debugging) */
  sourcePath: string;
}

/**
 * Read Claude Code's active configuration.
 * Priority: API key (settings.json or env var) > OAuth (credentials.json or keychain)
 */
function readClaudeActiveConfig(home: string): ActiveCliConfig | null {
  // Try 1: API key from settings.json. 支持两种布局：
  //   - 顶层字段: settings.apiKey / settings.anthropicApiKey
  //   - env 注入: settings.env.ANTHROPIC_AUTH_TOKEN / settings.env.ANTHROPIC_API_KEY
  //     （Claude Code 常用 env 方式，例如指向 DeepSeek 等兼容网关）
  const settingsPath = path.join(home, '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const env = settings && typeof settings.env === 'object' ? settings.env : {};
    const apiKey = settings.apiKey
      || settings.anthropicApiKey
      || env.ANTHROPIC_AUTH_TOKEN
      || env.ANTHROPIC_API_KEY
      || '';
    if (apiKey) {
      const baseUrl = settings.baseUrl
        || settings.anthropicBaseUrl
        || env.ANTHROPIC_BASE_URL
        || env.ANTHROPIC_API_URL
        || '';
      return {
        cli: 'claude',
        baseUrl,
        apiKey: String(apiKey),
        mode: 'api',
        sourcePath: settingsPath,
      };
    }
  } catch {
    // settings.json doesn't exist or is malformed
  }

  // Try 2: OAuth from credentials.json (macOS钥匙串会同步到这里，或Linux/Windows直接存这)
  const credPath = path.join(home, '.claude', '.credentials.json');
  try {
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    // OAuth token structure varies; common fields: authToken, access_token, token
    const token = cred.authToken || cred.access_token || cred.token;
    if (token && typeof token === 'string') {
      return {
        cli: 'claude',
        baseUrl: '', // Official endpoint (OAuth doesn't use custom baseUrl)
        apiKey: token,
        mode: 'oauth',
        sourcePath: credPath,
      };
    }
  } catch {
    // credentials.json doesn't exist or is malformed
  }

  return null;
}

/**
 * Read Codex's active configuration from ~/.codex/auth.json.
 * Two supported shapes:
 *   - OAuth:  { "access_token": "...", "refresh_token": "...", ... }
 *   - API key stored under OPENAI_API_KEY (observed in the wild — Codex also
 *     writes `{ "OPENAI_API_KEY": "sk-..." }`; this is the actual key value,
 *     not an env-var reference).
 */
function readCodexActiveConfig(home: string): ActiveCliConfig | null {
  const authPath = path.join(home, '.codex', 'auth.json');
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));

    // Codex auth.json structure (OAuth):
    // { "access_token": "...", "refresh_token": "...", ... }
    const token = auth.access_token || auth.token;
    if (token && typeof token === 'string') {
      return {
        cli: 'codex',
        baseUrl: '', // Official OpenAI endpoint
        apiKey: token,
        mode: 'oauth',
        sourcePath: authPath,
      };
    }

    // API-key shape: { "OPENAI_API_KEY": "sk-..." }
    const apiKey = auth.OPENAI_API_KEY;
    if (apiKey && typeof apiKey === 'string') {
      return {
        cli: 'codex',
        baseUrl: '', // Official OpenAI endpoint
        apiKey,
        mode: 'api',
        sourcePath: authPath,
      };
    }
  } catch {
    // auth.json doesn't exist or is malformed
  }

  return null;
}

/**
 * Read OpenCode's active configuration from ~/.local/share/opencode/auth.json.
 * OpenCode stores multiple providers; we return the FIRST one found (or a heuristic).
 */
function readOpencodeActiveConfig(home: string): ActiveCliConfig | null {
  const authPath = path.join(home, '.local', 'share', 'opencode', 'auth.json');
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;

    // OpenCode auth.json structure:
    // { "<provider>": { "type": "api" | "oauth", "key": "...", "baseURL": "..." } }
    for (const [provider, entry] of Object.entries(auth)) {
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const key = typeof e.key === 'string' ? e.key : '';
        const baseURL = typeof e.baseURL === 'string' ? e.baseURL : '';
        const type = e.type === 'oauth' ? 'oauth' : 'api';

        if (key) {
          return {
            cli: 'opencode',
            baseUrl: baseURL,
            apiKey: key,
            mode: type,
            sourcePath: authPath,
          };
        }
      }
    }
  } catch {
    // auth.json doesn't exist or is malformed
  }

  return null;
}

/**
 * Read the active configuration for a given CLI type.
 * Returns null if:
 *   - The CLI is not installed
 *   - The CLI has no active configuration
 *   - The config file is unreadable
 *
 * Never throws. Logs warnings for unexpected errors.
 */
export function readActiveCliConfig(
  cli: LocalCliType,
  home = os.homedir(),
): ActiveCliConfig | null {
  try {
    switch (cli) {
      case 'claude':
        return readClaudeActiveConfig(home);
      case 'codex':
        return readCodexActiveConfig(home);
      case 'opencode':
        return readOpencodeActiveConfig(home);
      // hermes, workbuddy, openclaw: not yet supported for active config reading
      default:
        return null;
    }
  } catch (err) {
    log.warn('unexpected error reading active CLI config', {
      cli,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Read active configurations for all installed CLIs.
 * Returns only the CLIs that have an active configuration.
 */
export function readAllActiveCliConfigs(home = os.homedir()): ActiveCliConfig[] {
  const clis: LocalCliType[] = ['claude', 'codex', 'opencode'];
  const configs: ActiveCliConfig[] = [];

  for (const cli of clis) {
    const config = readActiveCliConfig(cli, home);
    if (config) configs.push(config);
  }

  return configs;
}

/**
 * Lightweight model-endpoint probe from a CLI's OWN config — used to surface
 * "this CLI routes through a local proxy (CC Switch etc.)" hints in onboarding.
 * The app itself never depends on the proxy; this is purely informational.
 * Returns null when no endpoint is readable.
 *
 * Also reports whether the CLI has a READABLE credential and what kind
 * (`configAvailable` / `authMode` from readActiveCliConfig) so the UI can
 * decide whether "连接并存储 API" is meaningful: an OAuth (account) login has
 * no API key to store — storing an OAuth token as an API key would be broken.
 */
export function readCliModelEndpoint(
  cli: LocalCliType,
  home = os.homedir(),
): { baseUrl: string; isLocalProxy: boolean; configAvailable: boolean; authMode: 'api' | 'oauth' | null } | null {
  let baseUrl = '';
  try {
    if (cli === 'codex') {
      // ~/.codex/config.toml: base_url lives inside [model_providers.*].
      // Restrict the scan to that section — [mcp_servers.*] etc. may carry
      // unrelated url-ish keys.
      const cfgPath = path.join(home, '.codex', 'config.toml');
      const toml = fs.readFileSync(cfgPath, 'utf8');
      const match = toml.match(/\[model_providers\.[^\]]+\][^\[]*base_url\s*=\s*"([^"]+)"/m);
      baseUrl = match ? match[1] : '';
    } else if (cli === 'claude') {
      const settingsPath = path.join(home, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const env = settings && typeof settings.env === 'object' ? settings.env : {};
      baseUrl = settings.baseUrl || settings.anthropicBaseUrl || env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_URL || '';
    } else if (cli === 'opencode') {
      const cfg = readOpencodeActiveConfig(home);
      baseUrl = cfg ? cfg.baseUrl : '';
    }
  } catch {
    baseUrl = '';
  }

  let configAvailable = false;
  let authMode: 'api' | 'oauth' | null = null;
  try {
    const cfg = readActiveCliConfig(cli, home);
    if (cfg) {
      configAvailable = true;
      authMode = cfg.mode === 'oauth' ? 'oauth' : 'api';
    }
  } catch {
    /* no readable credential */
  }

  if (!baseUrl && !configAvailable) return null;
  const isLocalProxy = /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|::1)/i.test(baseUrl);
  return { baseUrl, isLocalProxy, configAvailable, authMode };
}

/** Parse `http(s)://host:port/...` into { host, port } for TCP probing.
 *  Returns null for non-URL / non-http(s) values (treat as not probeable). */
function _parseHttpEndpoint(baseUrl: string): { host: string; port: number } | null {
  if (!baseUrl) return null;
  let u: URL;
  try { u = new URL(baseUrl); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host: u.hostname, port };
}

/** TCP-reachability probe for a CLI's configured model endpoint.
 *  Returns:
 *    - `true`  — TCP connect succeeded (a listener answered on host:port).
 *    - `false` — connect failed (ECONNREFUSED / timeout / DNS) → the endpoint
 *                (typically a local proxy like CC Switch) is NOT running.
 *    - `null`  — endpoint unreadable or not http(s) → unknown, don't judge.
 *  Short timeout so a dead listener surfaces fast without stalling fallback. */
export function probeModelEndpointReachable(
  cli: LocalCliType,
  home = os.homedir(),
  timeoutMs = 800,
): Promise<boolean | null> {
  const ep = readCliModelEndpoint(cli, home);
  if (!ep || !ep.baseUrl) return Promise.resolve(null);
  const parsed = _parseHttpEndpoint(ep.baseUrl);
  if (!parsed) return Promise.resolve(null);
  // Only probe local endpoints. A remote endpoint may be up but slow / rate
  // limited; we never want to label the user's CLI "unusable" off a remote
  // connect failure. Local proxies are the case that matters (CC Switch etc.)
  // and a refused local port is a definitive "not running".
  if (!/^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|::1)$/i.test(parsed.host)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect({ host: parsed.host, port: parsed.port });
  });
}

/** Same probe over all supported CLIs, keyed by cli type. */
export async function probeAllModelEndpointsReachable(
  clis: readonly LocalCliType[],
  home = os.homedir(),
): Promise<Record<string, boolean | null>> {
  const out: Record<string, boolean | null> = {};
  for (const cli of clis) {
    out[cli] = await probeModelEndpointReachable(cli, home);
  }
  return out;
}
