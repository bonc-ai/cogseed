import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
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
});
