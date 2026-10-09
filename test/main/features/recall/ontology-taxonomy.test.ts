import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-taxonomy-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Ontology T-Box taxonomy', () => {
  it('loads the group ledger with titles and field vocabulary', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const taxonomy = await import('../../../../src/main/features/recall/ontology-taxonomy');

    const group = await groups.createGroup('tbox-user', '工作方式');
    const groupId = group.group!.group_id;
    // Seed two field values so listGroupFields sees a vocabulary.
    await groups.appendFieldValue('tbox-user', groupId, '工作节奏', '上午专注', '手动');

    const loaded = await taxonomy.loadOntologyTaxonomy('tbox-user');
    expect(loaded.groups).toHaveLength(1);
    expect(loaded.groups[0]).toMatchObject({
      groupId,
      title: '工作方式',
    });
    expect(loaded.groups[0].fields.map((field) => field.name)).toContain('工作节奏');
  });

  it('returns empty groups for a fresh user and tolerates a broken group file', async () => {
    const taxonomy = await import('../../../../src/main/features/recall/ontology-taxonomy');
    expect((await taxonomy.loadOntologyTaxonomy('tbox-user')).groups).toEqual([]);
    expect(taxonomy.ontologyGroupExists('tbox-user', 'nope')).toBe(false);
  });

  it('validates group existence synchronously against the ledger', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const taxonomy = await import('../../../../src/main/features/recall/ontology-taxonomy');

    const group = await groups.createGroup('tbox-user', '决策习惯');
    expect(taxonomy.ontologyGroupExists('tbox-user', group.group!.group_id)).toBe(true);
    expect(taxonomy.ontologyGroupExists('tbox-user', 'does-not-exist')).toBe(false);
  });
});
