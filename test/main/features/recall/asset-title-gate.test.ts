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
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-title-gate-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

const STATEMENT = '遇到同类任务时，先列出已知与未知，再补齐缺口。';

async function modules() {
  const [assets, store] = await Promise.all([
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/store'),
  ]);
  return { assets, store };
}

/** 直连 createAbilityAsset 的合规种子（绕开候选链，聚焦闸门本身）。 */
async function seedAsset(uid: string, id: string, title: string, statement: string) {
  const { assets } = await modules();
  const now = new Date().toISOString();
  return assets.createAbilityAsset(uid, {
    schemaVersion: 2, ownerId: uid, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_${id}_gate_2026`,
    type: 'rule', title, statement,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }],
    scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'title gate seed' });
}

describe('标题闸门（设计 3.2）：createAbilityAsset 收口强制判定', () => {
  it('机器可判四项不合规的 title 一律拒绝', async () => {
    const { assets } = await modules();
    const base = (title: string) => seedAsset('user-gate', 'aa-gate-reject-0000000001', title, STATEMENT)
      .catch((error: Error) => Promise.reject(error));
    await expect(base('')).rejects.toThrow(/invalid ability asset title/);                       // ①空
    await expect(base('这是一个超过十六个字的历史遗留超长标题')).rejects.toThrow(/invalid ability asset title/); // ②中文>16 字
    await expect(base('遇到同类任务先列清单')).rejects.toThrow(/invalid ability asset title/);   // ③与正文开头重复
    await expect(base('清单先行。')).rejects.toThrow(/invalid ability asset title/);             // ④标点结尾
  });

  it('create 路补与 update 对称的 bounded 归一：空白折叠、trim、≤120', async () => {
    const { assets } = await modules();
    // 折叠 + trim 后合规照常入库（落盘是归一形态）。
    const stored = await seedAsset('user-bounded', 'aa-gate-bounded-000000001', '  清单   先行  ', STATEMENT);
    expect(stored.title).toBe('清单 先行');
    // 超 120 字在 bounded 层被拒（与 update 同款错误）。
    await expect(seedAsset('user-bounded', 'aa-gate-bounded-000000002', `标${'题'.repeat(120)}`, STATEMENT))
      .rejects.toThrow(/invalid ability asset title/);
  });
});

describe('标题闸门（设计 3.2）：updateAbilityAsset 收口强制判定', () => {
  it('写入 title 时过判定；拒绝后不落盘（版本不动）', async () => {
    const { assets } = await modules();
    const asset = await seedAsset('user-upd', 'aa-gate-update-0000000001', '清单先行', STATEMENT);
    await expect(assets.updateAbilityAsset('user-upd', asset.id, {
      title: '遇到同类任务的处理', reason: 'bad title', actor: 'user',
    })).rejects.toThrow(/invalid ability asset title/);
    const after = await assets.readAbilityAsset('user-upd', asset.id);
    expect(after.title).toBe('清单先行');
    expect(after.version).toBe('1');
    // 合规 title 照常写入。
    const updated = await assets.updateAbilityAsset('user-upd', asset.id, {
      title: '先列已知未知', reason: 'good title', actor: 'user',
    });
    expect(updated.title).toBe('先列已知未知');
    expect(updated.version).toBe('2');
  });

  it('闸门拦的是写入不是存量：不写 title 的更新不受遗留坏标题影响', async () => {
    const { assets, store } = await modules();
    const asset = await seedAsset('user-legacy', 'aa-gate-legacy-0000000001', '清单先行', STATEMENT);
    // 模拟存量不合规标题（闸门前的历史数据）：raw 直改，不走收口。
    await store.updateRecallJsonRecord('user-legacy', 'ability-assets', asset.id, (raw) => ({
      ...raw!, title: '遇到同类任务时先列出已知与未知，再补齐缺口。这是正文首句当标题的老形态',
    }));
    // 只改正文的更新必须放行（否则所有遗留资产的正常维护都被卡死）。
    const updated = await assets.updateAbilityAsset('user-legacy', asset.id, {
      statement: '更新后的正文，换了一句开头。', reason: 'statement only', actor: 'user',
    });
    expect(updated.version).toBe('2');
    expect(updated.title).toBe('遇到同类任务时先列出已知与未知，再补齐缺口。这是正文首句当标题的老形态');
  });
});

describe('回滚/选版闸门（设计 3.2 拍板项 #2）：目标快照标题不合规时保留在用标题', () => {
  const BAD_SNAPSHOT_TITLE = '历史遗留的正文首句标题'; // 与快照正文开头重复 → 不合规
  const BAD_SNAPSHOT_STATEMENT = '历史遗留的正文首句标题，冻结在旧版本快照里。';

  /** 种子 + 追加一条标题不合规的 v5 快照（raw 直写版本流，模拟存量历史；
   *  编号避开回滚将生成的 v3/v4，防止 JSONL 内 id 撞号）。 */
  async function seedWithBadSnapshot(uid: string) {
    const { assets, store } = await modules();
    const asset = await seedAsset(uid, 'aa-gate-rollback-00000001', '清单先行', STATEMENT);
    await assets.updateAbilityAsset(uid, asset.id, { title: '先列已知未知', statement: '第二版正文。', reason: 'v2', actor: 'user' });
    await store.appendRecallJsonlRecord(uid, 'ability-asset-versions', asset.id, {
      schemaVersion: 1, ownerId: uid, id: `${asset.id}-v5`, assetId: asset.id, version: '5',
      at: new Date().toISOString(), reason: 'legacy bad-title snapshot',
      snapshot: {
        title: BAD_SNAPSHOT_TITLE, statement: BAD_SNAPSHOT_STATEMENT, type: 'rule', scope: 'general',
        evidenceRefs: [{ kind: 'conversation', id: `conv-${asset.id}` }],
        status: 'active', maturity: 'bud', version: '5',
      },
    } as never);
    return { asset };
  }

  it('rollback：其余字段照常回滚，标题保留在用合规标题，台账留注记', async () => {
    const { assets } = await modules();
    const uid = 'user-rb';
    const { asset } = await seedWithBadSnapshot(uid);
    const rolled = await assets.rollbackAbilityAsset(uid, asset.id, '5', { actor: 'user', reason: '回到 v5' });
    expect(rolled.title).toBe('先列已知未知');            // 保留在用标题（v2 的合规标题）
    expect(rolled.statement).toBe(BAD_SNAPSHOT_STATEMENT); // 其余字段照常回滚
    expect(rolled.version).toBe('3');                      // 回滚生成新版本（在用 v2 的下一个）
    const audit = await assets.listAbilityAssetAudit(uid, asset.id);
    expect(audit.find((r) => r.action === 'rolled_back')?.note).toContain('保留在用标题');
  });

  it('select：内容切到旧快照但标题保留在用合规标题', async () => {
    const { assets } = await modules();
    const uid = 'user-sel';
    const { asset } = await seedWithBadSnapshot(uid);
    const selected = await assets.selectAbilityAssetVersion(uid, asset.id, '5', { actor: 'user', reason: '用 v5' });
    expect(selected.title).toBe('先列已知未知');
    expect(selected.statement).toBe(BAD_SNAPSHOT_STATEMENT);
    expect(selected.activeVersion).toBe('5');
    const audit = await assets.listAbilityAssetAudit(uid, asset.id);
    expect(audit.find((r) => r.action === 'version_selected')?.note).toContain('保留在用标题');
  });
});

describe('同义归并闸门（设计 3.2 / 深探 F15）：source 在用标题不合规时不铺到 target', () => {
  const SOURCE_STATEMENT = '源正文的第一句作为遗留坏标题被冻结在版本快照里。';

  /** target 合规在用；source 在用快照标题不合规且 updatedAt 更新（sourceNewer=true）。 */
  async function seedMergePair(uid: string, sourceTitleCompliant: boolean) {
    const { assets, store } = await modules();
    const target = await seedAsset(uid, 'aa-gate-mtarget-00000001', '目标资产标题', '这是目标条目的在用正文。');
    const source = await seedAsset(uid, 'aa-gate-msource-00000001', '源资产标题', '这是源条目的初始正文。');
    if (sourceTitleCompliant) return { target, source };
    // 在用快照带不合规标题（标题＝正文开头重复）：raw 追加 v2 快照并把在用指针拨过去。
    const badTitle = SOURCE_STATEMENT.slice(0, 10);
    await store.appendRecallJsonlRecord(uid, 'ability-asset-versions', source.id, {
      schemaVersion: 1, ownerId: uid, id: `${source.id}-v2`, assetId: source.id, version: '2',
      at: new Date().toISOString(), reason: 'legacy bad-title active snapshot',
      snapshot: {
        title: badTitle, statement: SOURCE_STATEMENT, type: 'rule', scope: 'general',
        evidenceRefs: [{ kind: 'conversation', id: `conv-${source.id}` }],
        status: 'active', maturity: 'bud', version: '2',
      },
    } as never);
    await store.updateRecallJsonRecord(uid, 'ability-assets', source.id, (raw) => ({
      ...raw!, title: badTitle, statement: SOURCE_STATEMENT, version: '2', activeVersion: '2',
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    void target;
    return { target, source };
  }

  it('sourceNewer 且 source 在用标题不合规：target 保留在用标题，其余内容照常并入', async () => {
    const { assets } = await modules();
    const uid = 'user-merge-gate';
    const { target, source } = await seedMergePair(uid, false);
    const merged = await assets.mergeAbilityAssets(uid, source.id, target.id, { actor: 'user', reason: 'merge dup' });
    expect(merged.title).toBe('目标资产标题');   // 不合规标题不铺
    expect(merged.statement).toBe(SOURCE_STATEMENT); // 其余内容照常并入
  });

  it('source 在用标题合规：照常铺到 target（既有语义不变）', async () => {
    const { assets } = await modules();
    const uid = 'user-merge-ok';
    const { target, source } = await seedMergePair(uid, true);
    // 拨新 source 的 updatedAt 让 sourceNewer 成立（标题不动，raw 写不走闸门）。
    const { store } = await modules();
    await store.updateRecallJsonRecord(uid, 'ability-assets', source.id, (raw) => ({
      ...raw!, updatedAt: new Date(Date.now() + 90_000).toISOString(),
    }));
    const merged = await assets.mergeAbilityAssets(uid, source.id, target.id, { actor: 'user', reason: 'merge dup' });
    expect(merged.title).toBe('源资产标题');
    expect(merged.statement).toBe('这是源条目的初始正文。');
  });
});

describe('投影刷新（设计 3.3 硬前提 / 深探 F6）：update 改 title 必伴随 committed 投影版本刷新', () => {
  /** raw 写一条引用该资产的 confirmed 投影（冻结 v1）。 */
  async function seedCommittedProjection(uid: string, assetId: string) {
    const { store } = await modules();
    const at = new Date().toISOString();
    await store.writeRecallJsonRecord(uid, 'projections', `proj-${assetId}`, {
      schemaVersion: 2, ownerId: uid, id: `proj-${assetId}`,
      assetIds: [assetId], assetVersions: { [assetId]: '1' },
      sourceRefs: [], omittedRefs: [],
      taskRunId: 'task-gate', purpose: 'gate test', authorization: 'user-confirmed',
      status: 'confirmed', createdAt: at, confirmedAt: at,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } as never);
    return `proj-${assetId}`;
  }

  it('改 title 后 committed 投影的冻结版本号被刷到新版本', async () => {
    const { assets, store } = await modules();
    const uid = 'user-proj';
    const asset = await seedAsset(uid, 'aa-gate-proj-00000000001', '清单先行', STATEMENT);
    const projectionId = await seedCommittedProjection(uid, asset.id);

    const updated = await assets.updateAbilityAsset(uid, asset.id, { title: '先列已知未知', reason: 'retitle', actor: 'user' });
    expect(updated.version).toBe('2');
    const projection = await store.readRecallJsonRecord(uid, 'projections', projectionId);
    expect((projection as { assetVersions?: Record<string, string> }).assetVersions?.[asset.id]).toBe('2');
  });

  it('只改正文不改 title 不触发刷新（刷新挂在 title 变更分支）', async () => {
    const { assets, store } = await modules();
    const uid = 'user-proj-2';
    const asset = await seedAsset(uid, 'aa-gate-proj-00000000002', '清单先行', STATEMENT);
    const projectionId = await seedCommittedProjection(uid, asset.id);

    await assets.updateAbilityAsset(uid, asset.id, { statement: '只换正文，标题不动。', reason: 'body only', actor: 'user' });
    const projection = await store.readRecallJsonRecord(uid, 'projections', projectionId);
    expect((projection as { assetVersions?: Record<string, string> }).assetVersions?.[asset.id]).toBe('1');
  });
});
