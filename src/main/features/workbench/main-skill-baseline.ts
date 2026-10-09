/**
 * Main Skill Baseline — the frozen method version a KSTAR Episode runs against.
 *
 * A baseline pins WHICH capability asset (id + version) a complex-delivery
 * Workspace uses, plus a content fingerprint so drift is detectable. Per
 * US-11: a baseline records skill id, version, source, Action Plan, Ontology
 * Binding, Evaluation Contract and a hash, and is IMMUTABLE for the duration
 * of an Episode. No baseline → no formal KSTAR Episode.
 *
 * Design constraints (US-19 / US-20 / RG-S3-13 / RG-S3-15):
 *   - Reference, never copy. Only `asset_id` + `version` + `content_hash` are
 *     stored here; the remaining governance metadata (owner, scope, maturity,
 *     sensitivity, control, …) belongs to the asset layer (T2-S3-01).
 *   - Freeze happens BEFORE the TaskRun. Freezing after execution is the
 *     timing contamination RG-S3-15 marks as REWORK.
 *   - Immutable once frozen. A change means a NEW baseline; never edit in
 *     place, and never auto-refreeze when drift is detected.
 *   - Only the user freezes (`frozen_by: 'user'`). Agents must not write
 *     formal assets.
 *
 * Content hash reuses `util/marketplace-tree-hash`. That hasher is already a
 * cross-language contract (codepoint ordering, platform-neutral relative
 * paths) and skips volatile entries such as `.DS_Store` / `_install.json`, so
 * an incidental OS file cannot masquerade as method drift. Do not substitute
 * `sha256OfFile` — it digests a single file and cannot cover a skill tree.
 *
 * Storage: `<uid>/local/kstar/baselines/<baseline_id>.json` — one file per
 * baseline (concurrent writes to different baselines never conflict; listing
 * is a directory scan, no aggregate index), machine-private alongside the
 * other execution evidence.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { userLocalRoot } from '../../paths';
import { safeId, writeJson } from '../../storage';
import { createLogger } from '../../logger';
import { fileEditLock } from '../../util/locks';
import { isPathAllowed } from '../../util/path-sandbox';
import { logErrorRef, maskId } from '../../util/log-redact';
import { marketplaceContentTreeHash } from '../../util/marketplace-tree-hash';

const log = createLogger('main-skill-baseline');

const MAX_ID_LENGTH = 160;
const MAX_REF_LENGTH = 512;
/** Asset versions are user/asset-layer authored; keep them printable and short. */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_VERSION_LENGTH = 64;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Where a baseline's skill came from. Closed set — mirrors US-11 AC1
 * ("Workspace/Role builtin, admitted external Skill, or a user-confirmed
 * Session-extracted Draft"). Do not add a fourth source.
 */
export type BaselineSource =
  | 'workspace-builtin'
  | 'external-admitted'
  | 'session-draft-confirmed';

const BASELINE_SOURCES: readonly BaselineSource[] = [
  'workspace-builtin',
  'external-admitted',
  'session-draft-confirmed',
];

/**
 * Stable reference to a capability asset. Workspaces reference assets by id +
 * version and never copy their content (US-20 AC3).
 *
 * This is the minimum reference contract; the asset layer (T2-S3-01) owns the
 * full US-19 field set. These three field NAMES are the handover baseline —
 * extend around them rather than renaming.
 */
export interface AssetRef {
  asset_id: string;
  version: string;
  /** `sha256-tree-v1` digest of the asset's content tree. */
  content_hash: string;
}

/** Frozen method version. Immutable — a change requires a new baseline. */
export interface MainSkillBaseline {
  baseline_id: string;
  skill_ref: AssetRef;
  source: BaselineSource;
  /** Reference to the Action Plan this baseline was frozen with. */
  action_plan_ref?: string;
  /** Reference to the Ontology Binding in force at freeze time. */
  ontology_binding_ref?: string;
  /** Reference to the Evaluation Contract — must be frozen pre-run (RG-S3-15). */
  evaluation_contract_ref?: string;
  frozen_at: string;
  /** Agents must not write formal assets (RG-S3-13). */
  frozen_by: 'user';
}

export interface FreezeBaselineInput {
  baselineId?: string;
  assetId: string;
  version: string;
  /** Absolute path to the skill's content tree; hashed at freeze time. */
  skillDir: string;
  /** Sandbox roots the skill dir must fall inside. */
  allowedRoots: readonly string[];
  source: BaselineSource;
  actionPlanRef?: string;
  ontologyBindingRef?: string;
  evaluationContractRef?: string;
}

export type VerifyBaselineFailure = 'not_found' | 'drift' | 'unreadable';

export type VerifyBaselineResult =
  | { ok: true }
  | { ok: false; reason: VerifyBaselineFailure };

// ── validation helpers ────────────────────────────────────────────────────

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH || !safeId(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function requireVersion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_VERSION_LENGTH ||
    !VERSION_RE.test(value)
  ) {
    throw new Error('invalid asset version');
  }
  return value;
}

function requireContentHash(value: unknown): string {
  if (typeof value !== 'string' || !CONTENT_HASH_RE.test(value)) {
    throw new Error('invalid content hash');
  }
  return value;
}

function requireSource(value: unknown): BaselineSource {
  if (BASELINE_SOURCES.includes(value as BaselineSource)) return value as BaselineSource;
  throw new Error('invalid baseline source');
}

/**
 * Optional pointer to a sibling record. Kept as an opaque bounded string: the
 * Action Plan / Ontology Binding / Evaluation Contract carriers do not exist
 * yet, so this layer validates shape only and never dereferences.
 */
function optionalRef(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`invalid ${field}`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REF_LENGTH) throw new Error(`invalid ${field}`);
  if (path.isAbsolute(trimmed) || trimmed.includes('..')) throw new Error(`invalid ${field}`);
  return trimmed;
}

// ── paths ─────────────────────────────────────────────────────────────────

function baselinesDir(userId: string): string {
  return path.join(userLocalRoot(userId), 'kstar', 'baselines');
}

export function baselinePath(userId: string, baselineId: string): string {
  return path.join(baselinesDir(userId), `${requireId(baselineId, 'baseline id')}.json`);
}

// ── content hashing ───────────────────────────────────────────────────────

/**
 * Digest a skill content tree. Returns null when the tree is unreadable or
 * empty — the hasher yields '' in that case, which must NOT be persisted as a
 * baseline: an empty digest would make every later comparison vacuous. An
 * unhashable tree is treated as "cannot freeze", equivalent to no baseline.
 */
function hashSkillTree(skillDir: string, allowedRoots: readonly string[]): string | null {
  if (!isPathAllowed(skillDir, allowedRoots)) {
    throw new Error('skill directory is outside allowed roots');
  }
  const digest = marketplaceContentTreeHash(skillDir);
  return CONTENT_HASH_RE.test(digest) ? digest : null;
}

// ── parsing ───────────────────────────────────────────────────────────────

function parseBaseline(raw: string): MainSkillBaseline {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('main skill baseline is malformed'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('main skill baseline is malformed');
  }
  const row = value as Partial<MainSkillBaseline>;
  const ref = row.skill_ref;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new Error('main skill baseline is malformed');
  }
  if (row.frozen_by !== 'user') throw new Error('main skill baseline is malformed');
  if (typeof row.frozen_at !== 'string' || !row.frozen_at) {
    throw new Error('main skill baseline is malformed');
  }
  return {
    baseline_id: requireId(row.baseline_id, 'baseline id'),
    skill_ref: {
      asset_id: requireId(ref.asset_id, 'asset id'),
      version: requireVersion(ref.version),
      content_hash: requireContentHash(ref.content_hash),
    },
    source: requireSource(row.source),
    ...(optionalRef(row.action_plan_ref, 'action plan ref')
      ? { action_plan_ref: optionalRef(row.action_plan_ref, 'action plan ref') }
      : {}),
    ...(optionalRef(row.ontology_binding_ref, 'ontology binding ref')
      ? { ontology_binding_ref: optionalRef(row.ontology_binding_ref, 'ontology binding ref') }
      : {}),
    ...(optionalRef(row.evaluation_contract_ref, 'evaluation contract ref')
      ? { evaluation_contract_ref: optionalRef(row.evaluation_contract_ref, 'evaluation contract ref') }
      : {}),
    frozen_at: row.frozen_at,
    frozen_by: 'user',
  };
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Freeze a baseline. Must be called BEFORE the TaskRun it governs (RG-S3-15).
 *
 * Refuses to overwrite an existing baseline: immutability is the whole point
 * (US-11 AC3). Callers that need different values must freeze a new baseline.
 */
export async function freezeBaseline(
  userId: string,
  input: FreezeBaselineInput,
): Promise<MainSkillBaseline> {
  const baselineId = input.baselineId
    ? requireId(input.baselineId, 'baseline id')
    : `baseline-${randomUUID()}`;
  const assetId = requireId(input.assetId, 'asset id');
  const version = requireVersion(input.version);
  const source = requireSource(input.source);
  const actionPlanRef = optionalRef(input.actionPlanRef, 'action plan ref');
  const ontologyBindingRef = optionalRef(input.ontologyBindingRef, 'ontology binding ref');
  const evaluationContractRef = optionalRef(input.evaluationContractRef, 'evaluation contract ref');

  const contentHash = hashSkillTree(input.skillDir, input.allowedRoots);
  if (!contentHash) throw new Error('skill content tree is unreadable or empty');

  const target = baselinePath(userId, baselineId);
  return fileEditLock(target).runExclusive(async () => {
    try {
      await fs.access(target);
      throw new Error('main skill baseline already exists');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const baseline: MainSkillBaseline = {
      baseline_id: baselineId,
      skill_ref: { asset_id: assetId, version, content_hash: contentHash },
      source,
      ...(actionPlanRef ? { action_plan_ref: actionPlanRef } : {}),
      ...(ontologyBindingRef ? { ontology_binding_ref: ontologyBindingRef } : {}),
      ...(evaluationContractRef ? { evaluation_contract_ref: evaluationContractRef } : {}),
      frozen_at: new Date().toISOString(),
      frozen_by: 'user',
    };
    await writeJson(target, baseline);
    log.info('froze main skill baseline', {
      user_id: maskId(userId),
      baseline_id: maskId(baselineId),
      asset_id: maskId(assetId),
      version,
      source,
    });
    return baseline;
  });
}

export async function readBaseline(
  userId: string,
  baselineId: string,
): Promise<MainSkillBaseline> {
  const target = baselinePath(userId, baselineId);
  try {
    return parseBaseline(await fs.readFile(target, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('main skill baseline not found');
    }
    throw err;
  }
}

/**
 * Re-hash the skill tree and compare against the frozen digest. Call before
 * every Episode / TaskRun start.
 *
 * A `drift` result must BLOCK the Episode. Never auto-refreeze: silently
 * re-pinning would defeat "immutable for the duration of an Episode".
 */
export async function verifyBaseline(
  userId: string,
  baselineId: string,
  skillDir: string,
  allowedRoots: readonly string[],
): Promise<VerifyBaselineResult> {
  let baseline: MainSkillBaseline;
  try {
    baseline = await readBaseline(userId, baselineId);
  } catch (err) {
    if ((err as Error).message === 'main skill baseline not found') {
      return { ok: false, reason: 'not_found' };
    }
    throw err;
  }
  const digest = hashSkillTree(skillDir, allowedRoots);
  if (!digest) {
    log.warn('baseline verification could not hash skill tree', {
      user_id: maskId(userId),
      baseline_id: maskId(baselineId),
    });
    return { ok: false, reason: 'unreadable' };
  }
  if (digest !== baseline.skill_ref.content_hash) {
    log.warn('baseline drift detected — episode must not start', {
      user_id: maskId(userId),
      baseline_id: maskId(baselineId),
      asset_id: maskId(baseline.skill_ref.asset_id),
    });
    return { ok: false, reason: 'drift' };
  }
  return { ok: true };
}

/** Directory scan, newest first. Malformed files are skipped, not fatal. */
export async function listBaselines(userId: string): Promise<MainSkillBaseline[]> {
  let names: string[];
  try { names = await fs.readdir(baselinesDir(userId)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const rows: MainSkillBaseline[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const baselineId = name.slice(0, -'.json'.length);
    if (!safeId(baselineId)) continue;
    try {
      rows.push(parseBaseline(await fs.readFile(path.join(baselinesDir(userId), name), 'utf8')));
    } catch (err) {
      log.warn('skipping unreadable main skill baseline', {
        user_id: maskId(userId),
        baseline_id: maskId(baselineId),
        error: logErrorRef(err),
      });
    }
  }
  return rows.sort((left, right) => right.frozen_at.localeCompare(left.frozen_at));
}
