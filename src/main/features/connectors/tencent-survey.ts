/** Native hosted MCP lifecycle for Tencent Survey. Only business schemas confirmed by tools/list
 * are exposed. Auth/version-management tools never enter model-visible caches. A per-user mutex
 * serializes tools, refresh and removal; disconnect aborts device authorization before waiting.
 * Token-bearing fields use registry.secrets_enc. No refresh/revoke endpoint is assumed.
 */
import { Mutex } from 'async-mutex';
import { McpConnection } from './mcp-client';
import * as registry from './registry';
import { isConnectorEnabled } from '../component_enabled';
import { TENCENT_SURVEY_ID as ID, TENCENT_SURVEY_MCP_URL as URL } from './catalog-tencent-survey';
import { authorizeTencentSurvey, cancelTencentSurveyAuth, cancelAllTencentSurveyAuth, isTencentSurveyToken, surveyError } from './tencent-survey-auth';
import type { ConnectorInstance, OAuthGrant, ToolSchema } from './types';

// Names documented in the official package; schemas/descriptions always come from live MCP.
const BUSINESS = new Set(['get_survey', 'create_survey', 'update_question', 'batch_create_question',
  'delete_question', 'update_settings', 'update_logic', 'list_answers']);
const locks = new Map<string, Mutex>();
const live = new Map<string, McpConnection>();
function lock(uid: string): Mutex {
  if (!uid) throw new Error('uid required');
  if (!locks.has(uid)) locks.set(uid, new Mutex());
  return locks.get(uid)!;
}
export function surveyBusinessTools(tools: ToolSchema[]): ToolSchema[] {
  return tools.filter(t => BUSINESS.has(t.name));
}
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/401|403|invalid[_ ]token|token[_ ]expired|missing_token|unauthorized/i.test(message)) return 'survey_reauthorize';
  if (/survey_[a-z_]+/.test(message)) return message.match(/survey_[a-z_]+/)![0];
  return 'survey_connection_failed';
}
async function close(uid: string): Promise<void> {
  const conn = live.get(uid); live.delete(uid);
  await conn?.close().catch(() => {});
}
async function open(grant: OAuthGrant, signal?: AbortSignal): Promise<{ conn: McpConnection; tools: ToolSchema[] }> {
  if (!isTencentSurveyToken(grant.access_token)) throw surveyError('survey_reauthorize');
  const conn = new McpConnection(ID, { kind: 'streamable-http', url: URL,
    headers: { Authorization: `Bearer ${grant.access_token}` } });
  try {
    signal?.throwIfAborted();
    await conn.connect();
    signal?.throwIfAborted();
    const tools = surveyBusinessTools(await conn.listTools({ signal }));
    signal?.throwIfAborted();
    if (!tools.length) throw surveyError('survey_no_business_tools');
    return { conn, tools };
  } catch (err) { await conn.close().catch(() => {}); throw surveyError(errorCode(err)); }
}
export async function connectTencentSurvey(uid: string): Promise<ConnectorInstance> {
  return authorizeTencentSurvey(uid, (grant, signal) => lock(uid).runExclusive(async () => {
    signal.throwIfAborted();
    const { conn, tools } = await open(grant, signal);
    try {
      signal.throwIfAborted();
      const old = registry.load(uid).connections[ID];
      const now = new Date().toISOString();
      const inst: ConnectorInstance = { id: ID, display_name: '腾讯问卷', origin: 'catalog',
        transport: { kind: 'streamable-http', url: URL, headers: { Authorization: `Bearer ${grant.access_token}` } },
        oauth_grant: grant, enabled_subtools: old?.enabled_subtools ?? null,
        tools_cache: tools, tools_cached_at: Date.now(), status: { kind: 'connected', since: Date.now() },
        created_at: old?.created_at ?? now, updated_at: now };
      await registry.upsert(uid, inst);
      // If cancelled while the atomic write ran, restore the previous row before releasing lock.
      if (signal.aborted) {
        if (old) await registry.upsert(uid, old); else await registry.remove(uid, ID);
        signal.throwIfAborted();
      }
      await close(uid); live.set(uid, conn);
      return inst;
    } catch (err) { await conn.close().catch(() => {}); throw err; }
  }));
}
async function verify(uid: string): Promise<ConnectorInstance> {
  const inst = registry.load(uid).connections[ID];
  if (!inst) throw surveyError('survey_not_connected');
  await close(uid);
  let conn: McpConnection | undefined;
  try {
    if (!inst.oauth_grant) throw surveyError('survey_reauthorize');
    const opened = await open(inst.oauth_grant); conn = opened.conn;
    const updated = await registry.update(uid, ID, cur => ({ ...cur, tools_cache: opened.tools,
      tools_cached_at: Date.now(), auth_error: undefined,
      status: { kind: 'connected', since: Date.now() }, updated_at: new Date().toISOString() }));
    if (!updated) throw surveyError('survey_not_connected');
    live.set(uid, conn); return updated;
  } catch (err) {
    await conn?.close().catch(() => {});
    const code = errorCode(err);
    const updated = await registry.update(uid, ID, cur => ({ ...cur, tools_cache: [],
      status: { kind: 'error', message: code, at: Date.now() }, updated_at: new Date().toISOString() }));
    if (!updated) throw surveyError(code);
    return updated;
  }
}
export async function refreshTencentSurvey(uid: string): Promise<ConnectorInstance> {
  return lock(uid).runExclusive(() => verify(uid));
}
export async function removeTencentSurvey(uid: string): Promise<boolean> {
  cancelTencentSurveyAuth(uid);
  return lock(uid).runExclusive(async () => { await close(uid); return registry.remove(uid, ID); });
}
export async function callTencentSurvey(uid: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return lock(uid).runExclusive(async () => {
    signal?.throwIfAborted();
    let inst = registry.load(uid).connections[ID];
    if (!inst || inst.status.kind !== 'connected' || !isConnectorEnabled(uid, ID)) throw surveyError('survey_not_connected');
    if (!BUSINESS.has(name) || (inst.enabled_subtools !== null && !inst.enabled_subtools.includes(name))) throw surveyError('survey_tool_disabled');
    if (!live.get(uid)?.isConnected) inst = await verify(uid);
    const conn = live.get(uid);
    if (!conn || inst.status.kind !== 'connected') throw surveyError('survey_not_connected');
    if (!inst.tools_cache.some(t => t.name === name)) throw surveyError('survey_tool_disabled');
    signal?.throwIfAborted();
    try {
      const result = await conn.callTool(name, args, { signal }) as { isError?: boolean; content?: Array<{ text?: string }> };
      if (result.isError && errorCode(result.content?.map(c => c.text || '').join('\n')) === 'survey_reauthorize') throw surveyError('survey_reauthorize');
      return result; // Business errors keep their schema guidance; never retry non-idempotent writes.
    } catch (err) {
      await close(uid);
      if (signal?.aborted) throw surveyError('user_cancelled');
      const code = errorCode(err);
      await registry.update(uid, ID, cur => ({ ...cur, tools_cache: [],
        status: { kind: 'error', message: code, at: Date.now() }, updated_at: new Date().toISOString() }));
      throw surveyError(code);
    }
  });
}
export async function shutdownTencentSurvey(): Promise<void> {
  cancelAllTencentSurveyAuth();
  await Promise.all([...live.keys()].map(uid => lock(uid).runExclusive(() => close(uid))));
}
