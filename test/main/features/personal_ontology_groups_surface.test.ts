import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 个人本体模块不恢复已退役的路径解析和外部渲染通知导出。
 * 仍有效的兼容导出保留，渲染副本由 owning 写路径维护。
 * mock 避免模块加载时引入向量库依赖。 */

let tmpDir: string;
let prevWs: string | undefined;

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));

vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-onto-surface-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('personal_ontology_groups › 导出面', () => {
  it('死导出 resolveGroupContentAbsPathForUser / ontologyDocPathForUser 不得回流', async () => {
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    const surface = Object.keys(groups) as string[];
    expect(surface).not.toContain('resolveGroupContentAbsPathForUser');
    expect(surface).not.toContain('ontologyDocPathForUser');
  });

  it('相邻兼容导出仍在（未被连带误删）', async () => {
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    expect(surfaceHas(groups, 'appendOntologyAudit')).toBe(true);
    expect(surfaceHas(groups, 'readGroupAudit')).toBe(true);
    expect(groups.ENTRY_SEPARATOR).toBeTypeOf('string');
  });

  it('死导出 notifyGroupUpserted / notifyGroupDeleted 不得回流', async () => {
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    const surface = Object.keys(groups) as string[];
    expect(surface).not.toContain('notifyGroupUpserted');
    expect(surface).not.toContain('notifyGroupDeleted');
    // store 侧唯一消费链（po/store.ts）一并删除，防回流：需要外部重刷渲染
    // 副本时走写路径 touch / markRemoved，不要再按 relPath 加回导出口。
    const store = await import('../../../src/main/features/po/store');
    const storeSurface = Object.keys(store) as string[];
    expect(storeSurface).not.toContain('syncRenderForRelPath');
    expect(storeSurface).not.toContain('dropRenderForRelPath');
  });
});

function surfaceHas(mod: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(mod, name);
}
