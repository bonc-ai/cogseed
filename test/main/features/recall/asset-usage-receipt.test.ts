import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-asset-usage-receipt-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('asset usage receipts', () => {
  it('迟到回执不复活已清资产：墓碑已落（级联未完窗口）时锁内拒绝', async () => {
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    // 注入发生在 purge 前：注入回执行仍在盘上。
    const injection = await injections.recordInjectionReceipt('user-late', {
      taskRunId: 'run-late', projectionId: 'proj-late', assetId: 'aa-late', assetVersion: '1',
      boundary: 'real', status: 'injected', messageId: 'message-late',
    });
    // 等价构造「setStatus 已落墓碑、级联尚未摘除注入行」的窗口：直接写
    // purged 墓碑。迟到回执走到流锁内时必须复核终态并拒绝。
    const now = new Date().toISOString();
    await writeRecallJsonRecord('user-late', 'ability-assets', 'aa-late', {
      schemaVersion: 2, ownerId: 'user-late', id: 'aa-late', candidateId: 'cand-aa-late',
      reviewDecisionId: 'rd_probeaa_late1', title: '', statement: '', evidenceRefs: [],
      scope: '', status: 'purged', lifecycleStatus: 'user_confirmed_unverified',
      version: '1', createdAt: now, updatedAt: now,
    } as never);

    await expect(usage.recordAssetUsageReceipt('user-late', {
      taskRunId: 'run-late', projectionId: 'proj-late', assetId: 'aa-late', assetVersion: '1',
      injectionReceiptId: injection.id,
      status: 'applied', evidenceKind: 'tool_call',
      evidenceRefs: [{ kind: 'execution_evaluation' as const, id: 'kse-run-late' }],
      boundary: 'real',
    })).rejects.toThrow(/has been purged/);
    // 回执流保持为空：已清使用痕迹没有回填复活。
    expect(await usage.listAssetUsageReceipts('user-late')).toEqual([]);
  });

  it('persists a normalized evidence-bound applied receipt idempotently', async () => {
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const injection = await injections.recordInjectionReceipt('user-a', {
      taskRunId: 'run-a', projectionId: 'proj-a', assetId: 'asset-a', assetVersion: '1',
      boundary: 'real', status: 'injected', messageId: 'message-a',
    });
    const input = {
      taskRunId: 'run-a', projectionId: 'proj-a', assetId: 'asset-a', assetVersion: '1',
      injectionReceiptId: injection.id,
      status: 'applied' as const,
      evidenceKind: 'tool_call' as const,
      evidenceRefs: [
        { kind: 'execution_evaluation' as const, id: 'kse-run-a', excerpt: 'prompt and tool argument values must not persist' },
        { kind: 'execution_evaluation' as const, id: 'kse-run-a' },
      ],
      boundary: 'real' as const,
    };

    const [first, second, third] = await Promise.all([
      usage.recordAssetUsageReceipt('user-a', input),
      usage.recordAssetUsageReceipt('user-a', input),
      usage.recordAssetUsageReceipt('user-a', input),
    ]);

    expect(first).toMatchObject({
      id: expect.stringMatching(/^aur-[a-f0-9]{24}$/),
      status: 'applied',
      evidenceKind: 'tool_call',
      evidenceRefs: [{
        kind: 'execution_evaluation', id: 'kse-run-a', taxonomyVersion: 2, subtype: 'execution',
      }],
    });
    expect(first.evidenceRefs[0]).not.toHaveProperty('excerpt');
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    await expect(usage.listAssetUsageReceipts('user-a', 'run-a')).resolves.toEqual([first]);

    const jsonl = path.join(root, 'user-a', 'cloud', 'recall', 'jsonl', 'asset-usage-receipts', 'events.jsonl');
    expect(fs.readFileSync(jsonl, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('normalizes historical receipt ids so later user feedback replaces the same event', async () => {
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const injection = await injections.recordInjectionReceipt('user-legacy-id', {
      taskRunId: 'run-legacy-id', projectionId: 'proj-legacy-id', assetId: 'asset-legacy-id', assetVersion: '1',
      boundary: 'real', status: 'injected', messageId: 'message-legacy-id',
    });
    const input = {
      taskRunId: 'run-legacy-id', projectionId: 'proj-legacy-id', assetId: 'asset-legacy-id', assetVersion: '1',
      injectionReceiptId: injection.id,
      status: 'applied',
      evidenceKind: 'tool_call',
      evidenceRefs: [{ kind: 'execution_evaluation', id: 'eval-legacy-id' }],
      boundary: 'real',
    } as const;
    const original = await usage.recordAssetUsageReceipt('user-legacy-id', input);

    const jsonl = path.join(root, 'user-legacy-id', 'cloud', 'recall', 'jsonl', 'asset-usage-receipts', 'events.jsonl');
    const stored = JSON.parse(fs.readFileSync(jsonl, 'utf8').trim());
    stored.id = `aur-${'0'.repeat(24)}`;
    fs.writeFileSync(jsonl, `${JSON.stringify(stored)}\n`);

    await expect(usage.listAssetUsageReceipts('user-legacy-id')).resolves.toEqual([
      expect.objectContaining({ id: original.id, status: 'applied', assetId: 'asset-legacy-id' }),
    ]);
    await expect(usage.recordAssetUsageReceipt('user-legacy-id', input)).resolves.toMatchObject({ id: original.id, status: 'applied' });
    expect(fs.readFileSync(jsonl, 'utf8').trim().split('\n')).toHaveLength(1);

    const contradicted = await usage.recordAssetUsageReceipt('user-legacy-id', { ...input, status: 'contradicted' });
    expect(contradicted).toMatchObject({ id: original.id, status: 'contradicted' });
    await expect(usage.listAssetUsageReceipts('user-legacy-id')).resolves.toEqual([
      expect.objectContaining({ id: original.id, status: 'contradicted', assetId: 'asset-legacy-id' }),
    ]);
    expect(fs.readFileSync(jsonl, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('negative feedback overrides an earlier applied receipt; reads return the latest per id ', async () => {
    // KSTAR 收账先写 applied，用户随后点踩写 contradicted——此前被同键幂等
    // 去重静默吞掉（「点踩进治理」失效）；现在 contradicted 可覆盖，读取侧
    // 同 id 取末条，消费方不双计。
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const injection = await injections.recordInjectionReceipt('user-b', {
      taskRunId: 'run-b', projectionId: 'proj-b', assetId: 'asset-b', assetVersion: '1',
      boundary: 'real', status: 'injected', messageId: 'message-b',
    });
    const base = {
      taskRunId: 'run-b', projectionId: 'proj-b', assetId: 'asset-b', assetVersion: '1',
      injectionReceiptId: injection.id,
      evidenceKind: 'agent_action' as const,
      evidenceRefs: [{ kind: 'conversation' as const, id: 'conv-b', title: 'user negative feedback' }],
      boundary: 'real' as const,
    };
    const applied = await usage.recordAssetUsageReceipt('user-b', { ...base, status: 'applied' });
    expect(applied.status).toBe('applied');

    const contradicted = await usage.recordAssetUsageReceipt('user-b', { ...base, status: 'contradicted' });
    expect(contradicted.status).toBe('contradicted');

    const listed = await usage.listAssetUsageReceipts('user-b', 'run-b');
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe('contradicted');

    // 幂等方向不变：已是 contradicted 再写 contradicted 仍返回同状态、list 仍一条。
    const again = await usage.recordAssetUsageReceipt('user-b', { ...base, status: 'contradicted' });
    expect(again.status).toBe('contradicted');
    expect(await usage.listAssetUsageReceipts('user-b', 'run-b')).toHaveLength(1);
  });

  it.each([
    ['task run', { taskRunId: 'run-other' }],
    ['projection', { projectionId: 'proj-other' }],
    ['asset', { assetId: 'asset-other' }],
    ['asset version', { assetVersion: '2' }],
  ])('rejects an injection receipt with a mismatched %s', async (_label, override) => {
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const injection = await injections.recordInjectionReceipt('user-a', {
      taskRunId: 'run-a', projectionId: 'proj-a', assetId: 'asset-a', assetVersion: '1',
      boundary: 'real', status: 'injected', messageId: 'message-a',
    });

    await expect(usage.recordAssetUsageReceipt('user-a', {
      taskRunId: 'run-a', projectionId: 'proj-a', assetId: 'asset-a', assetVersion: '1',
      injectionReceiptId: injection.id,
      status: 'usage_unknown', evidenceKind: 'none', evidenceRefs: [], boundary: 'real',
      ...override,
    })).rejects.toThrow('injection receipt does not match asset usage');
  });

  it('rejects missing, failed, or unsafe injection references', async () => {
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const failed = await injections.recordInjectionReceipt('user-a', {
      taskRunId: 'run-a', projectionId: 'proj-a', assetId: 'asset-a', assetVersion: '1',
      boundary: 'real', status: 'failed', messageId: 'message-a',
    });
    const base = {
      taskRunId: 'run-a', projectionId: 'proj-a', assetId: 'asset-a', assetVersion: '1',
      status: 'usage_unknown' as const, evidenceKind: 'none' as const, evidenceRefs: [], boundary: 'real' as const,
    };

    await expect(usage.recordAssetUsageReceipt('user-a', {
      ...base, injectionReceiptId: 'inj-missing',
    })).rejects.toThrow('injection receipt not found');
    await expect(usage.recordAssetUsageReceipt('user-a', {
      ...base, injectionReceiptId: failed.id,
    })).rejects.toThrow('injection receipt did not inject asset');
    await expect(usage.recordAssetUsageReceipt('user-a', {
      ...base, taskRunId: '../unsafe', injectionReceiptId: failed.id,
    })).rejects.toThrow('invalid asset usage receipt reference');
  });

  it.each(['applied', 'considered_not_applicable', 'contradicted'] as const)(
    'requires nonempty evidence for %s',
    async (status) => {
      const injections = await import('../../../../src/main/features/recall/injection-receipt');
      const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
      const injection = await injections.recordInjectionReceipt('user-a', {
        taskRunId: 'run-a', projectionId: 'proj-a', assetId: 'asset-a', assetVersion: '1',
        boundary: 'real', status: 'injected', messageId: 'message-a',
      });

      await expect(usage.recordAssetUsageReceipt('user-a', {
        taskRunId: 'run-a', projectionId: 'proj-a', assetId: 'asset-a', assetVersion: '1',
        injectionReceiptId: injection.id, status, evidenceKind: 'none', evidenceRefs: [], boundary: 'real',
      })).rejects.toThrow('asset usage evidence is required');
    },
  );

  it('allows usage_unknown and available_no_opportunity without evidence', async () => {
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    for (const [suffix, status] of [['unknown', 'usage_unknown'], ['unavailable', 'available_no_opportunity']] as const) {
      const injection = await injections.recordInjectionReceipt('user-a', {
        taskRunId: `run-${suffix}`, projectionId: `proj-${suffix}`, assetId: `asset-${suffix}`, assetVersion: '1',
        boundary: 'real', status: 'injected', messageId: `message-${suffix}`,
      });
      await expect(usage.recordAssetUsageReceipt('user-a', {
        taskRunId: `run-${suffix}`, projectionId: `proj-${suffix}`, assetId: `asset-${suffix}`, assetVersion: '1',
        injectionReceiptId: injection.id, status, evidenceKind: 'none', boundary: 'real',
      })).resolves.toMatchObject({ status, evidenceRefs: [] });
    }
  });

  it('persists profile-memory channel injection receipts and rejects unknown channels', async () => {
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    // 画像通道收据：无 projectionId（背景记忆不携带投影授权），channel 区分。
    const receipt = await injections.recordInjectionReceipt('user-a', {
      taskRunId: 'turn-profile', assetId: 'onto-abc123def456abc123def456', assetVersion: '1',
      boundary: 'real', status: 'injected', messageId: 'message-profile',
      channel: 'profile_memory',
    });
    expect(receipt).toMatchObject({ channel: 'profile_memory', status: 'injected' });
    expect(receipt.projectionId).toBeUndefined();
    const listed = await injections.listInjectionReceipts('user-a', 'turn-profile');
    expect(listed).toEqual([expect.objectContaining({ channel: 'profile_memory' })]);
    // 幂等：同键重落返回同一张收据（channel 不参与去重键）。
    const again = await injections.recordInjectionReceipt('user-a', {
      taskRunId: 'turn-profile', assetId: 'onto-abc123def456abc123def456', assetVersion: '1',
      boundary: 'real', status: 'injected', messageId: 'message-profile',
      channel: 'profile_memory',
    });
    expect(again.id).toBe(receipt.id);
    // 非法通道值在写入侧即拒绝。
    await expect(injections.recordInjectionReceipt('user-a', {
      taskRunId: 'turn-profile', assetId: 'onto-abc123def456abc123def456', assetVersion: '1',
      boundary: 'real', status: 'injected',
      channel: 'side_channel' as 'profile_memory',
    })).rejects.toThrow('invalid injection receipt reference');
  });

  it('画像通道正式资产镜像计入使用统计，onto-* 文件遗留仅留回执', async () => {
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const { listRecallUsage } = await import('../../../../src/main/features/recall/usage-service');
    await injections.recordProfileMemoryInjection('user-a', [
      { id: 'aa-profile-usage-real', source: 'conv-x', version: '3' },
      { id: 'onto-abc123def456abc123def456', source: 'user_profile', version: '1' },
    ], { taskRunId: 'turn-profile-usage', messageId: 'message-profile-usage' });

    // 回执：两条都落（审计「这轮带了什么」以收据流为准）。
    const receipts = await injections.listInjectionReceipts('user-a', 'turn-profile-usage');
    expect(receipts.map((row) => row.assetId).sort())
      .toEqual(['aa-profile-usage-real', 'onto-abc123def456abc123def456']);
    // 使用统计：只有正式资产镜像（aa-*）——「带入即计一次使用」与投影注入/
    // 派发/模型自取同口径；onto-* 是迁移回退的文件条目，没有资产本体，不进 usage。
    const profileUsage = (await listRecallUsage('user-a')).filter((row) => row.taskRunId === 'turn-profile-usage');
    expect(profileUsage).toHaveLength(1);
    expect(profileUsage[0]).toMatchObject({
      assetId: 'aa-profile-usage-real',
      assetVersion: '3',
      messageId: 'message-profile-usage',
      boundary: 'real',
      outcome: 'injected',
    });
  });
});


const outputHash = createHash('sha256').update('persisted final output').digest('hex');
const taskHash = createHash('sha256').update('original task').digest('hex');
async function outputObservation() {
  const injections = await import('../../../../src/main/features/recall/injection-receipt');
  const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
  const store = await import('../../../../src/main/features/recall/store');
  const injection = await injections.recordInjectionReceipt('user-a', {
    taskRunId: 'run-a', projectionId: 'proj-a', assetId: 'asset-a', assetVersion: '1',
    boundary: 'real', status: 'injected', messageId: 'message-a',
  });
  const base = {
    taskRunId: 'run-a', projectionId: 'proj-a', assetId: 'asset-a', assetVersion: '1', injectionReceiptId: injection.id,
    evidenceKind: 'final_output' as const, boundary: 'real' as const,
    evidenceRefs: [{ kind: 'message' as const, id: 'message-a' }],
  };
  const proofId = `coc-${createHash('sha256').update(JSON.stringify(['run-a', 'message-a', outputHash, taskHash])).digest('hex').slice(0, 24)}`;
  const proof = { schemaVersion: 1, ownerId: 'user-a', id: proofId, taskRunId: 'run-a', messageId: 'message-a',
    outputHash, taskHash, method: 'model_assisted', modelCompleted: true,
    checks: [{ assetId: 'asset-a', version: '1', status: 'not_complied', outputEvidence: { start: 0, end: 5 } }],
    createdAt: new Date().toISOString() };
  const report = { ...base, status: 'applied' as const, observationMethod: 'agent_reported' as const, messageId: 'message-a', outputHash };
  const checked = { ...base, status: 'usage_unknown' as const, observationMethod: 'model_assisted' as const,
    messageId: 'message-a', outputHash, outputCheckReceiptId: proofId };
  return { usage, store, base, proof, report, checked };
}

describe('persisted-result observation precedence', () => {
  it('replaces a failed agent report with a completed independent unknown and rejects delayed reports', async () => {
    const { usage, store, proof, report, checked } = await outputObservation();
    const failedReport = { ...report, status: 'usage_unknown' as const, reportFailure: 'quote_not_found' as const };
    await usage.recordAssetUsageReceipt('user-a', failedReport);
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, { ...proof,
      checks: [{ assetId: 'asset-a', version: '1', status: 'unknown' }] });
    const independent = await usage.recordAssetUsageReceipt('user-a', checked);
    expect(independent).toMatchObject({ status: 'usage_unknown', observationMethod: 'model_assisted', outputCheckReceiptId: proof.id });
    expect(independent.reportFailure).toBeUndefined();
    expect(await usage.recordAssetUsageReceipt('user-a', failedReport)).toEqual(independent);
    expect(await usage.recordAssetUsageReceipt('user-a', report)).toEqual(independent);
    expect(await usage.listAppliedUsageReceipts('user-a', { taskRunIds: ['run-a'] })).toEqual([]);
  });
  it.each([
    { status: 'unknown' },
    { status: 'not_applicable', taskEvidence: { start: 0, end: 8 } },
  ])('withdraws same-output self-reported adoption for a completed %j without claiming no use', async finding => {
    const { usage, store, proof, report, checked } = await outputObservation();
    const completed = { ...proof, checks: [{ assetId: 'asset-a', version: '1', ...finding }] };
    await usage.recordAssetUsageReceipt('user-a', report);
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, completed);
    // Persisted proofs contain task hashes/coordinates, never invented task text.
    expect(completed).not.toHaveProperty('task');
    expect(completed.checks[0]).not.toHaveProperty('outputEvidence');
    const attempts = await Promise.all(Array.from({ length: 4 }, () => usage.recordAssetUsageReceipt('user-a', checked)));
    expect(attempts.every(receipt => receipt.status === 'usage_unknown')).toBe(true);
    const corrected = attempts[0];
    expect(corrected).toMatchObject({ observationMethod: 'model_assisted', outputCheckReceiptId: proof.id });
    expect(corrected.status).not.toBe('contradicted');
    expect(await usage.listAppliedUsageReceipts('user-a', { taskRunIds: ['run-a'] })).toEqual([]);
    expect(await usage.recordAssetUsageReceipt('user-a', report)).toEqual(corrected);
    expect(await usage.listAssetUsageReceipts('user-a')).toEqual([corrected]);
    const jsonl = path.join(root, 'user-a', 'cloud', 'recall', 'jsonl', 'asset-usage-receipts', 'events.jsonl');
    expect(fs.readFileSync(jsonl, 'utf8').trim().split('\n')).toHaveLength(2);
    const { listValidationRecords } = await import('../../../../src/main/features/recall/validation-service');
    const { listEffectivenessProofs } = await import('../../../../src/main/features/recall/proof-service');
    expect(await listValidationRecords('user-a')).toEqual([]);
    expect(await listEffectivenessProofs('user-a')).toEqual([]);
    expect(await store.readRecallJsonRecord('user-a', 'output-checks', proof.id)).toEqual(completed);
  });

  it.each([
    { status: 'unknown' },
    { status: 'not_applicable', taskEvidence: { start: 0, end: 8 } },
  ])('never uses a failed provider check as evidence against a self-report: %j', async finding => {
    const { usage, store, proof, report, checked } = await outputObservation();
    const claimed = await usage.recordAssetUsageReceipt('user-a', report);
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, {
      ...proof, modelCompleted: false, checks: [{ assetId: 'asset-a', version: '1', ...finding }],
    });
    await expect(usage.recordAssetUsageReceipt('user-a', checked)).rejects.toThrow('does not match observation');
    expect(await usage.listAssetUsageReceipts('user-a')).toEqual([claimed]);
  });

  it.each([
    { status: 'unknown' },
    { status: 'not_applicable', taskEvidence: { start: 0, end: 8 } },
  ])('does not relabel legacy provenance or user contradiction from %j', async finding => {
    const { usage, store, base, proof, checked } = await outputObservation();
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, {
      ...proof, checks: [{ assetId: 'asset-a', version: '1', ...finding }],
    });
    const legacy = await usage.recordAssetUsageReceipt('user-a', { ...base, status: 'applied' });
    expect(await usage.recordAssetUsageReceipt('user-a', checked)).toEqual(legacy);
    const negative = await usage.recordAssetUsageReceipt('user-a', { ...base, status: 'contradicted' });
    expect(await usage.recordAssetUsageReceipt('user-a', checked)).toEqual(negative);
  });

  it('does not promote a completed unknown proof to applied or replace user/legacy decisions', async () => {
    const { usage, store, proof, report, checked } = await outputObservation();
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, {
      ...proof, checks: [{ assetId: 'asset-a', version: '1', status: 'unknown' }],
    });
    const unknown = await usage.recordAssetUsageReceipt('user-a', checked);
    await expect(usage.recordAssetUsageReceipt('user-a', { ...checked, status: 'applied' }))
      .rejects.toThrow('does not match observation');
    // Even a later rewritten checker result cannot erase the completed unknown.
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, {
      ...proof, checks: [{ assetId: 'asset-a', version: '1', status: 'complied', outputEvidence: { start: 0, end: 5 } }],
    });
    expect(await usage.recordAssetUsageReceipt('user-a', { ...checked, status: 'applied' })).toEqual(unknown);
    expect(await usage.recordAssetUsageReceipt('user-a', report)).toEqual(unknown);
    const negative = await usage.recordAssetUsageReceipt('user-a', { ...report, observationMethod: undefined,
      outputHash: undefined, messageId: undefined, status: 'contradicted' });
    expect(await usage.recordAssetUsageReceipt('user-a', { ...checked, status: 'applied' })).toEqual(negative);
    expect(await usage.listAppliedUsageReceipts('user-a', { taskRunIds: ['run-a'] })).toEqual([]);
  });

  it.each([
    { status: 'not_applicable' },
    { status: 'not_applicable', taskEvidence: null },
    { status: 'not_applicable', taskEvidence: [] },
    { status: 'not_applicable', taskEvidence: { start: 0, end: 0 } },
    { status: 'not_applicable', taskEvidence: { start: -1, end: 5 } },
    { status: 'not_applicable', taskEvidence: { start: 0.5, end: 5 } },
    { status: 'not_applicable', taskEvidence: { start: 0, end: Number.MAX_SAFE_INTEGER + 1 } },
    { status: 'not_applicable', taskEvidence: { start: '0', end: 5 } },
    { status: 'not_applicable', taskEvidence: { start: 0, end: 5, quote: 'unverified raw task' } },
    { status: 'unknown', outputEvidence: { start: 0, end: 5, quote: 'unverified raw output' } },
    { status: 'unknown', taskEvidence: { start: 5, end: 0 } },
    { status: 'unknown', outputEvidence: null },
    { status: 'unknown', extra: 'caller-provided claim' },
  ])('rejects malformed applicability/unknown proof instead of correcting adoption: %j', async finding => {
    const { usage, store, proof, report, checked } = await outputObservation();
    const claimed = await usage.recordAssetUsageReceipt('user-a', report);
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, {
      ...proof, checks: [{ assetId: 'asset-a', version: '1', ...finding }],
    });
    await expect(usage.recordAssetUsageReceipt('user-a', checked)).rejects.toThrow('does not match observation');
    expect(await usage.listAssetUsageReceipts('user-a')).toEqual([claimed]);
  });

  it('rejects ambiguous unknown rows and preserves claims tied to a different output', async () => {
    const { usage, store, proof, report, checked } = await outputObservation();
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, {
      ...proof, checks: Array.from({ length: 2 }, () => ({ assetId: 'asset-a', version: '1', status: 'unknown' })),
    });
    const claimed = await usage.recordAssetUsageReceipt('user-a', { ...report, outputHash: '0'.repeat(64) });
    await expect(usage.recordAssetUsageReceipt('user-a', checked)).rejects.toThrow('does not match observation');
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, {
      ...proof, checks: [{ assetId: 'asset-a', version: '1', status: 'unknown' }],
    });
    expect(await usage.recordAssetUsageReceipt('user-a', checked)).toEqual(claimed);
  });

  it('corrects self-reported adoption and removes it from the authoritative applied count', async () => {
    const { usage, store, proof, report, checked } = await outputObservation();
    await usage.recordAssetUsageReceipt('user-a', report);
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, proof);
    const corrected = await usage.recordAssetUsageReceipt('user-a', checked);
    expect(corrected).toMatchObject({ status: 'usage_unknown', observationMethod: 'model_assisted', outputCheckReceiptId: proof.id });
    expect(await usage.listAppliedUsageReceipts('user-a', { taskRunIds: ['run-a'] })).toEqual([]);
    const views = await usage.listAssetUsageReceiptViews('user-a', 'asset-a');
    expect(views).toEqual([expect.objectContaining({ observationMethod: 'model_assisted', status: 'usage_unknown' })]);
    expect(JSON.stringify(views)).not.toContain(outputHash);
    expect(views[0]).not.toHaveProperty('outputCheckReceiptId');
    await usage.recordAssetUsageReceipt('user-a', report);
    await usage.recordAssetUsageReceipt('user-a', checked);
    expect(await usage.listAssetUsageReceipts('user-a')).toEqual([corrected]);
  });

  it('holds the independent finding even if the delayed report arrives after checking', async () => {
    const { usage, store, proof, report, checked } = await outputObservation();
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, proof);
    await usage.recordAssetUsageReceipt('user-a', checked);
    expect(await usage.recordAssetUsageReceipt('user-a', report)).toMatchObject({ status: 'usage_unknown', observationMethod: 'model_assisted' });
  });

  it('preserves user contradiction and legacy applied receipts without guessing their source', async () => {
    const { usage, store, base, proof, report, checked } = await outputObservation();
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, proof);
    await usage.recordAssetUsageReceipt('user-a', { ...base, status: 'applied', reason: 'Model-reported adoption' });
    expect(await usage.recordAssetUsageReceipt('user-a', checked)).toMatchObject({ status: 'applied' });
    await usage.recordAssetUsageReceipt('user-a', { ...base, status: 'contradicted' });
    expect(await usage.recordAssetUsageReceipt('user-a', checked)).toMatchObject({ status: 'contradicted' });
    expect(await usage.recordAssetUsageReceipt('user-a', report)).toMatchObject({ status: 'contradicted' });
  });

  it('requires persisted proof before a caller label can change adoption', async () => {
    const { usage, report, checked } = await outputObservation();
    await usage.recordAssetUsageReceipt('user-a', report);
    await expect(usage.recordAssetUsageReceipt('user-a', checked)).rejects.toThrow('does not match observation');
    expect((await usage.listAssetUsageReceipts('user-a'))[0].status).toBe('applied');
  });

  it.each([
    { modelCompleted: false }, { method: 'agent_reported' }, { taskRunId: 'other-run' }, { messageId: 'other-message' },
    { outputHash: '0'.repeat(64) }, { taskHash: '0'.repeat(64) },
    { checks: [{ assetId: 'other-asset', version: '1', status: 'not_complied', outputEvidence: { start: 0, end: 5 } }] },
    { checks: [{ assetId: 'asset-a', version: '2', status: 'not_complied', outputEvidence: { start: 0, end: 5 } }] },
    { checks: [{ assetId: 'asset-a', version: '1', status: 'complied', outputEvidence: { start: 0, end: 5 } }] },
    { checks: [{ assetId: 'asset-a', version: '1', status: 'not_complied', outputEvidence: { start: 5, end: 0 } }] },
    { checks: [{ assetId: 'asset-a', version: '1', status: 'not_complied' }] },
  ])('rejects incomplete or mismatched checker proof: %j', async overrides => {
    const { usage, store, proof, report, checked } = await outputObservation();
    await usage.recordAssetUsageReceipt('user-a', report);
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, { ...proof, ...overrides });
    await expect(usage.recordAssetUsageReceipt('user-a', checked)).rejects.toThrow('does not match observation');
    expect((await usage.listAssetUsageReceipts('user-a'))[0].status).toBe('applied');
  });

  it('requires matching message/hash in self-report and final-message evidence', async () => {
    const { usage, store, proof, report, checked } = await outputObservation();
    await store.writeRecallJsonRecord('user-a', 'output-checks', proof.id, proof);
    await usage.recordAssetUsageReceipt('user-a', { ...report, outputHash: '0'.repeat(64) });
    expect(await usage.recordAssetUsageReceipt('user-a', checked)).toMatchObject({ status: 'applied' });
    await expect(usage.recordAssetUsageReceipt('user-a', { ...checked, evidenceRefs: [{ kind: 'message', id: 'other-message' }] }))
      .rejects.toThrow('needs its final message evidence');
    await expect(usage.recordAssetUsageReceipt('user-a', { ...checked, messageId: 'other-message', evidenceRefs: [{ kind: 'message', id: 'other-message' }] }))
      .rejects.toThrow('does not match final output observation');
  });
});
