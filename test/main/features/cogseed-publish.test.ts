import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// cogseed-publish.ts 单测：mock fetch + 本地配置 + seed contexts 文件。
// 覆盖：配置读写、发布（权限透传）、幂等、同步策略、撤销。
import {
  getCogseedShareConfig,
  setCogseedShareConfig,
  publishSpaceToCogseedShare,
  syncCogseedPolicy,
  revokeCogseedShare,
  listCogseedShares,
} from '../../../src/main/features/share/cogseed-publish';
import { userLocalConfigDir, spaceContextsDir } from '../../../src/main/paths';

const UID = 'tester-cogseed';

function clearLocal(): void {
  const base = path.join(userLocalConfigDir(UID), 'personal-context');
  try { fs.rmSync(path.join(base, 'cogseed-share.json'), { force: true }); } catch { /* noop */ }
  try { fs.rmSync(path.join(base, 'cogseed-shares.json'), { force: true }); } catch { /* noop */ }
  try { fs.rmSync(spaceContextsDir(UID, 'sp_c1'), { recursive: true, force: true }); } catch { /* noop */ }
  try { fs.rmSync(spaceContextsDir(UID, 'sp_c2'), { recursive: true, force: true }); } catch { /* noop */ }
}

function seedSpace(spaceId: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(spaceContextsDir(UID, spaceId), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

const MOCK_FETCH = vi.fn();
beforeEach(() => {
  clearLocal();
  MOCK_FETCH.mockReset();
  globalThis.fetch = MOCK_FETCH as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cogseed-publish › config', () => {
  it('未配置返回 null', async () => {
    expect(await getCogseedShareConfig(UID)).toBeNull();
  });
  it('配置后可读（apiKey 不回显之外本地可读）', async () => {
    await setCogseedShareConfig(UID, { baseUrl: 'https://share.cogseed.dev', apiKey: 'CHANGEME_key_abc' });
    const cfg = await getCogseedShareConfig(UID);
    expect(cfg?.baseUrl).toBe('https://share.cogseed.dev');
    expect(cfg?.apiKey).toBe('CHANGEME_key_abc');
  });
  it('清除配置', async () => {
    await setCogseedShareConfig(UID, { baseUrl: 'https://share.cogseed.dev', apiKey: 'CHANGEME_key_abc' });
    await setCogseedShareConfig(UID, null);
    expect(await getCogseedShareConfig(UID)).toBeNull();
  });
});

describe('cogseed-publish › publish', () => {
  it('发布：携带 join_mode/member_permission，返回链接', async () => {
    await setCogseedShareConfig(UID, { baseUrl: 'https://share.cogseed.dev', apiKey: 'CHANGEME_key_abc' });
    seedSpace('sp_c1', { 'doc.md': '# 知识库\n\n测试内容。' });
    MOCK_FETCH.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, shareId: 'ABC12345', url: 'https://share.cogseed.dev/s/ABC12345' }),
    });
    const res = await publishSpaceToCogseedShare(UID, 'sp_c1', {
      name: '测试库', joinMode: 'apply', memberPermission: 'view_only',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state.shareId).toBe('ABC12345');
    expect(res.state.joinMode).toBe('apply');
    expect(res.state.memberPermission).toBe('view_only');
    expect(res.state.url).toContain('/s/ABC12345');
    // 验证请求体含权限字段
    const [, init] = MOCK_FETCH.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.joinMode).toBe('apply');
    expect(body.memberPermission).toBe('view_only');
    expect(body.name).toBe('测试库');
  });

  it('未配置返回 not_configured', async () => {
    seedSpace('sp_c1', { 'doc.md': '内容' });
    const res = await publishSpaceToCogseedShare(UID, 'sp_c1', { name: 'x', joinMode: 'direct', memberPermission: 'view_export' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_configured');
  });

  it('已发布（force=false）幂等返回已有状态', async () => {
    await setCogseedShareConfig(UID, { baseUrl: 'https://share.cogseed.dev', apiKey: 'CHANGEME_key_abc' });
    seedSpace('sp_c1', { 'doc.md': '# 知识库\n\n测试内容。' });
    MOCK_FETCH.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, shareId: 'ABC12345', url: 'https://share.cogseed.dev/s/ABC12345' }),
    });
    await publishSpaceToCogseedShare(UID, 'sp_c1', { name: '测试库', joinMode: 'direct', memberPermission: 'view_export' });
    const calls1 = MOCK_FETCH.mock.calls.length;
    const second = await publishSpaceToCogseedShare(UID, 'sp_c1', { name: '测试库', joinMode: 'direct', memberPermission: 'view_export' });
    expect(second.ok).toBe(true);
    expect(MOCK_FETCH.mock.calls.length).toBe(calls1); // 未重新请求
  });

  it('后端错误透传', async () => {
    await setCogseedShareConfig(UID, { baseUrl: 'https://share.cogseed.dev', apiKey: 'CHANGEME_key_abc' });
    seedSpace('sp_c1', { 'doc.md': '内容' });
    MOCK_FETCH.mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: 'backend down' }) });
    const res = await publishSpaceToCogseedShare(UID, 'sp_c1', { name: 'x', joinMode: 'direct', memberPermission: 'view_export' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('backend_error');
  });
});

describe('cogseed-publish › syncPolicy / revoke / list', () => {
  beforeEach(async () => {
    await setCogseedShareConfig(UID, { baseUrl: 'https://share.cogseed.dev', apiKey: 'CHANGEME_key_abc' });
    seedSpace('sp_c1', { 'doc.md': '# 知识库\n\n测试内容。' });
    MOCK_FETCH.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, shareId: 'ABC12345', url: 'https://share.cogseed.dev/s/ABC12345' }),
    });
    await publishSpaceToCogseedShare(UID, 'sp_c1', { name: '测试库', joinMode: 'direct', memberPermission: 'view_export' });
    MOCK_FETCH.mockReset();
  });

  it('syncPolicy 调用 PATCH /policy 且更新本地状态', async () => {
    MOCK_FETCH.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    const res = await syncCogseedPolicy(UID, 'sp_c1', { joinMode: 'invite', memberPermission: 'hidden' });
    expect(res.ok).toBe(true);
    const [url, init] = MOCK_FETCH.mock.calls[0];
    expect(String(url)).toContain('/policy');
    expect(init?.method).toBe('PATCH');
    const items = await listCogseedShares(UID);
    expect(items[0]?.joinMode).toBe('invite');
    expect(items[0]?.memberPermission).toBe('hidden');
  });

  it('syncPolicy 未发布时静默成功（不调用后端）', async () => {
    const res = await syncCogseedPolicy(UID, 'sp_ghost', { joinMode: 'apply' });
    expect(res.ok).toBe(true);
    expect(MOCK_FETCH).not.toHaveBeenCalled();
  });

  it('revoke 调用 DELETE 并清状态', async () => {
    MOCK_FETCH.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    const res = await revokeCogseedShare(UID, 'sp_c1');
    expect(res.ok).toBe(true);
    const [url, init] = MOCK_FETCH.mock.calls[0];
    expect(String(url)).toContain('/ABC12345');
    expect(init?.method).toBe('DELETE');
    expect(await listCogseedShares(UID)).toEqual([]);
  });
});
