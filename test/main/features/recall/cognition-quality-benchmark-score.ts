import { FORMATION_CASES, type FormationQualityCase } from './cognition-quality-benchmark-fixture';

/** Fixed semantic labels stay unchanged. A forbidden field is a prohibition,
 * not a positive assertion; negated phrases in body/applicability likewise
 * cannot become positive wrong facts merely through substring matching. */
export function positiveCounterassertions(text: string, patterns: readonly RegExp[]): string[] {
  const failures: string[] = [];
  for (const pattern of patterns) for (const match of text.matchAll(new RegExp(pattern.source, [...new Set(pattern.flags + 'g')].join('')))) {
    const prefix = text.slice(0, match.index);
    if (/(?:不要|禁止|不得|不应|不该|不能|切勿|请勿|勿|别|避免|无需|不必|不是|并非|不)\s*(?:再|去)?\s*$/u.test(prefix)) continue;
    failures.push(match[0]);
  }
  return failures;
}

export function scoreFormationContract(unit: FormationQualityCase, row: {
  judgment: string; applicableWhen?: string[]; forbiddenWhen?: string[];
}) {
  const contract = [row.judgment, ...(row.applicableWhen || []).map(value => `适用于：${value}`),
    ...(row.forbiddenWhen || []).map(value => `不适用于：${value}`)].join('\n');
  const counterassertions = positiveCounterassertions([row.judgment, ...(row.applicableWhen || [])].join('\n'), unit.forbidden || []);
  // Banning the supported positive action is also wrong. This is independent
  // of positive wrong assertions in body/applicability; a correct prohibition
  // elsewhere cannot cancel a contradictory positive claim.
  const boundaryContradictions = (row.forbiddenWhen || []).filter(value =>
    (unit.forbiddenBoundary || []).some(pattern => pattern.test(value)));
  return { semantic: (unit.required || []).every(pattern => pattern.test(row.judgment))
    && (unit.requiredContract || []).every(pattern => pattern.test(contract))
    && !counterassertions.length && !boundaryContradictions.length,
    contract, counterassertions, boundaryContradictions };
}

export interface FormationBenchmarkProposal {
  id: string; judgment: string; applicableWhen?: string[]; forbiddenWhen?: string[];
  suggestedAction?: string; targetAssetId?: string; scopePolicy?: { projectIds?: string[] };
  sourceRefs: Array<{ id: string; subtype?: string }>; evidenceRefs: Array<{ id: string; subtype?: string }>;
  ontologyFormation?: { blockedReasons: string[]; [key: string]: unknown };
}
const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
export function scoreFormationOutputs(formed: FormationBenchmarkProposal[], sourceIds: Record<string, string>, projectId: string) {
  const references = (row: FormationBenchmarkProposal) => new Set([...row.sourceRefs, ...row.evidenceRefs].filter(ref => ref.subtype === 'message').map(ref => ref.id));
  const unitChecks = FORMATION_CASES.map(unit => {
    const sourceId = sourceIds[unit.id];
    if (!sourceId) throw new Error(`missing original source identity for ${unit.id}`);
    const checks = formed.filter(row => references(row).has(sourceId)).map(row => ({ candidateId: row.id,
      ...scoreFormationContract(unit, row), action: row.suggestedAction === 'create' && !row.targetAssetId,
      sourceScope: JSON.stringify(row.scopePolicy?.projectIds) === JSON.stringify([projectId]), body: row.judgment,
      applicableWhen: row.applicableWhen || [], forbiddenWhen: row.forbiddenWhen || [] }));
    return { id: unit.id, stratum: unit.stratum, positive: unit.positive, sourceId, checks,
      recalled: unit.positive && checks.some(row => row.semantic && row.action && row.sourceScope) };
  });
  const proposalChecks = formed.map(row => {
    const cited = unitChecks.filter(unit => unit.checks.some(check => check.candidateId === row.id));
    return { candidateId: row.id, citedUnits: cited.map(unit => unit.id), body: row.judgment,
      applicableWhen: row.applicableWhen || [], forbiddenWhen: row.forbiddenWhen || [], ontologyFormation: row.ontologyFormation,
      correct: !(row.ontologyFormation?.blockedReasons.length) && cited.length > 0
        && cited.every(unit => unit.positive && unit.checks.some(check => check.candidateId === row.id && check.semantic && check.action && check.sourceScope)) };
  });
  const positives = unitChecks.filter(unit => unit.positive);
  const recallNumerator = positives.filter(unit => unit.recalled).length;
  const precisionNumerator = proposalChecks.filter(row => row.correct).length;
  const strata = Object.fromEntries([...new Set(positives.map(unit => unit.stratum))].map(stratum => {
    const units = positives.filter(unit => unit.stratum === stratum);
    return [stratum, { numerator: units.filter(unit => unit.recalled).length, denominator: units.length }];
  }));
  return { recall: { numerator: recallNumerator, denominator: positives.length, value: ratio(recallNumerator, positives.length), strata },
    precision: { numerator: precisionNumerator, denominator: formed.length, value: ratio(precisionNumerator, formed.length) },
    negativeUnits: unitChecks.filter(unit => !unit.positive), unitChecks, proposalChecks,
    failures: { missed: positives.filter(unit => !unit.recalled), incorrect: proposalChecks.filter(row => !row.correct) } };
}
