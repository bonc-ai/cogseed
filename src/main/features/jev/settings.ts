import { userPreferencesFile, userSemanticaSecretsFile } from '../../paths';
import { readJsonSync, writeJsonSync } from '../../storage';
import * as appConfig from '../config';
import * as localSecrets from '../../util/local-secret-store';
import {
  JEV_DEFAULT_MAX_RETRIES,
  JEV_DEFAULT_TIMEOUT_MS,
  JEV_GATES,
  type JevClientConfig,
  type JevGate,
} from './types';

export const DEFAULT_JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_JEV_MODEL = 'jev-latest';

export interface SemanticaSettings {
  semanticaEnabled: boolean;
  jevEnabled: boolean;
  endpoint: string;
  model: string;
  gates: JevGate[];
  timeoutMs: number;
  maxRetries: number;
}

interface SemanticaPreferenceShape {
  semantica_enabled?: boolean;
  jev_enabled?: boolean;
  jev_endpoint?: string;
  jev_model?: string;
  jev_gates?: JevGate[];
  jev_timeout_ms?: number;
  jev_max_retries?: number;
}

interface SecretFile { version?: number; secrets_enc?: string }

const SECRET_CONTEXT = 'jev-api-key';
const testStatus = new Map<string, 'connected' | 'failed'>();

function secretContext(userId: string): localSecrets.LocalSecretContext {
  return { namespace: 'semantica.jev', ownerId: userId, recordId: SECRET_CONTEXT };
}

function boolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return undefined;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function normalizedGates(value: unknown): JevGate[] {
  if (!Array.isArray(value)) return [...JEV_GATES];
  const requested = new Set(value);
  const gates = JEV_GATES.filter((gate) => requested.has(gate));
  return gates.length ? gates : [...JEV_GATES];
}

export function readSemanticaSettings(userId?: string): SemanticaSettings {
  const prefs = (userId
    ? readJsonSync<SemanticaPreferenceShape>(userPreferencesFile(userId))
    : appConfig.readPreferences()) as SemanticaPreferenceShape;
  return {
    semanticaEnabled: prefs.semantica_enabled === true,
    jevEnabled: prefs.jev_enabled === true,
    endpoint: typeof prefs.jev_endpoint === 'string' && prefs.jev_endpoint.trim()
      ? prefs.jev_endpoint.trim() : DEFAULT_JEV_ENDPOINT,
    model: typeof prefs.jev_model === 'string' && prefs.jev_model.trim()
      ? prefs.jev_model.trim() : DEFAULT_JEV_MODEL,
    gates: normalizedGates(prefs.jev_gates),
    timeoutMs: boundedInt(prefs.jev_timeout_ms, JEV_DEFAULT_TIMEOUT_MS, 100, 10_000),
    maxRetries: boundedInt(prefs.jev_max_retries, JEV_DEFAULT_MAX_RETRIES, 0, 2),
  };
}

export function updateSemanticaSettings(input: Partial<SemanticaSettings>): SemanticaSettings {
  const current = readSemanticaSettings();
  const next: SemanticaSettings = {
    semanticaEnabled: typeof input.semanticaEnabled === 'boolean' ? input.semanticaEnabled : current.semanticaEnabled,
    jevEnabled: typeof input.jevEnabled === 'boolean' ? input.jevEnabled : current.jevEnabled,
    endpoint: typeof input.endpoint === 'string' && input.endpoint.trim() ? input.endpoint.trim() : current.endpoint,
    model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : current.model,
    gates: input.gates === undefined ? current.gates : normalizedGates(input.gates),
    timeoutMs: boundedInt(input.timeoutMs, current.timeoutMs, 100, 10_000),
    maxRetries: boundedInt(input.maxRetries, current.maxRetries, 0, 2),
  };
  // Turning off the parent feature also turns off Jev. The remaining Jev
  // fields and encrypted key are deliberately preserved for later re-entry.
  if (!next.semanticaEnabled) next.jevEnabled = false;
  const endpoint = new URL(next.endpoint);
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') throw new Error('invalid Jev endpoint');
  appConfig.writePreferences({
    semantica_enabled: next.semanticaEnabled,
    jev_enabled: next.jevEnabled,
    jev_endpoint: next.endpoint,
    jev_model: next.model,
    jev_gates: next.gates,
    jev_timeout_ms: next.timeoutMs,
    jev_max_retries: next.maxRetries,
  });
  return next;
}

export function readJevApiKey(userId: string): string {
  const file = readJsonSync<SecretFile>(userSemanticaSecretsFile(userId));
  if (!file.secrets_enc) return '';
  try {
    return localSecrets.decryptLocalSecret(secretContext(userId), file.secrets_enc);
  } catch {
    return '';
  }
}

export function writeJevApiKey(userId: string, apiKey: string): void {
  const value = apiKey.trim();
  if (!value) return;
  writeJsonSync(userSemanticaSecretsFile(userId), {
    version: 1,
    secrets_enc: localSecrets.encryptLocalSecret(secretContext(userId), value),
  });
  testStatus.delete(userId);
}

export interface JevRuntimeEnvironment extends NodeJS.ProcessEnv {
  COGSEED_SEMANTICA_ENABLED?: string;
  COGSEED_JEV_ENABLED?: string;
  COGSEED_JEV_ENDPOINT?: string;
  COGSEED_JEV_MODEL?: string;
  COGSEED_JEV_API_KEY?: string;
  COGSEED_JEV_GATES?: string;
  COGSEED_JEV_TIMEOUT_MS?: string;
  COGSEED_JEV_MAX_RETRIES?: string;
}

/** Explicit environment values override UI settings; absent values inherit UI settings. */
export function resolveSemanticaRuntime(userId: string, env: JevRuntimeEnvironment = process.env): {
  semanticaEnabled: boolean;
  gates: JevGate[];
  config: JevClientConfig;
} {
  const saved = readSemanticaSettings(userId);
  const semanticaEnabled = boolEnv(env.COGSEED_SEMANTICA_ENABLED) ?? saved.semanticaEnabled;
  const jevEnabled = boolEnv(env.COGSEED_JEV_ENABLED) ?? saved.jevEnabled;
  const envGates = env.COGSEED_JEV_GATES?.split(',').map((gate) => gate.trim());
  const gates = envGates ? normalizedGates(envGates) : saved.gates;
  return {
    semanticaEnabled,
    gates,
    config: {
      enabled: semanticaEnabled && jevEnabled,
      endpoint: env.COGSEED_JEV_ENDPOINT?.trim() || saved.endpoint,
      model: env.COGSEED_JEV_MODEL?.trim() || saved.model,
      apiKey: env.COGSEED_JEV_API_KEY?.trim() || readJevApiKey(userId),
      timeoutMs: boundedInt(env.COGSEED_JEV_TIMEOUT_MS, saved.timeoutMs, 100, 10_000),
      maxRetries: boundedInt(env.COGSEED_JEV_MAX_RETRIES, saved.maxRetries, 0, 2),
    },
  };
}

export function isSemanticaEnabled(userId: string, env: JevRuntimeEnvironment = process.env): boolean {
  return resolveSemanticaRuntime(userId, env).semanticaEnabled;
}

export function settingsView(userId: string): Record<string, unknown> {
  const saved = readSemanticaSettings(userId);
  const runtime = resolveSemanticaRuntime(userId);
  const hasApiKey = !!runtime.config.apiKey;
  const status = !runtime.semanticaEnabled ? 'disabled'
    : runtime.config.enabled !== true ? 'disabled'
      : !hasApiKey ? 'not_configured'
        : testStatus.get(userId) || 'configured';
  return {
    ...saved,
    hasApiKey,
    semanticaStatus: runtime.semanticaEnabled ? 'running' : 'disabled',
    jevStatus: status,
    degraded: runtime.semanticaEnabled && runtime.config.enabled === true && status !== 'connected',
  };
}

export async function testJevConnection(userId: string): Promise<{
  ok: boolean;
  status: string;
  reason?: string;
  code?: string;
  httpStatus?: number;
}> {
  const runtime = resolveSemanticaRuntime(userId);
  if (!runtime.semanticaEnabled || runtime.config.enabled !== true || !runtime.config.apiKey) {
    testStatus.set(userId, 'failed');
    return { ok: false, status: 'not_configured', reason: 'Jev is disabled or missing an API key' };
  }
  if (!/^apikey_[\x21-\x7e]+$/u.test(runtime.config.apiKey)) {
    testStatus.set(userId, 'failed');
    return {
      ok: false,
      status: 'failed',
      code: 'invalid_api_key_format',
      reason: 'API Key 格式不正确，请重新粘贴以 apikey_ 开头的完整密钥',
    };
  }
  const { createJevClient } = await import('./adapter');
  const client = createJevClient(runtime.config);
  const result = await client.evaluate({
    requestId: `settings-test-${Date.now()}`,
    gate: 'intent',
    question: { id: 'synthetic-connection-test', kind: 'choice', text: 'Select the supported synthetic candidate.' },
    query: 'Synthetic connection test. No user or asset content is included.',
    candidates: [{ id: 'synthetic-ok', summary: 'Synthetic candidate used only to verify connectivity.', source: 'semantic' }],
  });
  if (result.status === 'ok') {
    testStatus.set(userId, 'connected');
    return { ok: true, status: 'connected' };
  }
  testStatus.set(userId, 'failed');
  const code = result.httpStatus === 401 || result.httpStatus === 403 ? 'authentication_failed'
    : result.httpStatus === 404 ? 'endpoint_not_found'
      : result.httpStatus === 451 ? 'access_restricted'
      : result.reason;
  const reason = code === 'authentication_failed' ? 'API Key 无效或无权访问 Jev（401/403）'
    : code === 'endpoint_not_found' ? 'Jev 接口地址不存在（404）'
      : code === 'access_restricted' ? '当前网络或地区无法访问 Jev 服务（451），Semantica 将继续使用本地确定性链路'
      : code === 'rate_limited' ? 'Jev 请求过于频繁，请稍后重试（429）'
        : code === 'timeout' ? '连接 Jev 超时，请检查网络或调大超时时间'
          : code === 'invalid_response' ? 'Jev 已响应，但返回格式与当前适配器不兼容'
            : code === 'network_error' ? `无法建立 Jev 网络连接${result.networkCode ? `（${result.networkCode}）` : ''}`
              : result.providerMessage || `Jev 请求失败（${result.reason}）`;
  return {
    ok: false,
    status: 'failed',
    reason,
    code,
    ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
  };
}
