import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-title-migration-'));
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
  const { activateUser } = await import('../../../../src/main/features/users');
  activateUser('user-m');
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('legacy ability-asset title migration', () => {
  it('rewrites legacy English titles and gap judgments, leaving others untouched', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    // Seed: one legacy lesson title, one legacy gap title+judgment, one fine.
    const legacyLesson = await assets.createSystemAbilityAsset('user-m', {
      schemaVersion: 2, ownerId: 'user-m', id: 'aa-legacy-lesson-000000000001', candidateId: 'cand-legacy-lesson-1',
      title: 'Reusable experience lesson (requirement-level)', type: 'rule', scope: 'general',
      statement: '处理“N 字资料”类请求时，在交付开头注明实际字数。', evidenceRefs: [{ kind: 'conversation', id: 'c1' }],
      reviewDecisionId: 'legacy-untracked', lifecycleStatus: 'system_precipitated_unverified',
      status: 'active', maturity: 'seed', version: '1',
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    } as never, 'test');
    const legacyGap = await assets.createSystemAbilityAsset('user-m', {
      schemaVersion: 2, ownerId: 'user-m', id: 'aa-legacy-gap-00000000000001', candidateId: 'cand-legacy-gap-1',
      title: 'KSTAR rule gap candidate (requirement-level)', type: 'rule', scope: 'general',
      statement: 'For similar tasks, address this rule gap: 用户纠正格式要求后应清理旧文件。', evidenceRefs: [{ kind: 'conversation', id: 'c2' }],
      reviewDecisionId: 'legacy-untracked', lifecycleStatus: 'system_precipitated_unverified',
      status: 'active', maturity: 'seed', version: '1',
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    } as never, 'test');
    const fine = await assets.createSystemAbilityAsset('user-m', {
      schemaVersion: 2, ownerId: 'user-m', id: 'aa-fine-0000000000000000000001', candidateId: 'cand-fine-1',
      title: '只读审查方法', type: 'skill_method', scope: 'review',
      statement: '该审查方法可复用。', evidenceRefs: [{ kind: 'conversation', id: 'c3' }],
      reviewDecisionId: 'legacy-untracked', lifecycleStatus: 'automatically_extracted_unverified',
      status: 'active', maturity: 'seed', version: '1',
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    } as never, 'test');
    void fine;

    const count = await assets.migrateLegacyUserFacingTitles('user-m');
    expect(count).toBe(2);

    const lesson = await assets.readAbilityAsset('user-m', legacyLesson.id);
    expect(lesson.title).toBe('可复用经验（通用）');
    const gap = await assets.readAbilityAsset('user-m', legacyGap.id);
    expect(gap.title).toBe('待修正的经验（通用）');
    expect(gap.statement).toContain('遇到同类情况时，应注意修正：用户纠正格式要求后应清理旧文件。');
    const untouched = await assets.readAbilityAsset('user-m', 'aa-fine-0000000000000000000001');
    expect(untouched.title).toBe('只读审查方法');

    // Idempotent: second run migrates nothing.
    expect(await assets.migrateLegacyUserFacingTitles('user-m')).toBe(0);
  });
});
