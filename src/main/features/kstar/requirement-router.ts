import { createLogger } from '../../logger';
import { hasConfiguredModel } from '../auth';
import type { KstarExpectedResult, KstarRequirementIntent } from './requirement-types';

const log = createLogger('kstar.requirement-router');
const ROUTE_MIN_CONFIDENCE = 0.6;
const MAX_ROUTE_REASON = 500;
const MAX_ROUTE_TEXT = 4_000;

export interface KstarRequirementRouteInput {
  text: string;
  hasOpenTask: boolean;
  hasOpenRequirement: boolean;
  forcedIntent?: Extract<KstarRequirementIntent, 'complete'>;
}

export interface KstarRequirementRouteResult {
  intent: KstarRequirementIntent;
  confidence: number;
  reason: string;
  requirementText?: string;
  expectedResult?: KstarExpectedResult;
  method: 'model' | 'forced' | 'fallback';
}

export type KstarRequirementClassifier = (input: {
  text: string;
  hasOpenTask: boolean;
  hasOpenRequirement: boolean;
}) => Promise<Omit<KstarRequirementRouteResult, 'method'> | null>;

export interface KstarRequirementRouterOptions {
  classify?: KstarRequirementClassifier;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ROUTE_TEXT);
}

function expectedFromText(text: string): KstarExpectedResult {
  return {
    summary: text.slice(0, 500),
    acceptanceSignals: [],
    source: 'user_message',
    confidence: text ? 0.6 : 0,
  };
}

function validIntent(value: unknown): value is KstarRequirementIntent {
  return value === 'new' || value === 'continue' || value === 'complete' || value === 'topic_switch';
}

function parseModelRoute(text: string, sourceText: string): Omit<KstarRequirementRouteResult, 'method'> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) throw new Error('route output is not strict JSON');
  const value = JSON.parse(trimmed) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('route output must be an object');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['intent', 'confidence', 'reason', 'requirementText']);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error('route output contains unknown fields');
  if (!validIntent(record.intent)) throw new Error('invalid route intent');
  const confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence)
    ? record.confidence
    : 0;
  if (confidence < 0 || confidence > 1) throw new Error('invalid route confidence');
  const reason = typeof record.reason === 'string' && record.reason.trim()
    ? record.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_ROUTE_REASON)
    : 'The model did not provide a routing reason.';
  return {
    intent: record.intent,
    confidence,
    reason,
    requirementText: typeof record.requirementText === 'string' && record.requirementText.trim()
      ? normalizeText(record.requirementText)
      : sourceText,
    expectedResult: record.intent === 'new' || record.intent === 'topic_switch'
      ? expectedFromText(sourceText)
      : undefined,
  };
}

async function defaultClassifyWithCoreAgent(
  userId: string,
  input: { text: string; hasOpenTask: boolean; hasOpenRequirement: boolean },
): Promise<Omit<KstarRequirementRouteResult, 'method'>> {
  if (!hasConfiguredModel().configured) throw new Error('requirement router model is not configured');
  const { buildRunner } = await import('../../model/core-agent/runner');
  const { runner } = await buildRunner({
    sessionId: `kstar-router-${Date.now().toString(36)}`,
    userId,
    systemPrompt: [
      'Classify one user message for a multi-turn task tracker.',
      'Return exactly one JSON object and no markdown.',
      'Schema: {"intent":"new|continue|complete|topic_switch","confidence":0_to_1,"reason":"short evidence-grounded reason","requirementText":"bounded normalized requirement text"}.',
      'Use continue when ambiguous. Do not infer completion unless the user meaning is task closure.',
    ].join('\n'),
    disableTools: true,
    ephemeralSession: true,
    skillList: [],
  });
  const result = await runner.run({
    message: JSON.stringify(input),
    thinkingLevel: 'off',
    cacheRetention: 'none',
  });
  if (result.meta.aborted || result.meta.error) throw new Error('requirement router model unavailable');
  return parseModelRoute(result.text, input.text);
}

export async function routeRequirementIntent(
  userId: string,
  input: KstarRequirementRouteInput,
  options: KstarRequirementRouterOptions = {},
): Promise<KstarRequirementRouteResult> {
  const text = normalizeText(input.text);
  if (input.forcedIntent) {
    return {
      intent: input.forcedIntent,
      confidence: 1,
      reason: 'An explicit UI action forced requirement routing.',
      requirementText: text,
      method: 'forced',
    };
  }

  const classifier = options.classify || ((classifierInput: {
    text: string;
    hasOpenTask: boolean;
    hasOpenRequirement: boolean;
  }) => defaultClassifyWithCoreAgent(userId, classifierInput));

  try {
    const classified = await classifier({
      text,
      hasOpenTask: input.hasOpenTask,
      hasOpenRequirement: input.hasOpenRequirement,
    });
    if (classified && validIntent(classified.intent) && Number.isFinite(classified.confidence)
      && classified.confidence >= ROUTE_MIN_CONFIDENCE && classified.confidence <= 1) {
      return {
        ...classified,
        requirementText: classified.requirementText || text,
        expectedResult: classified.expectedResult
          || (classified.intent === 'new' || classified.intent === 'topic_switch' ? expectedFromText(text) : undefined),
        method: 'model',
      };
    }
  } catch (error) {
    log.warn('kstar requirement routing degraded', {
      userId,
      errorCode: 'requirement_router_unavailable',
      error: (error as Error).message,
    });
  }

  if (!input.hasOpenTask) {
    return {
      intent: 'new',
      confidence: 0.5,
      reason: 'No open task; conservative fallback starts one.',
      requirementText: text,
      expectedResult: expectedFromText(text),
      method: 'fallback',
    };
  }
  return {
    intent: 'continue',
    confidence: 0.5,
    reason: 'Classifier unavailable or low-confidence; conservative fallback continues the open requirement.',
    requirementText: text,
    method: 'fallback',
  };
}
