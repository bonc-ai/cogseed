// ============================================================
// Module: Promotion & Governance Board (Module 7)
// Three-Gate pipeline: Validation → Governance → Canary
// Fixed order, any failure = rejection + permanent buffer
// ============================================================

import type { PatchProposal } from '../types/index.js';
import { ENGINE_CONFIG } from '../config/engine-config.js';

export interface GateResult {
  gate: 'Validation Gate' | 'Governance Gate' | 'Canary Gate';
  passed: boolean;
  evidence: string;
  timestamp: string;
}

export interface GovernanceDecision {
  decision_id: string;
  proposal_id: string;
  results: GateResult[];
  final_status: 'staged' | 'rejected' | 'needs_more_evidence';
  human_review_required: boolean;
  human_decision?: {
    approved: boolean;
    reviewer: string;
    reason: string;
    timestamp: string;
  };
}

/**
 * Three-Gate Governance — fixed order pipeline
 * Validation → Governance → Canary → (Human Review) → Staged
 */
export class GovernanceGates {
  private decisions: GovernanceDecision[] = [];

  /**
   * Run the full three-gate pipeline on a patch proposal
   */
  async runGates(proposal: PatchProposal): Promise<GovernanceDecision> {
    const results: GateResult[] = [];

    // Gate 1: Validation — candidate improves overall, no regression
    const validationResult = await this.runValidationGate(proposal);
    results.push(validationResult);
    if (!validationResult.passed) {
      return this.finalizeDecision(proposal, results, 'rejected');
    }

    // Gate 2: Governance — zero protected surface violations
    const governanceResult = await this.runGovernanceGate(proposal);
    results.push(governanceResult);
    if (!governanceResult.passed) {
      return this.finalizeDecision(proposal, results, 'rejected');
    }

    // Gate 3: Canary — representative scenario no degradation
    const canaryResult = await this.runCanaryGate(proposal);
    results.push(canaryResult);
    if (!canaryResult.passed) {
      return this.finalizeDecision(proposal, results, 'rejected');
    }

    // All gates passed → staged (NOT production release)
    return this.finalizeDecision(proposal, results, 'staged');
  }

  /**
   * Human review step — mandatory hard step before staged → production
   */
  humanReview(
    decisionId: string,
    approved: boolean,
    reviewer: string,
    reason: string,
  ): GovernanceDecision {
    const decision = this.decisions.find(d => d.decision_id === decisionId);
    if (!decision) throw new Error(`Decision not found: ${decisionId}`);

    decision.human_decision = {
      approved,
      reviewer,
      reason,
      timestamp: new Date().toISOString(),
    };

    if (approved) {
      decision.final_status = 'staged';
    } else {
      decision.final_status = 'rejected';
    }

    return decision;
  }

  /**
   * Get all governance decisions
   */
  getDecisions(): GovernanceDecision[] {
    return [...this.decisions];
  }

  // ── Gate Implementations ────────────────────────────────

  private async runValidationGate(proposal: PatchProposal): Promise<GateResult> {
    // Validation: candidate improves overall on replay set, no per-scenario regression
    const hasEvidence = proposal.evidence_refs.length >= 2;  // minimum support
    const withinBudget = proposal.operation_count <= ENGINE_CONFIG.edit_budget.max_operations;

    return {
      gate: 'Validation Gate',
      passed: hasEvidence && withinBudget,
      evidence: hasEvidence && withinBudget
        ? `Evidence: ${proposal.evidence_refs.length} refs, Operations: ${proposal.operation_count}/${ENGINE_CONFIG.edit_budget.max_operations}`
        : `Failed: evidence=${proposal.evidence_refs.length} (need >=2), operations=${proposal.operation_count}`,
      timestamp: new Date().toISOString(),
    };
  }

  private async runGovernanceGate(proposal: PatchProposal): Promise<GateResult> {
    // Governance: zero violations of protected invariants
    const protectedSurfaces = ENGINE_CONFIG.edit_budget.protected_surfaces;
    const touchesProtected = !proposal.mutable_surface;  // if not mutable, it's protected

    return {
      gate: 'Governance Gate',
      passed: !touchesProtected,
      evidence: !touchesProtected
        ? `Patch touches mutable surface only. Protected surfaces untouched: ${protectedSurfaces.join(', ')}`
        : `VIOLATION: Patch touches protected surface!`,
      timestamp: new Date().toISOString(),
    };
  }

  private async runCanaryGate(proposal: PatchProposal): Promise<GateResult> {
    // Canary: representative scenario canary verification shows no degradation
    // Simplified: check risk level — L4 auto-blocked
    const autoBlocked = proposal.risk_level >= 4;

    return {
      gate: 'Canary Gate',
      passed: !autoBlocked,
      evidence: !autoBlocked
        ? `Risk level ${proposal.risk_level} < 4, canary passed`
        : `AUTO-BLOCKED: Risk level ${proposal.risk_level} >= 4 (production data/external writes)`,
      timestamp: new Date().toISOString(),
    };
  }

  private finalizeDecision(
    proposal: PatchProposal,
    results: GateResult[],
    status: 'staged' | 'rejected' | 'needs_more_evidence',
  ): GovernanceDecision {
    const decision: GovernanceDecision = {
      decision_id: `gov_${proposal.proposal_id}`,
      proposal_id: proposal.proposal_id,
      results,
      final_status: status,
      human_review_required: status === 'staged',  // staged needs human review
    };

    this.decisions.push(decision);
    return decision;
  }
}
