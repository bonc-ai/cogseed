import { buildBoundedPreview } from '../../util/tool-result-cap';
import { isRuntimeHostToolName, type RuntimeHostToolCall } from '../cogseed_runtime/protocol';
import type { RuntimeHostToolHandlerContext } from '../cogseed_runtime/worker-process';
import { cogseedOfficeAdapter, type CogSeedHostToolResult, type CogSeedHostToolScope } from './office-adapter';
import { cogseedBrowserAdapter } from './browser-adapter';
import { createCogSeedCoordinator, type CogSeedCoordinator } from './coordinator';
import { cogseedControlService } from './cogseed-control-service';
import { resolveRuntimeCapabilities } from './messaging-capability-policy';

interface HostAdapter { run(name: any, input: Record<string, unknown>, scope: CogSeedHostToolScope, opts?: { signal?: AbortSignal | null }): Promise<CogSeedHostToolResult> }
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
      if (call.name.startsWith('office_')) return cap(await office.run(call.name as any, call.input, scope, { signal: context.signal }));
      if (call.name.startsWith('browser_')) return cap(await browser.run(call.name as any, call.input, scope, { signal: context.signal }));
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
          signal: context.signal,
        }));
      }
      try {
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
