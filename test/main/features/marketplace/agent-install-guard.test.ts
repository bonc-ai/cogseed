/**
 * 回归：**Hub 已停用的 Agent 不允许新安装**（2026-10-15 实测缺陷）。
 *
 * 缺陷现场：Hub 侧「文本整理助手123」已停用且目录里 `status=disabled` / `disabled=true`
 * 双表达齐全，但客户端市场页三处判据都写成 `kind === 'skill' && ...`，Agent 分支恒为
 * false —— 卡片与可用内容逐像素相同、按钮可点，点下去**真的会装到本机**。
 *
 * 渲染层的回归在 `test/renderer/marketplace-card-states.test.ts`（同一缺陷的界面一半）。
 * 这里钉住安装侧：渲染层可以被绕过（IPC 直调、旧界面、将来的新入口），所以主进程必须
 * 自己判一次，且判据只看 Hub 本次返回的 `status` 字符串。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type CatalogHook = () => { code: number; list: unknown[]; total: number } | Error;

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/util/retry', () => ({
  fetchWithRetry: fetchMock,
  fetchAndReadWithRetry: vi.fn(async () => { throw new Error('package bytes are not part of this fixture'); }),
  serverErrorEnvelopeOf: () => null,
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getVersion: () => '1.2.0', isPackaged: false },
  shell: { openExternal: vi.fn() },
}));

const UID = 'agent-install-guard-user';
const ID = '3c7e2419fc12';

let root: string;
let prevRoot: string | undefined;
let prevApi: string | undefined;
let catalog: CatalogHook;
let api: typeof import('../../../../src/main/features/marketplace');
let paths: typeof import('../../../../src/main/paths');

const jsonResponse = (payload: unknown) => ({ status: 200, text: async () => JSON.stringify(payload) });

/** Hub 目录行：只带能判断停用的字段（不带 artifact ⇒ 走既有 legacy 路径，与本缺陷无关）。 */
const catalogRow = (status: string, disabled: boolean) => ({
  content_id: ID,
  name: '文本整理助手123',
  version: '1.0.0',
  create_uid: '0',
  published_at: 1791590400000,
  status,
  disabled,
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-install-guard-'));
  prevRoot = process.env.COGSEED_WORKSPACE_ROOT;
  prevApi = process.env.COGSEED_API_BASE_URL;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  process.env.COGSEED_API_BASE_URL = 'https://marketplace.test/api';
  vi.resetModules();
  catalog = () => ({ code: 0, total: 1, list: [catalogRow('published', false)] });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_key: string, url: string) => {
    if (url.endsWith('/marketplace/agents/list')) {
      const result = catalog();
      if (result instanceof Error) throw result;
      return jsonResponse(result);
    }
    // 停用拦截之后的一切网络访问都属于"没有被拦下"的证据，这里一律拒绝。
    throw new Error(`unexpected request after the disable guard: ${url}`);
  });
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  api = await import('../../../../src/main/features/marketplace');
  paths = await import('../../../../src/main/paths');
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevRoot;
  if (prevApi === undefined) delete process.env.COGSEED_API_BASE_URL;
  else process.env.COGSEED_API_BASE_URL = prevApi;
  fs.rmSync(root, { recursive: true, force: true });
});

const freshness = { version: '1.0.0', published_at: 1791590400000 };

describe('Hub disabled Agent cannot be newly installed', () => {
  it.each(['disabled', ' DISABLED '])('rejects the install and writes nothing locally (%s)', async (status) => {
    catalog = () => ({ code: 0, total: 1, list: [catalogRow(status, true)] });

    await expect(api.installMarketplaceAgentForUser(UID, ID, freshness))
      .rejects.toMatchObject({ marketplaceReason: 'content_disabled', marketplaceKind: 'agent' });

    // 本地零落盘：没有内容目录，安装清单里也没有这一条。
    expect(fs.existsSync(paths.userMarketplaceAgentDir(UID, ID))).toBe(false);
    const { readInstalls } = await import('../../../../src/main/features/marketplace_installs');
    expect((await readInstalls(UID)).agents).toEqual([]);

    // 而且拦在任何下载之前：除了那一次目录查询，没有任何网络访问（发布物字节都没去取）。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][1])).toContain('/marketplace/agents/list');
  });

  it('the guard reads the Hub row, not a stale local status', async () => {
    // 本机残留一条"上次看到 published"的安装记录：它不能放行新安装（也不能反过来拦）。
    const installs = await import('../../../../src/main/features/marketplace_installs');
    await installs.addAgentInstall(UID, {
      id: ID, version: '0.9.0', published_at: 1, updated_at: 1, installed_at: Date.now(),
      agent_json_url: '', create_uid: '0', status: 'published',
    } as never);
    catalog = () => ({ code: 0, total: 1, list: [catalogRow('disabled', true)] });

    await expect(api.installMarketplaceAgentForUser(UID, ID, freshness))
      .rejects.toMatchObject({ marketplaceReason: 'content_disabled' });
  });

  it('an unknown status does not block: the guard only fires on an explicit disabled row', async () => {
    // Hub 目录里没有这一行（跨通道不可见/查不到，也没有明确的停用事实）⇒ 交给原有路径，
    // 由它按既有方式失败。断言的是"不是被停用判据拦下的"，避免把未知当停用。
    catalog = () => ({ code: 0, total: 0, list: [] });

    const error = await api.installMarketplaceAgentForUser(UID, ID, freshness).then(
      () => null,
      (err: unknown) => err as { marketplaceReason?: string },
    );
    expect(error?.marketplaceReason).not.toBe('content_disabled');
  });

  it('a published Agent still passes the disable guard', async () => {
    // 通过判据 ⇒ 继续走原流程，并在下一步（不在本夹具内）失败；失败原因不是 content_disabled。
    catalog = () => ({ code: 0, total: 1, list: [catalogRow('published', false)] });

    const error = await api.installMarketplaceAgentForUser(UID, ID, freshness).then(
      () => null,
      (err: unknown) => err as { marketplaceReason?: string; message?: string },
    );
    expect(error).not.toBeNull();
    expect(error?.marketplaceReason).not.toBe('content_disabled');
    expect(String(error?.message)).toContain('unexpected request after the disable guard');
  });

  it('a failed catalog lookup does not block installation (unknown ≠ disabled)', async () => {
    catalog = () => new Error('offline');

    const error = await api.installMarketplaceAgentForUser(UID, ID, freshness).then(
      () => null,
      (err: unknown) => err as { marketplaceReason?: string },
    );
    expect(error?.marketplaceReason).not.toBe('content_disabled');
  });
});
