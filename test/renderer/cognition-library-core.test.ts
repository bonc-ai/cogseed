import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf8');
function setup(handler?: (channel: string, payload: any) => Promise<any>) {
  const invoke = vi.fn(handler || (async (channel: string) => {
    if (channel === 'recall.assets.list') return [];
    if (channel === 'cognition.ontology.snapshot') return { ontology: { records: {} } };
    return { ok: true };
  }));
  const context: any = { window: { cogseed: { invoke }, uiToast: vi.fn() }, setTimeout, clearTimeout, lastConversationCid: 'conv-1' };
  runInNewContext(source, context);
  return { NS: context.window.CogAssets, context, invoke };
}

describe('资产库读取与编辑基准', () => {
  it('读取失败保留已读资产并显式错误，重试成功后清空错误', async () => {
    const { NS, invoke } = setup();
    NS.store.assets = [{ id: 'previous' }];
    invoke.mockImplementation(async channel => {
      if (channel === 'recall.assets.list') throw new Error('disk unavailable');
      if (channel === 'cognition.ontology.snapshot') return { ontology: { records: {} } };
      return { ok: true };
    });
    await NS.loaders.snapshot();
    expect(NS.store.assets).toEqual([{ id: 'previous' }]);
    expect(NS.store.assetsError).toBe('disk unavailable');
    invoke.mockImplementation(async channel => channel === 'recall.assets.list' ? [] : { ok: true });
    await NS.loaders.snapshot();
    expect(NS.store.assets).toEqual([]);
    expect(NS.store.assetsError).toBe('');
  });

  it('失去在用版的编辑提交原草稿基准，冲突时保留文字与范围草稿', async () => {
    const { NS, invoke, context } = setup();
    const fields = { title: '我的修改', statement: '正在编辑且不可被覆盖的内容', applicable: '产品', forbidden: '审查' };
    context.document = { querySelector: () => ({ querySelector: (selector: string) => ({ value: fields[selector.match(/"([^"]+)"/)![1] as keyof typeof fields] }) }) };
    NS.notify = vi.fn();
    NS.store.assets = [{ id: 'asset-1', type: 'rule', status: 'active', version: '8', activeVersion: '6', title: '他处更新', statement: '他处正文' }];
    NS.store.assetCapabilities = { versionedUpdate: true };
    NS.store.assetEditDrafts = { 'asset-1': { baseVersion: '5', baseActiveVersion: '3', scopeSelection: { agentIds: ['agent-1'] } } };
    NS.store.route = { name: 'overview', assetId: 'asset-1', assetEdit: '1' };
    invoke.mockRejectedValueOnce(new Error('ability asset active version conflict'));
    await NS.actions.editAsset('asset-1');
    expect(invoke).toHaveBeenCalledWith('recall.assets.update', expect.objectContaining({ expectedVersion: '5', expectedActiveVersion: '3' }));
    expect(NS.store.assetEditDrafts['asset-1']).toMatchObject({ ...fields, baseVersion: '5', baseActiveVersion: '3', scopeSelection: { agentIds: ['agent-1'] }, saveConflict: true });
    expect(NS.store.assetEditDrafts['asset-1'].saveError).toContain('未覆盖现有内容');
    expect(NS.store.route.assetEdit).toBe('1');
  });
});

describe('资产页会话绑定退役', () => {
  it('版本读取不再缓存旧后端返回的引用统计，原有版本与采用记录仍可读取', async () => {
    const { NS, invoke } = setup(async () => ({ versions: [{ version: '2' }], usage: [{ version: '1', total: 1 }], frozen: [{ version: '1', count: 2 }] }));
    await NS.loadAssetVersions('asset-1');
    expect(invoke).toHaveBeenCalledWith('recall.assets.versions.list', { assetId: 'asset-1' });
    expect(NS.store.assetVersions).toMatchObject({ versions: [{ version: '2' }], usage: [{ version: '1', total: 1 }] });
    expect(NS.store.assetVersions).not.toHaveProperty('frozen');
    expect(NS.store).not.toHaveProperty('libraryConversation');
    expect(NS.loadLibraryConversation).toBeUndefined();
    expect(NS.actions.attachAssetToConversation).toBeUndefined();
    expect(NS.actions.detachLibraryProjection).toBeUndefined();
  });
});
