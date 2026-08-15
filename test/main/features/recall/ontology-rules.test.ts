import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ontology-rules-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Ontology R-Box (relation rules)', () => {
  it('extracts A → B relation-shaped field values as durable business rules', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const rules = await import('../../../../src/main/features/recall/ontology-rules');

    const group = await groups.createGroup('rule-user', '技术栈');
    await groups.appendFieldValue('rule-user', group.group!.group_id, '工具', 'React → 前端框架', '手动');
    await groups.appendFieldValue('rule-user', group.group!.group_id, '工具', 'Python → 后端语言', '手动');
    // Non-relation-shaped value in the same field stays an A-Box fact.
    await groups.appendFieldValue('rule-user', group.group!.group_id, '工具', '每天写代码', '手动');

    const loaded = await rules.loadOntologyRules('rule-user');
    expect(loaded.rules).toHaveLength(2);
    expect(loaded.rules[0]).toMatchObject({
      groupId: group.group!.group_id,
      groupTitle: '技术栈',
      field: '工具',
      subject: 'React',
      object: '前端框架',
    });
    expect(loaded.rules[0].id).toMatch(/^ontr-[a-z0-9]+$/);
    expect(loaded.rules.map((rule) => rule.subject).sort()).toEqual(['Python', 'React']);
  });

  it('parses only relation-shaped values; non-relation values are ignored', () => {
    const rules = require('../../../../src/main/features/recall/ontology-rules');
    expect(rules.parseRelationValue('React → 前端框架')).toEqual({
      subject: 'React', relation: 'relates_to', object: '前端框架',
    });
    expect(rules.parseRelationValue('React -> Vue')).toEqual({
      subject: 'React', relation: 'relates_to', object: 'Vue',
    });
    expect(rules.parseRelationValue('plain value without arrow')).toBeNull();
    expect(rules.parseRelationValue('')).toBeNull();
  });

  it('returns no rules for a fresh user or values without relation shape', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const rules = await import('../../../../src/main/features/recall/ontology-rules');

    expect((await rules.loadOntologyRules('rule-user')).rules).toEqual([]);

    const group = await groups.createGroup('rule-user', '普通组');
    await groups.appendFieldValue('rule-user', group.group!.group_id, '工作节奏', '上午专注', '手动');
    expect((await rules.loadOntologyRules('rule-user')).rules).toEqual([]);
  });
});
