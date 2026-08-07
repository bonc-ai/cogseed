import { safeId } from '../../storage';

export const SCHEDULER_FAIRNESS_SCHEMA_VERSION = 1 as const;

export interface SchedulerScopeCandidate {
  userId: string;
  scopeId: string;
  weight?: number;
}

export interface SchedulerFairnessState {
  schemaVersion: typeof SCHEDULER_FAIRNESS_SCHEMA_VERSION;
  roundRobinLast: Record<string, string | undefined>;
  weightedServed: Record<string, Record<string, number>>;
}

export interface SchedulerScopeBudget {
  userId: string;
  scopeId: string;
  limit: number;
  used: number;
}

export interface SchedulerScopeBudgetState {
  schemaVersion: typeof SCHEDULER_FAIRNESS_SCHEMA_VERSION;
  budgets: Record<string, SchedulerScopeBudget>;
}

export type SchedulerFairnessSelectionResult =
  | { state: SchedulerFairnessState; selected: SchedulerScopeCandidate }
  | { state: SchedulerFairnessState; selected: null; reason: 'empty' | 'budget_exhausted' | 'no_eligible' };

function assertSafeId(value: unknown, label: string): string {
  if (!safeId(value)) throw new Error(`invalid scheduler fairness ${label}`);
  return value as string;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid scheduler fairness ${label}`);
  return value as number;
}

function assertPositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`invalid scheduler fairness ${label}`);
  return value;
}

function candidateKey(candidate: Pick<SchedulerScopeCandidate, 'userId' | 'scopeId'>): string {
  return `${candidate.userId}::${candidate.scopeId}`;
}

function cloneCandidate(candidate: SchedulerScopeCandidate): SchedulerScopeCandidate {
  return { ...candidate };
}

function cloneFairnessState(state: SchedulerFairnessState): SchedulerFairnessState {
  assertFairnessState(state);
  const weightedServed: Record<string, Record<string, number>> = {};
  for (const [fairnessKey, counts] of Object.entries(state.weightedServed)) weightedServed[fairnessKey] = { ...counts };
  return { schemaVersion: state.schemaVersion, roundRobinLast: { ...state.roundRobinLast }, weightedServed };
}

function cloneBudgetState(state: SchedulerScopeBudgetState): SchedulerScopeBudgetState {
  assertBudgetState(state);
  const budgets: Record<string, SchedulerScopeBudget> = {};
  for (const [key, budget] of Object.entries(state.budgets)) budgets[key] = { ...budget };
  return { schemaVersion: state.schemaVersion, budgets };
}

function assertFairnessState(state: SchedulerFairnessState): void {
  if (!state || state.schemaVersion !== SCHEDULER_FAIRNESS_SCHEMA_VERSION) throw new Error('malformed scheduler fairness state');
  if (!state.roundRobinLast || typeof state.roundRobinLast !== 'object' || Array.isArray(state.roundRobinLast)) throw new Error('malformed scheduler round-robin state');
  if (!state.weightedServed || typeof state.weightedServed !== 'object' || Array.isArray(state.weightedServed)) throw new Error('malformed scheduler weighted state');
  for (const key of Object.keys(state.roundRobinLast)) assertSafeId(key.replace(/::/g, '-'), 'fairness key');
  for (const counts of Object.values(state.weightedServed)) {
    for (const [key, value] of Object.entries(counts)) {
      assertSafeId(key.replace(/::/g, '-'), 'scope key');
      assertNonNegativeInteger(value, 'service count');
    }
  }
}

function assertCandidate(candidate: SchedulerScopeCandidate): SchedulerScopeCandidate {
  const userId = assertSafeId(candidate.userId, 'user id');
  const scopeId = assertSafeId(candidate.scopeId, 'scope id');
  const weight = candidate.weight === undefined ? 1 : assertPositiveNumber(candidate.weight, 'weight');
  return { userId, scopeId, weight };
}

function validateCandidates(candidates: SchedulerScopeCandidate[], weighted: boolean): SchedulerScopeCandidate[] {
  if (!Array.isArray(candidates)) throw new Error('invalid scheduler fairness candidates');
  const output = candidates.map(assertCandidate);
  const seen = new Set<string>();
  for (const candidate of output) {
    const key = candidateKey(candidate);
    if (seen.has(key)) throw new Error('duplicate scheduler fairness candidate');
    seen.add(key);
    if (!weighted) candidate.weight = candidate.weight ?? 1;
  }
  return output;
}

function assertFairnessKey(fairnessKey: unknown): string {
  return assertSafeId(fairnessKey, 'fairness key');
}

function assertBudget(budget: SchedulerScopeBudget): void {
  assertSafeId(budget.userId, 'budget user id');
  assertSafeId(budget.scopeId, 'budget scope id');
  assertNonNegativeInteger(budget.limit, 'budget limit');
  assertNonNegativeInteger(budget.used, 'budget usage');
  if (budget.used > budget.limit) throw new Error('scheduler budget usage exceeds limit');
}

function assertBudgetState(state: SchedulerScopeBudgetState): void {
  if (!state || state.schemaVersion !== SCHEDULER_FAIRNESS_SCHEMA_VERSION) throw new Error('malformed scheduler budget state');
  if (!state.budgets || typeof state.budgets !== 'object' || Array.isArray(state.budgets)) throw new Error('malformed scheduler budgets');
  for (const budget of Object.values(state.budgets)) assertBudget(budget);
}

function budgetAvailable(budgets: SchedulerScopeBudgetState | undefined, candidate: SchedulerScopeCandidate): boolean {
  if (!budgets) return true;
  const budget = budgets.budgets[candidateKey(candidate)];
  return Boolean(budget && budget.used < budget.limit);
}

function eligibleCandidates(candidates: SchedulerScopeCandidate[], budgets?: SchedulerScopeBudgetState): SchedulerScopeCandidate[] {
  if (budgets) assertBudgetState(budgets);
  return candidates.filter((candidate) => budgetAvailable(budgets, candidate));
}

export function createSchedulerFairnessState(): SchedulerFairnessState {
  return { schemaVersion: SCHEDULER_FAIRNESS_SCHEMA_VERSION, roundRobinLast: {}, weightedServed: {} };
}

export function createSchedulerScopeBudgetState(inputs: SchedulerScopeBudget[]): SchedulerScopeBudgetState {
  if (!Array.isArray(inputs)) throw new Error('invalid scheduler budget inputs');
  const budgets: Record<string, SchedulerScopeBudget> = {};
  for (const input of inputs) {
    assertBudget(input);
    const normalized = { ...input };
    const key = candidateKey(normalized);
    if (budgets[key]) throw new Error('duplicate scheduler scope budget');
    budgets[key] = normalized;
  }
  return { schemaVersion: SCHEDULER_FAIRNESS_SCHEMA_VERSION, budgets };
}

export function reserveSchedulerScopeBudget(
  state: SchedulerScopeBudgetState,
  input: { userId: string; scopeId: string; amount: number },
): { state: SchedulerScopeBudgetState; reserved: true; budget: SchedulerScopeBudget } | { state: SchedulerScopeBudgetState; reserved: false; reason: 'not_configured' | 'budget_exhausted' } {
  const next = cloneBudgetState(state);
  const userId = assertSafeId(input.userId, 'budget user id');
  const scopeId = assertSafeId(input.scopeId, 'budget scope id');
  const amount = assertPositiveNumber(input.amount, 'budget amount');
  if (!Number.isSafeInteger(amount)) throw new Error('invalid scheduler fairness budget amount');
  const budget = next.budgets[candidateKey({ userId, scopeId })];
  if (!budget) return { state: next, reserved: false, reason: 'not_configured' };
  if (budget.used + amount > budget.limit) return { state: next, reserved: false, reason: 'budget_exhausted' };
  budget.used += amount;
  return { state: next, reserved: true, budget: { ...budget } };
}

export function releaseSchedulerScopeBudget(
  state: SchedulerScopeBudgetState,
  input: { userId: string; scopeId: string; amount: number },
): { state: SchedulerScopeBudgetState; released: true; budget: SchedulerScopeBudget } {
  const next = cloneBudgetState(state);
  const userId = assertSafeId(input.userId, 'budget user id');
  const scopeId = assertSafeId(input.scopeId, 'budget scope id');
  const amount = assertPositiveNumber(input.amount, 'budget amount');
  if (!Number.isSafeInteger(amount)) throw new Error('invalid scheduler fairness budget amount');
  const budget = next.budgets[candidateKey({ userId, scopeId })];
  if (!budget) throw new Error('scheduler scope budget not configured');
  if (amount > budget.used) throw new Error('scheduler budget release exceeds usage');
  budget.used -= amount;
  return { state: next, released: true, budget: { ...budget } };
}

export function chooseRoundRobinScope(
  state: SchedulerFairnessState,
  input: { fairnessKey: string; candidates: SchedulerScopeCandidate[]; budgets?: SchedulerScopeBudgetState },
): SchedulerFairnessSelectionResult {
  const next = cloneFairnessState(state);
  const fairnessKey = assertFairnessKey(input.fairnessKey);
  const candidates = validateCandidates(input.candidates, false);
  if (candidates.length === 0) return { state: next, selected: null, reason: 'empty' };
  const eligible = eligibleCandidates(candidates, input.budgets);
  if (eligible.length === 0) return { state: next, selected: null, reason: input.budgets ? 'budget_exhausted' : 'no_eligible' };
  const last = next.roundRobinLast[fairnessKey];
  const lastIndex = last ? eligible.findIndex((candidate) => candidateKey(candidate) === last) : -1;
  const selected = eligible[(lastIndex + 1 + eligible.length) % eligible.length];
  next.roundRobinLast[fairnessKey] = candidateKey(selected);
  return { state: next, selected: cloneCandidate(selected) };
}

export function chooseWeightedServiceScope(
  state: SchedulerFairnessState,
  input: { fairnessKey: string; candidates: SchedulerScopeCandidate[]; budgets?: SchedulerScopeBudgetState },
): SchedulerFairnessSelectionResult {
  const next = cloneFairnessState(state);
  const fairnessKey = assertFairnessKey(input.fairnessKey);
  const candidates = validateCandidates(input.candidates, true);
  if (candidates.length === 0) return { state: next, selected: null, reason: 'empty' };
  const eligible = eligibleCandidates(candidates, input.budgets);
  if (eligible.length === 0) return { state: next, selected: null, reason: input.budgets ? 'budget_exhausted' : 'no_eligible' };
  const counts = next.weightedServed[fairnessKey] ?? {};
  let selected = eligible[0];
  let bestRatio = (counts[candidateKey(selected)] ?? 0) / (selected.weight ?? 1);
  for (const candidate of eligible.slice(1)) {
    const ratio = (counts[candidateKey(candidate)] ?? 0) / (candidate.weight ?? 1);
    if (ratio < bestRatio) {
      selected = candidate;
      bestRatio = ratio;
    }
  }
  counts[candidateKey(selected)] = (counts[candidateKey(selected)] ?? 0) + 1;
  next.weightedServed[fairnessKey] = counts;
  return { state: next, selected: cloneCandidate(selected) };
}
