import { describe, expect, it, vi } from 'vitest';

describe('skills rollback-service', () => {
  it('writes a rollbackable version snapshot and appends provenance', async () => {
    const mod = await import('../../../../src/main/features/skills/rollback-service');
    const writeFn = vi.fn(async () => true);
    const appendVersionFn = vi.fn(async () => []);
    const listVersionsFn = vi.fn(async () => [{ version: '0.1.0', at: '2026-01-01T00:00:00.000Z', content: 'old skill', canRollback: true }]);
    const result = await mod.rollbackSkillToVersion('u1', { skillId: 'skill-a', version: '0.1.0', writeFn, appendVersionFn, listVersionsFn });
    expect(result).toEqual({ ok: true, skillId: 'skill-a', version: '0.1.0' });
    expect(writeFn).toHaveBeenCalledWith('skill-a', 'SKILL.md', 'old skill');
    expect(appendVersionFn).toHaveBeenCalledWith('u1', 'skill-a', expect.objectContaining({ version: '0.1.0', note: 'Rollback to 0.1.0', content: 'old skill' }));
  });

  it('rejects rollback when the target record has no content snapshot', async () => {
    const mod = await import('../../../../src/main/features/skills/rollback-service');
    await expect(mod.rollbackSkillToVersion('u1', {
      skillId: 'skill-a',
      version: '0.1.0',
      writeFn: vi.fn(async () => true),
      appendVersionFn: vi.fn(async () => []),
      listVersionsFn: vi.fn(async () => [{ version: '0.1.0', at: '2026-01-01T00:00:00.000Z', canRollback: false }]),
    })).rejects.toThrow('skill version is not rollbackable');
  });
});
