import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prev: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-l3-')); prev = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (prev === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = prev; fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('L3 闸门在沉淀入口生效', () => {
  it('含凭证的判断不形成候选', async () => {
    const cs = await import('../../../../src/main/features/recall/candidate-service');
    await expect(cs.saveRecallCandidate('u1', {
      judgment: '部署时用 api_key = sk_live_9f8e7d6c5b4a3210 这个凭证。',
      suggestedType: 'rule', suggestedScope: 'ops',
      sourceRefs: [{ kind: 'execution', id: 'exec-1' }],
    })).rejects.toThrow('forbidden to persist');
    // 关键：不是静默丢弃，而且磁盘上不该留下记录
    const dir = path.join(tmpDir, 'u1', 'cloud', 'recall', 'records', 'candidates');
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('凭证藏在 summary 里同样拦下', async () => {
    const cs = await import('../../../../src/main/features/recall/candidate-service');
    await expect(cs.saveRecallCandidate('u1', {
      judgment: '一条正常的工程判断。',
      summary: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      suggestedType: 'rule', suggestedScope: 'ops',
      sourceRefs: [{ kind: 'execution', id: 'exec-2' }],
    })).rejects.toThrow('forbidden to persist');
  });

  it('正常判断照常沉淀，闸门不误伤', async () => {
    const cs = await import('../../../../src/main/features/recall/candidate-service');
    const c = await cs.saveRecallCandidate('u1', {
      judgment: '密码字段在日志里必须脱敏。',
      suggestedType: 'rule', suggestedScope: 'ops',
      sourceRefs: [{ kind: 'execution', id: 'exec-3' }],
    });
    expect(c.status).toBe('pending');
    const { asset } = await cs.promoteRecallCandidate('u1', c.id);
    expect(asset.statement).toContain('脱敏');
  });

  it('资产编辑路径也挡（纵深防御）', async () => {
    const cs = await import('../../../../src/main/features/recall/candidate-service');
    const as = await import('../../../../src/main/features/recall/asset-service');
    const c = await cs.saveRecallCandidate('u1', {
      judgment: '正常判断。', suggestedType: 'rule', suggestedScope: 'ops',
      sourceRefs: [{ kind: 'execution', id: 'exec-4' }],
    });
    const { asset } = await cs.promoteRecallCandidate('u1', c.id);
    await expect(as.updateAbilityAsset('u1', asset.id, {
      statement: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    })).rejects.toThrow('forbidden to persist');
    // 被拒的编辑不该动版本
    expect((await as.readAbilityAsset('u1', asset.id)).version).toBe('1');
  });
});
