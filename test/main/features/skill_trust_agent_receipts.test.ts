/**
 * Agent 私有 Skill 回执的快照与还原：更新失败把旧版换回来时，回执也要跟着换回，
 * 否则旧私有 Skill 的树摘要与回执对不上，会被当成被篡改而拒绝加载。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UID = 'receipts-user';
let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  vi.doUnmock('node:fs');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-receipts-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});
afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

const scan = { outcome: 'pass', score: 10 };
const violations = { violationCount: 0 };

async function load() {
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
  return import('../../../src/main/features/skill_trust');
}

describe('Agent 回执快照', () => {
  it('更新失败：新版本写的回执被清掉，旧回执原样回来', async () => {
    const t = await load();
    t.writeInstallReceipt(UID, 'ocr', 'hash-old', scan, violations, 'agent1');
    const before = t.readReceipt(UID, 'ocr', 'agent1');
    expect(before?.payloadHash).toBe('hash-old');

    const snapshot = t.snapshotAgentReceipts(UID, 'agent1');
    // 新版本深扫通过后覆盖同一个键，另外多出一个新 Skill 的回执
    t.writeInstallReceipt(UID, 'ocr', 'hash-new', scan, violations, 'agent1');
    t.writeInstallReceipt(UID, 'extra', 'hash-extra', scan, violations, 'agent1');
    // 更新失败 → 还原
    t.restoreAgentReceipts(UID, 'agent1', snapshot);

    expect(t.readReceipt(UID, 'ocr', 'agent1')?.payloadHash).toBe('hash-old');
    expect(t.readReceipt(UID, 'extra', 'agent1')).toBeNull();
  });

  it('只动这个 Agent 的回执，别的 Agent 与独立 Skill 的不受影响', async () => {
    const t = await load();
    t.writeInstallReceipt(UID, 'ocr', 'hash-a', scan, violations, 'agent1');
    t.writeInstallReceipt(UID, 'ocr', 'hash-b', scan, violations, 'agent2');
    t.writeInstallReceipt(UID, 'ocr', 'hash-standalone', scan, violations);
    const snapshot = t.snapshotAgentReceipts(UID, 'agent1');
    t.writeInstallReceipt(UID, 'ocr', 'hash-a2', scan, violations, 'agent1');
    t.restoreAgentReceipts(UID, 'agent1', snapshot);

    expect(t.readReceipt(UID, 'ocr', 'agent1')?.payloadHash).toBe('hash-a');
    expect(t.readReceipt(UID, 'ocr', 'agent2')?.payloadHash).toBe('hash-b');
    expect(t.readReceipt(UID, 'ocr')?.payloadHash).toBe('hash-standalone');
  });

  it('全新安装失败（没有旧回执）：还原后这个 Agent 不留任何回执', async () => {
    const t = await load();
    const snapshot = t.snapshotAgentReceipts(UID, 'fresh');
    expect(snapshot).toEqual([]);
    t.writeInstallReceipt(UID, 'ocr', 'hash-new', scan, violations, 'fresh');
    t.restoreAgentReceipts(UID, 'fresh', snapshot);
    expect(t.readReceipt(UID, 'ocr', 'fresh')).toBeNull();
  });

  it('agentId 前缀相近的 Agent 不会被误清（agent1 与 agent10）', async () => {
    const t = await load();
    t.writeInstallReceipt(UID, 'ocr', 'hash-1', scan, violations, 'agent1');
    t.writeInstallReceipt(UID, 'ocr', 'hash-10', scan, violations, 'agent10');
    t.restoreAgentReceipts(UID, 'agent1', []);
    expect(t.readReceipt(UID, 'ocr', 'agent1')).toBeNull();
    expect(t.readReceipt(UID, 'ocr', 'agent10')?.payloadHash).toBe('hash-10');
  });
});
