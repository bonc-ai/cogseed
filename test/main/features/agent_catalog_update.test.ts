import { describe, expect, it } from 'vitest';

import {
  decideAgentUpdate, fetchCompleteAgentCatalog, normalizeCatalogAgentRow,
  type CatalogSnapshot,
} from '../../../src/main/features/agent_catalog_update';

const snap = (rows: Array<{ content_id: string; version: string; artifactSha256?: string; status?: string }>, complete = true): CatalogSnapshot =>
  ({ complete, rows: new Map(rows.map((r) => [r.content_id, r])) });
const inst = { id: 'a1', version: '1.0.0', artifactSha256: 'aaa' };

describe('decideAgentUpdate', () => {
  it('版本更高 → 更新', () => {
    expect(decideAgentUpdate(inst, snap([{ content_id: 'a1', version: '1.1.0' }]))).toMatchObject({ action: 'update', reason: 'newer_version' });
  });
  it('同版本摘要不同 → 重新发布，更新', () => {
    expect(decideAgentUpdate(inst, snap([{ content_id: 'a1', version: '1.0.0', artifactSha256: 'bbb' }]))).toMatchObject({ action: 'update', reason: 'republished' });
  });
  it('同版本同摘要 → 不动', () => {
    expect(decideAgentUpdate(inst, snap([{ content_id: 'a1', version: '1.0.0', artifactSha256: 'aaa' }]))).toMatchObject({ action: 'keep', reason: 'up_to_date' });
  });
  it('目录里没有 → 当前不可见，保持，不当作有更新', () => {
    expect(decideAgentUpdate(inst, snap([{ content_id: 'other', version: '9.0.0' }]))).toMatchObject({ action: 'keep', reason: 'not_visible' });
  });
  it('目录没翻完 → 不下结论，即使其中有更高版本', () => {
    expect(decideAgentUpdate(inst, snap([{ content_id: 'a1', version: '2.0.0' }], false))).toMatchObject({ action: 'keep', reason: 'catalog_incomplete' });
  });
  it('停用但版本没变 → 不是新版本', () => {
    expect(decideAgentUpdate(inst, snap([{ content_id: 'a1', version: '1.0.0', artifactSha256: 'aaa', status: 'disabled' }])))
      .toMatchObject({ action: 'keep', reason: 'up_to_date', disabled: true });
  });
  it('停用且有更高版本 → 默认更新并标记 disabled；策略可关', () => {
    const s = snap([{ content_id: 'a1', version: '1.2.0', status: 'disabled' }]);
    expect(decideAgentUpdate(inst, s)).toMatchObject({ action: 'update', disabled: true });
    expect(decideAgentUpdate(inst, s, { allowUpdateWhenDisabled: false }).action).toBe('keep');
  });
  it('目录版本低于本机 → 永不降级', () => {
    expect(decideAgentUpdate({ ...inst, version: '2.0.0' }, snap([{ content_id: 'a1', version: '1.9.0' }]))).toMatchObject({ action: 'keep', reason: 'older_than_installed' });
  });
  it('版本解析不了 → 保持', () => {
    expect(decideAgentUpdate(inst, snap([{ content_id: 'a1', version: 'latest' }]))).toMatchObject({ action: 'keep', reason: 'unparsable_version' });
  });
  it('本机没记摘要 → 只比版本', () => {
    expect(decideAgentUpdate({ id: 'a1', version: '1.0.0' }, snap([{ content_id: 'a1', version: '1.0.0', artifactSha256: 'zzz' }])).action).toBe('keep');
  });
});

describe('normalizeCatalogAgentRow', () => {
  it('取 artifact.sha256 与 status 字符串，不读布尔 disabled', () => {
    expect(normalizeCatalogAgentRow({ content_id: 'a1', version: '1.0.0', artifact: { sha256: 'x' }, status: 'published', disabled: true }))
      .toEqual({ content_id: 'a1', version: '1.0.0', artifactSha256: 'x', status: 'published' });
  });
  it('缺 content_id 或 version → null', () => {
    expect(normalizeCatalogAgentRow({ version: '1.0.0' })).toBeNull();
    expect(normalizeCatalogAgentRow(null)).toBeNull();
  });
});

describe('fetchCompleteAgentCatalog', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ content_id: `c${i}`, version: '1.0.0' }));
  const pager = (all: unknown[]) => async (page: number, size: number) => ({ list: all.slice((page - 1) * size, page * size), total: all.length });

  it('多页翻完，目标在最后一页也能找到', async () => {
    const s = await fetchCompleteAgentCatalog(pager(mk(250)));
    expect(s.complete).toBe(true);
    expect(s.rows.size).toBe(250);
    expect(s.rows.has('c249')).toBe(true);
  });
  it('空目录（total=0）算翻完', async () => {
    expect((await fetchCompleteAgentCatalog(pager([]))).complete).toBe(true);
  });
  it('某页失败 → 不完整', async () => {
    const s = await fetchCompleteAgentCatalog(async (p) => { if (p === 2) throw new Error('x'); return { list: mk(100), total: 250 }; });
    expect(s.complete).toBe(false);
  });
  it('还没凑够 total 就遇到空页 → 不完整', async () => {
    const s = await fetchCompleteAgentCatalog(async (p) => (p === 1 ? { list: mk(100), total: 250 } : { list: [], total: 250 }));
    expect(s.complete).toBe(false);
  });
  it('翻到页数上限 → 不完整', async () => {
    expect((await fetchCompleteAgentCatalog(pager(mk(300)), { size: 100, maxPages: 2 })).complete).toBe(false);
  });
  it('响应形态不对 → 不完整', async () => {
    expect((await fetchCompleteAgentCatalog(async () => ({ list: 'x', total: 1 } as never))).complete).toBe(false);
    expect((await fetchCompleteAgentCatalog(async () => ({ list: [], total: -1 }))).complete).toBe(false);
  });
});
