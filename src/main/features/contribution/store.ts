import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import { userLocalRoot } from '../../paths';

interface ContributionStore {
  schema_version: 1;
  account_partition: string;
  generated_at: string | null;
  last_success_at: string | null;
  items: Record<string, unknown>;
  skill_ids: Record<string, string>;
  retries: Record<string, unknown>;
}

const MAX_CACHE_ENTRIES = 500;

function partition(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 24);
}

function storeFile(userId: string, accountId: string): string {
  return path.join(userLocalRoot(userId), 'hub-contributions', `${partition(accountId)}.json`);
}

function empty(accountId: string): ContributionStore {
  return { schema_version: 1, account_partition: partition(accountId), generated_at: null, last_success_at: null, items: {}, skill_ids: {}, retries: {} };
}

export function readContributionStore(userId: string, accountId: string): ContributionStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(userId, accountId), 'utf8')) as ContributionStore;
    if (parsed.schema_version !== 1 || parsed.account_partition !== partition(accountId)
      || !parsed.items || typeof parsed.items !== 'object' || Array.isArray(parsed.items)
      || !parsed.skill_ids || typeof parsed.skill_ids !== 'object' || Array.isArray(parsed.skill_ids)) return empty(accountId);
    return parsed;
  } catch { return empty(accountId); }
}

export function writeContributionStore(userId: string, accountId: string, value: ContributionStore): void {
  const file = storeFile(userId, accountId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...value, account_partition: partition(accountId), schema_version: 1 }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function mergeMine(userId: string, accountId: string, response: Record<string, unknown>): ContributionStore {
  const current = readContributionStore(userId, accountId);
  const items = Array.isArray(response.items) ? response.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const entryId = record.entry_id;
    if (typeof entryId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(entryId)) continue;
    const latest = record.latest_submission;
    const submissionId = latest && typeof latest === 'object' && !Array.isArray(latest)
      ? (latest as Record<string, unknown>).submission_id : null;
    if (typeof submissionId === 'string') {
      for (const [cachedEntryId, cachedItem] of Object.entries(current.items)) {
        if (cachedEntryId === entryId || !cachedItem || typeof cachedItem !== 'object' || Array.isArray(cachedItem)) continue;
        const cachedLatest = (cachedItem as Record<string, unknown>).latest_submission;
        if (cachedLatest && typeof cachedLatest === 'object' && !Array.isArray(cachedLatest)
          && (cachedLatest as Record<string, unknown>).submission_id === submissionId) delete current.items[cachedEntryId];
      }
    }
    current.items[entryId] = item;
  }
  const retained = Object.entries(current.items)
    .sort(([, a], [, b]) => {
      const at = a && typeof a === 'object' && !Array.isArray(a) ? String((a as Record<string, unknown>).updated_at || '') : '';
      const bt = b && typeof b === 'object' && !Array.isArray(b) ? String((b as Record<string, unknown>).updated_at || '') : '';
      return bt.localeCompare(at);
    })
    .slice(0, MAX_CACHE_ENTRIES);
  current.items = Object.fromEntries(retained);
  current.generated_at = typeof response.generated_at === 'string' ? response.generated_at : current.generated_at;
  current.last_success_at = new Date().toISOString();
  writeContributionStore(userId, accountId, current);
  return current;
}

export function safeStoreView(store: ContributionStore): Pick<ContributionStore, 'generated_at' | 'last_success_at' | 'items'> {
  return { generated_at: store.generated_at, last_success_at: store.last_success_at, items: store.items };
}

export function contributionTarget(
  userId: string, accountId: string, contentId: string,
): { currentVersion: string; origin: Record<string, unknown> | null; pendingSubmissionId: string | null } | null {
  const store = readContributionStore(userId, accountId);
  const item = Object.values(store.items).find((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (value as Record<string, unknown>).content_id === contentId;
  });
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const currentVersion = typeof record.current_published_version === 'string' ? record.current_published_version : '';
  const latest = record.latest_submission;
  const latestRecord = latest && typeof latest === 'object' && !Array.isArray(latest) ? latest as Record<string, unknown> : null;
  const origin = latestRecord?.declarations_origin;
  const latestStatus = typeof latestRecord?.status === 'string' ? latestRecord.status.toUpperCase() : '';
  return {
    currentVersion,
    origin: origin && typeof origin === 'object' && !Array.isArray(origin) ? origin as Record<string, unknown> : null,
    pendingSubmissionId: latestStatus === 'PENDING_REVIEW' && typeof latestRecord?.submission_id === 'string'
      ? latestRecord.submission_id : null,
  };
}

export function localSkillUuid(userId: string, accountId: string, skillId: string): string {
  const current = readContributionStore(userId, accountId);
  const existing = current.skill_ids[skillId];
  if (existing) return existing;
  const next = randomUUID();
  current.skill_ids[skillId] = next;
  writeContributionStore(userId, accountId, current);
  return next;
}
