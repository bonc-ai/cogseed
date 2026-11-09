/** Private consultation workflow. Host scope + dispatch receipt bind the peer;
 * model arguments never choose an account or conversation. Persist before every
 * external effect: the Hub currently ignores requestId, so interrupted/ambiguous
 * sends are quarantined, never automatically replayed. Polling recovers pending
 * nudges and prepared final replies using their original creation time. */
import { createHash } from 'node:crypto';
import { safeId } from '../../storage';
import { userA2AConsultationsFile } from '../../paths';
import { fileEditLock } from '../../util/locks';
import { createLogger } from '../../logger';
import { getConversation, updateConversationAtomic } from '../chats';
import { getCachedContact } from '../contacts/store';
import { currentHubIdentity, isHubIdentityCurrent } from '../hub_account/transport';
import { getActiveUserId } from '../users';
import { parseA2AConversationMarker } from './conversation-marker';
import { isReceptionRun, type TrustedReceptionScope } from './reception-scope';
import { validateReceptionWorkspaceGrant } from './reception-service';
import { readReceptionLedger, updateReceptionEntry, validReceptionPayload, type ReceptionLedgerEntry } from './reception-ledger';
import { receptionPendingReplyText } from './reception-nudge';
import { sendRelayMessageDetailed } from './relay-client';
import { createConsultation, listConsultations, needsNudge, updateConsultation, type A2AConsultationDecision, type A2AConsultationRecord, type ConsultationCreationError, type ConsultationDelivery } from './consultations';
const log = createLogger('a2a-consultations');
type Notice = {
    userId: string;
    conversationId: string;
};
const listeners = new Set<(notice: Notice) => void>();
// Fail closed for the live turn even when the durable marker write fails.
// A process exit before that write leaves dispatch uncertainty, never a replay.
const unpersistedAttempts = new Set<string>();
function attemptKey(userId: string, cid: string, messageId: string): string {
    return JSON.stringify([userId, cid, messageId]);
}
export function onConsultationChanged(listener: (notice: Notice) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
function changed(userId: string, conversationId: string): void {
    for (const listener of listeners) {
        try {
            listener({ userId, conversationId });
        }
        catch { /* observer cannot undo persistence */ }
    }
}
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
function scopeError(): never { return fail('E_CONSULTATION_SCOPE', 'The reception identity, contact or workspace is no longer available.'); }
function guard(userId: string) {
    const identity = currentHubIdentity(userId);
    return () => {
        try {
            return !!identity && getActiveUserId() === userId && isHubIdentityCurrent(userId, identity);
        }
        catch {
            return false;
        } // The relay may tick before user activation.
    };
}
function lock(userId: string, id: string) {
    if (!safeId(userId))
        scopeError();
    return fileEditLock(`${userA2AConsultationsFile(userId)}:delivery:${id}`);
}
function peerActor(account: string): string {
    return 'a2a_' + (account.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'peer');
}
function dispatchId(messageId: string): string {
    return 'turn-a2a-in-' + createHash('sha256').update(messageId, 'utf8').digest('hex').slice(0, 20);
}
function validPrivateText(value: unknown): value is string {
    return typeof value === 'string' && !!value.trim() && value.trim().length <= 4000;
}
/** Build only from a host-owned LOCAL intent. A missing/invalid draft is an
 * explicit owner-revisable failure, never permission to invent a public reply. */
function creationInput(entry: ReceptionLedgerEntry, workspace: string, peerName?: string) {
    const intent = entry.consultationIntent;
    if (intent && intent.workspace !== workspace)
        scopeError();
    const creationError: ConsultationCreationError | undefined = !intent ? 'INTENT_UNAVAILABLE'
        : intent.creationError || !validPrivateText(intent.question) || !validPrivateText(intent.proposedReply) ? 'INVALID_INPUT' : undefined;
    const createdAt = intent?.createdAt ?? entry.at;
    if (!Number.isFinite(Date.parse(createdAt)))
        scopeError();
    return {
        conversationId: entry.conversationId, peerUserId: entry.peerUserId, peerName,
        question: intent && validPrivateText(intent.question) ? intent.question.trim() : entry.text,
        proposedReply: creationError ? '' : intent!.proposedReply.trim(),
        ...(creationError ? { creationError } : {}), createdAt,
        sourceMessageId: entry.messageId, turnId: dispatchId(entry.messageId),
        toAccount: entry.toAccount, generation: entry.generation, workspace,
    };
}
export async function requestConsultation(userId: string, input: {
    scope: TrustedReceptionScope;
    turnId?: string;
    question: string;
    proposedReply: string;
}): Promise<A2AConsultationRecord> {
    const { scope } = input;
    if (!scope || !safeId(scope.conversationId) || !input.turnId)
        scopeError();
    const isCurrent = guard(userId);
    if (!isCurrent())
        scopeError();
    let result: A2AConsultationRecord | undefined;
    let created = false;
    await updateConversationAtomic(userId, scope.conversationId, async (current) => {
        const marker = parseA2AConversationMarker(current.a2a);
        if (!marker || !isReceptionRun(marker) || marker.exchange_id !== scope.conversationId
            || peerActor(marker.peer_user_id) !== scope.sourceActorId
            || validateReceptionWorkspaceGrant(marker.workspace) !== scope.root
            || !scope.root || !await getCachedContact(userId, marker.peer_user_id))
            scopeError();
        const entries = (await readReceptionLedger(userId)).filter(entry => entry.conversationId === scope.conversationId
            && dispatchId(entry.messageId) === input.turnId);
        const entry = entries[0];
        if (entries.length !== 1 || !validReceptionPayload(entry) || entry.admission !== 'committed'
            || entry.status !== 'running' || !['dispatching', 'enqueued'].includes(entry.stage)
            || entry.peerUserId !== marker.peer_user_id || entry.toAccount !== currentHubIdentity(userId)?.accountId
            || entry.generation !== current._cogseed_result_generation || !isCurrent())
            scopeError();
        const key = attemptKey(userId, scope.conversationId, entry.messageId);
        unpersistedAttempts.add(key);
        const valid = validPrivateText(input.question) && validPrivateText(input.proposedReply);
        const marked = await updateReceptionEntry(userId, entry, row => ({ ...row, consultationRequested: true,
            consultationIntent: row.consultationIntent ?? {
                createdAt: new Date().toISOString(), workspace: scope.root,
                question: validPrivateText(input.question) ? input.question.trim() : entry.text,
                proposedReply: valid ? input.proposedReply.trim() : '',
                ...(!valid ? { creationError: 'INVALID_INPUT' as const } : {}),
            },
        }), isCurrent);
        if (!marked)
            scopeError();
        unpersistedAttempts.delete(key);
        const previous = await consultationForReception(userId, scope.conversationId, entry.messageId);
        if (previous) {
            result = previous;
            return null;
        }
        result = await createConsultation(userId, creationInput(marked, scope.root, marker.peer_name));
        created = true;
        return null;
    });
    if (!result)
        scopeError();
    if (created)
        changed(userId, result.conversationId);
    if (result.creationError)
        fail('E_CONSULTATION_INPUT', 'The private request needs owner-supplied wording.');
    return result;
}
/** Owner-facing IPC compatibility entry. Resolve the active host dispatch;
 * caller-supplied peer identity is deliberately not accepted. */
export async function requestConsultationForConversation(userId: string, input: {
    conversationId: string;
    question: string;
    proposedReply: string;
}): Promise<A2AConsultationRecord> {
    if (!safeId(input.conversationId))
        scopeError();
    const current = await getConversation(userId, input.conversationId);
    const marker = parseA2AConversationMarker(current?.a2a);
    if (!marker || !isReceptionRun(marker))
        scopeError();
    const entries = (await readReceptionLedger(userId)).filter(entry => entry.conversationId === input.conversationId
        && entry.status === 'running' && ['dispatching', 'enqueued'].includes(entry.stage)
        && entry.generation === current?._cogseed_result_generation);
    if (entries.length !== 1)
        scopeError();
    return requestConsultation(userId, {
        scope: { conversationId: input.conversationId, sourceActorId: peerActor(marker.peer_user_id), root: marker.workspace || '' },
        turnId: dispatchId(entries[0].messageId), question: input.question, proposedReply: input.proposedReply,
    });
}
/** Exact incoming-message binding also suppresses a late model final after an
 * owner has already answered: state is deliberately not part of this lookup. */
export async function consultationForReception(userId: string, conversationId: string, sourceMessageId: string) {
    return (await listConsultations(userId, { conversationId })).find(row => row.sourceMessageId === sourceMessageId);
}
/** Privacy fence also covers a failed private-request write with no UI row. */
export async function hasConsultationRequestForReception(userId: string, conversationId: string, sourceMessageId: string): Promise<boolean> {
    if (unpersistedAttempts.has(attemptKey(userId, conversationId, sourceMessageId)))
        return true;
    const entry = (await readReceptionLedger(userId)).find(row => row.conversationId === conversationId && row.messageId === sourceMessageId);
    if (entry?.consultationRequested || entry?.consultationIntent)
        return true;
    try {
        return !!await consultationForReception(userId, conversationId, sourceMessageId);
    } catch {
        // A valid, unflagged dispatch has not requested consultation: every
        // production request journals the flag before touching the card store.
        // Unknown/malformed dispatches fail closed rather than forwarding text.
        return !entry || !validReceptionPayload(entry);
    }
}
export interface ConsultationDeliveryDeps {
    now?: number;
    afterStage?: (stage: 'prepared' | 'sending' | 'relay' | 'sent') => Promise<void>;
}
function payloadHash(record: A2AConsultationRecord, text: string, requestId: string): string {
    return createHash('sha256').update(JSON.stringify([record.id, record.conversationId, record.peerUserId,
        record.sourceMessageId, record.toAccount, record.generation, record.workspace, text, requestId])).digest('hex');
}
function prepared(record: A2AConsultationRecord, text: string, nudge = false): ConsultationDelivery {
    const requestId = `a2a-consult-${nudge ? 'nudge' : 'reply'}-${record.id}`;
    return { state: 'prepared', requestId, text, payloadHash: payloadHash(record, text, requestId) };
}
async function save(userId: string, id: string, update: (row: A2AConsultationRecord) => A2AConsultationRecord) {
    const row = await updateConsultation(userId, id, update);
    if (!row)
        fail('E_CONSULTATION_NOT_FOUND', 'Consultation not found.');
    changed(userId, row.conversationId);
    return row;
}
type ConsultationBinding = Pick<A2AConsultationRecord, 'conversationId' | 'sourceMessageId' | 'workspace' | 'generation' | 'toAccount' | 'peerUserId' | 'turnId'>;
async function authorized(userId: string, row: ConsultationBinding, current: Awaited<ReturnType<typeof getConversation>>, isCurrent: () => boolean) {
    const marker = parseA2AConversationMarker(current?.a2a);
    if (!isCurrent() || !row.sourceMessageId || !row.workspace || !row.generation
        || row.toAccount !== currentHubIdentity(userId)?.accountId || !marker || !isReceptionRun(marker)
        || marker.exchange_id !== row.conversationId || marker.peer_user_id !== row.peerUserId
        || current?._cogseed_result_generation !== row.generation
        || validateReceptionWorkspaceGrant(marker.workspace) !== row.workspace
        || !await getCachedContact(userId, row.peerUserId))
        scopeError();
    const entries = (await readReceptionLedger(userId)).filter(entry => entry.messageId === row.sourceMessageId);
    const entry = entries[0];
    if (entries.length !== 1 || !validReceptionPayload(entry) || entry.admission !== 'committed'
        || entry.conversationId !== row.conversationId || entry.peerUserId !== row.peerUserId
        || entry.generation !== row.generation || entry.toAccount !== row.toAccount
        || dispatchId(entry.messageId) !== row.turnId || !isCurrent())
        scopeError();
}
/** Reconcile journal -> owner card under the same conversation queue as live
 * creation. Idempotency uses the original source message; no model redispatch. */
async function recoverCreationIntents(userId: string, isCurrent: () => boolean) {
    for (const snapshot of await readReceptionLedger(userId)) {
        if ((!snapshot.consultationRequested && !snapshot.consultationIntent) || !validReceptionPayload(snapshot)
            || snapshot.toAccount !== currentHubIdentity(userId)?.accountId)
            continue;
        await updateConversationAtomic(userId, snapshot.conversationId, async current => {
            if (!isCurrent()) return null;
            const entry = (await readReceptionLedger(userId)).find(row => row.messageId === snapshot.messageId);
            if (!entry || !validReceptionPayload(entry) || (!entry.consultationRequested && !entry.consultationIntent)) return null;
            if (await consultationForReception(userId, entry.conversationId, entry.messageId)) return null;
            const marker = parseA2AConversationMarker(current.a2a);
            const workspace = validateReceptionWorkspaceGrant(marker?.workspace);
            if (!workspace) scopeError();
            const input = creationInput(entry, workspace, marker?.peer_name);
            await authorized(userId, input, current, isCurrent);
            const row = await createConsultation(userId, input);
            changed(userId, row.conversationId);
            return null;
        }).catch(() => {
            log.warn('consultation creation recovery deferred', { code: 'E_CONSULTATION_CREATION_RECOVERY' });
        });
    }
}
const DEFINITE_REJECTION = new Set(['INVALID_MESSAGE', 'HUB_NOT_CONFIGURED', 'HUB_AUTH_REQUIRED', 'NOT_CONTACT', 'QUESTIONS_DISABLED',
    'CONTACT_NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED', 'INVALID_REQUEST', 'HUB_400', 'HUB_401', 'HUB_403', 'HUB_404', 'HUB_422', 'HUB_429']);
const NUDGE_MAX_ATTEMPTS = 3;
const NUDGE_RETRY_MS = 60_000;
/** Caller owns the per-consultation lock. Contact/conversation mutations share
 * the canonical conversation queue, so validation and the send stay together. */
async function deliver(userId: string, row: A2AConsultationRecord, nudge: boolean, deps: ConsultationDeliveryDeps) {
    const field = nudge ? 'nudgeDelivery' : 'delivery';
    let receipt = row[field]!;
    if (receipt.state === 'sent')
        return row;
    if (receipt.state === 'sending' || receipt.state === 'uncertain') {
        if (receipt.state === 'sending')
            row = await save(userId, row.id, current => ({ ...current, [field]: { ...receipt, state: 'uncertain', error: 'ACKNOWLEDGEMENT_UNKNOWN' } }));
        fail('E_CONSULTATION_DELIVERY_UNCERTAIN', 'Delivery may have occurred. It will not be sent again automatically.');
    }
    const expected = prepared(row, receipt.text, nudge);
    if (receipt.requestId !== expected.requestId || receipt.payloadHash !== expected.payloadHash
        || !receipt.text || receipt.text.length > 4000 || (!nudge && receipt.text !== row.finalReply)) {
        fail('E_CONSULTATION_DELIVERY_UNCERTAIN', 'Invalid delivery receipt; preserved for inspection.');
    }
    const isCurrent = guard(userId);
    if (!isCurrent())
        scopeError();
    let result: A2AConsultationRecord | undefined;
    let failure: string | undefined;
    await updateConversationAtomic(userId, row.conversationId, async (current) => {
        await authorized(userId, row, current, isCurrent);
        receipt = { ...receipt, state: 'sending', ...(nudge ? {
            attempts: (receipt.attempts ?? 0) + 1,
            lastAttemptAt: new Date(deps.now ?? Date.now()).toISOString(), nextAttemptAt: undefined,
        } : {}) };
        row = await save(userId, row.id, record => ({ ...record, [field]: receipt }));
        await deps.afterStage?.('sending');
        if (!isCurrent())
            scopeError();
        const sent = await sendRelayMessageDetailed(userId, { to: row.peerUserId, conversationId: row.conversationId, kind: 'answer', text: receipt.text, requestId: receipt.requestId, isCurrent })
            .catch(() => ({ ok: false as const, code: 'HUB_UNREACHABLE' }));
        await deps.afterStage?.('relay');
        // Persist an acknowledged effect even if login changed while awaiting it.
        if (sent.ok === true) {
            result = await save(userId, row.id, record => ({ ...record, [field]: { ...receipt, state: 'sent', relayMessageId: sent.messageId },
                ...(nudge ? { nudgedAt: new Date(deps.now ?? Date.now()).toISOString() } : {}) }));
        }
        else {
            const code = sent.code;
            const state = DEFINITE_REJECTION.has(code) ? 'failed' : 'uncertain';
            const nextAttemptAt = nudge && state === 'failed' && receipt.attempts! < NUDGE_MAX_ATTEMPTS
                ? new Date((deps.now ?? Date.now()) + NUDGE_RETRY_MS * 2 ** (receipt.attempts! - 1)).toISOString() : undefined;
            result = await save(userId, row.id, record => ({
                ...record, [field]: { ...receipt, state, error: code, ...(nudge ? { nextAttemptAt } : {}) },
            }));
            failure = state === 'failed' ? 'E_CONSULTATION_DELIVERY_FAILED' : 'E_CONSULTATION_DELIVERY_UNCERTAIN';
        }
        return null;
    });
    if (!result)
        scopeError();
    if (failure)
        fail(failure, failure === 'E_CONSULTATION_DELIVERY_FAILED'
            ? 'Reply was not delivered. Retry the same decision.' : 'Delivery may have occurred. Do not resend.');
    await deps.afterStage?.('sent');
    return result;
}
export async function answerAndDeliverConsultation(userId: string, id: string, decision: A2AConsultationDecision, text?: string, deps: ConsultationDeliveryDeps = {}) {
    if (!['approve', 'revise', 'decline'].includes(decision))
        fail('E_CONSULTATION_DECISION', 'Invalid consultation decision.');
    const revised = typeof text === 'string' ? text.trim() : '';
    if (decision === 'revise' && (!revised || revised.length > 4000))
        fail('E_CONSULTATION_DECISION', 'Revise requires the new wording (at most 4000 characters).');
    return lock(userId, id).runExclusive(async () => {
        let row = (await listConsultations(userId)).find(record => record.id === id);
        if (!row)
            fail('E_CONSULTATION_NOT_FOUND', 'Consultation not found.');
        if (decision === 'approve' && (row.creationError || !validPrivateText(row.proposedReply)))
            fail('E_CONSULTATION_DECISION', 'This request needs revised wording or refusal.');
        const state = decision === 'approve' ? 'approved' : decision === 'revise' ? 'revised' : 'declined';
        if (row.state !== 'pending' && (row.state !== state || (decision === 'revise' && row.finalReply !== revised))) {
            fail('E_CONSULTATION_DECISION', 'Consultation already has a different decision.');
        }
        if (row.state === 'pending') {
            const isCurrent = guard(userId);
            await authorized(userId, row, await getConversation(userId, row.conversationId), isCurrent);
            row = await save(userId, id, current => {
                const next: A2AConsultationRecord = { ...current, state, answeredAt: new Date().toISOString(),
                    ...(decision !== 'decline' ? { finalReply: decision === 'revise' ? revised : current.proposedReply } : {}) };
                return decision === 'decline' ? next : { ...next, delivery: prepared(next, next.finalReply!) };
            });
            await deps.afterStage?.('prepared');
        }
        if (decision === 'decline')
            return row;
        if (!row.delivery)
            fail('E_CONSULTATION_DELIVERY_UNCERTAIN', 'Missing delivery receipt; preserved for inspection.');
        return deliver(userId, row, false, deps);
    });
}
/** Called by the existing relay poll, including its initial boot tick. Final
 * failures require explicit retry. Definite nudge rejections get at most three
 * attempts with 1/2-minute backoff. Sending/uncertain effects never replay. */
export async function recoverConsultations(userId: string, deps: ConsultationDeliveryDeps = {}): Promise<void> {
    const isCurrent = guard(userId);
    if (!isCurrent())
        return;
    await recoverCreationIntents(userId, isCurrent);
    for (const snapshot of await listConsultations(userId)) {
        await lock(userId, snapshot.id).runExclusive(async () => {
            let row = (await listConsultations(userId)).find(record => record.id === snapshot.id);
            if (!row || !row.sourceMessageId)
                return;
            if (row.delivery && ['prepared', 'sending'].includes(row.delivery.state)) {
                await deliver(userId, row, false, deps);
                return;
            }
            if (row.nudgeDelivery?.state === 'sending') {
                await deliver(userId, row, true, deps);
                return;
            }
            if (row.state !== 'pending' || row.nudgedAt || !needsNudge(row, deps.now))
                return;
            if (!row.nudgeDelivery)
                row = await save(userId, row.id, current => ({ ...current, nudgeDelivery: prepared(current, receptionPendingReplyText(), true) }));
            if (row.nudgeDelivery?.state === 'failed' && DEFINITE_REJECTION.has(row.nudgeDelivery.error ?? '')) {
                const receipt = row.nudgeDelivery;
                const attempts = receipt.attempts ?? 1; // Legacy failed receipt already attempted once.
                if (!Number.isInteger(attempts) || attempts < 1 || attempts >= NUDGE_MAX_ATTEMPTS) return;
                if (receipt.nextAttemptAt === undefined) {
                    // Upgrade legacy failures conservatively: persist a delay,
                    // never reinterpret a failed send as a fresh immediate POST.
                    await save(userId, row.id, current => ({ ...current, nudgeDelivery: { ...receipt, attempts,
                        nextAttemptAt: new Date((deps.now ?? Date.now()) + NUDGE_RETRY_MS * 2 ** (attempts - 1)).toISOString() } }));
                    return;
                }
                const retryAt = Date.parse(receipt.nextAttemptAt);
                if (Number.isFinite(retryAt) && (deps.now ?? Date.now()) >= retryAt)
                    await deliver(userId, row, true, deps);
                return;
            }
            if (row.nudgeDelivery?.state === 'prepared')
                await deliver(userId, row, true, deps);
        }).catch(error => {
            // Do not log the exception text: storage/transport errors may carry private payloads.
            log.warn('consultation recovery deferred', { code: typeof error?.code === 'string' ? error.code : 'E_CONSULTATION_RECOVERY' });
        });
    }
}
