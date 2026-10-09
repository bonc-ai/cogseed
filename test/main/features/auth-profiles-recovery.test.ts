import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-auth-recovery';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-auth-recovery-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('auth profiles recovery', () => {
  it('surfaces hosted-encrypted stores as recoverable when hosted backend is unavailable', async () => {
    const paths = await import('../../../src/main/paths');
    fs.mkdirSync(paths.userLocalConfigDir(TEST_UID), { recursive: true });
    fs.writeFileSync(paths.userAuthProfilesFile(TEST_UID), 'ORKLSEC1:not-decryptable-in-oss');
    const auth = await import('../../../src/main/features/auth');
    expect(auth.getProfilesStoreStatus()).toMatchObject({
      ok: false,
      recoverable: true,
      reason: 'hosted_backend_unavailable',
    });
  });

  it('backs up an unreadable store and creates a fresh empty store', async () => {
    const paths = await import('../../../src/main/paths');
    fs.mkdirSync(paths.userLocalConfigDir(TEST_UID), { recursive: true });
    fs.writeFileSync(paths.userAuthProfilesFile(TEST_UID), 'ORKLSEC1:not-decryptable-in-oss');
    const auth = await import('../../../src/main/features/auth');
    const result = auth.resetProfilesStoreAfterDecryptFailure();
    expect(result.ok).toBe(true);
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    expect(auth.getProfilesStoreStatus()).toMatchObject({ ok: true, entries: 0, profiles: 0 });
    expect((await auth.listEntries()).entries).toEqual([]);
  });
});
