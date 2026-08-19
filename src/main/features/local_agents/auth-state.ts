/**
 * Local CLI auth-state detection.
 *
 * Distinguishes "the user is signed in with an official account" from
 * "configured with a raw API key" so the team-connect page can show honest
 * state and the commander can fall back to a signed-in CLI as its execution
 * backend when no API-key model is configured.
 *
 * Detection is FILE-BASED and READ-ONLY — we never probe the CLI's own auth
 * endpoints, never read tokens into memory beyond a boolean existence check.
 *
 *   claude    → ~/.claude/.credentials.json (OAuth session file)
 *               OR ~/.claude/settings.json with an API key / env-injected
 *               key (raw-key config — counted as "configured", mode 'api')
 *   codex     → ~/.codex/auth.json            (OAuth session file)
 *   opencode  → ~/.local/share/opencode/auth.json ({ "<provider>": {type,key} })
 *   workbuddy → ~/.workbuddy/app/sessions.json (app-managed sign-in record)
 *
 * A file's presence means the user signed in through the official flow; an
 * `api`-typed opencode entry means a raw key was configured. Absence of the
 * file is "not signed in" — a CLI can still exist on disk without any
 * credential, and we must never pretend otherwise.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface CliAuthState {
  /** True when a credential file for this CLI exists on this machine. */
  loggedIn: boolean;
  /** 'oauth' (official account) | 'api' (raw key) | 'unknown' (file unreadable). */
  mode: 'oauth' | 'api' | 'unknown';
}

function claudeAuthFile(home: string): string {
  return path.join(home, '.claude', '.credentials.json');
}

function claudeSettingsFile(home: string): string {
  return path.join(home, '.claude', 'settings.json');
}

function codexAuthFile(home: string): string {
  return path.join(home, '.codex', 'auth.json');
}

function opencodeAuthFile(home: string): string {
  return path.join(home, '.local', 'share', 'opencode', 'auth.json');
}

function workbuddyAuthFile(home: string): string {
  return path.join(home, '.workbuddy', 'app', 'sessions.json');
}

/**
 * Claude Code can be configured two ways that both make it usable without
 * ever touching the OAuth flow: a top-level `apiKey`/`anthropicApiKey` in
 * settings.json, or env-injected keys (`env.ANTHROPIC_AUTH_TOKEN` /
 * `env.ANTHROPIC_API_KEY`) that the CLI reads at spawn time. Counting only
 * the OAuth credentials file made API-key users show up as "not signed in"
 * even though the CLI runs fine — treat either shape as `mode:'api'`.
 * Boolean existence check only; the key value is never read into memory.
 */
function claudeApiKeyConfigured(home: string): boolean {
  try {
    const settings = JSON.parse(fs.readFileSync(claudeSettingsFile(home), 'utf8')) as {
      apiKey?: unknown;
      anthropicApiKey?: unknown;
      env?: Record<string, unknown>;
    };
    if (typeof settings.apiKey === 'string' && settings.apiKey.length > 0) return true;
    if (typeof settings.anthropicApiKey === 'string' && settings.anthropicApiKey.length > 0) return true;
    const env = settings && typeof settings.env === 'object' ? settings.env : {};
    if (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && (env.ANTHROPIC_AUTH_TOKEN as string).length > 0) return true;
    if (typeof env.ANTHROPIC_API_KEY === 'string' && (env.ANTHROPIC_API_KEY as string).length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/** WorkBuddy manages sign-in inside the app; the CLI reuses it and reports
 *  `apiKeySource:"copilot.tencent.com"` at init. The only file-based,
 *  read-only signal we can honestly read is the app's own session record —
 *  presence of a `sessions` entry with a `userId` means the user is signed
 *  in. We never read tokens; a boolean existence + shape check only. */
function workbuddyLoggedIn(home: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(workbuddyAuthFile(home), 'utf8')) as {
      sessions?: Array<{ userId?: unknown }>;
    };
    return Array.isArray(raw.sessions)
      && raw.sessions.some(s => s && typeof s === 'object' && typeof s.userId === 'string' && s.userId.length > 0);
  } catch {
    return false;
  }
}

/** Read opencode auth.json and decide api vs oauth from the first entry. */
function opencodeAuthMode(home: string): 'oauth' | 'api' | 'unknown' {
  try {
    const auth = JSON.parse(fs.readFileSync(opencodeAuthFile(home), 'utf8')) as Record<string, unknown>;
    for (const entry of Object.values(auth)) {
      if (entry && typeof entry === 'object') {
        const type = (entry as Record<string, unknown>).type;
        if (type === 'api') return 'api';
        if (type === 'oauth') return 'oauth';
      }
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Detect the auth state for one CLI type. Never throws. */
export function detectCliAuth(type: string, home = os.homedir()): CliAuthState {
  switch (type) {
    case 'claude':
      if (fs.existsSync(claudeAuthFile(home))) return { loggedIn: true, mode: 'oauth' };
      if (claudeApiKeyConfigured(home)) return { loggedIn: true, mode: 'api' };
      return { loggedIn: false, mode: 'unknown' };
    case 'codex':
      return fs.existsSync(codexAuthFile(home))
        ? { loggedIn: true, mode: 'oauth' }
        : { loggedIn: false, mode: 'unknown' };
    case 'opencode':
      if (!fs.existsSync(opencodeAuthFile(home))) {
        return { loggedIn: false, mode: 'unknown' };
      }
      return { loggedIn: true, mode: opencodeAuthMode(home) };
    case 'workbuddy':
      // App-managed OAuth sign-in (Tencent account). No raw key on disk we
      // can read; treat a valid session record as an official sign-in.
      return workbuddyLoggedIn(home)
        ? { loggedIn: true, mode: 'oauth' }
        : { loggedIn: false, mode: 'unknown' };
    default:
      return { loggedIn: false, mode: 'unknown' };
  }
}
