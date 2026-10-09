/**
 * 候选写路径的失败必须带**稳定错误码**。
 *
 * 渲染层按 code 出中文（skills-bindings.js::_recallCandidateErrorText）。只要
 * 这里退回裸 `new Error(...)`，用户就会重新在弹窗里看到内部英文契约语言——
 * 这正是这条链路此前的实机故障。message 保持原样（日志与既有断言仍读它），
 * 用例只钉 code。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-candidate-error-codes-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function service() {
  return import('../../../../src/main/features/recall/candidate-service');
}

const BASE = {
  judgment: 'Always confirm the rollout scope before shipping a config change.',
  summary: 'Confirm rollout scope',
  value: 'Scope confirmation prevents unscoped config rollouts.',
  suggestedType: 'rule' as const,
  suggestedScope: 'product',
  sourceRefs: [{ kind: 'memory' as const, id: 'mem-scope' }],
};

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return String((error as { code?: unknown }).code || '');
  }
  throw new Error('expected the call to reject');
}

describe('recall candidate error codes', () => {
  it('codes a missing candidate read', async () => {
    const candidates = await service();
    expect(await codeOf(() => candidates.readRecallCandidate('user-a', 'rcand-missing')))
      .toBe('recall_candidate_not_found');
  });

  it('codes the high-risk gate when the user has not acknowledged the risk', async () => {
    const candidates = await service();
    const saved = await candidates.saveRecallCandidate('user-a', { ...BASE, risk: 'high' });
    expect(await codeOf(() => candidates.promoteRecallCandidate('user-a', saved.id, { actor: 'user' })))
      .toBe('recall_candidate_risk_gate');
  });

  it('codes a non-asset verdict routed into promotion', async () => {
    const candidates = await service();
    const saved = await candidates.saveRecallCandidate('user-a', { ...BASE, suggestedAction: 'keep_current' });
    expect(await codeOf(() => candidates.promoteRecallCandidate('user-a', saved.id, { actor: 'user' })))
      .toBe('recall_candidate_non_asset_decision');
  });

  it('codes an edit that lands on a terminal candidate', async () => {
    const candidates = await service();
    const saved = await candidates.saveRecallCandidate('user-a', BASE);
    await candidates.rejectRecallCandidate('user-a', saved.id, 'not reusable');
    expect(await codeOf(() => candidates.updateRecallCandidate('user-a', saved.id, BASE)))
      .toBe('recall_candidate_terminal');
  });

  it('skips one malformed record instead of failing the whole candidate list', async () => {
    const candidates = await service();
    const healthy = await candidates.saveRecallCandidate('user-a', BASE);

    // 手工写一条违反 asCandidate 不变量的记录（pending_review 却没有证据）。
    // 旧行为：`.map(asCandidate)` 一抛，recall.candidates.list 整体失败，
    // 「待我处理」和候选池同时清空——用户看到的是"我的候选全没了"。
    const dir = path.dirname(
      [...walk(tmpDir)].find((file) => file.endsWith(`${healthy.id}.json`))!,
    );
    // 两层不变量各一条：store 的 validateRecallRecord（缺 schemaVersion）与
    // candidate-service 的 asCandidate（pending_review 却没有证据）。
    fs.writeFileSync(path.join(dir, 'rcand-noenvelope.json'), JSON.stringify({
      id: 'rcand-noenvelope', judgment: 'broken', suggestedType: 'rule', suggestedScope: 'product',
      sourceRefs: [], evidenceRefs: [], status: 'pending_review',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(dir, 'rcand-noevidence.json'), JSON.stringify({
      schemaVersion: 1, ownerId: 'user-a', id: 'rcand-noevidence',
      judgment: 'broken', suggestedType: 'rule', suggestedScope: 'product',
      sourceRefs: [], evidenceRefs: [], status: 'pending_review',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    }));

    const listed = await candidates.listRecallCandidates('user-a');
    expect(listed.map((item) => item.id)).toEqual([healthy.id]);
  });

  it('codes an edit that collides with an existing candidate', async () => {
    const candidates = await service();
    const first = await candidates.saveRecallCandidate('user-a', BASE);
    const second = await candidates.saveRecallCandidate('user-a', {
      ...BASE,
      judgment: 'Keep the staging database seeded before a demo run.',
    });
    expect(second.id).not.toBe(first.id);
    expect(await codeOf(() => candidates.updateRecallCandidate('user-a', second.id, BASE)))
      .toBe('recall_candidate_duplicate');
  });
});

/**
 * 证据引用不接受用户自造的 id。
 *
 * `normalizeCognitionSourceRef` 只校验形状（kind 在白名单、id 过 safeId 的格式
 * 检查），`isCognitionSourceEnabled` 在查不到控制记录时默认放行——两者都不回答
 * "这个来源真的存在吗"。而证据非空正是 reviewReady 与 candidate-capabilities
 * 里 canPromote 的判据，所以编造一条 ref 就能把只读候选变成可晋升，并作为正式
 * 资产的证据链落库。渲染层已改成只读+可删，但 recall.candidates.update 这个
 * IPC 通道对任何调用方都开着，闸必须在服务端。
 */
describe('更新候选时的证据来源校验', () => {
  it('新增一条来源目录里查不到的引用 → 保存失败，带稳定错误码', async () => {
    const candidates = await service();
    const saved = await candidates.saveRecallCandidate('user-a', {
      judgment: '发布前先跑冒烟',
      value: '减少回滚',
      summary: '发布前冒烟',
      suggestedType: 'rule',
      suggestedScope: 'review',
      suggestedAction: 'create',
      applicableWhen: ['发布前'],
      forbiddenWhen: ['本地调试'],
      sourceRefs: [{ kind: 'execution_evaluation', id: 'exec-real' }],
      evidenceRefs: [{ kind: 'execution_evaluation', id: 'exec-real' }],
    });

    await expect(candidates.updateRecallCandidate('user-a', saved.id, {
      judgment: saved.judgment,
      value: saved.value,
      summary: saved.summary,
      suggestedType: saved.suggestedType,
      suggestedScope: saved.suggestedScope,
      suggestedAction: saved.suggestedAction,
      applicableWhen: saved.applicableWhen,
      forbiddenWhen: saved.forbiddenWhen,
      // 编造的一条：格式合法，但来源目录里不存在
      sourceRefs: [...saved.sourceRefs, { kind: 'conversation', id: 'conv-made-up' }],
    } as never)).rejects.toMatchObject({ code: 'recall_candidate_unknown_source' });
  });

  it('原样提交已有引用不受影响——旧记录可能指向已删除的来源，不该由一次编辑触发迁移', async () => {
    const candidates = await service();
    const saved = await candidates.saveRecallCandidate('user-a', {
      judgment: '评审要留结论',
      value: '避免重复讨论',
      summary: '评审留结论',
      suggestedType: 'rule',
      suggestedScope: 'review',
      suggestedAction: 'create',
      applicableWhen: ['评审时'],
      forbiddenWhen: ['头脑风暴'],
      sourceRefs: [{ kind: 'execution_evaluation', id: 'exec-legacy' }],
      evidenceRefs: [{ kind: 'execution_evaluation', id: 'exec-legacy' }],
    });

    const updated = await candidates.updateRecallCandidate('user-a', saved.id, {
      judgment: '评审要留结论（改过）',
      value: saved.value,
      summary: saved.summary,
      suggestedType: saved.suggestedType,
      suggestedScope: saved.suggestedScope,
      suggestedAction: saved.suggestedAction,
      applicableWhen: saved.applicableWhen,
      forbiddenWhen: saved.forbiddenWhen,
      sourceRefs: saved.sourceRefs,
    } as never);
    expect(updated.judgment).toBe('评审要留结论（改过）');
  });
});

/**
 * 来源超过展示窗口时，合法引用不能被判成"不存在"。
 *
 * 原实现拿 `listCognitionSources(..., { limit: 100 })` 的前 100 条构造 key 集合
 * 当存在性判据。而这个 limit 上限就是 100，且是在 adapter **内部**截断的
 * （`conversations.slice(0, query.limit)` 等），所以来源多于 100 条时，第 101 条
 * 之后的合法来源必然落在窗口外 → 被拒成 recall_candidate_unknown_source。
 * 那是把展示分页伪装成真实性结论。
 *
 * 现在改为 cognitionExistingSourceIds：按 kind 全量枚举、精确匹配 id、不设窗口。
 */
describe('来源数量超过展示窗口时的存在性判定', () => {
  const TOTAL = 160;

  async function seedExecutions() {
    const executions = await import('../../../../src/main/features/execution-records');
    for (let index = 0; index < TOTAL; index += 1) {
      await executions.create('user-a', {
        executionId: `exec-seed-${String(index).padStart(3, '0')}`,
        kind: 'core-agent',
        sessionId: 'gconv-seed',
        conversationId: 'seedconv',
        boundary: 'real',
        permissionMode: 'read-only',
      } as never);
    }
  }

  /**
   * 从**窗口之外**挑目标，而不是假设"第 111 条就在窗口外"——
   * executionRecords.list() 的排序不由本用例决定，写死序号会让这条用例
   * 在排序变化时静默失效（目标落回窗口内，测了个寂寞）。
   */
  async function outsideWindowIds(count: number): Promise<string[]> {
    const catalog = await import('../../../../src/main/features/recall/source-catalog');
    const windowed = await catalog.listCognitionSources('user-a', {
      kinds: ['execution_evaluation'], limit: 100,
    });
    const windowIds = new Set(windowed.flatMap((group) => group.items.map((item) => item.id)));
    const all = Array.from({ length: TOTAL }, (_, index) => `exec-seed-${String(index).padStart(3, '0')}`);
    const outside = all.filter((id) => !windowIds.has(id));
    // 窗口确实截断了：这是本组用例成立的前提。
    expect(outside.length).toBeGreaterThan(0);
    return outside.slice(0, count);
  }

  async function baseCandidate() {
    const candidates = await service();
    return candidates.saveRecallCandidate('user-a', {
      ...BASE,
      applicableWhen: ['评审时'],
      forbiddenWhen: ['头脑风暴'],
    } as never);
  }

  function updateWith(saved: Record<string, any>, sourceRefs: unknown[]) {
    return service().then((candidates) => candidates.updateRecallCandidate('user-a', saved.id, {
      judgment: saved.judgment,
      value: saved.value,
      summary: saved.summary,
      suggestedType: saved.suggestedType,
      suggestedScope: saved.suggestedScope,
      suggestedAction: saved.suggestedAction,
      applicableWhen: saved.applicableWhen,
      forbiddenWhen: saved.forbiddenWhen,
      sourceRefs,
    } as never));
  }

  it('落在原 100 窗口之外的合法来源，作为新增证据可以正常保存', async () => {
    await seedExecutions();
    const [targetId] = await outsideWindowIds(1);
    const saved = await baseCandidate();

    // 精确查询认得它——而列表窗口不认（上面 outsideWindowIds 已经断言过）。
    const catalog = await import('../../../../src/main/features/recall/source-catalog');
    expect(await catalog.cognitionSourceExists('user-a', 'execution_evaluation', targetId)).toBe(true);

    const updated = await updateWith(saved, [
      ...saved.sourceRefs,
      { kind: 'execution_evaluation', id: targetId },
    ]);
    expect(updated.sourceRefs.some((ref: Record<string, unknown>) => ref.id === targetId)).toBe(true);
  });

  it('同一次更新新增多条同类引用时，按 kind 只枚举一次', async () => {
    await seedExecutions();
    const ids = await outsideWindowIds(3);
    const saved = await baseCandidate();

    const updated = await updateWith(saved, [
      ...saved.sourceRefs,
      ...ids.map((id) => ({ kind: 'execution_evaluation', id })),
    ]);
    for (const id of ids) {
      expect(updated.sourceRefs.some((ref: Record<string, unknown>) => ref.id === id)).toBe(true);
    }
  });

  it('真正不存在的引用仍然被拒，且带稳定错误码', async () => {
    await seedExecutions();
    const saved = await baseCandidate();
    await expect(updateWith(saved, [
      ...saved.sourceRefs,
      { kind: 'execution_evaluation', id: 'exec-seed-999' },
    ])).rejects.toMatchObject({ code: 'recall_candidate_unknown_source' });
  });

  it('候选自带一条目录解析不出来的历史引用，原样提交不受阻', async () => {
    const candidates = await service();
    // BASE.sourceRefs 是 memory:mem-scope —— 目录里查不到它。
    const saved = await candidates.saveRecallCandidate('user-a', {
      ...BASE,
      applicableWhen: ['评审时'],
      forbiddenWhen: ['头脑风暴'],
    } as never);
    const updated = await updateWith({ ...saved, judgment: '改过的判断' }, saved.sourceRefs);
    expect(updated.judgment).toBe('改过的判断');
  });
});
