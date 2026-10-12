/**
 * 个人本体 v2 · 并发压力测试（2026-09-30 r2，对标 recall/asset-concurrency-stress.test.ts）。
 *
 * po v2 把全部组收进一个 JSON 单源、一把文档级 fileEditLock（store.ts:10 自述），
 * 写路径竞争全部集中在这把锁上——本文件锁定三条并发/交错不变量：
 * ① 并发 editPoDoc 串行化：无丢失更新（每笔都落盘）；
 * ② ensurePoDoc 迁移与首写交错：v1 组不丢、不降格进 trash、备份只一份、marker 只设一次；
 * ③ 业务回调抛错不落盘（首写场景盘上仍无 JSON）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'po-stress-user';

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-po-concurrency-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function poDocFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json');
}
function v1Dir(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
}
function localRoot(): string {
  return path.join(tmpDir, UID, 'local');
}

async function loadApi() {
  return import('../../../../src/main/features/po/api');
}
async function loadGroups() {
  return import('../../../../src/main/features/personal_ontology_groups');
}
async function loadStore() {
  return import('../../../../src/main/features/po/store');
}

/** v1 存量种子：一个活组（带字段值与流水）+ 台账 + 一份历史快照。 */
function seedV1(): void {
  const dir = v1Dir();
  fs.mkdirSync(path.join(dir, '.history', 'grp001'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'groups.md'), [
    '# 记忆分组',
    '',
    '### grp001',
    '- 标题: 工作偏好',
    '- 文件: .personal_ontology_groups/grp001.md',
    '- 创建时间: 2026-09-01T10:00:00',
    '- 更新时间: 2026-09-02T10:00:00',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'grp001.md'), [
    '## 字段区',
    '',
    '### 常用工具',
    '- ZCode [手动] @asof:2026-09',
    '',
    '---',
    '',
    '## 流水区',
    '',
    '周五提交周报',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.history', 'grp001', '2026-09-01T10-05-00-000Z-00.md'), '旧快照\n');
}

describe('并发压力：单 JSON 单锁写路径', () => {
  it('20 笔并发 poAddValue/poAddEntry 串行化：全部成功、无丢失更新、盘上 JSON 完整', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '并发组');
    expect(g.ok).toBe(true);
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '并发字段', {});
    expect(f.ok).toBe(true);

    const writes = [
      ...Array.from({ length: 10 }, (_, i) => api.poAddValue(UID, gid, f.field!.id, { text: `并发值#${i}` })),
      ...Array.from({ length: 10 }, (_, i) => api.poAddEntry(UID, gid, `并发流水#${i}`)),
    ];
    const settled = await Promise.allSettled(writes);
    // 锁内串行 + 每笔锁内重读最新文档：20 笔全部成功（不同文本互不去重）。
    const oks = settled.filter((r) => r.status === 'fulfilled' && (r.value as { ok: boolean }).ok);
    expect(oks.length).toBe(20);

    // 无丢失更新：盘上单源可解析，10 值 + 10 流水一条不少。
    const doc = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    const group = doc.groups.find((x: any) => x.id === gid);
    expect(group).toBeTruthy();
    const texts = group.values.map((v: any) => v.text);
    for (let i = 0; i < 10; i++) expect(texts).toContain(`并发值#${i}`);
    const entries = group.entries.map((e: any) => e.text);
    for (let i = 0; i < 10; i++) expect(entries).toContain(`并发流水#${i}`);
    expect(group.values.length).toBe(10);
    expect(group.entries.length).toBe(10);
  });

  it('ensurePoDoc 迁移与首写交错：v1 组不丢、不进 trash、备份只一份、marker 只设一次', async () => {
    seedV1();
    const store = await loadStore();
    const groups = await loadGroups();

    // 同 tick 并发：读路径迁移持久化 + 业务首写（两者争同一把文档锁）。
    const settled = await Promise.allSettled([
      store.ensurePoDoc(UID),
      groups.createGroup(UID, '并发新组'),
    ]);
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);

    // 盘上单源存在且可解析。
    const doc = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    // v1 迁移组不丢、不降格进 trash（trash 是删除组专用）。
    const migrated = doc.groups.find((g: any) => g.id === 'grp001');
    expect(migrated?.title).toBe('工作偏好');
    expect(doc.trash.some((t: any) => t.group?.id === 'grp001')).toBe(false);
    // 并发首写的新组也在（迁移持久化没有覆盖掉它，或它接在迁移结果之上）。
    expect(doc.groups.some((g: any) => g.title === '并发新组')).toBe(true);
    // marker 已设置（此后读路径不再尝试 v1 导入）。
    expect(doc.migratedFromV1At).toBeTruthy();
    // 备份只一份（锁串行：后到者看到 JSON 已存在，不再走 firstPersist 分支）。
    const backups = fs.readdirSync(localRoot()).filter((n) => n.startsWith('ontology-v1-backup-'));
    expect(backups.length).toBe(1);
  });

  it('editPoDoc 回调抛错：返回 { ok:false, error } 且不落盘（首写场景盘上仍无 JSON）', async () => {
    const store = await loadStore();
    const uid = 'po-stress-throw';
    // 首写场景：JSON 尚不存在，业务回调抛错 → 整个 runExclusive 失败，不得落盘。
    const result = await store.editPoDoc(uid, () => {
      throw new Error('boom');
    });
    expect(result).toEqual({ ok: false, error: 'boom' });
    const firstWrite = path.join(tmpDir, uid, 'cloud', 'cognition', 'personal-ontology.json');
    expect(fs.existsSync(firstWrite)).toBe(false);

    // 已有文档场景：抛错后盘上内容保持不变。
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '稳定组');
    expect(g.ok).toBe(true);
    const before = fs.readFileSync(poDocFile(), 'utf8');
    const result2 = await store.editPoDoc(UID, () => {
      throw new Error('boom2');
    });
    expect(result2).toEqual({ ok: false, error: 'boom2' });
    expect(fs.readFileSync(poDocFile(), 'utf8')).toBe(before);
  });
});
