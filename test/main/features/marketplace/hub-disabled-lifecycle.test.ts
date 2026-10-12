/** Behavior regression across catalog observation → install → task admission → final execution. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/util/retry', () => ({
  fetchWithRetry: fetchMock,
  fetchAndReadWithRetry: vi.fn(async () => { throw new Error('bytes must come from the seeded cache in this fixture'); }),
  serverErrorEnvelopeOf: () => null,
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), getVersion: () => '1.2.0', isPackaged: false }, shell: { openExternal: vi.fn() } }));

const UID = 'hub-disabled-lifecycle-user';
const ID = 'a1b2c3d4e5f6';
let root: string;
let prevRoot: string | undefined;
let prevApi: string | undefined;
let status: string;
let publishedAt: number | string;
let api: typeof import('../../../../src/main/features/marketplace');
let paths: typeof import('../../../../src/main/paths');
let tasks: typeof import('../../../../src/main/features/cogseed_backend/task-store');
let components: typeof import('../../../../src/main/features/component_enabled');

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-disabled-lifecycle-'));
  prevRoot = process.env.COGSEED_WORKSPACE_ROOT;
  prevApi = process.env.COGSEED_API_BASE_URL;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  process.env.COGSEED_API_BASE_URL = 'https://marketplace.test/api';
  vi.resetModules();
  status = 'approved';
  publishedAt = 100;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_key: string, url: string) => {
    if (!url.endsWith('/marketplace/skills/list')) throw new Error(`unexpected URL ${url}`);
    return { status: 200, text: async () => JSON.stringify({ code: 0, total: 1, list: [{
      content_id: ID, name: 'lifecycle-fixture', version: '1.0.0', create_uid: '0',
      published_at: publishedAt, status, disabled: status === 'disabled',
      artifact: { sha256: 'a'.repeat(64), size_bytes: 100, format: 'skill-tree-v1' },
    }] }) };
  });
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  api = await import('../../../../src/main/features/marketplace');
  paths = await import('../../../../src/main/paths');
  tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
  components = await import('../../../../src/main/features/component_enabled');
  const cache = await import('../../../../src/main/features/marketplace_cache');
  await cache.writeSkillCache(ID, async (dir) => {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: lifecycle-fixture\ndescription: Synthetic regression skill\n---\n\n# Lifecycle fixture\n');
    fs.writeFileSync(path.join(dir, 'scripts/echo.js'), 'module.exports = async () => ({ ok: true, continued: true });\n');
  }, { version: '1.0.0', published_at: 100 });
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevRoot;
  if (prevApi === undefined) delete process.env.COGSEED_API_BASE_URL;
  else process.env.COGSEED_API_BASE_URL = prevApi;
  fs.rmSync(root, { recursive: true, force: true });
});

async function install() { return api.installMarketplaceSkill(ID, { version: '1.0.0', published_at: 100 }); }
async function create(requestId: string) {
  return (await tasks.createCogSeedTask(UID, { requestId: `req-${requestId}`, task: 'Use synthetic skill', allowedSkillIds: [ID] })).task;
}
async function runTask(task: { allowedSkillIds?: string[]; skillVersionPins?: any[] }) {
  const { createRuntimeToolRunner } = await import('../../../../src/main/features/cogseed_runtime/kernel/tools/runner');
  const { DEFAULT_RUNTIME_TOOL_POLICY } = await import('../../../../src/main/features/cogseed_runtime/kernel/config');
  return createRuntimeToolRunner({
    userId: UID, runtimeSessionId: 'mruntime-disable-regression', allowedRoots: [root], writableRoots: [],
    toolPolicy: { ...DEFAULT_RUNTIME_TOOL_POLICY, skillRun: 'allowlisted_skills' },
    allowedSkillIds: task.allowedSkillIds, skillVersionPins: task.skillVersionPins,
    hostToolClient: { async call() { return { content: JSON.stringify({ approved: true, request_id: 'regression' }) }; } } as never,
  }).run('run_skill', { skill_id: ID, script: 'echo', cwd: root });
}
function marker() {
  return JSON.parse(fs.readFileSync(path.join(paths.userMarketplaceSkillDir(UID, ID), '_install.json'), 'utf8'));
}

describe('Hub disabled Skill lifecycle', () => {
  it('先停用后安装：缓存已存在、过期目录参数和 force 都不能绕过拒绝', async () => {
    status = 'disabled';
    await expect(install()).rejects.toMatchObject({ marketplaceReason: 'content_disabled' });
    await expect(api.installMarketplaceSkill(ID, { version: '1.0.0', published_at: 100 }, { force: true, acceptSecurityRisk: true }))
      .rejects.toMatchObject({ marketplaceReason: 'content_disabled' });
    expect(fs.existsSync(paths.userMarketplaceSkillDir(UID, ID))).toBe(false);
    const { readInstalls } = await import('../../../../src/main/features/marketplace_installs');
    expect((await readInstalls(UID)).skills).toEqual([]);
  });

  it('安装后停用：新的目录状态落到本机、版本和偏好保留，停用后发起新任务在最终入口被拒', async () => {
    await install();
    const existingVersion = marker().version;
    status = 'disabled';
    await api.listMarketplaceSkills();
    expect(marker()).toMatchObject({ status: 'disabled', version: existingVersion });
    expect(components.readDisabledSets(UID).skills.has(ID)).toBe(false);
    const next = await create('new-after-disabled');
    expect(next.allowedSkillIds).toEqual([]);
    const denied = await runTask(next);
    expect(denied).toMatchObject({ isError: true });
    expect(denied.content).toContain('E_RUNTIME_PERMISSION_DENIED');
    // A stale manually retained allowlist, with no admitted pin, cannot bypass the final entry.
    const stale = await runTask({ allowedSkillIds: [ID] });
    expect(stale.content).toContain('E_RUNTIME_SKILL_DISABLED');
    expect(fs.existsSync(path.join(paths.userMarketplaceSkillDir(UID, ID), 'scripts/echo.js'))).toBe(true);
  });

  it('已有任务继续：停用和更新目录后仍执行原任务固定副本', async () => {
    await install();
    const started = await create('started-before-disabled');
    expect(started.skillVersionPins).toHaveLength(1);
    status = 'disabled';
    await api.listMarketplaceSkills();
    fs.writeFileSync(path.join(paths.userMarketplaceSkillDir(UID, ID), 'scripts/echo.js'), 'module.exports = async () => ({ ok: false });');
    const continued = await runTask(started);
    expect(continued.isError).toBeFalsy();
    expect(JSON.parse(continued.content)).toEqual({ ok: true, continued: true });
    const reread = await tasks.readCogSeedTask(UID, started.taskId);
    expect(reread?.allowedSkillIds).toEqual(started.allowedSkillIds);
    expect(reread?.skillVersionPins).toEqual(started.skillVersionPins);
  });

  it.each([true, false])('恢复启用：保留用户原有启停选择（enabled=%s）', async (enabled) => {
    await install();
    components.setSkillEnabled(UID, ID, enabled);
    status = 'disabled';
    await api.listMarketplaceSkills();
    status = 'approved';
    await api.listMarketplaceSkills();
    expect(marker().status).toBe('approved');
    expect(components.readDisabledSets(UID).skills.has(ID)).toBe(!enabled);
    const after = await create(`recovered-${enabled}`);
    expect(after.allowedSkillIds).toEqual(enabled ? [ID] : []);
    const skills = await import('../../../../src/main/features/skills');
    expect((await skills.listSkills()).find((s) => s.id === ID)).toMatchObject({ status: 'approved', enabled });
  });

  it('后台检查识别 A-01 content_id 和 RFC3339；内容版本未变也同步停用/恢复，离线沿用状态', async () => {
    await install();
    publishedAt = '2026-09-16T07:30:00Z';
    status = 'disabled';
    const reconcile = await import('../../../../src/main/features/marketplace_reconcile');
    await reconcile.checkServerUpdatesForInstalls(UID, { force: true });
    expect(marker()).toMatchObject({ status: 'disabled', version: '1.0.0' });
    const marketplace = await import('../../../../src/main/features/marketplace');
    expect((await marketplace.getSkillDetail(ID, { version: '1.0.0' })).status).toBe('disabled');
    expect(marker().status).toBe('disabled');
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await reconcile.checkServerUpdatesForInstalls(UID, { force: true });
    expect(marker().status).toBe('disabled');
    status = 'approved';
    await reconcile.checkServerUpdatesForInstalls(UID, { force: true });
    expect(marker()).toMatchObject({ status: 'approved', version: '1.0.0' });
  });

  it('a rejected reinstall immediately records disable for an existing install, without deleting it', async () => {
    await install();
    status = 'disabled';
    await expect(install()).rejects.toMatchObject({ marketplaceReason: 'content_disabled' });
    expect(marker()).toMatchObject({ status: 'disabled', version: '1.0.0' });
    expect((await create('reinstall-disabled')).allowedSkillIds).toEqual([]);
  });

  it('missing Hub status cannot clear a previously observed disable in detail or installation', async () => {
    await install();
    status = 'disabled';
    await api.listMarketplaceSkills();
    status = '';
    await api.listMarketplaceSkills();
    expect(marker().status).toBe('disabled');
    expect((await api.getSkillDetail(ID, { version: '1.0.0', published_at: 100 })).status).toBe('disabled');
    await expect(install()).rejects.toMatchObject({ marketplaceReason: 'content_disabled' });
    expect(marker().status).toBe('disabled');
  });

  it('cached preview with failed metadata cannot manufacture recovery; fresh installation still fails', async () => {
    status = 'disabled';
    fetchMock.mockRejectedValue(new Error('offline'));
    const detail = await api.getSkillDetail(ID, { version: '1.0.0', published_at: 100 });
    // Unknown status is absent: Renderer keeps its last successful directory observation.
    expect(detail).not.toHaveProperty('status');
    await expect(install()).rejects.toThrow('offline');
    expect(fs.existsSync(paths.userMarketplaceSkillDir(UID, ID))).toBe(false);
  });

  it('planned task begins after disable: admission filters the Skill before freezing its execution context', async () => {
    await install();
    const planned = (await tasks.createCogSeedTask(UID, { requestId: 'req-planned', task: 'Use later', initialStatus: 'planned' })).task;
    status = 'disabled';
    await api.listMarketplaceSkills();
    const admitted = await tasks.admitPlannedCogSeedTask(UID, planned.taskId, {
      task: 'Use later', allowedSkillIds: [ID], runtimeWorkerId: 'cogseed-worker-regression',
    });
    expect(admitted.allowedSkillIds).toEqual([]);
    expect((await runTask(admitted)).isError).toBe(true);
  });
});
