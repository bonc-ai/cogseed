import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-commander-routing';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-commander-routing-'));
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

describe('commander backend routing', () => {
  it('defaults to Orkas Core Agent', async () => {
    const mod = await import('../../../src/main/features/commander_backend');
    const view = await mod.getCommanderBackendView();
    expect(view.settings).toEqual({
      backend: 'orkas-core-agent',
      authEntryId: null,
      localCli: null,
    });
  });

  it('surfaces Hermes availability in the backend view', async () => {
    const mod = await import('../../../src/main/features/commander_backend');
    const view = await mod.getCommanderBackendView();
    expect(typeof view.hermes.available).toBe('boolean');
    expect(view.hermes.path === null || typeof view.hermes.path === 'string').toBe(true);
    expect(view.hermes.version === null || typeof view.hermes.version === 'string').toBe(true);
  });

  it('resolves Hermes when explicitly selected', async () => {
    const mod = await import('../../../src/main/features/commander_backend');
    const resolved = await mod.resolveCommanderBackend({
      backend: 'hermes-cli',
      authEntryId: null,
      localCli: { type: 'hermes', useCliDefaultModel: true },
    });
    expect(resolved.backend).toBe('hermes-cli');
    expect(resolved.localCli).toMatchObject({ type: 'hermes', useCliDefaultModel: true });
  });
});
