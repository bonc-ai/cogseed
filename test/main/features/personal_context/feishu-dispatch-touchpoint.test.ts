import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  proactive: { listTargets: vi.fn() },
  registry: { getInstance: vi.fn() },
  manager: {
    sendProactive: vi.fn(),
    getLiveInstanceStatus: vi.fn(),
  },
}));

vi.mock('../../../../src/main/features/messaging/proactive', () => mocks.proactive);
vi.mock('../../../../src/main/features/messaging/registry', () => mocks.registry);
vi.mock('../../../../src/main/features/messaging/manager', () => mocks.manager);

import { dispatchBriefingTouchpoint } from '../../../../src/main/features/personal_context/feishu-dispatch';
import { readTouchpointLedgerForTest } from '../../../../src/main/features/touchpoints/ledger';

function availableTarget(overrides: Record<string, unknown> = {}) {
  return { instance_id: 'inst_feishu_1', status: 'available', ...overrides };
}

const uid = 'tp-dispatch-7272';

describe('dispatchBriefingTouchpoint', () => {
  beforeEach(() => {
    mocks.proactive.listTargets.mockReset();
    mocks.registry.getInstance.mockReset();
    mocks.manager.sendProactive.mockReset();
    mocks.manager.getLiveInstanceStatus.mockReset();
    mocks.manager.getLiveInstanceStatus.mockResolvedValue({ kind: 'connected', checkedAt: '2026-08-10T13:00:00.000Z' });
    mocks.proactive.listTargets.mockResolvedValue({ targets: [availableTarget()] });
    mocks.registry.getInstance.mockResolvedValue({
      id: 'inst_feishu_1',
      platform: 'feishu_lark',
      enabled: true,
      status: { kind: 'connected' },
      ownerExternalUserId: 'ou_owner',
    });
    mocks.manager.sendProactive.mockResolvedValue({ entry: { externalDeliveryId: 'om_briefing_1', attempts: 1 } });
  });

  it('routes a briefing through the touchpoint pipeline and records a sent intent', async () => {
    const result = await dispatchBriefingTouchpoint(uid, {
      instanceId: 'inst_feishu_1',
      text: '今日安排：10:00 项目会。',
      sourceKey: 'briefing:at_briefing_1:2026-08-10',
    });

    expect(result).toEqual({ ok: true });
    const ledgerState = await readTouchpointLedgerForTest(uid);
    const intents = Object.values(ledgerState.intents);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      template: 'daily_briefing',
      status: 'sent',
      userId: uid,
      contextRef: 'briefing:at_briefing_1:2026-08-10',
    });
    expect(intents[0]?.actionContract?.allowedActions).toEqual(['open', 'snooze', 'adjust']);
    expect(intents[0]?.actionContract?.input?.label).toBeTruthy();
  });

  it('is idempotent for the same sourceKey on the same day', async () => {
    const opts = {
      instanceId: 'inst_feishu_1',
      text: '今日安排：10:00 项目会。',
      sourceKey: 'briefing:at_briefing_1:2026-08-10',
    };
    const first = await dispatchBriefingTouchpoint(uid, opts);
    const second = await dispatchBriefingTouchpoint(uid, opts);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    const ledgerState = await readTouchpointLedgerForTest(uid);
    expect(Object.values(ledgerState.intents)).toHaveLength(1);
  });

  it('rejects unknown instances like the text path', async () => {
    mocks.proactive.listTargets.mockResolvedValue({ targets: [availableTarget({ instance_id: 'other' })] });

    const result = await dispatchBriefingTouchpoint(uid, {
      instanceId: 'inst_feishu_1',
      text: 'x',
      sourceKey: 'briefing:k:2026-08-10',
    });

    expect(result).toMatchObject({ ok: false, code: 'instance_unknown' });
  });

  it('rejects empty text and missing source keys up front', async () => {
    await expect(dispatchBriefingTouchpoint(uid, { instanceId: 'inst_feishu_1', text: '  ', sourceKey: 'k' }))
      .resolves.toMatchObject({ ok: false, code: 'empty_text' });
    await expect(dispatchBriefingTouchpoint(uid, { instanceId: 'inst_feishu_1', text: 'x', sourceKey: ' ' }))
      .resolves.toMatchObject({ ok: false, code: 'missing_source_key' });
  });

  it('reports delivery failure without leaving a phantom intent', async () => {
    mocks.manager.sendProactive.mockRejectedValue(new Error('boom'));
    const failUid = `${uid}-fail`;

    const result = await dispatchBriefingTouchpoint(failUid, {
      instanceId: 'inst_feishu_1',
      text: '今日安排：10:00 项目会。',
      sourceKey: 'briefing:at_briefing_2:2026-08-10',
    });

    expect(result.ok).toBe(false);
    const ledgerState = await readTouchpointLedgerForTest(failUid);
    const intents = Object.values(ledgerState.intents);
    expect(intents).toHaveLength(1);
    expect(['failed', 'retry_pending']).toContain(intents[0]?.status);
  });
});
