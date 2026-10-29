import { z } from 'zod';

export const JEV_PROTOCOL_VERSION = 1 as const;
export const JEV_DEFAULT_TIMEOUT_MS = 5_000;
export const JEV_DEFAULT_MAX_RETRIES = 1;
export const JEV_MAX_CANDIDATES = 32;

export const JEV_GATES = ['intent', 'candidate_suitability', 'result_validation'] as const;
export type JevGate = (typeof JEV_GATES)[number];

export const JEV_QUESTION_KINDS = ['choice', 'score', 'evidence_check'] as const;
export type JevQuestionKind = (typeof JEV_QUESTION_KINDS)[number];

export interface JevCandidate {
  id: string;
  summary: string;
  source: 'ontology' | 'semantic' | 'hybrid';
  evidence?: string[];
}

export interface JevEvaluationRequest {
  requestId: string;
  gate: JevGate;
  question: {
    id: string;
    kind: JevQuestionKind;
    text: string;
  };
  query: string;
  candidates: JevCandidate[];
}

export type JevDecision =
  | { type: 'select'; candidateIds: string[] }
  | { type: 'score'; scores: Array<{ candidateId: string; score: number }> }
  | { type: 'none'; reason?: string }
  | { type: 'clarify'; question: string };

export interface JevEvaluationResponse {
  protocolVersion: typeof JEV_PROTOCOL_VERSION;
  requestId: string;
  questionId: string;
  decision: JevDecision;
}

export type JevFallbackReason =
  | 'disabled'
  | 'unconfigured'
  | 'invalid_request'
  | 'timeout'
  | 'aborted'
  | 'rate_limited'
  | 'http_error'
  | 'http_rejected'
  | 'network_error'
  | 'invalid_response';

export type JevEvaluationResult =
  | {
    status: 'ok';
    response: JevEvaluationResponse;
    attempts: number;
    latencyMs?: number;
  }
  | {
    status: 'fallback';
    reason: JevFallbackReason;
    attempts: number;
    httpStatus?: number;
    providerCode?: string;
    providerMessage?: string;
    networkCode?: string;
    latencyMs?: number;
  };

export interface JevEvaluationOptions {
  signal?: AbortSignal;
}

export interface JevClient {
  evaluate(request: JevEvaluationRequest, options?: JevEvaluationOptions): Promise<JevEvaluationResult>;
}

export interface JevClientConfig {
  enabled?: boolean;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxCandidates?: number;
}

export interface JevAdapterDependencies {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const candidateIdSchema = z.string().trim().min(1).max(160);

export const jevCandidateSchema = z.object({
  id: candidateIdSchema,
  summary: z.string().trim().min(1).max(2_000),
  source: z.enum(['ontology', 'semantic', 'hybrid']),
  evidence: z.array(z.string().trim().min(1).max(1_000)).max(16).optional(),
}).strict();

export const jevEvaluationRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(160),
  gate: z.enum(JEV_GATES),
  question: z.object({
    id: z.string().trim().min(1).max(160),
    kind: z.enum(JEV_QUESTION_KINDS),
    text: z.string().trim().min(1).max(2_000),
  }).strict(),
  query: z.string().trim().min(1).max(4_000),
  candidates: z.array(jevCandidateSchema).min(1).max(JEV_MAX_CANDIDATES),
}).strict();

const jevDecisionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('select'),
    candidateIds: z.array(candidateIdSchema).min(1).max(JEV_MAX_CANDIDATES),
  }).strict(),
  z.object({
    type: z.literal('score'),
    scores: z.array(z.object({
      candidateId: candidateIdSchema,
      score: z.number().finite().min(0).max(1),
    }).strict()).min(1).max(JEV_MAX_CANDIDATES),
  }).strict(),
  z.object({
    type: z.literal('none'),
    reason: z.string().trim().min(1).max(1_000).optional(),
  }).strict(),
  z.object({
    type: z.literal('clarify'),
    question: z.string().trim().min(1).max(1_000),
  }).strict(),
]);

export const jevEvaluationResponseSchema = z.object({
  protocolVersion: z.literal(JEV_PROTOCOL_VERSION),
  requestId: z.string().trim().min(1).max(160),
  questionId: z.string().trim().min(1).max(160),
  decision: jevDecisionSchema,
}).strict();

export function validateJevRequest(request: unknown, maxCandidates = JEV_MAX_CANDIDATES): JevEvaluationRequest | null {
  const result = jevEvaluationRequestSchema.safeParse(request);
  if (!result.success || result.data.candidates.length > maxCandidates) return null;

  const ids = result.data.candidates.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) return null;
  return result.data as JevEvaluationRequest;
}

export function validateJevResponse(
  value: unknown,
  request: JevEvaluationRequest,
): JevEvaluationResponse | null {
  const result = jevEvaluationResponseSchema.safeParse(value);
  if (!result.success) return null;
  if (result.data.requestId !== request.requestId || result.data.questionId !== request.question.id) return null;

  const candidateIds = new Set(request.candidates.map((candidate) => candidate.id));
  if (result.data.decision.type === 'select') {
    if (new Set(result.data.decision.candidateIds).size !== result.data.decision.candidateIds.length) return null;
    if (result.data.decision.candidateIds.some((id) => !candidateIds.has(id))) return null;
  }
  if (result.data.decision.type === 'score') {
    const scoredIds = result.data.decision.scores.map((entry) => entry.candidateId);
    if (new Set(scoredIds).size !== scoredIds.length) return null;
    if (scoredIds.some((id) => !candidateIds.has(id))) return null;
  }
  return result.data as JevEvaluationResponse;
}
