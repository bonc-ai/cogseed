import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExternalResource } from '../../../src/main/features/personal_context/contract';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pc-scope-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const UID = 'test-user-1';

function resource(overrides: Partial<ExternalResource> = {}): ExternalResource {
  return {
    resourceId: 'feishu:tenant-1:calendar:cal_001',
    resourceType: 'calendar',
    title: '主日历',
    observedAt: '2026-08-01T00:00:00.000Z',
    accessLabel: 'personal',
    retentionPolicy: 'source-linked',
    ...overrides,
  };
}

const rCalendar = resource();
const rDoc = resource({ resourceId: 'feishu:tenant-1:document:doc_001', resourceType: 'document', title: '课程大纲' });
const rChat = resource({ resourceId: 'feishu:tenant-1:chat:oc_001', resourceType: 'chat', title: '课程讨论组' });

async function load() {
  const { ScopeManifestStore } = await import('../../../src/main/features/personal_context/scope-manifest');
  const { PersonalContextRegistry } = await import('../../../src/main/features/personal_context/registry');
  const registry = new PersonalContextRegistry();
  return { ScopeManifestStore, store: new ScopeManifestStore(registry), registry };
}

function manifestPath() {
  return path.join(tmpDir, UID, 'cloud', 'context', 'scope-manifest.json');
}

describe('scope-manifest 落盘与读取', () => {
  it('save 后写入云同步路径 cloud/context/scope-manifest.json', async () => {
    const { store } = await load();
    await store.save(UID, [rCalendar, rDoc]);
    expect(fs.existsSync(manifestPath())).toBe(true);
    const raw = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.entries.map((e: { resourceId: string }) => e.resourceId)).toEqual([
      'feishu:tenant-1:calendar:cal_001',
      'feishu:tenant-1:document:doc_001',
    ]);
    expect(raw.entries[0].resourceType).toBe('calendar');
    expect(raw.entries[0].selectedAt).toBeTruthy();
    expect(raw.updatedAt).toBeTruthy();
  });

  it('未保存时 get 返回空清单', async () => {
    const { store } = await load();
    const manifest = await store.get(UID);
    expect(manifest.entries).toEqual([]);
    expect(await store.has(UID, rCalendar.resourceId)).toBe(false);
  });

  it('get/has 反映已保存的接入范围', async () => {
    const { store } = await load();
    await store.save(UID, [rCalendar]);
    expect(await store.has(UID, rCalendar.resourceId)).toBe(true);
    expect(await store.has(UID, rDoc.resourceId)).toBe(false);
    expect((await store.get(UID)).entries).toHaveLength(1);
  });

  it('脏数据容错：无法解析的 resourceId 条目被过滤', async () => {
    const { store } = await load();
    fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
    fs.writeFileSync(manifestPath(), JSON.stringify({
      version: 1,
      updatedAt: '2026-08-01T00:00:00.000Z',
      entries: [
        { resourceId: 'feishu:tenant-1:calendar:cal_001', resourceType: 'calendar', selectedAt: '2026-08-01T00:00:00.000Z' },
        { resourceId: 'bad-key-without-segments', resourceType: 'calendar', selectedAt: '2026-08-01T00:00:00.000Z' },
        { resourceId: 42, resourceType: 'calendar', selectedAt: '2026-08-01T00:00:00.000Z' },
      ],
    }));
    const manifest = await store.get(UID);
    expect(manifest.entries.map((e) => e.resourceId)).toEqual(['feishu:tenant-1:calendar:cal_001']);
  });
});

describe('scope-manifest 幂等与变更', () => {
  it('相同内容重复 save → changed:false，updatedAt 不变（幂等）', async () => {
    const { store } = await load();
    const first = await store.save(UID, [rCalendar, rDoc]);
    expect(first.changed).toBe(true);

    const second = await store.save(UID, [rCalendar, rDoc]);
    expect(second.changed).toBe(false);
    expect(second.manifest.updatedAt).toBe(first.manifest.updatedAt);
  });

  it('内容变化 → changed:true，整体替换（顺序敏感的全量语义）', async () => {
    const { store } = await load();
    await store.save(UID, [rCalendar, rDoc]);
    const next = await store.save(UID, [rDoc, rCalendar]); // 顺序变化也算变更
    expect(next.changed).toBe(true);
    expect((await store.get(UID)).entries.map((e) => e.resourceId)).toEqual([
      'feishu:tenant-1:document:doc_001',
      'feishu:tenant-1:calendar:cal_001',
    ]);
  });

  it('空数组保存 = 清空接入范围', async () => {
    const { store } = await load();
    await store.save(UID, [rCalendar]);
    const cleared = await store.save(UID, []);
    expect(cleared.changed).toBe(true);
    expect((await store.get(UID)).entries).toEqual([]);
  });
});

describe('scope-manifest 与注册表联动', () => {
  it('save 后注册表选择状态一致：勾选 true、未勾选 false', async () => {
    const { store, registry } = await load();
    // 先登记三个资源（discover 已登记，这里模拟）
    for (const r of [rCalendar, rDoc, rChat]) await registry.upsert(UID, r);

    await store.save(UID, [rCalendar, rDoc]);
    const selected = await registry.list(UID, { selectedOnly: true });
    expect(selected.map((e) => e.resource.resourceId).sort()).toEqual([
      'feishu:tenant-1:calendar:cal_001',
      'feishu:tenant-1:document:doc_001',
    ]);
    const chatEntry = await registry.get(UID, rChat.resourceId);
    expect(chatEntry?.selected).toBe(false);

    // 缩小范围：只留 rCalendar → rDoc 联动取消选择
    await store.save(UID, [rCalendar]);
    const selected2 = await registry.list(UID, { selectedOnly: true });
    expect(selected2.map((e) => e.resource.resourceId)).toEqual(['feishu:tenant-1:calendar:cal_001']);
  });

  it('资源未登记时 save 兜底登记（upsert 幂等）', async () => {
    const { store, registry } = await load();
    await store.save(UID, [rCalendar]);
    const entry = await registry.get(UID, rCalendar.resourceId);
    expect(entry?.resource.title).toBe('主日历');
    expect(entry?.selected).toBe(true);
  });

  it('clear（撤销授权）清空清单但保留注册表资源', async () => {
    const { store, registry } = await load();
    await store.save(UID, [rCalendar]);
    await store.clear(UID);
    expect((await store.get(UID)).entries).toEqual([]);
    const entry = await registry.get(UID, rCalendar.resourceId);
    expect(entry?.resource.title).toBe('主日历');
    expect(entry?.selected).toBe(true); // 失效标记由 revoke 链路负责，clear 只清清单
  });
});
