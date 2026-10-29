import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCogSeedHostToolRouter } from '../../../../src/main/features/cogseed_backend/host-tool-router';
import { createRuntimeToolRunner } from '../../../../src/main/features/cogseed_runtime/kernel/tools/runner';
import { createRuntimeSessionRunner } from '../../../../src/main/features/cogseed_runtime/kernel/session-runner';
import { COGSEED_RUNTIME_TOOL_POLICY } from '../../../../src/main/features/cogseed_runtime/kernel/config';
import { TRANSCRIPT_TOOL_DEFINITIONS } from '../../../../src/main/features/transcript-tool-contract';
import { upsertEntry } from '../../../../src/main/features/transcript_glossary';
import { resolveGlossaryConfirmation, markGlossaryConfirmationVisible } from '../../../../src/main/model/core-agent/glossary-confirm';
import { resolveGlossaryTextReply } from '../../../../src/main/features/transcript-confirmation';
import type { RuntimeKernelRequest } from '../../../../src/main/features/cogseed_runtime/kernel/types';

const { loadTask, broadcast, review } = vi.hoisted(() => ({ loadTask: vi.fn(), broadcast: vi.fn(), review: vi.fn() }));
vi.mock('../../../../src/main/features/transcript_llm_candidates', async (original) => ({ ...await original<any>(), generateReviewCandidates: review }));
vi.mock('../../../../src/main/features/cogseed_backend/task-store', async (original) => ({ ...await original<any>(), readCogSeedTaskByRequestId: loadTask }));
vi.mock('../../../../src/main/ipc', () => ({ broadcastToRenderer: broadcast }));
let uid: string;
const runtimeSessionId = 'mruntime-transcript-test';
const requestId = 'req-transcript-test';
const cid = 'transcript-test';
const text = '今天讨论扣格种子的使用方式。';
const input = { docId: 'meeting-test', text, includeReview: false };

function request(): RuntimeKernelRequest {
  return { userId: uid, requestId, runtimeSessionId, task: 'Summarize this meeting',
    context: [{ type: 'text', label: 'Formal Agent execution context', content: 'Workflow: transcript_glossary_scan then transcript_glossary_apply before minutes.' }],
    attachments: [], readOnlyRoots: [], writableRoots: [], toolPolicy: COGSEED_RUNTIME_TOOL_POLICY,
    capabilities: [], executionKind: 'cogseed-native', allowedSkillIds: [], skillVersionPins: [] };
}
function setup(workspace?: string) {
  const router = createCogSeedHostToolRouter();
  const runRequest = { protocol_version: 2, type: 'run' as const, request_id: requestId, runtime_session_id: runtimeSessionId, user_id: uid, task: 'test', context: [], attachments: [],
    ...(workspace ? { read_only_roots: [workspace], writable_roots: [workspace], working_dir: workspace } : {}) };
  const runner = createRuntimeToolRunner({ userId: uid, requestId, runtimeSessionId, allowedRoots: [], toolPolicy: COGSEED_RUNTIME_TOOL_POLICY,
    hostToolClient: {
      call: (call) => router.handle({ type: 'host_tool_call', request_id: call.requestId, runtime_session_id: call.runtimeSessionId, call_id: 'call-test', name: call.name, input: call.input }, { request: runRequest, signal: new AbortController().signal }),
      resolve: () => false, rejectAll() {},
    } });
  return runner;
}
beforeEach(() => {
  uid = `transcript-runtime-${crypto.randomUUID()}`;
  loadTask.mockResolvedValue({ runtimeSessionId, conversationId: cid, executionId: 'cogseed-exec-test', agentId: 'meeting-agent', taskId: 'meeting-task' });
  broadcast.mockClear();
  review.mockReset();
  broadcast.mockImplementation((channel, data) => {
    if (channel === 'transcript_glossary.confirmation_required') queueMicrotask(() => markGlossaryConfirmationVisible(data.confirm_id));
  });
});
async function seed(wrong = '扣格种子', correct = 'CogSeed') {
  await upsertEntry(uid, { wrong, correct, kind: 'product' });
}

describe('Runtime transcript host bridge and completion gate', () => {
  it('resumes the exact confirmed source without another scan, then reuses the delivered minutes on acknowledgement', async () => {
    await seed('健全', '鉴权');
    const source = { ...input, text: '生态健全度不足' };
    const runner = setup();
    const calls: string[] = [];
    let turn = 0;
    let round = 0;
    const session = createRuntimeSessionRunner({ maxToolRounds: 4, memoryProvider: () => undefined,
      toolRunner: { catalog: runner.catalog, async run(name, args) {
        calls.push(name);
        return name === 'write_file' ? { content: 'File written: minutes.md' } : runner.run(name, args);
      } },
      modelAdapter: { async *stream(modelInput) {
        if (turn === 0) {
          yield { type: 'tool_call' as const, call: { id: 'scan', name: 'transcript_glossary_scan', arguments: source } };
          yield { type: 'tool_call' as const, call: { id: 'apply', name: 'transcript_glossary_apply', arguments: source } };
        } else if (turn === 1 && round++ === 0) {
          expect(modelInput.message).toContain('status: applied');
          expect(modelInput.message).toContain(source.text);
          expect(modelInput.message.match(/Exact correction input:/g)).toHaveLength(1);
          yield { type: 'tool_call' as const, call: { id: 'write', name: 'write_file', arguments: { path: 'minutes.md' } } };
        } else {
          if (turn === 2) expect(modelInput.message).toContain('File written: minutes.md');
          yield { type: 'delta' as const, text: turn === 2 ? 'Confirmed existing minutes.' : 'Please confirm minutes.' };
        }
      } },
    });
    const collect = async (id: string) => { const out = []; for await (const event of session.run({ ...request(), requestId: id })) out.push(event); return out; };
    expect((await collect('req-source')) .at(-1)?.type).toBe('error');
    expect((await collect('req-pending-retry')).at(-1)?.type).toBe('error');
    const card = broadcast.mock.calls.find(([name]) => name === 'transcript_glossary.confirmation_required')![1];
    expect(resolveGlossaryTextReply(uid, { cid, agentId: 'meeting-agent', taskId: 'meeting-task', text: '都不用改' })).toBe(true);
    turn = 1;
    expect((await collect('req-confirmed')).at(-1)?.type).toBe('result');
    turn = 2;
    expect((await collect('req-acknowledge')).at(-1)?.text).toBe('Confirmed existing minutes.');
    expect(calls.filter(name => name === 'transcript_glossary_scan')).toHaveLength(1);
    expect(calls.filter(name => name === 'write_file')).toHaveLength(1);
  });

  it('reads the transcript by path and writes the raw and corrected files on the host, never returning the text', async () => {
    await seed('健全', '鉴权');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-path-'));
    const sourceFile = path.join(workspace, 'transcript_meeting.txt');
    fs.writeFileSync(sourceFile, '生态健全度不足');
    const call = { path: sourceFile, outputPath: path.join(workspace, 'm_转写-纠错.md'), rawOutputPath: path.join(workspace, 'm_转写.md') };
    const runner = setup(workspace);
    const results: string[] = [];
    let turn = 0;
    const session = createRuntimeSessionRunner({ maxToolRounds: 4, memoryProvider: () => undefined,
      toolRunner: { catalog: runner.catalog, async run(name, args) {
        const result = name === 'write_file' ? { content: 'File written: minutes.md' } : await runner.run(name, args);
        results.push(`${name}: ${result.content}`);
        return result;
      } },
      modelAdapter: { async *stream(modelInput) {
        if (turn === 0) {
          yield { type: 'tool_call' as const, call: { id: 'scan', name: 'transcript_glossary_scan', arguments: { path: sourceFile, includeReview: false } } };
          yield { type: 'tool_call' as const, call: { id: 'apply', name: 'transcript_glossary_apply', arguments: call } };
        } else if (!modelInput.message.includes('File written')) {
          yield { type: 'tool_call' as const, call: { id: 'write', name: 'write_file', arguments: { path: 'minutes.md' } } };
        } else yield { type: 'delta' as const, text: 'Minutes ready.' };
      } },
    });
    const collect = async (id: string) => { const out = []; for await (const event of session.run({ ...request(), requestId: id })) out.push(event); return out; };
    try {
      expect((await collect('req-source')).at(-1)).toMatchObject({ type: 'error', metadata: { code: 'transcript_confirmation_required' } });
      expect(fs.readFileSync(call.rawOutputPath, 'utf8')).toBe('生态健全度不足');
      expect(fs.existsSync(call.outputPath)).toBe(false);
      expect(resolveGlossaryTextReply(uid, { cid, agentId: 'meeting-agent', taskId: 'meeting-task', text: '确认' })).toBe(true);
      turn = 1;
      expect((await collect('req-confirmed')).at(-1)).toMatchObject({ type: 'result', text: 'Minutes ready.' });
      expect(fs.readFileSync(call.outputPath, 'utf8')).toBe('生态鉴权度不足');
      const applied = results.filter(row => row.startsWith('transcript_glossary_apply: status: applied'));
      expect(applied).toHaveLength(1);
      expect(applied[0]).toContain(`corrected_path: ${call.outputPath}`);
      expect(applied[0]).not.toContain('--- corrected transcript ---');
      expect(fs.readFileSync(sourceFile, 'utf8')).toBe('生态健全度不足');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('saves the raw transcript at scan and lets the confirmed replay write the corrected file named at scan', async () => {
    await seed('健全', '鉴权');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-scan-out-'));
    const outputs = { outputPath: path.join(workspace, 'm_转写-纠错.md'), rawOutputPath: path.join(workspace, 'm_转写.md') };
    // Connector transcript: not a file yet, so it travels as text exactly once.
    const source = { docId: 'record-1', text: '生态健全度不足', includeReview: false };
    const runner = setup(workspace);
    const results: string[] = [];
    let turn = 0;
    const session = createRuntimeSessionRunner({ maxToolRounds: 4, memoryProvider: () => undefined,
      toolRunner: { catalog: runner.catalog, async run(name, args) {
        const result = name === 'write_file' ? { content: 'File written: minutes.md' } : await runner.run(name, args);
        results.push(`${name}: ${result.content}`);
        return result;
      } },
      modelAdapter: { async *stream(modelInput) {
        if (turn === 0) {
          yield { type: 'tool_call' as const, call: { id: 'scan', name: 'transcript_glossary_scan', arguments: { ...source, ...outputs } } };
          // A model-issued apply without paths still uses the ones named at scan.
          yield { type: 'tool_call' as const, call: { id: 'apply', name: 'transcript_glossary_apply', arguments: source } };
        } else if (!modelInput.message.includes('File written')) {
          yield { type: 'tool_call' as const, call: { id: 'write', name: 'write_file', arguments: { path: 'minutes.md' } } };
        } else yield { type: 'delta' as const, text: 'Minutes ready.' };
      } },
    });
    const collect = async (id: string) => { const out = []; for await (const event of session.run({ ...request(), requestId: id })) out.push(event); return out; };
    try {
      expect((await collect('req-source')).at(-1)).toMatchObject({ type: 'error', metadata: { code: 'transcript_confirmation_required' } });
      expect(fs.readFileSync(outputs.rawOutputPath, 'utf8')).toBe('生态健全度不足');
      expect(results.find(row => row.startsWith('transcript_glossary_scan'))).toContain(`raw_path: ${outputs.rawOutputPath}`);
      expect(fs.existsSync(outputs.outputPath)).toBe(false);
      expect(resolveGlossaryTextReply(uid, { cid, agentId: 'meeting-agent', taskId: 'meeting-task', text: '确认' })).toBe(true);
      turn = 1;
      expect((await collect('req-confirmed')).at(-1)).toMatchObject({ type: 'result', text: 'Minutes ready.' });
      expect(fs.readFileSync(outputs.outputPath, 'utf8')).toBe('生态鉴权度不足');
      const applied = results.filter(row => row.startsWith('transcript_glossary_apply: status: applied'));
      expect(applied).toHaveLength(1);
      expect(applied[0]).toContain(`corrected_path: ${outputs.outputPath}`);
      expect(applied[0]).not.toContain('--- corrected transcript ---');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('refuses transcript paths outside the task workspace, including when it has no roots', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), '生态健全度不足');
    try {
      await seed('健全', '鉴权');
      const scoped = await setup(workspace).run('transcript_glossary_scan', { path: path.join(outside, 'secret.txt'), includeReview: false });
      expect(scoped).toMatchObject({ isError: true });
      expect(scoped.content).toContain('outside the task workspace');
      const unscoped = await setup().run('transcript_glossary_scan', { path: path.join(outside, 'secret.txt'), includeReview: false });
      expect(unscoped).toMatchObject({ isError: true });
      expect(unscoped.content).toContain('outside the task workspace');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('lets a later scan supersede an abandoned unapplied scan, so writes open after the confirmed apply', async () => {
    await seed('健全', '鉴权');
    const abandoned = { ...input, docId: 'meeting-draft', text: '生态健全度不足 ' + '。' };
    const source = { ...input, docId: 'meeting-final', text: '生态健全度不足' };
    const runner = setup();
    const results: Array<{ name: string; isError?: boolean }> = [];
    let turn = 0;
    const session = createRuntimeSessionRunner({ maxToolRounds: 4, memoryProvider: () => undefined,
      toolRunner: { catalog: runner.catalog, async run(name, args) {
        return name === 'write_file' ? { content: 'File written: minutes.md' } : runner.run(name, args);
      } },
      modelAdapter: { async *stream(modelInput) {
        if (turn === 0) {
          yield { type: 'tool_call' as const, call: { id: 'scan-a', name: 'transcript_glossary_scan', arguments: abandoned } };
          yield { type: 'tool_call' as const, call: { id: 'scan-b', name: 'transcript_glossary_scan', arguments: source } };
          yield { type: 'tool_call' as const, call: { id: 'apply-b', name: 'transcript_glossary_apply', arguments: source } };
        } else if (!modelInput.message.includes('File written')) {
          yield { type: 'tool_call' as const, call: { id: 'write', name: 'write_file', arguments: { path: 'minutes.md' } } };
        } else yield { type: 'delta' as const, text: 'Minutes ready.' };
      } },
    });
    const collect = async (id: string) => {
      const out = [];
      for await (const event of session.run({ ...request(), requestId: id })) {
        if (event.type === 'tool_result') results.push({ name: String(event.metadata?.name), isError: event.metadata?.isError === true });
        out.push(event);
      }
      return out;
    };
    expect((await collect('req-source')).at(-1)).toMatchObject({ type: 'error', metadata: { code: 'transcript_confirmation_required' } });
    expect(resolveGlossaryTextReply(uid, { cid, agentId: 'meeting-agent', taskId: 'meeting-task', text: '确认' })).toBe(true);
    turn = 1;
    expect((await collect('req-confirmed')).at(-1)).toMatchObject({ type: 'result', text: 'Minutes ready.' });
    expect(results.filter(row => row.name === 'write_file')).toEqual([{ name: 'write_file', isError: false }]);
  });

  it('applies a partial text reply with the user rewrite, lets the Agent ask about the rest, then finishes', async () => {
    await seed('健全', '鉴权');
    await seed('机制', '机智');
    const source = { ...input, text: '生态健全度不足，机制待定' };
    const runner = setup();
    const calls: string[] = [];
    const messages: string[] = [];
    let turn = 0;
    const session = createRuntimeSessionRunner({ maxToolRounds: 4, memoryProvider: () => undefined,
      toolRunner: { catalog: runner.catalog, async run(name, args) {
        calls.push(name);
        return name === 'write_file' ? { content: 'File written: minutes.md' } : runner.run(name, args);
      } },
      modelAdapter: { async *stream(modelInput) {
        messages.push(modelInput.message);
        if (turn === 0) {
          yield { type: 'tool_call' as const, call: { id: 'scan', name: 'transcript_glossary_scan', arguments: source } };
          yield { type: 'tool_call' as const, call: { id: 'apply', name: 'transcript_glossary_apply', arguments: source } };
        } else if (turn === 1) {
          // A rescan while the card is open is refused before reaching the host.
          if (!modelInput.message.includes('E_TRANSCRIPT_CONFIRMATION_PENDING')) {
            yield { type: 'tool_call' as const, call: { id: 'rescan', name: 'transcript_glossary_scan', arguments: source } };
          } else yield { type: 'delta' as const, text: '收到，健全按鉴全改。机制要改成机智吗？' };
        } else if (!modelInput.message.includes('File written')) {
          yield { type: 'tool_call' as const, call: { id: 'write', name: 'write_file', arguments: { path: 'minutes.md' } } };
        } else yield { type: 'delta' as const, text: 'Minutes ready.' };
      } },
    });
    const collect = async (id: string) => { const out = []; for await (const event of session.run({ ...request(), requestId: id })) out.push(event); return out; };
    expect((await collect('req-source')).at(-1)).toMatchObject({ type: 'error', metadata: { code: 'transcript_confirmation_required' } });
    expect(resolveGlossaryTextReply(uid, { cid, agentId: 'meeting-agent', taskId: 'meeting-task', text: '健全 是鉴全' })).toBe(true);
    turn = 1;
    const asked = (await collect('req-partial')).at(-1);
    expect(asked).toMatchObject({ type: 'error', metadata: { code: 'transcript_confirmation_required', reply: '收到，健全按鉴全改。机制要改成机智吗？' } });
    expect(asked?.error).toContain('「机制」');
    expect(asked?.error).not.toContain('「健全」');
    expect(messages.at(-1)).toContain('Some correction items are still undecided');
    expect(calls.filter(name => name === 'transcript_glossary_scan')).toHaveLength(1);
    expect(resolveGlossaryTextReply(uid, { cid, agentId: 'meeting-agent', taskId: 'meeting-task', text: '其他都改' })).toBe(true);
    turn = 2;
    expect((await collect('req-rest')).at(-1)).toMatchObject({ type: 'result', text: 'Minutes ready.' });
    expect(messages.find(message => message.includes('status: applied'))).toContain('生态鉴全度不足，机智待定');
  });

  it.each(['accept', 'reject', 'hidden'])('shows model suggestions before stopping and resumes the same candidates: %s', async (decision) => {
    await seed();
    const source = '汉不端，汉不端，bpm 端，自转 version。';
    const suggestions = [
      { wrong: '汉不端', correct: 'hub端', start: 0 },
      { wrong: '汉不端', correct: 'hub端', start: 4 },
      { wrong: 'bpm 端', correct: 'hub端', start: 8 },
      { wrong: '自转 version', correct: 'version', start: 14 },
    ];
    review.mockResolvedValue({ candidates: suggestions.map(c => ({ ...c, confidence: 0.95, reason: 'Review this suggestion', inAllowlist: false })),
      rejected: [], outsideAllowlist: 4, chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0 });
    if (decision === 'hidden') broadcast.mockImplementation(() => {});
    const args = { docId: 'review-meeting', text: source };
    const runner = setup();
    const calls: string[] = [];
    const run = async () => {
      let round = 0;
      const session = createRuntimeSessionRunner({ maxToolRounds: 3, memoryProvider: () => undefined,
        modelAdapter: { async *stream() {
          if (round++ === 0) for (const name of ['transcript_glossary_scan', 'transcript_glossary_apply', 'write_file']) yield { type: 'tool_call' as const, call: { id: name, name, arguments: args } };
          else yield { type: 'delta' as const, text: 'Done' };
        } }, toolRunner: { catalog: runner.catalog, async run(name, input) { calls.push(name); return name === 'write_file' ? { content: 'written' } : runner.run(name, input); } } });
      const events = []; for await (const event of session.run(request())) events.push(event);
      return events;
    };
    const stopped = await run();
    const card = broadcast.mock.calls.find(([channel]) => channel === 'transcript_glossary.confirmation_required')?.[1];
    expect(card?.items).toHaveLength(4);
    expect(card.cid).toBe(cid);
    expect(stopped.at(-1)).toMatchObject({ type: 'error', metadata: { code: 'transcript_confirmation_required' } });
    expect(stopped.at(-1)?.error).toContain('「自转 version」 → 「version」');
    expect(calls).not.toContain('write_file');
    if (decision === 'hidden') return;
    resolveGlossaryConfirmation(card.confirm_id, decision === 'accept' ? [card.items[0].entryRef] : []);
    calls.length = 0;
    const resumed = await run();
    expect(review).toHaveBeenCalledTimes(1);
    expect(resumed.at(-1)?.type).toBe('result');
    expect(calls).toContain('write_file');
    const applied = resumed.find(e => e.type === 'tool_result' && e.metadata?.name === 'transcript_glossary_apply')!;
    expect(applied.text).toContain(decision === 'accept' ? 'hub端，汉不端，bpm 端，自转 version。' : source);
  });
  it('exposes the shared schemas and routes scan/apply to the existing user-owned engine', async () => {
    await seed();
    const runner = setup();
    for (const definition of TRANSCRIPT_TOOL_DEFINITIONS) expect(runner.catalog.find(t => t.name === definition.name)?.parameters).toEqual(definition.inputSchema);
    const scan = await runner.run('transcript_glossary_scan', input);
    expect(scan.correction?.state).toBe('scanned');
    const applied = await runner.run('transcript_glossary_apply', input);
    expect(applied.content).toContain('今天讨论CogSeed的使用方式。');
    expect(applied.correction).toEqual({ state: 'applied', docId: input.docId, sourceHash: createHash('sha256').update(text).digest('hex') });
  });

  it('rejects a mismatched persisted task and cannot self-approve high-risk corrections', async () => {
    await seed();
    const runner = setup();
    expect((await runner.run('transcript_glossary_apply', { ...input, acceptRiskLevels: ['high'] })).isError).toBe(true);
    loadTask.mockResolvedValue({ runtimeSessionId: 'mruntime-other' });
    expect((await runner.run('transcript_glossary_list', {})).content).toContain('scope mismatch');
  });

  it('routes the confirmation card to the task and resumes a submitted rejection without replaying tool history', async () => {
    await seed('健全', '鉴权');
    const runner = setup();
    const args = { ...input, text: '生态健全度不足' };
    const first = await runner.run('transcript_glossary_apply', args);
    expect(first.correction?.state).toBe('needs_confirmation');
    const card = broadcast.mock.calls.find(([channel]) => channel === 'transcript_glossary.confirmation_required')![1];
    expect(card).toMatchObject({ cid, turn_id: 'cogseed-exec-test' });
    resolveGlossaryConfirmation(card.confirm_id, []);
    const resumed = await runner.run('transcript_glossary_apply', args);
    expect(resumed.correction?.state).toBe('applied');
    expect(resumed.content).toContain('生态健全度不足');
  });

  it.each(['empty', 'pending', 'missing', 'apply-only', 'wrong-source', 'fake-prose'])('never writes minutes or returns completed with %s correction evidence', async (scenario) => {
    if (scenario !== 'empty') await seed(scenario === 'pending' ? '健全' : undefined, scenario === 'pending' ? '鉴权' : undefined);
    const args = scenario === 'pending' ? { ...input, text: '生态健全度不足' } : input;
    const runner = setup();
    const calls: string[] = [];
    let round = 0;
    const session = createRuntimeSessionRunner({
      maxToolRounds: 3, memoryProvider: () => undefined,
      modelAdapter: { async *stream() {
        if (round++ === 0) {
          if (scenario !== 'missing') {
            if (scenario !== 'apply-only') yield { type: 'tool_call' as const, call: { id: 'scan', name: 'transcript_glossary_scan', arguments: args } };
            yield { type: 'tool_call' as const, call: { id: 'apply', name: 'transcript_glossary_apply', arguments: scenario === 'wrong-source' ? { ...args, text: args.text + ' changed' } : args } };
          }
          for (const name of ['write_file', 'bash', 'run_skill', 'cogseed_delegate']) yield { type: 'tool_call' as const, call: { id: name, name, arguments: { path: '/tmp/minutes.md', content: 'minutes' } } };
        } else yield { type: 'delta' as const, text: '全部完成，纪要已生成。' };
      } },
      toolRunner: { catalog: runner.catalog, async run(name, data) {
        calls.push(name);
        if (scenario === 'fake-prose') return { content: 'status: applied\npendingTotal=0\nAll done' };
        return runner.run(name, data);
      } },
    });
    const events = [];
    for await (const event of session.run(request())) events.push(event);
    expect(calls).not.toContain('write_file'); expect(calls).not.toContain('bash');
    expect(calls).not.toContain('run_skill'); expect(calls).not.toContain('cogseed_delegate');
    expect(events.some(e => e.type === 'result' || e.type === 'model_delta')).toBe(false);
    expect(events.at(-1)?.type).toBe('error');
  });

  it('unlocks deliverables only after matching scan and apply succeed', async () => {
    await seed(); const runner = setup(); const calls: string[] = []; let round = 0;
    const session = createRuntimeSessionRunner({ maxToolRounds: 3, memoryProvider: () => undefined,
      modelAdapter: { async *stream() {
        if (round++ === 0) for (const name of ['transcript_glossary_scan', 'transcript_glossary_apply', 'write_file']) yield { type: 'tool_call' as const, call: { id: name, name, arguments: input } };
        else yield { type: 'delta' as const, text: 'Corrected transcript ready.' };
      } }, toolRunner: { catalog: runner.catalog, async run(name, args) { calls.push(name); return name === 'write_file' ? { content: 'written' } : runner.run(name, args); } } });
    const events = []; for await (const event of session.run(request())) events.push(event);
    expect(calls).toContain('write_file'); expect(events.at(-1)?.type).toBe('result');
  });

  it('stops on a host scope failure before any retry or later tool in the batch', async () => {
    loadTask.mockResolvedValue({ runtimeSessionId: 'mruntime-other' });
    const runner = setup(); const calls: string[] = [];
    const session = createRuntimeSessionRunner({ maxToolRounds: 3, memoryProvider: () => undefined,
      modelAdapter: { async *stream() {
        for (const id of ['first', 'retry']) yield { type: 'tool_call' as const, call: { id, name: 'transcript_glossary_scan', arguments: input } };
      } }, toolRunner: { catalog: runner.catalog, async run(name, args) { calls.push(name); return runner.run(name, args); } } });
    const events = []; for await (const event of session.run(request())) events.push(event);
    expect(calls).toEqual(['transcript_glossary_scan']);
    expect(events.at(-1)).toMatchObject({ type: 'error', metadata: { code: 'transcript_scope_mismatch' } });
  });
});
