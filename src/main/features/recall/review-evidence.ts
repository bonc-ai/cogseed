import { safeId } from '../../storage';
import { getConversation, getMessages } from '../chats';
import { readRecallCandidate } from './candidate-service';
import { readAbilityAsset } from './asset-service';
import { isCognitionSourceEnabled } from './source-control';
import { normalizeCognitionSourceRef, redactSourceExcerpt, type CognitionSourceRef } from './source-service';

export interface ReviewEvidenceItem {
  ref: CognitionSourceRef;
  state: 'available' | 'unavailable' | 'missing' | 'unrecorded' | 'read_failed' | 'changed' | 'ambiguous' | 'unmatched';
  title?: string;
  excerpt?: string;
  excerptKind?: 'recorded' | 'conversation_context';
  conversationId?: string;
  location?: { startLine: number; endLine: number };
  openTarget?: { conversationId: string; messageId: string; attachmentName?: string };
}

/** Read only sources already attached to an owned candidate/asset. Excerpts are
 * a transient review projection, never copied into the metadata-only catalog. */
export async function readReviewEvidence(
  userId: string,
  query: { candidateId?: string; assetId?: string },
): Promise<ReviewEvidenceItem[]> {
  if (Boolean(query.candidateId) === Boolean(query.assetId)) throw new Error('one review target is required');
  const id = query.candidateId || query.assetId;
  if (!safeId(id)) throw new Error('invalid review target id');
  const candidate = query.candidateId ? await readRecallCandidate(userId, query.candidateId) : undefined;
  const record = candidate || await readAbilityAsset(userId, query.assetId!);
  const refs = record.evidenceRefs?.length ? record.evidenceRefs : candidate?.sourceRefs || [];
  if (!refs.length && candidate?.stockOrganizationProvenance && candidate.ontologyFormation) {
    const { resolveLegacyOntologySource } = await import('./source-locator');
    const results: ReviewEvidenceItem[] = [];
    for (const change of candidate.ontologyFormation.previewChanges) {
      if (change.before?.source.kind !== 'user') continue;
      const found = await resolveLegacyOntologySource(userId, change.before.source.label);
      if (!found.recorded) continue;
      if (found.refs.length) results.push(...await readReviewEvidenceRefs(userId, found.refs));
      else results.push({ ref: { kind: 'ontology', subtype: 'artifact', taxonomyVersion: 1, id: change.before.id },
        state: found.issue || 'unrecorded' });
    }
    if (results.length) return results;
  }
  return readReviewEvidenceRefs(userId, refs, record.createdAt);
}

/** Internal reader for a host-owned stock baseline, not an arbitrary-reference IPC. */
export async function readReviewEvidenceRefs(userId: string, refs: readonly CognitionSourceRef[], createdAt?: string): Promise<ReviewEvidenceItem[]> {
  const seen = new Set<string>();
  const picked = (refs as CognitionSourceRef[]).filter(ref => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 100);
  return Promise.all(picked.map(async (ref): Promise<ReviewEvidenceItem> => {
    const { excerpt: _storedExcerpt, ...metadata } = ref;
    const base = { ref: metadata };
    if (ref.degraded) return { ...base, state: 'unavailable' };
    if (ref.locator) {
      const { readLocatedSource } = await import('./source-locator');
      const read = await readLocatedSource(userId, ref);
      if (read.state !== 'available') return { ...base, state: read.state, title: read.title };
      return { ...base, state: 'available', title: read.title,
        excerpt: redactSourceExcerpt(read.excerpt, 8_000),
        excerptKind: 'recorded', conversationId: ref.locator.conversationId, location: read.location,
        openTarget: { conversationId: ref.locator.conversationId, messageId: ref.locator.messageId,
          ...(ref.locator.attachmentName ? { attachmentName: ref.locator.attachmentName } : {}) } };
    }
    // The source-control domain uses canonical v2 discriminants.
    if (ref.kind !== 'conversation') return { ...base, state: 'unrecorded' };
    try {
      if (!(await isCognitionSourceEnabled(userId, ref))) return { ...base, state: 'unavailable' };
      // Message references use hashed locators; do not guess a parent session.
      if (ref.subtype === 'message' || !safeId(ref.id)) return { ...base, state: 'unrecorded' };
      const conversation = await getConversation(userId, ref.id);
      if (!conversation || conversation.deleted_at) return { ...base, state: 'unavailable' };
      const recorded = typeof ref.excerpt === 'string' ? ref.excerpt : '';
      const messages = recorded ? [] : await getMessages(userId, ref.id, 50);
      const at = Date.parse(String(createdAt || ''));
      const before = messages.filter(message => message.from === 'user' && message.text
        && !message.system_kind && (!Number.isFinite(at) || Date.parse(message.ts) <= at));
      const context = before.slice(-2).map(message => message.text.trim()).join('\n');
      const excerpt = normalizeCognitionSourceRef({ ...ref, excerpt: recorded || context }).excerpt;
      return {
        ...base, state: 'available', title: conversation.title || ref.title,
        conversationId: conversation.conversation_id,
        ...(excerpt ? { excerpt, excerptKind: recorded ? 'recorded' : 'conversation_context' } : {}),
      };
    } catch {
      return { ...base, state: 'read_failed' };
    }
  }));
}
