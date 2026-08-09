import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  configured: true,
  oauthExpired: null as string | null,
  getMessages: vi.fn(),
  getConversation: vi.fn(),
  buildRunner: vi.fn(),
  runModel: vi.fn(),
  saveCandidate: vi.fn(),
  readCandidate: vi.fn(),
  scheduleBootBackground: vi.fn(),
}));

vi.mock('../../../../src/main/features/auth', () => ({
  hasConfiguredModel: () => ({ configured: mocks.configured }),
  getConfiguredModelOAuthExpiredMessage: () => mocks.oauthExpired,
}));
vi.mock('../../../../src/main/features/chats', () => ({
  getMessages: mocks.getMessages,
  getConversation: mocks.getConversation,
  listConversations: vi.fn(async () => []),
}));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({ buildRunner: mocks.buildRunner }));
vi.mock('../../../../src/main/features/recall/candidate-service', () => ({
  saveRecallCandidate: mocks.saveCandidate,
  readRecallCandidate: mocks.readCandidate,
}));
vi.mock('../../../../src/main/util/boot_init', () => ({
  scheduleBootBackground: mocks.scheduleBootBackground,
}));

let tmpDir: string;
let previousRoot: string | undefined;

const messages = [
  {
    id: 'user-1',
    ts: '2026-08-01T00:01:00.000Z',
    from: 'user',
    to: ['commander'],
    text: 'Always keep decisions traceable.',
    attachments: ['/private/attachment.txt'],
  },
  {
    id: 'dispatch-1',
    ts: '2026-08-01T00:02:00.000Z',
    from: 'commander',
    to: ['worker'],
    text: 'hidden worker instructions',
    dispatch: true,
  },
  {
    id: 'failed-1',
    ts: '2026-08-01T00:03:00.000Z',
    from: 'commander',
    to: ['user'],
    text: 'failed model output',
    failure_kind: 'model',
  },
  {
    id: 'assistant-1',
    ts: '2026-08-01T00:04:00.000Z',
    from: 'commander',
    to: ['user'],
    text: 'The decision log is ready.',
    model_text: 'private internal model text',
    process: [{ type: 'progress', text: 'private tool trace' }],
    artifacts: [{ id: 'artifact-1', title: 'Decision log', agent_id: 'commander' }],
  },
] as any[];

const completedEvent = {
  run_id: 'run-1',
  user_id: 'capture-user',
  conversation_id: 'conv-1',
  status: 'completed' as const,
  started_at_ms: Date.parse('2026-08-01T00:00:00.000Z'),
  finished_at_ms: Date.parse('2026-08-01T00:10:00.000Z'),
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-capture-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  mocks.configured = true;
  mocks.oauthExpired = null;
  mocks.getMessages.mockReset().mockResolvedValue(messages);
  mocks.getConversation.mockResolvedValue({ conversation_id: 'conv-1', title: 'Decision work' });
  mocks.buildRunner.mockResolvedValue({ runner: { run: mocks.runModel } });
  mocks.runModel.mockResolvedValue({
    text: JSON.stringify({ candidates: [] }),
    content: [],
    meta: { aborted: false },
  });
  mocks.saveCandidate.mockImplementation(async (_userId: string, input: { captureKey: string }) => ({
    id: `cand-${input.captureKey.slice(-1)}`,
    status: 'pending',
    ...input,
  }));
  mocks.readCandidate.mockRejectedValue(new Error('candidate not found'));
  mocks.scheduleBootBackground.mockImplementation(() => ({
    cancel: vi.fn(),
    promise: new Promise<void>(() => {}),
  }));
});

afterEach(() => {
  vi.useRealTimers();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function captureModule() {
  return import('../../../../src/main/features/recall/capture-service');
}

describe('Recall conversation capture', () => {
  it('keeps only visible successful messages and enforces the prompt budget', async () => {
    const capture = await captureModule();
    const selected = capture.selectCaptureMessages([
      ...messages,
      {
        id: 'assistant-large',
        ts: '2026-08-01T00:05:00.000Z',
        from: 'commander',
        to: ['user'],
        text: 'x'.repeat(50_000),
      },
    ] as any, completedEvent.started_at_ms, completedEvent.finished_at_ms);

    expect(selected.map((message) => message.id)).toEqual(['user-1', 'assistant-1', 'assistant-large']);
    expect(selected.reduce((total, message) => total + message.text.length, 0)).toBeLessThanOrEqual(22_000);
    expect(JSON.stringify(selected)).not.toContain('hidden worker instructions');
    expect(JSON.stringify(selected)).not.toContain('failed model output');
    expect(JSON.stringify(selected)).not.toContain('private internal model text');
    expect(JSON.stringify(selected)).not.toContain('private tool trace');
    expect(JSON.stringify(selected)).not.toContain('/private/attachment.txt');
  });

  it('keeps second-precision messages when the terminal run starts later in the same second', async () => {
    const capture = await captureModule();
    const selected = capture.selectCaptureMessages([
      {
        id: 'user-second-precision',
        ts: '2026-08-06T17:27:47',
        from: 'user',
        to: ['commander'],
        text: 'Start this task.',
      },
      {
        id: 'assistant-second-precision',
        ts: '2026-08-06T17:27:48',
        from: 'commander',
        to: ['user'],
        text: 'The task is complete.',
      },
    ] as any, Date.parse('2026-08-06T17:27:47.519'), Date.parse('2026-08-06T17:27:48.900'));

    expect(selected.map((message) => message.id)).toEqual([
      'user-second-precision',
      'assistant-second-precision',
    ]);
  });

  it('uses terminal message ids to exclude adjacent runs in the same second', async () => {
    const capture = await captureModule();
    const selected = capture.selectCaptureMessages([
      {
        id: 'previous-user',
        ts: '2026-08-06T17:27:47',
        from: 'user',
        to: ['commander'],
        text: 'Previous task.',
      },
      {
        id: 'current-user',
        ts: '2026-08-06T17:27:47',
        from: 'user',
        to: ['commander'],
        text: 'Current task.',
      },
      {
        id: 'current-assistant',
        ts: '2026-08-06T17:27:48',
        from: 'commander',
        to: ['user'],
        text: 'Current task complete.',
      },
      {
        id: 'next-user',
        ts: '2026-08-06T17:27:48',
        from: 'user',
        to: ['commander'],
        text: 'Next task.',
      },
    ] as any,
    Date.parse('2026-08-06T17:27:47.519'),
    Date.parse('2026-08-06T17:27:48.900'),
    'current-user',
    'current-assistant');

    expect(selected.map((message) => message.id)).toEqual([
      'current-user',
      'current-assistant',
    ]);
  });

  it('forwards every terminal outcome to the capture state machine', async () => {
    const capture = await captureModule();
    let listener: ((event: any) => void) | undefined;
    const queue = vi.fn(async () => undefined);
    const stop = capture.startRecallCaptureOrchestrator({
      subscribe: (next) => { listener = next; return vi.fn(); },
      queue,
    });

    for (const status of ['failed', 'cancelled', 'waiting_input']) listener?.({ ...completedEvent, status });
    listener?.(completedEvent);
    await Promise.resolve();

    expect(queue).toHaveBeenCalledTimes(4);
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ status: 'waiting_input' }));
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
    expect(queue).toHaveBeenCalledWith(completedEvent);
    stop();
  });

  it('creates one durable quiet-wait task for duplicate terminal delivery', async () => {
    const capture = await captureModule();
    const first = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const duplicate = await capture.queueRecallCaptureFromTerminal(completedEvent);

    expect(first?.id).toBe(duplicate?.id);
    expect(first?.scheduledFor).toBe(duplicate?.scheduledFor);
    expect(first).toMatchObject({
      status: 'waiting_quiet',
      executionPolicy: 'smart',
      quietMinutes: 10,
      scheduledFor: expect.any(String),
      terminalRunId: 'run-1',
      anchorMessageId: 'user-1',
      messageIds: ['user-1', 'assistant-1'],
      attempt: 1,
    });
    expect(await capture.listRecallCaptures('capture-user')).toHaveLength(1);
  });

  it('creates a task from the persisted terminal message bounds', async () => {
    const capture = await captureModule();
    mocks.getMessages.mockResolvedValue([
      {
        id: 'user-bounded',
        ts: '2026-08-06T17:27:47',
        from: 'user',
        to: ['commander'],
        text: 'Complete the bounded task.',
      },
      {
        id: 'assistant-bounded',
        ts: '2026-08-06T17:33:58',
        from: 'commander',
        to: ['user'],
        text: 'The bounded task is complete.',
      },
    ]);

    const queued = await capture.queueRecallCaptureFromTerminal({
      ...completedEvent,
      run_id: 'run-bounded',
      started_at_ms: Date.parse('2026-08-06T17:27:47.519'),
      finished_at_ms: Date.parse('2026-08-06T17:33:58.941'),
      anchor_message_id: 'user-bounded',
      finished_message_id: 'assistant-bounded',
    });

    expect(queued).toMatchObject({
      terminalRunId: 'run-bounded',
      anchorMessageId: 'user-bounded',
      messageIds: ['user-bounded', 'assistant-bounded'],
      status: 'waiting_quiet',
    });
  });

  it('creates an idempotent waiting task when a historical conversation is selected manually', async () => {
    const capture = await captureModule();
    const first = await capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1');
    const duplicate = await capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1');

    expect(first).toMatchObject({
      id: duplicate.id,
      conversationId: 'conv-1',
      conversationTitle: 'Decision work',
      anchorMessageId: 'user-1',
      messageIds: ['user-1', 'assistant-1'],
      status: 'waiting_manual',
      executionPolicy: 'manual',
    });
    expect(await capture.listRecallCaptures('capture-user')).toHaveLength(1);

    mocks.getMessages.mockResolvedValue([...messages, {
      id: 'user-unanswered',
      ts: '2026-08-01T00:06:00.000Z',
      from: 'user',
      to: ['commander'],
      text: 'One more request.',
    }]);
    await expect(capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1'))
      .rejects.toThrow(/waiting for a response/i);
  });

  it('merges continued turns into the same task and restarts the quiet period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:10:00.000Z'));
    const capture = await captureModule();
    const first = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const continuedMessages = [
      ...messages,
      { id: 'user-2', ts: '2026-08-01T00:11:00.000Z', from: 'user', to: ['commander'], text: 'Keep the next review concise.' },
      { id: 'assistant-2', ts: '2026-08-01T00:12:00.000Z', from: 'commander', to: ['user'], text: 'The review is concise.' },
    ];
    mocks.getMessages.mockResolvedValue(continuedMessages);
    vi.setSystemTime(new Date('2026-08-01T00:12:00.000Z'));

    const second = await capture.queueRecallCaptureFromTerminal({
      ...completedEvent,
      run_id: 'run-2',
      started_at_ms: Date.parse('2026-08-01T00:10:30.000Z'),
      finished_at_ms: Date.parse('2026-08-01T00:13:00.000Z'),
    });

    expect(second?.id).toBe(first?.id);
    expect(second).toMatchObject({
      terminalRunId: 'run-2',
      anchorMessageId: 'user-1',
      messageIds: ['user-1', 'assistant-1', 'user-2', 'assistant-2'],
      status: 'waiting_quiet',
    });
    expect(Date.parse(second!.scheduledFor!)).toBe(Date.parse(first!.scheduledFor!) + 2 * 60_000);
    expect(await capture.listRecallCaptures('capture-user')).toHaveLength(1);
  });

  it('holds an automatic task for input and moves failed or cancelled conversations to manual handling', async () => {
    const capture = await captureModule();
    const first = await capture.queueRecallCaptureFromTerminal(completedEvent);

    await expect(capture.queueRecallCaptureFromTerminal({
      ...completedEvent,
      run_id: 'run-waiting',
      status: 'waiting_input',
    })).resolves.toMatchObject({
      id: first!.id,
      status: 'waiting_completion',
      scheduledFor: undefined,
    });

    await expect(capture.queueRecallCaptureFromTerminal({
      ...completedEvent,
      run_id: 'run-failed',
      status: 'failed',
    })).resolves.toMatchObject({
      id: first!.id,
      status: 'waiting_manual',
      errorCode: 'conversation_failed',
    });

    await expect(capture.queueRecallCaptureFromTerminal({
      ...completedEvent,
      run_id: 'run-cancelled',
      status: 'cancelled',
    })).resolves.toMatchObject({
      id: first!.id,
      status: 'waiting_manual',
      errorCode: 'conversation_cancelled',
    });
    await expect(capture.pauseRecallCapture('capture-user', first!.id)).resolves.toMatchObject({
      status: 'paused',
      resumeStatus: 'waiting_manual',
      errorCode: 'conversation_cancelled',
    });
    await expect(capture.resumeRecallCapture('capture-user', first!.id)).resolves.toMatchObject({
      status: 'waiting_manual',
      errorCode: 'conversation_cancelled',
    });
  });

  it('checks the visible message boundary when the quiet period expires', async () => {
    const capture = await captureModule();
    const waiting = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', waiting!.id, (current) => ({
      ...current!,
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    }));
    mocks.getMessages.mockResolvedValue([...messages, {
      id: 'user-continued',
      ts: new Date().toISOString(),
      from: 'user',
      to: ['commander'],
      text: 'Continue this conversation.',
    }]);
    const scheduledCall = mocks.scheduleBootBackground.mock.calls.find(([name]) => name === `recall:capture:${waiting!.id}`);

    await scheduledCall![1](new AbortController().signal);

    const held = await capture.readRecallCapture('capture-user', waiting!.id);
    expect(held).toMatchObject({ status: 'waiting_completion' });
    expect(held).not.toHaveProperty('scheduledFor');
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it('runs after an unchanged conversation reaches the quiet boundary', async () => {
    const capture = await captureModule();
    const waiting = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', waiting!.id, (current) => ({
      ...current!,
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    }));
    const scheduledCall = mocks.scheduleBootBackground.mock.calls.find(([name]) => name === `recall:capture:${waiting!.id}`);

    await scheduledCall![1](new AbortController().signal);

    expect(mocks.runModel).toHaveBeenCalledTimes(1);
    await expect(capture.readRecallCapture('capture-user', waiting!.id)).resolves.toMatchObject({ status: 'no_candidate' });
  });

  it('claims a queued capture once when two workers race', async () => {
    let releaseModel!: (value: { text: string; content: never[]; meta: { aborted: boolean } }) => void;
    const modelResult = new Promise<{ text: string; content: never[]; meta: { aborted: boolean } }>((resolve) => {
      releaseModel = resolve;
    });
    let markModelStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    mocks.runModel.mockImplementationOnce(async () => {
      markModelStarted();
      return modelResult;
    });

    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const first = capture.runRecallCapture('capture-user', queued!.id);
    const second = capture.runRecallCapture('capture-user', queued!.id);

    await modelStarted;
    releaseModel({ text: JSON.stringify({ candidates: [] }), content: [], meta: { aborted: false } });
    await Promise.all([first, second]);

    expect(mocks.runModel).toHaveBeenCalledTimes(1);
    await expect(capture.readRecallCapture('capture-user', queued!.id))
      .resolves.toMatchObject({ status: 'no_candidate' });
  });

  it('requeues a capture after cooperative background cancellation', async () => {
    let markModelStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    mocks.runModel.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      markModelStarted();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { text: '', content: [], meta: { aborted: true } };
    });

    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const controller = new AbortController();
    const running = capture.runRecallCapture('capture-user', queued!.id, controller.signal);

    await modelStarted;
    controller.abort();

    await expect(running).resolves.toMatchObject({ status: 'queued' });
    await expect(capture.readRecallCapture('capture-user', queued!.id))
      .resolves.toMatchObject({ status: 'queued' });
  });

  it('does not let an old paused run overwrite an immediate resume', async () => {
    let markModelStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => { markModelStarted = resolve; });
    mocks.runModel.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      markModelStarted();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { text: '', content: [], meta: { aborted: true } };
    });

    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const controller = new AbortController();
    const running = capture.runRecallCapture('capture-user', queued!.id, controller.signal);
    await modelStarted;

    await expect(capture.pauseRecallCapture('capture-user', queued!.id)).resolves.toMatchObject({ status: 'paused' });
    await expect(capture.resumeRecallCapture('capture-user', queued!.id)).resolves.toMatchObject({ status: 'queued' });
    controller.abort();

    await expect(running).resolves.toMatchObject({ status: 'queued' });
    await expect(capture.readRecallCapture('capture-user', queued!.id)).resolves.toMatchObject({ status: 'queued' });
  });

  it('uses an ephemeral no-tools runner and saves pending candidates with message evidence', async () => {
    mocks.getConversation.mockResolvedValueOnce({
      conversation_id: 'conv-1',
      title: 'Decision work',
      project_id: 'workspace-a',
    });
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Keep a traceable decision log.',
          summary: 'Decision traceability',
          suggestedType: 'rule',
          suggestedScope: 'project',
          evidence: ['m1', 'm2'],
        }],
      }),
      content: [],
      meta: { aborted: false, usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } },
    });
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const completed = await capture.runRecallCapture('capture-user', queued!.id);

    expect(mocks.buildRunner).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: `memory-extract-recall-${queued!.id}`,
      userId: 'capture-user',
      disableTools: true,
      ephemeralSession: true,
      skillList: [],
    }));
    expect(mocks.runModel).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: 'off', cacheRetention: 'none' }));
    const modelInput = mocks.runModel.mock.calls[0][0].message;
    const modelPayload = JSON.parse(modelInput);
    expect(modelInput).toContain('Always keep decisions traceable.');
    expect(modelInput).toContain('The decision log is ready.');
    expect(modelInput).not.toContain('hidden worker instructions');
    expect(modelInput).not.toContain('private tool trace');
    expect(modelInput).not.toContain('/private/attachment.txt');
    expect(modelPayload.recallView).toMatchObject({
      id: expect.stringMatching(/^rv-/),
      purpose: 'conversation_capture',
      assetRefs: [],
      degradedRefs: [],
    });
    expect(modelPayload.recallView.sourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'conversation', subtype: 'session', id: 'conv-1' }),
      expect.objectContaining({ kind: 'conversation', subtype: 'message' }),
      expect.objectContaining({ kind: 'artifact_file', subtype: 'artifact' }),
    ]));
    expect(mocks.saveCandidate).toHaveBeenCalledWith('capture-user', expect.objectContaining({
      captureKey: `capture-${queued!.id}-0`,
      suggestedType: 'rule',
      sourceRefs: expect.arrayContaining([
        expect.objectContaining({ kind: 'conversation', subtype: 'session', id: 'conv-1' }),
        expect.objectContaining({ kind: 'conversation', subtype: 'message' }),
        expect.objectContaining({ kind: 'artifact_file', subtype: 'artifact' }),
      ]),
    }));
    expect(completed).toMatchObject({
      status: 'review_ready',
      candidateIds: ['cand-0'],
      recallViewId: modelPayload.recallView.id,
      stage: 'candidate_save',
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      durationMs: expect.any(Number),
      modelUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    const persisted = await capture.readRecallCapture('capture-user', queued!.id);
    expect(persisted.recallViewId).toBe(modelPayload.recallView.id);
    const views = await import('../../../../src/main/features/recall/recall-view-service');
    const recallView = await views.readRecallView('capture-user', persisted.recallViewId!);
    expect(recallView).toMatchObject({
      id: modelPayload.recallView.id,
      ownerId: 'capture-user',
      workspaceId: 'workspace-a',
      purpose: 'conversation_capture',
      taxonomyVersion: 2,
    });
    expect(recallView.sourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'conversation', subtype: 'session', id: 'conv-1' }),
      expect.objectContaining({ kind: 'conversation', subtype: 'message' }),
      expect.objectContaining({ kind: 'artifact_file', subtype: 'artifact' }),
    ]));
    expect(recallView.sourceRefs.every((ref) => ref.excerpt === undefined)).toBe(true);
    expect(JSON.stringify(recallView)).not.toContain('/private/attachment.txt');
  });

  it('rejects pause and cancel once candidate persistence has started', async () => {
    let markSaveStarted!: () => void;
    let releaseSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Keep durable decisions traceable.',
          summary: 'Decision traceability',
          suggestedType: 'rule',
          suggestedScope: 'project',
          evidence: ['m1'],
        }],
      }),
      content: [],
      meta: { aborted: false },
    });
    mocks.saveCandidate.mockImplementationOnce(async (_userId: string, input: { captureKey: string }) => {
      markSaveStarted();
      await saveGate;
      return { id: 'cand-finalizing', status: 'pending', ...input };
    });

    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const running = capture.runRecallCapture('capture-user', queued!.id);
    await saveStarted;

    await expect(capture.pauseRecallCapture('capture-user', queued!.id)).rejects.toThrow(/finalizing candidates/i);
    await expect(capture.cancelRecallCapture('capture-user', queued!.id)).rejects.toThrow(/finalizing candidates/i);
    releaseSave();

    await expect(running).resolves.toMatchObject({ status: 'review_ready', candidateIds: ['cand-finalizing'] });
  });

  it('rebuilds a persisted RecallView when it is expired or no longer matches the conversation workspace', async () => {
    mocks.getConversation.mockResolvedValueOnce({
      conversation_id: 'conv-1',
      title: 'Decision work',
      project_id: 'workspace-current',
    });
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const views = await import('../../../../src/main/features/recall/recall-view-service');
    const stale = await views.createRecallView('capture-user', {
      purpose: 'conversation_capture',
      workspaceId: 'workspace-old',
      sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => ({
      ...current!,
      recallViewId: stale.id,
    }));

    const completed = await capture.runRecallCapture('capture-user', queued!.id);
    expect(completed.recallViewId).toMatch(/^rv-/);
    expect(completed.recallViewId).not.toBe(stale.id);
    await expect(views.readRecallView('capture-user', completed.recallViewId!)).resolves.toMatchObject({
      purpose: 'conversation_capture',
      workspaceId: 'workspace-current',
    });
  });

  it('rebuilds a RecallView after a teaching signal is no longer active', async () => {
    mocks.getConversation.mockResolvedValueOnce({
      conversation_id: 'conv-1',
      title: 'Decision work',
      project_id: 'workspace-a',
    });
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const views = await import('../../../../src/main/features/recall/recall-view-service');
    const stale = await views.createRecallView('capture-user', {
      purpose: 'conversation_capture',
      workspaceId: 'workspace-a',
      sourceRefs: [
        { kind: 'conversation', id: 'conv-1' },
        { kind: 'user_teaching_signal', subtype: 'teaching', id: 'teach-revoked', scope: 'project' },
      ],
    });
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => ({
      ...current!,
      recallViewId: stale.id,
    }));

    const completed = await capture.runRecallCapture('capture-user', queued!.id);

    expect(completed.recallViewId).not.toBe(stale.id);
    const rebuilt = await views.readRecallView('capture-user', completed.recallViewId!);
    expect(rebuilt.sourceRefs.some((ref) => ref.id === 'teach-revoked')).toBe(false);
  });

  it('reuses only the matching teaching candidate and preserves other knowledge from the same message', async () => {
    const teaching = await import('../../../../src/main/features/recall/teaching-service');
    const signal = await teaching.recordTeachingSignalAfterMemoryWrite('capture-user', {
      conversationId: 'conv-1',
      messageId: 'user-1',
      userMessage: '请记住：Always keep decisions traceable.',
      memoryContent: 'Always keep decisions traceable.',
      memoryScope: 'project',
    });
    expect(signal).toBeTruthy();
    mocks.readCandidate.mockResolvedValue({
      id: signal!.candidateIds[0],
      status: 'pending',
      judgment: 'Always keep decisions traceable.',
    });
    mocks.saveCandidate.mockClear();
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [
          {
            judgment: 'Always keep decisions traceable.',
            summary: 'Traceable decisions',
            suggestedType: 'rule',
            suggestedScope: 'project',
            evidence: ['m1'],
          },
          {
            judgment: 'Use the completed decision log as the review template.',
            summary: 'Review template',
            suggestedType: 'template',
            suggestedScope: 'project',
            evidence: ['m1'],
          },
        ],
      }),
      content: [],
      meta: { aborted: false },
    });

    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const completed = await capture.runRecallCapture('capture-user', queued!.id);

    expect(completed.candidateIds).toEqual(expect.arrayContaining([signal!.candidateIds[0], 'cand-1']));
    expect(mocks.saveCandidate).toHaveBeenCalledTimes(1);
    expect(mocks.saveCandidate).toHaveBeenCalledWith('capture-user', expect.objectContaining({
      judgment: 'Use the completed decision log as the review template.',
      captureKey: `capture-${queued!.id}-1`,
    }));
  });

  it('matches candidates across every teaching signal attached to the same user message', async () => {
    mocks.saveCandidate.mockImplementation(async (_userId: string, input: { captureKey: string }) => ({
      id: `cand-${input.captureKey}`,
      status: 'pending',
      ...input,
    }));
    const teaching = await import('../../../../src/main/features/recall/teaching-service');
    const firstSignal = await teaching.recordTeachingSignalAfterMemoryWrite('capture-user', {
      conversationId: 'conv-1',
      messageId: 'user-1',
      userMessage: '请记住这两项决策规则。',
      memoryContent: 'Always keep decisions traceable.',
      memoryScope: 'project',
    });
    const secondSignal = await teaching.recordTeachingSignalAfterMemoryWrite('capture-user', {
      conversationId: 'conv-1',
      messageId: 'user-1',
      userMessage: '请记住这两项决策规则。',
      memoryContent: 'Use the completed decision log as the review template.',
      memoryScope: 'project',
    });
    mocks.readCandidate.mockImplementation(async (_userId: string, candidateId: string) => ({
      id: candidateId,
      status: 'pending',
      judgment: candidateId === secondSignal!.candidateIds[0]
        ? 'Use the completed decision log as the review template.'
        : 'Always keep decisions traceable.',
    }));
    mocks.saveCandidate.mockClear();
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Use the completed decision log as the review template.',
          summary: 'Review template',
          suggestedType: 'template',
          suggestedScope: 'project',
          evidence: ['m1'],
        }],
      }),
      content: [],
      meta: { aborted: false },
    });

    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const completed = await capture.runRecallCapture('capture-user', queued!.id);

    expect(firstSignal).toBeTruthy();
    expect(completed.candidateIds).toEqual([secondSignal!.candidateIds[0]]);
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });

  it('records zero candidates, invalid output, model setup, retry, and crash recovery explicitly', async () => {
    const capture = await captureModule();

    const zeroQueued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', zeroQueued!.id);
    await expect(capture.runRecallCapture('capture-user', zeroQueued!.id))
      .resolves.toMatchObject({ status: 'no_candidate', candidateIds: [] });

    const secondMessages = messages.map((message) => (
      message.id === 'user-1'
        ? { ...message, id: 'user-2', ts: '2026-08-01T01:01:00.000Z' }
        : { ...message, id: `${message.id}-2`, ts: '2026-08-01T01:04:00.000Z' }
    ));
    mocks.getMessages.mockResolvedValue(secondMessages);
    const secondEvent = {
      ...completedEvent,
      run_id: 'run-2',
      started_at_ms: Date.parse('2026-08-01T01:00:00.000Z'),
      finished_at_ms: Date.parse('2026-08-01T01:10:00.000Z'),
    };
    const invalidQueued = await capture.queueRecallCaptureFromTerminal(secondEvent);
    await capture.runRecallCaptureNow('capture-user', invalidQueued!.id);
    mocks.runModel.mockResolvedValueOnce({ text: '```json\n{}\n```', content: [], meta: { aborted: false } });
    const failed = await capture.runRecallCapture('capture-user', invalidQueued!.id);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'invalid_model_output' });

    const retried = await capture.retryRecallCapture('capture-user', failed.id);
    expect(retried).toMatchObject({ status: 'queued', attempt: 2 });

    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', retried.id, (current) => ({
      ...current!,
      status: 'extracting',
    }));
    await expect(capture.recoverRecallCaptures('capture-user')).resolves.toBe(1);
    await expect(capture.readRecallCapture('capture-user', retried.id)).resolves.toMatchObject({
      status: 'queued',
      recoveredAt: expect.any(String),
    });

    const thirdMessages = secondMessages.map((message) => (
      message.id === 'user-2'
        ? { ...message, id: 'user-3', ts: '2026-08-01T02:01:00.000Z' }
        : { ...message, id: `${message.id}-3`, ts: '2026-08-01T02:04:00.000Z' }
    ));
    mocks.getMessages.mockResolvedValue(thirdMessages);
    const thirdEvent = {
      ...completedEvent,
      run_id: 'run-3',
      started_at_ms: Date.parse('2026-08-01T02:00:00.000Z'),
      finished_at_ms: Date.parse('2026-08-01T02:10:00.000Z'),
    };
    const configQueued = await capture.queueRecallCaptureFromTerminal(thirdEvent);
    await capture.runRecallCaptureNow('capture-user', configQueued!.id);
    mocks.configured = false;
    await expect(capture.runRecallCapture('capture-user', configQueued!.id))
      .resolves.toMatchObject({ status: 'configuration_required', errorCode: 'model_not_configured' });
  });

  it('creates manual and nightly tasks from the persisted execution policy and skips capture when disabled', async () => {
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    const capture = await captureModule();

    await settings.updateRecallCaptureSettings('capture-user', { executionPolicy: 'manual' });
    const manual = await capture.queueRecallCaptureFromTerminal(completedEvent);
    expect(manual).toMatchObject({ status: 'waiting_manual', executionPolicy: 'manual' });
    await expect(capture.runRecallCaptureNow('capture-user', manual!.id)).resolves.toMatchObject({ status: 'queued' });
    await expect(capture.pauseRecallCapture('capture-user', manual!.id)).resolves.toMatchObject({ status: 'paused' });
    await expect(capture.resumeRecallCapture('capture-user', manual!.id)).resolves.toMatchObject({ status: 'queued' });
    await expect(capture.cancelRecallCapture('capture-user', manual!.id)).resolves.toMatchObject({ status: 'cancelled' });

    const nightlyMessages = messages.map((message) => message.id === 'user-1'
      ? { ...message, id: 'user-night', ts: '2026-08-01T03:01:00.000Z' }
      : { ...message, id: `${message.id}-night`, ts: '2026-08-01T03:04:00.000Z' });
    mocks.getMessages.mockResolvedValueOnce(nightlyMessages);
    await settings.updateRecallCaptureSettings('capture-user', {
      executionPolicy: 'nightly',
      nightlyStart: '23:00',
      nightlyEnd: '23:30',
    });
    const nightly = await capture.queueRecallCaptureFromTerminal({
      ...completedEvent,
      run_id: 'run-night',
      started_at_ms: Date.parse('2026-08-01T03:00:00.000Z'),
      finished_at_ms: Date.parse('2026-08-01T03:10:00.000Z'),
    });
    expect(nightly).toMatchObject({
      status: 'scheduled',
      executionPolicy: 'nightly',
      scheduledFor: expect.any(String),
      nightlyStart: '23:00',
      nightlyEnd: '23:30',
    });
    await expect(capture.readRecallCapture('capture-user', manual!.id)).resolves.toMatchObject({
      status: 'cancelled',
      executionPolicy: 'manual',
    });
    expect(mocks.scheduleBootBackground).toHaveBeenCalledWith(
      `recall:capture:${nightly!.id}`,
      expect.any(Function),
      expect.any(Number),
      expect.objectContaining({ resourceClass: 'model', preferIdle: true }),
    );
    const nightlySchedule = mocks.scheduleBootBackground.mock.calls.find(([name]) => name === `recall:capture:${nightly!.id}`);
    expect(nightlySchedule?.[3]).not.toHaveProperty('maxSliceMs');

    await settings.updateRecallCaptureSettings('capture-user', { enabled: false });
    await expect(capture.queueRecallCaptureFromTerminal({
      ...completedEvent,
      run_id: 'run-disabled',
      started_at_ms: Date.parse('2026-08-01T04:00:00.000Z'),
      finished_at_ms: Date.parse('2026-08-01T04:10:00.000Z'),
    })).resolves.toBeUndefined();
  });

  it('moves a missed nightly task to the next window when catch-up is disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    await settings.updateRecallCaptureSettings('capture-user', {
      executionPolicy: 'nightly',
      nightlyStart: '02:00',
      nightlyEnd: '06:00',
      catchUpMissed: false,
    });
    const capture = await captureModule();
    const scheduled = await capture.queueRecallCaptureFromTerminal({
      ...completedEvent,
      anchor_message_id: 'user-1',
      finished_message_id: 'assistant-1',
    });
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', scheduled!.id, (current) => ({
      ...current!,
      scheduledFor: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    }));
    const scheduledCall = mocks.scheduleBootBackground.mock.calls.find(([name]) => name === `recall:capture:${scheduled!.id}`);
    expect(scheduledCall).toBeTruthy();

    await scheduledCall![1](new AbortController().signal);

    const deferred = await capture.readRecallCapture('capture-user', scheduled!.id);
    expect(deferred.status).toBe('scheduled');
    expect(Date.parse(deferred.scheduledFor!)).toBeGreaterThan(Date.now());
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it('leaves manual, paused, and cancelled tasks unchanged during boot recovery', async () => {
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    const capture = await captureModule();
    await settings.updateRecallCaptureSettings('capture-user', { executionPolicy: 'manual' });
    const manual = await capture.queueRecallCaptureFromTerminal(completedEvent);

    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', manual!.id, (current) => ({
      ...current!, status: 'paused', resumeStatus: 'waiting_manual',
    }));
    await expect(capture.recoverRecallCaptures('capture-user')).resolves.toBe(0);
    await expect(capture.readRecallCapture('capture-user', manual!.id)).resolves.toMatchObject({
      status: 'paused', resumeStatus: 'waiting_manual',
    });

    await store.updateRecallJsonRecord('capture-user', 'captures', manual!.id, (current) => ({
      ...current!, status: 'cancelled', resumeStatus: undefined,
    }));
    await expect(capture.recoverRecallCaptures('capture-user')).resolves.toBe(0);
    await expect(capture.readRecallCapture('capture-user', manual!.id)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('recovers and reschedules a persisted quiet-wait task after restart', async () => {
    const capture = await captureModule();
    const waiting = await capture.queueRecallCaptureFromTerminal(completedEvent);
    expect(waiting).toMatchObject({ status: 'waiting_quiet', scheduledFor: expect.any(String) });

    mocks.scheduleBootBackground.mockClear();
    vi.resetModules();
    const restarted = await captureModule();

    await expect(restarted.recoverRecallCaptures('capture-user')).resolves.toBe(1);
    expect(mocks.scheduleBootBackground).toHaveBeenCalledWith(
      `recall:capture:${waiting!.id}`,
      expect.any(Function),
      expect.any(Number),
      expect.objectContaining({ resourceClass: 'model' }),
    );
  });

  it('returns paged task counts and normalizes legacy records to immediate execution', async () => {
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => {
      const legacy = { ...current! };
      delete legacy.executionPolicy;
      return legacy;
    });

    const page = await capture.queryRecallCaptures('capture-user', { statuses: ['waiting_quiet'], limit: 1 });
    expect(page.captures).toHaveLength(1);
    expect(page.captures[0]).toMatchObject({ executionPolicy: 'immediate' });
    expect(page.counts.waiting).toBe(1);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects unknown evidence, invalid types, and more than three candidates as a whole', async () => {
    const capture = await captureModule();
    const validLabels = new Set(['m1']);

    expect(() => capture.parseRecallCaptureOutput(JSON.stringify({ candidates: [{
      judgment: 'x', summary: 'x', suggestedType: 'rule', suggestedScope: 'x', evidence: ['m2'],
    }] }), validLabels)).toThrow(/unknown evidence/i);
    expect(() => capture.parseRecallCaptureOutput(JSON.stringify({ candidates: [{
      judgment: 'x', summary: 'x', suggestedType: 'other', suggestedScope: 'x', evidence: ['m1'],
    }] }), validLabels)).toThrow(/suggestedType/i);
    expect(() => capture.parseRecallCaptureOutput(JSON.stringify({ candidates: Array.from({ length: 4 }, () => ({})) }), validLabels))
      .toThrow(/candidate count/i);
  });
});
