import { buildRunner } from '../../model/core-agent/runner';
import { classifyKeyFailure } from '../../model/core-agent/auth-error';
import { createLogger } from '../../logger';
import { getThinkingLevel } from '../config';
import type { RecallCaptureModelCandidate } from './capture-settings';
import { withCaptureModelBudget, recordCaptureModelOutcome, type CaptureModelBudgetContext, type CaptureModelFailureReason } from './capture-model-budget';
import * as os from 'node:os';

const log = createLogger('recall.capture-model-routing');
type ModelResult = Awaited<ReturnType<Awaited<ReturnType<typeof buildRunner>>['runner']['run']>>;

async function availabilityFailure(error: unknown): Promise<boolean> {
  const raw = error as { kind?: string; code?: string; message?: string };
  if (raw?.code === 'ABORT_ERR' || raw?.kind === 'context_overflow') return false;
  if (/^PROVIDER_(?:.*_EXHAUSTED|NO_FIRST_EVENT_TIMEOUT)$/.test(raw?.code || '')) return true;
  const normalizedError = error instanceof Error ? error : Object.assign(new Error(raw?.message || String(error)), raw);
  if (classifyKeyFailure(normalizedError)) return true;
  const { classifyTransientNetworkError, classifyRetryableError } = await import('#core-agent');
  // Permanent request/safety signals beat generic network wrappers.
  if (classifyRetryableError(normalizedError) === null) return false;
  // Some SDKs erase the socket code and return this exact transport envelope.
  return classifyTransientNetworkError(normalizedError) !== null || /^connection error\.?$/i.test(normalizedError.message.trim());
}

/** A stage commits only a complete, validated response. The runner exhausts its
 * normal retries for ONE requested model before this boundary tries the next.
 * This also permits safe recovery from partial streams, unlike interactive chat
 * rotation which must preserve already-visible output. No tools or durable
 * sessions execute here, so discarded partial responses have no side effects. */
interface CaptureModelOptions {
  sessionId: string;
  /** Non-conversation analysis uses its job identity for the existing CLI execution route. */
  jobContext?: { jobId: string };
  systemPrompt: string;
  message: string;
  modelCandidates: readonly RecallCaptureModelCandidate[];
  signal?: AbortSignal;
  shouldContinue?: () => Promise<boolean>;
  responseFormat?: 'json_object';
  maxOutputTokens?: number;
  budget?: CaptureModelBudgetContext;
  /** Explicit capture-stage opt-in. Generic empty-route callers retain their
   * original API/environment contract; configured API outages never use CLI. */
  cliContext?: { conversationId: string; agentId?: string; agentName?: string };
}

function failureReason(error: unknown): CaptureModelFailureReason {
  const raw = error as { message?: string; kind?: string; code?: string };
  return /connection|network|fetch failed|timed? ?out|timeout|ECONN|ENOTFOUND|503/i.test([raw?.message, raw?.kind, raw?.code].join(' '))
    ? 'connection' : 'model_error';
}

export async function runRecallCaptureModel(userId: string, options: CaptureModelOptions): Promise<{ result: ModelResult; chosen?: RecallCaptureModelCandidate }> {
  // Recheck callers have no lifecycle signal today. The CLI runner requires one,
  // so normalize here: a missing signal means "not cancellable", not a crash.
  options = { ...options, signal: options.signal ?? new AbortController().signal };
  let response: { result: ModelResult; chosen?: RecallCaptureModelCandidate };
  try { response = await dispatchCaptureModel(userId, options); }
  catch (error) {
    if (options.budget && !options.signal?.aborted && (error as { code?: string })?.code !== 'ABORT_ERR')
      await recordCaptureModelOutcome(userId, options.budget, failureReason(error));
    throw error;
  }
  if (options.budget && !options.signal?.aborted && !response.result.meta.aborted) {
    const failure = response.result.meta.error ? failureReason(response.result.meta.error)
      : !response.result.text?.trim() ? 'empty_output' : undefined;
    await recordCaptureModelOutcome(userId, options.budget, failure);
  }
  return response;
}

async function dispatchCaptureModel(userId: string, options: CaptureModelOptions): Promise<{ result: ModelResult; chosen?: RecallCaptureModelCandidate }> {
  if ((options.cliContext || options.jobContext) && !options.modelCandidates.length
    && !(await import('../auth')).hasConfiguredModelForUser(userId).configured && !process.env.ANTHROPIC_API_KEY) {
    if (options.signal?.aborted || options.shouldContinue && !await options.shouldContinue())
      throw Object.assign(new Error('Capture model run interrupted'), { code: 'ABORT_ERR' });
    const { detectAll } = await import('../local_agents/registry');
    const { run: runCliAgent, supportsNoTools } = await import('../local_agents/runner');
    // This prompt carries source text. Only a CLI that can expose zero tools
    // may run it; a read-only CLI can still read the user's files.
    const available = (await detectAll()).filter(entry => entry?.available && supportsNoTools(entry.type));
    const chosen = available.find(entry => entry.type === 'claude') || available[0];
    if (!chosen) throw Object.assign(new Error('capture model configuration is required'), { code: 'capture_model_not_configured' });
    const prompt = `${options.systemPrompt}\n\n${options.message}`;
    const dispatch = async () => {
      if (options.signal?.aborted || options.shouldContinue && !await options.shouldContinue())
        throw Object.assign(new Error('Capture model run interrupted'), { code: 'ABORT_ERR' });
      return runCliAgent({ uid: userId, cid: options.cliContext?.conversationId || options.jobContext!.jobId,
        agentId: options.cliContext?.agentId || 'recall-capture-analysis', agentName: options.cliContext?.agentName || 'Capture Analysis',
        cli: chosen.type, prompt, cwd: os.tmpdir(), signal: options.signal, skipDispatchCheck: true,
        toolPolicy: 'none', onEvent: () => {} });
    };
    const outcome = options.budget
      ? await withCaptureModelBudget(userId, options.budget, prompt.length, dispatch) : await dispatch();
    if (options.signal?.aborted || outcome.status === 'cancelled')
      throw Object.assign(new Error('Capture model run interrupted'), { code: 'ABORT_ERR' });
    if (outcome.status !== 'completed' || !outcome.output?.trim())
      throw Object.assign(new Error('capture CLI model did not complete'), { code: 'capture_model_unavailable' });
    return { result: { text: outcome.output.trim(), meta: {} } as ModelResult };
  }
  const routes: Array<RecallCaptureModelCandidate | undefined> = options.modelCandidates.length
    ? [...options.modelCandidates] : [undefined];
  let lastError: unknown;
  for (let index = 0; index < routes.length; index++) {
    if (options.signal?.aborted || (options.shouldContinue && !await options.shouldContinue())) {
      throw Object.assign(new Error('Capture model run interrupted'), { code: 'ABORT_ERR' });
    }
    const route = routes[index];
    let chosen: RecallCaptureModelCandidate | undefined;
    try {
      const dispatch = async (beforeDispatch?: () => Promise<void>) => {
        if (options.signal?.aborted || options.budget && options.shouldContinue && !await options.shouldContinue())
          throw Object.assign(new Error('Capture model run interrupted'), { code: 'ABORT_ERR' });
        let hostDispatchError: unknown;
        const { runner } = await buildRunner({ sessionId: options.sessionId, userId,
          systemPrompt: options.systemPrompt, disableTools: true, ephemeralSession: true, skillList: [],
          ...(options.budget ? { onModelDispatch: async () => {
            if (options.signal?.aborted || options.shouldContinue && !await options.shouldContinue())
              throw Object.assign(new Error('Capture model run interrupted'), { code: 'ABORT_ERR' });
            try { await beforeDispatch?.(); } catch (error) { hostDispatchError = error; throw error; }
          } } : {}),
          ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
          ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
          ...(route ? { modelCandidates: [route] } : {}),
          onCandidateChosen: info => { chosen = { provider: info.providerId, model: info.modelId }; },
        });
        const thinkingLevel = getThinkingLevel(userId);
        const result = await runner.run({ message: options.message, signal: options.signal, cacheRetention: 'none',
          ...(thinkingLevel === 'auto' ? {} : { thinkingLevel }) });
        // Runner error envelopes must not erase a host circuit hold reason.
        if (hostDispatchError) throw hostDispatchError;
        return result;
      };
      const result = options.budget ? await withCaptureModelBudget(userId, options.budget,
        options.systemPrompt.length + options.message.length, dispatch, result => result.meta.usage, { dispatchMode: 'physical' }) : await dispatch();
      if (options.signal?.aborted || result.meta.aborted) return { result, chosen };
      if (!result.meta.error) {
        if (chosen) log.info('capture stage model completed', { provider: chosen.provider, model: chosen.model });
        return { result, chosen };
      }
      if (index === routes.length - 1 || !await availabilityFailure(result.meta.error)) return { result, chosen };
      lastError = result.meta.error;
    } catch (error) {
      if (options.signal?.aborted || index === routes.length - 1 || !await availabilityFailure(error)) throw error;
      lastError = error;
    }
    log.warn('capture stage model unavailable; trying next configured model', { candidate_index: index });
  }
  throw lastError;
}
