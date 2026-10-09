import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeCatalogListRow } from '../../../../src/main/features/marketplace/metadata-adapter';

/** A-01 目录行（契约 a01-catalog.md 样例形状）。合成值，与真实内容无关。 */
function a01Row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content_id: '8a4f01c29d7e',
    create_uid: '0',
    version: '1.1.0',
    content_type: 'skill',
    name: 'synthetic-skill',
    description_zh: '合成说明',
    description_en: 'Synthetic description',
    category: 'productivity',
    published_at: '2026-09-16T07:30:00Z',
    updated_at: '2026-09-17T09:00:00Z',
    min_app_version: '0.0.5',
    disabled: false,
    status: 'published',
    artifact: {
      download_url: '/marketplace/skills/bundle',
      sha256: 'a'.repeat(64),
      size_bytes: 24576,
      format: 'skill-tree-v1',
    },
    ...over,
  };
}

async function loadMarketplace() {
  const users = await import('../../../../src/main/features/users');
  users.activateUser('u_marketplace_catalog_list');
  return import('../../../../src/main/features/marketplace');
}

describe('marketplace/catalog-list（A-01 列表边界归一）', () => {
  describe('normalizeCatalogListRow', () => {
    it('id 取 content_id，且保留 content_id；时间转为 epoch 毫秒', () => {
      const row = normalizeCatalogListRow(a01Row());
      expect(row?.id).toBe('8a4f01c29d7e');
      expect(row?.content_id).toBe('8a4f01c29d7e');
      expect(row?.published_at).toBe(Date.UTC(2026, 8, 16, 7, 30, 0));
      expect(row?.updated_at).toBe(Date.UTC(2026, 8, 17, 9, 0, 0));
    });

    it('保留归一后的 artifact，完整性依据仍是 sha256 与 size_bytes', () => {
      const row = normalizeCatalogListRow(a01Row());
      expect(row?.artifact).toEqual({ sha256: 'a'.repeat(64), size_bytes: 24576, format: 'skill-tree-v1' });
    });

    it('未下发 artifact 时不凭空生成零值 artifact', () => {
      const row = normalizeCatalogListRow(a01Row({ artifact: undefined }));
      expect(row).not.toHaveProperty('artifact');
    });

    it('旧字段 state / minAppVersion 仍被识别为 status / min_app_version', () => {
      const row = normalizeCatalogListRow(a01Row({
        status: undefined, state: 'disabled', min_app_version: undefined, minAppVersion: '1.2.0',
      }));
      expect(row?.status).toBe('disabled');
      expect(row?.min_app_version).toBe('1.2.0');
    });

    it('旧形态（只有 id、时间为毫秒）照常可用', () => {
      const row = normalizeCatalogListRow({ id: 'legacy-skill', published_at: 1_756_000_000_000, updated_at: 1_756_100_000_000 });
      expect(row?.id).toBe('legacy-skill');
      expect(row?.content_id).toBe('legacy-skill');
      expect(row?.published_at).toBe(1_756_000_000_000);
      expect(row?.updated_at).toBe(1_756_100_000_000);
    });

    it('updated_at 缺席时回退到 published_at，上层比较不遇到 undefined', () => {
      const row = normalizeCatalogListRow(a01Row({ updated_at: undefined }));
      expect(row?.updated_at).toBe(row?.published_at);
    });

    it('取不到 ID 的行与非对象行返回 null', () => {
      expect(normalizeCatalogListRow(a01Row({ content_id: undefined }))).toBeNull();
      expect(normalizeCatalogListRow(null)).toBeNull();
      expect(normalizeCatalogListRow('8a4f01c29d7e')).toBeNull();
      expect(normalizeCatalogListRow([a01Row()])).toBeNull();
    });
  });

  describe('listMarketplaceSkills', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
      delete process.env.COGSEED_API_BASE_URL;
    });

    it('Hub 只按 A-01 返回 content_id 与 RFC 3339 时间时，列表项仍有稳定 id 与毫秒时间', async () => {
      process.env.COGSEED_API_BASE_URL = 'https://marketplace.test/api';
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        code: 0,
        msg: '',
        generated_at: '2026-09-16T08:00:00Z',
        request_id: 'req_01',
        total: 3,
        list: [a01Row(), a01Row({ content_id: undefined, name: 'no-id' }), null],
      }))));

      const marketplace = await loadMarketplace();
      const res = await marketplace.listMarketplaceSkills({ page: 1, size: 100 });

      expect(res.list).toHaveLength(1);
      const [skill] = res.list;
      expect(skill.id).toBe('8a4f01c29d7e');
      expect(skill.content_id).toBe('8a4f01c29d7e');
      expect(typeof skill.published_at).toBe('number');
      expect(typeof skill.updated_at).toBe('number');
      expect(skill.status).toBe('published');
      expect(skill.min_app_version).toBe('0.0.5');
      expect(skill.artifact?.sha256).toBe('a'.repeat(64));
      // total 反映服务端的目录总量，不因本页丢弃无效行而改写。
      expect(res.total).toBe(3);
    });
  });
});
