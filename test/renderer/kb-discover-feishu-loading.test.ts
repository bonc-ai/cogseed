import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function loadPageAction() {
  const context: any = {
    module: { exports: {} },
    window: {
      addEventListener() {},
      t(key: string, vars?: Record<string, unknown>) {
        const message = {
          'kb.discover.select_documents': '选择文档',
          'kb.discover.feishu_already_imported_label': '已导入',
          'kb.discover.feishu_import_success_description': '已成功导入 1 篇文档，正在建立知识库索引。',
          'kb.discover.feishu_import_success_stay': '留在发现',
          'kb.discover.feishu_import_success_title': '导入完成',
          'kb.discover.feishu_imported_documents': '已导入文档',
          'kb.discover.feishu_loading_documents': '正在读取文档…',
          'kb.discover.feishu_importing_documents': '正在导入文档…',
          'kb.discover.feishu_sync_documents': '立即同步',
          'kb.discover.feishu_syncing_documents': '正在同步…',
          'kb.discover.feishu_disconnect_title': '断开飞书连接？',
          'kb.discover.feishu_disconnect_description': '保留 {count} 篇文档。',
          'kb.discover.feishu_confirm_disconnect': '确认断开',
          'kb.discover.feishu_remove_title': '移除飞书知识来源？',
          'kb.discover.feishu_remove_description': '删除 {count} 篇文档。',
          'kb.discover.feishu_confirm_remove': '确认移除',
          'kb.discover.public_pending_title': '公共广场待开发',
          'kb.discover.public_pending_detail': '远端目录暂未开放。',
        }[key] || key;
        return message.replace(/\{(\w+)\}/g, (_match: string, name: string) => String(vars?.[name] ?? `{${name}}`));
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/icons.js'), context);
  vm.runInContext(read('src/renderer/modules/ui-button.js'), context);
  vm.runInContext(read('src/renderer/modules/kb-discover.js'), context);
  return context;
}

describe('KB discovery Feishu document action', () => {
  it('opens imported source documents directly in the full source viewer', () => {
    const source = read('src/renderer/modules/kb-discover.js');

    expect(source).toMatch(/function _openSource[\s\S]*?__openAnchorViewer\(\{[\s\S]*?view: 'document'/);
  });

  it('renders the shared button as loading while Wiki documents are being listed', () => {
    const context = loadPageAction();
    const options = context.module.exports._feishuDocumentActionOptions(true, 'list-documents');
    const html = context.window.uiButton(options);

    expect(html).toContain('正在读取文档…');
    expect(html).toContain('is-loading');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled');
  });

  it('restores the selectable state and distinguishes document import progress', () => {
    const context = loadPageAction();
    const idleHtml = context.window.uiButton(context.module.exports._feishuDocumentActionOptions(false, ''));
    const importingHtml = context.window.uiButton(context.module.exports._feishuDocumentActionOptions(true, 'import-documents'));

    expect(idleHtml).toContain('选择文档');
    expect(idleHtml).not.toContain('is-loading');
    expect(idleHtml).not.toContain(' disabled');
    expect(importingHtml).toContain('正在导入文档…');
    expect(importingHtml).toContain('aria-busy="true"');
  });

  it('renders the shared sync button with an explicit loading state', () => {
    const context = loadPageAction();
    const idleHtml = context.window.uiButton(context.module.exports._feishuSyncActionOptions(false, ''));
    const syncingHtml = context.window.uiButton(context.module.exports._feishuSyncActionOptions(true, 'sync-documents'));

    expect(idleHtml).toContain('立即同步');
    expect(idleHtml).toContain('data-discover-action="sync-feishu-documents"');
    expect(syncingHtml).toContain('正在同步…');
    expect(syncingHtml).toContain('is-loading');
    expect(syncingHtml).toContain('disabled');
  });

  it('builds separate confirmation modals for disconnecting and removing the source', () => {
    const context = loadPageAction();
    const disconnect = context.module.exports._feishuDisconnectModalOptions(3);
    const remove = context.module.exports._feishuRemoveModalOptions(3);

    expect(disconnect.title).toBe('断开飞书连接？');
    expect(disconnect.description).toContain('3');
    expect(disconnect.actions).toContainEqual(expect.objectContaining({ id: 'confirm', role: 'danger' }));
    expect(remove.title).toBe('移除飞书知识来源？');
    expect(remove.description).toContain('3');
    expect(remove.actions).toContainEqual(expect.objectContaining({ id: 'confirm', role: 'danger' }));
  });

  it('presents the public plaza as an explicit pending feature', () => {
    const context = loadPageAction();
    const options = context.module.exports._publicPlazaPendingStateOptions();

    expect(options).toEqual({
      icon: 'clock',
      message: '公共广场待开发',
      detail: '远端目录暂未开放。',
    });
  });

  it('refreshes the knowledge workbench after a background Feishu import completes', () => {
    const context = loadPageAction();
    context.window.renderKbWorkbench = vi.fn();

    context.module.exports._refreshKbWorkbenchAfterImport();

    expect(context.window.renderKbWorkbench).toHaveBeenCalledOnce();
  });

  it('marks previously imported documents as disabled choices', () => {
    const context = loadPageAction();
    const imported = context.module.exports._feishuDocumentChoiceOptions({ id: 'doc-1', title: 'SM 的交接', imported: true });
    const available = context.module.exports._feishuDocumentChoiceOptions({ id: 'doc-2', title: '新文档', imported: false });

    expect(context.window.uiButton(imported)).toContain('SM 的交接 · 已导入');
    expect(context.window.uiButton(imported)).toContain('disabled');
    expect(context.window.uiButton(available)).not.toContain(' disabled');
  });

  it('keeps imported Feishu documents visible on the source card', () => {
    const context = loadPageAction();
    const source = context.module.exports._normalizeSourceItem({
      id: 'feishu',
      provider: 'feishu',
      documents: [{ title: 'SM 的交接', path: 'external/feishu-wiki/sm.md', importedAt: '2026-09-04T10:51:49' }],
    });
    const html = context.module.exports._renderFeishuSourceDocuments(source);

    expect(source.documents).toHaveLength(1);
    expect(html).toContain('已导入文档');
    expect(html).toContain('SM 的交接');
    expect(html).toContain('data-discover-path="external/feishu-wiki/sm.md"');
    expect(html).toContain('ui-button');
  });

  it('builds a shared success modal with an explicit knowledge-library action', () => {
    const context = loadPageAction();
    const options = context.module.exports._feishuImportSuccessModalOptions([
      { title: 'SM 的交接', path: 'external/feishu-wiki/sm.md' },
    ], 1);

    expect(options.title).toBe('导入完成');
    expect(options.description).toContain('已成功导入 1 篇文档');
    expect(options.bodyHtml).toContain('SM 的交接');
    expect(options.actions).toContainEqual(expect.objectContaining({ id: 'open-library', role: 'primary' }));
  });
});
