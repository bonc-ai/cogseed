/**
 * v1.4.0 install regression: Hub requires app_version on every catalog request.
 * Only HTTP and Electron are replaced; installation uses real temporary files,
 * package verification, quality gates and install manifests.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getVersion: () => '1.4.0-rc.1', isPackaged: false },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

const UID = 'install-contract-user';
const AGENT = '3a1fcb1b193f';
const SKILL = '615e8ba7f9d8';
const freshness = { version: '1.0.0', published_at: Date.parse('2026-10-28T00:00:00Z') };
const definition = {
  agent_id: 'author-local-id', name: 'Synthetic assistant', category: 'office',
  description_zh: '合成安装测试', description_en: 'Synthetic installation fixture',
  workflow: 'Summarize the text supplied by the user.', skill_list: [],
};
const skillText = '---\nname: synthetic-summary\ndescription: Summarize supplied text\n---\n\nSummarize the text supplied by the user.\n';
function pack(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}
const agentBytes = pack({
  'agent.json': JSON.stringify(definition),
  '_meta.json': JSON.stringify({ version: '1.0.0', published_at: '2026-10-28T00:00:00Z' }),
});
const skillBytes = pack({ 'SKILL.md': skillText });
function row(id: string, bytes: Buffer, format: string) {
  return {
    content_id: id, ...freshness, name: 'Synthetic fixture', create_uid: '0', status: 'published',
    artifact: { format, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length },
  };
}
const agentRow = row(AGENT, agentBytes, 'agent-package-v1');
const skillRow = row(SKILL, skillBytes, 'skill-tree-v1');
// B-05 returns a display projection, NOT the legacy agent_json envelope.
const displayDetail = {
  content_id: AGENT, content_type: 'agent', version: '1.0.0', name: definition.name,
  workflow: definition.workflow, category: 'office', status: 'published', disabled: false,
  avatar: { icon: 'bot', color: 'blue' }, author: { source: 'official' },
  skill_refs: [], builtin_refs: [], bundled_skills: [], server_check: null,
};
const json = (data: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ code: 0, ...data }), { status });

let root: string;
let api: typeof import('../../../src/main/features/marketplace');
let paths: typeof import('../../../src/main/paths');
let catalogUnavailable: boolean;
let legacy: boolean;
let detailResponse: Record<string, unknown>;
let requests: string[];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-install-contract-'));
  vi.stubEnv('COGSEED_WORKSPACE_ROOT', root);
  vi.stubEnv('COGSEED_API_BASE_URL', 'https://marketplace.test/api');
  vi.resetModules();
  catalogUnavailable = false;
  legacy = false;
  detailResponse = displayDetail;
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = url.pathname.replace(/^\/api/, '');
    requests.push(route);
    const body = JSON.parse(String(init?.body || '{}'));
    if (route.endsWith('/list')) {
      if (catalogUnavailable || body.app_version !== '1.4.0-rc.1') {
        return json({ code: 400, msg: '缺少 app_version：目录请求必须携带当前客户端版本' }, 400);
      }
      const item = route.includes('/agents/') ? agentRow : skillRow;
      return json({ list: legacy ? [{ ...item, artifact: undefined }] : [item], total: 1 });
    }
    if (route === '/marketplace/agents/detail') return json(detailResponse);
    if (route.endsWith('/bundle')) {
      const bytes = route.includes('/agents/') ? agentBytes : skillBytes;
      return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    throw new Error(`Unexpected fixture request: ${route}`);
  }));
  (await import('../../../src/main/features/users')).activateUser(UID);
  api = await import('../../../src/main/features/marketplace');
  paths = await import('../../../src/main/paths');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Hub catalog version contract across display and install', () => {
  it('installs a visible Skill through the version-requiring Hub contract', async () => {
    expect((await api.listMarketplaceSkills()).list[0].id).toBe(SKILL);
    await expect(api.installMarketplaceSkillForUser(UID, SKILL, freshness)).resolves.toMatchObject({ ok: true, id: SKILL });
    expect(fs.readFileSync(path.join(paths.userMarketplaceSkillDir(UID, SKILL), 'SKILL.md'), 'utf8')).toBe(skillText);
    const { readInstalls } = await import('../../../src/main/features/marketplace_installs');
    expect((await readInstalls(UID)).skills).toContainEqual(expect.objectContaining({ id: SKILL, version: '1.0.0' }));
  });

  it('installs a visible Agent from its verified package, not the display projection', async () => {
    expect((await api.listMarketplaceAgents()).list[0].id).toBe(AGENT);
    await expect(api.installMarketplaceAgentForUser(UID, AGENT, freshness)).resolves.toEqual({ ok: true, id: AGENT });
    const dir = paths.userMarketplaceAgentDir(UID, AGENT);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8'))).toEqual({ ...definition, agent_id: AGENT });
    expect(JSON.parse(fs.readFileSync(path.join(dir, '_install.json'), 'utf8'))).toMatchObject({
      package_format: 'agent-package-v1', artifact_sha256: agentRow.artifact.sha256,
    });
    const { readInstalls } = await import('../../../src/main/features/marketplace_installs');
    expect((await readInstalls(UID)).agents).toContainEqual(expect.objectContaining({ id: AGENT, version: '1.0.0' }));
    expect(requests).not.toContain('/marketplace/agents/detail');
  });

  it('loads a new-format Agent detail without misreading it as a legacy cache entry', async () => {
    await expect(api.getAgentDetailForUser(UID, AGENT, freshness)).resolves.toMatchObject({
      id: AGENT, agent_json: { name: definition.name, workflow: definition.workflow },
    });
    expect(fs.existsSync(paths.marketplaceCacheAgentDir(UID, AGENT))).toBe(false);
  });
});

describe('Agent legacy fallback must contain installable data', () => {
  async function expectInvalidDetail(): Promise<void> {
    const { t } = await import('../../../src/main/i18n');
    await expect(api.installMarketplaceAgentForUser(UID, AGENT, freshness)).rejects.toMatchObject({
      code: 'MARKETPLACE_INSTALL_FAILED', marketplaceKind: 'agent',
      marketplaceReason: t('marketplace_install_result.invalid_agent_detail'),
    });
    expect(fs.existsSync(paths.userMarketplaceAgentDir(UID, AGENT))).toBe(false);
    const { readInstalls } = await import('../../../src/main/features/marketplace_installs');
    expect((await readInstalls(UID)).agents).toEqual([]);
  }

  it('rejects a B-05 projection after a failed catalog lookup without creating a cache', async () => {
    catalogUnavailable = true;
    await expectInvalidDetail();
    expect(fs.existsSync(paths.marketplaceCacheAgentDir(UID, AGENT))).toBe(false);
    expect(requests).not.toContain('/marketplace/agents/bundle');
  });

  it.each([
    { label: 'missing', value: undefined }, { label: 'null', value: null },
    { label: 'array', value: [] }, { label: 'string', value: 'not an object' }, { label: 'number', value: 42 },
  ])(
    'rejects invalid legacy agent_json ($label) without destroying an older cache', async ({ value }) => {
      legacy = true;
      detailResponse = { ...freshness, agent_json: value };
      const cache = await import('../../../src/main/features/marketplace_cache');
      await cache.writeAgentCacheForUser(UID, AGENT, definition, { ...freshness, version: '0.9.0' });
      await expectInvalidDetail();
      expect(await cache.readAgentCacheForUser(UID, AGENT)).toEqual(definition);
    },
  );

  it('also validates the refreshed detail when the Agent cache is already fresh', async () => {
    catalogUnavailable = true;
    const cache = await import('../../../src/main/features/marketplace_cache');
    await cache.writeAgentCacheForUser(UID, AGENT, definition, freshness);
    await expectInvalidDetail();
    expect(await cache.readAgentCacheForUser(UID, AGENT)).toEqual(definition);
  });

  it.each([false, true])('keeps valid legacy installs working (fresh cache: %s)', async (cached) => {
    legacy = true;
    detailResponse = {
      ...freshness, agent_json: definition, agent_json_url: 'https://marketplace.test/legacy-agent.json',
      create_uid: '0', status: 'published',
    };
    if (cached) {
      const cache = await import('../../../src/main/features/marketplace_cache');
      await cache.writeAgentCacheForUser(UID, AGENT, definition, freshness);
    }
    await expect(api.installMarketplaceAgentForUser(UID, AGENT, freshness)).resolves.toEqual({ ok: true, id: AGENT });
    expect(JSON.parse(fs.readFileSync(path.join(paths.userMarketplaceAgentDir(UID, AGENT), 'agent.json'), 'utf8'))).toEqual(definition);
  });
});
