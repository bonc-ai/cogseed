import { safeId } from '../../storage';

export const SCHEDULER_QUEUE_SCHEMA_VERSION = 1 as const;

export type SchedulerQueueItemStatus =
  | 'queued'
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface SchedulerQueueItemInput {
  userId: string;
  itemId: string;
  scopeId: string;
  priority?: number;
  enqueuedAt: number;
  dependencies?: string[];
}

export interface SchedulerQueueItem extends SchedulerQueueItemInput {
  schemaVersion: typeof SCHEDULER_QUEUE_SCHEMA_VERSION;
  priority: number;
  dependencies: string[];
  insertionSequence: number;
  status: SchedulerQueueItemStatus;
  generation: number;
  claimId?: string;
  claimedBy?: string;
  claimedAt?: number;
  terminalAt?: number;
}

export interface SchedulerQueueState {
  schemaVersion: typeof SCHEDULER_QUEUE_SCHEMA_VERSION;
  nextInsertionSequence: number;
  items: Record<string, SchedulerQueueItem>;
  order: string[];
}

export interface SchedulerQueueEnqueueResult {
  state: SchedulerQueueState;
  item: SchedulerQueueItem;
  created: boolean;
}

export type SchedulerQueueClaimFailureReason =
  | 'empty'
  | 'not_found'
  | 'not_ready'
  | 'claimed'
  | 'already_claimed'
  | 'terminal';

export type SchedulerQueueClaimResult =
  | { state: SchedulerQueueState; claimed: true; item: SchedulerQueueItem }
  | { state: SchedulerQueueState; claimed: false; reason: SchedulerQueueClaimFailureReason; item?: SchedulerQueueItem };

export interface SchedulerQueueClaimInput {
  userId: string;
  itemId: string;
  claimId: string;
  claimedBy: string;
  now: number;
}

export interface SchedulerQueueNextClaimInput {
  userId: string;
  claimId: string;
  claimedBy: string;
  now: number;
  scopeId?: string;
}

export interface SchedulerQueueCompletionInput {
  userId: string;
  itemId: string;
  claimId: string;
  generation: number;
  status: Extract<SchedulerQueueItemStatus, 'completed' | 'failed' | 'cancelled' | 'skipped'>;
  now: number;
}

export interface SchedulerQueueReleaseInput {
  userId: string;
  itemId: string;
  claimId: string;
  generation: number;
  now: number;
}

const TERMINAL_STATUSES = new Set<SchedulerQueueItemStatus>(['completed', 'failed', 'cancelled', 'skipped']);
const DEPENDENCY_READY_STATUSES = new Set<SchedulerQueueItemStatus>(['completed', 'skipped']);

function assertSafeId(value: unknown, label: string): string {
  if (!safeId(value)) throw new Error(`invalid scheduler ${label}`);
  return value as string;
}

function assertUserId(userId: unknown): string {
  return assertSafeId(userId, 'user id');
}

function assertItemId(itemId: unknown): string {
  return assertSafeId(itemId, 'item id');
}

function assertScopeId(scopeId: unknown): string {
  return assertSafeId(scopeId, 'scope id');
}

function assertClaimId(claimId: unknown): string {
  return assertSafeId(claimId, 'claim id');
}

function assertClaimedBy(claimedBy: unknown): string {
  return assertSafeId(claimedBy, 'claim holder');
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid scheduler ${label}`);
  return value as number;
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid scheduler ${label}`);
  return value as number;
}

function assertTime(value: unknown, label: string): number {
  return assertNonNegativeInteger(value, label);
}

function cloneItem(item: SchedulerQueueItem): SchedulerQueueItem {
  return { ...item, dependencies: [...item.dependencies] };
}

function cloneState(state: SchedulerQueueState): SchedulerQueueState {
  assertQueueState(state);
  const items: Record<string, SchedulerQueueItem> = {};
  for (const [itemId, item] of Object.entries(state.items)) items[itemId] = cloneItem(item);
  return {
    schemaVersion: state.schemaVersion,
    nextInsertionSequence: state.nextInsertionSequence,
    items,
    order: [...state.order],
  };
}

function assertDependencies(dependencies: unknown, itemId: string): string[] {
  if (dependencies === undefined) return [];
  if (!Array.isArray(dependencies)) throw new Error('invalid scheduler dependencies');
  const output = dependencies.map((dependency) => assertItemId(dependency));
  if (new Set(output).size !== output.length) throw new Error('duplicate scheduler dependency');
  if (output.includes(itemId)) throw new Error('scheduler item cannot depend on itself');
  return output;
}

function assertPriority(priority: unknown): number {
  if (priority === undefined) return 0;
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority)) throw new Error('invalid scheduler priority');
  return priority;
}

function assertQueueItem(item: SchedulerQueueItem): void {
  if (!item || item.schemaVersion !== SCHEDULER_QUEUE_SCHEMA_VERSION) throw new Error('malformed scheduler queue item');
  assertUserId(item.userId);
  assertItemId(item.itemId);
  assertScopeId(item.scopeId);
  assertPriority(item.priority);
  assertTime(item.enqueuedAt, 'enqueue time');
  assertDependencies(item.dependencies, item.itemId);
  assertPositiveInteger(item.insertionSequence, 'insertion sequence');
  if (!['queued', 'claimed', 'completed', 'failed', 'cancelled', 'skipped'].includes(item.status)) throw new Error('invalid scheduler queue status');
  assertNonNegativeInteger(item.generation, 'generation');
  if (item.claimId !== undefined) assertClaimId(item.claimId);
  if (item.claimedBy !== undefined) assertClaimedBy(item.claimedBy);
  if (item.claimedAt !== undefined) assertTime(item.claimedAt, 'claim time');
  if (item.terminalAt !== undefined) assertTime(item.terminalAt, 'terminal time');
  if (item.status === 'claimed' && (!item.claimId || !item.claimedBy || item.claimedAt === undefined || item.generation < 1)) {
    throw new Error('malformed claimed scheduler queue item');
  }
  if (TERMINAL_STATUSES.has(item.status) && item.terminalAt === undefined) throw new Error('malformed terminal scheduler queue item');
}

function assertQueueState(state: SchedulerQueueState): void {
  if (!state || state.schemaVersion !== SCHEDULER_QUEUE_SCHEMA_VERSION) throw new Error('malformed scheduler queue state');
  assertPositiveInteger(state.nextInsertionSequence, 'next insertion sequence');
  if (!state.items || typeof state.items !== 'object' || Array.isArray(state.items)) throw new Error('malformed scheduler queue items');
  if (!Array.isArray(state.order)) throw new Error('malformed scheduler queue order');
  const seen = new Set<string>();
  for (const itemId of state.order) {
    assertItemId(itemId);
    if (seen.has(itemId) || !state.items[itemId]) throw new Error('malformed scheduler queue order');
    seen.add(itemId);
  }
  if (seen.size !== Object.keys(state.items).length) throw new Error('malformed scheduler queue order');
  for (const item of Object.values(state.items)) assertQueueItem(item);
}

function sameDefinition(item: SchedulerQueueItem, input: SchedulerQueueItemInput): boolean {
  const dependencies = assertDependencies(input.dependencies, input.itemId);
  return item.userId === input.userId
    && item.itemId === input.itemId
    && item.scopeId === input.scopeId
    && item.priority === (input.priority ?? 0)
    && item.enqueuedAt === input.enqueuedAt
    && item.dependencies.length === dependencies.length
    && item.dependencies.every((dependency, index) => dependency === dependencies[index]);
}

function dependenciesReady(state: SchedulerQueueState, item: SchedulerQueueItem): boolean {
  for (const dependencyId of item.dependencies) {
    const dependency = state.items[dependencyId];
    if (!dependency || dependency.userId !== item.userId || !DEPENDENCY_READY_STATUSES.has(dependency.status)) return false;
  }
  return true;
}

function compareReadyItems(left: SchedulerQueueItem, right: SchedulerQueueItem): number {
  return right.priority - left.priority
    || left.enqueuedAt - right.enqueuedAt
    || left.insertionSequence - right.insertionSequence
    || left.itemId.localeCompare(right.itemId);
}

function validateClaimInput(input: SchedulerQueueClaimInput): SchedulerQueueClaimInput {
  return {
    userId: assertUserId(input.userId),
    itemId: assertItemId(input.itemId),
    claimId: assertClaimId(input.claimId),
    claimedBy: assertClaimedBy(input.claimedBy),
    now: assertTime(input.now, 'claim time'),
  };
}

function assertClaimMatches(item: SchedulerQueueItem, input: { claimId: string; generation: number }): void {
  assertClaimId(input.claimId);
  assertNonNegativeInteger(input.generation, 'generation');
  if (item.status !== 'claimed') throw new Error('scheduler item is not claimed');
  if (item.claimId !== input.claimId || item.generation !== input.generation) throw new Error('stale scheduler claim');
}

export function createSchedulerQueueState(): SchedulerQueueState {
  return {
    schemaVersion: SCHEDULER_QUEUE_SCHEMA_VERSION,
    nextInsertionSequence: 1,
    items: {},
    order: [],
  };
}

export function enqueueSchedulerItem(state: SchedulerQueueState, input: SchedulerQueueItemInput): SchedulerQueueEnqueueResult {
  const next = cloneState(state);
  const userId = assertUserId(input.userId);
  const itemId = assertItemId(input.itemId);
  const scopeId = assertScopeId(input.scopeId);
  const priority = assertPriority(input.priority);
  const enqueuedAt = assertTime(input.enqueuedAt, 'enqueue time');
  const dependencies = assertDependencies(input.dependencies, itemId);
  const normalized = { userId, itemId, scopeId, priority, enqueuedAt, dependencies };
  const existing = next.items[itemId];
  if (existing) {
    if (!sameDefinition(existing, normalized)) throw new Error('scheduler item id already exists with a different definition');
    return { state: next, item: cloneItem(existing), created: false };
  }
  for (const dependencyId of dependencies) {
    const dependency = next.items[dependencyId];
    if (dependency && dependency.userId !== userId) throw new Error('scheduler dependency crosses user scope');
  }
  const item: SchedulerQueueItem = {
    schemaVersion: SCHEDULER_QUEUE_SCHEMA_VERSION,
    ...normalized,
    insertionSequence: next.nextInsertionSequence,
    status: 'queued',
    generation: 0,
  };
  next.nextInsertionSequence += 1;
  next.items[itemId] = item;
  next.order.push(itemId);
  return { state: next, item: cloneItem(item), created: true };
}

export function listReadySchedulerQueueItems(
  state: SchedulerQueueState,
  filter: { userId: string; scopeId?: string },
): SchedulerQueueItem[] {
  assertQueueState(state);
  const userId = assertUserId(filter.userId);
  const scopeId = filter.scopeId === undefined ? undefined : assertScopeId(filter.scopeId);
  return state.order
    .map((itemId) => state.items[itemId])
    .filter((item) => item.userId === userId && (scopeId === undefined || item.scopeId === scopeId))
    .filter((item) => item.status === 'queued' && dependenciesReady(state, item))
    .sort(compareReadyItems)
    .map(cloneItem);
}

export function claimSchedulerItemById(state: SchedulerQueueState, input: SchedulerQueueClaimInput): SchedulerQueueClaimResult {
  const next = cloneState(state);
  const normalized = validateClaimInput(input);
  const item = next.items[normalized.itemId];
  if (!item) return { state: next, claimed: false, reason: 'not_found' };
  if (item.userId !== normalized.userId) throw new Error('scheduler item user scope mismatch');
  if (item.status === 'claimed') {
    if (item.claimId === normalized.claimId && item.claimedBy === normalized.claimedBy) {
      return { state: next, claimed: false, reason: 'already_claimed', item: cloneItem(item) };
    }
    return { state: next, claimed: false, reason: 'claimed', item: cloneItem(item) };
  }
  if (TERMINAL_STATUSES.has(item.status)) return { state: next, claimed: false, reason: 'terminal', item: cloneItem(item) };
  if (!dependenciesReady(next, item)) return { state: next, claimed: false, reason: 'not_ready', item: cloneItem(item) };
  item.status = 'claimed';
  item.generation += 1;
  item.claimId = normalized.claimId;
  item.claimedBy = normalized.claimedBy;
  item.claimedAt = normalized.now;
  return { state: next, claimed: true, item: cloneItem(item) };
}

export function claimNextSchedulerItem(state: SchedulerQueueState, input: SchedulerQueueNextClaimInput): SchedulerQueueClaimResult {
  const userId = assertUserId(input.userId);
  const claimId = assertClaimId(input.claimId);
  const claimedBy = assertClaimedBy(input.claimedBy);
  const now = assertTime(input.now, 'claim time');
  const scopeId = input.scopeId === undefined ? undefined : assertScopeId(input.scopeId);
  const ready = listReadySchedulerQueueItems(state, { userId, ...(scopeId ? { scopeId } : {}) });
  if (ready.length === 0) return { state: cloneState(state), claimed: false, reason: 'empty' };
  return claimSchedulerItemById(state, { userId, itemId: ready[0].itemId, claimId, claimedBy, now });
}

export function completeSchedulerClaim(state: SchedulerQueueState, input: SchedulerQueueCompletionInput): SchedulerQueueEnqueueResult {
  const next = cloneState(state);
  const userId = assertUserId(input.userId);
  const itemId = assertItemId(input.itemId);
  const claimId = assertClaimId(input.claimId);
  const generation = assertNonNegativeInteger(input.generation, 'generation');
  const now = assertTime(input.now, 'terminal time');
  if (!['completed', 'failed', 'cancelled', 'skipped'].includes(input.status)) throw new Error('invalid scheduler terminal status');
  const item = next.items[itemId];
  if (!item) throw new Error('scheduler item not found');
  if (item.userId !== userId) throw new Error('scheduler item user scope mismatch');
  assertClaimMatches(item, { claimId, generation });
  if (item.claimedAt !== undefined && now < item.claimedAt) throw new Error('scheduler terminal time precedes claim time');
  item.status = input.status;
  item.terminalAt = now;
  return { state: next, item: cloneItem(item), created: false };
}

export function releaseSchedulerClaim(state: SchedulerQueueState, input: SchedulerQueueReleaseInput): SchedulerQueueEnqueueResult {
  const next = cloneState(state);
  const userId = assertUserId(input.userId);
  const itemId = assertItemId(input.itemId);
  const claimId = assertClaimId(input.claimId);
  const generation = assertNonNegativeInteger(input.generation, 'generation');
  const now = assertTime(input.now, 'release time');
  const item = next.items[itemId];
  if (!item) throw new Error('scheduler item not found');
  if (item.userId !== userId) throw new Error('scheduler item user scope mismatch');
  assertClaimMatches(item, { claimId, generation });
  if (item.claimedAt !== undefined && now < item.claimedAt) throw new Error('scheduler release time precedes claim time');
  item.status = 'queued';
  delete item.claimId;
  delete item.claimedBy;
  delete item.claimedAt;
  return { state: next, item: cloneItem(item), created: false };
}
