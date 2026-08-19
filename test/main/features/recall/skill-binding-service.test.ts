import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'skill-binding-user';
let root = '';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-skill-bindings-'));
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(async () => {
  delete process.env.COGSEED_WORKSPACE_ROOT;
  await fs.rm(root, { recursive: true, force: true });
});

describe('Recall Skill binding service', () => {
  it('lists bindings and refreshes every asset attached to a Skill', async () => {
    const service = await import('../../../../src/main/features/recall/skill-binding-service');
    const base = {
      skillId: 'skill-stable',
      installedAssetVersion: '1',
      currentSkillVersion: '2',
      currentRevisionId: 'revision-2',
      currentManifestHash: 'a'.repeat(64),
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
      decisions: [{ assetVersion: '1', action: 'installed' as const, at: '2026-08-17T00:00:00.000Z', skillVersion: '2' }],
    };
    await service.createSkillBinding(UID, { assetId: 'asset-a', ...base });
    await service.createSkillBinding(UID, { assetId: 'asset-b', ...base });
    await service.createSkillBinding(UID, {
      assetId: 'asset-other',
      ...base,
      skillId: 'skill-other',
    });

    expect((await service.listSkillBindings(UID)).map((item) => item.assetId).sort()).toEqual([
      'asset-a', 'asset-b', 'asset-other',
    ]);
    await service.refreshBindingsForSkill(UID, 'skill-stable', '3', 'revision-3', 'b'.repeat(64));
    await expect(service.readSkillBinding(UID, 'asset-a')).resolves.toMatchObject({
      currentSkillVersion: '3', currentRevisionId: 'revision-3', currentManifestHash: 'b'.repeat(64),
    });
    await expect(service.readSkillBinding(UID, 'asset-other')).resolves.toMatchObject({ currentSkillVersion: '2' });
  });

  it('identifies stale bindings and explicit rejection decisions', async () => {
    const service = await import('../../../../src/main/features/recall/skill-binding-service');
    const binding = await service.createSkillBinding(UID, {
      assetId: 'asset-a',
      skillId: 'skill-a',
      installedAssetVersion: '2',
      currentSkillVersion: '4',
      currentRevisionId: 'revision-4',
      currentManifestHash: 'c'.repeat(64),
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
      decisions: [{ assetVersion: '2', action: 'rejected', at: '2026-08-17T00:00:00.000Z' }],
    });
    expect(service.bindingIsStale(binding, '3')).toBe(true);
    expect(service.bindingIsStale(binding, '2')).toBe(false);
    expect(service.bindingHasDecision(binding, '2', ['rejected'])).toBe(true);
    expect(service.bindingHasDecision(binding, '3', ['rejected'])).toBe(false);
  });
});
