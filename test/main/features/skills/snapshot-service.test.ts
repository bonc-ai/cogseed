import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  captureSkillTree,
  materializeSkillTree,
  normalizeSkillSnapshotFiles,
  normalizeSkillSnapshotPath,
  snapshotSkillFiles,
} from '../../../../src/main/features/skills/snapshot-service';

const roots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-skill-snapshot-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Skill tree snapshots', () => {
  it.each([
    '/etc/passwd',
    '\\etc\\passwd',
    'C:\\Windows\\system.ini',
    'C:/Windows/system.ini',
    '\\\\server\\share\\file.txt',
    '../escape.txt',
    'references/../../escape.txt',
  ])('rejects unsafe snapshot path %j', (value) => {
    expect(() => normalizeSkillSnapshotPath(value)).toThrow(/invalid skill snapshot path/);
  });

  it('normalizes ordering and produces a stable manifest hash', () => {
    const first = snapshotSkillFiles([
      { path: 'scripts/run.js', content: 'module.exports = 1;\n' },
      { path: 'SKILL.md', content: '---\nname: stable\ndescription: stable\n---\n' },
      { path: 'references/guide.md', content: '# Guide\n' },
    ]);
    const second = snapshotSkillFiles([...first.files].reverse());

    expect(first.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/guide.md',
      'scripts/run.js',
    ]);
    expect(second).toEqual(first);
  });

  it('rejects duplicate paths and mismatched content hashes', () => {
    expect(() => normalizeSkillSnapshotFiles([
      { path: 'SKILL.md', content: 'one' },
      { path: 'SKILL.md', content: 'two' },
    ])).toThrow(/duplicate/);
    expect(() => normalizeSkillSnapshotFiles([
      { path: 'SKILL.md', content: 'one', contentHash: '0'.repeat(64) },
    ])).toThrow(/hash mismatch/);
  });

  it('captures and materializes the complete authored file tree', async () => {
    const source = tempDir();
    fs.mkdirSync(path.join(source, 'references'), { recursive: true });
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: full\ndescription: full\n---\n');
    fs.writeFileSync(path.join(source, 'references', 'guide.md'), '# Guide\n');
    fs.writeFileSync(path.join(source, 'scripts', 'run.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(source, '_meta.json'), '{"ignored":true}\n');

    const captured = await captureSkillTree(source);
    expect(captured.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/guide.md',
      'scripts/run.js',
    ]);

    const target = tempDir();
    const materialized = await materializeSkillTree(target, captured.files);
    expect(materialized.manifestHash).toBe(captured.manifestHash);
    expect(await captureSkillTree(target)).toEqual(captured);
  });

  it('refuses symbolic links instead of following them', async () => {
    const source = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: link\ndescription: link\n---\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(source, 'secret.txt'));

    await expect(captureSkillTree(source)).rejects.toThrow(/symlink is not allowed/);
  });
});
