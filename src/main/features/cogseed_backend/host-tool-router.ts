import { buildBoundedPreview } from '../../util/tool-result-cap';
import { t } from '../../i18n';
import { isRuntimeHostToolName, type RuntimeHostToolCall } from '../cogseed_runtime/protocol';
import type { RuntimeHostToolHandlerContext } from '../cogseed_runtime/worker-process';
import { cogseedOfficeAdapter, type CogSeedHostToolResult, type CogSeedHostToolScope } from './office-adapter';
import { cogseedBrowserAdapter } from './browser-adapter';
import { createCogSeedCoordinator, type CogSeedCoordinator } from './coordinator';
import { cogseedControlService } from './cogseed-control-service';
import { resolveRuntimeCapabilities } from './messaging-capability-policy';
import { grantAutoActionApproval, recordActionApprovalExecution, requestActionApproval } from '../action_approval';
import { isA2AReceptionRequest, shouldAutoApproveRuntimeAction } from './runtime-tool-policy';
import { classifyBashCommand } from '../../util/bash-risk';
import { isTranscriptToolName } from '../transcript-tool-contract';

interface HostAdapter { run(name: any, input: Record<string, unknown>, scope: CogSeedHostToolScope, opts?: { signal?: AbortSignal | null; beforeAction?: () => Promise<void> }): Promise<CogSeedHostToolResult> }
export interface CogSeedHostToolRouterDeps { office?: HostAdapter; browser?: HostAdapter; coordinator?: CogSeedCoordinator }

export function createCogSeedHostToolRouter(deps: CogSeedHostToolRouterDeps = {}) {
  const office = deps.office ?? cogseedOfficeAdapter;
  const browser = deps.browser ?? cogseedBrowserAdapter;
  const coordinator = deps.coordinator ?? createCogSeedCoordinator({
    startTask: async (userId, input) => (await import('./runtime-controller')).cogseedRuntimeController.startCogSeedTask(userId, input),
    cancelTask: async (userId, taskId) => (await import('./runtime-controller')).cogseedRuntimeController.cancelCogSeedTask(userId, taskId),
  });

  function cap(result: CogSeedHostToolResult): CogSeedHostToolResult {
    if (result.content.length <= 24_000) return result;
    return { ...result, content: `${buildBoundedPreview(result.content, 5_500)}\n[host tool result truncated]` };
  }

  return {
    async handle(call: RuntimeHostToolCall, context: RuntimeHostToolHandlerContext): Promise<CogSeedHostToolResult> {
      const request = context.request;
      if (call.request_id !== request.request_id || call.runtime_session_id !== request.runtime_session_id) {
        return { content: '[E_RUNTIME_HOST_TOOL_SCOPE] host tool request scope mismatch', isError: true };
      }
      if (!isRuntimeHostToolName(String(call.name))) {
        return { content: `[E_RUNTIME_HOST_TOOL_UNKNOWN] unknown CogSeed host tool: ${String(call.name)}`, isError: true };
      }
      const scope: CogSeedHostToolScope = {
        userId: request.user_id, requestId: request.request_id, runtimeSessionId: request.runtime_session_id,
        readOnlyRoots: request.read_only_roots ?? [], writableRoots: request.writable_roots ?? [],
        ...(request.working_dir ? { workingDir: request.working_dir } : {}),
      };
      const ontologyPreflight = async (toolName: string, input: Record<string, unknown>, finalPayload = false): Promise<CogSeedHostToolResult | undefined> => {
        const { readCogSeedTaskByRequestId } = await import('./task-store');
        const { readCogSeedSession } = await import('./session-store');
        const task = await readCogSeedTaskByRequestId(request.user_id, request.request_id);
        const session = task ? await readCogSeedSession(request.user_id, task.sessionId) : undefined;
        if (!task || task.runtimeSessionId !== request.runtime_session_id || !session || session.ownerId !== request.user_id
          || session.lifecycleState !== 'active' || session.runtimeSessionId !== request.runtime_session_id || session.activeTaskId !== task.taskId)
          return { content: '[E_ONTOLOGY_OPERATION_PRECONDITION_UNAVAILABLE] current task scope unavailable', isError: true };
        const { getConversation } = await import('../chats');
        const conversation = task.conversationId ? await getConversation(request.user_id, task.conversationId) : undefined;
        if (task.conversationId && !conversation) return { content: '[E_ONTOLOGY_OPERATION_PRECONDITION_UNAVAILABLE] current conversation scope unavailable', isError: true };
        const taskContext = { ...(task.agentId ? { agentId: task.agentId } : {}), taskText: task.task,
          ...(conversation?.project_id ? { projectId: conversation.project_id } : {}),
          ...(conversation?.space_id || task.spaceId ? { workspaceId: conversation?.space_id || task.spaceId } : {}) };
        const { ontologyActionCapability } = await import('../cognition/ontology/ontology-action-capabilities');
        const capability = ontologyActionCapability(toolName, input, { finalMarkdownAdapter: finalPayload });
        const guard = await import('../cognition/ontology/operation-guard');
        const decision = capability.coverage === 'read_only' ? undefined
          : capability.coverage === 'final_markdown_adapter' && typeof input.path === 'string' && typeof input.content === 'string'
            ? await guard.checkOntologyMarkdownWrite(request.user_id, { operation: toolName as 'write_file' | 'edit_file', path: input.path, content: input.content, context: taskContext })
            : await guard.checkOntologyUnverifiedAction(request.user_id, { operationKinds: capability.operationKinds, context: taskContext });
        if (context.signal?.aborted) return { content: '[E_ONTOLOGY_OPERATION_PRECONDITION_UNAVAILABLE] action cancelled', isError: true };
        return decision && !decision.allowed ? { content: JSON.stringify({ code: decision.code, checks: decision.checks,
          ...(decision.checks.some(check => check.reasonCode === 'operation_adapter_missing')
            ? { message: t('ontology.operation.adapter_missing') } : {}) }), isError: true } : undefined;
      };
      // This bridge is internal, absent from the model's tool catalog. Owner,
      // project and current request are re-derived from persisted host records.
      if (call.name === 'ontology_operation_preflight') {
        const toolName = typeof call.input.tool_name === 'string' ? call.input.tool_name : '';
        if (!toolName || !call.input.arguments || typeof call.input.arguments !== 'object' || Array.isArray(call.input.arguments))
          return { content: '[E_ONTOLOGY_OPERATION_PRECONDITION_UNAVAILABLE] invalid action payload', isError: true };
        try {
          const arguments_ = call.input.arguments as Record<string, unknown>;
          const denied = await ontologyPreflight(toolName, arguments_, true);
          if (denied) return denied;
          // 接访会话的写：逐次由接收方本人批准（设计 §3.6 L3）。运行时内核的写工具
          // 没有审批客户端，这一层是它唯一的闸门；普通会话的写路径完全不变。
          if (toolName === 'write_file' || toolName === 'edit_file') {
            const { requestReceptionWriteApproval } = await import('../a2a/reception-approval');
            const refusal = await requestReceptionWriteApproval({
              userId: request.user_id,
              requestId: request.request_id,
              runtimeSessionId: request.runtime_session_id,
              toolName,
              path: String(arguments_.path ?? ''),
              content: String(arguments_.content ?? ''),
              ...(request.working_dir ? { workingDir: request.working_dir } : {}),
            });
            if (refusal) {
              return { content: `[${refusal}] 这次写操作没有得到接收方批准，未执行`, isError: true };
            }
          }
          // Risky shell commands already use the kernel's action-approval client.
          // Its low-risk fast path still needs a per-action receiver decision.
          if (toolName === 'bash' && !classifyBashCommand(String(arguments_.command ?? '').trim()).risky
            && await isA2AReceptionRequest(request.user_id, request.request_id, request.runtime_session_id)) {
            const { requestReceptionShellApproval } = await import('../a2a/reception-approval');
            const decision = await requestReceptionShellApproval({
              userId: request.user_id,
              requestId: request.request_id,
              runtimeSessionId: request.runtime_session_id,
              toolName: 'bash',
              command: String(arguments_.command ?? ''),
              workingDir: String(arguments_.working_dir ?? request.working_dir ?? ''),
              signal: context.signal,
            });
            if (!decision || typeof decision === 'string') return { content: `[${decision || 'E_ACTION_APPROVAL_UNAVAILABLE'}] Receiver approval was not granted. Do not retry or work around this decision.`, isError: true };
            return { content: JSON.stringify({ allowed: true, approval_request_id: decision.requestId }) };
          }
          return { content: JSON.stringify({ allowed: true }) };
        } catch { return { content: '[E_ONTOLOGY_OPERATION_PRECONDITION_UNAVAILABLE] current required conditions unavailable', isError: true }; }
      }
      if (isTranscriptToolName(call.name)) {
        const { runTranscriptHostTool } = await import('./transcript-host-adapter');
        // Keep full text until the normal Runtime cap can spill it; the generic
        // host preview truncator would permanently discard the corrected text.
        return runTranscriptHostTool(request.user_id, call.name, call.input, scope);
      }
      if (call.name === 'desktop_connector_list_tools' || call.name === 'desktop_connector_call_tool') {
        try {
          const { runDesktopConnectorTool } = await import('./desktop-connectors');
          const beforeDispatch = async () => {
            const denied = await ontologyPreflight('call_connector_tool', call.input || {});
            if (denied) throw new Error(denied.content);
          };
          const result = await runDesktopConnectorTool(request.user_id, call.name, call.input, request, context.signal,
            call.name === 'desktop_connector_call_tool' ? beforeDispatch : undefined);
          if (call.name !== 'desktop_connector_call_tool') return cap(result);
          const { spillConnectorTranscript } = await import('./connector-transcript-spill');
          return cap(spillConnectorTranscript(result, scope));
        } catch (error) {
          return { content: error instanceof Error ? error.message : 'Connector request failed', isError: true };
        }
      }
      // Internal Worker-only approval bridge. The model never sees these as
      // Runtime tools; the host receives the original request/session from the
      // JSONL envelope and does not trust any user/session identity in input.
      if (call.name === 'action_approval_request') {
        const input = call.input || {};
        const text = (value: unknown) => typeof value === 'string' ? value : '';
        const approvalInput = {
          userId: request.user_id,
          runtimeSessionId: request.runtime_session_id,
          runtimeRequestId: request.request_id,
          actor: text(input.actor),
          action: input.action as any,
          target: text(input.target),
          verbatimTarget: input.action === 'bash' && input.verbatim_target === true,
          scope: text(input.scope),
          auditTarget: text(input.audit_target),
          auditScope: text(input.audit_scope),
          risk: input.risk as any,
          reasons: Array.isArray(input.reasons) ? input.reasons.filter((item): item is string => typeof item === 'string') : [],
          fingerprint: text(input.fingerprint),
          signal: context.signal,
        };
        // 是否自动放行也由主进程从持久化会话重新推导（worker 不得自述）：
        // full / auto_approve 直接授予，不广播、不弹窗；ask 走既有确认通道。
        const autoApprove = await shouldAutoApproveRuntimeAction(
          request.user_id,
          request.request_id,
          request.runtime_session_id,
        );
        const result = autoApprove
          ? await grantAutoActionApproval(approvalInput)
          : await requestActionApproval(approvalInput);
        if ('requestId' in result) return { content: JSON.stringify({ approved: true, request_id: result.requestId }) };
        return { content: JSON.stringify({ approved: false, code: result.code }), isError: true };
      }
      if (call.name === 'action_approval_execution') {
        const input = call.input || {};
        const requestId = typeof input.approval_request_id === 'string' ? input.approval_request_id : '';
        const phase = input.phase === 'started' || input.phase === 'succeeded' || input.phase === 'failed' ? input.phase : null;
        if (!requestId || !phase) return { content: '[E_ACTION_APPROVAL_INVALID] invalid approval execution event', isError: true };
        const result = await recordActionApprovalExecution({
          userId: request.user_id,
          runtimeSessionId: request.runtime_session_id,
          runtimeRequestId: request.request_id,
          requestId,
          phase,
          ...(typeof input.result_code === 'string' ? { resultCode: input.result_code } : {}),
        });
        return result.handled
          ? { content: JSON.stringify({ ok: true }) }
          : { content: '[E_ACTION_APPROVAL_NOT_ACTIVE] approval is not active for this Runtime action', isError: true };
      }
      try {
        const denied = await ontologyPreflight(call.name, call.input || {});
        if (denied) return denied;
      } catch { return { content: '[E_ONTOLOGY_OPERATION_PRECONDITION_UNAVAILABLE] current required conditions unavailable', isError: true }; }
      if (call.name.startsWith('office_')) return cap(await office.run(call.name as any, call.input, scope, { signal: context.signal, beforeAction: async () => { const denied = await ontologyPreflight(call.name, call.input || {}); if (denied) throw new Error(denied.content); } }));
      if (call.name.startsWith('browser_')) return cap(await browser.run(call.name as any, call.input, scope, { signal: context.signal, beforeAction: async () => { const denied = await ontologyPreflight(call.name, call.input || {}); if (denied) throw new Error(denied.content); } }));
      // Proactive messaging: the capability must be re-derived from the
      // persisted task/session on every call — the worker's own capability
      // claims are never trusted. Denied scopes are hard errors so the run
      // cannot mistake a permission bypass for a delivery outcome.
      if (call.name === 'messaging_list_targets' || call.name === 'messaging_send') {
        const capabilities = await resolveRuntimeCapabilities(request.user_id, request.request_id, request.runtime_session_id);
        if (!capabilities.includes('messaging.proactive')) {
          return { content: '[E_RUNTIME_HOST_TOOL_FORBIDDEN] messaging tools require a Commander runtime scope', isError: true };
        }
        const { runMessagingHostTool } = await import('./messaging-host-adapter');
        return cap(await runMessagingHostTool(call.name, call.input, {
          userId: request.user_id,
          sourceKey: `${request.request_id}:${call.call_id}`,
          signal: context.signal,
          beforeDispatch: async () => { const denied = await ontologyPreflight(call.name, call.input || {}); if (denied) throw new Error(denied.content); },
        }));
      }
      // P3394 agent interop (outbound): Commander-only, capability re-derived
      // from the persisted task/session chain on every call.
      if (call.name === 'p3394_send') {
        const capabilities = await resolveRuntimeCapabilities(request.user_id, request.request_id, request.runtime_session_id);
        if (!capabilities.includes('p3394.interop')) {
          return { content: '[E_RUNTIME_HOST_TOOL_FORBIDDEN] p3394_send requires a Commander runtime scope', isError: true };
        }
        const { runP3394HostTool } = await import('./p3394-host-adapter');
        return cap(await runP3394HostTool(call.input, {
          userId: request.user_id,
          sourceKey: `${request.request_id}:${call.call_id}`,
          ...(request.working_dir ? { workingDir: request.working_dir } : {}),
          allowedRoots: [...(request.read_only_roots ?? []), ...(request.writable_roots ?? [])],
          signal: context.signal,
        }));
      }
      if (call.name === 'ontology_graph_read' || call.name === 'ontology_projection_apply') {
        const { runOntologyHostTool } = await import('./ontology-host-adapter');
        return cap(await runOntologyHostTool(call.name, call.input, scope));
      }
      try {
        // Native counterpart of the core-agent `publish_outputs` contract.
        // The host verifies every path against this session's write records,
        // then awaits knowledge-base precipitation so the Agent gets a
        // per-file outcome instead of a fire-and-forget acknowledgement.
        if (call.name === 'publish_outputs') {
          const { runPublishRuntimeOutputs } = await import('./publish-runtime-outputs');
          return cap(await runPublishRuntimeOutputs({
            userId: request.user_id,
            requestId: request.request_id,
            runtimeSessionId: request.runtime_session_id,
            ...(request.working_dir ? { workingDir: request.working_dir } : {}),
            writableRoots: request.writable_roots ?? [],
            input: call.input,
          }));
        }
        // Delegation is the parent's authority. The catalog already hides it
        // from a child, but the host re-derives the grant so a worker that
        // fabricates a capability or calls the host directly is still denied.
        if (call.name === 'cogseed_delegate'
          || call.name === 'cogseed_join'
          || call.name === 'cogseed_tasks'
          || call.name === 'cogseed_cancel') {
          const capabilities = await resolveRuntimeCapabilities(
            request.user_id,
            request.request_id,
            request.runtime_session_id,
          );
          if (!capabilities.includes('cogseed.coordination')) {
            return {
              content: '[E_RUNTIME_HOST_TOOL_FORBIDDEN] delegation tools require a Commander coordination scope',
              isError: true,
            };
          }
        }
        if (call.name === 'cogseed_workflow'
          || call.name === 'cogseed_retry_step'
          || call.name === 'cogseed_skip_step'
          || call.name === 'cogseed_resume_workflow') {
          // 这四个工具只在真的挂在协作 workflow 上的任务里才有意义；能力同样
          // 由持久化记录重新推导（worker 自述不算）。
          const capabilities = await resolveRuntimeCapabilities(
            request.user_id,
            request.request_id,
            request.runtime_session_id,
          );
          if (!capabilities.includes('cogseed.workflow')) {
            return {
              content: '[E_RUNTIME_HOST_TOOL_FORBIDDEN] workflow tools require a CogSeed collaboration workflow',
              isError: true,
            };
          }
        }
        if (call.name === 'cogseed_delegate') {
          const task = typeof call.input.task === 'string' ? call.input.task.trim() : '';
          if (!task || task.length > 20_000) return { content: '[E_MATE_COORDINATION_INPUT] task is required and must be at most 20000 characters', isError: true };
          const child = await coordinator.delegate(request.user_id, request.request_id, {
            requestId: `req-${call.call_id}`.slice(0, 120), task,
            ...(typeof call.input.role === 'string' ? { role: call.input.role } : {}),
            ...(Array.isArray(call.input.context) ? { context: call.input.context.slice(0, 50) } : {}),
          });
          return cap({ content: JSON.stringify({ taskId: child.taskId, sessionId: child.sessionId, runtimeSessionId: child.runtimeSessionId, status: child.status }) });
        }
        if (call.name === 'cogseed_join') {
          const ids = Array.isArray(call.input.task_ids)
            ? call.input.task_ids.filter((id): id is string => typeof id === 'string').slice(0, 20)
            : [];
          const timeoutMs = typeof call.input.timeout_ms === 'number' && Number.isFinite(call.input.timeout_ms)
            ? call.input.timeout_ms
            : undefined;
          const joined = await coordinator.join(
            request.user_id,
            request.request_id,
            { ...(ids.length ? { taskIds: ids } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
            { signal: context.signal },
          );
          return cap({ content: JSON.stringify(joined) });
        }
        if (call.name === 'cogseed_tasks') {
          const ids = Array.isArray(call.input.task_ids) ? call.input.task_ids.filter((id): id is string => typeof id === 'string').slice(0, 20) : [];
          return cap({ content: JSON.stringify(await coordinator.tasks(request.user_id, request.request_id, ids)) });
        }
        if (call.name === 'cogseed_retry_step') { if (typeof call.input.step_id !== 'string') return { content: '[E_MATE_CONTROL_INPUT] step_id is required', isError: true }; return cap({ content: JSON.stringify(await cogseedControlService.retryStep(request.user_id, request.request_id, call.input.step_id)) }); }
        if (call.name === 'cogseed_skip_step') { if (typeof call.input.step_id !== 'string') return { content: '[E_MATE_CONTROL_INPUT] step_id is required', isError: true }; return cap({ content: JSON.stringify(await cogseedControlService.skipStep(request.user_id, request.request_id, call.input.step_id, typeof call.input.reason === 'string' ? call.input.reason : undefined)) }); }
        if (call.name === 'cogseed_resume_workflow') return cap({ content: JSON.stringify(await cogseedControlService.resume(request.user_id, request.request_id, typeof call.input.reason === 'string' ? call.input.reason : undefined)) });
        if (call.name === 'cogseed_workflow') return cap({ content: JSON.stringify(await cogseedControlService.workflow(request.user_id, request.request_id)) });
        if (call.name === 'cogseed_cancel') {
          if (typeof call.input.task_id !== 'string') return { content: '[E_MATE_COORDINATION_INPUT] task_id is required', isError: true };
          const child = await coordinator.cancel(request.user_id, request.request_id, call.input.task_id);
          return { content: JSON.stringify({ taskId: child.taskId, status: child.status }) };
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
      return { content: `[E_RUNTIME_HOST_TOOL_UNKNOWN] unknown CogSeed host tool: ${String(call.name)}`, isError: true };
    },
  };
}

export const cogseedHostToolRouter = createCogSeedHostToolRouter();
