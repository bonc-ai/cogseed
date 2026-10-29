import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNightlyCandidateFixture } from '../../helpers/nightly-formation-fixture';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../src/main/features/kb_indexer', () => ({ enqueue: () => {}, kbEvents: { on: () => {}, off: () => {}, emit: () => {} } }));
vi.mock('../../../src/main/features/search', () => ({ upsertContext: () => {}, dropContext: () => {} }));
let root: string; let previous: string | undefined;
const uid = 'bridge-user';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-bridge-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
function asset(id = 'aa-template', extra: Record<string, unknown> = {}) {
  return { schemaVersion: 2, ownerId: uid, id, candidateId: 'candidate-one', reviewDecisionId: 'legacy-untracked', type: 'template',
    title: '验收测试模板', statement: '# 模板\n\n1. 准备\n2. 验收\n\n' + '长正文'.repeat(900), origin: 'manual', evidenceRefs: [],
    version: '4', activeVersion: '2', scope: 'global', status: 'paused', maturity: 'seed', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    scopePolicy: { projectIds: ['project-one'] }, applicableWhen: ['测试'], forbiddenWhen: ['正式交付'], ...extra };
}
function sourceFile(id = 'aa-template') { return path.join(root, uid, 'cloud', 'recall', 'records', 'ability-assets', id + '.json'); }
function seed(a = asset()) {
  fs.mkdirSync(path.dirname(sourceFile()), { recursive: true }); fs.writeFileSync(sourceFile(String(a.id)), JSON.stringify(a));
  const dir = path.join(root, uid, 'cloud', 'recall', 'jsonl', 'ability-asset-versions'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(a.id) + '.jsonl'), JSON.stringify({ schemaVersion: 1, ownerId: uid, id: a.id + '-v2', assetId: a.id, version: '2', snapshot: { ...a, version: '2' }, at: '2026-10-01' }) + '\n');
}
async function modules() {
  const [migration, bridge, store, kernel] = await Promise.all([
    import('../../../src/main/features/cognition_migration'), import('../../../src/main/features/cognition_bridge'),
    import('../../../src/main/features/recall/store'), import('../../../src/main/features/cognition_kernel/store'),
  ]); return { migration, bridge, store, kernel };
}
describe('认知主档切换与恢复', () => {
  it('不分类认识不会与缺少字段名的既有断言争用个人槽位', async () => {
    seed(asset('aa-cognition', { type: 'cognition', statement: '来源支持的认识。' }));
    const { migration, kernel } = await modules();
    const { buildDelta } = await import('../../../src/main/features/cognition_kernel/delta');
    await kernel.applyCognitionDeltas(uid, [buildDelta({ op: 'add', target: { home: 'personal_fact', objectId: 'native-assertion' }, origin: 'user', after: '原有字段断言。', status: 'applied' })]);
    expect((await migration.migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]);
    expect(kernel.loadCognitionStoreSync(uid).objects['native-assertion'].statement).toBe('原有字段断言。');
    const assets = await import('../../../src/main/features/recall/asset-service');
    await assets.pauseAbilityAsset(uid, 'aa-cognition', { actor: 'user', reason: '暂停复核' });
    expect(kernel.loadCognitionStoreSync(uid).objects['aa-cognition'].status).toBe('paused');
  });
  it('统一主档支持不分类认知且不投影到个人本体字段', async () => {
    seed(asset('aa-cognition', { type: 'cognition', statement: '有依据的认识保留条件和局限。' }));
    const { migration, kernel, store } = await modules();
    expect((await migration.migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]);
    expect(kernel.loadCognitionStoreSync(uid).objects['aa-cognition']).toMatchObject({
      kind: 'assertion', home: 'cognition', statement: '有依据的认识保留条件和局限。',
    });
    expect(kernel.loadCognitionStoreSync(uid).objects['aa-cognition'].fieldName).toBeUndefined();
    expect(await store.readRecallJsonRecord(uid, 'ability-assets', 'aa-cognition')).toMatchObject({ type: 'cognition' });
  });
  it('统一模式真实业务服务贯通夜间模板确认、版本更新、暂停和历史读取', async () => {
    const { migration, bridge } = await modules();
    expect((await migration.migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]);
    const candidates = await import('../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../src/main/features/recall/asset-service');
    const candidate = await createNightlyCandidateFixture(uid, {
      judgment: '准备活动时逐项列出事项和验收条件。', summary: '活动准备验收清单',
      suggestedType: 'template', suggestedScope: 'general', suggestedAction: 'create', sourceRefs: [], value: '活动验收清单可供后续同类活动复用。',
    });
    const { asset: created } = await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user', forceCreateSimilar: true });
    expect(created.type).toBe('template');
    expect(bridge.cognitionCompatibility(uid)?.ontologyCandidates).toEqual([]);
    expect(bridge.cognitionCompatibility(uid)?.records.candidates[candidate.id].status).toBe('confirmed');
    const updated = await assets.updateAbilityAsset(uid, created.id, { statement: '每项准备事项必须包含责任人和验收条件。', reason: '补全验收要求', actor: 'user' });
    expect(updated.version).toBe('2');
    expect((await assets.readAbilityAssetVersionSnapshot(uid, created.id, '1')).statement).toBe(created.statement);
    await assets.pauseAbilityAsset(uid, created.id, { actor: 'user', reason: '结束独立验收' });
    expect((await assets.readAbilityAsset(uid, created.id)).status).toBe('paused');
    expect(bridge.cognitionCompatibility(uid)?.records['ability-assets'][created.id].status).toBe('paused');
    await bridge.rollbackCognitionAuthority(uid);
    expect((await assets.readAbilityAsset(uid, created.id)).version).toBe('2');
    expect((await assets.readAbilityAssetVersionSnapshot(uid, created.id, '1')).statement).toBe(created.statement);
  });
  it('统一模式无本体字段值时仍完成只读检查和恢复', async () => {
    seed(); const { migration, kernel } = await modules();
    await migration.migrateLegacyCognition(uid, { activate: true });
    await kernel.editCognitionCompatibility(uid, doc => {
      doc.compatibility!.po!.groups = [{ id: 'empty-group' }];
    });
    const report = await migration.migrateLegacyCognition(uid, { dryRun: true });
    expect(report.errors).toEqual([]); expect(report.poValues.total).toBe(0);
  });
  it('预检零写盘，完整模板/范围/治理态/选中版本保真，等文不同资产不合并', async () => {
    seed(); seed(asset('aa-same-body', { status: 'archived' }));
    const { migration, kernel } = await modules();
    const before = fs.readdirSync(path.join(root, uid, 'cloud'));
    expect((await migration.migrateLegacyCognition(uid, { dryRun: true })).errors).toEqual([]);
    expect(fs.readdirSync(path.join(root, uid, 'cloud'))).toEqual(before);
    expect(fs.existsSync(kernel.cognitionStorePath(uid))).toBe(false);
    expect((await migration.migrateLegacyCognition(uid)).errors).toEqual([]);
    const doc = kernel.loadCognitionStoreSync(uid);
    expect(doc.compatibility?.records['ability-assets']['aa-template']).toEqual(asset());
    expect(doc.objects['aa-template']).toMatchObject({ status: 'paused', version: 2, statement: asset().statement });
    expect(doc.objects['aa-same-body'].status).toBe('archived');
  });
  it('镜像重跑同步同 ID 内容和状态变更，而不是跳过；再次运行零差异', async () => {
    seed(); const { migration, store, kernel } = await modules();
    await migration.migrateLegacyCognition(uid);
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-template', current => ({ ...current!, statement: '修改后的正文', status: 'archived', version: '5' }));
    expect(kernel.loadCognitionStoreSync(uid).objects['aa-template']).toMatchObject({ statement: '修改后的正文', status: 'archived' });
    const report = await migration.migrateLegacyCognition(uid);
    expect(report.errors).toEqual([]); expect(report.differences.updated).toBe(0); expect(report.backupDir).toBeUndefined();
  });
  it('统一权威读写不受陈旧旧文件影响，列表含新资产；回退先完整导出最新状态', async () => {
    seed(); const { migration, store, bridge } = await modules();
    expect((await migration.migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]);
    fs.writeFileSync(sourceFile(), JSON.stringify(asset('aa-template', { statement: '陈旧文件', status: 'active' })));
    expect((await store.readRecallJsonRecord(uid, 'ability-assets', 'aa-template'))?.status).toBe('paused');
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-template', current => ({ ...current!, statement: '统一库新值', version: '5' }));
    await store.writeRecallJsonRecord(uid, 'ability-assets', 'aa-new', asset('aa-new'));
    expect(bridge.unifiedCognitionRecordIds(uid, 'ability-assets')).toContain('aa-new');
    fs.unlinkSync(sourceFile('aa-new'));
    expect((await store.readRecallJsonRecord(uid, 'ability-assets', 'aa-new'))?.id).toBe('aa-new');
    await bridge.rollbackCognitionAuthority(uid);
    expect(bridge.cognitionCompatibility(uid)?.mode).toBe('mirror');
    expect(JSON.parse(fs.readFileSync(sourceFile(), 'utf8')).statement).toBe('统一库新值');
    expect(fs.existsSync(sourceFile('aa-new'))).toBe(true);
  });
  it('投影失败主档仍已提交，pending 持久化；恢复后旧文件匹配且重新迁移不反灌', async () => {
    seed(); const { migration, bridge, store } = await modules();
    await migration.migrateLegacyCognition(uid, { activate: true });
    fs.unlinkSync(sourceFile()); fs.mkdirSync(sourceFile());
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-template', current => ({ ...current!, statement: '原子提交已成功' }));
    expect((await store.readRecallJsonRecord(uid, 'ability-assets', 'aa-template'))?.statement).toBe('原子提交已成功');
    expect(bridge.cognitionCompatibility(uid)?.pendingProjection).toBe(true);
    fs.rmdirSync(sourceFile());
    expect(await bridge.recoverCognitionProjection(uid)).toBe(true);
    expect(bridge.cognitionCompatibility(uid)?.pendingProjection).toBe(false);
    fs.writeFileSync(sourceFile(), JSON.stringify(asset('aa-template', { statement: '错误反灌' })));
    await migration.migrateLegacyCognition(uid);
    expect((await store.readRecallJsonRecord(uid, 'ability-assets', 'aa-template'))?.statement).toBe('原子提交已成功');
  });
  it('并发修改与切换串行化，资产计数不丢更新', async () => {
    seed(asset('aa-template', { counter: 0 })); const { migration, store } = await modules();
    await migration.migrateLegacyCognition(uid);
    await Promise.all([migration.migrateLegacyCognition(uid, { activate: true }), ...Array.from({ length: 12 }, () => store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-template', current => ({ ...current!, counter: Number(current!.counter) + 1 })))]);
    expect((await store.readRecallJsonRecord(uid, 'ability-assets', 'aa-template'))?.counter).toBe(12);
  });
  it('坏来源/跨用户记录/未来 schema 拒绝迁移且不切权威', async () => {
    seed(asset('aa-template', { ownerId: 'another-user' })); const { migration, bridge } = await modules();
    expect((await migration.migrateLegacyCognition(uid, { activate: true })).errors.length).toBeGreaterThan(0);
    expect(bridge.cognitionCompatibility(uid)).toBeUndefined();
    seed(asset('aa-template', { schemaVersion: 99 }));
    expect((await migration.migrateLegacyCognition(uid)).errors.length).toBeGreaterThan(0);
    fs.writeFileSync(sourceFile(), '{broken');
    expect((await migration.migrateLegacyCognition(uid)).errors.length).toBeGreaterThan(0);
  });
  it('批量读取只解析一次主档，后续读取及写入仍取新快照并隔离用户', async () => {
    seed(asset('aa-first')); seed(asset('aa-second'));
    const { migration, store, kernel } = await modules();
    await migration.migrateLegacyCognition(uid, { activate: true });
    const guard = await import('../../../src/main/util/corrupt-guard');
    const reads = vi.spyOn(guard, 'readTextGuarded');
    const assets = await import('../../../src/main/features/recall/asset-service');
    expect((await assets.listAbilityAssets(uid)).map(row => row.id).sort()).toEqual(['aa-first', 'aa-second']);
    expect(reads.mock.calls.filter(([file]) => file === kernel.cognitionStorePath(uid))).toHaveLength(1);
    reads.mockClear();
    const reader = store.createRecallCollectionReader(uid, 'ability-assets');
    expect(reader.ids?.sort()).toEqual(['aa-first', 'aa-second']);
    const records = await Promise.all(reader.ids!.map(id => reader.read(id)));
    expect(records.map(row => row?.id).sort()).toEqual(['aa-first', 'aa-second']);
    expect(reads.mock.calls.filter(([file]) => file === kernel.cognitionStorePath(uid))).toHaveLength(1);
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-first', row => ({ ...row!, statement: 'new source' }));
    expect((await reader.read('aa-first'))?.statement).not.toBe('new source'); // One coherent request snapshot.
    expect((await store.createRecallCollectionReader(uid, 'ability-assets').read('aa-first'))?.statement).toBe('new source');
    expect(await store.createRecallCollectionReader('other-user', 'ability-assets').read('aa-first')).toBeUndefined();
  });
  it('批量读取沿用 mirror 回退和逐条 owner 校验，不缓存坏档失败', async () => {
    seed(); const { store, kernel } = await modules();
    const legacy = store.createRecallCollectionReader(uid, 'ability-assets');
    expect(legacy.ids).toBeUndefined();
    expect((await legacy.read('aa-template'))?.status).toBe('paused');
    fs.writeFileSync(sourceFile(), JSON.stringify(asset('aa-template', { ownerId: 'wrong-user' })));
    await expect(legacy.read('aa-template')).rejects.toThrow('owner mismatch');
    fs.mkdirSync(path.dirname(kernel.cognitionStorePath(uid)), { recursive: true });
    fs.writeFileSync(kernel.cognitionStorePath(uid), '{broken');
    expect(() => store.createRecallCollectionReader(uid, 'ability-assets')).toThrow('legacy fallback refused');
  });
  it('主档损坏绝不退回旧 active 内容', async () => {
    seed(); const { migration, store, kernel } = await modules(); await migration.migrateLegacyCognition(uid, { activate: true });
    fs.writeFileSync(kernel.cognitionStorePath(uid), '{broken');
    await expect(store.readRecallJsonRecord(uid, 'ability-assets', 'aa-template')).rejects.toThrow('legacy fallback refused');
    await expect(store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-template', () => asset())).rejects.toThrow();
    expect(JSON.parse(fs.readFileSync(sourceFile(), 'utf8')).status).toBe('paused');
  });
  it('保留本体多值、受限值、回收站；从本体写口同步，统一读取不会用旧副本', async () => {
    seed(); const { migration, bridge, kernel } = await modules();
    const po = await import('../../../src/main/features/po/store');
    await po.editPoDoc(uid, ctx => { ctx.doc.groups.push({ id: 'g-one', title: '测试身份', kind: 'user', fields: [{ id: 'f-one', name: '城市', origin: 'user', createdAt: '2026-10-01' }],
      values: ['甲', '乙'].map((text, i) => ({ id: 'value-' + i, fieldId: 'f-one', text, source: 'manual', restricted: i === 1, createdAt: '2026-10-01', updatedAt: '2026-10-01' })), entries: [], createdAt: '2026-10-01', updatedAt: '2026-10-01' }); });
    expect((await migration.migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]);
    expect(Object.values(kernel.loadCognitionStoreSync(uid).objects).filter(o => o.managedSource?.startsWith('po:'))).toHaveLength(2);
    await po.editPoDoc(uid, ctx => { ctx.doc.groups[0].values[0].text = '更新城市'; });
    fs.writeFileSync(po.poDocPath(uid), JSON.stringify({ schemaVersion: 2, groups: [], trash: [] }));
    expect(po.loadPoDocSync(uid).groups[0].values[0].text).toBe('更新城市');
    expect(bridge.cognitionCompatibility(uid)?.po).toBeTruthy();
  });
  it('本体候选确认/驳回使用统一主档且并发添加不丢失', async () => {
    seed(); const { migration, bridge } = await modules();
    expect((await migration.migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]);
    const candidates = await import('../../../src/main/features/personal_ontology_candidates');
    await Promise.all(Array.from({ length: 5 }, (_, i) => candidates.addCandidate(uid, { candidate_id: 'candidate-' + i, summary: '验收候选 ' + i })));
    expect((await candidates.listCandidates(uid)).candidate_updates).toHaveLength(5);
    await Promise.all([candidates.rejectCandidate(uid, 'candidate-0'), candidates.addCandidate(uid, { candidate_id: 'candidate-new', summary: '保留新候选' })]);
    expect((await candidates.listCandidates(uid)).candidate_updates.map(c => c.candidate_id)).toContain('candidate-new');
    expect(bridge.cognitionCompatibility(uid)?.ontologyCandidates).toHaveLength(5);
  });
  it('历史流原样保留，缺少在用版本或坏历史拒绝切换', async () => {
    seed(); const { migration, bridge } = await modules();
    const stream = path.join(root, uid, 'cloud', 'recall', 'jsonl', 'ability-asset-versions', 'aa-template.jsonl');
    const before = fs.readFileSync(stream, 'utf8');
    await migration.migrateLegacyCognition(uid);
    expect(fs.readFileSync(stream, 'utf8')).toBe(before);
    fs.unlinkSync(stream);
    expect((await migration.migrateLegacyCognition(uid, { activate: true })).errors.join()).toContain('snapshot missing');
    expect(bridge.cognitionCompatibility(uid)?.mode).toBe('mirror');
    fs.writeFileSync(stream, '{broken');
    expect((await migration.migrateLegacyCognition(uid, { activate: true })).errors.length).toBeGreaterThan(0);
  });
  it('已有内核手工对象冲突必须显式拒绝，不能用导入静默覆盖', async () => {
    seed(); const { migration, kernel } = await modules(); const { buildDelta } = await import('../../../src/main/features/cognition_kernel/delta');
    await kernel.applyCognitionDeltas(uid, [buildDelta({ op: 'add', target: { home: 'template', objectId: 'aa-template' }, origin: 'user', after: '内核手工内容', status: 'applied' })]);
    expect((await migration.migrateLegacyCognition(uid, { activate: true })).errors.join()).toContain('conflicts');
    expect(kernel.loadCognitionStoreSync(uid).objects['aa-template'].statement).toBe('内核手工内容');
  });
});
