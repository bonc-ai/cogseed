import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const uid = 'inventory-owner', cid = 'inventory-chat', messageId = 'inventory-message', at = '2026-10-16T00:00:00Z';
const request = '请盘点我的全部认知资产与本体内容，仅查看，不修改。';
let root: string, previous: string | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-owner-inventory-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; vi.resetModules(); });
afterEach(() => { if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
const host = (text = request) => ({ userId: uid, cid, sourceMessageId: messageId, sourceMessageFromUser: true, taskText: text, turnId: 'inventory-turn' });
async function setup(text = request) {
  const storage = await import('../../../src/main/storage');
  const layout = await import('../../../src/main/util/project-layout');
  const file = layout.conversationMessageReadFile(uid, cid);
  await storage.appendJsonl(file, { id: messageId, from: 'user', text, ts: at, to: ['commander'] });
  const bridge = await import('../../../src/main/features/cognition_bridge');
  await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: at });
  const ontology = await import('../../../src/main/features/cognition/ontology/service');
  const [{ createOntologyTools }, inventory] = await Promise.all([import('../../../src/main/model/core-agent/ontology-tools'), import('../../../src/main/features/cognition/ontology/inventory')]);
  return { ontology, bridge, file, inventory, tool: createOntologyTools(host(text))[0] };
}
const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: 'synthetic inventory setup' });
const moduleRecord = (access = 'task') => ({ kind: 'module', name: '合成目录', description: '', scope: { kind: 'personal' }, access });
const rule = (moduleId: string, requirement = '完整合成条文') => ({ kind: 'rule', moduleId, name: '合成条目', requirement, strength: 'required', condition: null, effect: { kind: 'note' }, exception: '合成例外完整保留' });

describe('source-qualified owner content inventory', () => {
  it('enumerates a generated 272-record seven-module pool although task topic queries are empty; emits full pages without use receipts', async () => {
    const env = await setup();
    await env.ontology.commitOntologyCommand(uid, { commandId: 'modules', expectedRevision: 0, actions: Array.from({ length: 7 }, (_, i) => create(`module-${i}`, moduleRecord(i ? 'owner_only' : 'task'))) });
    for (let start = 0; start < 265; start += 50) await env.ontology.commitOntologyCommand(uid, { commandId: `records-${start}`, expectedRevision: env.ontology.readOntologyDocument(uid).revision,
      actions: Array.from({ length: Math.min(50, 265 - start) }, (_, j) => { const i = start + j; return create(`record-${String(i).padStart(3, '0')}`, { ...rule(`module-${i % 7}`, `合成完整正文-${i}`), access: i % 7 ? 'owner_only' : 'task' }); }) });
    await env.ontology.commitOntologyCommand(uid, { commandId: 'pause-one', expectedRevision: env.ontology.readOntologyDocument(uid).revision,
      actions: [{ intent: 'update', recordId: 'record-000', expectedVersion: 1, sourceLabel: 'synthetic', patch: { status: 'paused' } }] });
    const task = JSON.parse((await env.tool.execute({ query: '不存在的主题' })).content);
    expect(task.records).toEqual([]); expect(task.sourceCoverage.complete).toBe(true);
    const seen: any[] = []; let cursor: string | undefined; let first: any;
    do { const page = JSON.parse((await env.tool.execute({ mode: 'inventory', limit: 50, ...(cursor ? { cursor } : {}) })).content); first ||= page;
      expect(page.status).toBe('ok'); expect(page.snapshot.token).toBe(first.snapshot.token); seen.push(...page.records); cursor = page.page.nextCursor; } while (cursor);
    expect(first.counts).toMatchObject({ total: 272, modules: 7, canonical: { total: 272, modules: 7 }, legacyAdditional: { total: 0 } });
    expect(seen).toHaveLength(272); expect(new Set(seen.map(x => x.record.id)).size).toBe(272);
    expect(seen.find(x => x.record.id === 'record-264').record.requirement).toBe('合成完整正文-264');
    expect(seen.find(x => x.record.id === 'record-000').record.status).toBe('paused');
    const managed = JSON.parse((await env.tool.execute({ mode: 'manage', recordId: 'record-001' })).content);
    expect(managed.record.access).toBe('owner_only');
    const store = await import('../../../src/main/features/recall/store');
    expect(await store.listRecallJsonlRecords(uid, 'ontology-query-receipts', 'events', 0)).toEqual([]);
    expect(env.ontology.readOntologyDocument(uid).records['record-000'].status).toBe('paused');
    await expect(import('../../../src/main/features/cognition/edit-service').then(m => m.assertCognitionManagementTarget(host(), managed.record, env.ontology.readOntologyDocument(uid)))).rejects.toThrow();
  });

  it('requires a real current all-content request and binds pages and whole-contract chunks to current versions', async () => {
    const env = await setup(); const full = '合成完整正文😀'.repeat(900), condition = { kind: 'all', conditions: Array.from({ length: 32 }, (_, i) => ({ kind: 'task', field: 'purpose', equals: `condition-${i}` })) };
    await env.ontology.commitOntologyCommand(uid, { commandId: 'long', expectedRevision: 0, actions: [create('module', moduleRecord()), create('long-rule', { ...rule('module', full), condition })] });
    const page = JSON.parse((await env.tool.execute({ mode: 'inventory', limit: 1 })).content);
    const oversized = page.records[0]; expect(oversized.contentState).toBe('requires_chunk_read');
    let cursor: string | number = 0, text = '', token: string | undefined;
    do { const result = await env.tool.execute({ mode: 'manage', recordId: 'long-rule', contentCursor: cursor }); expect(result.isError).toBeUndefined();
      const part = JSON.parse(result.content); expect(part.contentRange.start).toBe(text.length); text += part.content; token ||= part.nextContentCursor; cursor = part.nextContentCursor; } while (cursor);
    expect(JSON.parse(text).record).toMatchObject({ requirement: full, condition, exception: '合成例外完整保留' });
    await env.ontology.commitOntologyCommand(uid, { commandId: 'changed', expectedRevision: 1, actions: [{ intent: 'update', recordId: 'long-rule', expectedVersion: 1, patch: { requirement: '新版本' }, sourceLabel: 'synthetic' }] });
    expect((await env.tool.execute({ mode: 'inventory', cursor: page.page.nextCursor })).isError).toBe(true);
    expect((await env.tool.execute({ mode: 'manage', recordId: 'long-rule', contentCursor: token })).isError).toBe(true);
    fs.writeFileSync(env.file, JSON.stringify({ id: messageId, from: 'user', text: '你支持盘点全部本体的功能吗？', ts: at }) + '\n');
    expect((await env.tool.execute({ mode: 'inventory' })).isError).toBe(true);
    const { hasFullManagementReadIntent } = await import('../../../src/main/features/cognition/management-read');
    for (const s of ['不要盘点全部本体。', '示例：“请盘点我的全部本体”。', '只查看一个本体模块。']) expect(hasFullManagementReadIntent(s, 'ontology')).toBe(false);
  });

  it('accepts polite complete-content requests but binds all to the requested domain and does not authorize writes', async () => {
    const { hasFullManagementReadIntent } = await import('../../../src/main/features/cognition/management-read');
    const polite = '那我希望你现在帮我整理一下我的资产和本体的全部内容，你能帮我做到吗？';
    const env = await setup(polite);
    await env.ontology.commitOntologyCommand(uid, { commandId: 'polite', expectedRevision: 0, actions: [create('module', moduleRecord()), create('rule', rule('module'))] });
    expect(JSON.parse((await env.tool.execute({ mode: 'inventory' })).content).counts.total).toBe(2);
    expect(JSON.parse((await env.tool.execute({ mode: 'manage', recordId: 'rule' })).content).record.requirement).toBe('完整合成条文');
    for (const domain of ['asset', 'ontology'] as const) {
      expect(hasFullManagementReadIntent(polite, domain)).toBe(true);
      expect(hasFullManagementReadIntent('Can you list all my assets and ontologies?', domain)).toBe(true);
    }
    expect(hasFullManagementReadIntent('列出全部本体，再查看资产aa-x。', 'asset')).toBe(false);
    expect(hasFullManagementReadIntent('列出全部本体，再查看资产aa-x。', 'ontology')).toBe(true);
    expect(hasFullManagementReadIntent('列出全部本体和资产aa-x。', 'asset')).toBe(false);
    expect(hasFullManagementReadIntent('列出全部本体和资产aa-x。', 'ontology')).toBe(true);
    expect(hasFullManagementReadIntent('列出全部本体和资产“指定单条”。', 'asset')).toBe(false);
    expect(hasFullManagementReadIntent('列出全部资产，再查看本体record-x。', 'ontology')).toBe(false);
    expect(hasFullManagementReadIntent('你支持盘点全部本体的功能吗？', 'ontology')).toBe(false);
  });

  it('includes corrected records, reports a failed legacy read as partial and withholds candidate sources that lack an identity', async () => {
    const env = await setup();
    await env.ontology.commitOntologyCommand(uid, { commandId: 'facts', expectedRevision: 0, actions: [create('module', moduleRecord()),
      create('type', { kind: 'definition', moduleId: 'module', name: '类型', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      create('attribute', { kind: 'definition', moduleId: 'module', name: '属性', description: '', definitionKind: 'attribute', subjectTypes: ['type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
      create('entity', { kind: 'entity', moduleId: 'module', typeId: 'type', name: '合成对象', description: '', aliases: [], identityStatus: 'confirmed' }),
      create('fact', { kind: 'assertion', moduleId: 'module', subjectId: 'entity', definitionId: 'attribute', object: { kind: 'literal', valueType: 'text', value: '旧值' }, validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'UTC' } }), create('unbound-rule', rule('module', '不可泄漏缺源正文'))] });
    await env.ontology.commitOntologyCommand(uid, { commandId: 'correct', expectedRevision: 1, actions: [{ intent: 'correct', recordId: 'fact', expectedVersion: 1, sourceLabel: 'synthetic', object: { kind: 'literal', valueType: 'text', value: '新值' } }] });
    const kernel = await import('../../../src/main/features/cognition_kernel/store');
    await kernel.editCognitionDocument(uid, doc => { doc.ontology!.records['unbound-rule'].source = { kind: 'candidate', label: 'source identity absent' }; });
    const page = await env.inventory.readOntologyInventory(uid, host(), { limit: 50 });
    expect(page.records.some(x => (x.record as any)?.id === 'fact' && (x.record as any).status === 'corrected')).toBe(true);
    expect(page.records.find(x => x.id === 'unbound-rule')).toMatchObject({ contentState: 'unavailable' });
    expect(JSON.stringify(page)).not.toContain('不可泄漏缺源正文');
    const paths = await import('../../../src/main/paths'); fs.writeFileSync(paths.userOntologyGraphFile(uid), JSON.stringify({ schemaVersion: 1, ownerId: uid, categories: [], entities: [{ id: 'bad-legacy' }], relations: [] }));
    const partial = await env.inventory.readOntologyInventory(uid, host(), { limit: 50 });
    expect(partial.status).toBe('partial'); expect(partial.counts.total).toBeNull(); expect(partial.counts.canonical.total).toBe(7);
    expect(partial.coverage).toMatchObject({ totalKnown: false, legacy: 'unavailable' });
  });

  it('lets task contentCursor read a large contract only while its existing runtime access remains eligible', async () => {
    await setup(); const store = await import('../../../src/main/features/recall/store');
    const conditions = Array.from({ length: 32 }, (_, i) => `合成条件${i}` + '保留'.repeat(60));
    await store.writeRecallJsonRecord(uid, 'ability-assets', 'aa-task', { schemaVersion: 2, ownerId: uid, id: 'aa-task', candidateId: 'synthetic', reviewDecisionId: 'synthetic', type: 'cognition', title: '合成任务资产', statement: 'task body', evidenceRefs: [], origin: 'manual', status: 'active', maturity: 'seed', scope: 'general', version: '1', applicableWhen: conditions, forbiddenWhen: conditions, createdAt: at, updatedAt: at });
    const { createAssetStewardTools } = await import('../../../src/main/model/core-agent/asset-steward-tools');
    const tool = createAssetStewardTools({ userId: uid, taskText: '独立任务，不是全库管理请求' }).find(x => x.name === 'read_ability_asset')!;
    const first = await tool.execute({ assetId: 'aa-task', contentCursor: 0 }); expect(first.isError).toBeUndefined();
    const part = JSON.parse(first.content); expect(part.nextContentCursor).toBeTruthy();
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-task', row => ({ ...row, status: 'paused' }));
    expect((await tool.execute({ assetId: 'aa-task', contentCursor: part.nextContentCursor })).isError).toBe(true);
  });

  it('keeps full legacy text separate from its bounded projection and invalidates cursors when the old source changes', async () => {
    const env = await setup(), full = '旧来源原文😀'.repeat(1_300);
    const state = structuredClone(env.bridge.cognitionCompatibility(uid)!); state.po = { schemaVersion: 2, groups: [{ id: 'legacy-group', title: '合成旧来源', kind: 'user', fields: [], values: [], entries: [{ id: 'entry-one', text: full, createdAt: at }], createdAt: at, updatedAt: at }], trash: [] }; await env.bridge.replaceCognitionSources(uid, state);
    const page = await env.inventory.readOntologyInventory(uid, host(), { limit: 50 });
    expect(page.counts.canonical.total).toBe(0); expect(page.counts.legacyAdditional.total).toBeGreaterThan(0);
    const row = page.records.find(x => x.contentState === 'requires_chunk_read')!;
    const args = row.managementRead as Record<string, unknown>; expect(args.recordId).toBeTruthy();
    let cursor: string | number = 0, text = '', firstCursor: string | undefined;
    do { const part = JSON.parse((await env.tool.execute({ mode: 'manage', recordId: args.recordId, contentCursor: cursor })).content); text += part.content; firstCursor ||= part.nextContentCursor; cursor = part.nextContentCursor; } while (cursor);
    const read = JSON.parse(text); expect(read.record.description.length).toBeLessThan(full.length); expect(read.legacySourceContent.text).toBe(full);
    const changed = structuredClone(env.bridge.cognitionCompatibility(uid)!); (changed.po as any).groups[0].entries[0].text += '变化'; await env.bridge.replaceCognitionSources(uid, changed);
    expect((await env.tool.execute({ mode: 'manage', recordId: args.recordId, contentCursor: firstCursor })).isError).toBe(true);
  });

  it('authorizes all-assets management reads without enabling paused/deleted task use, and preserves 32 conditions through source-bound chunks', async () => {
    const env = await setup(), { writeRecallJsonRecord, readRecallJsonRecord } = await import('../../../src/main/features/recall/store');
    const body = '合成资产完整正文😀'.repeat(500), conditions = Array.from({ length: 32 }, (_, i) => `条件${i}：` + '全部保留'.repeat(50));
    for (const status of ['active', 'paused', 'deleted']) await writeRecallJsonRecord(uid, 'ability-assets', `aa-${status}`, { schemaVersion: 2, ownerId: uid, id: `aa-${status}`, candidateId: 'synthetic', reviewDecisionId: 'synthetic', type: 'cognition', contentCategory: 'preference', title: `合成${status}`, statement: body, evidenceRefs: [], origin: 'manual', status, maturity: 'seed', lifecycleStatus: 'automatically_extracted_unverified', scope: 'general', version: '1', applicableWhen: conditions, forbiddenWhen: conditions, createdAt: at, updatedAt: at });
    const { createAssetStewardTools } = await import('../../../src/main/model/core-agent/asset-steward-tools');
    const tool = createAssetStewardTools(host()).find(x => x.name === 'read_ability_asset')!;
    expect((await tool.execute({ assetId: 'aa-paused' })).isError).toBe(true);
    expect((await tool.execute({ assetId: 'aa-deleted', mode: 'manage', contentCursor: 0 })).isError).toBe(true);
    const first = JSON.parse((await tool.execute({ assetId: 'aa-paused', mode: 'manage', contentCursor: 0 })).content);
    let text = first.content, cursor = first.nextContentCursor;
    while (cursor) { const part = JSON.parse((await tool.execute({ assetId: 'aa-paused', mode: 'manage', contentCursor: cursor })).content); text += part.content; cursor = part.nextContentCursor; }
    expect(JSON.parse(text).asset).toMatchObject({ statement: body, applicableWhen: conditions, forbiddenWhen: conditions, status: 'paused' });
    await writeRecallJsonRecord(uid, 'ability-assets', 'aa-paused', { ...(await readRecallJsonRecord(uid, 'ability-assets', 'aa-paused')), status: 'revoked' });
    expect((await tool.execute({ assetId: 'aa-paused', mode: 'manage', contentCursor: first.nextContentCursor })).isError).toBe(true);
    expect((await readRecallJsonRecord(uid, 'ability-assets', 'aa-active')).status).toBe('active');
    expect(env.ontology.readOntologyDocument(uid).revision).toBe(0);
  });

  it('withholds source-revoked ontology content and rejects an earlier content cursor after current-source revocation', async () => {
    const env = await setup(), store = await import('../../../src/main/features/recall/store');
    const evidence = { kind: 'conversation', subtype: 'session', taxonomyVersion: 2, id: 'evidence-chat' } as const;
    await store.writeRecallJsonRecord(uid, 'ability-assets', 'aa-source', { schemaVersion: 2, ownerId: uid, id: 'aa-source', candidateId: 'synthetic', reviewDecisionId: 'synthetic', type: 'cognition', title: '来源', statement: '来源正文', evidenceRefs: [evidence], origin: 'manual', status: 'active', maturity: 'seed', scope: 'general', version: '1', createdAt: at, updatedAt: at });
    await env.ontology.commitOntologyCommand(uid, { commandId: 'source-records', expectedRevision: 0, actions: [create('module', moduleRecord()), create('protected-rule', rule('module', '不可再读标记'.repeat(1000)))] });
    await env.bridge.withCognitionSourceDependency(uid, 'ability-assets', doc => { doc.ontology!.records['protected-rule'].source.refs = [{ kind: 'asset', id: 'aa-source' }]; },
      () => store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-source', old => ({ ...old })));
    const before = JSON.parse((await env.tool.execute({ mode: 'manage', recordId: 'protected-rule', contentCursor: 0 })).content);
    expect(before.nextContentCursor).toBeTruthy();
    const { pauseCognitionSource } = await import('../../../src/main/features/recall/source-control');
    await pauseCognitionSource(uid, evidence);
    const after = await env.tool.execute({ mode: 'manage', recordId: 'protected-rule', contentCursor: before.nextContentCursor });
    expect(after.isError).toBe(true); expect(after.content).not.toContain('不可再读标记');
    const page = await env.inventory.readOntologyInventory(uid, host(), { limit: 50 });
    expect(page.counts.total).toBe(2); expect(page.coverage.withheldSourceCount).toBe(1);
    expect(page.records.find(x => x.id === 'protected-rule')).toMatchObject({ contentState: 'withheld' });
    expect(JSON.stringify(page)).not.toContain('不可再读标记');
  });

  it('reconstructs a large task ontology query through fresh scoped chunks and rejects its cursor after source revocation', async () => {
    const env = await setup(), store = await import('../../../src/main/features/recall/store');
    const evidence = { kind: 'conversation', subtype: 'session', taxonomyVersion: 2, id: 'task-evidence' } as const;
    await store.writeRecallJsonRecord(uid, 'ability-assets', 'aa-task-source', { schemaVersion: 2, ownerId: uid, id: 'aa-task-source', candidateId: 'synthetic', reviewDecisionId: 'synthetic', type: 'cognition', title: '任务来源', statement: 'task source', evidenceRefs: [evidence], origin: 'manual', status: 'active', maturity: 'seed', scope: 'general', version: '1', createdAt: at, updatedAt: at });
    const full = '任务范围完整正文😀'.repeat(700);
    const condition = { kind: 'all', conditions: Array.from({ length: 32 }, (_, i) => ({ kind: 'task', field: 'purpose', equals: `condition-${i}` })) };
    await env.ontology.commitOntologyCommand(uid, { commandId: 'task-large', expectedRevision: 0, actions: [create('module', moduleRecord()), create('task-rule', { ...rule('module', full), condition })] });
    await env.bridge.withCognitionSourceDependency(uid, 'ability-assets', doc => { doc.ontology!.records['task-rule'].source.refs = [{ kind: 'asset', id: 'aa-task-source' }]; },
      () => store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-task-source', old => ({ ...old })));
    const { createOntologyTools } = await import('../../../src/main/model/core-agent/ontology-tools');
    const task = createOntologyTools({ userId: uid, turnId: 'task-large-query', context: { taskText: '普通任务，不是管理盘点' } })[0];
    const raw = await task.execute({ query: '合成', at: '2026-10-16' });
    const { capToolResult } = await import('../../../src/main/util/tool-result-cap');
    expect(capToolResult('cognition_ontology_query', raw, { state: {} }, { maxInlineTokens: 8_000, toolResultsDir: path.join(root, 'results') }).isError).toBe(true);
    let cursor: string | number = 0, text = '', firstCursor: string | undefined;
    do { const result = await task.execute({ query: '合成', at: '2026-10-16', contentCursor: cursor }); expect(result.isError).toBeUndefined();
      const part = JSON.parse(result.content); expect(part.mode).toBe('task'); expect(part.contentRange.start).toBe(text.length);
      text += part.content; firstCursor ||= part.nextContentCursor; cursor = part.nextContentCursor; } while (cursor);
    const restored = JSON.parse(text); expect(restored.records.find((r: any) => r.id === 'task-rule')).toMatchObject({ requirement: full, condition });
    expect(restored.rules.find((r: any) => r.source.recordId === 'task-rule').requirement).toBe(full);
    const { pauseCognitionSource } = await import('../../../src/main/features/recall/source-control'); await pauseCognitionSource(uid, evidence);
    const revoked = await task.execute({ query: '合成', at: '2026-10-16', contentCursor: firstCursor });
    expect(revoked.isError).toBe(true); expect(revoked.content).not.toContain('任务范围完整正文');
    expect(fs.existsSync(path.join(root, 'results'))).toBe(false);
    expect((await task.execute({ mode: 'manage', recordId: 'task-rule' })).isError).toBe(true);
  });
});
