import { describe, expect, it, vi } from 'vitest';

import { createMateHostToolRouter } from '../../../../src/main/features/mate_agent_backend/host-tool-router';

const context: any = { request: { user_id: 'router-user', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', read_only_roots: ['/tmp'], writable_roots: ['/tmp'], working_dir: '/tmp' }, signal: new AbortController().signal };

describe('Mate host tool router', () => {
  it('routes allowlisted capabilities with request scope and caps results', async () => {
    const office = { run: vi.fn(async () => ({ content: 'office-result' })) };
    const browser = { run: vi.fn(async () => ({ content: 'browser-result' })) };
    const coordinator = { delegate: vi.fn(async () => ({ taskId: 'mate-task-child', status: 'running' })), tasks: vi.fn(), cancel: vi.fn() };
    const router = createMateHostToolRouter({ office, browser, coordinator: coordinator as any });
    await expect(router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-1', name: 'office_read', input: { path: '/tmp/a.docx' } }, context)).resolves.toEqual({ content: 'office-result' });
    await expect(router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-2', name: 'browser_snapshot', input: {} }, context)).resolves.toEqual({ content: 'browser-result' });
    expect(office.run).toHaveBeenCalledWith('office_read', { path: '/tmp/a.docx' }, expect.objectContaining({ userId: 'router-user', runtimeSessionId: 'mruntime-parent' }), expect.anything());
    const child = await router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-3', name: 'mate_delegate', input: { task: 'child' } }, context);
    expect(child.content).toContain('mate-task-child'); expect(coordinator.delegate).toHaveBeenCalledWith('router-user', 'req-parent', expect.objectContaining({ requestId: expect.stringMatching(/^req-/), task: 'child' }));
  });

  it('denies unknown host calls and caps oversized output', async () => {
    const office = { run: vi.fn(async () => ({ content: 'x'.repeat(30_000) })) };
    const router = createMateHostToolRouter({ office: office as any });
    const result = await router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-1', name: 'office_read', input: {} }, context);
    expect(result.content.length).toBeLessThan(25_000);
    const denied = await router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-1', name: 'not-allowed' as any, input: {} }, context);
    expect(denied).toMatchObject({ isError: true, content: expect.stringContaining('E_RUNTIME_HOST_TOOL_UNKNOWN') });
    const prefixSpoof = await router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-2', name: 'office_delete' as any, input: {} }, context);
    expect(prefixSpoof).toMatchObject({ isError: true, content: expect.stringContaining('E_RUNTIME_HOST_TOOL_UNKNOWN') });
    expect(office.run).not.toHaveBeenCalledWith('office_delete', expect.anything(), expect.anything(), expect.anything());
  });
});
