import { beforeEach, describe, expect, it, vi } from 'vitest';

const proactive = vi.hoisted(() => ({
  listTargets: vi.fn(),
  sendToSelf: vi.fn(),
}));

vi.mock('../../../../src/main/features/messaging/proactive', () => proactive);

beforeEach(() => {
  proactive.listTargets.mockReset();
  proactive.sendToSelf.mockReset();
});

describe('CogSeed messaging host adapter', () => {
  it('lists targets and forwards one idempotent proactive send through the shared messaging feature', async () => {
    proactive.listTargets.mockResolvedValue([{ instance_id: 'instance-1', target: 'self' }]);
    proactive.sendToSelf.mockResolvedValue({ status: 'sent', delivery_id: 'delivery-1' });
    const { runMessagingHostTool } = await import('../../../../src/main/features/cogseed_backend/messaging-host-adapter');

    await expect(runMessagingHostTool('messaging_list_targets', {}, {
      userId: 'messaging-host-user',
      sourceKey: 'source-list',
    })).resolves.toEqual({
      content: JSON.stringify([{ instance_id: 'instance-1', target: 'self' }]),
    });
    await expect(runMessagingHostTool('messaging_send', {
      instance_id: 'instance-1',
      target: 'self',
      text: 'Projected final answer',
    }, {
      userId: 'messaging-host-user',
      sourceKey: 'source-send',
    })).resolves.toEqual({
      content: JSON.stringify({ status: 'sent', delivery_id: 'delivery-1' }),
    });
    expect(proactive.sendToSelf).toHaveBeenCalledWith(
      'messaging-host-user',
      { instance_id: 'instance-1', target: 'self', text: 'Projected final answer' },
      { cid: 'source-send', sourceKey: 'source-send', signal: null },
    );
  });

  it('rejects non-self targets before invoking messaging delivery', async () => {
    const { runMessagingHostTool } = await import('../../../../src/main/features/cogseed_backend/messaging-host-adapter');
    const result = await runMessagingHostTool('messaging_send', {
      target: 'another-user',
      text: 'Do not send',
    }, {
      userId: 'messaging-host-user',
      sourceKey: 'source-rejected',
    });
    expect(result.isError).toBe(true);
    expect(proactive.sendToSelf).not.toHaveBeenCalled();
  });
});
