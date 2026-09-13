import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-marketplace-installs-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('marketplace install manifest', () => {
  it('uninstalls the requested user marketplace skill after an active-user switch', async () => {
    const users = await import('../../../src/main/features/users');
    const marketplace = await import('../../../src/main/features/marketplace');
    const installs = await import('../../../src/main/features/marketplace_installs');
    const skillDir = path.join(tmpDir, 'u2', 'local', 'marketplace', 'skills', 'scoped-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: scoped-skill\n---\nbody');
    await installs.addSkillInstall('u2', {
      id: 'scoped-skill', version: '1.0.0', published_at: 1, bundle_url: 'https://cdn.test/s.zip',
    });
    users.activateUser('u1');

    await marketplace.uninstallMarketplaceSkillForUser('u2', 'scoped-skill');

    expect(fs.existsSync(skillDir)).toBe(false);
    expect((await installs.readInstalls('u1')).skills).toHaveLength(1);
    expect((await installs.readInstalls('u2')).skills).toEqual([]);
  });

  it('records uninstall tombstones and clears them on reinstall', async () => {
    const installs = await import('../../../src/main/features/marketplace_installs');

    await installs.addAgentInstall('u1', {
      id: 'agent-a',
      version: '1.0.0',
      published_at: 1,
      agent_json_url: 'https://cdn.test/a.json',
    });

    await expect(installs.removeAgentInstall('u1', 'agent-a')).resolves.toBe(true);
    const removed = await installs.readInstalls('u1');
    expect(removed.agents).toEqual([]);
    expect(removed._deleted_at?.agents?.['agent-a']).toEqual(expect.any(Number));

    await installs.addAgentInstall('u1', {
      id: 'agent-a',
      version: '1.0.0',
      published_at: 1,
      agent_json_url: 'https://cdn.test/a.json',
    });
    const reinstalled = await installs.readInstalls('u1');
    expect(reinstalled.agents).toHaveLength(1);
    expect(reinstalled._deleted_at?.agents?.['agent-a']).toBeUndefined();
  });

  it('prunes uninstall tombstones older than the retention window when reading', async () => {
    const dir = path.join(tmpDir, 'u1', 'cloud', 'marketplace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'installs.json'), JSON.stringify({
      version: 1,
      agents: [],
      skills: [],
      _deleted_at: {
        agents: {
          'agent-old': Date.now() - 31 * 24 * 60 * 60 * 1000,
          'agent-recent': Date.now(),
        },
      },
    }, null, 2), 'utf8');

    const installs = await import('../../../src/main/features/marketplace_installs');
    const manifest = await installs.readInstalls('u1');

    expect(manifest._deleted_at?.agents).toEqual({
      'agent-recent': expect.any(Number),
    });
  });
});
