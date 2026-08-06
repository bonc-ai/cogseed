import type { Agent } from '../agents';
import type { WorkflowAttempt } from './collaboration';
import type { Actor } from './state';

const MAX_RECOVERY_ATTEMPTS = 4;
const DEFAULT_MINIMUM_SCORE = 20;
const MAX_TEXT_LENGTH = 16_384;
const MAX_LIST_ITEMS = 256;
const MAX_ID_LENGTH = 512;
const MAX_TOKEN_LENGTH = 128;
const MAX_TOKENS = 1_024;
const POINTS_PER_TOKEN = 5;
const TOKEN_SCORE_CAP = 20;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_ENTRIES = 4_096;
const MAX_CANONICAL_KEYS = 256;
const MAX_CANONICAL_KEY_LENGTH = 512;
const MAX_CANONICAL_STRING_LENGTH = 65_536;
const MAX_CANONICAL_OUTPUT_LENGTH = 262_144;
const AGENT_SNAPSHOT_FIELDS: readonly (keyof Agent)[] = [
  'agent_id',
  'name',
  'description_zh',
  'description_en',
  'workflow',
  'icon',
  'color',
  'skill_list',
  'inputs',
  'interactive',
  'profile',
  'runtime_stats',
  'runtime',
  'interface_contract',
  'category',
  'enabled_connectors',
  'output_format',
  'source',
  'created_at',
  'updated_at',
  'enabled',
  'create_uid',
  'version',
  'marketplace_published_at',
  'marketplace_updated_at',
  'default_install',
  'is_open_source',
  'status',
  'seed_source',
];

export type RecoveryAction =
  | { kind: 'retry_same' }
  | { kind: 'select_fallback' }
  | { kind: 'run_anonymous' }
  | { kind: 'return_commander' }
  | { kind: 'stop' };

interface DecisionAttempt {
  attempt: number;
  actor_id: string | null;
  actor_kind: WorkflowAttempt['actor_kind'];
  failure_code: NonNullable<WorkflowAttempt['failure_code']>;
  started_at_ms: number;
  completed_at_ms: number;
}

const FAILURE_CODES = new Set<NonNullable<WorkflowAttempt['failure_code']>>([
  'coordinator_tool_idle',
  'coordinator_agent_idle',
  'runtime_failed',
  'dependency_failed',
]);

const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:(Z)|([+-])(\d{2}):(\d{2}))?$/;

interface ParsedTimestamp {
  explicitZone: boolean;
  instantMs: number;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function parseTimestamp(value: unknown): ParsedTimestamp | null {
  if (typeof value !== 'string') return null;
  const timestamp = value.trim();
  const match = ISO_TIMESTAMP_PATTERN.exec(timestamp);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour < 0
    || hour > 23
    || minute < 0
    || minute > 59
    || second < 0
    || second > 59
  ) return null;

  const hasZuluZone = match[8] === 'Z';
  const hasNumericZone = match[9] === '+' || match[9] === '-';
  if (hasNumericZone) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (
      offsetHour > 14
      || offsetMinute > 59
      || (offsetHour === 14 && offsetMinute !== 0)
    ) return null;
  }

  const instantMs = Date.parse(timestamp);
  if (!Number.isFinite(instantMs)) return null;
  return {
    explicitZone: hasZuluZone || hasNumericZone,
    instantMs,
  };
}

function decisionAttempt(value: unknown, expectedAttempt: number): DecisionAttempt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.attempt !== expectedAttempt || raw.status !== 'failed') return null;
  if (raw.actor_kind !== 'agent' && raw.actor_kind !== 'anonymous_worker') return null;
  if (
    typeof raw.failure_code !== 'string'
    || !FAILURE_CODES.has(raw.failure_code as NonNullable<WorkflowAttempt['failure_code']>)
  ) {
    return null;
  }
  if (raw.actor_kind === 'agent') {
    if (
      typeof raw.actor_id !== 'string'
      || !raw.actor_id
      || raw.actor_id !== raw.actor_id.trim()
      || raw.actor_id.length > MAX_ID_LENGTH
    ) return null;
  } else if (raw.actor_id !== null) {
    return null;
  }
  const startedAt = parseTimestamp(raw.started_at);
  const completedAt = parseTimestamp(raw.completed_at);
  if (
    !startedAt
    || !completedAt
    || (startedAt.explicitZone
      && completedAt.explicitZone
      && completedAt.instantMs < startedAt.instantMs)
  ) {
    return null;
  }
  return {
    attempt: expectedAttempt,
    actor_id: raw.actor_id as string | null,
    actor_kind: raw.actor_kind,
    failure_code: raw.failure_code as NonNullable<WorkflowAttempt['failure_code']>,
    started_at_ms: startedAt.instantMs,
    completed_at_ms: completedAt.instantMs,
  };
}

function isCoordinatorIdleFailure(failureCode: DecisionAttempt['failure_code']): boolean {
  return failureCode === 'coordinator_tool_idle'
    || failureCode === 'coordinator_agent_idle';
}

function recoveryActionForHistory(attempts: DecisionAttempt[]): RecoveryAction | null {
  const original = attempts[0];
  if (!original || original.actor_kind !== 'agent' || !original.actor_id) return null;

  const originalId = original.actor_id;
  let expectedTier: 'same' | 'fallback' | 'anonymous' | 'terminal' =
    isCoordinatorIdleFailure(original.failure_code) ? 'same' : 'fallback';

  for (let index = 1; index < attempts.length; index += 1) {
    const current = attempts[index];
    if (expectedTier === 'same') {
      if (current.actor_kind !== 'agent' || current.actor_id !== originalId) return null;
      expectedTier = 'fallback';
      continue;
    }
    if (expectedTier === 'fallback') {
      if (current.actor_kind === 'anonymous_worker') {
        expectedTier = 'terminal';
        continue;
      }
      if (current.actor_kind !== 'agent' || current.actor_id === originalId) return null;
      expectedTier = 'anonymous';
      continue;
    }
    if (expectedTier === 'anonymous') {
      if (current.actor_kind !== 'anonymous_worker') return null;
      expectedTier = 'terminal';
      continue;
    }
    return null;
  }

  if (expectedTier === 'same') return { kind: 'retry_same' };
  if (expectedTier === 'fallback') return { kind: 'select_fallback' };
  if (expectedTier === 'anonymous') return { kind: 'run_anonymous' };
  return { kind: 'return_commander' };
}

export function nextRecoveryAction(input: {
  attempts: WorkflowAttempt[];
  abortSource?: 'user' | 'group_abort' | 'parent_abort' | 'coordinator';
}): RecoveryAction {
  if (
    input?.abortSource === 'user'
    || input?.abortSource === 'group_abort'
    || input?.abortSource === 'parent_abort'
  ) {
    return { kind: 'stop' };
  }

  const rawAttempts = input?.attempts as unknown;
  if (!Array.isArray(rawAttempts) || rawAttempts.length === 0) {
    return { kind: 'return_commander' };
  }
  if (rawAttempts.length >= MAX_RECOVERY_ATTEMPTS) {
    return { kind: 'return_commander' };
  }

  const attempts = rawAttempts.map((value, index) => decisionAttempt(value, index + 1));
  if (attempts.some((value) => value === null)) return { kind: 'return_commander' };
  return recoveryActionForHistory(attempts as DecisionAttempt[])
    ?? { kind: 'return_commander' };
}

export interface FallbackCandidate {
  actor: Actor;
  agent: Agent;
  score: number;
}

function boundedString(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT_LENGTH) : '';
}

function normalizeText(value: unknown): string {
  const input = boundedString(value).toLowerCase();
  let output = '';
  let pendingSpace = false;
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isWhitespace = codePoint <= 0x20
      || codePoint === 0x85
      || codePoint === 0xa0
      || codePoint === 0x1680
      || (codePoint >= 0x2000 && codePoint <= 0x200a)
      || codePoint === 0x2028
      || codePoint === 0x2029
      || codePoint === 0x202f
      || codePoint === 0x205f
      || codePoint === 0x3000;
    if (isWhitespace) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) output += ' ';
    output += character;
    pendingSpace = false;
  }
  return output;
}

function isAsciiTokenCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x30 && codePoint <= 0x39)
    || (codePoint >= 0x61 && codePoint <= 0x7a);
}

function isHanCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x20000 && codePoint <= 0x2fa1f);
}

function tokensFor(value: unknown): Set<string> {
  const tokens = new Set<string>();
  const input = boundedString(value).toLowerCase();
  let ascii = '';
  let han: string[] = [];

  const flushAscii = () => {
    if (ascii && tokens.size < MAX_TOKENS) tokens.add(ascii.slice(0, MAX_TOKEN_LENGTH));
    ascii = '';
  };
  const flushHan = () => {
    for (let index = 0; index + 1 < han.length; index += 1) {
      if (tokens.size >= MAX_TOKENS) break;
      tokens.add(han[index] + han[index + 1]);
    }
    han = [];
  };

  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isAsciiTokenCodePoint(codePoint)) {
      flushHan();
      if (ascii.length < MAX_TOKEN_LENGTH) ascii += character;
      continue;
    }
    if (isHanCodePoint(codePoint)) {
      flushAscii();
      han.push(character);
      continue;
    }
    flushAscii();
    flushHan();
  }
  flushAscii();
  flushHan();
  return tokens;
}

function addTokens(target: Set<string>, source: Set<string>): void {
  for (const token of source) target.add(token);
}

function tokenMatchScore(taskTokens: Set<string>, candidateTokens: Set<string>): number {
  let matched = 0;
  for (const token of taskTokens) {
    if (!candidateTokens.has(token)) continue;
    matched += 1;
    if (matched * POINTS_PER_TOKEN >= TOKEN_SCORE_CAP) return TOKEN_SCORE_CAP;
  }
  return matched * POINTS_PER_TOKEN;
}

function validActor(value: unknown): value is Actor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actor = value as Record<string, unknown>;
  return actor.kind === 'agent'
    && typeof actor.id === 'string'
    && !!actor.id.trim()
    && actor.id.length <= MAX_ID_LENGTH
    && (actor.name === undefined || typeof actor.name === 'string')
    && typeof actor.joined_at === 'string';
}

function actorKey(actor: Actor): string {
  return `${actor.id}\u0000${actor.name ?? ''}\u0000${actor.joined_at}`;
}

function validAgent(value: unknown): value is Agent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.agent_id === 'string'
    && !!candidate.agent_id.trim()
    && candidate.agent_id.length <= MAX_ID_LENGTH
    && typeof candidate.name === 'string'
    && typeof candidate.description_zh === 'string'
    && typeof candidate.description_en === 'string'
    && typeof candidate.workflow === 'string'
    && typeof candidate.category === 'string'
    && (candidate.source === 'custom' || candidate.source === 'marketplace')
    && typeof candidate.created_at === 'string'
    && typeof candidate.updated_at === 'string'
    && typeof candidate.enabled === 'boolean';
}

function safeSetHas(set: ReadonlySet<string> | undefined, value: string): boolean {
  if (!set || typeof set.has !== 'function') return false;
  try {
    return set.has(value);
  } catch {
    return true;
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return [];
  const result: string[] = [];
  for (const item of value.slice(0, MAX_LIST_ITEMS)) {
    if (typeof item === 'string') result.push(item);
  }
  return result;
}

function hasRequiredCapability(
  requiredCapabilities: string[],
  skills: string[],
  searchableFields: string[],
): boolean {
  if (requiredCapabilities.length === 0) return false;
  const normalizedSkills = new Set(skills.map(normalizeText).filter(Boolean));
  const normalizedFields = searchableFields.map(normalizeText).filter(Boolean);
  return requiredCapabilities.some((capability) => (
    normalizedSkills.has(capability)
    || normalizedFields.some((field) => field.includes(capability))
  ));
}

function categoryMatches(
  category: string,
  requiredCapabilities: string[],
  taskTokens: Set<string>,
): boolean {
  const normalizedCategory = normalizeText(category);
  if (!normalizedCategory) return false;
  if (requiredCapabilities.includes(normalizedCategory)) return true;
  const categoryTokens = tokensFor(category);
  for (const token of categoryTokens) {
    if (taskTokens.has(token)) return true;
  }
  return false;
}

function runtimeStatsBonus(runtimeStats: Agent['runtime_stats']): number {
  if (!runtimeStats || typeof runtimeStats !== 'object') return 0;
  const attempts = runtimeStats.attempts;
  const successes = runtimeStats.successes;
  if (
    typeof attempts !== 'number'
    || typeof successes !== 'number'
    || !Number.isFinite(attempts)
    || !Number.isFinite(successes)
    || !Number.isInteger(attempts)
    || !Number.isInteger(successes)
    || attempts < 5
    || successes < 0
    || successes > attempts
  ) {
    return 0;
  }
  return successes / attempts >= 0.8 ? 5 : 0;
}

function scoreAgent(
  candidate: Agent,
  taskTokens: Set<string>,
  requiredCapabilities: string[],
): number {
  const skills = stringList(candidate.skill_list);
  const searchableFields = [
    candidate.category,
    candidate.name,
    candidate.description_zh,
    candidate.description_en,
    candidate.workflow,
  ];
  let score = 0;
  if (hasRequiredCapability(requiredCapabilities, skills, searchableFields)) score += 50;
  if (categoryMatches(
    candidate.category,
    requiredCapabilities,
    taskTokens,
  )) score += 25;

  const descriptiveTokens = new Set<string>();
  for (const field of searchableFields.slice(1)) addTokens(descriptiveTokens, tokensFor(field));
  score += tokenMatchScore(taskTokens, descriptiveTokens);

  const skillTokens = new Set<string>();
  for (const skill of skills) addTokens(skillTokens, tokensFor(skill));
  score += tokenMatchScore(taskTokens, skillTokens);
  score += runtimeStatsBonus(candidate.runtime_stats);
  return score;
}

const INVALID_SNAPSHOT = Symbol('invalid-agent-snapshot');

type SnapshotValue = unknown | typeof INVALID_SNAPSHOT;

interface SnapshotState {
  active: WeakSet<object>;
  entries: number;
}

function defineSnapshotValue(target: object, key: string, value: unknown): boolean {
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    return true;
  } catch {
    return false;
  }
}

function snapshotNestedValue(
  value: unknown,
  state: SnapshotState,
  depth: number,
): SnapshotValue {
  state.entries += 1;
  if (state.entries > MAX_CANONICAL_ENTRIES || depth > MAX_CANONICAL_DEPTH) {
    return INVALID_SNAPSHOT;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'undefined') return value;
  if (typeof value === 'string') {
    return value.length <= MAX_CANONICAL_STRING_LENGTH ? value : INVALID_SNAPSHOT;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_SNAPSHOT;
  if (typeof value !== 'object' || state.active.has(value)) return INVALID_SNAPSHOT;

  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return INVALID_SNAPSHOT;
  }
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    return INVALID_SNAPSHOT;
  }

  let output: Record<string, unknown> | unknown[];
  if (isArray) {
    let lengthDescriptor: PropertyDescriptor | undefined;
    try {
      lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    } catch {
      return INVALID_SNAPSHOT;
    }
    if (
      !lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || typeof lengthDescriptor.value !== 'number'
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > MAX_LIST_ITEMS
    ) return INVALID_SNAPSHOT;
    output = new Array(lengthDescriptor.value);
  } else {
    output = {};
  }

  state.active.add(value);
  let propertyCount = 0;
  try {
    for (const key in value as Record<string, unknown>) {
      propertyCount += 1;
      if (propertyCount > MAX_CANONICAL_KEYS || key.length > MAX_CANONICAL_KEY_LENGTH) {
        return INVALID_SNAPSHOT;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return INVALID_SNAPSHOT;
      }
      const child = snapshotNestedValue(descriptor.value, state, depth + 1);
      if (child === INVALID_SNAPSHOT || !defineSnapshotValue(output, key, child)) {
        return INVALID_SNAPSHOT;
      }
    }
  } catch {
    return INVALID_SNAPSHOT;
  } finally {
    state.active.delete(value);
  }
  return output;
}

function snapshotAgent(value: unknown): Agent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
  } catch {
    return null;
  }

  const state: SnapshotState = {
    active: new WeakSet<object>([value]),
    entries: 1,
  };
  const output: Record<string, unknown> = {};
  for (const field of AGENT_SNAPSHOT_FIELDS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      return null;
    }
    if (!descriptor) continue;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    const snapshot = snapshotNestedValue(descriptor.value, state, 1);
    if (snapshot === INVALID_SNAPSHOT || !defineSnapshotValue(output, field, snapshot)) {
      return null;
    }
  }
  return output as unknown as Agent;
}

interface CanonicalState {
  active: WeakSet<object>;
  entries: number;
  length: number;
  parts: string[];
}

function appendCanonical(state: CanonicalState, text: string): boolean {
  if (state.length + text.length > MAX_CANONICAL_OUTPUT_LENGTH) return false;
  state.parts.push(text);
  state.length += text.length;
  return true;
}

function sortedStrings(values: string[]): string[] {
  return values.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function writeCanonicalSnapshot(
  value: unknown,
  state: CanonicalState,
  depth: number,
): boolean {
  state.entries += 1;
  if (state.entries > MAX_CANONICAL_ENTRIES || depth > MAX_CANONICAL_DEPTH) return false;
  if (value === null) return appendCanonical(state, 'null');
  if (typeof value === 'string') return appendCanonical(state, `s:${JSON.stringify(value)}`);
  if (typeof value === 'number') {
    return appendCanonical(state, `n:${Object.is(value, -0) ? '-0' : String(value)}`);
  }
  if (typeof value === 'boolean') return appendCanonical(state, value ? 'b:1' : 'b:0');
  if (typeof value === 'undefined') return appendCanonical(state, 'u:');
  if (typeof value !== 'object' || state.active.has(value)) return false;

  const isArray = Array.isArray(value);
  const keys = sortedStrings(Object.keys(value));
  if (keys.length > MAX_CANONICAL_KEYS) return false;
  state.active.add(value);
  const prefix = isArray ? `a:${value.length}{` : 'o:{';
  if (!appendCanonical(state, prefix)) {
    state.active.delete(value);
    return false;
  }
  for (const key of keys) {
    if (!appendCanonical(state, `${JSON.stringify(key)}=`)) {
      state.active.delete(value);
      return false;
    }
    if (!writeCanonicalSnapshot(
      (value as Record<string, unknown>)[key],
      state,
      depth + 1,
    )) {
      state.active.delete(value);
      return false;
    }
    if (!appendCanonical(state, ';')) {
      state.active.delete(value);
      return false;
    }
  }
  state.active.delete(value);
  return appendCanonical(state, '}');
}

function canonicalAgentKey(agent: Agent): string | null {
  const state: CanonicalState = {
    active: new WeakSet<object>(),
    entries: 0,
    length: 0,
    parts: [],
  };
  return writeCanonicalSnapshot(agent, state, 0) ? state.parts.join('') : null;
}

export function selectFallbackAgent(input: {
  task: string;
  requiredCapabilities: string[];
  members: Actor[];
  agents: Agent[];
  failedActorIds: ReadonlySet<string>;
  busyActorIds: ReadonlySet<string>;
  minimumScore?: number;
}): FallbackCandidate | null {
  if (
    !input
    || !Array.isArray(input.members)
    || !Array.isArray(input.agents)
    || input.members.length > MAX_LIST_ITEMS
    || input.agents.length > MAX_LIST_ITEMS
    || (Array.isArray(input.requiredCapabilities)
      && input.requiredCapabilities.length > MAX_LIST_ITEMS)
  ) return null;

  const taskTokens = tokensFor(input.task);
  const requiredCapabilities = Array.isArray(input.requiredCapabilities)
    ? [...new Set(
      input.requiredCapabilities
        .slice(0, MAX_LIST_ITEMS)
        .map(normalizeText)
        .filter(Boolean),
    )]
    : [];
  const minimumScore = typeof input.minimumScore === 'number'
    && Number.isFinite(input.minimumScore)
    ? input.minimumScore
    : DEFAULT_MINIMUM_SCORE;

  const actorsById = new Map<string, Actor>();
  for (const value of input.members.slice(0, MAX_LIST_ITEMS)) {
    if (!validActor(value)) continue;
    if (safeSetHas(input.failedActorIds, value.id) || safeSetHas(input.busyActorIds, value.id)) {
      continue;
    }
    const existing = actorsById.get(value.id);
    if (!existing || actorKey(value) < actorKey(existing)) actorsById.set(value.id, value);
  }

  const candidatesById = new Map<string, {
    candidate: FallbackCandidate;
    canonical: string;
  }>();
  for (const value of input.agents.slice(0, MAX_LIST_ITEMS)) {
    try {
      const snapshot = snapshotAgent(value);
      if (!snapshot || !validAgent(snapshot) || !snapshot.enabled) continue;
      const canonical = canonicalAgentKey(snapshot);
      if (canonical === null) continue;
      const actor = actorsById.get(snapshot.agent_id);
      if (!actor) continue;
      const score = scoreAgent(
        snapshot,
        taskTokens,
        requiredCapabilities,
      );
      const candidate = { actor, agent: snapshot, score };
      const existing = candidatesById.get(snapshot.agent_id);
      if (
        !existing
        || candidate.score > existing.candidate.score
        || (candidate.score === existing.candidate.score
          && canonical < existing.canonical)
      ) {
        candidatesById.set(snapshot.agent_id, { candidate, canonical });
      }
    } catch {
      // Reflection/proxy failures make the spec unreadable and ineligible.
    }
  }

  const ranked = [...candidatesById.values()]
    .map((entry) => entry.candidate)
    .filter((candidate) => candidate.score >= minimumScore)
    .sort((left, right) => (
      right.score - left.score
      || (left.agent.agent_id < right.agent.agent_id ? -1
        : left.agent.agent_id > right.agent.agent_id ? 1 : 0)
    ));
  return ranked[0] ?? null;
}
