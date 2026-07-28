import { describe, it, expect } from 'vitest';
import { bumpSemver, applyPatchToSkill } from '../../../../src/main/features/evolution/patch-service';

describe('patch-service', () => {
  it('bumpSemver 递增 patch 位', () => {
    expect(bumpSemver('0.1.0')).toBe('0.1.1');
    expect(bumpSemver('1.2.9')).toBe('1.2.10');
    expect(bumpSemver('')).toBe('0.1.0');
  });

  it('applyPatchToSkill 写 SKILL.md 并 bump 版本，追加版本记录，不自动晋升 production', async () => {
    const writes: Array<{ id: string; file: string; content: string }> = [];
    const versions: Array<{ uid: string; skillId: string; version: string }> = [];
    const r = await applyPatchToSkill('u1', {
      skillId: 'sk1', newContent: 'version: 0.1.0\nstatus: staged\n---\n新正文',
      writeFn: async (id, file, content) => { writes.push({ id, file, content }); return true; },
      appendVersionFn: async (uid, skillId, entry) => { versions.push({ uid, skillId, version: entry.version }); },
    });
    expect(r.ok).toBe(true);
    expect(r.newVersion).toBe('0.1.1');
    expect(writes[0].file).toBe('SKILL.md');
    expect(writes[0].content).toContain('0.1.1');
    expect(writes[0].content).not.toContain('status: production'); // 晋升需人工
    expect(versions).toEqual([{ uid: 'u1', skillId: 'sk1', version: '0.1.1' }]); // 追加了版本记录
  });

  it('写失败时不追加版本记录', async () => {
    const versions: unknown[] = [];
    const r = await applyPatchToSkill('u1', {
      skillId: 'sk1', newContent: 'version: 0.1.0\n---\nx',
      writeFn: async () => false,
      appendVersionFn: async (...args) => { versions.push(args); },
    });
    expect(r.ok).toBe(false);
    expect(versions).toEqual([]);
  });
});
