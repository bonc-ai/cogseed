import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadMarketplace() {
  const users = await import('../../../../src/main/features/users');
  users.activateUser('u_marketplace_agent_list');
  return import('../../../../src/main/features/marketplace');
}

/** B-01 目录行（契约草案样例形状）。合成值。 */
const b01Row = (over: Record<string, unknown> = {}) => ({
  content_id: 'f0e1d2c3b4a5', content_type: 'agent', create_uid: 'u_author', version: '1.0.0', name: '报销预检助手',
  description_zh: '核对', description_en: 'check', category: 'office', avatar: { icon: 'bot', color: 'coral' },
  published_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z', min_app_version: '1.0.0',
  status: 'approved', disabled: false,
  artifact: { download_url: '', sha256: 'a'.repeat(64), size_bytes: 939, format: 'agent-package-v1' },
  skill_refs: [{ content_id: 'a3f09c21b7e4' }], builtin_refs: [{ id: 'builtin:coding' }], bundled_skills: [{ name: 'invoice-ocr' }],
  ...over,
});

describe('marketplace/listMarketplaceAgents（B-01 列表边界归一）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.COGSEED_API_BASE_URL;
  });

  const serve = (list: unknown[], total = list.length) => vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ code: 0, msg: '', list, total }))));

  it('新格式：content_id → id，RFC 3339 → 毫秒，avatar → icon/color，保留 artifact 与引用清单', async () => {
    process.env.COGSEED_API_BASE_URL = 'https://marketplace.test/api';
    serve([b01Row()]);
    const res = await (await loadMarketplace()).listMarketplaceAgents({ page: 1, size: 100 });
    const [a] = res.list as unknown as Array<Record<string, unknown>>;
    expect(a.id).toBe('f0e1d2c3b4a5');
    expect(a.content_id).toBe('f0e1d2c3b4a5');
    expect(a.published_at).toBe(Date.UTC(2026, 9, 13));
    expect(a.icon).toBe('bot');
    expect(a.color).toBe('coral');
    expect(a.artifact).toEqual({ sha256: 'a'.repeat(64), size_bytes: 939, format: 'agent-package-v1' });
    expect(a.builtin_refs).toEqual([{ id: 'builtin:coding' }]);
    expect(res.total).toBe(1);
  });

  it('旧格式的行（只有 id、数值时间、icon/color）原样透传，不被归一化改动', async () => {
    process.env.COGSEED_API_BASE_URL = 'https://marketplace.test/api';
    const legacy = { id: 'abc123def456', name: 'Legacy', version: '1.0.0', published_at: 1700000000000, updated_at: 1700000000000, icon: 'star', color: 'blue', create_uid: '0' };
    serve([legacy]);
    const res = await (await loadMarketplace()).listMarketplaceAgents();
    expect(res.list[0]).toEqual(legacy);
  });

  it('取不到 content_id 的新格式行被丢弃，total 仍是服务端总量', async () => {
    process.env.COGSEED_API_BASE_URL = 'https://marketplace.test/api';
    serve([b01Row({ content_id: '' }), b01Row({ content_id: 'ffffffffffff' })], 7);
    const res = await (await loadMarketplace()).listMarketplaceAgents();
    expect(res.list).toHaveLength(1);
    expect((res.list[0] as unknown as { id: string }).id).toBe('ffffffffffff');
    expect(res.total).toBe(7);
  });

  it('行自带 icon/color 时不被 avatar 覆盖', async () => {
    process.env.COGSEED_API_BASE_URL = 'https://marketplace.test/api';
    serve([b01Row({ icon: 'rocket', color: 'green' })]);
    const [a] = (await (await loadMarketplace()).listMarketplaceAgents()).list as unknown as Array<Record<string, unknown>>;
    expect([a.icon, a.color]).toEqual(['rocket', 'green']);
  });
});
