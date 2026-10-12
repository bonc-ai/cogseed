import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-title-migration-'));
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
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
      reviewDecisionId: 'legacy-untracked', lifecycleStatus: 'user_confirmed_unverified',
      status: 'active', maturity: 'seed', version: '1',
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    } as never, 'test');
    const legacyGap = await assets.createSystemAbilityAsset('user-m', {
      schemaVersion: 2, ownerId: 'user-m', id: 'aa-legacy-gap-00000000000001', candidateId: 'cand-legacy-gap-1',
      title: 'KSTAR rule gap candidate (requirement-level)', type: 'rule', scope: 'general',
      statement: 'For similar tasks, address this rule gap: 用户纠正格式要求后应清理旧文件。', evidenceRefs: [{ kind: 'conversation', id: 'c2' }],
      reviewDecisionId: 'legacy-untracked', lifecycleStatus: 'user_confirmed_unverified',
      status: 'active', maturity: 'seed', version: '1',
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    } as never, 'test');
    const fine = await assets.createSystemAbilityAsset('user-m', {
      schemaVersion: 2, ownerId: 'user-m', id: 'aa-fine-0000000000000000000001', candidateId: 'cand-fine-1',
      title: '只读审查方法', type: 'skill_method', scope: 'review',
      statement: '该审查方法可复用。', evidenceRefs: [{ kind: 'conversation', id: 'c3' }],
      reviewDecisionId: 'legacy-untracked', lifecycleStatus: 'user_confirmed_unverified',
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

  it('status 过滤（2026-09-28 红队补齐口径）：paused 被改写+bump，deleted/revoked 终态原样', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const seed = (id: string, status: string) => assets.createSystemAbilityAsset('user-m', {
      schemaVersion: 2, ownerId: 'user-m', id, candidateId: `cand-${id}`,
      title: 'Reusable experience lesson (requirement-level)', type: 'rule', scope: 'general',
      statement: '正文。', evidenceRefs: [{ kind: 'conversation', id: 'c-status' }],
      reviewDecisionId: 'legacy-untracked', lifecycleStatus: 'user_confirmed_unverified',
      status, maturity: 'seed', version: '1',
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    } as never, 'test');
    const paused = await seed('aa-title-paused-0000000000001', 'paused');
    const deleted = await seed('aa-title-deleted-000000000001', 'deleted');
    const revoked = await seed('aa-title-revoked-00000000001', 'revoked');

    // 只有 paused 一条被迁移（终态 deleted/revoked 不进改写分支）。
    expect(await assets.migrateLegacyUserFacingTitles('user-m')).toBe(1);

    const afterPaused = await assets.readAbilityAsset('user-m', paused.id);
    expect(afterPaused.title).toBe('可复用经验（通用）');
    expect(afterPaused.version).toBe('2');
    // 终态原样：标题与版本都不动（保留期内容不可变）。
    const afterDeleted = await assets.readAbilityAsset('user-m', deleted.id);
    expect(afterDeleted.title).toBe('Reusable experience lesson (requirement-level)');
    expect(afterDeleted.version).toBe('1');
    const afterRevoked = await assets.readAbilityAsset('user-m', revoked.id);
    expect(afterRevoked.title).toBe('Reusable experience lesson (requirement-level)');
    expect(afterRevoked.version).toBe('1');
  });

  it('锁内终态复核（r2）：快照后资产被删除则闭包拒绝改写（不 bump、不追加版本）', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const { fileEditLock } = await import('../../../../src/main/util/locks');
    const { recallJsonRecordPath } = await import('../../../../src/main/features/recall/paths');
    const seeded = await assets.createSystemAbilityAsset('user-m', {
      schemaVersion: 2, ownerId: 'user-m', id: 'aa-title-race-000000000001', candidateId: 'cand-title-race-1',
      title: 'Reusable experience lesson (requirement-level)', type: 'rule', scope: 'general',
      statement: '正文。', evidenceRefs: [{ kind: 'conversation', id: 'c-race' }],
      reviewDecisionId: 'legacy-untracked', lifecycleStatus: 'user_confirmed_unverified',
      status: 'active', maturity: 'seed', version: '1',
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    } as never, 'test');
    const recPath = recallJsonRecordPath('user-m', 'ability-assets', seeded.id);

    // 确定性时序构造：测试先持同款文件锁，再启动迁移——迁移快照读到 active，
    // 其改写闭包在 updateRecallJsonRecord 内排队等锁。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = fileEditLock(recPath).runExclusive(() => gate);
    await new Promise((r) => setTimeout(r, 5));

    const migP = assets.migrateLegacyUserFacingTitles('user-m');
    await new Promise((r) => setTimeout(r, 15)); // 快照完成（active）、闭包已排队

    // 持锁期间用原始 fs 把资产置为 deleted：模拟「快照之后、闭包取锁之前」
    // 另一路径（registerDeferred 启动迁移遍历期间用户删除）已删除落盘。
    const raw = JSON.parse(fs.readFileSync(recPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(recPath, JSON.stringify({ ...raw, status: 'deleted' }));

    release();
    await holder;
    const migrated = await migP;

    // 锁内 assertMutableAbilityAsset 拒绝：整个 runExclusive reject 不落盘，
    // 外层 catch 记 warn 跳过——资产保持 deleted + 原标题 + 版本 '1'。
    expect(migrated).toBe(0);
    const after = JSON.parse(fs.readFileSync(recPath, 'utf8')) as Record<string, unknown>;
    expect(after.status).toBe('deleted');
    expect(after.title).toBe('Reusable experience lesson (requirement-level)');
    expect(after.version).toBe('1');
  });
});
