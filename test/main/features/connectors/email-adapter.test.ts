import { describe, it, expect, vi } from 'vitest';
const { createMailbox, config, TOOLS, safeError } = require('../../../../bin/email-mcp-core.cjs');
function harness() {
  const options: any[] = [], calls: any[] = [];
  const state = { validity: 7n, next: 1051 as number | undefined, exists: 3, latestUid: 1049 as number | undefined, ids: [1049, 1048, 1047], fail: null as any, size: 120,
    source: Buffer.from('From: sender@example.com\r\nSubject: =?UTF-8?B?5rWL6K+V?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello, external content') };
  class ImapFlow {
    mailbox = { uidValidity: state.validity, uidNext: state.next, exists: state.exists };
    constructor(opts: any) { options.push(opts); }
    on() {}
    async connect() { if (state.fail) throw state.fail; }
    async getMailboxLock(folder: string, opts: any) { calls.push(['lock', folder, opts]); return { release() { calls.push(['release']); } }; }
    close() { calls.push(['close']); }
    async search(query: any, opts: any) { calls.push(['search', query, opts]); return state.ids; }
    async *fetch(ids: string, query: any, opts: any) { calls.push(['fetch', ids, query, opts]); for (const uid of ids.split(',').map(Number)) yield { uid, envelope: { subject: 'Hello' }, size: state.size }; }
    async fetchOne(id: string, query: any, opts: any) {
      calls.push(['fetchOne', id, query, opts]);
      if (!opts?.uid) return { uid: state.latestUid };
      if (query.source) return { source: state.source };
      return { uid: Number(id), size: state.size, envelope: { subject: 'Hello' }, bodyStructure: { childNodes: [
        { disposition: 'attachment', dispositionParameters: { filename: 'report.pdf' }, type: 'application/pdf', size: 1024 },
      ] } };
    }
    async list() { return [{ path: 'INBOX', flags: new Set() }, { path: 'hidden', flags: new Set(['\\Noselect']) }]; }
  }
  const make = (address = 'person@qq.com') => createMailbox(config('email-qq', address, 'app-secret'), { ImapFlow });
  return { state, options, calls, make, ImapFlow, mailbox: make() };
}
describe('read-only email protocol', () => {
  it('fixes all three TLS hosts without SMTP and never exposes configuration or writes', async () => {
    expect(config('email-qq', 'p@qq.com', 'x').host).toBe('imap.qq.com');
    expect(config('email-163', 'p@163.com', 'x').host).toBe('imap.163.com');
    expect(() => config('email-enterprise', 'p@corp.test', 'x')).toThrow('email_invalid_server');
    expect(TOOLS.map((x: any) => x.name)).toEqual(['search_messages', 'read_message', 'list_folders']);
    const h = harness(); await h.mailbox.verify();
    expect(h.options[0]).toMatchObject({ secure: true, port: 993, tls: { rejectUnauthorized: true }, logger: false, disableAutoIdle: true });
    expect(h.calls).toContainEqual(['lock', 'INBOX', { readOnly: true }]);
    expect(h.calls.at(-1)).toEqual(['close']);
  });
  it('uses enterprise-defined IMAP TLS or required STARTTLS without allowing plaintext or URLs', async () => {
    for (const security of ['tls', 'starttls']) {
      const h = harness();
      const cfg = config('email-enterprise', 'p@corp.test', 'x', { host: 'imap.other.test', port: 1993, security, username: 'staff-login' });
      await createMailbox(cfg, { ImapFlow: h.ImapFlow }).verify();
      expect(h.options[0]).toMatchObject({ host: 'imap.other.test', port: 1993, secure: security === 'tls',
        doSTARTTLS: security === 'starttls', tls: { rejectUnauthorized: true }, auth: { user: 'staff-login', pass: 'x' } });
    }
    for (const invalid of [{ host: '' }, { host: 'https://mail.test' }, { port: 0 }, { port: 65536 }, { security: 'none' }, { username: 'a\nLOGIN' }]) {
      expect(() => config('email-enterprise', 'p@corp.test', 'x', { host: 'imap.other.test', port: 993, security: 'tls', ...invalid })).toThrow('email_invalid_server');
    }
    expect(config('email-qq', 'p@qq.com', 'x', { host: 'evil.test', port: 143 }).host).toBe('imap.qq.com');
  });
  it('uses UID for list-to-body and rejects cross-account or reset mailbox references', async () => {
    const h = harness(); const page = await h.mailbox.call('search_messages', { limit: 2 });
    const ref = page.messages[0].message_ref;
    const message = await h.mailbox.call('read_message', { message_ref: ref });
    expect(message).toMatchObject({ account: 'person@qq.com', uid: 1049, body: 'Hello, external content', untrusted_content: true });
    expect(message.attachments).toEqual([{ filename: 'report.pdf', content_type: 'application/pdf', size: 1024 }]);
    expect(h.calls.filter(c => c[0] === 'fetchOne').every(c => c[3].uid === true)).toBe(true);
    await expect(h.make('other@qq.com').call('read_message', { message_ref: ref })).rejects.toThrow('email_invalid_reference');
    h.state.validity = 8n;
    await expect(h.mailbox.call('read_message', { message_ref: ref })).rejects.toThrow('email_stale_reference');
  });
  it('rejects message references and cursors after switching enterprise server or login', async () => {
    const h = harness();
    const endpoint = { host: 'mail.one.test', port: 993, security: 'tls', username: 'first' };
    const make = (settings: any) => createMailbox(config('email-enterprise', 'p@company.test', 'x', settings), { ImapFlow: h.ImapFlow });
    const page = await make(endpoint).call('search_messages', { limit: 1 });
    for (const changed of [{ host: 'mail.two.test' }, { username: 'second' }]) {
      const other = make({ ...endpoint, ...changed });
      await expect(other.call('read_message', { message_ref: page.messages[0].message_ref })).rejects.toThrow('email_invalid_reference');
      await expect(other.call('search_messages', { limit: 1, cursor: page.next_cursor })).rejects.toThrow('email_stale_cursor');
    }
  });
  it('bounds search ranges and paginates even when a scanned window has no matches', async () => {
    const h = harness();
    const input = { from: 'sender@example.com', subject: 'report', keyword: 'deadline', since: '2026-10-01', before: '2026-10-10', limit: 2 };
    const a = await h.mailbox.call('search_messages', input);
    expect(h.calls.find(c => c[0] === 'search')).toEqual(['search', { uid: '51:1050', from: input.from, subject: input.subject, text: input.keyword, since: new Date(input.since), before: new Date(input.before) }, { uid: true }]);
    h.state.ids = [1047];
    const b = await h.mailbox.call('search_messages', { ...input, cursor: a.next_cursor });
    expect(b.messages.map((m: any) => m.uid)).toEqual([1047]);
    await expect(h.mailbox.call('search_messages', { ...input, from: 'other', cursor: a.next_cursor })).rejects.toThrow('email_stale_cursor');
    h.state.ids = [];
    const empty = await h.mailbox.call('search_messages', {});
    expect(empty.messages).toEqual([]); expect(empty.next_cursor).toBeTruthy();
    h.state.next = 1;
    expect((await h.mailbox.call('search_messages', {})).next_cursor).toBeNull();
  });
  it('retrieves existing mail when EXAMINE omits UIDNEXT instead of reporting an empty mailbox', async () => {
    const h = harness(); h.state.next = undefined;
    const page = await h.mailbox.call('search_messages', { limit: 2 });
    expect(page.messages.map((m: any) => m.uid)).toEqual([1049, 1048]);
    expect(page.scanned_uid_range).toEqual([50, 1049]);
    expect(page.next_cursor).toBeTruthy();
    expect(h.calls).toContainEqual(['lock', 'INBOX', { readOnly: true }]);
  });
  it('reports a truly empty mailbox without UIDNEXT without issuing an invalid search', async () => {
    const h = harness(); h.state.next = undefined; h.state.exists = 0;
    const page = await h.mailbox.call('search_messages', {});
    expect(page).toMatchObject({ messages: [], next_cursor: null });
    expect(h.calls.some(c => c[0] === 'search' || c[0] === 'fetchOne')).toBe(false);
    expect(JSON.stringify(page)).not.toContain('[null,null]');
  });
  it('fails explicitly when a nonempty mailbox cannot provide a usable UID', async () => {
    const h = harness(); h.state.next = undefined; h.state.latestUid = undefined;
    await expect(h.mailbox.call('search_messages', {})).rejects.toThrow('email_connection_failed');
    expect(h.calls.some(c => c[0] === 'search')).toBe(false);
  });
  it.each([{ limit: 51 }, { since: '2026-02-30' }, { before: '2026-01-01', since: '2026-10-01' }, { password: 'secret' }, { folder: 'INBOX\nLOGOUT' }])('rejects invalid input before connecting: %j', async input => {
    const h = harness(); await expect(h.mailbox.call('search_messages', input)).rejects.toThrow('email_invalid_arguments'); expect(h.options).toHaveLength(0);
  });
  it('limits large bodies and never returns attachment bytes', async () => {
    const h = harness(); const page = await h.mailbox.call('search_messages', {});
    h.state.size = 3 * 1024 * 1024;
    const result = await h.mailbox.call('read_message', { message_ref: page.messages[0].message_ref });
    expect(result.body_notice).toBe('email_message_too_large');
    expect(h.calls.filter(c => c[0] === 'fetchOne')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('app-secret');
  });
  it('redacts server errors, closes failed sessions and permits explicit recovery', async () => {
    const h = harness(); h.state.fail = Object.assign(new Error('AUTH person@qq.com app-secret'), { authenticationFailed: true });
    await expect(h.mailbox.verify()).rejects.toThrow('email_auth_failed');
    expect(h.calls.at(-1)).toEqual(['close']);
    h.state.fail = new Error('network packet contains app-secret');
    await expect(h.mailbox.verify()).rejects.toThrow('email_connection_failed');
    h.state.fail = null; await expect(h.mailbox.verify()).resolves.toBe(true);
    expect(safeError({ code: 'CERT_HAS_EXPIRED' })).toBe('email_tls_failed');
    expect(safeError(new Error('email_private_password'))).toBe('email_connection_failed');
  });
  it('decodes multipart encoded MIME text without returning executable HTML', async () => {
    const h = harness(); h.state.source = Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n5rWL6K+V\r\n--b\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>\r\n--b--');
    const page = await h.mailbox.call('search_messages', {});
    const result = await h.mailbox.call('read_message', { message_ref: page.messages[0].message_ref });
    expect(result.body.trim()).toBe('测试'); expect(result.html).toBeUndefined();
  });
});
