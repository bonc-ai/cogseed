import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'version-mutation-user';
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-version-mutation-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
});

afterEach(() => {
  delete process.env.ORKAS_WORKSPACE_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Skill version mutation recovery', () => {
  it('restores an interrupted backup and is idempotent', async () => {
    const snapshot = await import('../../../../src/main/features/skills/snapshot-service');
    const versions = await import('../../../../src/main/features/skills/version-store');
    const mutation = await import('../../../../src/main/features/skills/version-mutation-service');
    const finalDir = path.join(root, USER, 'cloud', 'skills', 'recoverable');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), 'old\n');
    const oldTree = await snapshot.captureSkillTree(finalDir);
    const oldVersion = await versions.appendFullSkillVersion(USER, 'recoverable', {
      operation: 'install',
      files: oldTree.files,
      source: { kind: 'manual_edit' },
      security: { outcome: 'pass', findingCount: 0 },
    });

    const parent = path.dirname(finalDir);
    const token = 'interrupted';
    const backupDir = path.join(parent, `.cogseed-backup-recoverable-${token}`);
    const stageDir = path.join(parent, `.cogseed-stage-recoverable-${token}`);
    fs.renameSync(finalDir, backupDir);
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(path.join(stageDir, 'SKILL.md'), 'new\n');
    fs.mkdirSync(path.dirname(mutation.skillMutationJournalFile(USER, 'recoverable')), { recursive: true });
    fs.writeFileSync(mutation.skillMutationJournalFile(USER, 'recoverable'), JSON.stringify({
      schemaVersion: 1,
      userId: USER,
      skillId: 'recoverable',
      phase: 'backed_up',
      finalDir,
      stageDir,
      backupDir,
      hadOriginal: true,
      previousEnvelope: {
        schemaVersion: 2,
        skillId: 'recoverable',
        currentRevisionId: oldVersion.revisionId,
        records: [oldVersion],
      },
    }), 'utf8');

    await expect(mutation.recoverSkillVersionMutations(USER)).resolves.toMatchObject({ restored: 1 });
    expect(fs.readFileSync(path.join(finalDir, 'SKILL.md'), 'utf8')).toBe('old\n');
    await expect(versions.readSkillVersionEnvelope(USER, 'recoverable')).resolves.toMatchObject({
      currentRevisionId: oldVersion.revisionId,
    });
    await expect(mutation.recoverSkillVersionMutations(USER)).resolves.toEqual({ finalized: 0, restored: 0, removed: 0 });
  });
});
