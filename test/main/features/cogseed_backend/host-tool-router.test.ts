import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRuntimeToolRunner } from '../../../../src/main/features/cogseed_runtime/kernel/tools/runner';
import { deriveRuntimeToolPolicy } from '../../../../src/main/features/cogseed_backend/runtime-tool-policy';
import { createRuntimeActionApprovalClient } from '../../../../src/main/features/cogseed_runtime/kernel/tools/action-approval';

import { createCogSeedHostToolRouter } from '../../../../src/main/features/cogseed_backend/host-tool-router';
import * as paths from '../../../../src/main/paths';
import {
  _resetActionApprovalForTest,
  _setActionApprovalBroadcastForTest,
  respondActionApproval,
} from '../../../../src/main/features/action_approval';

const { publishRuntimeOutputs, resolveRuntimeCapabilities, runMessagingHostTool, shouldAutoApproveRuntimeAction, isA2AReceptionRequest, cogseedControlService, readTask, readSession, runDesktopConnectorTool } = vi.hoisted(() => ({
  publishRuntimeOutputs: vi.fn(),
  resolveRuntimeCapabilities: vi.fn(),
  runMessagingHostTool: vi.fn(),
  shouldAutoApproveRuntimeAction: vi.fn(),
  isA2AReceptionRequest: vi.fn(),
  readTask: vi.fn(),
  readSession: vi.fn(),
  runDesktopConnectorTool: vi.fn(),
  cogseedControlService: {
    retryStep: vi.fn(),
    skipStep: vi.fn(),
    resume: vi.fn(),
    workflow: vi.fn(),
  },
}));

vi.mock('../../../../src/main/features/cogseed_backend/task-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/cogseed_backend/task-store')>(),
  readCogSeedTaskByRequestId: readTask,
}));
vi.mock('../../../../src/main/features/cogseed_backend/session-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/cogseed_backend/session-store')>(),
  readCogSeedSession: readSession,
}));
vi.mock('../../../../src/main/features/cogseed_backend/desktop-connectors', () => ({ runDesktopConnectorTool }));

vi.mock('../../../../src/main/features/cogseed_backend/messaging-capability-policy', () => ({
  resolveRuntimeCapabilities,
}));
vi.mock('../../../../src/main/features/cogseed_backend/messaging-host-adapter', () => ({
  runMessagingHostTool,
}));
vi.mock('../../../../src/main/features/cogseed_backend/runtime-tool-policy', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/cogseed_backend/runtime-tool-policy')>(),
  shouldAutoApproveRuntimeAction,
  isA2AReceptionRequest,
}));
vi.mock('../../../../src/main/features/cogseed_backend/cogseed-control-service', () => ({
  cogseedControlService,
}));
vi.mock('../../../../src/main/features/cogseed_backend/publish-runtime-outputs', () => ({
  runPublishRuntimeOutputs: publishRuntimeOutputs,
}));

const context: any = { request: { user_id: 'router-user', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', read_only_roots: ['/tmp'], writable_roots: ['/tmp'], working_dir: '/tmp' }, signal: new AbortController().signal };

beforeEach(() => {
  publishRuntimeOutputs.mockReset();
  publishRuntimeOutputs.mockResolvedValue({ content: '{"published":4}' });
  resolveRuntimeCapabilities.mockReset();
  runMessagingHostTool.mockReset();
  shouldAutoApproveRuntimeAction.mockReset();
  // Default: the persisted conversation mode requires the human gate.
  shouldAutoApproveRuntimeAction.mockResolvedValue(false);
  readTask.mockReset().mockResolvedValue({ taskId: 'task-parent', sessionId: 'cogseed-session-parent',
    runtimeSessionId: 'mruntime-parent', task: 'Use the host tools' });
  readSession.mockReset().mockResolvedValue({ ownerId: 'router-user', lifecycleState: 'active',
    runtimeSessionId: 'mruntime-parent', activeTaskId: 'task-parent' });
  runDesktopConnectorTool.mockReset();
  isA2AReceptionRequest.mockReset().mockResolvedValue(false);
  for (const fn of Object.values(cogseedControlService)) fn.mockReset();
});

afterEach(() => {
  _resetActionApprovalForTest();
  fs.rmSync(paths.userRoot('router-user'), { recursive: true, force: true });
});

describe('CogSeed host tool router', () => {
  it.each([
    '/private/reception  workspace/with   spaces',
    `/private/${'long-directory/'.repeat(90)}exact-cwd-suffix`,
  ])('scope fidelity regression: kernel bridge displays the exact working directory %#', async cwd => {
    const router = createCogSeedHostToolRouter();
    const client = createRuntimeActionApprovalClient({
      requestId: context.request.request_id, runtimeSessionId: context.request.runtime_session_id, actor: 'receiver',
      hostToolClient: {
        call: async (call: any) => router.handle({
          type: 'host_tool_call', request_id: call.requestId, runtime_session_id: call.runtimeSessionId,
          call_id: 'scope-fidelity', name: call.name, input: call.input,
        }, context),
      },
    });
    const pushed: any[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload: any) => {
      pushed.push(payload);
      void respondActionApproval(payload.request_id, 'deny');
    });
    const scope = `Run this command once in ${cwd}`;
    expect(await client.request({
      action: 'bash', target: 'pwd', verbatimTarget: true, scope,
      auditTarget: 'Shell command', auditScope: 'One command', risk: 'high',
      reasons: ['a2a_reception_shell'], execution: { command: 'pwd', cwd },
    })).toEqual({ approved: false, code: 'E_ACTION_APPROVAL_DENIED' });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].scope).toBe(scope);
    expect(pushed[0].scope).toContain(cwd);
    expect(fs.readFileSync(paths.actionApprovalAuditFile('router-user'), 'utf8')).not.toContain(cwd);
  });

  function shellRunner(afterPreflight?: () => void) {
    const root = path.join(paths.userRoot('router-user'), 'local', 'shell-test');
    fs.mkdirSync(root, { recursive: true });
    const router = createCogSeedHostToolRouter();
    const tools = createRuntimeToolRunner({
      userId: 'router-user', requestId: 'req-parent', runtimeSessionId: 'mruntime-parent',
      allowedRoots: [root], writableRoots: [root], toolPolicy: deriveRuntimeToolPolicy('full', root),
      hostToolClient: {
        call: async (call: any) => {
          const result = await router.handle({
            type: 'host_tool_call', request_id: call.requestId, runtime_session_id: call.runtimeSessionId,
            call_id: 'shell-host-call', name: call.name, input: call.input,
          }, { ...context, signal: call.signal, request: { ...context.request, read_only_roots: [root], writable_roots: [root], working_dir: root } });
          if (call.name === 'ontology_operation_preflight') afterPreflight?.();
          return result;
        },
      } as any,
    });
    return { tools, root };
  }

  it.each(['success', 'failure', 'cancel'] as const)('quality regression: worker records the actual low-risk reception outcome %s after host preflight', async outcome => {
    isA2AReceptionRequest.mockResolvedValue(true);
    const controller = new AbortController();
    const { tools, root } = shellRunner(() => {
      const records = fs.readFileSync(paths.actionApprovalAuditFile('router-user'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records.map(record => record.event)).toEqual(['requested', 'approved']);
      if (outcome === 'cancel') controller.abort();
    });
    fs.mkdirSync(path.join(root, 'already-exists'));
    const pushed: any[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload: any) => {
      pushed.push(payload);
      void respondActionApproval(payload.request_id, 'approve');
    });
    const result = await tools.run('bash', {
      command: outcome === 'failure' ? 'mkdir already-exists' : 'mkdir private-worker-marker',
    }, { signal: controller.signal });
    expect(Boolean(result.isError)).toBe(outcome !== 'success');
    expect(pushed).toHaveLength(1);
    const audit = fs.readFileSync(paths.actionApprovalAuditFile('router-user'), 'utf8');
    const records = audit.trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.event)).toEqual([
      'requested', 'approved', 'execution_started', outcome === 'success' ? 'execution_succeeded' : 'execution_failed',
    ]);
    expect(audit).not.toContain('private-worker-marker');
    expect(audit).not.toContain(root);
    expect(fs.existsSync(path.join(root, 'private-worker-marker'))).toBe(outcome === 'success');
  });

  it.each(['deny', 'approve'])('Runtime reception low-risk shell requires receiver %s for every call', async decision => {
    isA2AReceptionRequest.mockResolvedValue(true);
    const { tools, root } = shellRunner();
    const pushed: any[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload: any) => {
      pushed.push(payload);
      expect(fs.existsSync(path.join(root, `marker-${pushed.length}`))).toBe(false);
      void respondActionApproval(payload.request_id, decision as 'deny' | 'approve');
    });
    for (let i = 1; i <= 2; i++) {
      const result = await tools.run('bash', { command: `mkdir marker-${i}` });
      expect(pushed).toHaveLength(i);
      expect(result.isError).toBe(decision === 'deny' ? true : undefined);
      if (decision === 'deny') expect(result.content).toContain('E_ACTION_APPROVAL_DENIED');
      expect(fs.existsSync(path.join(root, `marker-${i}`))).toBe(decision === 'approve');
    }
    expect(pushed[0]).toMatchObject({ action: 'bash', target: 'mkdir marker-1', reasons: ['a2a_reception_shell'] });
    expect(pushed[0].scope).toContain(root);
  });

  it('Runtime reception high-risk shell prompts only once through the existing approval client', async () => {
    isA2AReceptionRequest.mockResolvedValue(true);
    const { tools, root } = shellRunner();
    fs.mkdirSync(path.join(root, 'remove-me'));
    const pushed: any[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload: any) => {
      pushed.push(payload);
      void respondActionApproval(payload.request_id, 'approve');
    });
    const result = await tools.run('bash', { command: 'rmdir remove-me' });
    expect(result.isError).toBeFalsy();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].reasons).toContain('destructive');
    expect(fs.existsSync(path.join(root, 'remove-me'))).toBe(false);
  });

  it('Runtime ordinary low-risk shell keeps direct execution', async () => {
    const { tools, root } = shellRunner();
    const pushed = vi.fn();
    _setActionApprovalBroadcastForTest(pushed);
    expect((await tools.run('bash', { command: 'mkdir local-own' })).isError).toBeFalsy();
    expect(fs.existsSync(path.join(root, 'local-own'))).toBe(true);
    expect(pushed).not.toHaveBeenCalled();
  });

  it('Runtime reception low-risk shell fails closed when approval or reception lookup is unavailable', async () => {
    isA2AReceptionRequest.mockResolvedValue(true);
    const { tools, root } = shellRunner();
    _setActionApprovalBroadcastForTest(() => false);
    const unavailable = await tools.run('bash', { command: 'mkdir unavailable' });
    expect(unavailable).toMatchObject({ isError: true, content: expect.stringContaining('E_ACTION_APPROVAL_UNAVAILABLE') });
    isA2AReceptionRequest.mockRejectedValueOnce(new Error('private lookup failure'));
    expect((await tools.run('bash', { command: 'mkdir lookup-error' })).isError).toBe(true);
    expect(fs.existsSync(path.join(root, 'unavailable'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'lookup-error'))).toBe(false);
  });

  it('rechecks the persisted task scope at final desktop connector dispatch', async () => {
    const execute = vi.fn();
    runDesktopConnectorTool.mockImplementation(async (_user, _name, _input, _request, _signal, beforeDispatch) => {
      readSession.mockResolvedValueOnce({ ownerId: 'router-user', lifecycleState: 'active',
        runtimeSessionId: 'mruntime-parent', activeTaskId: 'other-task' });
      await beforeDispatch();
      execute();
      return { content: 'sent' };
    });
    const router = createCogSeedHostToolRouter({});
    const result = await router.handle({ type: 'host_tool_call', request_id: 'req-parent',
      runtime_session_id: 'mruntime-parent', call_id: 'host-connector', name: 'desktop_connector_call_tool',
      input: { connector_id: 'tencent-survey', tool_name: 'get_survey', arguments: {} } }, context);
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('current task scope unavailable') });
    expect(execute).not.toHaveBeenCalled();
    expect(readTask).toHaveBeenCalledWith('router-user', 'req-parent');
  });

  it('routes allowlisted capabilities with request scope and caps results', async () => {
    resolveRuntimeCapabilities.mockResolvedValue(['cogseed.coordination']);
    const office = { run: vi.fn(async () => ({ content: 'office-result' })) };
    const browser = { run: vi.fn(async () => ({ content: 'browser-result' })) };
    const coordinator = { delegate: vi.fn(async () => ({ taskId: 'cogseed-task-child', status: 'running' })), tasks: vi.fn(), cancel: vi.fn() };
    const router = createCogSeedHostToolRouter({ office, browser, coordinator: coordinator as any });
    await expect(router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-1', name: 'office_read', input: { path: '/tmp/a.docx' } }, context)).resolves.toEqual({ content: 'office-result' });
    await expect(router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-2', name: 'browser_snapshot', input: {} }, context)).resolves.toEqual({ content: 'browser-result' });
    expect(office.run).toHaveBeenCalledWith('office_read', { path: '/tmp/a.docx' }, expect.objectContaining({ userId: 'router-user', runtimeSessionId: 'mruntime-parent' }), expect.anything());
    const child = await router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-3', name: 'cogseed_delegate', input: { task: 'child' } }, context);
    expect(child.content).toContain('cogseed-task-child'); expect(coordinator.delegate).toHaveBeenCalledWith('router-user', 'req-parent', expect.objectContaining({ requestId: expect.stringMatching(/^req-/), task: 'child' }));
  });

  it('denies unknown host calls and caps oversized output', async () => {
    const office = { run: vi.fn(async () => ({ content: 'x'.repeat(30_000) })) };
    const router = createCogSeedHostToolRouter({ office: office as any });
    const result = await router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-1', name: 'office_read', input: {} }, context);
    expect(result.content.length).toBeLessThan(25_000);
    const denied = await router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-1', name: 'not-allowed' as any, input: {} }, context);
    expect(denied).toMatchObject({ isError: true, content: expect.stringContaining('E_RUNTIME_HOST_TOOL_UNKNOWN') });
    const prefixSpoof = await router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-2', name: 'office_delete' as any, input: {} }, context);
    expect(prefixSpoof).toMatchObject({ isError: true, content: expect.stringContaining('E_RUNTIME_HOST_TOOL_UNKNOWN') });
    expect(office.run).not.toHaveBeenCalledWith('office_delete', expect.anything(), expect.anything(), expect.anything());
  });

  it('denies messaging host tools when no Commander capability is derived', async () => {
    resolveRuntimeCapabilities.mockResolvedValue([]);
    const router = createCogSeedHostToolRouter({});
    const denied = await router.handle({
      type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-m1',
      name: 'messaging_send', input: { target: 'self', text: 'hi' },
    }, context);
    expect(denied).toMatchObject({ isError: true, content: expect.stringContaining('E_RUNTIME_HOST_TOOL_FORBIDDEN') });
    expect(runMessagingHostTool).not.toHaveBeenCalled();
    expect(resolveRuntimeCapabilities).toHaveBeenCalledWith('router-user', 'req-parent', 'mruntime-parent');
  });

  it('routes messaging host tools only for a derived Commander capability', async () => {
    resolveRuntimeCapabilities.mockResolvedValue(['messaging.proactive']);
    runMessagingHostTool.mockResolvedValue({ content: JSON.stringify({ status: 'sent', instance_id: 'bot-1' }) });
    const router = createCogSeedHostToolRouter({});
    const result = await router.handle({
      type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-m2',
      name: 'messaging_send', input: { target: 'self', text: 'hello' },
    }, context);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('"status":"sent"');
    expect(runMessagingHostTool).toHaveBeenCalledWith('messaging_send', { target: 'self', text: 'hello' }, expect.objectContaining({
      userId: 'router-user',
      sourceKey: 'req-parent:host-m2',
    }));
  });

  it('bridges a Worker approval request to the main-owned action gate and records the outcome', async () => {
    const pushed: any[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload) => pushed.push(payload));
    const router = createCogSeedHostToolRouter({});
    const waiting = router.handle({
      type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-a1',
      name: 'action_approval_request',
      input: {
        actor: 'writer', action: 'run_skill', target: 'writer / create', scope: 'run one script',
        audit_target: 'Skill script: writer/create', audit_scope: 'argument count: 0', risk: 'high',
        reasons: ['local_skill_execution'], fingerprint: 'b'.repeat(64),
      },
    }, context);
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    await respondActionApproval(pushed[0].request_id, 'approve');
    const approval = await waiting;
    const requestId = JSON.parse(approval.content).request_id;
    expect(approval.isError).toBeFalsy();

    await expect(router.handle({
      type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-a2',
      name: 'action_approval_execution', input: { approval_request_id: requestId, phase: 'started' },
    }, context)).resolves.toEqual({ content: JSON.stringify({ ok: true }) });
    await expect(router.handle({
      type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-a3',
      name: 'action_approval_execution', input: { approval_request_id: requestId, phase: 'succeeded' },
    }, context)).resolves.toEqual({ content: JSON.stringify({ ok: true }) });
  });

  it('auto-approves a sensitive action when the persisted conversation mode allows it', async () => {
    const pushed: any[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload) => {
      pushed.push(payload);
      return true;
    });
    shouldAutoApproveRuntimeAction.mockResolvedValue(true);
    const router = createCogSeedHostToolRouter({});
    const approval = await router.handle({
      type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-auto-1',
      name: 'action_approval_request',
      input: {
        actor: 'writer', action: 'bash', target: 'rm -rf build', scope: 'clean the workspace',
        audit_target: 'Sensitive shell command', audit_scope: 'risk categories: destructive', risk: 'critical',
        reasons: ['destructive'], fingerprint: 'c'.repeat(64),
      },
    }, context);

    expect(approval.isError).toBeFalsy();
    // No human prompt was broadcast.
    expect(pushed).toHaveLength(0);
    expect(shouldAutoApproveRuntimeAction).toHaveBeenCalledWith('router-user', 'req-parent', 'mruntime-parent');

    // The auto grant is still consumable by the execution audit bridge.
    const requestId = JSON.parse(approval.content).request_id;
    await expect(router.handle({
      type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-auto-2',
      name: 'action_approval_execution', input: { approval_request_id: requestId, phase: 'started' },
    }, context)).resolves.toEqual({ content: JSON.stringify({ ok: true }) });
  });

  it('refuses the workflow tools unless the host derives the workflow capability', async () => {
    resolveRuntimeCapabilities.mockResolvedValue([]);
    const router = createCogSeedHostToolRouter({});
    const denied = await router.handle({
      type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-w1',
      name: 'cogseed_workflow', input: {},
    }, context);
    expect(denied).toMatchObject({ isError: true, content: expect.stringContaining('E_RUNTIME_HOST_TOOL_FORBIDDEN') });
    expect(cogseedControlService.workflow).not.toHaveBeenCalled();

    resolveRuntimeCapabilities.mockResolvedValue(['cogseed.workflow']);
    cogseedControlService.workflow.mockResolvedValue({ runId: 'wrun-1', status: 'running' });
    const allowed = await router.handle({
      type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-w2',
      name: 'cogseed_workflow', input: {},
    }, context);
    expect(allowed.isError).toBeFalsy();
    expect(allowed.content).toContain('wrun-1');
    expect(cogseedControlService.workflow).toHaveBeenCalledWith('router-user', 'req-parent');
  });

  it('routes ontology host tools with the request scope and keeps projection inside the Runtime roots', async () => {
    const router = createCogSeedHostToolRouter();
    const read = await router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-o1', name: 'ontology_graph_read', input: {} }, context);
    expect(read.isError).toBeFalsy();
    expect(JSON.parse(read.content)).toMatchObject({ total: 0, entities: [] });
    const escaped = await router.handle({ type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent', call_id: 'host-call-o2', name: 'ontology_projection_apply', input: { record_path: '/etc/meeting.json' } }, context);
    expect(escaped).toEqual({ content: expect.stringMatching(/^\[E_PATH_OUT_OF_SCOPE\]/), isError: true });
  });

  it('routes publish_outputs with the persisted request scope and writable roots', async () => {
    const router = createCogSeedHostToolRouter({});
    const result = await router.handle({
      type: 'host_tool_call', request_id: 'req-parent', runtime_session_id: 'mruntime-parent',
      call_id: 'host-publish', name: 'publish_outputs', input: { paths: ['/tmp/minutes.md'] },
    }, context);

    expect(result).toEqual({ content: '{"published":4}' });
    expect(publishRuntimeOutputs).toHaveBeenCalledWith({
      userId: 'router-user',
      requestId: 'req-parent',
      runtimeSessionId: 'mruntime-parent',
      workingDir: '/tmp',
      writableRoots: ['/tmp'],
      input: { paths: ['/tmp/minutes.md'] },
    });
  });

});
