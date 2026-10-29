/** Test fixtures for the real nightly formation boundary. Callers own a temporary
 * workspace. Synthetic user evidence is explicitly labeled and is additional to
 * the input references; it never pretends that an empty/legacy ref was evidence.
 * No production gate is mocked or switched off. */
import { createHash } from 'node:crypto';
import type { SaveRecallCandidateInput, RecallCandidateRecord } from '../../src/main/features/recall/candidate-service';
import type { CaptureContextSummary } from '../../src/main/features/recall/capture-context-summary';

export async function prepareNightlyCandidateInput(userId: string, input: SaveRecallCandidateInput): Promise<SaveRecallCandidateInput> {
  if (input.manual === true) throw new Error('manual input is not a nightly formation fixture');
  // This helper writes synthetic chats, captures, candidates and assets through
  // production storage paths. Refuse a non-temporary workspace so fixtures
  // cannot be materialized in a user's real data directory.
  const { realpath } = await import('node:fs/promises');
  const workspaceRoot = String(process.env.COGSEED_WORKSPACE_ROOT || '');
  const resolved = await realpath(workspaceRoot).catch(() => workspaceRoot);
  const tmpRoot = await realpath(await import('node:os').then((os) => os.tmpdir())).catch(() => '');
  if (!resolved.startsWith(tmpRoot)) {
    throw new Error(`nightly formation fixture refuses a non-temporary workspace: ${workspaceRoot}`);
  }
  const { normalizeCognitionSourceRefsForWrite } = await import('../../src/main/features/recall/source-service');
  const { captureContextSourceDigest, validateCaptureContextSummary } = await import('../../src/main/features/recall/capture-context-summary');
  const { captureSummaryDecisionDigest } = await import('../../src/main/features/recall/capture-provenance');
  const { cognitionMessageSourceId } = await import('../../src/main/features/recall/source-catalog');
  const { readRecallJsonRecord, writeRecallJsonRecord } = await import('../../src/main/features/recall/store');
  if (input.captureProvenance) {
    const existing = await readRecallJsonRecord(userId, 'captures', input.captureProvenance.captureId);
    if (!existing || existing.ownerId !== userId || existing.executionPolicy !== 'nightly'
      || !['extracting', 'review_ready'].includes(String(existing.status))) {
      throw new Error('explicit fixture proof requires an existing nightly extraction');
    }
    await writeRecallJsonRecord(userId, 'captures', existing.id, { ...existing, status: 'extracting' });
    return input; // The real save validates this proof; do not rewrite it.
  }
  const identity = createHash('sha256').update(JSON.stringify({ userId, captureKey: input.captureKey,
    judgment: input.judgment, value: input.value, type: input.suggestedType, scope: input.suggestedScope,
    action: input.suggestedAction, target: input.targetAssetId, refs: input.sourceRefs, evidence: input.evidenceRefs })).digest('hex').slice(0, 20);
  const captureId = input.captureProvenance?.captureId || `fixture-nightly-${identity}`;
  const conversationId = `fixture-conv-${identity}`;
  const messageId = `fixture-user-${identity}`;
  const quote = 'Synthetic test user evidence: retain reusable source checks and confirm each proposed durable insight.';
  const existing = await readRecallJsonRecord(userId, 'captures', captureId);
  const now = typeof existing?.extractionCompletedAt === 'string' ? existing.extractionCompletedAt : new Date().toISOString();
  const messageAt = new Date(Date.parse(now) - 86_400_000).toISOString();
  const messages = [{ id: messageId, role: 'user', text: quote, discovery: true }];
  const summary: CaptureContextSummary = validateCaptureContextSummary({
    sourceDigest: captureContextSourceDigest(messages), completedAt: now,
    topics: [{ title: 'Synthetic fixture requirement', content: quote, conditions: [], unresolved: [], attribution: 'user_requirement',
      evidence: [{ messageId, quote, role: 'user', start: 0, end: quote.length }] }],
    coverage: { messageCount: 1, sourceChars: quote.length, segmentCount: 1, processedSegmentIds: ['m0:0'], maxInputChars: 4000 },
  }, messages);
  const sourceId = cognitionMessageSourceId(conversationId, messageId);
  const syntheticRefs = [{ kind: 'conversation' as const, subtype: 'session' as const, id: conversationId,
    title: 'Synthetic nightly fixture conversation' }, { kind: 'conversation' as const, subtype: 'message' as const, id: sourceId,
    excerpt: quote, title: 'Synthetic nightly fixture user evidence' }];
  const proof = { pipeline: 'nightly_conversation' as const, captureId, messageIds: [messageId],
    valueJudgment: { eligible: true as const, reason: 'Synthetic fixture evidence for a reusable requirement.',
      evidence: [{ messageId, sourceId, quote }], judgedAt: now, summaryDigest: captureSummaryDecisionDigest(summary) }, extractionCompletedAt: now };
  // Materialize the evidence as ordinary temporary conversation data so source
  // resolution and permission checks can inspect a real source record.
  const { conversationLayout } = await import('../../src/main/util/project-layout');
  const { appendJsonlAtomic, readJsonl, readJson, writeJson } = await import('../../src/main/storage');
  const { fileEditLock } = await import('../../src/main/util/locks');
  const layout = conversationLayout(userId, conversationId, null);
  const conversation = { ownerId: userId, conversation_id: conversationId, title: 'Synthetic nightly fixture conversation',
    kind: 'normal', agent_id: '', skill_id: '', session_id: `group-${conversationId}`, created_at: messageAt, updated_at: messageAt };
  await writeJson(layout.metaFile, conversation);
  // Preserve other fixtures in this user's compact index; no chat mutation,
  // search catalog or runtime side effects are needed to seed old source bytes.
  await fileEditLock(layout.indexFile).runExclusive(async () => {
    const raw = await readJson<any>(layout.indexFile);
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
    if (!rows.some(row => row.conversation_id === conversationId)) {
      const next = [...rows, conversation];
      await writeJson(layout.indexFile, Array.isArray(raw) || !Array.isArray(raw.items) ? next : { ...raw, items: next });
    }
  });
  if (!(await readJsonl<{ id: string }>(layout.messageFile)).some(message => message.id === messageId)) {
    await appendJsonlAtomic(layout.messageFile, { id: messageId, ts: messageAt, from: 'user', to: ['commander'], text: quote });
  }
  await writeRecallJsonRecord(userId, 'captures', captureId, { schemaVersion: 2, ownerId: userId, id: captureId,
    taxonomyVersion: 2, conversationId, terminalRunId: `fixture-run-${identity}`, anchorMessageId: messageId,
    messageIds: [messageId], status: 'extracting', visibility: 'visible', screeningStatus: 'qualified',
    executionPolicy: 'nightly', reviewDay: messageAt.slice(0, 10), attempt: 1,
    candidateIds: Array.isArray(existing?.candidateIds) ? existing.candidateIds : [],
    createdAt: existing?.createdAt || now, updatedAt: now, contextSummary: summary,
    valueJudgment: proof.valueJudgment, extractionCompletedAt: now });
  return { ...input, captureProvenance: proof,
    sourceRefs: normalizeCognitionSourceRefsForWrite([...(input.sourceRefs || []), ...syntheticRefs]),
    evidenceRefs: normalizeCognitionSourceRefsForWrite([...(input.evidenceRefs || input.sourceRefs || []), ...syntheticRefs]) };
}

export async function markFixtureCaptureReady(userId: string, candidate: RecallCandidateRecord): Promise<void> {
  if (!candidate.captureProvenance) throw new Error('fixture candidate must have nightly capture provenance');
  const { updateRecallJsonRecord } = await import('../../src/main/features/recall/store');
  await updateRecallJsonRecord(userId, 'captures', candidate.captureProvenance.captureId, current => {
    if (!current || current.ownerId !== userId) throw new Error('fixture capture not found');
    return { ...current, candidateIds: [...new Set([...(current.candidateIds as string[]), candidate.id])],
      status: 'review_ready', writingCandidateId: undefined, updatedAt: new Date().toISOString() };
  });
}

export async function createNightlyCandidateFixture(userId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  const prepared = await prepareNightlyCandidateInput(userId, input);
  const { saveRecallCandidate } = await import('../../src/main/features/recall/candidate-service');
  const candidate = await saveRecallCandidate(userId, prepared);
  // Dedup / purge-hash suppression may return an older confirmed identity whose
  // capture fields were cleared. Still close out the synthetic capture written
  // for this fixture attempt.
  const captureProvenance = candidate.captureProvenance || prepared.captureProvenance;
  if (!captureProvenance) throw new Error('fixture candidate must have nightly capture provenance');
  await markFixtureCaptureReady(userId, { ...candidate, captureProvenance });
  return candidate;
}
