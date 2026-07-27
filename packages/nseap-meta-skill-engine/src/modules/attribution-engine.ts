// ============================================================
// Module: Attribution Lab (Module 3)
// Judges why something succeeded or failed — the "So What" step
// Key rule: DeltaA gates DeltaR (fix the body first, then learn the mind)
// ============================================================

import type { KSTAREpisode, PatchTarget } from '../types/index.js';
import { generateId } from '../utils/ids.js';

export interface AttributionRecord {
  attribution_id: string;
  episode_id: string;
  delta_r_analysis: {
    value: number;
    significant: boolean;
    threshold: number;
  };
  delta_a_analysis: {
    value: number;
    gates_delta_r: boolean;         // if true, DeltaR untrustworthy
    confidence_cap: 'high' | 'medium' | 'low';
  };
  root_cause: {
    category: PatchTarget;
    description: string;
    evidence: string[];
  };
  recommendation: {
    action: 'patch_skill' | 'patch_ontology_tbox' | 'patch_ontology_rbox' | 'patch_ontology_abox' | 'create_skill' | 'no_action';
    target_id?: string;
    rationale: string;
  };
  timestamp: string;
}

/**
 * Attribution Engine — triage analysis of KSTAR Episodes
 * Determines: execution problem vs knowledge problem vs ontology gap
 */
export class AttributionEngine {
  private records: AttributionRecord[] = [];
  private readonly DELTA_R_THRESHOLD = 0.5;

  /**
   * Analyze an episode and produce an attribution record
   */
  analyze(episode: KSTAREpisode): AttributionRecord {
    const deltaRSignificant = Math.abs(episode.delta_r) >= this.DELTA_R_THRESHOLD;
    const deltaAGatesDeltaR = episode.delta_a !== 0;  // DeltaA gates DeltaR
    const confidenceCap = deltaAGatesDeltaR ? 'medium' : 'high';

    // Root cause analysis
    const rootCause = this.identifyRootCause(episode, deltaRSignificant, deltaAGatesDeltaR);

    // Recommendation
    const recommendation = this.formulateRecommendation(episode, rootCause, deltaAGatesDeltaR);

    const record: AttributionRecord = {
      attribution_id: generateId('attr'),
      episode_id: episode.episode_id,
      delta_r_analysis: {
        value: episode.delta_r,
        significant: deltaRSignificant,
        threshold: this.DELTA_R_THRESHOLD,
      },
      delta_a_analysis: {
        value: episode.delta_a,
        gates_delta_r: deltaAGatesDeltaR,
        confidence_cap: confidenceCap,
      },
      root_cause: rootCause,
      recommendation: recommendation,
      timestamp: new Date().toISOString(),
    };

    this.records.push(record);
    return record;
  }

  /**
   * Aggregate multiple episodes into a pattern (symbolic aggregation rule)
   * Candidates need >= 2 independent evidence to become proposals
   */
  aggregate(episodes: KSTAREpisode[]): Array<{ target: PatchTarget; count: number; episodes: string[] }> {
    const grouped = new Map<PatchTarget, { count: number; episodes: string[] }>();

    for (const ep of episodes) {
      const attr = this.records.find(r => r.episode_id === ep.episode_id);
      if (!attr) continue;

      const target = attr.root_cause.category;
      const existing = grouped.get(target) ?? { count: 0, episodes: [] };
      existing.count++;
      existing.episodes.push(ep.episode_id);
      grouped.set(target, existing);
    }

    // Filter: minimum support >= 2 independent evidence
    return Array.from(grouped.entries())
      .filter(([, v]) => v.count >= 2)
      .map(([target, v]) => ({ target, ...v }));
  }

  /**
   * Get all attribution records
   */
  getRecords(): AttributionRecord[] {
    return [...this.records];
  }

  /**
   * Get record by episode ID
   */
  getRecordByEpisode(episodeId: string): AttributionRecord | undefined {
    return this.records.find(r => r.episode_id === episodeId);
  }

  /**
   * Analyze "no matching skill" episode — triggers auto skill creation
   * This is the bridge between KSTAR attribution and Skill-Creator (channel 2)
   */
  analyzeNoMatch(episode: KSTAREpisode): AttributionRecord {
    const record: AttributionRecord = {
      attribution_id: generateId('attr'),
      episode_id: episode.episode_id,
      delta_r_analysis: { value: 0, significant: false, threshold: 0.5 },
      delta_a_analysis: { value: 0, gates_delta_r: false, confidence_cap: 'high' },
      root_cause: {
        category: 'Skill',
        description: 'No matching skill found for this query. A new skill needs to be created.',
        evidence: [`Query: ${episode.task}`, `Situation: ${episode.situation}`],
      },
      recommendation: {
        action: 'create_skill',
        rationale: 'First occurrence of unmatched query — trigger auto skill creation (N=1 sensitive mode).',
      },
      timestamp: new Date().toISOString(),
    };

    this.records.push(record);
    return record;
  }

  /**
   * Route attribution result to the correct action
   * Returns the action type and target info
   */
  routeRecommendation(record: AttributionRecord): {
    action: string;
    skill_id?: string;
    ontology_id?: string;
    message: string;
  } {
    switch (record.recommendation.action) {
      case 'create_skill':
        return {
          action: 'create_skill_auto',
          message: `发现新能力缺口: "${record.root_cause.description}"。建议创建新技能。`,
        };
      case 'patch_skill':
        return {
          action: 'propose_skill_patch',
          skill_id: record.root_cause.category,
          message: `Skill 需要修复: ${record.recommendation.rationale}`,
        };
      case 'patch_ontology_tbox':
      case 'patch_ontology_rbox':
      case 'patch_ontology_abox':
        return {
          action: 'propose_ontology_patch',
          ontology_id: record.root_cause.category,
          message: `本体需要修复: ${record.recommendation.rationale}`,
        };
      default:
        return { action: 'no_action', message: '无需操作' };
    }
  }

  // ── Private helpers ─────────────────────────────────────

  private identifyRootCause(
    episode: KSTAREpisode,
    deltaRSignificant: boolean,
    deltaAGatesDeltaR: boolean,
  ): AttributionRecord['root_cause'] {
    // DeltaA != 0 → execution problem (fix the body first)
    if (deltaAGatesDeltaR) {
      return {
        category: 'Skill',
        description: 'Execution deviation: agent did not follow the intended workflow. DeltaR untrustworthy — diagnose execution/tool/permission issues first.',
        evidence: [`DeltaA=${episode.delta_a}`, `Predicted: ${episode.action_hat}`, `Actual: ${episode.actual_action}`],
      };
    }

    // DeltaA = 0 but DeltaR significant → knowledge problem
    if (deltaRSignificant) {
      // Heuristic: if result is empty/missing, likely ontology gap
      if (!episode.actual_result || episode.actual_result === '') {
        return {
          category: 'TBox',
          description: 'Agent executed correctly but produced no result. Likely missing concept or property in ontology TBox.',
          evidence: [`DeltaR=${episode.delta_r}`, `Task: ${episode.task}`],
        };
      }
      // If result exists but wrong, likely rule issue
      return {
        category: 'RBox',
        description: 'Agent executed correctly but result incorrect. Likely missing or wrong business rule in ontology RBox.',
        evidence: [`DeltaR=${episode.delta_r}`, `Expected: ${episode.result_hat}`, `Actual: ${episode.actual_result}`],
      };
    }

    // No significant deviation
    return {
      category: 'Skill',
      description: 'No significant deviation detected. Episode is a positive example.',
      evidence: [`DeltaR=${episode.delta_r}`, `DeltaA=${episode.delta_a}`],
    };
  }

  private formulateRecommendation(
    episode: KSTAREpisode,
    rootCause: AttributionRecord['root_cause'],
    deltaAGatesDeltaR: boolean,
  ): AttributionRecord['recommendation'] {
    if (deltaAGatesDeltaR) {
      return {
        action: 'patch_skill',
        rationale: 'Execution deviation detected. Review and patch Skill workflow/tool binding.',
      };
    }

    switch (rootCause.category) {
      case 'TBox':
        return {
          action: 'patch_ontology_tbox',
          rationale: 'Missing concept/property in ontology TBox. Propose new class or property.',
        };
      case 'RBox':
        return {
          action: 'patch_ontology_rbox',
          rationale: 'Missing or incorrect business rule in ontology RBox. Propose new or updated rule.',
        };
      case 'ABox':
        return {
          action: 'patch_ontology_abox',
          rationale: 'Insufficient examples in ontology ABox. Propose new fewshot examples.',
        };
      default:
        return {
          action: 'no_action',
          rationale: 'No significant issue detected. Record as positive example.',
        };
    }
  }
}
