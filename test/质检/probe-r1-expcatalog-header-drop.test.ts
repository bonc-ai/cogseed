// 经验目录截断后仍保留页眉、条目计数与读取完整正文的指引。
// 构造超过内联条目上限的目录，实际调用提示装配入口观察结果。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-exp-cat-hdr';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-expcat-hdr-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const TASK_TEXT = '修复登录函数的缺陷';

describe('experience catalog hint truncation drops header (probe)', () => {
  it('截断后的清单文本保留页眉两行（取正文指引与计数不再丢失）', async () => {
    const users = await import('../../src/main/features/users');
    users.activateUser(UID);
    const service = await import('../../src/main/features/recall/experience-service');
    const similarity = await import('../../src/main/features/recall/similarity');
    similarity.clearEmbedCacheForTest();
    similarity._injectEmbeddingForTest(UID, TASK_TEXT, [1, 0]);
    const sharedBody = '同类型经验正文样本。';
    similarity._injectEmbeddingForTest(UID, sharedBody, [1, 0]);

    for (let i = 1; i <= 32; i += 1) {
      const now = new Date(Date.now() + i * 1_000).toISOString();
      await service.createExperience(UID, {
        id: `exp-hdr-${String(i).padStart(4, '0')}`,
        source: {
          episodeId: `kse-exp-hdr-${i}`,
          taskGoal: '修复登录超时',
          taskType: 'code' as const,
          taskStatus: 'confirmed' as const,
        },
        experienceType: 'lesson' as const,
        title: `经验-${i}`,
        body: sharedBody,
        scope: 'code',
        verification: {
          state: 'confirmed' as const,
          outcome: 'better_than_expected' as const,
          deltaR: 0.3,
          confidence: 0.8,
        },
        evidenceRefs: [{ kind: 'conversation' as const, id: `conv-${i}` }],
        learningProvenance: {
          projectionId: `prj-${i}`,
          episodeId: `kse-exp-hdr-${i}`,
          ruleRefs: [],
          attribution: 'execution_gap' as const,
        },
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
      });
    }

    const hint = await import('../../src/main/features/recall/experience-catalog-hint');
    const catalog = await import('../../src/main/features/recall/experience-catalog');
    const built = await catalog.buildExperienceCatalog(UID, TASK_TEXT);
    // 前提：确实触发了 >30 截断分支的输入形态。
    expect(built.entries.length).toBeGreaterThan(30);
    expect(built.text).toContain('read_task_experience');

    const truncated = await hint.experienceCatalogForPrompt(UID, 'cid-hdr', 1_000, TASK_TEXT);
    // 修复后断言：页眉两行被复写进截断文本——取正文指引与 Experience
    // catalog 计数行都在，hint 层截断条目时保留页眉。
    expect(truncated).toContain('read_task_experience');
    expect(truncated).toContain('Experience catalog');
    expect(truncated).toContain('还有 12 条');
  });
});
