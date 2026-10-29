import { randomUUID } from 'node:crypto';
import { fileEditLock } from '../../util/locks';
import { recallJsonRecordPath } from './paths';
import {
  readRecallJsonRecord,
  updateRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';

const SETTINGS_COLLECTION = 'capture-settings';
const SETTINGS_ID = 'settings';
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type RecallCaptureExecutionPolicy = 'smart' | 'nightly' | 'manual';
export type RecallCaptureReviewPolicy = 'auto' | 'manual';
type StoredRecallCaptureExecutionPolicy = RecallCaptureExecutionPolicy | 'immediate';

export interface RecallCaptureModelCandidate { provider: string; model: string; }

export interface RecallCaptureSettingsRecord extends RecallJsonRecord {
  id: typeof SETTINGS_ID;
  modelCandidates: RecallCaptureModelCandidate[];
  enabled: boolean;
  autoApproval: boolean;
  autoApprovalEnabledAt?: string;
  autoApprovalEpoch?: string;
  autoApprovalPolicyVersion?: 2;
  executionPolicy: RecallCaptureExecutionPolicy;
  reviewPolicy: RecallCaptureReviewPolicy;
  quietMinutes: number;
  nightlyStart: string;
  nightlyEnd: string;
  catchUpMissed: boolean;
  updatedAt: string;
}

export interface UpdateRecallCaptureSettingsInput {
  modelCandidates?: RecallCaptureModelCandidate[];
  enabled?: boolean;
  autoApproval?: boolean;
  executionPolicy?: StoredRecallCaptureExecutionPolicy;
  reviewPolicy?: RecallCaptureReviewPolicy;
  quietMinutes?: number;
  nightlyStart?: string;
  nightlyEnd?: string;
}

const DEFAULT_SETTINGS = Object.freeze({
  modelCandidates: [] as RecallCaptureModelCandidate[],
  enabled: true,
  autoApproval: false,
  // One nightly pipeline; automatic confirmation requires a fresh explicit opt-in.
  executionPolicy: 'nightly' as const,
  reviewPolicy: 'manual' as const,
  quietMinutes: 10,
  nightlyStart: '02:00',
  nightlyEnd: '06:00',
  catchUpMissed: false,
});

function isStoredExecutionPolicy(value: unknown): value is StoredRecallCaptureExecutionPolicy {
  return value === 'smart' || value === 'immediate' || value === 'nightly' || value === 'manual';
}

function canonicalExecutionPolicy(value: StoredRecallCaptureExecutionPolicy): RecallCaptureExecutionPolicy {
  // Legacy choices are read-compatible; all new automatic work uses the nightly pipeline.
  return 'nightly';
}

function isReviewPolicy(value: unknown): value is RecallCaptureReviewPolicy {
  return value === 'auto' || value === 'manual';
}

function isQuietMinutes(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 120;
}

function assertTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    throw new Error(`invalid recall capture ${field}`);
  }
  return value;
}

function validateModelCandidates(value: unknown): RecallCaptureModelCandidate[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('invalid recall capture model candidates');
  const seen = new Set<string>();
  return value.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.keys(candidate).some(key => key !== 'provider' && key !== 'model')
      || typeof candidate.provider !== 'string' || typeof candidate.model !== 'string'
      || !candidate.provider.trim() || !candidate.model.trim()
      || candidate.provider.length > 200 || candidate.model.length > 200) {
      throw new Error('invalid recall capture model candidate');
    }
    const next = { provider: candidate.provider.trim(), model: candidate.model.trim() };
    const key = JSON.stringify([next.provider, next.model]);
    if (seen.has(key)) throw new Error('duplicate recall capture model candidate');
    seen.add(key);
    return next;
  });
}

function asSettings(value: RecallJsonRecord): RecallCaptureSettingsRecord {
  // Retired scope flag: saved-content organization follows the discovery switch.
  const { stockOrganizationEnabled: _retiredScope, ...current } = value;
  if (
    value.id !== SETTINGS_ID
    || typeof value.enabled !== 'boolean'
    || (value.autoApproval !== undefined && typeof value.autoApproval !== 'boolean')
    || !isStoredExecutionPolicy(value.executionPolicy)
    || (value.reviewPolicy !== undefined && !isReviewPolicy(value.reviewPolicy))
    || (value.quietMinutes !== undefined && !isQuietMinutes(value.quietMinutes))
    || typeof value.nightlyStart !== 'string'
    || !TIME_PATTERN.test(value.nightlyStart)
    || typeof value.nightlyEnd !== 'string'
    || !TIME_PATTERN.test(value.nightlyEnd)
    || value.nightlyStart === value.nightlyEnd
    || (value.catchUpMissed !== undefined && typeof value.catchUpMissed !== 'boolean')
    || typeof value.updatedAt !== 'string'
    || Number.isNaN(Date.parse(value.updatedAt))
  ) throw new Error('malformed recall capture settings');
  return {
    ...current,
    // A previous manual choice was an explicit opt-out. Ordinary settings
    // edits preserve it; an explicit enable writes the new nightly record.
    enabled: value.executionPolicy === 'manual' ? false : value.enabled,
    modelCandidates: value.modelCandidates === undefined ? [] : validateModelCandidates(value.modelCandidates),
    executionPolicy: canonicalExecutionPolicy(value.executionPolicy),
    // Legacy auto values without an explicit grant stay disabled.
    reviewPolicy: 'manual',
    autoApproval: value.autoApproval === true && value.autoApprovalPolicyVersion === 2 && typeof value.autoApprovalEpoch === 'string'
      && /^[a-f0-9-]{36}$/.test(value.autoApprovalEpoch) && typeof value.autoApprovalEnabledAt === 'string'
      && Number.isFinite(Date.parse(value.autoApprovalEnabledAt)),
    catchUpMissed: false,
    autoApprovalPolicyVersion: value.autoApprovalPolicyVersion === 2 ? 2 : undefined,
    autoApprovalEpoch: typeof value.autoApprovalEpoch === 'string' ? value.autoApprovalEpoch : undefined,
    autoApprovalEnabledAt: typeof value.autoApprovalEnabledAt === 'string' ? value.autoApprovalEnabledAt : undefined,
    quietMinutes: isQuietMinutes(value.quietMinutes) ? value.quietMinutes : DEFAULT_SETTINGS.quietMinutes,
  } as RecallCaptureSettingsRecord;
}

function defaultSettings(userId: string): RecallCaptureSettingsRecord {
  return {
    schemaVersion: 1,
    ownerId: userId,
    id: SETTINGS_ID,
    ...DEFAULT_SETTINGS,
    updatedAt: new Date().toISOString(),
  };
}

export async function readRecallCaptureSettings(userId: string): Promise<RecallCaptureSettingsRecord> {
  const stored = await readRecallJsonRecord(userId, SETTINGS_COLLECTION, SETTINGS_ID);
  return stored ? asSettings(stored) : defaultSettings(userId);
}

const UNIFIED_DISCOVERY_MIGRATION_ID = 'unified-discovery-migration';

/** One-shot migration from the retired independent inspection switch. The
 * enabled flag is copied directly (never through `updateRecallCaptureSettings`)
 * so an automatic migration cannot mint a fresh auto-approval grant. Legacy
 * dismissed/deferred keys stay in `inspection-settings` and keep applying. */
export async function migrateUnifiedDiscoverySettings(userId: string): Promise<void> {
  if (!userId) return;
  const marker = await readRecallJsonRecord(userId, SETTINGS_COLLECTION, UNIFIED_DISCOVERY_MIGRATION_ID)
    .catch(() => undefined);
  if (marker) return;
  await withRecallAutoApprovalLock(userId, async () => {
    const again = await readRecallJsonRecord(userId, SETTINGS_COLLECTION, UNIFIED_DISCOVERY_MIGRATION_ID)
      .catch(() => undefined);
    if (again) return;
    const { readInspectionSettings } = await import('./asset-inspection-service');
    // A failed read must not be stamped as "no legacy switch"; leave the marker
    // unwritten so the next boot retries the migration.
    const inspection = await readInspectionSettings(userId);
    if (inspection?.enabled) {
      await updateRecallJsonRecord(userId, SETTINGS_COLLECTION, SETTINGS_ID, current => {
        const base = current ? asSettings(current) : defaultSettings(userId);
        if (base.enabled) return base;
        return { ...base, enabled: true, updatedAt: new Date().toISOString() };
      });
    }
    await updateRecallJsonRecord(userId, SETTINGS_COLLECTION, UNIFIED_DISCOVERY_MIGRATION_ID, current => current || {
      schemaVersion: 1,
      ownerId: userId,
      id: UNIFIED_DISCOVERY_MIGRATION_ID,
      legacyInspectionEnabled: inspection?.enabled === true,
      migratedAt: new Date().toISOString(),
    } as RecallJsonRecord);
  });
}

export async function updateRecallCaptureSettings(
  userId: string,
  input: UpdateRecallCaptureSettingsInput,
): Promise<RecallCaptureSettingsRecord> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid recall capture settings');
  }
  const allowed = new Set(['modelCandidates', 'enabled', 'autoApproval', 'executionPolicy', 'reviewPolicy', 'quietMinutes', 'nightlyStart', 'nightlyEnd']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error('invalid recall capture settings field');
  }
  if (input.autoApproval !== undefined && typeof input.autoApproval !== 'boolean') {
    throw new Error('invalid recall capture auto approval');
  }
  if (input.reviewPolicy === 'auto') {
    throw new Error('automatic approval is unavailable');
  }
  if (input.executionPolicy !== undefined && input.executionPolicy !== 'nightly') {
    throw new Error('only nightly capture is available');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new Error('invalid recall capture enabled');
  }
  if (input.executionPolicy !== undefined && !isStoredExecutionPolicy(input.executionPolicy)) {
    throw new Error('invalid recall capture execution policy');
  }
  if (input.reviewPolicy !== undefined && !isReviewPolicy(input.reviewPolicy)) {
    throw new Error('invalid recall capture review policy');
  }
  if (input.quietMinutes !== undefined && !isQuietMinutes(input.quietMinutes)) {
    throw new Error('invalid recall capture quiet minutes');
  }
  const modelCandidates = input.modelCandidates === undefined ? undefined : validateModelCandidates(input.modelCandidates);
  const nightlyStart = input.nightlyStart === undefined
    ? undefined : assertTime(input.nightlyStart, 'nightly start');
  const nightlyEnd = input.nightlyEnd === undefined
    ? undefined : assertTime(input.nightlyEnd, 'nightly end');

  return withRecallAutoApprovalLock(userId, async () => asSettings(await updateRecallJsonRecord(
    userId,
    SETTINGS_COLLECTION,
    SETTINGS_ID,
    async (current) => {
      const base = current ? asSettings(current) : defaultSettings(userId);
      if (modelCandidates !== undefined) {
        const { assertRecallCaptureModelAdditions } = await import('./capture-model-selection');
        await assertRecallCaptureModelAdditions(userId, base.modelCandidates, modelCandidates);
      }
      const autoApproval = input.autoApproval ?? base.autoApproval;
      const newGrant = autoApproval && (!base.autoApproval || input.enabled === false || (input.enabled === true && !base.enabled));
      const next: RecallCaptureSettingsRecord = {
        ...base,
        ...(modelCandidates === undefined ? {} : { modelCandidates }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.executionPolicy === undefined ? {} : { executionPolicy: canonicalExecutionPolicy(input.executionPolicy) }),
        reviewPolicy: 'manual',
        autoApproval,
        autoApprovalPolicyVersion: autoApproval ? 2 : undefined,
        autoApprovalEpoch: autoApproval ? (newGrant ? randomUUID() : base.autoApprovalEpoch) : undefined,
        autoApprovalEnabledAt: autoApproval ? (newGrant ? new Date().toISOString() : base.autoApprovalEnabledAt) : undefined,
        ...(input.quietMinutes === undefined ? {} : { quietMinutes: input.quietMinutes }),
        ...(nightlyStart === undefined ? {} : { nightlyStart }),
        ...(nightlyEnd === undefined ? {} : { nightlyEnd }),
        catchUpMissed: false,
        updatedAt: new Date().toISOString(),
      };
      if (next.nightlyStart === next.nightlyEnd) {
        throw new Error('recall capture nightly window must not be empty');
      }
      return next;
    },
  )));
}

/** Settings changes and system promotion share this grant lock. Disabling waits
 * for an already committing operation; nothing can commit after revocation returns. */
export function withRecallAutoApprovalLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  return fileEditLock(recallJsonRecordPath(userId, 'candidate-locks', 'auto-approval')).runExclusive(operation);
}

export function captureAutoApprovalAuthorization(settings: RecallCaptureSettingsRecord): { autoApprovalEpoch?: string; autoApprovalEnabledAt?: string } {
  return settings.enabled && settings.autoApproval
    ? { autoApprovalEpoch: settings.autoApprovalEpoch, autoApprovalEnabledAt: settings.autoApprovalEnabledAt } : {};
}

function minuteOfDay(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function atLocalMinute(base: Date, minute: number, dayOffset = 0): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + dayOffset);
  next.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return next;
}

export function isWithinNightlyWindow(
  now: Date,
  nightlyStart: string,
  nightlyEnd: string,
): boolean {
  const minute = now.getHours() * 60 + now.getMinutes();
  const start = minuteOfDay(assertTime(nightlyStart, 'nightly start'));
  const end = minuteOfDay(assertTime(nightlyEnd, 'nightly end'));
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export function nextNightlyRunAt(
  now: Date,
  nightlyStart: string,
  nightlyEnd: string,
): Date {
  const start = minuteOfDay(assertTime(nightlyStart, 'nightly start'));
  assertTime(nightlyEnd, 'nightly end');
  if (nightlyStart === nightlyEnd) throw new Error('recall capture nightly window must not be empty');
  if (isWithinNightlyWindow(now, nightlyStart, nightlyEnd)) return new Date(now);
  const todayStart = atLocalMinute(now, start);
  return now < todayStart ? todayStart : atLocalMinute(now, start, 1);
}
