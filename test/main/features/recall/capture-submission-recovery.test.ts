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

describe('capture candidate submission receipts', () => {
  const proposal = { judgment: 'Always keep decisions traceable.', summary: 'Traceable decisions',
    value: 'Future decisions remain auditable.', suggestedScope: 'project', suggestedAction: 'create', risk: 'low', evidence: ['m1'] };
  const prepare = async () => {
    const capture = await api();
    await capture.runNightlyCaptureSweep(USER, WINDOW, capture.settings);
    mocks.runModel.mockResolvedValueOnce(answer(positive)).mockResolvedValueOnce(answer({ candidates: [proposal] }));
    return { capture, id: (await records())[0].id };
  };

  it('does not scan for a receipt when a fresh group has never been submitted', async () => {
    const { capture, id } = await prepare();
    mocks.findCandidateReceipt.mockRejectedValue(new Error('unrelated corrupt candidate'));
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'first-save', status: 'pending_review' }));
    const result = await capture.runRecallCapture(USER, id);
    expect(result).toMatchObject({ status: 'review_ready', candidateIds: ['first-save'],
      formationCheckpoint: { groups: [expect.objectContaining({ submissionStarted: true, savedCandidateId: 'first-save' })] } });
    expect(mocks.findCandidateReceipt).not.toHaveBeenCalled();
    expect(mocks.saveCandidate).toHaveBeenCalledTimes(1);
  });

  it('skips receipt recovery for an unstarted prepared group after interruption', async () => {
    const { capture, id } = await prepare();
    mocks.saveCandidate.mockRejectedValueOnce(new Error('interrupted before write'));
    const failed = await capture.runRecallCapture(USER, id);
    const unstarted = structuredClone(failed.formationCheckpoint!);
    delete unstarted.groups[0].submissionStarted;
    await capture.updateRecallJsonRecord(USER, 'captures', id, current => ({ ...current!, status: 'queued', formationCheckpoint: unstarted }));
    mocks.findCandidateReceipt.mockRejectedValue(new Error('unrelated corrupt candidate'));
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'resumed-unstarted', status: 'pending_review' }));
    const resumed = await capture.runRecallCapture(USER, id);
    expect(resumed).toMatchObject({ status: 'review_ready', candidateIds: ['resumed-unstarted'] });
    expect(mocks.findCandidateReceipt).not.toHaveBeenCalled();
    expect(mocks.saveCandidate).toHaveBeenCalledTimes(2);
  });

  it('recovers a committed candidate after interruption before the capture receipt', async () => {
    const { capture, id } = await prepare();
    let saved: any;
    mocks.saveCandidate.mockImplementationOnce(async (_user, input) => {
      saved = { ...input, id: 'committed-before-interruption', status: 'pending_review' };
      throw new Error('interrupted after candidate write');
    });
    const failed = await capture.runRecallCapture(USER, id);
    expect(failed.formationCheckpoint?.groups[0]).toMatchObject({ submissionStarted: true });
    expect(failed.formationCheckpoint?.groups[0].savedCandidateId).toBeUndefined();
    await capture.updateRecallJsonRecord(USER, 'captures', id, current => ({ ...current!, status: 'queued' }));
    mocks.findCandidateReceipt.mockResolvedValue(saved);
    mocks.readCandidate.mockResolvedValue(saved);
    const resumed = await capture.runRecallCapture(USER, id);
    expect(resumed).toMatchObject({ status: 'review_ready', candidateIds: [saved.id],
      formationCheckpoint: { groups: [expect.objectContaining({ savedCandidateId: saved.id })] } });
    expect(mocks.findCandidateReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.saveCandidate).toHaveBeenCalledTimes(1);
  });

  it('retries a started group only after confirming that no receipt exists', async () => {
    const { capture, id } = await prepare();
    mocks.saveCandidate.mockRejectedValueOnce(new Error('interrupted after marker, before write'));
    const failed = await capture.runRecallCapture(USER, id);
    expect(failed.formationCheckpoint?.groups[0]).toMatchObject({ submissionStarted: true });
    await capture.updateRecallJsonRecord(USER, 'captures', id, current => ({ ...current!, status: 'queued' }));
    mocks.findCandidateReceipt.mockResolvedValue(undefined);
    mocks.saveCandidate.mockImplementation(async (_user, input) => ({ ...input, id: 'resumed-started', status: 'pending_review' }));
    const resumed = await capture.runRecallCapture(USER, id);
    expect(resumed).toMatchObject({ status: 'review_ready', candidateIds: ['resumed-started'] });
    expect(mocks.findCandidateReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.saveCandidate).toHaveBeenCalledTimes(2);
  });
});
