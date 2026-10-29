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
import { tencentMeetingBinaryPath } from '../../paths';

import { getGoogleConnectorsConfig, type ConnectorSwitchState } from '../client_config';
import type { CatalogEntry } from './types';
import { managedConnectorBinary, canPrepareConnectorRuntime, connectorRuntimeProgress } from './cli-runtime';

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
// Four connectors are backed by a locally installed vendor CLI (`auth_mode: 'local_cli'`):
// Tencent Meeting (`tmeet`), Feishu (`lark-cli`), DingTalk (`dws`) and WeCom (`wecom-cli`).
//
// Each adapter resolves its binary at spawn time, falling back to the bare name, i.e. it trusts
// PATH. That is the right call for a spawned child (a terminal run has a full PATH) but the wrong
// question for a catalog card: a Finder-launched packaged app inherits the minimal GUI PATH, so a
// bare-name fallback resolves to nothing and the user sees only ENOENT *after* clicking 连接. The
// catalog needs a stricter, earlier answer, so it probes the filesystem itself.
//
// The absolute candidate list is duplicated from `bin/cli-bridge-mcp-server.cjs` on purpose (main
// must not `require` an MCP adapter — that would pull the MCP SDK into the main process). The two
// copies are pinned equal by `test/main/features/connectors/lark-local-cli-connector.test.ts`,
// which reads both files, so they cannot drift silently.

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

function _isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Shared probe shape for every `local_cli` connector.
 *
 *  An explicit override wins and is validated rather than trusted: a user who points it at a path
 *  that does not exist should see "not available" with the configured path named, not a card that
 *  fails on click. Then the absolute candidates a GUI-launched app cannot see on PATH, then PATH
 *  itself. */
function _probeCli(overrideVar: string, absoluteCandidates: string[], pathNames: string[]): boolean {
  const override = process.env[overrideVar];
  if (override) {
    if (override.includes('/') || override.includes('\\')) return _isExecutableFile(override);
    return _isOnPath([override]);
  }
  for (const candidate of absoluteCandidates) {
    if (_isExecutableFile(candidate)) return true;
  }
  return _isOnPath(pathNames);
}

/** Windows resolves `foo` to `foo.cmd`/`foo.exe`; a bare name would miss both. */
function _cliPathNames(binName: string): string[] {
  return process.platform === 'win32' ? [`${binName}.cmd`, `${binName}.exe`] : [binName];
}

/** nvm keeps every Node version's bin dir under `~/.nvm/versions/node/<version>/bin`, which no
 *  static list can spell — and an nvm-installed CLI is exactly what the GUI PATH misses. */
function _nvmBinCandidates(binName: string): string[] {
  const out: string[] = [];
  try {
    const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
    for (const version of fs.readdirSync(root)) out.push(path.join(root, version, 'bin', binName));
  } catch { /* nvm not installed — the other candidates still apply */ }
  return out;
}

/** Every `local_cli` connector resolves through this one list, keyed by binary name.
 *  `bin/cli-bridge-mcp-server.cjs` builds the same list for spawn time; a test pins the two copies
 *  equal. One function rather than one per CLI, so adding a fourth CLI cannot introduce a fifth
 *  slightly-different path list. */
function _cliAbsoluteCandidates(binName: string): string[] {
  const home = os.homedir();
  const names = _cliPathNames(binName);
  const dirs = [
    // Homebrew: Apple Silicon then Intel.
    '/opt/homebrew/bin',
    '/usr/local/bin',
    // npm global prefixes that do not land on the GUI PATH.
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'Library', 'pnpm'),
  ];
  const out: string[] = [];
  for (const dir of dirs) for (const name of names) out.push(path.join(dir, name));
  if (process.platform !== 'win32') for (const name of names) out.push(..._nvmBinCandidates(name));
  return out;
}

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
  return _cliPathNames('tmeet');
}

function _probeDws(): boolean {
  return _probeCli('COGSEED_DWS_BIN', _cliAbsoluteCandidates('dws'), _cliPathNames('dws'));
}

function _probeWecomCli(): boolean {
  return _probeCli('COGSEED_WECOM_CLI_BIN', _cliAbsoluteCandidates('wecom-cli'), _cliPathNames('wecom-cli'));
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
  const bundled = tencentMeetingBinaryPath();
  if (bundled && _isExecutableFile(bundled)) return true;
  if (process.platform === 'win32' && process.env.APPDATA && _isExecutableFile(path.join(process.env.APPDATA, 'npm', 'tmeet.cmd'))) return true;
  for (const candidate of _tmeetAbsoluteCandidates()) {
    if (_isExecutableFile(candidate)) return true;
  }
  return _isOnPath(_tmeetPathNames());
}

function _probeLarkCli(): boolean {
  return _probeCli('COGSEED_LARK_CLI_BIN', _cliAbsoluteCandidates('lark-cli'), _cliPathNames('lark-cli'));
}

/** Test seam: the probe touches the real filesystem and PATH, which differ between CI runners and
 *  developer machines, so tests must be able to pin the answer. Mirrors the adapter's
 *  `_setExecForTest` / `_resetBinForTest` convention. */
let _cliProbe: (() => boolean) | null = null;
export function _setLocalCliProbeForTest(probe: (() => boolean) | null): void {
  _cliProbe = probe;
}

/** Catalog ids backed by a locally installed CLI (`auth_mode: 'local_cli'`) and how to probe for
 *  that CLI. Per-id so a new CLI connector needs only a row. */
const LOCAL_CLI_PROBES: Record<string, () => boolean> = {
  'tencent-meeting': _probeTmeet,
  'feishu': _probeLarkCli,
  'dingtalk': _probeDws,
  'wecom': _probeWecomCli,
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

function _decisionForId(uid: string, id: string): { availability: ConnectorAvailability; disabled_reason?: DisabledReason } {
  const cliProbe = LOCAL_CLI_PROBES[id];
  if (cliProbe) {
    const installed = _cliProbe ? _cliProbe() : (!!managedConnectorBinary(uid, id) || cliProbe());
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

export function connectorAvailabilityForId(uid: string, id: string): ConnectorAvailability {
  return _decisionForId(uid, id).availability;
}

export function isConnectorRuntimeEnabled(uid: string, id: string): boolean {
  return connectorAvailabilityForId(uid, id) === 'enabled';
}

export function catalogWithAvailability(uid: string, entries: readonly CatalogEntry[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const entry of entries) {
    const { availability, disabled_reason } = _decisionForId(uid, entry.id);
    if (availability === 'hidden') continue;
    if (availability === 'visible_disabled') {
      out.push({
        ...entry,
        availability,
        ...(disabled_reason === 'cli_missing' && canPrepareConnectorRuntime(entry.id) ? { runtime_installable: true, runtime_progress: connectorRuntimeProgress(uid, entry.id) } : {}),
        disabled_reason: disabled_reason || 'unsupported',
      });
    } else {
      out.push(entry);
    }
  }
  return out;
}

export function assertConnectorRuntimeEnabled(uid: string, id: string): void {
  if (isConnectorRuntimeEnabled(uid, id)) return;
  const err = new Error('connector_unsupported') as Error & { code?: string };
  err.code = 'connector_unsupported';
  throw err;
}
