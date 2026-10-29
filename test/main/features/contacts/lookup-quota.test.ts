import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const uid = 'lookup-quota-user';
let root: string;
let previous: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-quota-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

async function signIn() {
  const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
  saveHubSession(uid, {
    session_id: 'lookup-quota-session',
    access_token: 'synthetic',
    refresh_token: 'synthetic-refresh',
    access_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
  });
  writeHubAccountState(uid, { account_id: 'self' });
}

it('surfaces the Hub quota rejection instead of falling back to a local miss', async () => {
  await signIn();
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status: 429,
    json: async () => ({ ok: false, error: { code: 'LOOKUP_QUOTA_EXCEEDED', message: '今日查找次数已用完' } }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  const { hubLookupPhone } = await import('../../../../src/main/features/contacts/hub-client');
  const { lookupPhone } = await import('../../../../src/main/features/contacts/store');

  await expect(hubLookupPhone(uid, '13900000011')).rejects.toMatchObject({ code: 'LOOKUP_QUOTA_EXCEEDED' });
  await expect(lookupPhone(uid, '13900000011')).rejects.toMatchObject({ code: 'LOOKUP_QUOTA_EXCEEDED' });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('still falls back to the local lookup when Hub is unreachable', async () => {
  await signIn();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
  const { lookupPhone } = await import('../../../../src/main/features/contacts/store');
  await expect(lookupPhone(uid, '13900000011')).resolves.toEqual({
    registered: false,
    discoverable: false,
    is_contact: false,
  });
});
