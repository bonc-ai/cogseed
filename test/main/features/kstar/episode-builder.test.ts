import { describe, expect, it } from 'vitest';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from '../../../../src/main/features/mate_agent_runtime/protocol';

function runtimeRequest(): RuntimeRunRequest {
  return {
    protocol_version: 1,
    type: 'run',
    request_id: 'req-a',
    runtime_session_id: 'mruntime-a',
    user_id: 'builder-user',
    task: 'Create the requested report.',
    context: [{ type: 'text', content: 'Use the attached requirements.' }],
    attachments: [],
    read_only_roots: ['/tmp/project'],
    working_dir: '/tmp/project',
    model_profile: 'balanced',
  };
}

const toolCall: RuntimeEventEnvelope = {
  type: 'event', request_id: 'req-a', runtime_session_id: 'mruntime-a', status: 'running',
  metadata: { kernel_event: 'tool_call', id: 'call-a', name: 'read_file', arguments: { path: '/tmp/project/spec.md' } },
};
const toolResult: RuntimeEventEnvelope = {
  type: 'event', request_id: 'req-a', runtime_session_id: 'mruntime-a', status: 'running', text: 'requirements',
  metadata: { kernel_event: 'tool_result', id: 'call-a', name: 'read_file', isError: false },
};
const completed: RuntimeEventEnvelope = {
  type: 'result', request_id: 'req-a', runtime_session_id: 'mruntime-a', status: 'completed', text: 'Report created.',
};

describe('KSTAR episode builders', () => {
  it('normalizes Runtime request/events into bounded K/S/T/A/R evidence', async () => {
    const { buildRuntimeKstarEpisode } = await import('../../../../src/main/features/kstar/episode-builder');
    const episode = buildRuntimeKstarEpisode({
      userId: 'builder-user',
      runId: 'run-a',
      request: runtimeRequest(),
      events: [toolCall, toolResult, completed],
      createdAt: '2026-08-05T00:00:00.000Z',
    });

    expect(episode).toMatchObject({
      id: 'kse-run-a',
      ownerId: 'builder-user',
      sessionId: 'mruntime-a',
      taskRunId: 'run-a',
      requestId: 'req-a',
      runtimeSessionId: 'mruntime-a',
      t: { userGoal: 'Create the requested report.' },
      r: { status: 'completed', finalText: 'Report created.' },
    });
    expect(episode.a.toolCalls).toEqual([
      expect.objectContaining({ name: 'read_file', id: 'call-a', status: 'ok', argumentsSummary: 'path' }),
    ]);
    expect(episode.evidenceRefs).toContainEqual(expect.objectContaining({ kind: 'execution', id: 'run-a' }));
    expect(episode.evidenceRefs).toContainEqual(expect.objectContaining({ kind: 'context' }));
  });

  it('records failed and cancelled Runtime outcomes without treating error text as a success', async () => {
    const { buildRuntimeKstarEpisode } = await import('../../../../src/main/features/kstar/episode-builder');
    const failed = buildRuntimeKstarEpisode({
      userId: 'builder-user', runId: 'run-failed', request: runtimeRequest(),
      events: [{ ...toolCall, metadata: { ...toolCall.metadata, name: 'write_file' } }, {
        type: 'error', request_id: 'req-a', runtime_session_id: 'mruntime-a', status: 'failed',
        error: 'permission denied', metadata: { code: 'runtime_tool_error' },
      }],
      createdAt: '2026-08-05T00:00:00.000Z',
    });
    const cancelled = buildRuntimeKstarEpisode({
      userId: 'builder-user', runId: 'run-cancelled', request: runtimeRequest(),
      events: [{ type: 'error', request_id: 'req-a', runtime_session_id: 'mruntime-a', status: 'cancelled', error: 'cancelled' }],
      createdAt: '2026-08-05T00:00:00.000Z',
    });

    expect(failed.r).toMatchObject({ status: 'failed', failureCode: 'runtime_tool_error' });
    expect(cancelled.r).toMatchObject({ status: 'cancelled', failureKind: 'cancelled' });
  });

  it('builds a group episode from bounded user and actor messages', async () => {
    const { buildGroupKstarEpisode } = await import('../../../../src/main/features/kstar/episode-builder');
    const episode = buildGroupKstarEpisode({
      userId: 'builder-user',
      runId: 'run-group',
      conversationId: 'cid-a',
      status: 'completed',
      startedAtMs: Date.parse('2026-08-05T00:00:00.000Z'),
      finishedAtMs: Date.parse('2026-08-05T00:01:00.000Z'),
      messages: [
        { id: 'msg-old', ts: '2026-08-04T23:59:00.000Z', from: 'user', to: [], text: 'old' },
        { id: 'msg-user', ts: '2026-08-05T00:00:01.000Z', from: 'user', to: [], text: 'Make a concise plan.' },
        { id: 'msg-agent', ts: '2026-08-05T00:00:30.000Z', from: 'commander', to: [], text: 'Plan completed.', produced: ['/tmp/plan.md'] },
      ],
    });

    expect(episode).toMatchObject({
      id: 'kse-run-group',
      sessionId: 'gconv-cid-a',
      sessionKind: 'group_chat',
      r: { status: 'completed', finalText: 'Plan completed.', producedFiles: ['plan.md'] },
      t: { userGoal: 'Make a concise plan.' },
    });
    expect(episode.a.agentActions).toEqual([expect.objectContaining({ actor: 'commander', action: 'Plan completed.' })]);
    expect(episode.evidenceRefs).toContainEqual(expect.objectContaining({ kind: 'conversation', id: 'msg-user' }));
    expect(episode.evidenceRefs).not.toContainEqual(expect.objectContaining({ id: 'msg-old' }));
  });
});
