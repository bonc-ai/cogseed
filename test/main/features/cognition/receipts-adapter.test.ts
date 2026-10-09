import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listReceipts: vi.fn(),
  readReceipt: vi.fn(),
  executionList: vi.fn(),
  executionRead: vi.fn(),
}));

vi.mock('../../../../src/main/features/p3394', () => ({
  listReceipts: mocks.listReceipts,
  readReceipt: mocks.readReceipt,
}));
vi.mock('../../../../src/main/features/execution-records', () => ({
  list: mocks.executionList,
  read: mocks.executionRead,
}));
vi.mock('../../../../src/main/features/recall/source-service', () => ({
  cognitionSourceRefKeys: (refs: Array<{ kind: string; id: string }>) => refs.map((ref) => `${ref.kind}:${ref.id}`),
}));

import { listCognitionReuseReceipts } from '../../../../src/main/features/cognition/receipts-adapter';

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    receiptId: 'receipt-1',
    executionId: 'turn-abc123',
    targetSessionId: 'gconv-c1',
    reusedRefs: ['aa-1'],
    omittedRefs: [],
    permissionMode: 'read-only',
    allowedScopes: ['cognition:projection'],
    status: 'prepared' as const,
    boundary: 'real' as const,
    createdAt: '2026-08-17T06:38:19.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.listReceipts.mockReset();
  mocks.readReceipt.mockReset();
  mocks.executionList.mockReset();
  mocks.executionRead.mockReset();
  mocks.executionRead.mockResolvedValue(undefined);
});

describe('cognition receipts adapter', () => {
  /**
   * 这条钉住的是一个真实回归：列表曾经从 ExecutionRecord 的 `receiptId` 反查，
   * 而群聊回合注入后只写回执文件、从没有人把 receiptId 回填到同回合的执行
   * 记录上。结果回执真实存在（terminal-proof 照常按 executionId 读到它并完成
   * 迁移证明），只有这个面向 UI 的读口恒空。
   */
  it('lists receipts that no execution record points back to', async () => {
    mocks.listReceipts.mockResolvedValue([receipt()]);
    // 执行记录存在但没有 receiptId —— 正是 bus.ts 那条链的真实形态。
    mocks.executionRead.mockResolvedValue({
      executionId: 'turn-abc123', kind: 'core-agent', agentId: 'commander', conversationId: 'c1',
    });

    const out = await listCognitionReuseReceipts('u1');

    expect(out).toHaveLength(1);
    expect(out[0]!.receiptId).toBe('receipt-1');
    // 反查那条路已经断开：不再依赖 ExecutionRecord 列表。
    expect(mocks.executionList).not.toHaveBeenCalled();
  });

  it('keeps a receipt whose execution record cannot be read', async () => {
    mocks.listReceipts.mockResolvedValue([receipt()]);
    mocks.executionRead.mockRejectedValue(new Error('execution record missing'));

    const out = await listCognitionReuseReceipts('u1');

    // 执行记录只是展示补充，取不到不该让回执从列表里消失。
    expect(out).toHaveLength(1);
    expect(out[0]!.agentId).toBeUndefined();
  });

  it('returns newest first and honours the limit', async () => {
    mocks.listReceipts.mockResolvedValue([
      receipt({ receiptId: 'old', executionId: 'turn-old', createdAt: '2026-08-01T00:00:00.000Z' }),
      receipt({ receiptId: 'new', executionId: 'turn-new', createdAt: '2026-08-17T00:00:00.000Z' }),
      receipt({ receiptId: 'mid', executionId: 'turn-mid', createdAt: '2026-08-10T00:00:00.000Z' }),
    ]);

    const out = await listCognitionReuseReceipts('u1', { limit: 2 });

    expect(out.map((item) => item.receiptId)).toEqual(['new', 'mid']);
  });

  it('degrades to an empty list instead of throwing when the receipt store is unreadable', async () => {
    mocks.listReceipts.mockRejectedValue(new Error('receipt directory unreadable'));

    await expect(listCognitionReuseReceipts('u1')).resolves.toEqual([]);
  });
});
