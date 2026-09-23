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

import { sha256OfFile } from '../util/sha256';
import { marketplaceContentTreeHash } from '../util/marketplace-tree-hash';
import { writeInstallReceipt } from './skill_trust';
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
import { invalidateSkills as invalidateCoreAgentSkills } from '../model/core-agent/skill-registry';
import {
  getSkillCacheDir, isCacheFresh, readAgentCache, touchCacheEntry,
  writeAgentCache, writeSkillCache,
} from './marketplace_cache';
import {
  addAgentInstall, addSkillInstall, readInstalls, removeAgentInstall, removeSkillInstall,
} from './marketplace_installs';
import { withMarketplaceCacheLock, withMarketplaceInstallLock } from './marketplace_locks';
import { agentPrivateSkillIdsFromBundle } from './marketplace_private_skills';
import { MarketplaceError } from './marketplace/errors';
import { readInstalledVersion } from './marketplace/installed-version';
import { getSkillMetadata, normalizeCatalogListRow, type CatalogListRow, type SkillMetadata } from './marketplace/metadata-adapter';
import { decideMarketplaceContentUpdate } from './marketplace-update-policy';
import { fetchImmutableSource } from './marketplace/source-fetch';
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
  if (data.code !== 0) throw new Error(data.msg || `marketplace ${p} failed (code=${data.code})`);
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
export async function listMarketplaceAgents(
  opts: { category?: string; status?: string; q?: string; page?: number; size?: number } = {},
): Promise<{ list: MarketplaceAgent[]; total: number }> {
  return await postJson('/marketplace/agents/list', {
    category: opts.category || null,
    status: opts.status || null,
    q: opts.q || null,
    page: opts.page || 1,
    size: opts.size || 50,
  });
}

export async function listMarketplaceSkills(
  opts: { category?: string; status?: string; q?: string; page?: number; size?: number } = {},
): Promise<{ list: MarketplaceSkill[]; total: number }> {
  const res = await postJson<{ list?: unknown; total?: number }>('/marketplace/skills/list', {
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
  return { ...res, list, total: typeof res.total === 'number' ? res.total : list.length };
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

function _currentAppVersion(): string {
  try { return app.getVersion(); } catch { return ''; }
}

function _normalizeMarketplaceMinAppVersion(...sources: Array<MinAppVersionSource | null | undefined>): string {
  return minAppVersionFrom(...sources);
}

function _assertMarketplaceAppCompatible(kind: MarketplaceInstallKind, id: string, name: string | undefined, minAppVersion: string): void {
  const min = normalizeMinAppVersion(minAppVersion);
  if (!min) return;
  const current = _currentAppVersion();
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
  return satisfiesMinAppVersion(_currentAppVersion(), minAppVersion);
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
  return String(row.status || row.state || '').trim().toLowerCase();
}

function _assertApprovedDependencySkill(
  skillId: string,
  displayName: string,
  row: { status?: string; state?: string },
): void {
  const status = _marketplaceStatus(row);
  if (status !== 'approved') {
    throw new MarketplaceInstallError(
      'skill',
      skillId,
      displayName || skillId,
      status ? `status_not_approved:${status}` : 'status_not_approved',
    );
  }
}

export async function getAgentDetail(
  agentId: string, expect: MarketplaceFreshness,
): Promise<AgentDetail> {
  if (!agentId) throw new Error('agentId required');
  if (await isCacheFresh('agent', agentId, expect)) {
    const cached = await readAgentCache(agentId);
    if (cached) {
      await touchCacheEntry('agent', agentId);
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
  // Miss → fetch + repopulate.
  const data = await postJson<{ agent_json: Record<string, unknown>; version: string; category: string; published_at: number; updated_at?: number; agent_json_url: string; agent_skills_bundle_url?: string; create_uid: string; default_install?: boolean; is_open_source?: boolean; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }>(
    '/marketplace/agents/detail', { id: agentId },
  );
  await writeAgentCache(agentId, data.agent_json, {
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
  if (!skillId) throw new Error('skillId required');
  if (await isCacheFresh('skill', skillId, expect)) {
    await touchCacheEntry('skill', skillId);
    return {
      id: skillId, version: expect.version, category: '',
      published_at: expect.published_at, updated_at: expect.updated_at,
      cache_dir: getSkillCacheDir(skillId), bundle_url: '', create_uid: '',
      ...(_normalizeMarketplaceMinAppVersion(expect) ? { min_app_version: _normalizeMarketplaceMinAppVersion(expect) } : {}),
    };
  }
  // Miss → metadata from the adapter; bytes from the Hub origin by {content_id, version}.
  // The byte endpoint is no longer asked for JSON, and no object-storage URL is involved.
  const meta = await getSkillMetadata(skillId);
  if (!meta) throw new MarketplaceError('CONTENT_NOT_FOUND', `CONTENT_NOT_FOUND: ${skillId}`);
  await _fetchAndCacheSkill(skillId, meta);
  return {
    id: skillId, name: meta.name, version: meta.version, category: meta.category,
    published_at: meta.published_at, updated_at: meta.updated_at,
    cache_dir: getSkillCacheDir(skillId), bundle_url: '', artifact: meta.artifact,
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
  skillId: string,
  meta: { version: string; published_at: number; updated_at?: number; artifact: SkillMetadata['artifact'] },
): Promise<void> {
  const stagingRoot = marketplaceCacheSkillsDir(getActiveUserId());
  await fsp.mkdir(stagingRoot, { recursive: true });
  const staging = path.join(stagingRoot, `.staging-${skillId}-${randomBytes(6).toString('hex')}.zip`);
  try {
    await fetchImmutableSource({
      contentId: skillId, version: meta.version, artifact: meta.artifact, destPath: staging,
    });
    // The file on disk is already digest- and size-verified; reading it back is bounded by
    // the same compressed-size cap that governed the download.
    const zip = parseMarketplaceBundle(await fsp.readFile(staging));
    await writeSkillCache(skillId, async (dir) => {
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
  if (!agentId) throw new Error('agentId required');
  return withMarketplaceInstallLock(
    getActiveUserId(),
    'agent',
    agentId,
    () => _installMarketplaceAgentLocked(agentId, expect, opts),
  );
}

async function _installMarketplaceAgentLocked(
  agentId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string }> {
  if (!agentId) throw new Error('agentId required');
  let agentName = opts.name || '';
  try {
    // Ensure cache is hot (and pick up agent_json_url for the manifest).
    let detail = await getAgentDetail(agentId, expect);
    agentName = agentName || _agentJsonName(detail.agent_json);
    if (!detail.agent_json_url) {
      // Cache-hit path returns url='' (and create_uid=''); re-fetch via detail endpoint to
      // capture both — needed for manifest + `_install.json` author badge.
      const fresh = await postJson<{ agent_json: Record<string, unknown>; version: string; category: string; published_at: number; updated_at?: number; agent_json_url: string; agent_skills_bundle_url?: string; create_uid: string; default_install?: boolean; is_open_source?: boolean; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }>(
        '/marketplace/agents/detail', { id: agentId },
      );
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
    const privateSkillsZip = await _fetchAgentPrivateSkillsBundle(agentId, detail.agent_skills_bundle_url || '');
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
    const missingSkillIds = skillList.filter(
      (sid) => !privateSkillIds.has(sid) && !_skillAlreadyOnDisk(sid),
    );
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
          await installMarketplaceSkill(sid, {
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
      uid: getActiveUserId(), kind: 'agent', id: agentId, report: preReport,
    });
    // `report.ok === false` means an EXTREME violation, and EXTREME is not
    // user-overridable (see `quality/README.md`) — `force` must not reach it.
    // See `_assertQualityGatePassed` for why force is deliberately ignored here.
    _assertQualityGatePassed('agent', agentId, preReport, opts.acceptSecurityRisk === true);
    // 4. Now materialize the agent: cache content → `<uid>/local/marketplace/agents/<id>/`.
    //    `_install.json` is a version pin read by `marketplace_reconcile.ts::_agentNeedsPull`
    //    on other devices to skip a re-pull when their local copy already matches the manifest's
    //    (version, freshness timestamp).
    const target = userMarketplaceAgentDir(getActiveUserId(), agentId);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.mkdir(target, { recursive: true });
    const agentJsonFile = path.join(target, 'agent.json');
    await fsp.writeFile(agentJsonFile, JSON.stringify(detail.agent_json, null, 2), 'utf8');
    if (privateSkillsZip) {
      const privateSkillsDir = userMarketplaceAgentSkillsDir(getActiveUserId(), agentId);
      await fsp.mkdir(privateSkillsDir, { recursive: true });
      extractBundleSafely(privateSkillsZip, privateSkillsDir);
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
      const privateSkillsDir = userMarketplaceAgentSkillsDir(getActiveUserId(), agentId);
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
            getActiveUserId(), entry.name, privateTreeHash, scan,
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
      }, null, 2), 'utf8');
    await touchCacheEntry('agent', agentId);

    // 4. Record in the cloud-synced manifest so other devices reconcile this install.
    await addAgentInstall(getActiveUserId(), {
      id: agentId, version: detail.version, published_at: detail.published_at,
      ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : {}),
      agent_json_url: detail.agent_json_url, create_uid: detail.create_uid || '',
      agent_skills_bundle_url: detail.agent_skills_bundle_url || '',
      installed_at: installedAt,
      ...(typeof detail.default_install === 'boolean' ? { default_install: detail.default_install } : {}),
      ...(detail.status ? { status: detail.status } : {}),
      min_app_version: detail.min_app_version || '',
    });
    invalidateCoreAgentSkills();
    log.info('installed marketplace agent', { agentId, version: detail.version, target: logPathRef(target) });

    return { ok: true, id: agentId };
  } catch (err) {
    throw _wrapMarketplaceInstallError('agent', agentId, agentName, err);
  }
}

export async function installMarketplaceSkill(
  skillId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string }> {
  if (!skillId) throw new Error('skillId required');
  return withMarketplaceInstallLock(
    getActiveUserId(),
    'skill',
    skillId,
    () => _installMarketplaceSkillLocked(skillId, expect, opts),
  );
}

async function _installMarketplaceSkillLocked(
  skillId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string; securityScan?: SentryScanResult }> {
  if (!skillId) throw new Error('skillId required');
  let skillName = opts.name || '';
  try {
    let detail = await getSkillDetail(skillId, expect);
    skillName = skillName || detail.name || '';
    if (!detail.artifact) {
      // The cache-fresh branch of `getSkillDetail` carries no artifact identity, and the
      // install path needs one to verify the bytes. This used to top up `bundle_url` from
      // the byte endpoint; it now tops up `{sha256, size_bytes}` from the metadata adapter.
      const fresh = await getSkillMetadata(skillId);
      if (!fresh) throw new MarketplaceError('CONTENT_NOT_FOUND', `CONTENT_NOT_FOUND: ${skillId}`);
      skillName = skillName || fresh.name;
      detail = {
        ...detail,
        name: fresh.name || detail.name,
        published_at: fresh.published_at,
        updated_at: fresh.updated_at,
        bundle_url: '',
        artifact: fresh.artifact,
        create_uid: fresh.create_uid,
        default_install: fresh.default_install,
        is_open_source: fresh.is_open_source,
        status: fresh.status,
        ...(fresh.min_app_version ? { min_app_version: fresh.min_app_version } : {}),
      };
    }
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

    const cacheDir = getSkillCacheDir(skillId);
    const uid = getActiveUserId();
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
        uid: getActiveUserId(), kind: 'skill', id: skillId, report: skillReport,
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
          getActiveUserId(), skillId, skillTreeHash,
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
      await touchCacheEntry('skill', skillId);
      invalidateCoreAgentSkills();
    } catch (err) {
      // Safety net: a refusal, an engine crash, or a killed process between
      // materialize and promote must never leave the unverified tree on disk.
      // Idempotent — the refusal paths above may already have removed it, and
      // after promotion the staging path no longer exists.
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    await addSkillInstall(getActiveUserId(), {
      id: skillId, version: detail.version, published_at: detail.published_at,
      ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : {}),
      bundle_url: detail.bundle_url, create_uid: detail.create_uid || '',
      installed_at: installedAt,
      ...(typeof detail.default_install === 'boolean' ? { default_install: detail.default_install } : {}),
      ...(detail.status ? { status: detail.status } : {}),
      min_app_version: detail.min_app_version || '',
    });
    log.info('installed marketplace skill', { skillId, version: detail.version, target: logPathRef(target) });
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
function _skillAlreadyOnDisk(skillId: string): boolean {
  try {
    const customRoot = userSkillsDir(getActiveUserId());
    if (fs.existsSync(path.join(customRoot, skillId, 'SKILL.md'))) return true;
    const installedDir = userMarketplaceSkillDir(getActiveUserId(), skillId);
    if (fs.existsSync(path.join(installedDir, 'SKILL.md'))) return true;
  } catch { /* getActiveUserId throws when no active uid */ }
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
): Promise<{ seeded: number; blocked: boolean }> {
  if (!shouldContinue()) return { seeded: 0, blocked: true };
  const detail = await postJson<{
    agent_json: Record<string, unknown>;
    agent_skills_bundle_url?: string;
  }>(
    '/marketplace/agents/detail', { id: agentId },
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
        throw new Error(`requires CogSeed >= ${minAppVersion}; current ${_currentAppVersion() || 'unknown'}`);
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
};

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
        const depSeed = await _seedAgentSkillDependencies(uid, a.id, installedSkills, deletedSkills, canContinue);
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
      if (installedSkills.has(s.id) || deletedSkills.has(s.id)) continue;
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
  if (!agentId) throw new Error('agentId required');
  const uid = getActiveUserId();
  return withMarketplaceInstallLock(uid, 'agent', agentId, async () => {
    await fsp.rm(userMarketplaceAgentDir(uid, agentId), { recursive: true, force: true });
    await withMarketplaceCacheLock(uid, 'agent', agentId, async () => {
      await fsp.rm(marketplaceCacheAgentDir(uid, agentId), { recursive: true, force: true });
    });
    await removeAgentInstall(uid, agentId);
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
  if (!skillId) throw new Error('skillId required');
  const uid = getActiveUserId();
  return withMarketplaceInstallLock(uid, 'skill', skillId, async () => {
    await fsp.rm(userMarketplaceSkillDir(uid, skillId), { recursive: true, force: true });
    await withMarketplaceCacheLock(uid, 'skill', skillId, async () => {
      await fsp.rm(marketplaceCacheSkillDir(uid, skillId), { recursive: true, force: true });
    });
    await removeSkillInstall(uid, skillId);
    invalidateCoreAgentSkills();
    log.info(`uninstalled marketplace skill ${skillId} (local + cache + manifest)`);
    // 卸载后跑一轮保守回收（FR-052 的第二个触发点）。**不在这里删任何副本**——
    // 回收自己判断三条件，仍被钉固、仍是 current、或未过宽限期的一概保留；
    // 任何异常本轮删 0。回收失败不影响卸载本身已经完成的事实。
    void runVersionGcAfterUninstall(uid);
    return { ok: true, id: skillId };
  });
}
