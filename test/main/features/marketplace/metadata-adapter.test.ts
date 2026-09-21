import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getSkillMetadata,
  normalizeCatalogEntry,
  setMetadataSource,
  toEpochMillis,
  type MetadataSource,
} from '../../../../src/main/features/marketplace/metadata-adapter';

afterEach(() => {
  setMetadataSource(null);
  vi.unstubAllGlobals();
});

/** 一条合成目录记录，字段取自 data-model.md §1。合成值，与真实内容无关。 */
function catalogRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content_id: 'a1b2c3d4e5f6',
    version: '1.2.0',
    create_uid: '0',
    status: 'published',
    min_app_version: '1.2.0',
    category: 'productivity',
    published_at: '2026-09-01T08:30:00Z',
    updated_at: '2026-09-15T12:00:00Z',
    artifact: { sha256: 'f'.repeat(64), size_bytes: 4096, format: 'zip' },
    name: 'synthetic-skill',
    ...over,
  };
}

function sourceOf(rows: Record<string, unknown>[]): MetadataSource {
  const index = new Map(rows.map((r) => [String(r.content_id), r]));
  return { lookup: async (id) => index.get(id) ?? null, invalidate: () => {} };
}

describe('marketplace/metadata-adapter', () => {
  describe('时间归一（FR-007）', () => {
    it('RFC 3339 UTC 转 epoch 毫秒，上层不见时间字符串', () => {
      expect(toEpochMillis('2026-09-01T08:30:00Z')).toBe(Date.UTC(2026, 8, 1, 8, 30, 0));
    });

    it('已是毫秒数值的直接采用（既有客户端兼容形态）', () => {
      expect(toEpochMillis(1_756_715_400_000)).toBe(1_756_715_400_000);
    });

    it('不可解析的时间归为 undefined，不抛错也不产生 NaN', () => {
      expect(toEpochMillis('not-a-date')).toBeUndefined();
      expect(toEpochMillis('')).toBeUndefined();
      expect(toEpochMillis(null)).toBeUndefined();
    });
  });

  describe('字段缺席即语义（FR-005）', () => {
    it('min_app_version 缺席 = 无下限，以空串承载，不是 null', () => {
      const meta = normalizeCatalogEntry(catalogRow({ min_app_version: undefined }));
      expect(meta.min_app_version).toBe('');
      expect(meta.min_app_version).not.toBeNull();
    });

    it('category 缺省 = 未分类', () => {
      expect(normalizeCatalogEntry(catalogRow({ category: undefined })).category).toBe('');
    });

    it('artifact 缺席时给出零值形状，调用方无需判 undefined', () => {
      const meta = normalizeCatalogEntry(catalogRow({ artifact: undefined }));
      expect(meta.artifact).toEqual({ sha256: '', size_bytes: 0, format: '' });
    });

    it('完整性依据是 artifact.sha256，不是树哈希', () => {
      expect(normalizeCatalogEntry(catalogRow()).artifact.sha256).toBe('f'.repeat(64));
    });
  });

  describe('按 content_id 取元信息（FR-001 / FR-002）', () => {
    it('返回统一形状，时间已是毫秒', async () => {
      setMetadataSource(sourceOf([catalogRow()]));

      const meta = await getSkillMetadata('a1b2c3d4e5f6');

      expect(meta).not.toBeNull();
      expect(meta?.content_id).toBe('a1b2c3d4e5f6');
      expect(meta?.version).toBe('1.2.0');
      expect(meta?.create_uid).toBe('0');
      expect(meta?.published_at).toBe(Date.UTC(2026, 8, 1, 8, 30, 0));
      expect(meta?.updated_at).toBe(Date.UTC(2026, 8, 15, 12, 0, 0));
    });

    it('空 content_id 返回 null 而不是去打网络', async () => {
      const lookup = vi.fn();
      setMetadataSource({ lookup, invalidate: () => {} });

      await expect(getSkillMetadata('')).resolves.toBeNull();
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('空结果非错误（FR-003）', () => {
    it('目录里没有该 content_id 时返回 null，不抛错', async () => {
      setMetadataSource(sourceOf([]));
      await expect(getSkillMetadata('missing0000')).resolves.toBeNull();
    });
  });
});
