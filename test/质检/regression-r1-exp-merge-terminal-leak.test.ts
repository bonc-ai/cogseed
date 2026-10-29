/** 经验合并的 target 与 source updater 都在记录锁内重新检查终态。
 * 排队期间被归档的对象拒绝合并，不能追加 mergedFrom 或强改为 merged；
 * 无竞态时的锁外预检继续有效。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-exp-merge-r1';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-exp-merge-r1-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkExperience(id: string, title: string) {
  const now = new Date().toISOString();
  return {
    id,
    source: {
      episodeId: `kse-${id}`,
      taskGoal: `任务-${id}`,
      taskType: 'code' as const,
      taskStatus: 'confirmed',
    },
    experienceType: 'lesson' as const,
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

describe('经验 merge 锁内终态复核', () => {
  it('对照组：无并发时归档终态拒绝 merge，resume 亦拒绝（锁外预检与同文件先例都在）', async () => {
    const { svc, recallJsonRecordPath } = await setup();
    await svc.createExperience(UID, mkExperience('exp-src-ctl', '对照组源'));
    await svc.createExperience(UID, mkExperience('exp-tgt-ctl', '对照组靶'));
    await svc.archiveExperience(UID, 'exp-tgt-ctl', '过期');
    await expect(svc.mergeExperiences(UID, 'exp-src-ctl', 'exp-tgt-ctl')).rejects.toThrow(/terminal/);
    await expect(svc.setExperienceStatus(UID, 'exp-tgt-ctl', 'resume')).rejects.toThrow(/terminal/);
    // 锁外预检生效：盘上靶仍是 archived、零 mergedFrom。
    const disk = readRawDisk(recallJsonRecordPath, 'exp-tgt-ctl');
    expect(disk.status).toBe('archived');
    expect(disk.mergedFrom).toBeUndefined();
  });

  it('回归：预检后、锁内落盘前 target 被归档 → 锁内复核 terminal，mergedFrom 保持缺席', async () => {
    const { svc, recallJsonRecordPath, fileEditLock } = await setup();
    await svc.createExperience(UID, mkExperience('exp-src-t', '并发源'));
    await svc.createExperience(UID, mkExperience('exp-tgt-t', '并发靶'));
    const recPath = recallJsonRecordPath(UID, 'experiences', 'exp-tgt-t');

    // 确定性时序：先持 target 文件锁，merge 的 target 段 updateExperience 在锁上排队。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = fileEditLock(recPath).runExclusive(() => gate);
    await new Promise((r) => setTimeout(r, 5));

    const mergeP = svc.mergeExperiences(UID, 'exp-src-t', 'exp-tgt-t', '并发窗口探针');
    await new Promise((r) => setTimeout(r, 25));

    // 持锁期间另一路径归档 target（直改盘，照 asset-service.test.ts 先例）。
    const raw = JSON.parse(fs.readFileSync(recPath, 'utf8')) as Record<string, unknown>;
    const archivedUpdatedAt = new Date().toISOString();
    fs.writeFileSync(recPath, JSON.stringify({
      ...raw,
      status: 'archived',
      archiveReason: '并发归档',
      archivedAt: new Date().toISOString(),
      updatedAt: archivedUpdatedAt,
    }));

    release();
    await holder;
    // 修复后：target 段锁内复核终态（archived 无出弧），merge 整体 rejects /terminal/。
    await expect(mergeP).rejects.toThrow(/terminal/);

    const disk = readRawDisk(recallJsonRecordPath, 'exp-tgt-t');
    // 修复后：盘上 mergedFrom 保持缺席、updatedAt 仍是并发归档写的值（未被 merge 刷新）。
    expect(disk.status).toBe('archived');
    expect(disk.mergedFrom).toBeUndefined();
    expect(disk.updatedAt).toBe(archivedUpdatedAt);
  });

  it('回归：预检后、锁内落盘前 source 被归档 → 锁内复核 terminal，archived 不落 merged', async () => {
    const { svc, recallJsonRecordPath, fileEditLock } = await setup();
    await svc.createExperience(UID, mkExperience('exp-src-s', '并发源2'));
    await svc.createExperience(UID, mkExperience('exp-tgt-s', '并发靶2'));
    const recPath = recallJsonRecordPath(UID, 'experiences', 'exp-src-s');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = fileEditLock(recPath).runExclusive(() => gate);
    await new Promise((r) => setTimeout(r, 5));

    // target 段（另一把文件锁）正常先行；source 段在 gate 上排队。
    const mergeP = svc.mergeExperiences(UID, 'exp-src-s', 'exp-tgt-s', '并发窗口探针2');
    await new Promise((r) => setTimeout(r, 25));

    const raw = JSON.parse(fs.readFileSync(recPath, 'utf8')) as Record<string, unknown>;
    expect(raw.status).toBe('active');
    fs.writeFileSync(recPath, JSON.stringify({
      ...raw,
      status: 'archived',
      archiveReason: '并发归档2',
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    release();
    await holder;
    // 修复后：source 段锁内复核终态，archived→merged 非法跃迁被整体拒绝。
    await expect(mergeP).rejects.toThrow(/terminal/);

    const disk = readRawDisk(recallJsonRecordPath, 'exp-src-s');
    // 修复后：盘上 status 保持 archived，去向未写入，归档痕迹完好。
    expect(disk.status).toBe('archived');
    expect(disk.mergedIntoExperienceId).toBeUndefined();
    expect(disk.archiveReason).toBe('并发归档2');
  });
});
