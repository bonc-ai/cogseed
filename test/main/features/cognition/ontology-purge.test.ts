import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cognitionStorePath } from '../../../../src/main/features/cognition_kernel/store';
import { scrubOntologyArchives, scrubOntologyDocument } from '../../../../src/main/features/cognition/ontology/purge';
import { validateOntologyDocument } from '../../../../src/main/features/cognition/ontology/model';

const now = '2026-01-01T00:00:00.000Z';
const marker = 'SYNTHETIC_PURGED_ONTOLOGY_BODY';

function fixture() {
  const module = {
    id: 'mod1', kind: 'module' as const, version: 1, status: 'active' as const, access: 'task' as const,
    createdAt: now, updatedAt: now, source: { kind: 'legacy' as const, label: 'Synthetic' },
    name: 'Module', description: '', scope: { kind: 'personal' as const },
  };
  const rule = {
    id: 'rule1', kind: 'rule' as const, moduleId: 'mod1', version: 1, status: 'active' as const, access: 'task' as const,
    createdAt: now, updatedAt: now,
    source: { kind: 'user' as const, label: 'Synthetic', refs: [{ kind: 'asset' as const, id: 'aa-purge' }] },
    name: marker, requirement: marker, strength: 'default' as const, condition: null, effect: { kind: 'note' as const }, exception: '',
  };
  const peer = {
    ...rule, id: 'rule2', name: 'Peer rule', requirement: 'Peer requirement',
    source: { kind: 'user' as const, label: 'Synthetic', refs: [{ kind: 'asset' as const, id: 'aa-peer' }] },
  };
  const doc = {
    schemaVersion: 1 as const, ownerId: 'user', revision: 1,
    records: { mod1: module, rule1: rule, rule2: peer },
    history: [
      { commandId: 'cmd0', revision: 1, intent: marker, recordedAt: now, after: rule },
      { commandId: 'cmd1', revision: 1, intent: 'create', recordedAt: now, after: peer },
    ],
    receipts: {
      cmd0: { commandId: 'cmd0', requestHash: 'a'.repeat(64), revision: 1, recordedAt: now, changedIds: ['rule1'] },
      cmd1: { commandId: 'cmd1', requestHash: 'b'.repeat(64), revision: 1, recordedAt: now, changedIds: ['rule2'] },
    },
  };
  return { doc, rule, peer };
}

function effectFixture() {
  const doc = structuredClone(fixture().doc) as any;
  const base = doc.records.rule1;
  const effectRule = {
    ...base, id: 'rule-effect', name: marker, requirement: marker, exception: marker,
    condition: { kind: 'task', field: 'purpose', equals: marker },
    effect: { kind: 'required_section', name: marker },
  };
  const choiceRule = {
    ...base, id: 'rule-choice', name: marker, requirement: marker,
    condition: { kind: 'all', conditions: [
      { kind: 'task', field: 'purpose', equals: marker },
      { kind: 'not', condition: { kind: 'task', field: 'taskKind', equals: 'weekly_report' } },
    ] },
    effect: { kind: 'choice', key: marker, value: marker },
  };
  const entityRule = {
    ...base, id: 'rule-entity', name: 'Entity binding', requirement: 'Keep the entity binding',
    condition: { kind: 'task', field: 'entityId', equals: 'aa-entity' },
    effect: { kind: 'include_recipient', entityId: 'aa-entity' },
  };
  Object.assign(doc.records, { 'rule-effect': effectRule, 'rule-choice': choiceRule, 'rule-entity': entityRule });
  doc.revision = 2;
  const batch = { commandId: 'cmd2', revision: 2, intent: 'create', recordedAt: now };
  doc.history.push(
    { ...batch, after: effectRule },
    { ...batch, after: choiceRule },
    { ...batch, after: entityRule },
  );
  doc.receipts.cmd2 = { commandId: 'cmd2', requestHash: 'c'.repeat(64), revision: 2, recordedAt: now,
    changedIds: ['rule-effect', 'rule-choice', 'rule-entity'] };
  return { doc, effectRule, choiceRule, entityRule };
}

describe('ontology purge', () => {
  it('scrubs purged record text and history while keeping the graph skeleton and peer content', () => {
    const { doc, rule } = fixture();
    expect(() => validateOntologyDocument(doc)).not.toThrow();
    const { document, result } = scrubOntologyDocument(doc, 'aa-purge');

    expect(result.changed).toBe(true);
    expect(result.recordIds).toEqual(['rule1']);
    expect(document.records.rule1).toMatchObject({ id: 'rule1', kind: 'rule', version: 1 });
    expect((document.records.rule1 as typeof rule).name).toBe('[已清除]');
    expect((document.records.rule1 as typeof rule).requirement).toBe('');
    expect(document.history[0].intent).toBe('purged');
    expect(JSON.stringify(document)).not.toContain(marker);
    expect((document.records.rule2 as typeof rule).name).toBe('Peer rule');
    expect((document.records.rule2 as typeof rule).requirement).toBe('Peer requirement');
    expect(() => validateOntologyDocument(document)).not.toThrow();
  });

  it('scrubs rule effects and task-purpose conditions while keeping machine refs', () => {
    const { doc } = effectFixture();
    expect(() => validateOntologyDocument(doc)).not.toThrow();
    const { document } = scrubOntologyDocument(doc, 'aa-purge');

    expect(JSON.stringify(document)).not.toContain(marker);
    const effectRule = document.records['rule-effect'] as any;
    expect(effectRule.effect).toEqual({ kind: 'required_section', name: '[已清除]' });
    expect(effectRule.condition).toEqual({ kind: 'task', field: 'purpose', equals: '[已清除]' });

    const choiceRule = document.records['rule-choice'] as any;
    expect(choiceRule.effect).toEqual({ kind: 'choice', key: '[已清除]', value: '' });
    expect(choiceRule.condition.conditions[1].condition).toEqual({ kind: 'task', field: 'taskKind', equals: 'weekly_report' });

    const entityRule = document.records['rule-entity'] as any;
    expect(entityRule.condition).toEqual({ kind: 'task', field: 'entityId', equals: 'aa-entity' });
    expect(entityRule.effect).toEqual({ kind: 'include_recipient', entityId: 'aa-entity' });
    expect(() => validateOntologyDocument(document)).not.toThrow();
  });

  it('scrubs archived history and receipts for the purged records', async () => {
    const previous = process.env.COGSEED_WORKSPACE_ROOT;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-purge-archive-'));
    process.env.COGSEED_WORKSPACE_ROOT = root;
    try {
      const { doc, rule } = fixture();
      const { effectRule } = effectFixture();
      const storeFile = cognitionStorePath('user');
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      const archive = `${storeFile}.archive-test.jsonl`;
      fs.writeFileSync(archive, [
        JSON.stringify({ kind: 'history', entry: { commandId: 'cmd0', revision: 1, intent: marker, recordedAt: now, after: rule } }),
        JSON.stringify({ kind: 'history', entry: { commandId: 'cmd2', revision: 2, intent: 'create', recordedAt: now, after: effectRule } }),
        JSON.stringify({ kind: 'receipt', commandId: 'cmd0', receipt: {
          commandId: 'cmd0', requestHash: 'a'.repeat(64), revision: 1, recordedAt: now, changedIds: ['rule1'],
          userEditDecision: { patch: marker },
        } }),
      ].join('\n') + '\n');

      expect(await scrubOntologyArchives('user', 'aa-purge', ['rule1', 'rule-effect'])).toBe(1);
      const raw = fs.readFileSync(archive, 'utf8');
      expect(raw).not.toContain(marker);
      expect(raw).not.toContain('userEditDecision');
      const archivedEffect = raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
        .find(row => row.entry?.after?.id === 'rule-effect').entry.after;
      expect(archivedEffect.effect).toEqual({ kind: 'required_section', name: '[已清除]' });
      expect(archivedEffect.condition).toEqual({ kind: 'task', field: 'purpose', equals: '[已清除]' });
      expect(() => validateOntologyDocument(doc)).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
      else process.env.COGSEED_WORKSPACE_ROOT = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
