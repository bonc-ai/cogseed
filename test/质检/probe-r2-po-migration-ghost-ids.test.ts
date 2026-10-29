/**
 * 迁移未结清窗口的身份稳定性与读路径零副作用：
 * 值/字段/条目 id 由内容可复现派生——两次只读 load 同一套 id，UI 持 id
 * 编辑可命中并结清迁移；旧 .history → po-history 的转换只在结清步落盘，
 * 读路径不再写盘。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, emit: () => {}, off: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r2-ghost';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r2-ghost-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function v1Dir(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
}
function poDocFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json');
}
function poHistoryDirOf(groupId: string): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'po-history', groupId);
}

/** v1 现场：1 个组（1 字段 1 值）+ 一版历史快照。 */
function seedV1(): void {
  const dir = v1Dir();
  fs.mkdirSync(path.join(dir, '.history', 'grp001'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'groups.md'), [
    '# 记忆分组', '',
    '### grp001',
    '- 标题: 工作偏好',
    '- 文件: .personal_ontology_groups/grp001.md',
    '- 创建时间: 2026-09-01T10:00:00',
    '- 更新时间: 2026-09-02T10:00:00',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'grp001.md'), [
    '## 字段区', '',
    '### 常用工具',
    '- ZCode [手动] @asof:2026-09',
    '',
    '---', '',
    '## 流水区', '',
    '周五提交周报',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.history', 'grp001', '2026-09-01T10-05-00-000Z-00.md'), [
    '## 字段区', '',
    '### 常用工具',
    '- ZCode [手动]',
    '',
    '---', '',
    '## 流水区', '',
    '旧快照条目',
  ].join('\n'));
}

/** 追加一个孤儿历史目录（台账无行 → v1 已删除分组）。 */
function seedOrphanHistory(): void {
  const dir = v1Dir();
  fs.mkdirSync(path.join(dir, '.history', 'grp002'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.history', 'grp002', '2026-09-03T10-05-00-000Z-00.md'), [
    '## 字段区', '',
    '### 已删字段',
    '- 旧值 [手动]',
    '',
  ].join('\n'));
}

async function loadStore() {
  return import('../../src/main/features/po/store');
}
async function loadApi() {
  return import('../../src/main/features/po/api');
}

function valueIdsOf(doc: { groups: any[] }): string[] {
  return doc.groups[0].values.map((v: any) => v.id);
}

describe('迁移未结清窗口的身份稳定性与读路径零副作用', () => {
  it('两次只读 load 同一套值 id；读路径不写 po-history；持 id 编辑命中并结清', async () => {
    seedV1();
    const store = await loadStore();

    // 第一次读（对应 IPC po.snapshot 首次返回给 UI 的 id 集）。
    const doc1 = store.loadPoDocSync(UID);
    expect(doc1.groups.length).toBe(1);
    expect(doc1.groups[0].id).toBe('grp001'); // 组 id 稳定（台账保留）
    const ids1 = valueIdsOf(doc1);

    // 读路径零副作用：po-history 不被读路径写出（转换挪到结清步）。
    expect(fs.existsSync(poHistoryDirOf('grp001'))).toBe(false);

    // 第二次读（页面刷新 / 下一个 IPC）：同一套 id（可复现派生，非随机）。
    const doc2 = store.loadPoDocSync(UID);
    expect(valueIdsOf(doc2)).toEqual(ids1);

    // UI 拿第一次的 valueId 走编辑（editPoDoc 锁内第三次导入同 id）→ 命中。
    const api = await loadApi();
    const patched = await api.poUpdateValue(UID, 'grp001', ids1[0], { text: '改得动' });
    expect(patched.ok).toBe(true);

    // 编辑成功即迁移结清：JSON 文档落盘；po-history 转换在写路径发生。
    expect(fs.existsSync(poDocFile())).toBe(true);
    const historyJsons = fs.readdirSync(poHistoryDirOf('grp001')).filter((n) => n.endsWith('.json'));
    expect(historyJsons.length).toBeGreaterThanOrEqual(1);
    const persisted = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    expect(persisted.groups[0].values[0].text).toBe('改得动');
    expect(persisted.groups[0].values[0].id).toBe(ids1[0]);

    // 结清后再读：从 JSON 读，id 冻结不变（不再重放导入）。
    expect(valueIdsOf(store.loadPoDocSync(UID))).toEqual(ids1);
  });

  it('孤儿历史复活进回收站：纯解析不落盘，trash 带回最新快照状态', async () => {
    seedV1();
    seedOrphanHistory();
    const store = await loadStore();
    const doc = store.loadPoDocSync(UID);
    expect(doc.trash.length).toBe(1);
    expect(doc.trash[0].group.id).toBe('grp002');
    expect(doc.trash[0].group.values[0].text).toBe('旧值');
    // 复活是读出来的状态，不是写出来的文件：po-history 仍不存在。
    expect(fs.existsSync(poHistoryDirOf('grp002'))).toBe(false);
  });
});
