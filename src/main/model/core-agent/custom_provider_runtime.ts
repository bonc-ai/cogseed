/**
 * Custom provider runtime — turn a stored `CustomProvider` (phase 1) into a
 * pi-ai `Model` object so the built-in chat path can route to it.
 *
 * Mirrors the hand-built-Model pattern in `external-providers.ts`
 * (buildMoonshotModel / buildDeepSeekModel / buildDoubaoModel), but generic:
 * the base URL, protocol dialect, and model id all come from the user's
 * stored record instead of a hard-coded table.
 *
 * ## Synthetic provider id
 *
 * A custom provider surfaces to the rest of the auth/runner machinery under
 * the synthetic provider id `cp:<customProviderId>`. This keeps it distinct
 * from every pi-ai catalog id and every EXTERNAL_API_PROVIDERS id, so the
 * `if (isCustomProviderId(...))` branches added to auth.ts / runner.ts never
 * collide with a real provider. The id round-trips through `entries[]`,
 * `ChatEntryChoice`, cooldown keys, and the model catalog untouched.
 *
 * ## Protocol → pi-ai api dialect
 *
 *   anthropic → 'anthropic-messages'
 *   openai    → 'openai-completions'
 *   gemini    → 'google-generative-ai'
 *
 * We use `openai-completions` (not `openai-responses`) for the OpenAI dialect
 * because third-party OpenAI-compatible relays (the common CC Switch case)
 * implement the classic `/chat/completions` surface, not OpenAI's newer
 * Responses API.
 */

import type { LLMProvider } from '#core-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { listCustomProviders } from '../../features/custom_providers';
import type { CustomProvider } from '../../features/auth';
import { publicModelAbilitiesFor } from '../../model/public_model_catalog';

type CA = typeof import('#core-agent');
let _caPromise: Promise<CA> | null = null;
function ca(): Promise<CA> {
  if (!_caPromise) _caPromise = import('#core-agent') as Promise<CA>;
  return _caPromise;
}

const CUSTOM_PROVIDER_PREFIX = 'cp:';

/** Default context window / max output tokens for a hand-built custom model.
 *  We can't know the real limits of an arbitrary third-party endpoint, so we
 *  reference the unified product defaults (2026-09-13 十进制口径 1M / 384K，
 *  与 auth.ts 的 DEFAULT_CUSTOM_PROVIDER_* 同源同值)。Users can refine
 *  per-model later if needed. */
const DEFAULT_CONTEXT_WINDOW = 1000000;
const DEFAULT_MAX_OUTPUT_TOKENS = 384000;

/** True when a provider id addresses a custom provider (synthetic `cp:` id). */
export function isCustomProviderId(providerId: string): boolean {
  return typeof providerId === 'string' && providerId.startsWith(CUSTOM_PROVIDER_PREFIX);
}

/** Build the synthetic provider id for a stored custom provider. */
export function customProviderId(id: string): string {
  return `${CUSTOM_PROVIDER_PREFIX}${id}`;
}

/** Extract the stored CustomProvider.id from a synthetic `cp:<id>` provider id. */
export function customProviderRawId(providerId: string): string {
  return isCustomProviderId(providerId)
    ? providerId.slice(CUSTOM_PROVIDER_PREFIX.length)
    : providerId;
}

/** Look up the stored record behind a synthetic `cp:<id>` provider id. */
export function findCustomProvider(userId: string, providerId: string): CustomProvider | undefined {
  if (!isCustomProviderId(providerId)) return undefined;
  const rawId = customProviderRawId(providerId);
  return listCustomProviders(userId).find((p) => p.id === rawId);
}

function apiForProtocol(protocol: CustomProvider['protocol']): Api {
  switch (protocol) {
    case 'openai':
      return 'openai-completions' as Api;
    case 'openai-responses':
      return 'openai-responses' as Api;
    case 'gemini':
      return 'google-generative-ai' as Api;
    case 'anthropic':
    default:
      return 'anthropic-messages' as Api;
  }
}

/**
 * OpenCode Zen/Go 端点自 2026-09-05 起要求每个请求带 `x-opencode-session`
 * （服务端做会话路由，缺失直接 400 "cannot be routed correctly"）。pi-ai
 * 自身不注入该头（上游 issue earendil-works/pi#4847，0.85.1 仍未修），
 * 且 CogSeed 的 Model 构造在这里——按端点识别后补上。
 * 值取 provider 级稳定 id：服务端要求"稳定"即可；逐对话一一对应需要请求级
 * 上下文（模型层拿不到），先满足路由的最低要求。
 */
function customProviderHeaders(baseUrl: string, providerId: string): Record<string, string> | undefined {
  if (/^https:\/\/(?:[a-z0-9-]+\.)?opencode\.ai\//i.test(String(baseUrl || ''))) {
    return { 'x-opencode-session': `cogseed-${providerId}` };
  }
  return undefined;
}

/**
 * Hand-build a pi-ai Model for one (custom provider, model id) pair.
 * `baseUrl` is baked into the Model so createPiProvider routes there
 * directly. Cost is left at 0 (local stat display only — the real bill
 * comes from the third-party endpoint).
 */
export function buildCustomProviderModel(
  cp: CustomProvider,
  modelId: string,
  recognition?: { reasoning?: boolean; vision?: boolean },
): Model<Api> {
  const api = apiForProtocol(cp.protocol);
  const metadata = buildCustomProviderModelMeta(cp, modelId);
  const headers = customProviderHeaders(cp.baseUrl, cp.id);
  // 配置 → 调用映射（2026-09-13 全面对齐，子安口径"配置驱动调用"）：
  //   input（输入类型）   配置勾选 > 目录登记 > 识别器，图片直传模型
  //   reasoning（推理）   配置声明了推理等级 > 识别器——没配等级的模型
  //                      不带 reasoning_effort（选了档位也不会盲发参数）
  //   capabilities        system_message → compat.supportsDeveloperRole、
  //                      structured_output → compat.supportsStrictMode；
  //                      native_web_search 按 api 注入（openai-responses），
  //                      openai-completions 通道声明留档不生效
  //   reasoningParamsMap  高级参数映射：落库+校验+展示；运行时注入接线
  //                      留待后续（pi-ai 的 thinkingLevel 已覆盖常规档位）
  const stored = cp.models.find((candidate) => candidate.id === modelId);
  const acceptsImage = (Array.isArray(stored?.input) && stored!.input!.includes('image'))
    || publicModelAbilitiesFor(modelId).vision === true
    || recognition?.vision === true;
  const declaredReasoning = (Array.isArray(stored?.reasoningLevels) && stored!.reasoningLevels!.length > 0)
    || (stored?.reasoningParamsMap && Object.keys(stored!.reasoningParamsMap!).length > 0);
  const capabilities = Array.isArray(stored?.capabilities) ? stored!.capabilities! : [];
  const model: Model<Api> = {
    id: modelId,
    name: modelId,
    api,
    // pi-ai's Provider type accepts arbitrary strings; the synthetic id keeps
    // us clear of catalog collisions.
    provider: customProviderId(cp.id) as any,
    baseUrl: cp.baseUrl,
    ...(headers ? { headers } : {}),
    // 方案 C（参数真透传）：reasoning 按配置声明优先（统一表单「推理等
    // 级」），未声明回退识别器；识别不出（未知模型）保持关闭，不给不认
    // 识的服务盲发参数。
    reasoning: declaredReasoning === true || recognition?.reasoning === true,
    input: acceptsImage ? ['text', 'image'] : ['text'],
    ...(capabilities.includes('system_message') || capabilities.includes('structured_output')
      ? {
        compat: {
          ...(capabilities.includes('system_message') ? { supportsDeveloperRole: true } : {}),
          ...(capabilities.includes('structured_output') ? { supportsStrictMode: true } : {}),
        },
      }
      : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: metadata.contextWindow,
    maxTokens: metadata.maxTokens,
  };
  return model;
}

/** Metadata slice (window sizes) for the runner's model catalog. */
export function buildCustomProviderModelMeta(
  cp: CustomProvider,
  modelId: string,
): { contextWindow: number; maxTokens: number } {
  const id = String(modelId || '').trim();
  const model = cp.models.find((candidate) => candidate.id === id);
  return model
    ? { contextWindow: model.contextWindow, maxTokens: model.maxTokens }
    : { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_OUTPUT_TOKENS };
}

/**
 * Build an LLMProvider wired to a custom provider's endpoint. Async because
 * core-agent is loaded on demand (ESM from CJS main). Does not touch the
 * network — the first request is deferred to the provider's stream/complete.
 */
export async function createCustomProvider(
  userId: string,
  providerId: string,
  apiKey: string,
  modelId: string,
): Promise<LLMProvider> {
  const cp = findCustomProvider(userId, providerId);
  if (!cp) throw new Error(`custom provider not found: ${providerId}`);
  if (!apiKey) throw new Error(`custom provider ${providerId}: apiKey required`);
  if (!modelId) throw new Error(`custom provider ${providerId}: modelId required`);
  const mod = await ca();
  // 识别（方案 C）：知名模型家族按目录能力决定是否透传推理参数。
  let recognition: { reasoning?: boolean; vision?: boolean } | undefined;
  try {
    const { recognizeModelByIdReady } = await import('../model_id_recognition');
    recognition = (await recognizeModelByIdReady(modelId)) || undefined;
  } catch { /* unrecognized → no reasoning forwarding */ }
  const model = buildCustomProviderModel(cp, modelId, recognition);
  return mod.createPiProvider({
    provider: customProviderId(cp.id),
    apiKey,
    customModel: model,
  });
}

/** Default model id to offer when a custom provider has no explicit model
 *  list. Falls back to a protocol-appropriate placeholder the user can edit. */
export function defaultCustomProviderModel(cp: CustomProvider): string {
  if (cp.models.length) return cp.models[0].id;
  return '';
}
