import { describe, expect, it, vi } from 'vitest';
import { runAgentSmokeTest } from '../../../../src/main/features/group_chat/agent-smoke-run';

const agent = { name: '报销助手', workflow: '读取 material，说明处理步骤。' };

describe('runAgentSmokeTest', () => {
  it('passes when the tool-free model returns bounded text', async () => {
    const chat = vi.fn(async () => ({ ok: true, aborted: false, text: '我会先读取材料。', error: '' }));
    const result = await runAgentSmokeTest('u1', agent, { chat, id: () => 'smoke-1' });
    expect(result).toMatchObject({ runId: 'smoke-1', status: 'passed' });
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      disableTools: true,
      ephemeralSession: true,
      skillList: [],
      idleTimeout: 60,
      streamIdleTimeout: 60,
      message: expect.stringContaining('冒烟测试'),
    }));
  });

  it('fails when the model errors or aborts', async () => {
    await expect(runAgentSmokeTest('u1', agent, {
      chat: async () => { throw new Error('boom'); },
    })).resolves.toMatchObject({ status: 'failed' });
    await expect(runAgentSmokeTest('u1', agent, {
      chat: async () => ({ ok: false, aborted: true, text: '', error: 'aborted' }),
    })).resolves.toMatchObject({ status: 'failed' });
  });

  it('fails on empty or overlong text and removes the temporary directory', async () => {
    const removeTempDir = vi.fn(async () => undefined);
    const makeTempDir = vi.fn(async () => '/tmp/smoke-test');
    const empty = await runAgentSmokeTest('u1', agent, {
      makeTempDir, removeTempDir,
      chat: async () => ({ ok: true, aborted: false, text: '   ', error: '' }),
    });
    expect(empty.status).toBe('failed');
    expect(removeTempDir).toHaveBeenCalledWith('/tmp/smoke-test');

    const overlong = await runAgentSmokeTest('u1', agent, {
      chat: async () => ({ ok: true, aborted: false, text: 'x'.repeat(12_001), error: '' }),
    });
    expect(overlong.status).toBe('failed');
  });
});
