import type { CreatorPresetManifestV1, CreatorPresetLifecycle } from './types';
import { buildCreatorCapabilityCatalog, type CreatorCapabilityDescriptor } from './catalog';
import { verifyCreatorPreset } from './verification-service';
import { sessionLock } from '../../util/locks';
import { getActiveUserId } from '../users';
import {
  activateCreatorPresetVersion,
  appendCreatorLifecycleAudit,
  listCreatorAudit,
  publishCreatorPresetVersion,
  readCreatorDraft,
  readCreatorPresetState,
  readCreatorPresetVersion,
  rollbackCreatorPreset,
  creatorLifecycleStoreLock,
  type CreatorAuditInput,
  type CreatorAuditRecord,
  type CreatorPresetDraft,
} from './store';
import {
  creatorManifestDigest,
  type CreatorVerificationReport,
} from './verification-service';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_VERIFICATION_EVIDENCE = 256;
const MAX_VERIFICATION_EVIDENCE_LENGTH = 4_000;
const MAX_VERIFICATION_SCALAR_LENGTH = 256;
async function defaultMaterializationCheck(
  userId: string,
  presetId: string,
  version: string,
  manifestDigest: string,
): Promise<boolean> {
  const { isCreatorPresetMaterializedForRuntime } = await import('./materializer');
  return isCreatorPresetMaterializedForRuntime(userId, presetId, version, manifestDigest);
}

const VERIFICATION_CHECK_IDS = [
  'schema',
  'catalog-resolution',
  'tool-allow-list',
  'file-grants',
  'side-effects',
  'budget',
  'timeout',
  'cancel',
  'idempotency',
  'audit-trajectory',
  'agent-usefulness',
] as const;

export interface CreatorApprovalInput {
  draftId: string;
  manifestDigest: string;
  verificationRunId: string;
  actorId: string;
  confirmedAt: string;
  approved: boolean;
  approvedCapabilities: string[];
  approvedSideEffects: string[];
}

export interface CreatorPublishInput {
  version: string;
  manifestDigest: string;
  verificationRunId: string;
}

export interface CreatorConfirmationInput {
  actorId: string;
  confirmedAt: string;
}

export interface CreatorLifecycleRecord {
  schemaVersion: 1;
  status: CreatorPresetLifecycle;
  presetId: string;
  manifestDigest: string;
  updatedAt: string;
  draftId?: string;
  version?: string;
  verificationRunId?: string;
  approvalRef?: string;
}

export interface CreatorActiveSnapshot {
  presetId: string;
  version: string;
  manifestDigest: string;
  manifest: Readonly<CreatorPresetManifestV1>;
}

export interface CreatorLifecycleDependencies {
  getActiveUserId?: () => string;
  readDraft?: typeof readCreatorDraft;
  publishVersion?: typeof publishCreatorPresetVersion;
  readVersion?: typeof readCreatorPresetVersion;
  readPresetState?: typeof readCreatorPresetState;
  activateVersion?: typeof activateCreatorPresetVersion;
  rollbackVersion?: typeof rollbackCreatorPreset;
  appendAudit?: (userId: string, input: CreatorAuditInput) => Promise<CreatorAuditRecord>;
  listAudit?: typeof listCreatorAudit;
  isMaterialized?: (
    userId: string,
    presetId: string,
    version: string,
    manifestDigest: string,
  ) => boolean | Promise<boolean>;
  buildCatalog?: (userId: string) => Promise<CreatorCapabilityDescriptor[]>;
  verifyPreset?: (
    userId: string,
    manifest: CreatorPresetManifestV1,
    runId: string,
  ) => Promise<CreatorVerificationReport>;
}

export interface CreatorLifecycleService {
  sandboxPreset(userId: string, draftId: string, manifestDigest: string): Promise<CreatorLifecycleRecord>;
  recordVerification(
    userId: string,
    draftId: string,
    report: CreatorVerificationReport,
  ): Promise<CreatorLifecycleRecord>;
  approvePreset(
    userId: string,
    draftId: string,
    approval: CreatorApprovalInput,
  ): Promise<CreatorLifecycleRecord>;
  rejectPreset(
    userId: string,
    draftId: string,
    confirmation: CreatorConfirmationInput,
  ): Promise<CreatorLifecycleRecord>;
  publishPreset(
    userId: string,
    draftId: string,
    input: CreatorPublishInput,
  ): Promise<CreatorLifecycleRecord>;
  activatePreset(userId: string, presetId: string, version: string): Promise<CreatorLifecycleRecord>;
  disablePreset(
    userId: string,
    presetId: string,
    version: string,
    confirmation: CreatorConfirmationInput,
  ): Promise<CreatorLifecycleRecord>;
  rollbackPreset(
    userId: string,
    presetId: string,
    version: string,
    confirmation: CreatorConfirmationInput,
  ): Promise<CreatorLifecycleRecord>;
  captureActiveSnapshot(userId: string, presetId: string): Promise<CreatorActiveSnapshot>;
}

type AuditMetadata = Record<string, unknown>;

function assertIdentifier(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(code);
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error('creator_manifest_digest_invalid');
}

function assertConfirmation(input: unknown, invalidCode = 'creator_confirmation_invalid'): asserts input is CreatorConfirmationInput {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(invalidCode);
    const value = input as Record<string, unknown>;
    assertIdentifier(value.actorId, 'creator_approval_actor_invalid');
    if (typeof value.confirmedAt !== 'string'
      || value.confirmedAt.length > 32
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.confirmedAt)
      || !Number.isFinite(Date.parse(value.confirmedAt))
      || new Date(value.confirmedAt).toISOString() !== value.confirmedAt) {
      throw new Error('creator_approval_confirmation_invalid');
    }
  } catch (error) {
    if (error instanceof Error && (
      error.message === 'creator_approval_actor_invalid'
      || error.message === 'creator_approval_confirmation_invalid'
      || error.message === invalidCode
    )) throw error;
    throw new Error(invalidCode);
  }
}

function assertApprovalInput(input: unknown): asserts input is CreatorApprovalInput {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    const value = input as Record<string, unknown>;
    if (typeof value.draftId !== 'string' || typeof value.manifestDigest !== 'string'
      || typeof value.verificationRunId !== 'string' || typeof value.approved !== 'boolean'
      || !Array.isArray(value.approvedCapabilities) || !Array.isArray(value.approvedSideEffects)) throw new Error();
  } catch { throw new Error('creator_approval_invalid'); }
}

function assertPublishInput(input: unknown): asserts input is CreatorPublishInput {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    const value = input as Record<string, unknown>;
    if (typeof value.version !== 'string' || typeof value.manifestDigest !== 'string'
      || typeof value.verificationRunId !== 'string') throw new Error();
  } catch { throw new Error('creator_publish_input_invalid'); }
}

function assertVerificationReport(report: unknown): asserts report is CreatorVerificationReport {
  try {
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error();
    const value = report as Record<string, unknown>;
    if (
      value.schemaVersion !== 1
      || typeof value.runId !== 'string'
      || value.runId.length === 0 || value.runId.length > MAX_VERIFICATION_SCALAR_LENGTH
      || typeof value.presetId !== 'string'
      || value.presetId.length === 0 || value.presetId.length > MAX_VERIFICATION_SCALAR_LENGTH
      || typeof value.manifestDigest !== 'string'
      || value.manifestDigest.length > MAX_VERIFICATION_SCALAR_LENGTH || !DIGEST.test(value.manifestDigest)
      || typeof value.status !== 'string'
      || !['passed', 'failed', 'cancelled'].includes(value.status)
      || typeof value.startedAt !== 'string'
      || value.startedAt.length > MAX_VERIFICATION_SCALAR_LENGTH
      || !Number.isFinite(Date.parse(value.startedAt))
      || typeof value.completedAt !== 'string'
      || value.completedAt.length > MAX_VERIFICATION_SCALAR_LENGTH
      || !Number.isFinite(Date.parse(value.completedAt))
      || !Array.isArray(value.checks)
      || value.checks.length !== VERIFICATION_CHECK_IDS.length
    ) throw new Error();

  for (let index = 0; index < VERIFICATION_CHECK_IDS.length; index += 1) {
      const item = value.checks[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error();
      const check = item as Record<string, unknown>;
      if (
        check.id !== VERIFICATION_CHECK_IDS[index]
        || (check.status !== 'passed' && check.status !== 'failed')
        || !Array.isArray(check.evidence)
        || check.evidence.length > MAX_VERIFICATION_EVIDENCE
      ) throw new Error();
      let evidenceLength: number;
      try { evidenceLength = check.evidence.length; } catch { throw new Error(); }
      if (!Number.isSafeInteger(evidenceLength) || evidenceLength < 0 || evidenceLength > MAX_VERIFICATION_EVIDENCE) throw new Error();
      for (let evidenceIndex = 0; evidenceIndex < evidenceLength; evidenceIndex += 1) {
        if (!Object.prototype.hasOwnProperty.call(check.evidence, evidenceIndex)) throw new Error();
        const entry = check.evidence[evidenceIndex];
        if (typeof entry !== 'string' || entry.length > MAX_VERIFICATION_EVIDENCE_LENGTH) throw new Error();
      }
    }
  } catch {
    throw new Error('creator_verification_report_invalid');
  }
}

function metadata(record: CreatorAuditRecord): AuditMetadata {
  return record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata as AuditMetadata
    : {};
}

function exactStringArray(actual: unknown, expected: readonly string[]): boolean {
  try {
    if (!Array.isArray(actual) || actual.length > expected.length) return false;
    const left: string[] = [];
    for (let index = 0; index < actual.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(actual, index)) return false;
      const value = actual[index];
      if (typeof value !== 'string' || value.length > 128) return false;
      left.push(value);
    }
    const right = expected.length <= 128 ? [...expected] : [];
    left.sort();
    right.sort();
    return left.length === right.length && left.every((value, index) => value === right[index]);
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneFrozen<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

function draftStatus(records: readonly CreatorAuditRecord[], draftId: string): CreatorPresetLifecycle {
  const statuses: Array<[string, CreatorPresetLifecycle]> = [
    ['creator.lifecycle.sandboxed', 'sandboxed'],
    ['creator.lifecycle.verified', 'verified'],
    ['creator.lifecycle.approved', 'approved'],
    ['creator.lifecycle.rejected', 'rejected'],
    ['creator.lifecycle.published', 'published'],
  ];
  let latestSave: { index: number; manifestDigest?: string } | undefined;
  let latestLifecycle: { index: number; status: CreatorPresetLifecycle; manifestDigest?: string } | undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.draftId !== draftId) continue;
    if (record.event === 'draft.saved' && !latestSave) {
      const digest = metadata(record).manifestDigest;
      latestSave = { index, ...(typeof digest === 'string' ? { manifestDigest: digest } : {}) };
      continue;
    }
    if (!latestLifecycle && record.event === 'creator.verification.recorded' && metadata(record).status === 'passed') {
      latestLifecycle = { index, status: 'verified', manifestDigest: metadata(record).manifestDigest as string | undefined };
      continue;
    }
    const match = statuses.find(([event]) => event === record.event);
    if (!latestLifecycle && match) {
      const digest = metadata(record).manifestDigest;
      latestLifecycle = { index, status: match[1], ...(typeof digest === 'string' ? { manifestDigest: digest } : {}) };
    }
  }
  if (!latestLifecycle) return 'draft';
  if (latestSave && latestSave.index > latestLifecycle.index
    && (!latestSave.manifestDigest || latestSave.manifestDigest !== latestLifecycle.manifestDigest)) return 'draft';
  return latestLifecycle.status;
}

function verificationRecord(
  records: readonly CreatorAuditRecord[],
  draftId: string,
  runId: string,
): AuditMetadata | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const value = metadata(record);
    if (
      record.event === 'creator.verification.recorded'
      && record.draftId === draftId
      && value.verificationRunId === runId
    ) return value;
  }
  return undefined;
}

function approvalRecord(records: readonly CreatorAuditRecord[], draftId: string): AuditMetadata | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.event === 'creator.lifecycle.approved' && record.draftId === draftId) {
      return metadata(record);
    }
  }
  return undefined;
}

function versionEvents(
  records: readonly CreatorAuditRecord[],
  presetId: string,
  version: string,
): CreatorAuditRecord[] {
  return records.filter((record) => record.presetId === presetId && record.version === version && (
    record.event === 'creator.lifecycle.published'
    || record.event === 'creator.lifecycle.active'
    || record.event === 'creator.lifecycle.disabled'
    || record.event === 'creator.lifecycle.rolled_back'
  ));
}

function hasPublishedVersion(
  records: readonly CreatorAuditRecord[],
  presetId: string,
  version: string,
): boolean {
  return versionEvents(records, presetId, version)
    .some((record) => record.event === 'creator.lifecycle.published');
}

function storePublishCommitted(
  records: readonly CreatorAuditRecord[],
  draftId: string,
  presetId: string,
  version: string,
): boolean {
  return records.some((record) => record.event === 'preset.version_published'
    && record.draftId === draftId
    && record.presetId === presetId
    && record.version === version);
}

interface PendingRollback {
  fromVersion: string;
  lifecycleAuditCommitted: boolean;
}

function pendingRollback(
  records: readonly CreatorAuditRecord[],
  presetId: string,
  targetVersion: string,
): PendingRollback | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const value = metadata(record);
    if (
      record.event !== 'preset.rolled_back'
      || record.presetId !== presetId
      || record.version !== targetVersion
      || typeof value.fromVersion !== 'string'
    ) continue;
    const fromVersion = value.fromVersion;
    const later = records.slice(index + 1);
    const completed = later.some((candidate) => candidate.event === 'creator.lifecycle.active'
      && candidate.presetId === presetId
      && candidate.version === targetVersion
      && metadata(candidate).rolledBackFromVersion === fromVersion);
    if (completed) return undefined;
    const lifecycleAuditCommitted = later.some((candidate) => candidate.event === 'creator.lifecycle.rolled_back'
      && candidate.presetId === presetId
      && candidate.version === fromVersion
      && metadata(candidate).targetVersion === targetVersion);
    return { fromVersion, lifecycleAuditCommitted };
  }
  return undefined;
}

function activationMutationCommitted(
  records: readonly CreatorAuditRecord[],
  presetId: string,
  version: string,
): boolean {
  let publishedIndex = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.event === 'creator.lifecycle.published'
      && record.presetId === presetId
      && record.version === version) {
      publishedIndex = index;
      break;
    }
  }
  if (publishedIndex < 0) return false;
  return records.slice(publishedIndex + 1).some((record) => record.event === 'preset.activated'
    && record.presetId === presetId
    && record.version === version);
}

function latestVersionStatus(
  records: readonly CreatorAuditRecord[],
  presetId: string,
  version: string,
): CreatorPresetLifecycle | undefined {
  const latest = versionEvents(records, presetId, version).at(-1);
  if (!latest) return undefined;
  if (latest.event === 'creator.lifecycle.published') return 'published';
  if (latest.event === 'creator.lifecycle.active') return 'active';
  if (latest.event === 'creator.lifecycle.disabled') return 'disabled';
  return 'rolled_back';
}

function latestLifecycleAudit(
  records: readonly CreatorAuditRecord[],
  event: string,
  presetId: string,
  version: string,
  draftId?: string,
): CreatorAuditRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.event === event && record.presetId === presetId && record.version === version
      && (draftId === undefined || record.draftId === draftId)) return record;
  }
  return undefined;
}

function latestDraftLifecycleAudit(
  records: readonly CreatorAuditRecord[],
  event: string,
  draftId: string,
): CreatorAuditRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.event === event && record.draftId === draftId) return record;
  }
  return undefined;
}

function lifecycleRecord(
  status: CreatorPresetLifecycle,
  manifest: CreatorPresetManifestV1,
  updatedAt: string,
  fields: { draftId?: string; version?: string; verificationRunId?: string; approvalRef?: string } = {},
): CreatorLifecycleRecord {
  return {
    schemaVersion: 1,
    status,
    presetId: manifest.presetId,
    manifestDigest: creatorManifestDigest(manifest),
    updatedAt,
    ...fields,
  };
}

function assertApprovalScope(manifest: CreatorPresetManifestV1, approval: CreatorApprovalInput): void {
  const expectedCapabilities = manifest.capabilities.map((item) => item.capabilityId);
  if (
    !exactStringArray(approval.approvedCapabilities, expectedCapabilities)
    || !exactStringArray(approval.approvedSideEffects, manifest.permissions.sideEffects)
  ) throw new Error('creator_approval_scope_mismatch');
}

function lifecycleLock(userId: string, key: string) {
  void key;
  return sessionLock(`creator-lifecycle:${userId}`);
}

function assertLifecycleUser(userId: unknown, getActive: () => string): asserts userId is string {
  if (typeof userId !== 'string' || userId.length === 0 || userId === '.' || userId === '..' || /[\\/]/.test(userId)) {
    throw new Error('creator_user_not_active');
  }
  let active: string;
  try { active = getActive(); } catch { throw new Error('creator_user_not_active'); }
  if (active !== userId) throw new Error('creator_user_not_active');
}

async function requireDraft(
  readDraft: typeof readCreatorDraft,
  userId: string,
  draftId: string,
): Promise<CreatorPresetDraft> {
  assertIdentifier(draftId, 'creator_invalid_draft_id');
  const draft = await readDraft(userId, draftId);
  if (!draft) throw new Error('creator_draft_not_found');
  return draft;
}

export function createCreatorLifecycleService(
  deps: CreatorLifecycleDependencies = {},
): CreatorLifecycleService {
  const readDraft = deps.readDraft ?? readCreatorDraft;
  const publishVersion = deps.publishVersion ?? publishCreatorPresetVersion;
  const readVersion = deps.readVersion ?? readCreatorPresetVersion;
  const readPresetState = deps.readPresetState ?? readCreatorPresetState;
  const activateVersion = deps.activateVersion ?? activateCreatorPresetVersion;
  const rollbackVersion = deps.rollbackVersion ?? rollbackCreatorPreset;
  const appendAudit = deps.appendAudit ?? appendCreatorLifecycleAudit;
  const listAudit = deps.listAudit ?? listCreatorAudit;
  const isMaterialized = deps.isMaterialized ?? defaultMaterializationCheck;
  const getActive = deps.getActiveUserId ?? getActiveUserId;
  const verifyPreset = deps.verifyPreset ?? (async (userId: string, manifest: CreatorPresetManifestV1, runId: string) => {
    const catalog = await (deps.buildCatalog ?? buildCreatorCapabilityCatalog)(userId);
    return verifyCreatorPreset(userId, { manifest, catalogSnapshot: catalog }, {
      createId: () => runId,
      buildCatalog: async () => catalog,
    });
  });

  const trustedVerification = async (
    userId: string,
    manifest: CreatorPresetManifestV1,
    runId: string,
  ): Promise<CreatorVerificationReport> => {
    const report = await verifyPreset(userId, manifest, runId);
    assertVerificationReport(report);
    if (report.runId !== runId || report.presetId !== manifest.presetId
      || report.manifestDigest !== creatorManifestDigest(manifest)) {
      throw new Error('creator_verification_binding_invalid');
    }
    return report;
  };

  return {
    async sandboxPreset(userId, draftId, manifestDigest) {
      assertLifecycleUser(userId, getActive);
      return lifecycleLock(userId, `draft:${draftId}`).runExclusive(async () => {
        assertDigest(manifestDigest);
        const draft = await requireDraft(readDraft, userId, draftId);
        if (creatorManifestDigest(draft.manifest) !== manifestDigest) throw new Error('creator_manifest_digest_mismatch');
        const records = await listAudit(userId);
        if (draftStatus(records, draftId) !== 'draft') throw new Error('creator_lifecycle_transition_invalid');
        const audit = await appendAudit(userId, { event: 'creator.lifecycle.sandboxed', draftId, presetId: draft.manifest.presetId, metadata: { manifestDigest } });
        return lifecycleRecord('sandboxed', draft.manifest, audit.createdAt, { draftId });
      });
    },

    async recordVerification(userId, draftId, report) {
      assertLifecycleUser(userId, getActive);
      return lifecycleLock(userId, `draft:${draftId}`).runExclusive(async () => {
        assertVerificationReport(report);
        assertIdentifier(report.runId, 'creator_verification_run_invalid');
        const draft = await requireDraft(readDraft, userId, draftId);
        const records = await listAudit(userId);
        const digest = creatorManifestDigest(draft.manifest);
        if (report.presetId !== draft.manifest.presetId || report.manifestDigest !== digest) throw new Error('creator_manifest_digest_mismatch');
        const status = draftStatus(records, draftId);
        const existing = verificationRecord(records, draftId, report.runId);
        if (existing && status !== 'sandboxed' && status !== 'verified') {
          throw new Error('creator_lifecycle_transition_invalid');
        }
        if (!existing && status !== 'sandboxed') throw new Error('creator_lifecycle_transition_invalid');
        if (existing && existing.manifestDigest !== digest) throw new Error('creator_manifest_digest_mismatch');
        const trusted = existing ? undefined : await trustedVerification(userId, draft.manifest, report.runId);
        if (!existing) await appendAudit(userId, {
          event: 'creator.verification.recorded',
          draftId,
          presetId: draft.manifest.presetId,
          metadata: {
            verificationRunId: trusted!.runId,
            manifestDigest: trusted!.manifestDigest,
            status: trusted!.status,
          },
        });
        const passed = existing?.status === 'passed'
          || (trusted?.status === 'passed' && trusted.checks.every((item) => item.status === 'passed'));
        if (!passed) {
          return lifecycleRecord('sandboxed', draft.manifest, trusted?.completedAt ?? new Date().toISOString(), {
            draftId, verificationRunId: report.runId,
          });
        }
        if (existing && records.some((entry) => entry.event === 'creator.lifecycle.verified'
          && entry.draftId === draftId && metadata(entry).verificationRunId === report.runId)) {
          return lifecycleRecord('verified', draft.manifest, new Date().toISOString(), {
            draftId, verificationRunId: report.runId,
          });
        }
        const audit = await appendAudit(userId, {
        event: 'creator.lifecycle.verified',
        draftId,
        presetId: draft.manifest.presetId,
          metadata: { verificationRunId: report.runId, manifestDigest: digest },
        });
        return lifecycleRecord('verified', draft.manifest, audit.createdAt, {
          draftId, verificationRunId: report.runId,
        });
      });
    },

    async approvePreset(userId, draftId, approval) {
      assertLifecycleUser(userId, getActive);
      return lifecycleLock(userId, `draft:${draftId}`).runExclusive(async () => {
      assertApprovalInput(approval);
      if (approval.draftId !== draftId) throw new Error('creator_approval_draft_mismatch');
      assertDigest(approval.manifestDigest);
      assertIdentifier(approval.verificationRunId, 'creator_verification_run_invalid');
      assertConfirmation(approval, 'creator_approval_invalid');
      if (approval.approved !== true) throw new Error('creator_approval_required');
      const draft = await requireDraft(readDraft, userId, draftId);
      const digest = creatorManifestDigest(draft.manifest);
      if (approval.manifestDigest !== digest) throw new Error('creator_manifest_digest_mismatch');
      assertApprovalScope(draft.manifest, approval);
      const records = await listAudit(userId);
      const previousApproval = approvalRecord(records, draftId);
      if (previousApproval) {
        if (draftStatus(records, draftId) !== 'approved') throw new Error('creator_lifecycle_transition_invalid');
        const priorAudit = latestDraftLifecycleAudit(records, 'creator.lifecycle.approved', draftId);
        if (priorAudit
          && previousApproval.manifestDigest === digest
          && previousApproval.verificationRunId === approval.verificationRunId
          && previousApproval.actorId === approval.actorId
          && previousApproval.confirmedAt === approval.confirmedAt
          && exactStringArray(previousApproval.approvedCapabilities, approval.approvedCapabilities)
          && exactStringArray(previousApproval.approvedSideEffects, approval.approvedSideEffects)) {
          return lifecycleRecord('approved', draft.manifest, priorAudit.createdAt, {
            draftId,
            verificationRunId: approval.verificationRunId,
            approvalRef: priorAudit.auditId,
          });
        }
        throw new Error('creator_approval_stale');
      }
      const verification = verificationRecord(records, draftId, approval.verificationRunId);
      if (!verification) throw new Error('creator_verification_required');
      const trusted = await trustedVerification(userId, draft.manifest, approval.verificationRunId);
      if (trusted.status !== 'passed' || trusted.checks.some((item) => item.status !== 'passed')) throw new Error('creator_verification_not_passed');
      if (verification.manifestDigest !== digest) throw new Error('creator_manifest_digest_mismatch');
      if (draftStatus(records, draftId) !== 'verified') throw new Error('creator_lifecycle_transition_invalid');
      const audit = await appendAudit(userId, {
        event: 'creator.lifecycle.approved',
        draftId,
        presetId: draft.manifest.presetId,
        metadata: {
          manifestDigest: digest,
          verificationRunId: approval.verificationRunId,
          actorId: approval.actorId,
          confirmedAt: approval.confirmedAt,
          approvedCapabilities: approval.approvedCapabilities,
          approvedSideEffects: approval.approvedSideEffects,
        },
      });
      return lifecycleRecord('approved', draft.manifest, audit.createdAt, {
        draftId,
        verificationRunId: approval.verificationRunId,
        approvalRef: audit.auditId,
      });
      });
    },

    async rejectPreset(userId, draftId, confirmation) {
      assertLifecycleUser(userId, getActive);
      return lifecycleLock(userId, `draft:${draftId}`).runExclusive(async () => {
      assertConfirmation(confirmation);
      const draft = await requireDraft(readDraft, userId, draftId);
      const records = await listAudit(userId);
      if (draftStatus(records, draftId) === 'rejected') {
        const priorAudit = latestDraftLifecycleAudit(records, 'creator.lifecycle.rejected', draftId);
        const prior = priorAudit ? metadata(priorAudit) : {};
        if (priorAudit && prior.actorId === confirmation.actorId && prior.confirmedAt === confirmation.confirmedAt) {
          return lifecycleRecord('rejected', draft.manifest, priorAudit.createdAt, { draftId });
        }
        throw new Error('creator_lifecycle_transition_invalid');
      }
      if (draftStatus(records, draftId) !== 'approved') throw new Error('creator_lifecycle_transition_invalid');
      const audit = await appendAudit(userId, {
        event: 'creator.lifecycle.rejected',
        draftId,
        presetId: draft.manifest.presetId,
        metadata: confirmation,
      });
      return lifecycleRecord('rejected', draft.manifest, audit.createdAt, { draftId });
      });
    },

    async publishPreset(userId, draftId, input) {
      assertLifecycleUser(userId, getActive);
      return lifecycleLock(userId, `draft:${draftId}`).runExclusive(async () => {
      const releaseStoreLock = await creatorLifecycleStoreLock(userId).acquire();
      try {
      assertPublishInput(input);
      assertIdentifier(input.version, 'creator_invalid_version');
      assertDigest(input.manifestDigest);
      assertIdentifier(input.verificationRunId, 'creator_verification_run_invalid');
      const draft = await requireDraft(readDraft, userId, draftId);
      const digest = creatorManifestDigest(draft.manifest);
      if (input.manifestDigest !== digest) throw new Error('creator_manifest_digest_mismatch');
      const records = await listAudit(userId);
      const expected = { ...draft.manifest, version: input.version };
      const existing = await readVersion(userId, draft.manifest.presetId, input.version);
      if (existing) {
        if (
          !storePublishCommitted(records, draftId, draft.manifest.presetId, input.version)
          || creatorManifestDigest(existing) !== creatorManifestDigest(expected)
        ) throw new Error('creator_preset_version_exists');
        const priorAudit = latestLifecycleAudit(records, 'creator.lifecycle.published', draft.manifest.presetId, input.version, draftId);
        if (priorAudit && metadata(priorAudit).verificationRunId === input.verificationRunId) {
          return lifecycleRecord('published', existing, priorAudit.createdAt, {
            draftId,
            version: existing.version,
            verificationRunId: input.verificationRunId,
          });
        }
        if (priorAudit) throw new Error('creator_verification_binding_invalid');
      }
      const verification = verificationRecord(records, draftId, input.verificationRunId);
      if (!verification) throw new Error('creator_verification_required');
      const trusted = await trustedVerification(userId, draft.manifest, input.verificationRunId);
      if (trusted.status !== 'passed' || trusted.checks.some((item) => item.status !== 'passed')) throw new Error('creator_verification_not_passed');
      if (verification.manifestDigest !== digest) throw new Error('creator_manifest_digest_mismatch');
      const approved = approvalRecord(records, draftId);
      if (!approved || draftStatus(records, draftId) !== 'approved') throw new Error('creator_approval_required');
      if (
        approved.manifestDigest !== digest
        || approved.verificationRunId !== input.verificationRunId
        || typeof approved.actorId !== 'string'
        || typeof approved.confirmedAt !== 'string'
      ) throw new Error('creator_approval_stale');
      const finalTrusted = await trustedVerification(userId, expected, input.verificationRunId);
      if (finalTrusted.status !== 'passed' || finalTrusted.checks.some((item) => item.status !== 'passed')) {
        throw new Error('creator_verification_not_passed');
      }
      const finalDigest = creatorManifestDigest(expected);
      if (finalTrusted.manifestDigest !== finalDigest) throw new Error('creator_verification_binding_invalid');
      let published: CreatorPresetManifestV1;
      if (existing) {
        published = existing;
      } else {
        published = await publishVersion(userId, draftId, input.version, digest, { lifecycleLockHeld: true });
      }
      const publishedDigest = creatorManifestDigest(published);
      if (published.version !== input.version || publishedDigest !== finalDigest || publishedDigest !== finalTrusted.manifestDigest) {
        throw new Error('creator_manifest_digest_mismatch');
      }
      const audit = await appendAudit(userId, {
          event: 'creator.lifecycle.published',
          draftId,
          presetId: published.presetId,
          version: published.version,
          metadata: {
            manifestDigest: publishedDigest,
            draftManifestDigest: digest,
            verificationRunId: input.verificationRunId,
          },
      });
      return lifecycleRecord('published', published, audit.createdAt, {
        draftId,
        version: published.version,
        verificationRunId: input.verificationRunId,
      });
      } finally {
        releaseStoreLock();
      }
      });
    },

    async activatePreset(userId, presetId, version) {
      assertLifecycleUser(userId, getActive);
      return lifecycleLock(userId, `preset:${presetId}`).runExclusive(async () => {
      assertIdentifier(presetId, 'creator_invalid_preset_id');
      assertIdentifier(version, 'creator_invalid_version');
      const manifest = await readVersion(userId, presetId, version);
      const records = await listAudit(userId);
      const state = await readPresetState(userId, presetId);
      if (!manifest || !hasPublishedVersion(records, presetId, version)) {
        throw new Error('creator_preset_version_not_published');
      }
      if (state.activeVersion === version && latestVersionStatus(records, presetId, version) === 'active'
        && activationMutationCommitted(records, presetId, version)) {
        const priorAudit = latestLifecycleAudit(records, 'creator.lifecycle.active', presetId, version);
        return lifecycleRecord('active', manifest, priorAudit?.createdAt ?? new Date().toISOString(), { version });
      }
      if (latestVersionStatus(records, presetId, version) !== 'published') {
        throw new Error('creator_preset_version_not_published');
      }
      const digest = creatorManifestDigest(manifest);
      if (!await isMaterialized(userId, presetId, version, digest)) {
        throw new Error('creator_preset_not_materialized');
      }
      if (state.activeVersion !== version || !activationMutationCommitted(records, presetId, version)) {
        await activateVersion(userId, presetId, version);
      }
      const audit = await appendAudit(userId, {
        event: 'creator.lifecycle.active',
        presetId,
        version,
        metadata: { manifestDigest: digest },
      });
      return lifecycleRecord('active', manifest, audit.createdAt, { version });
      });
    },

    async disablePreset(userId, presetId, version, confirmation) {
      assertLifecycleUser(userId, getActive);
      return lifecycleLock(userId, `preset:${presetId}`).runExclusive(async () => {
      assertIdentifier(presetId, 'creator_invalid_preset_id');
      assertIdentifier(version, 'creator_invalid_version');
      assertConfirmation(confirmation);
      const manifest = await readVersion(userId, presetId, version);
      const records = await listAudit(userId);
      const status = latestVersionStatus(records, presetId, version);
      if (status === 'disabled' && manifest) {
        const priorAudit = latestLifecycleAudit(records, 'creator.lifecycle.disabled', presetId, version);
        return lifecycleRecord('disabled', manifest, priorAudit?.createdAt ?? new Date().toISOString(), { version });
      }
      if (
        !manifest
        || !hasPublishedVersion(records, presetId, version)
        || (status !== 'published' && status !== 'active')
      ) {
        throw new Error('creator_lifecycle_transition_invalid');
      }
      const audit = await appendAudit(userId, {
        event: 'creator.lifecycle.disabled',
        presetId,
        version,
        metadata: {
          manifestDigest: creatorManifestDigest(manifest),
          actorId: confirmation.actorId,
          confirmedAt: confirmation.confirmedAt,
        },
      });
      return lifecycleRecord('disabled', manifest, audit.createdAt, { version });
      });
    },

    async rollbackPreset(userId, presetId, version, confirmation) {
      assertLifecycleUser(userId, getActive);
      return lifecycleLock(userId, `preset:${presetId}`).runExclusive(async () => {
      assertIdentifier(presetId, 'creator_invalid_preset_id');
      assertIdentifier(version, 'creator_invalid_version');
      assertConfirmation(confirmation);
      const state = await readPresetState(userId, presetId);
      const records = await listAudit(userId);
      const recovery = state.activeVersion === version
        ? pendingRollback(records, presetId, version)
        : undefined;
      if (state.activeVersion === version && !recovery) {
        const priorAudit = latestLifecycleAudit(records, 'creator.lifecycle.active', presetId, version);
        if (priorAudit && metadata(priorAudit).rolledBackFromVersion !== undefined) {
          const target = await readVersion(userId, presetId, version);
          if (!target) throw new Error('creator_active_preset_corrupt');
          return lifecycleRecord('active', target, priorAudit.createdAt, { version });
        }
      }
      const fromVersion = recovery?.fromVersion ?? state.activeVersion;
      if (!fromVersion || (fromVersion === version && !recovery)) {
        throw new Error('creator_lifecycle_transition_invalid');
      }
      const target = await readVersion(userId, presetId, version);
      if (
        !target
        || !hasPublishedVersion(records, presetId, version)
        || latestVersionStatus(records, presetId, version) === 'disabled'
      ) throw new Error('creator_preset_version_not_published');
      const targetDigest = creatorManifestDigest(target);
      if (!await isMaterialized(userId, presetId, version, targetDigest)) {
        throw new Error('creator_preset_not_materialized');
      }
      const source = await readVersion(userId, presetId, fromVersion);
      if (!source) throw new Error('creator_active_preset_corrupt');
      if (!recovery) await rollbackVersion(userId, presetId, version);
      if (!recovery?.lifecycleAuditCommitted) {
        await appendAudit(userId, {
          event: 'creator.lifecycle.rolled_back',
          presetId,
          version: fromVersion,
          metadata: {
            manifestDigest: creatorManifestDigest(source),
            targetVersion: version,
            actorId: confirmation.actorId,
            confirmedAt: confirmation.confirmedAt,
          },
        });
      }
      const audit = await appendAudit(userId, {
        event: 'creator.lifecycle.active',
        presetId,
        version,
        metadata: {
          manifestDigest: targetDigest,
          rolledBackFromVersion: fromVersion,
        },
      });
      return lifecycleRecord('active', target, audit.createdAt, { version });
      });
    },

    async captureActiveSnapshot(userId, presetId) {
      assertLifecycleUser(userId, getActive);
      return lifecycleLock(userId, `preset:${presetId}`).runExclusive(async () => {
        assertIdentifier(presetId, 'creator_invalid_preset_id');
        const state = await readPresetState(userId, presetId);
        if (!state.activeVersion) throw new Error('creator_preset_not_active');
        const records = await listAudit(userId);
        if (latestVersionStatus(records, presetId, state.activeVersion) !== 'active') {
          throw new Error('creator_preset_not_active');
        }
        const manifest = await readVersion(userId, presetId, state.activeVersion);
        if (!manifest) throw new Error('creator_active_preset_corrupt');
        return deepFreeze({
          presetId,
          version: state.activeVersion,
          manifestDigest: creatorManifestDigest(manifest),
          manifest: cloneFrozen(manifest),
        });
      });
    },
  };
}
