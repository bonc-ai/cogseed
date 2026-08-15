import { createLogger } from '../../logger';
import { loadCommittedProjectionKnowledge } from '../recall/projection-knowledge';
import { commitCommanderForecast } from './forecast-commit';

/**
 * auto-forecast.ts — the WORLD MODEL owns prediction.
 *
 * Architectural fix (live 2026-08-15): the Commander was previously expected
 * to emit `kstar_control commit_forecast` with a giant nested JSON payload
 * (candidates with plan/expectedTools/expectedActors/predictedResult plus
 * runtime ids it cannot know). deepseek-v4-flash systematically fails that
 * shape (stringified objects, flattened arrays, guessed ids) — three live
 * rounds of host-side tolerance patches followed. The world model already
 * had the full scoring/selection/recording pipeline; it only lacked the
 * candidate GENERATION step, which wrongly lived in the Commander's tool
 * surface.
 *
 * Now the host triggers prediction automatically once a projection is
 * confirmed: a dedicated ephemeral runner (same pattern as the routing
 * judge — NOT the busy commander turn) generates 2-4 candidate plans from
 * the committed projection knowledge, the host parses them tolerantly, and
 * the existing world-model scoring commits the forecast record. The
 * Commander's tool surface no longer contains kstar_control at all.
 */

const log = createLogger('kstar.auto-forecast');

/** Ceiling for the forecast-generation model call. */
export const AUTO_FORECAST_TIMEOUT_MS = 30_000;

/** Prompt for the dedicated forecast candidate generator. The model only
 *  needs to reason about the TASK + the projected ability assets; it never
 *  supplies runtime ids (host resolves them). Output is a tagged JSON array
 *  so the parser has a stable contract, but parsing is tolerant (see
 *  parseGeneratedForecastCandidates). */
export const AUTO_FORECAST_PROMPT = [
  'You are the world-model prediction generator for a governed task.',
  'Given the task goal and the projected ability assets (reusable capability statements), propose 2-4 distinct candidate execution plans that would achieve the goal.',
  'Reply with EXACTLY one <kstar-forecast> block containing a JSON array and nothing else around it:',
  '[{"plan":["step 1","step 2"],"expectedTools":["tool-name"],"expectedActors":["commander"],"predictedResult":{"summary":"expected outcome","acceptanceSignals":["signal"]}}, ...]',
  '- plan: 2-6 concrete steps; expectedTools: real tool names or [] when none; expectedActors: "commander" and/or delegated agent names or []; predictedResult.summary: the expected deliverable; predictedResult.acceptanceSignals: 0-3 checkable signals.',
  '- Candidates must differ meaningfully (e.g. direct approach vs delegation vs tool-heavy verification).',
  '- Use the projected ability assets when they fit; do not invent asset names.',
].join('\n');

/** Tolerant parser: accepts the tagged array, a bare JSON array, prose
 *  wrapped around JSON, or flattened strings inside candidates. Returns a
 *  list of raw candidate objects (host-side validation in forecast-commit
 *  applies the real shape rules). */
export function parseGeneratedForecastCandidates(text: string | undefined): unknown[] {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const tagged = raw.match(/<kstar-forecast>\s*([\s\S]*?)\s*<\/kstar-forecast>/);
  const payload = (tagged ? tagged[1] : raw).trim();
  const jsonStart = payload.search(/[[{]/);
  if (jsonStart < 0) return [];
  const candidate = payload.slice(jsonStart);
  for (let end = candidate.length; end > 0; end -= 1) {
    try {
      const value = JSON.parse(candidate.slice(0, end));
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') return [value];
    } catch {
      /* keep trimming */
    }
  }
  return [];
}

export interface AutoForecastOptions {
  /** Bounded model call ceiling. */
  timeoutMs?: number;
  /** Injectable runner for tests (mirrors the routing-judge hook pattern). */
  generate?: (prompt: string, payload: unknown) => Promise<string | null>;
  /** Override the default tool-name allowlist check (empty = skip tool
   *  availability validation, since the generator cannot know the live
   *  tool set at forecast time). */
  allowedToolNames?: ReadonlySet<string>;
}

let _autoForecastGeneratorForTest: AutoForecastOptions['generate'] | null = null;

export function _setAutoForecastGeneratorForTest(
  generate: AutoForecastOptions['generate'] | null,
): void {
  _autoForecastGeneratorForTest = generate;
}

/** Generate + commit a world-model forecast for an open requirement whose
 *  projection is confirmed. Idempotent: skips when a forecast already
 *  exists. Never blocks the caller on model failure — returns ok:false and
 *  logs, so the user's task still proceeds (execution is never held hostage
 *  by prediction quality). */
export async function autoForecastForRequirement(
  userId: string,
  conversationId: string,
  requirementId: string,
  options: AutoForecastOptions = {},
): Promise<{ ok: boolean; forecastId?: string; reason?: string }> {
  try {
    const { readKstarRequirement } = await import('./requirement-store');
    const requirement = await readKstarRequirement(userId, requirementId);
    if (!requirement || requirement.status !== 'open') {
      return { ok: false, reason: 'no open requirement' };
    }
    if (requirement.forecastId) return { ok: true, forecastId: requirement.forecastId };
    if (!requirement.projectionId) {
      return { ok: false, reason: 'projection not confirmed yet' };
    }

    let knowledge: Awaited<ReturnType<typeof loadCommittedProjectionKnowledge>>;
    try {
      knowledge = await loadCommittedProjectionKnowledge(userId, requirement.projectionId);
    } catch {
      return { ok: false, reason: 'projection knowledge unavailable' };
    }

    const assetLines = knowledge.abilityAssets
      .slice(0, 12)
      .map((asset) => `- [${asset.type}] ${asset.title}: ${asset.statement}`)
      .join('\n');

    const generate = options.generate || _autoForecastGeneratorForTest || (async (prompt, payload) => {
      const { buildRunner } = await import('../../model/core-agent/runner');
      const { runner } = await buildRunner({
        sessionId: `kstar-forecast-${conversationId}`,
        userId,
        systemPrompt: prompt,
        disableTools: true,
        ephemeralSession: true,
        skillList: [],
      });
      const task = await Promise.race([
        runner.run({
          message: JSON.stringify(payload),
          thinkingLevel: 'off',
          cacheRetention: 'none',
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), options.timeoutMs || AUTO_FORECAST_TIMEOUT_MS)),
      ]);
      if (!task || task.meta.aborted || task.meta.error) {
        log.warn('kstar auto-forecast runner failed', {
          userId,
          conversationId,
          aborted: task?.meta.aborted,
          error: task?.meta.error,
        });
        return null;
      }
      return task.text || null;
    });

    const payload = {
      taskGoal: requirement.goalText,
      projectedAbilityAssets: assetLines || '(none projected)',
      ...(requirement.rHat?.acceptanceSignals?.length
        ? { acceptanceSignals: requirement.rHat.acceptanceSignals }
        : {}),
    };
    const generated = await generate(AUTO_FORECAST_PROMPT, payload);
    const candidates = parseGeneratedForecastCandidates(generated);
    if (!candidates.length) {
      log.warn('kstar auto-forecast generated no candidates', {
        userId,
        requirementId,
        raw: String(generated || '').slice(0, 200),
      });
      return { ok: false, reason: 'no candidates generated' };
    }
    // Bounded: keep at most 4 candidates (world-model contract).
    const bounded = candidates.slice(0, 4);
    if (bounded.length < 2) {
      log.warn('kstar auto-forecast generated fewer than 2 candidates', {
        userId,
        requirementId,
      });
      return { ok: false, reason: 'fewer than 2 candidates' };
    }

    const record = await commitCommanderForecast(userId, {
      taskRunId: requirement.taskId,
      requirementId: requirement.id,
      projectionId: requirement.projectionId,
      candidates: bounded,
      allowedToolNames: options.allowedToolNames || new Set<string>(),
      taskText: requirement.goalText,
      acceptanceCriteria: requirement.rHat?.acceptanceSignals || [],
    });
    log.info('kstar auto-forecast committed', {
      userId,
      requirementId,
      forecastId: record.id,
      candidateCount: bounded.length,
    });
    return { ok: true, forecastId: record.id };
  } catch (error) {
    log.warn('kstar auto-forecast degraded', {
      userId,
      requirementId,
      error: (error as Error).message,
    });
    return { ok: false, reason: (error as Error).message };
  }
}

/** Test-only: trigger the forecast generation for a requirement whose
 *  projection exists, using the current generator (or none → ok:false). */
export async function _autoForecastForRequirementForTest(
  userId: string,
  requirementId: string,
  generate?: AutoForecastOptions['generate'],
): Promise<{ ok: boolean; forecastId?: string; reason?: string }> {
  const { readKstarRequirement } = await import('./requirement-store');
  const requirement = await readKstarRequirement(userId, requirementId);
  if (!requirement) return { ok: false, reason: 'no requirement' };
  return autoForecastForRequirement(userId, requirement.conversationId, requirementId, {
    ...(generate ? { generate } : {}),
  });
}
