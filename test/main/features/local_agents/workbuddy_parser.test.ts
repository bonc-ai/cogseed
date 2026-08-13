import { describe, it, expect } from 'vitest';

import { buildWorkbuddyArgs } from '../../../../src/main/features/local_agents/backends/workbuddy';
import { defaultModel, listModels } from '../../../../src/main/features/local_agents/models';
import {
  mapClaudeEvent,
  extractClaudeUsage,
} from '../../../../src/main/features/local_agents/backends/claude';
import { parseWorkbuddyTranscript } from '../../../../src/main/features/session_import/transcript-normalize';

// ── Real WorkBuddy (codebuddy 2.115.0) stream-json records, captured from
//    a live `codebuddy -p "回复OK两个字" --output-format stream-json`. These
//    are the actual bytes the CLI emitted — no fabrication. The point of the
//    reuse-claude-parser design is that mapClaudeEvent handles them as-is.

const REAL_INIT = {
  type: 'system', subtype: 'init',
  session_id: 'bea089dd-8a4c-4b39-b396-70f96a54a150',
  cwd: '/Users/blue', model: 'auto', permissionMode: 'default',
};

const REAL_ASSISTANT_TEXT = {
  type: 'assistant',
  session_id: 'bea089dd-8a4c-4b39-b396-70f96a54a150',
  message: {
    content: [{ type: 'text', text: 'OK' }],
    model: 'deepseek-v4-flash', role: 'assistant',
    usage: {
      input_tokens: 22829, output_tokens: 16,
      cache_creation_input_tokens: 22829, cache_read_input_tokens: 0,
    },
  },
};

const REAL_RESULT = {
  type: 'result', subtype: 'success', is_error: false, result: 'OK',
  session_id: 'bea089dd-8a4c-4b39-b396-70f96a54a150',
  duration_ms: 13293, num_turns: 3, total_cost_usd: 0,
  usage: {
    input_tokens: 23003, output_tokens: 22,
    cache_creation_input_tokens: 22829, cache_read_input_tokens: 0,
  },
  permission_denials: [],
};

describe('local_agents/backends/workbuddy › reuses claude parser on real records', () => {
  it('captures session id from the init record', () => {
    const ev = mapClaudeEvent(REAL_INIT, undefined);
    expect(ev?.captureSession).toBe(true);
    expect(ev?.event).toEqual({ type: 'status', status: 'running' });
  });

  it('surfaces assistant text (no partial stream_events → fallback path)', () => {
    // WorkBuddy does not emit stream_event partials, so sawTextStreamEvent
    // stays false and the assistant block itself yields the reply.
    const ev = mapClaudeEvent(REAL_ASSISTANT_TEXT, REAL_INIT.session_id, { sawTextStreamEvent: false });
    expect(ev?.event).toEqual({ type: 'text-delta', text: 'OK' });
  });

  it('parses the terminal result into a completed turn with usage', () => {
    const ev = mapClaudeEvent(REAL_RESULT, REAL_INIT.session_id);
    expect(ev?.terminal?.status).toBe('completed');
    expect(ev?.terminal?.text).toBe('OK');
    expect(ev?.terminal?.usage).toMatchObject({
      input: 23003, output: 22, cacheCreate: 22829, cacheRead: 0,
    });
  });

  it('extracts usage field-for-field from WorkBuddy result shape', () => {
    const u = extractClaudeUsage(REAL_RESULT);
    expect(u).toMatchObject({ input: 23003, output: 22, cacheCreate: 22829, cacheRead: 0 });
  });

  it('silently ignores WorkBuddy-only record types', () => {
    expect(mapClaudeEvent({ type: 'system', subtype: 'status', status: null }, undefined)).toBeUndefined();
    expect(mapClaudeEvent({ type: 'file-history-snapshot', id: 'x' }, undefined)).toBeUndefined();
    expect(mapClaudeEvent({ type: 'ai-title', aiTitle: '回复OK两个字' }, undefined)).toBeUndefined();
  });
});

describe('local_agents/backends/workbuddy › buildWorkbuddyArgs', () => {
  it('passes the prompt as a -p argv value with stream-json output', () => {
    const args = buildWorkbuddyArgs({ prompt: '你好' });
    expect(args).toEqual(['-p', '你好', '--output-format', 'stream-json', '--verbose']);
  });

  it('appends --model when specified and --append-system-prompt for asset injection', () => {
    const args = buildWorkbuddyArgs({
      prompt: 'task', model: 'glm-5.2',
      bridge: { mcpConfigPath: '/x', server: { command: 'c', args: [], env: {} }, appendSystemPrompt: 'ASSETS' },
    });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('glm-5.2');
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('ASSETS');
  });

  it('resumes a prior session id when provided', () => {
    const args = buildWorkbuddyArgs({ prompt: 'x', resumeSessionId: 'sess-1' });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-1');
  });
});

describe('local_agents/models › workbuddy catalog', () => {
  it('exposes auto as the default plus pinnable ids', () => {
    expect(listModels('workbuddy').map(m => m.id)).toEqual(['auto', 'glm-5.2', 'glm-5.1', 'hy3']);
    expect(defaultModel('workbuddy')).toBe('auto');
  });
});

// ── Transcript normalization against WorkBuddy's real on-disk jsonl shape:
//    type:"message" + TOP-LEVEL role/content, epoch-ms timestamps, and the
//    first user turn wrapping the real prompt in <user_query> inside a big
//    system-reminder blob.

describe('session_import/transcript-normalize › parseWorkbuddyTranscript', () => {
  const jsonl = [
    JSON.stringify({
      id: 'a', timestamp: 1786584623686, type: 'message', role: 'user',
      content: [{
        type: 'input_text',
        text: '<system-reminder data-role="memory">lots of context…</system-reminder>\n<user_query>帮我梳理一下这个季度的目标</user_query>',
      }],
    }),
    JSON.stringify({
      id: 'b', timestamp: 1786584630000, type: 'message', role: 'assistant',
      content: [
        { type: 'thinking', text: 'internal reasoning that must be dropped' },
        { type: 'text', text: '好的，我们分三步来梳理。' },
      ],
    }),
    // Non-message noise that must be skipped.
    JSON.stringify({ type: 'ai-title', aiTitle: '季度目标' }),
    JSON.stringify({ type: 'file-history-snapshot', id: 'c' }),
    JSON.stringify({
      id: 'd', timestamp: 1786584640000, type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '第二步具体怎么做？' }],
    }),
  ].join('\n');

  it('extracts user_query, drops thinking + reminder scaffolding, keeps assistant text', () => {
    const t = parseWorkbuddyTranscript(jsonl, 'sess-uuid');
    expect(t.source).toBe('workbuddy');
    expect(t.sourceId).toBe('sess-uuid');
    expect(t.turns).toEqual([
      { role: 'user', text: '帮我梳理一下这个季度的目标', ts: new Date(1786584623686).toISOString() },
      { role: 'assistant', text: '好的，我们分三步来梳理。', ts: new Date(1786584630000).toISOString() },
      { role: 'user', text: '第二步具体怎么做？', ts: new Date(1786584640000).toISOString() },
    ]);
  });

  it('is best-effort: malformed lines are skipped, not thrown', () => {
    const withGarbage = 'not json\n' + jsonl + '\n{"partial":';
    expect(() => parseWorkbuddyTranscript(withGarbage, 's')).not.toThrow();
    expect(parseWorkbuddyTranscript(withGarbage, 's').turns.length).toBe(3);
  });

  it('returns empty turns for a transcript with no usable messages', () => {
    const onlyNoise = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'x' }),
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<system-reminder>only scaffolding</system-reminder>' }] }),
    ].join('\n');
    expect(parseWorkbuddyTranscript(onlyNoise, 's').turns).toEqual([]);
  });
});
