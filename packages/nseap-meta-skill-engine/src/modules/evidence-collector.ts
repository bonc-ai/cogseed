// ============================================================
// Module: Evidence & KSTAR Center (Module 1)
// Transforms agent interactions into learnable KSTAR Episodes
// ============================================================

import type {
  InteractionContext,
  KSTAREpisode,
  EvidenceBundle,
  GovernanceFields,
} from '../types/index.js';
import { generateId, generateHash } from '../utils/ids.js';

/**
 * Evidence Collector — captures interaction data and builds KSTAR Episodes
 * Core rule: DeltaA gates DeltaR (if execution deviated, DeltaR untrustworthy)
 */
export class EvidenceCollector {
  private episodes: KSTAREpisode[] = [];
  private bundles: EvidenceBundle[] = [];

  /**
   * Capture an interaction and produce a KSTAR Episode
   */
  captureEpisode(
    interaction: InteractionContext,
    prediction: { action_hat: string; result_hat: string },
    actual: { action: string; result: string },
  ): KSTAREpisode {
    const delta_r = this.computeDeltaR(prediction.result_hat, actual.result);
    const delta_a = this.computeDeltaA(prediction.action_hat, actual.action);
    const delta_a_gate = this.assessDeltaAGate(delta_a);

    const episode: KSTAREpisode = {
      episode_id: generateId('ep'),
      bundle_id: generateId('bundle'),
      k_snapshot_ref: interaction.ontology_refs.join(','),
      situation: this.summarizeSituation(interaction),
      task: interaction.user_query,
      action_hat: prediction.action_hat,
      result_hat: prediction.result_hat,
      actual_action: actual.action,
      actual_result: actual.result,
      delta_r,
      delta_a,
      delta_a_confidence_gate: delta_a_gate,
      timestamp: new Date().toISOString(),
      session_id: interaction.session_id,
      user_id: interaction.user_id,
      attribution_refs: [],
      patch_refs: [],
    };

    this.episodes.push(episode);
    return episode;
  }

  /**
   * Create a full Evidence Bundle (wraps episode with ontology + skill snapshots)
   */
  createBundle(
    episode: KSTAREpisode,
    interaction: InteractionContext,
    ontologySnapshots: EvidenceBundle['ontology_snapshots'],
    skillSnapshots: EvidenceBundle['skill_snapshots'],
  ): EvidenceBundle {
    const governance: GovernanceFields = {
      schema_version: '1.0.0',
      source_mode: 'real',
      authority_level: 'draft',
      owner_team: 'C',
      author_team: 'E',
      approver_team: null,
      source_refs: [interaction.session_id],
      evidence_refs: [episode.episode_id],
      artifact_hash: generateHash(episode.episode_id + episode.timestamp),
      data_boundary: 'internal',
      export_allowed: false,
      non_claim_note: '',
    };

    const bundle: EvidenceBundle = {
      bundle_id: episode.bundle_id,
      episode_id: episode.episode_id,
      interaction,
      kstar: episode,
      ontology_snapshots: ontologySnapshots,
      skill_snapshots: skillSnapshots,
      governance,
    };

    this.bundles.push(bundle);
    return bundle;
  }

  /**
   * Query episodes by session, skill, or delta threshold
   */
  queryEpisodes(filter: {
    session_id?: string;
    skill_id?: string;
    min_delta_r?: number;
    delta_a_gate?: 'pass' | 'warn' | 'fail';
    since?: string;
  }): KSTAREpisode[] {
    return this.episodes.filter(ep => {
      if (filter.session_id && ep.session_id !== filter.session_id) return false;
      if (filter.min_delta_r && Math.abs(ep.delta_r) < filter.min_delta_r) return false;
      if (filter.delta_a_gate && ep.delta_a_confidence_gate !== filter.delta_a_gate) return false;
      if (filter.since && ep.timestamp < filter.since) return false;
      return true;
    });
  }

  /**
   * Get all bundles
   */
  getBundles(): EvidenceBundle[] {
    return [...this.bundles];
  }

  /**
   * Get episode by ID
   */
  getEpisode(episodeId: string): KSTAREpisode | undefined {
    return this.episodes.find(ep => ep.episode_id === episodeId);
  }

  // ── Private helpers ─────────────────────────────────────

  private computeDeltaR(predicted: string, actual: string): number {
    // Simplified: numeric comparison if possible, else binary match
    const p = parseFloat(predicted);
    const a = parseFloat(actual);
    if (!isNaN(p) && !isNaN(a)) return a - p;
    return predicted === actual ? 0 : 1;
  }

  private computeDeltaA(predicted: string, actual: string): number {
    return predicted === actual ? 0 : 1;
  }

  private assessDeltaAGate(deltaA: number): 'pass' | 'warn' | 'fail' {
    if (deltaA === 0) return 'pass';
    if (deltaA <= 0.5) return 'warn';
    return 'fail';
  }

  private summarizeSituation(interaction: InteractionContext): string {
    const skill = interaction.matched_skill_name ?? 'unmatched';
    const ontologies = interaction.ontology_refs.join(', ') ?? 'none';
    return `Agent: ${interaction.agent_id}, Skill: ${skill}, Ontologies: ${ontologies}`;
  }
}
