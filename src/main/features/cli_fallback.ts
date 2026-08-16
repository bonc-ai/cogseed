/**
 * Commander CLI-fallback preference.
 *
 * When NO API-key model is configured (no entry in the auth profiles, no
 * usable provider), the commander cannot answer by itself. The user's own
 * signed-in CLI agent (Claude Code / Codex / OpenCode / WorkBuddy, official
 * account) is the only local execution backend, so conversations are routed
 * to it. This module persists which CLI is the preferred fallback, and
 * whether the user has been told about the state.
 *
 * Storage: `<uid>/local/config/cli-fallback.json` — machine-local preference,
 * never synced.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userLocalConfigDir } from '../paths';

const FILE = 'cli-fallback.json';

interface CliFallbackPrefs {
  /** Preferred fallback CLI type: 'claude' | 'codex' | 'opencode' |
   *  'workbuddy' | ''. */
  cli: string;
  /** Set once the settings UI has explained the no-API fallback state. */
  noticeShown?: boolean;
}

/** CLI types the commander can fall back to (mirrors the onboarding
 *  connect list — a CLI connected there must be selectable here). */
const FALLBACK_CLI_TYPES = ['claude', 'codex', 'opencode', 'workbuddy'] as const;

function filePath(uid: string): string {
  return path.join(userLocalConfigDir(uid), FILE);
}

function read(uid: string): CliFallbackPrefs {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(uid), 'utf8')) as Partial<CliFallbackPrefs>;
    const cli = typeof raw.cli === 'string' ? raw.cli : '';
    return { cli: (FALLBACK_CLI_TYPES as readonly string[]).includes(cli) ? cli : '', noticeShown: !!raw.noticeShown };
  } catch {
    return { cli: '', noticeShown: false };
  }
}

function write(uid: string, prefs: CliFallbackPrefs): void {
  fs.mkdirSync(path.dirname(filePath(uid)), { recursive: true });
  fs.writeFileSync(filePath(uid), JSON.stringify(prefs, null, 2), 'utf8');
}

/** Preferred fallback CLI, or '' when unset. */
export function getCliFallback(uid: string): string {
  return read(uid).cli;
}

/** Set the preferred fallback CLI ('' clears it). Returns the saved value. */
export function setCliFallback(uid: string, cli: string): string {
  const next = (FALLBACK_CLI_TYPES as readonly string[]).includes(cli) ? cli : '';
  write(uid, { ...read(uid), cli: next });
  return next;
}

/** Whether the no-API fallback notice has been shown to the user. */
export function cliFallbackNoticeShown(uid: string): boolean {
  return read(uid).noticeShown;
}

/** Mark the no-API fallback notice as shown. */
export function markCliFallbackNoticeShown(uid: string): void {
  write(uid, { ...read(uid), noticeShown: true });
}
