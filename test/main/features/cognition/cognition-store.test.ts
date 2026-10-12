import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const storageMocks = vi.hoisted(() => ({
  writeJson: vi.fn(),
  writeTextAtomicSync: vi.fn(),
}));

vi.mock('../../../../src/main/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/storage')>();
  storageMocks.writeJson.mockImplementation(actual.writeJson);
  storageMocks.writeTextAtomicSync.mockImplementation(actual.writeTextAtomicSync);
  return {
    ...actual,
    writeJson: storageMocks.writeJson,
    writeTextAtomicSync: storageMocks.writeTextAtomicSync,
  };
});

import {
  COGNITION_STORE_BYTE_LIMIT,
  MAX_COGNITION_PAGE_SIZE,
  invalidateCognitionMemorySources,
  listActiveCognitionSourceIds,
  listCognitionAssetPage,
  _setSyncDirtyNotifierForTest,
  type CognitionAsset,
} from '../../../../src/main/features/cognition';
import {
  MEMORY_CHAR_LIMIT,
  addEntry as addMemoryEntry,
  ensureCognitionMemoryEntry,
  listEntries as listMemoryEntries,
  memoryContentHash,
} from '../../../../src/main/features/memory';
import { userMemoryFile } from '../../../../src/main/paths';

const uid = 'cognition-store-user';
const workspaceRoot = process.env.COGSEED_WORKSPACE_ROOT as string;
const cognitionFile = path.join(workspaceRoot, uid, 'cloud', 'cognition', 'assets.json');

const FIXTURE_TS = '2026-09-28T10:00:00';

function fixtureEvidence(id: string) {
  return {
    id: `evidence_${id}`,
    kind: 'manual' as const,
    summary: '用户确认这条认知来自可核验证据。',
    sourceLabel: '人工证据',
    createdAt: FIXTURE_TS,
  };
}

/** Pending/seed 资产直写 v3 store——旧写入口已下线，测试不再经 API 构造。 */
function pendingAsset(id: string, title: string, summary: string, withEvidence = false) {
  const evidence = withEvidence ? [fixtureEvidence(id)] : [];
  return {
    id,
    title,
    summary,
    stage: withEvidence ? 'sprout' : 'seed',
    reviewState: 'pending',
    evidence,
    reuseEvents: [],
    transitions: [
      { id: `transition_${id}_created`, kind: 'created', at: FIXTURE_TS },
      ...(withEvidence
        ? [{ id: `transition_${id}_evidence`, kind: 'evidence_added', at: FIXTURE_TS, evidenceId: `evidence_${id}` }]
        : []),
    ],
    createdAt: FIXTURE_TS,
    updatedAt: FIXTURE_TS,
  };
}

/** Confirmed 资产的合法 transitions 尾部（confirmation_requested → confirmed）。 */
function confirmedTail(id: string) {
  return [
    { id: `transition_${id}_request`, kind: 'confirmation_requested', at: FIXTURE_TS },
    { id: `transition_${id}_confirmed`, kind: 'confirmed', at: FIXTURE_TS },
  ];
}

async function seedStore(assets: Array<Record<string, unknown>>): Promise<void> {
  await fs.mkdir(path.dirname(cognitionFile), { recursive: true });
  await fs.mkdir(path.dirname(userMemoryFile(uid)), { recursive: true });
  await fs.writeFile(cognitionFile, JSON.stringify({ version: 3, assets }, null, 2), 'utf8');
}

/** Confirmed 资产 + MEMORY 记录（经 memory 的 sourced-record 机制绑定；合并写入）。 */
async function seedConfirmedCognition(id: string, title: string, summary: string): Promise<string> {
  const ensured = ensureCognitionMemoryEntry(uid, id, summary);
  if (!ensured.ok || !ensured.record) throw new Error(`fixture memory ensure failed: ${ensured.error}`);
  const base = pendingAsset(id, title, summary, true);
  const asset = {
    ...base,
    stage: 'growing',
    reviewState: 'confirmed',
    confirmedAt: FIXTURE_TS,
    memoryBinding: {
      sourceId: id,
      recordId: ensured.record.recordId,
      contentSha256: memoryContentHash(summary),
      activatedAt: FIXTURE_TS,
    },
    transitions: [...base.transitions, ...confirmedTail(id)],
  };
  let existing: Array<Record<string, unknown>> = [];
  try {
    existing = (JSON.parse(await fs.readFile(cognitionFile, 'utf8')) as { assets?: Array<Record<string, unknown>> }).assets || [];
  } catch { /* first seed */ }
  await seedStore([...existing.filter((item) => item.id !== id), asset]);
  return summary;
}

async function readStoreFile(): Promise<CognitionAsset[]> {
  return (JSON.parse(await fs.readFile(cognitionFile, 'utf8')) as { assets: CognitionAsset[] }).assets;
}

/** 经 renderer 的真实读口（分页）触发对账，再以落盘文件为事实断言。 */
async function findStored(id: string): Promise<CognitionAsset> {
  await listCognitionAssetPage(uid);
  const asset = (await readStoreFile()).find((item) => item.id === id);
  if (!asset) throw new Error(`cognition asset not found: ${id}`);
  return asset;
}

beforeEach(async () => {
  const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
    '../../../../src/main/storage',
  );
  storageMocks.writeJson.mockReset();
  storageMocks.writeJson.mockImplementation(actualStorage.writeJson);
  storageMocks.writeTextAtomicSync.mockReset();
  storageMocks.writeTextAtomicSync.mockImplementation(actualStorage.writeTextAtomicSync);
  await fs.rm(path.join(workspaceRoot, uid), { recursive: true, force: true });
});

afterEach(async () => {
  _setSyncDirtyNotifierForTest(null);
  await fs.rm(path.join(workspaceRoot, uid), { recursive: true, force: true });
});

describe('cognition store', () => {
  it('遗留 store 为只读面：种子资产直写后列表可读回', async () => {
    await seedStore([pendingAsset('cog_seed', '复杂任务拆解', '先澄清边界、拆分依赖，再安排执行顺序')]);

    const page = await listCognitionAssetPage(uid);
    expect(page.items[0].stage).toBe('seed');
    expect(page.items[0].reviewState).toBe('pending');
    expect(page.items[0].evidenceCount).toBe(0);
  });

  it('每次云端认知写入都会通知同步引擎', async () => {
    const notifications: Array<{ domain: string; relPath: string }> = [];
    _setSyncDirtyNotifierForTest((domain, relPath) => notifications.push({ domain, relPath }));
    await seedConfirmedCognition('cog_sync', '同步通知', '写入后应唤醒云端同步。');

    await invalidateCognitionMemorySources(uid, ['cog_sync'], 'removed');

    expect(notifications).toEqual([
      { domain: 'cognition', relPath: 'cloud/cognition/assets.json' },
    ]);
  });

  it('返回值与持久化对象解耦，调用方不能绕过互斥锁改内存数据', async () => {
    await seedStore([pendingAsset('cog_clone', '不可外改', '返回值应是安全快照。')]);

    const first = await listCognitionAssetPage(uid);
    first.items[0].title = '外部篡改';

    expect((await findStored('cog_clone')).title).toBe('不可外改');
  });

  it('拒绝状态、阶段和证据矛盾的持久化数据', async () => {
    await seedStore([pendingAsset('cog_stage', '不一致状态', '未确认认知不能伪装为已成长。')]);
    const store = JSON.parse(await fs.readFile(cognitionFile, 'utf8')) as {
      assets: Array<Record<string, unknown>>;
    };
    store.assets[0] = { ...store.assets[0], stage: 'growing' };
    await fs.writeFile(cognitionFile, JSON.stringify(store), 'utf8');

    await expect(listCognitionAssetPage(uid)).rejects.toThrow('inconsistent cognition stage');
  });

  it('拒绝无证据或无确认时间的已确认持久化数据', async () => {
    await seedStore([pendingAsset('cog_fake', '伪确认状态', '只改状态不能绕过人工确认不变量。')]);
    const store = JSON.parse(await fs.readFile(cognitionFile, 'utf8')) as {
      assets: Array<Record<string, unknown>>;
    };
    store.assets[0] = { ...store.assets[0], stage: 'growing', reviewState: 'confirmed' };
    await fs.writeFile(cognitionFile, JSON.stringify(store), 'utf8');

    await expect(listCognitionAssetPage(uid)).rejects.toThrow('needs evidence');
  });

  it('拒绝已暂缓但仍携带待确认意图的矛盾持久化数据', async () => {
    await seedStore([pendingAsset('cog_deferred', '矛盾暂缓状态', '暂缓后不应保留上一次确认意图。', true)]);
    const store = JSON.parse(await fs.readFile(cognitionFile, 'utf8')) as {
      assets: Array<Record<string, unknown>>;
    };
    store.assets[0] = { ...store.assets[0], reviewState: 'deferred', confirmationRequestedAt: '2026-08-03T12:00:00' };
    await fs.writeFile(cognitionFile, JSON.stringify(store), 'utf8');

    await expect(listCognitionAssetPage(uid)).rejects.toThrow('deferred cognition asset has pending confirmation');
  });

  it('拒绝缺失证据或复用覆盖的生命周期事件', async () => {
    await seedStore([pendingAsset('cog_coverage', '不完整轨迹', '证据事件必须与实体一一对应。', true)]);
    const store = JSON.parse(await fs.readFile(cognitionFile, 'utf8')) as {
      assets: Array<{ transitions: Array<Record<string, unknown>> }>;
    };
    store.assets[0].transitions = store.assets[0].transitions
      .filter((transition) => transition.kind !== 'evidence_added');
    await fs.writeFile(cognitionFile, JSON.stringify(store), 'utf8');

    await expect(listCognitionAssetPage(uid)).rejects.toThrow('evidence transition coverage is incomplete');
  });

  it('拒绝时间倒序或创建时间不匹配的生命周期事件', async () => {
    await seedStore([pendingAsset('cog_order', '乱序轨迹', '生命周期时间必须保持非递减顺序。', true)]);
    const store = JSON.parse(await fs.readFile(cognitionFile, 'utf8')) as {
      assets: Array<{ transitions: Array<Record<string, unknown>> }>;
    };
    store.assets[0].transitions[0].at = '2026-08-03T12:00:01';
    await fs.writeFile(cognitionFile, JSON.stringify(store), 'utf8');

    await expect(listCognitionAssetPage(uid)).rejects.toThrow('matching created transition');
  });

  it('迁移 v1 已确认资产时，没有稳定来源 metadata 则保守失效并要求重新确认', async () => {
    const timestamp = '2026-08-03T12:00:00';
    const legacySummary = '旧版已确认认知的正文。';
    const legacyStore = {
      version: 1,
      assets: [{
        id: 'cog_legacy',
        title: '旧版认知',
        summary: legacySummary,
        stage: 'growing',
        reviewState: 'confirmed',
        evidence: [{
          id: 'evidence_legacy',
          kind: 'manual',
          summary: '旧版确认证据。',
          sourceLabel: '旧版存储',
          createdAt: timestamp,
        }],
        reuseEvents: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        confirmedAt: timestamp,
      }],
    };
    await fs.mkdir(path.dirname(cognitionFile), { recursive: true });
    await fs.writeFile(cognitionFile, JSON.stringify(legacyStore), 'utf8');
    await fs.mkdir(path.dirname(userMemoryFile(uid)), { recursive: true });
    await fs.writeFile(userMemoryFile(uid), legacySummary, 'utf8');

    const page = await listCognitionAssetPage(uid);
    const [migrated] = await readStoreFile();

    expect(page.items[0].reviewState).toBe('invalidated');
    expect(migrated.reviewState).toBe('invalidated');
    expect(migrated.stage).toBe('sprout');
    expect(migrated.invalidation?.reason).toBe('metadata_missing');
    expect(migrated.transitions.map((item) => item.kind)).toEqual([
      'created', 'evidence_added', 'confirmed', 'invalidated',
    ]);
    expect(migrated.memoryBinding).toBeUndefined();
    expect(listMemoryEntries(uid, 'memory').entries).toEqual([legacySummary]);
    expect(JSON.parse(await fs.readFile(cognitionFile, 'utf8'))).toMatchObject({
      version: 3,
      assets: [{ reviewState: 'invalidated' }],
    });
  });

  it('读取触发的对账落盘同样通知同步引擎并修复中断的暂缓意图', async () => {
    const notifications: Array<{ domain: string; relPath: string }> = [];
    _setSyncDirtyNotifierForTest((domain, relPath) => notifications.push({ domain, relPath }));
    const base = pendingAsset('cog_interrupted', '中断的暂缓', '读取时必须完成落盘前中断的暂缓。', true);
    const asset = {
      ...base,
      memoryTransition: {
        kind: 'deactivate',
        sourceId: 'cog_interrupted',
        contentSha256: memoryContentHash(base.summary),
        requestedAt: FIXTURE_TS,
      },
      confirmationRequestedAt: FIXTURE_TS,
      transitions: [
        ...base.transitions,
        { id: 'transition_cog_interrupted_defer_request', kind: 'defer_requested', at: FIXTURE_TS },
      ],
    };
    await seedStore([asset]);

    await listCognitionAssetPage(uid);
    const [reconciled] = await readStoreFile();

    expect(reconciled.reviewState).toBe('deferred');
    expect(reconciled.memoryTransition).toBeUndefined();
    expect(notifications).toEqual([
      { domain: 'cognition', relPath: 'cloud/cognition/assets.json' },
    ]);
  });

  it('拒绝会解析到数据根目录之外或共享目录的 UID', async () => {
    await expect(listCognitionAssetPage('.')).rejects.toThrow('invalid cognition user id');
    await expect(listCognitionAssetPage('..')).rejects.toThrow('invalid cognition user id');
    await expect(listCognitionAssetPage('user/name')).rejects.toThrow('invalid cognition user id');
  });

  it('限制用户 ID 长度', async () => {
    await expect(listCognitionAssetPage('u'.repeat(81))).rejects.toThrow('invalid cognition user id');
  });

  it('以 UTF-8 总字节数拒绝超限存储', async () => {
    await fs.mkdir(path.dirname(cognitionFile), { recursive: true });
    await fs.writeFile(cognitionFile, 'x'.repeat(COGNITION_STORE_BYTE_LIMIT + 1), 'utf8');
    await expect(listCognitionAssetPage(uid)).rejects.toThrow('UTF-8 bytes');
  });

  it('按实际缩进后的 JSON 字节数拒绝写入，避免落盘后无法读回', async () => {
    const timestamp = '2026-08-03T12:00:00';
    const assets = Array.from({ length: 500 }, (_, assetIndex) => ({
      id: `cog_${assetIndex}`,
      title: '边界',
      summary: '边界',
      stage: assetIndex === 0 ? 'growing' : 'sprout',
      reviewState: assetIndex === 0 ? 'confirmed' : 'pending',
      evidence: Array.from({ length: 94 }, (_, evidenceIndex) => ({
        id: `ev_${assetIndex}_${evidenceIndex}`,
        kind: 'manual',
        summary: '证据',
        sourceLabel: '来源',
        createdAt: timestamp,
      })),
      ...(assetIndex === 0 ? { confirmedAt: timestamp } : {}),
      reuseEvents: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const compact = JSON.stringify({ version: 1, assets });
    expect(Buffer.byteLength(compact, 'utf8')).toBeLessThan(COGNITION_STORE_BYTE_LIMIT);
    expect(Buffer.byteLength(JSON.stringify({ version: 2, assets }, null, 2), 'utf8'))
      .toBeGreaterThan(COGNITION_STORE_BYTE_LIMIT);
    await fs.mkdir(path.dirname(cognitionFile), { recursive: true });
    await fs.writeFile(cognitionFile, compact, 'utf8');

    await expect(invalidateCognitionMemorySources(uid, ['cog_0'], 'removed')).rejects.toThrow('UTF-8 bytes');
    expect(await fs.readFile(cognitionFile, 'utf8')).toBe(compact);
  });

  it('分页摘要稳定排序并拒绝越界页大小', async () => {
    const first = { ...pendingAsset('cog_page_a', '较早项', '较早项摘要'), updatedAt: '2026-09-01T10:00:00' };
    const second = { ...pendingAsset('cog_page_b', '较新项', '较新项摘要'), updatedAt: '2026-09-02T10:00:00' };
    await seedStore([first, second]);
    const pageOne = await listCognitionAssetPage(uid, 1, 1);
    const pageTwo = await listCognitionAssetPage(uid, 2, 1);

    expect(pageOne).toMatchObject({ page: 1, pageSize: 1, total: 2, totalPages: 2 });
    expect(pageTwo).toMatchObject({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    expect(pageOne.items[0].id).toBe('cog_page_b');
    expect(pageTwo.items[0].id).toBe('cog_page_a');
    expect(pageOne.items[0]).not.toHaveProperty('evidence');
    await expect(listCognitionAssetPage(uid, 1, MAX_COGNITION_PAGE_SIZE + 1)).rejects.toThrow('page size');
    // 下界守卫（r4 补齐）：page<1 / pageSize<1 拒绝而非静默返回空 items。
    // 注意 'invalid cognition page' 是 'invalid cognition page size' 的子串且
    // toThrow 为子串匹配——page 断言必须 /^…$/ 锚定，防两条 throw 分支互串
    // 掩盖回归（删掉 page<1 检查后 page=0 曾静默返回空 items、全测试仍绿）。
    await expect(listCognitionAssetPage(uid, 0, 1)).rejects.toThrow(/^invalid cognition page$/);
    await expect(listCognitionAssetPage(uid, -1, 1)).rejects.toThrow(/^invalid cognition page$/);
    await expect(listCognitionAssetPage(uid, 1, 0)).rejects.toThrow('invalid cognition page size');
  });

  it('两个同文资产共享记忆记录，失效其中一个不会误删另一个', async () => {
    const summary = '同文资产必须以稳定来源 ID 分离所有权。';
    const first = ensureCognitionMemoryEntry(uid, 'cog_shared_a', summary);
    if (!first.ok || !first.record) throw new Error('fixture memory ensure failed');
    const second = ensureCognitionMemoryEntry(uid, 'cog_shared_b', summary);
    if (!second.ok || !second.record) throw new Error('fixture memory ensure failed');
    const confirmed = (id: string, title: string, recordId: string) => {
      const base = pendingAsset(id, title, summary, true);
      return {
        ...base,
        stage: 'growing',
        reviewState: 'confirmed',
        confirmedAt: FIXTURE_TS,
        memoryBinding: { sourceId: id, recordId, contentSha256: memoryContentHash(summary), activatedAt: FIXTURE_TS },
        transitions: [...base.transitions, ...confirmedTail(id)],
      };
    };
    await seedStore([
      confirmed('cog_shared_a', '同文一', first.record.recordId),
      confirmed('cog_shared_b', '同文二', second.record.recordId),
    ]);

    await invalidateCognitionMemorySources(uid, ['cog_shared_a'], 'removed');

    expect(listMemoryEntries(uid, 'memory').entries).toEqual([summary]);
    expect((await findStored('cog_shared_b')).reviewState).toBe('confirmed');
  });

  it('记忆被删除后资产失效', async () => {
    const summary = await seedConfirmedCognition('cog_removed', '删除联动', '长期记忆被删除后必须失效。');
    const memory = await import('../../../../src/main/features/memory');
    const removed = memory.removeEntry(uid, 'memory', summary);
    await invalidateCognitionMemorySources(uid, removed.detachedCognitionSourceIds || [], 'removed');

    expect((await findStored('cog_removed')).reviewState).toBe('invalidated');
  });

  it('替换成已有认知来源正文时拒绝去重，且原文件字节不变', async () => {
    const summary = await seedConfirmedCognition('cog_dedup', '已有认知正文', '这条正文已由认知资产持有。');
    expect(addMemoryEntry(uid, 'memory', '待替换的独立记忆。').ok).toBe(true);
    const memory = await import('../../../../src/main/features/memory');
    const memoryFile = userMemoryFile(uid);
    const before = await fs.readFile(memoryFile);

    expect(memory.replaceEntry(uid, 'memory', '待替换', summary))
      .toMatchObject({ ok: false, error: 'content already exists' });
    expect(await fs.readFile(memoryFile)).toEqual(before);
    expect(listMemoryEntries(uid, 'memory').entries).toEqual([
      summary,
      '待替换的独立记忆。',
    ]);
  });

  it('清空共享记忆后所有已确认认知在返回前失效', async () => {
    await seedConfirmedCognition('cog_clear_a', '清空联动一', '清空时必须失效的第一条认知。');
    await seedConfirmedCognition('cog_clear_b', '清空联动二', '清空时必须失效的第二条认知。');
    const memory = await import('../../../../src/main/features/memory');

    await expect(memory.clearMemoryAndInvalidateCognition(uid, 'memory'))
      .resolves.toMatchObject({ ok: true, entries: [] });

    const assets = await readStoreFile();
    expect(assets).toHaveLength(2);
    expect(assets.every((asset) => asset.reviewState === 'invalidated')).toBe(true);
    expect(assets.every((asset) => asset.invalidation?.reason === 'removed')).toBe(true);
  });

  it.each([
    ['replace', 'replaced'],
    ['remove', 'removed'],
    ['clear', 'removed'],
  ] as const)('认知失效落盘失败时 %s 回滚 MEMORY 原始字节', async (operation, reason) => {
    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    const summary = await seedConfirmedCognition(
      `cog_rollback_${operation}`,
      `回滚-${operation}`,
      `认知失效失败时必须回滚-${operation}。`,
    );
    const memory = await import('../../../../src/main/features/memory');
    const memoryFile = userMemoryFile(uid);
    const before = await fs.readFile(memoryFile);
    storageMocks.writeJson.mockReset();
    storageMocks.writeJson.mockImplementation(async (file, value) => {
      if (String(file) === cognitionFile) throw new Error('simulated cognition invalidation write failure');
      return actualStorage.writeJson(file, value);
    });

    const action = operation === 'replace'
      ? memory.mutateMemoryAndInvalidateCognition(
        uid, 'memory', reason,
        () => memory.replaceEntry(uid, 'memory', summary, '用户新记忆。'),
      )
      : operation === 'remove'
        ? memory.mutateMemoryAndInvalidateCognition(
          uid, 'memory', reason,
          () => memory.removeEntry(uid, 'memory', summary),
        )
        : memory.clearMemoryAndInvalidateCognition(uid, 'memory');

    await expect(action).rejects.toThrow('shared memory was rolled back');
    expect(await fs.readFile(memoryFile)).toEqual(before);

    storageMocks.writeJson.mockReset();
    storageMocks.writeJson.mockImplementation(actualStorage.writeJson);
    expect((await findStored(`cog_rollback_${operation}`)).reviewState).toBe('confirmed');
  });

  it('同用户 MEMORY 写等待认知失效事务回滚，随后成功且不丢数据', async () => {
    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    const summary = await seedConfirmedCognition('cog_lock_a', '并发回滚隔离', '失败事务不得覆盖随后成功的共享记忆写入。');
    const memory = await import('../../../../src/main/features/memory');

    let releaseInvalidation!: () => void;
    const invalidationGate = new Promise<void>((resolve) => { releaseInvalidation = resolve; });
    let invalidationReached!: () => void;
    const reached = new Promise<void>((resolve) => { invalidationReached = resolve; });
    storageMocks.writeJson.mockReset();
    storageMocks.writeJson.mockImplementation(async (file, value) => {
      if (String(file) === cognitionFile) {
        invalidationReached();
        await invalidationGate;
        throw new Error('simulated gated cognition invalidation failure');
      }
      return actualStorage.writeJson(file, value);
    });

    const operationA = memory.removeEntryTransactional(uid, 'memory', summary);
    await reached;
    let operationBSettled = false;
    const operationB = memory.addEntryTransactional(uid, 'memory', '并发成功写入。')
      .finally(() => { operationBSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(operationBSettled).toBe(false);

    releaseInvalidation();
    await expect(operationA).rejects.toThrow('shared memory was rolled back');
    await expect(operationB).resolves.toMatchObject({ ok: true });
    expect(listMemoryEntries(uid, 'memory').entries).toEqual([
      summary,
      '并发成功写入。',
    ]);
  });

  it('同用户清空等待失败事务回滚，旧快照不覆盖清空结果', async () => {
    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    const summary = await seedConfirmedCognition('cog_lock_clear', '清空并发隔离', '并发清空成功后不得被 A 的回滚快照恢复。');
    const memory = await import('../../../../src/main/features/memory');

    let releaseInvalidation!: () => void;
    const invalidationGate = new Promise<void>((resolve) => { releaseInvalidation = resolve; });
    let invalidationReached!: () => void;
    const reached = new Promise<void>((resolve) => { invalidationReached = resolve; });
    let failNextCognitionWrite = true;
    storageMocks.writeJson.mockReset();
    storageMocks.writeJson.mockImplementation(async (file, value) => {
      if (String(file) === cognitionFile && failNextCognitionWrite) {
        failNextCognitionWrite = false;
        invalidationReached();
        await invalidationGate;
        throw new Error('simulated gated cognition invalidation failure');
      }
      return actualStorage.writeJson(file, value);
    });

    const operationA = memory.removeEntryTransactional(uid, 'memory', summary);
    await reached;
    let clearSettled = false;
    const clear = memory.clearMemoryAndInvalidateCognition(uid, 'memory')
      .finally(() => { clearSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(clearSettled).toBe(false);

    releaseInvalidation();
    await expect(operationA).rejects.toThrow('shared memory was rolled back');
    await expect(clear).resolves.toMatchObject({ ok: true, entries: [] });
    expect(listMemoryEntries(uid, 'memory').entries).toEqual([]);
    expect((await findStored('cog_lock_clear')).reviewState).toBe('invalidated');
  });

  it('不同用户的共享记忆事务互不阻塞', async () => {
    const otherUid = 'cognition-other-user';
    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    const summary = await seedConfirmedCognition('cog_lock_user', '按用户隔离锁', '只有同一用户需要串行化。');
    const memory = await import('../../../../src/main/features/memory');

    let releaseInvalidation!: () => void;
    const invalidationGate = new Promise<void>((resolve) => { releaseInvalidation = resolve; });
    let invalidationReached!: () => void;
    const reached = new Promise<void>((resolve) => { invalidationReached = resolve; });
    storageMocks.writeJson.mockReset();
    storageMocks.writeJson.mockImplementation(async (file, value) => {
      if (String(file) === cognitionFile) {
        invalidationReached();
        await invalidationGate;
        throw new Error('simulated gated cognition invalidation failure');
      }
      return actualStorage.writeJson(file, value);
    });

    const blockedUserOperation = memory.removeEntryTransactional(uid, 'memory', summary);
    await reached;
    await expect(memory.addEntryTransactional(otherUid, 'memory', '另一用户立即写入。'))
      .resolves.toMatchObject({ ok: true });
    expect(listMemoryEntries(otherUid, 'memory').entries).toEqual(['另一用户立即写入。']);

    releaseInvalidation();
    await expect(blockedUserOperation).rejects.toThrow('shared memory was rolled back');
  });

  it('失效失败后按原始 Buffer 恢复非法 UTF-8 字节', async () => {
    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    const summary = await seedConfirmedCognition('cog_bytes', '原始字节恢复', '回滚必须保留无法用 UTF-8 表示的磁盘字节。');
    const memory = await import('../../../../src/main/features/memory');
    const memoryFile = userMemoryFile(uid);
    const validBytes = await fs.readFile(memoryFile);
    const originalBytes = Buffer.concat([validBytes, Buffer.from([0xff, 0xfe, 0x80])]);
    await fs.writeFile(memoryFile, originalBytes);
    storageMocks.writeJson.mockReset();
    storageMocks.writeJson.mockImplementation(async (file, value) => {
      if (String(file) === cognitionFile) throw new Error('simulated cognition invalidation write failure');
      return actualStorage.writeJson(file, value);
    });

    await expect(memory.mutateMemoryAndInvalidateCognition(
      uid,
      'memory',
      'removed',
      () => {
        actualStorage.writeTextAtomicSync(memoryFile, 'temporary replacement');
        return {
          ok: true,
          entries: [],
          usage: { current: 0, limit: MEMORY_CHAR_LIMIT },
          detachedCognitionSourceIds: ['cog_bytes'],
        };
      },
    )).rejects.toThrow('shared memory was rolled back');
    expect(await fs.readFile(memoryFile)).toEqual(originalBytes);
  });

  it('认知失效与 MEMORY 回滚同时失败时保留两个错误', async () => {
    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(
      '../../../../src/main/storage',
    );
    const summary = await seedConfirmedCognition('cog_dual_fail', '双重失败错误链', '两个失败原因都必须可审计。');
    const memory = await import('../../../../src/main/features/memory');
    const memoryFile = userMemoryFile(uid);
    storageMocks.writeJson.mockReset();
    storageMocks.writeJson.mockImplementation(async (file, value) => {
      if (String(file) === cognitionFile) throw new Error('primary invalidation failure');
      return actualStorage.writeJson(file, value);
    });
    storageMocks.writeTextAtomicSync.mockReset();
    storageMocks.writeTextAtomicSync.mockImplementation((file, value, encoding) => {
      if (String(file) === memoryFile && Buffer.isBuffer(value)) {
        throw new Error('secondary rollback failure');
      }
      return actualStorage.writeTextAtomicSync(file, value, encoding);
    });

    let thrown: unknown;
    try {
      await memory.removeEntryTransactional(uid, 'memory', summary);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.message).toContain('rollback also failed');
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message).toBe('primary invalidation failure');
    expect((aggregate.errors[1] as Error).message).toBe('secondary rollback failure');
  });

  it('模拟 MEMORY 先落盘后进程崩溃，下次读取会自动失效认知', async () => {
    const summary = await seedConfirmedCognition('cog_crash', '崩溃恢复', '下次读取必须修复跨文件中断。');
    const memory = await import('../../../../src/main/features/memory');

    expect(memory.removeEntry(uid, 'memory', summary)).toMatchObject({ ok: true });

    const reconciled = await findStored('cog_crash');
    expect(reconciled.reviewState).toBe('invalidated');
    expect(reconciled.invalidation?.reason).toBe('metadata_missing');
  });

  it('外部更改正文或损坏 metadata 会使资产失效，机器头不进入模型上下文', async () => {
    const summary = await seedConfirmedCognition('cog_tamper', '外部篡改检测', '这条记忆的完整性需要验证。');
    const memoryFile = userMemoryFile(uid);
    const original = await fs.readFile(memoryFile, 'utf8');
    await fs.writeFile(memoryFile, original.replace(summary, '被外部改动的正文'), 'utf8');

    const invalidated = await findStored('cog_tamper');
    expect(invalidated.reviewState).toBe('invalidated');
    expect(invalidated.invalidation?.reason).toBe('metadata_missing');
    const memory = await import('../../../../src/main/features/memory');
    expect(memory.formatForSystemPrompt(uid)).not.toContain('cogseed-agent-memory:v1');
  });

  it('机器来源记忆只在对应认知仍有效时进入模型上下文', async () => {
    const summary = await seedConfirmedCognition('cog_prompt_gate', '模型来源白名单', '只有有效人工确认来源才可进入模型。');
    const memory = await import('../../../../src/main/features/memory');
    const activeIds = await listActiveCognitionSourceIds(uid);

    expect(activeIds).toContain('cog_prompt_gate');
    // 签名：(uid, agentId?, spaceId?, legacyProjectId?, activeCognitionSourceIds?)
    expect(memory.formatForSystemPrompt(uid, undefined, undefined, undefined, activeIds)).toContain(summary);
    expect(memory.formatForSystemPrompt(uid)).not.toContain(summary);
  });

  it('外部改写为合法旧格式正文时标记 metadata 丢失', async () => {
    const summary = await seedConfirmedCognition('cog_metadata', 'metadata 丢失', '只有稳定来源 metadata 才能证明记忆仍在生效。');
    await fs.writeFile(userMemoryFile(uid), summary, 'utf8');

    const invalidated = await findStored('cog_metadata');
    expect(invalidated.reviewState).toBe('invalidated');
    expect(invalidated.invalidation?.reason).toBe('metadata_missing');
    expect(listMemoryEntries(uid, 'memory').entries).toEqual([summary]);
  });
});
