/** 绑定回执：写读往返、无回合不记录、非法输入拒绝、只存指针不存值、
 * 坏档跳过；personal_fields_check 使用实际回执实现，体检失败不落回执。 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/main/features/recall/agent-read-accounting', () => ({
  recordAssetAgentReads: vi.fn(async () => {}),
}));

vi.mock('../../../../src/main/features/cognition_kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/cognition_kernel')>();
  return {
    ...actual,
    checkTaskFields: vi.fn(),
    getTaskFieldPack: vi.fn(),
    recordCognitionBoundReceipt: vi.fn(
      (uid: string, turnId: string | undefined, packId: string, check: import('../../../../src/main/features/cognition_kernel').TaskFieldCheck) =>
        actual.recordCognitionBoundReceipt(uid, turnId, packId, check),
    ),
    TASK_FIELD_PACKS: { synthetic_task: { id: 'synthetic_task', title: '合成任务', fields: [{ fieldName: '姓名' }, { fieldName: '工号' }] } },
  };
});

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ck-bound-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fixtureCheck(): import('../../../../src/main/features/cognition_kernel').TaskFieldCheck {
  return {
    packId: 'synthetic_task',
    packTitle: '合成任务',
    resolution: {
      bound: [{
        fieldName: '姓名', value: '示例用户甲', source: 'ontology_value', sourceId: 'pv-1',
        version: 'v3', revision: 'r9', updatedAt: '2026-10-07T00:00:00.000Z',
      }],
      missing: [
        { fieldName: '工号', required: true, reason: 'no_value' },
        { fieldName: '联系偏好', required: false, reason: 'restricted' },
      ],
      policyVersion: 'pfv-1',
    },
    gaps: [{ axis: 'personal', fieldName: '工号', required: true, reason: 'no_value', question: '请补充：工号', action: 'answer' }],
    boundCount: 1,
    totalCount: 3,
  };
}

describe('cognition bound receipt 单元', () => {
  it('写入后可按回合读回，且只存指针不存值', async () => {
    const { recordCognitionBoundReceipt, listCognitionBoundReceipts } = await import('../../../../src/main/features/cognition_kernel');
    const receipt = await recordCognitionBoundReceipt('u1', 'turn-1', 'synthetic_task', fixtureCheck());
    expect(receipt?.taskRunId).toBe('turn-1');
    expect(receipt?.boundCount).toBe(1);
    expect(receipt?.totalCount).toBe(3);

    const listed = await listCognitionBoundReceipts('u1', 'turn-1');
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(receipt?.id);
    expect(listed[0].bound[0]).toMatchObject({ slot: '姓名', axis: 'personal', source: 'ontology_value', sourceId: 'pv-1', version: 'v3' });
    expect('value' in (listed[0].bound[0] as unknown as Record<string, unknown>)).toBe(false);
    expect(listed[0].missing).toEqual([
      { slot: '工号', axis: 'personal', reason: 'no_value', required: true },
      { slot: '联系偏好', axis: 'personal', reason: 'restricted', required: false },
    ]);
    expect(await listCognitionBoundReceipts('u1', 'turn-other')).toHaveLength(0);
  });

  it('无真实回合不记录；非法属主或空槽拒绝写', async () => {
    const { recordCognitionBoundReceipt } = await import('../../../../src/main/features/cognition_kernel');
    expect(await recordCognitionBoundReceipt('u1', undefined, 'synthetic_task', fixtureCheck())).toBeUndefined();
    await expect(recordCognitionBoundReceipt('bad uid', 'turn-1', 'synthetic_task', fixtureCheck())).rejects.toThrow(/owner/);
    const empty = fixtureCheck();
    empty.resolution = { bound: [], missing: [], policyVersion: 'pfv-1' };
    await expect(recordCognitionBoundReceipt('u1', 'turn-1', 'synthetic_task', empty)).rejects.toThrow(/at least one slot/);
  });

  it('读侧跳过形状不对的历史记录，不当作证据', async () => {
    const { recordCognitionBoundReceipt, listCognitionBoundReceipts } = await import('../../../../src/main/features/cognition_kernel');
    await recordCognitionBoundReceipt('u1', 'turn-1', 'synthetic_task', fixtureCheck());
    const { appendRecallJsonlRecord } = await import('../../../../src/main/features/recall/store');
    // 形状不对但行本身合法（id 不符合回执模式）：读侧校验须跳过它
    await appendRecallJsonlRecord('u1', 'cognition-bound-receipts', 'events',
      { schemaVersion: 1, ownerId: 'u1', id: 'cbound-legacy-xxxx' });
    const listed = await listCognitionBoundReceipts('u1');
    expect(listed).toHaveLength(1);
    expect(listed[0].bound[0].slot).toBe('姓名');
  });
});

describe('personal_fields_check 绑定回执接线', () => {
  it('体检成功后回执落盘（真实回执实现），行为不变', async () => {
    const kernel = await import('../../../../src/main/features/cognition_kernel');
    vi.mocked(kernel.checkTaskFields).mockResolvedValue(fixtureCheck());
    vi.mocked(kernel.getTaskFieldPack).mockReturnValue(
      (kernel.TASK_FIELD_PACKS as Record<string, import('../../../../src/main/features/cognition_kernel').TaskFieldPack>).synthetic_task,
    );
    const { createCognitionKernelTools } = await import('../../../../src/main/model/core-agent/cognition-kernel-tools');
    const tools = createCognitionKernelTools({ userId: 'u1', turnId: 'turn-42' });
    const check = tools.find((tool) => tool.name === 'personal_fields_check');
    expect(check).toBeTruthy();

    const result = await check!.execute({ pack: 'synthetic_task' });
    const payload = JSON.parse((result as { content: string }).content);
    expect(payload.boundCount).toBe(1);
    expect(payload.missing[0]).toMatchObject({ slot: '工号', axis: 'personal', ask: '请补充：工号', action: 'answer' });

    const receipts = await kernel.listCognitionBoundReceipts('u1', 'turn-42');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].packId).toBe('synthetic_task');
    expect(receipts[0].bound[0].sourceId).toBe('pv-1');
    expect('value' in (receipts[0].bound[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it('无 turnId 的调用不落盘', async () => {
    const kernel = await import('../../../../src/main/features/cognition_kernel');
    vi.mocked(kernel.checkTaskFields).mockResolvedValue(fixtureCheck());
    vi.mocked(kernel.getTaskFieldPack).mockReturnValue(
      (kernel.TASK_FIELD_PACKS as Record<string, import('../../../../src/main/features/cognition_kernel').TaskFieldPack>).synthetic_task,
    );
    const { createCognitionKernelTools } = await import('../../../../src/main/model/core-agent/cognition-kernel-tools');
    const tools = createCognitionKernelTools({ userId: 'u2' });
    const check = tools.find((tool) => tool.name === 'personal_fields_check');
    await check!.execute({ pack: 'synthetic_task' });
    expect(await kernel.listCognitionBoundReceipts('u2')).toHaveLength(0);
  });

  it('体检抛错回工具错误且不写回执；回执异常只降级不砸工具', async () => {
    const kernel = await import('../../../../src/main/features/cognition_kernel');
    vi.mocked(kernel.checkTaskFields).mockRejectedValue(new Error('store down'));
    vi.mocked(kernel.getTaskFieldPack).mockReturnValue(
      (kernel.TASK_FIELD_PACKS as Record<string, import('../../../../src/main/features/cognition_kernel').TaskFieldPack>).synthetic_task,
    );
    const { createCognitionKernelTools } = await import('../../../../src/main/model/core-agent/cognition-kernel-tools');
    const tools = createCognitionKernelTools({ userId: 'u3', turnId: 'turn-1' });
    const check = tools.find((tool) => tool.name === 'personal_fields_check');
    const failed = await check!.execute({ pack: 'synthetic_task' }) as { isError?: boolean };
    expect(failed.isError).toBe(true);
    expect(await kernel.listCognitionBoundReceipts('u3')).toHaveLength(0);

    vi.mocked(kernel.checkTaskFields).mockResolvedValue(fixtureCheck());
    vi.mocked(kernel.recordCognitionBoundReceipt).mockRejectedValueOnce(new Error('receipt io down'));
    const ok = await check!.execute({ pack: 'synthetic_task' }) as { isError?: boolean; content: string };
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content).boundCount).toBe(1);
  });
});
