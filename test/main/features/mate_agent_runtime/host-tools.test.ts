import { describe, expect, it } from 'vitest';

import { createRuntimeHostToolClient } from '../../../../src/main/features/mate_agent_runtime/kernel/tools/host-tools';

describe('Runtime host tool client', () => {
  it('correlates host results and rejects an aborted call', async () => {
    const sent: any[] = [];
    const client = createRuntimeHostToolClient((message) => sent.push(message));
    const call = client.call({
      requestId: 'req-host-A',
      runtimeSessionId: 'mruntime-host-A',
      name: 'office_read',
      input: { path: '/tmp/a.docx' },
    });
    expect(sent[0]).toMatchObject({ type: 'host_tool_call', request_id: 'req-host-A', name: 'office_read' });
    expect(client.resolve({
      type: 'host_tool_result', request_id: 'req-host-A', runtime_session_id: 'mruntime-host-A',
      call_id: sent[0].call_id, content: 'ok',
    })).toBe(true);
    await expect(call).resolves.toEqual({ content: 'ok', isError: false });

    const controller = new AbortController();
    const aborted = client.call({
      requestId: 'req-host-B', runtimeSessionId: 'mruntime-host-B', name: 'browser_snapshot', input: {}, signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/i);
  });
});
