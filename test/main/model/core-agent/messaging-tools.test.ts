import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool, ToolContext } from '#core-agent';

const proactive = {
  listTargets: vi.fn(),
  sendToSelf: vi.fn(),
};

async function tools() {
  const { createMessagingTools } = await import('../../../../src/main/model/core-agent/messaging-tools');
  return createMessagingTools({ userId: 'user-1', cid: 'cid-1', turnId: 'turn-1' });
}

function ctx(signal?: AbortSignal): ToolContext {
  return { state: {}, ...(signal ? { signal } : {}) };
}

const LIST_RESULT = {
  targets: [
    { instance_id: 'bot-1', display_name: 'Feishu bot', platform: 'feishu_lark', status: 'available', target: 'self', owner_label: '本人' },
  ],
  available_instance_ids: ['bot-1'],
};

const SEND_RESULT = {
  status: 'sent',
  instance_id: 'bot-1',
  owner_label: '本人',
  text_length: 5,
  attempts: 1,
  delivery_id: 'om_1',
};

describe('core-agent messaging tools', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../../../src/main/features/messaging/proactive', () => proactive);
    proactive.listTargets.mockReset();
    proactive.sendToSelf.mockReset();
  });

  afterEach(() => {
    vi.doUnmock('../../../../src/main/features/messaging/proactive');
  });

  it('builds exactly the two messaging tools with closed schemas', async () => {
    const [list, send] = await tools();
    expect(list.name).toBe('messaging_list_targets');
    expect(send.name).toBe('messaging_send');
    expect(list.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(send.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['target', 'text'],
    });
    // The model can only name an instance; no chat/open id/secret fields exist.
    expect(JSON.stringify(send.inputSchema)).not.toMatch(/chat_id|open_id|secret|token/i);
  });

  it('lists targets through the shared proactive service', async () => {
    proactive.listTargets.mockResolvedValue(LIST_RESULT);
    const [list] = await tools();
    const result = await list.execute({}, ctx());
    expect(proactive.listTargets).toHaveBeenCalledWith('user-1');
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toEqual(LIST_RESULT);
  });

  it('sends to self after forwarding signal and a stable per-turn source key', async () => {
    proactive.sendToSelf.mockResolvedValue(SEND_RESULT);
    const [, send] = await tools();
    const controller = new AbortController();
    const result = await send.execute({ target: 'self', text: 'hello' }, ctx(controller.signal));
    const [uid, input, opts] = proactive.sendToSelf.mock.calls[0] as [
      string,
      { instance_id?: string; target: string; text: string },
      { cid: string; sourceKey: string; signal: AbortSignal | null },
    ];
    expect(uid).toBe('user-1');
    expect(input).toEqual({ target: 'self', text: 'hello' });
    expect(opts.cid).toBe('cid-1');
    expect(opts.signal).toBe(controller.signal);
    // Same turn + same payload ⇒ identical source key; a different turn differs.
    expect(opts.sourceKey).toBeTruthy();
    const [, second] = await tools();
    const other = await second.execute({ target: 'self', text: 'hello' }, ctx(controller.signal));
    const otherOpts = proactive.sendToSelf.mock.calls[1]?.[2];
    expect(otherOpts?.sourceKey).toBe(opts.sourceKey);
    const later = await second.execute({ target: 'self', text: 'hello' }, ctx(controller.signal));
    const laterOpts = proactive.sendToSelf.mock.calls[2]?.[2];
    expect(laterOpts?.sourceKey).toBe(opts.sourceKey);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toEqual(SEND_RESULT);
  });

  it('passes the chosen instance id when provided', async () => {
    proactive.sendToSelf.mockResolvedValue(SEND_RESULT);
    const [, send] = await tools();
    await send.execute({ instance_id: 'bot-1', target: 'self', text: 'hello' }, ctx());
    const input = proactive.sendToSelf.mock.calls[0]?.[1];
    expect(input).toMatchObject({ instance_id: 'bot-1', target: 'self', text: 'hello' });
  });

  it('rejects a non-self target without touching the service', async () => {
    const [, send] = await tools();
    const result = await send.execute({ target: 'chat_123', text: 'hello' }, ctx());
    expect(result.isError).toBe(true);
    expect(proactive.sendToSelf).not.toHaveBeenCalled();
  });

  it('maps domain errors to error results and keeps not_sent as an ordinary result', async () => {
    const [, send] = await tools();
    proactive.sendToSelf.mockResolvedValue({ status: 'error', code: 'E_MESSAGING_OWNER_MISSING', message: 'no owner' });
    const failed = await send.execute({ target: 'self', text: 'hello' }, ctx());
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain('E_MESSAGING_OWNER_MISSING');

    proactive.sendToSelf.mockResolvedValue({ status: 'not_sent', reason: 'denied' });
    const declined = await send.execute({ target: 'self', text: 'hello' }, ctx());
    expect(declined.isError).toBeFalsy();
    expect(declined.content).toContain('not_sent');
  });
});
