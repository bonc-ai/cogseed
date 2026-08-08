import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Model client stub. Individual tests override `__nextChat` to shape the
// extractor's model output.
let __nextChat: (message: string, systemPrompt?: string) => { ok: boolean; text: string } =
  () => ({ ok: true, text: '' });
// The extractor imports chatWithModel from model/core-agent/client, so that is
// the module we must intercept (not the lower-level model/client).
vi.mock('../../../src/main/model/core-agent/client', () => ({
  async chatWithModel(opts: any) {
    const r = __nextChat(opts.message, opts.systemPrompt);
    return { ok: r.ok, text: r.text, error: r.ok ? '' : 'stub-fail', aborted: false };
  },
}));
// group_chat's send path (reached transitively by chats.ts) still uses the
// lower-level model/client stream — stub it so nothing does a real LLM call.
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel(_opts: any) {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-simport-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  __nextChat = () => ({ ok: true, text: '' });
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session_import › transcript-normalize', () => {
  it('parses new (string content) and old (block array) Claude formats', async () => {
    const { parseClaudeTranscript } = await import(
      '../../../src/main/features/session_import/transcript-normalize'
    );
    const body = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, cwd: '/proj', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } }),
      JSON.stringify({ type: 'queue-operation', foo: 1 }),
      '{ this is not json',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] } }),
    ].join('\n');

    const norm = parseClaudeTranscript(body, 'sess-1');
    expect(norm.source).toBe('claude');
    expect(norm.sourceId).toBe('sess-1');
    expect(norm.projectPath).toBe('/proj');
    // queue-op, malformed and tool-only lines are dropped.
    expect(norm.turns).toEqual([
      { role: 'user', text: 'hello', ts: '2026-01-01T00:00:00Z' },
      { role: 'assistant', text: 'hi there', ts: '' },
    ]);
  });
});

describe('session_import › extractor', () => {
  it('parses strict JSON from a single pass', async () => {
    __nextChat = () => ({
      ok: true,
      text: JSON.stringify({
        summary: '完成了支付迁移，遗留退款回调未测。',
        personal: [{ text: '偏好 TypeScript' }],
        rules: ['提交前必须过 lint'],
        templates: [],
      }),
    });
    const { extractSession } = await import('../../../src/main/features/session_import/extractor');
    const res = await extractSession(TEST_UID, {
      source: 'claude', sourceId: 's', projectPath: '/p',
      turns: [{ role: 'user', text: '帮我迁移支付', ts: '' }],
    });
    expect(res.ok).toBe(true);
    expect(res.sessionSummary).toContain('支付迁移');
    expect(res.personal[0].text).toBe('偏好 TypeScript');
    expect(res.rules[0].text).toBe('提交前必须过 lint');
    expect(res.templates).toEqual([]);
  });

  it('strips code fences around the JSON', async () => {
    __nextChat = () => ({
      ok: true,
      text: '好的，结果如下：\n```json\n{"summary":"S","personal":[],"rules":[],"templates":[]}\n```',
    });
    const { extractSession } = await import('../../../src/main/features/session_import/extractor');
    const res = await extractSession(TEST_UID, {
      source: 'claude', sourceId: 's', projectPath: '',
      turns: [{ role: 'user', text: 'hi', ts: '' }],
    });
    expect(res.ok).toBe(true);
    expect(res.sessionSummary).toBe('S');
  });

  it('degrades honestly when the model output is unparseable', async () => {
    __nextChat = () => ({ ok: true, text: 'sorry no json here' });
    const { extractSession } = await import('../../../src/main/features/session_import/extractor');
    const res = await extractSession(TEST_UID, {
      source: 'claude', sourceId: 's', projectPath: '',
      turns: [{ role: 'user', text: '第一句用户消息', ts: '' }],
    });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    // Fallback seed = first user turn, so the session stays importable.
    expect(res.sessionSummary).toContain('第一句用户消息');
    expect(res.personal).toEqual([]);
  });

  it('degrades when the model call fails', async () => {
    __nextChat = () => ({ ok: false, text: '' });
    const { extractSession } = await import('../../../src/main/features/session_import/extractor');
    const res = await extractSession(TEST_UID, {
      source: 'claude', sourceId: 's', projectPath: '',
      turns: [{ role: 'user', text: 'x', ts: '' }],
    });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.reason).toBe('model_unavailable');
  });
});

describe('session_import › materialize', () => {
  it('creates a continuable conversation seeded with the summary', async () => {
    const { materializeSession } = await import('../../../src/main/features/session_import/materialize');
    const chats = await import('../../../src/main/features/chats');

    const result = await materializeSession({
      userId: TEST_UID,
      source: 'claude',
      sourceId: 'sess-abc',
      extraction: {
        ok: true,
        sessionSummary: '上次进展：完成支付迁移，退款回调待测。',
        personal: [], rules: [], templates: [],
      },
    });

    expect(result.created).toBe(true);
    expect(result.seeded).toBe(true);

    // Conversation shows up in the sidebar list.
    const list = await chats.listConversations(TEST_UID);
    const found = list.find((c: any) => c.conversation_id === result.conversationId);
    expect(found).toBeTruthy();
    expect(found.title).toContain('⤴');

    // Seed message is in the jsonl with both human text and model_text.
    const msgs = await chats.getMessages(TEST_UID, result.conversationId);
    expect(msgs.length).toBe(1);
    expect(msgs[0].from).toBe('commander');
    expect(msgs[0].text).toContain('已提炼');
    expect(msgs[0].text).toContain('支付迁移');
    expect(msgs[0].model_text).toContain('继续协助');
  });

  it('is idempotent — re-importing the same session does not duplicate or re-seed', async () => {
    const { materializeSession } = await import('../../../src/main/features/session_import/materialize');
    const chats = await import('../../../src/main/features/chats');

    const first = await materializeSession({
      userId: TEST_UID, source: 'claude', sourceId: 'dup-1',
      extraction: { ok: true, sessionSummary: 'S1', personal: [], rules: [], templates: [] },
    });
    const second = await materializeSession({
      userId: TEST_UID, source: 'claude', sourceId: 'dup-1',
      extraction: { ok: true, sessionSummary: 'S2-different', personal: [], rules: [], templates: [] },
    });

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.created).toBe(false);
    expect(second.seeded).toBe(false);

    const msgs = await chats.getMessages(TEST_UID, first.conversationId);
    // Still exactly one seed — the second import did not append.
    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toContain('S1');
  });

  it('marks a degraded extraction with the honest banner', async () => {
    const { materializeSession } = await import('../../../src/main/features/session_import/materialize');
    const chats = await import('../../../src/main/features/chats');

    const res = await materializeSession({
      userId: TEST_UID, source: 'claude', sourceId: 'deg-1',
      extraction: {
        ok: false, degraded: true, reason: 'unparseable_json',
        sessionSummary: '原始开头文本', personal: [], rules: [], templates: [],
      },
    });
    const msgs = await chats.getMessages(TEST_UID, res.conversationId);
    expect(msgs[0].text).toContain('未能自动提炼');
  });
});
