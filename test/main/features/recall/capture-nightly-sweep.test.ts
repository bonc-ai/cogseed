import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureSummaryModelResponse, captureSummaryModelResponseWithEvidence } from '../../../helpers/capture-summary-model';

const mocks = vi.hoisted(() => ({
  listConversations: vi.fn(), getMessagesPage: vi.fn(), getConversation: vi.fn(),
  isQuiescent: vi.fn(() => true), scheduleBootBackground: vi.fn(),
  buildRunner: vi.fn(), runModel: vi.fn(), runSummary: vi.fn(), saveCandidate: vi.fn(),
  readCandidate: vi.fn(), findCandidateReceipt: vi.fn(), oauthExpired: null as string | null,
}));
vi.mock('../../../../src/main/features/chats', () => ({
  listConversations: mocks.listConversations, getMessagesPage: mocks.getMessagesPage,
  getConversation: mocks.getConversation, getMessages: vi.fn(),
}));
vi.mock('../../../../src/main/features/group_chat/bus', () => ({
  isQuiescent: mocks.isQuiescent, subscribeTaskTerminals: () => () => {}, subscribe: () => () => {},
}));
vi.mock('../../../../src/main/features/auth', () => ({
  listEntriesForUser: async () => ({ entries: [{ provider: 'openai', model: 'first' }, { provider: 'anthropic', model: 'second' }] }),
  hasConfiguredModelForUser: () => ({ configured: true }),
  getConfiguredModelOAuthExpiredMessageForUser: () => null,

  hasConfiguredModel: () => ({ configured: true }), getConfiguredModelOAuthExpiredMessage: () => mocks.oauthExpired,
}));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({ buildRunner: mocks.buildRunner }));
vi.mock('../../../../src/main/features/recall/candidate-service', () => ({
  saveRecallCandidate: mocks.saveCandidate, readRecallCandidate: mocks.readCandidate,
  findCaptureCandidateReceipt: mocks.findCandidateReceipt, readRecallAssetHandoffReceipt: vi.fn(),
  promoteRecallCandidate: vi.fn(), listRecallCandidates: vi.fn(async () => []), supersedeRecallCandidate: vi.fn(),
  isAutoCaptureEligible: (candidate: { status: string }) => candidate.status === 'pending_review',
}));
vi.mock('../../../../src/main/util/boot_init', () => ({
  scheduleBootBackground: mocks.scheduleBootBackground, registerDeferred: () => {},
}));
let tmpDir: string;
let previousRoot: string | undefined;
const USER = 'nightly-user';
const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).toISOString();
const WINDOW = at(12, 3);
const row = (id: string, day = 11, role = 'user', text = 'Always keep decisions traceable.') => ({
  id, ts: at(day), from: role === 'user' ? 'user' : 'commander', to: ['user'], text,
});
const conversation = (cid = 'cid', day = 11) => ({ conversation_id: cid, title: 'Report decisions', kind: 'normal', updated_at: at(day), project_id: 'project-1' });

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(WINDOW));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-cognition-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  mocks.oauthExpired = null;
  mocks.isQuiescent.mockReturnValue(true);
  // Admission fixtures execute captures explicitly below; the fake scheduler has no active work.
  mocks.scheduleBootBackground.mockImplementation(() => ({ cancel: vi.fn(), promise: Promise.resolve() }));
  mocks.listConversations.mockResolvedValue([conversation()]);
  mocks.getConversation.mockResolvedValue(conversation());
  mocks.getMessagesPage.mockResolvedValue({ history: [row('u1'), row('a1', 11, 'assistant')], nextCursor: null });
  mocks.buildRunner.mockImplementation(async (options) => ({ runner: { run: async input => {
    // The runner calls the host dispatch hook before every physical request; the
    // capture budget is reserved there, so the mock must preserve that contract.
    await options.onModelDispatch?.();
    return (options.sessionId.startsWith('memory-summary-') ? mocks.runSummary : mocks.runModel)(input);
  } } }));
  mocks.runSummary.mockReset().mockImplementation(captureSummaryModelResponse);
  mocks.runModel.mockReset();
  mocks.saveCandidate.mockReset();
  mocks.readCandidate.mockReset();
  mocks.findCandidateReceipt.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  (await import('../../../../src/main/features/recall/capture-service')).startRecallCaptureOrchestrator()();
  const events = await import('../../../../src/main/features/recall/store-events');
  events.setCognitionChangeBroadcaster(null); events.resetCognitionChangeStateForTests();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
async function api() {
  const capture = await import('../../../../src/main/features/recall/capture-service');
  const store = await import('../../../../src/main/features/recall/store');
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  capture.startRecallCaptureOrchestrator();
  return { ...capture, ...store, settings: await settings.readRecallCaptureSettings(USER) };
}
async function records() {
  const paths = await import('../../../../src/main/features/recall/paths');
  const dir = path.dirname(paths.recallJsonRecordPath(USER, 'captures', 'placeholder'));
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : [];
}
const answer = (value: unknown) => ({ text: JSON.stringify(value), meta: {} });
const positive = { eligible: true, reason: 'A durable traceability rule', evidence: [{ messageId: 'u1', quote: 'Always keep decisions traceable.' }] };

async function workerFeedbackFixture() {
  const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
  const record = (await records())[0];
  const observation = { id: 'nf-worker', messageId: 'u1', assetId: 'aa-worker', assetVersion: '1', taskRunId: 'synthetic-turn',
    feedback: 'negative' as const, updatedAt: WINDOW,
    resultSource: { kind: 'group_execution' as const, executionId: 'exec-worker', conversationId: 'cid', actorId: 'worker-1' } };
  const sourceRef = { kind: 'execution_evaluation' as const, taxonomyVersion: 2 as const, subtype: 'execution' as const,
    scope: 'conversation' as const, id: 'exec-worker', sourceVersion: WINDOW };
  const resultContext = { status: 'available' as const, fingerprint: 'worker-result-snapshot', text: 'The delivered report omitted source references.',
    refs: [{ kind: 'execution_output' as const, id: 'exec-worker:output', status: 'readable' as const }],
    coverage: { complete: true, totalFiles: 0, readableFiles: 0 }, sourceRefs: [sourceRef] };
  const context = { ...observation, resultContext, versionContext: { status: 'unavailable' } };
  await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!,
    feedbackRevision: 'f'.repeat(64), feedbackObservations: [observation] }));
  const feedback = await import('../../../../src/main/features/recall/feedback-version-context');
  const read = vi.spyOn(feedback, 'readFeedbackVersionContext').mockResolvedValue([context]);
  const readResult = vi.spyOn(feedback, 'readFeedbackResultContext').mockResolvedValue(resultContext as any);
  const verify = vi.spyOn(feedback, 'assertFeedbackResultContextsCurrent').mockResolvedValue();
  const proposal = { judgment: 'Always keep decisions traceable.', summary: 'Traceable decisions',
    value: 'Future decisions remain auditable.', suggestedType: 'rule', suggestedScope: 'project',
    suggestedAction: 'create', risk: 'low', evidence: ['m1'],
    applicableWhen: ['When recording decisions'], forbiddenWhen: ['Without original evidence'] };
  mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [proposal] }));
  mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'worker-candidate', status: 'pending_review' }));
  return { capture, record, observation, sourceRef, resultContext, context, read, readResult, verify,
    restore: () => { read.mockRestore(); readResult.mockRestore(); verify.mockRestore(); } };
}

describe('the sole nightly cognition pipeline', () => {
  it('keeps the active window after settings change during a sweep', async () => {
    const capture = await api();
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    mocks.scheduleBootBackground.mockImplementation((_label, callback) => ({ cancel: vi.fn(),
      promise: Promise.resolve().then(() => callback(new AbortController().signal)) }));
    mocks.listConversations.mockImplementationOnce(async () => {
      await settings.updateRecallCaptureSettings(USER, { nightlyStart: '22:00', nightlyEnd: '23:00' });
      return [conversation()];
    });
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'No durable value', evidence: [] }));
    const result = await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect(result.ran).toBe(true);
    expect((await records())[0]).toMatchObject({ status: 'no_candidate' });
    expect(mocks.runSummary).toHaveBeenCalled();
    expect((await capture.readRecallNightlySweep(USER))?.windowSnapshot).toMatchObject({
      nightlyStart: capture.settings.nightlyStart, nightlyEnd: capture.settings.nightlyEnd,
    });
  });

  it('records resolved capture failures as partial completion with a retryable item', async () => {
    const capture = await api();
    mocks.scheduleBootBackground.mockImplementation((_label, callback) => ({ cancel: vi.fn(),
      promise: Promise.resolve().then(() => callback(new AbortController().signal)) }));
    mocks.runSummary.mockResolvedValue({ text: 'not json', meta: {} });
    const result = await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect(result).toMatchObject({ ran: true, failed: 1, error: 'scan_task_failed' });
    const sweep = await capture.readRecallNightlySweep(USER);
    expect(sweep).toMatchObject({ phase: 'partial_complete', discovery: { failed: 1 }, receipt: {
      items: [expect.objectContaining({ conversationId: 'cid', status: 'failed', errorCode: expect.any(String) })],
    } });
  });

  it('records a rejected scheduler task against its capture without double counting', async () => {
    const capture = await api();
    mocks.scheduleBootBackground.mockImplementation((label, callback) => ({ cancel: vi.fn(),
      promise: String(label).startsWith('recall:capture:') ? Promise.reject(new Error('synthetic scheduler failure'))
        : Promise.resolve().then(() => callback(new AbortController().signal)) }));
    const result = await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect(result).toMatchObject({ ran: true, failed: 1, error: 'scan_task_failed' });
    expect((await capture.readRecallNightlySweep(USER))?.receipt?.items).toEqual([
      expect.objectContaining({ conversationId: 'cid', status: 'failed', errorCode: 'capture_task_failed' }),
    ]);
  });

  it('holds all seven related assets without saving a partial result or organizing them independently', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const inspection = await import('../../../../src/main/features/recall/asset-inspection-service');
    const stock = await import('../../../../src/main/features/recall/stock-organization');
    const oldStatement = 'Always keep decisions traceable.';
    const newStatement = `${oldStatement} Cite the original evidence.`;
    const old = Array.from({ length: 7 }, (_, index) => ({ id: `overflow-${index}`, ownerId: USER,
      type: index ? 'rule' : 'cognition', version: '1', activeVersion: '1', title: 'Traceability',
      statement: oldStatement, status: 'active', scope: 'project', evidenceRefs: [], updatedAt: at(11) }));
    vi.spyOn(assets, 'listAbilityAssets').mockResolvedValue(old as any);
    const inspect = vi.spyOn(inspection, 'runAssetInspection').mockResolvedValue({ id: 'ir-overflow', ownerId: USER,
      schemaVersion: 1, trigger: 'nightly', scope: { statuses: ['active'] }, findings: [], scanned: 0,
      startedAt: WINDOW, coverage: { total: 7, evaluated: 0, remaining: 7 } } as any);
    const organize = vi.spyOn(stock, 'runStockOrganization').mockResolvedValue({ phase: 'complete', total: 0,
      checked: 0, proposed: 0, saved: 0, remaining: 0, noChange: 0, insufficient: 0, failed: 0, candidateIds: [] });
    mocks.scheduleBootBackground.mockImplementation((_label, callback) => ({ cancel: vi.fn(),
      promise: Promise.resolve().then(() => callback(new AbortController().signal)) }));
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', newStatement), row('a1', 11, 'assistant')], nextCursor: null });
    mocks.runModel.mockResolvedValueOnce(answer({ ...positive, evidence: [{ messageId: 'u1', quote: newStatement }] }))
      .mockResolvedValueOnce(answer({ candidates: [{ judgment: newStatement, summary: 'Traceable decisions',
        value: 'Future decisions remain auditable.', suggestedType: 'rule', suggestedScope: 'project',
        suggestedAction: 'create', risk: 'low', evidence: ['m1'] }] }))
      .mockResolvedValueOnce(answer({ assessments: [{ index: 0, checks: { supported: true, noUnsupportedClaims: true,
        scopePreserved: true, finalDecisionPreserved: true, priorContentPreserved: true,
        evidence: [{ label: 'm1', quote: newStatement }] }, uncertaintyDisposition: 'none',
        comparison: { relation: 'duplicate', reason: 'One related requirement exists.', targetAssetId: old[0].id,
          targetVersion: old[0].version, targetQuote: oldStatement } }] }));
    try {
      expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings))
        .toMatchObject({ ran: true, failed: 1, error: 'scan_task_failed' });
      const sweep = await capture.readRecallNightlySweep(USER);
      const ids = old.map(row => row.id).sort();
      expect(sweep?.receipt?.items).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'related_assets_overflow',
        relatedAssetIds: expect.arrayContaining(ids), candidateIds: [] })]);
      expect(Object.keys(sweep?.claims?.heldAssets || {}).sort()).toEqual(ids);
      expect([...(organize.mock.calls[0][5]!.excludeRefs || [])].sort()).toEqual(ids);
      expect([...(inspect.mock.calls[0][1]!.excludeAssetIds || [])].sort()).toEqual(ids);
      expect(mocks.saveCandidate).not.toHaveBeenCalled();
      // A later retry that now fits must clear only this capture's former hold.
      old.pop();
      mocks.runModel.mockResolvedValueOnce(answer({ assessments: [{ index: 0, checks: { supported: true, noUnsupportedClaims: true,
        scopePreserved: true, finalDecisionPreserved: true, priorContentPreserved: true,
        evidence: [{ label: 'm1', quote: newStatement }] }, uncertaintyDisposition: 'none',
        comparison: { relation: 'duplicate', reason: 'One related requirement exists.', targetAssetId: old[0].id,
          targetVersion: old[0].version, targetQuote: oldStatement } }] }));
      let saved: any;
      mocks.saveCandidate.mockImplementation(async (_user, input) => (saved = { ...input, id: 'overflow-review', status: 'pending_review' }));
      mocks.readCandidate.mockImplementation(async () => saved);
      await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings, undefined,
        { manual: true, reviewDay: capture.nightlyReviewDay(WINDOW) });
      const resumed = await capture.readRecallNightlySweep(USER);
      expect(Object.keys(resumed?.claims?.heldAssets || {})).toEqual([]);
      expect(resumed?.receipt?.items).toEqual([expect.objectContaining({ status: 'completed', candidateIds: ['overflow-review'] })]);
    } finally { inspect.mockRestore(); organize.mockRestore(); }
  });

  it('returns a safe reconciliation failure rather than zero-result success', async () => {
    const capture = await api();
    mocks.listConversations.mockResolvedValue([]);
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const read = vi.spyOn(candidates, 'listRecallCandidates').mockRejectedValueOnce(new Error('private diagnostic details'));
    try {
      const result = await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
      expect(result).toMatchObject({ ran: true, error: 'scan_task_failed', reconcile: { error: 'reconcile_failed' } });
      const sweep = await capture.readRecallNightlySweep(USER);
      expect(sweep?.reconcile).toMatchObject({ error: 'reconcile_failed' });
      expect(JSON.stringify(sweep?.reconcile)).not.toContain('private diagnostic details');
    } finally { read.mockRestore(); }
  });

  it('shows a reused existing suggestion on the round receipt without creating another', async () => {
    const capture = await api();
    mocks.listConversations.mockResolvedValue([]);
    const stock = await import('../../../../src/main/features/recall/stock-organization');
    const inspection = await import('../../../../src/main/features/recall/asset-inspection-service');
    const organize = vi.spyOn(stock, 'runStockOrganization').mockResolvedValue({ phase: 'complete', total: 1,
      checked: 1, proposed: 0, saved: 0, remaining: 0, noChange: 0, insufficient: 0, failed: 0,
      candidateIds: ['cand-existing'], skippedClaimed: 0,
      items: { 'asset-stock-asset': { status: 'skipped', errorCode: 'already_has_suggestion', candidateId: 'cand-existing' } } });
    const inspect = vi.spyOn(inspection, 'runAssetInspection').mockResolvedValue({ id: 'ir-reuse', ownerId: USER,
      schemaVersion: 1, trigger: 'nightly', scope: { statuses: ['active'] }, findings: [], scanned: 0,
      startedAt: WINDOW, currentFindingKeys: [], coverage: { total: 0, evaluated: 0, remaining: 0 } } as any);
    mocks.readCandidate.mockResolvedValue({ id: 'cand-existing', status: 'pending_review' });
    mocks.scheduleBootBackground.mockImplementation((_label, callback) => ({ cancel: vi.fn(),
      promise: Promise.resolve().then(() => callback(new AbortController().signal)) }));
    try {
      expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings)).toMatchObject({ ran: true });
      expect((await capture.readRecallNightlySweep(USER))?.receipt?.candidateIds).toEqual(['cand-existing']);
      expect(mocks.saveCandidate).not.toHaveBeenCalled();
    } finally { organize.mockRestore(); inspect.mockRestore(); }
  });

  it('preserves the inspection baseline change as a retryable failure', async () => {
    const capture = await api();
    mocks.listConversations.mockResolvedValue([]);
    const inspection = await import('../../../../src/main/features/recall/asset-inspection-service');
    const inspect = vi.spyOn(inspection, 'runAssetInspection').mockRejectedValue(
      Object.assign(new Error('synthetic inspection baseline change'), { code: 'inspection_baseline_stale' }));
    try {
      expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings))
        .toMatchObject({ ran: true, error: 'scan_task_failed' });
      expect((await capture.readRecallNightlySweep(USER))?.inspection?.error).toBe('inspection_baseline_stale');
    } finally { inspect.mockRestore(); }
  });

  it('keeps a cancelled scheduler task pending rather than reporting a failure', async () => {
    const capture = await api();
    let admitted!: () => void;
    const admittedTask = new Promise<void>(resolve => { admitted = resolve; });
    mocks.scheduleBootBackground.mockImplementation((label, callback) => {
      if (!String(label).startsWith('recall:capture:')) return { cancel: vi.fn(),
        promise: Promise.resolve().then(() => callback(new AbortController().signal)) };
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((_resolve, rejectTask) => { reject = rejectTask; });
      admitted();
      return { cancel: () => reject(new Error('cancelled')), promise };
    });
    const running = capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    await admittedTask;
    await capture.stopRecallCaptureSweep(USER);
    await running;
    const sweep = await capture.readRecallNightlySweep(USER);
    expect(sweep?.phase).toBe('stopped');
    expect(sweep?.receipt?.items).toEqual([expect.objectContaining({ conversationId: 'cid', status: 'pending' })]);
    expect(sweep?.receipt?.items[0].errorCode).toBeUndefined();
  });

  it('resumes a stopped run with the same receipt and frozen review range', async () => {
    const capture = await api();
    let entered!: () => void, release!: () => void;
    const enteredPage = new Promise<void>(resolve => { entered = resolve; });
    const pageGate = new Promise<void>(resolve => { release = resolve; });
    mocks.getMessagesPage.mockImplementationOnce(async () => {
      entered(); await pageGate;
      return { history: [row('u1'), row('a1', 11, 'assistant')], nextCursor: null };
    });
    const first = capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    await enteredPage;
    await capture.stopRecallCaptureSweep(USER);
    release(); await first;
    const stopped = await capture.readRecallNightlySweep(USER);
    expect(stopped?.phase).toBe('stopped');
    expect(stopped?.receipt?.runId).toBeTruthy();
    vi.setSystemTime(new Date(at(12, 12)));
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    await settings.updateRecallCaptureSettings(USER, { nightlyStart: '22:00', nightlyEnd: '23:00' });
    await capture.runManualCaptureSweep(USER);
    const resumed = await capture.readRecallNightlySweep(USER);
    expect(resumed?.receipt?.runId).toBe(stopped?.receipt?.runId);
    expect(resumed?.reviewWindow).toEqual(stopped?.reviewWindow);
    expect(resumed?.windowSnapshot).toMatchObject({ nightlyStart: capture.settings.nightlyStart, nightlyEnd: capture.settings.nightlyEnd });
    expect((await records()).some(record => record.reviewDay === '2026-10-11')).toBe(true);
  });

  it('does not read a paused first message into nightly analysis', async () => {
    const capture = await api();
    const controls = await import('../../../../src/main/features/recall/source-control');
    const identity = await import('../../../../src/main/features/recall/source-identity');
    await controls.pauseCognitionSource(USER, {
      kind: 'conversation', subtype: 'message', taxonomyVersion: 2, scope: 'conversation',
      id: identity.cognitionMessageSourceId('cid', 'u1'),
      locator: { conversationId: 'cid', messageId: 'u1' },
    });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect(await records()).toHaveLength(0);
    expect(mocks.runSummary).not.toHaveBeenCalled();
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it('stops nightly context at the first paused message and resumes after it is unpaused', async () => {
    const capture = await api();
    const controls = await import('../../../../src/main/features/recall/source-control');
    const identity = await import('../../../../src/main/features/recall/source-identity');
    const ctx = { ...row('ctx', 10, 'user', 'Earlier sealed decision context.'), ts: at(10, 23) };
    const m1 = { ...row('m1', 11, 'user', 'Always keep decisions traceable.'), ts: at(11, 9) };
    const p1 = { ...row('p1', 11, 'user', 'Paused private detail.'), ts: at(11, 10) };
    const m2 = { ...row('m2', 11, 'user', 'After pause content.'), ts: at(11, 11) };
    mocks.getMessagesPage.mockResolvedValue({ history: [ctx, m1, p1, m2], nextCursor: null });
    mocks.runSummary.mockImplementation(input => captureSummaryModelResponseWithEvidence(input, [m1.text]));
    mocks.runModel.mockResolvedValue(answer({ ...positive, evidence: [{ messageId: m1.id, quote: m1.text }] }));
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'paused-candidate', status: 'pending_review' }));
    const pausedSource = {
      kind: 'conversation' as const, subtype: 'message' as const, taxonomyVersion: 2 as const, scope: 'conversation' as const,
      id: identity.cognitionMessageSourceId('cid', p1.id), locator: { conversationId: 'cid', messageId: p1.id },
    };
    await controls.pauseCognitionSource(USER, pausedSource);

    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const [first] = await records();
    expect(first).toMatchObject({ messageIds: [m1.id], contextMessageIds: [ctx.id] });
    await capture.runRecallCapture(USER, first.id);
    const summaryMessages = mocks.runSummary.mock.calls
      .map(call => JSON.parse(call[0].message))
      .filter((request: { stage?: string }) => request.stage === 'chunk')
      .flatMap((request: { segments: Array<{ messageId: string }> }) => request.segments.map(segment => segment.messageId));
    expect(summaryMessages).toEqual([ctx.id, m1.id]);
    expect(JSON.stringify(mocks.runModel.mock.calls)).not.toContain(p1.text);
    expect(JSON.stringify(mocks.runModel.mock.calls)).not.toContain(m2.text);

    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect((await capture.readRecallNightlySweep(USER))?.cursors['2026-10-11:cid']).toMatchObject({
      state: 'deferred', errorCode: 'source_paused', throughMessageId: m1.id,
    });

    await controls.resumeCognitionSource(USER, pausedSource);
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const second = (await records()).find(record => record.id !== first.id)!;
    expect(second).toMatchObject({ messageIds: [p1.id, m2.id], contextMessageIds: [ctx.id, m1.id] });
    expect((await capture.readRecallNightlySweep(USER))?.cursors['2026-10-11:cid']).toMatchObject({ throughMessageId: m2.id });
  });

  it('manual sweep bypasses the nightly window and reviews the due day', async () => {
    vi.setSystemTime(new Date(at(12, 20)));
    const capture = await api();
    const settingsMod = await import('../../../../src/main/features/recall/capture-settings');
    const settings = await settingsMod.readRecallCaptureSettings(USER);
    expect(await capture.runNightlyCaptureSweep(USER, at(12, 3), settings))
      .toMatchObject({ ran: false, reason: 'outside_nightly_window' });
    expect(await capture.runManualCaptureSweep(USER)).toMatchObject({ ran: true, reviewDay: '2026-10-12' });
    expect(await capture.readRecallNightlySweep(USER)).toMatchObject({ reviewWindow: { reviewDay: '2026-10-12' } });
    expect(await records()).toEqual([]);
    vi.setSystemTime(new Date(at(12, 1)));
    expect(await capture.runManualCaptureSweep(USER)).toMatchObject({ ran: true, reviewDay: '2026-10-11' });
    expect((await records()).some(record => record.reviewDay === '2026-10-11')).toBe(true);
    const captureTasks = mocks.scheduleBootBackground.mock.calls.filter(call => String(call[0]).startsWith('recall:capture:'));
    expect(captureTasks.length).toBeGreaterThan(0);
    expect(captureTasks.every(call => (call[3] as { preferIdle?: boolean }).preferIdle === false)).toBe(true);
  });
  it.each(['manual', 'nightly'] as const)('retains covered same-day messages as context for the next %s admission', async secondEntry => {
    const morning = { ...row('morning', 12, 'user', 'Always keep decisions traceable.'), ts: at(12, 10) };
    const afternoon = { ...row('afternoon', 12, 'user', 'That requirement applies only to Project Alpha.'), ts: at(12, 15) };
    vi.setSystemTime(new Date(at(12, 11)));
    const capture = await api();
    mocks.listConversations.mockResolvedValue([conversation('cid', 12)]);
    mocks.getConversation.mockResolvedValue(conversation('cid', 12));
    mocks.getMessagesPage.mockResolvedValue({ history: [morning], nextCursor: null });
    mocks.runSummary.mockImplementation(input => captureSummaryModelResponseWithEvidence(input, [morning.text, afternoon.text]));
    await capture.runManualCaptureSweep(USER);
    const [first] = await records();
    mocks.runModel.mockResolvedValueOnce(answer({ ...positive, evidence: [{ messageId: morning.id, quote: morning.text }] }))
      .mockResolvedValueOnce(answer({ candidates: [{ judgment: morning.text, summary: 'Preserve traceable decisions in future work.',
        value: 'Makes future decisions auditable through their original source.', suggestedType: 'rule',
        suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'] }] }));
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'morning-candidate', status: 'pending_review' }));
    const before = await capture.runRecallCapture(USER, first.id);
    expect(before.status).toBe('review_ready');

    vi.setSystemTime(new Date(secondEntry === 'manual' ? at(12, 16) : at(13, 3)));
    mocks.getMessagesPage.mockResolvedValue({ history: [morning, afternoon], nextCursor: null });
    const sweep = () => secondEntry === 'manual' ? capture.runManualCaptureSweep(USER)
      : capture.runNightlyCaptureSweep(USER, at(13, 3), capture.settings);
    await sweep();
    const second = (await records()).find(record => record.id !== first.id)!;
    expect(second).toMatchObject({ messageIds: [afternoon.id], contextMessageIds: [morning.id] });
    mocks.runModel.mockResolvedValueOnce(answer({ eligible: true, reason: 'A scope correction for future decisions',
      evidence: [{ messageId: afternoon.id, quote: afternoon.text }] })).mockResolvedValueOnce(answer({ candidates: [] }));
    expect((await capture.runRecallCapture(USER, second.id)).status).toBe('no_candidate');
    const summaryInput = JSON.parse(mocks.runSummary.mock.calls.at(-1)![0].message);
    expect(summaryInput.segments).toEqual([
      expect.objectContaining({ messageId: morning.id, text: morning.text, discovery: false }),
      expect.objectContaining({ messageId: afternoon.id, text: afternoon.text, discovery: true }),
    ]);
    const extractionInput = JSON.parse(mocks.runModel.mock.calls.at(-1)![0].message);
    expect(extractionInput.messages.map((message: any) => [message.id, message.discovery])).toEqual([
      [morning.id, false], [afternoon.id, true],
    ]);
    expect(await capture.readRecallCapture(USER, first.id)).toEqual(before);
    expect(mocks.saveCandidate).toHaveBeenCalledTimes(1);
    mocks.runModel.mockClear(); mocks.runSummary.mockClear();
    await sweep();
    expect(await records()).toHaveLength(2);
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(mocks.runSummary).not.toHaveBeenCalled();
  });
  it('preserves source order when a late new message precedes covered same-day context', async () => {
    vi.setSystemTime(new Date(at(12, 16)));
    const capture = await api();
    const first = { ...row('covered', 12), ts: at(12, 15) };
    mocks.listConversations.mockResolvedValue([conversation('cid', 12)]);
    mocks.getMessagesPage.mockResolvedValue({ history: [first], nextCursor: null });
    await capture.runManualCaptureSweep(USER);
    const [covered] = await records();
    await capture.updateRecallJsonRecord(USER, 'captures', covered.id, current => ({ ...current!, status: 'no_candidate' }));
    // A late-arriving earlier message is not consumed by an old cursor.
    await capture.updateRecallJsonRecord(USER, 'capture-sweep', 'nightly', current => ({ ...current!, cursors: {} }));
    const late = { ...row('late', 12, 'user', 'For later reports, preserve the original decision source.'), ts: at(12, 14) };
    mocks.getMessagesPage.mockResolvedValue({ history: [late, first], nextCursor: null });
    await capture.runManualCaptureSweep(USER);
    const admitted = (await records()).find(record => record.id !== covered.id)!;
    expect(admitted).toMatchObject({ messageIds: [late.id], contextMessageIds: [first.id] });
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'No new understanding', evidence: [] }));
    await capture.runRecallCapture(USER, admitted.id);
    const input = JSON.parse(mocks.runSummary.mock.calls[0][0].message);
    expect(input.segments.map((segment: any) => [segment.messageId, segment.discovery])).toEqual([
      [late.id, true], [first.id, false],
    ]);
  });
  it('uses the same explicit model sequence in summary, judgment and extraction despite an unrelated expired OAuth account', async () => {
    const capture = await api();
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    const routes = [{ provider: 'openai', model: 'first' }, { provider: 'anthropic', model: 'second' }];
    await settings.updateRecallCaptureSettings(USER, { modelCandidates: routes });
    mocks.oauthExpired = 'unrelated account expired';
    const attempts: string[] = [];
    mocks.buildRunner.mockImplementation(async params => ({ runner: { run: async input => {
      const stage = params.sessionId.split('-')[1];
      const route = params.modelCandidates[0];
      attempts.push(`${stage}:${route.model}`);
      if (route.model === 'first') return { text: 'partial', meta: { error: { kind: 'provider_error', message: '503 service unavailable' } } };
      params.onCandidateChosen({ providerId: route.provider, modelId: route.model });
      return stage === 'summary' ? captureSummaryModelResponse(input) : answer(stage === 'value' ? positive : { candidates: [] });
    } } }));
    await capture.runNightlyCaptureSweep(USER, WINDOW, await settings.readRecallCaptureSettings(USER));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result.status).toBe('no_candidate');
    expect(attempts).toEqual(['summary:first', 'summary:second', 'value:first', 'value:second', 'extract:first', 'extract:second']);
    expect(result.modelUsage).toMatchObject(routes[1]);
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });
  it('processes a manually admitted capture in daytime without admitting ordinary nightly captures', async () => {
    vi.setSystemTime(new Date(at(12, 1)));
    const capture = await api();
    await capture.runManualCaptureSweep(USER);
    const [manual] = await records();
    expect(manual.terminalRunId).toContain('-manual-');
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [] }));
    expect((await capture.runRecallCapture(USER, manual.id)).status).toBe('no_candidate');
    expect(mocks.runSummary).toHaveBeenCalled();
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    await capture.updateRecallJsonRecord(USER, 'captures', 'ordinary-night', raw => ({ ...manual, id: 'ordinary-night',
      terminalRunId: 'nightly-sweep-ordinary', status: 'queued' }));
    expect((await capture.runRecallCapture(USER, 'ordinary-night')).status).toBe('queued');
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
  });
  it('uses only the system first model in summary and judgment despite an unrelated expired OAuth account', async () => {
    const capture = await api();
    mocks.oauthExpired = 'unrelated account expired';
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'No durable value', evidence: [] }));
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect((await capture.runRecallCapture(USER, (await records())[0].id)).status).toBe('no_candidate');
    expect(mocks.buildRunner).toHaveBeenCalledTimes(2);
    expect(mocks.buildRunner.mock.calls.map(([params]) => params.modelCandidates)).toEqual([
      [{ provider: 'openai', model: 'first' }], [{ provider: 'openai', model: 'first' }],
    ]);
  });
  it('settles an interrupted nightly window for later work instead of recording a model failure', async () => {
    const capture = await api();
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    await settings.updateRecallCaptureSettings(USER, { modelCandidates: [{ provider: 'openai', model: 'first' }, { provider: 'anthropic', model: 'second' }] });
    mocks.runSummary.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(2026, 9, 12, 7));
      return { text: 'partial', meta: { error: { kind: 'provider_error', message: '503 service unavailable' } } };
    });
    await capture.runNightlyCaptureSweep(USER, WINDOW, await settings.readRecallCaptureSettings(USER));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result.status).not.toBe('failed');
    expect(result.errorCode).toBeUndefined();
    expect(mocks.buildRunner).toHaveBeenCalledTimes(1);
  });
  it('freezes the previous complete local natural day and excludes older and current-day messages', async () => {
    const capture = await api();
    mocks.getMessagesPage.mockResolvedValue({ history: [row('old', 10), row('u1'), row('a1', 11, 'assistant'), row('today', 12)], nextCursor: null });
    expect(capture.nightlyReviewDay(WINDOW)).toMatchObject({ key: '2026-10-11', start: new Date(2026, 9, 11), end: new Date(2026, 9, 12) });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect((await records()).map(record => record.messageIds)).toEqual([['u1', 'a1']]);
    expect(mocks.runModel).not.toHaveBeenCalled();
    // Another tick cannot admit the same day/range again.
    expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings)).toMatchObject({ queued: 0 });
    expect(await records()).toHaveLength(1);
  });
  it('does no all-history catch-up and preserves existing processed historical captures', async () => {
    const capture = await api();
    mocks.listConversations.mockResolvedValue([conversation('old', 1)]);
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect(mocks.getMessagesPage).not.toHaveBeenCalled();
    expect(await records()).toHaveLength(0);
  });
  it('bounds admission cursors to the current day while retaining admitted ranges and retry history', async () => {
    const capture = await api();
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const admitted = (await records())[0];
    expect((await capture.readRecallNightlySweep(USER))?.cursors).toHaveProperty('2026-10-11:cid');
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    mocks.listConversations.mockResolvedValue([]);
    await capture.runNightlyCaptureSweep(USER, at(13, 3), capture.settings);
    expect((await capture.readRecallNightlySweep(USER))?.cursors).toEqual({});
    expect(await capture.readRecallCapture(USER, admitted.id)).toMatchObject({ messageIds: ['u1', 'a1'], reviewDay: '2026-10-11', status: 'queued' });
    expect(mocks.getMessagesPage).toHaveBeenCalledTimes(1);
  });
  it('filters trivial conversations locally before queuing a model task', async () => {
    const capture = await api();
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', '谢谢'), row('a1', 11, 'assistant', '不客气')], nextCursor: null });
    const result = await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect(result).toMatchObject({ queued: 0 });
    expect((await records())[0]).toMatchObject({ status: 'no_candidate', visibility: 'internal', screeningStatus: 'filtered' });
    expect(mocks.buildRunner).not.toHaveBeenCalled();
  });
  it('defers active conversations without consuming their progress', async () => {
    const capture = await api(); mocks.isQuiescent.mockReturnValue(false);
    expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings)).toMatchObject({ deferred: 1 });
    expect(await records()).toHaveLength(0);
    mocks.isQuiescent.mockReturnValue(true);
    expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings)).toMatchObject({ queued: 1 });
  });
  it('cancels legacy scheduled captures whose source was removed and leaves active ones untouched', async () => {
    const capture = await api();
    const now = new Date().toISOString();
    const seed = (id: string, conversationId: string) => capture.updateRecallJsonRecord(USER, 'captures', id, () => ({
      schemaVersion: 1, taxonomyVersion: 2, ownerId: USER, id, conversationId,
      terminalRunId: `run-${id}`, anchorMessageId: 'u1', messageIds: ['u1'],
      executionPolicy: 'nightly', status: 'scheduled', attempt: 1, candidateIds: [],
      visibility: 'internal', screeningStatus: 'pending', createdAt: now, updatedAt: now,
    }));
    await seed('legacy-ghost', 'ghost');
    await seed('legacy-live', 'cid');
    expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings)).toMatchObject({ queued: 1 });
    const byId = Object.fromEntries((await records()).map((record) => [record.id, record]));
    expect(byId['legacy-ghost']).toMatchObject({ status: 'cancelled', errorCode: 'source_removed' });
    expect(byId['legacy-live']).toMatchObject({ status: 'scheduled' });
  });
  it('resumes a busy range next night without admitting other historical conversations', async () => {
    let capture = await api();
    mocks.isQuiescent.mockReturnValue(false);
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect((await capture.readRecallNightlySweep(USER))?.pendingRanges).toMatchObject({
      '2026-10-11:cid': { start: new Date(2026, 9, 11).toISOString(), end: new Date(2026, 9, 12).toISOString() },
    });
    capture.startRecallCaptureOrchestrator()();
    vi.resetModules();
    capture = await api();
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    mocks.isQuiescent.mockReturnValue(true);
    mocks.listConversations.mockResolvedValue([conversation('unadmitted', 10)]);
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1'), row('a1', 11, 'assistant'), row('later', 12)], nextCursor: null });
    expect(await capture.runNightlyCaptureSweep(USER, at(13, 3), capture.settings)).toMatchObject({ queued: 1 });
    expect(await records()).toEqual([expect.objectContaining({
      conversationId: 'cid', reviewDay: '2026-10-11', messageIds: ['u1', 'a1'],
      reviewDayStart: new Date(2026, 9, 11).toISOString(), reviewDayEnd: new Date(2026, 9, 12).toISOString(),
    })]);
    expect((await capture.readRecallNightlySweep(USER))?.pendingRanges).toEqual({});
    expect(mocks.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(mocks.buildRunner).not.toHaveBeenCalled();
  });
  it('keeps unreadable admitted ranges across a failed next-night inventory read', async () => {
    const capture = await api();
    mocks.getMessagesPage.mockRejectedValueOnce(new Error('source temporarily unreadable'));
    expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings)).toMatchObject({ deferred: 1 });
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    mocks.listConversations.mockRejectedValueOnce(new Error('inventory unavailable'));
    expect(await capture.runNightlyCaptureSweep(USER, at(13, 3), capture.settings)).toMatchObject({ error: 'sweep_failed' });
    expect((await capture.readRecallNightlySweep(USER))?.pendingRanges).toHaveProperty('2026-10-11:cid');
    mocks.listConversations.mockResolvedValue([]);
    expect(await capture.runNightlyCaptureSweep(USER, at(13, 3), capture.settings)).toMatchObject({ queued: 1 });
    expect((await records())[0].messageIds).toEqual(['u1', 'a1']);
  });
  it('does not admit a range after the sweep is cancelled during its source read', async () => {
    const capture = await api();
    const controller = new AbortController();
    mocks.getMessagesPage.mockImplementationOnce(async () => {
      controller.abort();
      return { history: [row('u1')], nextCursor: null };
    });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings, controller.signal);
    expect(await records()).toHaveLength(0);
    expect((await capture.readRecallNightlySweep(USER))?.pendingRanges).toHaveProperty('2026-10-11:cid');
    expect(mocks.buildRunner).not.toHaveBeenCalled();
  });
  it('uses the persisted absolute window when a resumed window has different local calendar boundaries', async () => {
    const capture = await api();
    const start = at(10, 16), end = at(11, 16);
    await capture.updateRecallJsonRecord(USER, 'capture-sweep', 'nightly', () => ({
      schemaVersion: 1, ownerId: USER, id: 'nightly', baselineAt: start, cursors: {},
      reviewWindow: { reviewDay: '2026-10-11', start, end, ranForWindow: WINDOW },
    }));
    mocks.getMessagesPage.mockResolvedValue({ history: [row('in-frozen-day', 11), row('outside-frozen-day', 11, 'assistant', 'Always use the source.')
      ].map((message, index) => index ? { ...message, ts: at(11, 18) } : message), nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect((await records())[0]).toMatchObject({ messageIds: ['in-frozen-day'], reviewDayStart: start, reviewDayEnd: end });
  });
  it('handles more than 2000 messages by paging only until the day boundary and loses no batch IDs', async () => {
    const capture = await api();
    const all = Array.from({ length: 2050 }, (_, i) => row(`m${i}`, 11, i % 2 ? 'assistant' : 'user'));
    mocks.getMessagesPage.mockImplementation(async (_user, _cid, _limit, before) => before === undefined
      ? { history: all.slice(1800), nextCursor: 1800 }
      : { history: [row('past', 10), ...all.slice(0, 1800)], nextCursor: 100 });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const ids = (await records()).flatMap(record => record.messageIds);
    expect(new Set(ids)).toEqual(new Set(all.map(message => message.id)));
    expect(ids).toHaveLength(all.length);
    expect(mocks.getMessagesPage).toHaveBeenCalledTimes(2);
  });
  it('summarizes context before value judgment; a negative decision never calls asset extraction', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'one-time status', evidence: [] }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result).toMatchObject({ status: 'no_candidate', visibility: 'internal', valueJudgment: { eligible: false } });
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(mocks.buildRunner).toHaveBeenCalledTimes(2);
    expect(mocks.buildRunner.mock.calls[0][0].sessionId).toMatch(/memory-summary/);
    expect(mocks.buildRunner.mock.calls[1][0].sessionId).toMatch(/memory-value/);
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });
  it('makes independent summary/value/extraction calls and persists completed provenance on concrete suggestions', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [{
      judgment: 'Always keep decisions traceable.', summary: 'Preserve traceable decisions in future work.',
      value: 'Makes future decisions auditable through their original source.', suggestedType: 'rule',
      suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'],
      applicableWhen: ['When recording decisions'], forbiddenWhen: ['When no original source is available'],
    }] }));
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'candidate-1', status: 'pending_review' }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result.status).toBe('review_ready');
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    expect(mocks.buildRunner.mock.calls.map(call => call[0].sessionId)).toEqual([
      expect.stringMatching(/memory-summary/), expect.stringMatching(/memory-value/), expect.stringMatching(/memory-extract/),
    ]);
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(result.contextSummary).toMatchObject({ completedAt: expect.any(String), coverage: { messageCount: 2 } });
    const judgmentInput = JSON.parse(mocks.runModel.mock.calls[0][0].message);
    expect(judgmentInput.summary).toEqual(result.contextSummary?.topics);
    expect(judgmentInput.messages).toEqual([expect.objectContaining({ id: 'u1', excerpts: [positive.evidence[0].quote] })]);
    expect(result.extractionCompletedAt).toBeTruthy();
    expect(mocks.saveCandidate.mock.calls[0][1].captureProvenance).toMatchObject({
      pipeline: 'nightly_conversation', captureId: result.id, messageIds: ['u1', 'a1'],
      extractionCompletedAt: result.extractionCompletedAt,
      valueJudgment: { eligible: true, evidence: [{ messageId: 'u1', sourceId: expect.any(String), quote: 'Always keep decisions traceable.' }] },
    });
    expect(result.autoApprovalEpoch).toBeUndefined();
  });
  it('retains extraction proof and group identity when persistence resumes after a partial save', async () => {
    const capture = await api();
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const proposal = { judgment: 'Always keep decisions traceable.', summary: 'Traceable decisions',
      value: 'Future decisions remain auditable.', suggestedType: 'rule', suggestedScope: 'project',
      suggestedAction: 'create', risk: 'low', evidence: ['m1'],
      applicableWhen: ['When recording decisions'], forbiddenWhen: ['Without original evidence'] };
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [proposal] }));
    let saved: any;
    mocks.saveCandidate.mockImplementation(async (_user, input) => {
      saved = { ...input, id: 'first-group', status: 'pending_review' };
      throw new Error('interrupted after candidate commit but before return');
    });
    const failed = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'candidate_save_failed' });
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord(USER, 'captures', failed.id, raw => ({ ...raw!, status: 'queued' }));
    vi.setSystemTime(new Date(at(12, 4)));
    // A provider could return different groups now. Replay must never ask it.
    mocks.runModel.mockResolvedValue(answer({ candidates: [{ ...proposal, judgment: 'A different unsupported regenerated group.' }] }));
    mocks.saveCandidate.mockImplementation(async () => saved);
    const resumed = await capture.runRecallCapture(USER, failed.id);
    expect(resumed).toMatchObject({ status: 'review_ready', candidateIds: ['first-group'],
      extractionCompletedAt: saved.captureProvenance.extractionCompletedAt });
    expect(mocks.saveCandidate.mock.calls[1][1].captureKey).toBe(saved.captureKey);
    expect(mocks.saveCandidate.mock.calls[1][1].captureProvenance).toEqual(saved.captureProvenance);
    expect(mocks.saveCandidate.mock.calls[1][1].judgment).toBe(proposal.judgment);
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    expect(resumed.formationCheckpoint?.groups).toEqual([expect.objectContaining({ savedCandidateId: 'first-group' })]);
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
  });
  it('does not regenerate a prepared batch after its original source changes', async () => {
    const capture = await api();
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const proposal = { judgment: 'Always keep decisions traceable.', summary: 'Traceable decisions',
      value: 'Future decisions remain auditable.', suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'] };
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [proposal] }));
    mocks.saveCandidate.mockRejectedValueOnce(new Error('temporary save failure'));
    const failed = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(failed.formationCheckpoint?.groups).toHaveLength(1);
    await capture.updateRecallJsonRecord(USER, 'captures', failed.id, raw => ({ ...raw!, status: 'queued' }));
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', 'Never keep the earlier rule.'), row('a1', 11, 'assistant')], nextCursor: null });
    expect(await capture.runRecallCapture(USER, failed.id)).toMatchObject({ status: 'failed', errorCode: 'formation_checkpoint_stale' });
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    expect(mocks.saveCandidate).toHaveBeenCalledTimes(1);
  });
  it('marks only an uncommitted legacy R group for source review without rewriting the frozen input or saved group', async () => {
    const capture = await api();
    const bridge = await import('../../../../src/main/features/cognition_bridge');
    const ontology = await import('../../../../src/main/features/cognition/ontology/service');
    await bridge.replaceCognitionSources(USER, { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} },
      po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: WINDOW });
    await ontology.commitOntologyCommand(USER, { commandId: 'checkpoint-seed', expectedRevision: 0,
      actions: [{ intent: 'create', recordId: 'checkpoint-module', sourceLabel: 'Synthetic project baseline',
        record: { kind: 'module', name: 'Checkpoint fixture', description: '', scope: { kind: 'project', id: 'project-1' } } }] });
    const bodies = ['Keep decisions traceable in future project reports.', 'Keep the original evidence in future incident reviews.'];
    const source = bodies.join(' ');
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', source), row('a1', 11, 'assistant', 'Both proposals remain pending review.')], nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const proposals = bodies.map((judgment, index) => ({ judgment, summary: 'Future source checks', value: 'Use original evidence in future project decisions.',
      suggestedType: 'cognition', suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'],
      ontologyChanges: { reason: 'Synthetic explicit user requirement', evidence: ['m1'],
        actions: [{ intent: 'create', recordId: `checkpoint-rule-${index}`, sourceLabel: 'Original user requirement',
          record: { kind: 'rule', moduleId: 'checkpoint-module', name: `Source rule ${index}`, requirementSource: 'cognition_body',
            strength: 'default', condition: null, effect: { kind: 'note' }, exception: '' } }],
        refs: [{ moduleId: 'checkpoint-module', recordId: `checkpoint-rule-${index}`, versionPolicy: 'current', sharedBody: true }] } }));
    mocks.runModel.mockResolvedValueOnce(answer({ eligible: true, reason: 'Two reusable source requirements', evidence: [{ messageId: 'u1', quote: source }] }))
      .mockResolvedValueOnce(answer({ candidates: proposals }))
      .mockResolvedValueOnce(answer({ assessments: proposals.map((_, index) => ({ index,
        checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
          priorContentPreserved: true, evidence: [{ label: 'm1', quote: source }] }, uncertaintyDisposition: 'none',
        sourceRuleConclusions: [{ recordId: `checkpoint-rule-${index}`, status: 'resolved',
          expectedContract: { strength: 'required', condition: null, effect: { kind: 'note' }, exception: '' },
          topicEvidence: [{ label: 'm1', approvedQuoteIndex: 0 }], fieldEvidence: {
            strength: [{ label: 'm1', quote: bodies[index] }], condition: [], effect: [], exception: [] } }] })) }));
    let saved: any;
    mocks.saveCandidate.mockImplementationOnce(async (_user, input) => (saved = { ...input, id: 'checkpoint-saved', status: 'pending_review' }))
      .mockRejectedValueOnce(new Error('second group interrupted'));
    const failed = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'candidate_save_failed' });
    expect(failed.formationCheckpoint!.groups).toHaveLength(2);
    for (const group of failed.formationCheckpoint!.groups) {
      expect(group.ruleSourceAssessment).toMatchObject({ policyVersion: 3, sourceFingerprint: expect.any(String),
        finalInputFingerprint: expect.any(String), resultingContracts: [{ recordId: `checkpoint-rule-${group.index}`, strength: 'required' }] });
      expect(group.input.ontologyFormation!.previewChanges[0].after).toMatchObject({ strength: 'required' });
    }
    const legacy = structuredClone(failed.formationCheckpoint!);
    delete legacy.groups[1].ruleSourceAssessment;
    const originalInputs = structuredClone(legacy.groups.map(group => group.input));
    const savedBefore = structuredClone(saved);
    await capture.updateRecallJsonRecord(USER, 'captures', failed.id, current => ({ ...current!, status: 'queued',
      formationCheckpoint: legacy, formationBatchAssessment: undefined }));
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    vi.mocked(candidates.readRecallCandidate).mockImplementation(async (_user, id) => id === saved.id ? saved : undefined as any);
    mocks.runModel.mockRejectedValue(new Error('checkpoint recovery must not call a model'));
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'checkpoint-resumed', status: 'pending_review' }));
    const resumed = await capture.runRecallCapture(USER, failed.id);
    expect(resumed.status).toBe('review_ready');
    expect(mocks.runModel).toHaveBeenCalledTimes(3); expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(mocks.saveCandidate).toHaveBeenCalledTimes(3); // saved group is never resubmitted
    const submitted = mocks.saveCandidate.mock.calls[2][1];
    expect(submitted.uncertainty).toContain('尚未完成来源优先');
    expect(submitted.ontologyFormation.blockedReasons).toContain('rule_source_assessment_required');
    expect(resumed.formationCheckpoint!.groups.map(group => group.input)).toEqual(originalInputs);
    expect(resumed.formationCheckpoint!.groups[0].savedCandidateId).toBe(saved.id);
    expect(saved).toEqual(savedBefore);
  });
  it('rechecks an uncommitted target on replay and preserves the original version instead of silently rebasing', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const admission = await import('../../../../src/main/features/recall/prompt-injection');
    const target = { id: 'existing-policy', ownerId: USER, title: 'Existing policy', statement: 'An earlier traceability policy.',
      version: '1', activeVersion: '1', status: 'active', type: 'cognition', scope: 'project', evidenceRefs: [] };
    const selection = vi.spyOn(assets, 'listAbilityAssets').mockResolvedValue([target as any]);
    const lookup = vi.spyOn(assets, 'readAbilityAsset').mockResolvedValue(target as any);
    const permitted = vi.spyOn(admission, 'filterRecallAssetsForAgentRead').mockImplementation(async (_user, rows) => rows);
    try {
      await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
      mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [{
        judgment: 'Always keep decisions traceable.', summary: 'Traceable decisions', value: 'Future decisions remain auditable.',
        suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'],
      }] })).mockResolvedValueOnce(answer({ assessments: [{ index: 0,
        checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
          priorContentPreserved: true, evidence: [{ label: 'm1', quote: 'Always keep decisions traceable.' }] },
        uncertaintyDisposition: 'none',
        comparison: { relation: 'evidence', reason: 'Approved support for the same traceability policy.', targetAssetId: target.id,
          targetVersion: '1', targetQuote: target.statement },
        revision: { judgment: 'An earlier traceability policy. Always keep decisions traceable.' },
      }] }));
      mocks.saveCandidate.mockRejectedValueOnce(new Error('interrupted before save'));
      const failed = await capture.runRecallCapture(USER, (await records())[0].id);
      expect(failed.formationCheckpoint?.groups).toHaveLength(1);
      // Exercise a checkpoint written before asset-baseline support existed.
      const legacy = { ...failed.formationCheckpoint!, pendingCandidates: [] };
      delete legacy.assetBaselineDigest; delete legacy.sourceProposalVersion;
      delete legacy.assetBaselineRefreshes; delete legacy.assetBaselineAttempt;
      delete legacy.formationGeneration; delete legacy.formationNeedsRefresh; delete legacy.supportPendingIndexes;
      await capture.updateRecallJsonRecord(USER, 'captures', failed.id, raw => ({ ...raw!, status: 'queued', formationCheckpoint: legacy }));
      lookup.mockResolvedValue({ ...target, version: '2', activeVersion: '2' } as any);
      mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'review-new-baseline', status: 'pending_review' }));
      expect((await capture.runRecallCapture(USER, failed.id)).status).toBe('review_ready');
      expect(mocks.saveCandidate.mock.calls[1][1]).toMatchObject({ targetAssetId: target.id, targetVersionUsed: '1',
        uncertainty: expect.stringContaining('在用版本已变化') });
      expect(mocks.runModel).toHaveBeenCalledTimes(3);
    } finally { selection.mockRestore(); lookup.mockRestore(); permitted.mockRestore(); }
  });
  it('judges the new proposal with related old assets before saving and holds the multi-asset result', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const oldStatement = 'Always keep decisions traceable.';
    const newStatement = `${oldStatement} Cite the original evidence.`;
    const old = [
      { id: 'related-first', type: 'cognition', version: '6', activeVersion: '6' },
      { id: 'related-second', type: 'rule', version: '3', activeVersion: '3' },
    ].map(row => ({ ...row, ownerId: USER, title: 'Traceability', statement: oldStatement,
      status: 'active', scope: 'project', evidenceRefs: [], updatedAt: at(11) }));
    vi.spyOn(assets, 'listAbilityAssets').mockResolvedValue(old as any);
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', newStatement), row('a1', 11, 'assistant')], nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const sweep = await capture.readRecallNightlySweep(USER);
    const inspection = await (await import('../../../../src/main/features/recall/asset-inspection-service'))
      .readInspectionRun(USER, sweep!.receipt!.inspectionRunId!);
    expect(sweep?.inspection).toMatchObject({ evaluatedAssetIds: inspection?.evaluatedAssetIds,
      pendingAssetIds: inspection?.pendingAssetIds, unavailableAssetIds: inspection?.unavailableAssetIds });
    mocks.runModel.mockResolvedValueOnce(answer({ ...positive, evidence: [{ messageId: 'u1', quote: newStatement }] }))
      .mockResolvedValueOnce(answer({ candidates: [{ judgment: newStatement, summary: 'Traceable decisions',
        value: 'Future decisions remain auditable.', suggestedType: 'rule', suggestedScope: 'project',
        suggestedAction: 'create', risk: 'low', evidence: ['m1'] }] }))
      .mockResolvedValueOnce(answer({ assessments: [{ index: 0, checks: { supported: true, noUnsupportedClaims: true,
        scopePreserved: true, finalDecisionPreserved: true, priorContentPreserved: true,
        evidence: [{ label: 'm1', quote: newStatement }] }, uncertaintyDisposition: 'none',
        comparison: { relation: 'duplicate', reason: 'One related requirement exists.', targetAssetId: old[0].id,
          targetVersion: old[0].version, targetQuote: oldStatement } }] }));
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'related-review', status: 'pending_review' }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result).toMatchObject({ status: 'review_ready', candidateIds: ['related-review'] });
    const batch = JSON.parse(mocks.runModel.mock.calls[2][0].message);
    expect(batch.existingAssets.map((row: { id: string }) => row.id).sort()).toEqual(['related-first', 'related-second']);
    expect(batch.relatedFindings).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'conflict',
      assetIds: expect.arrayContaining(['related-first', 'related-second']) })]));
    expect(mocks.saveCandidate).toHaveBeenCalledWith(USER, expect.objectContaining({
      judgment: newStatement, uncertainty: expect.any(String),
      formationComparison: expect.objectContaining({ relation: 'ambiguous', relatedAssets: expect.arrayContaining([
        { assetId: 'related-first', version: '6' },
        { assetId: 'related-second', version: '3' },
      ]) }),
    }));
  });

  it('reforms an uncommitted comparison after approval changes its asset baseline', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const updatedStatement = 'Always keep decisions traceable. Cite the original evidence.';
    let target = { id: 'approval-race', ownerId: USER, title: 'Traceability policy', statement: 'Always keep decisions traceable.',
      version: '6', activeVersion: '6', status: 'active', type: 'cognition', scope: 'project', evidenceRefs: [], updatedAt: at(11) };
    vi.spyOn(assets, 'listAbilityAssets').mockImplementation(async () => [target as any]);
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', updatedStatement), row('a1', 11, 'assistant')], nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const proposal = { judgment: updatedStatement, summary: 'Traceable decisions', value: 'Future decisions remain auditable.',
      suggestedScope: 'project', suggestedAction: 'update', targetAssetId: target.id, risk: 'low', evidence: ['m1'],
      comparison: { relation: 'evidence', reason: 'Add the evidence requirement.', targetAssetId: target.id, targetVersion: '6',
        targetQuote: 'Always keep decisions traceable.' } };
    const assessment = { index: 0,
      checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
        priorContentPreserved: true, evidence: [{ label: 'm1', quote: updatedStatement }] },
      uncertaintyDisposition: 'none',
      comparison: { relation: 'duplicate', reason: 'The approved version already contains the requirement.', targetAssetId: target.id,
        targetVersion: '7', targetQuote: updatedStatement } };
    let releaseExtraction!: () => void;
    let extractionStarted!: () => void;
    const started = new Promise<void>(resolve => { extractionStarted = resolve; });
    mocks.runModel.mockResolvedValueOnce(answer({ ...positive, evidence: [{ messageId: 'u1', quote: updatedStatement }] }))
      .mockImplementationOnce(async () => { extractionStarted(); await new Promise<void>(resolve => { releaseExtraction = resolve; }); return answer({ candidates: [proposal] }); })
      .mockResolvedValueOnce(answer({ assessments: [assessment] }));
    const running = capture.runRecallCapture(USER, (await records())[0].id);
    await started;
    target = { ...target, version: '7', activeVersion: '7', statement: updatedStatement, updatedAt: WINDOW };
    releaseExtraction();
    const result = await running;
    expect(result).toMatchObject({ status: 'no_candidate', candidateIds: [],
      formationCheckpoint: { assetBaselineRefreshes: 1, formationNeedsRefresh: false } });
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(mocks.runModel).toHaveBeenCalledTimes(3);
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.runModel.mock.calls[1][0].message)).not.toHaveProperty('existingAssets');
    const batchInput = JSON.parse(mocks.runModel.mock.calls[2][0].message);
    expect(batchInput.existingAssets).toEqual([expect.objectContaining({ id: target.id, version: '7', statement: updatedStatement })]);
  });

  it('stops instead of settling a stale empty result when the asset baseline changes twice', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    let target = { id: 'approval-twice', ownerId: USER, title: 'Traceability policy', statement: 'Always keep decisions traceable.',
      version: '6', activeVersion: '6', status: 'active', type: 'cognition', scope: 'project', evidenceRefs: [], updatedAt: at(11) };
    vi.spyOn(assets, 'listAbilityAssets').mockImplementation(async () => [target as any]);
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const proposal = { judgment: 'Always keep decisions traceable. Cite the original evidence.', summary: 'Traceable decisions',
      value: 'Future decisions remain auditable.', suggestedScope: 'project', suggestedAction: 'update', targetAssetId: target.id,
      risk: 'low', evidence: ['m1'], comparison: { relation: 'evidence', reason: 'Add evidence.', targetAssetId: target.id,
        targetVersion: '6', targetQuote: target.statement } };
    const batchAnswer = (version: string, statement: string) => answer({ assessments: [{ index: 0,
      checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
        priorContentPreserved: true, evidence: [{ label: 'm1', quote: 'Always keep decisions traceable.' }] },
      uncertaintyDisposition: 'none', comparison: { relation: 'duplicate', reason: 'Already present.', targetAssetId: target.id,
        targetVersion: version, targetQuote: statement } }] });
    const gates: Array<() => void> = [];
    const starts: Array<() => void> = [];
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [proposal] }));
    for (let index = 0; index < 2; index += 1) mocks.runModel.mockImplementationOnce(async () => {
      starts[index]();
      await new Promise<void>(resolve => { gates[index] = resolve; });
      return batchAnswer(target.version, target.statement);
    });
    const running = capture.runRecallCapture(USER, (await records())[0].id);
    await new Promise<void>(resolve => { starts[0] = resolve; });
    target = { ...target, version: '7', activeVersion: '7', statement: 'Always keep decisions traceable. Cite the original evidence.' };
    gates[0]();
    await new Promise<void>(resolve => { starts[1] = resolve; });
    target = { ...target, version: '8', activeVersion: '8', statement: 'Always keep decisions traceable. Cite the original evidence and its date.' };
    gates[1]();
    expect(await running).toMatchObject({ status: 'failed', errorCode: 'formation_baseline_stale', candidateIds: [] });
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
    expect(mocks.runModel).toHaveBeenCalledTimes(4);
  });

  it('discards a batch that finished against v6 and reclassifies against v7', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const latestText = 'Always keep decisions traceable. Cite the original evidence.';
    let target = { id: 'approval-during-batch', ownerId: USER, title: 'Traceability policy',
      statement: 'Always keep decisions traceable.', version: '6', activeVersion: '6', status: 'active',
      type: 'cognition', scope: 'project', evidenceRefs: [], updatedAt: at(11) };
    vi.spyOn(assets, 'listAbilityAssets').mockImplementation(async () => [target as any]);
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', latestText), row('a1', 11, 'assistant')], nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    let startBatch!: () => void;
    let releaseBatch!: () => void;
    const started = new Promise<void>(resolve => { startBatch = resolve; });
    const checks = { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
      priorContentPreserved: true, evidence: [{ label: 'm1', quote: latestText }] };
    const proposal = { judgment: latestText, summary: 'Traceable decisions', value: 'Future decisions remain auditable.',
      suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'] };
    mocks.runModel.mockResolvedValueOnce(answer({ ...positive, evidence: [{ messageId: 'u1', quote: latestText }] }))
      .mockResolvedValueOnce(answer({ candidates: [proposal] }))
      .mockImplementationOnce(async () => {
        startBatch();
        await new Promise<void>(resolve => { releaseBatch = resolve; });
        return answer({ assessments: [{ index: 0, checks, uncertaintyDisposition: 'none',
          comparison: { relation: 'evidence', reason: 'Adds evidence.', targetAssetId: target.id,
            targetVersion: '6', targetQuote: 'Always keep decisions traceable.' }, revision: { judgment: latestText } }] });
      })
      .mockResolvedValueOnce(answer({ assessments: [{ index: 0, checks, uncertaintyDisposition: 'none',
        comparison: { relation: 'duplicate', reason: 'The new version contains this requirement.', targetAssetId: target.id,
          targetVersion: '7', targetQuote: latestText } }] }));
    const running = capture.runRecallCapture(USER, (await records())[0].id);
    await started;
    target = { ...target, version: '7', activeVersion: '7', statement: latestText };
    releaseBatch();
    expect(await running).toMatchObject({ status: 'no_candidate', candidateIds: [],
      formationCheckpoint: { assetBaselineRefreshes: 1 } });
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(mocks.runModel).toHaveBeenCalledTimes(4);
    expect(JSON.parse(mocks.runModel.mock.calls[2][0].message).existingAssets[0]).toMatchObject({ version: '6' });
    expect(JSON.parse(mocks.runModel.mock.calls[3][0].message).existingAssets[0]).toMatchObject({ version: '7' });
  });

  it('reports a partial capture and resumes only its failed formation group', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const inspection = await import('../../../../src/main/features/recall/asset-inspection-service');
    const stock = await import('../../../../src/main/features/recall/stock-organization');
    const source = 'Always keep decisions traceable. Cite the original evidence.';
    const unrelated = { id: 'unrelated-partial', ownerId: USER, title: 'Other policy', statement: 'Use a different policy for unrelated work.',
      version: '1', activeVersion: '1', status: 'active', type: 'rule', scope: 'project', evidenceRefs: [], updatedAt: at(11) };
    vi.spyOn(assets, 'listAbilityAssets').mockResolvedValue([unrelated as any]);
    const inspect = vi.spyOn(inspection, 'runAssetInspection').mockResolvedValue({ id: 'ir-partial', ownerId: USER,
      schemaVersion: 1, trigger: 'nightly', scope: { statuses: ['active'] }, findings: [], scanned: 1,
      startedAt: WINDOW, coverage: { total: 1, evaluated: 1, remaining: 0 } } as any);
    const organize = vi.spyOn(stock, 'runStockOrganization').mockResolvedValue({ phase: 'complete', total: 0,
      checked: 0, proposed: 0, saved: 0, remaining: 0, noChange: 0, insufficient: 0, failed: 0, candidateIds: [] });
    mocks.scheduleBootBackground.mockImplementation((_label, callback) => ({ cancel: vi.fn(),
      promise: Promise.resolve().then(() => callback(new AbortController().signal)) }));
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', source), row('a1', 11, 'assistant')], nextCursor: null });
    const proposals = [
      { judgment: 'Always keep decisions traceable.', summary: 'Traceable decisions', value: 'Future decisions remain auditable.',
        suggestedType: 'rule', suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'] },
      { judgment: 'Cite the original evidence when recording decisions.', summary: 'Cite decision evidence', value: 'Future reviewers can find the source.',
        suggestedType: 'rule', suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'] },
    ];
    const checks = { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
      priorContentPreserved: true, evidence: [{ label: 'm1', quote: source }] };
    const assessment = (index: number) => ({ index, checks, uncertaintyDisposition: 'none', comparison: { relation: 'new', reason: 'Different topic.' } });
    mocks.runModel.mockResolvedValueOnce(answer({ ...positive, evidence: [{ messageId: 'u1', quote: source }] }))
      .mockResolvedValueOnce(answer({ candidates: proposals }))
      .mockResolvedValueOnce(answer({ assessments: [assessment(0)] }))
      .mockResolvedValueOnce(answer({ assessments: [{ index: 1, checks, uncertaintyDisposition: 'none' }] }));
    const saved = new Map<string, any>();
    mocks.saveCandidate.mockImplementation(async (_user, input) => {
      const value = { ...input, id: `partial-candidate-${saved.size + 1}`, status: 'pending_review' };
      saved.set(value.id, value); return value;
    });
    mocks.readCandidate.mockImplementation(async (_user, id) => saved.get(id));
    try {
      const first = await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
      expect(first).toMatchObject({ ran: true, failed: 1, error: 'scan_task_failed' });
      const partial = await capture.readRecallNightlySweep(USER);
      expect(partial).toMatchObject({ phase: 'partial_complete', discovery: { failed: 1 }, receipt: { items: [expect.objectContaining({
        status: 'partial', candidateIds: ['partial-candidate-1'], errorCode: 'candidate_support_unavailable',
        failures: [expect.objectContaining({ candidateIndex: 1, stage: 'grounding', reason: 'assessment_invalid' })],
      })] } });
      const [record] = await records();
      expect(record).toMatchObject({ status: 'review_ready', candidateIds: ['partial-candidate-1'],
        formationCheckpoint: { supportPendingIndexes: [1], groups: [expect.objectContaining({ index: 0, savedCandidateId: 'partial-candidate-1' })] } });
      const summaryCalls = mocks.runSummary.mock.calls.length;
      mocks.runModel.mockResolvedValueOnce(answer({ assessments: [assessment(1)] }));
      await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings, undefined,
        { manual: true, reviewDay: capture.nightlyReviewDay(WINDOW) });
      const completed = await capture.readRecallNightlySweep(USER);
      expect(completed?.receipt?.items).toEqual([expect.objectContaining({ status: 'completed',
        candidateIds: ['partial-candidate-1', 'partial-candidate-2'] })]);
      expect(mocks.saveCandidate).toHaveBeenCalledTimes(2);
      expect(mocks.runSummary).toHaveBeenCalledTimes(summaryCalls);
      expect(mocks.runModel).toHaveBeenCalledTimes(5);
    } finally { inspect.mockRestore(); organize.mockRestore(); }
  });

  it('holds two source proposals that would independently update the same target', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const source = 'Always keep decisions traceable. Cite the original evidence.';
    const target = { id: 'shared-update-target', ownerId: USER, title: 'Traceability policy',
      statement: 'Keep decisions traceable.', version: '6', activeVersion: '6', status: 'active',
      type: 'cognition', scope: 'project', evidenceRefs: [], updatedAt: at(11) };
    vi.spyOn(assets, 'listAbilityAssets').mockResolvedValue([target as any]);
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', source), row('a1', 11, 'assistant')], nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const proposals = [
      { judgment: 'Always keep decisions traceable.', summary: 'Traceable decisions', value: 'Future decisions remain auditable.',
        suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'] },
      { judgment: 'Cite the original evidence when recording decisions.', summary: 'Cite decision evidence',
        value: 'Future reviewers can find the source.', suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'] },
    ];
    const checks = { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
      priorContentPreserved: true, evidence: [{ label: 'm1', quote: source }] };
    mocks.runModel.mockResolvedValueOnce(answer({ ...positive, evidence: [{ messageId: 'u1', quote: source }] }))
      .mockResolvedValueOnce(answer({ candidates: proposals }))
      .mockResolvedValueOnce(answer({ assessments: proposals.map((proposal, index) => ({ index, checks,
        uncertaintyDisposition: 'none', comparison: { relation: 'evidence', reason: 'Adds source support.',
          targetAssetId: target.id, targetVersion: '6', targetQuote: target.statement },
        revision: { judgment: `${target.statement} ${proposal.judgment}` },
      })) }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'candidate_support_unavailable', candidateIds: [],
      candidateSupportUnavailableCount: 2 });
    expect(result.candidateSupportUnavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateIndex: 0, reason: 'dependency_unavailable' }),
      expect.objectContaining({ candidateIndex: 1, reason: 'dependency_unavailable' }),
    ]));
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });

  it('rechecks an empty result at settlement and does not commit the stale no_candidate', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    let target = { id: 'empty-final-check', ownerId: USER, title: 'Traceability policy',
      statement: 'Always keep decisions traceable.', version: '6', activeVersion: '6', status: 'active',
      type: 'cognition', scope: 'project', evidenceRefs: [], updatedAt: at(11) };
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    let reads = 0;
    let statusAtChange: string | undefined;
    vi.spyOn(assets, 'listAbilityAssets').mockImplementation(async () => {
      reads++;
      if (reads === 3) {
        statusAtChange = (await records())[0].status;
        target = { ...target, version: '7', activeVersion: '7', statement: 'Traceability includes original evidence.' };
      }
      return [target as any];
    });
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [] }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(statusAtChange).toBe('extracting');
    expect(result).toMatchObject({ status: 'no_candidate', candidateIds: [],
      formationCheckpoint: { assetBaselineRefreshes: 1, formationGeneration: 1 } });
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
  });

  it('does not let an older in-flight formation overwrite a newer checkpoint generation', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const target = { id: 'generation-target', ownerId: USER, title: 'Traceability policy',
      statement: 'Always keep decisions traceable.', version: '6', activeVersion: '6', status: 'active',
      type: 'cognition', scope: 'project', evidenceRefs: [], updatedAt: at(11) };
    vi.spyOn(assets, 'listAbilityAssets').mockResolvedValue([target as any]);
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    let startBatch!: () => void;
    let releaseBatch!: () => void;
    const started = new Promise<void>(resolve => { startBatch = resolve; });
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [{
      judgment: 'Always keep decisions traceable.', summary: 'Traceable decisions', value: 'Future decisions remain auditable.',
      suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'],
    }] })).mockImplementationOnce(async () => {
      startBatch();
      await new Promise<void>(resolve => { releaseBatch = resolve; });
      return answer({ assessments: [{ index: 0,
        checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
          priorContentPreserved: true, evidence: [{ label: 'm1', quote: 'Always keep decisions traceable.' }] },
        uncertaintyDisposition: 'none', comparison: { relation: 'duplicate', reason: 'Already present.',
          targetAssetId: target.id, targetVersion: '6', targetQuote: target.statement } }] });
    });
    const id = (await records())[0].id;
    const running = capture.runRecallCapture(USER, id);
    await started;
    await capture.updateRecallJsonRecord(USER, 'captures', id, current => ({ ...current!,
      formationCheckpoint: { ...(current!.formationCheckpoint as object), formationGeneration: 1 } }));
    releaseBatch();
    const result = await running;
    expect(result.formationCheckpoint?.formationGeneration).toBe(1);
    expect(result.formationBatchAssessment).toBeUndefined();
    expect(result.status).toBe('extracting');
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });

  it('recovers a saved candidate receipt before rebuilding a stale checkpoint', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    let active: any[] = [];
    vi.spyOn(assets, 'listAbilityAssets').mockImplementation(async () => active);
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const proposal = { judgment: 'Always keep decisions traceable.', summary: 'Traceable decisions',
      value: 'Future decisions remain auditable.', suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'] };
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [proposal] }));
    let saved: any;
    mocks.saveCandidate.mockImplementationOnce(async (_user, input) => {
      saved = { ...input, id: 'saved-before-crash', status: 'pending_review' };
      throw new Error('crash after candidate commit');
    });
    const failed = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'candidate_save_failed' });
    expect(failed.formationCheckpoint?.groups[0].savedCandidateId).toBeUndefined();
    active = [{ id: 'added-after-save', ownerId: USER, title: 'New policy', statement: 'A new policy.',
      version: '1', activeVersion: '1', status: 'active', type: 'cognition', scope: 'project', evidenceRefs: [] }];
    mocks.findCandidateReceipt.mockImplementation(async (_user, key) => key === saved.captureKey ? saved : undefined);
    mocks.readCandidate.mockResolvedValue(saved);
    await capture.updateRecallJsonRecord(USER, 'captures', failed.id, current => ({ ...current!, status: 'queued' }));
    const resumed = await capture.runRecallCapture(USER, failed.id);
    expect(resumed).toMatchObject({ status: 'review_ready', candidateIds: ['saved-before-crash'],
      formationCheckpoint: { groups: [expect.objectContaining({ savedCandidateId: 'saved-before-crash' })] } });
    expect(mocks.saveCandidate).toHaveBeenCalledTimes(1);
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
  });

  it('rechecks prepared targets with source context instead of quoted prohibitions or a proposed scope', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const admission = await import('../../../../src/main/features/recall/prompt-injection');
    const target = { id: 'existing-policy', ownerId: USER, title: 'Existing policy',
      statement: 'Always keep decisions traceable. Informal chat is excluded.',
      version: '1', status: 'active', type: 'cognition', scope: 'project', evidenceRefs: [],
      maturity: 'bud', lifecycleStatus: 'automatically_extracted_unverified',
      forbiddenWhen: ['informal chat'], scopePolicy: { projectIds: ['project-1'] } };
    const comparison = { relation: 'evidence', reason: 'New approved support for the same policy with its original boundary.',
      targetAssetId: target.id, targetVersion: '1', targetQuote: target.statement };
    const selection = vi.spyOn(assets, 'listAbilityAssets').mockResolvedValue([target as any]);
    const lookup = vi.spyOn(assets, 'readAbilityAsset').mockResolvedValue(target as any);
    // Keep the real inspect/source/scope/forbidden gates; the previous replay
    // fixture returned every row and could not reveal this context mismatch.
    const realAdmission = admission.filterRecallAssetsForAgentRead;
    const permitted = vi.spyOn(admission, 'filterRecallAssetsForAgentRead').mockImplementation(realAdmission);
    try {
      // Even the authenticated source/summary may discuss the forbidden case;
      // quoted data must remain a ranking query, not the running task.
      mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', target.statement), row('a1', 11, 'assistant')], nextCursor: null });
      await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
      // The sweep's own inventory reads without a conversation project. The
      // assertion below is about the capture recheck that follows.
      permitted.mockClear();
      mocks.runModel.mockResolvedValueOnce(answer({ ...positive, evidence: [{ messageId: 'u1', quote: target.statement }] })).mockResolvedValueOnce(answer({ candidates: [{
        judgment: target.statement, summary: 'Traceable decisions', value: 'Future decisions remain auditable.',
        uncertainty: 'Whether this traceability policy improves future decisions remains unverified.',
        suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'],
      }] })).mockResolvedValueOnce(answer({ assessments: [{ index: 0,
        checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
          priorContentPreserved: true, evidence: [{ label: 'm1', quote: target.statement }] },
        uncertaintyDisposition: 'effect_unverified', comparison,
        revision: { judgment: target.statement, forbiddenWhen: target.forbiddenWhen },
      }] }));
      mocks.saveCandidate.mockRejectedValueOnce(new Error('interrupted before save'));
      const failed = await capture.runRecallCapture(USER, (await records())[0].id);
      expect(failed.errorCode).toBe('candidate_save_failed');
      expect(failed.formationCheckpoint?.groups).toHaveLength(1);
      expect(failed.uncertaintyAssessments).toEqual([expect.objectContaining({ candidateIndex: 0,
        modelCompleted: true, nonBlocking: true, uncertaintyDisposition: 'effect_unverified' })]);
      expect(permitted.mock.calls[0][2]).toMatchObject({ projectId: 'project-1' });
      expect(permitted.mock.calls.every(call => !call[2]?.taskText && !call[2]?.purpose)).toBe(true);
      const legacy = { ...failed.formationCheckpoint!, pendingCandidates: [] };
      delete legacy.assetBaselineDigest; delete legacy.sourceProposalVersion;
      delete legacy.assetBaselineRefreshes; delete legacy.assetBaselineAttempt;
      delete legacy.formationGeneration; delete legacy.formationNeedsRefresh; delete legacy.supportPendingIndexes;
      await capture.updateRecallJsonRecord(USER, 'captures', failed.id, raw => ({ ...raw!, status: 'queued', formationCheckpoint: legacy }));
      // Access revoked after preparation must still fail closed, without
      // regenerating the model result or committing the frozen group.
      lookup.mockResolvedValueOnce({ ...target, scopePolicy: { projectIds: ['another-project'] } } as any);
      expect(await capture.runRecallCapture(USER, failed.id)).toMatchObject({ status: 'failed', errorCode: 'formation_baseline_unavailable' });
      expect(mocks.saveCandidate).toHaveBeenCalledTimes(1);
      await capture.updateRecallJsonRecord(USER, 'captures', failed.id, raw => ({ ...raw!, status: 'queued' }));
      // The model's suggestedScope is not an actual purpose-tag grant.
      lookup.mockResolvedValueOnce({ ...target, scopePolicy: { purposeTags: ['project'] } } as any);
      expect(await capture.runRecallCapture(USER, failed.id)).toMatchObject({ status: 'failed', errorCode: 'formation_baseline_unavailable' });
      expect(mocks.saveCandidate).toHaveBeenCalledTimes(1);
      await capture.updateRecallJsonRecord(USER, 'captures', failed.id, raw => ({ ...raw!, status: 'queued' }));
      mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'review-source-context', status: 'pending_review' }));
      expect((await capture.runRecallCapture(USER, failed.id)).status).toBe('review_ready');
      expect(mocks.saveCandidate).toHaveBeenCalledTimes(2);
      expect(mocks.runModel).toHaveBeenCalledTimes(3);
    } finally { selection.mockRestore(); lookup.mockRestore(); permitted.mockRestore(); }
  });
  it('admits feedback on an already-covered historical answer through the same next-night pipeline', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'No new durable understanding.', evidence: [] }));
    await capture.runRecallCapture(USER, (await records())[0].id);
    const feedback = await import('../../../../src/main/features/recall/nightly-feedback');
    await feedback.queueNightlyFeedback(USER, { conversationId: 'cid', messageId: 'a1', assetId: 'aa-test-feedback', assetVersion: '1', taskRunId: 'synthetic-turn', feedback: 'negative' });
    vi.setSystemTime(new Date(at(13, 3)));
    await capture.runNightlyCaptureSweep(USER, at(13, 3), capture.settings);
    const feedbackCapture = (await records()).find(record => record.feedbackRevision);
    expect(feedbackCapture).toMatchObject({ status: 'queued', reviewDay: '2026-10-11', feedbackObservations: [expect.objectContaining({ feedback: 'negative', assetVersion: '1' })] });
    const result = await capture.runRecallCapture(USER, feedbackCapture.id);
    expect(result.status).toBe('no_candidate');
    expect(result.autoApprovalEpoch).toBeUndefined();
    const summaryInput = JSON.parse(mocks.runSummary.mock.calls.at(-1)![0].message);
    expect(summaryInput.segments.find((segment: any) => segment.messageId === 'a1').observations).toEqual([expect.objectContaining({ feedback: 'negative' })]);
    expect(await feedback.queuedNightlyFeedback(USER)).toEqual([]);
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });
  it('stops unavailable worker feedback before any summary or value model call', async () => {
    const f = await workerFeedbackFixture();
    try {
      f.readResult.mockRejectedValue(new Error('execution context unavailable'));
      expect(await f.capture.runRecallCapture(USER, f.record.id)).toMatchObject({ status: 'failed', errorCode: 'source_unavailable' });
      expect(mocks.runSummary).not.toHaveBeenCalled(); expect(mocks.runModel).not.toHaveBeenCalled();
      expect(mocks.saveCandidate).not.toHaveBeenCalled();
    } finally { f.restore(); }
  });
  it('carries worker feedback as supplementary result context and source refs without changing user evidence', async () => {
    const f = await workerFeedbackFixture();
    try {
      const result = await f.capture.runRecallCapture(USER, f.record.id);
      expect(result.status).toBe('review_ready');
      const summary = JSON.parse(mocks.runSummary.mock.calls[0][0].message);
      expect(summary.segments.find((segment: any) => segment.messageId === 'u1')).toMatchObject({
        text: positive.evidence[0].quote, observations: [f.context],
      });
      const extraction = JSON.parse(mocks.runModel.mock.calls[1][0].message);
      expect(extraction.recallView.sourceRefs).toContainEqual({ kind: f.sourceRef.kind, subtype: f.sourceRef.subtype, id: f.sourceRef.id });
      expect(extraction.messages[0]).toMatchObject({ id: 'u1', role: 'user', text: positive.evidence[0].quote, observations: [f.context] });
      expect(result.formationCheckpoint!.groups[0].input.sourceRefs).toContainEqual(f.sourceRef);
      expect(mocks.saveCandidate.mock.calls[0][1].sourceRefs).toContainEqual(f.sourceRef);
      expect(result.valueJudgment?.evidence).toEqual([expect.objectContaining(positive.evidence[0])]);
      expect(f.readResult).toHaveBeenCalledWith(USER, 'cid', expect.objectContaining({ id: f.observation.id }));
    } finally { f.restore(); }
  });
  it('rechecks worker feedback before a prepared group is submitted', async () => {
    const f = await workerFeedbackFixture();
    try {
      let preparedChecks = 0;
      f.readResult.mockImplementation(async () => {
        const current = await f.capture.readRecallCapture(USER, f.record.id);
        if (current.formationCheckpoint?.groups.length && ++preparedChecks === 2) return { ...f.resultContext, fingerprint: 'changed-before-submission' } as any;
        return f.resultContext as any;
      });
      const result = await f.capture.runRecallCapture(USER, f.record.id);
      expect(result).toMatchObject({ status: 'failed', errorCode: 'source_unavailable' });
      expect(result.formationCheckpoint?.groups).toHaveLength(1);
      expect(mocks.saveCandidate).not.toHaveBeenCalled();
    } finally { f.restore(); }
  });
  it('rejects changed worker feedback after extraction before freezing a preparation', async () => {
    const f = await workerFeedbackFixture();
    try {
      f.readResult.mockResolvedValueOnce(f.resultContext as any)
        .mockResolvedValue({ ...f.resultContext, fingerprint: 'changed-during-extraction' } as any);
      const result = await f.capture.runRecallCapture(USER, f.record.id);
      expect(result).toMatchObject({ status: 'failed', errorCode: 'source_unavailable' });
      expect(mocks.runModel).toHaveBeenCalledTimes(2);
      expect(result.formationCheckpoint).toBeUndefined();
      expect(mocks.saveCandidate).not.toHaveBeenCalled();
    } finally { f.restore(); }
  });
  it('refuses changed worker feedback on checkpoint resume before replacing the frozen context', async () => {
    const f = await workerFeedbackFixture();
    try {
      mocks.saveCandidate.mockRejectedValueOnce(new Error('candidate write unavailable'));
      const prepared = await f.capture.runRecallCapture(USER, f.record.id);
      expect(prepared).toMatchObject({ status: 'failed', errorCode: 'candidate_save_failed' });
      await f.capture.updateRecallJsonRecord(USER, 'captures', f.record.id, current => ({ ...current!, status: 'queued' }));
      f.readResult.mockResolvedValue({ ...f.resultContext, fingerprint: 'changed-before-resume' } as any);
      f.read.mockClear(); f.readResult.mockClear(); mocks.runSummary.mockClear(); mocks.runModel.mockClear(); mocks.saveCandidate.mockClear();
      const resumed = await f.capture.runRecallCapture(USER, f.record.id);
      expect(resumed).toMatchObject({ status: 'failed', errorCode: 'source_unavailable' });
      expect(resumed.feedbackVersionContexts).toEqual(prepared.feedbackVersionContexts);
      expect(resumed.formationCheckpoint).toEqual(prepared.formationCheckpoint);
      expect(f.readResult).toHaveBeenCalledTimes(1); expect(mocks.runSummary).not.toHaveBeenCalled();
      expect(mocks.runModel).not.toHaveBeenCalled(); expect(mocks.saveCandidate).not.toHaveBeenCalled();
    } finally { f.restore(); }
  });
  it('extracts an explicit ontology-only group through the same nightly evidence gates', async () => {
    const capture = await api();
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ proposalVersion: 2, proposals: [{
      id: 'traceability', target: 'ontology',
      explanation: { description: 'Always keep decisions traceable.', summary: 'Traceable decision records',
        value: 'Future project decisions can be checked against their original evidence.', suggestedScope: 'project', risk: 'low', evidence: ['m1'] },
      ontologyChanges: { reason: 'The user explicitly requires source checks for project decisions.', evidence: ['m1'], actions: [
        { intent: 'create', recordId: 'project-module', sourceLabel: 'Explicit project traceability requirement',
          record: { kind: 'module', name: 'Project decisions', description: '', scope: { kind: 'project', id: 'project-1' } } },
        { intent: 'create', recordId: 'traceability-rule', sourceLabel: 'Explicit project traceability requirement',
          record: { kind: 'rule', moduleId: 'project-module', name: 'Traceable decisions', requirement: 'Always keep decisions traceable.',
            strength: 'suggestion', condition: null, effect: { kind: 'note' }, exception: '' } },
      ] },
    }] })).mockResolvedValueOnce(answer({ assessments: [{ index: 0, uncertaintyDisposition: 'none',
      checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
        priorContentPreserved: true, evidence: [{ label: 'm1', quote: 'Always keep decisions traceable.' }] },
      sourceRuleConclusions: [{ recordId: 'traceability-rule', status: 'resolved',
        expectedContract: { strength: 'required', condition: null, effect: { kind: 'note' }, exception: '' },
        topicEvidence: [{ label: 'm1', quote: 'Always keep decisions traceable.' }], fieldEvidence: {
          strength: [{ label: 'm1', quote: 'Always keep decisions traceable.' }], condition: [], effect: [], exception: [] } }],
    }] }));
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'ontology-candidate', status: 'pending_review' }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result).toMatchObject({ status: 'review_ready', candidateIds: ['ontology-candidate'] });
    expect(mocks.saveCandidate.mock.calls[0][1]).toMatchObject({ proposalTarget: 'ontology', formationProposalId: 'traceability',
      judgment: 'Always keep decisions traceable.', ontologyFormation: { blockedReasons: [], requiresTReview: true } });
    expect(mocks.saveCandidate.mock.calls[0][1].ontologyFormation.refs.some(ref => ref.sharedBody)).toBe(false);
    expect(mocks.saveCandidate.mock.calls[0][1].ontologyFormation.previewChanges).toContainEqual(expect.objectContaining({
      after: expect.objectContaining({ id: 'traceability-rule', strength: 'required' }),
    }));
    expect(mocks.runModel).toHaveBeenCalledTimes(3);
    expect(mocks.buildRunner.mock.calls.at(-1)![0].sessionId).toMatch(/^memory-formation-recall-/);
  });
  it('uses contextual user text for R fields while the new message retains the formation topic authority', async () => {
    const earlier = { ...row('requirement', 12, 'user', 'Deployment reviews must include risks and rollback conditions.'), ts: at(12, 10) };
    const latest = { ...row('scope', 12, 'user', 'That requirement applies to Project Alpha; ordinary meetings are exempt.'), ts: at(12, 15) };
    const body = 'Project Alpha deployment reviews must include risks and rollback conditions; ordinary meetings are exempt.';
    vi.setSystemTime(new Date(at(12, 11)));
    const capture = await api();
    mocks.listConversations.mockResolvedValue([conversation('cid', 12)]);
    mocks.getConversation.mockResolvedValue(conversation('cid', 12));
    mocks.getMessagesPage.mockResolvedValue({ history: [earlier], nextCursor: null });
    await capture.runManualCaptureSweep(USER);
    const [first] = await records();
    await capture.updateRecallJsonRecord(USER, 'captures', first.id, current => ({ ...current!, status: 'no_candidate' }));
    vi.setSystemTime(new Date(at(12, 16)));
    mocks.getMessagesPage.mockResolvedValue({ history: [earlier, latest], nextCursor: null });
    mocks.runSummary.mockImplementation(input => captureSummaryModelResponseWithEvidence(input, [earlier.text, latest.text]));
    await capture.runManualCaptureSweep(USER);
    const second = (await records()).find(record => record.id !== first.id)!;
    mocks.runModel.mockResolvedValueOnce(answer({ eligible: true, reason: 'Defines the future scope and exception of the review requirement.',
      evidence: [{ messageId: latest.id, quote: latest.text }] })).mockResolvedValueOnce(answer({ proposalVersion: 2, proposals: [{
      id: 'scoped-review', target: 'ontology', explanation: { description: body, summary: 'Project review requirements',
        value: 'Future project reviews preserve risk evidence without imposing the review format on ordinary meetings.',
        suggestedScope: 'project', risk: 'low', evidence: ['m1', 'm2'] },
      ontologyChanges: { reason: 'A new scope qualification of the earlier review requirement.', evidence: ['m2'], actions: [
        { intent: 'create', recordId: 'project-module', sourceLabel: 'Project Alpha scope',
          record: { kind: 'module', name: 'Project Alpha', description: '', scope: { kind: 'project', id: 'project-1' } } },
        { intent: 'create', recordId: 'review-rule', sourceLabel: 'Review requirement with scope qualification',
          record: { kind: 'rule', moduleId: 'project-module', name: 'Deployment review', requirement: body,
            strength: 'default', condition: null, effect: { kind: 'note' }, exception: 'ordinary meetings are exempt' } },
      ] },
    }] })).mockResolvedValueOnce(answer({ assessments: [{ index: 0, uncertaintyDisposition: 'none',
      checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
        priorContentPreserved: true, evidence: [{ label: 'm2', quote: latest.text }] },
      sourceRuleConclusions: [{ recordId: 'review-rule', status: 'resolved',
        expectedContract: { strength: 'required', condition: null, effect: { kind: 'note' }, exception: 'ordinary meetings are exempt' },
        topicEvidence: [{ label: 'm2', quote: latest.text }], fieldEvidence: {
          strength: [{ label: 'm1', quote: earlier.text }], condition: [], effect: [],
          exception: [{ label: 'm2', quote: 'ordinary meetings are exempt' }] } }],
    }] }));
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'scoped-rule-candidate', status: 'pending_review' }));
    const result = await capture.runRecallCapture(USER, second.id);
    expect(result).toMatchObject({ status: 'review_ready', candidateIds: ['scoped-rule-candidate'] });
    const assessmentInput = JSON.parse(mocks.runModel.mock.calls.at(-1)![0].message);
    expect(assessmentInput.candidates[0].sources).toEqual([
      { label: 'm1', text: earlier.text, approvedQuotes: [] },
      { label: 'm2', text: latest.text, approvedQuotes: [latest.text] },
    ]);
    const saved = mocks.saveCandidate.mock.calls[0][1];
    expect(saved.captureProvenance.messageIds).toEqual([latest.id]);
    expect(saved.captureProvenance.valueJudgment.evidence.map((evidence: any) => evidence.messageId)).toEqual([latest.id]);
    expect(saved.ontologyFormation.blockedReasons).toEqual([]);
    expect(saved.ontologyFormation.previewChanges).toContainEqual(expect.objectContaining({
      after: expect.objectContaining({ id: 'review-rule', strength: 'required' }),
    }));
    expect(result.formationCheckpoint?.groups[0].ruleSourceAssessment).toMatchObject({ conclusions: [
      expect.objectContaining({ topicEvidence: [{ label: 'm2', quote: latest.text }], fieldEvidence: expect.objectContaining({
        strength: [{ label: 'm1', quote: earlier.text }],
      }) }),
    ] });
  });
  it('keeps invalid/fabricated value decisions internal and does not invoke extraction', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockResolvedValue(answer({ ...positive, evidence: [{ messageId: 'a1', quote: 'Always keep decisions traceable.' }] }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result).toMatchObject({ status: 'failed', visibility: 'internal', errorCode: 'value_judgment_failed' });
    expect(mocks.runModel).toHaveBeenCalledTimes(1);
    expect(capture.captureBucket(result)).toBe('silent');
  });
  it('submits all complete long messages beyond the former limits before value judgment', async () => {
    const capture = await api();
    const source = Array.from({ length: 41 }, (_, index) => row(`full-${index}`, 11,
      index === 0 ? 'user' : 'assistant', `${index}:` + 'Complete source material. '.repeat(1_600)
        + `END-${index}` + (index === 0 ? '\nAlways keep decisions traceable in future work.' : '')));
    mocks.getMessagesPage.mockResolvedValue({ history: source, nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const [record] = await records();
    expect(record.messageIds).toEqual(source.map(message => message.id));
    expect(await records()).toHaveLength(1);
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'No durable value', evidence: [] }));
    const result = await capture.runRecallCapture(USER, record.id);
    const budgets = await import('../../../../src/main/features/recall/capture-model-budget');
    expect((await budgets.readCaptureModelBudget(USER)).stages.summary?.calls).toBeGreaterThan(80);
    expect(result.status).toBe('no_candidate');
    const inputs = mocks.runSummary.mock.calls.map(call => JSON.parse(call[0].message));
    const segments = inputs.filter(input => input.stage === 'chunk').flatMap(input => input.segments);
    for (const message of source) {
      const submitted = segments.filter(segment => segment.messageId === message.id)
        .sort((left, right) => left.start - right.start);
      expect(submitted.map(segment => segment.text).join('')).toBe(message.text);
    }
    expect(inputs.some(input => input.stage === 'merge')).toBe(true);
    expect(result.contextSummary?.coverage).toMatchObject({ messageCount: source.length,
      sourceChars: source.reduce((sum, message) => sum + message.text.length, 0) });
    expect(mocks.runModel).toHaveBeenCalledTimes(1);
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });
  it('includes previous-day long assistant continuations with earlier user context kept outside discovery', async () => {
    const capture = await api();
    const prior = row('previous-user', 10, 'user', 'Always use this reusable migration rollback checklist for every schema migration.');
    const fresh = Array.from({ length: 36 }, (_, index) => row(`continuation-${index}`, 11, 'assistant',
      `Assistant continuation ${index}: ` + 'Verify rollback before deployment. '.repeat(300) + `TAIL-${index}`));
    mocks.getMessagesPage.mockResolvedValue({ history: [prior, ...fresh], nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const [record] = await records();
    expect(record.messageIds).toEqual(fresh.map(message => message.id));
    expect(record.contextMessageIds).toContain(prior.id);
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'Assistant proposals need review', evidence: [] }));
    await capture.runRecallCapture(USER, record.id);
    const segments = mocks.runSummary.mock.calls.map(call => JSON.parse(call[0].message))
      .filter(input => input.stage === 'chunk').flatMap(input => input.segments);
    expect(segments.filter(segment => segment.messageId === prior.id)).toEqual([
      expect.objectContaining({ text: prior.text, discovery: false }),
    ]);
    for (const message of fresh) {
      const slices = segments.filter(segment => segment.messageId === message.id);
      expect(slices.every(segment => segment.discovery === true)).toBe(true);
      expect(slices.map(segment => segment.text).join('')).toBe(message.text);
    }
  });
  it('repairs a rejected summary draft with one bounded contract retry before value judgment', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'No durable value', evidence: [] }));
    mocks.runSummary.mockImplementationOnce(async input => {
      const response = captureSummaryModelResponse(input);
      const output = JSON.parse(response.text);
      output.topics[0].evidence[0].quote = 'Fabricated quote absent from the original source';
      return answer(output);
    });
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    // The rejected draft never persists; only the revalidated summary does.
    expect(result.status).toBe('no_candidate');
    expect(result.contextSummary?.topics.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.contextSummary)).not.toContain('Fabricated quote');
    expect(result.candidateIds).toEqual([]);
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
    // Exactly one repair: only the retry call carries the fixed contract text.
    expect(mocks.runSummary).toHaveBeenCalledTimes(2);
    const summaryRuns = mocks.buildRunner.mock.calls.map(([params]) => params)
      .filter(params => String(params.sessionId).startsWith('memory-summary'));
    expect(summaryRuns).toHaveLength(2);
    expect(summaryRuns[0].systemPrompt).not.toContain('逐字连续的原文');
    expect(summaryRuns[1].systemPrompt).toContain('逐字连续的原文');
  });
  it('keeps a persistently invalid summary internal with its classified reason after the single repair', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runSummary.mockImplementation(async input => {
      const request = JSON.parse(input.message);
      return answer({ coveredIds: request.segments.map((segment: { id: string }) => segment.id), topics: [] });
    });
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result).toMatchObject({ status: 'failed', visibility: 'internal', errorCode: 'summary_output_invalid',
      reasonCode: 'nonempty source requires a topic' });
    expect(result.contextSummary).toBeUndefined();
    // The repair is bounded at one retry even when the model repeats the fault.
    expect(mocks.runSummary).toHaveBeenCalledTimes(2);
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });
  it('records a summary model failure with the host failure token instead of a generic summary failure', async () => {
    const capture = await api();
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    await settings.updateRecallCaptureSettings(USER, { modelCandidates: [{ provider: 'openai', model: 'first' }] });
    mocks.runSummary.mockImplementation(async () => ({ text: 'partial', meta: { error: { kind: 'provider_error', message: '503 service unavailable' } } }));
    await capture.runNightlyCaptureSweep(USER, WINDOW, await settings.readRecallCaptureSettings(USER));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result).toMatchObject({ status: 'failed', visibility: 'internal', errorCode: 'summary_model_failed', reasonCode: 'provider_error' });
    expect(result.contextSummary).toBeUndefined();
    // Model-side failures never enter the contract-repair path.
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
    // One model failure advances the protection circuit without holding the night.
    const budgets = await import('../../../../src/main/features/recall/capture-model-budget');
    expect(await budgets.readCaptureModelBudget(USER)).toMatchObject({ failureGuard: { consecutiveFailures: 1, held: false } });
  });
  it('separates an oversized summary response from validation failures and keeps the night retryable', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runSummary.mockImplementation(async () => ({ text: 'x'.repeat(16_001), meta: {} }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result).toMatchObject({ status: 'failed', visibility: 'internal', errorCode: 'summary_budget_exhausted', reasonCode: 'output too large' });
    expect(result.contextSummary).toBeUndefined();
    // The oversized answer gets exactly one budget-restated repair, then settles.
    expect(mocks.runSummary).toHaveBeenCalledTimes(2);
    expect(mocks.runModel).not.toHaveBeenCalled();
    // The model call behind an exhausted output budget completed; validator and
    // budget failures never advance the model-failure circuit or hold the night.
    const budgets = await import('../../../../src/main/features/recall/capture-model-budget');
    expect(await budgets.readCaptureModelBudget(USER)).toMatchObject({ failureGuard: { consecutiveFailures: 0, held: false } });
  });
  it('resumes the summary repair from the persisted checkpoint without resending completed chunks', async () => {
    const capture = await api();
    const text = 'Traceable decisions matter. ' + 'Synthetic bounded context sentence. '.repeat(600);
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', text), row('a1', 11, 'assistant', text)], nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'No durable value', evidence: [] }));
    let chunkCalls = 0;
    mocks.runSummary.mockImplementation(async input => {
      const request = JSON.parse(input.message);
      if (request.stage !== 'chunk') return captureSummaryModelResponse(input);
      chunkCalls += 1;
      if (chunkCalls === 2) return answer({ coveredIds: request.segments.map((segment: { id: string }) => segment.id), topics: [] });
      return captureSummaryModelResponse(input);
    });
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result.status).toBe('no_candidate');
    expect(result.contextSummary?.coverage.segmentCount).toBeGreaterThan(1);
    // First pass: chunk1 + the rejected chunk2; repair pass: chunk2 again plus
    // the merge — completed chunks are never resent.
    expect(chunkCalls).toBe(3);
    expect(mocks.runSummary).toHaveBeenCalledTimes(4);
  });
  it('maps only repairable validator rejections to bounded contract restatements', async () => {
    const { captureSummaryRepairInstruction } = await import('../../../../src/main/features/recall/capture-service');
    for (const reason of ['nonempty source requires a topic', 'incomplete coverage', 'dropped input topic',
      'quote outside submitted source', 'quote outside input evidence', 'fabricated quote', 'fabricated offset',
      'fabricated role', 'object shape', 'topics shape', 'evidence shape', 'text size or shape', 'list shape',
      'attribution', 'invalid topic annotation', 'user attribution lacks user evidence',
      'assistant attribution lacks assistant evidence', 'compression dropped evidence', 'output too large'])
      expect(captureSummaryRepairInstruction(reason)).toBeTruthy();
    for (const reason of ['checkpoint merges', 'checkpoint missing merge input', 'compression input too large',
      'summary compression budget exhausted', 'merge cannot fit two summaries', 'stored source digest mismatch',
      'unheard-of validator reason'])
      expect(captureSummaryRepairInstruction(reason)).toBeUndefined();
  });
  it('does not treat an aborted summary as completed even when it contains valid output', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runSummary.mockImplementationOnce(async input => ({ ...captureSummaryModelResponse(input), meta: { aborted: true } }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result.contextSummary).toBeUndefined();
    expect(result.candidateIds).toEqual([]);
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });
  it.each(['password = example-secret-value', '"api_key": "example-secret-value"'])('rejects sensitive summary copies without removing original chat: %s', async secretFixture => {
    const capture = await api();
    const original = `Always keep decisions traceable. Test-only sample: ${secretFixture}`;
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', original), row('a1', 11, 'assistant')], nextCursor: null });
    mocks.runSummary.mockImplementation(input => captureSummaryModelResponseWithEvidence(input, [secretFixture]));
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result).toMatchObject({ status: 'failed', visibility: 'internal', errorCode: 'summary_sensitive_content', candidateIds: [] });
    expect(result.contextSummary).toBeUndefined();
    expect(result.summaryCheckpoint).toBeUndefined();
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
    const persisted = await records();
    expect(persisted[0].contextSummary).toBeUndefined();
    expect(persisted[0].summaryCheckpoint).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain(secretFixture);
    const originalPage = await mocks.getMessagesPage(USER, 'cid');
    expect(originalPage.history[0].text).toBe(original);
  });
  it.each(['contextSummary', 'summaryCheckpoint'] as const)('discards a structurally valid sensitive persisted %s before rebuilding', async cachedField => {
    const capture = await api();
    const secretFixture = 'password = example-secret-value';
    const original = `Always keep decisions traceable. Test-only sample: ${secretFixture}`;
    const source = [row('u1', 11, 'user', original), row('a1', 11, 'assistant')];
    mocks.getMessagesPage.mockResolvedValue({ history: source, nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    const summaries = await import('../../../../src/main/features/recall/capture-context-summary');
    let checkpoint: import('../../../../src/main/features/recall/capture-context-summary').CaptureContextCheckpoint | undefined;
    const summary = await summaries.summarizeCaptureContext(source.map(message => ({
      id: message.id, role: message.from === 'user' ? 'user' : 'assistant', text: message.text, discovery: true,
    })), {
      run: async message => captureSummaryModelResponseWithEvidence({ message }, [secretFixture]).text,
      onCheckpoint: progress => { checkpoint = progress; },
    });
    expect(checkpoint).toBeDefined();
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!,
      ...(cachedField === 'contextSummary' ? { contextSummary: summary } : { summaryCheckpoint: checkpoint }),
    }));
    expect(JSON.stringify(await records())).toContain(secretFixture);
    mocks.runSummary.mockImplementation(input => captureSummaryModelResponseWithEvidence(input, [secretFixture]));
    const result = await capture.runRecallCapture(USER, record.id);
    expect(result).toMatchObject({ status: 'failed', visibility: 'internal', errorCode: 'summary_sensitive_content', candidateIds: [] });
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
    expect(result.contextSummary).toBeUndefined();
    expect(result.summaryCheckpoint).toBeUndefined();
    const persisted = await records();
    expect(persisted[0].contextSummary).toBeUndefined();
    expect(persisted[0].summaryCheckpoint).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain(secretFixture);
  });
  it('re-summarizes and rejudges legacy eligible decisions that lack the source summary', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!,
      valueJudgment: { ...positive, judgedAt: WINDOW, evidence: [{ ...positive.evidence[0], sourceId: 'legacy-source' }] },
    }));
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'Rejudged after complete summary', evidence: [] }));
    const result = await capture.runRecallCapture(USER, record.id);
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(mocks.runModel).toHaveBeenCalledTimes(1);
    expect(mocks.buildRunner.mock.calls.map(call => call[0].sessionId)).toEqual([
      expect.stringMatching(/memory-summary/), expect.stringMatching(/memory-value/),
    ]);
    expect(result).toMatchObject({ status: 'no_candidate', valueJudgment: { eligible: false } });
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });
  it('retries a persisted range only on the next night within the attempt limit, without rescanning old messages', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!, status: 'failed', attempt: 2, lastAttemptReviewDay: '2026-10-10' }));
    expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings)).toMatchObject({ retried: 1, queued: 0 });
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!, status: 'failed', attempt: 3 }));
    expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings)).toMatchObject({ retried: 0 });
    expect(await records()).toHaveLength(1);
  });
  it('does not consume new daily messages merely because an old manual or cancelled task mentions them', async () => {
    const capture = await api();
    const now = new Date().toISOString();
    await capture.updateRecallJsonRecord(USER, 'captures', 'old-manual', () => ({
      schemaVersion: 1, taxonomyVersion: 2, ownerId: USER, id: 'old-manual', conversationId: 'cid',
      terminalRunId: 'old-run', anchorMessageId: 'u1', messageIds: ['u1', 'a1'],
      executionPolicy: 'manual', status: 'waiting_manual', attempt: 1, candidateIds: [],
      visibility: 'visible', screeningStatus: 'qualified', createdAt: now, updatedAt: now,
    }));
    expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings)).toMatchObject({ queued: 1 });
    expect(await records()).toHaveLength(2);
  });
  it('a value decision for one quoted topic cannot extract a different user topic', async () => {
    const capture = await api();
    const source = 'Always keep decisions traceable. For one temporary task generate a calendar meeting agenda.';
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', source), row('a1', 11, 'assistant')], nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [{
      judgment: '会议准备模板：会议目标、背景事实、三个待决策问题、负责人和下一步行动。',
      summary: '项目会议议程', value: '供后续项目会议复用，减少重复准备并使决策责任清晰。',
      suggestedType: 'template', suggestedScope: 'project', suggestedAction: 'create', evidence: ['m1'],
    }] })).mockResolvedValueOnce(answer({ assessments: [{ index: 0, uncertaintyDisposition: 'content_unresolved', checks: {
      supported: false, noUnsupportedClaims: false, scopePreserved: false,
      finalDecisionPreserved: false, priorContentPreserved: false, evidence: [],
    } }] }));
    const screening = await import('../../../../src/main/features/recall/capture-value-screening');
    expect(screening.assessRecallCandidateClassification({
      judgment: '会议准备模板：会议目标、背景事实、三个待决策问题、负责人和下一步行动。',
      summary: '项目会议议程', value: '供后续项目会议复用，减少重复准备并使决策责任清晰。',
      suggestedType: 'template', suggestedScope: 'project', suggestedAction: 'create', valueProvided: true, actionProvided: true,
    }).ok).toBe(true);
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result.status).toBe('no_candidate');
    expect(mocks.runModel).toHaveBeenCalledTimes(3);
    expect(JSON.parse(mocks.runModel.mock.calls[1][0].message).messages[0].text).toBe(source);
    expect(JSON.parse(mocks.runModel.mock.calls[2][0].message).candidates[0].sources[0].approvedQuotes).toEqual([positive.evidence[0].quote]);
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });
  it('keeps later scope restrictions and corrections in extraction even when value cites only the earlier requirement', async () => {
    const capture = await api();
    const correction = '仅限项目甲。以前英文记错了，一直是中文。';
    const source = [row('u1'), row('a1', 11, 'assistant'), row('u2', 11, 'user', correction)];
    mocks.getMessagesPage.mockResolvedValue({ history: source, nextCursor: null });
    mocks.runSummary.mockImplementation(input => captureSummaryModelResponseWithEvidence(input,
      [positive.evidence[0].quote, correction]));
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [] }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    const input = JSON.parse(mocks.runModel.mock.calls[1][0].message);
    expect(input.summary).toEqual(result.contextSummary?.topics);
    expect(input.approvedEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: 'u1', quote: positive.evidence[0].quote }),
    ]));
    expect(input.messages.map(message => message.id)).toEqual(source.map(message => message.id));
    expect(input.messages.find(message => message.id === 'u2').text).toBe(correction);
    expect(JSON.stringify(input.summary)).toContain(correction);
  });
  it('bounds positive long-source extraction input while preserving the final correction and approved source evidence', async () => {
    const capture = await api();
    const correction = '仅限项目甲。以前英文记错了，一直是中文。';
    const longText = positive.evidence[0].quote + '\n' + 'Source discussion with full details. '.repeat(6_000);
    const source = [row('u1', 11, 'user', longText), row('a1', 11, 'assistant'), row('u2', 11, 'user', correction)];
    mocks.getMessagesPage.mockResolvedValue({ history: source, nextCursor: null });
    mocks.runSummary.mockImplementation(input => captureSummaryModelResponseWithEvidence(input,
      [positive.evidence[0].quote, correction]));
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [] }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    const raw = mocks.runModel.mock.calls[1][0].message;
    expect(raw.length).toBeLessThanOrEqual(96_000);
    const input = JSON.parse(raw);
    expect(input.summary).toEqual(result.contextSummary?.topics);
    expect(input.approvedEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: 'u1', quote: positive.evidence[0].quote }),
    ]));
    expect(input.messages.find(message => message.id === 'u1')).toMatchObject({ excerpt: true });
    const excerpt = input.messages.find(message => message.id === 'u1');
    expect(excerpt.text).toContain(positive.evidence[0].quote);
    expect(excerpt.sourceSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ start: 0, end: expect.any(Number) }),
    ]));
    for (const span of excerpt.sourceSpans) {
      expect(excerpt.text).toContain(longText.slice(span.start, span.end));
    }
    expect(input.messages.find(message => message.id === 'u2').text).toBe(correction);
    expect(JSON.stringify(input.summary)).toContain(correction);
    expect(result.contextSummary?.coverage.sourceChars).toBe(source.reduce((sum, message) => sum + message.text.length, 0));
  });
  it('configuration failures remain internal and consume at most one retry in each later night', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!, status: 'configuration_required' }));
    expect(await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings)).toMatchObject({ retried: 0 });
    mocks.listConversations.mockResolvedValue([]);
    const nextWindow = at(13, 3);
    vi.setSystemTime(new Date(nextWindow));
    expect(await capture.runNightlyCaptureSweep(USER, nextWindow, capture.settings)).toMatchObject({ retried: 1 });
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!, status: 'configuration_required' }));
    expect(await capture.runNightlyCaptureSweep(USER, nextWindow, capture.settings)).toMatchObject({ retried: 0 });
    expect((await records())[0]).toMatchObject({ attempt: 2, lastAttemptReviewDay: '2026-10-12' });
  });
  it('a cross-midnight window continues to review the day frozen at its start', async () => {
    const capture = await api();
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    await settings.updateRecallCaptureSettings(USER, { nightlyStart: '22:00', nightlyEnd: '02:00' });
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 12, 1));
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 10), row('a1', 10, 'assistant'), row('current-night', 11)], nextCursor: null });
    // Drive admission and execution separately; leave the coordinator handle
    // pending so the mock cannot create an unbounded rescheduling chain.
    let admit!: () => void;
    mocks.scheduleBootBackground.mockImplementation((label: string) => ({ cancel: vi.fn(),
      promise: label === 'recall:nightly-sweep' ? new Promise<void>(resolve => { admit = resolve; })
        : label === 'recall:nightly-sweep-run' ? new Promise<void>(() => {}) : Promise.resolve() }));
    const stop = capture.startNightlyCaptureSweepLoop(USER);
    const callback = mocks.scheduleBootBackground.mock.calls.at(-1)![1];
    await callback(new AbortController().signal);
    expect(await records()).toHaveLength(0);
    admit(); await Promise.resolve();
    const run = mocks.scheduleBootBackground.mock.calls.find(call => call[0] === 'recall:nightly-sweep-run')![1];
    await run(new AbortController().signal);
    stop.stop(); vi.useRealTimers();
    expect((await records())[0]).toMatchObject({ reviewDay: '2026-10-10', messageIds: ['u1', 'a1'] });
  });
  it.each([false, true])('recovers an interrupted user confirmation outside discovery without model work (discovery disabled: %s)', async disabled => {
    const capture = await api();
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!,
      status: 'writing', candidateIds: ['candidate-a'], writingCandidateId: 'candidate-a', stage: 'asset_write' }));
    vi.setSystemTime(new Date(2026, 9, 12, 12));
    if (disabled) {
      const settings = await import('../../../../src/main/features/recall/capture-settings');
      await settings.updateRecallCaptureSettings(USER, { enabled: false });
    }
    expect(await capture.recoverRecallCaptures(USER)).toBe(0);
    expect(await capture.readRecallCapture(USER, record.id)).toMatchObject({ status: 'review_ready', errorCode: 'asset_write_interrupted' });
    expect((await capture.readRecallCapture(USER, record.id)).writingCandidateId).toBeUndefined();
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it('missed windows and daytime startup never scan conversations or spend model calls', async () => {
    const capture = await api();
    vi.setSystemTime(new Date(2026, 9, 12, 12));
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    await capture.updateRecallJsonRecord(USER, 'capture-settings', 'settings', () => ({ ...capture.settings, catchUpMissed: true }));
    expect(await capture.recoverRecallCaptures(USER)).toBe(0);
    expect(await capture.runNightlyCaptureSweep(USER, WINDOW, await settings.readRecallCaptureSettings(USER)))
      .toMatchObject({ ran: false, reason: 'outside_nightly_window' });
    // Same anti-spin guard as the cross-midnight case: the loop task must stay
    // pending or the mock's resolved promise drives an unbounded reschedule
    // chain that starves this test's awaited callback.
    mocks.scheduleBootBackground.mockImplementation((label: string) => ({ cancel: vi.fn(),
      promise: label === 'recall:nightly-sweep' ? new Promise<void>(() => {}) : Promise.resolve() }));
    const loop = capture.startNightlyCaptureSweepLoop(USER);
    const callback = mocks.scheduleBootBackground.mock.calls.at(-1)![1];
    await callback(new AbortController().signal); loop.stop();
    expect(mocks.listConversations).not.toHaveBeenCalled();
    expect(mocks.getMessagesPage).not.toHaveBeenCalled();
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(await records()).toHaveLength(0);
  });
  it('does not renew a model task after the window closes; its saved range resumes next night', async () => {
    const capture = await api();
    // The sweep now settles only after its admitted capture tasks settle
    // (allSettled over control.tasks). A task promise held pending until a
    // later test step therefore deadlocks the awaited sweep below; the shared
    // default mock resolves immediately and the no-renewal contract is still
    // pinned by the scheduleBootBackground call counts below.
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    // The sweep also queues its stock-organization task on the same lane, so
    // the no-renewal contract is counted over capture tasks only.
    const captureTasks = () => mocks.scheduleBootBackground.mock.calls
      .filter(call => String(call[0]).startsWith('recall:capture:'));
    const callback = captureTasks()[0][1];
    vi.setSystemTime(new Date(2026, 9, 12, 12));
    await callback(new AbortController().signal);
    await new Promise(resolve => setImmediate(resolve));
    expect(captureTasks()).toHaveLength(1);
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect((await records())[0]).toMatchObject({ status: 'queued', attempt: 1 });
    capture.scheduleRecallCapture(USER, record.id);
    expect(await capture.recoverRecallCaptures(USER)).toBe(0);
    await new Promise(resolve => setImmediate(resolve));
    expect(captureTasks()).toHaveLength(1);
    mocks.listConversations.mockResolvedValue([]); mocks.getMessagesPage.mockClear();
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    await capture.runNightlyCaptureSweep(USER, at(13, 3), capture.settings);
    expect(captureTasks()).toHaveLength(2);
    expect(mocks.getMessagesPage).not.toHaveBeenCalled();
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'No durable value', evidence: [] }));
    expect(await capture.runRecallCapture(USER, record.id)).toMatchObject({ status: 'no_candidate' });
  });
  it('daytime startup requeues an interrupted checkpoint for the next nightly sweep without a second recovery call', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    const proposal = { judgment: 'Always keep decisions traceable.', summary: 'Traceable decisions',
      value: 'Future decisions remain auditable.', suggestedType: 'rule', suggestedScope: 'project',
      suggestedAction: 'create', risk: 'low', evidence: ['m1'] };
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [proposal] }));
    mocks.saveCandidate.mockRejectedValueOnce(new Error('interrupted candidate write'));
    const prepared = await capture.runRecallCapture(USER, record.id);
    expect(prepared.formationCheckpoint?.groups).toHaveLength(1);
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!, status: 'extracting', stage: 'candidate_save' }));
    vi.setSystemTime(new Date(2026, 9, 12, 12));
    expect(await capture.recoverRecallCaptures(USER)).toBe(0);
    expect(await capture.readRecallCapture(USER, record.id)).toMatchObject({ status: 'queued', attempt: 1,
      formationCheckpoint: prepared.formationCheckpoint, valueJudgment: prepared.valueJudgment, contextSummary: prepared.contextSummary });
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    mocks.listConversations.mockResolvedValue([]);
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'resumed-candidate', status: 'pending_review' }));
    await capture.runNightlyCaptureSweep(USER, at(13, 3), capture.settings);
    const tasks = mocks.scheduleBootBackground.mock.calls.filter(call => String(call[0]).startsWith('recall:capture:'));
    expect(tasks).toHaveLength(2);
    await tasks.at(-1)![1](new AbortController().signal);
    expect(await capture.readRecallCapture(USER, record.id)).toMatchObject({ status: 'review_ready', attempt: 1,
      candidateIds: ['resumed-candidate'], extractionCompletedAt: prepared.extractionCompletedAt });
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
  });
  it.each(['disabled', 'stopped'] as const)('repairs orphaned extraction state without dispatch when discovery is %s', async gate => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!, status: 'extracting' }));
    if (gate === 'disabled') {
      const settings = await import('../../../../src/main/features/recall/capture-settings');
      await settings.updateRecallCaptureSettings(USER, { enabled: false });
    } else {
      const { captureBudgetWindowKey } = await import('../../../../src/main/features/recall/capture-model-budget');
      await capture.updateRecallJsonRecord(USER, 'capture-sweep', 'nightly', current => ({ ...current!,
        heldWindow: captureBudgetWindowKey(new Date(), capture.settings.nightlyStart) }));
    }
    mocks.scheduleBootBackground.mockClear();
    expect(await capture.recoverRecallCaptures(USER)).toBe(0);
    expect(await capture.readRecallCapture(USER, record.id)).toMatchObject({ status: 'queued', attempt: 1 });
    expect(mocks.scheduleBootBackground).not.toHaveBeenCalled();
    expect(mocks.runModel).not.toHaveBeenCalled();
  });
  it('preserves manual daytime recovery authority without enabling ordinary nightly work', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!, status: 'extracting',
      terminalRunId: 'nightly-sweep-manual-20261012' }));
    vi.setSystemTime(new Date(at(12, 12)));
    mocks.scheduleBootBackground.mockClear();
    expect(await capture.recoverRecallCaptures(USER)).toBe(1);
    expect(await capture.readRecallCapture(USER, record.id)).toMatchObject({ status: 'queued', attempt: 1,
      terminalRunId: 'nightly-sweep-manual-20261012' });
    expect(mocks.scheduleBootBackground).toHaveBeenCalledTimes(1);
    expect(mocks.runModel).not.toHaveBeenCalled();
  });
  it('does not requeue an active capture and isolates same-id recovery for another user', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    let admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const releases: Array<() => void> = [];
    mocks.scheduleBootBackground.mockImplementation(() => {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      releases.push(release); admitted();
      return { cancel: release, promise };
    });
    capture.scheduleRecallCapture(USER, record.id);
    await admission;
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!, status: 'extracting', stage: 'context_summary' }));
    const active = await capture.readRecallCapture(USER, record.id);
    expect(await capture.recoverRecallCaptures(USER)).toBe(0);
    expect(await capture.readRecallCapture(USER, record.id)).toEqual(active);
    const otherUser = 'other-nightly-user';
    await capture.updateRecallJsonRecord(otherUser, 'captures', record.id, () => ({ ...active, ownerId: otherUser }));
    expect(await capture.recoverRecallCaptures(otherUser)).toBe(1);
    expect(await capture.readRecallCapture(otherUser, record.id)).toMatchObject({ ownerId: otherUser, status: 'queued' });
    expect(await capture.readRecallCapture(USER, record.id)).toEqual(active);
    releases.forEach(release => release());
  });
  it.each([
    ['extracting', 'completed'], ['extracting', 'cancelled'], ['writing', 'completed'], ['writing', 'cancelled'],
  ] as const)('does not overwrite %s becoming %s after the recovery inventory read', async (initial, terminal) => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!, status: initial }));
    let entered!: () => void, finish!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const finishWrite = new Promise<void>(resolve => { finish = resolve; });
    const completion = capture.updateRecallJsonRecord(USER, 'captures', record.id, async current => {
      entered(); await finishWrite;
      return { ...current!, status: terminal, stage: undefined };
    });
    await writing;
    const store = await import('../../../../src/main/features/recall/store');
    const read = store.readRecallJsonRecord;
    let inventoried!: () => void;
    const inventory = new Promise<void>(resolve => { inventoried = resolve; });
    const spy = vi.spyOn(store, 'readRecallJsonRecord').mockImplementation(async (userId, collection, id) => {
      const value = await read(userId, collection, id);
      if (collection === 'captures' && id === record.id) inventoried();
      return value;
    });
    const recovery = capture.recoverRecallCaptures(USER);
    await inventory; finish(); await completion; await recovery;
    spy.mockRestore();
    expect(await capture.readRecallCapture(USER, record.id)).toMatchObject({ status: terminal });
    expect(mocks.runModel).not.toHaveBeenCalled();
  });
  it('does not start extraction in daytime when the value model crosses the window boundary', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(2026, 9, 12, 6)); return answer(positive);
    });
    const record = (await records())[0];
    expect(await capture.runRecallCapture(USER, record.id)).toMatchObject({ status: 'queued', valueJudgment: { eligible: true } });
    expect(mocks.runModel).toHaveBeenCalledTimes(1);
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });
  it('checkpoints a summary crossing the night boundary and resumes it before value judgment next night', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runSummary.mockImplementationOnce(async input => {
      vi.setSystemTime(new Date(2026, 9, 12, 6));
      return captureSummaryModelResponse(input);
    });
    const record = (await records())[0];
    const interrupted = await capture.runRecallCapture(USER, record.id);
    expect(interrupted).toMatchObject({ status: 'queued', summaryCheckpoint: { chunks: [expect.any(Object)] } });
    expect(interrupted.contextSummary).toBeUndefined();
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'No durable value', evidence: [] }));
    const resumed = await capture.runRecallCapture(USER, record.id);
    expect(resumed).toMatchObject({ status: 'no_candidate', contextSummary: { completedAt: expect.any(String) } });
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(mocks.runModel).toHaveBeenCalledTimes(1);
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });
  it('continues successful summaries past a previously exhausted stage quota', async () => {
    const capture = await api();
    const text = 'Always keep decisions traceable. ' + 'Synthetic bounded context sentence. '.repeat(1_500);
    mocks.getMessagesPage.mockResolvedValue({ history: [row('u1', 11, 'user', text), row('a1', 11, 'assistant')], nextCursor: null });
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const budgets = await import('../../../../src/main/features/recall/capture-model-budget');
    const store = await import('../../../../src/main/features/recall/store');
    const key = 'night-' + budgets.captureBudgetWindowKey(new Date(), capture.settings.nightlyStart);
    await store.writeRecallJsonRecord(USER, 'capture-model-budgets', key, { schemaVersion: 1, ownerId: USER, id: key,
      calls: 80, inputChars: 0, reportedTokens: 0, unknownUsageCalls: 80, billingStatus: 'unavailable', updatedAt: new Date().toISOString(),
      stages: { summary: { calls: 80, inputChars: 0, reportedTokens: 0 } } });
    mocks.runModel.mockResolvedValue(answer({ eligible: false, reason: 'No durable value', evidence: [] }));
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result).toMatchObject({ status: 'no_candidate', contextSummary: { completedAt: expect.any(String) } });
    expect((await budgets.readCaptureModelBudget(USER)).calls).toBeGreaterThan(80);
    expect(mocks.runModel).toHaveBeenCalledTimes(1);
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });
  it('refuses an inconsistent budget ledger before model dispatch instead of treating it as an empty budget', async () => {
    const capture = await api(); await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const budgets = await import('../../../../src/main/features/recall/capture-model-budget');
    const store = await import('../../../../src/main/features/recall/store');
    const key = 'night-' + budgets.captureBudgetWindowKey(new Date(), capture.settings.nightlyStart);
    await store.writeRecallJsonRecord(USER, 'capture-model-budgets', key, { schemaVersion: 1, ownerId: USER, id: key,
      calls: 0, inputChars: 0, reportedTokens: 0, unknownUsageCalls: 0, billingStatus: 'unavailable', updatedAt: new Date().toISOString(),
      stages: { summary: { calls: 1, inputChars: 0, reportedTokens: 0 } } });
    const result = await capture.runRecallCapture(USER, (await records())[0].id);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'summary_failed' });
    expect(mocks.runSummary).not.toHaveBeenCalled();
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(await store.readRecallJsonRecord(USER, 'capture-model-budgets', key)).toMatchObject({ calls: 0, stages: { summary: { calls: 1 } } });
  });
  it('terminal completion never creates a capture or subscribes an automatic producer', async () => {
    const capture = await api();
    expect(capture).not.toHaveProperty('queueRecallCaptureFromTerminal');
    for (const method of ['queueManualRecallCaptureFromConversation', 'startHistoricalRecallCapture', 'runRecallCaptureNow', 'retryRecallCapture', 'pauseRecallCapture', 'resumeRecallCapture', 'cancelRecallCapture', 'retryRecallCapturesBatch', 'runRecallCapturesNowBatch']) {
      expect(capture).not.toHaveProperty(method);
    }
    expect(await records()).toHaveLength(0);
  });
  it('does not present legacy scan counts as results of the new summary/value/extraction pipeline', async () => {
    const capture = await api();
    const legacy = { schemaVersion: 1, ownerId: USER, id: 'nightly', baselineAt: WINDOW, cursors: {},
      lastRunAt: WINDOW, lastResult: { ranForWindow: WINDOW, finishedAt: WINDOW, scanned: 59, queued: 0, deferred: 0, retried: 0, skipped: 59, failed: 0 } };
    await capture.writeRecallJsonRecord(USER, 'capture-sweep', 'nightly', legacy);
    expect(await capture.readRecallNightlySweep(USER)).toMatchObject({ lastResult: undefined, lastRunAt: undefined });
    expect(await capture.readRecallJsonRecord(USER, 'capture-sweep', 'nightly')).toEqual(legacy);
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    expect((await capture.readRecallNightlySweep(USER))?.lastResult).toMatchObject({ pipelineVersion: 3, reviewDay: '2026-10-11' });
  });

});
