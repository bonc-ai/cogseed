import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** purge 墓碑清除 validationCount、consecutiveFailures、lastValidatedAt
 * 及 maturity，不能继续替已清除内容声称已验证。终态写入拒绝保持不变。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const UID = 'probe-sm6-pv';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-sm6-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ACT = { actor: 'user' as const, reason: 'probe' };

describe('purge 墓碑清验证三件套', () => {
  it('回归：带验证历史的资产 purge 后墓碑不再带 validationCount/lastValidatedAt（效果声明清空）', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const now = new Date().toISOString();
    const id = 'aa-pv-purge01';
    await seedStoredAbilityAsset(UID, {
      schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
      sourceCandidateIds: [`cand-${id}`], reviewDecisionId: 'rd_probepv00001x',
      type: 'personal', title: '资产 pv', statement: '可验证的陈述。',
      evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
      lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
      createdAt: now, updatedAt: now,
    }, ACT);
    await assets.recordAbilityAssetValidation(UID, id, 'success');
    const validated = await assets.readAbilityAsset(UID, id);
    expect(validated.validationCount).toBe(1);
    expect(validated.lastValidatedAt).toBeTruthy();

    await assets.deleteAbilityAsset(UID, id, ACT);
    await assets.purgeAbilityAsset(UID, id, { actor: 'user', reason: 'probe purge' });

    const tomb = await assets.readAbilityAsset(UID, id);
    expect(tomb.status).toBe('purged');
    expect(tomb.title).toBe(''); // 对照：正文确已清
    expect(tomb.maturity).toBeUndefined(); // 对照：maturity 效果声明确已清
    // 验证三件套与 maturity 同被清，墓碑不替已清除内容背书。
    expect(tomb.validationCount).toBeUndefined();
    expect(tomb.consecutiveFailures).toBeUndefined();
    expect(tomb.lastValidatedAt).toBeUndefined();
    // 终态拒写：任何通道都清不掉它（setStatus 首行 assertNotPurged）。
    await expect(assets.updateAbilityAsset(UID, id, { statement: 'x', reason: 'try', actor: 'user' }))
      .rejects.toThrow(/has been purged/);
  });
});
