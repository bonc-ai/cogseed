import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.fn();
const info = vi.fn();
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info, warn, error: vi.fn() }),
}));

/**
 * Hub 待改清单 §5：`/marketplace/defaults` 给新格式 Agent 的 `agent_json_url` 是空串，
 * `agents/detail` 也不出 `agent_json`。默认安装不能再只写一条空 URL 的种子行，
 * 必须走完整安装；依赖判断改读目录行 `skill_refs`。
 */
const UID = 'u_marketplace_defaults_package';
const AGENT = 'pkgagent0001';
const DEP = 'hubskill0001';
const savedBase = process.env.COGSEED_API_BASE_URL;
const savedWs = process.env.COGSEED_WORKSPACE_ROOT;
let tmpDir: string;

const ok = (data: Record<string, unknown>) => new Response(JSON.stringify({ code: 0, msg: '', ...data }), { status: 200 });

const CATALOG_ROW = {
  content_id: AGENT, name: 'PkgAgent', version: '1.0.0',
  published_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z', status: 'published',
  artifact: { sha256: 'a'.repeat(64), size_bytes: 10, format: 'agent-package-v1' },
  skill_refs: [{ content_id: DEP }], builtin_refs: [], bundled_skills: [],
};

/** 按路径应答；`agents/bundle` 默认失败，用来确认走的是完整安装而不是写空行。 */
function stubHub(): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    const p = new URL(url).pathname.replace(/^\/api/, '');
    calls.push(p);
    if (p === '/marketplace/defaults') {
      return ok({ agents: [{ id: AGENT, version: '1.0.0', published_at: 1, updated_at: 1, agent_json_url: '', agent_skills_bundle_url: '', create_uid: '0', status: 'published' }], skills: [] });
    }
    if (p === '/marketplace/agents/list') return ok({ list: [CATALOG_ROW], total: 1 });
    return new Response(JSON.stringify({ code: 500, msg: `boom ${p}` }), { status: 200 });
  }));
  return calls;
}

beforeEach(async () => {
  vi.resetModules();
  warn.mockClear();
  info.mockClear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-defaults-package-'));
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  process.env.COGSEED_API_BASE_URL = 'https://marketplace.test/api';
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedBase === undefined) delete process.env.COGSEED_API_BASE_URL;
  else process.env.COGSEED_API_BASE_URL = savedBase;
  if (savedWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = savedWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('默认安装：新格式 Agent（agent_json_url 为空）', () => {
  it('走完整安装；装不上就不留空内容的种子行，也不再调 agents/detail', async () => {
    const calls = stubHub();
    const mp = await import('../../../../src/main/features/marketplace');
    const installs = await import('../../../../src/main/features/marketplace_installs');
    const result = await mp.ensureDefaultInstalls(UID, { force: true, minIntervalMs: 0 });
    expect(result.seeded_agents).toBe(0);
    expect(calls).not.toContain('/marketplace/agents/detail');
    expect(calls).toContain('/marketplace/agents/list');
    expect((await installs.readInstalls(UID)).agents).toEqual([]);
    expect(warn.mock.calls.some((c) => new RegExp(`skip default agent ${AGENT}; seed failed`).test(String(c[0])))).toBe(true);
  });

  it('目录行 skill_refs 里的依赖被用户卸载过 → 跳过该 Agent，不下载任何东西', async () => {
    const installs = await import('../../../../src/main/features/marketplace_installs');
    await installs.addSkillInstall(UID, { id: DEP, version: '1.0.0', published_at: 1, bundle_url: '', create_uid: '0' });
    await installs.removeSkillInstall(UID, DEP);
    const calls = stubHub();
    const mp = await import('../../../../src/main/features/marketplace');
    const result = await mp.ensureDefaultInstalls(UID, { force: true, minIntervalMs: 0 });
    expect(result.seeded_agents).toBe(0);
    expect(calls).toEqual(['/marketplace/defaults', '/marketplace/agents/list']);
    expect(info.mock.calls.some((c) => new RegExp(`dependency skill ${DEP} was previously uninstalled`).test(String(c[0])))).toBe(true);
  });
});
