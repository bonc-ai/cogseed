/**
 * Unified LLM provider backed by @earendil-works/pi-ai.
 *
 * Replaces the individual Anthropic/OpenAI implementations with pi-ai's
 * multi-provider layer — the same approach used by OpenClaw.
 */
import {
  getModel,
  getModels,
  getProviders,
  complete as piComplete,
  stream as piStream,
  completeSimple as piCompleteSimple,
  streamSimple as piStreamSimple,
} from "@earendil-works/pi-ai";
import type {
  Model,
  Api,
  Context as PiContext,
  AssistantMessage as PiAssistantMessage,
  Tool as PiTool,
  KnownProvider,
} from "@earendil-works/pi-ai";

import * as crypto from "node:crypto";

import type { Message, MessageContent, StreamEvent, StopReason, Usage } from "../shared/types.js";
import { isValidTokenCount } from "../shared/types.js";
import { AuthError, ProviderError, RateLimitError, ContextOverflowError } from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import type { CompletionParams, CompletionResult, LLMProvider, ToolDefinition } from "./base.js";
import { createRequestPrefixAudit } from "./request-prefix-audit.js";
import { translatePromptCachePolicy, type PromptCachePolicy } from "./prompt-cache-policy.js";
import { OpenAIWireCapture } from "./openai-wire-usage.js";
import {
  TOOL_RESULT_IMAGE_BUDGET,
  externalizeToolResultImages,
} from "../shared/tool-result-images.js";

const log = createLogger("pi-provider");

// Shared across factories (the host can rebuild a provider between turns), but
// allocated only when explicitly enabled. The audit owns a hard-bounded LRU.
let requestPrefixAudit: ReturnType<typeof createRequestPrefixAudit> | undefined;
type PayloadHook = (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>;
function auditedPayloadHook(onPayload: PayloadHook | undefined, sessionId: string | undefined, requestId?: number): PayloadHook | undefined {
  // Reuse the host's explicit debug environment seam; the core logger's default
  // level otherwise suppresses debug(). No config files or prompts are changed.
  if (process.env.COGSEED_LOG_LEVEL !== "debug") return onPayload;
  return async function (this: unknown, payload, model) {
    // Preserve mutation + undefined, async replacements, and existing failures.
    // Audit only the final provider-facing value, after the host hook completes.
    const replacement = await onPayload?.call(this, payload, model);
    try {
      requestPrefixAudit ??= createRequestPrefixAudit();
      const report = requestPrefixAudit.observe({
        api: model.api, provider: model.provider, model: model.id,
        baseUrl: model.baseUrl, sessionId,
      }, replacement === undefined ? payload : replacement);
      log.info("request_prefix_audit", { ...report, requestId });
    } catch { /* diagnostics, including logger failures, must not break requests */ }
    return replacement;
  };
}

// Core-agent favors stable HTTP event streams over WebSocket optimizations.
// Providers that do not support transport selection ignore this option.
const CORE_AGENT_TRANSPORT = "sse" as const;

/**
 * Clamp a session id to a provider-safe cache key. OpenAI / Codex / Azure
 * enforce `prompt_cache_key.length ≤ 64`; pi-ai forwards `options.sessionId`
 * verbatim to that field. With the dev-mode OAuth flow `reconcileDevUid()`
 * can install a 36-char GUID uid, after which `<uid>-gmember-<cid>-<aid>`
 * is 70 chars and OpenAI 400s the request.
 *
 * Inputs that fit pass through unchanged so existing 8-digit-uid sessions
 * keep their readable cache key (and existing cache buckets). Longer ones
 * collapse to `<prefix>-<sha1hex>` = 22 + 1 + 40 = 63 chars — deterministic
 * (same session ⇒ same key ⇒ cache still hits) and keeps a recognizable
 * head for log diagnosis. */
const MAX_CACHE_KEY_LEN = 64;
function cacheSafeSessionId(s: string | undefined): string | undefined {
  if (!s) return s;
  if (s.length <= MAX_CACHE_KEY_LEN) return s;
  const hash = crypto.createHash("sha1").update(s).digest("hex");
  return `${s.slice(0, 22)}-${hash}`;
}

// Request-local, content-free correlation. Custom cache keys never contain the
// caller's user/session identity, even when the original id is short.
let wireRequestSequence = 0;
type RequestTrace = { requestId: number; startedAt: number; finished: boolean };

/** Cheap numeric diagnostics at normal log level. Prefix hashing stays opt-in.
 * Absent provider counts must not become zero cache misses (SDKs default them).
 * A trace finishes once, including when an SDK error is subsequently rethrown. */
function logRequestUsage(trace: RequestTrace, outcome: 'completed' | 'error', usage?: Partial<Usage>, toolCalls = 0): void {
  if (trace.finished) return;
  trace.finished = true;
  try {
    const total = usage?.totalInputTokens;
    const cached = usage?.cacheReadTokens;
    const known = isValidTokenCount(total) && isValidTokenCount(cached) && cached <= total;
    log.info('request_usage_summary', {
      requestId: trace.requestId, outcome,
      durationMs: Math.max(0, Math.round(performance.now() - trace.startedAt)),
      toolCalls, cacheStatus: known ? 'known' : 'unknown',
      ...(isValidTokenCount(total) ? { totalInputTokens: total } : {}),
      ...(isValidTokenCount(usage?.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
      ...(known ? { cacheReadTokens: cached, uncachedInputTokens: total - cached,
        ...(total > 0 ? { cacheReadRatio: cached / total } : {}) } : {}),
      // Without an authoritative total this may just be an SDK default zero.
      ...(isValidTokenCount(total) && isValidTokenCount(usage?.cacheWriteTokens)
        ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    });
  } catch { /* diagnostics must not fail or retry a model request */ }
}

function scopedCacheKey(model: Model<Api>, sessionId?: string, namespace?: string): string | undefined {
  if (!sessionId) return undefined;
  return crypto.createHash("sha256")
    .update(JSON.stringify([namespace, model.provider, model.baseUrl, sessionId])).digest("hex");
}
function safeReportedModel(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:/@+\-]{1,160}$/.test(value) ? value : undefined;
}
function requestOptions(config: { onPayload?: PayloadHook; promptCachePolicy?: PromptCachePolicy; cacheNamespace?: string },
  model: Model<Api>, params: CompletionParams) {
  const requestId = ++wireRequestSequence;
  const trace: RequestTrace = { requestId, startedAt: performance.now(), finished: false };
  const explicitPolicy = config.promptCachePolicy !== undefined
    && (model.api === 'openai-completions' || model.api === 'openai-responses');
  const sessionId = explicitPolicy ? scopedCacheKey(model, params.sessionId, config.cacheNamespace) : cacheSafeSessionId(params.sessionId);
  const hints = translatePromptCachePolicy({ policy: config.promptCachePolicy,
    api: model.api, cacheRetention: params.cacheRetention, sessionId });
  const headers: Record<string, string> = { ...model.headers };
  if (explicitPolicy) {
    for (const key of Object.keys(headers)) {
      if (['session_id', 'x-client-request-id', 'x-session-affinity'].includes(key.toLowerCase())) delete headers[key];
    }
    Object.assign(headers, hints.headers);
  }
  const applyPolicy: PayloadHook | undefined = explicitPolicy ? async function (this: unknown, payload, target) {
    const replacement = await config.onPayload?.call(this, payload, target);
    const finalPayload = replacement === undefined ? payload : replacement;
    if (finalPayload && typeof finalPayload === 'object' && !Array.isArray(finalPayload)) {
      const body = { ...(finalPayload as Record<string, unknown>) };
      delete body.prompt_cache_key;
      delete body.prompt_cache_retention;
      return Object.assign(body, hints.payload);
    }
    return replacement;
  } : config.onPayload;
  const sdkModel = explicitPolicy ? { ...model, headers,
    compat: { ...(model as any).compat, sendSessionAffinityHeaders: false } } as Model<Api> : model;
  const audit = { requestId, cacheHintsObserved: false, cacheKey: false,
    retention: 'unspecified', affinity: Object.keys(hints.headers).length > 0 };
  const inspect: PayloadHook | undefined = process.env.COGSEED_LOG_LEVEL === 'debug'
    ? async function (this: unknown, payload, target) {
      const replacement = await applyPolicy?.call(this, payload, target);
      const finalPayload = replacement === undefined ? payload : replacement;
      if (finalPayload && typeof finalPayload === 'object' && !Array.isArray(finalPayload)) {
        const body = finalPayload as Record<string, unknown>;
        audit.cacheHintsObserved = true;
        audit.cacheKey = typeof body.prompt_cache_key === 'string' && !!body.prompt_cache_key;
        audit.retention = body.prompt_cache_retention === '24h' || body.prompt_cache_retention === 'in-memory'
          ? body.prompt_cache_retention : 'unspecified';
      }
      return replacement;
    } : applyPolicy;
  return { sessionId, sdkSessionId: explicitPolicy ? undefined : sessionId, headers, requestId, sdkModel,
    onPayload: auditedPayloadHook(inspect, sessionId, requestId), audit, trace,
  };
}
function wireResult(capture: OpenAIWireCapture | undefined, usage: PiAssistantMessage['usage'],
  model: unknown, audit: Record<string, unknown>, requestedModel: string,
  trace: RequestTrace, outcome: 'completed' | 'error', content: PiAssistantMessage['content']) {
  const observed = capture?.finish(mapUsage(usage), safeReportedModel(model));
  if (observed) {
    const reported = safeReportedModel(observed.reportedModel);
    if (reported) observed.reportedModel = reported;
    else delete observed.reportedModel;
  }
  if (process.env.COGSEED_LOG_LEVEL === 'debug') {
    try { log.info('request_wire_usage', { ...audit, requestedModel: safeReportedModel(requestedModel),
      ...(observed?.diagnostics || {}), reportedModel: observed?.reportedModel,
      usage: observed?.usage || mapUsage(usage) }); } catch { /* diagnostics only */ }
  }
  const result = observed || { usage: mapUsage(usage), reportedModel: safeReportedModel(model) };
  logRequestUsage(trace, outcome, result.usage, content.filter(block => block.type === 'toolCall').length);
  return result;
}

// ─── Type conversion helpers ──────────────────────────────────────────────

/** Convert our internal Message[] to pi-ai Context.
 *  Exported for the C1/R-09 contract test: tool-result image externalization happens
 *  here, and pinning it through the real conversion is the only way to prove images
 *  never leak back into a request whose model cannot take them. */
export function buildPiContext(
  messages: Message[],
  systemPrompt?: string,
  tools?: ToolDefinition[],
  /**
   * Current model being called. Used to stamp each replayed assistant
   * message with `api`/`provider`/`model` matching the active model so
   * pi-ai's `transformMessages` evaluates `isSameModel === true` and
   * preserves thinking blocks (with their `thinkingSignature`) intact.
   *
   * Why this matters: pi-ai's transformMessages downgrades a thinking
   * block to a plain text block whenever it judges the source model
   * differs from the current one — that path skips the reasoner-specific
   * field (`reasoning_content` / `signature`) altogether, which causes
   * DeepSeek V4 Pro to 400 with a misleading "reasoning_content in the
   * thinking mode must be passed back" error. Stamping the current model
   * here keeps the thinking block whole and lets pi-ai's openai-completions
   * converter set `assistantMsg.reasoning_content` correctly.
   *
   * Caveat: CogSeed doesn't persist per-message provenance in the session
   * jsonl, so this assumes the entire conversation was generated by one
   * model. If the user mid-chat switches to a different provider whose
   * thinking signatures are incompatible (Anthropic encrypted thinking →
   * OpenAI o-series), pi-ai's safety downgrade was the right behavior;
   * we accept that mid-chat switch may produce a turn the new model
   * rejects. Per-message stamping is the proper long-term fix.
   */
  model?: { api: string; provider: string; id: string; input?: readonly string[] },
): PiContext {
  const piMessages: PiContext["messages"] = [];

  // C1/R-09 — tool-result image externalization (the DSH route). Images a tool
  // produced stay attributed blocks in the session, but once a request exceeds the
  // image budget they become text handles naming the read-only copy. A route whose
  // model does not accept images externalizes all of them: sending them is either
  // dropped by the converter or a 400, and the handle still tells the model how to
  // read the file. User attachments keep their existing vision path — only blocks
  // carrying the producing `tool_use` id take part.
  const acceptsImages = model?.input ? model.input.includes("image") : true;
  const projectedMessages = externalizeToolResultImages(
    messages,
    acceptsImages ? TOOL_RESULT_IMAGE_BUDGET : { maxImages: 0 },
  );

  for (const msg of projectedMessages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      // Check for tool_result content
      const toolResults = msg.content.filter((c) => c.type === "tool_result");
      const others = msg.content.filter((c) => c.type !== "tool_result");

      // Emit tool result messages first
      for (const tr of toolResults) {
        if (tr.type !== "tool_result") continue;
        piMessages.push({
          role: "toolResult",
          toolCallId: tr.toolUseId,
          toolName: "", // pi-ai tolerates empty
          content: [{ type: "text", text: tr.content }],
          isError: tr.isError ?? false,
          timestamp: Date.now(),
        });
      }

      // Emit user text/image content
      if (others.length > 0) {
        const piContent: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        for (const c of others) {
          if (c.type === "text") {
            piContent.push({ type: "text", text: c.text });
          } else if (c.type === "image") {
            piContent.push({ type: "image", data: c.data, mimeType: c.mediaType });
          }
        }
        if (piContent.length > 0) {
          piMessages.push({
            role: "user",
            content: piContent,
            timestamp: Date.now(),
          });
        }
      }
    } else if (msg.role === "assistant") {
      const piContent: PiAssistantMessage["content"] = [];
      for (const c of msg.content) {
        if (c.type === "text") {
          piContent.push({ type: "text", text: c.text });
        } else if (c.type === "tool_use") {
          piContent.push({
            type: "toolCall",
            id: c.id,
            name: c.name,
            arguments: c.input,
          });
        } else if (c.type === "thinking") {
          // Re-inject reasoning into outgoing context — required by DeepSeek
          // reasoner / Anthropic encrypted-thinking / llama.cpp gpt-oss; see
          // mapContent() for the inbound side.
          //
          // pi-ai stores `thinkingSignature` in two incompatible formats
          // depending on which provider produced the block:
          //   - openai-completions adapter writes the literal field name
          //     ("reasoning_content" / "reasoning" / "reasoning_text") so
          //     the next-turn payload can echo `assistantMsg[signature]`
          //     back as the same key.
          //   - openai-responses-shared expects a JSON-encoded reasoning
          //     item and does `JSON.parse(thinkingSignature)` unconditionally.
          // A cross-provider conversation (e.g. DeepSeek then gpt-5) will
          // crash the second turn with `Unexpected token 'r', "reasoning_content"
          // is not valid JSON`. Drop the signature when it would crash the
          // target adapter; losing the signature only weakens DeepSeek-style
          // "echo back" guarantees, which is acceptable cross-provider.
          const targetIsResponsesApi = model?.api === "openai-responses"
            || model?.api === "azure-openai-responses"
            || model?.api === "openai-codex-responses";
          let safeSignature = c.thinkingSignature;
          if (safeSignature && targetIsResponsesApi) {
            try { JSON.parse(safeSignature); }
            catch { safeSignature = undefined; }
          }
          piContent.push({
            type: "thinking",
            thinking: c.thinking,
            ...(safeSignature ? { thinkingSignature: safeSignature } : {}),
            ...(c.redacted ? { redacted: c.redacted } : {}),
          });
        }
      }
      piMessages.push({
        role: "assistant",
        content: piContent,
        // Stamp with the current model so pi-ai's `transformMessages` sees
        // `isSameModel === true` and keeps thinking blocks (with their
        // signature) verbatim — see the param comment on `buildPiContext`.
        // Falls back to harmless placeholders only when no model is supplied
        // (utility paths like validateAuth that don't replay history).
        api: (model?.api ?? "anthropic-messages") as PiAssistantMessage["api"],
        provider: model?.provider ?? "anthropic",
        model: model?.id ?? "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
  }

  // Convert tool definitions to pi-ai Tool format
  const piTools: PiTool[] | undefined = tools?.map((t) => ({
    name: t.name,
    description: t.description,
    // pi-ai accepts JSON Schema directly. Rebuilding just the top-level
    // primitives loses nested objects, enums and constraints (and turned
    // template slot maps into strings in real calls).
    parameters: structuredClone(t.inputSchema) as PiTool["parameters"],
  }));

  return {
    systemPrompt,
    messages: piMessages,
    tools: piTools,
  };
}

/** Map pi-ai StopReason to our StopReason. */
function mapStopReason(reason: PiAssistantMessage["stopReason"]): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "toolUse":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "error":
    case "aborted":
      return "end_turn";
    default:
      return "end_turn";
  }
}

/** pi-ai input is uncached; cache reads/writes are separate input buckets.
 * Preserve numeric zero and omit absent cache fields. pi-ai itself defaults
 * some missing wire fields to zero, so those cannot be distinguished here. */
function mapUsage(u: PiAssistantMessage["usage"]): Usage {
  return {
    inputTokens: u.input,
    outputTokens: u.output,
    ...(isValidTokenCount(u.cacheRead) ? { cacheReadTokens: u.cacheRead } : {}),
    ...(isValidTokenCount(u.cacheWrite) ? { cacheWriteTokens: u.cacheWrite } : {}),
    totalTokens: u.totalTokens,
  };
}

/** Convert pi-ai AssistantMessage content to our MessageContent[]. */
function mapContent(content: PiAssistantMessage["content"]): MessageContent[] {
  const result: MessageContent[] = [];
  for (const block of content) {
    if (block.type === "text") {
      result.push({ type: "text", text: block.text });
    } else if (block.type === "toolCall") {
      result.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.arguments,
      });
    } else if (block.type === "thinking") {
      // Preserve reasoning blocks for round-trip. DeepSeek-style reasoners
      // 400 the next turn if `reasoning_content` isn't echoed back; pi-ai's
      // openai-completions adapter writes it via `assistantMsg[signature]`
      // (signature = original field name, e.g. "reasoning_content").
      const tc: MessageContent = {
        type: "thinking",
        thinking: block.thinking,
        ...(block.thinkingSignature ? { thinkingSignature: block.thinkingSignature } : {}),
        ...(block.redacted ? { redacted: block.redacted } : {}),
      };
      result.push(tc);
    }
  }
  return result;
}

// ─── Provider creation ────────────────────────────────────────────────────

/**
 * Create an LLMProvider backed by pi-ai for the given provider/model.
 *
 * This is the main factory — it uses pi-ai's `getModel()` to resolve the
 * model, then wraps `complete()` and `stream()` behind our LLMProvider interface.
 */
export function createPiProvider(config: {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Pre-built pi-ai Model object. Bypasses `getModel()` lookup — use for
   *  providers not registered in pi-ai's catalog (e.g. Moonshot's open
   *  platform), where the `Model<"openai-completions">` shape is
   *  hand-constructed by the caller. When set, `config.model` /
   *  `config.baseUrl` are ignored (the Model already carries them). */
  customModel?: Model<Api>;
  /** Explicit compatible endpoint cache capabilities; absent keeps SDK defaults. */
  promptCachePolicy?: PromptCachePolicy;
  /** Private host user namespace; hashed into explicit cache keys, never sent raw. */
  cacheNamespace?: string;
  /** Each pi-ai provider invokes `options.onPayload?(params, model)`
   *  after `buildParams` and before sending the request, allowing the
   *  callback to return new params that overwrite the originals.
   *  Forwarded directly to pi-ai's hook of the same name; the upper
   *  layer can use it to inject vendor server-side tools (e.g.
   *  `{type:"web_search_preview"}`) without modifying pi-ai source. */
  onPayload?: (params: unknown, model: Model<Api>) => unknown | Promise<unknown>;
  /** Default thinking level applied when the caller does not pass
   *  `params.reasoning`. Set this for models whose API requires
   *  `reasoning_effort` to be present whenever `model.reasoning === true` —
   *  notably DeepSeek V4 Pro, which 400s with a misleading
   *  "reasoning_content in the thinking mode must be passed back" error if
   *  the request lacks `reasoning_effort` while the assistant history
   *  carries `reasoning_content`. The caller can still pass
   *  `params.reasoning: 'off'` to bypass this default for a specific call
   *  (e.g. cost-sensitive utility calls). */
  defaultReasoning?: "minimal" | "low" | "medium" | "high";
}): LLMProvider {
  const providerId = config.provider as KnownProvider;

  // Resolve the model object. `customModel` shortcuts pi-ai's catalog
  // lookup for providers pi-ai doesn't know about.
  let resolvedModel: Model<Api> | undefined = config.customModel;
  if (!resolvedModel && config.model) {
    try {
      resolvedModel = getModel(providerId as any, config.model as any);
    } catch {
      // Model not found in pi-ai catalog — will be resolved later per-request
    }
  }

  // If baseUrl is overridden, create a custom model
  if (config.baseUrl && resolvedModel && !config.customModel) {
    resolvedModel = { ...resolvedModel, baseUrl: config.baseUrl };
  }

  // Resolve the effective ThinkingLevel for a single call. Pi-ai accepts
  // ThinkingLevel | undefined; our `'off'` is a meta-value meaning "skip the
  // provider default", not a pi-ai level. Caller's explicit `'off'` always
  // wins; otherwise fall back to the provider's `defaultReasoning`.
  const effectiveReasoning = (
    paramReasoning: CompletionParams["reasoning"],
  ): "minimal" | "low" | "medium" | "high" | undefined => {
    if (paramReasoning === "off") return undefined;
    if (paramReasoning) return paramReasoning;
    return config.defaultReasoning;
  };

  const provider: LLMProvider = {
    id: providerId,
    name: providerId.charAt(0).toUpperCase() + providerId.slice(1),

    async complete(params: CompletionParams): Promise<CompletionResult> {
      const model = resolveModel(providerId, params.model, resolvedModel, config.baseUrl);
      const context = buildPiContext(params.messages, params.systemPrompt, params.tools, model);
      const reasoning = effectiveReasoning(params.reasoning);
      const { sdkSessionId, onPayload, headers, audit, sdkModel, trace } = requestOptions(config, model, params);
      const capture = model.api === 'openai-completions' || model.api === 'openai-responses'
        ? new OpenAIWireCapture({ baseUrl: model.baseUrl,
            api: model.api === 'openai-responses' ? 'openai-responses' : 'openai-completions' }) : undefined;

      log.debug(`complete ${providerId}/${model.id}`);

      try {
        let result: PiAssistantMessage;

        const options = {
          apiKey: config.apiKey, transport: CORE_AGENT_TRANSPORT,
          signal: params.signal, maxTokens: params.maxTokens,
          temperature: params.temperature, cacheRetention: params.cacheRetention,
          sessionId: sdkSessionId, headers, ...(onPayload ? { onPayload: onPayload as any } : {}),
        };
        const invoke = () => reasoning
          ? piCompleteSimple(sdkModel, context, { ...options, reasoning })
          : piComplete(sdkModel, context, options);
        result = await (capture ? capture.run(invoke) : invoke());

        if (result.stopReason === "error") {
          // Error responses can omit usage. Diagnostics must never replace the
          // provider's status with a mapper error (or make a 400 retryable).
          if (result.usage) wireResult(capture, result.usage, (result as any).responseModel,
            audit, model.id, trace, 'error', result.content);
          throw providerResultError(result, providerId);
        }
        const observed = wireResult(capture, result.usage, (result as any).responseModel,
          audit, model.id, trace, 'completed', result.content);
        return {
          content: mapContent(result.content), stopReason: mapStopReason(result.stopReason),
          usage: observed.usage, model: model.id,
          ...(observed.reportedModel ? { reportedModel: observed.reportedModel } : {}),
        };
      } catch (err) {
        logRequestUsage(trace, 'error');
        throw wrapError(err, providerId);
      }
    },

    async *stream(params: CompletionParams): AsyncIterable<StreamEvent> {
      const model = resolveModel(providerId, params.model, resolvedModel, config.baseUrl);
      const context = buildPiContext(params.messages, params.systemPrompt, params.tools, model);
      const reasoning = effectiveReasoning(params.reasoning);
      const { sdkSessionId, onPayload, headers, audit, sdkModel, trace } = requestOptions(config, model, params);
      const capture = model.api === 'openai-completions' || model.api === 'openai-responses'
        ? new OpenAIWireCapture({ baseUrl: model.baseUrl,
            api: model.api === 'openai-responses' ? 'openai-responses' : 'openai-completions' }) : undefined;

      // Request identity + whether the routing headers actually ride along. The
      // 2026-10-13 pattern was "first attempt 400 MissingSessionID, retry fine", so the
      // next step is comparing these two lines instead of guessing again.
      log.info(
        `stream ${providerId}/${model.id} customModel=${config.customModel ? 'yes' : 'no'}`
        + ` headers=${model.headers ? Object.keys(model.headers).sort().join(',') : '-'}`,
      );
      log.debug(`stream ${providerId}/${model.id}`);

      try {
        const invoke = () => reasoning
          ? piStreamSimple(sdkModel, context, {
              apiKey: config.apiKey,
              transport: CORE_AGENT_TRANSPORT,
              signal: params.signal,
              maxTokens: params.maxTokens,
              temperature: params.temperature,
              reasoning,
              cacheRetention: params.cacheRetention,
              sessionId: sdkSessionId,
              // pi-ai reads request headers from these per-call options, NOT from the
              // Model object — omitting them silently dropped `x-opencode-session`, so
              // OpenCode-fronting endpoints answered 400 {"type":"MissingSessionID"}
              // (2026-10-13, three attempts: the header was set on the Model all along).
              headers,
              ...(onPayload ? { onPayload: onPayload as any } : {}),
              // Diagnostics (2026-10-13): identify WHICH request the endpoint rejects.
              // pi-ai calls this once per HTTP response with the status, so a 400 can be
              // tied to a concrete call instead of the whole turn.
              onResponse: (info: any) => {
                try {
                  log.info(
                    `stream response ${providerId}/${model.id}`
                    + ` status=${info?.status ?? "-"}`
                    + ` endpoint=${new URL(model.baseUrl).hostname}`,
                  );
                } catch { /* diagnostics must never break the stream */ }
              },
            })
          : piStream(sdkModel, context, {
              apiKey: config.apiKey,
              transport: CORE_AGENT_TRANSPORT,
              signal: params.signal,
              maxTokens: params.maxTokens,
              temperature: params.temperature,
              cacheRetention: params.cacheRetention,
              sessionId: sdkSessionId,
              // pi-ai reads request headers from these per-call options, NOT from the
              // Model object — omitting them silently dropped `x-opencode-session`, so
              // OpenCode-fronting endpoints answered 400 {"type":"MissingSessionID"}
              // (2026-10-13, three attempts: the header was set on the Model all along).
              headers,
              ...(onPayload ? { onPayload: onPayload as any } : {}),
              // Diagnostics (2026-10-13): identify WHICH request the endpoint rejects.
              // pi-ai calls this once per HTTP response with the status, so a 400 can be
              // tied to a concrete call instead of the whole turn.
              onResponse: (info: any) => {
                try {
                  log.info(
                    `stream response ${providerId}/${model.id}`
                    + ` status=${info?.status ?? "-"}`
                    + ` endpoint=${new URL(model.baseUrl).hostname}`,
                  );
                } catch { /* diagnostics must never break the stream */ }
              },
            });

        const eventStream = capture ? capture.run(invoke) : invoke();
        for await (const event of eventStream) {
          switch (event.type) {
            case "start":
              yield { type: "message_start" };
              break;
            case "thinking_delta":
              // 模型思考流（交互设计 2026-09-08：思考过程展示）：pi-ai 的
              // thinking_delta 原先落 default 被丢弃——转发为内部
              // thinking_delta，runner/event-mapper 继续向渲染层透传。
              yield { type: "thinking_delta", delta: event.delta };
              break;
            case "text_delta":
              yield { type: "text_delta", text: event.delta };
              break;
            case "toolcall_start":
              yield {
                type: "tool_use_start",
                id: event.partial.content[event.contentIndex]?.type === "toolCall"
                  ? (event.partial.content[event.contentIndex] as { id: string }).id
                  : "",
                name: event.partial.content[event.contentIndex]?.type === "toolCall"
                  ? (event.partial.content[event.contentIndex] as { name: string }).name
                  : "",
              };
              break;
            case "toolcall_delta":
              yield { type: "tool_use_delta", id: "", input: event.delta };
              break;
            case "toolcall_end":
              yield { type: "tool_use_end", id: event.toolCall.id };
              break;
            case "done": {
              const observed = wireResult(capture, event.message.usage,
                (event.message as any).responseModel, audit, model.id, trace, 'completed', event.message.content);
              yield {
                type: "message_end",
                stopReason: mapStopReason(event.reason),
                usage: observed.usage,
                content: mapContent(event.message.content),
                model: model.id,
                ...(observed.reportedModel ? { reportedModel: observed.reportedModel } : {}),
              };
              break;
            }
            case "error":
              if (event.error.usage) wireResult(capture, event.error.usage, (event.error as any).responseModel, audit, model.id,
                trace, 'error', event.error.content);
              else logRequestUsage(trace, 'error');
              // Surface everything we can from the stream error event.
              // pi-ai's fetch layer swallows the original Error(cause chain)
              // and only keeps `.message` on `errorMessage`; any extra field
              // the provider adapter exposes (kind/reason/statusCode/...) is
              // still useful and worth logging. Without this the caller
              // sees a bare "fetch failed" string and has no path to the
              // real undici / SDK cause.
              try {
                const pe = (event as any).error;
                const peKeys = pe && typeof pe === 'object' ? Object.keys(pe) : [];
                log.warn(
                  `stream error provider=${providerId} model=${model.id} ` +
                  `msg="${String(pe?.errorMessage || '').slice(0, 200)}" ` +
                  `reason=${pe?.stopReason ?? '-'} ` +
                  `fields=${JSON.stringify(peKeys)}`,
                );
              } catch (_) { /* best-effort */ }
              yield {
                type: "error",
                error: providerResultError(event.error, providerId),
              };
              break;
          }
        }
      } catch (err) {
        logRequestUsage(trace, 'error');
        throw wrapError(err, providerId);
      }
    },

    async validateAuth(): Promise<boolean> {
      try {
        const model = resolveModel(providerId, undefined, resolvedModel, config.baseUrl);
        const result = await piComplete(model, {
          messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
        }, {
          apiKey: config.apiKey,
          transport: CORE_AGENT_TRANSPORT,
          maxTokens: 1,
        });
        return result.stopReason !== "error";
      } catch {
        return false;
      }
    },
  };

  return provider;
}

/** Resolve a pi-ai Model for the given provider + model ID. */
function resolveModel(
  providerId: string,
  modelId?: string,
  cached?: Model<Api>,
  baseUrl?: string,
): Model<Api> {
  // Use cached model if model ID matches
  if (cached && (!modelId || cached.id === modelId)) {
    return baseUrl ? { ...cached, baseUrl } : cached;
  }

  // Try to look up the model. `getModel` returns undefined for unknown
  // (provider, model) pairs — DO NOT return that as a Model; fall through
  // so the next branches (cached / first-of-provider / throw) can run.
  if (modelId) {
    try {
      const m = getModel(providerId as any, modelId as any);
      if (m) return baseUrl ? { ...m, baseUrl } : m;
    } catch {
      // Fall through
    }
  }

  // If we have a cached model, use it
  if (cached) {
    return baseUrl ? { ...cached, baseUrl } : cached;
  }

  // Pick first available model for this provider
  const models = getModels(providerId as any);
  if (models.length > 0) {
    return baseUrl ? { ...models[0], baseUrl } : models[0];
  }

  throw new ProviderError(`No model found for provider: ${providerId}`, providerId);
}

/** Restore HTTP status when pi-ai returns a serialized failure result. */
function providerResultError(result: unknown, providerId: string): ProviderError {
  const record = result as Record<string, unknown>;
  const message = typeof record?.errorMessage === 'string' ? record.errorMessage : 'Unknown provider error';
  // pi-ai often serializes SDK APIError into errorMessage and drops status.
  // Recover only recognized HTTP error prefixes, never arbitrary numbers in
  // request ids, model names or quoted payload fields. Structured status wins.
  const rawStatus = record?.statusCode ?? record?.status ?? record?.httpStatus ?? record?.http_status;
  const structured = Number(rawStatus);
  const prefix = message.match(/^(?:(?:OpenAI|Anthropic|Google|Gemini)(?: Responses)? API error\s*\((\d{3})\):|(?:HTTP\s+)?(\d{3})\b)/i);
  const inferred = prefix ? Number(prefix[1] || prefix[2]) : undefined;
  const candidate = Number.isInteger(structured) && structured >= 400 && structured <= 599
    ? structured : inferred;
  const status = candidate !== undefined && candidate >= 400 && candidate <= 599 ? candidate : undefined;
  return new ProviderError(message, providerId, status);
}

/** Wrap thrown SDK errors, retaining their cause and structured status for
 * credential rotation and retry classification. */
function wrapError(err: unknown, providerId: string): Error {
  if (err instanceof AuthError || err instanceof RateLimitError || err instanceof ContextOverflowError || err instanceof ProviderError) {
    return err;
  }

  const original = err instanceof Error ? err : undefined;
  const msg = err instanceof Error ? err.message : String(err);
  const msgLower = msg.toLowerCase();

  if (msgLower.includes("401") || msgLower.includes("403") || msgLower.includes("authentication") || msgLower.includes("unauthorized")) {
    return new AuthError(`${providerId} auth failed: ${msg}`, original);
  }
  if (msgLower.includes("429") || msgLower.includes("rate limit") || msgLower.includes("too many requests")) {
    return new RateLimitError(`${providerId} rate limited: ${msg}`, undefined, original);
  }
  if (msgLower.includes("context") && (msgLower.includes("overflow") || msgLower.includes("too long") || msgLower.includes("maximum"))) {
    return new ContextOverflowError(`${providerId} context overflow: ${msg}`, original);
  }

  // Generic ProviderError — try to forward `status` from the underlying
  // SDK error (Anthropic / OpenAI both expose `.status` on APIError).
  const status = original && typeof (original as any).status === 'number'
    ? (original as any).status as number
    : undefined;
  return new ProviderError(msg, providerId, status, original);
}

// ─── Convenience factories for specific providers ─────────────────────────

/** Create an Anthropic provider using pi-ai. */
export function createAnthropicProvider(config: {
  apiKey?: string;
  baseUrl?: string;
} = {}): LLMProvider {
  return createPiProvider({
    provider: "anthropic",
    model: "claude-opus-4-8",
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
}

/** Create an OpenAI provider using pi-ai. */
export function createOpenAIProvider(config: {
  apiKey?: string;
  baseUrl?: string;
} = {}): LLMProvider {
  return createPiProvider({
    provider: "openai",
    model: "gpt-4o",
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
}

// ─── Utility exports ──────────────────────────────────────────────────────

/** List all providers available via pi-ai. */
export function listPiProviders(): string[] {
  return getProviders();
}

/** List all models for a provider. */
export function listPiModels(provider: string): Array<{ id: string; name: string; contextWindow: number }> {
  try {
    return getModels(provider as any).map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
    }));
  } catch {
    return [];
  }
}
