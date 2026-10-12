/** Label-based offline evaluation. Historical applications alone are biased by exposure. */
export interface CatalogJudgedCase {
  id: string;
  /** Human-reviewed useful assets for this task. Empty means no asset should be suggested. */
  relevantIds: readonly string[];
  /** Assets known to be misleading or forbidden for this task. */
  harmfulIds?: readonly string[];
}

export interface CatalogEvaluatedRun {
  caseId: string;
  rankedIds: readonly string[];
  shownIds: readonly string[];
  appliedIds?: readonly string[];
}

export interface CatalogEvaluationSummary {
  cases: number;
  relevantCases: number;
  recallAt5: number;
  mrrAt10: number;
  noMatchSuccessRate: number | null;
  harmfulShownRate: number;
  relevantAppliedRate: number | null;
}

/** The same labels can score both old and new rankings without changing their data. */
export function evaluateCatalogRuns(
  cases: readonly CatalogJudgedCase[],
  runs: readonly CatalogEvaluatedRun[],
): CatalogEvaluationSummary {
  const byId = new Map(runs.map((run) => [run.caseId, run]));
  let recall = 0;
  let reciprocal = 0;
  let harmfulShown = 0;
  let shown = 0;
  let relevantApplied = 0;
  let applied = 0;
  let counted = 0;
  let relevantCases = 0;
  let noMatchCases = 0;
  let noMatchCorrect = 0;
  for (const judged of cases) {
    const run = byId.get(judged.id);
    if (!run) continue;
    counted += 1;
    const relevant = new Set(judged.relevantIds);
    const harmful = new Set(judged.harmfulIds || []);
    if (relevant.size) {
      relevantCases += 1;
      const found = new Set(run.rankedIds.slice(0, 5).filter((id) => relevant.has(id)));
      recall += found.size / relevant.size;
      const position = run.rankedIds.slice(0, 10).findIndex((id) => relevant.has(id));
      if (position >= 0) reciprocal += 1 / (position + 1);
    } else {
      noMatchCases += 1;
      if (run.shownIds.length === 0) noMatchCorrect += 1;
    }
    shown += run.shownIds.length;
    harmfulShown += run.shownIds.filter((id) => harmful.has(id)).length;
    for (const id of run.appliedIds || []) {
      applied += 1;
      if (relevant.has(id)) relevantApplied += 1;
    }
  }
  return {
    cases: counted,
    relevantCases,
    recallAt5: relevantCases ? recall / relevantCases : 0,
    mrrAt10: relevantCases ? reciprocal / relevantCases : 0,
    noMatchSuccessRate: noMatchCases ? noMatchCorrect / noMatchCases : null,
    harmfulShownRate: shown ? harmfulShown / shown : 0,
    relevantAppliedRate: applied ? relevantApplied / applied : null,
  };
}
