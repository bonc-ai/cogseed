import { describe, expect, it } from 'vitest';
import { applyOntologyCommand, type OntologyCommand } from '../../../src/main/features/cognition/ontology/commands';
import { emptyOntologyDocument, validateOntologyRecord } from '../../../src/main/features/cognition/ontology/model';

const uid = 'ontology-summary-points-user';
const now = '2026-10-22T00:00:00Z';
const base = { id: 'module', version: 1, status: 'active', access: 'task', certainty: 'confirmed',
  createdAt: null, updatedAt: null, source: { kind: 'user', label: '用户确认' } };
const moduleValue = (overrides: Record<string, unknown> = {}) => ({
  ...base, kind: 'module', name: '本体', description: '', scope: { kind: 'personal' }, ...overrides,
});
const create = (recordId: string, record: Record<string, unknown>) => ({
  intent: 'create' as const, recordId, sourceLabel: '验收', record,
});
const rule = (moduleId = 'module', overrides: Record<string, unknown> = {}) => ({
  kind: 'rule', moduleId, name: '规则', requirement: '需要审批', strength: 'required',
  condition: null, effect: { kind: 'note' }, exception: '', ...overrides,
});
const run = (actions: OntologyCommand['actions'], commandId = 'summary-seed', expectedRevision = 0) =>
  applyOntologyCommand(emptyOntologyDocument(uid), { commandId, expectedRevision, actions }, now);

describe('ontology summary points', () => {
  it('accepts optional summary fields without changing legacy modules', () => {
    expect(validateOntologyRecord(moduleValue())).toMatchObject({ kind: 'module', name: '本体' });
    expect(validateOntologyRecord(moduleValue({
      scopeNote: '这份本体描述的是产品，不是个人偏好。',
      summaryPoints: [{ text: '一条结论。', evidenceIds: ['rule'] }],
    }))).toMatchObject({ summaryPoints: [{ text: '一条结论。', evidenceIds: ['rule'] }] });
  });

  it('rejects malformed summary fields before they reach the store', () => {
    expect(() => validateOntologyRecord(moduleValue({ summaryPoints: [{ text: ' ', evidenceIds: ['rule'] }] }))).toThrow(/invalid ontology record/);
    expect(() => validateOntologyRecord(moduleValue({ summaryPoints: [{ text: '结论', evidenceIds: [] }] }))).toThrow(/invalid ontology record/);
    expect(() => validateOntologyRecord(moduleValue({ summaryPoints: [{ text: '结论', evidenceIds: ['rule', 'rule'] }] }))).toThrow(/invalid ontology record/);
    expect(() => validateOntologyRecord(moduleValue({ summaryPoints: Array.from({ length: 6 }, (_, index) => ({ text: `结论${index}`, evidenceIds: ['rule'] })) }))).toThrow(/invalid ontology record/);
    expect(() => validateOntologyRecord(moduleValue({ scopeNote: 'x'.repeat(301) }))).toThrow(/invalid ontology record/);
    expect(() => validateOntologyRecord(moduleValue({ summaryPoint: [] }))).toThrow(/invalid ontology record/);
  });

  it('creates a module and its same-module evidence atomically', () => {
    const result = run([
      create('module', { kind: 'module', name: '本体', description: '', scope: { kind: 'personal' },
        summaryPoints: [{ text: '一条结论。', evidenceIds: ['rule'] }] }),
      create('rule', rule()),
    ]);
    expect(result.document.records.module).toMatchObject({
      summaryPoints: [{ text: '一条结论。', evidenceIds: ['rule'] }],
    });
    expect(result.receipt.changedIds).toEqual(['module', 'rule']);
  });

  it('rejects missing, cross-module, reference and module evidence', () => {
    expect(() => run([
      create('module', { kind: 'module', name: '本体', description: '', scope: { kind: 'personal' },
        summaryPoints: [{ text: '结论', evidenceIds: ['missing'] }] }),
    ])).toThrow(/summary evidence unavailable/);

    expect(() => run([
      create('module-a', { kind: 'module', name: '甲本体', description: '', scope: { kind: 'personal' },
        summaryPoints: [{ text: '结论', evidenceIds: ['rule-b'] }] }),
      create('module-b', { kind: 'module', name: '乙本体', description: '', scope: { kind: 'personal' } }),
      create('rule-b', rule('module-b')),
    ])).toThrow(/summary evidence unavailable/);

    expect(() => run([
      create('module-a', { kind: 'module', name: '甲本体', description: '', scope: { kind: 'personal' },
        summaryPoints: [{ text: '结论', evidenceIds: ['ref-b'] }] }),
      create('module-b', { kind: 'module', name: '乙本体', description: '', scope: { kind: 'personal' } }),
      create('ref-b', { kind: 'reference', moduleId: 'module-a', targetModuleId: 'module-b', versionPolicy: 'current' }),
    ])).toThrow(/summary evidence unavailable/);

    expect(() => run([
      create('module-a', { kind: 'module', name: '甲本体', description: '', scope: { kind: 'personal' },
        summaryPoints: [{ text: '结论', evidenceIds: ['module-b'] }] }),
      create('module-b', { kind: 'module', name: '乙本体', description: '', scope: { kind: 'personal' } }),
    ])).toThrow(/summary evidence unavailable/);
  });

  it('rejects evidence that exceeds a task module access', () => {
    expect(() => run([
      create('module', { kind: 'module', name: '本体', description: '', scope: { kind: 'personal' },
        summaryPoints: [{ text: '结论', evidenceIds: ['rule'] }] }),
      create('rule', rule('module', { access: 'owner_only' })),
    ])).toThrow(/summary evidence exceeds module access/);
  });

  it('allows inactive evidence at write time and does not block ordinary module edits after evidence is archived', () => {
    let doc = run([
      create('module', { kind: 'module', name: '本体', description: '', scope: { kind: 'personal' } }),
      create('rule', rule()),
    ]).document;
    doc = applyOntologyCommand(doc, {
      commandId: 'archive-rule', expectedRevision: doc.revision,
      actions: [{ intent: 'archive', recordId: 'rule', expectedVersion: 1, sourceLabel: '验收停用' }],
    }, now).document;
    doc = applyOntologyCommand(doc, {
      commandId: 'add-summary-with-inactive-evidence', expectedRevision: doc.revision,
      actions: [{ intent: 'update', recordId: 'module', expectedVersion: 1, sourceLabel: '验收整理',
        patch: { summaryPoints: [{ text: '停用证据仍可作为历史依据。', evidenceIds: ['rule'] }] } }],
    }, now).document;
    expect(doc.records.module.summaryPoints).toHaveLength(1);
    expect(doc.records.rule.status).toBe('archived');
    expect(() => applyOntologyCommand(doc, {
      commandId: 'rename-module-after-archive', expectedRevision: doc.revision,
      actions: [{ intent: 'update', recordId: 'module', expectedVersion: 2, sourceLabel: '验收改名', patch: { name: '新名字' } }],
    }, now)).not.toThrow();
  });
});
