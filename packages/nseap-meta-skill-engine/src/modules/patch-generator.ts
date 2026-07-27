// ============================================================
// Module: Patch Proposal Manager (Module 6)
// Normalizes attribution results into bounded, diff-able patch proposals
// Key constraint: edit budget <= 2 operations, mutable surface only
// ============================================================

import type { PatchProposal, PatchType, PatchTarget, GovernanceFields } from '../types/index.js';
import type { AttributionRecord } from './attribution-engine.js';
import { generateId, generateHash } from '../utils/ids.js';
import { ENGINE_CONFIG } from '../config/engine-config.js';

/**
 * Patch Generator — converts attribution into bounded patch proposals
 * Enforces: edit budget <= 2, mutable surface only, evidence refs required
 */
export class PatchGenerator {
  private proposals: PatchProposal[] = [];
  private rejectedBuffer: PatchProposal[] = [];  // append-only

  /**
   * Generate a patch proposal from an attribution record
   */
  generate(attribution: AttributionRecord, options: {
    target_id: string;
    target_version: string;
    current_content: string;
    proposed_content: string;
    description: string;
  }): PatchProposal {
    const patchType = this.mapToPatchType(attribution.recommendation.action);
    const operationCount = this.computeOperationCount(options.current_content, options.proposed_content);

    // Enforce bounded edit budget
    if (operationCount > ENGINE_CONFIG.edit_budget.max_operations) {
      throw new Error(
        `Patch exceeds edit budget: ${operationCount} operations > max ${ENGINE_CONFIG.edit_budget.max_operations}`
      );
    }

    const governance: GovernanceFields = {
      schema_version: '1.0.0',
      source_mode: 'real',
      authority_level: 'proposal',
      owner_team: 'E',
      author_team: 'E',
      approver_team: null,
      source_refs: [attribution.episode_id],
      evidence_refs: [attribution.attribution_id],
      artifact_hash: generateHash(options.proposed_content),
      data_boundary: 'internal',
      export_allowed: false,
      non_claim_note: '',
    };

    const proposal: PatchProposal = {
      proposal_id: generateId('patch'),
      type: patchType,
      target: attribution.root_cause.category,
      target_id: options.target_id,
      target_version: options.target_version,
      diff_ref: `diff://${options.target_id}/${generateId('diff')}`,
      description: options.description,
      before_hash: generateHash(options.current_content),
      after_hash: generateHash(options.proposed_content),
      operation_count: operationCount,
      mutable_surface: true,  // verified by gate later
      evidence_refs: [attribution.episode_id],
      risk_level: this.assessRiskLevel(attribution.root_cause.category),
      expected_improvement: attribution.recommendation.rationale,
      rollback_plan: `Revert to hash: ${generateHash(options.current_content)}`,
      status: 'proposed',
      governance_fields: governance,
    };

    this.proposals.push(proposal);
    return proposal;
  }

  /**
   * Reject a patch — moves to append-only rejected buffer
   */
  reject(proposalId: string, reason: string): void {
    const proposal = this.proposals.find(p => p.proposal_id === proposalId);
    if (proposal) {
      proposal.status = 'rejected';
      this.rejectedBuffer.push({ ...proposal });
    }
  }

  /**
   * Get all active proposals
   */
  getProposals(): PatchProposal[] {
    return [...this.proposals];
  }

  /**
   * Get rejected patches (append-only buffer)
   */
  getRejectedPatches(): PatchProposal[] {
    return [...this.rejectedBuffer];
  }

  /**
   * Get proposal by ID
   */
  getProposal(proposalId: string): PatchProposal | undefined {
    return this.proposals.find(p => p.proposal_id === proposalId);
  }

  // ── Private helpers ─────────────────────────────────────

  private mapToPatchType(action: AttributionRecord['recommendation']['action']): PatchType {
    switch (action) {
      case 'patch_skill': return 'SkillPatch';
      case 'patch_ontology_tbox':
      case 'patch_ontology_rbox':
      case 'patch_ontology_abox': return 'OntologyPatch';
      case 'create_skill': return 'SkillPatch';
      default: return 'SkillPatch';
    }
  }

  private computeOperationCount(before: string, after: string): number {
    // Simplified: count line differences
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    let diffs = 0;
    const maxLen = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (beforeLines[i] !== afterLines[i]) diffs++;
    }
    return Math.min(diffs, ENGINE_CONFIG.edit_budget.max_operations + 1);
  }

  private assessRiskLevel(target: PatchTarget): 0 | 1 | 2 | 3 | 4 {
    switch (target) {
      case 'Skill': return 1;
      case 'Workflow': return 2;
      case 'TBox':
      case 'RBox':
      case 'ABox': return 3;
      case 'Policy': return 4;
      default: return 1;
    }
  }
}
