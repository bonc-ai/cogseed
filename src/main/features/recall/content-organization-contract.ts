/** Shared, side-effect-free merge/split contract for scan, conversation and review. */
import { z } from 'zod';
import type { RecallAbilityAssetRecord } from './candidate-service';
import type { OntologyRecord, OntologyDocument } from '../cognition/ontology/model';
import { RECALL_TEXT_LIMITS } from './content-contract';
export interface OrganizationOutput {
  title: string; statement: string; value?: string; applicableWhen?: string[]; forbiddenWhen?: string[];
  sourceAssetIds: string[]; excerpts: Array<{ assetId: string; quote: string }>; ontologyRecordIds: string[];
}
export interface OrganizationDraft {
  operation: 'merge' | 'split'; sourceAssetIds: string[]; outputs: OrganizationOutput[]; reason: string;
}
const text = z.string().min(1).max(RECALL_TEXT_LIMITS.statement);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const organizationOutputSchema = z.object({ title: z.string().min(1).max(1000), statement: text, value: text.optional(),
  applicableWhen: z.array(text).max(32).optional(), forbiddenWhen: z.array(text).max(32).optional(),
  sourceAssetIds: z.array(id).min(1).max(6),
  excerpts: z.array(z.object({ assetId: id, quote: text }).strict()).min(1).max(60),
  ontologyRecordIds: z.array(id).max(100),
}).strict() as z.ZodType<OrganizationOutput>;
export const organizationDraftSchema = z.object({ operation: z.enum(['merge', 'split']), sourceAssetIds: z.array(id).min(1).max(6),
  outputs: z.array(organizationOutputSchema).min(1).max(6), reason: text }).strict() as z.ZodType<OrganizationDraft>;
export interface OrganizationSource { head: RecallAbilityAssetRecord; rawHead: RecallAbilityAssetRecord; content: RecallAbilityAssetRecord }
export interface ContentOrganizationPlan {
  schemaVersion: 1; operationId: string; groupKey: string; origin: 'scan' | 'conversation'; draft: OrganizationDraft;
  sources: OrganizationSource[]; sourceState: string[]; ontologyRevision: number; ontologyBaseline: Record<string, OntologyRecord>;
  resultIds: string[]; ontologyChanges: Array<{ before?: OntologyRecord; after: OntologyRecord }>;
  ontologyAfter: Pick<OntologyDocument, 'revision' | 'records' | 'history' | 'receipts'>; createdAt: string; conversationRequestId?: string;
}
export interface ContentOrganizationReceipt {
  operationId: string; assets: Array<{ id: string; version: string }>; archivedIds: string[]; committedAt: string;
  afterAssets: Record<string, RecallAbilityAssetRecord>; ontologyAfter: Record<string, OntologyRecord>;
  undoneAt?: string; undoDecisionId?: string;
}
