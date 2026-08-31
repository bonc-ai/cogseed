import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRetryResumeModelText } from '../../../../src/main/features/group_chat/retry_resume';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const storageFaults = vi.hoisted(() => ({
  failCompletedRetryClaimWrite: false,
  failPendingRetryClaimWrite: false,
}));

vi.mock('../../../../src/main/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/storage')>();
  return {
    ...actual,
    writeJson: async (...args: Parameters<typeof actual.writeJson>) => {
      const [file, value] = args;
      if (storageFaults.failPendingRetryClaimWrite
        && String(file).includes('dashboard-retry-claims')
        && value && typeof value === 'object'
        && (value as { status?: unknown }).status === 'pending') {
        storageFaults.failPendingRetryClaimWrite = false;
        throw new Error('simulated failure after target claim persistence');
      }
      if (storageFaults.failCompletedRetryClaimWrite
        && String(file).includes('dashboard-retry-claims')
        && value && typeof value === 'object'
        && (value as { status?: unknown }).status === 'completed') {
        storageFaults.failCompletedRetryClaimWrite = false;
        throw new Error('simulated retry claim completion failure');
      }
      return actual.writeJson(...args);
    },
  };
});

let tmpDir: string;
let previousWorkspace: string | undefined;

const UID = 'failed-retry-user';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-failed-retry-'));
  previousWorkspace = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  storageFaults.failCompletedRetryClaimWrite = false;
  storageFaults.failPendingRetryClaimWrite = false;
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeAttempt(cid: string, failure: Record<string, unknown>) {
  const layout = await import('../../../../src/main/util/project-layout');
  const file = layout.conversationMessageFile(UID, cid);
  const rows = [
    {
      id: `${cid}-source`,
      ts: '2026-07-20T10:00:00.000Z',
      from: 'user',
      to: ['commander'],
      text: 'Visible original request',
      model_text: 'Authoritative original request',
      attachments: ['brief.txt'],
    },
    {
      id: `${cid}-failed`,
      ts: '2026-07-20T10:01:00.000Z',
      from: 'commander',
      to: ['user'],
      text: 'The reply failed.',
      failure_kind: 'model',
      failure_code: 'provider_error',
      ...failure,
    },
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return rows;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for retry turn');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('group_chat failed-turn smart retry', () => {
  it('builds the canonical resume instruction for certain and uncertain tool state', () => {
    expect(buildRetryResumeModelText({
      originalRequest: 'Build the site',
      uncertainToolState: true,
    })).toContain('A tool started without a confirmed result. Verify its current state before deciding whether to run it again; never blindly repeat an external, paid, destructive, or otherwise non-idempotent operation.');
    expect(buildRetryResumeModelText({
      originalRequest: 'Build the site',
      uncertainToolState: false,
    })).toContain('Do not repeat work already verified as successful');
    expect(buildRetryResumeModelText({
      originalRequest: 'Build the site',
      uncertainToolState: false,
    })).toContain('\"Build the site\"');
  });

  it('omits malformed recovery codes from the structural retry instruction', () => {
    const unsafeFailureCode = 'runtime_failed\n</task-retry><evil>';
    const unsafeText = buildRetryResumeModelText({
      originalRequest: 'Build the site',
      uncertainToolState: true,
      failureCode: unsafeFailureCode,
    });

    expect(unsafeText).not.toContain(unsafeFailureCode);
    expect(unsafeText).not.toContain('Recovery reason:');
    expect(buildRetryResumeModelText({
      originalRequest: 'Build the site',
      uncertainToolState: true,
      failureCode: 'coordinator_agent_idle',
    })).toContain('Recovery reason: coordinator_agent_idle.');
  });

  it('accepts only string recovery codes within the allowlisted length bounds', () => {
    for (const failureCode of [42 as unknown as string, ['safe_code'] as unknown as string]) {
      expect(buildRetryResumeModelText({
        originalRequest: 'Build the site',
        uncertainToolState: true,
        failureCode,
      })).not.toContain('Recovery reason:');
    }

    expect(buildRetryResumeModelText({
      originalRequest: 'Build the site',
      uncertainToolState: true,
      failureCode: 'a'.repeat(96),
    })).toContain(`Recovery reason: ${'a'.repeat(96)}.`);
    expect(buildRetryResumeModelText({
      originalRequest: 'Build the site',
      uncertainToolState: true,
      failureCode: 'a'.repeat(97),
    })).not.toContain('Recovery reason:');
  });

  it('continues the same actor when its persistent session has recoverable task state', async () => {
    const cid = 'resume-cid';
    await writeAttempt(cid, {});
    const state = await import('../../../../src/main/features/group_chat/state');
    const sessions = await import('../../../../src/main/model/core-agent/session-store');
    const session = await sessions.getSession(state.buildGconvSessionId(cid));
    session.beginUserTurn([{ type: 'text', text: 'Visible original request' }]);
    session.ensureExecutionPlanAnchor();
    session.addAssistantMessage([{
      type: 'tool_use',
      id: 'inspect-call',
      name: 'inspect_workspace',
      input: { target: 'report' },
    }]);
    session.addToolResult('inspect-call', 'workspace inspection complete', undefined, false);
    session.recordCompletedWork({
      toolCallId: 'inspect-call',
      tool: 'inspect_workspace',
      inputDigest: 'inspect:report',
      inputSummary: '{"target":"report"}',
      status: 'succeeded',
      resultSummary: 'workspace inspection complete',
    });
    // Force the resolver to reload JSONL + context sidecar instead of seeing
    // the in-memory session created above. This models an application restart.
    sessions._evictAll();

    const groupChat = await import('../../../../src/main/features/group_chat');
    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('resume');
    expect(resolved.value.enqueue).toMatchObject({
      uid: UID,
      cid,
      fromActorId: 'user',
      text: 'Continue',
      forceTo: ['commander'],
      userRoute: { agentId: 'commander', origin: 'failed_turn_retry' },
    });
    expect(resolved.value.enqueue.model_text).toContain('<task-retry mode="resume">');
    expect(resolved.value.enqueue.model_text).toContain('Do not repeat work already verified as successful');
    expect(resolved.value.enqueue.model_text).toContain('Authoritative original request');
    expect(resolved.value.enqueue.resumeActiveTurn).toBe(true);
    expect(resolved.value.enqueue).not.toHaveProperty('attachments');
    const restored = await sessions.getSession(state.buildGconvSessionId(cid));
    expect(restored.getSerializedContextState()?.activeTurn).toBeTruthy();
    expect(restored.getCompletedWorkLedger()).toEqual([
      expect.objectContaining({ tool: 'inspect_workspace', status: 'succeeded' }),
    ]);
  });

  it('continues from a completed turn when its plan and completed-work evidence remain durable', async () => {
    const cid = 'completed-state-cid';
    await writeAttempt(cid, {});
    const state = await import('../../../../src/main/features/group_chat/state');
    const sessions = await import('../../../../src/main/model/core-agent/session-store');
    const session = await sessions.getSession(state.buildGconvSessionId(cid));
    session.beginUserTurn([{ type: 'text', text: 'Visible original request' }]);
    session.updateExecutionPlan({
      steps: [
        { step: 'Inspect inputs', status: 'completed' },
        { step: 'Generate final report', status: 'pending' },
      ],
    });
    session.recordCompletedWork({
      tool: 'inspect_workspace',
      inputDigest: 'inspect:inputs',
      inputSummary: '{"scope":"inputs"}',
      status: 'succeeded',
      resultSummary: 'inputs verified',
    });
    session.addAssistantMessage([{ type: 'text', text: 'Partial result before host failure' }]);
    session.completeActiveTurn('host failed after model output');
    sessions._evictAll();

    const groupChat = await import('../../../../src/main/features/group_chat');
    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('resume');
    expect(resolved.value.enqueue.resumeActiveTurn).toBe(true);
  });

  it('continues an uncertain started tool from persisted process evidence and requires verification', async () => {
    const cid = 'uncertain-tool-cid';
    await writeAttempt(cid, {
      failure_kind: 'config',
      failure_code: 'worker_lost_after_tool_start',
      process: [{
        event: {
          stream: 'tool',
          data: { phase: 'start', tool: 'publish_external_asset' },
        },
      }],
    });
    const groupChat = await import('../../../../src/main/features/group_chat');

    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('resume');
    expect(resolved.value.enqueue.resumeActiveTurn).toBe(true);
    expect(resolved.value.enqueue.model_text).toContain('Verify its current state before deciding whether to run it again;');
    expect(resolved.value.enqueue.model_text).toContain('non-idempotent operation');
  });

  it('replays the authoritative request and attachments when no recoverable state exists', async () => {
    const cid = 'restart-cid';
    await writeAttempt(cid, { failure_kind: 'config', failure_code: 'model_not_configured' });
    const groupChat = await import('../../../../src/main/features/group_chat');

    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('restart');
    expect(resolved.value.enqueue).toMatchObject({
      uid: UID,
      cid,
      fromActorId: 'user',
      text: 'Continue',
      model_text: 'Authoritative original request',
      attachments: ['brief.txt'],
      forceTo: ['commander'],
    });
    expect(resolved.value.enqueue).not.toHaveProperty('resumeActiveTurn');
  });

  it('restarts an older failed bubble instead of attaching it to a newer actor turn', async () => {
    const cid = 'stale-failure-cid';
    await writeAttempt(cid, {});
    const layout = await import('../../../../src/main/util/project-layout');
    const file = layout.conversationMessageFile(UID, cid);
    fs.appendFileSync(file, [
      JSON.stringify({
        id: `${cid}-newer-user`,
        ts: '2026-07-20T10:02:00.000Z',
        from: 'user',
        to: ['commander'],
        text: 'A newer task',
        model_text: 'Authoritative newer task',
      }),
      JSON.stringify({
        id: `${cid}-newer-failed`,
        ts: '2026-07-20T10:03:00.000Z',
        from: 'commander',
        to: ['user'],
        text: 'The newer reply failed.',
        failure_kind: 'model',
        failure_code: 'provider_error',
      }),
    ].join('\n') + '\n');
    const state = await import('../../../../src/main/features/group_chat/state');
    const sessions = await import('../../../../src/main/model/core-agent/session-store');
    const session = await sessions.getSession(state.buildGconvSessionId(cid));
    session.beginUserTurn([{ type: 'text', text: 'A newer task' }]);
    session.ensureExecutionPlanAnchor();

    const groupChat = await import('../../../../src/main/features/group_chat');
    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('restart');
    expect(resolved.value.enqueue.model_text).toBe('Authoritative original request');
    expect(resolved.value.enqueue.attachments).toEqual(['brief.txt']);
    expect(resolved.value.enqueue).not.toHaveProperty('resumeActiveTurn');
  });

  it('rejects a successful assistant message as a retry target', async () => {
    const cid = 'success-cid';
    await writeAttempt(cid, { failure_kind: undefined, failure_code: undefined, text: 'Done.' });
    const groupChat = await import('../../../../src/main/features/group_chat');

    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved).toEqual({ ok: false, error: 'retry target is not a failed assistant reply' });
  });

  it('replays a Dashboard retry idempotently and rejects request-id payload conflicts', async () => {
    const cid = 'idempotent-retry-cid';
    await writeAttempt(cid, { failure_kind: 'config', failure_code: 'model_not_configured' });
    const groupChat = await import('../../../../src/main/features/group_chat');
    const input = {
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
      requestId: 'req-dashboard-idempotent-retry',
    };

    const first = await groupChat.retryFailedTurn(input);
    const replay = await groupChat.retryFailedTurn(input);
    const conflict = await groupChat.retryFailedTurn({ ...input, visibleText: 'Different request' });

    expect(first).toMatchObject({ ok: true, mode: 'restart', msg: { action_request_id: input.requestId } });
    expect(replay).toMatchObject({ ok: true, mode: 'restart', msg: { id: first.msg?.id } });
    expect(conflict).toEqual({ ok: false, error: 'retry request ID payload conflict' });
    const layout = await import('../../../../src/main/util/project-layout');
    const rows = fs.readFileSync(layout.conversationMessageFile(UID, cid), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.action_request_id === input.requestId)).toHaveLength(1);
    await groupChat.dropConv(UID, cid);
  });

  it('allows only one request ID to claim the same failed message concurrently', async () => {
    const cid = 'retry-target-claim-cid';
    await writeAttempt(cid, { failure_kind: 'config', failure_code: 'model_not_configured' });
    const groupChat = await import('../../../../src/main/features/group_chat');
    const base = {
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    };

    const results = await Promise.all([
      groupChat.retryFailedTurn({ ...base, requestId: 'req-dashboard-target-a' }),
      groupChat.retryFailedTurn({ ...base, requestId: 'req-dashboard-target-b' }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: 'retry target already claimed' },
    ]);
    const layout = await import('../../../../src/main/util/project-layout');
    const rows = fs.readFileSync(layout.conversationMessageFile(UID, cid), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.filter((row) => (
      row.action_request_id === 'req-dashboard-target-a'
      || row.action_request_id === 'req-dashboard-target-b'
    ))).toHaveLength(1);
    await groupChat.dropConv(UID, cid);
  });

  it('lets a fresh request ID take over when only the target claim persisted before the message', async () => {
    const cid = 'retry-target-before-message-cid';
    await writeAttempt(cid, { failure_kind: 'config', failure_code: 'model_not_configured' });
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const interruptedInput = {
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
      requestId: 'req-dashboard-target-before-message-a',
    };
    const recoveryInput = {
      ...interruptedInput,
      requestId: 'req-dashboard-target-before-message-b',
    };
    let releaseTurn = () => {};
    const holdTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let startedTurns = 0;
    bus._setActorTurnPreBodyHookForTest(async () => {
      startedTurns += 1;
      await holdTurn;
    });

    try {
      storageFaults.failPendingRetryClaimWrite = true;
      expect(await groupChat.retryFailedTurn(interruptedInput)).toEqual({
        ok: false,
        error: 'simulated failure after target claim persistence',
      });
      const layout = await import('../../../../src/main/util/project-layout');
      let rows = fs.readFileSync(layout.conversationMessageFile(UID, cid), 'utf8')
        .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.filter((row) => row.action_request_id)).toHaveLength(0);
      expect(fs.existsSync(path.join(
        layout.conversationLayout(UID, cid).groupDir,
        'dashboard-retry-target-claims',
        `${cid}-failed.json`,
      ))).toBe(true);
      expect(fs.existsSync(path.join(
        layout.conversationLayout(UID, cid).groupDir,
        'dashboard-retry-claims',
        `${interruptedInput.requestId}.json`,
      ))).toBe(false);

      const recovered = await groupChat.retryFailedTurn(recoveryInput);
      expect(recovered).toMatchObject({
        ok: true,
        mode: 'restart',
        msg: { action_request_id: recoveryInput.requestId },
      });
      await waitUntil(() => startedTurns === 1);
      await expect(groupChat.retryFailedTurn(interruptedInput)).resolves.toEqual({
        ok: false,
        error: 'retry target already claimed',
      });
      expect(startedTurns).toBe(1);
      rows = fs.readFileSync(layout.conversationMessageFile(UID, cid), 'utf8')
        .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.filter((row) => (
        row.action_request_id === interruptedInput.requestId
        || row.action_request_id === recoveryInput.requestId
      ))).toHaveLength(1);
    } finally {
      bus._setActorTurnPreBodyHookForTest(null);
      releaseTurn();
      await waitUntil(() => bus.isQuiescent(UID, cid), 5_000).catch(() => undefined);
      await groupChat.dropConv(UID, cid);
    }
  });

  it('lets a fresh request ID take over one persisted retry after failure before queue insertion', async () => {
    const cid = 'retry-persisted-before-queue-cid';
    await writeAttempt(cid, { failure_kind: 'config', failure_code: 'model_not_configured' });
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const interruptedInput = {
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
      requestId: 'req-dashboard-persisted-before-queue-a',
    };
    const recoveryInput = {
      ...interruptedInput,
      requestId: 'req-dashboard-persisted-before-queue-b',
    };
    let releaseTurn = () => {};
    const holdTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let startedTurns = 0;
    bus._setBeforeQueueDispatchForTest(() => {
      throw new Error('simulated failure before queue insertion');
    });
    bus._setActorTurnPreBodyHookForTest(async () => {
      startedTurns += 1;
      await holdTurn;
    });

    try {
      const interrupted = await groupChat.retryFailedTurn(interruptedInput);
      expect(interrupted).toEqual({
        ok: false,
        error: 'simulated failure before queue insertion',
      });
      bus._setBeforeQueueDispatchForTest(null);

      const recovered = await groupChat.retryFailedTurn(recoveryInput);
      expect(recovered).toMatchObject({
        ok: true,
        mode: 'restart',
        msg: { action_request_id: interruptedInput.requestId },
      });
      await waitUntil(() => startedTurns === 1);
      const replay = await groupChat.retryFailedTurn(recoveryInput);
      expect(replay).toMatchObject({ ok: true, msg: { id: recovered.msg?.id } });
      expect(startedTurns).toBe(1);

      const layout = await import('../../../../src/main/util/project-layout');
      const rows = fs.readFileSync(layout.conversationMessageFile(UID, cid), 'utf8')
        .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.filter((row) => (
        row.action_request_id === interruptedInput.requestId
        || row.action_request_id === recoveryInput.requestId
      ))).toHaveLength(1);
    } finally {
      bus._setBeforeQueueDispatchForTest(null);
      bus._setActorTurnPreBodyHookForTest(null);
      releaseTurn();
      await waitUntil(() => bus.isQuiescent(UID, cid), 5_000).catch(() => undefined);
      await groupChat.dropConv(UID, cid);
    }
  });

  it('does not replay a persisted retry whose stable turn already completed', async () => {
    const cid = 'retry-completed-before-takeover-cid';
    await writeAttempt(cid, { failure_kind: 'config', failure_code: 'model_not_configured' });
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const firstInput = {
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
      requestId: 'req-dashboard-completed-takeover-a',
    };

    try {
      const layout = await import('../../../../src/main/util/project-layout');
      const { cogSeedRequestFingerprint } = await import('../../../../src/main/features/cogseed_backend/request-fingerprint');
      const fingerprint = cogSeedRequestFingerprint('retry', {
        cid,
        failedMessageId: firstInput.failedMessageId,
        visibleText: firstInput.visibleText,
      });
      const dispatchTurnId = `turn-retry-${fingerprint.slice(0, 24)}`;
      const canonicalMessageId = `${cid}-canonical`;
      const targetClaimFile = path.join(
        layout.conversationLayout(UID, cid).groupDir,
        'dashboard-retry-target-claims',
        `${cid}-failed.json`,
      );
      fs.mkdirSync(path.dirname(targetClaimFile), { recursive: true });
      fs.writeFileSync(targetClaimFile, JSON.stringify({
        schemaVersion: 1,
        requestId: firstInput.requestId,
        fingerprint,
        failedMessageId: firstInput.failedMessageId,
        mode: 'restart',
        dispatchTurnId,
        canonicalRequestId: firstInput.requestId,
        messageId: canonicalMessageId,
        createdAt: '2026-07-20T10:01:30.000Z',
        updatedAt: '2026-07-20T10:01:30.000Z',
      }));
      const completedMessageId = `${cid}-completed`;
      fs.appendFileSync(layout.conversationMessageFile(UID, cid), [
        JSON.stringify({
          id: canonicalMessageId,
          ts: '2026-07-20T10:01:30.000Z',
          from: 'user',
          to: ['commander'],
          text: firstInput.visibleText,
          action_request_id: firstInput.requestId,
        }),
        JSON.stringify({
          id: completedMessageId,
          ts: '2026-07-20T10:02:00.000Z',
          from: 'commander',
          to: ['user'],
          text: 'Done.',
          turn_id: dispatchTurnId,
          turn_end: true,
        }),
      ].join('\n') + '\n');
      const deletion = await groupChat.deleteMessages(UID, cid, [completedMessageId]);
      expect(deletion).toEqual({
        ok: true,
        deleted: [completedMessageId],
      });
      const completedTombstone = fs.readFileSync(layout.conversationMessageFile(UID, cid), 'utf8')
        .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        .find((row) => row.id === completedMessageId);
      expect(completedTombstone).toMatchObject({
        text: '',
        deleted_by_user: true,
        turn_id: dispatchTurnId,
        turn_end: true,
      });

      const takeover = await groupChat.retryFailedTurn({
        ...firstInput,
        requestId: 'req-dashboard-completed-takeover-b',
      });
      expect(takeover).toEqual({ ok: false, error: 'retry target already claimed' });
      expect(bus.isQuiescent(UID, cid)).toBe(true);
    } finally {
      await groupChat.dropConv(UID, cid);
    }
  });

  it('fails closed when a persisted target claim is malformed', async () => {
    const cid = 'retry-corrupt-target-claim-cid';
    await writeAttempt(cid, { failure_kind: 'config', failure_code: 'model_not_configured' });
    const layout = await import('../../../../src/main/util/project-layout');
    const targetClaimFile = path.join(
      layout.conversationLayout(UID, cid).groupDir,
      'dashboard-retry-target-claims',
      `${cid}-failed.json`,
    );
    fs.mkdirSync(path.dirname(targetClaimFile), { recursive: true });
    fs.writeFileSync(targetClaimFile, JSON.stringify({ schemaVersion: 1, requestId: '../bad' }));
    const groupChat = await import('../../../../src/main/features/group_chat');

    const result = await groupChat.retryFailedTurn({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
      requestId: 'req-dashboard-corrupt-target',
    });

    expect(result).toEqual({ ok: false, error: 'malformed Group Chat retry target claim' });
    const rows = fs.readFileSync(layout.conversationMessageFile(UID, cid), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.action_request_id)).toHaveLength(0);
    await groupChat.dropConv(UID, cid);
  });

  it('repairs a pending retry claim when the message persisted before completion bookkeeping failed', async () => {
    const cid = 'retry-claim-repair-cid';
    await writeAttempt(cid, { failure_kind: 'config', failure_code: 'model_not_configured' });
    const groupChat = await import('../../../../src/main/features/group_chat');
    const input = {
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
      requestId: 'req-dashboard-retry-claim-repair',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    let releaseTurn = () => {};
    const holdTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let startedTurns = 0;
    bus._setActorTurnPreBodyHookForTest(async () => {
      startedTurns += 1;
      await holdTurn;
    });

    try {
      storageFaults.failCompletedRetryClaimWrite = true;
      const interrupted = await groupChat.retryFailedTurn(input);
      await waitUntil(() => startedTurns === 1);
      const recovered = await groupChat.retryFailedTurn(input);

      expect(interrupted).toEqual({
        ok: false,
        error: 'simulated retry claim completion failure',
      });
      expect(recovered).toMatchObject({
        ok: true,
        mode: 'restart',
        msg: { action_request_id: input.requestId },
      });
      expect(startedTurns).toBe(1);
      const layout = await import('../../../../src/main/util/project-layout');
      const rows = fs.readFileSync(layout.conversationMessageFile(UID, cid), 'utf8')
        .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.filter((row) => row.action_request_id === input.requestId)).toHaveLength(1);
    } finally {
      bus._setActorTurnPreBodyHookForTest(null);
      releaseTurn();
      await waitUntil(() => bus.isQuiescent(UID, cid), 5_000).catch(() => undefined);
      await groupChat.dropConv(UID, cid);
    }
  });
});
