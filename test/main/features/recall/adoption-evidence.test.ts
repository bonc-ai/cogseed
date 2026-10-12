import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// specs/015 T003/T004：`listAppliedUsageReceipts` 是「实际采用」的唯一只读口径——
// 只有 usage 回执 `applied` + `boundary='real'` 才算采用；注入回执
// `injected`/`dispatched` 只是「被带入」，不算（specs/011 定稿口径，不得重议）。

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-adoption-evidence-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function recallModules() {
  const [injections, usage] = await Promise.all([
    import('../../../../src/main/features/recall/injection-receipt'),
    import('../../../../src/main/features/recall/asset-usage-receipt'),
  ]);
  return { injections, usage };
}

type UsageStatus = 'applied' | 'considered_not_applicable' | 'available_no_opportunity' | 'contradicted' | 'usage_unknown';
type Boundary = 'real' | 'degraded' | 'test-double';

/** 与真实链路同序：先落注入回执（usage 回执的外键），再落使用回执。 */
async function recordUsage(
  userId: string,
  input: {
    taskRunId: string; assetId: string; assetVersion?: string; projectionId?: string;
    status: UsageStatus; boundary?: Boundary; injectionStatus?: 'injected' | 'dispatched';
  },
) {
  const { injections, usage } = await recallModules();
  const assetVersion = input.assetVersion ?? '1';
  const projectionId = input.projectionId ?? 'proj-1';
  const boundary = input.boundary ?? 'real';
  const injection = await injections.recordInjectionReceipt(userId, {
    taskRunId: input.taskRunId, projectionId, assetId: input.assetId, assetVersion,
    boundary, status: input.injectionStatus ?? 'injected', messageId: `message-${input.taskRunId}`,
  });
  const receipt = await usage.recordAssetUsageReceipt(userId, {
    taskRunId: input.taskRunId, projectionId, assetId: input.assetId, assetVersion,
    injectionReceiptId: injection.id, status: input.status,
    evidenceKind: 'tool_call', evidenceRefs: [{ kind: 'conversation', id: `conv-${input.taskRunId}` }],
    boundary,
  });
  return { injection, receipt };
}

function usageJsonlPath(userId: string): string {
  return path.join(root, userId, 'cloud', 'recall', 'jsonl', 'asset-usage-receipts', 'events.jsonl');
}

describe('adoption evidence (applied usage receipts)', () => {
  it('returns only applied + real receipts for the requested runs, mapped to the evidence shape', async () => {
    const { usage } = await recallModules();
    const first = await recordUsage('user-evidence', { taskRunId: 'run-1', assetId: 'asset-a', status: 'applied' });
    const second = await recordUsage('user-evidence', {
      taskRunId: 'run-2', assetId: 'asset-b', assetVersion: '2', status: 'applied',
    });
    await recordUsage('user-evidence', { taskRunId: 'run-3', assetId: 'asset-c', status: 'applied' });

    const listed = await usage.listAppliedUsageReceipts('user-evidence', { taskRunIds: ['run-1', 'run-2'] });

    expect(listed).toHaveLength(2);
    expect(listed.map((entry) => entry.taskRunId)).toEqual(['run-1', 'run-2']);
    expect(Object.keys(listed[0]).sort()).toEqual(['assetId', 'assetVersion', 'evidenceRefs', 'id', 'taskRunId']);
    expect(listed[0]).toEqual({
      id: first.receipt.id,
      assetId: 'asset-a',
      assetVersion: '1',
      taskRunId: 'run-1',
      evidenceRefs: first.receipt.evidenceRefs,
    });
    expect(listed[1]).toMatchObject({
      id: second.receipt.id, assetId: 'asset-b', assetVersion: '2', taskRunId: 'run-2',
    });
    // 只读、零写入：三条回执各一行，查询前后 JSONL 一字不改。
    expect(fs.readFileSync(usageJsonlPath('user-evidence'), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('keeps carried-in injection receipts (injected / dispatched) out of adoption evidence', async () => {
    const { injections, usage } = await recallModules();
    await recordUsage('user-evidence', {
      taskRunId: 'run-injected', assetId: 'asset-a', status: 'usage_unknown', injectionStatus: 'injected',
    });
    await recordUsage('user-evidence', {
      taskRunId: 'run-dispatched', assetId: 'asset-a', status: 'usage_unknown', injectionStatus: 'dispatched',
    });
    // 夹具非空：两张注入回执确实存在，只是「被带入」不是「采用」。
    expect((await injections.listInjectionReceipts('user-evidence', 'run-injected'))[0].status).toBe('injected');
    expect((await injections.listInjectionReceipts('user-evidence', 'run-dispatched'))[0].status).toBe('dispatched');

    await expect(usage.listAppliedUsageReceipts('user-evidence', {
      taskRunIds: ['run-injected', 'run-dispatched'],
    })).resolves.toEqual([]);
  });

  it('excludes applied receipts whose boundary is not real', async () => {
    const { usage } = await recallModules();
    const degraded = await recordUsage('user-evidence', {
      taskRunId: 'run-degraded', assetId: 'asset-a', status: 'applied', boundary: 'degraded',
    });
    const testDouble = await recordUsage('user-evidence', {
      taskRunId: 'run-double', assetId: 'asset-b', status: 'applied', boundary: 'test-double',
    });
    const real = await recordUsage('user-evidence', {
      taskRunId: 'run-real', assetId: 'asset-c', status: 'applied', boundary: 'real',
    });
    expect([degraded.receipt.status, testDouble.receipt.status]).toEqual(['applied', 'applied']);

    const listed = await usage.listAppliedUsageReceipts('user-evidence', {
      taskRunIds: ['run-degraded', 'run-double', 'run-real'],
    });
    expect(listed.map((entry) => entry.taskRunId)).toEqual(['run-real']);
    expect(listed[0].id).toBe(real.receipt.id);
  });

  it('excludes non-adoption statuses (considered_not_applicable / available_no_opportunity / contradicted / usage_unknown)', async () => {
    const { usage } = await recallModules();
    const statuses: UsageStatus[] = [
      'considered_not_applicable', 'available_no_opportunity', 'contradicted', 'usage_unknown',
    ];
    const runIds: string[] = [];
    for (const [index, status] of statuses.entries()) {
      const taskRunId = `run-status-${index}`;
      runIds.push(taskRunId);
      const { receipt } = await recordUsage('user-evidence', { taskRunId, assetId: 'asset-a', status });
      expect(receipt.status).toBe(status);
    }
    const applied = await recordUsage('user-evidence', {
      taskRunId: 'run-applied-control', assetId: 'asset-a', status: 'applied',
    });

    const listed = await usage.listAppliedUsageReceipts('user-evidence', {
      taskRunIds: [...runIds, 'run-applied-control'],
    });
    expect(listed.map((entry) => entry.taskRunId)).toEqual(['run-applied-control']);
    expect(listed[0].id).toBe(applied.receipt.id);
  });

  it('filters by taskRunIds, returns an empty list for an empty batch, and never falls back to a full read', async () => {
    const { usage } = await recallModules();
    await recordUsage('user-evidence', { taskRunId: 'run-1', assetId: 'asset-a', status: 'applied' });
    await recordUsage('user-evidence', { taskRunId: 'run-2', assetId: 'asset-b', status: 'applied' });

    await expect(usage.listAppliedUsageReceipts('user-evidence', { taskRunIds: ['run-1'] }))
      .resolves.toMatchObject([{ taskRunId: 'run-1' }]);
    await expect(usage.listAppliedUsageReceipts('user-evidence', { taskRunIds: ['run-unknown'] }))
      .resolves.toEqual([]);
    // 空批次 = 空结果，而不是「不加过滤的全量」。
    await expect(usage.listAppliedUsageReceipts('user-evidence', { taskRunIds: [] })).resolves.toEqual([]);
  });

  it('applies the optional assetId filter on top of the run filter', async () => {
    const { usage } = await recallModules();
    await recordUsage('user-evidence', { taskRunId: 'run-1', assetId: 'asset-a', status: 'applied' });
    await recordUsage('user-evidence', { taskRunId: 'run-1', assetId: 'asset-b', status: 'applied' });
    await recordUsage('user-evidence', { taskRunId: 'run-2', assetId: 'asset-b', status: 'applied' });

    await expect(usage.listAppliedUsageReceipts('user-evidence', { taskRunIds: ['run-1'] }))
      .resolves.toMatchObject([{ assetId: 'asset-a' }, { assetId: 'asset-b' }]);
    const filtered = await usage.listAppliedUsageReceipts('user-evidence', {
      taskRunIds: ['run-1', 'run-2'], assetId: 'asset-b',
    });
    expect(filtered.map((entry) => entry.taskRunId)).toEqual(['run-1', 'run-2']);
    expect(filtered.every((entry) => entry.assetId === 'asset-b')).toBe(true);
    await expect(usage.listAppliedUsageReceipts('user-evidence', {
      taskRunIds: ['run-2'], assetId: 'asset-a',
    })).resolves.toEqual([]);
  });

  it('stays idempotent per receipt id: repeated writes add no entry and negative feedback wins as last write', async () => {
    const { usage } = await recallModules();
    const base = { taskRunId: 'run-idem', assetId: 'asset-a', status: 'applied' as const };
    const first = await recordUsage('user-evidence', base);
    const repeat = await usage.recordAssetUsageReceipt('user-evidence', {
      taskRunId: 'run-idem', projectionId: 'proj-1', assetId: 'asset-a', assetVersion: '1',
      injectionReceiptId: first.injection.id, status: 'applied', evidenceKind: 'tool_call',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-run-idem' }], boundary: 'real',
    });
    expect(repeat.id).toBe(first.receipt.id);
    // 同 id 重复写不新增行、查询也不重复计数。
    expect(fs.readFileSync(usageJsonlPath('user-evidence'), 'utf8').trim().split('\n')).toHaveLength(1);
    await expect(usage.listAppliedUsageReceipts('user-evidence', { taskRunIds: ['run-idem'] }))
      .resolves.toEqual([{
        id: first.receipt.id, assetId: 'asset-a', assetVersion: '1', taskRunId: 'run-idem',
        evidenceRefs: first.receipt.evidenceRefs,
      }]);

    // 负反馈覆盖机制会为同一 id 追加第二行（contradicted 覆盖 applied）；读取取末条，
    // 该运行不再出现在采用证据里——不做 id 去重的裸行扫描会错误地复活旧的 applied。
    const contradicted = await usage.recordAssetUsageReceipt('user-evidence', {
      taskRunId: 'run-idem', projectionId: 'proj-1', assetId: 'asset-a', assetVersion: '1',
      injectionReceiptId: first.injection.id, status: 'contradicted', evidenceKind: 'tool_call',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-run-idem' }], boundary: 'real',
    });
    expect(contradicted.status).toBe('contradicted');
    expect(fs.readFileSync(usageJsonlPath('user-evidence'), 'utf8').trim().split('\n')).toHaveLength(2);
    await expect(usage.listAppliedUsageReceipts('user-evidence', { taskRunIds: ['run-idem'] }))
      .resolves.toEqual([]);
  });

  it('rejects unsafe or malformed query input', async () => {
    const { usage } = await recallModules();
    await expect(usage.listAppliedUsageReceipts('../unsafe', { taskRunIds: ['run-1'] }))
      .rejects.toThrow('invalid asset usage receipt query');
    await expect(usage.listAppliedUsageReceipts('user-evidence', { taskRunIds: ['../unsafe'] }))
      .rejects.toThrow('invalid asset usage receipt query');
    await expect(usage.listAppliedUsageReceipts('user-evidence', { taskRunIds: ['run-1'], assetId: '../unsafe' }))
      .rejects.toThrow('invalid asset usage receipt query');
    await expect(usage.listAppliedUsageReceipts('user-evidence', { taskRunIds: 'run-1' as never }))
      .rejects.toThrow('invalid asset usage receipt query');
    await expect(usage.listAppliedUsageReceipts('user-evidence', {} as never))
      .rejects.toThrow('invalid asset usage receipt query');
  });
});
