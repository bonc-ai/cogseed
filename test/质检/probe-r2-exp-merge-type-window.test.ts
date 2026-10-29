/**
 * mergeExperiences 的 experienceType 并发一致性回归测试。
 *
 * 锁外预读通过后，setExperienceType 仍可能在真正写入前改变类型；因此 target
 * 和 source 两段 updater 都必须在锁内复核。lesson 与 workflow 跨类型合并
 * 必须拒绝，不能静默改变经验的分类判断。
 *
 * 用文件锁让改类型操作先排队，再启动 merge，确定性交错两次写入。target
 * 侧拒绝时不写 mergedFrom；source 侧拒绝时保留 interrupted entry，记录部分
 * 合并尚未完成，以便后续对账和重试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-exp-merge-type-r2';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-exp-merge-type-r2-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkExperience(id: string, title: string, experienceType: 'lesson' | 'workflow') {
  const now = new Date().toISOString();
  return {
    id,
    source: {
      episodeId: `kse-${id}`,
      taskGoal: `任务-${id}`,
      taskType: 'code' as const,
      taskStatus: 'confirmed',
    },
    experienceType,
    title,
    body: `${title}：先备份再执行变更。`,
    scope: 'code',
    verification: {
      state: 'confirmed' as const,
      outcome: 'met_expected' as const,
      deltaR: 0.1,
      confidence: 0.7,
    },
    evidenceRefs: [{ kind: 'conversation' as const, id: `conv-${id}` }],
    learningProvenance: {
      projectionId: `prj-${id}`,
      episodeId: `kse-${id}`,
      ruleRefs: [],
      attribution: 'execution_gap' as const,
    },
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
  };
}

async function setup() {
  const users = await import('../../src/main/features/users');
  users.activateUser(UID);
  const svc = await import('../../src/main/features/recall/experience-service');
  const { recallJsonRecordPath } = await import('../../src/main/features/recall/paths');
  const { fileEditLock } = await import('../../src/main/util/locks');
  return { svc, recallJsonRecordPath, fileEditLock };
}

function readRawDisk(recallJsonRecordPath: (uid: string, c: string, id: string) => string, id: string) {
  return JSON.parse(fs.readFileSync(recallJsonRecordPath(UID, 'experiences', id), 'utf8')) as Record<string, unknown>;
}

describe('经验 merge 的 experienceType 锁内一致性（TOCTOU）', () => {
  it('对照组：无并发时跨类型 merge 被拒（lesson → workflow）', async () => {
    const { svc } = await setup();
    await svc.createExperience(UID, mkExperience('exp-src-tc', '对照组源', 'lesson'));
    await svc.createExperience(UID, mkExperience('exp-tgt-tc', '对照组靶', 'workflow'));
    await expect(svc.mergeExperiences(UID, 'exp-src-tc', 'exp-tgt-tc')).rejects.toThrow(/same experienceType/);
  });

  it('target 侧：预检通过后、target 落盘前类型被改 → 锁内复核拒绝，跨类型合并不再落盘', async () => {
    const { svc, recallJsonRecordPath, fileEditLock } = await setup();
    await svc.createExperience(UID, mkExperience('exp-src-tw', '并发源', 'lesson'));
    await svc.createExperience(UID, mkExperience('exp-tgt-tw', '并发靶', 'lesson'));
    const recPath = recallJsonRecordPath(UID, 'experiences', 'exp-tgt-tw');

    // 确定性时序：持 target 锁，先排队一次真实改类型，再启动 merge。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = fileEditLock(recPath).runExclusive(() => gate);
    await new Promise((r) => setTimeout(r, 5));

    const typeP = svc.setExperienceType(UID, 'exp-tgt-tw', 'workflow', '并发改类型');
    await new Promise((r) => setTimeout(r, 5));
    // merge 的锁外预读发生在此刻：双双 lesson、类型一致、预检通过，
    // 其 target updater 排在 setType 之后（锁内看到的已是 workflow）。
    const mergeP = svc.mergeExperiences(UID, 'exp-src-tw', 'exp-tgt-tw', '并发窗口探针');
    await new Promise((r) => setTimeout(r, 25));

    release();
    await holder;
    await typeP;
    // 修复后：target updater 锁内复核类型，分叉即拒绝。
    await expect(mergeP).rejects.toThrow(/same experienceType/);

    const disk = readRawDisk(recallJsonRecordPath, 'exp-tgt-tw');
    expect(disk.experienceType).toBe('workflow');
    // 跨类型合并不再落盘：target 无 mergedFrom 铺入。
    const mergedFrom = disk.mergedFrom as Array<{ id: string }> | undefined;
    expect(Array.isArray(mergedFrom) && mergedFrom.some((e) => e.id === 'exp-src-tw')).toBe(false);
    // source 侧未置 merged（② 段没跑到），两条记录都还各自完整可处置。
    const src = readRawDisk(recallJsonRecordPath, 'exp-src-tw');
    expect(src.status).toBe('active');
    expect(src.mergedIntoExperienceId).toBeUndefined();
  });

  it('source 侧镜像窗口：预检通过后、source 落盘前 source 类型被改 → source 段锁内复核拒绝，interrupted entry 如实记未完成', async () => {
    const { svc, recallJsonRecordPath, fileEditLock } = await setup();
    await svc.createExperience(UID, mkExperience('exp-src-sm', '镜像源', 'lesson'));
    await svc.createExperience(UID, mkExperience('exp-tgt-sm', '镜像靶', 'lesson'));
    // source 在预检后被改类型：①段（target 铺 entry）用的是锁外快照照常通过，
    // 卡点在 ②source 段——持 source 锁排队一次真实改类型，让 ② 的锁内读看到
    // 新类型。
    const srcPath = recallJsonRecordPath(UID, 'experiences', 'exp-src-sm');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = fileEditLock(srcPath).runExclusive(() => gate);
    await new Promise((r) => setTimeout(r, 5));

    const typeP = svc.setExperienceType(UID, 'exp-src-sm', 'workflow', '镜像窗口改类型');
    await new Promise((r) => setTimeout(r, 5));
    const mergeP = svc.mergeExperiences(UID, 'exp-src-sm', 'exp-tgt-sm', '镜像窗口探针');
    await new Promise((r) => setTimeout(r, 25));

    release();
    await holder;
    await typeP;
    // source 段锁内复核：锁内 source 类型（workflow）≠ target 类型（lesson）
    // → 拒绝，跨类型合并不成立。
    await expect(mergeP).rejects.toThrow(/same experienceType/);

    // source 未被置 merged，类型保持用户改的 workflow。
    const src = readRawDisk(recallJsonRecordPath, 'exp-src-sm');
    expect(src.status).toBe('active');
    expect(src.experienceType).toBe('workflow');
    // target 侧留下 interrupted entry（①已铺、②拒绝）——家谱如实记
    // 「合并进行中未完成」，重试由入口对账自愈（幂等口径）。
    const tgt = readRawDisk(recallJsonRecordPath, 'exp-tgt-sm');
    const mergedFrom = tgt.mergedFrom as Array<{ id: string; interrupted?: boolean }> | undefined;
    expect(Array.isArray(mergedFrom) && mergedFrom.some((e) => e.id === 'exp-src-sm' && e.interrupted === true)).toBe(true);
  });
});
