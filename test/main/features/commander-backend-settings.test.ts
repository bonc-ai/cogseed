import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-commander-backend';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-commander-backend-'));
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

describe('commander backend settings', () => {
  it('defaults to CogSeed Core Agent when no preference exists', async () => {
    const config = await import('../../../src/main/features/config');
    expect(config.getCommanderBackendSettings()).toEqual({
      backend: 'cogseed-core-agent',
      authEntryId: null,
      localCli: null,
    });
  });

  it('normalizes legacy Hermes commander preferences back to CogSeed Core Agent', async () => {
    const config = await import('../../../src/main/features/config');
    config.writePreferences({
      commander_backend: {
        backend: 'hermes-cli',
        authEntryId: null,
        localCli: { type: 'hermes', model: '', useCliDefaultModel: true },
      } as never,
    });
    expect(config.getCommanderBackendSettings()).toEqual({
      backend: 'cogseed-core-agent',
      authEntryId: null,
      localCli: null,
    });
  });

  it('rejects unknown backend kinds', async () => {
    const config = await import('../../../src/main/features/config');
    expect(() => config.setCommanderBackendSettings({
      backend: 'unknown' as never,
      authEntryId: null,
      localCli: null,
    })).toThrow('invalid commander backend');
  });

  it('rejects Hermes as a commander backend', async () => {
    const config = await import('../../../src/main/features/config');
    expect(() => config.setCommanderBackendSettings({
      backend: 'hermes-cli' as never,
      authEntryId: null,
      localCli: { type: 'hermes', useCliDefaultModel: true } as never,
    })).toThrow('invalid commander backend');
  });
});
