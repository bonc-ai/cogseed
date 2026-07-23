import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-commander-backend';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-commander-backend-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('commander backend settings', () => {
  it('defaults to Orkas Core Agent when no preference exists', async () => {
    const config = await import('../../../src/main/features/config');
    expect(config.getCommanderBackendSettings()).toEqual({
      backend: 'orkas-core-agent',
      authEntryId: null,
      localCli: null,
    });
  });

  it('persists Hermes CLI selection without storing secrets', async () => {
    const config = await import('../../../src/main/features/config');
    config.setCommanderBackendSettings({
      backend: 'hermes-cli',
      authEntryId: null,
      localCli: { type: 'hermes', model: '', useCliDefaultModel: true },
    });
    expect(config.readPreferences().commander_backend).toMatchObject({
      backend: 'hermes-cli',
      authEntryId: null,
      localCli: { type: 'hermes', model: '', useCliDefaultModel: true },
    });
    expect(JSON.stringify(config.readPreferences().commander_backend)).not.toMatch(/api|secret|key|token/i);
  });

  it('rejects unknown backend kinds', async () => {
    const config = await import('../../../src/main/features/config');
    expect(() => config.setCommanderBackendSettings({
      backend: 'unknown' as never,
      authEntryId: null,
      localCli: null,
    })).toThrow('invalid commander backend');
  });

  it('rejects Hermes without Hermes localCli settings', async () => {
    const config = await import('../../../src/main/features/config');
    expect(() => config.setCommanderBackendSettings({
      backend: 'hermes-cli',
      authEntryId: null,
      localCli: null,
    })).toThrow('hermes backend requires hermes localCli settings');
  });
});
