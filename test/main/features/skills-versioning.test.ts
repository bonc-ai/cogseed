import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'skills-versioning-user';
let root = '';
let previousHome: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-skills-versioning-'));
  previousHome = process.env.HOME;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  process.env.HOME = root;
  const users = await import('../../../src/main/features/users');
  users.activateUser(USER);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  delete process.env.ORKAS_WORKSPACE_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

function skillDir(): string {
  return path.join(root, USER, 'cloud', 'skills', 'bound-skill');
}

describe('versioned Recall Skill edits', () => {
  it('records a single complete manual-edit version for a multi-file edit', async () => {
    fs.mkdirSync(path.join(skillDir(), 'references'), { recursive: true });
    fs.mkdirSync(path.join(skillDir(), 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skillDir(), 'SKILL.md'), '---\nname: bound-skill\ndescription: test\n---\n');
    fs.writeFileSync(path.join(skillDir(), 'references', 'guide.md'), 'old\n');
    fs.writeFileSync(path.join(skillDir(), 'scripts', 'run.js'), 'module.exports = 1;\n');

    const skills = await import('../../../src/main/features/skills');
    const snapshots = await import('../../../src/main/features/skills/snapshot-service');
    const versions = await import('../../../src/main/features/skills/version-store');
    const bindings = await import('../../../src/main/features/recall/skill-binding-service');
    const initial = await snapshots.captureSkillTree(skillDir());
    const first = await versions.appendFullSkillVersion(USER, 'bound-skill', {
      operation: 'install',
      files: initial.files,
      source: { kind: 'recall_asset', assetId: 'asset-1', assetVersion: '1' },
      security: { outcome: 'pass', findingCount: 0 },
    });
    await bindings.createSkillBinding(USER, {
      assetId: 'asset-1',
      skillId: 'bound-skill',
      installedAssetVersion: '1',
      currentSkillVersion: first.version,
      currentRevisionId: first.revisionId,
      currentManifestHash: first.manifestHash!,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      decisions: [{ assetVersion: '1', action: 'installed', at: new Date().toISOString(), skillVersion: first.version }],
    });

    const results = await skills.writeSkillFilesForEditChecked('bound-skill', [
      { path: 'references/guide.md', content: 'new\n' },
      { path: 'scripts/run.js', content: 'module.exports = 2;\n' },
    ]);
    expect(results).toHaveLength(2);
    expect(results?.every((result) => result.ok)).toBe(true);
    const history = await versions.listSkillVersions(USER, 'bound-skill');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ operation: 'manual_edit', rollbackScope: 'full_tree' });
    expect(history[0].files?.find((file) => file.path === 'references/guide.md')?.content).toBe('new\n');
    expect(history[0].files?.find((file) => file.path === 'scripts/run.js')?.content).toBe('module.exports = 2;\n');
    await expect(bindings.readSkillBinding(USER, 'asset-1')).resolves.toMatchObject({
      currentRevisionId: history[0].revisionId,
      currentSkillVersion: history[0].version,
    });
  });
});
