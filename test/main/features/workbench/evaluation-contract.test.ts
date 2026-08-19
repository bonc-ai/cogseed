import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'test-user-ec';
const MOD = '../../../../src/main/features/workbench/evaluation-contract';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-eval-contract-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules(); // paths.ts WS_ROOT 模块加载时求值
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  return import(MOD);
}

describe('evaluation-contract › 创建与读取', () => {
  it('创建即冻结：success_criteria 落盘、frozen_at 存在、id 前缀 ec_', async () => {
    const m = await loadMod();
    const c = await m.createEvaluationContract(UID, {
      skillAssetId: 'sk-handoff',
      skillVersion: '1.0.0',
      successCriteria: [
        'Action Plan 可追溯到实际使用的资产',
        '目标 Agent 真实加载能力包并产出首个 Action Plan',
      ],
      comparisonMethod: 'baseline_treatment_diff',
    });
    expect(c.evaluation_contract_id).toMatch(/^ec_/);
    expect(c.frozen_at).toBeDefined();
    expect(c.success_criteria.length).toBe(2);

    const back = await m.readEvaluationContract(UID, c.evaluation_contract_id);
    expect(back?.skill_asset_id).toBe('sk-handoff');
    expect(back?.success_criteria[0]).toContain('Action Plan');
  });

  it('非法入参抛错：空 criteria / 超长 criterion / 非法 asset id', async () => {
    const m = await loadMod();
    await expect(m.createEvaluationContract(UID, {
      skillAssetId: 'sk-x', skillVersion: '1.0.0', successCriteria: [],
    })).rejects.toThrow('requires success criteria');
    await expect(m.createEvaluationContract(UID, {
      skillAssetId: 'sk-x', skillVersion: '1.0.0',
      successCriteria: ['x'.repeat(501)],
    })).rejects.toThrow('too long');
    await expect(m.createEvaluationContract(UID, {
      skillAssetId: 'bad/id!', skillVersion: '1.0.0',
      successCriteria: ['ok'],
    })).rejects.toThrow('invalid skill asset id');
  });

  it('不存在/非法 id → null', async () => {
    const m = await loadMod();
    expect(await m.readEvaluationContract(UID, 'ec_missing')).toBeNull();
    expect(await m.readEvaluationContract(UID, 'bad id')).toBeNull();
  });

  it('listEvaluationContracts 按资产过滤、最新在前', async () => {
    const m = await loadMod();
    // 显式 createdAt（nowIso 为毫秒精度，同一毫秒内创建会触发 id tie-break，测不出排序语义）
    const c1 = await m.createEvaluationContract(UID, { skillAssetId: 'sk-a', skillVersion: '1.0.0', successCriteria: ['a'], createdAt: '2026-08-01T00:00:00.000Z' });
    const c2 = await m.createEvaluationContract(UID, { skillAssetId: 'sk-a', skillVersion: '1.1.0', successCriteria: ['b'], createdAt: '2026-08-02T00:00:00.000Z' });
    await m.createEvaluationContract(UID, { skillAssetId: 'sk-other', skillVersion: '1.0.0', successCriteria: ['c'], createdAt: '2026-08-03T00:00:00.000Z' });

    const list = await m.listEvaluationContracts(UID, 'sk-a');
    expect(list.length).toBe(2);
    expect(list[0].evaluation_contract_id).toBe(c2.evaluation_contract_id); // 最新在前
    expect(list[1].evaluation_contract_id).toBe(c1.evaluation_contract_id);
  });
});
