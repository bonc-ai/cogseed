import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { KstarAdmissionContext } from '../../../../src/main/features/kstar/improvement-admission';
import type { KstarCandidateProposal } from '../../../../src/main/features/kstar/types';

// specs/015 T007/T008：改进提案准入**唯一处**。
// 门 = 「实际采用」唯一权威口径（usage 回执 `applied` + `boundary='real'`）：
// 更新型提案（update/limit_scope/pause + targetAssetId）必须证明"任务里真的用过这一版"，
// 「被带入」（注入回执 injected/dispatched）不算；版本对不上同样拦（改错版本 = 改错对象）。

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-improvement-admission-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

const USER = 'user-admission';
const ASSET = 'asset-method-a';

async function modules() {
  const [admission, usage, injections, outcome] = await Promise.all([
    import('../../../../src/main/features/kstar/improvement-admission'),
    import('../../../../src/main/features/recall/asset-usage-receipt'),
    import('../../../../src/main/features/recall/injection-receipt'),
    import('../../../../src/main/features/kstar/improvement-outcome'),
  ]);
  return { admission, usage, injections, outcome };
}

type UsageStatus =
  | 'applied'
  | 'considered_not_applicable'
  | 'available_no_opportunity'
  | 'contradicted'
  | 'usage_unknown';

/** 与真实链路同序：先落注入回执（usage 回执的外键），再落使用回执。 */
async function recordUsage(input: {
  taskRunId: string;
  assetId?: string;
  assetVersion?: string;
  status: UsageStatus;
  injectionStatus?: 'injected' | 'dispatched';
}) {
  const { usage, injections } = await modules();
  const assetId = input.assetId ?? ASSET;
  const assetVersion = input.assetVersion ?? '1';
  const injection = await injections.recordInjectionReceipt(USER, {
    taskRunId: input.taskRunId,
    projectionId: 'proj-admission',
    assetId,
    assetVersion,
    boundary: 'real',
    status: input.injectionStatus ?? 'injected',
    messageId: `message-${input.taskRunId}`,
  });
  const applied = input.status === 'applied';
  const receipt = await usage.recordAssetUsageReceipt(USER, {
    taskRunId: input.taskRunId,
    projectionId: 'proj-admission',
    assetId,
    assetVersion,
    injectionReceiptId: injection.id,
    status: input.status,
    evidenceKind: applied ? 'tool_call' : 'none',
    evidenceRefs: applied ? [{ kind: 'conversation', id: `conv-${input.taskRunId}` }] : [],
    boundary: 'real',
  });
  return { injection, receipt };
}

function sourceRefs() {
  return [{ kind: 'execution' as const, id: 'kse-a', taxonomyVersion: 1 as const, subtype: 'execution' as const }];
}

/** 更新型提案：目标既有方法 + 任务当时用的版本。 */
function updateProposal(overrides: Partial<KstarCandidateProposal> = {}): KstarCandidateProposal {
  return {
    judgment: '同类任务里先核对原方法与实际采用的版本',
    suggestedType: 'rule',
    suggestedScope: 'code',
    suggestedAction: 'update',
    targetAssetId: ASSET,
    targetVersionUsed: '1',
    sourceRefs: sourceRefs(),
    ...overrides,
  };
}

/** 存量候选（老数据）：`targetVersionUsed` 字段真的不存在。 */
function legacyUpdateProposal(): KstarCandidateProposal {
  const { targetVersionUsed: _omitted, ...legacy } = updateProposal();
  return legacy;
}

/** 新建型提案：没有旧版可改，不受采用门影响。 */
function createProposal(overrides: Partial<KstarCandidateProposal> = {}): KstarCandidateProposal {
  return {
    judgment: '先把同类任务验证过的工具链记成一条可复用方法',
    suggestedType: 'skill_method',
    suggestedScope: 'code',
    suggestedAction: 'create',
    sourceRefs: sourceRefs(),
    ...overrides,
  };
}

function context(taskRunIds: string[], overrides: Partial<KstarAdmissionContext> = {}): KstarAdmissionContext {
  return {
    source: 'requirement_level',
    appliedAdoption: { taskRunIds },
    reviewId: 'ksr-a',
    episodeId: 'kse-a',
    ...overrides,
  };
}

/** 结论记录的落点（data-model §2：`<uid>/cloud/kstar/improvement-outcomes/kio-<episodeId>.json`）。 */
function outcomeFile(userId: string, episodeId: string): string {
  return path.join(root, userId, 'cloud', 'kstar', 'improvement-outcomes', `kio-${episodeId}.json`);
}

function usageJsonl(userId: string): string {
  return path.join(root, userId, 'cloud', 'recall', 'jsonl', 'asset-usage-receipts', 'events.jsonl');
}

function recallRecordsDir(userId: string): string {
  return path.join(root, userId, 'cloud', 'recall', 'records');
}

describe('KSTAR improvement admission (adoption gate)', () => {
  it('admits an update proposal only when the target version was actually applied', async () => {
    const { admission, outcome, usage } = await modules();
    const { receipt } = await recordUsage({ taskRunId: 'run-b', status: 'applied', assetVersion: '1' });

    // 形态一：调用方已按 T003 取好采用证据（数组即唯一权威口径的结果）。
    const fetched = await usage.listAppliedUsageReceipts(USER, { taskRunIds: ['run-b'] });
    expect(fetched).toEqual([{
      id: receipt.id, assetId: ASSET, assetVersion: '1', taskRunId: 'run-b',
      evidenceRefs: receipt.evidenceRefs,
    }]);
    const viaList = await admission.admitKstarProposals(
      USER, [updateProposal()], context(['run-b'], { appliedAdoption: fetched }),
    );
    expect(viaList.admitted).toHaveLength(1);
    expect(viaList.blocked).toEqual([]);
    expect(viaList.decisions[0]).toMatchObject({
      admitted: true, code: 'admitted', appliedReceiptId: receipt.id,
    });
    // 证据齐备 = 没有可落档的结论（结论只装"没出候选"的实话）。
    expect(viaList.outcomeId).toBeNull();
    expect(viaList.outcome).toBeNull();

    // 形态二：只给任务 run id，本模块内部走 `listAppliedUsageReceipts`。
    const viaQuery = await admission.admitKstarProposals(USER, [updateProposal()], context(['run-b']));
    expect(viaQuery.admitted).toHaveLength(1);
    expect(viaQuery.decisions[0].appliedReceiptId).toBe(receipt.id);
    // 重复决策不重复落档（本来就没结论），回执流也只读不改。
    expect(await outcome.listKstarImprovementOutcomes(USER)).toEqual([]);
    expect(fs.readFileSync(usageJsonl(USER), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(path.join(recallRecordsDir(USER), 'candidates'))).toBe(false);
  });

  it('blocks proposals whose target was only carried in (injected / dispatched), never applied', async () => {
    const { admission, outcome, injections } = await modules();
    const injected = await recordUsage({
      taskRunId: 'run-injected', status: 'usage_unknown', injectionStatus: 'injected',
    });
    const dispatched = await recordUsage({
      taskRunId: 'run-dispatched', status: 'usage_unknown', injectionStatus: 'dispatched',
    });
    // 夹具非空：两张注入回执确实在，只是「被带入」不等于「实际采用」。
    expect((await injections.listInjectionReceipts(USER, 'run-injected'))[0].status).toBe('injected');
    expect((await injections.listInjectionReceipts(USER, 'run-dispatched'))[0].status).toBe('dispatched');
    expect([injected.receipt.status, dispatched.receipt.status]).toEqual(['usage_unknown', 'usage_unknown']);

    const result = await admission.admitKstarProposals(USER, [
      updateProposal(),
      updateProposal({ suggestedAction: 'limit_scope' }),
      updateProposal({ suggestedAction: 'pause' }),
    ], context(['run-injected', 'run-dispatched']));

    expect(result.decisions).toHaveLength(3);
    expect(result.admitted).toEqual([]);
    // 三类"改既有对象"的动作同款受门（update / limit_scope / pause）。
    expect(result.blocked.map((entry) => entry.proposal.suggestedAction))
      .toEqual(['update', 'limit_scope', 'pause']);
    expect(result.blocked.every((entry) => entry.code === 'blocked_no_applied_evidence')).toBe(true);
    expect(result.blocked[0].reason).toContain('实际采用');

    const record = await outcome.readKstarImprovementOutcome(USER, 'kse-a');
    expect(result.outcomeId).toBe('kio-kse-a');
    expect(record.conclusion).toBe('insufficient_evidence');
    expect(record.failureCategory).toBeUndefined();
    expect(record.adoptedAssetRefs).toBeUndefined();
    expect(record.episodeId).toBe('kse-a');
    expect(record.reviewId).toBe('ksr-a');
    // 结论只存摘要与 id：提案正文、资产正文都不进记录。
    expect(record.reason).not.toContain('同类任务里先核对');
    // 纯决策：没有候选、没有资产被写。
    expect(fs.existsSync(path.join(recallRecordsDir(USER), 'candidates'))).toBe(false);
    expect(fs.existsSync(path.join(recallRecordsDir(USER), 'ability-assets'))).toBe(false);
  });

  it('blocks when the applied receipt is for a different version of the same method', async () => {
    const { admission, outcome } = await modules();
    const appliedV2 = await recordUsage({ taskRunId: 'run-b', status: 'applied', assetVersion: '2' });

    const result = await admission.admitKstarProposals(
      USER, [updateProposal({ targetVersionUsed: '1' })], context(['run-b']),
    );

    expect(result.admitted).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].code).toBe('blocked_no_applied_evidence');
    // 版本不一致是这道门的核心语义：有 applied 但版对不上，同样不进入候选。
    expect(result.blocked[0].reason).toContain('「1」');
    expect(result.blocked[0].reason).toContain('「2」');
    expect(result.blocked[0].reason).toContain('不一致');

    const record = await outcome.readKstarImprovementOutcome(USER, 'kse-a');
    expect(record.conclusion).toBe('insufficient_evidence');
    expect(record.reason).toContain('不一致');
    // 本次分析看到的实际采用如实落档：只存标识与版本，没有资产正文。
    expect(record.adoptedAssetRefs).toEqual([
      { assetId: ASSET, assetVersion: '2', usageReceiptId: appliedV2.receipt.id },
    ]);
    expect(record.evidenceRefs.length).toBeGreaterThan(0);
    expect('excerpt' in (record.evidenceRefs[0] as unknown as Record<string, unknown>)).toBe(false);

    // 反向对照：同一份证据下，依据 v2 的提案放行。
    const v2 = await admission.admitKstarProposals(
      USER, [updateProposal({ targetVersionUsed: '2' })], context(['run-b']),
    );
    expect(v2.admitted).toHaveLength(1);
    expect(v2.blocked).toEqual([]);
  });

  it('lets legacy proposals without targetVersionUsed through and records that the target cannot be checked', async () => {
    const { admission, outcome } = await modules();
    // 老数据不查证据：连回执都没有也不拦（存量兼容——否则会拦死一批合法改进）。
    const result = await admission.admitKstarProposals(USER, [legacyUpdateProposal()], context(['run-b']));

    expect(result.admitted).toHaveLength(1);
    expect(result.blocked).toEqual([]);
    expect(result.decisions[0].code).toBe('admitted_unverifiable_target');
    expect(result.decisions[0].reason).toContain('无法核对');
    expect(result.outcomeId).toBe('kio-kse-a');

    const record = await outcome.readKstarImprovementOutcome(USER, 'kse-a');
    expect(record.conclusion).toBe('insufficient_evidence');
    expect(record.reason).toContain('无法核对');
    expect(record.reason).toContain(ASSET);
  });

  it('carries the declared precipitation line and requirement id into the outcome record', async () => {
    const { admission, outcome } = await modules();
    const result = await admission.admitKstarProposals(USER, [updateProposal()], context(['run-b'], {
      source: 'direct_experience', requirementId: 'ksreq-a',
    }));

    expect(result.blocked).toHaveLength(1);
    expect(result.outcomeId).toBe('kio-kse-a');
    const record = await outcome.readKstarImprovementOutcome(USER, 'kse-a');
    expect(record.requirementId).toBe('ksreq-a');
    // 结论说清是哪条沉淀线得出的，便于用户/日志归因（直通线 = direct_experience，需求级 = requirement_level）。
    expect(record.reason.startsWith('任务级改进分析：')).toBe(true);
  });

  it('leaves create proposals outside the adoption gate', async () => {
    const { admission, outcome } = await modules();
    const alone = await admission.admitKstarProposals(USER, [createProposal()], context(['run-b']));
    expect(alone.admitted).toHaveLength(1);
    expect(alone.blocked).toEqual([]);
    expect(alone.decisions[0].code).toBe('admitted');
    // 新建型没有"改错对象"的风险 → 没有可落档的结论。
    expect(alone.outcomeId).toBeNull();
    expect(fs.existsSync(outcomeFile(USER, 'kse-a'))).toBe(false);

    const mixed = await admission.admitKstarProposals(
      USER, [createProposal(), updateProposal()], context(['run-b']),
    );
    expect(mixed.admitted.map((proposal) => proposal.suggestedAction)).toEqual(['create']);
    expect(mixed.blocked.map((entry) => entry.proposal.suggestedAction)).toEqual(['update']);
    expect((await outcome.readKstarImprovementOutcome(USER, 'kse-a')).conclusion).toBe('insufficient_evidence');

    // 没带目标方法的提案（无 targetAssetId）无从核对，按规则不受此门影响。
    const noTarget = await admission.admitKstarProposals(
      USER, [updateProposal({ targetAssetId: undefined })], context(['run-b']),
    );
    expect(noTarget.admitted).toHaveLength(1);
    expect(noTarget.blocked).toEqual([]);
  });

  it('keeps exactly one outcome record per episode across repeated decisions', async () => {
    const { admission, outcome } = await modules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T05:00:00.000Z'));

    const first = await admission.admitKstarProposals(USER, [updateProposal()], context(['run-b']));
    expect(first.outcomeId).toBe('kio-kse-a');
    const file = outcomeFile(USER, 'kse-a');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['kio-kse-a.json']);
    const firstRecord = await outcome.readKstarImprovementOutcome(USER, 'kse-a');

    vi.setSystemTime(new Date('2026-09-25T05:10:00.000Z'));
    const second = await admission.admitKstarProposals(
      USER, [updateProposal(), createProposal()], context(['run-b']),
    );
    expect(second.outcomeId).toBe(first.outcomeId);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['kio-kse-a.json']);
    const records = await outcome.listKstarImprovementOutcomes(USER);
    expect(records).toHaveLength(1);
    expect(records[0].conclusion).toBe('insufficient_evidence');
    // 覆盖同一条：createdAt 保留首次，updatedAt 推进。
    expect(records[0].createdAt).toBe(firstRecord.createdAt);
    expect(records[0].updatedAt).toBe('2026-09-25T05:10:00.000Z');
  });

  it('fails closed and records analysis_failed when the adoption evidence cannot be read', async () => {
    const { admission, outcome } = await modules();
    // 存储损坏：使用回执流里混入一行坏 JSON → 整个读取失败。
    const streamPath = usageJsonl(USER);
    fs.mkdirSync(path.dirname(streamPath), { recursive: true });
    fs.writeFileSync(streamPath, '{ not json }\n', 'utf8');

    const result = await admission.admitKstarProposals(USER, [updateProposal()], context(['run-b']));
    expect(result.admitted).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].code).toBe('blocked_evidence_unavailable');

    const record = await outcome.readKstarImprovementOutcome(USER, 'kse-a');
    expect(record.conclusion).toBe('analysis_failed');
    expect(record.failureCategory).toBe('evidence');
    // 读取失败**不得**退化成"无需更新"。
    expect(record.conclusion).not.toBe('no_update');
    expect(record.adoptedAssetRefs).toBeUndefined();

    // 读取失败只影响需要核对版本的提案；新建型照常放行。
    const createOnly = await admission.admitKstarProposals(USER, [createProposal()], context(['run-b']));
    expect(createOnly.admitted).toHaveLength(1);
  });

  it('rejects unsafe references and malformed adoption evidence without recording anything', async () => {
    const { admission } = await modules();
    const proposal = updateProposal();
    const rejects = (userId: string, proposals: unknown[], ctx: unknown) =>
      admission.admitKstarProposals(userId, proposals as never, ctx as never);

    await expect(rejects('../unsafe', [proposal], context(['run-b']))).rejects.toThrow(/invalid kstar improvement admission reference/);
    await expect(rejects(USER, [proposal], context(['run-b'], { episodeId: '../unsafe' }))).rejects.toThrow(/invalid kstar improvement admission reference/);
    await expect(rejects(USER, [proposal], context(['run-b'], { reviewId: 'bad.value' }))).rejects.toThrow(/invalid kstar improvement admission reference/);
    await expect(rejects(USER, [proposal], context(['run-b'], { requirementId: 'bad.value' }))).rejects.toThrow(/invalid kstar improvement admission reference/);
    await expect(rejects(USER, [proposal], context(['run-b'], { source: 'elsewhere' as never }))).rejects.toThrow(/invalid kstar improvement admission reference/);
    await expect(rejects(USER, [proposal], context(['../unsafe']))).rejects.toThrow(/invalid kstar improvement admission reference/);
    await expect(rejects(USER, [proposal], context([], { appliedAdoption: {} as never }))).rejects.toThrow(/invalid kstar improvement admission reference/);
    await expect(rejects(USER, ['nope'], context(['run-b']))).rejects.toThrow(/invalid kstar improvement admission reference/);
    // 形状不合法的"采用证据"不允许冒充权威口径。
    await expect(rejects(USER, [proposal], context([], {
      appliedAdoption: [{ id: 'aur-x', assetId: ASSET, assetVersion: '1' }] as never,
    }))).rejects.toThrow(/invalid kstar improvement admission reference/);

    expect(fs.existsSync(path.join(root, USER, 'cloud', 'kstar'))).toBe(false);
  });
});
