/** target 合并段成功而 source 段遇终态时，整体返回失败。
 * 已写 entry 与台账如实标记 interrupted，不回滚并发写入，也不把
 * 尚未完成的合并呈现为成功；终态 source 不因重试而被改写。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-exp-merge-r2';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-exp-merge-r2-'));
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
    source: { episodeId: `kse-${id}`, taskGoal: `任务-${id}`, taskType: 'code' as const, taskStatus: 'confirmed' },
    experienceType: 'lesson' as const,
    title,
    body: `${title}：先备份再执行变更。`,
    scope: 'code',
    verification: { state: 'confirmed' as const, outcome: 'met_expected' as const, deltaR: 0.1, confidence: 0.7 },
    evidenceRefs: [{ kind: 'conversation' as const, id: `conv-${id}` }],
    learningProvenance: { projectionId: `prj-${id}`, episodeId: `kse-${id}`, ruleRefs: [], attribution: 'execution_gap' as const },
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

function readRaw(recallJsonRecordPath: (uid: string, c: string, id: string) => string, id: string) {
  return JSON.parse(fs.readFileSync(recallJsonRecordPath(UID, 'experiences', id), 'utf8')) as Record<string, unknown>;
}

describe('经验 merge 两段非原子：source 段抛错后 target 半完成痕迹不回滚', () => {
  it('对照组：无并发时完整 merge 成功，target 家谱干净单条、source 置 merged', async () => {
    const { svc } = await setup();
    await svc.createExperience(UID, mkExperience('exp-src-ok', '正常源'));
    await svc.createExperience(UID, mkExperience('exp-tgt-ok', '正常靶'));
    const merged = await svc.mergeExperiences(UID, 'exp-src-ok', 'exp-tgt-ok');
    expect(merged.target.mergedFrom?.length).toBe(1);
    expect(merged.source.status).toBe('merged');
  });

  it('target 段落盘后 source 段遇终态抛错 → merge rejects 且 target 的 mergedFrom/台账如实带 interrupted，不声称完成', async () => {
    const { svc, recallJsonRecordPath, fileEditLock } = await setup();
    await svc.createExperience(UID, mkExperience('exp-src-p', '中断源'));
    await svc.createExperience(UID, mkExperience('exp-tgt-p', '中断靶'));
    const srcPath = recallJsonRecordPath(UID, 'experiences', 'exp-src-p');

    // 确定性时序：持 source 文件锁——target 段（另一把锁）先完成落盘，
    // source 段在 gate 上排队。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = fileEditLock(srcPath).runExclusive(() => gate);
    await new Promise((r) => setTimeout(r, 5));

    const mergeP = svc.mergeExperiences(UID, 'exp-src-p', 'exp-tgt-p', '中断窗口探针');
    await new Promise((r) => setTimeout(r, 25));

    // 持锁期间 source 被归档（另一路径）。
    const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8')) as Record<string, unknown>;
    expect(raw.status).toBe('active');
    fs.writeFileSync(srcPath, JSON.stringify({
      ...raw,
      status: 'archived',
      archiveReason: '窗口期归档',
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    release();
    await holder;
    // source 段抛 terminal，merge 整体 rejects。
    await expect(mergeP).rejects.toThrow(/terminal/);

    // 修复后（interrupted 标志如实化）：target 段的落盘保留——entry 与台账都在，
    // 但都带 interrupted=true——家谱如实记「合并开始过、未完成」，不再声称
    // 一条从未完成的合并已经并进来了。
    const target = readRaw(recallJsonRecordPath, 'exp-tgt-p');
    const mf = target.mergedFrom as Array<{ id: string; interrupted?: boolean }> | undefined;
    expect(Array.isArray(mf) && mf.some((e) => e.id === 'exp-src-p' && e.interrupted === true)).toBe(true);
    expect((target.history as Array<{ action?: string; interrupted?: boolean }>)
      .some((h) => h.action === 'merged_from' && h.interrupted === true)).toBe(true);

    // source 已 archived 终态（resume 也被拒）：这条 merge 无法重试完成是终态纪律
    // （archived 无出弧），但 target 侧的 interrupted 标志把「未完成」如实留在盘上。
    await expect(svc.setExperienceStatus(UID, 'exp-src-p', 'resume')).rejects.toThrow(/terminal/);
    await expect(svc.mergeExperiences(UID, 'exp-src-p', 'exp-tgt-p')).rejects.toThrow(/terminal/);
    const stillInterrupted = readRaw(recallJsonRecordPath, 'exp-tgt-p');
    expect(((stillInterrupted.mergedFrom as Array<{ id: string; interrupted?: boolean }>) || [])
      .some((e) => e.id === 'exp-src-p' && e.interrupted === true)).toBe(true);
  });
});
