import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const state = vi.hoisted(() => ({ fail: false, transports: [] as any[], calls: [] as any[], releases: [] as any[] }));
vi.mock('../../../../src/main/features/connectors/mcp-client', () => ({ McpConnection: class {
  isConnected = true;
  constructor(public id: string, public transport: any) { state.transports.push(transport); }
  async connect() {}
  async listTools() { if (state.fail) throw new Error('email_auth_failed'); return ['search_messages', 'read_message', 'list_folders'].map(name => ({ name, description: 'Read-only', input_schema: {} })); }
  async callTool(name: string, args: any) { state.calls.push([this.transport.env.EMAIL_ADDRESS, name, args]); return { content: [{ text: 'ok' }] }; }
  async close() { this.isConnected = false; state.releases.push(this.transport.env.EMAIL_ADDRESS); }
} }));
vi.mock('electron', () => ({ app: { isPackaged: false } }));
let tmp: string, previous: string | undefined;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'email-auth-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmp; vi.resetModules(); state.fail = false; state.transports = []; state.calls = []; state.releases = []; });
afterEach(async () => { await (await import('../../../../src/main/features/connectors/email-auth')).shutdownEmail(); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(tmp, { recursive: true, force: true }); });
describe('mailbox credential lifecycle', () => {
  it('encrypts per-user/per-instance credentials and isolates simultaneous live accounts', async () => {
    const auth = await import('../../../../src/main/features/connectors/email-auth');
    const paths = await import('../../../../src/main/paths');
    const registry = await import('../../../../src/main/features/connectors/registry');
    const a = await auth.connectEmail('alice', 'email-qq', 'alice@qq.com', 'secret-a');
    await auth.connectEmail('bob', 'email-qq', 'bob@qq.com', 'secret-b');
    await auth.connectEmail('alice', 'email-163', 'alice@163.com', 'secret-c');
    expect(a.status.kind).toBe('connected'); expect(a.oauth_grant).toBeUndefined();
    const disk = fs.readFileSync(paths.userConnectorsConfigFile('alice'), 'utf8');
    expect(disk).not.toContain('secret-a'); expect(disk).not.toContain('secret-c'); expect(disk).toContain('secrets_enc');
    await auth.callEmail('alice', 'email-qq', 'search_messages', {});
    await auth.callEmail('bob', 'email-qq', 'search_messages', {});
    expect(state.calls.map(c => c[0])).toEqual(['alice@qq.com', 'bob@qq.com']);
    // Ciphertext copied to another user must fail closed.
    const bobPath = paths.userConnectorsConfigFile('bob'); fs.writeFileSync(bobPath, disk);
    const bob = registry.load('bob').connections['email-qq'];
    expect(bob.transport).toBeUndefined(); expect(bob.status.kind).toBe('error');
  });
  it('failed INBOX verification never marks connected or exposes tools; retry recovers', async () => {
    const auth = await import('../../../../src/main/features/connectors/email-auth');
    state.fail = true;
    const failed = await auth.connectEmail('u', 'email-enterprise', 'person@company.test', 'private', { host: 'imap.company.test', port: 993, security: 'tls' });
    expect(failed.status).toMatchObject({ kind: 'error', message: 'email_auth_failed' }); expect(failed.tools_cache).toEqual([]);
    await expect(auth.callEmail('u', 'email-enterprise', 'search_messages', {})).rejects.toThrow('email_not_connected');
    state.fail = false; expect((await auth.refreshEmail('u', 'email-enterprise')).status.kind).toBe('connected');
    await expect(auth.callEmail('u', 'email-enterprise', 'send_mail', {})).rejects.toThrow('email_tool_disabled');
    await auth.removeEmail('u', 'email-enterprise');
    await expect(auth.callEmail('u', 'email-enterprise', 'search_messages', {})).rejects.toThrow('email_not_connected');
  });
  it('persists enterprise settings per account, returns only safe fields and rejects missing endpoints', async () => {
    const auth = await import('../../../../src/main/features/connectors/email-auth');
    const registry = await import('../../../../src/main/features/connectors/registry');
    const settings = { host: 'imap.company.test', port: 1143, security: 'starttls', username: 'staff' };
    const inst = await auth.connectEmail('u', 'email-enterprise', 'p@company.test', 'private', settings);
    expect(auth.emailConnectionSettings(inst)).toEqual({ address: 'p@company.test', has_saved_password: true, ...settings });
    await auth.shutdownEmail(); await auth.refreshEmail('u', 'email-enterprise');
    expect(state.transports.at(-1).env).toMatchObject({ EMAIL_IMAP_HOST: settings.host, EMAIL_IMAP_PORT: '1143', EMAIL_IMAP_SECURITY: 'starttls', EMAIL_USERNAME: 'staff' });
    await expect(auth.connectEmail('u', 'email-enterprise', 'p@company.test', 'private')).rejects.toThrow('email_invalid_server');
    expect(registry.load('u').connections['email-enterprise'].transport).toEqual(inst.transport);
    await registry.update('u', 'email-enterprise', row => ({ ...row, transport: { kind: 'stdio', command: 'untrusted', env: { EMAIL_ADDRESS: 'old@company.test', EMAIL_PASSWORD: 'old-secret' } } }));
    const legacy = await auth.refreshEmail('u', 'email-enterprise');
    expect(legacy.status).toMatchObject({ kind: 'error', message: 'email_invalid_server' });
    expect(legacy.tools_cache).toEqual([]);
    expect(() => auth.emailConnectionSettings(legacy)).toThrow('email_invalid_server');
  });
  it.each([
    ['email-qq', 'p@qq.com', undefined],
    ['email-163', 'p@163.com', undefined],
    ['email-enterprise', 'p@company.test', { host: 'imap.company.test', port: 993, security: 'tls' }],
  ])('reverifies the saved credential after closing live connections for %s', async (id, address, settings) => {
    const auth = await import('../../../../src/main/features/connectors/email-auth');
    await auth.connectEmail('u', id, address, 'saved-fixture-secret', settings);
    await auth.shutdownEmail();
    const refreshed = await auth.refreshEmail('u', id);
    expect(refreshed.status.kind).toBe('connected');
    expect(state.transports.at(-1).env.EMAIL_PASSWORD).toBe('saved-fixture-secret');
    expect(auth.emailConnectionSettings(refreshed)?.has_saved_password).toBe(true);
    expect(JSON.stringify(auth.emailConnectionSettings(refreshed))).not.toContain('saved-fixture-secret');
    await auth.removeEmail('u', id);
    await expect(auth.refreshEmail('u', id)).rejects.toThrow('email_not_configured');
  });
  it('honors disable/subtool filtering and serializes replacement then removal', async () => {
    const auth = await import('../../../../src/main/features/connectors/email-auth');
    const enabled = await import('../../../../src/main/features/component_enabled');
    const registry = await import('../../../../src/main/features/connectors/registry');
    await auth.connectEmail('u', 'email-qq', 'one@qq.com', 'first');
    enabled.setConnectorEnabled('u', 'email-qq', false);
    await expect(auth.callEmail('u', 'email-qq', 'search_messages', {})).rejects.toThrow('email_not_connected');
    enabled.setConnectorEnabled('u', 'email-qq', true);
    await registry.update('u', 'email-qq', row => ({ ...row, enabled_subtools: ['read_message'] }));
    await expect(auth.callEmail('u', 'email-qq', 'search_messages', {})).rejects.toThrow('email_tool_disabled');
    await Promise.all([auth.connectEmail('u', 'email-qq', 'two@qq.com', 'second'), auth.removeEmail('u', 'email-qq')]);
    expect(registry.load('u').connections['email-qq']).toBeUndefined();
    expect(state.releases).toContain('one@qq.com'); expect(state.releases).toContain('two@qq.com');
  });
});
