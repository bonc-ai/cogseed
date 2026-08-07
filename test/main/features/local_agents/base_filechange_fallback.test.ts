import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  snapshotWorkingDir,
  diffWorkingDirSnapshots,
} from '../../../../src/main/features/local_agents/backends/base';

// Regression coverage for the T2-04 gap: codex writing files via
// `exec_command` (arbitrary shell) never emits `turn/diff/updated`, so the
// only way to detect the resulting file-change is a before/after snapshot
// of the working directory. See the doc comment above `snapshotWorkingDir`
// in codex.ts for the full rationale.
describe('local_agents/backends/codex › working-dir snapshot fallback', () => {
  function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-snapshot-test-'));
  }

  it('detects a new file created after the snapshot (exec_command-style write)', () => {
    const dir = mkTmpDir();
    try {
      const before = snapshotWorkingDir(dir);
      fs.writeFileSync(path.join(dir, 'NOTES.md'), 'hello');
      const after = snapshotWorkingDir(dir);
      const changed = diffWorkingDirSnapshots(before, after);
      expect(changed).toEqual([path.join(dir, 'NOTES.md')]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a modification to an existing file (size + mtime change)', () => {
    const dir = mkTmpDir();
    try {
      const target = path.join(dir, 'existing.txt');
      fs.writeFileSync(target, 'v1');
      const before = snapshotWorkingDir(dir);
      // Ensure mtime resolution ticks forward on fast filesystems.
      const future = Date.now() / 1000 + 2;
      fs.writeFileSync(target, 'v1-modified-longer');
      fs.utimesSync(target, future, future);
      const after = snapshotWorkingDir(dir);
      const changed = diffWorkingDirSnapshots(before, after);
      expect(changed).toEqual([target]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports nothing when the directory is untouched', () => {
    const dir = mkTmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'unchanged.txt'), 'static');
      const before = snapshotWorkingDir(dir);
      const after = snapshotWorkingDir(dir);
      expect(diffWorkingDirSnapshots(before, after)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not report deletions (only additions/modifications surface as artifacts)', () => {
    const dir = mkTmpDir();
    try {
      const target = path.join(dir, 'to-delete.txt');
      fs.writeFileSync(target, 'bye');
      const before = snapshotWorkingDir(dir);
      fs.rmSync(target);
      const after = snapshotWorkingDir(dir);
      expect(diffWorkingDirSnapshots(before, after)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips noisy directories like node_modules and .git', () => {
    const dir = mkTmpDir();
    try {
      fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'noop');
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');
      const snap = snapshotWorkingDir(dir);
      expect(snap.size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
