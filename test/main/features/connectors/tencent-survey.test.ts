import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ rows: new Map<string, any>(), connect: vi.fn(), list: vi.fn(), call: vi.fn(), close: vi.fn(), enabled: vi.fn(), abort: new AbortController(), transports: [] as any[] }));
vi.mock('../../../../src/main/features/connectors/registry', () => ({
 load: (uid: string) => ({ connections: m.rows.has(uid) ? { 'tencent-survey': m.rows.get(uid) } : {} }),
 upsert: async (uid: string, inst: any) => { m.rows.set(uid, inst); },
 update: async (uid: string, _id: string, fn: any) => { if (!m.rows.has(uid)) return null; const next = fn(m.rows.get(uid)); m.rows.set(uid, next); return next; },
 remove: async (uid: string) => m.rows.delete(uid),
}));
vi.mock('../../../../src/main/features/component_enabled', () => ({ isConnectorEnabled: m.enabled }));
vi.mock('../../../../src/main/features/connectors/tencent-survey-auth', async importOriginal => ({
 ...(await importOriginal<typeof import('../../../../src/main/features/connectors/tencent-survey-auth')>()),
 authorizeTencentSurvey: async (_uid: string, install: any) => install({ access_token: 'wjpt_' + 'a'.repeat(65), refresh_token: null, expires_at: null, scopes: [], token_type: 'Bearer' }, m.abort.signal),
 cancelTencentSurveyAuth: vi.fn(), cancelAllTencentSurveyAuth: vi.fn(),
 surveyError: (code: string) => Object.assign(new Error(code), { code }),
}));
vi.mock('../../../../src/main/features/connectors/mcp-client', () => ({ McpConnection: class {
 isConnected = true;
 constructor(_id: string, transport: unknown) { m.transports.push(transport); }
 connect = m.connect; listTools = m.list; callTool = m.call; close = m.close;
} }));
import { connectTencentSurvey, refreshTencentSurvey, callTencentSurvey, removeTencentSurvey, shutdownTencentSurvey } from '../../../../src/main/features/connectors/tencent-survey';
const business = { name: 'get_survey', description: 'live schema', input_schema: { type: 'object', required: ['survey_id'] } };
beforeEach(() => { vi.clearAllMocks(); m.rows.clear(); m.transports.length = 0; m.abort = new AbortController(); m.connect.mockResolvedValue(undefined); m.close.mockResolvedValue(undefined); m.enabled.mockReturnValue(true); m.list.mockResolvedValue([business, { name: 'start_login' }, { name: 'check_skill_update' }, { name: 'unknown_new_action' }]); m.call.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }); });
afterEach(async () => { await shutdownTencentSurvey(); });
describe('Tencent Survey lifecycle', () => {
 it('publishes only discovered business schemas after a real connection, without guessing team metadata', async () => {
  const inst = await connectTencentSurvey('alice'); expect(inst.tools_cache).toEqual([business]);
  expect(inst.status.kind).toBe('connected'); expect(inst.oauth_grant?.account_label).toBeUndefined();
  expect(m.transports[0].url).toBe('https://wj.qq.com/api/v2/mcp');
  await expect(callTencentSurvey('alice', 'start_login', {})).rejects.toThrow('survey_tool_disabled');
  await expect(callTencentSurvey('alice', 'create_survey', {})).rejects.toThrow('survey_tool_disabled');
  expect(m.call).not.toHaveBeenCalled();
 });
 it('does not install after list failure or cancellation during verification', async () => {
  m.list.mockRejectedValueOnce(new Error('401 token=secret'));
  await expect(connectTencentSurvey('alice')).rejects.toThrow('survey_reauthorize'); expect(m.rows.has('alice')).toBe(false);
  m.list.mockImplementationOnce(async () => { m.abort.abort(); return [business]; });
  await expect(connectTencentSurvey('alice')).rejects.toThrow(); expect(m.rows.has('alice')).toBe(false);
 });
 it('isolates users, checks enabled state and subtool restrictions at call time', async () => {
  await connectTencentSurvey('alice'); await expect(callTencentSurvey('bob', 'get_survey', {})).rejects.toThrow('survey_not_connected');
  m.enabled.mockReturnValue(false); await expect(callTencentSurvey('alice', 'get_survey', {})).rejects.toThrow('survey_not_connected');
  m.enabled.mockReturnValue(true); m.rows.get('alice').enabled_subtools = [];
  await expect(callTencentSurvey('alice', 'get_survey', {})).rejects.toThrow('survey_tool_disabled'); expect(m.call).not.toHaveBeenCalled();
 });
 it('turns a provider auth error envelope into a disconnected model surface, without exposing token errors', async () => {
  await connectTencentSurvey('alice'); m.call.mockResolvedValueOnce({ isError: true, content: [{ text: 'invalid_token secret' }] });
  await expect(callTencentSurvey('alice', 'get_survey', {})).rejects.toThrow(/^survey_reauthorize$/);
  expect(m.rows.get('alice').tools_cache).toEqual([]); expect(m.rows.get('alice').status.kind).toBe('error');
 });
 it('returns business errors without replaying writes and removes access on disconnect', async () => {
  m.list.mockResolvedValue([{ ...business, name: 'create_survey' }]); await connectTencentSurvey('alice');
  const failure = { isError: true, content: [{ text: 'invalid_text_format' }] }; m.call.mockResolvedValue(failure);
  expect(await callTencentSurvey('alice', 'create_survey', { text: 'draft' })).toBe(failure); expect(m.call).toHaveBeenCalledTimes(1);
  await removeTencentSurvey('alice'); await expect(callTencentSurvey('alice', 'create_survey', {})).rejects.toThrow('survey_not_connected');
 });
 it('refresh failure cannot leave a green card or cached business tools', async () => {
  await connectTencentSurvey('alice'); m.connect.mockRejectedValueOnce(new Error('network gone'));
  const inst = await refreshTencentSurvey('alice'); expect(inst.status.kind).toBe('error'); expect(inst.tools_cache).toEqual([]);
 });
});
