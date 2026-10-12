import { randomUUID } from 'node:crypto';
import { app } from 'electron';

import { createLogger } from '../../logger';
import { desktopPlatform, type DesktopPlatform } from '../../system_info';
import { getCurrentLang } from '../../i18n';
import { apiBase } from '../marketplace';
import { ensureFreshSession } from '../hub_account';

const log = createLogger('contribution/hub-client');
const REQUEST_TIMEOUT_MS = 30_000;

export type ContributionErrorCode =
  | 'INVALID_REQUEST' | 'UNEXPECTED_FIELD' | 'AUTH_REQUIRED' | 'ACCOUNT_UNAVAILABLE'
  | 'NOT_CONTRIBUTOR' | 'DISPLAY_NAME_REQUIRED' | 'CLIENT_VERSION_UNSUPPORTED'
  | 'CONTRIBUTION_CLOSED' | 'CONTENT_NOT_FOUND' | 'SUBMISSION_NOT_FOUND'
  | 'SUBMISSION_NOT_PENDING' | 'IDEMPOTENCY_KEY_CONFLICT' | 'WITHDRAWAL_PENDING_EXISTS'
  | 'VERSION_WITHDRAWAL_UNSUPPORTED' | 'PENDING_LIMIT_EXCEEDED' | 'TERMS_VERSION_MISMATCH'
  | 'DECLARATION_MISSING' | 'FORKED_FROM_REQUIRED' | 'LOCAL_CHECK_NOT_CLEAN'
  | 'PACKAGE_REJECTED' | 'PACKAGE_DIGEST_MISMATCH' | 'VERSION_NOT_HIGHER'
  | 'CONTENT_NOT_COMMUNITY' | 'PAYLOAD_TOO_LARGE' | 'AUTH_UPSTREAM_UNAVAILABLE'
  | 'INTERNAL_ERROR' | 'UNKNOWN_ERROR';

export class ContributionApiError extends Error {
  constructor(
    public readonly code: ContributionErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly requestId: string | null,
    public readonly details: Record<string, unknown> | null,
  ) { super(message); }
}

type JsonObject = Record<string, unknown>;

/**
 * 契约 C-00 的 `X-CogSeed-Platform` **只取** `macos` / `windows`（OpenAPI 的 enum 同）；
 * 而本机平台标识来自 `system_info.desktopPlatform()`，词表是 `mac` / `windows` / `pc`。
 * 两者不是同一个词表，必须在这个**上线边界**上显式换算——直接把 `mac` 透传出去会被 Hub
 * 按 `INVALID_REQUEST`（`平台取值必须是 macos / windows`）拒绝，而且该闸门是**所有已登录
 * 贡献接口**的统一前置（提交 / 状态回读 / 撤回 / 我的贡献 / 撤回申请都会失败）。
 *
 * `pc`（非 mac/win 的源码运行）在契约里没有对应值，这里**不做猜测性映射**：原样发出、
 * 由 Hub 拒绝，比把一个平台说成另一个平台诚实。
 */
export function platformWireValue(platform: DesktopPlatform): string {
  return platform === 'mac' ? 'macos' : platform;
}

/**
 * 客户端 app 版本（`X-CogSeed-Client-Version` 与 `local_check.checker.version` 的**同一来源**）。
 *
 * C03 §1：`checker.version` 在客户端侧就是 app 版本。此前 `ipc/contribution.ts` 另读
 * `process.env.COGSEED_APP_VERSION || npm_package_version`，源码运行下两者都没有，于是
 * `local_check.checker` 落库成 `0.0.0`，而同一请求的版本头是 `app.getVersion()`（`1.2.0`）——
 * 同一个请求里两个版本号不一致，运营在后台看到的检查器版本是错的。这里统一到一处。
 */
export function clientAppVersion(): string {
  let version = process.env.COGSEED_APP_VERSION || process.env.npm_package_version || '';
  try { version = app.getVersion() || version; } catch { /* tests/pre-ready */ }
  return version || '0.0.0';
}

function requestHeaders(token?: string, requestId = randomUUID()): Record<string, string> {
  return {
    Accept: 'application/json',
    'Accept-Language': getCurrentLang() || 'en',
    'X-CogSeed-Client-Version': clientAppVersion(),
    'X-CogSeed-Platform': platformWireValue(desktopPlatform()),
    'X-CogSeed-Request-ID': requestId,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

async function parseEnvelope(res: Response): Promise<JsonObject> {
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = null; }
  const data = object(parsed);
  if (!data || typeof data.code !== 'number') {
    throw new ContributionApiError('UNKNOWN_ERROR', 'Invalid Hub response', res.status, res.status >= 500, null, null);
  }
  if (data.code !== 0 || !res.ok) {
    const error = object(data.error);
    const rawCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN_ERROR';
    const message = typeof error?.message === 'string' ? error.message : (typeof data.msg === 'string' ? data.msg : 'Hub request failed');
    throw new ContributionApiError(
      rawCode as ContributionErrorCode,
      message.slice(0, 1000),
      res.status,
      error?.retryable === true,
      typeof data.request_id === 'string' ? data.request_id : null,
      object(error?.details),
    );
  }
  return data;
}

async function fetchEnvelope(pathname: string, init: RequestInit, externalSignal?: AbortSignal): Promise<JsonObject> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  if (externalSignal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await parseEnvelope(await fetch(`${apiBase()}${pathname}`, { ...init, signal: controller.signal }));
  } catch (err) {
    if (err instanceof ContributionApiError) throw err;
    const timeout = (err as Error).name === 'AbortError';
    log.warn('contribution request unavailable', { pathname, category: timeout ? 'timeout' : 'network' });
    throw new ContributionApiError('UNKNOWN_ERROR', timeout ? 'Request timed out' : 'Hub unavailable', 0, true, null, null);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

async function authorized(userId: string): Promise<{ token: string; headers: Record<string, string> }> {
  const session = await ensureFreshSession(userId);
  return { token: session.access_token, headers: requestHeaders(session.access_token) };
}

export interface SubmissionManifest extends JsonObject {
  content_type: 'skill';
  local_skill_id: string;
  target_content_id: string | null;
  package_digest: string;
  package_size: number;
  file_list: Array<{ path: string; size: number; sha256: string }>;
  metadata: { name: string; description: string; version: string };
  declarations: JsonObject;
  local_check: JsonObject;
}

function assertCurrentManifest(manifest: SubmissionManifest): void {
  if (Object.prototype.hasOwnProperty.call(manifest.local_check, 'components')) {
    throw new Error('components_contract_not_frozen');
  }
  if (Object.prototype.hasOwnProperty.call(manifest, 'icon')) throw new Error('icon_contract_not_frozen');
}

export async function readTerms(etag?: string): Promise<{ notModified: boolean; etag: string | null; body: JsonObject | null }> {
  const headers = requestHeaders();
  if (etag) headers['If-None-Match'] = etag;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase()}/marketplace/contributions/terms`, { headers, signal: controller.signal });
    if (res.status === 304) return { notModified: true, etag, body: null };
    return { notModified: false, etag: res.headers.get('etag'), body: await parseEnvelope(res) };
  } finally { clearTimeout(timer); }
}

export async function createSubmission(userId: string, args: {
  idempotencyKey: string;
  manifest: SubmissionManifest;
  packageBytes: Buffer;
  signal?: AbortSignal;
}): Promise<JsonObject> {
  assertCurrentManifest(args.manifest);
  const { headers } = await authorized(userId);
  headers['Idempotency-Key'] = args.idempotencyKey;
  const form = new FormData();
  form.append('manifest', new Blob([JSON.stringify(args.manifest)], { type: 'application/json' }), 'manifest.json');
  const packageBytes = new Uint8Array(args.packageBytes.byteLength);
  packageBytes.set(args.packageBytes);
  form.append('package', new Blob([packageBytes], { type: 'application/zip' }), 'skill.zip');
  return fetchEnvelope('/marketplace/contributions/submissions', { method: 'POST', headers, body: form }, args.signal);
}

export async function getSubmission(userId: string, submissionId: string): Promise<JsonObject> {
  const { headers } = await authorized(userId);
  return fetchEnvelope(`/marketplace/contributions/submissions/${encodeURIComponent(submissionId)}`, { headers });
}

export async function withdrawSubmission(userId: string, submissionId: string): Promise<JsonObject> {
  const { headers } = await authorized(userId);
  headers['Content-Type'] = 'application/json';
  return fetchEnvelope(`/marketplace/contributions/submissions/${encodeURIComponent(submissionId)}/withdraw`, { method: 'POST', headers, body: '{}' });
}

export async function listMine(userId: string, query: { page?: number; size?: number; updatedSince?: string } = {}): Promise<JsonObject> {
  const { headers } = await authorized(userId);
  const q = new URLSearchParams();
  if (query.page) q.set('page', String(query.page));
  if (query.size) q.set('size', String(Math.min(100, query.size)));
  if (query.updatedSince) q.set('updated_since', query.updatedSince);
  return fetchEnvelope(`/marketplace/contributions/mine${q.size ? `?${q}` : ''}`, { headers });
}

export async function createWithdrawalRequest(userId: string, contentId: string, reason: string): Promise<JsonObject> {
  const { headers } = await authorized(userId);
  headers['Content-Type'] = 'application/json';
  return fetchEnvelope('/marketplace/contributions/withdrawal-requests', {
    method: 'POST', headers, body: JSON.stringify({ content_id: contentId, reason }),
  });
}

export async function listWithdrawalRequests(userId: string, contentId: string): Promise<JsonObject> {
  const { headers } = await authorized(userId);
  return fetchEnvelope(`/marketplace/contributions/withdrawal-requests?content_id=${encodeURIComponent(contentId)}`, { headers });
}
