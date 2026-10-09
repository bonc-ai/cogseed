import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RecallAbilityAssetRecord } from '../../../src/main/features/recall/candidate-service';

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-agent-inherit-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

const CREATED_AT = '2026-08-13T02:00:00.000Z';

function asset(overrides: Partial<RecallAbilityAssetRecord> & { id: string }): RecallAbilityAssetRecord {
  return {
    schemaVersion: 2,
    ownerId: 'user-inherit',
    candidateId: `cand-${overrides.id}`,
    reviewDecisionId: 'rd_abcdefgh1234',
    type: 'rule',
    title: `Title ${overrides.id}`,
    statement: `Statement for ${overrides.id}`,
    evidenceRefs: [{ kind: 'execution', id: `exec-${overrides.id}` }],
    scope: 'delivery',
    status: 'active',
    lifecycleStatus: 'user_confirmed_unverified',
    maturity: 'seed',
    version: '1',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  } as RecallAbilityAssetRecord;
}

async function mod() {
  return import('../../../src/main/features/agent_inheritance');
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'ag-001',
    rolePrompt: '你负责交付评审，先对齐验收标准再动手。',
    assets: [asset({ id: 'aa-0001' }), asset({ id: 'aa-0002', status: 'revoked' })],
    origin: { conversationId: 'gconv-source', projectId: 'proj-alpha' },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe('agent 出生快照构建', () => {
  it('冻结认知资产版本，并把没带走的记成带原因的排除项', async () => {
    const { buildAgentInheritance } = await mod();
    const record = buildAgentInheritance(baseInput());

    expect(record.inheritedAssets.map((ref) => ref.asset_id)).toEqual(['aa-0001']);
    expect(record.inheritedAssets[0].version).toBe('1');
    expect(record.inheritedAssets[0].content_hash).toHaveLength(32);
    // 少一条和从来没有过，在追溯页上长得一样——所以排除必须带原因。
    expect(record.excludedAssets).toEqual([{ assetId: 'aa-0002', reason: 'revoked' }]);
  });

  it('用户勾掉的与系统按状态排除的，原因分得开', async () => {
    const { buildAgentInheritance } = await mod();
    const record = buildAgentInheritance(baseInput({
      assets: [
        asset({ id: 'aa-0001' }),
        asset({ id: 'aa-0002', status: 'paused' }),
        asset({ id: 'aa-0003' }),
      ],
      excludedAssetIds: ['aa-0003'],
    }));

    expect(record.inheritedAssets.map((r) => r.asset_id)).toEqual(['aa-0001']);
    expect(record.excludedAssets).toEqual([
      { assetId: 'aa-0002', reason: 'paused' },
      { assetId: 'aa-0003', reason: 'user_excluded' },
    ]);
  });

  it('内容哈希覆盖正文而不只是版本号——改了正文没改版本也认得出来', async () => {
    const { inheritedAssetContentHash } = await mod();
    const base = asset({ id: 'aa-0001' });
    const drifted = asset({ id: 'aa-0001', statement: 'Quietly edited in place.' });
    expect(inheritedAssetContentHash(base)).not.toBe(inheritedAssetContentHash(drifted));
    expect(inheritedAssetContentHash(base)).toBe(inheritedAssetContentHash(asset({ id: 'aa-0001' })));
  });

  it('没有任何排除时不写空数组', async () => {
    const { buildAgentInheritance } = await mod();
    const record = buildAgentInheritance(baseInput({ assets: [asset({ id: 'aa-0001' })] }));
    expect(record.excludedAssets).toBeUndefined();
    expect(record.glossary).toBeUndefined();
  });

  it('拒绝非法 agent id 与超长角色提示', async () => {
    const { buildAgentInheritance } = await mod();
    expect(() => buildAgentInheritance(baseInput({ agentId: '../escape' }))).toThrow('invalid agent id');
    expect(() => buildAgentInheritance(baseInput({ rolePrompt: 'x'.repeat(8_001) })))
      .toThrow('role prompt is too long');
  });

  it('术语表按词条去重，记忆引用只收合法 id', async () => {
    const { buildAgentInheritance } = await mod();
    const record = buildAgentInheritance(baseInput({
      glossary: [
        { term: 'KSTAR', definition: '这里指任务闭环的七步。' },
        { term: 'kstar', definition: '重复词条，丢弃。' },
      ],
      memoryRefs: ['grp-001', 'grp-001', 'grp-002'],
    }));
    expect(record.glossary).toEqual([{ term: 'KSTAR', definition: '这里指任务闭环的七步。' }]);
    expect(record.memoryRefs).toEqual(['grp-001', 'grp-002']);
    expect(() => buildAgentInheritance(baseInput({ memoryRefs: ['../escape'] })))
      .toThrow('invalid agent inheritance memory ref');
  });
});

describe('agent 出生快照落盘与读取', () => {
  it('一次写入，重复记录直接拒绝', async () => {
    const { recordAgentInheritance } = await mod();
    await recordAgentInheritance('user-inherit', baseInput());
    await expect(recordAgentInheritance('user-inherit', baseInput()))
      .rejects.toThrow('already recorded');
  });

  it('没有继承记录的 agent 读出来是 null，不是空记录', async () => {
    const { readAgentInheritance } = await mod();
    // 「这个 Agent 生成时还没有继承机制」和「它继承了空」必须分得开。
    expect(await readAgentInheritance('user-inherit', 'ag-legacy')).toBeNull();
  });

  it('落盘后能原样读回，origin 只留 id', async () => {
    const { recordAgentInheritance, readAgentInheritance } = await mod();
    const written = await recordAgentInheritance('user-inherit', baseInput());
    const read = await readAgentInheritance('user-inherit', 'ag-001');
    expect(read).toEqual(written);
    expect(read!.origin).toEqual({ conversationId: 'gconv-source', projectId: 'proj-alpha' });
    expect(read!.schemaVersion).toBe(2);
  });

  it('列出全部出生快照，按时间倒序，坏文件跳过而不是整体失败', async () => {
    const { recordAgentInheritance, listAgentInheritance, agentInheritanceFile } = await mod();
    await recordAgentInheritance('user-inherit', baseInput({ agentId: 'ag-001', createdAt: CREATED_AT }));
    await recordAgentInheritance('user-inherit', baseInput({
      agentId: 'ag-002',
      createdAt: '2026-08-13T05:00:00.000Z',
    }));

    const brokenPath = agentInheritanceFile('user-inherit', 'ag-broken');
    fs.mkdirSync(path.dirname(brokenPath), { recursive: true });
    fs.writeFileSync(brokenPath, '{ not json');

    const records = await listAgentInheritance('user-inherit');
    expect(records.map((r) => r.agentId)).toEqual(['ag-002', 'ag-001']);
  });

  it('读得懂早先内嵌 capability pack 的 v1 记录，但不冒充它的哈希', async () => {
    const { readAgentInheritance, agentInheritanceFile } = await mod();
    const legacyPath = agentInheritanceFile('user-inherit', 'ag-legacy-v1');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({
      schemaVersion: 1,
      agentId: 'ag-legacy-v1',
      rolePrompt: '旧版记录。',
      origin: {},
      createdAt: CREATED_AT,
      capabilityPack: {
        packId: 'pack-agent-ag-legacy-v1',
        assets: [{ assetId: 'aa-old', version: '3', statementHash: 'deadbeef' }],
      },
    }));

    const read = await readAgentInheritance('user-inherit', 'ag-legacy-v1');
    expect(read!.inheritedAssets).toEqual([{ asset_id: 'aa-old', version: '3' }]);
    // v1 的 statementHash 只覆盖正文，语义比 content_hash 窄，不搬过来冒充。
    expect(read!.inheritedAssets[0].content_hash).toBeUndefined();
  });
});
