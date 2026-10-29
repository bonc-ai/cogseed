import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ request: vi.fn(), open: vi.fn(), notice: vi.fn(), delay: vi.fn() }));
vi.mock('electron', () => ({ shell: { openExternal: m.open } }));
vi.mock('node:timers/promises', () => ({ setTimeout: m.delay }));
vi.mock('../../../../src/main/util/abort', () => ({ fetchAndReadWithTimeout: m.request }));
vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({ broadcastAuthorizationUrl: m.notice }));
import { authorizeTencentSurvey, cancelTencentSurveyAuth, cancelAllTencentSurveyAuth } from '../../../../src/main/features/connectors/tencent-survey-auth';
const TOKEN = 'wjpt_' + 'a'.repeat(65);
const ok = (data: any) => ({ response: { ok: true }, body: { code: 'OK', data } });
const init = () => ok({ code: 'a'.repeat(32), nonce: '123456' });
beforeEach(() => { vi.clearAllMocks(); m.open.mockResolvedValue(undefined); m.delay.mockResolvedValue(undefined); });
afterEach(() => { cancelAllTencentSurveyAuth(); vi.useRealTimers(); });
describe('Tencent Survey official device authorization', () => {
  it('waits for completed, passes only the grant to installation, and opens only the official URL', async () => {
    m.request.mockResolvedValueOnce(init()).mockResolvedValueOnce(ok({ status: 'pending' }))
      .mockResolvedValueOnce(ok({ status: 'completed', token: TOKEN }));
    const install = vi.fn().mockResolvedValue('installed');
    await expect(authorizeTencentSurvey('alice', install)).resolves.toBe('installed');
    expect(m.open.mock.calls[0][0]).toBe('https://wj.qq.com/oauth/authorize?code=' + 'a'.repeat(32) + '&nonce=123456');
    expect(install.mock.calls[0][0]).toEqual({ access_token: TOKEN, refresh_token: null, expires_at: null, scopes: [], token_type: 'Bearer' });
    expect(m.request).toHaveBeenCalledTimes(3);
    expect(cancelTencentSurveyAuth('alice')).toBe(false);
  });
  it.each([{ code: 'https://evil.test', nonce: '1' }, { code: 'b'.repeat(32) }, { code: 'b'.repeat(32), nonce: '' }])('rejects invalid init %j before opening a browser', async data => {
    m.request.mockResolvedValueOnce(ok(data));
    await expect(authorizeTencentSurvey('alice', vi.fn())).rejects.toThrow('survey_protocol_error');
    expect(m.open).not.toHaveBeenCalled();
  });
  it.each(['', 'not-a-token', 'wjpt_', 'wjpt_a\r\nX-Header: bad', 'wjpt_' + 'a'.repeat(8192)])('rejects completed without a valid token', async token => {
    m.request.mockResolvedValueOnce(init()).mockResolvedValueOnce(ok({ status: 'completed', token }));
    const install = vi.fn();
    await expect(authorizeTencentSurvey('alice', install)).rejects.toThrow('survey_protocol_error');
    expect(install).not.toHaveBeenCalled();
  });
  it.each([32, 64, 65, 128])('accepts provider tokens without inventing a fixed length (%i)', async size => {
    const token = 'wjpt_' + 'b'.repeat(size);
    m.request.mockResolvedValueOnce(init()).mockResolvedValueOnce(ok({ status: 'completed', token }));
    const install = vi.fn().mockResolvedValue('verified');
    await expect(authorizeTencentSurvey('alice', install)).resolves.toBe('verified');
    expect(install.mock.calls[0][0].access_token).toBe(token);
  });
  it('honors cancellation even when a completed response arrives in flight', async () => {
    m.request.mockResolvedValueOnce(init()).mockImplementationOnce(async () => {
      expect(cancelTencentSurveyAuth('bob')).toBe(false);
      expect(cancelTencentSurveyAuth('alice')).toBe(true);
      return ok({ status: 'completed', token: TOKEN });
    });
    const install = vi.fn();
    await expect(authorizeTencentSurvey('alice', install)).rejects.toMatchObject({ code: 'user_cancelled' });
    expect(install).not.toHaveBeenCalled();
  });
  it('times out and leaves no late authorization installation', async () => {
    vi.useFakeTimers();
    m.request.mockResolvedValueOnce(init());
    m.delay.mockImplementationOnce((_ms, _value, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    const run = authorizeTencentSurvey('alice', vi.fn());
    const assertion = expect(run).rejects.toMatchObject({ code: 'flow_timeout' });
    await vi.advanceTimersByTimeAsync(300_000); await assertion;
    expect(cancelTencentSurveyAuth('alice')).toBe(false);
  });
  it('sanitizes upstream errors that echo credentials', async () => {
    m.request.mockRejectedValueOnce(new Error('https://wj.qq.com?token=secret'));
    await expect(authorizeTencentSurvey('alice', vi.fn())).rejects.toThrow(/^survey_network_error$/);
  });
  it('keeps a copyable URL when opening the browser fails', async () => {
    m.open.mockRejectedValue(new Error('no browser'));
    m.request.mockResolvedValueOnce(init()).mockResolvedValueOnce(ok({ status: 'completed', token: TOKEN }));
    await authorizeTencentSurvey('alice', async () => 'done');
    expect(m.notice).toHaveBeenCalledWith(expect.objectContaining({ catalog_id: 'tencent-survey' }));
  });
});
