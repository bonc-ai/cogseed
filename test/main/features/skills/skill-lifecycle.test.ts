import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'test-user-sl';
const MOD = '../../../../src/main/features/skills/skill-lifecycle';
const FLAGS = '../../../../src/main/features/p3394/flags';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-skill-lifecycle-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules(); // paths.ts WS_ROOT 模块加载时求值
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  return import(MOD);
}

describe('skill-lifecycle › 记录与读取', () => {
  it('四分支均可记录；create/update 为 draft，invoke 为 invoked', async () => {
    const m = await loadMod();
    const create = await m.recordSkillLifecycleRecommendation(UID, {
      recommendationType: 'create', skillId: 'sk-new', reason: '重复工作模式', triggerRefs: ['run-1'],
    });
    expect(create.recommendation_id).toMatch(/^slr_/);
    expect(create.status).toBe('draft');

    const invoke = await m.recordSkillLifecycleRecommendation(UID, {
      recommendationType: 'invoke', skillId: 'sk-exist', skillVersion: '1.0.0', reason: '任务匹配', triggerRefs: ['run-2'],
    });
    expect(invoke.status).toBe('invoked');

    const update = await m.recordSkillLifecycleRecommendation(UID, {
      recommendationType: 'update', skillId: 'sk-exist', skillVersion: '1.0.0', reason: '有可解释 Diff', triggerRefs: ['run-3'],
    });
    expect(update.status).toBe('draft');

    const noChange = await m.recordSkillLifecycleRecommendation(UID, {
      recommendationType: 'no_change', skillId: 'sk-exist', skillVersion: '1.0.0',
      reason: 'Evidence 不足', noChangeReason: 'evidence_insufficient',
      reassessWhen: '出现新 Evidence 后再次评估', triggerRefs: ['run-4'],
    });
    expect(noChange.recommendation_type).toBe('no_change');
    expect(noChange.no_change_reason).toBe('evidence_insufficient');

    const list = await m.listSkillLifecycleRecommendations(UID, 'sk-exist');
    expect(list.length).toBe(3);
  });

  it('no_change 缺细分原因或再评估条件 → 抛错（不产生虚假版本）', async () => {
    const m = await loadMod();
    await expect(m.recordSkillLifecycleRecommendation(UID, {
      recommendationType: 'no_change', skillId: 'sk-x', reason: '暂不更新', triggerRefs: [],
    })).rejects.toThrow('no_change requires no_change_reason');
    await expect(m.recordSkillLifecycleRecommendation(UID, {
      recommendationType: 'no_change', skillId: 'sk-x', reason: '暂不更新',
      noChangeReason: 'made_up' as never, reassessWhen: 'later', triggerRefs: [],
    })).rejects.toThrow('invalid no_change reason');
  });

  it('非法类型/非法 skill id 抛错', async () => {
    const m = await loadMod();
    await expect(m.recordSkillLifecycleRecommendation(UID, {
      recommendationType: 'maybe' as never, skillId: 'sk-x', reason: 'r', triggerRefs: [],
    })).rejects.toThrow('invalid skill lifecycle type');
    await expect(m.recordSkillLifecycleRecommendation(UID, {
      recommendationType: 'create', skillId: 'bad id!', reason: 'r', triggerRefs: [],
    })).rejects.toThrow('invalid skill id');
  });
});

describe('skill-lifecycle › classify 四分支判定（P0 最小）', () => {
  it('无匹配 Skill → create；重复 2 次以上原因更明确', async () => {
    const m = await loadMod();
    const once = m.classifyLifecycleRecommendation({
      skillId: 'sk-x', hasMatchingSkill: false, outcome: 'unknown', evidenceComplete: false, repeatCount: 1, attributionClear: false,
    });
    expect(once.recommendationType).toBe('create');
    const twice = m.classifyLifecycleRecommendation({
      skillId: 'sk-x', hasMatchingSkill: false, outcome: 'unknown', evidenceComplete: false, repeatCount: 2, attributionClear: false,
    });
    expect(twice.recommendationType).toBe('create');
    expect(twice.reason).toContain('重复');
  });

  it('证据不足/不可归因/未达阈值 → no_change（合法结论，不升版）', async () => {
    const m = await loadMod();
    const insufficient = m.classifyLifecycleRecommendation({
      skillId: 'sk-x', skillVersion: '1.0.0', hasMatchingSkill: true, outcome: 'better', evidenceComplete: false, repeatCount: 3, attributionClear: true,
    });
    expect(insufficient.recommendationType).toBe('no_change');
    expect(insufficient.noChangeReason).toBe('evidence_insufficient');

    const notAttr = m.classifyLifecycleRecommendation({
      skillId: 'sk-x', skillVersion: '1.0.0', hasMatchingSkill: true, outcome: 'better', evidenceComplete: true, repeatCount: 3, attributionClear: false,
    });
    expect(notAttr.noChangeReason).toBe('not_attributable');

    const oneOff = m.classifyLifecycleRecommendation({
      skillId: 'sk-x', skillVersion: '1.0.0', hasMatchingSkill: true, outcome: 'better', evidenceComplete: true, repeatCount: 1, attributionClear: true,
    });
    expect(oneOff.noChangeReason).toBe('below_repeat_threshold');
  });

  it('证据完整+归因清晰+重复达标：better/worse → update；same → no_change(covered)', async () => {
    const m = await loadMod();
    const better = m.classifyLifecycleRecommendation({
      skillId: 'sk-x', skillVersion: '1.0.0', hasMatchingSkill: true, outcome: 'better', evidenceComplete: true, repeatCount: 2, attributionClear: true,
    });
    expect(better.recommendationType).toBe('update');
    const worse = m.classifyLifecycleRecommendation({
      skillId: 'sk-x', skillVersion: '1.0.0', hasMatchingSkill: true, outcome: 'worse', evidenceComplete: true, repeatCount: 2, attributionClear: true,
    });
    expect(worse.recommendationType).toBe('update');
    expect(worse.reason).toContain('负迁移');
    const same = m.classifyLifecycleRecommendation({
      skillId: 'sk-x', skillVersion: '1.0.0', hasMatchingSkill: true, outcome: 'same', evidenceComplete: true, repeatCount: 2, attributionClear: true,
    });
    expect(same.recommendationType).toBe('no_change');
    expect(same.noChangeReason).toBe('covered_by_existing_version');
  });
});

describe('skill-lifecycle › flag 门控', () => {
  it('skilllifecycle flag 关闭 → 记录被拒（双保险）', async () => {
    const m = await loadMod();
    const flags = await import(FLAGS);
    flags.setP3394Flag('skilllifecycle', false);
    await expect(m.recordSkillLifecycleRecommendation(UID, {
      recommendationType: 'create', skillId: 'sk-flag', reason: 'r', triggerRefs: [],
    })).rejects.toThrow('disabled by feature flag');
    // 恢复默认
    flags.setP3394Flag('skilllifecycle', true);
    const ok = await m.recordSkillLifecycleRecommendation(UID, {
      recommendationType: 'create', skillId: 'sk-flag', reason: 'r', triggerRefs: [],
    });
    expect(ok.recommendation_id).toBeDefined();
  });
});
