import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bumpSemver, applyPatchToSkill, rollbackSkillToVersion } from '../../../../src/main/features/evolution/patch-service';

let root = '';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-service-')); process.env.ORKAS_WORKSPACE_ROOT = root; });
afterEach(() => { delete process.env.ORKAS_WORKSPACE_ROOT; fs.rmSync(root, { recursive: true, force: true }); });

describe('patch-service', () => {
  it('bumpSemver 递增 patch 位', () => {
    expect(bumpSemver('0.1.0')).toBe('0.1.1');
    expect(bumpSemver('1.2.9')).toBe('1.2.10');
    expect(bumpSemver('')).toBe('0.1.0');
  });

  it('applyPatchToSkill 写 SKILL.md 并 bump 版本，追加版本记录，不自动晋升 production', async () => {
    const writes: Array<{ id: string; file: string; content: string }> = [];
    const versions: Array<{ uid: string; skillId: string; version: string; content?: string }> = [];
    const r = await applyPatchToSkill('u1', {
      skillId: 'sk1', newContent: '---\nname: x\ndescription: x\nversion: 0.1.0\nstatus: staged\n---\n新正文',
      writeFn: async (id, file, content) => { writes.push({ id, file, content }); return true; },
      appendVersionFn: async (uid, skillId, entry) => { versions.push({ uid, skillId, version: entry.version, content: entry.content }); },
    });
    expect(r.ok).toBe(true);
    expect(r.newVersion).toBe('0.1.1');
    expect(writes[0].file).toBe('SKILL.md');
    expect(writes[0].content).toContain('0.1.1');
    expect(writes[0].content).not.toContain('status: production'); // 晋升需人工
    expect(versions).toEqual([{ uid: 'u1', skillId: 'sk1', version: '0.1.1', content: writes[0].content }]); // 追加了可回滚版本记录
  });

  it('写失败时不追加版本记录', async () => {
    const versions: unknown[] = [];
    const r = await applyPatchToSkill('u1', {
      skillId: 'sk1', newContent: '---\nname: x\ndescription: x\nversion: 0.1.0\n---\nx',
      writeFn: async () => false,
      appendVersionFn: async (...args) => { versions.push(args); },
    });
    expect(r.ok).toBe(false);
    expect(versions).toEqual([]);
  });

  it('revalidates final content and blocks EXTREME findings before write', async () => {
    let writes = 0;
    const r = await applyPatchToSkill('u1', {
      skillId: 'sk1',
      newContent: '---\nname: x\ndescription: x\n---\n```bash\ncat ~/.ssh/id_rsa\n```',
      writeFn: async () => { writes += 1; return true; },
      appendVersionFn: async () => undefined,
      validationBoundary: 'test-double',
    });
    expect(r).toMatchObject({ ok: false, validationStatus: 'blocked' });
    expect(r.validationId).toEqual(expect.any(String));
    expect(writes).toBe(0);
  });

  it('writes content after a passing final validation and records validation provenance', async () => {
    const writes: string[] = [];
    const r = await applyPatchToSkill('u1', {
      skillId: 'sk1', newContent: '---\nname: x\ndescription: safe\n---\nSafe body.',
      writeFn: async (_id, _file, content) => { writes.push(content); return true; },
      appendVersionFn: async () => undefined,
      validationBoundary: 'test-double',
    });
    expect(r.ok).toBe(true);
    expect(r.validationStatus).toBe('pass');
    expect(r.validationId).toEqual(expect.any(String));
    expect(writes).toHaveLength(1);
  });


  it('rolls back to a version only when a content snapshot exists', async () => {
    const writes: Array<{ id: string; file: string; content: string }> = [];
    const appended: Array<{ version: string; note?: string; content?: string }> = [];
    const versions = [
      { version: '0.1.2', at: '2026-08-04T02:00:00.000Z', canRollback: false },
      { version: '0.1.1', at: '2026-08-04T01:00:00.000Z', content: 'snapshot 0.1.1', canRollback: true },
    ];

    const r = await rollbackSkillToVersion('u1', {
      skillId: 'sk1',
      version: '0.1.1',
      listVersionsFn: async () => versions,
      writeFn: async (id, file, content) => { writes.push({ id, file, content }); return true; },
      appendVersionFn: async (_uid, _skillId, entry) => { appended.push(entry); },
    });

    expect(r).toMatchObject({ ok: true, skillId: 'sk1', version: '0.1.1' });
    expect(writes).toEqual([{ id: 'sk1', file: 'SKILL.md', content: 'snapshot 0.1.1' }]);
    expect(appended).toEqual([expect.objectContaining({ version: '0.1.1', content: 'snapshot 0.1.1' })]);

    await expect(rollbackSkillToVersion('u1', {
      skillId: 'sk1',
      version: '0.1.2',
      listVersionsFn: async () => versions,
      writeFn: async () => true,
      appendVersionFn: async () => undefined,
    })).rejects.toThrow(/not rollbackable/i);
  });

});
