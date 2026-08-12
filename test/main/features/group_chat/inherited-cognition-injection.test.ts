import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-inherit-inject-')); previousRoot = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

const UID = 'user-inject';
const AGENT_ID = 'ag-inject';

async function seedAsset(statement: string, id: string): Promise<RecallAbilityAssetRecord> {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const candidate = await candidates.saveRecallCandidate(UID, {
    judgment: statement,
    suggestedType: 'rule',
    suggestedScope: 'delivery',
    sourceRefs: [{ kind: 'execution', id: `exec-${id}` }],
  });
  const { asset } = await candidates.promoteRecallCandidate(UID, candidate.id, {
    forbiddenWhen: id === 'b' ? ['在客户现场不要引用内部估算'] : undefined,
  });
  return asset;
}

async function recordBirth(assets: RecallAbilityAssetRecord[], createdAt = new Date().toISOString()) {
  const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
  return recordAgentInheritance(UID, {
    agentId: AGENT_ID,
    rolePrompt: '你负责交付评审。',
    assets,
    createdAt,
  });
}

async function block(): Promise<string> {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  return bus._buildInheritedCognitionBlockForTest(UID, AGENT_ID);
}

describe('继承认知注入 Agent 运行时', () => {
  it('把冻结的资产语句与版本号注入提示', async () => {
    const a = await seedAsset('动手前先把验收标准写成可勾选的清单。', 'a');
    await recordBirth([a]);

    const out = await block();
    expect(out).toContain('### Inherited cognition');
    expect(out).toContain('动手前先把验收标准写成可勾选的清单。');
    expect(out).toContain(`[${a.id} v1]`);
  });

  it('禁用条件一并注入，模型才可能遵守', async () => {
    const b = await seedAsset('对外报价前先过一遍内部估算口径。', 'b');
    await recordBirth([b]);

    const out = await block();
    expect(out).toContain('禁用：在客户现场不要引用内部估算');
    expect(out).toContain('Respect every stated');
  });

  it('资产在 Agent 生成之后被撤销，立即停止注入', async () => {
    const a = await seedAsset('这条稍后会被撤销。', 'a');
    await recordBirth([a]);
    expect(await block()).toContain('这条稍后会被撤销。');

    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.revokeAbilityAsset(UID, a.id, 'unsafe');

    // 冻结的是内容，不是授权——撤销必须对已生成的 Agent 立刻生效。
    const after = await block();
    expect(after).not.toContain('这条稍后会被撤销。');
    expect(after).toBe('');
  });

  it('被暂停的资产同样不注入，并在块里说明扣了几条', async () => {
    const a = await seedAsset('这条会被暂停。', 'a');
    const b = await seedAsset('这条保持生效。', 'b');
    await recordBirth([a, b]);

    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.pauseAbilityAsset(UID, a.id, 'under review');

    const out = await block();
    expect(out).not.toContain('这条会被暂停。');
    expect(out).toContain('这条保持生效。');
    expect(out).toContain('1 inherited item(s) withheld');
  });

  it('注入的是出生时的冻结文本，资产事后被编辑不改变已生成 Agent 的行为', async () => {
    const a = await seedAsset('原始判断。', 'a');
    await recordBirth([a]);

    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.updateAbilityAsset(UID, a.id, { statement: '后来改过的判断。' });

    const out = await block();
    expect(out).toContain('原始判断。');
    expect(out).not.toContain('后来改过的判断。');
    // 版本号仍是出生时那一版，回执才说得清当时用的是第几版。
    expect(out).toContain(`[${a.id} v1]`);
  });

  it('能力包过期后整份不注入', async () => {
    const a = await seedAsset('过期包里的判断。', 'a');
    // 出生时间设在两年前，出生包 TTL 一年，必然过期。
    const longAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    await recordBirth([a], longAgo);

    expect(await block()).toBe('');
  });

  it('没有继承记录的 Agent 注入空串，不报错也不编造', async () => {
    expect(await block()).toBe('');
  });
});
