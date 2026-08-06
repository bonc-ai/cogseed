import { buildBoundedPreview } from '../../util/tool-result-cap';
import { isRuntimeHostToolName, type RuntimeHostToolCall } from '../mate_agent_runtime/protocol';
import type { RuntimeHostToolHandlerContext } from '../mate_agent_runtime/worker-process';
import { mateOfficeAdapter, type MateHostToolResult, type MateHostToolScope } from './office-adapter';
import { mateBrowserAdapter } from './browser-adapter';
import { createMateCoordinator, type MateCoordinator } from './coordinator';
import { mateRuntimeController } from './runtime-controller';
import { mateControlService } from './mate-control-service';

interface HostAdapter { run(name: any, input: Record<string, unknown>, scope: MateHostToolScope, opts?: { signal?: AbortSignal | null }): Promise<MateHostToolResult> }
export interface MateHostToolRouterDeps { office?: HostAdapter; browser?: HostAdapter; coordinator?: MateCoordinator }

export function createMateHostToolRouter(deps: MateHostToolRouterDeps = {}) {
  const office = deps.office ?? mateOfficeAdapter;
  const browser = deps.browser ?? mateBrowserAdapter;
  const coordinator = deps.coordinator ?? createMateCoordinator({
    startTask: (userId, input) => mateRuntimeController.startMateTask(userId, input),
    cancelTask: (userId, taskId) => mateRuntimeController.cancelMateTask(userId, taskId),
  });

  function cap(result: MateHostToolResult): MateHostToolResult {
    if (result.content.length <= 24_000) return result;
    return { ...result, content: `${buildBoundedPreview(result.content, 5_500)}\n[host tool result truncated]` };
  }

  return {
    async handle(call: RuntimeHostToolCall, context: RuntimeHostToolHandlerContext): Promise<MateHostToolResult> {
      const request = context.request;
      if (call.request_id !== request.request_id || call.runtime_session_id !== request.runtime_session_id) {
        return { content: '[E_RUNTIME_HOST_TOOL_SCOPE] host tool request scope mismatch', isError: true };
      }
      if (!isRuntimeHostToolName(String(call.name))) {
        return { content: `[E_RUNTIME_HOST_TOOL_UNKNOWN] unknown Mate host tool: ${String(call.name)}`, isError: true };
      }
      const scope: MateHostToolScope = {
        userId: request.user_id, requestId: request.request_id, runtimeSessionId: request.runtime_session_id,
        readOnlyRoots: request.read_only_roots ?? [], writableRoots: request.writable_roots ?? [],
        ...(request.working_dir ? { workingDir: request.working_dir } : {}),
      };
      if (call.name.startsWith('office_')) return cap(await office.run(call.name as any, call.input, scope, { signal: context.signal }));
      if (call.name.startsWith('browser_')) return cap(await browser.run(call.name as any, call.input, scope, { signal: context.signal }));
      try {
        if (call.name === 'mate_delegate') {
          const task = typeof call.input.task === 'string' ? call.input.task.trim() : '';
          if (!task || task.length > 20_000) return { content: '[E_MATE_COORDINATION_INPUT] task is required and must be at most 20000 characters', isError: true };
          const child = await coordinator.delegate(request.user_id, request.request_id, {
            requestId: `req-${call.call_id}`.slice(0, 120), task,
            ...(typeof call.input.role === 'string' ? { role: call.input.role } : {}),
            ...(Array.isArray(call.input.context) ? { context: call.input.context.slice(0, 50) } : {}),
          });
          return cap({ content: JSON.stringify({ taskId: child.taskId, sessionId: child.sessionId, runtimeSessionId: child.runtimeSessionId, status: child.status }) });
        }
        if (call.name === 'mate_tasks') {
          const ids = Array.isArray(call.input.task_ids) ? call.input.task_ids.filter((id): id is string => typeof id === 'string').slice(0, 20) : [];
          return cap({ content: JSON.stringify(await coordinator.tasks(request.user_id, request.request_id, ids)) });
        }
        if (call.name === 'mate_retry_step') { if (typeof call.input.step_id !== 'string') return { content: '[E_MATE_CONTROL_INPUT] step_id is required', isError: true }; return cap({ content: JSON.stringify(await mateControlService.retryStep(request.user_id, request.request_id, call.input.step_id)) }); }
        if (call.name === 'mate_skip_step') { if (typeof call.input.step_id !== 'string') return { content: '[E_MATE_CONTROL_INPUT] step_id is required', isError: true }; return cap({ content: JSON.stringify(await mateControlService.skipStep(request.user_id, request.request_id, call.input.step_id, typeof call.input.reason === 'string' ? call.input.reason : undefined)) }); }
        if (call.name === 'mate_resume_workflow') return cap({ content: JSON.stringify(await mateControlService.resume(request.user_id, request.request_id, typeof call.input.reason === 'string' ? call.input.reason : undefined)) });
        if (call.name === 'mate_workflow') return cap({ content: JSON.stringify(await mateControlService.workflow(request.user_id, request.request_id)) });
        if (call.name === 'mate_cancel') {
          if (typeof call.input.task_id !== 'string') return { content: '[E_MATE_COORDINATION_INPUT] task_id is required', isError: true };
          const child = await coordinator.cancel(request.user_id, request.request_id, call.input.task_id);
          return { content: JSON.stringify({ taskId: child.taskId, status: child.status }) };
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
      return { content: `[E_RUNTIME_HOST_TOOL_UNKNOWN] unknown Mate host tool: ${String(call.name)}`, isError: true };
    },
  };
}

export const mateHostToolRouter = createMateHostToolRouter();
