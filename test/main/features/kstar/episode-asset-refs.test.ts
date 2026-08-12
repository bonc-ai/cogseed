import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prev: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ep-refs-')); prev = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (prev === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = prev; fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('Episode 记录本轮实际带入的认知资产', () => {
  it('builder 原样收下调用方查到的引用', async () => {
    const { buildGroupKstarEpisode } = await import('../../../../src/main/features/kstar/episode-builder');
    const episode = buildGroupKstarEpisode({
      userId: 'u1',
      conversationId: 'conv-1',
      runId: 'run-1',
      executionId: 'turn-abc',
      userGoal: '评审接口',
      messages: [],
      abilityAssetRefs: ['asset:aa-1@v1', 'asset:aa-2@v3'],
    } as never);
    expect(episode.k.abilityAssetRefs).toEqual(['asset:aa-1@v1', 'asset:aa-2@v3']);
  });

  it('没传就是空数组——空表示本轮没带入，不是没查', async () => {
    const { buildGroupKstarEpisode } = await import('../../../../src/main/features/kstar/episode-builder');
    const episode = buildGroupKstarEpisode({
      userId: 'u1', conversationId: 'conv-1', runId: 'run-1',
      userGoal: '评审接口', messages: [],
    } as never);
    expect(episode.k.abilityAssetRefs).toEqual([]);
  });

  it('builder 保持同步纯函数，不为这个字段读盘', async () => {
    const mod = await import('../../../../src/main/features/kstar/episode-builder');
    // 返回值不是 Promise —— 纯函数属性是有意的设计，回归时要守住。
    const out = mod.buildGroupKstarEpisode({
      userId: 'u1', conversationId: 'c', runId: 'r', userGoal: 'g', messages: [],
    } as never);
    expect(out).not.toBeInstanceOf(Promise);
    expect(typeof out.id).toBe('string');
  });
});

describe('资产引用来自回执，不重新推断', () => {
  it('按 executionId 取回 reusedRefs，只保留 asset: 前缀的', async () => {
    const { prepareReceipt } = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    await prepareReceipt('u1', {
      executionId: 'turn-xyz',
      targetSessionId: 'gmember-conv-1-ag-1',
      // 回执里可能同时有非资产引用，Episode 只要资产那部分。
      reusedRefs: ['asset:aa-9@v2', 'memory:m-1'],
      omittedRefs: ['asset:aa-8@v1:paused'],
      permissionMode: 'read-only',
      allowedScopes: ['cognition:inherited'],
      boundary: 'real',
    }, { sessionId: 'gmember-conv-1-ag-1' });

    const { readReceipt } = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    const receipt = await readReceipt('u1', 'turn-xyz');
    const assetRefs = receipt.reusedRefs.filter((r) => r.startsWith('asset:'));
    expect(assetRefs).toEqual(['asset:aa-9@v2']);
    // 没带上的不算「实际带入」，不该混进 Episode。
    expect(assetRefs).not.toContain('asset:aa-8@v1:paused');
  });
});
