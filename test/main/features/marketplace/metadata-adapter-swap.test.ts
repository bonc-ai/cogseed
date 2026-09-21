import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getSkillMetadata,
  setMetadataSource,
  type MetadataSource,
  type SkillMetadata,
} from '../../../../src/main/features/marketplace/metadata-adapter';

afterEach(() => {
  setMetadataSource(null);
  vi.unstubAllGlobals();
});

const ROW = {
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
};

/**
 * Q1 = (a)：A-01 全量目录 + 本地索引。
 * 内部先翻页建索引，再按 ID 命中——**多条记录**进来。
 */
function catalogIndexSource(): MetadataSource {
  const index = new Map<string, Record<string, unknown>>([
    ['0000deadbeef', { ...ROW, content_id: '0000deadbeef', name: 'other' }],
    [ROW.content_id, ROW],
    ['ffff00001111', { ...ROW, content_id: 'ffff00001111', name: 'another' }],
  ]);
  return { lookup: async (id) => index.get(id) ?? null, invalidate: () => {} };
}

/**
 * Q1 = (b)：Hub 新增按 ID 的详情接口。
 * 内部**不建索引**，一次只取一条——承载方式与 (a) 完全不同。
 */
function detailEndpointSource(): MetadataSource {
  return {
    lookup: async (id) => (id === ROW.content_id ? { ...ROW } : null),
    invalidate: () => {},
  };
}

/**
 * SC-011 的可执行判据：**同一组断言**，两种内部承载方式下都必须通过，
 * 且**一个字符都不改**。断言写在这里一次，跑两遍。
 */
async function assertAdapterContract(): Promise<void> {
  const meta = (await getSkillMetadata(ROW.content_id)) as SkillMetadata;

  expect(meta).not.toBeNull();
  expect(meta.content_id).toBe('a1b2c3d4e5f6');
  expect(meta.version).toBe('1.2.0');
  expect(meta.create_uid).toBe('0');
  expect(meta.status).toBe('published');
  expect(meta.min_app_version).toBe('1.2.0');
  expect(meta.category).toBe('productivity');
  expect(meta.published_at).toBe(Date.UTC(2026, 8, 1, 8, 30, 0));
  expect(meta.updated_at).toBe(Date.UTC(2026, 8, 15, 12, 0, 0));
  expect(meta.artifact).toEqual({ sha256: 'f'.repeat(64), size_bytes: 4096, format: 'zip' });

  // 空结果在两种承载方式下同样是 null，不是异常。
  await expect(getSkillMetadata('not-in-catalog')).resolves.toBeNull();
}

describe('marketplace/metadata-adapter：Q1 可翻转性（SC-011）', () => {
  it('Q1 = (a) A-01 全量目录 + 本地索引：契约成立', async () => {
    setMetadataSource(catalogIndexSource());
    await assertAdapterContract();
  });

  it('Q1 = (b) Hub 按 ID 的详情接口：同一组断言不改即通过', async () => {
    setMetadataSource(detailEndpointSource());
    await assertAdapterContract();
  });

  it('翻转不改变调用方看到的字段集合：两种承载方式返回的键完全一致', async () => {
    setMetadataSource(catalogIndexSource());
    const fromCatalog = await getSkillMetadata(ROW.content_id);

    setMetadataSource(detailEndpointSource());
    const fromDetail = await getSkillMetadata(ROW.content_id);

    expect(Object.keys(fromDetail ?? {}).sort()).toEqual(Object.keys(fromCatalog ?? {}).sort());
    expect(fromDetail).toEqual(fromCatalog);
  });

  it('调用方只提供 content_id：适配层不向上暴露分页参数或目录总量', async () => {
    const lookup = vi.fn(async (id: string) => (id === ROW.content_id ? { ...ROW } : null));
    setMetadataSource({ lookup, invalidate: () => {} });

    await getSkillMetadata(ROW.content_id);

    expect(lookup).toHaveBeenCalledWith(ROW.content_id);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
