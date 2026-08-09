import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendSkillVersion, listSkillVersions,
} from '../../../../src/main/features/evolution/versions-store';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ver-'));
  process.env.ORKAS_WORKSPACE_ROOT = dir;
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); delete process.env.ORKAS_WORKSPACE_ROOT; });

describe('versions-store', () => {
  it('未记录时列表为空', async () => {
    expect(await listSkillVersions('u1', 'sk1')).toEqual([]);
  });

  it('appendSkillVersion 追加，最新在前', async () => {
    await appendSkillVersion('u1', 'sk1', { version: '0.1.1', note: '第一次改进' });
    await appendSkillVersion('u1', 'sk1', { version: '0.1.2', note: '第二次改进' });
    const versions = await listSkillVersions('u1', 'sk1');
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe('0.1.2');
    expect(versions[1].version).toBe('0.1.1');
    expect(versions[0].at).toBeTypeOf('string');
  });

  it('落盘位置在 local/kstar/versions/<id>.json', async () => {
    await appendSkillVersion('u1', 'sk1', { version: '0.1.1' });
    const p = path.join(dir, 'u1', 'local', 'kstar', 'versions', 'sk1.json');
    const raw = JSON.parse(await fs.readFile(p, 'utf-8'));
    expect(raw[0].version).toBe('0.1.1');
  });

  it('stores optional version content snapshots and exposes rollback availability', async () => {
    await appendSkillVersion('u1', 'sk1', { version: '0.1.1', note: 'with snapshot', content: 'snapshot body' });
    await appendSkillVersion('u1', 'sk1', { version: '0.1.0', note: 'legacy metadata only' });
    const versions = await listSkillVersions('u1', 'sk1');
    expect(versions[0]).toMatchObject({ version: '0.1.0', canRollback: false });
    expect(versions[0]).not.toHaveProperty('content');
    expect(versions[1]).toMatchObject({ version: '0.1.1', canRollback: true, content: 'snapshot body' });
  });

});
