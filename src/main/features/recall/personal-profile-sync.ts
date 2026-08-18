/**
 * Projects accepted PersonalOntology assets into USER.md and, when available,
 * installed role-template fields. These are one-way additive views: the formal
 * asset remains the source of truth and Rule / Template / Skill assets never
 * enter this flow.
 */

import { createHash } from 'node:crypto';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { ensurePersonalProfileEntry } from '../memory';
import {
  appendExistingTemplateFieldValueToRef,
  buildContentRef,
  listTemplateFileCatalog,
  type TemplateCatalogEntry,
} from '../personal_ontology_template_files';
import { routeCandidateToField, type RouteDecision } from '../personal_ontology_router';
import { getRoleTemplate } from '../role_templates';
import { listAbilityAssets } from './asset-service';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import type { RecallAbilityAssetRecord } from './candidate-service';
import type { RecallJsonRecord } from './types';

const log = createLogger('recall-personal-profile-sync');
const PROJECTION_COLLECTION = 'personal-profile-projections';
const PROFILE_MEMORY_PROJECTION_COLLECTION = 'personal-profile-memory-projections';

type ProjectionStatus = 'applied' | 'no_match' | 'failed';

interface PersonalProfileProjectionRecord extends RecallJsonRecord {
  id: string;
  assetId: string;
  assetVersion: string;
  inputFingerprint: string;
  catalogFingerprint: string;
  status: ProjectionStatus;
  templateId?: string;
  groupId?: string;
  section?: string;
  fieldName?: string;
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
}

interface PersonalProfileMemoryProjectionRecord extends RecallJsonRecord {
  id: string;
  assetId: string;
  assetVersion: string;
  inputFingerprint: string;
  status: 'applied' | 'failed';
  recordId?: string;
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalProfileSyncResult {
  eligible: number;
  written: number;
  skipped: number;
  unmatched: number;
  failed: Array<{ assetId: string; error: string }>;
  /** USER.md profile projection counters. Template counters above stay compatible. */
  profileWritten?: number;
  profileSkipped?: number;
  profileFailed?: Array<{ assetId: string; error: string }>;
}

export interface PersonalProfileSyncDependencies {
  listAssets?: (userId: string) => Promise<RecallAbilityAssetRecord[]>;
  listCatalog?: (userId: string) => Promise<TemplateCatalogEntry[]>;
  routeAsset?: (userId: string, statement: string, catalog: TemplateCatalogEntry[]) => Promise<RouteDecision>;
  appendFieldValue?: typeof appendExistingTemplateFieldValueToRef;
  writeProfileEntry?: typeof ensurePersonalProfileEntry;
}

/** User-selected destination for a personal asset during candidate review. */
export interface PersonalProfileTarget {
  groupId: string;
  section: string;
  fieldName: string;
  templateId?: string;
}

export interface PersonalProfileSyncOptions {
  /** Limit the pass to one newly confirmed asset. */
  assetId?: string;
  /** Explicit destination selected in the capture review UI. */
  target?: PersonalProfileTarget;
}

const syncsInFlight = new Map<string, Promise<PersonalProfileSyncResult>>();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function projectionIdFor(assetId: string): string {
  return `profile-${sha256(assetId).slice(0, 24)}`;
}

function profileMemoryProjectionIdFor(assetId: string): string {
  return `profile-memory-${sha256(assetId).slice(0, 24)}`;
}

function inputFingerprint(asset: RecallAbilityAssetRecord): string {
  return sha256(JSON.stringify({
    assetId: asset.id,
    assetVersion: asset.version,
    assetUpdatedAt: asset.updatedAt,
    statement: asset.statement,
  }));
}

function catalogFingerprint(catalog: TemplateCatalogEntry[]): string {
  const catalogShape = catalog.map((template) => ({
    groupId: template.group_id,
    templateId: template.template_id,
    sections: template.sections.map((section) => ({ title: section.title, fields: [...section.fields] })),
  }));
  return sha256(JSON.stringify(catalogShape));
}

function isSettledForInput(
  record: RecallJsonRecord | undefined,
  fingerprint: string,
  currentCatalogFingerprint: string,
  hasExplicitTarget = false,
): boolean {
  if (!record) return false;
  // An applied projection is append-only. Asset updates require an explicit
  // review flow rather than silently adding a second, potentially conflicting
  // profile value.
  if (record.status === 'applied') return true;
  if (record.inputFingerprint !== fingerprint) return false;
  return !hasExplicitTarget && record.status === 'no_match' && record.catalogFingerprint === currentCatalogFingerprint;
}

/** Assets allowed to populate the base personal profile. Automatic capture is
 * an explicit user policy, so its unverified Personal assets are eligible;
 * KStar/system precipitation is deliberately excluded from identity data. */
function isEligiblePersonalAsset(asset: RecallAbilityAssetRecord): boolean {
  return asset.type === 'personal'
    && asset.status === 'active'
    && (asset.lifecycleStatus === 'user_confirmed_unverified'
      || asset.lifecycleStatus === 'automatically_extracted_unverified')
    && /^rd_[A-Za-z0-9_-]{8,64}$/.test(asset.reviewDecisionId || '')
    && Boolean(asset.statement.trim());
}

/** Role-template routing remains narrower: ontology-linked Personal assets
 * already have an explicit formal destination and must not be auto-routed. */
function isEligibleTemplateAsset(asset: RecallAbilityAssetRecord): boolean {
  return isEligiblePersonalAsset(asset) && !(asset.ontologyRefs?.length);
}

async function persistProfileMemoryProjection(
  userId: string,
  asset: RecallAbilityAssetRecord,
  fingerprint: string,
  status: PersonalProfileMemoryProjectionRecord['status'],
  details: { recordId?: string; failureMessage?: string } = {},
): Promise<void> {
  const id = profileMemoryProjectionIdFor(asset.id);
  await updateRecallJsonRecord(userId, PROFILE_MEMORY_PROJECTION_COLLECTION, id, (current) => {
    const now = new Date().toISOString();
    const previous = current as PersonalProfileMemoryProjectionRecord | undefined;
    return {
      schemaVersion: 2,
      ownerId: userId,
      id,
      assetId: asset.id,
      assetVersion: asset.version,
      inputFingerprint: fingerprint,
      status,
      ...(details.recordId ? { recordId: details.recordId } : {}),
      ...(details.failureMessage ? { failureMessage: details.failureMessage.slice(0, 1_000) } : {}),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    } satisfies PersonalProfileMemoryProjectionRecord;
  });
}

async function syncProfileMemoryAsset(
  userId: string,
  asset: RecallAbilityAssetRecord,
  writeProfileEntry: typeof ensurePersonalProfileEntry,
): Promise<'written' | 'skipped' | { failed: string }> {
  if (!isEligiblePersonalAsset(asset)) return 'skipped';
  const fingerprint = inputFingerprint(asset);
  try {
    const existing = await readRecallJsonRecord(
      userId,
      PROFILE_MEMORY_PROJECTION_COLLECTION,
      profileMemoryProjectionIdFor(asset.id),
    );
    // A confirmed profile projection is append-only. A later asset revision
    // must be reviewed explicitly instead of silently replacing user-visible
    // identity data.
    if (existing?.status === 'applied') return 'skipped';

    assertNotForbiddenToPersist([asset.statement]);
    const write = writeProfileEntry(userId, asset.id, asset.statement);
    if (!write.ok || !write.record) throw new Error(write.error || 'personal profile write failed');
    await persistProfileMemoryProjection(userId, asset, fingerprint, 'applied', {
      recordId: write.record.recordId,
    });
    return 'written';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('personal profile memory projection failed', { userId, assetId: asset.id, error: message });
    await persistProfileMemoryProjection(userId, asset, fingerprint, 'failed', {
      failureMessage: message,
    }).catch((persistError) => {
      log.warn('personal profile memory projection failure could not be recorded', {
        userId,
        assetId: asset.id,
        error: persistError instanceof Error ? persistError.message : String(persistError),
      });
    });
    return { failed: message };
  }
}

/** Keep automatic writes inside the built-in role-template T-box. */
function tboxCatalog(catalog: TemplateCatalogEntry[]): TemplateCatalogEntry[] {
  const out: TemplateCatalogEntry[] = [];
  for (const entry of catalog) {
    const template = getRoleTemplate(entry.template_id);
    if (!template) continue;
    const fieldsBySection = new Map(template.preset_groups.map((section) => [
      section.title,
      new Set(section.fields.map((field) => field.name)),
    ]));
    const sections = entry.sections.map((section) => ({
      title: section.title,
      fields: section.fields.filter((field) => fieldsBySection.get(section.title)?.has(field)),
    })).filter((section) => section.fields.length > 0);
    if (sections.length) out.push({ ...entry, sections });
  }
  return out;
}

async function persistProjection(
  userId: string,
  asset: RecallAbilityAssetRecord,
  fingerprint: string,
  currentCatalogFingerprint: string,
  status: ProjectionStatus,
  details: {
    templateId?: string;
    groupId?: string;
    section?: string;
    fieldName?: string;
    failureMessage?: string;
  } = {},
): Promise<void> {
  const id = projectionIdFor(asset.id);
  await updateRecallJsonRecord(userId, PROJECTION_COLLECTION, id, (current) => {
    const now = new Date().toISOString();
    const previous = current as PersonalProfileProjectionRecord | undefined;
    return {
      schemaVersion: 2,
      ownerId: userId,
      id,
      assetId: asset.id,
      assetVersion: asset.version,
      inputFingerprint: fingerprint,
      catalogFingerprint: currentCatalogFingerprint,
      status,
      ...(details.templateId ? { templateId: details.templateId } : {}),
      ...(details.groupId ? { groupId: details.groupId } : {}),
      ...(details.section ? { section: details.section } : {}),
      ...(details.fieldName ? { fieldName: details.fieldName } : {}),
      ...(details.failureMessage ? { failureMessage: details.failureMessage.slice(0, 1_000) } : {}),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    } satisfies PersonalProfileProjectionRecord;
  });
}

async function syncAsset(
  userId: string,
  asset: RecallAbilityAssetRecord,
  catalog: TemplateCatalogEntry[],
  deps: Required<Pick<PersonalProfileSyncDependencies, 'routeAsset' | 'appendFieldValue'>>,
  target?: PersonalProfileTarget,
): Promise<'written' | 'skipped' | 'unmatched' | { failed: string }> {
  if (!isEligibleTemplateAsset(asset)) return 'skipped';

  const fingerprint = inputFingerprint(asset);
  const currentCatalogFingerprint = catalogFingerprint(catalog);

  try {
    // A damaged receipt is isolated to this asset so the remaining assets can
    // still be projected during the same synchronization pass.
    const existing = await readRecallJsonRecord(userId, PROJECTION_COLLECTION, projectionIdFor(asset.id));
    if (isSettledForInput(existing, fingerprint, currentCatalogFingerprint, Boolean(target))) return 'skipped';

    // Recheck at the projection boundary because this writes a second user-data view.
    assertNotForbiddenToPersist([asset.statement]);
    const decision = target
      ? { action: 'field' as const, group_title: target.section, field_name: target.fieldName, confidence: 'high' as const }
      : await deps.routeAsset(userId, asset.statement, catalog);
    if (decision.failure) throw new Error(`profile routing ${decision.failure}`);
    if (decision.action !== 'field' || !decision.group_title || !decision.field_name) {
      await persistProjection(userId, asset, fingerprint, currentCatalogFingerprint, 'no_match');
      return 'unmatched';
    }

    const matches = catalog.filter((entry) => entry.sections.some((section) =>
      entry.group_id === (target?.groupId || entry.group_id)
      && section.title === decision.group_title && section.fields.includes(decision.field_name!),
    ));
    if (matches.length !== 1) {
      if (target) throw new Error('profile target field not found');
      await persistProjection(userId, asset, fingerprint, currentCatalogFingerprint, 'no_match');
      return 'unmatched';
    }
    const template = matches[0];
    if (target?.templateId && template.template_id !== target.templateId) {
      throw new Error('profile target template mismatch');
    }

    const write = await deps.appendFieldValue(
      userId,
      buildContentRef(template.group_id, decision.group_title),
      decision.field_name,
      asset.statement,
      '智能',
    );
    if (!write.ok) throw new Error(write.error || 'profile field write failed');

    await persistProjection(userId, asset, fingerprint, currentCatalogFingerprint, 'applied', {
      templateId: template.template_id,
      groupId: template.group_id,
      section: decision.group_title,
      fieldName: decision.field_name,
    });
    return 'written';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('personal profile projection failed', { userId, assetId: asset.id, error: message });
    await persistProjection(userId, asset, fingerprint, currentCatalogFingerprint, 'failed', { failureMessage: message }).catch((persistError) => {
      log.warn('personal profile projection failure could not be recorded', {
        userId,
        assetId: asset.id,
        error: persistError instanceof Error ? persistError.message : String(persistError),
      });
    });
    return { failed: message };
  }
}

/**
 * Fill USER.md and installed role-template fields from active PersonalOntology
 * assets accepted by the user's review or automatic-capture policy. Unmatched
 * template fields do not block the base profile projection and never fall back
 * to an arbitrary field or flow.
 */
export async function syncPersonalProfileFromRecallAssets(
  userId: string,
  dependencies: PersonalProfileSyncDependencies = {},
  options: PersonalProfileSyncOptions = {},
): Promise<PersonalProfileSyncResult> {
  if (!safeId(userId)) throw new Error('invalid user id');
  const listAssets = dependencies.listAssets || listAbilityAssets;
  const listCatalog = dependencies.listCatalog || listTemplateFileCatalog;
  const routeAsset = dependencies.routeAsset || routeCandidateToField;
  const appendFieldValue = dependencies.appendFieldValue || appendExistingTemplateFieldValueToRef;
  const writeProfileEntry = dependencies.writeProfileEntry || ensurePersonalProfileEntry;

  const assets = await listAssets(userId);
  // USER.md is the independent personal-profile projection. A temporary
  // template catalog failure must not prevent confirmed Personal assets from
  // reaching the base profile; template routing can be retried later.
  let rawCatalog: TemplateCatalogEntry[] = [];
  try {
    rawCatalog = await listCatalog(userId);
  } catch (error) {
    log.warn('personal template catalog unavailable; continuing with profile projection', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const catalog = tboxCatalog(rawCatalog);
  const personalAssets = assets
    .filter(isEligiblePersonalAsset)
    .filter((asset) => !options.assetId || asset.id === options.assetId);
  const result: PersonalProfileSyncResult = {
    eligible: personalAssets.length,
    written: 0,
    skipped: 0,
    unmatched: 0,
    failed: [],
    profileWritten: 0,
    profileSkipped: 0,
    profileFailed: [],
  };

  // USER.md is the base personal-profile view and must not depend on a role
  // template being installed. Role-template fields are an optional second
  // projection handled below.
  for (const asset of personalAssets) {
    const outcome = await syncProfileMemoryAsset(userId, asset, writeProfileEntry);
    if (outcome === 'written') result.profileWritten! += 1;
    else if (outcome === 'skipped') result.profileSkipped! += 1;
    else {
      const failure = { assetId: asset.id, error: outcome.failed };
      result.profileFailed!.push(failure);
      result.failed.push(failure);
    }
  }

  if (!catalog.length) {
    if (options.target) {
      result.failed.push(...personalAssets.map((asset) => ({ assetId: asset.id, error: 'no installed personal template fields' })));
    } else {
      result.skipped = personalAssets.length;
    }
    return result;
  }

  for (const asset of personalAssets) {
    const outcome = await syncAsset(userId, asset, catalog, { routeAsset, appendFieldValue }, options.target);
    if (outcome === 'written') result.written += 1;
    else if (outcome === 'skipped') result.skipped += 1;
    else if (outcome === 'unmatched') result.unmatched += 1;
    else result.failed.push({ assetId: asset.id, error: outcome.failed });
  }
  return result;
}

/** De-duplicate automatic renderer-triggered syncs for one user in the main process. */
export function schedulePersonalProfileSync(
  userId: string,
  options: PersonalProfileSyncOptions = {},
): Promise<PersonalProfileSyncResult> {
  const pending = syncsInFlight.get(userId);
  // A page-open background sync may already be running when the user confirms
  // a candidate. Do not drop that confirmation's explicit target (or its new
  // asset); queue a focused pass immediately after the existing read finishes.
  if (pending && (options.assetId || options.target)) {
    const task = pending.then(() => syncPersonalProfileFromRecallAssets(userId, {}, options));
    syncsInFlight.set(userId, task);
    const clear = () => {
      if (syncsInFlight.get(userId) === task) syncsInFlight.delete(userId);
    };
    void task.then(clear, clear);
    return task;
  }
  if (pending) return pending;
  const task = syncPersonalProfileFromRecallAssets(userId, {}, options);
  syncsInFlight.set(userId, task);
  const clear = () => {
    if (syncsInFlight.get(userId) === task) syncsInFlight.delete(userId);
  };
  void task.then(clear, clear);
  return task;
}
