import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets, renderCognition } from './helpers/cognition-renderer';

const PREVIEW = {
  fingerprints: { user: 'a'.repeat(64), shared: 'b'.repeat(64) },
  sources: {
    user: { status: 'ready', eligibleEntries: 1, eligibleRecords: 2, retainedTemplateRecords: 1, retainedAssetRecords: 0 },
    shared: { status: 'ready', eligibleEntries: 1, eligibleRecords: 1, retainedTemplateRecords: 0, retainedAssetRecords: 1 },
  },
  items: [
    { scope: 'user', contentHash: 'c'.repeat(64), text: '我偏好先看完整原文。\n这一句必须保留。', occurrences: 2 },
    { scope: 'shared', contentHash: 'd'.repeat(64), text: '<脚本>按共享方式工作的规则。', occurrences: 1 },
  ],
};

describe('设置页里的旧记忆归属核对（2026-09-28 两页重整：两区自「待我处理」页尾挪入设置页）', () => {
  it('在真实待办视图显示来源、完整原文、重复数量和默认未选状态', () => {
    const html = renderCognition({ name: 'settings' }, {
      legacyMemoryMigration: {
        preview: PREVIEW,
        loading: false,
        failed: false,
        selectionKeys: [],
        running: false,
        lastRun: null,
      },
    });

    expect(html).toContain('旧记忆归属与迁移');
    expect(html).toContain('个人记忆 · USER.md');
    expect(html).toContain('共享记忆 · MEMORY.md');
    expect(html).toContain('我偏好先看完整原文。\n这一句必须保留。');
    expect(html).toContain('&lt;脚本&gt;按共享方式工作的规则。');
    expect(html).toContain('相同内容 2 条');
    expect(html).toContain('data-act="legacy-memory-toggle"');
    expect(html).toContain('data-act="legacy-memory-run"');
    expect(html).toContain('disabled');
    // 默认未选：设置页还有「自动整理」等开关（aria-checked），断言只看迁移
    // 复选框——uiCheckbox 的 checked 是布尔属性，跟在 type="checkbox" 之后。
    expect(html).not.toMatch(/type="checkbox" checked[^>]*data-act="legacy-memory-toggle"/);
  });

  it('给同一来源下的每个旧记忆复选框独立的可访问名称', () => {
    const html = renderCognition({ name: 'settings' }, {
      legacyMemoryMigration: {
        preview: PREVIEW,
        loading: false,
        failed: false,
        selectionKeys: [],
        running: false,
        lastRun: null,
      },
    });

    expect(html).toContain('aria-label="选择来自 个人记忆 · USER.md 的这条记忆：我偏好先看完整原文。 这一句必须保留。：cccccccc"');
    expect(html).toContain('aria-label="选择来自 共享记忆 · MEMORY.md 的这条记忆：&lt;脚本&gt;按共享方式工作的规则。：dddddddd"');
  });

  it('给同一 Agent 下的不同迁移组独立的可访问名称', () => {
    const scopedPreview = {
      fingerprints: { 'agent:agent-a:canonical': 'a'.repeat(64) },
      sources: [{
        sourceKey: 'agent:agent-a:canonical', kind: 'agent', id: 'agent-a', label: 'commander', status: 'ready',
        eligibleEntries: 2, eligibleRecords: 2, retainedTemplateRecords: 0, retainedAssetRecords: 0,
        retainedNonIndependentRecords: 0, retainedOversizedRecords: 0,
      }],
      items: [
        { kind: 'agent', id: 'agent-a', contentHash: 'e'.repeat(64), sourceKeys: ['agent:agent-a:canonical'], text: '第一条 Agent 记忆。', occurrences: 1, scopePolicy: { agentIds: ['agent-a'] } },
        { kind: 'agent', id: 'agent-a', contentHash: 'f'.repeat(64), sourceKeys: ['agent:agent-a:canonical'], text: '第二条 Agent 记忆。', occurrences: 1, scopePolicy: { agentIds: ['agent-a'] } },
      ],
    };
    const html = renderCognition({ name: 'settings' }, {
      legacyScopedMemoryMigration: {
        preview: scopedPreview,
        loading: false,
        failed: false,
        selectionKeys: [],
        running: false,
        lastRun: null,
      },
    });

    expect(html).toContain('aria-label="迁入这条 Agent 记忆：第一条 Agent 记忆。：eeeeeeee"');
    expect(html).toContain('aria-label="迁入这条 Agent 记忆：第二条 Agent 记忆。：ffffffff"');
  });

  it('进入待办只读预览；迁入前逐项确认，并只提交被选内容及预览指纹', async () => {
    const calls: Array<[string, unknown]> = [];
    const confirms: string[] = [];
    const report = {
      migrated: 2,
      pendingReview: 0,
      failed: 0,
      sourceChangedFiles: 0,
      staleSelections: 0,
      backupFailed: false,
      cleanupFailedFiles: 0,
    };
    const invoke = async (channel: string, payload: any) => {
      calls.push([channel, payload]);
      if (channel === 'recall.memory.migrate' && payload && payload.dryRun) return PREVIEW;
      if (channel === 'recall.memory.migrate') return report;
      return { ok: true };
    };
    const loaded = loadCognitionAssets({ legacyMemoryMigration: null }, { name: 'tree' }, {
      cogseed: { invoke },
      uiConfirmDanger: async ({ message }: { message: string }) => { confirms.push(message); return true; },
      uiAlert: async () => {},
    });

    loaded.ns.router.go({ name: 'review' });
    expect(calls.filter(([channel]) => channel === 'recall.memory.migrate')).toEqual([
      ['recall.memory.migrate', { dryRun: true }],
    ]);
    await vi.waitFor(() => expect(loaded.store.legacyMemoryMigration.preview).toEqual(PREVIEW));

    await loaded.ns.actions.legacyMemoryMigrationToggle('user', 'c'.repeat(64), true);
    expect(loaded.store.legacyMemoryMigration.selectionKeys).toEqual([`user:${'c'.repeat(64)}`]);
    expect(calls.filter(([channel]) => channel === 'recall.memory.migrate')).toHaveLength(1);

    await loaded.ns.actions.legacyMemoryMigrationRun();

    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain('将迁入你勾选的 2 条');
    const migrationCalls = calls.filter(([channel]) => channel === 'recall.memory.migrate');
    expect(migrationCalls).toEqual([
      ['recall.memory.migrate', { dryRun: true }],
      ['recall.memory.migrate', {
        selectedEntries: [{ scope: 'user', contentHash: 'c'.repeat(64) }],
        expectedFingerprints: PREVIEW.fingerprints,
      }],
      ['recall.memory.migrate', { dryRun: true }],
    ]);
    expect(loaded.store.legacyMemoryMigration.lastRun).toEqual(report);
    expect(loaded.store.legacyMemoryMigration.selectionKeys).toEqual([]);
  });


  it('进入设置页真实拉取两区预览（2026-09-28 挪页配套；不靠播种掩盖门控缺口）', async () => {
    const calls: string[] = [];
    const invoke = async (channel: string) => {
      calls.push(channel);
      if (channel === 'recall.memory.migrate') {
        return { fingerprints: PREVIEW.fingerprints, sources: PREVIEW.sources, items: PREVIEW.items };
      }
      return {
        fingerprints: ['agent:agent-a:canonical'],
        sources: [],
        items: [],
      };
    };
    const loaded = loadCognitionAssets({ legacyMemoryMigration: null, legacyScopedMemoryMigration: null }, { name: 'tree' }, {
      cogseed: { invoke },
    });

    loaded.ns.router.go({ name: 'settings' });

    await vi.waitFor(() => {
      expect(loaded.store.legacyMemoryMigration?.preview).toBeTruthy();
      expect(loaded.store.legacyScopedMemoryMigration?.preview).toBeTruthy();
    });
    expect(calls).toContain('recall.memory.migrate');
    expect(calls).toContain('recall.scopedMemoryMigration.preview');
  });

  it('「待我处理」页不再渲染迁移两区（本页零残留）', () => {
    const html = renderCognition({ name: 'review' }, {
      legacyMemoryMigration: {
        preview: PREVIEW, loading: false, failed: false, selectionKeys: [], running: false, lastRun: null,
      },
    });
    expect(html).not.toContain('旧记忆归属与迁移');
    expect(html).not.toContain('data-act="legacy-memory-run"');
  });

  it('does not present an unreadable source as an empty source', () => {
    const html = renderCognition({ name: 'settings' }, {
      legacyMemoryMigration: {
        preview: {
          fingerprints: { user: 'a'.repeat(64), shared: 'b'.repeat(64) },
          sources: {
            user: { status: 'blocked', eligibleEntries: 0, eligibleRecords: 0, retainedTemplateRecords: 0, retainedAssetRecords: 0 },
            shared: { status: 'empty', eligibleEntries: 0, eligibleRecords: 0, retainedTemplateRecords: 0, retainedAssetRecords: 0 },
          },
          items: [],
        },
        loading: false,
        failed: false,
        selectionKeys: [],
        running: false,
      },
    });
    expect(html).toContain('个人记忆 · USER.md 的来源标记损坏');
    expect(html).not.toContain('没有可迁移的未归属条目');
  });

  it('keeps the old file unchanged when the user cancels the final confirmation', async () => {
    const calls: Array<[string, unknown]> = [];
    const invoke = async (channel: string, payload: unknown) => {
      calls.push([channel, payload]);
      return { ok: true };
    };
    const loaded = loadCognitionAssets({
      legacyMemoryMigration: {
        preview: PREVIEW,
        loading: false,
        failed: false,
        selectionKeys: [`user:${'c'.repeat(64)}`],
        running: false,
        lastRun: null,
      },
    }, { name: 'review' }, {
      cogseed: { invoke },
      uiConfirmDanger: async () => false,
      uiAlert: async () => {},
    });

    await loaded.ns.actions.legacyMemoryMigrationRun();

    expect(calls).toEqual([]);
    expect(loaded.store.legacyMemoryMigration.selectionKeys).toEqual([`user:${'c'.repeat(64)}`]);
    expect(loaded.store.legacyMemoryMigration.running).toBe(false);
  });

  it('迁移完成后整区自动隐藏（2026-09-29 子安拍板）：两区都加载完、零待迁、无上次结果 ⇒ 设置页不再渲染「旧记忆迁移」', () => {
    const html = renderCognition({ name: 'settings' }, {
      legacyMemoryMigration: {
        preview: { items: [], sources: { user: { status: 'ready' }, shared: { status: 'ready' } } },
        loading: false, failed: false, selectionKeys: [], running: false, lastRun: null,
      },
      legacyScopedMemoryMigration: {
        preview: { items: [], sources: [] },
        loading: false, failed: false, selectionKeys: [], running: false, lastRun: null,
      },
    });
    expect(html).not.toContain('旧记忆迁移');
    expect(html).not.toContain('legacy-memory-run');
    // 有待迁条目时照常显示（含合并区标题与诚实角标）。
    const withPending = renderCognition({ name: 'settings' }, {
      legacyMemoryMigration: {
        preview: PREVIEW, loading: false, failed: false, selectionKeys: [], running: false, lastRun: null,
      },
      legacyScopedMemoryMigration: {
        preview: { items: [], sources: [] }, loading: false, failed: false, selectionKeys: [], running: false, lastRun: null,
      },
    });
    expect(withPending).toContain('旧记忆迁移');
    expect(withPending).toContain('旧记忆归属与迁移');
  });
});
