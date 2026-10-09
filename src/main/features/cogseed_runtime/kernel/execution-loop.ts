import { assembleRuntimePrompt, type AssembledRuntimeContext } from './prompt-assembler';
import { DEFAULT_RUNTIME_KERNEL_CONFIG } from './config';
import { assembleRuntimeContextForPrompt } from './context/importer';
import { loadRuntimeMemorySummary } from './memory/injector';
import type { RuntimeModelAdapter, RuntimeModelToolCall } from './model-adapter';
import type { RuntimeToolRunner } from './tools/runner';
import type { RuntimeToolResult } from './tools/file-tools';
import type { RuntimeKernelEvent, RuntimeKernelRequest } from './types';
import { isRuntimeAborted } from './cancellation';
import { getRuntimeOpenAIToolCatalog } from './tools/catalog';

export interface RuntimeExecutionLoopDeps {
  modelAdapter: RuntimeModelAdapter;
  toolRunner: RuntimeToolRunner;
  maxToolRounds: number;
  maxPromptContextChars?: number;
  maxMemoryInjectionChars?: number;
  contextAssembler?: (request: RuntimeKernelRequest) => Promise<AssembledRuntimeContext> | AssembledRuntimeContext;
  memoryProvider?: (request: RuntimeKernelRequest) => Promise<string | undefined> | string | undefined;
  memoryExtractor?: (input: { request: RuntimeKernelRequest; finalText: string }) => Promise<void> | void;
}

export interface RuntimeExecutionLoopOptions {
  signal?: AbortSignal | null;
  onRecord?: (role: 'user' | 'assistant' | 'tool' | 'system', content: string) => Promise<void> | void;
}

function eventBase(request: RuntimeKernelRequest): Pick<RuntimeKernelEvent, 'requestId' | 'runtimeSessionId'> {
  return { requestId: request.requestId, runtimeSessionId: request.runtimeSessionId };
}

function renderToolResult(call: RuntimeModelToolCall, result: RuntimeToolResult): string {
  return [
    `<runtime-tool-result id="${call.id}" name="${call.name}" status="${result.isError ? 'error' : 'ok'}">`,
    result.content,
    `</runtime-tool-result>`,
  ].join('\n');
}

export async function* runRuntimeExecutionLoop(
  request: RuntimeKernelRequest,
  deps: RuntimeExecutionLoopDeps,
  options: RuntimeExecutionLoopOptions = {},
): AsyncGenerator<RuntimeKernelEvent, void, unknown> {
  const signal = options.signal ?? null;
  if (isRuntimeAborted(signal)) {
    yield { type: 'cancelled', ...eventBase(request), metadata: { code: 'aborted' } };
    return;
  }

  const assembledContext = deps.contextAssembler
    ? await deps.contextAssembler(request)
    : await assembleRuntimeContextForPrompt(request, {
      maxPromptContextChars: deps.maxPromptContextChars ?? DEFAULT_RUNTIME_KERNEL_CONFIG.maxPromptContextChars,
    });
  const memorySummary = deps.memoryProvider
    ? await deps.memoryProvider(request)
    : await loadRuntimeMemorySummary(request.userId, {
      agentId: request.agentId,
      maxChars: deps.maxMemoryInjectionChars ?? DEFAULT_RUNTIME_KERNEL_CONFIG.maxMemoryInjectionChars,
    });
  const prompt = assembleRuntimePrompt({ request, context: assembledContext, memorySummary });
  await options.onRecord?.('system', prompt.system);
  await options.onRecord?.('user', request.task);

  yield { type: 'started', ...eventBase(request) };

  let message = prompt.user;
  for (let round = 0; round <= deps.maxToolRounds; round += 1) {
    let finalText = '';
    const toolCalls: RuntimeModelToolCall[] = [];

    for await (const modelEvent of deps.modelAdapter.stream({
      userId: request.userId,
      requestId: request.requestId,
      runtimeSessionId: request.runtimeSessionId,
      message,
      systemPrompt: prompt.system,
      modelProfile: request.modelProfile,
      workingDir: request.workingDir,
      readOnlyRoots: request.readOnlyRoots,
      tools: getRuntimeOpenAIToolCatalog(deps.toolRunner.catalog),
    }, { signal })) {
      if (isRuntimeAborted(signal)) {
        yield { type: 'cancelled', ...eventBase(request), metadata: { code: 'aborted' } };
        return;
      }
      if (modelEvent.type === 'delta') {
        finalText += modelEvent.text;
        yield { type: 'model_delta', ...eventBase(request), text: modelEvent.text };
      } else if (modelEvent.type === 'tool_call') {
        toolCalls.push(modelEvent.call);
        yield { type: 'tool_call', ...eventBase(request), metadata: { id: modelEvent.call.id, name: modelEvent.call.name, arguments: modelEvent.call.arguments } };
      } else if (modelEvent.type === 'error') {
        yield { type: 'error', ...eventBase(request), error: modelEvent.message, metadata: { code: modelEvent.code } };
        return;
      }
    }

    if (!toolCalls.length) {
      await options.onRecord?.('assistant', finalText);
      await deps.memoryExtractor?.({ request, finalText });
      yield { type: 'result', ...eventBase(request), text: finalText };
      return;
    }

    if (round >= deps.maxToolRounds) {
      const error = 'runtime exceeded max tool rounds';
      await options.onRecord?.('assistant', error);
      yield { type: 'error', ...eventBase(request), error, metadata: { code: 'max_tool_rounds', maxToolRounds: deps.maxToolRounds } };
      return;
    }

    const renderedResults: string[] = [];
    for (const call of toolCalls) {
      const result = await deps.toolRunner.run(call.name, call.arguments, { signal });
      renderedResults.push(renderToolResult(call, result));
      await options.onRecord?.('tool', renderedResults[renderedResults.length - 1]);
      yield { type: 'tool_result', ...eventBase(request), text: result.content, metadata: { id: call.id, name: call.name, isError: !!result.isError } };
      // 工具报错是可恢复输入，不是整轮致命错误：错误文本已经随 tool_result 回灌给
      // 模型（下一轮的 renderedResults），让它自己换工具/改参数/如实说明。此前这里
      // 直接 yield error 并 return，导致任何一次工具失败都把整轮判死——真机上
      // cogseed_workflow（无 workflow 时必然报错）、路径写错、策略拒绝都因此变成
      // 「智能体未能完成本次回复，请重试」，而重试只会再撞同一面墙。
      // 终止仍由模型自身失败与 maxToolRounds 兜底（见上方与下方分支）。
    }

    message = [
      prompt.user,
      '## Runtime tool results',
      ...renderedResults,
      'Continue from these explicit runtime tool results and produce the final answer or request another tool.',
    ].join('\n\n');
  }
}
