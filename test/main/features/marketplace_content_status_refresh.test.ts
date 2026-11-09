import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const postJsonMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/features/marketplace', () => ({
  currentAppVersion: () => '1.4.0-test',
  postJson: postJsonMock,
}));

let root = '';
let previousRoot: string | undefined;
let refreshMarketplaceContentStatus: typeof import('../../../src/main/features/marketplace/content-status-refresh').refreshMarketplaceContentStatus;
let resetContentStatusRefreshCacheForTests: typeof import('../../../src/main/features/marketplace/content-status-refresh')._resetContentStatusRefreshCacheForTests;
let readInstalls: typeof import('../../../src/main/features/marketplace_installs').readInstalls;

function writeManifest(data: Record<string, unknown>): void {
  const dir = path.join(root, 'u1', 'cloud', 'marketplace');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'installs.json'), JSON.stringify(data, null, 2));
}

function writeMarker(kind: 'agents' | 'skills', id: string, status: string): string {
  const dir = path.join(root, 'u1', 'local', 'marketplace', kind, id);
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, '_install.json');
  fs.writeFileSync(marker, JSON.stringify({ version: '1.0.0', status }, null, 2));
  return marker;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-content-status-refresh-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  ({
    refreshMarketplaceContentStatus,
    _resetContentStatusRefreshCacheForTests: resetContentStatusRefreshCacheForTests,
  } = await import('../../../src/main/features/marketplace/content-status-refresh'));
  ({ readInstalls } = await import('../../../src/main/features/marketplace_installs'));
  postJsonMock.mockReset();
  resetContentStatusRefreshCacheForTests();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('narrow marketplace content status refresh', () => {
  it('writes a newly disabled Agent status and coalesces repeated execution checks', async () => {
    const marker = writeMarker('agents', 'agent-one', 'published');
    writeManifest({
      version: 1,
      agents: [{ id: 'agent-one', version: '1.0.0', published_at: 1, agent_json_url: 'https://example/agent.json', installed_at: 1, status: 'published' }],
      skills: [],
    });
    postJsonMock.mockResolvedValue({ list: [{ content_id: 'agent-one', status: 'disabled' }] });

    await expect(refreshMarketplaceContentStatus('u1', 'agent', 'agent-one')).resolves.toMatchObject({
      checked: true, installed: true, status: 'disabled', disabled: true,
    });
    await refreshMarketplaceContentStatus('u1', 'agent', 'agent-one');

    expect(postJsonMock).toHaveBeenCalledTimes(1);
    expect(postJsonMock).toHaveBeenCalledWith(
      '/marketplace/agents/list',
      { app_version: '1.4.0-test', page: 1, size: 100, ids: ['agent-one'] },
      { timeoutMs: 4_000, retries: 0 },
    );
    expect(JSON.parse(fs.readFileSync(marker, 'utf8')).status).toBe('disabled');
    expect((await readInstalls('u1')).agents[0].status).toBe('disabled');
  });

  it('restores an installed Skill without changing bytes and skips custom ids', async () => {
    const marker = writeMarker('skills', 'skill-one', 'disabled');
    writeManifest({
      version: 1,
      agents: [],
      skills: [{ id: 'skill-one', version: '1.0.0', published_at: 1, bundle_url: 'https://example/skill.zip', installed_at: 1, status: 'disabled' }],
    });
    postJsonMock.mockResolvedValue({ list: [{ content_id: 'skill-one', status: 'published' }] });

    await expect(refreshMarketplaceContentStatus('u1', 'skill', 'skill-one', { force: true })).resolves.toMatchObject({
      status: 'published', disabled: false,
    });
    await expect(refreshMarketplaceContentStatus('u1', 'agent', 'custom-agent')).resolves.toMatchObject({
      checked: false, installed: false,
    });

    expect(postJsonMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(marker, 'utf8')).status).toBe('published');
    expect((await readInstalls('u1')).skills[0].status).toBe('published');
  });
});
