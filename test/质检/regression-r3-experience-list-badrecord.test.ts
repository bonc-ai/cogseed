/**
 * 红队探针 r3：经验目录（specs/016）列表层无逐条坏档守卫——一条被篡改/
 * 损坏的经验 JSON 炸掉整个经验列表。
 *
 * 推演链：listExperiences（recall/experience-service.ts:366-382）readdir 全部
 * exp-*.json 后 `records.map((record) => asExperience(record))` **无逐条
 * try/catch**；asExperience（:216-316）逐字段严格校验（枚举/长度/溯源一致），
 * 一条坏记录（手改、磁盘坏档、云同步残缺、未来 schema 演进缺字段）抛
 * 'malformed experience' → 整个列表 reject。消费方 'recall.experiences.list'
 * （ipc/index.ts:2961 直接 await，无兜底）→ 渲染层经验目录整页打不开；
 * 'kstar.experiences.list'（:3361）同源同炸。
 *
 * 对照组：review 决定的跨文件聚合（cognition/review-decision.ts:215-237）
 * 明确做了「单个账本损坏不该让整页打不开」的逐文件 catch——经验目录是
 * 同类聚合却没对齐该契约。
 *
 * 2026-09-30 r3 修复（F-r3-1）：listExperiences 改为逐条降级——形状错
 * （readRecallJsonRecord / asExperience 两层）log.warn 跳过该条、好条目照常
 * 列出；带 errno code 的真实 IO 故障照旧上抛。本探针已由记账员反转为
 * 回归测试（原断言「整体 reject」在修复后必然红），改名 regression- 收编。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r3-exp';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r3-exp-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadExp() {
  return import('../../src/main/features/recall/experience-service');
}

function validInput(id: string, title: string) {
  return {
    id,
    source: {
      episodeId: `ep-${id}`,
      taskGoal: '完成任务A',
      taskType: 'report' as const,
      taskStatus: 'done',
    },
    experienceType: 'lesson' as const,
    title,
    body: '本次学到的重要经验。',
    scope: 'default',
    verification: { state: 'confirmed' as const, outcome: 'met_expected' as const, deltaR: 0, confidence: 0.8 },
    evidenceRefs: [{ kind: 'conversation', id: 'conv-1' }],
    learningProvenance: {
      projectionId: 'proj-1',
      episodeId: `ep-${id}`,
      ruleRefs: [],
      attribution: 'single_task' as any,
    },
    status: 'active' as const,
  };
}

describe('regression r3（F-r3-1 已修） › 经验列表坏档逐条降级', () => {
  it('一条坏 verification.state 被跳过：列表不炸、好条目照常列出（单读坏档仍明确报错）', async () => {
    const exp = await loadExp();
    const a = await exp.createExperience(UID, validInput('exp-aaaa1111', '好经验A'));
    const b = await exp.createExperience(UID, validInput('exp-bbbb2222', '好经验B'));
    expect(a.title).toBe('好经验A');
    expect(b.title).toBe('好经验B');

    // 两条都能列出（对照组）
    const before = await exp.listExperiences(UID);
    expect(before.length).toBe(2);

    // 篡改 B：verification.state 改成非法枚举（手改/坏档/旧 schema 场景）
    // 存储布局：experiences/<id>.json（按 recallJsonRecordPath 的集合目录定位）
    let fileB = findFile(path.join(tmpDir, UID), 'exp-bbbb2222.json') || '';
    expect(fileB).not.toBe('');
    const raw = JSON.parse(fs.readFileSync(fileB, 'utf8'));
    raw.verification.state = 'bogus_state';
    fs.writeFileSync(fileB, JSON.stringify(raw, null, 2), 'utf8');

    // F-r3-1 修复后（反转）：坏档逐条降级——列表不再整体 reject，
    // 好条目照常列出、坏条目被 log.warn 跳过。
    const after = await exp.listExperiences(UID);
    expect(after.map((e) => e.title)).toEqual(['好经验A']);
    // 单读好条目 A 仍正常（坏档只影响它自己那条）
    const still = await exp.readExperience(UID, 'exp-aaaa1111');
    expect(still?.title).toBe('好经验A');
    // 单读坏条目 B：仍明确报错（单读语义未变，错误不被吞）
    await expect(exp.readExperience(UID, 'exp-bbbb2222')).rejects.toThrow('malformed experience');
  });
});

function findFile(root: string, name: string): string | null {
  let out: string | null = null;
  const walk = (dir: string) => {
    if (out) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === name) { out = p; }
    }
  };
  walk(root);
  return out;
}
