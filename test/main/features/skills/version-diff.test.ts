import { describe, expect, it } from 'vitest';

import { snapshotSkillFiles } from '../../../../src/main/features/skills/snapshot-service';
import { diffSkillTrees } from '../../../../src/main/features/skills/version-diff';

function tree(files: Array<{ path: string; content: string }>) {
  return snapshotSkillFiles(files).files;
}

describe('Skill version diff', () => {
  it('reports added, modified, deleted, and unchanged files with line changes', () => {
    const before = tree([
      { path: 'SKILL.md', content: 'one\ntwo\n' },
      { path: 'references/old.md', content: 'old\n' },
      { path: 'scripts/same.js', content: 'same\n' },
    ]);
    const after = tree([
      { path: 'SKILL.md', content: 'one\nchanged\n' },
      { path: 'references/new.md', content: 'new\n' },
      { path: 'scripts/same.js', content: 'same\n' },
    ]);

    const diff = diffSkillTrees(before, after);
    expect(diff).toMatchObject({ added: 1, modified: 1, deleted: 1, unchanged: 1 });
    expect(diff.files.map((file) => [file.path, file.status])).toEqual([
      ['SKILL.md', 'modified'],
      ['references/new.md', 'added'],
      ['references/old.md', 'deleted'],
    ]);
    expect(diff.files[0].lines).toEqual(expect.arrayContaining([
      { type: 'deleted', text: 'two' },
      { type: 'added', text: 'changed' },
    ]));
  });

  it('returns an empty change list for identical manifests', () => {
    const files = tree([{ path: 'SKILL.md', content: 'same\n' }]);
    expect(diffSkillTrees(files, files)).toEqual({
      added: 0,
      modified: 0,
      deleted: 0,
      unchanged: 1,
      files: [],
    });
  });

  it('truncates line details for oversized text while preserving file metadata', () => {
    const before = tree([{ path: 'SKILL.md', content: `before\n${'a'.repeat(50_000)}` }]);
    const after = tree([{ path: 'SKILL.md', content: `after\n${'b'.repeat(50_000)}` }]);
    const diff = diffSkillTrees(before, after);

    expect(diff.modified).toBe(1);
    expect(diff.files[0]).toMatchObject({ path: 'SKILL.md', status: 'modified', truncated: true });
    expect(diff.files[0].lines).toBeUndefined();
  });
});
