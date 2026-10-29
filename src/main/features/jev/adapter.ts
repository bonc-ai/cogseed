import {
  JEV_DEFAULT_MAX_RETRIES,
  JEV_DEFAULT_TIMEOUT_MS,
  JEV_MAX_CANDIDATES,
  type JevAdapterDependencies,
  type JevClient,
  type JevClientConfig,
  type JevEvaluationOptions,
  type JevEvaluationRequest,
  type JevEvaluationResponse,
  type JevEvaluationResult,
  type JevFallbackReason,
  type JevGate,
  validateJevRequest,
  validateJevResponse,
} from './types';
import { resolveJevRollout, type JevRolloutEnvironment } from './rollout';
import { resolveSemanticaRuntime } from './settings';
import { z } from 'zod';

const MAX_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const TYPESAFE_MODEL = 'jev-latest';
const TYPESAFE_NONE_OPTION = 'none';
const TYPESAFE_DECISION_QUESTION = 'decision';

const typeSafeChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string().trim().min(1),
  confidence: z.number().finite().min(0).max(1).optional(),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)).optional(),
});
const typeSafeNoulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number().finite().min(0).max(1),
});
const typeSafeResponseSchema = z.object({
  model: z.string().trim().min(1),
  answers: z.record(z.string(), z.union([typeSafeChoiceAnswerSchema, typeSafeNoulAnswerSchema])),
});

type TypeSafeRequestBody = {
  state: string;
  model: string;
  questions: Record<string, {
    type: 'choice' | 'noul';
    instructions: string;
    criteria?: Record<string, string>;
  }>;
};

interface TypeSafeRequestMapping {
  body: TypeSafeRequestBody;
  optionToCandidateId: Map<string, string>;
  questionToCandidateId: Map<string, string>;
}

export interface JevEnvironment extends JevRolloutEnvironment {
  COGSEED_SEMANTICA_ENABLED?: string;
  COGSEED_JEV_ENABLED?: string;
  COGSEED_JEV_ENDPOINT?: string;
  COGSEED_JEV_MODEL?: string;
  COGSEED_JEV_API_KEY?: string;
  COGSEED_JEV_TIMEOUT_MS?: string;
  COGSEED_JEV_MAX_RETRIES?: string;
}

function normalizePositiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(parsed)));
}

function normalizeTimeout(value: unknown): number {
  return Math.max(1, normalizePositiveInteger(value, JEV_DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
}

function normalizeRetries(value: unknown): number {
  return normalizePositiveInteger(value, JEV_DEFAULT_MAX_RETRIES, MAX_RETRIES);
}

function isEnabled(value: unknown): boolean {
  return value === true || value === '1' || value === 'true';
}

export function jevConfigFromEnvironment(env: JevEnvironment = process.env): JevClientConfig {
  return {
    enabled: isEnabled(env.COGSEED_JEV_ENABLED),
    endpoint: typeof env.COGSEED_JEV_ENDPOINT === 'string' ? env.COGSEED_JEV_ENDPOINT.trim() : '',
    apiKey: typeof env.COGSEED_JEV_API_KEY === 'string' ? env.COGSEED_JEV_API_KEY.trim() : '',
    timeoutMs: normalizeTimeout(env.COGSEED_JEV_TIMEOUT_MS),
    maxRetries: normalizeRetries(env.COGSEED_JEV_MAX_RETRIES),
  };
}

function normalizeEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number): number {
  return Math.min(500, 100 * 2 ** Math.max(0, attempt - 1));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function fallback(
  reason: JevFallbackReason,
  attempts: number,
  details: Partial<Extract<JevEvaluationResult, { status: 'fallback' }>> = {},
): JevEvaluationResult {
  return { status: 'fallback', reason, attempts, ...details };
}

function boundedProviderText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text ? text.slice(0, 300) : undefined;
}

async function httpFailureDetails(response: Response): Promise<{
  httpStatus: number;
  providerCode?: string;
  providerMessage?: string;
}> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { httpStatus: response.status };
  }
  if (!body || typeof body !== 'object') return { httpStatus: response.status };
  const top = body as Record<string, unknown>;
  const detail = top.detail && typeof top.detail === 'object'
    ? top.detail as Record<string, unknown>
    : top;
  const providerCode = boundedProviderText(detail.error_type || detail.code);
  const providerMessage = boundedProviderText(detail.message || detail.error);
  return {
    httpStatus: response.status,
    ...(providerCode ? { providerCode } : {}),
    ...(providerMessage ? { providerMessage } : {}),
  };
}

function typeSafeState(request: JevEvaluationRequest): string {
  const candidates = request.candidates.map((candidate, index) => {
    const evidence = candidate.evidence?.length ? "; evidence=" + candidate.evidence.join(' | ') : '';
    return "candidate_" + index + ": source=" + candidate.source + "; summary=" + candidate.summary + evidence;
  });
  return [
    "User query: " + request.query,
    "Decision gate: " + request.gate,
    'Only judge the finite candidates below. Do not invent candidates or facts.',
    ...candidates,
  ].join('\n');
}

function typeSafeRequest(request: JevEvaluationRequest, model = TYPESAFE_MODEL): TypeSafeRequestMapping {
  const optionToCandidateId = new Map<string, string>();
  const questionToCandidateId = new Map<string, string>();
  const questions: TypeSafeRequestBody['questions'] = {};
  if (request.question.kind === 'choice') {
    const criteria: Record<string, string> = {};
    request.candidates.forEach((candidate, index) => {
      const option = "candidate_" + index;
      optionToCandidateId.set(option, candidate.id);
      criteria[option] = candidate.summary;
    });
    criteria[TYPESAFE_NONE_OPTION] = 'No supplied candidate is sufficiently supported or suitable.';
    questions[TYPESAFE_DECISION_QUESTION] = {
      type: 'choice',
      instructions: request.question.text + ' Choose exactly one supplied candidate, or none.',
      criteria,
    };
  } else {
    request.candidates.forEach((candidate, index) => {
      const questionId = "candidate_" + index;
      questionToCandidateId.set(questionId, candidate.id);
      questions[questionId] = {
        type: 'noul',
        instructions: request.question.text
          + ' Judge only candidate_' + index + ': ' + candidate.summary
          + '. A true answer requires satisfying every explicit relation direction and direct/indirect constraint in the user query.',
      };
    });
  }
  return {
    body: { state: typeSafeState(request), model, questions },
    optionToCandidateId,
    questionToCandidateId,
  };
}

function fromTypeSafeResponse(
  value: unknown,
  request: JevEvaluationRequest,
  mapping: TypeSafeRequestMapping,
): JevEvaluationResponse | null {
  const parsed = typeSafeResponseSchema.safeParse(value);
  if (!parsed.success) return null;
  let decision: JevEvaluationResponse['decision'];
  if (request.question.kind === 'choice') {
    const answer = parsed.data.answers[TYPESAFE_DECISION_QUESTION];
    if (!answer || answer.type !== 'choice') return null;
    if (answer.choice === TYPESAFE_NONE_OPTION) {
      decision = { type: 'none', reason: 'Jev selected none of the supplied candidates' };
    } else {
      const candidateId = mapping.optionToCandidateId.get(answer.choice);
      if (!candidateId) return null;
      decision = { type: 'select', candidateIds: [candidateId] };
    }
  } else {
    const scores: Array<{ candidateId: string; score: number }> = [];
    for (const [questionId, candidateId] of mapping.questionToCandidateId) {
      const answer = parsed.data.answers[questionId];
      if (!answer || answer.type !== 'noul') return null;
      scores.push({ candidateId, score: answer.noul });
    }
    decision = { type: 'score', scores };
  }
  return validateJevResponse({
    protocolVersion: 1,
    requestId: request.requestId,
    questionId: request.question.id,
    decision,
  }, request);
}

export class NoopJevClient implements JevClient {
  constructor(private readonly reason: 'disabled' | 'unconfigured' = 'disabled') {}

  async evaluate(_request: JevEvaluationRequest, _options: JevEvaluationOptions = {}): Promise<JevEvaluationResult> {
    return fallback(this.reason, 0);
  }
}

class HttpJevClient implements JevClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxCandidates: number;

  constructor(config: JevClientConfig, dependencies: JevAdapterDependencies = {}) {
    this.fetchImpl = dependencies.fetch || fetch;
    this.sleepImpl = dependencies.sleep || delay;
    this.endpoint = normalizeEndpoint(config.endpoint);
    this.apiKey = String(config.apiKey || '').trim();
    this.model = String(config.model || TYPESAFE_MODEL).trim() || TYPESAFE_MODEL;
    this.timeoutMs = normalizeTimeout(config.timeoutMs);
    this.maxRetries = normalizeRetries(config.maxRetries);
    this.maxCandidates = Math.max(1, normalizePositiveInteger(config.maxCandidates, JEV_MAX_CANDIDATES, JEV_MAX_CANDIDATES));
  }

  async evaluate(request: JevEvaluationRequest, options: JevEvaluationOptions = {}): Promise<JevEvaluationResult> {
    const validatedRequest = validateJevRequest(request, this.maxCandidates);
    if (!validatedRequest) return fallback('invalid_request', 0);
    const startedAt = Date.now();

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const result = await this.send(validatedRequest, options);
      if (result.status === 'ok' || result.reason === 'aborted' || result.reason === 'invalid_response') {
        return { ...result, attempts: attempt, latencyMs: Date.now() - startedAt };
      }
      if (attempt > this.maxRetries || !this.shouldRetry(result.reason)) {
        return { ...result, attempts: attempt, latencyMs: Date.now() - startedAt };
      }
      await this.sleepImpl(retryDelayMs(attempt));
    }
    return { ...fallback('network_error', this.maxRetries + 1), latencyMs: Date.now() - startedAt };
  }

  private shouldRetry(reason: JevFallbackReason): boolean {
    // A timeout has already consumed the gate's complete latency budget. A
    // second identical request only compounds turn delay, so fail open once.
    return reason === 'rate_limited' || reason === 'http_error' || reason === 'network_error';
  }

  private async send(
    request: JevEvaluationRequest,
    options: JevEvaluationOptions,
  ): Promise<JevEvaluationResult> {
    if (options.signal?.aborted) return fallback('aborted', 1);
    const controller = new AbortController();
    let timedOut = false;
    let parentAborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => {
      parentAborted = true;
      controller.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const mapping = typeSafeRequest(request, this.model);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(mapping.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const details = await httpFailureDetails(response);
        if (response.status === 429) return fallback('rate_limited', 1, details);
        return fallback(isRetryableStatus(response.status) ? 'http_error' : 'http_rejected', 1, details);
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        return fallback('invalid_response', 1);
      }
      const validatedResponse = fromTypeSafeResponse(raw, request, mapping);
      return validatedResponse
        ? { status: 'ok', response: validatedResponse, attempts: 1 }
        : fallback('invalid_response', 1);
    } catch (error) {
      if (parentAborted) return fallback('aborted', 1);
      if (timedOut || (error instanceof DOMException && error.name === 'AbortError')) {
        return fallback('timeout', 1);
      }
      const cause = error && typeof error === 'object'
        ? (error as { cause?: { code?: unknown } }).cause
        : undefined;
      const networkCode = boundedProviderText(cause?.code);
      return fallback('network_error', 1, networkCode ? { networkCode } : {});
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function createJevClient(
  config: JevClientConfig = {},
  dependencies: JevAdapterDependencies = {},
): JevClient {
  if (config.enabled !== true) return new NoopJevClient('disabled');
  if (!normalizeEndpoint(config.endpoint) || !String(config.apiKey || '').trim()) {
    return new NoopJevClient('unconfigured');
  }
  return new HttpJevClient(config, dependencies);
}

export function createJevClientFromEnvironment(
  env: JevEnvironment = process.env,
  dependencies: JevAdapterDependencies = {},
): JevClient {
  return createJevClient(jevConfigFromEnvironment(env), dependencies);
}

/** Gate-aware client factory used by production call sites. Global enablement,
 * gate allow-list and stable cohort rollout must all pass before HTTP is
 * possible; every disabled path returns the existing local fallback client. */
export function createJevClientForGateFromEnvironment(
  gate: JevGate,
  rolloutKey?: string,
  env: JevEnvironment = process.env,
  dependencies: JevAdapterDependencies = {},
): JevClient {
  const hasCompleteEnvironmentConfig = env.COGSEED_JEV_ENABLED !== undefined
    && Boolean(env.COGSEED_JEV_ENDPOINT?.trim())
    && Boolean(env.COGSEED_JEV_API_KEY?.trim());
  if (rolloutKey && !hasCompleteEnvironmentConfig) {
    // UI settings are user-scoped. resolveSemanticaRuntime merges every
    // environment field independently, so setting only COGSEED_JEV_ENABLED
    // must not discard the endpoint, model, gates, or encrypted key saved in
    // the UI.
    const runtime = resolveSemanticaRuntime(rolloutKey, env as NodeJS.ProcessEnv);
    const rollout = resolveJevRollout(gate, runtime.config.enabled === true, rolloutKey, {
      ...env,
      COGSEED_JEV_GATES: env.COGSEED_JEV_GATES ?? runtime.gates.join(','),
    });
    return createJevClient({ ...runtime.config, enabled: rollout.enabled }, dependencies);
  }
  const config = jevConfigFromEnvironment(env);
  const rollout = resolveJevRollout(gate, config.enabled === true, rolloutKey, env);
  return createJevClient({ ...config, enabled: rollout.enabled }, dependencies);
}
