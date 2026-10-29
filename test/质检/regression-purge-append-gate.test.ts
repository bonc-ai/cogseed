/** 版本流写入保护：purge 后到达的版本流追加在 store 层被拒。 */
import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'reg-purge-gate';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-reg-pgate-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ACT = { actor: 'user' as const, reason: 'probe' };

function versionsFile(id: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'jsonl', 'ability-asset-versions', `${id}.jsonl`);
}

function versionRecord(assetId: string, version: string, statement: string) {
  return {
    schemaVersion: 1, ownerId: UID, id: `${assetId}-v${version}`, assetId, version,
    at: new Date().toISOString(), reason: 'probe', actor: 'user' as const,
    snapshot: {
      candidateId: `cand-${assetId}`, type: 'personal', title: `资产 ${assetId}`,
      statement, evidenceRefs: [], scope: 'general',
      lifecycleStatus: 'user_confirmed_unverified', version,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  };
}

async function mkAsset(id: string) {
  const now = new Date().toISOString();
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_reg${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: `资产 ${id}`, statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, ACT);
}

describe('purged 后版本流追加的 store 层闸门', () => {
  it('purge 后的迟到 append 被拒：流不复活、正文不落盘', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const { appendRecallJsonlRecord } = await import('../../src/main/features/recall/store');
    await mkAsset('aa-gate-1');
    await assets.deleteAbilityAsset(UID, 'aa-gate-1', ACT);
    await assets.purgeAbilityAsset(UID, 'aa-gate-1', ACT);
    expect(fs.existsSync(versionsFile('aa-gate-1'))).toBe(false);

    // 模拟绕过 asset-service 收口的迟到追加（直调 store 层写入口）。
    await expect(
      appendRecallJsonlRecord(UID, 'ability-asset-versions', 'aa-gate-1', versionRecord('aa-gate-1', '9', 'purge 后迟到的正文。') as never),
    ).rejects.toThrow(/has been purged/);
    expect(fs.existsSync(versionsFile('aa-gate-1'))).toBe(false);
    expect(await assets.listAbilityAssetVersions(UID, 'aa-gate-1')).toEqual([]);
  });

  it('对照组：活资产的版本流追加不受闸门影响', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const { appendRecallJsonlRecord } = await import('../../src/main/features/recall/store');
    await mkAsset('aa-gate-2');
    await appendRecallJsonlRecord(UID, 'ability-asset-versions', 'aa-gate-2', versionRecord('aa-gate-2', '2', '活资产的正常追加。') as never);
    expect(fs.existsSync(versionsFile('aa-gate-2'))).toBe(true);
    expect((await assets.listAbilityAssetVersions(UID, 'aa-gate-2')).map((v) => v.version)).toEqual(['1', '2']);
  });
});
