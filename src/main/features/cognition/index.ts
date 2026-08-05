import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';

import { userCognitionFile } from '../../paths';
import { createLogger } from '../../logger';
import { nowIso, safeId, writeJson } from '../../storage';
import { logErrorSummary, maskId } from '../../util/log-redact';
import {
  detachCognitionMemoryEntryLocked,
  ensureCognitionMemoryEntryLocked,
  findCognitionMemoryEntryLocked,
  memoryContentHash,
  scanForInjection,
} from '../memory';
import { CorruptMemoryMetadataError } from '../memory-records';
import {
  assertCognitionMemoryTransaction,
  withCognitionMemoryTransaction,
  type CognitionMemoryTransaction,
} from '../cognition-memory-transaction';

const log = createLogger('cognition');
const STORE_VERSION = 3;
const LEGACY_STORE_VERSIONS = new Set([1, 2]);
export const BRIGHT_REUSE_THRESHOLD = 3;
export const COGNITION_STORE_BYTE_LIMIT = 8 * 1024 * 1024;
const MAX_ASSETS = 500;
const MAX_EVIDENCE_PER_ASSET = 200;
const MAX_REUSE_EVENTS_PER_ASSET = 500;
const MAX_TRANSITIONS_PER_ASSET = 1200;
const MAX_NON_INVALIDATION_TRANSITIONS = MAX_TRANSITIONS_PER_ASSET - 1;
const MAX_ID_LENGTH = 80;
const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 2000;
const MAX_SOURCE_LABEL_LENGTH = 160;
export const DEFAULT_COGNITION_PAGE_SIZE = 50;
export const MAX_COGNITION_PAGE_SIZE = 100;

export type CognitionStage = 'seed' | 'sprout' | 'growing' | 'bright';
export type CognitionReviewState = 'pending' | 'confirmed' | 'deferred' | 'invalidated';
export type CognitionEvidenceKind = 'conversation' | 'project' | 'execution' | 'manual';
export type CognitionInvalidationReason = 'removed' | 'replaced' | 'content_changed' | 'metadata_missing';
export type CognitionTransitionKind =
  | 'created'
  | 'evidence_added'
  | 'confirmation_requested'
  | 'defer_requested'
  | 'confirmed'
  | 'reconfirmed'
  | 'deferred'
  | 'reused'
  | 'invalidated';

export interface CognitionEvidenceInput {
  kind: CognitionEvidenceKind;
  summary: string;
  sourceLabel: string;
  conversationId?: string;
  projectId?: string;
}

export interface CognitionEvidence extends CognitionEvidenceInput {
  id: string;
  createdAt: string;
}

export interface CognitionReuseInput {
  sourceLabel: string;
  conversationId?: string;
  projectId?: string;
}

export interface CognitionReuseEvent extends CognitionReuseInput {
  id: string;
  createdAt: string;
}

export interface CognitionCreateInput {
  title: string;
  summary: string;
}

export interface CognitionCaptureInput extends CognitionCreateInput {
  evidence: CognitionEvidenceInput;
}

export interface CognitionMemoryBinding {
  sourceId: string;
  recordId: string;
  contentSha256: string;
  activatedAt: string;
}

export interface CognitionMemoryTransition {
  kind: 'activate' | 'deactivate';
  sourceId: string;
  contentSha256: string;
  requestedAt: string;
}

export interface CognitionInvalidation {
  at: string;
  reason: CognitionInvalidationReason;
  previousRecordId?: string;
}

export interface CognitionTransition {
  id: string;
  kind: CognitionTransitionKind;
  at: string;
  reason?: CognitionInvalidationReason;
  evidenceId?: string;
  reuseEventId?: string;
}

export interface CognitionAsset {
  id: string;
  title: string;
  summary: string;
  stage: CognitionStage;
  reviewState: CognitionReviewState;
  evidence: CognitionEvidence[];
  reuseEvents: CognitionReuseEvent[];
  transitions: CognitionTransition[];
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  /** Compatibility projection for the existing renderer's retry label. */
  confirmationRequestedAt?: string;
  memoryBinding?: CognitionMemoryBinding;
  memoryTransition?: CognitionMemoryTransition;
  invalidation?: CognitionInvalidation;
}

export interface CognitionAssetSummary {
  id: string;
  title: string;
  summary: string;
  stage: CognitionStage;
  reviewState: CognitionReviewState;
  evidenceCount: number;
  reuseCount: number;
  updatedAt: string;
  confirmationRequestedAt?: string;
  invalidation?: CognitionInvalidation;
}

export interface CognitionAssetPage {
  items: CognitionAssetSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface CognitionStore {
  version: number;
  assets: CognitionAsset[];
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type SyncDirtyNotifier = (domain: string, relPath: string) => void;

let syncDirtyNotifierForTest: SyncDirtyNotifier | null = null;

export function _setSyncDirtyNotifierForTest(notifier: SyncDirtyNotifier | null): void {
  syncDirtyNotifierForTest = notifier;
}

function assertUserId(userId: string): void {
  if (!safeId(userId) || userId.length > MAX_ID_LENGTH) throw new Error('invalid cognition user id');
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: JsonValue | undefined, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`invalid cognition ${field}`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new Error(`invalid cognition ${field}`);
  return trimmed;
}

function requiredSafeId(value: JsonValue | undefined, field: string): string {
  const id = requiredString(value, field, MAX_ID_LENGTH);
  if (!safeId(id)) throw new Error(`invalid cognition ${field}`);
  return id;
}

function requiredHash(value: JsonValue | undefined, field: string): string {
  const hash = requiredString(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`invalid cognition ${field}`);
  return hash;
}

function requiredTimestamp(value: JsonValue | undefined, field: string): string {
  const timestamp = requiredString(value, field, MAX_ID_LENGTH);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(timestamp);
  if (!match) throw new Error(`invalid cognition ${field}`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const parsed = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(parsed.getTime())
      || parsed.getFullYear() !== year
      || parsed.getMonth() !== month - 1
      || parsed.getDate() !== day
      || parsed.getHours() !== hour
      || parsed.getMinutes() !== minute
      || parsed.getSeconds() !== second) throw new Error(`invalid cognition ${field}`);
  return timestamp;
}

function optionalSafeId(value: JsonValue | undefined, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredSafeId(value, field);
}

function assertUniqueIds(items: Array<{ id: string }>, field: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`duplicate cognition ${field} id`);
    ids.add(item.id);
  }
}

function parseEvidence(value: JsonValue, index: number): CognitionEvidence {
  if (!isObject(value)) throw new Error(`invalid cognition evidence at index ${index}`);
  const kind = value.kind;
  if (kind !== 'conversation' && kind !== 'project' && kind !== 'execution' && kind !== 'manual') {
    throw new Error(`invalid cognition evidence kind at index ${index}`);
  }
  const evidence: CognitionEvidence = {
    id: requiredSafeId(value.id, `evidence[${index}].id`),
    kind,
    summary: requiredString(value.summary, `evidence[${index}].summary`, MAX_SUMMARY_LENGTH),
    sourceLabel: requiredString(value.sourceLabel, `evidence[${index}].sourceLabel`, MAX_SOURCE_LABEL_LENGTH),
    createdAt: requiredTimestamp(value.createdAt, `evidence[${index}].createdAt`),
  };
  const conversationId = optionalSafeId(value.conversationId, `evidence[${index}].conversationId`);
  const projectId = optionalSafeId(value.projectId, `evidence[${index}].projectId`);
  if (conversationId) evidence.conversationId = conversationId;
  if (projectId) evidence.projectId = projectId;
  return evidence;
}

function parseReuseEvent(value: JsonValue, index: number): CognitionReuseEvent {
  if (!isObject(value)) throw new Error(`invalid cognition reuse event at index ${index}`);
  const event: CognitionReuseEvent = {
    id: requiredSafeId(value.id, `reuseEvents[${index}].id`),
    sourceLabel: requiredString(value.sourceLabel, `reuseEvents[${index}].sourceLabel`, MAX_SOURCE_LABEL_LENGTH),
    createdAt: requiredTimestamp(value.createdAt, `reuseEvents[${index}].createdAt`),
  };
  const conversationId = optionalSafeId(value.conversationId, `reuseEvents[${index}].conversationId`);
  const projectId = optionalSafeId(value.projectId, `reuseEvents[${index}].projectId`);
  if (conversationId) event.conversationId = conversationId;
  if (projectId) event.projectId = projectId;
  return event;
}

function parseMemoryBinding(value: JsonValue | undefined, field: string): CognitionMemoryBinding | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new Error(`invalid cognition ${field}`);
  return {
    sourceId: requiredSafeId(value.sourceId, `${field}.sourceId`),
    recordId: requiredSafeId(value.recordId, `${field}.recordId`),
    contentSha256: requiredHash(value.contentSha256, `${field}.contentSha256`),
    activatedAt: requiredTimestamp(value.activatedAt, `${field}.activatedAt`),
  };
}

function parseMemoryTransition(value: JsonValue | undefined, field: string): CognitionMemoryTransition | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value) || (value.kind !== 'activate' && value.kind !== 'deactivate')) {
    throw new Error(`invalid cognition ${field}`);
  }
  return {
    kind: value.kind,
    sourceId: requiredSafeId(value.sourceId, `${field}.sourceId`),
    contentSha256: requiredHash(value.contentSha256, `${field}.contentSha256`),
    requestedAt: requiredTimestamp(value.requestedAt, `${field}.requestedAt`),
  };
}

function parseInvalidation(value: JsonValue | undefined, field: string): CognitionInvalidation | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value) || !['removed', 'replaced', 'content_changed', 'metadata_missing'].includes(String(value.reason))) {
    throw new Error(`invalid cognition ${field}`);
  }
  const previousRecordId = optionalSafeId(value.previousRecordId, `${field}.previousRecordId`);
  return {
    at: requiredTimestamp(value.at, `${field}.at`),
    reason: value.reason as CognitionInvalidationReason,
    ...(previousRecordId ? { previousRecordId } : {}),
  };
}

function isTransitionKind(value: JsonValue | undefined): value is CognitionTransitionKind {
  return value === 'created' || value === 'evidence_added' || value === 'confirmation_requested'
    || value === 'defer_requested' || value === 'confirmed' || value === 'reconfirmed' || value === 'deferred'
    || value === 'reused' || value === 'invalidated';
}

function parseTransition(value: JsonValue, index: number): CognitionTransition {
  if (!isObject(value) || !isTransitionKind(value.kind)) {
    throw new Error(`invalid cognition transition at index ${index}`);
  }
  const transition: CognitionTransition = {
    id: requiredSafeId(value.id, `transitions[${index}].id`),
    kind: value.kind,
    at: requiredTimestamp(value.at, `transitions[${index}].at`),
  };
  const evidenceId = optionalSafeId(value.evidenceId, `transitions[${index}].evidenceId`);
  const reuseEventId = optionalSafeId(value.reuseEventId, `transitions[${index}].reuseEventId`);
  if (evidenceId) transition.evidenceId = evidenceId;
  if (reuseEventId) transition.reuseEventId = reuseEventId;
  if (value.reason !== undefined) {
    if (!['removed', 'replaced', 'content_changed', 'metadata_missing'].includes(String(value.reason))) {
      throw new Error(`invalid cognition transition reason at index ${index}`);
    }
    transition.reason = value.reason as CognitionInvalidationReason;
  }
  if (transition.kind === 'evidence_added' && !transition.evidenceId) {
    throw new Error(`cognition evidence transition is missing evidence id at index ${index}`);
  }
  if (transition.kind === 'reused' && !transition.reuseEventId) {
    throw new Error(`cognition reuse transition is missing reuse event id at index ${index}`);
  }
  if (transition.kind === 'invalidated' && !transition.reason) {
    throw new Error(`cognition invalidation transition is missing reason at index ${index}`);
  }
  if (transition.kind !== 'invalidated' && transition.reason !== undefined) {
    throw new Error(`cognition transition has an unexpected reason at index ${index}`);
  }
  if (transition.kind !== 'evidence_added' && transition.evidenceId !== undefined) {
    throw new Error(`cognition transition has an unexpected evidence id at index ${index}`);
  }
  if (transition.kind !== 'reused' && transition.reuseEventId !== undefined) {
    throw new Error(`cognition transition has an unexpected reuse event id at index ${index}`);
  }
  return transition;
}

function migratedTransitionId(assetId: string, discriminator: string): string {
  const digest = crypto.createHash('sha256').update(`${assetId}\0${discriminator}`).digest('hex').slice(0, 16);
  return `transition_${digest}`;
}

function synthesizeTransitions(asset: CognitionAsset): CognitionTransition[] {
  const transitionOrder: Record<CognitionTransitionKind, number> = {
    created: 0,
    evidence_added: 1,
    confirmation_requested: 2,
    defer_requested: 2,
    confirmed: 3,
    reconfirmed: 3,
    reused: 4,
    deferred: 5,
    invalidated: 6,
  };
  const transitions: CognitionTransition[] = [{
    id: migratedTransitionId(asset.id, 'created'), kind: 'created', at: asset.createdAt,
  }];
  for (const item of asset.evidence) transitions.push({
    id: migratedTransitionId(asset.id, `evidence:${item.id}`),
    kind: 'evidence_added', at: item.createdAt, evidenceId: item.id,
  });
  if (asset.confirmedAt) transitions.push({
    id: migratedTransitionId(asset.id, `confirmed:${asset.confirmedAt}`),
    kind: 'confirmed', at: asset.confirmedAt,
  });
  for (const item of asset.reuseEvents) transitions.push({
    id: migratedTransitionId(asset.id, `reuse:${item.id}`),
    kind: 'reused', at: item.createdAt, reuseEventId: item.id,
  });
  if (asset.invalidation) transitions.push({
    id: migratedTransitionId(asset.id, `invalidated:${asset.invalidation.at}:${asset.invalidation.reason}`),
    kind: 'invalidated', at: asset.invalidation.at, reason: asset.invalidation.reason,
  });
  if (asset.reviewState === 'deferred') transitions.push({
    id: migratedTransitionId(asset.id, `deferred:${asset.updatedAt}`),
    kind: 'deferred', at: asset.updatedAt,
  });
  if (asset.memoryTransition?.kind === 'activate') transitions.push({
    id: migratedTransitionId(asset.id, `confirmation-requested:${asset.memoryTransition.requestedAt}`),
    kind: 'confirmation_requested', at: asset.memoryTransition.requestedAt,
  });
  if (asset.memoryTransition?.kind === 'deactivate') transitions.push({
    id: migratedTransitionId(asset.id, `defer-requested:${asset.memoryTransition.requestedAt}`),
    kind: 'defer_requested', at: asset.memoryTransition.requestedAt,
  });
  return transitions.sort((left, right) => left.at.localeCompare(right.at)
    || transitionOrder[left.kind] - transitionOrder[right.kind]
    || left.id.localeCompare(right.id));
}

function parseAsset(value: JsonValue, index: number, storeVersion: number): CognitionAsset {
  const legacy = storeVersion === 1;
  if (!isObject(value)) throw new Error(`invalid cognition asset at index ${index}`);
  const stage = value.stage;
  const reviewState = value.reviewState;
  if (stage !== 'seed' && stage !== 'sprout' && stage !== 'growing' && stage !== 'bright') {
    throw new Error(`invalid cognition stage at index ${index}`);
  }
  if (reviewState !== 'pending' && reviewState !== 'confirmed'
      && reviewState !== 'deferred' && (!legacy && reviewState !== 'invalidated')) {
    throw new Error(`invalid cognition review state at index ${index}`);
  }
  if (!Array.isArray(value.evidence) || !Array.isArray(value.reuseEvents)
      || value.evidence.length > MAX_EVIDENCE_PER_ASSET
      || value.reuseEvents.length > MAX_REUSE_EVENTS_PER_ASSET) {
    throw new Error(`invalid cognition collections at index ${index}`);
  }
  const evidence = value.evidence.map((item, itemIndex) => parseEvidence(item, itemIndex));
  const reuseEvents = value.reuseEvents.map((item, itemIndex) => parseReuseEvent(item, itemIndex));
  assertUniqueIds(evidence, `assets[${index}].evidence`);
  assertUniqueIds(reuseEvents, `assets[${index}].reuseEvents`);
  const asset: CognitionAsset = {
    id: requiredSafeId(value.id, `assets[${index}].id`),
    title: requiredString(value.title, `assets[${index}].title`, MAX_TITLE_LENGTH),
    summary: requiredString(value.summary, `assets[${index}].summary`, MAX_SUMMARY_LENGTH),
    stage,
    reviewState: reviewState as CognitionReviewState,
    evidence,
    reuseEvents,
    transitions: [],
    createdAt: requiredTimestamp(value.createdAt, `assets[${index}].createdAt`),
    updatedAt: requiredTimestamp(value.updatedAt, `assets[${index}].updatedAt`),
  };
  const confirmedAt = value.confirmedAt;
  if (confirmedAt !== undefined) asset.confirmedAt = requiredTimestamp(confirmedAt, `assets[${index}].confirmedAt`);
  const transition = parseMemoryTransition(value.memoryTransition, `assets[${index}].memoryTransition`);
  const binding = parseMemoryBinding(value.memoryBinding, `assets[${index}].memoryBinding`);
  const invalidation = parseInvalidation(value.invalidation, `assets[${index}].invalidation`);
  const rawConfirmationRequestedAt = value.confirmationRequestedAt === undefined
    ? undefined
    : requiredTimestamp(value.confirmationRequestedAt, `assets[${index}].confirmationRequestedAt`);
  if (transition) {
    if (rawConfirmationRequestedAt && rawConfirmationRequestedAt !== transition.requestedAt) {
      throw new Error(`cognition confirmation request does not match transition at index ${index}`);
    }
    asset.memoryTransition = transition;
    asset.confirmationRequestedAt = transition.requestedAt;
  } else if (legacy && rawConfirmationRequestedAt) {
    if (asset.reviewState === 'deferred') {
      throw new Error(`deferred cognition asset has pending confirmation at index ${index}`);
    }
    asset.memoryTransition = {
      kind: 'activate', sourceId: asset.id, contentSha256: memoryContentHash(asset.summary),
      requestedAt: rawConfirmationRequestedAt,
    };
    asset.confirmationRequestedAt = rawConfirmationRequestedAt;
  } else if (rawConfirmationRequestedAt) {
    if (asset.reviewState === 'deferred') {
      throw new Error(`deferred cognition asset has pending confirmation at index ${index}`);
    }
    throw new Error(`cognition confirmation request is missing transition at index ${index}`);
  }
  if (binding) asset.memoryBinding = binding;
  if (invalidation) asset.invalidation = invalidation;
  if (storeVersion >= STORE_VERSION) {
    if (!Array.isArray(value.transitions) || value.transitions.length > MAX_TRANSITIONS_PER_ASSET) {
      throw new Error(`invalid cognition transitions at index ${index}`);
    }
    asset.transitions = value.transitions.map((item, itemIndex) => parseTransition(item, itemIndex));
    assertUniqueIds(asset.transitions, `assets[${index}].transition`);
  } else {
    asset.transitions = synthesizeTransitions(asset);
  }
  if (!legacy) validateAssetState(asset, index);
  return asset;
}

function validateAssetState(asset: CognitionAsset, index: number): void {
  if (!Array.isArray(asset.transitions) || !asset.transitions.length
      || asset.transitions.length > MAX_TRANSITIONS_PER_ASSET) {
    throw new Error(`invalid cognition transition history at index ${index}`);
  }
  if (asset.reviewState === 'confirmed' && !asset.evidence.length) {
    throw new Error(`confirmed cognition asset needs evidence at index ${index}`);
  }
  if (asset.transitions.length === MAX_TRANSITIONS_PER_ASSET
      && asset.transitions[asset.transitions.length - 1]?.kind !== 'invalidated') {
    throw new Error(`cognition transition history has no capacity for invalidation at index ${index}`);
  }
  const createdTransitions = asset.transitions.filter((transition) => transition.kind === 'created');
  if (createdTransitions.length !== 1 || asset.transitions[0]?.kind !== 'created'
      || createdTransitions[0].at !== asset.createdAt) {
    throw new Error(`cognition asset needs a matching created transition at index ${index}`);
  }
  const evidenceIds = new Set(asset.evidence.map((item) => item.id));
  const reuseEventIds = new Set(asset.reuseEvents.map((item) => item.id));
  const evidenceTransitionIds = new Set<string>();
  const reuseTransitionIds = new Set<string>();
  let previousAt: string | undefined;
  let active = false;
  let confirmationPending = false;
  let deferPending = false;
  let confirmedSeen = false;
  let firstConfirmedAt: string | undefined;
  let deferredSeen = false;
  let lastInvalidation: CognitionTransition | undefined;
  for (const transition of asset.transitions) {
    if (previousAt && transition.at.localeCompare(previousAt) < 0) {
      throw new Error(`cognition transition history is out of order at index ${index}`);
    }
    previousAt = transition.at;
    if (transition.evidenceId && !evidenceIds.has(transition.evidenceId)) {
      throw new Error(`cognition transition references unknown evidence at index ${index}`);
    }
    if (transition.reuseEventId && !reuseEventIds.has(transition.reuseEventId)) {
      throw new Error(`cognition transition references unknown reuse event at index ${index}`);
    }
    if (transition.kind === 'evidence_added') {
      if (!transition.evidenceId || evidenceTransitionIds.has(transition.evidenceId)) {
        throw new Error(`cognition evidence transition coverage is invalid at index ${index}`);
      }
      const evidence = asset.evidence.find((item) => item.id === transition.evidenceId);
      if (!evidence || evidence.createdAt !== transition.at) {
        throw new Error(`cognition evidence transition timestamp is invalid at index ${index}`);
      }
      evidenceTransitionIds.add(transition.evidenceId);
    }
    if (transition.kind === 'reused') {
      if (!transition.reuseEventId || reuseTransitionIds.has(transition.reuseEventId)) {
        throw new Error(`cognition reuse transition coverage is invalid at index ${index}`);
      }
      const reuseEvent = asset.reuseEvents.find((item) => item.id === transition.reuseEventId);
      if (!reuseEvent || reuseEvent.createdAt !== transition.at) {
        throw new Error(`cognition reuse transition timestamp is invalid at index ${index}`);
      }
      if (!active) throw new Error(`cognition reuse transition is not active at index ${index}`);
      reuseTransitionIds.add(transition.reuseEventId);
    }
    if (transition.kind === 'confirmation_requested') {
      if (active || confirmationPending) throw new Error(`cognition confirmation request is out of sequence at index ${index}`);
      confirmationPending = true;
      deferPending = false;
    }
    if (transition.kind === 'defer_requested') {
      if (active || deferPending) throw new Error(`cognition defer request is out of sequence at index ${index}`);
      confirmationPending = false;
      deferPending = true;
    }
    if (transition.kind === 'confirmed' || transition.kind === 'reconfirmed') {
      if (transition.kind === 'confirmed' && confirmedSeen) {
        throw new Error(`cognition asset has duplicate confirmed transitions at index ${index}`);
      }
      if (transition.kind === 'reconfirmed' && (!confirmedSeen || active)) {
        throw new Error(`cognition reconfirmation is out of sequence at index ${index}`);
      }
      if (!firstConfirmedAt) firstConfirmedAt = transition.at;
      confirmedSeen = true;
      active = true;
      confirmationPending = false;
      deferPending = false;
    }
    if (transition.kind === 'deferred') {
      deferredSeen = true;
      active = false;
      deferPending = false;
      confirmationPending = false;
    }
    if (transition.kind === 'invalidated') {
      if (!confirmedSeen) throw new Error(`cognition invalidation precedes confirmation at index ${index}`);
      lastInvalidation = transition;
      active = false;
      deferPending = false;
      confirmationPending = false;
    }
  }
  if (evidenceTransitionIds.size !== evidenceIds.size || evidenceTransitionIds.size !== asset.evidence.length) {
    throw new Error(`cognition evidence transition coverage is incomplete at index ${index}`);
  }
  if (reuseTransitionIds.size !== reuseEventIds.size || reuseTransitionIds.size !== asset.reuseEvents.length) {
    throw new Error(`cognition reuse transition coverage is incomplete at index ${index}`);
  }
  if (asset.confirmedAt !== firstConfirmedAt) {
    throw new Error(`cognition confirmation timestamp does not match history at index ${index}`);
  }
  if (asset.reviewState === 'confirmed' && !confirmedSeen) {
    throw new Error(`confirmed cognition asset has no confirmation transition at index ${index}`);
  }
  if (asset.reviewState === 'deferred' && !deferredSeen) {
    throw new Error(`deferred cognition asset has no deferred transition at index ${index}`);
  }
  if (asset.reviewState === 'invalidated'
      && (!lastInvalidation || !asset.invalidation || lastInvalidation.at !== asset.invalidation.at
        || lastInvalidation.reason !== asset.invalidation.reason)) {
    throw new Error(`invalidated cognition asset has no matching invalidation transition at index ${index}`);
  }
  if (asset.memoryTransition?.kind === 'activate') {
    const request = asset.transitions.slice().reverse().find((transition) => transition.kind === 'confirmation_requested');
    if (!request || request.at !== asset.memoryTransition.requestedAt) {
      throw new Error(`cognition activation transition is missing its history event at index ${index}`);
    }
  }
  if (asset.memoryTransition?.kind === 'deactivate') {
    const request = asset.transitions.slice().reverse().find((transition) => transition.kind === 'defer_requested');
    if (!request || request.at !== asset.memoryTransition.requestedAt) {
      throw new Error(`cognition deactivation transition is missing its history event at index ${index}`);
    }
  }
  if (asset.memoryTransition && (!confirmationPending && asset.memoryTransition.kind === 'activate'
      || !deferPending && asset.memoryTransition.kind === 'deactivate')) {
    throw new Error(`cognition memory transition is inconsistent with history at index ${index}`);
  }
  if (active !== (asset.reviewState === 'confirmed')) {
    throw new Error(`cognition transition history does not match review state at index ${index}`);
  }
  const reviewActive = asset.reviewState === 'confirmed';
  if (reviewActive && (!asset.confirmedAt || !asset.memoryBinding || asset.memoryTransition)) {
    throw new Error(`confirmed cognition asset is not actively bound at index ${index}`);
  }
  if (asset.reviewState === 'invalidated'
      && (!asset.confirmedAt || !asset.invalidation || asset.memoryBinding)) {
    throw new Error(`invalidated cognition asset is inconsistent at index ${index}`);
  }
  if ((asset.reviewState === 'pending' || asset.reviewState === 'deferred') && asset.memoryBinding) {
    throw new Error(`unconfirmed cognition asset has memory binding at index ${index}`);
  }
  const pendingReactivation = asset.reviewState === 'pending'
    && asset.memoryTransition?.kind === 'activate' && confirmedSeen;
  if (asset.reviewState === 'pending' && asset.confirmedAt && !pendingReactivation) {
    throw new Error(`pending cognition asset has confirmation timestamp at index ${index}`);
  }
  if (asset.reviewState === 'deferred' && asset.memoryTransition) {
    throw new Error(`deferred cognition asset has pending transition at index ${index}`);
  }
  if (asset.memoryTransition
      && (asset.memoryTransition.sourceId !== asset.id
        || asset.memoryTransition.contentSha256 !== memoryContentHash(asset.summary))) {
    throw new Error(`cognition memory transition does not match asset at index ${index}`);
  }
  if (asset.memoryBinding
      && (asset.memoryBinding.sourceId !== asset.id
        || asset.memoryBinding.contentSha256 !== memoryContentHash(asset.summary))) {
    throw new Error(`cognition memory binding does not match asset at index ${index}`);
  }
  if (asset.reviewState !== 'invalidated' && asset.invalidation) {
    throw new Error(`active cognition asset has stale invalidation at index ${index}`);
  }
  if (asset.memoryTransition?.kind === 'activate'
      && asset.reviewState !== 'pending' && asset.reviewState !== 'invalidated') {
    throw new Error(`cognition activation transition has invalid review state at index ${index}`);
  }
  if (asset.reviewState === 'invalidated' && asset.memoryTransition?.kind === 'activate'
      && !asset.invalidation) {
    throw new Error(`invalidated cognition activation lost its reason at index ${index}`);
  }
  if (asset.memoryTransition?.kind === 'deactivate'
      && asset.reviewState !== 'pending' && asset.reviewState !== 'invalidated') {
    throw new Error(`cognition deactivation transition has invalid review state at index ${index}`);
  }
  if (asset.reviewState === 'pending' && asset.reuseEvents.length && !pendingReactivation) {
    throw new Error(`pending cognition asset has reuse events at index ${index}`);
  }
  if (asset.reviewState === 'deferred' && asset.reuseEvents.length && !asset.confirmedAt) {
    throw new Error(`never-confirmed deferred cognition asset has reuse events at index ${index}`);
  }
  const derivedStage = deriveCognitionStage(asset.reviewState, asset.evidence.length, asset.reuseEvents.length);
  if (asset.stage !== derivedStage) throw new Error(`inconsistent cognition stage at index ${index}`);
}

function emptyStore(): CognitionStore {
  return { version: STORE_VERSION, assets: [] };
}

function storeBytes(store: CognitionStore): number {
  // storage.writeJson persists two-space-indented JSON, so the admission
  // check must measure those exact bytes rather than the smaller compact form.
  return Buffer.byteLength(JSON.stringify(store, null, 2), 'utf8');
}

async function readStore(userId: string): Promise<CognitionStore> {
  assertUserId(userId);
  try {
    const text = await fs.readFile(userCognitionFile(userId), 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > COGNITION_STORE_BYTE_LIMIT) {
      throw new Error(`cognition store exceeds ${COGNITION_STORE_BYTE_LIMIT} UTF-8 bytes`);
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(text) as JsonValue;
    } catch (error) {
      throw new Error(`invalid cognition store JSON for user ${userId}`, { cause: error });
    }
    if (!isObject(parsed) || !Array.isArray(parsed.assets)
        || (parsed.version !== STORE_VERSION
          && (typeof parsed.version !== 'number' || !LEGACY_STORE_VERSIONS.has(parsed.version)))) {
      throw new Error(`invalid cognition store schema for user ${userId}`);
    }
    if (parsed.assets.length > MAX_ASSETS) throw new Error(`cognition asset count exceeds ${MAX_ASSETS}`);
    const storeVersion = parsed.version as number;
    const assets = parsed.assets.map((item, index) => parseAsset(item, index, storeVersion));
    assertUniqueIds(assets, 'asset');
    return { version: STORE_VERSION, assets };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    log.error('read cognition store failed', { user_id: maskId(userId), error: logErrorSummary(error) });
    throw error;
  }
}

function notifyDirty(): void {
  if (syncDirtyNotifierForTest) {
    syncDirtyNotifierForTest('cognition', 'cloud/cognition/assets.json');
    return;
  }
  try {
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('cognition', 'cloud/cognition/assets.json');
  } catch { /* hosted sync is stripped from the open-source build */ }
}

async function writeStore(userId: string, store: CognitionStore): Promise<void> {
  assertUserId(userId);
  if (store.assets.length > MAX_ASSETS) throw new Error(`cognition asset count exceeds ${MAX_ASSETS}`);
  store.assets.forEach((asset, index) => validateAssetState(asset, index));
  const bytes = storeBytes(store);
  if (bytes > COGNITION_STORE_BYTE_LIMIT) {
    throw new Error(`cognition store exceeds ${COGNITION_STORE_BYTE_LIMIT} UTF-8 bytes`);
  }
  await writeJson(userCognitionFile(userId), store);
  notifyDirty();
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function normalizedText(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`invalid cognition ${field}`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new Error(`invalid cognition ${field}`);
  return trimmed;
}

function validatedOptionalId(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!safeId(value) || value.length > MAX_ID_LENGTH) throw new Error(`invalid cognition ${field}`);
  return value;
}

function validateEvidenceInput(input: CognitionEvidenceInput): CognitionEvidenceInput {
  if (!input || (input.kind !== 'conversation' && input.kind !== 'project'
      && input.kind !== 'execution' && input.kind !== 'manual')) throw new Error('invalid cognition evidence kind');
  const conversationId = validatedOptionalId(input.conversationId, 'evidence conversationId');
  const projectId = validatedOptionalId(input.projectId, 'evidence projectId');
  return {
    kind: input.kind,
    summary: normalizedText(input.summary, 'evidence summary', MAX_SUMMARY_LENGTH),
    sourceLabel: normalizedText(input.sourceLabel, 'evidence sourceLabel', MAX_SOURCE_LABEL_LENGTH),
    ...(conversationId ? { conversationId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

function validateReuseInput(input: CognitionReuseInput): CognitionReuseInput {
  if (!input || typeof input !== 'object') throw new Error('invalid cognition reuse input');
  const conversationId = validatedOptionalId(input.conversationId, 'reuse conversationId');
  const projectId = validatedOptionalId(input.projectId, 'reuse projectId');
  return {
    sourceLabel: normalizedText(input.sourceLabel, 'reuse sourceLabel', MAX_SOURCE_LABEL_LENGTH),
    ...(conversationId ? { conversationId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

export function deriveCognitionStage(
  reviewState: CognitionReviewState,
  evidenceCount: number,
  reuseCount: number,
): CognitionStage {
  if (!Number.isInteger(evidenceCount) || evidenceCount < 0) throw new Error('invalid cognition evidence count');
  if (!Number.isInteger(reuseCount) || reuseCount < 0) throw new Error('invalid cognition reuse count');
  if (reviewState === 'confirmed') return reuseCount >= BRIGHT_REUSE_THRESHOLD ? 'bright' : 'growing';
  return evidenceCount > 0 ? 'sprout' : 'seed';
}

function refreshStage(asset: CognitionAsset): void {
  asset.stage = deriveCognitionStage(asset.reviewState, asset.evidence.length, asset.reuseEvents.length);
  asset.updatedAt = nowIso();
}

function appendTransition(
  asset: CognitionAsset,
  kind: CognitionTransitionKind,
  details: Pick<CognitionTransition, 'reason' | 'evidenceId' | 'reuseEventId'> = {},
  at = nowIso(),
): CognitionTransition {
  const maxTransitions = kind === 'invalidated'
    ? MAX_TRANSITIONS_PER_ASSET
    : MAX_NON_INVALIDATION_TRANSITIONS;
  if (asset.transitions.length >= maxTransitions) {
    throw new Error(`cognition transition count exceeds ${MAX_TRANSITIONS_PER_ASSET}`);
  }
  const transition: CognitionTransition = { id: newId('transition'), kind, at, ...details };
  asset.transitions.push(transition);
  return transition;
}

function assertTransitionCapacity(asset: CognitionAsset, additional: number): void {
  if (!Number.isSafeInteger(additional) || additional < 0
      || asset.transitions.length + additional > MAX_NON_INVALIDATION_TRANSITIONS) {
    throw new Error(`cognition transition count exceeds ${MAX_TRANSITIONS_PER_ASSET}`);
  }
}

function invalidateAsset(asset: CognitionAsset, reason: CognitionInvalidationReason): void {
  if (asset.transitions.length >= MAX_TRANSITIONS_PER_ASSET) {
    throw new Error(`cognition transition count exceeds ${MAX_TRANSITIONS_PER_ASSET}`);
  }
  const at = nowIso();
  const previousRecordId = asset.memoryBinding?.recordId;
  asset.reviewState = 'invalidated';
  asset.invalidation = { at, reason, ...(previousRecordId ? { previousRecordId } : {}) };
  delete asset.memoryBinding;
  delete asset.memoryTransition;
  delete asset.confirmationRequestedAt;
  appendTransition(asset, 'invalidated', { reason }, at);
  refreshStage(asset);
}

function reconcileAsset(
  userId: string,
  asset: CognitionAsset,
  transaction: CognitionMemoryTransaction,
): boolean {
  assertCognitionMemoryTransaction(transaction, userId);
  if (asset.memoryTransition?.kind === 'deactivate') {
    // The intent may have been persisted before the final cognition write
    // failed. Reserve the completion event before touching the shared memory
    // file so recovery cannot leave an un-audited deferred state.
    assertTransitionCapacity(asset, 1);
    const detached = detachCognitionMemoryEntryLocked(userId, asset.id, transaction);
    if (!detached.ok) {
      if (detached.error === 'corrupt_metadata') {
        invalidateAsset(asset, 'metadata_missing');
        return true;
      }
      throw new Error(`cognition memory detach failed: ${detached.error || 'unknown error'}`);
    }
    asset.reviewState = 'deferred';
    delete asset.memoryBinding;
    delete asset.memoryTransition;
    delete asset.confirmationRequestedAt;
    delete asset.invalidation;
    appendTransition(asset, 'deferred');
    refreshStage(asset);
    return true;
  }
  if (asset.memoryTransition?.kind === 'activate') {
    // An activation intent deliberately remains incomplete until an explicit
    // confirm retry. Reads must not silently cross the human confirmation
    // boundary, even if a prior attempt already wrote the MEMORY record.
    return false;
  }
  if (asset.reviewState !== 'confirmed') return false;
  let current;
  try {
    current = findCognitionMemoryEntryLocked(userId, asset.id, transaction);
  } catch (error) {
    if (!(error instanceof CorruptMemoryMetadataError)) throw error;
    invalidateAsset(asset, 'metadata_missing');
    return true;
  }
  if (!current) {
    invalidateAsset(asset, 'metadata_missing');
    return true;
  }
  const expectedHash = memoryContentHash(asset.summary);
  if (current.contentSha256 !== expectedHash || current.text !== asset.summary) {
    invalidateAsset(asset, 'content_changed');
    return true;
  }
  if (!asset.memoryBinding || asset.memoryBinding.recordId !== current.recordId
      || asset.memoryBinding.contentSha256 !== expectedHash) {
    asset.memoryBinding = {
      sourceId: asset.id,
      recordId: current.recordId,
      contentSha256: expectedHash,
      activatedAt: asset.confirmedAt || nowIso(),
    };
    delete asset.memoryTransition;
    delete asset.confirmationRequestedAt;
    refreshStage(asset);
    return true;
  }
  return false;
}

function reconcileStore(
  userId: string,
  store: CognitionStore,
  transaction: CognitionMemoryTransaction,
): boolean {
  assertCognitionMemoryTransaction(transaction, userId);
  let changed = false;
  for (const asset of store.assets) changed = reconcileAsset(userId, asset, transaction) || changed;
  return changed;
}

async function reconciledStore(
  userId: string,
  transaction: CognitionMemoryTransaction,
): Promise<CognitionStore> {
  assertCognitionMemoryTransaction(transaction, userId);
  const store = await readStore(userId);
  if (reconcileStore(userId, store, transaction)) await writeStore(userId, store);
  return store;
}

async function mutateAsset(
  userId: string,
  assetId: string,
  mutation: (asset: CognitionAsset) => void,
): Promise<CognitionAsset> {
  assertUserId(userId);
  if (!safeId(assetId) || assetId.length > MAX_ID_LENGTH) throw new Error('invalid cognition asset id');
  return withCognitionMemoryTransaction(userId, async (transaction) => {
    const store = await reconciledStore(userId, transaction);
    const asset = store.assets.find((item) => item.id === assetId);
    if (!asset) throw new Error('cognition asset not found');
    mutation(asset);
    refreshStage(asset);
    const result = structuredClone(asset);
    await writeStore(userId, store);
    return result;
  });
}

function newAsset(title: string, summary: string, evidence: CognitionEvidence[]): CognitionAsset {
  const timestamp = nowIso();
  const asset: CognitionAsset = {
    id: newId('cog'), title, summary,
    stage: evidence.length ? 'sprout' : 'seed', reviewState: 'pending', evidence, reuseEvents: [],
    transitions: [], createdAt: timestamp, updatedAt: timestamp,
  };
  appendTransition(asset, 'created', {}, timestamp);
  for (const item of evidence) appendTransition(asset, 'evidence_added', { evidenceId: item.id }, item.createdAt);
  return asset;
}

export async function createCognitionAsset(userId: string, input: CognitionCreateInput): Promise<CognitionAsset> {
  assertUserId(userId);
  if (!input || typeof input !== 'object') throw new Error('invalid cognition create input');
  const title = normalizedText(input.title, 'title', MAX_TITLE_LENGTH);
  const summary = normalizedText(input.summary, 'summary', MAX_SUMMARY_LENGTH);
  return withCognitionMemoryTransaction(userId, async (transaction) => {
    const store = await reconciledStore(userId, transaction);
    if (store.assets.length >= MAX_ASSETS) throw new Error(`cognition asset count exceeds ${MAX_ASSETS}`);
    const asset = newAsset(title, summary, []);
    store.assets.push(asset);
    await writeStore(userId, store);
    return structuredClone(asset);
  });
}

export async function createCognitionAssetWithEvidence(
  userId: string,
  input: CognitionCaptureInput,
): Promise<CognitionAsset> {
  assertUserId(userId);
  if (!input || typeof input !== 'object') throw new Error('invalid cognition capture input');
  const title = normalizedText(input.title, 'title', MAX_TITLE_LENGTH);
  const summary = normalizedText(input.summary, 'summary', MAX_SUMMARY_LENGTH);
  const evidenceInput = validateEvidenceInput(input.evidence);
  return withCognitionMemoryTransaction(userId, async (transaction) => {
    const store = await reconciledStore(userId, transaction);
    if (store.assets.length >= MAX_ASSETS) throw new Error(`cognition asset count exceeds ${MAX_ASSETS}`);
    const createdAt = nowIso();
    const asset = newAsset(title, summary, [{ id: newId('evidence'), ...evidenceInput, createdAt }]);
    store.assets.push(asset);
    await writeStore(userId, store);
    return structuredClone(asset);
  });
}

function sortedAssets(store: CognitionStore): CognitionAsset[] {
  return store.assets.slice().sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

export async function listCognitionAssets(userId: string): Promise<CognitionAsset[]> {
  return withCognitionMemoryTransaction(userId, async (transaction) =>
    sortedAssets(await reconciledStore(userId, transaction)).map((asset) => structuredClone(asset)));
}

export async function listActiveCognitionSourceIds(userId: string): Promise<ReadonlySet<string>> {
  return withCognitionMemoryTransaction(userId, async (transaction) => {
    const store = await reconciledStore(userId, transaction);
    return new Set(store.assets
      .filter((asset) => asset.reviewState === 'confirmed')
      .map((asset) => asset.id));
  });
}

export async function listCognitionAssetPage(
  userId: string,
  page = 1,
  pageSize = DEFAULT_COGNITION_PAGE_SIZE,
): Promise<CognitionAssetPage> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('invalid cognition page');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_COGNITION_PAGE_SIZE) {
    throw new Error('invalid cognition page size');
  }
  return withCognitionMemoryTransaction(userId, async (transaction) => {
    const assets = sortedAssets(await reconciledStore(userId, transaction));
    const offset = (page - 1) * pageSize;
    return {
      items: assets.slice(offset, offset + pageSize).map((asset) => ({
        id: asset.id,
        title: asset.title,
        summary: asset.summary,
        stage: asset.stage,
        reviewState: asset.reviewState,
        evidenceCount: asset.evidence.length,
        reuseCount: asset.reuseEvents.length,
        updatedAt: asset.updatedAt,
        ...(asset.confirmationRequestedAt ? { confirmationRequestedAt: asset.confirmationRequestedAt } : {}),
        ...(asset.invalidation ? { invalidation: structuredClone(asset.invalidation) } : {}),
      })),
      page,
      pageSize,
      total: assets.length,
      totalPages: Math.ceil(assets.length / pageSize),
    };
  });
}

export async function getCognitionAsset(userId: string, assetId: string): Promise<CognitionAsset> {
  assertUserId(userId);
  if (!safeId(assetId) || assetId.length > MAX_ID_LENGTH) throw new Error('invalid cognition asset id');
  return withCognitionMemoryTransaction(userId, async (transaction) => {
    const store = await reconciledStore(userId, transaction);
    const asset = store.assets.find((item) => item.id === assetId);
    if (!asset) throw new Error('cognition asset not found');
    return structuredClone(asset);
  });
}

export async function addCognitionEvidence(
  userId: string,
  assetId: string,
  input: CognitionEvidenceInput,
): Promise<CognitionAsset> {
  const evidence = validateEvidenceInput(input);
  return mutateAsset(userId, assetId, (asset) => {
    if (asset.evidence.length >= MAX_EVIDENCE_PER_ASSET) {
      throw new Error(`cognition evidence count exceeds ${MAX_EVIDENCE_PER_ASSET}`);
    }
    const item = { id: newId('evidence'), ...evidence, createdAt: nowIso() };
    asset.evidence.push(item);
    appendTransition(asset, 'evidence_added', { evidenceId: item.id }, item.createdAt);
  });
}

export async function confirmCognitionAsset(userId: string, assetId: string): Promise<CognitionAsset> {
  assertUserId(userId);
  if (!safeId(assetId) || assetId.length > MAX_ID_LENGTH) throw new Error('invalid cognition asset id');
  return withCognitionMemoryTransaction(userId, async (transaction) => {
    const store = await reconciledStore(userId, transaction);
    const asset = store.assets.find((item) => item.id === assetId);
    if (!asset) throw new Error('cognition asset not found');
    if (!asset.evidence.length) throw new Error('cognition asset needs evidence before confirmation');
    if (asset.reviewState === 'confirmed' && !reconcileAsset(userId, asset, transaction)) return structuredClone(asset);

    const wasPreviouslyConfirmed = Boolean(asset.confirmedAt);
    const threat = scanForInjection(asset.summary);
    if (threat) throw new Error(`cognition confirmation blocked: suspicious content (${threat})`);
    const hash = memoryContentHash(asset.summary);
    const existingTransition = asset.memoryTransition;
    if (existingTransition?.kind === 'activate' && existingTransition.contentSha256 !== hash) {
      throw new Error('cognition activation content changed during retry');
    }
    assertTransitionCapacity(asset, existingTransition?.kind === 'activate' ? 1 : 2);
    if (!existingTransition || existingTransition.kind !== 'activate') {
      const requestedAt = nowIso();
      if (asset.reviewState === 'deferred') asset.reviewState = 'pending';
      asset.memoryTransition = { kind: 'activate', sourceId: asset.id, contentSha256: hash, requestedAt };
      asset.confirmationRequestedAt = requestedAt;
      appendTransition(asset, 'confirmation_requested', {}, requestedAt);
      refreshStage(asset);
      await writeStore(userId, store);
    }

    let memoryResult;
    try {
      memoryResult = ensureCognitionMemoryEntryLocked(userId, asset.id, asset.summary, transaction);
    } catch (error) {
      throw new Error('cognition memory write failed', { cause: error });
    }
    if (!memoryResult.ok || !memoryResult.record) {
      throw new Error(`cognition memory write failed: ${memoryResult.error || 'unknown error'}`);
    }

    const confirmedAt = asset.memoryTransition.requestedAt;
    asset.reviewState = 'confirmed';
    asset.confirmedAt = asset.confirmedAt || confirmedAt;
    asset.memoryBinding = {
      sourceId: asset.id,
      recordId: memoryResult.record.recordId,
      contentSha256: hash,
      activatedAt: confirmedAt,
    };
    delete asset.memoryTransition;
    delete asset.confirmationRequestedAt;
    delete asset.invalidation;
    appendTransition(asset, wasPreviouslyConfirmed ? 'reconfirmed' : 'confirmed', {}, confirmedAt);
    refreshStage(asset);
    const result = structuredClone(asset);
    await writeStore(userId, store);
    return result;
  });
}

export async function deferCognitionAsset(userId: string, assetId: string): Promise<CognitionAsset> {
  assertUserId(userId);
  if (!safeId(assetId) || assetId.length > MAX_ID_LENGTH) throw new Error('invalid cognition asset id');
  return withCognitionMemoryTransaction(userId, async (transaction) => {
    const store = await readStore(userId);
    const asset = store.assets.find((item) => item.id === assetId);
    if (!asset) throw new Error('cognition asset not found');
    if (asset.reviewState === 'confirmed') throw new Error('confirmed cognition asset cannot be deferred');

    if (!asset.memoryTransition || asset.memoryTransition.kind !== 'deactivate') {
      const requestedAt = nowIso();
      if (asset.reviewState === 'deferred' && !asset.memoryTransition) return structuredClone(asset);
      assertTransitionCapacity(asset, 2);
      if (asset.reviewState !== 'invalidated') asset.reviewState = 'pending';
      asset.memoryTransition = {
        kind: 'deactivate',
        sourceId: asset.id,
        contentSha256: memoryContentHash(asset.summary),
        requestedAt,
      };
      asset.confirmationRequestedAt = requestedAt;
      appendTransition(asset, 'defer_requested', {}, requestedAt);
      // A deactivate transition is a valid in-flight form of an invalidated
      // asset; the invalidation is cleared only after the detach is durable.
      refreshStage(asset);
      await writeStore(userId, store);
    } else {
      assertTransitionCapacity(asset, 1);
    }
    const detached = detachCognitionMemoryEntryLocked(userId, asset.id, transaction);
    if (!detached.ok) throw new Error(`cognition memory detach failed: ${detached.error || 'unknown error'}`);
    asset.reviewState = 'deferred';
    delete asset.memoryBinding;
    delete asset.memoryTransition;
    delete asset.confirmationRequestedAt;
    delete asset.invalidation;
    appendTransition(asset, 'deferred');
    refreshStage(asset);
    const result = structuredClone(asset);
    await writeStore(userId, store);
    return result;
  });
}

export async function invalidateCognitionMemorySources(
  userId: string,
  sourceIds: string[],
  reason: Extract<CognitionInvalidationReason, 'removed' | 'replaced'>,
): Promise<void> {
  return withCognitionMemoryTransaction(userId, (transaction) =>
    invalidateCognitionMemorySourcesLocked(userId, sourceIds, reason, transaction));
}

/** Internal transaction body used by memory's cross-file rollback workflow.
 * Public callers must use `invalidateCognitionMemorySources`. */
export async function invalidateCognitionMemorySourcesLocked(
  userId: string,
  sourceIds: string[],
  reason: Extract<CognitionInvalidationReason, 'removed' | 'replaced'>,
  transaction: CognitionMemoryTransaction,
): Promise<void> {
  assertCognitionMemoryTransaction(transaction, userId);
  assertUserId(userId);
  const validIds = new Set(sourceIds.map((sourceId) => {
    if (!safeId(sourceId) || sourceId.length > MAX_ID_LENGTH) throw new Error('invalid cognition memory source id');
    return sourceId;
  }));
  if (!validIds.size) return;
  const store = await readStore(userId);
  let changed = false;
  for (const asset of store.assets) {
    if (validIds.has(asset.id) && asset.reviewState === 'confirmed') {
      invalidateAsset(asset, reason);
      changed = true;
    }
  }
  // Preserve the renderer/model operation's precise audit reason for the
  // sources it just detached, then reconcile every unrelated active asset.
  changed = reconcileStore(userId, store, transaction) || changed;
  if (changed) await writeStore(userId, store);
}

export async function recordCognitionReuse(
  userId: string,
  assetId: string,
  input: CognitionReuseInput,
): Promise<CognitionAsset> {
  const reuse = validateReuseInput(input);
  return mutateAsset(userId, assetId, (asset) => {
    if (asset.reviewState !== 'confirmed') throw new Error('only actively confirmed cognition assets can be reused');
    if (asset.reuseEvents.length >= MAX_REUSE_EVENTS_PER_ASSET) {
      throw new Error(`cognition reuse count exceeds ${MAX_REUSE_EVENTS_PER_ASSET}`);
    }
    const event = { id: newId('reuse'), ...reuse, createdAt: nowIso() };
    asset.reuseEvents.push(event);
    appendTransition(asset, 'reused', { reuseEventId: event.id }, event.createdAt);
  });
}
