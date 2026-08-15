/**
 * Projects confirmed PersonalOntology assets into installed role-template fields.
 * This is intentionally a one-way, additive view: the formal asset remains the
 * source of truth and Rule / Template / Skill assets never enter this flow.
 */

import { createHash } from 'node:crypto';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
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

export interface PersonalProfileSyncResult {
  eligible: number;
  written: number;
  skipped: number;
  unmatched: number;
  failed: Array<{ assetId: string; error: string }>;
}

export interface PersonalProfileSyncDependencies {
  listAssets?: (userId: string) => Promise<RecallAbilityAssetRecord[]>;
  listCatalog?: (userId: string) => Promise<TemplateCatalogEntry[]>;
  routeAsset?: (userId: string, statement: string, catalog: TemplateCatalogEntry[]) => Promise<RouteDecision>;
  appendFieldValue?: typeof appendExistingTemplateFieldValueToRef;
}

const syncsInFlight = new Map<string, Promise<PersonalProfileSyncResult>>();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function projectionIdFor(assetId: string): string {
  return `profile-${sha256(assetId).slice(0, 24)}`;
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
): boolean {
  if (!record) return false;
  // An applied projection is append-only. Asset updates require an explicit
  // review flow rather than silently adding a second, potentially conflicting
  // profile value.
  if (record.status === 'applied') return true;
  if (record.inputFingerprint !== fingerprint) return false;
  return record.status === 'no_match' && record.catalogFingerprint === currentCatalogFingerprint;
}

function isEligiblePersonalAsset(asset: RecallAbilityAssetRecord): boolean {
  return asset.type === 'personal'
    && asset.status === 'active'
    && asset.lifecycleStatus === 'user_confirmed_unverified'
    && /^rd_[A-Za-z0-9_-]{8,64}$/.test(asset.reviewDecisionId || '')
    && !(asset.ontologyRefs?.length)
    && Boolean(asset.statement.trim());
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
): Promise<'written' | 'skipped' | 'unmatched' | { failed: string }> {
  if (!isEligiblePersonalAsset(asset)) return 'skipped';

  const fingerprint = inputFingerprint(asset);
  const currentCatalogFingerprint = catalogFingerprint(catalog);

  try {
    // A damaged receipt is isolated to this asset so the remaining assets can
    // still be projected during the same synchronization pass.
    const existing = await readRecallJsonRecord(userId, PROJECTION_COLLECTION, projectionIdFor(asset.id));
    if (isSettledForInput(existing, fingerprint, currentCatalogFingerprint)) return 'skipped';

    // Recheck at the projection boundary because this writes a second user-data view.
    assertNotForbiddenToPersist([asset.statement]);
    const decision = await deps.routeAsset(userId, asset.statement, catalog);
    if (decision.failure) throw new Error(`profile routing ${decision.failure}`);
    if (decision.action !== 'field' || !decision.group_title || !decision.field_name) {
      await persistProjection(userId, asset, fingerprint, currentCatalogFingerprint, 'no_match');
      return 'unmatched';
    }

    const matches = catalog.filter((entry) => entry.sections.some((section) =>
      section.title === decision.group_title && section.fields.includes(decision.field_name!),
    ));
    if (matches.length !== 1) {
      await persistProjection(userId, asset, fingerprint, currentCatalogFingerprint, 'no_match');
      return 'unmatched';
    }
    const template = matches[0];

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
 * Fill installed role-template fields from active, confirmed PersonalOntology assets.
 * Unmatched assets are kept as formal Recall assets; no fallback writes to a field or flow.
 */
export async function syncPersonalProfileFromRecallAssets(
  userId: string,
  dependencies: PersonalProfileSyncDependencies = {},
): Promise<PersonalProfileSyncResult> {
  if (!safeId(userId)) throw new Error('invalid user id');
  const listAssets = dependencies.listAssets || listAbilityAssets;
  const listCatalog = dependencies.listCatalog || listTemplateFileCatalog;
  const routeAsset = dependencies.routeAsset || routeCandidateToField;
  const appendFieldValue = dependencies.appendFieldValue || appendExistingTemplateFieldValueToRef;

  const [assets, rawCatalog] = await Promise.all([listAssets(userId), listCatalog(userId)]);
  const catalog = tboxCatalog(rawCatalog);
  const personalAssets = assets.filter(isEligiblePersonalAsset);
  const result: PersonalProfileSyncResult = {
    eligible: personalAssets.length,
    written: 0,
    skipped: 0,
    unmatched: 0,
    failed: [],
  };

  if (!catalog.length) {
    result.skipped = personalAssets.length;
    return result;
  }

  for (const asset of personalAssets) {
    const outcome = await syncAsset(userId, asset, catalog, { routeAsset, appendFieldValue });
    if (outcome === 'written') result.written += 1;
    else if (outcome === 'skipped') result.skipped += 1;
    else if (outcome === 'unmatched') result.unmatched += 1;
    else result.failed.push({ assetId: asset.id, error: outcome.failed });
  }
  return result;
}

/** De-duplicate automatic renderer-triggered syncs for one user in the main process. */
export function schedulePersonalProfileSync(userId: string): Promise<PersonalProfileSyncResult> {
  const pending = syncsInFlight.get(userId);
  if (pending) return pending;
  const task = syncPersonalProfileFromRecallAssets(userId);
  syncsInFlight.set(userId, task);
  const clear = () => {
    if (syncsInFlight.get(userId) === task) syncsInFlight.delete(userId);
  };
  void task.then(clear, clear);
  return task;
}
