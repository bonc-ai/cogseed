import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prev: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-sem-flow-')); prev = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (prev === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = prev; fs.rmSync(tmpDir, { recursive: true, force: true }); });

const UID = 'user-flow';

async function cs() {
  return import('../../../../src/main/features/recall/candidate-service');
}

const baseInput = {
  suggestedType: 'rule' as const,
  suggestedScope: 'delivery',
  sourceRefs: [{ kind: 'execution', id: 'exec-1' }],
};

describe('适用/禁用条件从候选流到资产', () => {
  it('候选自带的条件在 promote 后进入资产——自动链路不再永远为空', async () => {
    // 此前 promote 只认调用方传的 options，候选自带的条件被丢弃，
    // 于是自动抽取产出的资产永远没有边界，等于形同虚设。
    const service = await cs();
    const candidate = await service.saveRecallCandidate(UID, {
      ...baseInput,
      judgment: '对外报价前先过一遍内部估算口径。',
      applicableWhen: ['准备对外报价时'],
      forbiddenWhen: ['在客户现场不要引用内部估算'],
    });
    expect(candidate.applicableWhen).toEqual(['准备对外报价时']);

    const { asset } = await service.promoteRecallCandidate(UID, candidate.id);
    expect(asset.applicableWhen).toEqual(['准备对外报价时']);
    expect(asset.forbiddenWhen).toEqual(['在客户现场不要引用内部估算']);
  });

  it('调用方显式传入的可覆盖候选自带的', async () => {
    const service = await cs();
    const candidate = await service.saveRecallCandidate(UID, {
      ...baseInput,
      judgment: '一条带原始边界的判断。',
      applicableWhen: ['原始场景'],
    });
    const { asset } = await service.promoteRecallCandidate(UID, candidate.id, {
      applicableWhen: ['人工修正后的场景'],
    });
    expect(asset.applicableWhen).toEqual(['人工修正后的场景']);
  });

  it('候选没识别出条件时保持缺失，不补空数组', async () => {
    // 缺失=没识别出来；空数组会被读成「已确认无限制」，两者含义不同。
    const service = await cs();
    const candidate = await service.saveRecallCandidate(UID, {
      ...baseInput,
      judgment: '一条没有明显边界的判断。',
    });
    expect(candidate.applicableWhen).toBeUndefined();
    const { asset } = await service.promoteRecallCandidate(UID, candidate.id);
    expect(asset.applicableWhen).toBeUndefined();
    expect(asset.forbiddenWhen).toBeUndefined();
  });

  it('候选层与资产层共用同一套规范化：去重且大小写不敏感', async () => {
    const service = await cs();
    const candidate = await service.saveRecallCandidate(UID, {
      ...baseInput,
      judgment: '重复条件应被去重。',
      applicableWhen: ['  评审接口时  ', '评审接口时', '写文档时'],
    });
    expect(candidate.applicableWhen).toEqual(['评审接口时', '写文档时']);
  });

  it('非法条件在候选写盘前就被拒，不留半写状态', async () => {
    const service = await cs();
    await expect(service.saveRecallCandidate(UID, {
      ...baseInput,
      judgment: '条件类型非法。',
      applicableWhen: ['ok', 123 as unknown as string],
    })).rejects.toThrow();
    const dir = path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'candidates');
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });
});
