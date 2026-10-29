import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const calls = vi.hoisted(() => ({ enqueue: vi.fn(async (_input: unknown) => ({})), wait: vi.fn(async (_uid: string, _task: string) => {}), broadcasts: [] as any[] }));
vi.mock('../../../src/main/ipc', () => ({ broadcastToRenderer: (_channel: string, payload: unknown) => calls.broadcasts.push(payload) }));
vi.mock('../../../src/main/features/group_chat/bus', () => ({ enqueue: calls.enqueue }));
vi.mock('../../../src/main/features/cogseed_backend/runtime-controller', () => ({ cogseedRuntimeController: { waitForTaskTurn: calls.wait } }));
let api: typeof import('../../../src/main/features/transcript-confirmation');
let root: string; let previousRoot: string | undefined;
beforeEach(async () => { previousRoot = process.env.COGSEED_WORKSPACE_ROOT; root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-confirm-')); process.env.COGSEED_WORKSPACE_ROOT = root; vi.resetModules(); api = await import('../../../src/main/features/transcript-confirmation'); });
afterEach(() => { if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(root, { recursive: true, force: true }); });
async function card() {
  const pending = api.createGlossaryConfirmation({ userId: 'owner', cid: 'source-chat', agentId: 'source-agent', taskId: 'source-task', text: 'source', docId: 'doc', items: [{ entryRef: 'ref', wrong: 'a', correct: 'b', action: 'replace', count: 1, riskLevel: 'high', ignoredCount: 0, context: 'source' }] });
  const token = calls.broadcasts.at(-1).confirm_id;
  api.markGlossaryConfirmationVisible(token);
  await pending;
  return token;
}
beforeEach(() => { calls.enqueue.mockClear(); calls.wait.mockClear(); calls.broadcasts.length = 0; });
describe('confirmation continuation ownership', () => {
  it('restores the exact scan and explicit rejections after restart, and never restores expired decisions', async () => {
    const scans = await import('../../../src/main/features/transcript-scan-state');
    const key = scans.transcriptScanKey('owner', 'chat', 'doc', 'source', {});
    const state = scans.saveTranscriptScan(key, [], false);
    state.decisions.set('keep-original', false);
    state.confirmationToken = 'pending-token';
    scans.persistTranscriptScan(key, state);
    vi.resetModules();
    const restored = await import('../../../src/main/features/transcript-scan-state');
    expect(restored.readTranscriptScan(key)).toMatchObject({ confirmationToken: 'pending-token', decisions: new Map([['keep-original', false]]) });
    expect(restored.readTranscriptScan(restored.transcriptScanKey('other', 'chat', 'doc', 'source', {}))).toBeUndefined();
    restored.persistTranscriptScan(key, { ...state, expiresAt: 0 });
    vi.resetModules();
    expect((await import('../../../src/main/features/transcript-scan-state')).readTranscriptScan(key)).toBeUndefined();
  });

  it.each([
    ['ok 不改，其他都改', ['second']], ['「OK」不用改，其余都改', ['second']],
    ['全部修改', ['first', 'second']], ['确认', ['first', 'second']], ['都不用改', []],
    ['未知词不改，其他都改', null], ['暂不确认', null], ['这句话是引用：确认', null],
    ['ok 不改，其他都改？', null],
  ])('resolves only an unambiguous scoped human choice: %s', async (text, accepted) => {
    const userId = `user-${crypto.randomUUID()}`;
    const pending = api.createGlossaryConfirmation({ userId, cid: 'chat', agentId: 'agent', taskId: 'task', docId: 'doc', text: 'source', items:
      ['ok', 'term'].map((wrong, index) => ({ entryRef: index ? 'second' : 'first', wrong, correct: 'target', action: 'replace' as const,
        count: 1, riskLevel: 'high' as const, ignoredCount: 0, context: 'source' })) });
    const token = calls.broadcasts.at(-1).confirm_id; api.markGlossaryConfirmationVisible(token); await pending;
    expect(api.resolveGlossaryTextReply('another-user', { cid: 'chat', agentId: 'agent', taskId: 'task', text })).toBe(false);
    expect(api.resolveGlossaryTextReply(userId, { cid: 'other-chat', agentId: 'agent', taskId: 'task', text })).toBe(false);
    expect(api.resolveGlossaryTextReply(userId, { cid: 'chat', agentId: 'agent', taskId: 'task', text })).toBe(accepted !== null);
    // A later bare confirmation cannot turn a prior rejection into approval.
    if (accepted !== null) expect(api.resolveGlossaryTextReply(userId, { cid: 'chat', agentId: 'agent', taskId: 'task', text: '确认' })).toBe(false);
    vi.resetModules();
    const restored = await import('../../../src/main/features/transcript-confirmation');
    expect(restored.consumeGlossaryConfirmation(token, 'source', { userId, cid: 'chat', docId: 'doc' })).toMatchObject(
      accepted === null ? { outcome: 'pending' } : { outcome: 'accepted', acceptedIds: accepted });
    expect(calls.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    ['ok 不改，佳伟 是嘉宇', { accepted: ['r-name'], decided: ['r-ok', 'r-name'], rewrites: { 'r-name': '嘉宇' } }],
    ['ok 不改，佳伟改成嘉宇，其他都改', { accepted: ['r-name', 'r-hub1', 'r-hub2'], decided: ['r-ok', 'r-name', 'r-hub1', 'r-hub2'], rewrites: { 'r-name': '嘉宇' } }],
    ['汉不端改', { accepted: ['r-hub1', 'r-hub2'], decided: ['r-hub1', 'r-hub2'], rewrites: {} }],
    ['佳伟 是赵丽霞', { accepted: ['r-name'], decided: ['r-name'], rewrites: {} }],
    ['佳伟 是 佳伟', { accepted: [], decided: ['r-name'], rewrites: {} }],
    ['好的，确认', { accepted: ['r-ok', 'r-name', 'r-hub1', 'r-hub2'], decided: ['r-ok', 'r-name', 'r-hub1', 'r-hub2'], rewrites: {} }],
    ['ok 不改，其他都改了', { accepted: ['r-name', 'r-hub1', 'r-hub2'], decided: ['r-ok', 'r-name', 'r-hub1', 'r-hub2'], rewrites: {} }],
    ['ok 不改，ok 改', null], ['张三 是李四', null], ['ok', null], ['佳伟是谁', null], ['ok 不改，其他都改，其他都不改', null],
  ])('parses per-item text decisions: %s', (text, expected) => {
    const item = (entryRef: string, wrong: string, correct: string) => ({ entryRef, wrong, correct, action: 'replace' as const,
      count: 1, riskLevel: 'high' as const, ignoredCount: 0, context: '' });
    const items = [item('r-ok', 'ok', 'EduSeed'), item('r-name', '佳伟', '赵丽霞'), item('r-hub1', '汉不端', 'hub 端'), item('r-hub2', '汉不端', 'hub 端')];
    const parsed = api.parseGlossaryTextReply(text, items);
    if (expected === null) return expect(parsed).toBeNull();
    const { namedItems: _named, ...decisions } = parsed!;
    expect({ ...decisions, accepted: [...decisions.accepted].sort(), decided: [...decisions.decided].sort() })
      .toEqual({ ...expected, accepted: [...expected.accepted].sort(), decided: [...expected.decided].sort() });
  });
  it('a partial reply consumes only the named items and carries the user rewrite', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const pending = api.createGlossaryConfirmation({ userId, cid: 'chat', agentId: 'agent', taskId: 'task', docId: 'doc', text: 'source', items:
      [['first', 'ok'], ['second', '佳伟'], ['third', 'cos']].map(([entryRef, wrong]) => ({ entryRef, wrong, correct: 'target', action: 'replace' as const,
        count: 1, riskLevel: 'high' as const, ignoredCount: 0, context: 'source' })) });
    const token = calls.broadcasts.at(-1).confirm_id; api.markGlossaryConfirmationVisible(token); await pending;
    expect(api.resolveGlossaryTextReply(userId, { cid: 'chat', agentId: 'agent', taskId: 'task', text: 'ok 不改，佳伟 是嘉宇' })).toBe(true);
    vi.resetModules();
    const restored = await import('../../../src/main/features/transcript-confirmation');
    expect(restored.consumeGlossaryConfirmation(token, 'source', { userId, cid: 'chat', docId: 'doc' })).toEqual(
      { outcome: 'accepted', acceptedIds: ['second'], decidedIds: ['first', 'second'], rewrites: { second: '嘉宇' } });
  });
  it('after an unreadable reply, a bare 确认 approves nothing but a reply naming items still resolves', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const pending = api.createGlossaryConfirmation({ userId, cid: 'chat', agentId: 'agent', taskId: 'task', docId: 'doc', text: 'source', items:
      [['first', 'ok'], ['second', 'cos']].map(([entryRef, wrong]) => ({ entryRef, wrong, correct: 'target', action: 'replace' as const,
        count: 1, riskLevel: 'high' as const, ignoredCount: 0, context: 'source' })) });
    const token = calls.broadcasts.at(-1).confirm_id; api.markGlossaryConfirmationVisible(token); await pending;
    const reply = (text: string) => api.resolveGlossaryTextReply(userId, { cid: 'chat', agentId: 'agent', taskId: 'task', text });
    expect(reply('除了一个其他都改')).toBe(false);
    expect(reply('确认')).toBe(false);
    expect(api.consumeGlossaryConfirmation(token, 'source', { userId, cid: 'chat', docId: 'doc' })).toEqual({ outcome: 'pending' });
    expect(reply('ok 不改，其他都改')).toBe(true);
    expect(api.consumeGlossaryConfirmation(token, 'source', { userId, cid: 'chat', docId: 'doc' })).toMatchObject(
      { outcome: 'accepted', acceptedIds: ['second'] });
  });

  it('resumes the original actor once after its turn closes, regardless of duplicate submits', async () => {
    const token = await card();
    let release!: () => void;
    calls.wait.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = api.submitGlossaryConfirmation('owner', token, ['ref'], false);
    const second = api.submitGlossaryConfirmation('owner', token, [], false);
    await vi.waitFor(() => expect(calls.wait).toHaveBeenCalledOnce());
    expect(calls.enqueue).not.toHaveBeenCalled();
    release();
    expect(await Promise.all([first, second])).toEqual([{ ok: true, resumed: true }, { ok: true, resumed: true }]);
    expect(calls.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uid: 'owner', cid: 'source-chat', fromActorId: 'user', forceTo: ['source-agent'] }));
    expect(api.consumeGlossaryConfirmation(token, 'source', { userId: 'owner', cid: 'source-chat', docId: 'doc' })).toMatchObject({ outcome: 'accepted', acceptedIds: ['ref'] });
    expect(await api.submitGlossaryConfirmation('owner', token, ['ref'], false)).toEqual({ ok: false, resumed: false });
    expect(calls.enqueue).toHaveBeenCalledOnce();
  });
  it('rejects another user without resolving the owners choice', async () => {
    const token = await card();
    expect(await api.submitGlossaryConfirmation('other-user', token, ['ref'], true)).toEqual({ ok: false, resumed: false });
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(api.consumeGlossaryConfirmation(token, 'source', { userId: 'owner', cid: 'source-chat', docId: 'doc' })).toEqual({ outcome: 'pending' });
  });
});
