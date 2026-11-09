/**
 * Narrow Hub-governance refresh immediately before starting new work.
 *
 * The ordinary marketplace reconciler stays a six-hour all-installs job. This
 * seam checks only the exact installed Agent/Skill about to run and briefly
 * coalesces repeats. Network failure preserves the last local observation:
 * offline is never treated as an implicit disable or recovery.
 */
import * as path from 'node:path';

import { hubContentStatus, isHubContentDisabled } from '../../../shared/hub-content-status';
import { createLogger } from '../../logger';
import { userMarketplaceAgentDir } from '../../paths';
import { readJson, writeJson } from '../../storage';
import { currentAppVersion, postJson } from '../marketplace';
import { addAgentInstall, readInstalls } from '../marketplace_installs';
import { withMarketplaceInstallLock } from '../marketplace_locks';
import { observeHubSkillStatus } from './content-status';

const log = createLogger('marketplace/content-status-refresh');
const DEFAULT_MAX_AGE_MS = 15_000;
const STATUS_LOOKUP_TIMEOUT_MS = 4_000;

export type MarketplaceContentKind = 'agent' | 'skill';

export interface ContentStatusRefreshResult {
  checked: boolean;
  installed: boolean;
  status: string;
  disabled: boolean;
}

interface RefreshCacheEntry {
  checkedAt: number;
  result: ContentStatusRefreshResult;
}

const _recent = new Map<string, RefreshCacheEntry>();
const _inFlight = new Map<string, Promise<ContentStatusRefreshResult>>();

function _key(userId: string, kind: MarketplaceContentKind, contentId: string): string {
  return `${userId}:${kind}:${contentId}`;
}

function _localResult(installed: boolean, status: string, checked = false): ContentStatusRefreshResult {
  return { checked, installed, status, disabled: isHubContentDisabled({ status }) };
}

async function _installedRow(userId: string, kind: MarketplaceContentKind, contentId: string) {
  const manifest = await readInstalls(userId);
  return (kind === 'agent' ? manifest.agents : manifest.skills).find((row) => row.id === contentId) || null;
}

function _catalogIdentity(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const row = raw as { id?: unknown; content_id?: unknown };
  return typeof row.content_id === 'string' && row.content_id
    ? row.content_id
    : (typeof row.id === 'string' ? row.id : '');
}

async function _persistAgentStatus(userId: string, contentId: string, status: string): Promise<void> {
  const installed = (await readInstalls(userId)).agents.find((row) => row.id === contentId);
  if (!installed || hubContentStatus(installed) === status) return;
  await addAgentInstall(userId, { ...installed, status });
  await withMarketplaceInstallLock(userId, 'agent', contentId, async () => {
    const marker = path.join(userMarketplaceAgentDir(userId, contentId), '_install.json');
    const meta = await readJson<Record<string, unknown>>(marker);
    if (meta && typeof meta.version === 'string' && hubContentStatus(meta) !== status) {
      await writeJson(marker, { ...meta, status });
    }
  });
}

async function _refreshOnce(
  userId: string,
  kind: MarketplaceContentKind,
  contentId: string,
): Promise<ContentStatusRefreshResult> {
  const installed = await _installedRow(userId, kind, contentId);
  if (!installed) return _localResult(false, '');
  const localStatus = hubContentStatus(installed);
  try {
    const endpoint = kind === 'agent' ? 'agents' : 'skills';
    const response = await postJson<{ list?: unknown[] }>(
      `/marketplace/${endpoint}/list`,
      { app_version: currentAppVersion(), page: 1, size: 100, ids: [contentId] },
      { timeoutMs: STATUS_LOOKUP_TIMEOUT_MS, retries: 0 },
    );
    const row = (Array.isArray(response.list) ? response.list : [])
      .find((candidate) => _catalogIdentity(candidate) === contentId);
    const status = hubContentStatus((row && typeof row === 'object' ? row : {}) as { status?: unknown; state?: unknown });
    if (!status) return _localResult(true, localStatus, true);
    if (kind === 'agent') await _persistAgentStatus(userId, contentId, status);
    else await observeHubSkillStatus(userId, contentId, { status });
    return _localResult(true, status, true);
  } catch (error) {
    log.warn('narrow Hub status refresh failed; preserving local observation', {
      kind,
      content_id: contentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return _localResult(true, localStatus);
  }
}

export async function refreshMarketplaceContentStatus(
  userId: string,
  kind: MarketplaceContentKind,
  contentId: string,
  opts: { force?: boolean; maxAgeMs?: number } = {},
): Promise<ContentStatusRefreshResult> {
  if (!userId || !contentId) return _localResult(false, '');
  const key = _key(userId, kind, contentId);
  const maxAgeMs = Number.isFinite(opts.maxAgeMs)
    ? Math.max(0, Number(opts.maxAgeMs))
    : DEFAULT_MAX_AGE_MS;
  const cached = _recent.get(key);
  if (!opts.force && cached && Date.now() - cached.checkedAt < maxAgeMs) return cached.result;
  const pending = _inFlight.get(key);
  if (pending) return pending;
  const run = _refreshOnce(userId, kind, contentId).then((result) => {
    _recent.set(key, { checkedAt: Date.now(), result });
    return result;
  }).finally(() => {
    if (_inFlight.get(key) === run) _inFlight.delete(key);
  });
  _inFlight.set(key, run);
  return run;
}

export function _resetContentStatusRefreshCacheForTests(): void {
  _recent.clear();
  _inFlight.clear();
}
