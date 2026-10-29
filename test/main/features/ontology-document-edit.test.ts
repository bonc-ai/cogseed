import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/main/features/recall/store-events', () => ({ notifyCognitionWrite: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const uid = 'ontology-document-editor';
let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-document-edit-'));
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

async function harness() {
  const service = await import('../../../src/main/features/cognition/ontology/service');
  const { editOntologyDocument } = await import('../../../src/main/features/cognition/ontology/document-edit');
  await service.commitOntologyCommand(uid, { commandId: 'seed-edit', expectedRevision: 0, actions: [
    { intent: 'create', recordId: 'module', sourceLabel: 'seed', record: { kind: 'module', name: '项目', description: '', scope: { kind: 'personal' } } },
    { intent: 'create', recordId: 'type', sourceLabel: 'seed', record: { kind: 'definition', moduleId: 'module', name: '人', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' } },
    { intent: 'create', recordId: 'person-a', sourceLabel: 'seed', record: { kind: 'entity', moduleId: 'module', typeId: 'type', name: '甲', description: '', aliases: [], identityStatus: 'confirmed' } },
    { intent: 'create', recordId: 'person-b', sourceLabel: 'seed', record: { kind: 'entity', moduleId: 'module', typeId: 'type', name: '乙', description: '', aliases: [], identityStatus: 'confirmed' } },
    { intent: 'create', recordId: 'attribute', sourceLabel: 'seed', record: { kind: 'definition', moduleId: 'module', name: '年龄', description: '', definitionKind: 'attribute', subjectTypes: ['type'], objectTypes: [], valueType: 'number', cardinality: 'one', cardinalityAnchor: 'subject' } },
    { intent: 'create', recordId: 'fact', sourceLabel: 'seed', record: { kind: 'assertion', moduleId: 'module', subjectId: 'person-a', definitionId: 'attribute', object: { kind: 'literal', valueType: 'number', value: 20 }, validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } } },
    { intent: 'create', recordId: 'flag-definition', sourceLabel: 'seed', record: { kind: 'definition', moduleId: 'module', name: '参与', description: '', definitionKind: 'attribute', subjectTypes: ['type'], objectTypes: [], valueType: 'boolean', cardinality: 'one', cardinalityAnchor: 'subject' } },
    { intent: 'create', recordId: 'flag-fact', sourceLabel: 'seed', record: { kind: 'assertion', moduleId: 'module', subjectId: 'person-a', definitionId: 'flag-definition', object: { kind: 'literal', valueType: 'boolean', value: false }, validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } } },
    { intent: 'create', recordId: 'date-definition', sourceLabel: 'seed', record: { kind: 'definition', moduleId: 'module', name: '生日', description: '', definitionKind: 'attribute', subjectTypes: ['type'], objectTypes: [], valueType: 'date', cardinality: 'one', cardinalityAnchor: 'subject' } },
    { intent: 'create', recordId: 'date-fact', sourceLabel: 'seed', record: { kind: 'assertion', moduleId: 'module', subjectId: 'person-a', definitionId: 'date-definition', object: { kind: 'literal', valueType: 'date', value: '2000-01-01' }, validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } } },
  ] });
  return { service, editOntologyDocument };
}

describe('canonical ontology document editing', () => {
  it('edits a definition, reads the canonical result and returns an idempotent receipt', async () => {
    const { service, editOntologyDocument } = await harness();
    const input = { commandId: 'edit-definition', recordId: 'attribute', expectedRevision: 1, expectedVersion: 1,
      changes: { name: '岁数', subjectTypes: ['type'], cardinality: 'many' } };
    const first = await editOntologyDocument(uid, input);
    expect(first).toMatchObject({ duplicate: false, recordId: 'attribute', receipt: { revision: 2, changedIds: ['attribute'] } });
    expect(first.ontology.records.attribute).toMatchObject({ name: '岁数', cardinality: 'many', version: 2 });
    expect(service.readOntologyDocument(uid).records.attribute).toMatchObject({ name: '岁数', version: 2 });
    const retry = await editOntologyDocument(uid, input);
    expect(retry.duplicate).toBe(true);
    expect(retry.receipt).toEqual(first.receipt);
    expect(service.readOntologyDocument(uid).revision).toBe(2);
    await expect(editOntologyDocument(uid, { ...input, changes: { name: '另一个名字' } })).rejects.toMatchObject({ code: 'command_reused' });
  });

  it('corrects a fact through a successor while retaining the old fact and history', async () => {
    const { service, editOntologyDocument } = await harness();
    const input = { commandId: 'correct-fact', recordId: 'fact', expectedRevision: 1, expectedVersion: 1,
      changes: { 'object.value': 21, subjectId: 'person-b', certainty: 'inferred' } };
    const result = await editOntologyDocument(uid, input);
    expect(result.recordId).not.toBe('fact');
    expect(result.ontology.records.fact).toMatchObject({ status: 'corrected', object: { value: 20 } });
    expect(result.ontology.records[result.recordId]).toMatchObject({ status: 'active', subjectId: 'person-b', object: { value: 21 }, supersedesId: 'fact', certainty: 'inferred' });
    expect(service.readOntologyDocument(uid).history.filter(entry => entry.commandId === input.commandId).map(entry => entry.intent)).toEqual(['mark_corrected', 'correct']);
    expect((await editOntologyDocument(uid, input)).recordId).toBe(result.recordId);
  });

  it('rejects stale baselines, illegal refs and metadata patches without writing', async () => {
    const { service, editOntologyDocument } = await harness();
    const base = { recordId: 'attribute', expectedRevision: 1, expectedVersion: 1 };
    await editOntologyDocument(uid, { ...base, commandId: 'first-edit', changes: { description: '说明' } });
    await expect(editOntologyDocument(uid, { ...base, commandId: 'stale-edit', changes: { name: '过期' } })).rejects.toMatchObject({ code: 'baseline_changed' });
    await expect(editOntologyDocument(uid, { ...base, commandId: 'bad-ref', expectedRevision: 2, expectedVersion: 2,
      changes: { subjectTypes: ['missing-type'] } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(editOntologyDocument(uid, { ...base, commandId: 'bad-meta', expectedRevision: 2, expectedVersion: 2,
      changes: { moduleId: 'elsewhere' } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(editOntologyDocument(uid, { ...base, commandId: 'empty-name', expectedRevision: 2, expectedVersion: 2,
      changes: { name: '   ' } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(editOntologyDocument(uid, { commandId: 'bad-number', recordId: 'fact', expectedRevision: 2, expectedVersion: 1,
      changes: { 'object.value': '21' } })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(service.readOntologyDocument(uid).revision).toBe(2);
    expect(service.readOntologyDocument(uid).history.filter(entry => entry.after.id === 'attribute').length).toBe(2);
  });

  it('serializes competing edits against one canonical revision', async () => {
    const { service, editOntologyDocument } = await harness();
    const baseline = { recordId: 'person-a', expectedRevision: 1, expectedVersion: 1 };
    const settled = await Promise.allSettled([
      editOntologyDocument(uid, { ...baseline, commandId: 'competing-a', changes: { description: 'A' } }),
      editOntologyDocument(uid, { ...baseline, commandId: 'competing-b', changes: { description: 'B' } }),
    ]);
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((settled.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('baseline_changed');
    expect(service.readOntologyDocument(uid).revision).toBe(2);
    expect(service.readOntologyDocument(uid).history.filter(entry => entry.after.id === 'person-a')).toHaveLength(2);
  });

  it('preserves boolean and date fact value types through correction history', async () => {
    const { service, editOntologyDocument } = await harness();
    const flag = await editOntologyDocument(uid, { commandId: 'correct-flag', recordId: 'flag-fact', expectedRevision: 1,
      expectedVersion: 1, changes: { 'object.value': true } });
    expect(flag.ontology.records['flag-fact']).toMatchObject({ status: 'corrected', object: { valueType: 'boolean', value: false } });
    expect(flag.ontology.records[flag.recordId]).toMatchObject({ status: 'active', object: { valueType: 'boolean', value: true } });
    await expect(editOntologyDocument(uid, { commandId: 'bad-date', recordId: 'date-fact', expectedRevision: 2,
      expectedVersion: 1, changes: { 'object.value': '2026-02-30' } })).rejects.toMatchObject({ code: 'invalid_input' });
    const date = await editOntologyDocument(uid, { commandId: 'correct-date', recordId: 'date-fact', expectedRevision: 2,
      expectedVersion: 1, changes: { 'object.value': '2001-02-28' } });
    expect(date.ontology.records['date-fact']).toMatchObject({ status: 'corrected', object: { valueType: 'date', value: '2000-01-01' } });
    expect(date.ontology.records[date.recordId]).toMatchObject({ status: 'active', object: { valueType: 'date', value: '2001-02-28' } });
    expect(service.readOntologyDocument(uid).revision).toBe(3);
  });

  it('keeps canonical legacy source records read only at the IPC service boundary', async () => {
    const service = await import('../../../src/main/features/cognition/ontology/service');
    const { editOntologyDocument } = await import('../../../src/main/features/cognition/ontology/document-edit');
    await service.commitOntologyCommand(uid, { commandId: 'legacy-seed', expectedRevision: 0, actions: [
      { intent: 'create', recordId: 'legacy-module', sourceLabel: 'migration', record: { kind: 'module', name: '旧模块', description: '', scope: { kind: 'personal' } } },
    ] }, { kind: 'legacy', recordId: 'legacy-source', label: '旧资料' });
    expect(service.readOntologyDocument(uid).records['legacy-module'].source.kind).toBe('legacy');
    await expect(editOntologyDocument(uid, { commandId: 'legacy-edit', recordId: 'legacy-module', expectedRevision: 1,
      expectedVersion: 1, changes: { name: '被改写' } })).rejects.toMatchObject({ code: 'legacy_read_only' });
    expect(service.readOntologyDocument(uid).revision).toBe(1);
    expect(service.readOntologyDocument(uid).records['legacy-module']).toMatchObject({ name: '旧模块', version: 1 });
  });

  it('edits module scope notes and summary points, and rejects unavailable evidence', async () => {
    const { service, editOntologyDocument } = await harness();
    const result = await editOntologyDocument(uid, { commandId: 'edit-summary', recordId: 'module', expectedRevision: 1,
      expectedVersion: 1, changes: {
        scopeNote: '这份本体描述项目，不是个人偏好。',
        summaryPoints: [{ text: '甲有年龄。', evidenceIds: ['fact'] }],
      } });
    expect(result.ontology.records.module).toMatchObject({
      scopeNote: '这份本体描述项目，不是个人偏好。',
      summaryPoints: [{ text: '甲有年龄。', evidenceIds: ['fact'] }],
      version: 2,
    });
    await expect(editOntologyDocument(uid, { commandId: 'bad-summary', recordId: 'module', expectedRevision: 2,
      expectedVersion: 2, changes: { summaryPoints: [{ text: '坏依据', evidenceIds: ['missing'] }] } }))
      .rejects.toMatchObject({ code: 'invalid_reference' });
    expect(service.readOntologyDocument(uid).records.module).toMatchObject({ version: 2,
      summaryPoints: [{ text: '甲有年龄。', evidenceIds: ['fact'] }] });
  });
});
