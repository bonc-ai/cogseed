/**
 * Runtime availability gates for catalogued connectors.
 *
 * Two independent reasons a catalogued connector can be non-connectable on this machine:
 *
 *  1. Remote config hides or soft-disables Google connectors without shipping a new desktop
 *     build. The gate is enforced in three places: catalog IPC (what the user sees), OAuth start
 *     (no bypass by stale renderer state), and model-tool visibility (already-connected
 *     connectors must stop being usable when disabled remotely).
 *  2. A `local_cli` connector needs a locally installed CLI. The renderer must be able to say
 *     "not available on this machine" *before* the user clicks 连接, so this file probes for the
 *     executable rather than deferring the failure to spawn time.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getGoogleConnectorsConfig, type ConnectorSwitchState } from '../client_config';
import type { CatalogEntry } from './types';

export type ConnectorAvailability = 'enabled' | 'hidden' | 'visible_disabled';

type DisabledReason = 'unsupported' | 'cli_missing';

const GOOGLE_CONNECTOR_IDS = new Set([
  'google-workspace',
  'gmail',
  'gdrive',
  'gcal',
  'gdocs',
  'gsheets',
  'gtasks',
  'gsearch-console',
]);
const GMAIL_SCOPE_CONNECTOR_IDS = new Set(['google-workspace', 'gmail']);

// ── Local CLI availability ──────────────────────────────────────────────
//
// `bin/tencent-meeting-mcp-server.cjs::tmeetBin()` resolves a binary at spawn time and falls back
// to the bare name `tmeet`, i.e. it trusts PATH. That is the right call for a spawned child (a
// terminal run has a full PATH) but the wrong question for a catalog card: a Finder-launched
// packaged app inherits the minimal GUI PATH, so a bare-name fallback resolves to nothing and the
// user sees only ENOENT *after* clicking 连接. The catalog needs a stricter, earlier answer, so it
// asks its own question instead of reusing `tmeetBin()`.
//
// The absolute candidate list is duplicated from that adapter on purpose (main must not `require`
// an MCP adapter — that would pull the MCP SDK into the main process). The two lists are pinned
// equal by `test/main/features/connectors/tencent-cli-availability.test.ts`, which reads both
// files, so they cannot drift silently.

function _tmeetAbsoluteCandidates(): string[] {
  const home = os.homedir();
  return [
    // Homebrew: Apple Silicon then Intel.
    '/opt/homebrew/bin/tmeet',
    '/usr/local/bin/tmeet',
    // npm global prefixes that do not land on the GUI PATH.
    path.join(home, '.npm-global', 'bin', 'tmeet'),
    path.join(home, '.local', 'bin', 'tmeet'),
    path.join(home, 'Library', 'pnpm', 'tmeet'),
    '/usr/local/lib/node_modules/@tencentcloud/tmeet/tmeet',
  ];
}

function _tmeetPathNames(): string[] {
  return process.platform === 'win32' ? ['tmeet.cmd', 'tmeet.exe'] : ['tmeet'];
}

function _isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Does `name` resolve to an executable on `PATH`? A pure directory scan — no shell, no `which`,
 *  so it behaves identically under the minimal GUI PATH and inside tests. */
function _isOnPath(names: readonly string[]): boolean {
  const raw = process.env.PATH || '';
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      if (_isExecutableFile(path.join(dir, name))) return true;
    }
  }
  return false;
}

/** True when the Tencent Meeting CLI is installed in a place this app can actually execute.
 *  An explicit `COGSEED_TMEET_BIN` wins, and is validated rather than trusted: a user who points
 *  it at a path that does not exist should see "not available" with the configured path named,
 *  not a card that fails on click. */
function _probeTmeet(): boolean {
  const override = process.env.COGSEED_TMEET_BIN;
  if (override) {
    if (override.includes('/') || override.includes('\\')) return _isExecutableFile(override);
    return _isOnPath([override]);
  }
  for (const candidate of _tmeetAbsoluteCandidates()) {
    if (_isExecutableFile(candidate)) return true;
  }
  return _isOnPath(_tmeetPathNames());
}

/** Test seam: the probe touches the real filesystem and PATH, which differ between CI runners and
 *  developer machines, so tests must be able to pin the answer. Mirrors the adapter's
 *  `_setExecForTest` / `_resetBinForTest` convention. */
let _cliProbe: (() => boolean) | null = null;
export function _setLocalCliProbeForTest(probe: (() => boolean) | null): void {
  _cliProbe = probe;
}

/** Catalog ids backed by a locally installed CLI (`auth_mode: 'local_cli'`) and how to probe for
 *  that CLI. One entry today; the shape is per-id so a second CLI connector needs only a row. */
const LOCAL_CLI_PROBES: Record<string, () => boolean> = {
  'tencent-meeting': _probeTmeet,
};

function _stateToAvailability(state: ConnectorSwitchState): ConnectorAvailability {
  if (state === 'enabled') return 'enabled';
  if (state === 'visible_disabled') return 'visible_disabled';
  return 'hidden';
}

function _overallStateToAvailability(state: ConnectorSwitchState): ConnectorAvailability {
  return state === 'enabled' ? 'enabled' : 'hidden';
}

export function isGoogleConnectorId(id: string): boolean {
  return GOOGLE_CONNECTOR_IDS.has(id);
}

function _decisionForId(id: string): { availability: ConnectorAvailability; disabled_reason?: DisabledReason } {
  const cliProbe = LOCAL_CLI_PROBES[id];
  if (cliProbe) {
    const installed = (_cliProbe || cliProbe)();
    return installed
      ? { availability: 'enabled' }
      : { availability: 'visible_disabled', disabled_reason: 'cli_missing' };
  }
  if (!isGoogleConnectorId(id)) return { availability: 'enabled' };
  const cfg = getGoogleConnectorsConfig();
  const overall = _overallStateToAvailability(cfg.google);
  if (overall !== 'enabled') return { availability: overall };
  if (GMAIL_SCOPE_CONNECTOR_IDS.has(id)) {
    const state = _stateToAvailability(cfg.gmail);
    return state === 'visible_disabled'
      ? { availability: state, disabled_reason: 'unsupported' }
      : { availability: state };
  }
  return { availability: 'enabled' };
}

export function connectorAvailabilityForId(id: string): ConnectorAvailability {
  return _decisionForId(id).availability;
}

export function isConnectorRuntimeEnabled(id: string): boolean {
  return connectorAvailabilityForId(id) === 'enabled';
}

export function catalogWithAvailability(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const entry of entries) {
    const { availability, disabled_reason } = _decisionForId(entry.id);
    if (availability === 'hidden') continue;
    if (availability === 'visible_disabled') {
      out.push({
        ...entry,
        availability,
        disabled_reason: disabled_reason || 'unsupported',
      });
    } else {
      out.push(entry);
    }
  }
  return out;
}

export function assertConnectorRuntimeEnabled(id: string): void {
  if (isConnectorRuntimeEnabled(id)) return;
  const err = new Error('connector_unsupported') as Error & { code?: string };
  err.code = 'connector_unsupported';
  throw err;
}
