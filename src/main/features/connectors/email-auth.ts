/** UI-owned credentials lifecycle. The encrypted transport carries credentials, never a model tool.
 * Each mailbox operation creates an IMAP connection inside the stdio adapter; no background monitor.
 * Serialize per user/instance so reconnect/remove cannot resurrect old credentials or tools.
 */
import { Mutex } from 'async-mutex';
import { McpConnection } from './mcp-client';
import * as registry from './registry';
import { EMAIL_ENTRIES, isEmailConnector } from './catalog-email';
import { applyTemplate } from './apply-template';
import { isConnectorEnabled } from '../component_enabled';
import type { ConnectorInstance, Transport } from './types';

// Share endpoint validation with the packaged stdio adapter.
const { serverSettings } = require('../../../../bin/email-mcp-core.cjs') as {
  serverSettings: (provider: string, address: string, settings: unknown) => EmailServerSettings;
};
export interface EmailServerSettings { host: string; port: number; security: 'tls' | 'starttls'; username: string }

const locks = new Map<string, Mutex>();
const connections = new Map<string, McpConnection>();
const key = (uid: string, id: string) => JSON.stringify([uid, id]);
function mutex(uid: string, id: string): Mutex {
  if (!uid || !isEmailConnector(id)) throw new Error('email_invalid_credentials');
  const k = key(uid, id);
  if (!locks.has(k)) locks.set(k, new Mutex());
  return locks.get(k)!;
}
export function emailErrorCode(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = message.match(/\bemail_[a-z_]+\b/)?.[0];
  const known = new Set(['email_invalid_server', 'email_invalid_credentials', 'email_not_configured', 'email_invalid_tools',
    'email_auth_failed', 'email_tls_failed', 'email_connection_failed', 'email_invalid_reference',
    'email_invalid_arguments', 'email_stale_cursor', 'email_stale_reference', 'email_message_missing',
    'email_unknown_tool']);
  return code && known.has(code) ? code : 'email_connection_failed';
}
function credentials(id: string, address: unknown, password: unknown): { address: string; password: string } {
  if (!isEmailConnector(id) || typeof address !== 'string' || typeof password !== 'string') throw new Error('email_invalid_credentials');
  const email = address.trim();
  const domain = email.split('@')[1]?.toLowerCase();
  if (email.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@]+$/.test(email)
    || (id === 'email-qq' && !['qq.com', 'foxmail.com'].includes(domain))
    || (id === 'email-163' && domain !== '163.com')
    || !password.length || password.length > 2048 || /[\x00\r\n]/.test(password)) throw new Error('email_invalid_credentials');
  return { address: email, password };
}
/** Public settings only: the password never leaves Main. Enterprise mail always
 * requires an explicitly configured endpoint, including restored incomplete records. */
export function emailConnectionSettings(inst: ConnectorInstance): (EmailServerSettings & { address: string; has_saved_password: boolean }) | undefined {
  if (!isEmailConnector(inst.id) || inst.transport?.kind !== 'stdio') return undefined;
  const env = inst.transport.env || {};
  const address = env.EMAIL_ADDRESS;
  if (!address) return undefined;
  return { address, has_saved_password: typeof env.EMAIL_PASSWORD === 'string' && env.EMAIL_PASSWORD.length > 0,
    ...serverSettings(inst.id, address, { host: env.EMAIL_IMAP_HOST, port: Number(env.EMAIL_IMAP_PORT), security: env.EMAIL_IMAP_SECURITY, username: env.EMAIL_USERNAME }) };
}
function transportFor(inst: ConnectorInstance): Transport {
  const env = inst.transport?.kind === 'stdio' ? inst.transport.env : undefined;
  const value = credentials(inst.id, env?.EMAIL_ADDRESS, env?.EMAIL_PASSWORD);
  const settings = emailConnectionSettings(inst)!;
  return makeTransport(inst.id, value, settings);
}
function makeTransport(id: string, value: { address: string; password: string }, settings: EmailServerSettings): Transport {
  const base = applyTemplate(EMAIL_ENTRIES.find(e => e.id === id)!, null);
  if (base.kind !== 'stdio') throw new Error('email_invalid_credentials');
  return { ...base, env: { ...base.env, EMAIL_PROVIDER: id, EMAIL_ADDRESS: value.address, EMAIL_PASSWORD: value.password,
    EMAIL_IMAP_HOST: settings.host, EMAIL_IMAP_PORT: String(settings.port), EMAIL_IMAP_SECURITY: settings.security, EMAIL_USERNAME: settings.username } };
}
async function close(uid: string, id: string): Promise<void> {
  const k = key(uid, id), conn = connections.get(k);
  connections.delete(k);
  if (conn) await conn.close();
}
async function verify(uid: string, id: string): Promise<ConnectorInstance> {
  const inst = registry.load(uid).connections[id];
  if (!inst) throw new Error('email_not_configured');
  await close(uid, id);
  let conn: McpConnection | undefined;
  try {
    const transport = transportFor(inst);
    conn = new McpConnection(id, transport);
    await conn.connect();
    const tools = await conn.listTools(); // Server verifies authentication and INBOX EXAMINE here.
    const allowed = new Set(['search_messages', 'read_message', 'list_folders']);
    if (tools.length !== allowed.size || tools.some(t => !allowed.has(t.name))) throw new Error('email_invalid_tools');
    const updated = await registry.update(uid, id, cur => ({ ...cur, transport, tools_cache: tools, tools_cached_at: Date.now(),
      status: { kind: 'connected', since: Date.now() }, updated_at: new Date().toISOString() }));
    if (!updated) throw new Error('email_not_configured');
    connections.set(key(uid, id), conn);
    return updated;
  } catch (err) {
    await conn?.close();
    const code = emailErrorCode(err);
    const updated = await registry.update(uid, id, cur => ({ ...cur, tools_cache: [],
      status: { kind: 'error', message: code, at: Date.now() }, updated_at: new Date().toISOString() }));
    if (!updated) throw new Error(code);
    return updated;
  }
}
export async function connectEmail(uid: string, id: string, address: unknown, password: unknown, settings?: unknown): Promise<ConnectorInstance> {
  const c = credentials(id, address, password);
  const endpoint = serverSettings(id, c.address, settings);
  return mutex(uid, id).runExclusive(async () => {
    const entry = EMAIL_ENTRIES.find(e => e.id === id)!;
    await close(uid, id);
    const now = new Date().toISOString();
    await registry.upsert(uid, { id, display_name: `${entry.display_name} · ${c.address}`, enabled_subtools: null,
      transport: makeTransport(id, c, endpoint),
      tools_cache: [], tools_cached_at: 0, status: { kind: 'connecting' }, created_at: now, updated_at: now });
    return verify(uid, id);
  });
}
export async function refreshEmail(uid: string, id: string): Promise<ConnectorInstance> {
  return mutex(uid, id).runExclusive(() => verify(uid, id));
}
export async function removeEmail(uid: string, id: string): Promise<boolean> {
  return mutex(uid, id).runExclusive(async () => { await close(uid, id); return registry.remove(uid, id); });
}
export async function callEmail(uid: string, id: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return mutex(uid, id).runExclusive(async () => {
    if (signal?.aborted) throw new Error('email_cancelled');
    let inst = registry.load(uid).connections[id];
    if (!inst || inst.status.kind !== 'connected' || !isConnectorEnabled(uid, id)) throw new Error('email_not_connected');
    if (!['search_messages', 'read_message', 'list_folders'].includes(name)
      || (inst.enabled_subtools !== null && !inst.enabled_subtools.includes(name))) throw new Error('email_tool_disabled');
    if (!connections.get(key(uid, id))?.isConnected) inst = await verify(uid, id);
    const conn = connections.get(key(uid, id));
    if (!conn || inst.status.kind !== 'connected') throw new Error('email_not_connected');
    try {
      const result = await conn.callTool(name, args, { signal }) as { isError?: boolean; content?: Array<{ text?: string }> };
      if (result.isError) {
        const code = emailErrorCode(result.content?.[0]?.text);
        if (['email_connection_failed', 'email_auth_failed', 'email_tls_failed'].includes(code)) throw new Error(code);
      }
      return result;
    } catch (err) {
      await close(uid, id);
      const code = signal?.aborted ? 'email_cancelled' : emailErrorCode(err);
      if (!signal?.aborted) await registry.update(uid, id, cur => ({ ...cur, tools_cache: [],
        status: { kind: 'error', message: code, at: Date.now() }, updated_at: new Date().toISOString() }));
      throw new Error(code);
    }
  });
}
export async function shutdownEmail(): Promise<void> {
  await Promise.all([...connections.values()].map(c => c.close()));
  connections.clear();
}
