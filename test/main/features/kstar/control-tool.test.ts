import { afterEach, describe, expect, it, vi } from 'vitest';

const previousFlag = process.env.ORKAS_COMMANDER_CENTRIC_KSTAR;

afterEach(() => {
  if (previousFlag === undefined) delete process.env.ORKAS_COMMANDER_CENTRIC_KSTAR;
  else process.env.ORKAS_COMMANDER_CENTRIC_KSTAR = previousFlag;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('Commander KStar control tool', () => {
  it('is disabled by default during rollout and enabled only by exact 1', async () => {
    delete process.env.ORKAS_COMMANDER_CENTRIC_KSTAR;
    let module = await import('../../../../src/main/features/kstar/control-tool');
    expect(module.isCommanderCentricKstarEnabled()).toBe(false);

    process.env.ORKAS_COMMANDER_CENTRIC_KSTAR = '0';
    expect(module.isCommanderCentricKstarEnabled()).toBe(false);
    process.env.ORKAS_COMMANDER_CENTRIC_KSTAR = '1';
    expect(module.isCommanderCentricKstarEnabled()).toBe(true);
  });

  it('binds host scope and resolved runtime outside model input', async () => {
    process.env.ORKAS_COMMANDER_CENTRIC_KSTAR = '1';
    const module = await import('../../../../src/main/features/kstar/control-tool');
    const executeControl = vi.fn(async () => ({
      ok: true as const,
      status: 'state_committed' as const,
      taskId: 'kst-a',
      requirementId: 'ksreq-a',
    }));
    const postProjectionCard = vi.fn(async () => undefined);
    const tool = module.createKstarControlTool({
      userId: 'user-a',
      conversationId: 'cid-a',
      sourceMessageId: 'msg-a',
      workspaceId: 'project-a',
      resolvedRuntime: () => ({
        providerId: 'anthropic',
        modelId: 'claude-test',
        profileId: 'profile-a',
        entryId: 'entry-a',
        toolNames: ['read_file', 'kstar_control'],
      }),
      postProjectionCard,
      executeControl,
    });

    const input = {
      operation: 'upsert_state',
      idempotencyKey: 'turn-a:create',
      userId: 'spoofed-user',
      conversationId: 'spoofed-cid',
      allowedToolNames: ['made_up_tool'],
      task: { operation: 'create', title: 'Task' },
      requirement: { operation: 'create', goalText: 'Goal' },
    };
    const result = await tool.execute(input, {} as never);

    expect(executeControl).toHaveBeenCalledWith({
      userId: 'user-a',
      conversationId: 'cid-a',
      sourceMessageId: 'msg-a',
      workspaceId: 'project-a',
      allowedToolNames: new Set(['read_file', 'kstar_control']),
      model: {
        providerId: 'anthropic',
        modelId: 'claude-test',
        profileId: 'profile-a',
        entryId: 'entry-a',
      },
      postProjectionCard,
    }, input);
    expect(result).toEqual({
      content: JSON.stringify({
        ok: true,
        status: 'state_committed',
        taskId: 'kst-a',
        requirementId: 'ksreq-a',
      }),
    });
    const schema = JSON.stringify(tool.inputSchema);
    expect(schema).not.toContain('userId');
    expect(schema).not.toContain('conversationId');
    expect(schema).not.toContain('allowedToolNames');
    expect(schema).not.toContain('credential');
  });

  it('returns a structured tool error without stack or raw provider data', async () => {
    const module = await import('../../../../src/main/features/kstar/control-tool');
    const tool = module.createKstarControlTool({
      userId: 'user-a',
      conversationId: 'cid-a',
      resolvedRuntime: () => null,
      postProjectionCard: vi.fn(async () => undefined),
      executeControl: vi.fn(async () => ({
        ok: false as const,
        code: 'kstar_control_invalid_input' as const,
        message: 'invalid request',
      })),
    });

    const result = await tool.execute({ operation: 'upsert_state', idempotencyKey: 'bad' }, {} as never);

    expect(result).toEqual({
      content: JSON.stringify({
        ok: false,
        code: 'kstar_control_invalid_input',
        message: 'invalid request',
      }),
      isError: true,
    });
    expect(result.content).not.toContain('stack');
    expect(result.content).not.toContain('api_key');
  });
});
