import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'user-personal';
let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-personal-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function review(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    ownerId: UID,
    id: 'ksr-kse-personal',
    episodeId: 'kse-personal',
    deltaR: 'unknown' as const,
    deltaA: 'unknown' as const,
    outcome: 'met_expected' as const,
    attribution: 'unclear' as const,
    reason: '任务完成。',
    confidence: 0.9,
    evidenceRefs: [{ kind: 'execution', id: 'exec-personal' }],
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:01:00.000Z',
    ...overrides,
  };
}

describe('personalLessonEligible（确定性校验，双闸第二闸）', () => {
  it('accepts a model-nominated personal lesson backed by long-term user evidence', async () => {
    const { personalLessonEligible } = await import('../../../../src/main/features/kstar/personal-profile-sync');
    const r = review({
      lesson: '我以后的周报都要按四段模板组织：本周完成/数据指标/风险与阻塞/下周计划。',
      lessonPersonal: true,
    });
    expect(personalLessonEligible(r, [{ text: '我以后的周报都要按这个格式：1.本周完成 2.数据指标 3.风险与阻塞 4.下周计划' }])).toBe(true);
  });

  it('accepts identity statements（"我是团队负责人"）', async () => {
    const { personalLessonEligible } = await import('../../../../src/main/features/kstar/personal-profile-sync');
    const r = review({
      lesson: '我是团队负责人，负责周报与团队协调。',
      lessonPersonal: true,
    });
    expect(personalLessonEligible(r, [{ text: '我是团队负责人' }])).toBe(true);
  });

  it('rejects without model nomination（lessonPersonal false）', async () => {
    const { personalLessonEligible } = await import('../../../../src/main/features/kstar/personal-profile-sync');
    const r = review({
      lesson: '城市资料应包含概况/历史/现状。',
      lessonPersonal: false,
    });
    expect(personalLessonEligible(r, [{ text: '我以后的周报都要按这个格式' }])).toBe(false);
  });

  it('rejects one-off requests（"今天帮我写诗"）despite nomination', async () => {
    const { personalLessonEligible } = await import('../../../../src/main/features/kstar/personal-profile-sync');
    const r = review({
      lesson: '今天写诗要用意象丰富的风格。',
      lessonPersonal: true,
    });
    expect(personalLessonEligible(r, [{ text: '今天帮我写一首诗' }])).toBe(false);
  });

  it('rejects project facts（"本周上线支付网关"）despite nomination', async () => {
    const { personalLessonEligible } = await import('../../../../src/main/features/kstar/personal-profile-sync');
    const r = review({
      lesson: '本周上线了支付网关。',
      lessonPersonal: true,
    });
    expect(personalLessonEligible(r, [{ text: '本周要上线支付网关' }])).toBe(false);
  });

  it('falls back to lesson wording when user messages lack the phrase', async () => {
    const { personalLessonEligible } = await import('../../../../src/main/features/kstar/personal-profile-sync');
    const r = review({
      lesson: '我的编码习惯是用 tab 缩进，不用空格。',
      lessonPersonal: true,
    });
    // 用户消息没命中长期模式（可能被截断），但 lesson 自身含"我的…习惯"。
    expect(personalLessonEligible(r, [{ text: '这个文件帮我改成 tab 缩进' }])).toBe(true);
  });
});

describe('syncPersonalLessonToProfile（写入 USER.md）', () => {
  it('writes a verified personal lesson into USER.md and is idempotent', async () => {
    const sync = await import('../../../../src/main/features/kstar/personal-profile-sync');
    const r = review({
      lesson: '我以后的周报都要按四段模板组织：本周完成/数据指标/风险与阻塞/下周计划。',
      lessonPersonal: true,
    });
    const userMessages = [{ text: '我以后的周报都要按这个格式' }];

    const first = await sync.syncPersonalLessonToProfile(UID, r, userMessages);
    const second = await sync.syncPersonalLessonToProfile(UID, r, userMessages);

    expect(first).toBe(true);
    expect(second).toBe(true); // 幂等：去重后仍 ok（no-op）
    const { userProfileFile } = await import('../../../../src/main/paths');
    const profile = fs.readFileSync(userProfileFile(UID), 'utf8');
    expect(profile).toContain('我以后的周报都要按四段模板组织');
    // 精确去重：同文本只出现一次
    const occurrences = profile.split('我以后的周报都要按四段模板组织').length - 1;
    expect(occurrences).toBe(1);
  });

  it('does not write when the lesson is not personal', async () => {
    const sync = await import('../../../../src/main/features/kstar/personal-profile-sync');
    const r = review({
      lesson: '城市资料应包含概况/历史/现状。',
      lessonPersonal: false,
    });
    const ok = await sync.syncPersonalLessonToProfile(UID, r, [{ text: '帮我写城市资料' }]);
    expect(ok).toBe(false);
    const { userProfileFile } = await import('../../../../src/main/paths');
    expect(fs.existsSync(userProfileFile(UID))).toBe(false);
  });
});
