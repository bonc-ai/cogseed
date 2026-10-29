import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { OpencodeApi } from '../../../../p3394-gateway/opencode-api.cjs';

const password = 'test-server-password';
const authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
const spec = { paths: {
  '/api/session': { post: {} },
  '/api/session/{sessionID}/prompt': { post: {} },
  '/api/experimental/session/{sessionID}/wait': { post: {} },
  '/api/session/{sessionID}/interrupt': { post: {} },
  '/api/session/{sessionID}/message': { get: {} },
} };
const idle = { id: 'idle-new', type: 'idle', outcome: 'succeeded' };
const answer = { id: 'answer-new', type: 'assistant', content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: '你好，已恢复' }] };
const user = { id: 'prompt-new', type: 'user', text: 'hello' };
const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(options: { pages?: any[]; discovery?: { status: number; body: unknown }; waitStatus?: number } = {}) {
  const requests: Array<{ route: string; method: string; body: any; authorized: boolean }> = [];
  const pages = options.pages || [{ data: [idle, answer, user, { ...answer, id: 'old-answer' }], cursor: {} }];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const route = req.url || '';
    requests.push({ route, method: req.method || '', body: text ? JSON.parse(text) : undefined, authorized: req.headers.authorization === authorization });
    res.setHeader('content-type', 'application/json');
    const send = (status: number, body?: unknown) => { res.writeHead(status); res.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)); };
    if (route === '/openapi.json') return send(options.discovery?.status || 200, options.discovery?.body ?? spec);
    if (req.headers.authorization !== authorization) return send(401, { message: password });
    if (route === '/api/session') return send(200, { data: { id: 'ses-v2' } });
    if (route.endsWith('/model')) return send(204);
    if (route.endsWith('/prompt')) return send(200, { data: { id: 'prompt-new', type: 'user' } });
    if (route.endsWith('/wait')) return send(options.waitStatus || 204, options.waitStatus ? { message: password } : undefined);
    if (route.includes('/message?')) return send(200, pages.shift());
    if (route.endsWith('/interrupt?resume=false')) return send(200, { interrupted: true });
    send(405);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as import('node:net').AddressInfo;
  const api = new OpencodeApi('http://127.0.0.1:' + address.port, password);
  return { api, requests };
}

describe('OpenCode versioned HTTP contract', () => {
  it('authenticates v2, preserves the workspace/model and returns only this turn’s visible reply after idle', async () => {
    const { api, requests } = await fixture();
    await api.detect();
    expect(api.v2).toBe(true);
    const sid = await api.createSession('/workspace/project');
    expect(await api.deliver(sid, 'hello', 'provider/model/with/slashes')).toBe('你好，已恢复');
    expect(requests.every((request) => request.authorized)).toBe(true);
    expect(requests.find((request) => request.route === '/api/session')?.body).toEqual({ location: { directory: '/workspace/project' } });
    expect(requests.find((request) => request.route.endsWith('/model'))?.body).toEqual({ model: { providerID: 'provider', id: 'model/with/slashes' } });
    expect(requests.find((request) => request.route.endsWith('/prompt'))?.body).toEqual({ text: 'hello' });
    expect(requests.findIndex((request) => request.route.endsWith('/wait'))).toBeLessThan(requests.findIndex((request) => request.route.includes('/message?')));
  });

  it('reads beyond the first projected page without leaking a previous turn', async () => {
    const { api, requests } = await fixture({ pages: [
      { data: [idle, answer], cursor: { next: 'next/opaque' } },
      { data: [user, { ...answer, id: 'old' }], cursor: {} },
    ] });
    await api.detect();
    expect(await api.deliver('ses-v2', 'hello')).toBe('你好，已恢复');
    expect(requests.at(-1)?.route).toContain('cursor=next%2Fopaque');
  });

  it.each([
    [404, ''], [405, ''], [200, '<!doctype html><html>v1 web UI</html>'],
  ])('retains the v1 transport when discovery returns %s', async (status, body) => {
    const { api } = await fixture({ discovery: { status, body } });
    await api.detect();
    expect(api.v2).toBe(false);
  });

  it.each([401, 500])('does not mistake discovery HTTP %s for a legacy server', async (status) => {
    const { api } = await fixture({ discovery: { status, body: { message: password } } });
    await expect(api.detect()).rejects.toThrow('discovery_http_' + status);
  });

  it('recognizes a legacy server that publishes its old OpenAPI schema', async () => {
    const { api } = await fixture({ discovery: { status: 200, body: { paths: { '/session': { post: {} }, '/session/{sessionID}/message': { post: {} } } } } });
    await api.detect();
    expect(api.v2).toBe(false);
  });

  it('rejects a look-alike schema before sending a prompt', async () => {
    const { api, requests } = await fixture({ discovery: { status: 200, body: { paths: { '/api/session': { post: {} } } } } });
    await expect(api.detect()).rejects.toThrow('unsupported_api');
    expect(requests).toHaveLength(1);
  });

  it.each([
    { data: [answer, user] },
    { data: [{ ...idle, outcome: 'failed' }, answer, user] },
    { data: [{ ...idle, outcome: 'interrupted' }, answer, user] },
    { data: [idle, { ...answer, error: { message: 'provider error' } }, user] },
    { data: [idle, { ...answer, content: [{ type: 'reasoning', text: 'not a reply' }] }, user] },
    { data: [idle, answer] },
    { data: 'not messages' },
  ])('rejects partial, failed, empty or unrelated terminal results', async (page) => {
    const { api } = await fixture({ pages: [page] });
    await expect(api.deliver('ses-v2', 'hello')).rejects.toThrow(/p3394_opencode_/);
  });

  it('does not read an old reply if waiting fails, and excludes echoed secrets from errors', async () => {
    const { api, requests } = await fixture({ waitStatus: 503 });
    await expect(api.deliver('ses-v2', 'hello')).rejects.toThrow('p3394_opencode_http_503');
    expect(requests.some((request) => request.route.includes('/message?'))).toBe(false);
  });

  it('stops between prompt admission and waiting when cancelled', async () => {
    const { api, requests } = await fixture();
    let cancelled = false;
    await expect(api.deliver('ses-v2', 'hello', undefined, {
      isCancelled: () => cancelled,
      onRequest: (req: http.ClientRequest) => { if (req.path.endsWith('/prompt')) req.on('response', () => { cancelled = true; }); },
    })).rejects.toThrow('p3394_opencode_cancelled');
    expect(requests.map((request) => request.route)).toEqual(['/api/session/ses-v2/prompt']);
  });

  it('routes v2 text deltas without exposing reasoning, and cancels through the authenticated interrupt API', async () => {
    const { api, requests } = await fixture();
    await api.detect();
    const source = fs.readFileSync('p3394-gateway/gateway.cjs', 'utf8');
    const start = source.indexOf('class OpencodeRuntime');
    const end = source.indexOf('const claudePersistentRuntime', start);
    const Runtime = vm.runInNewContext(source.slice(start, end) + '\nOpencodeRuntime', { http, Buffer, setTimeout, clearTimeout, console, OUTBOUND_HTTP_TIMEOUT_MS: 2000 });
    const runtime = new Runtime();
    const onDelta = vi.fn();
    runtime.turns.set('ses-v2', { onDelta });
    runtime._onEvent({ type: 'session.reasoning.delta', data: { sessionID: 'ses-v2', delta: 'private' } });
    runtime._onEvent({ type: 'session.text.delta', data: { sessionID: 'other', delta: 'unrelated' } });
    runtime._onEvent({ type: 'session.text.delta', data: { sessionID: 'ses-v2', delta: 'visible' } });
    expect(onDelta.mock.calls).toEqual([['visible']]);
    await runtime._abortSession({ base: api.base, api }, 'ses-v2');
    expect(requests.at(-1)).toMatchObject({ route: '/api/session/ses-v2/interrupt?resume=false', method: 'POST', authorized: true });
  });
});
