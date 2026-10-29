/** 经验两段合并在 target 已写、source 遇终态失败时保留中断痕迹。
 * target 的 entry 和台账标记 interrupted，不声称已经完成；确定性交错
 * 下 source 保持归档终态，重复尝试不增加影子条目。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-exp-merge-half-r2';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-exp-merge-half-r2-'));
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

describe('经验 merge 两段非原子：source 段窗口失败留半合并', () => {
  it('对照组：无并发时两段都成功（target 吸收 + source 置 merged 各就各位）', async () => {
    const { svc, recallJsonRecordPath } = await setup();
    await svc.createExperience(UID, mkExperience('exp-src-hc', '对照组源'));
    await svc.createExperience(UID, mkExperience('exp-tgt-hc', '对照组靶'));
    const merged = await svc.mergeExperiences(UID, 'exp-src-hc', 'exp-tgt-hc');
    expect(merged.source.status).toBe('merged');
    const tgt = readRawDisk(recallJsonRecordPath, 'exp-tgt-hc');
    expect((tgt.mergedFrom as Array<{ id: string }>).some((e) => e.id === 'exp-src-hc')).toBe(true);
  });

  it('target 段落盘后 source 在窗口期被归档 → merge rejects，半完成痕迹如实带 interrupted（不声称完成）', async () => {
    const { svc, recallJsonRecordPath, fileEditLock } = await setup();
    await svc.createExperience(UID, mkExperience('exp-src-hh', '并发源'));
    await svc.createExperience(UID, mkExperience('exp-tgt-hh', '并发靶'));
    const srcPath = recallJsonRecordPath(UID, 'experiences', 'exp-src-hh');

    // 持 source 记录锁：merge 的 ① target 段无竞争先行落盘，② source 段排队。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = fileEditLock(srcPath).runExclusive(() => gate);
    await new Promise((r) => setTimeout(r, 5));

    const mergeP = svc.mergeExperiences(UID, 'exp-src-hh', 'exp-tgt-hh', '半合并探针');
    await new Promise((r) => setTimeout(r, 30));
    // 此刻 ① 已落盘（target 侧已有 mergedFrom，带 interrupted），② 在 gate 上排队。

    // 持锁期间窗口内并发归档落盘（直改盘，先例手法）。
    const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8')) as Record<string, unknown>;
    expect(raw.status).toBe('active');
    fs.writeFileSync(srcPath, JSON.stringify({
      ...raw,
      status: 'archived',
      archiveReason: '窗口期并发归档',
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    release();
    await holder;
    // source 段的锁内终态复核抛错，不强改 archived→merged。
    await expect(mergeP).rejects.toThrow(/terminal/);

    // 修复后：target 侧的痕迹**如实**——entry 与台账行都在，但带 interrupted=true，
    // 「家谱声称合并过」的失真不再；也不叠出重复条目（entry 恰一条）。
    const tgt = readRawDisk(recallJsonRecordPath, 'exp-tgt-hh');
    const mergedFrom = tgt.mergedFrom as Array<{ id: string; interrupted?: boolean }> | undefined;
    expect(mergedFrom?.filter((e) => e.id === 'exp-src-hh')).toHaveLength(1);
    expect(mergedFrom?.[0].interrupted).toBe(true);
    const history = tgt.history as Array<{ action: string; from?: string; interrupted?: boolean }>;
    expect(history.some((h) => h.action === 'merged_from' && h.from === 'exp-src-hh' && h.interrupted === true)).toBe(true);
    // source 侧未置 merged、无去向（两段不一致由 interrupted 标志如实表达）。
    const src = readRawDisk(recallJsonRecordPath, 'exp-src-hh');
    expect(src.status).toBe('archived');
    expect(src.mergedIntoExperienceId).toBeUndefined();

    // source 已终态：重试 merge 仍被 terminal 拒绝（archived 无出弧是终态纪律），
    // 但中断残留不再失真——interrupted 标志留在盘上如实标注「未完成」。
    await expect(svc.mergeExperiences(UID, 'exp-src-hh', 'exp-tgt-hh')).rejects.toThrow(/terminal/);
    const after = readRawDisk(recallJsonRecordPath, 'exp-tgt-hh');
    expect(((after.mergedFrom as Array<{ id: string; interrupted?: boolean }>) || [])
      .some((e) => e.id === 'exp-src-hh' && e.interrupted === true)).toBe(true);
  });
});
