import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// specs/016 T007/T008：经验清单构建（无关类型零出现 / 不含正文 / 被拦零出现）
// 与提示词 hint（缺席不输出「0 条」/ 被拦的已挂载经验恰好一条 omitted 且只含标题）。

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-exp-cat';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-experience-cat-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface SeedInput {
  id: string;
  taskType: 'report' | 'code' | 'review' | 'product' | 'general';
  taskGoal: string;
  body: string;
  title?: string;
  status?: 'active' | 'paused' | 'archived' | 'merged';
  forbiddenWhen?: string[];
  updatedAt?: string;
}

function seedInput(spec: SeedInput) {
  const now = spec.updatedAt || new Date().toISOString();
  return {
    id: spec.id,
    source: {
      episodeId: `kse-${spec.id}`,
      taskGoal: spec.taskGoal,
      taskType: spec.taskType,
      taskStatus: 'confirmed',
    },
    experienceType: 'lesson' as const,
    title: spec.title || `经验-${spec.id}`,
    body: spec.body,
    scope: spec.taskType,
    verification: {
      state: 'confirmed' as const,
      outcome: 'better_than_expected' as const,
      deltaR: 0.3,
      confidence: 0.8,
    },
    evidenceRefs: [{ kind: 'conversation' as const, id: `conv-${spec.id}` }],
    learningProvenance: {
      projectionId: `prj-${spec.id}`,
      episodeId: `kse-${spec.id}`,
      ruleRefs: [],
      attribution: 'execution_gap' as const,
    },
    ...(spec.forbiddenWhen ? { forbiddenWhen: spec.forbiddenWhen } : {}),
    status: spec.status || 'active' as const,
    createdAt: now,
    updatedAt: now,
  };
}

async function setup() {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  const service = await import('../../../../src/main/features/recall/experience-service');
  return service;
}

/** 与 hint/catalog 同一套 embedding 工具的测试注入口：不注入的文本会走
 *  本地 ONNX 真实嵌入，测试里全部注入，保证相关度可精确控制。 */
async function injectEmbeddings(pairs: Array<[string, number[]]>): Promise<void> {
  const similarity = await import('../../../../src/main/features/recall/similarity');
  similarity.clearEmbedCacheForTest();
  for (const [text, vector] of pairs) similarity._injectEmbeddingForTest(UID, text, vector);
}

const TASK_TEXT = '修复登录函数的缺陷';

describe('experience catalog build (T007)', () => {
  it('keeps unrelated task types and blocked entries out of the catalog, never leaks body text', async () => {
    const service = await setup();
    await injectEmbeddings([
      [TASK_TEXT, [1, 0]],
      // 同类型（code）且相关 → 进清单，标 ★。
      ['先写回归测试再修复登录函数。BODY-SECRET-CODE1', [0.95, 0.31]],
      // 通用（general）且相关度达标（cos≈0.90）→ 进清单。
      ['任务收尾时同步更新检查清单。BODY-SECRET-GEN1', [0.9, 0.44]],
      // 通用但相关度不达标（cos≈0.30 < 0.40）→ 缺席。
      ['会议纪要要当天发出。BODY-SECRET-GEN2', [0.3, 0.954]],
      // 无关类型（report）即使相关度达标也零出现（AC1）。
      ['季度报告要带数据附录。BODY-SECRET-RPT1', [0.95, 0.31]],
    ]);
    const catalog = await import('../../../../src/main/features/recall/experience-catalog');

    await service.createExperience(UID, seedInput({
      id: 'exp-cat-code-1', taskType: 'code', taskGoal: '修复登录超时',
      body: '先写回归测试再修复登录函数。BODY-SECRET-CODE1',
    }));
    await service.createExperience(UID, seedInput({
      id: 'exp-cat-gen-1', taskType: 'general', taskGoal: '任务收尾流程',
      body: '任务收尾时同步更新检查清单。BODY-SECRET-GEN1',
    }));
    await service.createExperience(UID, seedInput({
      id: 'exp-cat-gen-2', taskType: 'general', taskGoal: '会议纪要习惯',
      body: '会议纪要要当天发出。BODY-SECRET-GEN2',
    }));
    await service.createExperience(UID, seedInput({
      id: 'exp-cat-rpt-1', taskType: 'report', taskGoal: '季度报告撰写',
      body: '季度报告要带数据附录。BODY-SECRET-RPT1',
    }));
    // 非 active：不该出现在清单。
    await service.createExperience(UID, seedInput({
      id: 'exp-cat-paused', taskType: 'code', taskGoal: '修复登录超时',
      body: '暂停的经验不出清单。BODY-SECRET-PAUSED', status: 'paused',
    }));
    // active 但命中自己声明的禁用范围：准入拦下，零出现。
    await service.createExperience(UID, seedInput({
      id: 'exp-cat-forbid', taskType: 'code', taskGoal: '修复登录超时',
      body: '被禁用范围拦住的经验。BODY-SECRET-FORBID', forbiddenWhen: ['登录函数'],
    }));

    const built = await catalog.buildExperienceCatalog(UID, TASK_TEXT);
    expect(built.entries.map((entry) => entry.id)).toEqual(['exp-cat-code-1', 'exp-cat-gen-1']);

    // 无关类型 / 不达标通用 / 被拦条目零出现。
    for (const absent of ['exp-cat-rpt-1', 'exp-cat-gen-2', 'exp-cat-paused', 'exp-cat-forbid']) {
      expect(built.text).not.toContain(absent);
    }
    // 清单文本不含正文（受限正文边界）。
    expect(built.text).not.toContain('BODY-SECRET');
    // 单行一条：清单行内无换行。
    for (const line of built.lines) expect(line).not.toContain('\n');
    // 相关条目带 ★ 标记。
    expect(built.entries.map((entry) => entry.relevant)).toEqual([true, true]);
  });

  it('sorts by relevance class then recency', async () => {
    const service = await setup();
    const older = new Date(Date.now() - 10_000).toISOString();
    const newer = new Date().toISOString();
    await injectEmbeddings([
      [TASK_TEXT, [1, 0]],
      ['相关经验甲。', [1, 0]],
      ['无关同类型经验乙。', [0, 1]],
      ['相关经验丙。', [1, 0]],
    ]);
    const catalog = await import('../../../../src/main/features/recall/experience-catalog');

    // 三条同类型（code）：丙最新但无关，甲相关，乙无关且更旧。
    await service.createExperience(UID, seedInput({
      id: 'exp-sort-relevant-old', taskType: 'code', taskGoal: '修复登录超时',
      body: '相关经验甲。', updatedAt: older,
    }));
    await service.createExperience(UID, seedInput({
      id: 'exp-sort-irrelevant-old', taskType: 'code', taskGoal: '修复登录超时',
      body: '无关同类型经验乙。', updatedAt: older,
    }));
    await service.createExperience(UID, seedInput({
      id: 'exp-sort-relevant-new', taskType: 'code', taskGoal: '修复登录超时',
      body: '相关经验丙。', updatedAt: newer,
    }));

    const built = await catalog.buildExperienceCatalog(UID, TASK_TEXT);
    // ★（相关）优先于无关；同为相关的近者在前。
    expect(built.entries.map((entry) => entry.id)).toEqual([
      'exp-sort-relevant-new', 'exp-sort-relevant-old', 'exp-sort-irrelevant-old',
    ]);
  });
});

describe('experience catalog hint (T008)', () => {
  it('returns an empty string (never a "0 条" line) when the catalog is absent', async () => {
    await setup();
    const hint = await import('../../../../src/main/features/recall/experience-catalog-hint');
    const text = await hint.experienceCatalogForPrompt(UID, 'cid-cat-empty', 1_000);
    expect(text).toBe('');
    expect(text).not.toContain('0');
  });

  it('emits exactly one title-only omitted receipt per blocked mounted experience', async () => {
    const service = await setup();
    await injectEmbeddings([
      [TASK_TEXT, [1, 0]],
      ['挂载且通过准入的经验正文。BODY-SECRET-OK', [0.95, 0.31]],
      ['被暂停的挂载经验正文。BODY-SECRET-PAUSED', [0.95, 0.31]],
    ]);
    const catalog = await import('../../../../src/main/features/recall/experience-catalog');
    const hint = await import('../../../../src/main/features/recall/experience-catalog-hint');
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');

    const ok = await service.createExperience(UID, seedInput({
      id: 'exp-hint-ok', taskType: 'code', taskGoal: '修复登录超时',
      body: '挂载且通过准入的经验正文。BODY-SECRET-OK',
    }));
    const paused = await service.createExperience(UID, seedInput({
      id: 'exp-hint-paused', taskType: 'code', taskGoal: '修复登录超时',
      body: '被暂停的挂载经验正文。BODY-SECRET-PAUSED', status: 'paused',
    }));

    const built = await catalog.buildExperienceCatalog(UID, TASK_TEXT, {
      mountedExperienceIds: [ok.id, paused.id],
    });
    // omitted 恰好一条：只含标题与理由码，无正文字段。
    expect(built.omitted).toHaveLength(1);
    expect(built.omitted[0]).toMatchObject({ id: paused.id, reason: 'status_not_active' });
    expect(built.omitted[0].title).toBe('经验-exp-hint-paused');
    expect('body' in built.omitted[0]).toBe(false);
    expect(JSON.stringify(built.omitted)).not.toContain('BODY-SECRET');

    const text = await hint.experienceCatalogForPrompt(UID, 'cid-cat', 1_000, TASK_TEXT, {
      taskRunId: 'turn-exp-1',
      experienceIds: [ok.id, paused.id],
    });
    expect(text).toContain(ok.id);
    expect(text).not.toContain(paused.id);
    expect(text).not.toContain('BODY-SECRET');

    const listed = await receipts.listInjectionReceipts(UID, 'turn-exp-1');
    const omitted = listed.filter((receipt) => receipt.channel === 'experience' && receipt.status === 'omitted');
    expect(omitted).toHaveLength(1);
    expect(omitted[0].assetId).toBe(paused.id);
    expect(omitted[0].reason).toBe('status_not_active');
    // 回执只存 id/版本/理由码：标题与正文都不落。
    expect('title' in omitted[0]).toBe(false);
    expect(JSON.stringify(omitted)).not.toContain('BODY-SECRET');

    // 同轮重复构建：幂等键兜底，仍只有一条。
    await hint.experienceCatalogForPrompt(UID, 'cid-cat', 1_100, TASK_TEXT, {
      taskRunId: 'turn-exp-1',
      experienceIds: [ok.id, paused.id],
    });
    const again = await receipts.listInjectionReceipts(UID, 'turn-exp-1');
    expect(again.filter((receipt) => receipt.channel === 'experience' && receipt.status === 'omitted')).toHaveLength(1);
  });

  it('rebuilds without task text so current eligibility changes are reflected', async () => {
    const service = await setup();
    const hint = await import('../../../../src/main/features/recall/experience-catalog-hint');
    const REPORT_TASK = '写季度总结报告';
    await injectEmbeddings([
      [REPORT_TASK, [1, 0]],
      ['通用经验第一条。', [0.95, 0.31]],
      ['通用经验第二条。', [0.95, 0.31]],
    ]);

    await service.createExperience(UID, seedInput({
      id: 'exp-cache-1', taskType: 'general', taskGoal: '通用任务',
      body: '通用经验第一条。',
    }));
    const first = await hint.experienceCatalogForPrompt(UID, 'cid-cache', 1_000);
    expect(first).toContain('exp-cache-1');

    // 新增条目后即刻刷新：资格可能随上下文变化，不能复用旧清单文本。
    await service.createExperience(UID, seedInput({
      id: 'exp-cache-2', taskType: 'general', taskGoal: '通用任务',
      body: '通用经验第二条。',
    }));
    const refreshed = await hint.experienceCatalogForPrompt(UID, 'cid-cache', 11_000);
    expect(refreshed).not.toBe(first);
    expect(refreshed).toContain('exp-cache-2');

    // 带 taskText 的调用不落也不读缓存：能看到新条目。
    const taskScoped = await hint.experienceCatalogForPrompt(UID, 'cid-cache', 12_000, REPORT_TASK);
    expect(taskScoped).toContain('exp-cache-2');
  });

  // specs/016 T023 ①：清单**接入提示词后**无关任务类型零出现。build 层的口径
  // 已由上一条 describe 钉住，这里补 hint 层（提示词文本最终形态）的回归钉——
  // 防的是 hint 追加/截断逻辑日后把被过滤的条目重新带进提示词。
  it('keeps unrelated task types out of the assembled prompt text (FR-003)', async () => {
    const service = await setup();
    await injectEmbeddings([
      [TASK_TEXT, [1, 0]],
      ['先写回归测试再修复登录函数。BODY-SECRET-PROMPT-CODE', [0.95, 0.31]],
      ['季度报告要带数据附录。BODY-SECRET-PROMPT-RPT', [0.95, 0.31]],
    ]);
    const hint = await import('../../../../src/main/features/recall/experience-catalog-hint');

    await service.createExperience(UID, seedInput({
      id: 'exp-prompt-code-1', taskType: 'code', taskGoal: '修复登录超时',
      body: '先写回归测试再修复登录函数。BODY-SECRET-PROMPT-CODE',
    }));
    await service.createExperience(UID, seedInput({
      id: 'exp-prompt-rpt-1', taskType: 'report', taskGoal: '季度报告撰写',
      body: '季度报告要带数据附录。BODY-SECRET-PROMPT-RPT',
    }));

    const text = await hint.experienceCatalogForPrompt(UID, 'cid-prompt-filter', 1_000, TASK_TEXT);
    // 同类型条目进提示词；无关类型（report）即使相关度达标也零出现；正文不进提示词。
    expect(text).toContain('exp-prompt-code-1');
    expect(text).not.toContain('exp-prompt-rpt-1');
    expect(text).not.toContain('BODY-SECRET');
  });

  it('caps inline entries and points to the paging tool beyond the cap', async () => {
    const service = await setup();
    const sharedBody = '同类型经验正文样本。';
    await injectEmbeddings([
      [TASK_TEXT, [1, 0]],
      [sharedBody, [1, 0]],
    ]);
    const hint = await import('../../../../src/main/features/recall/experience-catalog-hint');
    expect(hint.INLINE_EXPERIENCE_CATALOG_MAX_ENTRIES).toBe(30);

    for (let i = 1; i <= 32; i += 1) {
      await service.createExperience(UID, seedInput({
        id: `exp-ovf-${String(i).padStart(4, '0')}`,
        taskType: 'code',
        taskGoal: '修复登录超时',
        body: sharedBody,
        updatedAt: new Date(Date.now() + i * 1_000).toISOString(),
      }));
    }
    const text = await hint.experienceCatalogForPrompt(UID, 'cid-ovf', 1_000, TASK_TEXT);
    const entryLines = text.split('\n').filter((line) => line.includes('[exp:exp-ovf-'));
    expect(entryLines).toHaveLength(20);
    expect(text).toContain('还有 12 条');
    // 近度降序取前 20：最旧的 0012 起被截出内联清单。
    expect(text).not.toContain('[exp:exp-ovf-0012]');
  });
});
