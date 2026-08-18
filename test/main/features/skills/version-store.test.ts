import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let root = '';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-version-store-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
});

afterEach(async () => {
  delete process.env.ORKAS_WORKSPACE_ROOT;
  await fs.rm(root, { recursive: true, force: true });
});

describe('skills version-store', () => {
  it('writes new records under local/skills/versions and marks content snapshots rollbackable', async () => {
    const mod = await import('../../../../src/main/features/skills/version-store');
    const list = await mod.appendSkillVersion('u1', 'skill-a', { version: '0.2.0', note: 'apply', runId: 'run-1', content: 'body' });
    expect(list[0]).toMatchObject({ version: '0.2.0', note: 'apply', runId: 'run-1', content: 'body', canRollback: true });
    const stored = JSON.parse(await fs.readFile(path.join(root, 'u1', 'local', 'skills', 'versions', 'skill-a.json'), 'utf8'));
    expect(stored[0].version).toBe('0.2.0');
  });

  it('reads legacy local/kstar/versions records when no new store exists', async () => {
    const legacy = path.join(root, 'u1', 'local', 'kstar', 'versions');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'skill-a.json'), JSON.stringify([{ version: '0.1.0', at: '2026-01-01T00:00:00.000Z' }]), 'utf8');
    const mod = await import('../../../../src/main/features/skills/version-store');
    const list = await mod.listSkillVersions('u1', 'skill-a');
    expect(list).toEqual([expect.objectContaining({
      version: '0.1.0',
      at: '2026-01-01T00:00:00.000Z',
      rollbackScope: 'skill_md_only',
      canRollback: false,
    })]);
  });
});
