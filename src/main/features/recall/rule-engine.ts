import { scopeTokenMatches, splitScopeTerms } from './scope-policy';
import type { OntologyRule } from './ontology-rules';
import type { CausalRule } from './world-model-types';

/**
 * rule-engine.ts — host-side rule evaluation (minimal closed loop).
 *
 * Reference: the ontology-driven risk engine that evaluates R-Box rules
 * against the current task/state at each boundary. This minimal version
 * evaluates at forecast time (not per tool call yet):
 *
 *   - ontology rules (ontr-*, the ontology R-Box): trigger when the rule's
 *     subject/object/field tokens match the task text
 *   - asset rules (CausalRule, the ΔR lesson R-Box): trigger via their
 *     deterministic predicateKey against the A-Box snapshot (existing
 *     applyCausalRules path), OR by text trigger when no predicateKey exists
 *
 * Output: matchedRules — the rules whose trigger fired, with their ΔR
 * signal, fed into simulationInput.k so the Commander reasons over the
 * rules that actually apply to THIS task (not the whole rule library).
 */

export interface MatchedOntologyRule {
  source: 'ontology';
  ruleId: string;
  groupId: string;
  field: string;
  subject: string;
  object: string;
  trigger: string;
}

export interface MatchedAssetRule {
  source: 'asset';
  ruleId: string;
  assetId: string;
  cause: string;
  effect: string;
  mitigation: string;
  severity: CausalRule['severity'];
  deltaR: number | 'unknown';
  trigger: string;
}

export type MatchedRule = MatchedOntologyRule | MatchedAssetRule;

export interface RuleEngineInput {
  /** Task/goal text the rules are matched against. */
  taskText: string;
  /** Ontology R-Box rules (ontr-*). */
  ontologyRules: OntologyRule[];
  /** Asset R-Box rules with their owning asset ids. */
  assetRules: Array<{ assetId: string; rule: CausalRule }>;
}

export interface RuleEngineResult {
  matchedRules: MatchedRule[];
}

const MAX_MATCHED = 12;

function textTriggers(taskText: string, candidates: string[]): boolean {
  const taskTokens = splitScopeTerms(taskText);
  if (!taskTokens.length) return false;
  return candidates.some((candidate) => {
    const text = String(candidate || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) return false;
    // Whole-token first (fast path for exact concept names), then tokenize
    // the candidate trigger itself and check bidirectional containment per
    // token — a sentence trigger ("OAuth state is not checked") fires when
    // any of its tokens ('oauth', 'state') appears in the task.
    if (taskTokens.some((token) => token.toLocaleLowerCase() === text.toLocaleLowerCase())) return true;
    const triggerTokens = splitScopeTerms(text);
    return triggerTokens.some((triggerToken) => scopeTokenMatches(taskTokens, triggerToken));
  });
}

function evalOntologyRule(taskText: string, rule: OntologyRule): MatchedOntologyRule | null {
  const candidates = [rule.subject, rule.object, rule.field, rule.groupTitle];
  if (!textTriggers(taskText, candidates)) return null;
  return {
    source: 'ontology',
    ruleId: rule.id,
    groupId: rule.groupId,
    field: rule.field,
    subject: rule.subject,
    object: rule.object,
    trigger: `${rule.subject} ${rule.relation} ${rule.object}`,
  };
}

function evalAssetRule(taskText: string, assetId: string, rule: CausalRule): MatchedAssetRule | null {
  const candidates = [rule.cause, rule.effect, rule.mitigation];
  if (!textTriggers(taskText, candidates)) return null;
  return {
    source: 'asset',
    ruleId: `rule:${assetId}`,
    assetId,
    cause: rule.cause,
    effect: rule.effect,
    mitigation: rule.mitigation,
    severity: rule.severity,
    deltaR: rule.deltaR,
    trigger: rule.cause,
  };
}

/** Evaluate all rules against the current task text. Deterministic, bounded,
 *  and side-effect free — callers decide what to do with the matches. */
export function evaluateRules(input: RuleEngineInput): RuleEngineResult {
  const matchedRules: MatchedRule[] = [];
  for (const rule of input.ontologyRules) {
    const matched = evalOntologyRule(input.taskText, rule);
    if (matched) matchedRules.push(matched);
    if (matchedRules.length >= MAX_MATCHED) break;
  }
  if (matchedRules.length < MAX_MATCHED) {
    for (const entry of input.assetRules) {
      const matched = evalAssetRule(input.taskText, entry.assetId, entry.rule);
      if (matched) matchedRules.push(matched);
      if (matchedRules.length >= MAX_MATCHED) break;
    }
  }
  return { matchedRules };
}
