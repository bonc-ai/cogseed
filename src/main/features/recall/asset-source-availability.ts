/** Task reads validate the current version's message dependencies. The reader
 * owns a single read's cache; no qualification survives into a later task. */
import { getMessagesPage } from '../chats';
import { verifyCandidateFormationForCommittedRead } from '../cognition/human-instruction-provenance';
import { readRecallCandidate, type RecallAbilityAssetRecord, type RecallCandidateRecord } from './candidate-service';
import { isCognitionSourceEnabled } from './source-control';
import { cognitionMessageSourceId } from './source-identity';
import { readLocatedSource } from './source-locator';
import { readRecallJsonRecord } from './store';
import type { CognitionSourceLocator, CognitionSourceRef } from './source-service';

type AssetSourceDependencies = Pick<RecallAbilityAssetRecord, 'id' | 'evidenceRefs' | 'candidateId' | 'sourceCandidateIds' | 'sourceSessionIds'>;
export type AssetSourceAvailability = (asset: AssetSourceDependencies) => Promise<boolean>;
const contentVersion = (ref: CognitionSourceRef) => /^sha256:[a-f0-9]{64}$/.test(ref.sourceVersion || '');
const sameSource = (left: CognitionSourceRef, right: CognitionSourceRef) => left.kind === right.kind && left.id === right.id;

export function createAssetSourceAvailability(userId: string): AssetSourceAvailability {
  const reads = new Map<string, Promise<boolean>>();
  const candidates = new Map<string, Promise<RecallCandidateRecord | undefined>>();
  const captures = new Map<string, ReturnType<typeof readRecallJsonRecord>>();
  const proofs = new Map<string, Promise<boolean>>();
  const conversations = new Map<string, Promise<Map<string, CognitionSourceLocator>>>();
  const located = (ref: CognitionSourceRef) => {
    const key = JSON.stringify([ref.kind, ref.id, ref.sourceVersion, ref.locator]);
    if (!reads.has(key)) reads.set(key, readLocatedSource(userId, ref).then(result => result.state === 'available'));
    return reads.get(key)!;
  };
  const candidate = (id: string) => {
    if (!candidates.has(id)) candidates.set(id, readRecallCandidate(userId, id).catch(() => undefined));
    return candidates.get(id)!;
  };
  const proof = (row: RecallCandidateRecord) => {
    if (!proofs.has(row.id)) proofs.set(row.id, verifyCandidateFormationForCommittedRead(userId, row)
      .then(() => true, () => false));
    return proofs.get(row.id)!;
  };
  const conversationLocators = (cid: string) => {
    if (!conversations.has(cid)) conversations.set(cid, (async () => {
      const refs = new Map<string, CognitionSourceLocator>();
      let cursor: number | null | undefined;
      do {
        const page = await getMessagesPage(userId, cid, 100, cursor);
        for (const row of page.history) if (!row.deleted_at)
          refs.set(cognitionMessageSourceId(cid, row.id), { conversationId: cid, messageId: row.id });
        cursor = page.nextCursor;
      } while (cursor !== null);
      return refs;
    })());
    return conversations.get(cid)!;
  };
  const messageAvailable = async (asset: AssetSourceDependencies, ref: CognitionSourceRef) => {
    if (ref.locator && contentVersion(ref)) return located(ref);
    // Old timestamps are not content versions. The original formation proof
    // binds the frozen source text; it may supply missing message coordinates.
    for (const id of new Set([asset.candidateId, ...(asset.sourceCandidateIds || [])])) {
      if (!id) continue;
      const row = await candidate(id);
      if (!row || row.status !== 'confirmed' || row.promotedAssetId !== asset.id
        || ![...row.sourceRefs, ...row.evidenceRefs].some(source => sameSource(source, ref))) continue;
      const human = row.humanInstructionProvenance;
      let locator: CognitionSourceLocator | undefined;
      if (human && ref.id === cognitionMessageSourceId(human.cid, human.sourceMessageId))
        locator = { conversationId: human.cid, messageId: human.sourceMessageId };
      const capture = row.captureProvenance;
      if (!locator && capture) {
        if (!captures.has(capture.captureId)) captures.set(capture.captureId, readRecallJsonRecord(userId, 'captures', capture.captureId));
        const stored = await captures.get(capture.captureId);
        if (stored && typeof stored.conversationId === 'string') {
          const messageId = [...capture.messageIds, ...((stored.contextMessageIds as string[] | undefined) || [])]
            .find(id => cognitionMessageSourceId(String(stored.conversationId), id) === ref.id);
          if (messageId) locator = { conversationId: stored.conversationId, messageId };
        }
      }
      if (locator) {
        if (contentVersion(ref)) return located({ ...ref, locator });
        if (await proof(row)) return true;
      }
      // A current candidate may retain a versioned reference from an earlier
      // formation without making all of that earlier version a dependency.
      const versioned = [...row.evidenceRefs, ...row.sourceRefs].find(source => sameSource(source, ref)
        && source.locator && contentVersion(source) && source.sourceVersion === ref.sourceVersion);
      if (versioned && await located(versioned)) return true;
    }
    if (contentVersion(ref)) {
      const sessions = new Set([...(asset.sourceSessionIds || []), ...asset.evidenceRefs
        .filter(source => source.kind === 'conversation' && source.subtype === 'session').map(source => source.id)]);
      for (const cid of sessions) {
        const locator = (await conversationLocators(cid)).get(ref.id);
        if (locator) return located({ ...ref, locator });
      }
    }
    // No matching saved content version or formation proof: keep the asset
    // manageable, but do not infer task permission from an excerpt or switch.
    return false;
  };
  return async asset => {
    try {
      for (const ref of asset.evidenceRefs) {
        if (ref.taxonomyVersion !== 2) continue; // Preserve legacy source contracts.
        if (ref.degraded || !await isCognitionSourceEnabled(userId, ref)) return false;
        if (ref.kind === 'conversation' && ref.subtype === 'message') {
          if (!await messageAvailable(asset, ref)) return false;
        } else if (ref.locator && !await located(ref)) return false;
      }
      return true;
    } catch { return false; }
  };
}
