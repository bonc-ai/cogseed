import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 漏取审计（2026-09-19）：catalog_hint 回执——目录标★相关但该回合未被使用的
// 资产各记一条 omitted/catalog_hint；时间线透出「相关而未被用」行。

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-audit';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-catalog-audit-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('catalog_hint receipts and timeline', () => {
  it('records an omitted/catalog_hint receipt and surfaces it on the asset timeline', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');

    const now = new Date().toISOString();
    const asset = await assets.createAbilityAsset(UID, {
      schemaVersion: 2, ownerId: UID, id: 'aa-audit-1', candidateId: 'cand-audit-1',
      sourceCandidateIds: ['cand-audit-1'], reviewDecisionId: 'rd_audit0000000001',
      type: 'personal', title: '被提示但没用', statement: '一条被标★却没被取的偏好。',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-audit' }], scope: 'general', status: 'active',
      lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
      createdAt: now, updatedAt: now,
    }, { actor: 'user', reason: 'seed' });

    // 模拟回合收尾：★提示了、没人用 → omitted/catalog_hint 回执。
    await receipts.recordInjectionReceipt(UID, {
      assetId: asset.id, assetVersion: '0', taskRunId: 'turn-audit-1',
      messageId: 'msg-audit-1', boundary: 'real', status: 'omitted', channel: 'catalog_hint',
    });
    const listed = await receipts.listInjectionReceipts(UID, 'turn-audit-1');
    expect(listed.filter((receipt) => receipt.channel === 'catalog_hint' && receipt.status === 'omitted')).toHaveLength(1);

    // 时间线出现「相关而未被用」行。
    const timeline = await import('../../../../src/main/features/recall/timeline-service');
    const items = await timeline.listAbilityAssetTimeline(UID, asset.id);
    const row = items.find((item) => item.kind === 'catalog_hint_unused');
    expect(row).toBeDefined();
    expect(row?.summary).toContain('没有被注入或取用');
  });
});
