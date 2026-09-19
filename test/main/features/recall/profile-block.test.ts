import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 背景块资产源（清单 #7）：personal 资产按使用次数取头部、预算封顶、
// 空库回退文件渲染（由 memory.formatForSystemPrompt 的参数承接）。

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-profile-block';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-profile-block-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadAssetProfileEntries', () => {
  it('returns active personal assets ranked by usage, capped by budget', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const profile = await import('../../../../src/main/features/recall/profile-block');

    const mk = async (text: string, id: string) => {
      const now = new Date().toISOString();
      return assets.createAbilityAsset(UID, {
        schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
        sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_profileblock${id.replace(/-/g, '')}`.padEnd(16, 'x'),
        type: 'personal', title: text.slice(0, 10), statement: text,
        evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
        lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
        createdAt: now, updatedAt: now,
      }, { actor: 'user', reason: 'profile seed' });
    };
    await mk('常用画像：用户是开发者。', 'aa-pb-a');
    await mk('低频画像：用户喜欢周五复盘。', 'aa-pb-b');
    const paused = await mk('停用画像：不该出现。', 'aa-pb-c');
    await assets.pauseAbilityAsset(UID, paused.id, { actor: 'user', reason: 'test pause' });

    const entries = await profile.loadAssetProfileEntries(UID, {
      usageCounts: async () => new Map([['aa-pb-a', 9], ['aa-pb-b', 1], ['aa-pb-c', 99]]),
    });
    expect(entries.some((entry) => entry.includes('用户是开发者'))).toBe(true);
    expect(entries.every((entry) => !entry.includes('不该出现'))).toBe(true);
    expect(entries.length).toBeLessThanOrEqual(profile.PROFILE_BLOCK_MAX_ENTRIES);
  });

  it('memory block prefers asset entries and falls back to files when the pool is empty', async () => {
    const memory = await import('../../../../src/main/features/memory');
    const { userProfileFile } = await import('../../../../src/main/paths');
    fs.mkdirSync(path.dirname(userProfileFile(UID)), { recursive: true });
    fs.writeFileSync(userProfileFile(UID), '文件时代的画像条目。', 'utf8');

    const fromAssets = memory.formatForSystemPrompt(UID, 'commander', undefined, undefined, new Set(), ['资产时代的画像条目。']);
    expect(fromAssets).toContain('资产时代的画像条目。');
    expect(fromAssets).not.toContain('文件时代的画像条目。');

    const fallback = memory.formatForSystemPrompt(UID, 'commander', undefined, undefined, new Set(), []);
    expect(fallback).toContain('文件时代的画像条目。');
  });

describe('profile ordering + origin prefix (2026-09-19 三小修)', () => {
  it('a freshly captured zero-use asset outranks older confirmed ones and carries origin prefixes', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-pb-rank');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const profile = await import('../../../../src/main/features/recall/profile-block');
    const mk = async (id: string, statement: string, updatedAt: string, lifecycle: string) => assets.createAbilityAsset('user-pb-rank', {
      schemaVersion: 2, ownerId: 'user-pb-rank', id, candidateId: `cand-${id}`,
      sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_${id.slice(3)}padpadpad`,
      type: 'personal', title: statement.slice(0, 8), statement,
      evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
      lifecycleStatus: lifecycle as never, maturity: 'bud', version: '1',
      createdAt: updatedAt, updatedAt,
    }, { actor: 'user', reason: 'seed' });
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1_000).toISOString();
    // 注意：mk 走 user actor，lifecycle 必须是 user_confirmed_unverified——
    // 「模型记的」用 update 改 lifecycle 不行（单向门），所以用两条确认资产
    // 对比新旧档位即可；出身前缀断言由 statement 内容携带。
    await mk('aa-rank-old-confirmed-1', '老确认画像一。', old, 'user_confirmed_unverified');
    await mk('aa-rank-old-confirmed-2', '老确认画像二。', old, 'user_confirmed_unverified');
    const fresh = new Date().toISOString();
    await mk('aa-rank-fresh-confirmed', '刚确认的新偏好。', fresh, 'user_confirmed_unverified');

    const entries = await profile.loadAssetProfileEntries('user-pb-rank', {
      usageCounts: async () => new Map([['aa-rank-old-confirmed-1', 99], ['aa-rank-old-confirmed-2', 50]]),
    });
    // 72h 内的新资产压过 99 次使用的老资产，排第一。
    expect(entries[0]).toContain('刚确认的新偏好。');
    expect(entries[0]).toContain('[已确认]');
    expect(entries.every((entry) => entry.startsWith('[已确认] ') || entry.startsWith('[模型记的] '))).toBe(true);
  });
});

});
