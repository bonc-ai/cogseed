import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RecallAbilityAssetRecord } from '../../../src/main/features/recall/candidate-service';

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-agent-inherit-')); previousRoot = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

const CREATED_AT = '2026-08-11T02:00:00.000Z';

function asset(overrides: Partial<RecallAbilityAssetRecord> & { id: string }): RecallAbilityAssetRecord {
  return {
    schemaVersion: 1,
    ownerId: 'user-inherit',
    candidateId: `cand-${overrides.id}`,
    type: 'rule',
    title: `Title ${overrides.id}`,
    statement: `Statement for ${overrides.id}`,
    evidenceRefs: [{ kind: 'execution', id: `exec-${overrides.id}` }],
    scope: 'delivery',
    status: 'active',
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
  it('冻结认知资产版本，并把撤销的资产记进排除项', async () => {
    const { buildAgentInheritance } = await mod();
    const record = buildAgentInheritance(baseInput());

    expect(record.capabilityPack.assets.map((ref) => ref.assetId)).toEqual(['aa-0001']);
    expect(record.capabilityPack.assets[0].version).toBe('1');
    expect(record.capabilityPack.excluded[0]).toMatchObject({ assetId: 'aa-0002', reason: 'revoked' });
    expect(record.capabilityPack.contentHash).toHaveLength(64);
  });

  it('能力包绑定到该 agent，换 agent 不能复用同一份', async () => {
    const { buildAgentInheritance } = await mod();
    const first = buildAgentInheritance(baseInput());
    const second = buildAgentInheritance(baseInput({ agentId: 'ag-002' }));

    expect(first.capabilityPack.targetAgent).toBe('ag-001');
    expect(second.capabilityPack.targetAgent).toBe('ag-002');
    expect(second.capabilityPack.contentHash).not.toBe(first.capabilityPack.contentHash);
  });

  it('origin 只留 id，非法 id 直接拒绝', async () => {
    const { buildAgentInheritance } = await mod();
    expect(() => buildAgentInheritance(baseInput({ origin: { conversationId: '../escape' } })))
      .toThrow('conversationId');
  });

  it('术语表去重且大小写不敏感', async () => {
    const { buildAgentInheritance } = await mod();
    const record = buildAgentInheritance(baseInput({
      glossary: [
        { term: 'KSTAR', definition: '认知评估机制' },
        { term: 'kstar', definition: '重复项，忽略' },
        { term: '能力包', definition: '交给执行端的最小认知集合' },
      ],
    }));
    expect(record.glossary).toEqual([
      { term: 'KSTAR', definition: '认知评估机制' },
      { term: '能力包', definition: '交给执行端的最小认知集合' },
    ]);
  });

  it('没有术语表/记忆时字段整个缺失，不写空数组', async () => {
    const { buildAgentInheritance } = await mod();
    const record = buildAgentInheritance(baseInput());
    expect(record.glossary).toBeUndefined();
    expect(record.memoryRefs).toBeUndefined();
  });

  it('拒绝空角色提示——没有提示的继承记录没有意义', async () => {
    const { buildAgentInheritance } = await mod();
    expect(() => buildAgentInheritance(baseInput({ rolePrompt: '   ' }))).toThrow('role prompt');
  });
});

describe('agent 出生快照持久化', () => {
  it('落盘后可读回，内容一致', async () => {
    const { recordAgentInheritance, readAgentInheritance } = await mod();
    const written = await recordAgentInheritance('user-inherit', baseInput());
    const read = await readAgentInheritance('user-inherit', 'ag-001');

    expect(read).not.toBeNull();
    expect(read!.capabilityPack.contentHash).toBe(written.capabilityPack.contentHash);
    expect(read!.origin).toEqual({ conversationId: 'gconv-source', projectId: 'proj-alpha' });
    expect(read!.rolePrompt).toBe(written.rolePrompt);
  });

  it('出生快照一次写入，重复记录被拒绝', async () => {
    const { recordAgentInheritance } = await mod();
    await recordAgentInheritance('user-inherit', baseInput());
    await expect(recordAgentInheritance('user-inherit', baseInput()))
      .rejects.toThrow('already recorded');
  });

  it('资产事后被撤销，已落盘的出生快照内容不变', async () => {
    const { recordAgentInheritance, readAgentInheritance } = await mod();
    const written = await recordAgentInheritance('user-inherit', baseInput());

    // 模拟资产在 agent 生成之后被撤销：快照是历史，不该跟着变。
    const after = await readAgentInheritance('user-inherit', 'ag-001');
    expect(after!.capabilityPack.assets.map((r) => r.assetId)).toEqual(['aa-0001']);
    expect(after!.capabilityPack.contentHash).toBe(written.capabilityPack.contentHash);
  });

  it('没有继承记录的老 agent 返回 null，而不是空记录', async () => {
    const { readAgentInheritance } = await mod();
    expect(await readAgentInheritance('user-inherit', 'ag-legacy')).toBeNull();
  });

  it('记录损坏时抛错，不静默当作没有继承', async () => {
    const { agentInheritanceFile, readAgentInheritance } = await mod();
    const filePath = agentInheritanceFile('user-inherit', 'ag-broken');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ not json', 'utf8');
    await expect(readAgentInheritance('user-inherit', 'ag-broken')).rejects.toThrow('malformed');
  });

  it('记录里的 agentId 与请求不符时拒绝读取', async () => {
    const { agentInheritanceFile, readAgentInheritance } = await mod();
    const filePath = agentInheritanceFile('user-inherit', 'ag-mismatch');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1, agentId: 'ag-someone-else', rolePrompt: 'x',
      capabilityPack: {}, createdAt: CREATED_AT,
    }), 'utf8');
    await expect(readAgentInheritance('user-inherit', 'ag-mismatch')).rejects.toThrow('malformed');
  });
});
