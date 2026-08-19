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
  readHandoffReceipt: vi.fn(),
  readAbilityAsset: vi.fn(),
  promoteCandidate: vi.fn(),
  autoApplyCandidate: vi.fn(),
  prepareSkillDraft: vi.fn(),
  scheduleBootBackground: vi.fn(),
  detectLocalAgents: vi.fn(),
  runCliAgent: vi.fn(),
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
  readRecallAssetHandoffReceipt: mocks.readHandoffReceipt,
  promoteRecallCandidate: mocks.promoteCandidate,
  autoApplyRecallCandidate: mocks.autoApplyCandidate,
  isAutoCaptureEligible: (candidate: { status?: string }) => (
    candidate.status === 'pending_review' || candidate.status === 'failed'
  ),
}));
vi.mock('../../../../src/main/features/recall/asset-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/recall/asset-service')>(),
  readAbilityAsset: mocks.readAbilityAsset,
}));
vi.mock('../../../../src/main/features/recall/skill-draft-service', () => ({
  prepareRecallSkillDraft: mocks.prepareSkillDraft,
}));
vi.mock('../../../../src/main/features/local_agents/registry', () => ({
  detectAll: mocks.detectLocalAgents,
}));
vi.mock('../../../../src/main/features/local_agents/runner', () => ({
  run: mocks.runCliAgent,
}));
vi.mock('../../../../src/main/util/boot_init', () => ({
  scheduleBootBackground: mocks.scheduleBootBackground,
  // personal_ontology_template_files 顶层调用 registerDeferred 注册模板部署；
  // 本测试不关心该流程，stub 为空实现避免 mock 缺 export 导致模块加载失败。
  registerDeferred: () => {},
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

const reviewableCandidateContract = {
  value: 'Reduces repeated work and keeps later reviews auditable.',
  suggestedAction: 'create' as const,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-capture-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
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
    status: 'pending_review',
    ...input,
  }));
  mocks.readCandidate.mockRejectedValue(new Error('candidate not found'));
  mocks.readHandoffReceipt.mockReset().mockResolvedValue(undefined);
  mocks.readAbilityAsset.mockReset().mockRejectedValue(new Error('recall ability asset not found'));
  mocks.promoteCandidate.mockImplementation(async (_userId: string, candidateId: string) => ({
    candidate: { id: candidateId, status: 'confirmed', promotedAssetId: 'aa-promoted' },
    asset: { id: 'aa-promoted' },
  }));
  mocks.autoApplyCandidate.mockReset().mockImplementation(async (_userId: string, candidateId: string) => ({
    candidate: { id: candidateId, status: 'confirmed', promotedAssetId: 'aa-auto' },
    asset: { id: 'aa-auto', type: 'rule', status: 'active' },
  }));
  mocks.prepareSkillDraft.mockReset().mockResolvedValue({ status: 'draft', assetId: 'aa-promoted' });
  mocks.detectLocalAgents.mockReset().mockResolvedValue([]);
  mocks.runCliAgent.mockReset().mockResolvedValue({ runId: 'recall-cli', status: 'failed' });
  mocks.scheduleBootBackground.mockImplementation(() => ({
    cancel: vi.fn(),
    promise: new Promise<void>(() => {}),
  }));
});

afterEach(() => {
  vi.useRealTimers();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function captureModule(reviewPolicy: 'auto' | 'manual' = 'manual') {
  const capture = await import('../../../../src/main/features/recall/capture-service');
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  await settings.updateRecallCaptureSettings('capture-user', { reviewPolicy });
  return capture;
}

describe('Recall conversation capture', () => {
  it('does not create or run captures while the conversation source is paused or removed', async () => {
    const capture = await captureModule();
    const controls = await import('../../../../src/main/features/recall/source-control');
    const source = {
      kind: 'conversation' as const,
      subtype: 'session' as const,
      scope: 'conversation' as const,
      id: 'conv-1',
      title: 'Decision work',
    };
    const queued = await capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1');

    await controls.pauseCognitionSource('capture-user', source as any);
    await expect(capture.queueRecallCaptureFromTerminal(completedEvent)).resolves.toBeUndefined();
    await expect(capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1'))
      .rejects.toThrow(/paused/i);
    await expect(capture.startHistoricalRecallCapture('capture-user', 'conv-1'))
      .rejects.toThrow(/paused/i);
    await expect(capture.runRecallCaptureNow('capture-user', queued.id)).resolves.toMatchObject({
      id: queued.id,
      status: 'paused',
      errorCode: 'source_paused',
      resumeStatus: 'waiting_manual',
    });

    await controls.removeCognitionSource('capture-user', source as any, false);
    await expect(capture.queueRecallCaptureFromTerminal(completedEvent)).resolves.toBeUndefined();
    await expect(capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1'))
      .rejects.toThrow(/removed/i);
    await expect(capture.startHistoricalRecallCapture('capture-user', 'conv-1'))
      .rejects.toThrow(/removed/i);
    await expect(capture.runRecallCaptureNow('capture-user', queued.id)).resolves.toMatchObject({
      id: queued.id,
      status: 'paused',
      errorCode: 'source_removed',
    });
  });

  it('migrates legacy queued source failures to a paused task on read', async () => {
    const capture = await captureModule();
    const queued = await capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1');
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued.id, (current) => ({
      ...current!,
      status: 'queued',
      errorCode: 'source_removed',
      resumeStatus: undefined,
    }));

    await expect(capture.readRecallCapture('capture-user', queued.id)).resolves.toMatchObject({
      status: 'paused',
      errorCode: 'source_removed',
      resumeStatus: 'queued',
    });
    await expect(capture.readRecallCapture('capture-user', queued.id)).resolves.toMatchObject({ status: 'paused' });
  });

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

  it('excludes internal senders while retaining real Agent replies', async () => {
    const capture = await captureModule();
    const selected = capture.selectCaptureMessages([
      { id: 'user-policy', ts: '2026-08-01T00:01:00.000Z', from: 'user', text: 'Keep this decision.' },
      { id: 'system-policy', ts: '2026-08-01T00:02:00.000Z', from: 'system', text: 'internal status' },
      { id: 'tool-policy', ts: '2026-08-01T00:03:00.000Z', from: 'tool', text: 'internal tool output' },
      { id: 'process-policy', ts: '2026-08-01T00:04:00.000Z', from: 'process', text: 'internal process output' },
      { id: 'agent-policy', ts: '2026-08-01T00:05:00.000Z', from: 'research-agent', text: 'The reusable decision is complete.' },
    ] as any, completedEvent.started_at_ms, completedEvent.finished_at_ms);

    expect(selected.map((message) => [message.id, message.role])).toEqual([
      ['user-policy', 'user'],
      ['agent-policy', 'assistant'],
    ]);
  });

  it('does not treat system, tool, or process rows as a completed manual conversation', async () => {
    mocks.getMessages.mockResolvedValue([
      { id: 'user-internal', ts: '2026-08-01T00:01:00.000Z', from: 'user', text: 'Keep this decision.' },
      { id: 'system-internal', ts: '2026-08-01T00:02:00.000Z', from: 'system', text: 'internal status' },
      { id: 'tool-internal', ts: '2026-08-01T00:03:00.000Z', from: 'tool', text: 'internal tool output' },
      { id: 'process-internal', ts: '2026-08-01T00:04:00.000Z', from: 'process', text: 'internal process output' },
    ]);
    const capture = await captureModule('manual');

    await expect(capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1'))
      .rejects.toThrow(/waiting for a response/i);
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
    expect(first).toMatchObject({ visibility: 'internal', screeningStatus: 'pending' });
    expect(await capture.listRecallCaptures('capture-user')).toEqual([]);
  });

  it('does not create an automatic capture when a completed run has no assistant response', async () => {
    const capture = await captureModule();
    mocks.getMessages.mockResolvedValue([messages[0]]);

    await expect(capture.queueRecallCaptureFromTerminal(completedEvent)).resolves.toBeUndefined();
    expect(await capture.listRecallCaptures('capture-user')).toEqual([]);
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
    expect(first).toMatchObject({ visibility: 'visible', screeningStatus: 'qualified' });
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

  it('creates one durable manual task for a selected historical snapshot', async () => {
    const capture = await captureModule();
    const [first, concurrent] = await Promise.all([
      capture.startHistoricalRecallCapture('capture-user', 'conv-1'),
      capture.startHistoricalRecallCapture('capture-user', 'conv-1'),
    ]);
    const duplicate = await capture.startHistoricalRecallCapture('capture-user', 'conv-1');

    expect(first).toMatchObject({
      id: concurrent.id,
      conversationId: 'conv-1',
      conversationTitle: 'Decision work',
      anchorMessageId: 'user-1',
      messageIds: ['user-1', 'assistant-1'],
      status: 'waiting_manual',
      visibility: 'visible',
      screeningStatus: 'qualified',
      screeningSignals: ['manual_selection'],
      executionPolicy: 'manual',
      lastActivityAt: '2026-08-01T00:04:00.000Z',
      attempt: 1,
    });
    expect(duplicate).toEqual(first);
    expect(await capture.listRecallCaptures('capture-user')).toHaveLength(1);
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(mocks.scheduleBootBackground).not.toHaveBeenCalled();

    mocks.getMessages.mockResolvedValue([
      ...messages,
      { id: 'user-2', ts: '2026-08-01T00:05:00.000Z', from: 'user', to: ['commander'], text: 'Use the same rule next time.' },
      { id: 'assistant-2', ts: '2026-08-01T00:06:00.000Z', from: 'commander', to: ['user'], text: 'The rule is recorded.' },
    ]);
    const nextSnapshot = await capture.startHistoricalRecallCapture('capture-user', 'conv-1');
    expect(nextSnapshot.id).not.toBe(first.id);
    expect(nextSnapshot).toMatchObject({ status: 'waiting_manual' });
    expect(nextSnapshot.messageIds).toEqual(['user-1', 'assistant-1', 'user-2', 'assistant-2']);
    expect(await capture.listRecallCaptures('capture-user')).toHaveLength(2);
  });

  it('converts only an unstarted automatic wait into a manual task', async () => {
    const capture = await captureModule();
    const waiting = await capture.queueRecallCaptureFromTerminal(completedEvent);
    expect(waiting).toMatchObject({ status: 'waiting_quiet', visibility: 'internal' });

    const manual = await capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1');
    expect(manual).toMatchObject({
      id: waiting!.id,
      status: 'waiting_manual',
      visibility: 'visible',
      executionPolicy: 'manual',
      candidateIds: [],
    });
    expect(await capture.listRecallCaptures('capture-user')).toHaveLength(1);
  });

  it('creates a separate manual task after an internal automatic no-candidate result', async () => {
    const capture = await captureModule();
    const waiting = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', waiting!.id);
    const filtered = await capture.runRecallCapture('capture-user', waiting!.id);
    expect(filtered).toMatchObject({ status: 'no_candidate', visibility: 'internal' });

    const manual = await capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1');

    expect(manual).toMatchObject({ status: 'waiting_manual', visibility: 'visible' });
    expect(manual.id).not.toBe(filtered.id);
    expect(await capture.listRecallCaptures('capture-user')).toHaveLength(1);
  });

  it.each(['extracting', 'writing', 'review_ready', 'completed'] as const)(
    'does not overwrite an existing %s task or clear its candidates',
    async (status) => {
      const capture = await captureModule();
      const manual = await capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1');
      const store = await import('../../../../src/main/features/recall/store');
      await store.updateRecallJsonRecord('capture-user', 'captures', manual.id, (current) => ({
        ...current!,
        status,
        candidateIds: ['cand-existing'],
        startedAt: '2026-08-01T00:05:00.000Z',
        ...(status === 'extracting' ? { stage: 'model_extraction' } : {}),
        ...(status === 'writing' ? { stage: 'asset_write', writingCandidateId: 'cand-existing' } : {}),
      }));

      const selectedAgain = await capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1');

      expect(selectedAgain).toMatchObject({
        id: manual.id,
        status,
        candidateIds: ['cand-existing'],
        startedAt: '2026-08-01T00:05:00.000Z',
      });
      if (status === 'writing') expect(selectedAgain.writingCandidateId).toBe('cand-existing');
    },
  );

  it('does not let run-now bypass a waiting-completion state', async () => {
    const capture = await captureModule();
    const waiting = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', waiting!.id, (current) => ({
      ...current!,
      status: 'waiting_completion',
      waitingCompletionReason: 'terminal_waiting_input',
      scheduledFor: undefined,
    }));

    await expect(capture.runRecallCaptureNow('capture-user', waiting!.id))
      .rejects.toThrow(/not complete/i);
    await expect(capture.readRecallCapture('capture-user', waiting!.id)).resolves.toMatchObject({
      status: 'waiting_completion',
      waitingCompletionReason: 'terminal_waiting_input',
    });
    await expect(capture.readRecallCaptureWorkflow('capture-user', waiting!.id)).resolves.toMatchObject({
      nextAction: 'complete_conversation',
      actions: expect.not.arrayContaining(['run_now']),
    });
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
    expect(second).toMatchObject({ visibility: 'internal', screeningStatus: 'pending' });
    expect(await capture.listRecallCaptures('capture-user')).toEqual([]);
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T05:00:00.000Z'));
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
    expect(held).toMatchObject({
      status: 'waiting_completion',
      waitingCompletionReason: 'activity_changed',
      scheduledFor: expect.any(String),
    });
    expect(mocks.runModel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    mocks.getMessages.mockResolvedValue([
      ...messages,
      {
        id: 'user-continued',
        ts: '2026-08-14T05:00:00.000Z',
        from: 'user',
        to: ['commander'],
        text: 'Continue this conversation.',
      },
      {
        id: 'assistant-continued',
        ts: '2026-08-14T05:01:00.000Z',
        from: 'commander',
        to: ['user'],
        text: 'The continued work is complete.',
      },
    ]);
    await scheduledCall![1](new AbortController().signal);

    const requieted = await capture.readRecallCapture('capture-user', waiting!.id);
    expect(requieted).toMatchObject({
      status: 'waiting_quiet',
      messageIds: ['user-1', 'assistant-1', 'user-continued', 'assistant-continued'],
      scheduledFor: '2026-08-14T05:11:00.000Z',
    });
    expect(requieted).not.toHaveProperty('waitingCompletionReason');
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

  it('preserves activity-change polling when a waiting task is paused and resumed', async () => {
    const capture = await captureModule();
    const waiting = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    const scheduledFor = new Date(Date.now() + 60_000).toISOString();
    await store.updateRecallJsonRecord('capture-user', 'captures', waiting!.id, (current) => ({
      ...current!,
      status: 'waiting_completion',
      waitingCompletionReason: 'activity_changed',
      scheduledFor,
    }));

    await expect(capture.pauseRecallCapture('capture-user', waiting!.id)).resolves.toMatchObject({
      status: 'paused',
      resumeStatus: 'waiting_completion',
    });
    await expect(capture.resumeRecallCapture('capture-user', waiting!.id)).resolves.toMatchObject({
      status: 'waiting_completion',
      waitingCompletionReason: 'activity_changed',
      scheduledFor,
    });
  });

  it('filters trivial automatic exchanges before invoking the model', async () => {
    mocks.getMessages.mockResolvedValue([
      {
        id: 'user-trivial',
        ts: '2026-08-01T00:01:00.000Z',
        from: 'user',
        to: ['commander'],
        text: '谢谢',
      },
      {
        id: 'assistant-trivial',
        ts: '2026-08-01T00:02:00.000Z',
        from: 'commander',
        to: ['user'],
        text: '不客气。',
      },
    ]);
    const capture = await captureModule();
    const waiting = await capture.queueRecallCaptureFromTerminal({
      ...completedEvent,
      anchor_message_id: 'user-trivial',
      finished_message_id: 'assistant-trivial',
    });
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', waiting!.id, (current) => ({
      ...current!,
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    }));
    const scheduledCall = mocks.scheduleBootBackground.mock.calls.find(([name]) => name === `recall:capture:${waiting!.id}`);

    await scheduledCall![1](new AbortController().signal);

    await expect(capture.readRecallCapture('capture-user', waiting!.id)).resolves.toMatchObject({
      status: 'no_candidate',
      visibility: 'internal',
      screeningStatus: 'filtered',
      filterReason: 'trivial_exchange',
    });
    expect(await capture.listRecallCaptures('capture-user')).toEqual([]);
    expect(mocks.runModel).not.toHaveBeenCalled();
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

  it('uses an available local CLI when no API model is configured', async () => {
    mocks.configured = false;
    mocks.detectLocalAgents.mockResolvedValue([{ type: 'claude', available: true }]);
    mocks.runCliAgent.mockResolvedValue({
      runId: 'recall-cli',
      status: 'completed',
      output: JSON.stringify({ candidates: [] }),
    });
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);

    await expect(capture.runRecallCapture('capture-user', queued!.id))
      .resolves.toMatchObject({ status: 'no_candidate' });
    expect(mocks.runCliAgent).toHaveBeenCalledWith(expect.objectContaining({
      uid: 'capture-user',
      cid: 'conv-1',
      cli: 'claude',
      signal: expect.any(AbortSignal),
      skipDispatchCheck: true,
    }));
    expect(mocks.buildRunner).not.toHaveBeenCalled();
  });

  it('forwards capture cancellation to a running local CLI extraction', async () => {
    mocks.configured = false;
    mocks.detectLocalAgents.mockResolvedValue([{ type: 'claude', available: true }]);
    let markCliStarted!: () => void;
    const cliStarted = new Promise<void>((resolve) => { markCliStarted = resolve; });
    mocks.runCliAgent.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      markCliStarted();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { runId: 'recall-cli', status: 'cancelled' };
    });
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const controller = new AbortController();
    const running = capture.runRecallCapture('capture-user', queued!.id, controller.signal);

    await cliStarted;
    controller.abort();

    await expect(running).resolves.toMatchObject({ status: 'queued' });
    expect(mocks.runCliAgent.mock.calls[0][0].signal.aborted).toBe(true);
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
          ...reviewableCandidateContract,
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
      visibility: 'visible',
      screeningStatus: 'qualified',
      candidateIds: ['cand-0'],
      recallViewId: modelPayload.recallView.id,
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      durationMs: expect.any(Number),
      modelUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    expect(mocks.autoApplyCandidate).not.toHaveBeenCalled();
    expect(completed.stage).toBeUndefined();
    const persisted = await capture.readRecallCapture('capture-user', queued!.id);
    expect(persisted.stage).toBeUndefined();
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

  it('keeps weak observations without creating a review task', async () => {
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Possible reusable local convention.',
          value: 'May reduce repeated formatting work.',
          summary: 'Local convention',
          suggestedType: 'rule',
          suggestedScope: 'project',
          suggestedAction: 'create',
          evidence: ['m1'],
        }],
      }),
      content: [],
      meta: { aborted: false },
    });
    mocks.saveCandidate.mockResolvedValueOnce({
      id: 'cand-weak',
      status: 'weak_observation',
      taskRunId: 'run-1',
    });

    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const completed = await capture.runRecallCapture('capture-user', queued!.id);

    expect(completed).toMatchObject({ status: 'no_candidate', candidateIds: [] });
    expect(mocks.saveCandidate).toHaveBeenCalledWith('capture-user', expect.objectContaining({ taskRunId: 'run-1' }));
  });

  it('keeps model output that fails deterministic quality checks as a hidden weak observation', async () => {
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Keep a traceable decision log.',
          summary: 'Decision traceability',
          suggestedType: 'rule',
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

    expect(mocks.saveCandidate).toHaveBeenCalledWith('capture-user', expect.objectContaining({
      value: '',
      forceWeakObservation: true,
    }));
    expect(completed).toMatchObject({
      status: 'no_candidate',
      visibility: 'internal',
      screeningStatus: 'filtered',
      filterReason: 'candidate_quality',
      candidateIds: [],
    });
    expect(await capture.listRecallCaptures('capture-user')).toEqual([]);
  });

  it('automatically writes clear candidates to memory when automatic write is enabled', async () => {
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Keep a traceable decision log.',
          ...reviewableCandidateContract,
          summary: 'Decision traceability',
          suggestedType: 'rule',
          suggestedScope: 'project',
          evidence: ['m1'],
        }],
      }),
      content: [],
      meta: { aborted: false },
    });

    mocks.readCandidate.mockResolvedValue({ id: 'cand-0', status: 'pending_review' });
    const capture = await captureModule('auto');
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const completed = await capture.runRecallCapture('capture-user', queued!.id);

    expect(mocks.autoApplyCandidate).toHaveBeenCalledWith('capture-user', 'cand-0');
    expect(completed).toMatchObject({ status: 'completed', autoWrite: true, candidateIds: ['cand-0'] });
  });

  it('keeps a high-risk automatic candidate visible for the independent manual gate', async () => {
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Always keep decisions traceable.',
          value: 'Prevents production decisions from losing their evidence trail.',
          summary: 'Traceable production decisions',
          suggestedType: 'rule',
          suggestedScope: 'project',
          suggestedAction: 'create',
          risk: 'high',
          evidence: ['m1'],
        }],
      }),
      content: [],
      meta: { aborted: false },
    });
    const capture = await captureModule('auto');
    const waiting = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', waiting!.id);

    const reviewed = await capture.runRecallCapture('capture-user', waiting!.id);

    expect(mocks.saveCandidate).toHaveBeenCalledWith('capture-user', expect.objectContaining({
      risk: 'high',
      forceWeakObservation: false,
    }));
    expect(mocks.autoApplyCandidate).not.toHaveBeenCalled();
    expect(reviewed).toMatchObject({
      status: 'review_ready',
      visibility: 'visible',
      candidateIds: ['cand-0'],
    });
    expect(reviewed.autoWrite).toBeUndefined();
  });

  it.each(['confirmed', 'rejected', 'ignored', 'expired'] as const)(
    'skips a settled %s candidate during automatic replay while applying pending candidates',
    async (settledStatus) => {
      mocks.runModel.mockResolvedValueOnce({
        text: JSON.stringify({
          candidates: [0, 1].map(() => ({
            judgment: 'Keep a traceable decision log.',
            ...reviewableCandidateContract,
            summary: 'Decision traceability',
            suggestedType: 'rule',
            suggestedScope: 'project',
            evidence: ['m1'],
          })),
        }),
        content: [],
        meta: { aborted: false },
      });
      mocks.readCandidate.mockImplementation(async (_userId: string, candidateId: string) => ({
        id: candidateId,
        status: candidateId === 'cand-0' ? settledStatus : 'pending_review',
      }));

      const capture = await captureModule('auto');
      const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
      await capture.runRecallCaptureNow('capture-user', queued!.id);
      const completed = await capture.runRecallCapture('capture-user', queued!.id);

      expect(mocks.autoApplyCandidate).toHaveBeenCalledTimes(1);
      expect(mocks.autoApplyCandidate).toHaveBeenCalledWith('capture-user', 'cand-1');
      expect(completed).toMatchObject({
        status: 'completed',
        candidateIds: ['cand-0', 'cand-1'],
      });
    },
  );

  it('retries remaining automatic candidates without replaying a settled candidate', async () => {
    const statuses = new Map<string, string>([
      ['cand-0', 'pending_review'],
      ['cand-1', 'pending_review'],
    ]);
    mocks.runModel.mockResolvedValue({
      text: JSON.stringify({
        candidates: [0, 1].map(() => ({
          judgment: 'Keep a traceable decision log.',
          ...reviewableCandidateContract,
          summary: 'Decision traceability',
          suggestedType: 'rule',
          suggestedScope: 'project',
          evidence: ['m1'],
        })),
      }),
      content: [],
      meta: { aborted: false },
    });
    mocks.readCandidate.mockImplementation(async (_userId: string, candidateId: string) => ({
      id: candidateId,
      status: statuses.get(candidateId),
    }));
    let candidateOneAttempts = 0;
    mocks.autoApplyCandidate.mockImplementation(async (_userId: string, candidateId: string) => {
      if (candidateId === 'cand-0') {
        statuses.set(candidateId, 'rejected');
        return { candidate: { id: candidateId, status: 'rejected' } };
      }
      candidateOneAttempts += 1;
      if (candidateOneAttempts === 1) throw new Error('temporary asset write failure');
      statuses.set(candidateId, 'confirmed');
      return {
        candidate: { id: candidateId, status: 'confirmed', promotedAssetId: 'aa-retried' },
        asset: { id: 'aa-retried', type: 'rule', status: 'active' },
      };
    });

    const capture = await captureModule('auto');
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    await expect(capture.runRecallCapture('capture-user', queued!.id)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'asset_write_failed',
      candidateIds: ['cand-0', 'cand-1'],
    });

    await capture.retryRecallCapture('capture-user', queued!.id);
    await expect(capture.runRecallCapture('capture-user', queued!.id)).resolves.toMatchObject({
      status: 'completed',
      candidateIds: ['cand-0', 'cand-1'],
    });
    expect(mocks.autoApplyCandidate.mock.calls.map(([, candidateId]) => candidateId)).toEqual([
      'cand-0',
      'cand-1',
      'cand-1',
    ]);
  });

  it('continues writing later candidates when an earlier candidate fails', async () => {
    const statuses = new Map<string, string>([
      ['cand-0', 'pending_review'],
      ['cand-1', 'pending_review'],
    ]);
    mocks.runModel.mockResolvedValue({
      text: JSON.stringify({
        candidates: [0, 1].map(() => ({
          judgment: 'Keep a traceable decision log.',
          ...reviewableCandidateContract,
          summary: 'Decision traceability',
          suggestedType: 'rule',
          suggestedScope: 'project',
          evidence: ['m1'],
        })),
      }),
      content: [],
      meta: { aborted: false },
    });
    mocks.readCandidate.mockImplementation(async (_userId: string, candidateId: string) => ({
      id: candidateId,
      status: statuses.get(candidateId),
    }));
    let firstCandidateAttempts = 0;
    mocks.autoApplyCandidate.mockImplementation(async (_userId: string, candidateId: string) => {
      if (candidateId === 'cand-0') {
        firstCandidateAttempts += 1;
        if (firstCandidateAttempts === 1) throw new Error('temporary first candidate failure');
      }
      statuses.set(candidateId, 'confirmed');
      return {
        candidate: { id: candidateId, status: 'confirmed', promotedAssetId: `aa-${candidateId}` },
        asset: { id: `aa-${candidateId}`, type: 'rule', status: 'active' },
      };
    });

    const capture = await captureModule('auto');
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    await expect(capture.runRecallCapture('capture-user', queued!.id)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'asset_write_failed',
      candidateIds: ['cand-0', 'cand-1'],
    });
    expect(statuses.get('cand-1')).toBe('confirmed');

    await capture.retryRecallCapture('capture-user', queued!.id);
    await expect(capture.runRecallCapture('capture-user', queued!.id)).resolves.toMatchObject({
      status: 'completed',
      candidateIds: ['cand-0', 'cand-1'],
    });
    expect(mocks.autoApplyCandidate.mock.calls.map(([, candidateId]) => candidateId)).toEqual([
      'cand-0',
      'cand-1',
      'cand-0',
    ]);
  });

  it('prepares a Skill draft after an automatically written skill memory', async () => {
    mocks.getMessages.mockResolvedValue(messages.map((message) => (
      message.id === 'user-1'
        ? { ...message, text: 'From now on, for every product review: review the request, apply the method, and validate the result.' }
        : message
    )));
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Review the request, apply the method, and validate the result.',
          ...reviewableCandidateContract,
          summary: 'Evidence-first review method',
          suggestedType: 'skill_method',
          suggestedScope: 'product review',
          evidence: ['m1'],
        }],
      }),
      content: [],
      meta: { aborted: false },
    });
    mocks.readCandidate.mockResolvedValue({ id: 'cand-0', status: 'pending_review' });
    const capture = await captureModule('auto');
    mocks.autoApplyCandidate.mockResolvedValueOnce({
      candidate: { id: 'cand-0', status: 'confirmed', promotedAssetId: 'aa-skill' },
      asset: { id: 'aa-skill', type: 'skill_method', status: 'active' },
    });
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const completed = await capture.runRecallCapture('capture-user', queued!.id);

    expect(mocks.autoApplyCandidate).toHaveBeenCalledWith('capture-user', 'cand-0');
    expect(mocks.prepareSkillDraft).toHaveBeenCalledWith('capture-user', 'aa-skill');
    expect(completed).toMatchObject({ status: 'completed', autoWrite: true, candidateIds: ['cand-0'] });
  });

  it('keeps uncertain automatic candidates only as weak observations', async () => {
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Use the short review format.',
          ...reviewableCandidateContract,
          summary: 'Short review format',
          uncertainty: 'The user may only want this for the current project.',
          suggestedType: 'template',
          suggestedScope: 'project',
          evidence: ['m1'],
        }],
      }),
      content: [],
      meta: { aborted: false },
    });

    const capture = await captureModule('auto');
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const completed = await capture.runRecallCapture('capture-user', queued!.id);

    expect(mocks.autoApplyCandidate).not.toHaveBeenCalled();
    expect(mocks.saveCandidate).toHaveBeenCalledWith('capture-user', expect.objectContaining({
      forceWeakObservation: true,
    }));
    expect(completed).toMatchObject({ status: 'no_candidate', candidateIds: [] });
    expect(completed.autoWrite).toBeUndefined();
  });

  it('keeps a manually selected one-off generation candidate in review', async () => {
    mocks.getMessages.mockResolvedValue([
      {
        id: 'user-one-off',
        ts: '2026-08-01T00:01:00.000Z',
        from: 'user',
        to: ['commander'],
        text: 'Please turn this conversation into a new agent.',
      },
      {
        id: 'assistant-one-off',
        ts: '2026-08-01T00:02:00.000Z',
        from: 'commander',
        to: ['user'],
        text: 'The new agent configuration is ready.',
      },
    ]);
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Turn this conversation into a reusable agent workflow.',
          value: 'Reduces the effort of configuring this generated agent.',
          summary: 'Conversation-to-agent workflow',
          suggestedType: 'skill_method',
          suggestedScope: 'project',
          suggestedAction: 'create',
          evidence: ['m1'],
        }],
      }),
      content: [],
      meta: { aborted: false },
    });
    const capture = await captureModule();
    const queued = await capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1');
    await capture.runRecallCaptureNow('capture-user', queued.id);

    const completed = await capture.runRecallCapture('capture-user', queued.id);

    expect(mocks.saveCandidate).toHaveBeenCalledWith('capture-user', expect.objectContaining({
      forceWeakObservation: false,
    }));
    expect(mocks.autoApplyCandidate).not.toHaveBeenCalled();
    expect(completed).toMatchObject({
      status: 'review_ready',
      visibility: 'visible',
      candidateIds: ['cand-0'],
    });
  });

  it('keeps a manually selected historical conversation in review when auto-write is enabled', async () => {
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Keep a traceable decision log.',
          ...reviewableCandidateContract,
          summary: 'Decision traceability',
          suggestedType: 'rule',
          suggestedScope: 'project',
          evidence: ['m1'],
        }],
      }),
      content: [],
      meta: { aborted: false },
    });

    const capture = await captureModule('auto');
    const queued = await capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1');
    await capture.runRecallCaptureNow('capture-user', queued.id);
    const completed = await capture.runRecallCapture('capture-user', queued.id);

    expect(mocks.autoApplyCandidate).not.toHaveBeenCalled();
    expect(completed).toMatchObject({ status: 'review_ready', candidateIds: ['cand-0'] });
    expect(completed.autoWrite).toBeUndefined();
  });

  it('keeps an automatic write failure visible and retryable', async () => {
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Keep a traceable decision log.',
          ...reviewableCandidateContract,
          summary: 'Decision traceability',
          suggestedType: 'rule',
          suggestedScope: 'project',
          evidence: ['m1'],
        }],
      }),
      content: [],
      meta: { aborted: false },
    });
    const capture = await captureModule('auto');
    mocks.readCandidate.mockResolvedValue({ id: 'cand-0', status: 'pending_review' });
    mocks.autoApplyCandidate.mockRejectedValueOnce(new Error('asset write failed'));
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    await capture.runRecallCaptureNow('capture-user', queued!.id);
    const completed = await capture.runRecallCapture('capture-user', queued!.id);

    expect(completed).toMatchObject({
      status: 'failed',
      autoWrite: true,
      errorCode: 'asset_write_failed',
      candidateIds: ['cand-0'],
    });
    expect(mocks.autoApplyCandidate).toHaveBeenCalledWith('capture-user', 'cand-0');
    await expect(capture.retryRecallCapture('capture-user', queued!.id)).resolves.toMatchObject({ status: 'queued' });
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
          ...reviewableCandidateContract,
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
      return { id: 'cand-finalizing', status: 'pending_review', ...input };
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
      status: 'pending_review',
      judgment: 'Always keep decisions traceable.',
    });
    mocks.saveCandidate.mockClear();
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [
          {
            judgment: 'Always keep decisions traceable.',
            ...reviewableCandidateContract,
            summary: 'Traceable decisions',
            suggestedType: 'rule',
            suggestedScope: 'project',
            evidence: ['m1'],
          },
          {
            judgment: 'Use the completed decision log as the review template.',
            ...reviewableCandidateContract,
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

  it('sends rejected teaching content with new conversation evidence back through candidate governance', async () => {
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
      status: 'rejected',
      judgment: 'Always keep decisions traceable.',
    });
    mocks.saveCandidate.mockClear().mockImplementationOnce(async (_userId: string, input: { captureKey: string }) => ({
      id: 'cand-reconsidered',
      status: 'pending_review',
      ...input,
    }));
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Always keep decisions traceable.',
          value: 'Make later reviews auditable.',
          suggestedAction: 'create',
          summary: 'Traceable decisions',
          suggestedType: 'rule',
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

    expect(completed.candidateIds).toEqual(['cand-reconsidered']);
    expect(mocks.saveCandidate).toHaveBeenCalledWith('capture-user', expect.objectContaining({
      judgment: 'Always keep decisions traceable.',
      captureKey: `capture-${queued!.id}-0`,
      sourceRefs: expect.arrayContaining([
        expect.objectContaining({ kind: 'conversation', subtype: 'message' }),
      ]),
    }));
  });

  it('matches candidates across every teaching signal attached to the same user message', async () => {
    mocks.saveCandidate.mockImplementation(async (_userId: string, input: { captureKey: string }) => ({
      id: `cand-${input.captureKey}`,
      status: 'pending_review',
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
      status: 'pending_review',
      judgment: candidateId === secondSignal!.candidateIds[0]
        ? 'Use the completed decision log as the review template.'
        : 'Always keep decisions traceable.',
    }));
    mocks.saveCandidate.mockClear();
    mocks.runModel.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [{
          judgment: 'Use the completed decision log as the review template.',
          ...reviewableCandidateContract,
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
    // 18:00Z: 在任何时区（UTC-12..+14）都落在本地 06:00-08:00，不在 02:00-06:00
    // 夜间窗口内，否则 10:00Z 在 UTC-7 机器上是本地 03:00，仍在窗口内，
    // 重排分支不会触发，测试会按时区不同而失败。
    vi.setSystemTime(new Date('2026-08-01T18:00:00.000Z'));
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

  it('migrates a legacy historical automatic-write wait to manual after restart', async () => {
    const capture = await captureModule('manual');
    const queued = await capture.startHistoricalRecallCapture('capture-user', 'conv-1');
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued.id, (current) => ({
      ...current!,
      status: 'queued',
      executionPolicy: 'manual',
      autoWrite: true,
    }));

    mocks.scheduleBootBackground.mockClear();
    vi.resetModules();
    const restarted = await captureModule('manual');

    await expect(restarted.recoverRecallCaptures('capture-user')).resolves.toBe(0);
    const migrated = await restarted.readRecallCapture('capture-user', queued.id);
    expect(migrated).toMatchObject({
      status: 'waiting_manual',
      executionPolicy: 'manual',
    });
    expect(migrated.autoWrite).toBeUndefined();
    expect(mocks.scheduleBootBackground).not.toHaveBeenCalled();
  });

  it('migrates a legacy historical automatic-write wait before a new manual selection', async () => {
    const capture = await captureModule('manual');
    const queued = await capture.startHistoricalRecallCapture('capture-user', 'conv-1');
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued.id, (current) => ({
      ...current!,
      status: 'queued',
      executionPolicy: 'manual',
      autoWrite: true,
    }));

    await expect(capture.queueManualRecallCaptureFromConversation('capture-user', 'conv-1'))
      .resolves.toMatchObject({
        id: queued.id,
        status: 'waiting_manual',
        executionPolicy: 'manual',
      });
    await expect(capture.readRecallCapture('capture-user', queued.id))
      .resolves.not.toHaveProperty('autoWrite');
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it('does not reschedule a terminal waiting-input state after restart', async () => {
    const capture = await captureModule();
    const waiting = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const held = await capture.queueRecallCaptureFromTerminal({
      ...completedEvent,
      run_id: 'run-waiting-input',
      status: 'waiting_input',
    });
    expect(held).toMatchObject({
      id: waiting!.id,
      status: 'waiting_completion',
      waitingCompletionReason: 'terminal_waiting_input',
      scheduledFor: undefined,
    });

    mocks.scheduleBootBackground.mockClear();
    vi.resetModules();
    const restarted = await captureModule();

    await expect(restarted.recoverRecallCaptures('capture-user')).resolves.toBe(0);
    expect(mocks.scheduleBootBackground).not.toHaveBeenCalled();
  });

  it('migrates and reschedules a legacy waiting-completion state when newer activity exists', async () => {
    const capture = await captureModule();
    const waiting = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', waiting!.id, (current) => {
      const legacy = {
        ...current!,
        status: 'waiting_completion',
      };
      delete legacy.waitingCompletionReason;
      delete legacy.scheduledFor;
      return legacy;
    });
    mocks.getMessages.mockResolvedValue([...messages, {
      id: 'user-after-restart',
      ts: '2026-08-14T05:00:00.000Z',
      from: 'user',
      to: ['commander'],
      text: 'Continue with the next review.',
    }]);

    mocks.scheduleBootBackground.mockClear();
    vi.resetModules();
    const restarted = await captureModule();

    await expect(restarted.recoverRecallCaptures('capture-user')).resolves.toBe(1);
    await expect(restarted.readRecallCapture('capture-user', waiting!.id)).resolves.toMatchObject({
      status: 'waiting_completion',
      waitingCompletionReason: 'activity_changed',
      scheduledFor: expect.any(String),
      recoveredAt: expect.any(String),
    });
    expect(mocks.scheduleBootBackground).toHaveBeenCalledWith(
      `recall:capture:${waiting!.id}`,
      expect.any(Function),
      expect.any(Number),
      expect.objectContaining({ resourceClass: 'model' }),
    );
  });

  it('keeps legacy internal observations out of task counts while normalizing their execution policy', async () => {
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => {
      const legacy = { ...current! };
      delete legacy.executionPolicy;
      delete legacy.visibility;
      delete legacy.screeningStatus;
      return legacy;
    });

    const page = await capture.queryRecallCaptures('capture-user', { statuses: ['waiting_quiet'], limit: 1 });
    const stored = await capture.readRecallCapture('capture-user', queued!.id);
    expect(stored).toMatchObject({
      executionPolicy: 'immediate',
      visibility: 'internal',
      screeningStatus: 'pending',
    });
    expect(page.captures).toEqual([]);
    await expect(capture.queryRecallCaptures('capture-user', { statuses: ['waiting'] }))
      .resolves.toMatchObject({ captures: [] });
    expect(page.counts.waiting).toBe(0);
    expect(page.nextCursor).toBeNull();
  });

  it('derives completed workflow state from terminal candidates without rewriting the capture', async () => {
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => ({
      ...current!,
      status: 'review_ready',
      visibility: 'visible',
      screeningStatus: 'qualified',
      stage: 'candidate_save',
      candidateIds: ['cand-promoted', 'cand-rejected'],
    }));
    mocks.readCandidate.mockImplementation(async (_userId: string, candidateId: string) => (
      candidateId === 'cand-promoted'
        ? {
            id: candidateId,
            status: 'confirmed',
            promotedAssetId: 'aa-promoted',
            reviewDecisionId: 'rd_promoted0000000000000000',
          }
        : { id: candidateId, status: 'rejected' }
    ));
    mocks.readAbilityAsset.mockResolvedValue({
      id: 'aa-promoted',
      candidateId: 'cand-promoted',
      reviewDecisionId: 'rd_laterupdate0000000000000',
      type: 'rule',
      version: '2',
      scope: 'workspace-current',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-later' }],
    });
    mocks.readHandoffReceipt.mockResolvedValue({
      assetId: 'aa-promoted',
      assetType: 'rule',
      version: '1',
      lifecycleStatus: 'user_confirmed_unverified',
      scope: 'project',
      sourceRefs: [{ kind: 'conversation', id: 'conv-1' }, { kind: 'artifact_file', id: 'artifact-1' }],
      reviewDecisionId: 'rd_promoted0000000000000000',
    });
    const paths = await import('../../../../src/main/features/recall/paths');
    const storedPath = paths.recallJsonRecordPath('capture-user', 'captures', queued!.id);
    const beforeRead = fs.readFileSync(storedPath, 'utf8');

    const completedPage = await capture.queryRecallCaptures('capture-user', { statuses: ['completed'] });
    const reviewPage = await capture.queryRecallCaptures('capture-user', { statuses: ['review_ready'] });
    const detail = await capture.readRecallCaptureWorkflow('capture-user', queued!.id);

    expect(completedPage.captures).toHaveLength(1);
    expect(completedPage.captures[0]).toMatchObject({
      status: 'review_ready',
      workflowStatus: 'completed',
      displayStatus: 'completed',
      displayReason: 'review_completed',
      reviewSummary: { total: 2, pending: 0, deferred: 0, promoted: 1, rejected: 1, missing: 0 },
      linkedAssetIds: ['aa-promoted'],
      confirmedAssetReceipts: [{
        assetId: 'aa-promoted',
        assetType: 'rule',
        version: '1',
        scope: 'project',
        sourceRefCount: 2,
        reviewDecisionId: 'rd_promoted0000000000000000',
      }],
      nextAction: 'view_assets',
      actions: expect.arrayContaining(['view_assets', 'open_conversation']),
    });
    expect(completedPage.captures[0].stage).toBeUndefined();
    expect(completedPage.counts).toMatchObject({ completed: 1, review: 0 });
    expect(reviewPage.captures).toHaveLength(0);
    expect(detail.workflowStatus).toBe('completed');
    await expect(capture.readRecallCapture('capture-user', queued!.id)).resolves.toMatchObject({
      status: 'review_ready',
      stage: undefined,
    });
    expect(fs.readFileSync(storedPath, 'utf8')).toBe(beforeRead);
  });

  it('keeps a confirmed candidate retryable when its formal asset is unavailable', async () => {
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => ({
      ...current!,
      status: 'review_ready',
      visibility: 'visible',
      screeningStatus: 'qualified',
      candidateIds: ['cand-missing-asset'],
    }));
    mocks.readCandidate.mockResolvedValue({
      id: 'cand-missing-asset',
      status: 'confirmed',
      promotedAssetId: 'aa-missing',
      reviewDecisionId: 'rd_missingasset000000000000',
    });
    mocks.readAbilityAsset.mockRejectedValue(new Error('recall ability asset not found'));

    await expect(capture.readRecallCaptureWorkflow('capture-user', queued!.id)).resolves.toMatchObject({
      workflowStatus: 'failed',
      reviewSummary: { total: 1, promoted: 0, missing: 1 },
      linkedAssetIds: [],
      confirmedAssetReceipts: [],
      nextAction: 'retry',
    });
  });

  it('keeps a confirmed candidate retryable when its immutable handoff receipt is unavailable', async () => {
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => ({
      ...current!,
      status: 'review_ready',
      visibility: 'visible',
      screeningStatus: 'qualified',
      candidateIds: ['cand-missing-receipt'],
    }));
    mocks.readCandidate.mockResolvedValue({
      id: 'cand-missing-receipt',
      status: 'confirmed',
      promotedAssetId: 'aa-without-receipt',
      reviewDecisionId: 'rd_missingreceipt0000000000',
    });
    mocks.readAbilityAsset.mockResolvedValue({
      id: 'aa-without-receipt',
      candidateId: 'cand-missing-receipt',
      type: 'rule',
    });
    mocks.readHandoffReceipt.mockResolvedValue(undefined);

    await expect(capture.readRecallCaptureWorkflow('capture-user', queued!.id)).resolves.toMatchObject({
      workflowStatus: 'failed',
      reviewSummary: { total: 1, promoted: 0, missing: 1 },
      linkedAssetIds: [],
      confirmedAssetReceipts: [],
      nextAction: 'retry',
    });
    expect(mocks.readHandoffReceipt).toHaveBeenCalledWith(
      'capture-user',
      'cand-missing-receipt',
      'rd_missingreceipt0000000000',
    );
  });

  it('requeues a completed capture when its confirmed asset handoff is missing', async () => {
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => ({
      ...current!,
      status: 'completed',
      visibility: 'visible',
      screeningStatus: 'qualified',
      autoWrite: true,
      candidateIds: ['cand-completed-missing'],
    }));
    mocks.readCandidate.mockResolvedValue({
      id: 'cand-completed-missing',
      status: 'confirmed',
      promotedAssetId: 'aa-completed-missing',
      reviewDecisionId: 'rd_completedmissing000000',
    });
    mocks.readAbilityAsset.mockRejectedValue(new Error('recall ability asset not found'));

    await expect(capture.retryRecallCapture('capture-user', queued!.id))
      .resolves.toMatchObject({ status: 'queued', attempt: 2, autoWrite: true });
  });

  it('keeps pending candidates in review while deferred candidates stay quiet', async () => {
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => ({
      ...current!,
      status: 'review_ready',
      visibility: 'visible',
      screeningStatus: 'qualified',
      candidateIds: ['cand-pending', 'cand-deferred'],
    }));
    mocks.readCandidate.mockImplementation(async (_userId: string, candidateId: string) => (
      candidateId === 'cand-pending'
        ? { id: candidateId, status: 'pending_review' }
        : { id: candidateId, status: 'deferred' }
    ));

    const reviewPage = await capture.queryRecallCaptures('capture-user', { statuses: ['review_ready'] });
    const completedPage = await capture.queryRecallCaptures('capture-user', { statuses: ['completed'] });

    expect(reviewPage.captures[0]).toMatchObject({
      workflowStatus: 'review_ready',
      displayStatus: 'review_ready',
      displayReason: 'review_pending',
      reviewSummary: { total: 1, pending: 1, deferred: 0, promoted: 0, rejected: 0, missing: 0 },
      linkedAssetIds: [],
      nextAction: 'review_candidates',
      actions: expect.arrayContaining(['review_candidates', 'open_conversation']),
    });
    expect(reviewPage.counts).toMatchObject({ completed: 0, review: 1 });
    expect(completedPage.captures).toHaveLength(0);
  });

  it('marks missing candidate references as retryable workflow failures', async () => {
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => ({
      ...current!,
      status: 'review_ready',
      visibility: 'visible',
      screeningStatus: 'qualified',
      candidateIds: ['cand-missing'],
    }));
    mocks.readCandidate.mockRejectedValue(new Error('recall candidate not found'));

    const failedPage = await capture.queryRecallCaptures('capture-user', { statuses: ['failed'] });

    expect(failedPage.captures[0]).toMatchObject({
      status: 'review_ready',
      workflowStatus: 'failed',
      displayStatus: 'failed',
      displayReason: 'capture_failed',
      reviewSummary: { total: 1, pending: 0, deferred: 0, promoted: 0, rejected: 0, missing: 1 },
      linkedAssetIds: [],
      nextAction: 'retry',
      actions: expect.arrayContaining(['retry', 'open_conversation']),
    });
    await expect(capture.retryRecallCapture('capture-user', queued!.id))
      .resolves.toMatchObject({ status: 'queued', attempt: 2 });
  });

  it('maps no-candidate captures to the completed workflow filter', async () => {
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => ({
      ...current!,
      status: 'no_candidate',
      visibility: 'visible',
      screeningStatus: 'qualified',
      candidateIds: [],
    }));

    const completedPage = await capture.queryRecallCaptures('capture-user', { statuses: ['completed'] });

    expect(completedPage.captures[0]).toMatchObject({
      status: 'no_candidate',
      workflowStatus: 'completed',
      displayStatus: 'completed',
      displayReason: 'no_candidate',
      reviewSummary: { total: 0, pending: 0, deferred: 0, promoted: 0, rejected: 0, missing: 0 },
      linkedAssetIds: [],
      nextAction: 'none',
    });
    expect(completedPage.counts.completed).toBe(1);
  });

  it('passes the review decision and formal-asset receipt through candidate confirmation', async () => {
    const capture = await captureModule();
    const promoted = {
      candidate: {
        id: 'cand-receipt',
        status: 'confirmed',
        promotedAssetId: 'aa-receipt',
        reviewDecisionId: 'rd_receipt0000000000000000',
      },
      asset: { id: 'aa-receipt', type: 'rule', status: 'active' },
      decision: {
        decision_id: 'rd_receipt0000000000000000',
        target_ref: 'recall_candidate:cand-receipt',
        decision_type: 'accept',
        decision: 'accept',
        actor: 'user',
        timestamp: '2026-08-14T00:00:00.000Z',
      },
      receipt: {
        assetId: 'aa-receipt',
        assetType: 'rule',
        version: '1',
        lifecycleStatus: 'user_confirmed_unverified',
        scope: 'project',
        sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
        reviewDecisionId: 'rd_receipt0000000000000000',
      },
    };
    mocks.promoteCandidate.mockResolvedValueOnce(promoted);

    await expect(capture.promoteRecallCaptureCandidate('capture-user', 'cand-receipt'))
      .resolves.toEqual(promoted);
    expect(mocks.promoteCandidate).toHaveBeenCalledWith('capture-user', 'cand-receipt', {
      actor: 'user',
      riskAcknowledged: undefined,
    });
  });

  it('persists the approved candidate write phase and completes after the asset is stored', async () => {
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => ({
      ...current!,
      status: 'review_ready',
      visibility: 'visible',
      screeningStatus: 'qualified',
      candidateIds: ['cand-write'],
    }));

    let markWriteStarted!: () => void;
    let releaseWrite!: () => void;
    let promoted = false;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    mocks.readCandidate.mockImplementation(async (_userId: string, candidateId: string) => ({
      id: candidateId,
      status: promoted ? 'confirmed' : 'pending_review',
      ...(promoted ? {
        promotedAssetId: 'aa-write',
        reviewDecisionId: 'rd_write000000000000000000',
      } : {}),
    }));
    mocks.readAbilityAsset.mockResolvedValue({
      id: 'aa-write',
      candidateId: 'cand-write',
      type: 'rule',
    });
    mocks.readHandoffReceipt.mockResolvedValue({
      assetId: 'aa-write',
      assetType: 'rule',
      version: '1',
      lifecycleStatus: 'user_confirmed_unverified',
      scope: 'project',
      sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
      reviewDecisionId: 'rd_write000000000000000000',
    });
    mocks.promoteCandidate.mockImplementationOnce(async (_userId: string, candidateId: string) => {
      markWriteStarted();
      await writeGate;
      promoted = true;
      return {
        candidate: {
          id: candidateId,
          status: 'confirmed',
          promotedAssetId: 'aa-write',
          reviewDecisionId: 'rd_write000000000000000000',
        },
        asset: { id: 'aa-write' },
        decision: { decision_id: 'rd_write000000000000000000' },
        receipt: {
          assetId: 'aa-write',
          assetType: 'rule',
          version: '1',
          lifecycleStatus: 'user_confirmed_unverified',
          scope: 'project',
          sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
          reviewDecisionId: 'rd_write000000000000000000',
        },
      };
    });

    const writingPromise = capture.promoteRecallCaptureCandidate('capture-user', 'cand-write');
    await writeStarted;
    await expect(capture.readRecallCaptureWorkflow('capture-user', queued!.id)).resolves.toMatchObject({
      status: 'writing',
      stage: 'asset_write',
      writingCandidateId: 'cand-write',
      displayStatus: 'writing',
      displayReason: 'asset_write',
      actions: ['open_conversation'],
    });
    await expect(capture.cancelRecallCapture('capture-user', queued!.id)).rejects.toThrow(/writing/i);

    releaseWrite();
    await expect(writingPromise).resolves.toMatchObject({ asset: { id: 'aa-write' } });
    await expect(capture.readRecallCaptureWorkflow('capture-user', queued!.id)).resolves.toMatchObject({
      status: 'review_ready',
      workflowStatus: 'completed',
      displayStatus: 'completed',
      linkedAssetIds: ['aa-write'],
    });
  });

  it('recovers an interrupted approved-candidate write back to review', async () => {
    const capture = await captureModule();
    const queued = await capture.queueRecallCaptureFromTerminal(completedEvent);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'captures', queued!.id, (current) => ({
      ...current!,
      status: 'writing',
      visibility: 'visible',
      screeningStatus: 'qualified',
      stage: 'asset_write',
      writingCandidateId: 'cand-write',
      candidateIds: ['cand-write'],
    }));
    mocks.readCandidate.mockResolvedValue({ id: 'cand-write', status: 'pending_review' });

    await expect(capture.recoverRecallCaptures('capture-user')).resolves.toBe(0);
    const recovered = await capture.readRecallCaptureWorkflow('capture-user', queued!.id);
    expect(recovered).toMatchObject({
      status: 'review_ready',
      workflowStatus: 'review_ready',
      displayStatus: 'review_ready',
      displayReason: 'asset_write_interrupted',
      errorCode: 'asset_write_interrupted',
      actions: expect.arrayContaining(['review_candidates', 'open_conversation']),
    });
    expect(recovered).not.toHaveProperty('writingCandidateId');
  });

  it('skips malformed candidates individually and rejects oversized batches', async () => {
    const capture = await captureModule();
    const validLabels = new Set(['m1']);
    const good = { judgment: 'x', summary: 'x', suggestedType: 'rule', suggestedScope: 'x', evidence: ['m1'] };

    // A single malformed candidate no longer kills the batch: it is skipped
    // and the remaining valid candidates survive.
    expect(capture.parseRecallCaptureOutput(JSON.stringify({ candidates: [
      { ...good, suggestedType: 'method' },      // invalid type → skipped
      good,                                       // valid → kept
      { ...good, evidence: ['m2'] },              // unknown evidence → skipped
    ] }), validLabels)).toHaveLength(1);

    // All-malformed batch → empty result (not an exception).
    expect(capture.parseRecallCaptureOutput(JSON.stringify({ candidates: [{
      judgment: 'x', summary: 'x', suggestedType: 'other', suggestedScope: 'x', evidence: ['m1'],
    }] }), validLabels)).toEqual([]);

    // Oversized batch is still rejected as a whole.
    expect(() => capture.parseRecallCaptureOutput(JSON.stringify({ candidates: Array.from({ length: 4 }, () => ({})) }), validLabels))
      .toThrow(/candidate count/i);
  });

  it('tolerates markdown fences and prose wrapping around the JSON (model habit)', async () => {
    const capture = await captureModule();
    const validLabels = new Set(['m1']);
    const payload = JSON.stringify({ candidates: [{
      judgment: 'keep the four-part announcement structure',
      summary: '公告五段式',
      suggestedType: 'template',
      suggestedScope: 'general',
      suggestedAction: 'create',
      risk: 'low',
      evidence: ['m1'],
    }] });

    // ```json 围栏包裹
    const fenced = capture.parseRecallCaptureOutput(`\`\`\`json\n${payload}\n\`\`\``, validLabels);
    expect(fenced).toHaveLength(1);
    expect(fenced[0]).toMatchObject({ suggestedType: 'template', summary: '公告五段式' });
    // 前后散文说明
    const prosey = capture.parseRecallCaptureOutput(`Here is the result:\n${payload}\nHope this helps!`, validLabels);
    expect(prosey).toHaveLength(1);
    expect(prosey[0].evidence).toEqual(['m1']);
    // 围栏 + 散文混合
    const mixed = capture.parseRecallCaptureOutput(`Sure!\n\`\`\`\n${payload}\n\`\`\`\nDone.`, validLabels);
    expect(mixed).toHaveLength(1);
  });

  it('still rejects non-JSON garbage even after tolerance (no balanced object)', async () => {
    const capture = await captureModule();
    const validLabels = new Set(['m1']);
    expect(() => capture.parseRecallCaptureOutput('just some text without braces', validLabels))
      .toThrow(/not strict JSON/i);
    expect(() => capture.parseRecallCaptureOutput('```json\nnot json at all\n```', validLabels))
      .toThrow(/not strict JSON/i);
  });

  it('treats empty-string optional fields as absent (model habit of blanking unused fields)', async () => {
    const capture = await captureModule();
    const validLabels = new Set(['m1']);
    // 模型对不需要的字段（targetAssetId/uncertainty）给空串，不应判失败
    const parsed = capture.parseRecallCaptureOutput(JSON.stringify({ candidates: [{
      judgment: 'multi-format output preference',
      value: 'produce Word/MD/PPT/XLSX/HTML together',
      summary: '多格式输出偏好',
      suggestedType: 'rule',
      suggestedScope: '文档生成类任务',
      suggestedAction: 'create',
      targetAssetId: '',
      risk: 'low',
      evidence: ['m1'],
      uncertainty: '',
    }] }), validLabels);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      suggestedType: 'rule',
      suggestedAction: 'create',
      evidence: ['m1'],
    });
    expect(parsed[0]).not.toHaveProperty('targetAssetId');
    expect(parsed[0]).not.toHaveProperty('uncertainty');
  });

  it('drops wrong-typed optional fields instead of killing the candidate', async () => {
    const capture = await captureModule();
    const validLabels = new Set(['m1']);
    // 模型偶尔把 uncertainty 给成数字/对象（"uncertainty": 0.5），或把
    // targetAssetId 给成非字符串：这些 optional 字段应被忽略，候选保留。
    const parsed = capture.parseRecallCaptureOutput(JSON.stringify({ candidates: [{
      judgment: 'user prefers Chinese comments with a purpose line at function head',
      summary: '中文注释习惯',
      suggestedType: 'personal',
      suggestedScope: 'code',
      suggestedAction: 'create',
      risk: 'low',
      uncertainty: 0.5,
      targetAssetId: { id: 'aa-1' },
      evidence: ['m1'],
    }] }), validLabels);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      suggestedType: 'personal',
      summary: '中文注释习惯',
    });
    expect(parsed[0]).not.toHaveProperty('uncertainty');
    expect(parsed[0]).not.toHaveProperty('targetAssetId');
    // 超长 optional 字符串同样降级为 absent，不杀候选
    const longUncertainty = capture.parseRecallCaptureOutput(JSON.stringify({ candidates: [{
      judgment: 'x', summary: 'x', suggestedType: 'rule', suggestedScope: 'x',
      uncertainty: 'u'.repeat(1_001), evidence: ['m1'],
    }] }), validLabels);
    expect(longUncertainty).toHaveLength(1);
    expect(longUncertainty[0]).not.toHaveProperty('uncertainty');
  });
});
