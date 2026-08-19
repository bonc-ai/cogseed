/**
 * Multi-robot coexistence invariants for the messaging registry and
 * proactive targets. The 2026-08-10 demo hit "creating multiple robots
 * fails" (root cause: external network fault), so these tests pin the
 * code-level guarantee: every robot owns its identity, credentials,
 * allowlist and lifecycle; deleting or disabling one never touches another.
 *
 * Registry-level tests only (no runtime/network): enabled is a pure data
 * field here, mirroring the pattern in messaging.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-messaging-multi-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('messaging multiple robot coexistence', () => {
  it('keeps two Feishu robots fully independent after QR binding', async () => {
    const registry = await import('../../../src/main/features/messaging/registry');
    const first = await registry.createFeishuDraft('user-1', {
      feishuTenantBrand: 'feishu',
      displayName: 'Course bot',
      policy: { allowUserIds: ['ou_preallowed_1'] },
    });
    const second = await registry.createFeishuDraft('user-1', {
      feishuTenantBrand: 'lark',
      displayName: 'Work bot',
    });
    expect(first.id).not.toBe(second.id);

    await registry.bindFeishuDraft('user-1', first.id, {
      feishuTenantBrand: 'feishu',
      secret: { appId: 'cli_1111111111111111', appSecret: 'secret-first' },
      initialAllowUserId: 'ou_scanner_first',
      ownerExternalUserId: 'ou_scanner_first',
      ownerExternalUserName: 'First Owner',
    });
    await registry.bindFeishuDraft('user-1', second.id, {
      feishuTenantBrand: 'lark',
      secret: { appId: 'cli_2222222222222222', appSecret: 'secret-second' },
      initialAllowUserId: 'ou_scanner_second',
      ownerExternalUserId: 'ou_scanner_second',
      ownerExternalUserName: 'Second Owner',
    });

    const listed = await registry.listInstances('user-1');
    expect(listed).toHaveLength(2);
    const firstClient = listed.find((item) => item.id === first.id);
    const secondClient = listed.find((item) => item.id === second.id);
    expect(firstClient).toMatchObject({
      feishuTenantBrand: 'feishu',
      displayName: 'Course bot',
      ownerConfigured: true,
      ownerLabel: 'First Owner',
      ownerIdentitySource: 'qr',
      hasCredentials: true,
    });
    expect(secondClient).toMatchObject({
      feishuTenantBrand: 'lark',
      ownerConfigured: true,
      ownerLabel: 'Second Owner',
    });

    // Allowlists stay per-robot: neither scanner id leaks into the other policy.
    const firstInternal = await registry.getInstance('user-1', first.id);
    const secondInternal = await registry.getInstance('user-1', second.id);
    expect(firstInternal?.policy.allowUserIds).toEqual(['ou_preallowed_1', 'ou_scanner_first']);
    expect(secondInternal?.policy.allowUserIds).toEqual(['ou_scanner_second']);

    // Credentials resolve independently per robot.
    const firstLoaded = await registry.getInstanceWithSecret('user-1', first.id);
    const secondLoaded = await registry.getInstanceWithSecret('user-1', second.id);
    expect(firstLoaded?.secret.appId).toBe('cli_1111111111111111');
    expect(secondLoaded?.secret.appId).toBe('cli_2222222222222222');
  });

  it('deleting one robot leaves the other intact and still bindable', async () => {
    const registry = await import('../../../src/main/features/messaging/registry');
    const doomed = await registry.createFeishuDraft('user-1', { feishuTenantBrand: 'feishu', displayName: 'A' });
    const survivor = await registry.createFeishuDraft('user-1', { feishuTenantBrand: 'feishu', displayName: 'B' });
    await registry.bindFeishuDraft('user-1', doomed.id, {
      feishuTenantBrand: 'feishu',
      secret: { appId: 'cli_3333333333333333', appSecret: 'doomed-secret' },
      initialAllowUserId: 'ou_doomed_owner',
      ownerExternalUserId: 'ou_doomed_owner',
      ownerExternalUserName: 'Doomed Owner',
    });

    expect(await registry.deleteInstance('user-1', doomed.id)).toBe(true);
    expect(await registry.getInstance('user-1', doomed.id)).toBeNull();
    expect(await registry.getInstance('user-1', survivor.id)).toMatchObject({
      displayName: 'B',
    });

    // The survivor never bound during the other flow: late binding still works.
    const rebound = await registry.bindFeishuDraft('user-1', survivor.id, {
      feishuTenantBrand: 'feishu',
      secret: { appId: 'cli_4444444444444444', appSecret: 'late-secret' },
      initialAllowUserId: 'ou_late_owner',
      ownerExternalUserId: 'ou_late_owner',
    });
    expect(rebound).toMatchObject({ hasCredentials: true, ownerConfigured: true });
  });

  it('wechat single-instance discipline never touches Feishu robots', async () => {
    const registry = await import('../../../src/main/features/messaging/registry');
    const feishu = await registry.createFeishuDraft('user-1', { feishuTenantBrand: 'feishu', displayName: 'F' });
    const wechatOne = await registry.createWechatInstance('user-1', {
      displayName: 'W1',
      ilinkBotToken: 'ilink-token-1234567890abcdef',
      ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
      ilinkBotId: 'bot-w1',
      ownerExternalUserId: 'wx_owner_1',
    });
    const wechatTwo = await registry.createWechatInstance('user-1', {
      displayName: 'W2',
      ilinkBotToken: 'ilink-token-abcdef1234567890',
      ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
      ilinkBotId: 'bot-w2',
      ownerExternalUserId: 'wx_owner_2',
    });
    await registry.updateInstance('user-1', feishu.id, { enabled: true });
    await registry.updateInstance('user-1', wechatOne.id, { enabled: true });
    await registry.updateInstance('user-1', wechatTwo.id, { enabled: true });

    const disabled = await registry.disableOtherWechatPersonalInstances('user-1', wechatTwo.id);
    expect(disabled.sort()).toEqual([wechatOne.id]);

    const after = await registry.listInstances('user-1');
    expect(after.find((item) => item.id === feishu.id)?.enabled).toBe(true);
    expect(after.find((item) => item.id === wechatOne.id)?.enabled).toBe(false);
    expect(after.find((item) => item.id === wechatTwo.id)?.enabled).toBe(true);
  });

  it('reports per-instance proactive diagnostics with multiple robots', async () => {
    const registry = await import('../../../src/main/features/messaging/registry');
    const proactive = await import('../../../src/main/features/messaging/proactive');
    const withOwner = await registry.createFeishuDraft('user-1', { feishuTenantBrand: 'feishu', displayName: 'Owned' });
    const withoutOwner = await registry.createFeishuDraft('user-1', { feishuTenantBrand: 'feishu', displayName: 'Unclaimed' });
    await registry.bindFeishuDraft('user-1', withOwner.id, {
      feishuTenantBrand: 'feishu',
      secret: { appId: 'cli_5555555555555555', appSecret: 'owned-secret' },
      initialAllowUserId: 'ou_owned',
      ownerExternalUserId: 'ou_owned',
      ownerExternalUserName: 'Owned Owner',
    });
    // Data-layer enable only: no runtime starts in this test.
    await registry.updateInstance('user-1', withOwner.id, { enabled: true });
    await registry.updateInstance('user-1', withoutOwner.id, { enabled: true });

    const { targets, available_instance_ids } = await proactive.listTargets('user-1');
    expect(targets).toHaveLength(2);
    const owned = targets.find((target) => target.instance_id === withOwner.id);
    const unclaimed = targets.find((target) => target.instance_id === withoutOwner.id);
    expect(owned?.status).toBe('not_connected'); // enabled + owner, but no live runtime
    expect(unclaimed?.status).toBe('owner_missing');
    expect(available_instance_ids).toEqual([]);

    // An explicit send to the owner-less robot fails with the owner-missing
    // code; the ambiguous multi-robot choice is never silently resolved.
    const result = await proactive.sendToSelf(
      'user-1',
      { instance_id: withoutOwner.id, target: 'self', text: 'hello' },
      { cid: 'c-1', sourceKey: 'test' },
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('E_MESSAGING_OWNER_MISSING');
    }
  });
});
