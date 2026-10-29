/**
 * Marketplace — browse + install official agents / skills from the CogSeed Server.
 *
 * Three-layer storage model:
 *
 *   1. **Server** owns the catalog (marketplace_agents / marketplace_skills tables) and the
 *      blob URLs (agent.json on COS, skill bundle .zip on COS).
 *   2. **Cloud-synced install manifest** (`<uid>/cloud/marketplace/installs.json`) — the only
 *      multi-device state. Records what the user has installed: id / version / freshness
 *      timestamp / COS URL / installed_at. See `marketplace_installs.ts`.
 *   3. **Per-machine install target** (`<uid>/local/marketplace/{agents,skills}/<id>/`) — the
 *      actual content. Reconciled from (2) on startup by `marketplace_reconcile.ts`: any entry
 *      in the manifest without local content gets fetched in parallel. Listed alongside
 *      `cloud/{agents,skills}/` by `features/{agents,skills}.ts::list*` under the "Platform" group.
 *
 * Detail-page cache (`<uid>/local/cache/marketplace/{agents,skills}/<id>/`) is independent —
 * it's a working copy for the detail viewer, populated whenever the user views an item, and
 * subject to LRU sweep. Install copies cache→install-target to materialize.
 *
 * Install flow: cache-first. `installMarketplaceAgent/Skill` ensures cache hot via the same
 * fetch+cache path the detail page uses, copies cache → `<uid>/local/marketplace/<kind>/<id>/`,
 * then records the entry in the cloud manifest.
 *
 * **Skill bundle = real zip.** Earlier revisions used a JSON envelope `{files:[...]}` (no zip
 * dep needed); switched to adm-zip to avoid base64 expansion on binary files + get deflate
 * compression on text. PC/CLAUDE.md §1 allow-list updated accordingly.
 *
 * **Agent install resolves skill_list dependencies before writing the agent body.** `skill_list`
 * is the runtime allowlist and may contain skills shipped by `agent_skills_bundle_url` as well as
 * standalone marketplace skills. The installer inspects the private bundle first, then installs
 * every missing standalone sid in parallel BEFORE writing the agent's own files / manifest entry.
 * If ANY dependency install throws, the whole agent install fails; the agent never gets recorded.
 * **Why:** prevents "agent installed but its skills are missing" inconsistency that would survive
 * across devices via the cloud manifest. Previously-installed skills from a partial retry are
 * no-ops (`_skillAlreadyOnDisk` check), so retry-on-failure is cheap. The user just re-clicks
 * Install.
 *
 * Upload + delete (publishing custom items to the Server) are dev-only and live in
 * `marketplace_dev.ts` — excluded from packaged builds via `package.json::build.files`.
 */

import AdmZip from 'adm-zip';
import { app } from 'electron';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { t } from '../i18n';
import { sha256OfFile } from '../util/sha256';
import { marketplaceContentTreeHash } from '../util/marketplace-tree-hash';
import { restoreAgentReceipts, snapshotAgentReceipts, writeInstallReceipt } from './skill_trust';
import { topViolationOf } from './skill_reverify';
import {
  scanSkillDir, scanVerdictBlocksInstall, scanVerdictAllowsOverride,
  resolveInstallDecision, type SentryScanResult, type SkillSource,
} from './security/sentry-adapter';

/**
 * One-line, machine-readable reason for a security block.
 *
 * Reports attack-surface counts and rule ids only — never the matched source
 * text. The spec requires a high-risk message to state the risk type and impact
 * "without exposing the sensitive original text", since that text may itself be
 * a leaked credential.
 */
function _securityBlockReason(scan: SentryScanResult): string {
  if (scan.localRedLines?.length) return `red lines: ${scan.localRedLines.join(', ')}`;
  if (scan.hardBlocked) return 'hard-block red line (suspected data exfiltration)';
  const parts: string[] = [];
  // Absent when nothing was measured (`unknown` / `scanner_absent`), so this is
  // guarded rather than zero-filled upstream: a zeroed surface would read as
  // "scanned, nothing found" and explain a rejection with counts of zero.
  const s = scan.attackSurface;
  if (s && s.egressPoints > 0) parts.push(`${s.egressPoints} network egress point(s)`);
  if (s && s.dynamicExecPoints > 0) parts.push(`${s.dynamicExecPoints} dynamic execution point(s)`);
  if (s && s.persistencePoints > 0) parts.push(`${s.persistencePoints} persistence point(s)`);
  if (parts.length) return parts.join('; ');
  return scan.riskClassification || scan.recommendation || 'security scan rejected';
}

/**
 * Build the error thrown when the deep scan rejects an install.
 *
 * Carries the structured verdict on the error so the IPC layer and renderer can
 * render the spec's risk card (§5.2) instead of only a message string. Mirrors
 * `_qualityInstallError`'s shape so both gates surface the same way.
 */
function _securityInstallError(
  skillId: string, name: string, scan: SentryScanResult, kindLabel: 'skill' | 'agent' = 'skill',
): Error {
  const unavailable = scan.outcome === 'unknown';
  const e = new Error(unavailable
    ? `Security check unavailable for ${kindLabel} ${name || skillId} (${scan.unavailableReason || 'unknown'})`
    : `Security scan rejected ${kindLabel} ${name || skillId} (${_securityBlockReason(scan)})`);
  (e as { securityBlocked?: boolean }).securityBlocked = !unavailable;
  (e as { securityUnavailable?: boolean }).securityUnavailable = unavailable;
  (e as { securitySkillId?: string }).securitySkillId = skillId;
  (e as { securityScan?: SentryScanResult }).securityScan = scan;
  // Whether the renderer may offer "install anyway". Computed here, next to the
  // verdict, rather than re-derived in the UI: a second copy of the
  // non-overridable rule set is how an exfiltration finding eventually becomes
  // waivable in one place and not the other.
  (e as { securityOverridable?: boolean }).securityOverridable =
    scanVerdictAllowsOverride(scan);
  // Rule ids drive the plain-language explanation, so the dialog can say what was
  // found instead of only that something was.
  (e as { securityRuleIds?: string[] }).securityRuleIds = [...(scan.localRedLines || [])];
  return e;
}
import { logPathRef } from '../util/log-redact';
import { fetchWithRetry } from '../util/retry';
import {
  minAppVersionFrom,
  normalizeMinAppVersion,
  satisfiesMinAppVersion,
  type MinAppVersionSource,
} from '../util/app-version-compat';

import {
  userSkillsDir,
  userMarketplaceAgentDir, userMarketplaceAgentSkillsDir, userMarketplaceSkillDir,
  userMarketplaceAgentsDir, userMarketplaceSkillsDir,
  marketplaceCacheAgentDir, marketplaceCacheSkillDir, marketplaceCacheSkillsDir,
  userMarketplaceInstallsFile, marketplaceDefaultsSeededFile,
  userMarketplaceDirCloud,
} from '../paths';
import { getActiveUserId, isAnonymousLocalId } from './users';

import { registerDeferred } from '../util/boot_init';

/**
 * Remove orphaned quarantine staging/trash dirs left by an install killed
 * between materialize and promote. Registered as boot-phase work (W2): only
 * dot-prefixed staging/trash names under the marketplace skills root are
 * touched, so a crash can never strand content where the loader would see it.
 */
/** Staging dir name for the quarantine flow. Exported so a test can pin that
 *  the name never collides with the context-demotion words (`test`, `vendor`,
 *  ...): a future absolute-path classifier would otherwise silently demote the
 *  whole scan, laundering a payload parked in the staging dir name. */
export function quarantineStagingName(hex: string): string {
  return `.staging-${hex}`;
}

/**
 * Trash dir name for the promote swap.
 *
 * The `content_id` is part of the name on purpose: a crash between the two renames leaves the
 * previous version's ONLY copy in here, and boot-time recovery has to know which install it
 * belongs to. The old `.trash-<hex>` shape carried no such information, so recovery was
 * impossible and the dir could only be deleted — which is exactly how a crashed update made
 * both the old and the new version disappear (specs/010 发现 15).
 */
export function quarantineTrashName(contentId: string, hex: string): string {
  return `.trash-${contentId}-${hex}`;
}

/** Trailing random suffix produced by `randomBytes(6).toString('hex')`. */
const TRASH_SUFFIX = /^(.+)-([0-9a-f]{12})$/;

/**
 * Recover the `content_id` a trash dir belongs to, or `null` when the name predates the
 * id-bearing shape. `null` means "cannot know the target" — the caller deletes instead of
 * guessing, because restoring content into the wrong install would be worse than losing it.
 */
export function contentIdFromTrashName(name: string): string | null {
  if (!name.startsWith('.trash-')) return null;
  const match = TRASH_SUFFIX.exec(name.slice('.trash-'.length));
  return match ? match[1] : null;
}

export function cleanupOrphanedStagingDirs(uid: string): void {
  const root = userMarketplaceSkillsDir(uid);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith('.staging-') && !e.name.startsWith('.trash-')) continue;
    const full = path.join(root, e.name);
    try {
      // `.staging-*` holds content that never passed the quality gate or the deep scan.
      // It is deleted unconditionally: restoring it would install unverified bytes.
      //
      // `.trash-*` holds the PREVIOUS, already-verified version, parked there by the promote
      // swap. When the process died between `rename(target → trash)` and
      // `rename(staging → target)`, this is the only surviving copy — deleting it is what made
      // a crashed update lose both versions (specs/010 发现 15, PRD §7.5).
      if (e.name.startsWith('.trash-') && _restoreCrashedPromote(uid, root, e.name, full)) continue;
      fs.rmSync(full, { recursive: true, force: true });
      log.info('cleaned orphaned staging dir', { dir: e.name });
    } catch (err) {
      log.warn('failed to clean orphaned staging dir', { dir: e.name, error: String(err) });
    }
  }
}

/**
 * Put a trashed previous version back when the install it belongs to is missing.
 *
 * Returns `true` only when the content was restored; every other case falls through to the
 * unconditional delete. The three ways it declines are all "we cannot prove this is a usable
 * copy of that install", and guessing is worse than deleting:
 *   - the name predates the id-bearing shape, so the target is unknown;
 *   - the install already exists, so the trash is genuinely leftover;
 *   - the tree has no `SKILL.md`, so it is not a loadable skill.
 */
function _restoreCrashedPromote(uid: string, root: string, name: string, full: string): boolean {
  const contentId = contentIdFromTrashName(name);
  if (!contentId) return false;
  const target = userMarketplaceSkillDir(uid, contentId);
  if (path.dirname(target) !== root) return false;
  if (fs.existsSync(target)) return false;
  if (!fs.existsSync(path.join(full, 'SKILL.md'))) return false;
  try {
    // Restored under its real name: the dot prefix exists to keep crash residue invisible to
    // the loader, and this content is no longer residue — it is the live version again.
    fs.renameSync(full, target);
    log.info('restored previous version after a crashed promote', { contentId, from: name });
    return true;
  } catch (err) {
    log.warn('failed to restore previous version after a crashed promote', {
      contentId, from: name, error: String(err),
    });
    return false;
  }
}

registerDeferred('marketplace:cleanup-staging', () => {
  try {
    cleanupOrphanedStagingDirs(getActiveUserId());
    // An agent update interrupted between parking the old version and finishing the new one.
    recoverInterruptedAgentReplaces(userMarketplaceAgentsDir(getActiveUserId()));
  } catch {
    // No active user yet — nothing to clean.
  }
});

/**
 * Finish a fork ("convert to my version") that a crash interrupted between uninstalling the
 * official copy and adopting the custom one (specs/010 FR-055). Boot-phase work for the same
 * reason as the staging sweep: it is disk-only, has no deadline, and must never block startup.
 */
registerDeferred('marketplace:fork-recovery', async () => {
  try {
    const fork = await import('./marketplace/fork-to-custom');
    const report = await fork.recoverInterruptedForks(getActiveUserId());
    if (report.completed.length || report.discarded.length) {
      log.info('fork recovery finished', {
        completed: report.completed.length, discarded: report.discarded.length,
      });
    }
  } catch {
    // No active user yet, or nothing to recover — startup carries on either way.
  }
});
import { withCommonHeaders } from './api_common';
import { requireCogSeedApiBase } from './api_base';
import { getLanguage } from './config';
import { invalidateSkills as invalidateCoreAgentSkills, listSkillSpecsForUser } from '../model/core-agent/skill-registry';
import {
  getSkillCacheDir, getSkillCacheDirForUser, isCacheFresh, isCacheFreshForUser,
  readAgentCache, readAgentCacheForUser, touchCacheEntry, touchCacheEntryForUser,
  writeAgentCache, writeAgentCacheForUser, writeSkillCache, writeSkillCacheForUser,
} from './marketplace_cache';
import {
  addAgentInstall, addSkillInstall, readInstalls, removeAgentInstall, removeSkillInstall,
} from './marketplace_installs';
import { withMarketplaceCacheLock, withMarketplaceInstallLock } from './marketplace_locks';
import { agentPrivateSkillIdsFromBundle, stampPrivateSkillOwners } from './marketplace_private_skills';
import { MarketplaceError } from './marketplace/errors';
import { readContentStatus, readInstalledVersion } from './marketplace/installed-version';
import { recordSkillActivated } from './marketplace/engagement-event';
import { builtinCapabilityAvailable } from './agent_dependency_state';
import { beginAgentReplace, recoverInterruptedAgentReplaces } from './marketplace_agent_replace';
import { clearAgentUpdateFailure } from './agent_update_failures';
import {
  agentReadiness, planAgentDependencies, type AgentReadiness, type DependencyItem, type LocalSkillState,
} from './marketplace_agent_deps';
import { hubContentStatus, isHubContentDisabled, isHubContentInstallable } from '../../shared/hub-content-status';
import { observeHubSkillStatus, observeHubSkillStatusLocked } from './marketplace/content-status';
import { getSkillMetadata, invalidateMetadataIndex, normalizeCatalogListRow, type CatalogListRow, type SkillMetadata } from './marketplace/metadata-adapter';
import { decideMarketplaceContentUpdate } from './marketplace-update-policy';
import { fetchImmutableSource } from './marketplace/source-fetch';
import { AGENT_PACKAGE_FORMAT, fetchAgentPackage, type AgentPackage } from './marketplace/agent-package';
import { writeVersionCopy } from './marketplace/version-store';
import {
  downloadMarketplaceBundle,
  extractBundleSafely,
  parseMarketplaceBundle,
  safeRelPath,
} from './marketplace_bundle';
import { createLogger } from '../logger';
import {
  validateAgentSpec, validateSkillDir,
  ValidationReport as QualityReport,
} from '../quality';
import { persistReport as persistQualityReport } from '../quality/report';

const log = createLogger('marketplace');
const MARKETPLACE_JSON_TIMEOUT_MS = 60_000;

export { extractBundleSafely, safeRelPath };

// ── server URL ────────────────────────────────────────────────────────────
// Server access is explicit in CogSeed-only builds; no legacy or guessed domain is embedded.
export function apiBase(): string {
  return requireCogSeedApiBase();
}

// ── envelope ──────────────────────────────────────────────────────────────
interface Envelope { code: number; msg?: string; [k: string]: unknown }

export async function postJson<T>(p: string, body: unknown): Promise<T> {
  const res = await fetchWithRetry(`marketplace:${p}`, `${apiBase()}${p}`, {
    method: 'POST',
    headers: withCommonHeaders({
      'Content-Type': 'application/json',
      'Accept-Language': getLanguage(),
    }),
    body: JSON.stringify(body || {}),
  }, {
    timeoutMs: MARKETPLACE_JSON_TIMEOUT_MS,
    timeoutMessage: `marketplace:${p} timed out after ${Math.round(MARKETPLACE_JSON_TIMEOUT_MS / 1000)}s`,
  });
  const text = await res.text();
  let data: Envelope;
  try { data = JSON.parse(text); } catch { throw new Error(`bad response (${res.status}): ${text.slice(0, 200)}`); }
  if (data.code !== 0) {
    // 带上 Hub 自己的错误码：调用方按码识别"本 Hub 不提供该接口"，而不是从文案里猜。
    const hubErrorCode = (data as { error?: { code?: unknown } }).error?.code;
    throw Object.assign(new Error(data.msg || `marketplace ${p} failed (code=${data.code})`), {
      marketplaceCode: data.code,
      ...(typeof hubErrorCode === 'string' ? { hubErrorCode } : {}),
    });
  }
  return data as unknown as T;
}

// ── types ─────────────────────────────────────────────────────────────────
export interface MarketplaceCategory {
  code: string;
  name_zh: string;
  name_en: string;
  name_ja?: string;
  name_pt?: string;
  sort_order: number;
}

export interface MarketplaceAgent {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
  icon: string;
  color: string;
  version: string;
  agent_skills_bundle_url?: string;
  /** Author uid. `"0"` is the official-platform marker (UI label `marketplace.author_platform`);
   *  everything else is a community uploader. Dedup is on (name, create_uid), so same name from
   *  different authors yields distinct rows — the UI shows the author badge to tell them apart. */
  create_uid: string;
  download_count: number;
  published_at: number;
  updated_at: number;
  default_install?: boolean | number;
  is_open_source?: boolean | number;
  status?: string;
  min_app_version?: string;
  minAppVersion?: string;
  min_version?: string;
  minVersion?: string;
  min_pc_version?: string;
  minPcVersion?: string;
  /** C5/N-06：本机客户端版本不足、reconcile 跳过该内容时由列表接口附加（兼容条目缺席，
   *  不是 `false`）。字段名与 MarketplaceInstallError 一致，渲染层据此显示本地化状态。 */
  appUpdateRequired?: boolean;
  /** 标记成立时本机客户端版本（`currentAppVersion()`），供渲染层显示提示。 */
  currentAppVersion?: string;
}

export interface MarketplaceSkill {
  /** A-01 的 `content_id`，由 `listMarketplaceSkills` 在接口边界映射而来。 */
  id: string;
  content_id?: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
  version: string;
  create_uid: string;
  download_count: number;
  published_at: number;
  updated_at: number;
  default_install?: boolean | number;
  is_open_source?: boolean | number;
  status?: string;
  state?: string;
  min_app_version?: string;
  minAppVersion?: string;
  min_version?: string;
  minVersion?: string;
  min_pc_version?: string;
  minPcVersion?: string;
  artifact?: SkillMetadata['artifact'];
  /** 同 `MarketplaceAgent.appUpdateRequired`。 */
  appUpdateRequired?: boolean;
  /** 同 `MarketplaceAgent.currentAppVersion`。 */
  currentAppVersion?: string;
}

export interface AgentDetail {
  id: string;
  version: string;
  category: string;
  published_at: number;
  updated_at?: number;
  /** Full agent.json content (already merged from cache or freshly fetched). */
  agent_json: Record<string, unknown>;
  /** COS URL of the agent.json blob — recorded in installs.json so reconcile on other
   *  devices can fetch directly. May be empty on a cache-hit code path; install resolves
   *  via the detail endpoint when missing. */
  agent_json_url: string;
  /** Optional zip containing this agent's private skills. Empty means none. */
  agent_skills_bundle_url?: string;
  /** Author uid from the server row. Recorded in `_install.json` so the in-app detail can
   *  render the author badge without a marketplace round-trip. May be `''` on cache-hit. */
  create_uid: string;
  default_install?: boolean;
  is_open_source?: boolean;
  status?: string;
  min_app_version?: string;
}

export interface SkillDetail {
  id: string;
  name?: string;
  version: string;
  category: string;
  published_at: number;
  updated_at?: number;
  /** Local filesystem path to the cache directory (caller can walk it to render the file tree
   *  + read SKILL.md). The cache may also be wiped between calls — re-fetch via this function. */
  cache_dir: string;
  /**
   * @deprecated Hub 内容不再使用它。A-02 按 F4 收口为只回不可变字节后，对象存储地址
   * 既不是下载 authority 也不是版本身份；字节一律经 `source-fetch.ts` 按
   * `{content_id, version}` 从 Hub 源站取得。该字段对 Hub 内容恒为空串，仅为不改动
   * 既有类型形状而保留。**不得据它判定版本或发起下载。**
   */
  bundle_url: string;
  /** 不可变发布物标识。**完整性校验的唯一依据**（FR-011 / FR-025）。 */
  artifact?: SkillMetadata['artifact'];
  /** Same as `AgentDetail.create_uid`. */
  create_uid: string;
  default_install?: boolean;
  is_open_source?: boolean;
  status?: string;
  min_app_version?: string;
}

// ── listing ───────────────────────────────────────────────────────────────
/** C5/N-06：给列表条目附上"需更新客户端"状态。只有**确实被版本门跳过**的内容才加
 *  appUpdateRequired/minAppVersion/currentAppVersion；兼容条目原样返回（不加字段），
 *  渲染层据此显示本地化提示。字段名与 MarketplaceInstallError 一致。 */
function annotateAppIncompatible<T extends { id?: string }>(items: T[], kind: 'agent' | 'skill'): T[] {
  const skips = listAppIncompatibleSkips().filter((item) => item.kind === kind);
  if (!skips.length) return items;
  return items.map((item) => {
    const hit = skips.find((skip) => skip.id === String(item?.id || ''));
    return (hit
      ? { ...item, appUpdateRequired: true, minAppVersion: hit.minAppVersion, currentAppVersion: hit.currentAppVersion }
      : item) as T;
  });
}

export async function listMarketplaceAgents(
  opts: { category?: string; status?: string; q?: string; page?: number; size?: number } = {},
): Promise<{ list: MarketplaceAgent[]; total: number }> {
  // 2026-10-14（C5/N-06，按 owner 决定"市场内容与客户端同步"）：把本机客户端版本
  // 随目录请求发出，服务端可按版本下发兼容内容；老服务端忽略该字段，无副作用。
  const res = await postJson<{ list?: unknown; total?: number }>('/marketplace/agents/list', {
    app_version: currentAppVersion(),
    category: opts.category || null,
    status: opts.status || null,
    q: opts.q || null,
    page: opts.page || 1,
    size: opts.size || 50,
  });
  // 新格式（B-01）下发 `content_id`、RFC 3339 时间与 `avatar{icon,color}`：在接口边界归一，上层继续按
  // `id`、毫秒与 `icon`/`color` 读取。旧格式的行（只有 `id`）原样透传。
  const list = (Array.isArray(res.list) ? res.list : []).flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || !('content_id' in raw)) return [raw];
    const row = normalizeCatalogListRow(raw);
    if (!row) return [];
    const avatar = (row as { avatar?: { icon?: unknown; color?: unknown } }).avatar;
    return [{
      ...row,
      icon: typeof row.icon === 'string' && row.icon ? row.icon : String(avatar?.icon ?? ''),
      color: typeof row.color === 'string' && row.color ? row.color : String(avatar?.color ?? ''),
    }];
  }) as unknown as MarketplaceAgent[];
  return { ...res, list: annotateAppIncompatible(list, 'agent'), total: typeof res.total === 'number' ? res.total : list.length } as { list: MarketplaceAgent[]; total: number };
}

export async function listMarketplaceSkills(
  opts: { category?: string; status?: string; q?: string; page?: number; size?: number } = {},
): Promise<{ list: MarketplaceSkill[]; total: number }> {
  const uid = getActiveUserId();
  const res = await postJson<{ list?: unknown; total?: number }>('/marketplace/skills/list', {
    app_version: currentAppVersion(),
    category: opts.category || null,
    status: opts.status || null,
    q: opts.q || null,
    page: opts.page || 1,
    size: opts.size || 50,
  });
  // A-01 下发 `content_id` 与 RFC 3339 时间；在接口边界归一，上层继续按 `id` 与毫秒读取。
  const list = (Array.isArray(res.list) ? res.list : [])
    .map(normalizeCatalogListRow)
    .filter((row): row is CatalogListRow => row !== null) as unknown as MarketplaceSkill[];
  invalidateMetadataIndex();
  await Promise.all(list.map((row) => observeHubSkillStatus(uid, row.id, row)));
  return {
    ...res,
    list: annotateAppIncompatible(list, 'skill'),
    total: typeof res.total === 'number' ? res.total : list.length,
  };
}

// Open-source projects专区 — a curated, read-only catalog (config-as-code on
// the Server; no upload path). Unlike agents/skills it carries `driver`
// (install/cli/mcp — the existing mechanism that runs it, not a new system),
// `repo`, and a user-language `task_*` one-liner used to prefill the
// Commander composer when a card is clicked. The list endpoint also returns
// the OSS-specific `categories` so the client renders the chip row in one
// round-trip.
export type ProjectDriver = 'install' | 'cli' | 'mcp';
export interface MarketplaceProject {
  id: string;
  name: string;
  repo: string;
  category: string;
  driver: ProjectDriver;
  glyph: string;
  color: string;
  by: string;
  description_zh: string;
  description_en: string;
  task_zh: string;
  task_en: string;
  home?: boolean;
}
export interface MarketplaceProjectsListResult {
  list: MarketplaceProject[];
  total: number;
  categories: MarketplaceCategory[];
  source?: 'server' | 'bundled';
  stale?: boolean;
}

interface MarketplaceProjectsCatalog {
  categories: MarketplaceCategory[];
  projects: MarketplaceProject[];
}

let _localProjectsCatalog: MarketplaceProjectsCatalog | null = null;

function _loadLocalProjectsCatalog(): MarketplaceProjectsCatalog {
  if (_localProjectsCatalog) return _localProjectsCatalog;
  // Bundled mirror of Server/biz/marketplace/marketplace_mgr.py::_OSS_* for offline dev.
  const file = path.join(__dirname, '..', 'data', 'oss-projects.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<MarketplaceProjectsCatalog>;
  _localProjectsCatalog = {
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
  };
  return _localProjectsCatalog;
}

function _normProjectListOpts(
  opts: { category?: string; q?: string; page?: number; size?: number; home_only?: boolean; local_only?: boolean } = {},
): { category: string; q: string; page: number; size?: number; homeOnly: boolean } {
  const page = Number(opts.page);
  const size = Number(opts.size);
  return {
    category: String(opts.category || '').trim().toLowerCase(),
    q: String(opts.q || '').trim().toLowerCase(),
    page: Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1,
    ...(Number.isFinite(size) ? { size: Math.max(1, Math.min(100, Math.floor(size))) } : {}),
    homeOnly: opts.home_only === true,
  };
}

function _listLocalMarketplaceProjects(
  opts: { category?: string; q?: string; page?: number; size?: number; home_only?: boolean; local_only?: boolean } = {},
): MarketplaceProjectsListResult {
  const catalog = _loadLocalProjectsCatalog();
  const normalized = _normProjectListOpts(opts);
  const categoryCodes = new Set(catalog.categories.map((c) => c.code));
  let rows = catalog.projects;
  if (normalized.homeOnly) rows = rows.filter((p) => p.home);
  if (normalized.category && categoryCodes.has(normalized.category)) {
    rows = rows.filter((p) => p.category === normalized.category);
  } else if (normalized.category) {
    rows = [];
  }
  if (normalized.q) {
    rows = rows.filter((p) => [
      p.name,
      p.repo,
      p.by,
      p.description_zh,
      p.description_en,
      p.task_zh,
      p.task_en,
    ].join(' ').toLowerCase().includes(normalized.q));
  }

  const total = rows.length;
  const size = normalized.size || (normalized.homeOnly ? total || 1 : 20);
  const start = (normalized.page - 1) * size;
  const categories = catalog.categories
    .slice()
    .sort((a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code));

  return {
    list: rows.slice(start, start + size).map((p) => ({ ...p })),
    total,
    categories: categories.map((c) => ({ ...c })),
    source: 'bundled',
    stale: true,
  };
}

// Main-process conditional cache for the OSS projects list: store the last
// ETag + parsed body per query so PC's per-launch home-strip revalidation costs
// a 304 instead of re-downloading the (small) catalog. In-memory only — a fresh
// process re-establishes the ETag on its first call; bounded so ad-hoc searches
// can't grow it without limit.
// INVARIANT: the cache key is the request body ONLY. This is correct because the
// OSS projects list is public / account-independent and `apiBase()` is pinned for
// the process lifetime. If either ever becomes user/profile-scoped at runtime,
// fold the account/profile (and apiBase) into the key or a 304 could replay
// another scope's body.
const _projectsConditional = new Map<string, { etag: string; result: MarketplaceProjectsListResult }>();
const _PROJECTS_CONDITIONAL_MAX = 64;

async function _fetchProjectsListConditional(body: Record<string, unknown>): Promise<MarketplaceProjectsListResult> {
  const key = JSON.stringify(body);
  const prior = _projectsConditional.get(key);
  const headers: Record<string, string> = withCommonHeaders({
    'Content-Type': 'application/json',
    'Accept-Language': getLanguage(),
  });
  if (prior) headers['If-None-Match'] = prior.etag;
  const res = await fetchWithRetry(
    'marketplace:/marketplace/projects/list',
    `${apiBase()}/marketplace/projects/list`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    {
      timeoutMs: MARKETPLACE_JSON_TIMEOUT_MS,
      timeoutMessage: `marketplace:/marketplace/projects/list timed out after ${Math.round(MARKETPLACE_JSON_TIMEOUT_MS / 1000)}s`,
    },
  );
  if (res.status === 304 && prior) return prior.result;
  const text = await res.text();
  let data: Envelope;
  try { data = JSON.parse(text); } catch { throw new Error(`bad response (${res.status}): ${text.slice(0, 200)}`); }
  if (data.code !== 0) throw new Error(data.msg || `marketplace /marketplace/projects/list failed (code=${data.code})`);
  const result = data as unknown as MarketplaceProjectsListResult;
  const etag = res.headers.get('etag');
  if (etag) {
    if (_projectsConditional.size >= _PROJECTS_CONDITIONAL_MAX) _projectsConditional.clear();
    _projectsConditional.set(key, { etag, result });
  }
  return result;
}

export async function listMarketplaceProjects(
  opts: { category?: string; q?: string; page?: number; size?: number; home_only?: boolean; local_only?: boolean } = {},
): Promise<MarketplaceProjectsListResult> {
  if (opts.local_only === true) return _listLocalMarketplaceProjects(opts);
  try {
    const fresh = await _fetchProjectsListConditional({
      category: opts.category || null,
      q: opts.q || null,
      page: opts.page || 1,
      ...(typeof opts.size === 'number' ? { size: opts.size } : {}),
      home_only: opts.home_only === true,
    });
    return { ...fresh, source: fresh.source || 'server', stale: false };
  } catch (err) {
    log.warn('marketplace projects server list failed; using bundled catalog', {
      error: (err as Error)?.message || String(err),
    });
    return _listLocalMarketplaceProjects(opts);
  }
}

// ── detail (cache-aware) ──────────────────────────────────────────────────
// Detail-page entry. Caller provides the list-row's freshness pair so we can short-circuit
// when cache is hot; we still fetch + repopulate cache on miss / stale.
type MarketplaceFreshness = {
  version: string;
  published_at: number;
  updated_at?: number;
} & MinAppVersionSource;
type MarketplaceInstallKind = 'agent' | 'skill';
type MarketplaceInstallOpts = {
  force?: boolean;
  name?: string;
  /**
   * The user was shown the risk and chose to install anyway.
   *
   * Distinct from `force`, which predates this and gates unrelated things
   * (dependency propagation, advisories that never blocked). Reusing it would
   * have made every existing `force: true` caller silently accept security
   * risk — and `force` is set by ordinary retry paths.
   *
   * Honoured only where `scanVerdictAllowsOverride` agrees, so a caller passing
   * this cannot buy past a red line by asserting consent.
   */
  acceptSecurityRisk?: boolean;
};

/** 当前客户端版本。导出以便目录缓存按版本失效（C5/N-06：市场内容与客户端同步）——
 *  agents.ts / skills.ts 的 catalog 缓存需要它，但这两个模块没有 electron 依赖。 */
export function currentAppVersion(): string {
  try { return app.getVersion(); } catch { return ''; }
}

function _normalizeMarketplaceMinAppVersion(...sources: Array<MinAppVersionSource | null | undefined>): string {
  return minAppVersionFrom(...sources);
}

function _assertMarketplaceAppCompatible(kind: MarketplaceInstallKind, id: string, name: string | undefined, minAppVersion: string): void {
  const min = normalizeMinAppVersion(minAppVersion);
  if (!min) return;
  const current = currentAppVersion();
  if (satisfiesMinAppVersion(current, min)) return;
  throw new MarketplaceInstallError(
    kind,
    id,
    name,
    `requires CogSeed >= ${min}; current ${current || 'unknown'}`,
    { appUpdateRequired: true, minAppVersion: min, currentAppVersion: current || '' },
  );
}

function _isMarketplaceAppCompatible(minAppVersion: string): boolean {
  return satisfiesMinAppVersion(currentAppVersion(), minAppVersion);
}

export class MarketplaceInstallError extends Error {
  code = 'MARKETPLACE_INSTALL_FAILED';
  marketplaceKind: MarketplaceInstallKind;
  marketplaceId: string;
  marketplaceName: string;
  marketplaceReason: string;
  /** Set when the install was blocked because the client app version is missing
   *  or older than the item's min_app_version. Lets the renderer show a localized
   *  "update CogSeed" prompt with the versions instead of a raw English string. */
  appUpdateRequired = false;
  minAppVersion = '';
  currentAppVersion = '';

  constructor(
    kind: MarketplaceInstallKind,
    id: string,
    name: string | undefined,
    reason: string,
    extra?: { appUpdateRequired?: boolean; minAppVersion?: string; currentAppVersion?: string },
  ) {
    const label = kind === 'agent' ? 'agent' : 'skill';
    const cleanName = String(name || '').trim();
    const displayName = cleanName || (id || '').trim();
    super(`${label} ${displayName}: ${reason}`);
    this.name = 'MarketplaceInstallError';
    this.marketplaceKind = kind;
    this.marketplaceId = id;
    this.marketplaceName = cleanName;
    this.marketplaceReason = reason;
    if (extra?.appUpdateRequired) this.appUpdateRequired = true;
    if (extra?.minAppVersion) this.minAppVersion = extra.minAppVersion;
    if (extra?.currentAppVersion) this.currentAppVersion = extra.currentAppVersion;
  }
}

export function getMarketplaceInstallErrorInfo(err: unknown): {
  kind?: MarketplaceInstallKind;
  id?: string;
  name?: string;
  reason: string;
  qualityReport?: QualityReport;
  appUpdateRequired?: boolean;
  minAppVersion?: string;
  currentAppVersion?: string;
  securityBlocked?: boolean;
  securityUnavailable?: boolean;
  securityOverridable?: boolean;
  securityScan?: unknown;
  securityRuleIds?: string[];
} {
  const e = err as Partial<MarketplaceInstallError> & {
    message?: string;
    qualityReport?: QualityReport;
    securityBlocked?: boolean;
    securityUnavailable?: boolean;
    securityOverridable?: boolean;
    securityScan?: unknown;
    securityRuleIds?: string[];
  };
  return {
    kind: e.marketplaceKind,
    id: e.marketplaceId,
    name: e.marketplaceName,
    reason: e.marketplaceReason || e.message || String(err),
    qualityReport: e.qualityReport,
    ...(e.appUpdateRequired ? {
      appUpdateRequired: true,
      minAppVersion: e.minAppVersion || '',
      currentAppVersion: e.currentAppVersion || '',
    } : {}),
    // The scan verdict is part of the install-failure contract, not a separate
    // channel: the renderer's risk card reads these fields off the invoke
    // response. Dropped here once before by a refactor, which silently reduced
    // every security refusal to a generic failure alert — the card existed but
    // could never fire.
    ...(e.securityBlocked === true ? { securityBlocked: true } : {}),
    ...(e.securityUnavailable === true ? { securityUnavailable: true } : {}),
    ...(e.securityOverridable === true ? { securityOverridable: true } : {}),
    ...(e.securityScan ? { securityScan: e.securityScan } : {}),
    ...(Array.isArray(e.securityRuleIds) && e.securityRuleIds.length
      ? { securityRuleIds: e.securityRuleIds }
      : {}),
  };
}

function _wrapMarketplaceInstallError(
  kind: MarketplaceInstallKind,
  id: string,
  name: string | undefined,
  err: unknown,
): MarketplaceInstallError {
  if (err instanceof MarketplaceInstallError) return err;
  const reason = (err as Error)?.message || String(err);
  const wrapped = new MarketplaceInstallError(kind, id, name, reason);
  const qualityReport = (err as { qualityReport?: QualityReport })?.qualityReport;
  if (qualityReport) (wrapped as { qualityReport?: QualityReport }).qualityReport = qualityReport;
  // The security verdict fields ride on the same error as the quality report:
  // the IPC layer reads them via `getMarketplaceInstallErrorInfo`, and the
  // renderer's risk card keys off them. Wrapping without copying is how the
  // card silently became unreachable — `_securityInstallError` sets them, and
  // this wrapper is the next hop on every install path.
  const sec = err as {
    securityBlocked?: boolean;
    securityUnavailable?: boolean;
    securityOverridable?: boolean;
    securityScan?: unknown;
    securityRuleIds?: string[];
  };
  const target = wrapped as typeof wrapped & {
    securityBlocked?: boolean;
    securityUnavailable?: boolean;
    securityOverridable?: boolean;
    securityScan?: unknown;
    securityRuleIds?: string[];
  };
  if (sec.securityBlocked === true) target.securityBlocked = true;
  if (sec.securityUnavailable === true) target.securityUnavailable = true;
  if (sec.securityOverridable === true) target.securityOverridable = true;
  if (sec.securityScan) target.securityScan = sec.securityScan;
  if (Array.isArray(sec.securityRuleIds) && sec.securityRuleIds.length) {
    target.securityRuleIds = sec.securityRuleIds;
  }
  return wrapped;
}

function _agentJsonName(agentJson: Record<string, unknown>): string {
  const raw = agentJson?.name;
  return typeof raw === 'string' ? raw.trim() : '';
}

const SKILL_DISPLAY_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const BUILTIN_WORKFLOW_REFS = new Set([
  'read_file', 'write_file', 'bash', 'kb_search', 'kb_read',
  'markdown_to_pdf', 'html_to_pdf', 'generate_image', 'web_search', 'web_fetch',
]);

function _agentSkillDependencyDisplayNames(
  agentJson: Record<string, unknown>,
  skillList: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  const workflow = typeof agentJson.workflow === 'string' ? agentJson.workflow : '';
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const name = raw.trim();
    if (!SKILL_DISPLAY_REF_RE.test(name) || seen.has(name)) return;
    if (BUILTIN_WORKFLOW_REFS.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  // Marketplace-installed agents store dependency ids in skill_list, while older
  // authored workflows often still mention the readable skill names. Pair by order
  // so a stale id can still produce a useful user-facing failure.
  const useRe = /\buse\s+`([^`]+)`/gi;
  for (let m = useRe.exec(workflow); m; m = useRe.exec(workflow)) add(m[1]);
  if (names.length < skillList.length) {
    const skillRe = /`([^`]+)`\s+skill\b/gi;
    for (let m = skillRe.exec(workflow); m; m = skillRe.exec(workflow)) add(m[1]);
  }

  skillList.forEach((sid, idx) => {
    const display = names[idx] || (SKILL_DISPLAY_REF_RE.test(sid) && !/^[0-9a-f]{12}$/i.test(sid) ? sid : '');
    if (display) out.set(sid, display);
  });
  return out;
}

function _marketplaceStatus(row: { status?: string; state?: string }): string {
  return hubContentStatus(row);
}

function _assertApprovedDependencySkill(
  skillId: string,
  displayName: string,
  row: { status?: string; state?: string },
): void {
  const status = _marketplaceStatus(row);
  if (!isHubContentInstallable(row)) {
    throw new MarketplaceInstallError(
      'skill',
      skillId,
      displayName || skillId,
      status ? `status_not_approved:${status}` : 'status_not_approved',
    );
  }
}

/**
 * B-01 目录里这个 Agent 的 `agent-package-v1` 发布物行；旧格式 Agent（目录行没有 artifact）返回 `null`。
 *
 * 目录查询失败也返回 `null`：走旧格式路径，由它自己报错，一次目录抖动不应让本可成功的安装失败。
 * 找到的行是权威：版本、摘要、要求的客户端版本都以它为准，不用界面传来的（可能已过期的）值。
 */
async function _findAgentPackageRow(agentId: string): Promise<(CatalogListRow & { artifact: NonNullable<CatalogListRow['artifact']> }) | null> {
  try {
    for (let page = 1; page <= 20; page++) {
      const r = await postJson<{ list?: unknown[] }>('/marketplace/agents/list', { app_version: currentAppVersion(), page, size: 100, ids: [agentId] });
      const list = Array.isArray(r.list) ? r.list : [];
      for (const raw of list) {
        const row = normalizeCatalogListRow(raw);
        if (!row || row.id !== agentId) continue;
        return row.artifact && row.artifact.format === AGENT_PACKAGE_FORMAT && row.artifact.sha256
          ? (row as CatalogListRow & { artifact: NonNullable<CatalogListRow['artifact']> })
          : null;
      }
      if (list.length < 100) break;
    }
  } catch (err) {
    log.warn('agent package lookup failed; falling back to the legacy path', { agentId, error: String((err as Error)?.message || err) });
  }
  return null;
}

/** 目录行里的引用清单（B-01 的 `skill_refs` / `builtin_refs` / `bundled_skills`）；任一缺席返回 `null`，调用方改为读包。 */
function _skillListFromCatalogRow(row: CatalogListRow): { skillList: string[]; bundled: Set<string> } | null {
  const refs = (v: unknown, pick: (x: Record<string, unknown>) => unknown): string[] | null => {
    if (!Array.isArray(v)) return null;
    return v.map((x) => (x && typeof x === 'object' ? pick(x as Record<string, unknown>) : null))
      .filter((x): x is string => typeof x === 'string' && x.length > 0);
  };
  const hub = refs(row.skill_refs, (x) => x.content_id);
  const builtin = refs(row.builtin_refs, (x) => x.id);
  const bundled = refs(row.bundled_skills, (x) => x.name);
  if (!hub || !builtin || !bundled) return null;
  return { skillList: [...hub, ...builtin, ...bundled], bundled: new Set(bundled) };
}

/** 把读出的发布物与目录行拼成安装流程用的 `AgentDetail`。`agent_json_url` 为空：新格式的字节只经 B-02 取。 */
function _agentDetailFromPackage(
  agentId: string, row: CatalogListRow, pkg: AgentPackage,
): AgentDetail {
  const minAppVersion = _normalizeMarketplaceMinAppVersion(row, pkg.agentJson);
  const category = typeof row.category === 'string' && row.category ? row.category : String(pkg.agentJson.category || '');
  return {
    id: agentId, version: pkg.version, category,
    published_at: pkg.publishedAt ?? row.published_at,
    ...(typeof row.updated_at === 'number' ? { updated_at: row.updated_at } : {}),
    agent_json: pkg.agentJson, agent_json_url: '', agent_skills_bundle_url: '',
    create_uid: typeof row.create_uid === 'string' ? row.create_uid : '',
    default_install: row.default_install === true,
    is_open_source: row.is_open_source === true,
    status: row.status || '',
    ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
  };
}

export async function getAgentDetail(
  agentId: string, expect: MarketplaceFreshness,
): Promise<AgentDetail> {
  return getAgentDetailForUser(getActiveUserId(), agentId, expect);
}

/** B-05 is a display projection, not legacy install data. Validate before replacing
 *  a cache or consuming a refreshed detail so a catalog failure cannot turn a
 *  missing agent_json into a filesystem error (or an incomplete installation). */
function _assertLegacyAgentDetail(agentId: string, detail: { agent_json?: unknown }): void {
  if (!detail.agent_json || typeof detail.agent_json !== 'object' || Array.isArray(detail.agent_json)) {
    throw new MarketplaceInstallError('agent', agentId, '', t('marketplace_install_result.invalid_agent_detail'));
  }
}

export async function getAgentDetailForUser(
  userId: string, agentId: string, expect: MarketplaceFreshness,
): Promise<AgentDetail> {
  if (!agentId) throw new Error('agentId required');
  if (await isCacheFreshForUser(userId, 'agent', agentId, expect)) {
    const cached = await readAgentCacheForUser(userId, agentId);
    if (cached) {
      await touchCacheEntryForUser(userId, 'agent', agentId);
      // Cache hit path: agent_json_url / create_uid are unknown (not stored in cache meta).
      // Install path re-fetches via /detail to get them; detail render doesn't need them.
      return {
        id: agentId, version: expect.version, category: '',
        published_at: expect.published_at, updated_at: expect.updated_at,
        agent_json: cached, agent_json_url: '', create_uid: '',
        ...(_normalizeMarketplaceMinAppVersion(expect, cached) ? { min_app_version: _normalizeMarketplaceMinAppVersion(expect, cached) } : {}),
      };
    }
  }
  // 新格式：详情（展示用字段）取 B-05；Hub 还没提供该接口时退回读包里的 agent.json。不写旧缓存。
  const packageRow = await _findAgentPackageRow(agentId);
  if (packageRow) {
    let agentJson: Record<string, unknown>;
    try {
      const display = await postJson<Record<string, unknown>>('/marketplace/agents/detail', { content_id: agentId, version: packageRow.version });
      const inner = display && typeof display === 'object' ? (display as Record<string, unknown>).agent_json : null;
      agentJson = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner as Record<string, unknown> : { ...display };
    } catch (err) {
      log.info('agent detail endpoint unavailable; reading the package instead', { agentId, error: String((err as Error)?.message || err) });
      agentJson = (await fetchAgentPackage({ contentId: agentId, version: packageRow.version as string, artifact: packageRow.artifact })).agentJson;
    }
    return _agentDetailFromPackage(agentId, packageRow, {
      agentJson, version: packageRow.version as string, publishedAt: null, privateSkills: null, hasReadme: false,
    });
  }
  // Miss → fetch + repopulate.
  // Hub 的 `agents/detail` 要求 `content_id` + `version`（B-05），旧版只认 `id`；两者都带，
  // 老 Hub 仍可解析。版本优先取调用方期望值，其次从目录行取。
  const fallbackRow = await _findAgentCatalogRowForInstall(agentId);
  const fallbackVersion = (expect && typeof expect.version === 'string' && expect.version)
    || (fallbackRow && typeof fallbackRow.version === 'string' ? fallbackRow.version : '');
  const data = await postJson<{ agent_json: Record<string, unknown>; version: string; category: string; published_at: number; updated_at?: number; agent_json_url: string; agent_skills_bundle_url?: string; create_uid: string; default_install?: boolean; is_open_source?: boolean; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }>(
    '/marketplace/agents/detail',
    fallbackVersion ? { id: agentId, content_id: agentId, version: fallbackVersion } : { id: agentId },
  );
  _assertLegacyAgentDetail(agentId, data);
  await writeAgentCacheForUser(userId, agentId, data.agent_json, {
    version: data.version, published_at: data.published_at, updated_at: data.updated_at,
  });
  const minAppVersion = _normalizeMarketplaceMinAppVersion(data, data.agent_json);
  return {
    id: agentId, version: data.version, category: data.category,
    published_at: data.published_at, updated_at: data.updated_at,
    agent_json: data.agent_json, agent_json_url: data.agent_json_url || '',
    agent_skills_bundle_url: data.agent_skills_bundle_url || '',
    create_uid: data.create_uid || '', default_install: data.default_install === true,
    is_open_source: data.is_open_source === true, status: data.status || data.state || '',
    ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
  };
}

export async function getSkillDetail(
  skillId: string, expect: MarketplaceFreshness,
): Promise<SkillDetail> {
  return getSkillDetailForUser(getActiveUserId(), skillId, expect);
}

export async function getSkillDetailForUser(
  userId: string, skillId: string, expect: MarketplaceFreshness,
): Promise<SkillDetail> {
  if (!skillId) throw new Error('skillId required');
  let meta: SkillMetadata;
  try {
    invalidateMetadataIndex(); // A fresh detail view must not restore stale governance.
    const found = await getSkillMetadata(skillId);
    if (!found) throw new MarketplaceError('CONTENT_NOT_FOUND', `CONTENT_NOT_FOUND: ${skillId}`);
    meta = found;
  } catch (err) {
    // An offline preview can still show cached bytes and the latest known governance
    // state. Installation uses a separate fresh-metadata path and cannot use this fallback.
    if (!(await isCacheFreshForUser(userId, 'skill', skillId, expect))) throw err;
    await touchCacheEntryForUser(userId, 'skill', skillId);
    const knownStatus = readContentStatus(userId, skillId).raw;
    return {
      id: skillId, version: expect.version, category: '',
      published_at: expect.published_at, updated_at: expect.updated_at,
      cache_dir: getSkillCacheDirForUser(userId, skillId), bundle_url: '', create_uid: '',
      ...(knownStatus ? { status: knownStatus } : {}),
      ...(_normalizeMarketplaceMinAppVersion(expect) ? { min_app_version: _normalizeMarketplaceMinAppVersion(expect) } : {}),
    };
  }
  await observeHubSkillStatus(userId, skillId, meta);
  return materializeSkillDetail(userId, skillId, { ...meta, status: meta.status || readContentStatus(userId, skillId).raw });
}

/** Governance metadata is independent of byte-cache freshness. */
async function materializeSkillDetail(userId: string, skillId: string, meta: SkillMetadata): Promise<SkillDetail> {
  const fresh = await isCacheFresh('skill', skillId, meta);
  if (fresh) await touchCacheEntryForUser(userId, 'skill', skillId);
  else if (!isHubContentDisabled(meta)) await _fetchAndCacheSkill(userId, skillId, meta);
  return {
    id: skillId, name: meta.name, version: meta.version, category: meta.category,
    published_at: meta.published_at, updated_at: meta.updated_at,
    cache_dir: getSkillCacheDirForUser(userId, skillId), bundle_url: '', artifact: meta.artifact,
    create_uid: meta.create_uid, default_install: meta.default_install,
    is_open_source: meta.is_open_source, status: meta.status,
    ...(meta.min_app_version ? { min_app_version: meta.min_app_version } : {}),
  };
}

/**
 * Fetch the immutable artifact **from the Hub origin** and extract it into the local cache
 * (idempotent: wipe-and-replace).
 *
 * The former object-storage (COS) direct download is gone: bytes are requested by
 * `{content_id, version}`, streamed into a staging file and verified against
 * `artifact.sha256` + `size_bytes` before anything is unpacked (specs/010 FR-008～FR-012).
 */
async function _fetchAndCacheSkill(
  userId: string,
  skillId: string,
  meta: { version: string; published_at: number; updated_at?: number; artifact: SkillMetadata['artifact'] },
): Promise<void> {
  const stagingRoot = marketplaceCacheSkillsDir(userId);
  await fsp.mkdir(stagingRoot, { recursive: true });
  const staging = path.join(stagingRoot, `.staging-${skillId}-${randomBytes(6).toString('hex')}.zip`);
  try {
    await fetchImmutableSource({
      contentId: skillId, version: meta.version, artifact: meta.artifact, destPath: staging,
    });
    // The file on disk is already digest- and size-verified; reading it back is bounded by
    // the same compressed-size cap that governed the download.
    const zip = parseMarketplaceBundle(await fsp.readFile(staging));
    await writeSkillCacheForUser(userId, skillId, async (dir) => {
      extractBundleSafely(zip, dir);
    }, { version: meta.version, published_at: meta.published_at, updated_at: meta.updated_at });
  } finally {
    await fsp.rm(staging, { force: true }).catch(() => { /* staging is best-effort cleanup */ });
  }
}

async function _fetchAgentPrivateSkillsBundle(agentId: string, bundleUrl: string): Promise<ReturnType<typeof parseMarketplaceBundle> | null> {
  if (!bundleUrl) return null;
  let res: Response;
  let bundle: Buffer | null;
  try {
    const downloaded = await downloadMarketplaceBundle(`marketplace:agent-private-skills:${agentId}`, bundleUrl);
    res = downloaded.response;
    bundle = downloaded.buffer;
  } catch (err) {
    throw new Error(`download agent private skills failed from ${_bundleHost(bundleUrl)}: ${(err as Error)?.message || String(err)}`);
  }
  if (!res.ok) throw new Error(`download agent private skills failed from ${_bundleHost(bundleUrl)} (${res.status})`);
  if (!bundle) throw new Error(`download agent private skills failed from ${_bundleHost(bundleUrl)} (empty response)`);
  return parseMarketplaceBundle(bundle);
}

function _bundleHost(bundleUrl: string): string {
  try {
    return new URL(bundleUrl).host || 'bundle host';
  } catch {
    return 'bundle host';
  }
}

// ── install ───────────────────────────────────────────────────────────────
export async function installMarketplaceAgent(
  agentId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string }> {
  return installMarketplaceAgentForUser(getActiveUserId(), agentId, expect, opts);
}

export async function installMarketplaceAgentForUser(
  userId: string, agentId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string }> {
  if (!agentId) throw new Error('agentId required');
  try {
    return await withMarketplaceInstallLock(
      userId,
      'agent',
      agentId,
      () => _installMarketplaceAgentLocked(userId, agentId, expect, opts),
    );
  } finally {
    // 成败都可能改了安装目录（失败会回滚到旧版），统一让列表下次重读。
    await _clearAgentListCacheForUser(userId);
  }
}

/** "将同时安装"确认框用的只读视图：不写本机，不改任何状态。 */
export interface AgentInstallPlanView {
  items: Array<DependencyItem & { name: string }>;
  readiness: AgentReadiness;
  /** 本机版本低于 Agent 要求：此时不能安装，界面显示"需 CogSeed x.y+"。 */
  appUpdateRequired: boolean;
  minAppVersion: string;
}

/**
 * 预览安装一个 Agent 会同时装什么、复用什么、哪里被阻断。
 *
 * 与安装用同一份依赖规划（`planAgentDependencies`），所以确认框里列的就是真会发生的。
 * 私有 Skill 的名字来自包本身（`_fetchAgentPrivateSkillsBundle` 走缓存，安装时不会再下一遍）；
 * Hub Skill 的显示名取目录元数据，取不到时退回 id，不让预览因此失败。
 */
/**
 * 安装预览里一项依赖的显示名。
 * - `builtin:`：去掉前缀；
 * - 要下载安装（`install`）：本机还没有，只能问目录；
 * - 其它（复用 / 随包 / 被阻断）：技能就在本机，先读本机的名字，读不到再问目录，最后才回退成编号。
 *   此前只有 `install` 会查名字，所以"复用"的技能一律显示成 12 位编号。
 */
export async function planItemDisplayName(
  item: { id: string; kind: string; action: string },
  lookups: { local: (id: string) => Promise<string>; catalog: (id: string) => Promise<string> },
): Promise<string> {
  if (item.kind === 'builtin') return item.id.replace(/^builtin:/, '');
  if (item.action === 'install') return (await lookups.catalog(item.id)) || item.id;
  return (await lookups.local(item.id)) || (await lookups.catalog(item.id)) || item.id;
}

export async function previewAgentInstallPlan(agentId: string, expect: MarketplaceFreshness): Promise<AgentInstallPlanView> {
  if (!agentId) throw new Error('agentId required');
  let agentName: string;
  let minAppVersion: string;
  let skillList: string[];
  let privateIds: Set<string>;
  const packageRow = await _findAgentPackageRow(agentId);
  if (packageRow) {
    // 新格式：优先用目录行里的引用清单（不下载包）；Hub 还没给齐这些字段时才读包
    agentName = typeof packageRow.name === 'string' ? packageRow.name : '';
    minAppVersion = _normalizeMarketplaceMinAppVersion(packageRow) || '';
    const fromCatalog = _skillListFromCatalogRow(packageRow);
    if (fromCatalog) {
      skillList = fromCatalog.skillList;
      privateIds = fromCatalog.bundled;
    } else {
      const pkg = await fetchAgentPackage({ contentId: agentId, version: packageRow.version as string, artifact: packageRow.artifact });
      const rawList = pkg.agentJson.skill_list;
      skillList = Array.isArray(rawList) ? rawList.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0) : [];
      privateIds = agentPrivateSkillIdsFromBundle(pkg.privateSkills);
      agentName = agentName || _agentJsonName(pkg.agentJson);
    }
  } else {
    const detail = await getAgentDetail(agentId, expect);
    agentName = _agentJsonName(detail.agent_json);
    minAppVersion = detail.min_app_version || '';
    const rawList = (detail.agent_json as Record<string, unknown>).skill_list;
    skillList = Array.isArray(rawList)
      ? rawList.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0)
      : [];
    privateIds = agentPrivateSkillIdsFromBundle(
      await _fetchAgentPrivateSkillsBundle(agentId, detail.agent_skills_bundle_url || ''),
    );
  }
  let appUpdateRequired = false;
  try {
    _assertMarketplaceAppCompatible('agent', agentId, agentName, minAppVersion);
  } catch (err) {
    if (err instanceof MarketplaceInstallError && err.appUpdateRequired) appUpdateRequired = true;
    else throw err;
  }
  const plan = planAgentDependencies(
    skillList, privateIds, (id) => _localSkillStateForUser(getActiveUserId(), id),
    (name) => builtinCapabilityAvailable(getActiveUserId(), name, currentAppVersion()),
  );
  // 本机已装技能的名字只读一次（"复用"的技能就在本机，预览里应显示名字而不是编号）。
  let localNames: Map<string, string> | null = null;
  const localName = async (id: string): Promise<string> => {
    if (!localNames) {
      try { localNames = new Map((await listSkillSpecsForUser(getActiveUserId())).map((spec) => [spec.id, spec.name])); }
      catch { localNames = new Map(); }
    }
    return localNames.get(id) || '';
  };
  const catalogName = async (id: string): Promise<string> => {
    try { return (await getSkillMetadata(id))?.name || ''; } catch { return ''; /* 取不到名字不影响预览 */ }
  };
  const items = await Promise.all(plan.items.map(async (item) => ({
    ...item,
    name: await planItemDisplayName(item, { local: localName, catalog: catalogName }),
  })));
  return { items, readiness: agentReadiness(plan), appUpdateRequired, minAppVersion };
}

/**
 * 安装前取 Agent 的**当前**目录行（2026-10-15 缺陷的安装侧一半）。
 *
 * 单独查一次而不是复用 `_findAgentPackageRow`：那个函数的返回值把「已停用」与
 * 「没有可直接下载的包」压成同一个 `null`，安装路径无法据此区分，而这两件事的处置相反——
 * 前者必须阻断，后者要走既有的 detail 兜底。
 *
 * 与 Skill 侧同一口径（`_installMarketplaceSkillLocked`）：停用只拦**新安装**；判据是
 * Hub 这次返回的 `status` / `state` 字符串，**刻意不看**本机 `_install.json` 里的旧状态——
 * 那是上一次检查的快照，用可能过期的状态拦新安装会拦错。恢复后 `status` 回到 `published`，
 * 这里不做任何缓存。
 *
 * 边界：请求失败/换页异常返回 `null`（未知），由调用方继续原有流程并各按既有方式汇报；
 * 只有**明确读到 `disabled`** 才拦。写死方向，免得日后有人把未知当停用。
 */
async function _findAgentCatalogRowForInstall(
  agentId: string,
): Promise<CatalogListRow | null> {
  try {
    for (let page = 1; page <= 20; page++) {
      const r = await postJson<{ list?: unknown[] }>('/marketplace/agents/list', { app_version: currentAppVersion(), page, size: 100, ids: [agentId] });
      const list = Array.isArray(r.list) ? r.list : [];
      for (const raw of list) {
        const row = normalizeCatalogListRow(raw);
        if (!row || row.id !== agentId) continue;
        return row;
      }
      if (list.length < 100) break;
    }
  } catch (err) {
    log.warn('agent catalog lookup failed; disable guard skipped for this attempt', {
      agentId,
      error: String((err as Error)?.message || err),
    });
  }
  return null;
}

async function _installMarketplaceAgentLocked(
  uid: string, agentId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string }> {
  if (!agentId) throw new Error('agentId required');
  let agentName = opts.name || '';
  try {
    // Hub 已停用的 Agent 不新装。渲染层那道（市场卡片/详情的按钮）可以被绕过，这一道不行。
    //
    // **已知且刻意**：这道守卫对这个函数的所有调用方一视同仁，因此 reconcile 的「已有更高
    // 版本就更新」对已停用 Agent 也不会发生——本机停在装好的那一版，Hub 恢复后由下一次
    // 对账补上（版本更新不是新使用，`agent_catalog_update.ts` 也把「停用要不要更」明说为
    // 本机策略）。与挂载顺序无关：这条判断发生在任何下载之前，所以被停用的内容**一个字节
    // 都不会落盘**。Skill 侧的对账走自己的 `_pullSkillLocked`，不受此影响。
    const catalogRow = await _findAgentCatalogRowForInstall(agentId);
    if (catalogRow && isHubContentDisabled(catalogRow)) {
      throw new MarketplaceInstallError(
        'agent', agentId, agentName || (typeof catalogRow.name === 'string' ? catalogRow.name : ''), 'content_disabled',
      );
    }
    // 新格式（`agent-package-v1`）：目录行带 artifact 时走 B-02 取包；否则走原有的 detail + 私有技能地址。
    const packageRow = catalogRow && catalogRow.artifact && catalogRow.artifact.format === AGENT_PACKAGE_FORMAT && catalogRow.artifact.sha256
      ? (catalogRow as CatalogListRow & { artifact: NonNullable<CatalogListRow['artifact']> })
      : await _findAgentPackageRow(agentId);
    let detail: AgentDetail;
    let privateSkillsZip: Awaited<ReturnType<typeof _fetchAgentPrivateSkillsBundle>>;
    let installedPackage: { sha256: string } | null = null;
    if (packageRow) {
      agentName = agentName || (typeof packageRow.name === 'string' ? packageRow.name : '');
      // 要求的客户端版本以目录为准，先于下载检查：不够就不下载。
      _assertMarketplaceAppCompatible('agent', agentId, agentName, _normalizeMarketplaceMinAppVersion(packageRow) || '');
      const pkg = await fetchAgentPackage({ contentId: agentId, version: packageRow.version as string, artifact: packageRow.artifact });
      detail = _agentDetailFromPackage(agentId, packageRow, pkg);
      agentName = agentName || _agentJsonName(detail.agent_json);
      privateSkillsZip = pkg.privateSkills;
      installedPackage = { sha256: packageRow.artifact.sha256 };
    } else {
      detail = await getAgentDetailForUser(uid, agentId, expect);
      agentName = agentName || _agentJsonName(detail.agent_json);
      if (!detail.agent_json_url) {
        // Cache-hit path returns url='' (and create_uid=''); re-fetch via detail endpoint to
        // capture both — needed for manifest + `_install.json` author badge.
        // 同 miss 分支：Hub 要求 content_id + version，旧版只认 id，故两者都带。
        // 版本此时已在 `detail`（缓存命中）里，直接复用。
        const fresh = await postJson<{ agent_json: Record<string, unknown>; version: string; category: string; published_at: number; updated_at?: number; agent_json_url: string; agent_skills_bundle_url?: string; create_uid: string; default_install?: boolean; is_open_source?: boolean; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }>(
          '/marketplace/agents/detail',
          detail.version
            ? { id: agentId, content_id: agentId, version: detail.version }
            : { id: agentId },
        );
        _assertLegacyAgentDetail(agentId, fresh);
        const minAppVersion = _normalizeMarketplaceMinAppVersion(fresh, fresh.agent_json);
        detail = {
          id: agentId, version: fresh.version, category: fresh.category,
          published_at: fresh.published_at, updated_at: fresh.updated_at,
          agent_json: fresh.agent_json, agent_json_url: fresh.agent_json_url || '',
          agent_skills_bundle_url: fresh.agent_skills_bundle_url || '',
          create_uid: fresh.create_uid || '',
          default_install: fresh.default_install === true,
          is_open_source: fresh.is_open_source === true,
          status: fresh.status || fresh.state || '',
          ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
        };
        agentName = agentName || _agentJsonName(detail.agent_json);
      }
      _assertMarketplaceAppCompatible('agent', agentId, agentName, detail.min_app_version || '');

      // 1. Download the private bundle first so ids materialized by that bundle are not
      //    misclassified as standalone marketplace dependencies. `skill_list` doubles as the
      //    runtime allowlist and may contain both private and public skill ids.
      privateSkillsZip = await _fetchAgentPrivateSkillsBundle(agentId, detail.agent_skills_bundle_url || '');
    }
    const privateSkillIds = agentPrivateSkillIdsFromBundle(privateSkillsZip);

    // 2. Install dependent standalone skills FIRST, in parallel. Any failure throws — the agent body
    //    and manifest entry are never touched, so retry is a clean re-run (previously-installed
    //    skills short-circuit via `_skillAlreadyOnDisk`). This is the atomicity guarantee called
    //    out in the file header.
    const skillList = Array.isArray((detail.agent_json as Record<string, unknown>).skill_list)
      ? ((detail.agent_json as Record<string, unknown>).skill_list as unknown[])
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter((x): x is string => x.length > 0)
      : [];
    const depSkillNames = _agentSkillDependencyDisplayNames(detail.agent_json, skillList);
    // 依赖规划（复用/随包/阻断/需安装）见 marketplace_agent_deps.ts；"本机已有时怎么办"是其中
    // 一个可替换的策略函数。阻断项在下载任何东西之前就拒绝，保证失败时本机原有状态不变。
    const depPlan = planAgentDependencies(
      skillList, privateSkillIds, (id) => _localSkillStateForUser(uid, id),
      (name) => builtinCapabilityAvailable(uid, name, currentAppVersion()),
    );
    const firstBlocked = depPlan.blocked[0];
    if (firstBlocked) {
      throw new MarketplaceInstallError(
        'skill', firstBlocked.id, depSkillNames.get(firstBlocked.id) || firstBlocked.id,
        firstBlocked.action === 'blocked_disabled' ? 'status_not_approved:disabled' : 'builtin_unsupported',
      );
    }
    const missingSkillIds = depPlan.toInstall;
    if (missingSkillIds.length > 0) {
      await Promise.all(missingSkillIds.map(async (sid) => {
        let depSkillName = depSkillNames.get(sid) || '';
        try {
          // Metadata comes from the adapter, never from the byte endpoint. `/skills/bundle`
          // returns immutable bytes only once F4 lands, so treating it as a detail endpoint
          // is on its way out regardless of how Q1 is answered (specs/010 FR-001 / FR-002).
          // The adapter already normalized time, `min_app_version` absence and `status`.
          const meta = await getSkillMetadata(sid);
          if (!meta) {
            throw new MarketplaceInstallError('skill', sid, depSkillName || sid, 'content_not_found');
          }
          depSkillName = meta.name || depSkillName;
          _assertApprovedDependencySkill(sid, depSkillName, { status: meta.status });
          await installMarketplaceSkillForUser(uid, sid, {
            version: meta.version,
            published_at: meta.published_at,
            ...(meta.updated_at !== undefined ? { updated_at: meta.updated_at } : {}),
            ...(meta.min_app_version ? { min_app_version: meta.min_app_version } : {}),
          }, { force: opts.force === true, name: depSkillName });
          log.info(`  dep-installed skill ${sid}`);
        } catch (err) {
          throw _wrapMarketplaceInstallError('skill', sid, depSkillName || sid, err);
        }
      }));
    }

    // 3. Quality gate. Reject the install if `detail.agent_json` itself trips
    //    a red flag — content already on the catalog can still be malicious
    //    on a fresh user account, and the validator is the choke point that
    //    catches it before write. EXTREME → abort + persist report; MEDIUM
    //    only persists the report and lets the install proceed.
    const preReport = validateAgentSpec({
      agentJson: detail.agent_json,
      // Installation restores published bytes verbatim. Runner compatibility
      // is enforced while authoring/publishing, not retroactively on install.
      enforceSkillRunner: false,
    });
    await persistQualityReport({
      uid: uid, kind: 'agent', id: agentId, report: preReport,
    });
    // `report.ok === false` means an EXTREME violation, and EXTREME is not
    // user-overridable (see `quality/README.md`) — `force` must not reach it.
    // See `_assertQualityGatePassed` for why force is deliberately ignored here.
    _assertQualityGatePassed('agent', agentId, preReport, opts.acceptSecurityRisk === true);
    // 4. Now materialize the agent: cache content → `<uid>/local/marketplace/agents/<id>/`.
    //    `_install.json` is a version pin read by `marketplace_reconcile.ts::_agentNeedsPull`
    //    on other devices to skip a re-pull when their local copy already matches the manifest's
    //    (version, freshness timestamp).
    const target = userMarketplaceAgentDir(uid, agentId);
    // Park the installed version before writing the new one, so any failure from here on (a
    // rejected private-skill scan, a bad bundle, a write error) puts it back instead of leaving
    // the user without the agent they could use a moment ago. Receipts follow the same rule.
    const replace = await beginAgentReplace(target, agentId);
    const receiptSnapshot = replace.hadPrevious ? snapshotAgentReceipts(uid, agentId) : [];
    try {
      await fsp.mkdir(target, { recursive: true });
      const agentJsonFile = path.join(target, 'agent.json');
      await fsp.writeFile(agentJsonFile, JSON.stringify(detail.agent_json, null, 2), 'utf8');
      if (privateSkillsZip) {
        const privateSkillsDir = userMarketplaceAgentSkillsDir(uid, agentId);
        await fsp.mkdir(privateSkillsDir, { recursive: true });
        extractBundleSafely(privateSkillsZip, privateSkillsDir);
        // 贡献的包里 ownerAgent 是贡献者本机 id；改写成本次安装的 Agent id，私有 Skill 才只对它可见
        await stampPrivateSkillOwners(privateSkillsDir, agentId);
      }
      // 4b. Deep security scan for the agent's private skill bundle. Private
      //     skills bypass the standalone skill install path (and its deep scan),
      //     so they are scanned here, before the success marker (`_install.json`)
      //     is written. Same contract as the skill path: `blocked` / `unknown`
      //     roll the whole agent install back, and the refusal is reported as the
      //     worst verdict seen. `restricted` / `pass` admit.
      //
      //     Receipts for private skills are deliberately NOT written here: their
      //     trust keys need `(agentId, skillId)` disambiguation (a private skill
      //     id can shadow a standalone install), which lands with the private
      //     load-gate work — writing standard-keyed receipts now would verify the
      //     wrong bytes later.
      if (privateSkillsZip) {
        const privateSkillsDir = userMarketplaceAgentSkillsDir(uid, agentId);
        const sourceTier: SkillSource = String(detail.create_uid || '') === '0'
          ? 'official'
          : 'community';
        const entries = await fsp.readdir(privateSkillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillDir = path.join(privateSkillsDir, entry.name);
          const scan = await scanSkillDir(skillDir, sourceTier);
          if (scanVerdictBlocksInstall(scan.outcome)) {
            // Roll back before throwing: a rejected agent leaves nothing on disk,
            // the same rule as the skill path ("formal assets unchanged").
            await fsp.rm(target, { recursive: true, force: true });
            await fsp.rm(privateSkillsDir, { recursive: true, force: true });
            throw _securityInstallError(agentId, agentName || agentId, scan, 'agent');
          }
          // W3: receipt keyed by (agentId, skillId) so the private load gate
          // verifies THIS tree, never a same-named standalone install.
          const privateTreeHash = marketplaceContentTreeHash(skillDir);
          if (privateTreeHash) {
            const privateReport = validateSkillDir(skillDir, { enforceSkillRunner: false });
            const top = topViolationOf(privateReport.violations);
            writeInstallReceipt(
              uid, entry.name, privateTreeHash, scan,
              {
                violationCount: privateReport.violations.length,
                ...(top?.rule ? { topRule: top.rule } : {}),
                ...(top?.level ? { topLevel: top.level } : {}),
              },
              agentId,
              skillDir,
            );
          }
          log.info('agent private skill scanned', {
            agentId, skill: entry.name, outcome: scan.outcome, score: scan.score ?? null,
          });
        }
      }
      // `_install.json` stores everything the in-app UI needs without re-hitting the network:
      // version/freshness timestamp for reconcile; create_uid for the author badge on the
      // agent detail page; `content_sha` for the dev-mode local-edit guard in
      // `marketplace_reconcile._agentNeedsPull` (see that function's header).
      const installContentSha = sha256OfFile(agentJsonFile);
      const installTreeHash = marketplaceContentTreeHash(target);
      const installedAt = Date.now();
      await fsp.writeFile(path.join(target, '_install.json'),
        JSON.stringify({
          version: detail.version,
          published_at: detail.published_at,
          ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : {}),
          agent_json_url: detail.agent_json_url,
          agent_skills_bundle_url: detail.agent_skills_bundle_url || '',
          installed_at: installedAt,
          create_uid: detail.create_uid || '',
          ...(typeof detail.default_install === 'boolean' ? { default_install: detail.default_install } : {}),
          ...(typeof detail.is_open_source === 'boolean' ? { is_open_source: detail.is_open_source } : {}),
          ...(detail.status ? { status: detail.status } : {}),
          ...(detail.min_app_version ? { min_app_version: detail.min_app_version } : {}),
          ...(installContentSha ? { content_sha: installContentSha } : {}),
          ...(installTreeHash ? { content_tree_hash: installTreeHash } : {}),
          ...(installedPackage ? { package_format: AGENT_PACKAGE_FORMAT, artifact_sha256: installedPackage.sha256 } : {}),
        }, null, 2), 'utf8');
      await touchCacheEntryForUser(uid, 'agent', agentId);

      // 4. Record in the cloud-synced manifest so other devices reconcile this install.
      await addAgentInstall(uid, {
        id: agentId, version: detail.version, published_at: detail.published_at,
        ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : {}),
        agent_json_url: detail.agent_json_url, create_uid: detail.create_uid || '',
        agent_skills_bundle_url: detail.agent_skills_bundle_url || '',
        installed_at: installedAt,
        ...(typeof detail.default_install === 'boolean' ? { default_install: detail.default_install } : {}),
        ...(detail.status ? { status: detail.status } : {}),
        min_app_version: detail.min_app_version || '',
        ...(installedPackage ? { package_format: AGENT_PACKAGE_FORMAT, artifact_sha256: installedPackage.sha256 } : {}),
      });
      invalidateCoreAgentSkills();
      log.info('installed marketplace agent', { agentId, version: detail.version, target: logPathRef(target) });
      await replace.commit();
      clearAgentUpdateFailure(uid, agentId);
    } catch (replaceErr) {
      await replace.rollback().catch((rollbackErr) => log.warn('agent replace rollback failed', { agentId, error: String(rollbackErr) }));
      if (replace.hadPrevious) restoreAgentReceipts(uid, agentId, receiptSnapshot);
      invalidateCoreAgentSkills();
      throw replaceErr;
    }

    return { ok: true, id: agentId };
  } catch (err) {
    throw _wrapMarketplaceInstallError('agent', agentId, agentName, err);
  }
}

export async function installMarketplaceSkill(
  skillId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string }> {
  return installMarketplaceSkillForUser(getActiveUserId(), skillId, expect, opts);
}

export async function installMarketplaceSkillForUser(
  userId: string, skillId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string }> {
  if (!skillId) throw new Error('skillId required');
  return withMarketplaceInstallLock(
    userId,
    'skill',
    skillId,
    () => _installMarketplaceSkillLocked(userId, skillId, expect, opts),
  );
}

async function _installMarketplaceSkillLocked(
  uid: string, skillId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string; securityScan?: SentryScanResult }> {
  if (!skillId) throw new Error('skillId required');
  let skillName = opts.name || '';
  try {
    // An install must not trust a stale renderer row or the six-hour metadata index.
    invalidateMetadataIndex();
    const meta = await getSkillMetadata(skillId);
    if (!meta) throw new MarketplaceError('CONTENT_NOT_FOUND', `CONTENT_NOT_FOUND: ${skillId}`);
    await observeHubSkillStatusLocked(uid, skillId, meta);
    if (isHubContentDisabled(meta) || (!hubContentStatus(meta) && readContentStatus(uid, skillId).availability === 'disabled')) {
      throw new MarketplaceInstallError('skill', skillId, meta.name || skillName, 'content_disabled');
    }
    const detail = await materializeSkillDetail(uid, skillId, meta);
    skillName = skillName || detail.name || '';
    _assertMarketplaceAppCompatible('skill', skillId, skillName, detail.min_app_version || '');

    // ── FR-060：重新安装官方版时，若与本机某个自定义 Skill（典型是派生副本）同名，
    //    **先提示为派生副本改名**，而不是装出两条同名内容。
    //
    //    只在 `force: true`（用户显式点「重新安装官方版」）时判定：自动撒种与周期更新
    //    路径不受影响——否则一次同名就会让默认内容再也装不进来。
    //
    //    判据是**显示名称**：安装目录名是 `content_id`，`skills.ts` 的 id 级同名把关
    //    结构上看不到这组冲突。**不读 `forked_from`**——它在迭代一只写不读（FR-057）。
    if (opts.force === true && skillName) {
      const fork = await import('./marketplace/fork-to-custom');
      await fork.assertOfficialReinstallNameIsFree(skillName);
    }

    const cacheDir = getSkillCacheDirForUser(uid, skillId);
    const target = userMarketplaceSkillDir(uid, skillId);

    // ── FR-022 / PRD §7.4：本机已存在同 ID 内容（如随包种子）时，安装按 §7.5 的
    //    版本规则处理，**不产生第二份**。既有 promote 的 trash-swap 已保证「不产生第二份」；
    //    这里补的是「单调更新」——等于或低于本机版本时不替换内容。
    //
    //    复用既有 `decideMarketplaceContentUpdate`，**不另写一套版本比较**：它已经处理了
    //    「语义等价但拼写不同」（`v1.0.4` 对 `1.0.4`）落到新鲜度比较的分支。
    //
    //    `force: true`（「重新安装官方版」）仍然替换——那是用户的显式意图，不受单调规则约束。
    //
    //    ⚠️ 本机版本取自 `installed-version.ts` 这一**单一判定入口**（FR-019/FR-020）：
    //    读的是已成功原子落盘的本地事实，**不是**安装清单里的目标版本。
    const localFact = readInstalledVersion(uid, skillId);
    const wasInstalledBefore = localFact.version !== null;
    if (localFact.version && opts.force !== true) {
      const decision = decideMarketplaceContentUpdate(
        {
          version: localFact.version,
          published_at: localFact.publishedAt ?? 0,
          ...(typeof localFact.updatedAt === 'number' ? { updated_at: localFact.updatedAt } : {}),
        },
        {
          version: detail.version,
          published_at: detail.published_at,
          ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : {}),
        },
        // Hub 来源：不咨询新鲜度（Q4 内部默认值，见 `shouldConsultFreshness`）。
        'hub',
      );
      if (decision.action === 'preserve_content') {
        log.info('install kept the local copy per the monotonic version rule', {
          skillId, local: localFact.version, incoming: detail.version, reason: decision.reason,
        });
        return { ok: true, id: skillId };
      }
    }

    // ── Q2（发布侧同 ID 冲突拦截）的**单一兜底插入点** ─────────────────────────
    // Q2 归 Hub，**未收口**。内部默认值按「发布侧已拦截」实现，因此此处不做额外阻断。
    // 若 Q2 答案为「未拦截」，兜底逻辑**只加在这一处**（例如同 ID 且来源非 Hub 时拒绝安装
    // 或显著告警），不得散落到 promote、对账或撒种路径——否则来源判定会扩散。
    // 依据：specs/010 FR-049、`research.md` R-08。**当前为实现假设，不是 Hub 的答复。**
    // Quarantine (W2): materialize into a dot-prefixed staging dir beside the
    // final location, gate it there, and only `rename` it into place on pass.
    // The previous flow wrote to the final path and `rm -rf`'d on refusal — a
    // process killed in that window left the unverified content installed.
    //
    // Staging sits under the same marketplace skills root so `rename` never
    // crosses filesystems. The dot prefix keeps every enumeration path
    // (loader, listings, tree hash) from seeing a half-installed skill, and
    // the name deliberately avoids the context-demotion words (`test`,
    // `vendor`, ...) so a future absolute-path classifier cannot silently
    // demote the whole scan — locked by a test in marketplace.test.ts.
    const skillsRoot = userMarketplaceSkillsDir(uid);
    const staging = path.join(skillsRoot, quarantineStagingName(randomBytes(6).toString('hex')));
    const installedAt = Date.now();
    await fsp.mkdir(staging, { recursive: true });
    let admittedScan: SentryScanResult | undefined;
    try {
      await withMarketplaceCacheLock(uid, 'skill', skillId, async () => {
        await _copyDirSkippingCacheMeta(cacheDir, staging);
      });

      // Quality gate on the staged tree (rule scope = SKILL.md + scripts/*).
      // EXTREME violations → remove staging + persist the failed report +
      // throw. MEDIUM passes through but the report is persisted so the UI
      // advisory chip shows. The final location is never touched.
      const skillReport = validateSkillDir(staging, {
        // Installation restores published bytes verbatim. Runner compatibility
        // is enforced while authoring/publishing, not retroactively on install.
        enforceSkillRunner: false,
      });
      await persistQualityReport({
        uid, kind: 'skill', id: skillId, report: skillReport,
      });
      if (!skillReport.ok) {
        await fsp.rm(staging, { recursive: true, force: true });
        _assertQualityGatePassed('skill', skillId, skillReport, opts.acceptSecurityRisk === true);
      }

      const skillContentSha = sha256OfFile(path.join(staging, 'SKILL.md'));
      const skillTreeHash = marketplaceContentTreeHash(staging);

      // Deep security scan (skill-sentry + our EXTREME red lines). Runs after the
      // structural gate above because a skill that fails structurally is already
      // rolled back; this one decides whether structurally-valid content is safe.
      //
      // Source tier drives the threshold: platform-published skills
      // (`create_uid === '0'`) are only rejected on an outright DO_NOT_INSTALL,
      // while community uploads are also held back at CAUTION. Unknown
      // provenance falls to the stricter tier, never the looser one.
      const sourceTier: SkillSource = String(detail.create_uid || '') === '0'
        ? 'official'
        : 'community';
      const scan = await scanSkillDir(staging, sourceTier);
      // An informed user may accept a refusal the gate is willing to have waived —
      // currently only a scanner outage, never a red line. Checked through
      // `scanVerdictAllowsOverride` rather than trusting the flag, so consent
      // cannot be asserted for something that was never overridable.
      const decision = resolveInstallDecision(scan, opts.acceptSecurityRisk === true);
      const overridden = decision.overridden;
      if (overridden) {
        log.warn('install proceeding on user security override', {
          skillId, outcome: scan.outcome,
        });
      }
      if (!decision.allowed) {
        // Remove staging before throwing so a rejected skill leaves nothing on
        // disk — the spec requires "formal assets unchanged" after a
        // high-risk block. The final location was never touched.
        //
        // `unknown` rolls back too (fail closed, spec §6.2: a new executable
        // asset whose check could not run is not installed), but is flagged
        // separately on the error so the UI can say "check unavailable" rather
        // than "malicious" — conflating the two would train users to dismiss
        // real blocks.
        await fsp.rm(staging, { recursive: true, force: true });
        throw _securityInstallError(skillId, skillName, scan);
      }

      admittedScan = scan;
      // Promote: swap the verified tree into the final location. An existing
      // install moves to a dot-prefixed trash first, so `rename` onto a
      // non-empty directory cannot silently nest the new tree inside the old.
      // The name carries the content id so boot-time recovery can put it back if the process
      // dies before the second rename (发现 15).
      const trash = path.join(skillsRoot, quarantineTrashName(skillId, randomBytes(6).toString('hex')));
      if (fs.existsSync(target)) await fsp.rename(target, trash);
      await fsp.rename(staging, target);
      await fsp.rm(trash, { recursive: true, force: true });

      // Bind this verdict to the exact bytes and ruleset that produced it, so a
      // later edit or a ruleset upgrade makes the verdict provably stale instead
      // of silently standing forever. Reuses the report above rather than
      // rescanning: the receipt must record the verdict that actually gated the
      // install, not a second opinion.
      if (skillTreeHash) {
        // Top finding computed by severity, not by position: the validator
        // returns violations in scan order, so `violations[0]` is only
        // incidentally the most severe one.
        const top = topViolationOf(skillReport.violations);
        // Shared with the custom-import path so the two cannot drift; it swallows
        // its own failures, since a receipt is an audit aid and not part of the
        // gate the install already passed.
        writeInstallReceipt(
          uid, skillId, skillTreeHash,
          // The override rides on the scan so the receipt records what was waived,
          // not merely that something was.
          overridden
            ? { ...scan, userOverride: { outcome: scan.outcome, at: Date.now() } }
            : scan,
          {
            violationCount: skillReport.violations.length,
            ...(top?.rule ? { topRule: top.rule } : {}),
            ...(top?.level ? { topLevel: top.level } : {}),
          },
          undefined,
          target,
        );
      }
      await fsp.writeFile(path.join(target, '_install.json'),
        JSON.stringify({
          version: detail.version,
          published_at: detail.published_at,
          ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : {}),
          // Hub 内容不再有对象存储地址；保留字段形状但恒为空，版本身份见 artifact_*。
          bundle_url: '',
          ...(detail.artifact?.sha256 ? { artifact_sha256: detail.artifact.sha256 } : {}),
          ...(typeof detail.artifact?.size_bytes === 'number'
            ? { artifact_size_bytes: detail.artifact.size_bytes } : {}),
          installed_at: installedAt,
          create_uid: detail.create_uid || '',
          ...(typeof detail.default_install === 'boolean' ? { default_install: detail.default_install } : {}),
          ...(typeof detail.is_open_source === 'boolean' ? { is_open_source: detail.is_open_source } : {}),
          ...(detail.status ? { status: detail.status } : {}),
          ...(detail.min_app_version ? { min_app_version: detail.min_app_version } : {}),
          ...(skillContentSha ? { content_sha: skillContentSha } : {}),
          ...(skillTreeHash ? { content_tree_hash: skillTreeHash } : {}),
        }, null, 2), 'utf8');
      // T035：安装成功后写一份不可变版本副本。写在 success marker 之后，所以副本只在
      // 内容确实落盘之后才出现；写副本失败不回滚安装——副本是钉固用的冗余，不是安装的前提。
      if (detail.artifact?.sha256) {
        try {
          await writeVersionCopy(uid, {
            contentId: skillId,
            version: detail.version,
            sha256: detail.artifact.sha256,
            sizeBytes: detail.artifact.size_bytes,
          }, target);
        } catch (err) {
          log.warn('immutable version copy not written; install itself is unaffected', {
            skillId, version: detail.version, error: (err as Error).message,
          });
        }
      }
      await touchCacheEntryForUser(uid, 'skill', skillId);
      invalidateCoreAgentSkills();
    } catch (err) {
      // Safety net: a refusal, an engine crash, or a killed process between
      // materialize and promote must never leave the unverified tree on disk.
      // Idempotent — the refusal paths above may already have removed it, and
      // after promotion the staging path no longer exists.
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    await addSkillInstall(uid, {
      id: skillId, version: detail.version, published_at: detail.published_at,
      ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : {}),
      bundle_url: detail.bundle_url, create_uid: detail.create_uid || '',
      installed_at: installedAt,
      ...(typeof detail.default_install === 'boolean' ? { default_install: detail.default_install } : {}),
      ...(detail.status ? { status: detail.status } : {}),
      min_app_version: detail.min_app_version || '',
    });
    log.info('installed marketplace skill', { skillId, version: detail.version, target: logPathRef(target) });
    if (!wasInstalledBefore) {
      // 安装成功才计一次；更新/保留本机副本不产生事件。不等待网络，失败也不影响安装。
      void recordSkillActivated(uid, skillId, detail.version);
    }
    // W5: a restricted (Medium) verdict rides on the success response so the
    // renderer can show ONE quiet notice. No new dialog — the install succeeded,
    // and the risk card already lives on the skill's security panel.
    return { ok: true, id: skillId, ...(admittedScan?.outcome === 'restricted' ? { securityScan: admittedScan } : {}) };
  } catch (err) {
    throw _wrapMarketplaceInstallError('skill', skillId, skillName, err);
  }
}

/** Check if a skill is already present in any local source — either as a custom skill under
 *  `<uid>/cloud/skills/<id>/` OR a marketplace install under `<uid>/local/marketplace/skills/<id>/`.
 *  Both are valid; cascade install only triggers when missing. */
/** 规划用的本机状态：有没有、是否被 Hub 停用（只读本机记录，不联网）。 */
function _localSkillStateForUser(userId: string, skillId: string): LocalSkillState {
  const present = _skillAlreadyOnDiskForUser(userId, skillId);
  if (!present) return { present: false, disabled: false };
  let disabled = false;
  try { disabled = readContentStatus(userId, skillId).availability === 'disabled'; } catch { /* 取不到状态：按未停用 */ }
  return { present: true, disabled };
}

function _skillAlreadyOnDisk(skillId: string): boolean {
  try { return _skillAlreadyOnDiskForUser(getActiveUserId(), skillId); }
  catch { return false; }
}

function _skillAlreadyOnDiskForUser(uid: string, skillId: string): boolean {
  try {
    const customRoot = userSkillsDir(uid);
    if (fs.existsSync(path.join(customRoot, skillId, 'SKILL.md'))) return true;
    const installedDir = userMarketplaceSkillDir(uid, skillId);
    if (fs.existsSync(path.join(installedDir, 'SKILL.md'))) return true;
  } catch { /* malformed or unavailable user root */ }
  return false;
}

/** Build a single-line error message for a quality-rejected install. The
 *  full report is already persisted under `<uid>/local/quality_reports/`;
 *  the renderer reads it via the `quality.readReport` IPC to display the
 *  detailed violation list. The throw here is just the propagation path. */
function _qualityInstallError(
  kind: 'agent' | 'skill', id: string, report: QualityReport,
): Error {
  const blockingViolations = report.violations.filter((v) => v.level === 'EXTREME');
  const top = blockingViolations[0];
  const reason = top ? `${top.rule}: ${top.suggested_fix}` : 'validation failed';
  const e = new Error(`Quality validation rejected ${kind} ${id} (${reason})`);
  (e as { qualityKind?: string }).qualityKind = kind;
  (e as { qualityId?: string }).qualityId = id;
  // Rule ids drive the plain-language risk list in the confirm dialog, so the
  // user is told what was found rather than only that something was.
  (e as { qualityRuleIds?: string[] }).qualityRuleIds =
    [...new Set(blockingViolations.map((v) => v.rule).filter(Boolean))];
  (e as { qualityOverridable?: boolean }).qualityOverridable = true;
  (e as { qualityReport?: QualityReport }).qualityReport = {
    ...report,
    ok: false,
    violations: blockingViolations,
  };
  return e;
}

/**
 * Throw if the validator found an EXTREME violation.
 *
 * Deliberately takes no `force` parameter. `ValidationReport.ok === false`
 * means "at least one EXTREME violation", and EXTREME is defined as
 * non-overridable in `quality/README.md`:
 *
 *   > There is intentionally NO override for EXTREME. If a real use case
 *   > triggers a red flag, restructure the spec to remove the pattern.
 *
 * The install `force` flag remains meaningful for everything else it gates
 * (dependency-install propagation, MEDIUM advisories that never blocked in
 * the first place) — it just cannot buy past a red flag. Previously
 * `opts.force === true` skipped this check, so the renderer's "Install
 * anyway" button could install content the validator had rejected as
 * explicitly malicious. Keep this as a single chokepoint so the invariant
 * is enforced in one place rather than re-derived at each call site.
 */
function _assertQualityGatePassed(
  kind: 'agent' | 'skill', id: string, report: QualityReport,
  acceptRedFlagRisk = false,
): void {
  if (report.ok) return;
  // An informed user may proceed. This reverses the previous absolute rule; see
  // `quality/README.md` for why, and for what the earlier rule was protecting
  // against. The consent must be explicit and per-install — it is never implied
  // by `force`, which ordinary retry paths set for unrelated reasons.
  if (acceptRedFlagRisk) {
    log.warn('install proceeding on user red-flag override', {
      kind, id, rules: report.violations.filter((v) => v.level === 'EXTREME').map((v) => v.rule),
    });
    return;
  }
  throw _qualityInstallError(kind, id, report);
}

async function _copyDirSkippingCacheMeta(src: string, dst: string): Promise<void> {
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '_cache.json') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await fsp.mkdir(d, { recursive: true });
      await _copyDirSkippingCacheMeta(s, d);
    } else if (e.isFile()) {
      await fsp.copyFile(s, d);
    }
  }
}

async function _seedAgentSkillDependencies(
  uid: string,
  agentId: string,
  installedSkills: Set<string>,
  deletedSkills: Set<string>,
  shouldContinue: () => boolean = () => true,
  version?: string,
): Promise<{ seeded: number; blocked: boolean }> {
  if (!shouldContinue()) return { seeded: 0, blocked: true };
  // Hub 的 `agents/detail` 要求 content_id + version（B-05）；旧版只认 id，故两者都带。
  // 调用方通常已有目录行/安装记录的版本，缺省时再从目录行取一次。
  const detailVersion = typeof version === 'string' && version.trim()
    ? version.trim()
    : ((await _findAgentCatalogRowForInstall(agentId))?.version ?? '');
  const detail = await postJson<{
    agent_json: Record<string, unknown>;
    agent_skills_bundle_url?: string;
  }>(
    '/marketplace/agents/detail',
    detailVersion ? { id: agentId, content_id: agentId, version: detailVersion } : { id: agentId },
  );
  if (!shouldContinue()) return { seeded: 0, blocked: true };
  const privateSkillsZip = await _fetchAgentPrivateSkillsBundle(
    agentId,
    detail.agent_skills_bundle_url || '',
  );
  if (!shouldContinue()) return { seeded: 0, blocked: true };
  const privateSkillIds = agentPrivateSkillIdsFromBundle(privateSkillsZip);
  const skillList = Array.isArray(detail.agent_json?.skill_list)
    ? (detail.agent_json.skill_list as unknown[])
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter((x): x is string => x.length > 0 && !privateSkillIds.has(x))
    : [];
  let seeded = 0;
  for (const sid of skillList) {
    if (!shouldContinue()) return { seeded, blocked: true };
    if (installedSkills.has(sid)) continue;
    if (deletedSkills.has(sid)) {
      log.info(`skip default agent ${agentId}; dependency skill ${sid} was previously uninstalled`);
      return { seeded, blocked: true };
    }
    try {
      const meta = await getSkillMetadata(sid);
      if (!meta) throw new MarketplaceError('CONTENT_NOT_FOUND', `CONTENT_NOT_FOUND: ${sid}`);
      _assertApprovedDependencySkill(sid, meta.name || sid, { status: meta.status });
      const minAppVersion = meta.min_app_version;
      if (!_isMarketplaceAppCompatible(minAppVersion)) {
        throw new Error(`requires CogSeed >= ${minAppVersion}; current ${currentAppVersion() || 'unknown'}`);
      }
      if (!shouldContinue()) return { seeded, blocked: true };
      await addSkillInstall(uid, {
        id: sid,
        version: meta.version || '1.0.0',
        published_at: meta.published_at || 0,
        ...(typeof meta.updated_at === 'number' ? { updated_at: meta.updated_at } : {}),
        // 种子行不再携带对象存储地址；内容由对账阶段按 {content_id, version} 取字节。
        bundle_url: '',
        create_uid: meta.create_uid,
        ...(meta.status ? { status: meta.status } : {}),
        default_install: meta.default_install,
        ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
      });
      seeded++;
      installedSkills.add(sid);
    } catch (err) {
      log.warn(`skip default agent ${agentId}; dependency skill ${sid} seed failed: ${(err as Error).message}`);
      return { seeded, blocked: true };
    }
  }
  return { seeded, blocked: false };
}

// ── default install seed (fresh launch + incremental additions) ───────────
// Goal: users see a curated baseline of official agents / skills without lifting a finger.
// The server `POST /marketplace/defaults` returns the current recommended set (rows with
// `default_install=1`); we add a manifest row per missing item and let the standard
// `marketplace_reconcile` pass fetch the actual content at boot. Default agents mirror the
// manual install path's dependency rule: read `agent_json.skill_list`, exclude skills supplied by
// the agent-private bundle, and seed the remaining missing skills first, so the reconciled agent
// never lands without its required skills.
//
// This is intentionally incremental, not one-shot: if the team marks a new marketplace item
// as default later, existing users who have never installed/uninstalled that id should get it
// on their next boot. User intent still wins: uninstall records a tombstone in
// `installs.json::_deleted_at`, and tombstoned ids are never re-seeded automatically. If a
// default agent depends on a tombstoned skill, the agent is skipped too rather than installed
// in a broken state.
//
// The marker file records the last observed default id set for diagnostics and crash recovery.
// It is written only AFTER every eligible row is persisted. If the process crashes mid-loop,
// `add*Install` upserts make the next boot safe to retry.
export type DefaultInstallsSeedResult = {
  seeded_agents: number;
  seeded_skills: number;
  skipped?: boolean;
  failed?: boolean;
  error?: string;
  /** Hub 明确回答"不提供默认安装推荐"（`NOT_SUPPORTED`）：不是失败，也不重试。 */
  unsupported?: boolean;
};

/** Hub 对未实现的旧接口回 `NOT_SUPPORTED`（其文案本身建议"按 404 做有依据的降级"）。 */
export function isMarketplaceEndpointUnsupported(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { hubErrorCode?: unknown }).hubErrorCode === 'NOT_SUPPORTED';
}

interface DefaultInstallMarker {
  seeded_at?: number;
  checked_at?: number;
  version?: number;
  agent_ids?: unknown;
  skill_ids?: unknown;
}

function _stringIdSet(ids: unknown): Set<string> {
  return new Set((Array.isArray(ids) ? ids : [])
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0));
}

async function _readDefaultInstallMarker(uid: string): Promise<DefaultInstallMarker | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(marketplaceDefaultsSeededFile(uid), 'utf8')) as DefaultInstallMarker;
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function _markerRecentlyChecked(marker: DefaultInstallMarker | null, minIntervalMs: number, now = Date.now()): boolean {
  if (!marker || minIntervalMs <= 0) return false;
  const checkedAt = Number(marker.checked_at || marker.seeded_at || 0);
  return checkedAt > 0 && now - checkedAt < minIntervalMs;
}

function _hasLocalMarketplaceAgent(uid: string, id: string): boolean {
  return fs.existsSync(path.join(userMarketplaceAgentDir(uid, id), 'agent.json'));
}

function _hasLocalMarketplaceSkill(uid: string, id: string): boolean {
  return fs.existsSync(path.join(userMarketplaceSkillDir(uid, id), 'SKILL.md'));
}

function _hasAnyLocalMarketplaceInstall(uid: string): boolean {
  const hasEntries = (dir: string): boolean => {
    try { return fs.readdirSync(dir).some((name) => !!name && !name.startsWith('.')); }
    catch { return false; }
  };
  return hasEntries(userMarketplaceAgentsDir(uid)) || hasEntries(userMarketplaceSkillsDir(uid));
}

export async function hasKnownDefaultInstallWork(uid: string): Promise<boolean> {
  if (!uid || isAnonymousLocalId(uid)) return false;
  try {
    const manifest = await readInstalls(uid);
    const installedAgents = new Set(manifest.agents.map((a) => a.id));
    const installedSkills = new Set(manifest.skills.map((s) => s.id));
    const deletedAgents = new Set(Object.keys(manifest._deleted_at?.agents || {}));
    const deletedSkills = new Set(Object.keys(manifest._deleted_at?.skills || {}));

    const marker = await _readDefaultInstallMarker(uid);

    if (marker) {
      for (const id of _stringIdSet(marker.agent_ids)) {
        if (deletedAgents.has(id)) continue;
        if (!installedAgents.has(id) || !_hasLocalMarketplaceAgent(uid, id)) return true;
      }
      for (const id of _stringIdSet(marker.skill_ids)) {
        if (deletedSkills.has(id)) continue;
        if (!installedSkills.has(id) || !_hasLocalMarketplaceSkill(uid, id)) return true;
      }
      return false;
    }

    const defaultAgents = manifest.agents.filter((a) => a.default_install === true);
    const defaultSkills = manifest.skills.filter((s) => s.default_install === true);
    if (defaultAgents.some((a) => !_hasLocalMarketplaceAgent(uid, a.id))) return true;
    if (defaultSkills.some((s) => !_hasLocalMarketplaceSkill(uid, s.id))) return true;

    // Fresh logged-in account: no marker, no manifest rows, no local marketplace installs.
    // Existing installs without an old marker should not flash the default-install banner.
    return manifest.agents.length === 0
      && manifest.skills.length === 0
      && !_hasAnyLocalMarketplaceInstall(uid);
  } catch {
    return false;
  }
}

/**
 * Whether a marketplace default-install failure is worth retrying.
 *
 * Default installs previously retried every failure on a fixed
 * `[3s, 3s, 3s]` schedule, including permanent client errors — a `403` from
 * the server burned ~9s of pointless requests and dozens of log lines on
 * every launch. Classify by HTTP status instead:
 *
 *   408 / 429  → transient by definition, retry
 *   5xx        → server-side, retry
 *   other 4xx  → permanent (auth/forbidden/not-found), stop
 *   no status  → unknown (network/DNS/TLS), retry as before
 */
export function isRetryableMarketplaceError(message: string): boolean {
  const status = /\b(\d{3})\b/.exec(String(message || ''))?.[1];
  if (!status) return true;
  const code = Number(status);
  if (code === 408 || code === 429) return true;
  if (code >= 500) return true;
  if (code >= 400) return false;
  return true;
}

export async function ensureDefaultInstalls(
  uid: string,
  opts: { shouldContinue?: () => boolean; minIntervalMs?: number; force?: boolean } = {},
): Promise<DefaultInstallsSeedResult> {
  const canContinue = (): boolean => !isAnonymousLocalId(uid) && (opts.shouldContinue ? opts.shouldContinue() : true);
  if (!canContinue()) {
    log.info('skip default installs seed: login required');
    return { seeded_agents: 0, seeded_skills: 0 };
  }
  const markerFile = marketplaceDefaultsSeededFile(uid);
  try {
    const minIntervalMs = Number.isFinite(opts.minIntervalMs) ? Math.max(0, Number(opts.minIntervalMs)) : 0;
    const marker = await _readDefaultInstallMarker(uid);
    if (!opts.force && _markerRecentlyChecked(marker, minIntervalMs) && !(await hasKnownDefaultInstallWork(uid))) {
      log.info('skip default installs seed: checked recently');
      return { seeded_agents: 0, seeded_skills: 0, skipped: true };
    }
    const data = await postJson<{
      agents: { id: string; version: string; published_at: number; updated_at?: number; agent_json_url: string; agent_skills_bundle_url?: string; create_uid?: string; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }[];
      skills: { id: string; version: string; published_at: number; updated_at?: number; bundle_url: string; create_uid?: string; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }[];
    }>('/marketplace/defaults', {});
    if (!canContinue()) return { seeded_agents: 0, seeded_skills: 0 };
    const manifest = await readInstalls(uid);
    const installedAgents = new Set(manifest.agents.map((a) => a.id));
    const installedSkills = new Set(manifest.skills.map((s) => s.id));
    const deletedAgents = new Set(Object.keys(manifest._deleted_at?.agents || {}));
    const deletedSkills = new Set(Object.keys(manifest._deleted_at?.skills || {}));
    let seededAgents = 0;
    let seededSkills = 0;
    for (const a of data.agents || []) {
      if (!canContinue()) return { seeded_agents: seededAgents, seeded_skills: seededSkills };
      if (!a || !a.id) continue;
      if (deletedAgents.has(a.id)) continue;
      try {
        const minAppVersion = _normalizeMarketplaceMinAppVersion(a);
        if (!_isMarketplaceAppCompatible(minAppVersion)) {
          log.info(`skip default agent ${a.id}; requires CogSeed >= ${minAppVersion}`);
          continue;
        }
        if (!a.agent_json_url) {
          // 新格式（`agent-package-v1`）：Hub 的 `defaults` 不给 URL、`agents/detail` 也不出
          // `agent_json`，只写一条空 URL 的种子行永远落不了地（Hub 待改清单 §5）。
          // 这里直接走完整安装：依赖、私有技能、安全扫描与用户手动安装同一条路径。
          if (installedAgents.has(a.id)) continue; // 已有行：内容缺失时由对账补装
          const row = await _findAgentCatalogRowForInstall(a.id);
          const refs = row ? _skillListFromCatalogRow(row) : null;
          const removedDep = refs?.skillList.find((sid) => deletedSkills.has(sid));
          if (removedDep) {
            log.info(`skip default agent ${a.id}; dependency skill ${removedDep} was previously uninstalled`);
            continue;
          }
          if (!canContinue()) return { seeded_agents: seededAgents, seeded_skills: seededSkills };
          await installMarketplaceAgentForUser(uid, a.id, {
            version: a.version || '1.0.0', published_at: a.published_at || 0,
            ...(typeof a.updated_at === 'number' ? { updated_at: a.updated_at } : {}),
            ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
          });
          seededAgents++;
          installedAgents.add(a.id);
          continue;
        }
        const depSeed = await _seedAgentSkillDependencies(
          uid, a.id, installedSkills, deletedSkills, canContinue,
          typeof a.version === 'string' ? a.version : undefined,
        );
        if (!canContinue()) return { seeded_agents: seededAgents, seeded_skills: seededSkills };
        seededSkills += depSeed.seeded;
        if (installedAgents.has(a.id) || depSeed.blocked) continue;
        await addAgentInstall(uid, {
          id: a.id, version: a.version || '1.0.0',
          published_at: a.published_at || 0,
          ...(typeof a.updated_at === 'number' ? { updated_at: a.updated_at } : {}),
          agent_json_url: a.agent_json_url || '',
          agent_skills_bundle_url: a.agent_skills_bundle_url || '',
          create_uid: a.create_uid || '',
          ...((a.status || a.state) ? { status: a.status || a.state } : {}),
          default_install: true,
          ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
        });
        seededAgents++;
        installedAgents.add(a.id);
      } catch (err) {
        log.warn(`skip default agent ${a.id}; seed failed: ${(err as Error).message}`);
      }
    }
    for (const s of data.skills || []) {
      if (!canContinue()) return { seeded_agents: seededAgents, seeded_skills: seededSkills };
      if (!s || !s.id) continue;
      if (installedSkills.has(s.id) || deletedSkills.has(s.id) || isHubContentDisabled(s)) continue;
      try {
        const minAppVersion = _normalizeMarketplaceMinAppVersion(s);
        if (!_isMarketplaceAppCompatible(minAppVersion)) {
          log.info(`skip default skill ${s.id}; requires CogSeed >= ${minAppVersion}`);
          continue;
        }
        await addSkillInstall(uid, {
          id: s.id, version: s.version || '1.0.0',
          published_at: s.published_at || 0,
          ...(typeof s.updated_at === 'number' ? { updated_at: s.updated_at } : {}),
          bundle_url: s.bundle_url || '',
          create_uid: s.create_uid || '',
          ...((s.status || s.state) ? { status: s.status || s.state } : {}),
          default_install: true,
          ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
        });
        seededSkills++;
        installedSkills.add(s.id);
      } catch (err) {
        log.warn(`skip default skill ${s.id}; seed failed: ${(err as Error).message}`);
      }
    }
    // Marker is written LAST so any crash above leaves a partially-seeded manifest + stale/no
    // marker → next launch retries the whole loop, and add*Install upserts rows already there.
    // Failure here (rare disk issue) likewise → retry next launch.
    if (!canContinue()) return { seeded_agents: seededAgents, seeded_skills: seededSkills };
    await fsp.mkdir(userMarketplaceDirCloud(uid), { recursive: true });
    await fsp.writeFile(markerFile, JSON.stringify({
      seeded_at: Date.now(),
      checked_at: Date.now(),
      version: 1,
      agent_ids: (data.agents || [])
        .filter((a) => _isMarketplaceAppCompatible(_normalizeMarketplaceMinAppVersion(a)))
        .map((a) => a.id),
      skill_ids: (data.skills || [])
        .filter((s) => _isMarketplaceAppCompatible(_normalizeMarketplaceMinAppVersion(s)))
        .map((s) => s.id),
    }, null, 2), 'utf8');
    log.info(`seeded default installs: ${seededAgents} agent(s) + ${seededSkills} skill(s)`);
    return { seeded_agents: seededAgents, seeded_skills: seededSkills };
  } catch (err) {
    // Stale/no marker → next launch retries. Manifest may be partially populated; that's fine
    // because `reconcileInstalls` will pick up rows that are there and the next ensure pass
    // will finish the rest.
    if (!canContinue()) return { seeded_agents: 0, seeded_skills: 0 };
    const message = (err as Error).message;
    if (isMarketplaceEndpointUnsupported(err)) {
      // 这个 Hub 没有"官方默认安装推荐"：属于预期降级，用户看不出区别，不写警告也不重试。
      log.info('default installs not offered by this Hub (NOT_SUPPORTED); skipping');
      return { seeded_agents: 0, seeded_skills: 0, unsupported: true };
    }
    log.warn(`default installs incremental seed failed (will retry): ${message}`);
    return { seeded_agents: 0, seeded_skills: 0, failed: true, error: message };
  }
}

// ── uninstall (user-facing; non-dev) ──────────────────────────────────────
// Removes the per-machine install copy + manifest entry. **Does NOT touch the server row**
// (different from `marketplace_dev.deleteMarketplace*` which wipes COS + DB). After this runs:
//   - listAgents / listSkills stops including this id under the "Platform" group
//   - cloud sync propagates the missing manifest entry to other devices, where startup
//     `marketplace_reconcile` notices nothing to pull and the install disappears there too
//   - the marketplace catalog still lists the item; the user can re-install at any time
// Dependent skills (for an agent) are **not** cascade-uninstalled — other agents may share them.

export async function uninstallMarketplaceAgent(agentId: string): Promise<{ ok: true; id: string }> {
  return uninstallMarketplaceAgentForUser(getActiveUserId(), agentId);
}

export async function uninstallMarketplaceAgentForUser(userId: string, agentId: string): Promise<{ ok: true; id: string }> {
  if (!agentId) throw new Error('agentId required');
  return withMarketplaceInstallLock(userId, 'agent', agentId, async () => {
    await fsp.rm(userMarketplaceAgentDir(userId, agentId), { recursive: true, force: true });
    await withMarketplaceCacheLock(userId, 'agent', agentId, async () => {
      await fsp.rm(marketplaceCacheAgentDir(userId, agentId), { recursive: true, force: true });
    });
    await removeAgentInstall(userId, agentId);
    clearAgentUpdateFailure(userId, agentId);
    await _clearAgentListCacheForUser(userId);
    log.info(`uninstalled marketplace agent ${agentId} (local + cache + manifest)`);
    return { ok: true, id: agentId };
  });
}

/**
 * Uninstall a Hub official copy.
 *
 * ## 边界（specs/010 FR-048）
 *
 * 只删三样：**current install 内容树、下载缓存、安装清单行**（清单行的移除顺带写下墓碑）。
 *
 * ⚠️ **不可变版本副本不删** —— 它们可能仍被非终态 Task 钉固，删掉会中止进行中的使用。
 * 副本落在 `<uid>/local/marketplace/versions/`，与这里删的 `.../skills/<id>/` 是**两棵树**，
 * 因此「不删」由路径结构保证，不依赖这里记得跳过。副本的回收交给 `version-gc.ts` 的三条件。
 *
 * ⚠️ **墓碑只表达「不自动装回官方副本」的用户意图**，不是删除历史版本副本的依据。
 *
 * ⚠️ **authority boundary**：本函数只碰 marketplace 安装树。用户自定义 Skill 在
 * `<uid>/cloud/skills/`、派生副本转为 custom 之后同样在那里——本函数**触碰不到**它们。
 */
/**
 * Hub 安装 / 卸载改了 `<uid>/local/marketplace/agents` 后清智能体列表缓存。
 * 不能只靠目录时间戳：持久化目录缓存在「有源文件损坏」时会保留旧快照。
 * 动态引入：`agents.ts` 静态引用了本模块，反向静态引入会成环。
 */
async function _clearAgentListCacheForUser(uid: string): Promise<void> {
  try {
    const { clearAgentListCacheForUser } = await import('./agents');
    clearAgentListCacheForUser(uid);
  } catch (err) {
    log.warn('agent list cache clear failed', { error: (err as Error).message });
  }
}

/**
 * 卸载后触发一轮保守回收。
 *
 * 与卸载解耦：回收是磁盘清理，成败都不改变卸载结果，故不 await、不向调用方抛错。
 * 回收的三条删除条件与 fail-safe 语义完全由 `version-gc.ts` 决定，这里不传任何策略。
 */
async function runVersionGcAfterUninstall(uid: string): Promise<void> {
  try {
    const gc = await import('./marketplace/version-gc');
    const report = await gc.runVersionGc(uid);
    log.info('hub version copy gc after uninstall', {
      deleted: report.deleted.length, kept: report.kept.length, aborted: report.aborted,
    });
  } catch (err) {
    log.warn('hub version copy gc after uninstall failed; uninstall itself is unaffected', {
      error: (err as Error).message,
    });
  }
}

export async function uninstallMarketplaceSkill(skillId: string): Promise<{ ok: true; id: string }> {
  return uninstallMarketplaceSkillForUser(getActiveUserId(), skillId);
}

export async function uninstallMarketplaceSkillForUser(userId: string, skillId: string): Promise<{ ok: true; id: string }> {
  if (!skillId) throw new Error('skillId required');
  return withMarketplaceInstallLock(userId, 'skill', skillId, async () => {
    await fsp.rm(userMarketplaceSkillDir(userId, skillId), { recursive: true, force: true });
    await withMarketplaceCacheLock(userId, 'skill', skillId, async () => {
      await fsp.rm(marketplaceCacheSkillDir(userId, skillId), { recursive: true, force: true });
    });
    await removeSkillInstall(userId, skillId);
    invalidateCoreAgentSkills();
    log.info(`uninstalled marketplace skill ${skillId} (local + cache + manifest)`);
    // 卸载后跑一轮保守回收（FR-052 的第二个触发点）。**不在这里删任何副本**——
    // 回收自己判断三条件，仍被钉固、仍是 current、或未过宽限期的一概保留；
    // 任何异常本轮删 0。回收失败不影响卸载本身已经完成的事实。
    void runVersionGcAfterUninstall(userId);
    return { ok: true, id: skillId };
  });
}

// ── 因客户端版本不足被跳过的市场内容（C5/N-06）────────────────────────────
/** 需要更新客户端才能安装/使用的内容。字段与 MarketplaceInstallError 的
 *  appUpdateRequired / minAppVersion / currentAppVersion 对齐，渲染层可直接复用同一
 *  套本地化提示。收集是进程内的；按用户过滤在投影/渲染侧进行。 */
export interface AppIncompatibleSkip {
  id: string;
  kind: 'agent' | 'skill';
  minAppVersion: string;
  currentAppVersion: string;
  at: string;
}

const _appIncompatibleSkips: AppIncompatibleSkip[] = [];

/** 记录一条"因版本不足被跳过"的内容（幂等：同一 id+kind 只留一条）。由
 *  marketplace_reconcile 在 min_app_version 门处回调；该方向已有导入，零新增环。 */
export function recordAppIncompatibleSkip(
  row: { id?: string },
  kind: 'agent' | 'skill',
  minAppVersion: string,
): void {
  const id = String(row?.id || '').trim();
  if (!id) return;
  if (_appIncompatibleSkips.some((item) => item.id === id && item.kind === kind)) return;
  _appIncompatibleSkips.push({
    id,
    kind,
    minAppVersion,
    currentAppVersion: currentAppVersion(),
    at: new Date().toISOString(),
  });
}

/** 当前因客户端版本不足被跳过的内容（供列表投影/渲染层显示兼容状态）。 */
export function listAppIncompatibleSkips(): AppIncompatibleSkip[] {
  return [..._appIncompatibleSkips];
}

/** 撤销一条旧标记：同一 id+kind 上一轮因版本不足被跳过、这一轮已经兼容时调用。
 *  没有它，内容端下调 `min_app_version` 后卡片会永远停在「需更新客户端」——
 *  标记是进程内累积的，只有显式撤销才会消失。 */
export function clearAppIncompatibleSkip(row: { id?: string }, kind: 'agent' | 'skill'): void {
  const id = String(row?.id || '').trim();
  if (!id) return;
  for (let i = _appIncompatibleSkips.length - 1; i >= 0; i -= 1) {
    const item = _appIncompatibleSkips[i];
    if (item.id === id && item.kind === kind) _appIncompatibleSkips.splice(i, 1);
  }
}

/** 清空收集（版本满足后或新一轮扫描前调用，避免陈旧状态留在界面上）。 */
export function clearAppIncompatibleSkips(): void {
  _appIncompatibleSkips.length = 0;
}
