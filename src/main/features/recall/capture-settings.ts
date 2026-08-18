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

export interface RecallCaptureSettingsRecord extends RecallJsonRecord {
  id: typeof SETTINGS_ID;
  enabled: boolean;
  executionPolicy: RecallCaptureExecutionPolicy;
  reviewPolicy: RecallCaptureReviewPolicy;
  quietMinutes: number;
  nightlyStart: string;
  nightlyEnd: string;
  catchUpMissed: boolean;
  updatedAt: string;
}

export interface UpdateRecallCaptureSettingsInput {
  enabled?: boolean;
  executionPolicy?: StoredRecallCaptureExecutionPolicy;
  reviewPolicy?: RecallCaptureReviewPolicy;
  quietMinutes?: number;
  nightlyStart?: string;
  nightlyEnd?: string;
  catchUpMissed?: boolean;
}

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  executionPolicy: 'smart' as const,
  reviewPolicy: 'auto' as const,
  quietMinutes: 10,
  nightlyStart: '02:00',
  nightlyEnd: '06:00',
  catchUpMissed: true,
});

function isStoredExecutionPolicy(value: unknown): value is StoredRecallCaptureExecutionPolicy {
  return value === 'smart' || value === 'immediate' || value === 'nightly' || value === 'manual';
}

function canonicalExecutionPolicy(value: StoredRecallCaptureExecutionPolicy): RecallCaptureExecutionPolicy {
  return value === 'immediate' ? 'smart' : value;
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

function asSettings(value: RecallJsonRecord): RecallCaptureSettingsRecord {
  if (
    value.id !== SETTINGS_ID
    || typeof value.enabled !== 'boolean'
    || !isStoredExecutionPolicy(value.executionPolicy)
    || (value.reviewPolicy !== undefined && !isReviewPolicy(value.reviewPolicy))
    || (value.quietMinutes !== undefined && !isQuietMinutes(value.quietMinutes))
    || typeof value.nightlyStart !== 'string'
    || !TIME_PATTERN.test(value.nightlyStart)
    || typeof value.nightlyEnd !== 'string'
    || !TIME_PATTERN.test(value.nightlyEnd)
    || value.nightlyStart === value.nightlyEnd
    || typeof value.catchUpMissed !== 'boolean'
    || typeof value.updatedAt !== 'string'
    || Number.isNaN(Date.parse(value.updatedAt))
  ) throw new Error('malformed recall capture settings');
  return {
    ...value,
    executionPolicy: canonicalExecutionPolicy(value.executionPolicy),
    reviewPolicy: isReviewPolicy(value.reviewPolicy) ? value.reviewPolicy : DEFAULT_SETTINGS.reviewPolicy,
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

export async function updateRecallCaptureSettings(
  userId: string,
  input: UpdateRecallCaptureSettingsInput,
): Promise<RecallCaptureSettingsRecord> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid recall capture settings');
  }
  const allowed = new Set(['enabled', 'executionPolicy', 'reviewPolicy', 'quietMinutes', 'nightlyStart', 'nightlyEnd', 'catchUpMissed']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error('invalid recall capture settings field');
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
  if (input.catchUpMissed !== undefined && typeof input.catchUpMissed !== 'boolean') {
    throw new Error('invalid recall capture catch-up setting');
  }
  const nightlyStart = input.nightlyStart === undefined
    ? undefined : assertTime(input.nightlyStart, 'nightly start');
  const nightlyEnd = input.nightlyEnd === undefined
    ? undefined : assertTime(input.nightlyEnd, 'nightly end');

  return asSettings(await updateRecallJsonRecord(
    userId,
    SETTINGS_COLLECTION,
    SETTINGS_ID,
    (current) => {
      const base = current ? asSettings(current) : defaultSettings(userId);
      const next: RecallCaptureSettingsRecord = {
        ...base,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.executionPolicy === undefined ? {} : { executionPolicy: canonicalExecutionPolicy(input.executionPolicy) }),
        ...(input.reviewPolicy === undefined ? {} : { reviewPolicy: input.reviewPolicy }),
        ...(input.quietMinutes === undefined ? {} : { quietMinutes: input.quietMinutes }),
        ...(nightlyStart === undefined ? {} : { nightlyStart }),
        ...(nightlyEnd === undefined ? {} : { nightlyEnd }),
        ...(input.catchUpMissed === undefined ? {} : { catchUpMissed: input.catchUpMissed }),
        updatedAt: new Date().toISOString(),
      };
      if (next.nightlyStart === next.nightlyEnd) {
        throw new Error('recall capture nightly window must not be empty');
      }
      return next;
    },
  ));
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
