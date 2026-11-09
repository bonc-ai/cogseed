/** 读缓存的失效正确性：同进程写（epoch）、外部进程写（mtime/size）、坏档→修复、
 * 多用户隔离、validate-once 的对象身份语义、共享快照冻结，以及共享对象在
 * updater 边界的隔离。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string;
let previousRoot: string | undefined;
const userId = 'store-cache-user';
const otherUserId = 'store-cache-other';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-store-cache-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedOntology(uid: string, name: string) {
  const { commitOntologyCommand } = await import('../../../../src/main/features/cognition/ontology/service');
  await commitOntologyCommand(uid, {
    commandId: `cache-seed-${name}`, expectedRevision: 0,
    actions: [{ intent: 'create', recordId: `mod-${name}`, record: { kind: 'module', name, description: '', scope: { kind: 'personal' } }, sourceLabel: '缓存测试' }],
  });
}

describe('cognition store read cache', () => {
  it('same-process writes invalidate immediately and reads see the new version', async () => {
    await seedOntology(userId, 'one');
    const store = await import('../../../../src/main/features/cognition_kernel/store');
    const service = await import('../../../../src/main/features/cognition/ontology/service');
    const first = store.loadCognitionStoreSync(userId);
    const revisionBefore = service.readOntologyDocument(userId).revision;
    expect(service.readOntologyDocument(userId)).toBe(service.readOntologyDocument(userId));
    await store.applyCognitionDeltas(userId, { kind: 'ontology', command: {
      commandId: 'cache-second', expectedRevision: 1,
      actions: [{ intent: 'create', recordId: 'mod-2', record: { kind: 'module', name: '二号', description: '', scope: { kind: 'personal' } }, sourceLabel: '缓存测试' }],
    } });
    const after = store.loadCognitionStoreSync(userId);
    expect(after).not.toBe(first);
    expect(service.readOntologyDocument(userId).revision).toBe(revisionBefore + 1);
    expect(service.readOntologyDocument(userId).records['mod-2']).toBeTruthy();
  });

  it('out-of-process rewrites (mtime/size change) invalidate the cached document', async () => {
    await seedOntology(userId, 'one');
    const store = await import('../../../../src/main/features/cognition_kernel/store');
    const filePath = store.cognitionStorePath(userId);
    const cached = store.loadCognitionStoreSync(userId);
    // Simulate another process swapping in a different but internally
    // consistent document: hand-added records fail records↔history validation,
    // so reuse a document produced by the real command path under another uid.
    await seedOntology(otherUserId, 'other');
    const replacement = JSON.parse(fs.readFileSync(store.cognitionStorePath(otherUserId), 'utf8'));
    replacement.ontology.ownerId = userId;
    fs.writeFileSync(filePath, JSON.stringify(replacement, null, 2));
    const reloaded = store.loadCognitionStoreSync(userId);
    expect(reloaded).not.toBe(cached);
    expect(reloaded.ontology?.records['mod-other']).toBeTruthy();
    expect(reloaded.ontology?.records['mod-one']).toBeUndefined();
    expect(store.loadCognitionStoreSync(userId)).toBe(reloaded);
  });

  it('corrupt files are never cached and a repaired file reloads cleanly', async () => {
    await seedOntology(userId, 'one');
    const store = await import('../../../../src/main/features/cognition_kernel/store');
    const filePath = store.cognitionStorePath(userId);
    const good = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, 'not a json store');
    expect(store.loadCognitionStoreSync(userId).ontology).toBeUndefined();
    expect(store.loadCognitionStoreSync(userId).ontology).toBeUndefined();
    fs.writeFileSync(filePath, good);
    expect(store.loadCognitionStoreSync(userId).ontology?.records['mod-one']).toBeTruthy();
  });

  it('caches stay isolated per user', async () => {
    await seedOntology(userId, 'one');
    await seedOntology(otherUserId, 'other');
    const store = await import('../../../../src/main/features/cognition_kernel/store');
    const mine = store.loadCognitionStoreSync(userId);
    const theirs = store.loadCognitionStoreSync(otherUserId);
    expect(mine.ontology?.records['mod-one']).toBeTruthy();
    expect(mine.ontology?.records['mod-other']).toBeUndefined();
    expect(theirs.ontology?.records['mod-other']).toBeTruthy();
    expect(theirs.ontology?.records['mod-one']).toBeUndefined();
  });

  it('invalidates through the write epoch when stat still reports the old version', async () => {
    await seedOntology(userId, 'one');
    const store = await import('../../../../src/main/features/cognition_kernel/store');
    const filePath = store.cognitionStorePath(userId);
    const cached = store.loadCognitionStoreSync(userId);
    expect(cached.ontology?.records['mod-one']).toBeTruthy();
    const before = fs.statSync(filePath);
    await store.applyCognitionDeltas(userId, { kind: 'document', edit: doc => { doc.ontology = undefined; } });
    // The rewrite changed the file; pretend the old stat is still current. Only
    // the in-process write epoch can tell this reader that the cache is stale.
    const realStatSync = fs.statSync;
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(((target: string) =>
      String(target) === filePath ? before : realStatSync(target)) as typeof fs.statSync);
    try {
      const reloaded = store.loadCognitionStoreSync(userId);
      expect(reloaded).not.toBe(cached);
      expect(reloaded.ontology).toBeUndefined();
      expect(cached.ontology?.records['mod-one']).toBeTruthy();
    } finally {
      statSpy.mockRestore();
    }
  });

  it('reloads after the store file is deleted and recreated', async () => {
    await seedOntology(userId, 'one');
    const store = await import('../../../../src/main/features/cognition_kernel/store');
    const filePath = store.cognitionStorePath(userId);
    expect(store.loadCognitionStoreSync(userId).ontology?.records['mod-one']).toBeTruthy();
    fs.rmSync(filePath);
    expect(store.loadCognitionStoreSync(userId).ontology).toBeUndefined();
    await seedOntology(userId, 'reborn');
    const reborn = store.loadCognitionStoreSync(userId);
    expect(reborn.ontology?.records['mod-one']).toBeUndefined();
    expect(reborn.ontology?.records['mod-reborn']).toBeTruthy();
  });

  it('hands updaters a private record so a failed edit cannot pollute the store cache', async () => {
    const at = new Date().toISOString();
    const asset = {
      schemaVersion: 2, ownerId: userId, id: 'aa-source', candidateId: 'candidate-source',
      reviewDecisionId: 'rd_12345678', type: 'cognition', contentCategory: 'rule', title: '合成来源',
      statement: '合成规则正文', evidenceRefs: [{ kind: 'conversation', id: 'synthetic-source', taxonomyVersion: 2, subtype: 'session', scope: 'conversation' }],
      scope: 'general', status: 'active', lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
      createdAt: at, updatedAt: at,
    };
    const bridge = await import('../../../../src/main/features/cognition_bridge');
    await bridge.replaceCognitionSources(userId, {
      mode: 'unified', revision: 1,
      records: { 'ability-assets': { [asset.id]: asset }, candidates: {} },
      po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: at,
    });
    const store = await import('../../../../src/main/features/cognition_kernel/store');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const cached = store.loadCognitionStoreSync(userId);
    const shared = cached.compatibility!.records['ability-assets'][asset.id];
    expect(shared?.title).toBe('合成来源');
    await expect(recallStore.updateRecallJsonRecord(userId, 'ability-assets', asset.id, (current) => {
      expect(current).not.toBe(shared);
      if (!current) throw new Error('missing record');
      current.title = '被篡改';
      throw new Error('stop');
    })).rejects.toThrow('stop');
    expect(store.loadCognitionStoreSync(userId)).toBe(cached);
    expect(cached.compatibility!.records['ability-assets'][asset.id]?.title).toBe('合成来源');
  });

  it('clears cached documents explicitly and can be called repeatedly', async () => {
    await seedOntology(userId, 'one');
    const store = await import('../../../../src/main/features/cognition_kernel/store');
    const first = store.loadCognitionStoreSync(userId);
    store.clearCognitionStoreReadCache();
    store.clearCognitionStoreReadCache();
    const second = store.loadCognitionStoreSync(userId);
    expect(second).not.toBe(first);
    expect(second.ontology?.records['mod-one']).toBeTruthy();
  });

  it('still rejects an ontology that fails normalization', async () => {
    await seedOntology(userId, 'one');
    const store = await import('../../../../src/main/features/cognition_kernel/store');
    const service = await import('../../../../src/main/features/cognition/ontology/service');
    const filePath = store.cognitionStorePath(userId);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    raw.ontology = {};
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
    expect(() => service.readOntologyDocument(userId)).toThrow(/store_corrupt|unreadable/);
  });

  it('freezes the shared snapshot so in-place edits fail loudly', async () => {
    await seedOntology(userId, 'one');
    const store = await import('../../../../src/main/features/cognition_kernel/store');
    const service = await import('../../../../src/main/features/cognition/ontology/service');
    const cached = store.loadCognitionStoreSync(userId);
    expect(Object.isFrozen(cached)).toBe(true);
    expect(() => { (cached as unknown as Record<string, unknown>).ontology = undefined; }).toThrow();
    const shared = service.readOntologyDocument(userId) as unknown as Record<string, unknown>;
    expect(() => { shared.records = {}; }).toThrow();
    expect(service.readOntologyDocument(userId).records['mod-one']).toBeTruthy();
  });

  it('serves frozen unified records while updater drafts stay mutable', async () => {
    const at = new Date().toISOString();
    const asset = {
      schemaVersion: 2, ownerId: userId, id: 'aa-frozen', candidateId: 'candidate-frozen',
      reviewDecisionId: 'rd_12345678', type: 'cognition', contentCategory: 'rule', title: '冻结来源',
      statement: '合成规则正文', evidenceRefs: [{ kind: 'conversation', id: 'synthetic-frozen', taxonomyVersion: 2, subtype: 'session', scope: 'conversation' }],
      scope: 'general', status: 'active', lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
      createdAt: at, updatedAt: at,
    };
    const bridge = await import('../../../../src/main/features/cognition_bridge');
    await bridge.replaceCognitionSources(userId, {
      mode: 'unified', revision: 1,
      records: { 'ability-assets': { [asset.id]: asset }, candidates: {} },
      po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: at,
    });
    const store = await import('../../../../src/main/features/cognition_kernel/store');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const shared = await recallStore.readRecallJsonRecord(userId, 'ability-assets', asset.id);
    expect(() => { (shared as unknown as Record<string, unknown>).title = '被篡改'; }).toThrow();
    // updater 边界拿到的是解冻私有稿，正常修改且不落盘（沿用 stop 中断语义验证）。
    await expect(recallStore.updateRecallJsonRecord(userId, 'ability-assets', asset.id, (current) => {
      current!.title = '草稿可改';
      throw new Error('stop');
    })).rejects.toThrow('stop');
    const cached = store.loadCognitionStoreSync(userId);
    expect(cached.compatibility!.records['ability-assets'][asset.id]?.title).toBe('冻结来源');
  });
});
