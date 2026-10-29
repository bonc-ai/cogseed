import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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

describe('feedback is separated from the formation asset baseline', () => {
  it.each([true, false])('keeps evaluated evidence and projects current only from the admitted pool (admitted=%s)', async admitted => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const admission = await import('../../../../src/main/features/recall/prompt-injection');
    const feedback = await import('../../../../src/main/features/recall/feedback-version-context');
    const oldCurrent = 'Previous current asset body - v6';
    const newCurrent = 'Approved current asset body - v7';
    const evaluated = 'Historical evaluated body - v5';
    let target = { id: 'feedback-race', ownerId: USER, title: 'Traceable decisions', statement: oldCurrent,
      version: '6', activeVersion: '6', status: 'active', type: 'cognition', scope: 'project', evidenceRefs: [], updatedAt: at(11) };
    vi.spyOn(assets, 'listAbilityAssets').mockImplementation(async () => admitted ? [target as any] : []);
    vi.spyOn(assets, 'readAbilityAsset').mockImplementation(async () => target as any);
    vi.spyOn(assets, 'readAbilityAssetVersionSnapshot').mockImplementation(async (_user, _id, version) =>
      version === '5' ? { ...target, version: '5', statement: evaluated } as any : null);
    vi.spyOn(admission, 'filterRecallAssetsForAgentRead').mockImplementation(async (_user, rows) => [...rows]);
    const observation = { id: 'feedback-race-event', messageId: 'u1', assetId: target.id, assetVersion: '5', taskRunId: 'synthetic-turn',
      feedback: 'negative' as const, updatedAt: WINDOW };
    const sourceVersion = { ...observation, versionContext: { status: 'historical' as const,
      evaluated: { version: '5', statement: evaluated }, current: { version: '6', statement: oldCurrent } } };
    vi.spyOn(feedback, 'readFeedbackVersionContext').mockResolvedValue([sourceVersion] as any);
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!,
      feedbackRevision: 'f'.repeat(64), feedbackObservations: [observation] }));
    mocks.runModel.mockImplementationOnce(async () => {
      target = { ...target, version: '7', activeVersion: '7', statement: newCurrent };
      return answer(positive);
    }).mockResolvedValueOnce(answer({ candidates: [{ judgment: 'Always keep decisions traceable.', summary: 'Traceable decisions',
      value: 'Future decisions remain auditable.', suggestedScope: 'project', suggestedAction: 'create', risk: 'low',
      evidence: ['m1'], uncertainty: '效果尚未验证' }] })).mockResolvedValueOnce(answer({ assessments: [{ index: 0,
        checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
          priorContentPreserved: true, evidence: [{ label: 'm1', quote: 'Always keep decisions traceable.' }] },
        uncertaintyDisposition: 'effect_unverified', ...(admitted ? { comparison: { relation: 'exception', reason: '补充来源的要求。',
          targetAssetId: target.id, targetVersion: '7', targetQuote: newCurrent },
          revision: { judgment: `${newCurrent} Always keep decisions traceable.` } } : {}),
      }] }));
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'feedback-candidate', status: 'pending_review' }));
    const result = await capture.runRecallCapture(USER, record.id);
    const summaryCalls = JSON.stringify(mocks.runSummary.mock.calls);
    const valuePayload = JSON.parse(mocks.runModel.mock.calls[0][0].message);
    const valueText = JSON.stringify(valuePayload);
    expect(summaryCalls).toContain(evaluated);
    expect(summaryCalls).not.toContain(oldCurrent);
    expect(valueText).toContain(evaluated);
    expect(valueText).not.toContain(oldCurrent);
    const extractionText = mocks.runModel.mock.calls[1][0].message;
    expect(extractionText).not.toContain(oldCurrent);
    const formed = JSON.parse(mocks.runModel.mock.calls[2][0].message);
    const projected = formed.feedback[0].versionContext;
    const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
    const expectedSourceHash = createHash('sha256').update(JSON.stringify(canonical({ sources: formed.candidates[0].sources,
      context: formed.completeConversationContext }))).digest('hex');
    expect(result.uncertaintyAssessments?.[0].sourceHash).toBe(expectedSourceHash);
    expect(projected.evaluated).toMatchObject({ version: '5', statement: evaluated });
    expect(JSON.stringify(formed)).not.toContain(oldCurrent);
    if (admitted) {
      expect(projected).toMatchObject({ status: 'historical', current: { version: '7', statement: newCurrent } });
      expect(formed.existingAssets).toEqual([expect.objectContaining({ id: target.id, version: '7', statement: newCurrent })]);
      expect(result).toMatchObject({ status: 'review_ready' });
      expect(mocks.saveCandidate.mock.calls[0][1]).toMatchObject({ targetAssetId: target.id, targetVersionUsed: '7' });
    } else {
      expect(projected).toMatchObject({ status: 'unavailable' });
      expect(projected.current).toBeUndefined();
      expect(JSON.stringify(formed)).not.toContain(newCurrent);
    }
  });

  it('preserves an authorized evaluated version and execution evidence when the active snapshot is missing', async () => {
    const capture = await api();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const admission = await import('../../../../src/main/features/recall/prompt-injection');
    const feedback = await import('../../../../src/main/features/recall/feedback-version-context');
    const evaluated = 'Previously evaluated version - v5';
    const inaccessible = 'Current version should remain unreadable';
    const target = { id: 'feedback-missing-current', ownerId: USER, title: 'Traceability', statement: inaccessible,
      version: '7', activeVersion: '6', status: 'active', type: 'cognition', scope: 'project', evidenceRefs: [] };
    vi.spyOn(assets, 'listAbilityAssets').mockResolvedValue([target as any]);
    vi.spyOn(assets, 'readAbilityAsset').mockResolvedValue(target as any);
    vi.spyOn(assets, 'readAbilityAssetVersionSnapshot').mockImplementation(async (_user, _id, version) =>
      version === '5' ? { ...target, version: '5', statement: evaluated } as any : null);
    vi.spyOn(admission, 'filterRecallAssetsForAgentRead').mockImplementation(async (_user, rows) => [...rows]);
    const observation = { id: 'feedback-missing', messageId: 'u1', assetId: target.id, assetVersion: '5', taskRunId: 'synthetic-turn',
      feedback: 'negative' as const, updatedAt: WINDOW,
      resultSource: { kind: 'group_execution' as const, executionId: 'exec-a', conversationId: 'cid', actorId: 'worker-a' } };
    const resultContext = { status: 'available' as const, fingerprint: 'execution-snapshot', text: 'The execution omitted citations.',
      refs: [], coverage: { complete: true, totalFiles: 0, readableFiles: 0 }, sourceRefs: [] };
    const resultRead = vi.spyOn(feedback, 'readFeedbackResultContext').mockResolvedValue(resultContext as any);
    const legacyRead = vi.spyOn(feedback, 'readFeedbackVersionContext').mockRejectedValue(new Error('current version unavailable'));
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    const record = (await records())[0];
    await capture.updateRecallJsonRecord(USER, 'captures', record.id, current => ({ ...current!,
      feedbackRevision: 'e'.repeat(64), feedbackObservations: [observation] }));
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [{ judgment: 'Always keep decisions traceable.',
      summary: 'Traceable decisions', value: 'Future decisions remain auditable.', suggestedScope: 'project', suggestedAction: 'create',
      risk: 'low', evidence: ['m1'], uncertainty: '效果尚未验证' }] })).mockResolvedValueOnce(answer({ assessments: [{ index: 0,
        checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true, priorContentPreserved: true,
          evidence: [{ label: 'm1', quote: 'Always keep decisions traceable.' }] }, uncertaintyDisposition: 'effect_unverified',
        comparison: { relation: 'ambiguous', reason: 'The active asset snapshot is unavailable.' },
      }] }));
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'held-feedback-candidate', status: 'pending_review' }));
    const result = await capture.runRecallCapture(USER, record.id);
    const valueInput = JSON.parse(mocks.runModel.mock.calls[0][0].message);
    expect(JSON.stringify(valueInput)).toContain(evaluated);
    expect(JSON.stringify(valueInput)).toContain(resultContext.text);
    const formed = JSON.parse(mocks.runModel.mock.calls[2][0].message);
    expect(formed.feedback[0].versionContext).toMatchObject({ status: 'unavailable', evaluated: { version: '5', statement: evaluated } });
    expect(formed.feedback[0].versionContext.current).toBeUndefined();
    expect(JSON.stringify(formed)).not.toContain(inaccessible);
    expect(result.status).not.toBe('failed');
    expect(resultRead).toHaveBeenCalled();
    expect(legacyRead).not.toHaveBeenCalled();
  });

});
