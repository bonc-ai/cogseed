/** Host-qualified recall candidates only. One optional batch clarifies meaning;
 * no verdict can broaden scope, revive a source or authorize an operation. */
import { z } from 'zod';
import { prompts } from '../../prompts/loader';
import { readAbilityAsset } from './asset-service';
import { runRecallCaptureModel } from './capture-model-routing';
import { readRecallCaptureSettings } from './capture-settings';
import { resolveRecallCaptureModelCandidates } from './capture-model-selection';
import type { RecallAbilityAssetRecord } from './candidate-service';
import type { AssetScopeContext } from './scope-policy';
export const decisionSchema = z.object({ assetId: z.string(), version: z.string(),
  verdict: z.enum(['applicable', 'not_applicable', 'uncertain']), reason: z.string().trim().min(1).max(2000),
  taskQuote: z.string().min(1).max(1000), assetQuote: z.string().min(1).max(1000),
  rank: z.number().int().min(0).max(100),
}).strict();
export type SemanticApplicabilityDecision = z.infer<typeof decisionSchema>;
export interface SemanticApplicabilityResult {
  decisions: SemanticApplicabilityDecision[];
  unassessed: Array<{ assetId: string; version: string; reason: 'candidate_limit' | 'context_limit' }>;
}
const titleKey = (asset: RecallAbilityAssetRecord) => asset.title.normalize('NFKC').trim().toLocaleLowerCase();
const conflicts = (left: RecallAbilityAssetRecord, right: RecallAbilityAssetRecord) => left.id !== right.id
  && (titleKey(left) === titleKey(right) && left.statement !== right.statement
    || left.relations?.some(row => row.assetId === right.id && row.kind === 'conflicts_with')
    || right.relations?.some(row => row.assetId === left.id && row.kind === 'conflicts_with'));
const version = (asset: RecallAbilityAssetRecord) => String(asset.activeVersion || asset.version);
const uniqueLiteral = (text: string, quote: string) => !!quote.trim() && text.indexOf(quote) >= 0
  && text.indexOf(quote, text.indexOf(quote) + 1) < 0;
export function parseSemanticApplicability(raw: string, task: string, assets: RecallAbilityAssetRecord[]): SemanticApplicabilityDecision[] {
  if (raw.length > 32_000) throw new Error('semantic selection response too large');
  const result = z.object({ decisions: z.array(decisionSchema).max(12) }).strict()
    .parse(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
  if (result.decisions.length !== assets.length) throw new Error('incomplete semantic selection');
  const seen = new Set<string>();
  for (const row of result.decisions) {
    const asset = assets.find(asset => asset.id === row.assetId && version(asset) === row.version);
    const content = asset && [asset.statement, ...(asset.applicableWhen || []), ...(asset.forbiddenWhen || [])].join('\n');
    if (!asset || seen.has(asset.id) || !uniqueLiteral(task, row.taskQuote) || !uniqueLiteral(content!, row.assetQuote)) throw new Error('unresolved semantic selection evidence');
    seen.add(asset.id);
  }
  return result.decisions;
}
export function ambiguousRecallAssetIds(assets: RecallAbilityAssetRecord[], task: string, comparisonAssets = assets): Set<string> {
  const lower = task.toLocaleLowerCase();
  const ambiguous = new Set<string>();
  for (const asset of assets) {
    // Exact matches keep their existing path. Free-text conditions that did
    // not literally match need meaning adjudication, not a guessed exclusion.
    if ((asset.applicableWhen?.length && !asset.applicableWhen.some(value => lower.includes(value.toLocaleLowerCase())))
      || (asset.forbiddenWhen?.length && !asset.forbiddenWhen.some(value => lower.includes(value.toLocaleLowerCase())))) ambiguous.add(asset.id);
    if (comparisonAssets.some(other => conflicts(asset, other))) ambiguous.add(asset.id);
  }
  return ambiguous;
}
export async function assessSemanticApplicability(userId: string, task: string, assets: RecallAbilityAssetRecord[],
  context: AssetScopeContext, assess?: (message: string) => Promise<string>,
  comparisonAssets: RecallAbilityAssetRecord[] = assets): Promise<SemanticApplicabilityResult> {
  const { filterRecallAssetsForAgentRead } = await import('./prompt-injection');
  const candidate = (asset: RecallAbilityAssetRecord) => ({
    assetId: asset.id, version: version(asset), title: asset.title, statement: asset.statement,
    applicableWhen: asset.applicableWhen, forbiddenWhen: asset.forbiddenWhen, scope: asset.scope,
    scopePolicy: asset.scopePolicy, ontologyRefs: asset.ontologyRefs, relations: asset.relations,
  });
  const requested = new Set(assets.map(asset => asset.id));
  const pool = [...new Map([...comparisonAssets, ...assets].map(asset => [asset.id, asset])).values()];
  const at = new Date().toISOString(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const messageFor = (batch: RecallAbilityAssetRecord[]) => JSON.stringify({ currentTask: task, hostScope: context,
    currentTime: at, timeZone, candidates: batch.filter(asset => requested.has(asset.id)).map(candidate),
    comparisonCandidates: batch.filter(asset => !requested.has(asset.id)).map(candidate) });
  // Length accounting stays incremental: serializing the whole batch again for
  // every conflict group made packing O(n²) in the number of comparable assets.
  const candidateJson = new Map<string, string>();
  const candidateLength = (asset: RecallAbilityAssetRecord): number => {
    let value = candidateJson.get(asset.id);
    if (value === undefined) { value = JSON.stringify(candidate(asset)); candidateJson.set(asset.id, value); }
    return value.length;
  };
  const emptyLength = JSON.stringify({ currentTask: task, hostScope: context, currentTime: at, timeZone,
    candidates: [], comparisonCandidates: [] }).length;
  const arrayLength = (count: number, total: number): number => count ? 1 + total + count : 2;
  const messageLength = (batch: RecallAbilityAssetRecord[]): number => {
    let requestedCount = 0, requestedLength = 0, comparisonCount = 0, comparisonLength = 0;
    for (const asset of batch) {
      const length = candidateLength(asset);
      if (requested.has(asset.id)) { requestedCount += 1; requestedLength += length; }
      else { comparisonCount += 1; comparisonLength += length; }
    }
    return emptyLength - 4 + arrayLength(requestedCount, requestedLength) + arrayLength(comparisonCount, comparisonLength);
  };
  const batch: RecallAbilityAssetRecord[] = [], visited = new Set<string>();
  const unassessed: SemanticApplicabilityResult['unassessed'] = [];
  // Ranking comes from the host. Pack complete connected conflict groups into
  // one request; an overflow is an explicit unknown, never another model call.
  for (const seed of assets) {
    if (visited.has(seed.id)) continue;
    const group = [seed]; visited.add(seed.id);
    for (let i = 0; i < group.length; i++) for (const other of pool) {
      if (!visited.has(other.id) && conflicts(group[i], other)) { visited.add(other.id); group.push(other); }
    }
    const next = [...batch, ...group];
    const reason = next.length > 12 ? 'candidate_limit' : messageLength(next) > 96_000 ? 'context_limit' : undefined;
    if (reason) for (const asset of group.filter(asset => requested.has(asset.id)))
      unassessed.push({ assetId: asset.id, version: version(asset), reason });
    else batch.push(...group);
  }
  if (!batch.length) return { decisions: [], unassessed };
  const unchanged = async () => {
    for (const asset of batch) {
      const current = await readAbilityAsset(userId, asset.id);
      if (JSON.stringify(current) !== JSON.stringify(asset)
        || !(await filterRecallAssetsForAgentRead(userId, [current], { ...context, taskText: task })).length) throw new Error('semantic selection snapshot changed');
    }
  };
  const message = messageFor(batch);
  await unchanged();
  const text = assess ? await assess(message) : await (async () => {
    const settings = await readRecallCaptureSettings(userId);
    const modelCandidates = await resolveRecallCaptureModelCandidates(userId, settings.modelCandidates);
    await unchanged();
    const { result } = await runRecallCaptureModel(userId, { sessionId: `one-shot-recall-applicability-${Date.now()}`,
      systemPrompt: prompts.load('cognition_semantic_applicability'), message, modelCandidates,
      shouldContinue: async () => { try { await unchanged(); return true; } catch { return false; } } });
    if (result.meta.aborted || result.meta.error) throw new Error('semantic selection unavailable');
    return result.text;
  })();
  const decisions = parseSemanticApplicability(text, task, batch.filter(asset => requested.has(asset.id)));
  await unchanged();
  return { decisions, unassessed };
}
