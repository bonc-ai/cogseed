import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const manager = {
  listInstances: vi.fn(),
  sendProactive: vi.fn(),
};
const registry = {
  getInstance: vi.fn(),
};
const confirm = {
  requestSendConfirm: vi.fn(),
};

const INSTANCE_BASE = {
  platform: 'feishu_lark' as const,
  feishuTenantBrand: 'feishu' as const,
  displayName: 'Feishu bot',
  enabled: true,
  responseMode: 'text' as const,
  workspace: { type: 'default' as const },
  policy: { replyMode: 'every_message' as const, allowUserIds: [], allowGroupIds: [], requireMentionInGroups: true },
  status: { kind: 'connected' as const, checkedAt: new Date().toISOString() },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  hasCredentials: true,
};

function client(overrides: Record<string, unknown> & { id: string }) {
  return { ...INSTANCE_BASE, ...overrides };
}

describe('messaging proactive target service', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../../src/main/features/messaging/manager', () => manager);
    vi.doMock('../../../src/main/features/messaging/registry', () => registry);
    vi.doMock('../../../src/main/features/messaging/proactive-confirm', () => confirm);
    manager.listInstances.mockReset();
    manager.sendProactive.mockReset();
    registry.getInstance.mockReset();
    confirm.requestSendConfirm.mockReset();
  });

  afterEach(() => {
    vi.doUnmock('../../../src/main/features/messaging/manager');
    vi.doUnmock('../../../src/main/features/messaging/registry');
    vi.doUnmock('../../../src/main/features/messaging/proactive-confirm');
  });

  async function proactive() {
    return import('../../../src/main/features/messaging/proactive');
  }

  it('lists Feishu targets with sanitized status and available instance ids', async () => {
    manager.listInstances.mockResolvedValue([
      client({ id: 'bot-1', ownerConfigured: true, ownerLabel: '本人' }),
      client({ id: 'bot-2', status: { kind: 'disconnected', checkedAt: new Date().toISOString() }, ownerConfigured: true }),
      client({ id: 'bot-3', enabled: false, status: { kind: 'disabled', checkedAt: new Date().toISOString() }, ownerConfigured: true }),
      client({ id: 'bot-4', ownerConfigured: false }),
      client({ id: 'tele-1', platform: 'telegram', displayName: 'Telegram bot' }),
    ]);
    const result = await (await proactive()).listTargets('user-1');
    expect(result.targets).toEqual([
      expect.objectContaining({ instance_id: 'bot-1', status: 'available', target: 'self', owner_label: '本人' }),
      expect.objectContaining({ instance_id: 'bot-2', status: 'not_connected' }),
      expect.objectContaining({ instance_id: 'bot-3', status: 'disabled' }),
      expect.objectContaining({ instance_id: 'bot-4', status: 'owner_missing' }),
    ]);
    expect(result.targets.map((t: { instance_id: string }) => t.instance_id)).not.toContain('tele-1');
    expect(result.available_instance_ids).toEqual(['bot-1']);
  });

  it('reports target unavailable when no bot exists at all', async () => {
    manager.listInstances.mockResolvedValue([]);
    const result = await (await proactive()).sendToSelf('user-1', { target: 'self', text: 'hello' }, { cid: 'cid-1', sourceKey: 'k-1' });
    expect(result).toMatchObject({ status: 'error', code: 'E_MESSAGING_TARGET_UNAVAILABLE' });
    expect(confirm.requestSendConfirm).not.toHaveBeenCalled();
  });

  it('reports owner missing when no configured bot has an owner identity', async () => {
    manager.listInstances.mockResolvedValue([
      client({ id: 'bot-1', status: { kind: 'disconnected', checkedAt: new Date().toISOString() }, ownerConfigured: false }),
    ]);
    const result = await (await proactive()).sendToSelf('user-1', { target: 'self', text: 'hello' }, { cid: 'cid-1', sourceKey: 'k-1' });
    expect(result).toMatchObject({ status: 'error', code: 'E_MESSAGING_OWNER_MISSING' });
  });

  it('requires an explicit instance when several bots are available', async () => {
    manager.listInstances.mockResolvedValue([
      client({ id: 'bot-1', ownerConfigured: true }),
      client({ id: 'bot-2', ownerConfigured: true }),
    ]);
    const result = await (await proactive()).sendToSelf('user-1', { target: 'self', text: 'hello' }, { cid: 'cid-1', sourceKey: 'k-1' });
    expect(result).toMatchObject({
      status: 'error',
      code: 'E_MESSAGING_TARGET_AMBIGUOUS',
      candidates: ['bot-1', 'bot-2'],
    });
    expect(confirm.requestSendConfirm).not.toHaveBeenCalled();
  });

  it('does not confirm or send when the chosen instance lacks an owner identity', async () => {
    manager.listInstances.mockResolvedValue([client({ id: 'bot-1', ownerConfigured: false })]);
    const result = await (await proactive()).sendToSelf('user-1', { instance_id: 'bot-1', target: 'self', text: 'hello' }, { cid: 'cid-1', sourceKey: 'k-1' });
    expect(result).toMatchObject({ status: 'error', code: 'E_MESSAGING_OWNER_MISSING' });
    expect(confirm.requestSendConfirm).not.toHaveBeenCalled();
    expect(manager.sendProactive).not.toHaveBeenCalled();
  });

  it('returns not_sent without sending when the user denies the confirmation', async () => {
    manager.listInstances.mockResolvedValue([client({ id: 'bot-1', ownerConfigured: true, ownerLabel: '本人' })]);
    registry.getInstance.mockResolvedValue({ id: 'bot-1', ownerExternalUserId: 'ou_self_1' });
    confirm.requestSendConfirm.mockResolvedValue('denied');
    const result = await (await proactive()).sendToSelf('user-1', { target: 'self', text: 'hello' }, { cid: 'cid-1', sourceKey: 'k-1' });
    expect(result).toEqual({ status: 'not_sent', reason: 'denied' });
    expect(manager.sendProactive).not.toHaveBeenCalled();
  });

  it('sends to the owner open id after approval and reports the delivery result', async () => {
    manager.listInstances.mockResolvedValue([client({ id: 'bot-1', ownerConfigured: true, ownerLabel: '本人' })]);
    registry.getInstance.mockResolvedValue({ id: 'bot-1', ownerExternalUserId: 'ou_self_1' });
    confirm.requestSendConfirm.mockResolvedValue('approved');
    manager.sendProactive.mockResolvedValue({
      entry: { status: 'sent', attempts: 1, externalDeliveryId: 'om_1' },
    });
    const result = await (await proactive()).sendToSelf('user-1', { target: 'self', text: 'hello' }, { cid: 'cid-1', sourceKey: 'stable-key-1' });
    expect(result).toMatchObject({
      status: 'sent',
      instance_id: 'bot-1',
      owner_label: '本人',
      text_length: 5,
      attempts: 1,
      delivery_id: 'om_1',
    });
    expect(confirm.requestSendConfirm).toHaveBeenCalledWith(expect.objectContaining({
      cid: 'cid-1',
      instanceName: 'Feishu bot',
      ownerLabel: '本人',
      text: 'hello',
    }));
    expect(manager.sendProactive).toHaveBeenCalledWith('user-1', {
      instanceId: 'bot-1',
      recipientId: 'ou_self_1',
      text: 'hello',
      sourceKey: 'stable-key-1',
      signal: null,
    });
  });

  it('maps a failed proactive delivery to a stable error code', async () => {
    manager.listInstances.mockResolvedValue([client({ id: 'bot-1', ownerConfigured: true })]);
    registry.getInstance.mockResolvedValue({ id: 'bot-1', ownerExternalUserId: 'ou_self_1' });
    confirm.requestSendConfirm.mockResolvedValue('approved');
    manager.sendProactive.mockRejectedValue(new Error('delivery failed after retries'));
    const result = await (await proactive()).sendToSelf('user-1', { target: 'self', text: 'hello' }, { cid: 'cid-1', sourceKey: 'k-1' });
    expect(result).toMatchObject({ status: 'error', code: 'E_MESSAGING_DELIVERY_FAILED' });
  });

  it('reports aborted when the turn signal aborts during send', async () => {
    manager.listInstances.mockResolvedValue([client({ id: 'bot-1', ownerConfigured: true })]);
    registry.getInstance.mockResolvedValue({ id: 'bot-1', ownerExternalUserId: 'ou_self_1' });
    confirm.requestSendConfirm.mockResolvedValue('approved');
    manager.sendProactive.mockRejectedValue(Object.assign(new Error('delivery wait aborted'), { name: 'AbortError' }));
    const controller = new AbortController();
    const result = await (await proactive()).sendToSelf(
      'user-1',
      { target: 'self', text: 'hello' },
      { cid: 'cid-1', sourceKey: 'k-1', signal: controller.signal },
    );
    expect(result).toEqual({ status: 'not_sent', reason: 'aborted' });
  });

  it('rejects invalid target, empty and oversized text', async () => {
    const service = await proactive();
    manager.listInstances.mockResolvedValue([client({ id: 'bot-1', ownerConfigured: true })]);
    expect(await service.sendToSelf('user-1', { target: 'chat_123', text: 'hello' }, { cid: 'c', sourceKey: 'k' })).toMatchObject({ status: 'error' });
    expect(await service.sendToSelf('user-1', { target: 'self', text: '   ' }, { cid: 'c', sourceKey: 'k' })).toMatchObject({ status: 'error' });
    expect(await service.sendToSelf('user-1', { target: 'self', text: 'x'.repeat(12_001) }, { cid: 'c', sourceKey: 'k' })).toMatchObject({ status: 'error' });
    expect(confirm.requestSendConfirm).not.toHaveBeenCalled();
  });
});
