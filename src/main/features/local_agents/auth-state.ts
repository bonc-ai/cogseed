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
 *   claude   → ~/.claude/.credentials.json   (OAuth session file)
 *   codex    → ~/.codex/auth.json            (OAuth session file)
 *   opencode → ~/.local/share/opencode/auth.json ({ "<provider>": {type,key} })
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

function codexAuthFile(home: string): string {
  return path.join(home, '.codex', 'auth.json');
}

function opencodeAuthFile(home: string): string {
  return path.join(home, '.local', 'share', 'opencode', 'auth.json');
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
      return fs.existsSync(claudeAuthFile(home))
        ? { loggedIn: true, mode: 'oauth' }
        : { loggedIn: false, mode: 'unknown' };
    case 'codex':
      return fs.existsSync(codexAuthFile(home))
        ? { loggedIn: true, mode: 'oauth' }
        : { loggedIn: false, mode: 'unknown' };
    case 'opencode':
      if (!fs.existsSync(opencodeAuthFile(home))) {
        return { loggedIn: false, mode: 'unknown' };
      }
      return { loggedIn: true, mode: opencodeAuthMode(home) };
    default:
      return { loggedIn: false, mode: 'unknown' };
  }
}
