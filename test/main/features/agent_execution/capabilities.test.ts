import { describe, expect, it } from 'vitest';

import {
  AGENT_BACKEND_CAPABILITIES,
  AGENT_CAPABILITIES,
  getMissingAgentCapabilities,
  isAgentCapability,
  isAgentExecutionRequest,
  isAgentExecutionEvent,
  isAgentFallbackReason,
  isTerminalAgentExecutionEvent,
  isValidAgentExecutionEventSequence,
  assertAgentExecutionRequest,
  type AgentExecutionEvent,
  type AgentExecutionRequest,
} from '../../../../src/main/features/agent_execution';

const request: AgentExecutionRequest = {
  userId: 'user-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  task: 'Read the attached note and summarize it.',
  context: [{ type: 'text', content: 'Keep the summary concise.', label: 'instruction' }],
  attachments: [{ type: 'file', path: '/tmp/note.txt', name: 'note.txt' }],
  requiredCapabilities: ['file'],
  backendPreference: 'auto',
  allowFallback: true,
  allowSideEffects: false,
};

const baseEvent = {
  requestId: request.requestId,
  sessionId: request.sessionId,
  backend: 'native' as const,
};

describe('shared agent execution contract', () => {
  it('accepts an explicit task/context/attachment request without conversation fields', () => {
    expect(isAgentExecutionRequest(request)).toBe(true);
    expect(Object.keys(request).sort()).toEqual([
      'allowFallback',
      'allowSideEffects',
      'attachments',
      'backendPreference',
      'context',
      'requestId',
      'requiredCapabilities',
      'sessionId',
      'task',
      'userId',
    ]);
    expect(Object.keys(request)).not.toEqual(expect.arrayContaining(['cid', 'gconv', 'gmember', 'full_transcript']));
  });

  it('accepts the supported event sequence and identifies terminal events/outcomes', () => {
    const events: AgentExecutionEvent[] = [
      { ...baseEvent, type: 'started' },
      { ...baseEvent, type: 'model_delta', text: 'Summary' },
      { ...baseEvent, type: 'tool_call', metadata: { tool: 'read_file' } },
      { ...baseEvent, type: 'tool_result', metadata: { ok: true } },
      { ...baseEvent, type: 'result', text: 'Summary' },
    ];

    expect(events.every(isAgentExecutionEvent)).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      'started',
      'model_delta',
      'tool_call',
      'tool_result',
      'result',
    ]);
    expect(events.filter(isTerminalAgentExecutionEvent).map((event) => event.type)).toEqual(['result']);
    expect(isValidAgentExecutionEventSequence(events)).toBe(true);
    expect(isTerminalAgentExecutionEvent({ ...baseEvent, type: 'error' })).toBe(true);
    expect(isTerminalAgentExecutionEvent({ ...baseEvent, type: 'cancelled' })).toBe(true);
  });

  it('exposes the canonical capability set and conservative backend matrices', () => {
    expect(AGENT_CAPABILITIES).toEqual([
      'file',
      'shell',
      'skill',
      'kb',
      'search',
      'connector',
      'browser',
      'office',
      'history',
    ]);
    expect(AGENT_BACKEND_CAPABILITIES.native).toEqual(['file', 'shell', 'skill']);
    expect(AGENT_BACKEND_CAPABILITIES.core).toEqual([
      'file',
      'shell',
      'kb',
      'search',
      'connector',
      'office',
      'history',
    ]);
    expect(getMissingAgentCapabilities('native', ['file', 'skill'])).toEqual([]);
    expect(getMissingAgentCapabilities('native', ['file', 'kb'])).toEqual(['kb']);
    expect(getMissingAgentCapabilities('core', ['browser'])).toEqual(['browser']);
    expect(isAgentCapability('browser')).toBe(true);
    expect(isAgentCapability('not-a-capability')).toBe(false);
  });

  it('accepts only the canonical fallback reasons', () => {
    expect(['capability_gap', 'explicit_compatibility'].every(isAgentFallbackReason)).toBe(true);
    expect(isAgentFallbackReason('native_unavailable')).toBe(false);
    expect(isAgentFallbackReason('compatibility_mode')).toBe(false);
    expect(isAgentFallbackReason('unexpected_error')).toBe(false);
  });

  it('rejects events after a terminal event, multiple terminal events, and terminal-only sequences', () => {
    const completed = { ...baseEvent, type: 'result' as const, text: 'done' };
    const failed = { ...baseEvent, type: 'error' as const, text: 'failed' };

    expect(isValidAgentExecutionEventSequence([{ ...baseEvent, type: 'started' }, completed])).toBe(true);
    expect(isValidAgentExecutionEventSequence([completed, { ...baseEvent, type: 'model_delta', text: 'late' }])).toBe(false);
    expect(isValidAgentExecutionEventSequence([{ ...baseEvent, type: 'started' }, completed, failed])).toBe(false);
    expect(isValidAgentExecutionEventSequence([{ ...baseEvent, type: 'started' }])).toBe(false);
    expect(isValidAgentExecutionEventSequence([completed])).toBe(false);
  });

  it('rejects event sequences that mix executions or backends', () => {
    const started = { ...baseEvent, type: 'started' as const };
    const completed = { ...baseEvent, type: 'result' as const, text: 'done' };

    expect(isValidAgentExecutionEventSequence([started, { ...completed, requestId: 'request-2' }])).toBe(false);
    expect(isValidAgentExecutionEventSequence([started, { ...completed, sessionId: 'session-2' }])).toBe(false);
    expect(isValidAgentExecutionEventSequence([started, { ...completed, backend: 'core' as const }])).toBe(false);
  });

  it('rejects conversation-specific and full-transcript fields at runtime', () => {
    for (const field of ['cid', 'gconv', 'gmember', 'full_transcript', 'fullTranscript', 'transcript_path']) {
      const invalid = { ...request, [field]: 'forbidden' };
      expect(isAgentExecutionRequest(invalid), field).toBe(false);
      expect(() => assertAgentExecutionRequest(invalid), field).toThrow(/forbidden/i);
    }
  });

  it('rejects sparse request arrays', () => {
    const sparseContext = new Array(1);
    const sparseAttachments = new Array(1);
    const sparseCapabilities = new Array(1);

    expect(isAgentExecutionRequest({ ...request, context: sparseContext })).toBe(false);
    expect(isAgentExecutionRequest({ ...request, attachments: sparseAttachments })).toBe(false);
    expect(isAgentExecutionRequest({ ...request, requiredCapabilities: sparseCapabilities })).toBe(false);
  });

  it('rejects event objects with conversation-specific fields', () => {
    expect(isAgentExecutionEvent({ ...baseEvent, type: 'started', gconv: 'conversation' })).toBe(false);
    expect(isAgentExecutionEvent({ ...baseEvent, type: 'started', metadata: { gmember: 'member' } })).toBe(false);
  });

  it('rejects nested forbidden fields inside event metadata objects and arrays', () => {
    expect(isAgentExecutionEvent({
      ...baseEvent,
      type: 'tool_result',
      metadata: { wrapper: { cid: 'conversation' } },
    })).toBe(false);
    expect(isAgentExecutionEvent({
      ...baseEvent,
      type: 'tool_result',
      metadata: { items: [{ fullTranscript: 'secret transcript' }] },
    })).toBe(false);
    expect(isAgentExecutionEvent({
      ...baseEvent,
      type: 'tool_result',
      metadata: { rows: [[{ full_transcript: 'secret transcript' }]] },
    })).toBe(false);

    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;
    expect(isAgentExecutionEvent({ ...baseEvent, type: 'tool_result', metadata: cyclic })).toBe(true);
    expect(isAgentExecutionEvent({
      ...baseEvent,
      type: 'tool_result',
      metadata: new Map([['cid', 'secret']]) as unknown as Record<string, unknown>,
    })).toBe(false);
  });
});
