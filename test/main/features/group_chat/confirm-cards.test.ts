import { describe, it, expect, vi, beforeEach } from 'vitest';

// 评审补强单测：确认卡片主进程通道（幂等 / ALREADY_* / 不存在 / 并发互斥 / 取消对称）
const mocks = vi.hoisted(() => {
  const send = vi.fn();
  return { send, log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

vi.mock('../../../../src/main/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('../../../../src/main/features/group_chat/index.js', () => ({
  send: mocks.send,
  mainJsonlFile: (_uid: string, cid: string) => `/tmp/test-${cid}.jsonl`,
}));
vi.mock('../../../../src/main/storage', () => ({
  safeId: (v: unknown) => typeof v === 'string' && v.length > 0 && /^[A-Za-z0-9_-]+$/.test(v),
  nowIso: () => '2026-09-14T00:00:00.000Z',
  readJsonl: vi.fn(async () => rowsFixture),
  rewriteJsonlLine: vi.fn(async (_file: string, idx: number, cb: (rec: unknown) => unknown) => {
    const rec = cb(rowsFixture[idx]);
    if (rec !== null) rowsFixture[idx] = rec as never;
    return { ok: true };
  }),
}));

import { sendConfirmAndMark } from '../../../../src/main/features/group_chat/confirm-cards';
import { readJsonl, rewriteJsonlLine } from '../../../../src/main/storage';

const ART = 'art-e2e-confirm1';
const baseRow = {
  id: 'msg-1',
  from: 'commander',
  to: 'user',
  text: '请确认',
  artifacts: [{ id: ART, title: '待确认：提交项目', agent_id: 'commander' }],
};

let rowsFixture: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  rowsFixture = [JSON.parse(JSON.stringify(baseRow))];
});

describe('sendConfirmAndMark', () => {
  it('artifact 不存在 → 报错且不发送', async () => {
    rowsFixture = [];
    const r = await sendConfirmAndMark({ userId: 'u1', cid: 'e2econfirm01', artifactId: 'art-nope', op: 'submit-project' });
    expect(r).toEqual({ ok: false, error: 'artifact not found' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('已确认 → ALREADY_CONFIRMED 且不发送', async () => {
    (rowsFixture[0].artifacts as Array<Record<string, unknown>>)[0].confirm_state = 'confirmed';
    const r = await sendConfirmAndMark({ userId: 'u1', cid: 'e2econfirm01', artifactId: ART, op: 'submit-project' });
    expect(r).toMatchObject({ ok: false, code: 'ALREADY_CONFIRMED' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('已取消 → ALREADY_CANCELLED 且不发送', async () => {
    (rowsFixture[0].artifacts as Array<Record<string, unknown>>)[0].confirm_state = 'cancelled';
    const r = await sendConfirmAndMark({ userId: 'u1', cid: 'e2econfirm01', artifactId: ART, op: 'submit-project' });
    expect(r).toMatchObject({ ok: false, code: 'ALREADY_CANCELLED' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('确认成功 → 发送 plugin-confirm 并落 confirmed', async () => {
    mocks.send.mockResolvedValueOnce({ ok: true });
    const r = await sendConfirmAndMark({ userId: 'u1', cid: 'e2econfirm01', artifactId: ART, op: 'submit-project', payload: { 提交身份: '2023108600001' } });
    expect(r.ok).toBe(true);
    expect(r.confirm_state).toBe('confirmed');
    const sentText = mocks.send.mock.calls[0][0].text as string;
    expect(sentText).toContain('plugin-confirm');
    expect(sentText).toContain('artifact-result artifact_id="art-e2e-confirm1"');
    expect(rewriteJsonlLine).toHaveBeenCalled();
    const art = (rowsFixture[0].artifacts as Array<Record<string, unknown>>)[0];
    expect(art.confirm_state).toBe('confirmed');
  });

  it('取消成功 → 发送 plugin-cancel 并落 cancelled（评审补强：取消对称通道）', async () => {
    mocks.send.mockResolvedValueOnce({ ok: true });
    const r = await sendConfirmAndMark({ userId: 'u1', cid: 'e2econfirm01', artifactId: ART, op: 'submit-project', action: 'cancel' });
    expect(r.ok).toBe(true);
    expect(r.confirm_state).toBe('cancelled');
    const sentText = mocks.send.mock.calls[0][0].text as string;
    expect(sentText).toContain('plugin-cancel');
    const art = (rowsFixture[0].artifacts as Array<Record<string, unknown>>)[0];
    expect(art.confirm_state).toBe('cancelled');
  });

  it('发送失败 → 报错且不落标记（可重试）', async () => {
    mocks.send.mockResolvedValueOnce({ ok: false, error: 'send failed' });
    const r = await sendConfirmAndMark({ userId: 'u1', cid: 'e2econfirm01', artifactId: ART, op: 'submit-project' });
    expect(r.ok).toBe(false);
    expect(rewriteJsonlLine).not.toHaveBeenCalled();
    const art = (rowsFixture[0].artifacts as Array<Record<string, unknown>>)[0];
    expect(art.confirm_state).toBeUndefined();
  });

  it('并发双发互斥：同一卡片只发送一次（评审补强 #3）', async () => {
    let resolveSend!: (v: unknown) => void;
    mocks.send.mockImplementationOnce(() => new Promise((res) => { resolveSend = res; }));
    const p1 = sendConfirmAndMark({ userId: 'u1', cid: 'e2econfirm01', artifactId: ART, op: 'submit-project' });
    const p2 = sendConfirmAndMark({ userId: 'u1', cid: 'e2econfirm01', artifactId: ART, op: 'submit-project' });
    // send 在 readJsonl（异步 mock）之后的微任务里才被调用——先等它发生再放行
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    resolveSend({ ok: true });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(r1.ok).toBe(true);
    expect(r2).toEqual(r1); // 复用同一 Promise 结果
  });

  it('非法 cid/artifactId → 拒绝且不发送', async () => {
    const r = await sendConfirmAndMark({ userId: 'u1', cid: '../bad', artifactId: ART, op: 'submit-project' });
    expect(r).toEqual({ ok: false, error: 'invalid cid/artifactId' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('readJsonl/rewrite 调用路径符合预期（行索引定位）', async () => {
    mocks.send.mockResolvedValueOnce({ ok: true });
    await sendConfirmAndMark({ userId: 'u1', cid: 'e2econfirm01', artifactId: ART, op: 'submit-project' });
    expect(readJsonl).toHaveBeenCalledWith('/tmp/test-e2econfirm01.jsonl', 100_000);
    expect(rewriteJsonlLine).toHaveBeenCalledWith('/tmp/test-e2econfirm01.jsonl', 0, expect.any(Function));
  });
});
