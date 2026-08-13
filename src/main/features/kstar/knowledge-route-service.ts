import { promoteRecallCandidate, type RecallAbilityAssetRecord, type RecallCandidateRecord } from '../recall/candidate-service';
import type { AbilityAssetOntologyRef } from '../recall/ontology-refs';
import { appendFieldValueToRef, appendFlowEntryToRef, buildContentRef } from '../personal_ontology_template_files';

export interface KstarOntologyRouteInput {
  groupId: string;
  section?: string;
  field?: string;
}

export interface RouteConfirmedKstarCandidateInput {
  ontology?: KstarOntologyRouteInput;
}

export interface RouteConfirmedKstarCandidateResult {
  candidate: RecallCandidateRecord;
  asset: RecallAbilityAssetRecord;
  ontology?: { ok: boolean; error?: string };
}

function placement(input: KstarOntologyRouteInput): AbilityAssetOntologyRef {
  return {
    groupId: input.groupId,
    ...(input.section ? { section: input.section } : {}),
    ...(input.field ? { field: input.field } : {}),
  };
}

export async function routeConfirmedKstarCandidate(
  userId: string,
  candidateId: string,
  input: RouteConfirmedKstarCandidateInput = {},
): Promise<RouteConfirmedKstarCandidateResult> {
  const ontologyRefs = input.ontology ? [placement(input.ontology)] : [];
  const promoted = await promoteRecallCandidate(userId, candidateId, { actor: 'user', ontologyRefs });
  if (!input.ontology) return promoted;

  const ref = input.ontology.section ? buildContentRef(input.ontology.groupId, input.ontology.section) : input.ontology.groupId;
  const write = input.ontology.field
    ? await appendFieldValueToRef(userId, ref, input.ontology.field, promoted.asset.statement, 'KSTAR')
    : await appendFlowEntryToRef(userId, ref, promoted.asset.statement);

  return { ...promoted, ontology: write };
}
