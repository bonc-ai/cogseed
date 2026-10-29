import { createNightlyCandidateFixture, prepareNightlyCandidateInput } from '../../helpers/nightly-formation-fixture';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../../src/main/features/kb_indexer', () => ({ enqueue: () => {}, kbEvents: { on: () => {}, off: () => {}, emit: () => {} } }));
vi.mock('../../../src/main/features/search', () => ({ upsertContext: () => {}, dropContext: () => {} }));
let root: string, previous: string | undefined;
const uid = 'stabilization-user', id = 'aa-field-test';
const file = () => path.join(root, uid, 'cloud/recall/records/ability-assets', `${id}.json`);
function seed(extra: Record<string, unknown> = {}) {
 const record = { schemaVersion: 2, ownerId: uid, id, candidateId: 'c-field-test', type: 'personal', title: '部门', statement: '测试旧部门',
  scope: 'global', status: 'active', origin: 'manual', evidenceRefs: [], version: '1', maturity: 'seed', ontologyRefs: [{ groupId: 'g-test', field: '部门' }],
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra };
 fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(record)); return record;
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-stable-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
async function activate() { const m = await import('../../../src/main/features/cognition_migration'); expect((await m.migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]); }
describe('认知稳定化：真实业务边界', () => {
 it('字段工具返回来源与版本，重复读只记一次读取；读取不算采用', async () => {
  seed(); await activate();
  const { createCognitionKernelTools } = await import('../../../src/main/model/core-agent/cognition-kernel-tools');
  const tools = createCognitionKernelTools({ userId: uid, turnId: 'turn-field-test', cid: 'conv-field-test' });
  const check = tools.find(t => t.name === 'personal_fields_check')!;
  expect(check.inputSchema).toMatchObject({ properties: { pack: { enum: ['weekly_report'] } } });
  const result = JSON.parse((await check.execute({ pack: 'weekly_report' })).content as string);
  expect(result.bound.find((f: any) => f.field === '部门')).toMatchObject({ value: '测试旧部门', sourceId: id, version: '1' });
  await check.execute({ pack: 'weekly_report' });
  const { listInjectionReceipts } = await import('../../../src/main/features/recall/injection-receipt');
  const receipts = await listInjectionReceipts(uid, 'turn-field-test');
  expect(receipts.filter(r => r.assetId === id && r.channel === 'agent_read')).toHaveLength(1);
  const { listAssetUsageReceipts } = await import('../../../src/main/features/recall/asset-usage-receipt');
  expect(await listAssetUsageReceipts(uid)).toHaveLength(0);
  const { prepareAssetUsageClaim } = await import('../../../src/main/features/recall/asset-usage-claim');
  const claim = { assetId: id, assetVersion: '1', outputExcerpt: '周报中将部门填写为测试旧部门。' };
  await expect(prepareAssetUsageClaim(uid, 'turn-field-test', claim, [])).resolves.toEqual(claim);
  await expect(prepareAssetUsageClaim(uid, 'turn-field-test', { ...claim, assetVersion: '2' }, [])).rejects.toThrow('not supplied');
  expect(await listAssetUsageReceipts(uid)).toHaveLength(0);
 });
 it('分类后进入正式候选池，长正文保真，重复提交不新建实验池', async () => {
  const { submitCognitionCandidate } = await import('../../../src/main/features/cognition/candidate-submission');
  const statement = '# 验收模板\n\n' + '准备事项\n'.repeat(200);
  const input = await prepareNightlyCandidateInput(uid, { judgment: statement, summary: '稳定化测试模板', value: statement, suggestedType: 'template' as const, suggestedScope: 'global', sourceRefs: [], rawStatement: true, captureKey: 'nightly-stable-test' });
  const one = await submitCognitionCandidate(uid, input); const two = await submitCognitionCandidate(uid, input);
  expect(one.id).toBe(two.id); expect(one.judgment).toBe(statement.trim()); expect(one.suggestedType).toBe('template');
  expect(fs.existsSync(path.join(root, uid, 'cloud/cognition/cognition-pool.json'))).toBe(false);
 });
 it('单条编辑仅投影该记录；全量恢复能重建丢失的兼容文件', async () => {
  seed(); await activate(); const store = await import('../../../src/main/features/recall/store');
  await store.writeRecallJsonRecord(uid, 'candidates', 'candidate-control', { schemaVersion: 2, ownerId: uid, id: 'candidate-control' });
  const untouched = path.join(root, uid, 'cloud/recall/records/candidates/candidate-control.json');
  const before = fs.statSync(untouched, { bigint: true }).mtimeNs;
  await store.updateRecallJsonRecord(uid, 'ability-assets', id, raw => ({ ...raw!, status: 'paused' }));
  expect(fs.statSync(untouched, { bigint: true }).mtimeNs).toBe(before);
  fs.unlinkSync(untouched); const bridge = await import('../../../src/main/features/cognition_bridge');
  expect(await bridge.recoverCognitionProjection(uid, true)).toBe(true); expect(fs.existsSync(untouched)).toBe(true);
 });
 it('版本账追加失败后，快照与主记录原子保留，恢复不拿新正文重建旧版', async () => {
  seed(); await activate(); const assets = await import('../../../src/main/features/recall/asset-service');
  await assets.initializeAbilityAsset(uid, await assets.readAbilityAsset(uid, id));
  const storage = await import('../../../src/main/storage'); const append = storage.appendJsonlAtomic;
  const spy = vi.spyOn(storage, 'appendJsonlAtomic').mockImplementation(async (...args: Parameters<typeof append>) => {
   if (String(args[0]).includes('ability-asset-versions')) throw new Error('injected disk failure'); return append(...args);
  });
  const result = await assets.updateAbilityAsset(uid, id, { statement: '测试第二版', expectedVersion: '1', actor: 'user', reason: '测试恢复' });
  expect(result.version).toBe('2'); expect((await assets.readAbilityAsset(uid, id)).pendingVersionSnapshots).toBeTruthy();
  expect((await assets.readAbilityAssetVersionSnapshot(uid, id, '2'))?.statement).toBe('测试第二版');
  spy.mockRestore(); await assets.recoverAbilityAssetVersionJournals(uid); await assets.recoverAbilityAssetVersionJournals(uid);
  expect((await assets.readAbilityAsset(uid, id)).pendingVersionSnapshots).toBeUndefined();
  expect((await assets.listAbilityAssetVersions(uid, id)).map(v => v.version)).toEqual(['1', '2']);
 });
 it('多次版本追加失败仍保留每一版；恢复不混版，回退再升级不变更版本', async () => {
  seed(); await activate();
  const assets = await import('../../../src/main/features/recall/asset-service');
  await assets.initializeAbilityAsset(uid, await assets.readAbilityAsset(uid, id));
  const storage = await import('../../../src/main/storage'); const append = storage.appendJsonlAtomic;
  const spy = vi.spyOn(storage, 'appendJsonlAtomic').mockImplementation(async (...args: Parameters<typeof append>) => {
    if (String(args[0]).includes('ability-asset-versions')) throw new Error('injected ledger outage'); return append(...args);
  });
  await assets.updateAbilityAsset(uid, id, { statement: '版本二正文', expectedVersion: '1', actor: 'user', reason: '故障注入二' });
  await assets.updateAbilityAsset(uid, id, { statement: '版本三正文', expectedVersion: '2', actor: 'user', reason: '故障注入三' });
  expect((await assets.readAbilityAssetVersionSnapshot(uid, id, '2'))?.statement).toBe('版本二正文');
  expect((await assets.readAbilityAssetVersionSnapshot(uid, id, '3'))?.statement).toBe('版本三正文');
  spy.mockRestore(); await assets.recoverAbilityAssetVersionJournals(uid);
  const bridge = await import('../../../src/main/features/cognition_bridge');
  await bridge.rollbackCognitionAuthority(uid); expect(bridge.cognitionCompatibility(uid)?.mode).toBe('mirror');
  await activate(); expect((await assets.readAbilityAsset(uid, id)).version).toBe('3');
  expect((await assets.listAbilityAssetVersions(uid, id)).map(v => [v.version, v.snapshot.statement])).toEqual([
    ['1', '测试旧部门'], ['2', '版本二正文'], ['3', '版本三正文'],
  ]);
 });
 it('读取版本链与补账并发时不会在两次读取之间丢掉已提交版本', async () => {
  seed(); await activate();
  const assets = await import('../../../src/main/features/recall/asset-service');
  await assets.initializeAbilityAsset(uid, await assets.readAbilityAsset(uid, id));
  const storage = await import('../../../src/main/storage');
  const append = storage.appendJsonlAtomic;
  const failed = vi.spyOn(storage, 'appendJsonlAtomic').mockImplementation(async (...args: Parameters<typeof append>) => {
   if (String(args[0]).includes('ability-asset-versions')) throw new Error('injected ledger failure');
   return append(...args);
  });
  await assets.updateAbilityAsset(uid, id, { statement: '并发恢复第二版', expectedVersion: '1', actor: 'user', reason: '测试补账读写' });
  failed.mockRestore();
  const store = await import('../../../src/main/features/recall/store');
  const list = store.listRecallJsonlRecords;
  let recoverAtRead = true;
  vi.spyOn(store, 'listRecallJsonlRecords').mockImplementation(async (...args: Parameters<typeof list>) => {
   const rows = await list(...args);
   if (args[1] === 'ability-asset-versions' && recoverAtRead) {
    recoverAtRead = false;
    await assets.recoverAbilityAssetVersionJournals(uid);
   }
   return rows;
  });
  expect((await assets.listAbilityAssetVersions(uid, id)).map(v => v.version)).toEqual(['1', '2']);
  expect((await assets.readAbilityAsset(uid, id)).pendingVersionSnapshots).toBeUndefined();
 });
 it('兼容投影故障后两条待写记录合并恢复，不从旧文件覆盖主档', async () => {
  seed(); await activate();
  const storage = await import('../../../src/main/storage'); const write = storage.writeJson;
  // 投影目录的判定要用本平台的分隔符：生产代码（cognition_bridge.project）
  // 用 path.join 拼出 `<root>/cloud/recall/records/candidates/<id>.json`。
  // 硬编码 '/records/candidates/' 在 win32 上是 '\records\candidates\'，
  // 注入永远不会命中 → 写成功 → pendingProjection 被清空（本用例的前提消失）。
  const candidatesDir = path.join('records', 'candidates') + path.sep;
  const spy = vi.spyOn(storage, 'writeJson').mockImplementation(async (...args: Parameters<typeof write>) => {
    if (String(args[0]).includes(candidatesDir)) throw new Error('injected projection failure'); return write(...args);
  });
  const store = await import('../../../src/main/features/recall/store');
  await store.writeRecallJsonRecord(uid, 'candidates', 'dirty-one', { schemaVersion: 2, ownerId: uid, id: 'dirty-one', judgment: '新正文一' });
  await store.writeRecallJsonRecord(uid, 'candidates', 'dirty-two', { schemaVersion: 2, ownerId: uid, id: 'dirty-two', judgment: '新正文二' });
  const bridge = await import('../../../src/main/features/cognition_bridge');
  expect(bridge.cognitionCompatibility(uid)?.projectionChanges?.records.candidates).toEqual(['dirty-one', 'dirty-two']);
  spy.mockRestore(); expect(await bridge.recoverCognitionProjection(uid)).toBe(true);
  expect(bridge.cognitionCompatibility(uid)?.pendingProjection).toBe(false);
  for (const name of ['dirty-one', 'dirty-two']) expect(JSON.parse(fs.readFileSync(path.join(root, uid, 'cloud/recall/records/candidates', name + '.json'), 'utf8')).id).toBe(name);
 });

 it('增量编辑保留本体投影的分组、字段名和受限标记', async () => {
  seed(); await activate();
  const bridge = await import('../../../src/main/features/cognition_bridge');
  const current = bridge.cognitionCompatibility(uid)!;
  const po = { ...current.po, groups: [{ id: 'g-projected', title: '虚构分组', fields: [{ id: 'f-real', name: '真实字段名' }],
    values: [{ id: 'v-ref', fieldId: 'f-real', assetId: id, restricted: true, text: '不可用副本', source: 'user', updatedAt: '2026-10-04T00:00:00Z', createdAt: '2026-10-04T00:00:00Z' }] }] };
  await bridge.replaceCognitionSources(uid, { ...current, po });
  const store = await import('../../../src/main/features/recall/store');
  await store.updateRecallJsonRecord(uid, 'ability-assets', id, raw => ({ ...raw!, title: '改名' }));
  const kernel = await import('../../../src/main/features/cognition_kernel/store');
  expect(kernel.loadCognitionStoreSync(uid).objects[id]).toMatchObject({ groupId: 'g-projected', fieldName: '真实字段名', restricted: true });
 });

 it('正式候选晋升的模板在正文读取工具中填槽，缺值不新增读取证据', async () => {
  const submission = await import('../../../src/main/features/cognition/candidate-submission');
  const candidates = await import('../../../src/main/features/recall/candidate-service');
  const candidate = await createNightlyCandidateFixture(uid, { judgment: '# {{活动}}\n责任人：{{负责人}}', summary: '活动验收模板',
    suggestedType: 'template', suggestedScope: 'global', sourceRefs: [], rawStatement: true });
  const { asset } = await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' });
  const { createRecallToolSuite } = await import('../../../src/main/model/core-agent/recall-tools');
  const tool = createRecallToolSuite({ userId: uid, turnId: 'turn-template-fill' }).tools.find(t => t.name === 'search_ability_assets')!;
  const failedFill = await tool.execute({ assetIds: [asset.id], templateValues: { 活动: '虚构活动' } });
  expect(failedFill.content).toContain('模板填写失败');
  expect(failedFill.isError).toBe(true);
  const receipts = await import('../../../src/main/features/recall/injection-receipt');
  expect(await receipts.listInjectionReceipts(uid, 'turn-template-fill')).toHaveLength(0);
  const result = await tool.execute({ assetIds: [asset.id], templateValues: { 活动: '虚构活动', 负责人: '测试人' } });
  expect(result.content).toContain('# 虚构活动\n责任人：测试人');
  expect(await receipts.listInjectionReceipts(uid, 'turn-template-fill')).toHaveLength(1);
 });
 it('方法的真实安装绑定透传模型读取；在用版本改变会标为过期', async () => {
  seed({ type: 'skill_method', title: '测试方法', statement: '1. 读取输入\n2. 校验输出', ontologyRefs: [] });
  const store = await import('../../../src/main/features/recall/store');
  await store.writeRecallJsonRecord(uid, 'skill-bindings', id, { schemaVersion: 1, ownerId: uid, id, assetId: id, skillId: 'test-skill',
    installedAssetVersion: '1', currentSkillVersion: '1', currentRevisionId: 'test-revision', currentManifestHash: 'test-manifest',
    createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z', decisions: [] });
  const { createRecallToolSuite } = await import('../../../src/main/model/core-agent/recall-tools');
  const tool = createRecallToolSuite({ userId: uid, turnId: 'turn-method-read' }).tools.find(t => t.name === 'search_ability_assets')!;
  expect((await tool.execute({ assetIds: [id] })).content).toContain('"skillId":"test-skill"');
  const payload = await import('../../../src/main/features/recall/formal-assets/payload');
  expect(await payload.resolveFormalAssetPayload(uid, seed({ type: 'skill_method', version: '3', activeVersion: '2' }) as never)).toMatchObject({ skillReference: { stale: true } });
 });

});
