import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The local hub mock stands in for the account service (H-01/H-04). Its value is
 * that it *refuses* what the real hub must refuse, so the client cannot be built
 * against a permissive stub: wrong addressee, expired request, duplicate contact,
 * and the three-boolean lookup are all pinned here.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../scripts/dev/a2a-hub-mock.cjs');

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
let server: any;

async function call(path: string, options: { as?: string; method?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      ...(options.as ? { 'x-a2a-user': options.as } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  server = await start({
    port: PORT,
    users: [
      { uid: 'alice', phone: '13800001234', name: 'Alice' },
      { uid: 'bob', phone: '13900005678', name: 'Bob' },
    ],
  });
});

afterAll(() => { try { server.close(); } catch { /* ignore */ } });

describe('a2a hub mock › lookup', () => {
  it('answers exactly three booleans and never profile fields', async () => {
    const res = await call('/lookup', { as: 'alice', body: { phone: '13900005678' } });
    expect(res.body).toEqual({ registered: true, discoverable: true, is_contact: false });
  });

  it('reports an unknown number as unregistered', async () => {
    const res = await call('/lookup', { as: 'alice', body: { phone: '13700000000' } });
    expect(res.body).toEqual({ registered: false, discoverable: false, is_contact: false });
  });

  it('requires an account header', async () => {
    const res = await call('/lookup', { body: { phone: '13900005678' } });
    expect(res.status).toBe(401);
  });
});

describe('a2a hub mock › requests and contacts', () => {
  it('shows the request to the addressee as incoming and to the sender as outgoing', async () => {
    await call('/contacts/requests', { as: 'alice', body: { phone: '13900005678', note: 'hi' } });
    const bobView = await call('/contacts/requests', { as: 'bob' });
    const aliceView = await call('/contacts/requests', { as: 'alice' });
    expect(bobView.body.requests[0]).toMatchObject({ direction: 'in', peerUserId: 'alice' });
    expect(aliceView.body.requests[0]).toMatchObject({ direction: 'out', peerUserId: 'bob' });
  });

  it('only the addressee can accept, and acceptance makes both sides contacts', async () => {
    const id = (await call('/contacts/requests', { as: 'alice' })).body.requests[0].id;
    const wrong = await call(`/contacts/requests/${id}/accept`, { as: 'alice', method: 'POST' });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toBe('not_addressee');

    const ok = await call(`/contacts/requests/${id}/accept`, { as: 'bob', method: 'POST' });
    expect(ok.body.request.state).toBe('accepted');

    const aliceContacts = (await call('/contacts', { as: 'alice' })).body.contacts;
    const bobContacts = (await call('/contacts', { as: 'bob' })).body.contacts;
    expect(aliceContacts.map((row: any) => row.userId)).toEqual(['bob']);
    expect(bobContacts.map((row: any) => row.userId)).toEqual(['alice']);
  });

  it('refuses a second request once they are contacts', async () => {
    const res = await call('/contacts/requests', { as: 'alice', body: { phone: '13900005678' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('already_contact');
  });
});
