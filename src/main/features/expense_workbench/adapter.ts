import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

import { createLogger } from '../../logger';
import {
  userExpenseWorkbenchConfigFile,
  userExpenseWorkbenchHomeDir,
  userExpenseWorkbenchRuntimeDir,
  userExpenseWorkbenchTempDir,
  userLocalConfigDir,
  runtimeResourcesDir,
  WS_ROOT,
} from '../../paths';
import { getActiveUserId } from '../users';
import { startManagedStdioProcess, type ManagedStdioProcess } from '../../util/managed-stdio-process';
import { ensurePrivateDirectoryWithin } from '../../util/private-directory';
import {
  assertTrustedTarTree,
  extractTrustedTarGzip,
  type TrustedTarTree,
} from '../../util/trusted-tar';
import { assertCanonicalExpenseWorkbenchAgent } from './canonical-agent';
import {
  type ExpenseWorkbenchError,
  type ExpenseWorkbenchOperation,
  type ExpenseWorkbenchProjectConfig,
  type ExpenseWorkbenchProjectStatus,
  type ExpenseWorkbenchResponse,
  type JsonObject,
  type JsonValue,
  EXPENSE_WORKBENCH_EMPLOYEE_OPERATIONS,
  isExpenseWorkbenchExternalOperation,
  isJsonObject,
} from './contracts';
import {
  TRUSTED_EXPENSE_BRIDGE_PATH,
  TRUSTED_EXPENSE_COMPONENT_FILES,
  TRUSTED_EXPENSE_PLATFORM_ARTIFACTS,
  TRUSTED_EXPENSE_COMPONENT_VERSION,
  type TrustedExpenseComponentFile,
  type TrustedPythonArchive,
  type TrustedPythonDistribution,
} from './trusted-component-manifest';

const log = createLogger('expense-workbench:adapter');
const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES = 256 * 1024;
export const MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const WORKBENCH_PRINCIPAL_ROLE = 'employee';
const WORKBENCH_COMPONENT_ID = 'expense-precheck';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BRIDGE_ERROR_CODE_PATTERN = /^(?:[a-z][a-z0-9_]*|[A-Z][A-Z0-9_]*)$/;
const BASE64URL_SHA256_PATTERN = /^sha256=([A-Za-z0-9_-]{43})$/;
const DISTRIBUTION_VERSION_PATTERN = /^[0-9][A-Za-z0-9.!+_-]{0,63}$/;
const RELATIVE_RUNTIME_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+/@-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+@-]*)*$/;
const RUNTIME_ARCHIVE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}\.tar\.gz$/;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_FILES = 4_096;
const MAX_TRUSTED_DEPENDENCY_FILE_BYTES = 32 * 1024 * 1024;
const ARCHIVE_COPY_BUFFER_BYTES = 1024 * 1024;
const EXPENSE_RUNTIME_CACHE_SCHEMA = 2;
const PYTHON_BOOTSTRAP = [
  'import runpy,sys',
  'source_root,site_packages,bridge=sys.argv[1:4]',
  'sys.path[:0]=[source_root,site_packages]',
  'runpy.run_path(bridge,run_name="__main__")',
].join(';');

/** The bridge gets only neutral process settings and a host-selected role.
 * Secrets and privilege-bearing values from Electron's environment are never
 * inherited by the reimbursement child process. */
export function buildExpenseWorkbenchEnvironment(
  _projectRoot: string,
  userId: string,
): NodeJS.ProcessEnv {
  const home = userExpenseWorkbenchHomeDir(userId);
  const temp = userExpenseWorkbenchTempDir(userId);
  const privateHome = ensurePrivateDirectoryWithin(
    WS_ROOT,
    home,
    'Mate 报销组件 HOME 目录不可用',
  );
  const privateTemp = ensurePrivateDirectoryWithin(
    WS_ROOT,
    temp,
    'Mate 报销组件临时目录不可用',
  );
  const lang = typeof process.env.LANG === 'string' && process.env.LANG ? process.env.LANG : undefined;
  const locale = typeof process.env.LC_ALL === 'string' && process.env.LC_ALL
    ? process.env.LC_ALL
    : undefined;
  return {
    HOME: privateHome,
    USERPROFILE: privateHome,
    ...(lang ? { LANG: lang } : {}),
    ...(locale ? { LC_ALL: locale } : {}),
    TMPDIR: privateTemp,
    TEMP: privateTemp,
    TMP: privateTemp,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    WORKBENCH_PRINCIPAL_ROLE,
  };
}

interface PendingRequest {
  resolve: (response: ExpenseWorkbenchResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ExpenseWorkbenchHostRequest {
  host_capability_id?: string;
}

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const approvalRole = z.string().min(1).max(128).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'approval role contains control characters');
const timestamp = z.string().datetime({ offset: true });
const boundedJsonScalar = z.union([z.string().max(16_000), z.number().finite(), z.boolean(), z.null()]);
const boundedJsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  boundedJsonScalar,
  z.array(boundedJsonValue).max(500),
  z.record(z.string().min(1).max(256), boundedJsonValue).refine((value) => Object.keys(value).length <= 500),
]));
const operation = z.enum([
  'manifest', 'health.get', 'identity.get', 'overview.stats', 'applications.list',
  'applications.get', 'applications.create', 'applications.draft', 'applications.precheck',
  'applications.confirm', 'applications.submit', 'applications.report', 'applications.approve',
  'applications.refreshStatus', 'applications.recoverSubmission', 'applications.retryFeishu',
  'applications.retryFeishuNotifications',
  'applications.submitStatus', 'materials.list', 'materials.add', 'materials.addAndBind',
  'materials.delete', 'reviews.list', 'reviews.approve', 'reviews.reject', 'audit.list',
  'settings.get', 'settings.update', 'settings.test', 'settings.preflight', 'settings.models',
  'assistant.inspect', 'assistant.propose',
]);
const operationList = z.array(operation).min(1).max(operation.options.length)
  .refine((values) => new Set(values).size === values.length, 'operations must be unique');
const targetSchema = z.object({
  system: safeId, environment: safeId, adapter: safeId, form_type: safeId, mapping_version: safeId,
}).strict();
const materialSchema = z.object({
  ref: z.string().regex(/^workspace:\/\/mat-[0-9a-f]{32}$/i),
  name: z.string().min(1).max(256),
  media_type: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/heic']),
  size: z.number().int().min(1).max(176 * 1024),
  sha256,
  material_category: z.enum(['expense_receipt', 'travel_itinerary', 'hotel_stay_proof', 'other']),
}).strict();
const applicationSchema = z.object({
  schema_version: z.number().int().min(1).max(10).optional(),
  application_id: safeId,
  application_type: z.enum(['daily_expense', 'travel_expense', 'rental_expense', 'communication_expense']),
  application_type_label: z.string().max(256),
  status: z.string().min(1).max(64),
  current_version: z.number().int().min(0),
  current_payload_hash: sha256,
  external_application_id: z.union([safeId, z.literal('')]).optional(),
  precheck_status: z.string().min(1).max(64),
  confirmation_status: z.enum(['confirmed', 'not_confirmed']),
  oa_status: z.string().min(1).max(64),
  feishu_status: z.string().min(1).max(64),
  target: targetSchema,
  submission_gate: boundedJsonValue.optional(),
  formal_report_gate: boundedJsonValue.optional(),
  created_at: timestamp,
  updated_at: timestamp,
}).strict();
const notificationSchema = z.object({
  schema_version: z.number().int().min(1).max(10),
  notification_id: safeId,
  application_id: safeId,
  event: safeId,
  state: z.enum(['pending', 'in_flight', 'sent', 'failed']),
  attempts: z.number().int().min(0).max(1000),
  message_id: z.string().max(128),
  created_at: timestamp,
  updated_at: timestamp,
}).strict();
const draftSchema = z.object({
  schema_version: z.number().int().min(1).max(10).optional(),
  version_id: safeId.optional(),
  application_id: safeId.optional(),
  version: z.number().int().min(0),
  payload: z.record(z.string().min(1).max(256), boundedJsonValue),
  payload_hash: sha256,
  material_refs: z.array(materialSchema).max(20),
  material_categories: z.record(z.string().regex(/^workspace:\/\/mat-[0-9a-f]{32}$/i), z.enum(['expense_receipt', 'travel_itinerary', 'hotel_stay_proof', 'other'])),
  review_reasons: z.array(z.string().max(4_000)).max(100),
  created_at: timestamp,
}).strict();
const precheckSchema = z.object({
  status: z.enum(['ready', 'needs_review']), policy_version: z.string().min(1).max(128),
  reason_codes: z.array(z.string().min(1).max(256)).max(500), application_id: safeId,
  version: z.number().int().min(0),
  run_id: safeId.optional(), artifact_hash: sha256.optional(),
  approval_subject_hash: sha256.optional(), bundle_hash: sha256.optional(),
  required_approval_roles: z.array(approvalRole).max(32).optional(),
  unassigned_approval_roles: z.array(approvalRole).max(32).optional(),
}).strict();
const reportLineSchema = z.object({
  line_id: z.string().max(128), expense_type: z.string().max(256), category: z.string().max(256),
  amount: z.number().finite(), currency: z.string().max(16), merchant: z.string().max(256),
  expense_date: z.string().max(32), description: z.string().max(4_000), invoice_number: z.string().max(256),
  validation_status: z.string().max(256), validation_issues: z.array(boundedJsonValue).max(500),
  compliance_result: z.string().max(256), approved_amount: z.number().finite(),
  verification_id: z.string().max(256), verification_method: z.string().max(256),
  verification_is_authentic: z.boolean(), verification_is_reimbursable: z.boolean(),
  verification_issues: z.array(boundedJsonValue).max(500), evidence_refs: z.array(z.string().max(256)).max(500),
}).strict();
const reportSchema = z.record(z.string().min(1).max(256), boundedJsonValue)
  .refine((value) => Object.keys(value).length <= 200, 'report contains too many fields');
const applicationBundleSchema = z.object({
  application: applicationSchema, draft: draftSchema, materials: z.array(materialSchema).max(20),
  feishu_notifications: z.array(notificationSchema).max(100).optional(),
  unified_precheck: precheckSchema.optional(), report: reportSchema.optional(),
  approval: z.object({
    status: z.enum(['unavailable', 'pending', 'approved', 'rejected']),
    required_roles: z.array(approvalRole).max(32), pending_roles: z.array(approvalRole).max(32),
    approved_roles: z.array(approvalRole).max(32), rejected_roles: z.array(approvalRole).max(32),
    artifact_hash: z.union([sha256, z.literal('')]), subject_hash: z.union([sha256, z.literal('')]),
    can_decide: z.boolean().optional(),
  }).strict().optional(),
}).strict();
const confirmationSchema = z.object({
  status: z.literal('confirmed'), confirmed_at: timestamp, version: z.number().int().min(1),
  payload_hash: sha256, review_required: z.literal(true),
}).strict();
const reviewSchema = z.object({
  task_id: z.string().regex(/^hitl-[0-9]{8}-[0-9a-f]{8}$/), application_id: safeId,
  status: z.enum(['pending', 'approved', 'rejected', 'expired']), trigger_source: z.string().max(64).optional(),
  trigger_reason: z.string().max(1_000).optional(), suggested_action: z.enum(['approve', 'reject', 'manual_review']).optional(),
  created_at: timestamp.optional(), reviewed_at: timestamp.optional(),
}).strict();
const externalResultSchema = z.object({ application: applicationSchema, external_status: boundedJsonValue }).strict();
const approvalResultSchema = z.object({
  approval_id: safeId, application_id: safeId, application_version: z.number().int().min(1),
  approval_role: approvalRole, status: z.enum(['approved', 'rejected']), decision: z.enum(['approve', 'reject']),
  acted_at: timestamp, subject_hash: sha256, artifact_hash: sha256, bundle_hash: sha256,
}).strict();

const RESPONSE_RESULT_SCHEMAS: Readonly<Record<ExpenseWorkbenchOperation, z.ZodType<JsonObject>>> = {
  manifest: z.object({ protocol_version: z.literal(1), component_id: z.literal(WORKBENCH_COMPONENT_ID), component_version: z.literal(TRUSTED_EXPENSE_COMPONENT_VERSION), operations: operationList, data_scope: z.literal('isolated_host_user') }).strict(),
  'health.get': z.object({ status: z.enum(['ready', 'degraded']), component_version: z.literal(TRUSTED_EXPENSE_COMPONENT_VERSION), checks: z.object({ domain_store: z.enum(['ready', 'unavailable']), data_scope: z.literal('isolated_host_user'), external_connections: z.literal('unconfigured') }).strict() }).strict(),
  'identity.get': z.object({ role: z.enum(['employee', 'reviewer']), capabilities: operationList }).strict(),
  'overview.stats': z.object({ total_applications: z.number().int().min(0), status_counts: z.record(z.string(), z.number().int().min(0)) }).strict(),
  'applications.list': z.object({ applications: z.array(applicationSchema).max(100) }).strict(),
  'applications.get': applicationBundleSchema,
  'applications.create': applicationBundleSchema,
  'applications.draft': applicationBundleSchema,
  'applications.precheck': precheckSchema,
  'applications.confirm': z.object({ application: applicationSchema, confirmation: confirmationSchema }).strict(),
  'applications.submit': z.object({ application: applicationSchema, submission: boundedJsonValue }).strict(),
  'applications.report': z.object({ status: z.string().min(1).max(64), application_id: safeId, version: z.number().int().min(0), report: reportSchema }).strict(),
  'applications.approve': approvalResultSchema,
  'applications.refreshStatus': externalResultSchema,
  'applications.recoverSubmission': externalResultSchema,
  'applications.retryFeishu': externalResultSchema,
  'applications.retryFeishuNotifications': externalResultSchema,
  'applications.submitStatus': externalResultSchema,
  'materials.list': z.object({ materials: z.array(materialSchema).max(20) }).strict(),
  'materials.add': z.object({ material: materialSchema }).strict(),
  'materials.addAndBind': z.object({ material: materialSchema, application: applicationSchema, draft: draftSchema }).strict(),
  'materials.delete': z.object({ deleted: z.literal(true), ref: materialSchema.shape.ref }).strict(),
  'reviews.list': z.object({ total: z.number().int().min(0), reviews: z.array(reviewSchema).max(100) }).strict(),
  'reviews.approve': z.object({ review: reviewSchema }).strict(),
  'reviews.reject': z.object({ review: reviewSchema }).strict(),
  'audit.list': z.object({ total: z.number().int().min(0), logs: z.array(z.object({ session_id: z.string().max(128), action: z.string().max(256), created_at: timestamp }).strict()).max(100) }).strict(),
  'settings.get': z.object({ configured: z.boolean(), external_connections: z.object({ feishu: z.object({ status: z.string().min(1).max(64) }).strict(), ocr_provider: z.object({ status: z.string().min(1).max(64) }).strict(), invoice_verification: z.object({ status: z.string().min(1).max(64) }).strict() }).strict(), data_scope: z.literal('isolated_host_user') }).strict(),
  'settings.update': z.never(),
  'settings.test': z.object({ status: z.string(), error_codes: z.array(z.string()) }).strict(),
  'settings.preflight': z.object({ status: z.string(), error_codes: z.array(z.string()) }).strict(),
  'settings.models': z.object({ models: z.array(z.never()).max(0) }).strict(),
  'assistant.inspect': z.object({ message: z.string().max(16_000), precheck: precheckSchema.or(z.object({}).strict()) }).strict(),
  'assistant.propose': z.object({ message: z.string().max(16_000), precheck: precheckSchema }).strict(),
};

const PRIVATE_RESULT_KEY = /(?:^|_)(?:user_id|project_root|absolute_path|path|data_base64|raw_bytes|secret|password|token|api_key|capability|host_capability_id)$/i;
const ABSOLUTE_PATH_VALUE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

function assertSafeResultValue(value: JsonValue, location: string, depth = 0): void {
  if (depth > 24) throw new Error(`expense bridge result nesting exceeds limit at ${location}`);
  if (typeof value === 'string') {
    if (value.includes('\0') || ABSOLUTE_PATH_VALUE.test(value)) {
      throw new Error(`expense bridge result contains a private path at ${location}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 2_000) throw new Error(`expense bridge result array exceeds limit at ${location}`);
    value.forEach((entry, index) => assertSafeResultValue(entry, `${location}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const entries = Object.entries(value);
  if (entries.length > 1_000) throw new Error(`expense bridge result object exceeds limit at ${location}`);
  for (const [key, entry] of entries) {
    if (PRIVATE_RESULT_KEY.test(key)) throw new Error(`expense bridge result contains private field ${location}.${key}`);
    assertSafeResultValue(entry, `${location}.${key}`, depth + 1);
  }
}

export function validateExpenseWorkbenchResult(
  operation: ExpenseWorkbenchOperation,
  result: JsonObject,
): JsonObject {
  assertSafeResultValue(result, 'result');
  const parsed = RESPONSE_RESULT_SCHEMAS[operation].safeParse(result);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? issue.path.join('.') : 'result';
    throw new Error(`expense bridge result violates ${operation} schema at ${location}`);
  }
  return parsed.data as JsonObject;
}

interface StoredProjectConfig {
  version: 1;
  project_root: string;
}

function serializeExpenseWorkbenchJson(value: JsonValue, label: 'payload' | 'request'): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') throw new TypeError('JSON serialization produced no output');
    return serialized;
  } catch (error) {
    throw new Error(`expense bridge ${label} is not JSON serializable`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export function serializeExpenseWorkbenchRequest(
  requestId: string,
  operation: ExpenseWorkbenchOperation,
  userId: string,
  payload: JsonObject,
  hostRequest: ExpenseWorkbenchHostRequest = {},
): string {
  const payloadJson = serializeExpenseWorkbenchJson(payload, 'payload');
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES) {
    throw new Error(`expense bridge payload exceeds ${MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES} bytes`);
  }
  const request = serializeExpenseWorkbenchJson({
    request_id: requestId,
    operation,
    user_id: userId,
    payload,
    ...hostRequest,
  }, 'request');
  if (Buffer.byteLength(request, 'utf8') > MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES) {
    throw new Error(`expense bridge request line exceeds ${MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES} bytes`);
  }
  return request;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function parseExpenseWorkbenchResponse(line: string): ExpenseWorkbenchResponse {
  if (Buffer.byteLength(line, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('expense bridge response is too large');
  let parsed: JsonValue;
  try { parsed = JSON.parse(line) as JsonValue; }
  catch { throw new Error('expense bridge returned invalid JSON'); }
  if (!isJsonObject(parsed)) throw new Error('expense bridge response must be an object');
  const envelopeKeys = Object.keys(parsed).sort();
  if (envelopeKeys.some((key) => !['error', 'ok', 'request_id', 'result'].includes(key))) {
    throw new Error('expense bridge response envelope has unknown fields');
  }
  const requestId = asString(parsed.request_id);
  const ok = asBoolean(parsed.ok);
  if (!requestId || requestId.length > 192 || ok === undefined) throw new Error('expense bridge response envelope is invalid');
  const resultValue = parsed.result;
  const errorValue = parsed.error;
  const result = isJsonObject(resultValue) ? resultValue : undefined;
  let error: ExpenseWorkbenchError | undefined;
  if (isJsonObject(errorValue)) {
    if (Object.keys(errorValue).some((key) => !['code', 'message', 'retryable'].includes(key))) {
      throw new Error('expense bridge error has unknown fields');
    }
    const code = asString(errorValue.code);
    const message = asString(errorValue.message);
    const retryable = asBoolean(errorValue.retryable);
    if (code && code.length <= 128 && BRIDGE_ERROR_CODE_PATTERN.test(code)
        && message && message.length <= 4_000 && retryable !== undefined) {
      error = { code, message, retryable };
    }
  }
  if (ok && (!result || errorValue !== undefined)) throw new Error('successful expense bridge response envelope is invalid');
  if (!ok && (!error || resultValue !== undefined)) throw new Error('failed expense bridge response envelope is invalid');
  return { request_id: requestId, ok, ...(result ? { result } : {}), ...(error ? { error } : {}) };
}

function readStoredConfig(userId: string): ExpenseWorkbenchProjectConfig | null {
  const requestedFile = userExpenseWorkbenchConfigFile(userId);
  try {
    const configDirectory = ensurePrivateDirectoryWithin(
      WS_ROOT,
      userLocalConfigDir(userId),
      'Mate 报销组件配置目录不可用',
    );
    const file = path.join(configDirectory, path.basename(requestedFile));
    try {
      fs.lstatSync(file);
    } catch (cause) {
      if (cause && typeof cause === 'object' && 'code' in cause
          && String((cause as { code?: unknown }).code || '') === 'ENOENT') {
        return null;
      }
      throw cause;
    }
    const parsed = JSON.parse(
      readDirectFile(file, 2, 16 * 1024, 'Mate 报销组件配置').toString('utf8'),
    ) as JsonValue;
    if (!isJsonObject(parsed) || parsed.version !== 1 || typeof parsed.project_root !== 'string') {
      log.warn('expense workbench configuration has an unsupported shape', { user_id: userId });
      return null;
    }
    return { version: 1, project_root: parsed.project_root };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
    if (code !== 'ENOENT') {
      log.warn('expense workbench configuration is unavailable', {
        user_id: userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

async function writeStoredConfig(userId: string, config: StoredProjectConfig): Promise<void> {
  const requestedFile = userExpenseWorkbenchConfigFile(userId);
  const configDirectory = ensurePrivateDirectoryWithin(
    WS_ROOT,
    userLocalConfigDir(userId),
    'Mate 报销组件配置目录不可用',
  );
  const file = path.join(configDirectory, path.basename(requestedFile));
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temp, JSON.stringify(config), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fsp.rename(temp, file);
  } finally {
    try {
      await fsp.rm(temp, { force: true });
    } catch (error) {
      log.warn('failed to clean expense workbench configuration temporary file', {
        user_id: userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

interface ValidatedExpenseComponent {
  projectRoot: string;
  interpreter: string;
  assertExecutionIntegrity: () => void;
  trustedSourceRoot: string;
  trustedSitePackages: string;
  trustedBridge: string;
}

interface RuntimeManifestAsset {
  archive: string;
  executable: string;
  name: string;
  sha256: string;
  size: number;
}

interface RuntimePythonManifest {
  version: string;
  source: string;
  release: string;
  assets: Record<string, RuntimeManifestAsset>;
}

interface RuntimeMarker {
  schema: number;
  kind: string;
  platformKey: string;
  version: string;
  source: string;
  release: string;
  asset: string;
  sha256: string;
  size: number;
}

interface ParsedRecordFile {
  relativePath: string;
  bytes: number;
  sha256: Buffer;
}

interface ExpectedCacheFile {
  relativePath: string;
  bytes: number;
  sha256: Buffer;
}

function safeRealpath(file: string, label: string): string {
  try {
    return fs.realpathSync(file);
  } catch (cause) {
    throw new Error(label, { cause: cause instanceof Error ? cause : undefined });
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256File(file: string): Buffer {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest();
}

function readDirectFile(file: string, minimumBytes: number, maximumBytes: number, label: string): Buffer {
  let entry: fs.Stats;
  try { entry = fs.lstatSync(file); }
  catch (cause) { throw new Error(`${label}缺失`, { cause: cause instanceof Error ? cause : undefined }); }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size < minimumBytes || entry.size > maximumBytes) {
    throw new Error(`${label}无效`);
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
    );
  } catch (cause) {
    throw new Error(`${label}不可读取`, { cause: cause instanceof Error ? cause : undefined });
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== entry.size || stat.size < minimumBytes || stat.size > maximumBytes) {
      throw new Error(`${label}在读取前发生变化`);
    }
    const content = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = fs.readSync(descriptor, content, offset, content.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const finalStat = fs.fstatSync(descriptor);
    if (offset !== content.length || finalStat.size !== stat.size
        || finalStat.dev !== stat.dev || finalStat.ino !== stat.ino) {
      throw new Error(`${label}在读取期间发生变化`);
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function digestMatches(actual: Buffer, expectedHex: string): boolean {
  if (!SHA256_PATTERN.test(expectedHex)) return false;
  return crypto.timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
}

function assertDirectFile(file: string, root: string, expected: TrustedExpenseComponentFile, label: string): void {
  if (!isPathInside(path.resolve(file), path.resolve(root))) throw new Error(`${label}不在受信边界内`);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (cause) {
    throw new Error(`${label}缺失`, { cause: cause instanceof Error ? cause : undefined });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes) {
    throw new Error(`${label}不是受信的普通文件`);
  }
  if (!digestMatches(sha256File(file), expected.sha256)) {
    throw new Error(`${label}与 Mate 受信发布清单不匹配`);
  }
}

function readBoundedJsonFile(file: string, maxBytes: number, label: string): JsonValue {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (cause) { throw new Error(`${label}缺失`, { cause: cause instanceof Error ? cause : undefined }); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maxBytes) {
    throw new Error(`${label}无效`);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonValue; }
  catch (cause) { throw new Error(`${label}不是有效 JSON`, { cause: cause instanceof Error ? cause : undefined }); }
}

function runtimeManifest(value: JsonValue, platformKey: string): { python: RuntimePythonManifest; asset: RuntimeManifestAsset } {
  if (!isJsonObject(value) || value.schema !== 1 || !isJsonObject(value.python)
      || typeof value.python.version !== 'string' || !DISTRIBUTION_VERSION_PATTERN.test(value.python.version)
      || typeof value.python.source !== 'string' || !value.python.source
      || typeof value.python.release !== 'string' || !value.python.release
      || !isJsonObject(value.python.assets)) {
    throw new Error('Mate 宿主 Python 发布清单无效');
  }
  const candidate = value.python.assets[platformKey];
  if (!isJsonObject(candidate)
      || candidate.archive !== 'tar.gz'
      || typeof candidate.executable !== 'string' || !RELATIVE_RUNTIME_PATH_PATTERN.test(candidate.executable)
      || typeof candidate.name !== 'string' || !RUNTIME_ARCHIVE_NAME_PATTERN.test(candidate.name)
      || typeof candidate.sha256 !== 'string' || !SHA256_PATTERN.test(candidate.sha256)
      || typeof candidate.size !== 'number' || !Number.isSafeInteger(candidate.size) || candidate.size < 1) {
    throw new Error(`Mate 宿主 Python 不支持当前平台: ${platformKey}`);
  }
  return {
    python: value.python as unknown as RuntimePythonManifest,
    asset: candidate as unknown as RuntimeManifestAsset,
  };
}

function runtimeMarker(value: JsonValue): RuntimeMarker {
  if (!isJsonObject(value)
      || value.schema !== 1
      || value.kind !== 'python'
      || typeof value.platformKey !== 'string'
      || typeof value.version !== 'string'
      || typeof value.source !== 'string'
      || typeof value.release !== 'string'
      || typeof value.asset !== 'string'
      || typeof value.sha256 !== 'string'
      || typeof value.size !== 'number') {
    throw new Error('Mate 宿主 Python 安装标记无效');
  }
  return value as unknown as RuntimeMarker;
}

interface PackagedPythonArchive {
  archive: string;
  platformKey: string;
  trusted: TrustedPythonArchive;
}

interface PreparedHostPython {
  interpreter: string;
  assertIntegrity: () => void;
}

interface CachedPythonRuntime {
  cacheRoot: string;
  markerIdentity: string;
  runtimeRoot: string;
  tree: TrustedTarTree;
  trusted: TrustedPythonArchive;
}

const initializedPythonRuntimeRoots = new Set<string>();
const cachedPythonRuntimes = new Map<string, CachedPythonRuntime>();

function ensurePrivateDirectory(directory: string, label: string): string {
  return ensurePrivateDirectoryWithin(WS_ROOT, directory, label);
}

function resolvePackagedPythonArchive(platformKey: string, trusted: TrustedPythonArchive): PackagedPythonArchive {
  const requestedRoot = runtimeResourcesDir();
  let requestedRootStat: fs.Stats;
  try { requestedRootStat = fs.lstatSync(requestedRoot); }
  catch (cause) {
    throw new Error('Mate 宿主运行时目录不可用', { cause: cause instanceof Error ? cause : undefined });
  }
  if (!requestedRootStat.isDirectory() || requestedRootStat.isSymbolicLink()) {
    throw new Error('Mate 宿主运行时目录无效');
  }
  const root = safeRealpath(requestedRoot, 'Mate 宿主运行时目录不可用');
  const { python, asset } = runtimeManifest(
    readBoundedJsonFile(path.join(root, 'manifest.json'), 2 * 1024 * 1024, 'Mate 宿主 Python 发布清单'),
    platformKey,
  );
  if (asset.name !== trusted.name || asset.size !== trusted.bytes
      || asset.sha256 !== trusted.sha256 || asset.executable !== trusted.manifestExecutable) {
    throw new Error('Mate 宿主 Python 发布归档与应用受信清单不匹配');
  }

  const variantRoot = path.join(root, 'python', platformKey);
  let variantStat: fs.Stats;
  try { variantStat = fs.lstatSync(variantRoot); }
  catch (cause) { throw new Error('Mate 宿主 Python 目录不可用', { cause: cause instanceof Error ? cause : undefined }); }
  if (!variantStat.isDirectory() || variantStat.isSymbolicLink()) throw new Error('Mate 宿主 Python 目录无效');
  const realVariantRoot = safeRealpath(variantRoot, 'Mate 宿主 Python 目录不可用');
  if (!isPathInside(realVariantRoot, root)) throw new Error('Mate 宿主 Python 目录越界');

  const marker = runtimeMarker(readBoundedJsonFile(
    path.join(realVariantRoot, '.orkas-runtime.json'),
    16 * 1024,
    'Mate 宿主 Python 安装标记',
  ));
  if (marker.platformKey !== platformKey || marker.version !== python.version
      || marker.source !== python.source || marker.release !== python.release
      || marker.asset !== asset.name || marker.sha256 !== asset.sha256 || marker.size !== asset.size) {
    throw new Error('Mate 宿主 Python 安装标记与发布清单不匹配');
  }

  const archiveDirectory = path.join(realVariantRoot, 'archive');
  let archiveDirectoryStat: fs.Stats;
  try { archiveDirectoryStat = fs.lstatSync(archiveDirectory); }
  catch (cause) { throw new Error('Mate 宿主 Python 发布归档缺失', { cause: cause instanceof Error ? cause : undefined }); }
  if (!archiveDirectoryStat.isDirectory() || archiveDirectoryStat.isSymbolicLink()) {
    throw new Error('Mate 宿主 Python 发布归档目录无效');
  }
  const realArchiveDirectory = safeRealpath(archiveDirectory, 'Mate 宿主 Python 发布归档不可用');
  if (!isPathInside(realArchiveDirectory, realVariantRoot)) throw new Error('Mate 宿主 Python 发布归档目录越界');
  const archive = path.join(realArchiveDirectory, trusted.name);
  let archiveStat: fs.Stats;
  try { archiveStat = fs.lstatSync(archive); }
  catch (cause) { throw new Error('Mate 宿主 Python 发布归档缺失', { cause: cause instanceof Error ? cause : undefined }); }
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size !== trusted.bytes) {
    throw new Error('Mate 宿主 Python 发布归档无效');
  }
  return { archive, platformKey, trusted };
}

function writeAll(descriptor: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
    if (written < 1) throw new Error('Mate 宿主 Python 发布归档复制失败');
    offset += written;
  }
}

function copyVerifiedArchive(source: string, destination: string, trusted: TrustedPythonArchive): void {
  const sourceFlags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
  let sourceDescriptor: number | undefined;
  let destinationDescriptor: number | undefined;
  try {
    sourceDescriptor = fs.openSync(source, sourceFlags);
    const initialStat = fs.fstatSync(sourceDescriptor);
    if (!initialStat.isFile() || initialStat.size !== trusted.bytes) {
      throw new Error('Mate 宿主 Python 发布归档大小不匹配');
    }
    destinationDescriptor = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(ARCHIVE_COPY_BUFFER_BYTES, trusted.bytes));
    let copied = 0;
    while (copied < trusted.bytes) {
      const requested = Math.min(buffer.length, trusted.bytes - copied);
      const bytesRead = fs.readSync(sourceDescriptor, buffer, 0, requested, null);
      if (bytesRead < 1) throw new Error('Mate 宿主 Python 发布归档在复制期间被截断');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      writeAll(destinationDescriptor, chunk);
      copied += bytesRead;
    }
    const finalSourceStat = fs.fstatSync(sourceDescriptor);
    const finalDestinationStat = fs.fstatSync(destinationDescriptor);
    if (finalSourceStat.dev !== initialStat.dev || finalSourceStat.ino !== initialStat.ino
        || finalSourceStat.size !== initialStat.size || finalDestinationStat.size !== trusted.bytes
        || copied !== trusted.bytes || !digestMatches(hash.digest(), trusted.sha256)) {
      throw new Error('Mate 宿主 Python 发布归档与应用受信清单不匹配');
    }
    fs.fsyncSync(destinationDescriptor);
  } catch (cause) {
    try { fs.rmSync(destination, { force: true }); } catch { /* cleanup error is reported by the caller's failure */ }
    throw new Error('Mate 宿主 Python 发布归档验证失败', {
      cause: cause instanceof Error ? cause : undefined,
    });
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
  }
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o400);
}

function freezeRuntimeTree(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(absolute);
        fs.chmodSync(absolute, 0o500);
      } else if (stat.isFile()) {
        fs.chmodSync(absolute, (stat.mode & 0o111) !== 0 ? 0o500 : 0o400);
      } else {
        throw new Error(`Mate 宿主 Python 运行时包含特殊文件: ${absolute}`);
      }
    }
  };
  if (process.platform !== 'win32') {
    visit(root);
    fs.chmodSync(root, 0o500);
  }
}

function removePrivateTree(root: string): void {
  let rootStat: fs.Stats;
  try { rootStat = fs.lstatSync(root); }
  catch (cause) {
    const code = cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code?: unknown }).code || '')
      : '';
    if (code === 'ENOENT') return;
    throw cause;
  }
  if (process.platform !== 'win32' && rootStat.isDirectory() && !rootStat.isSymbolicLink()) {
    const makeWritable = (directory: string): void => {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) makeWritable(path.join(directory, entry.name));
      }
    };
    makeWritable(root);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function assertReadOnlyRuntimeTree(root: string): void {
  if (process.platform === 'win32') return;
  const visit = (directory: string): void => {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o222) !== 0) {
      throw new Error('Mate 宿主 Python 缓存目录权限无效');
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(absolute);
      else if (!stat.isFile() || (stat.mode & 0o222) !== 0) {
        throw new Error('Mate 宿主 Python 缓存文件权限无效');
      }
    }
  };
  visit(root);
}

function cachedInterpreter(runtimeRoot: string, trusted: TrustedPythonArchive): string {
  const requested = path.join(runtimeRoot, ...trusted.manifestExecutable.split('/'));
  if (!isPathInside(path.resolve(requested), path.resolve(runtimeRoot))) throw new Error('Mate 宿主 Python 缓存入口越界');
  const interpreter = safeRealpath(requested, 'Mate 宿主 Python 缓存入口不可用');
  if (!isPathInside(interpreter, safeRealpath(runtimeRoot, 'Mate 宿主 Python 缓存不可用'))) {
    throw new Error('Mate 宿主 Python 缓存符号链接越界');
  }
  const stat = fs.lstatSync(interpreter);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o111) === 0)) {
    throw new Error('Mate 宿主 Python 缓存入口无效');
  }
  return interpreter;
}

function assertCachedPythonRuntime(
  runtime: CachedPythonRuntime,
  privateRuntimeRoot: string,
  verifyContent: boolean,
): string {
  const cacheStat = fs.lstatSync(runtime.cacheRoot);
  if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()
      || !isPathInside(safeRealpath(runtime.cacheRoot, 'Mate 宿主 Python 缓存不可用'), privateRuntimeRoot)) {
    throw new Error('Mate 宿主 Python 缓存目录无效');
  }
  const marker = path.join(runtime.cacheRoot, '.complete.json');
  const markerStat = fs.lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()
      || fs.readFileSync(marker, 'utf8') !== runtime.markerIdentity) {
    throw new Error('Mate 宿主 Python 缓存完成标记无效');
  }
  assertTrustedTarTree(runtime.runtimeRoot, runtime.tree, { verifyContent });
  assertReadOnlyRuntimeTree(runtime.runtimeRoot);
  return cachedInterpreter(runtime.runtimeRoot, runtime.trusted);
}

function pythonRuntimeCacheKey(platformKey: string, trusted: TrustedPythonArchive): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    schema: EXPENSE_RUNTIME_CACHE_SCHEMA,
    platformKey,
    trusted,
  })).digest('hex');
}

function buildCachedPythonRuntime(
  packaged: PackagedPythonArchive,
  privateRuntimeRoot: string,
  cacheRoot: string,
  markerIdentity: string,
  userId: string,
): CachedPythonRuntime {
  const privateTempRoot = ensurePrivateDirectory(userExpenseWorkbenchTempDir(userId), 'Mate 报销组件临时目录不可用');
  if (!isPathInside(privateTempRoot, privateRuntimeRoot)) throw new Error('Mate 报销组件临时目录越界');
  const stagingRoot = fs.mkdtempSync(path.join(privateTempRoot, 'python-runtime-'));
  if (process.platform !== 'win32') fs.chmodSync(stagingRoot, 0o700);
  const copiedArchive = path.join(stagingRoot, packaged.trusted.name);
  const candidateRoot = path.join(stagingRoot, 'candidate');
  const candidateRuntimeRoot = path.join(candidateRoot, 'runtime');
  try {
    copyVerifiedArchive(packaged.archive, copiedArchive, packaged.trusted);
    fs.mkdirSync(candidateRuntimeRoot, { recursive: true, mode: 0o700 });
    const tree = extractTrustedTarGzip(copiedArchive, candidateRuntimeRoot);
    cachedInterpreter(candidateRuntimeRoot, packaged.trusted);
    fs.writeFileSync(path.join(candidateRoot, '.complete.json'), markerIdentity, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    freezeRuntimeTree(candidateRuntimeRoot);
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(candidateRoot, '.complete.json'), 0o400);
    }
    removePrivateTree(cacheRoot);
    fs.mkdirSync(path.dirname(cacheRoot), { recursive: true, mode: 0o700 });
    fs.renameSync(candidateRoot, cacheRoot);
    if (process.platform !== 'win32') fs.chmodSync(cacheRoot, 0o500);
    const runtime: CachedPythonRuntime = {
      cacheRoot,
      markerIdentity,
      runtimeRoot: path.join(cacheRoot, 'runtime'),
      tree,
      trusted: packaged.trusted,
    };
    assertCachedPythonRuntime(runtime, privateRuntimeRoot, true);
    return runtime;
  } finally {
    removePrivateTree(stagingRoot);
  }
}

function prepareHostPythonRuntime(userId: string): PreparedHostPython {
  const platformKey = `${process.platform}-${process.arch}`;
  const artifacts = TRUSTED_EXPENSE_PLATFORM_ARTIFACTS[platformKey];
  if (!artifacts) throw new Error(`Mate 报销组件尚未固定当前平台运行时: ${platformKey}`);
  const packaged = resolvePackagedPythonArchive(platformKey, artifacts.pythonArchive);
  const privateRuntimeRoot = ensurePrivateDirectory(
    userExpenseWorkbenchRuntimeDir(userId),
    'Mate 报销组件运行目录不可用',
  );
  const cacheParent = path.join(privateRuntimeRoot, 'python-runtime');
  const initializationKey = `${privateRuntimeRoot}\u0000${platformKey}`;
  if (!initializedPythonRuntimeRoots.has(initializationKey)) {
    removePrivateTree(cacheParent);
    for (const cachedPath of cachedPythonRuntimes.keys()) {
      if (isPathInside(cachedPath, cacheParent)) cachedPythonRuntimes.delete(cachedPath);
    }
    initializedPythonRuntimeRoots.add(initializationKey);
  }
  ensurePrivateDirectory(cacheParent, 'Mate 宿主 Python 缓存根目录不可用');
  const cacheRoot = path.join(cacheParent, pythonRuntimeCacheKey(platformKey, packaged.trusted));
  const markerIdentity = JSON.stringify({
    schema: EXPENSE_RUNTIME_CACHE_SCHEMA,
    platformKey,
    archive: {
      name: packaged.trusted.name,
      bytes: packaged.trusted.bytes,
      sha256: packaged.trusted.sha256,
    },
  });

  let runtime = cachedPythonRuntimes.get(cacheRoot);
  if (runtime) {
    try {
      assertCachedPythonRuntime(runtime, privateRuntimeRoot, false);
    } catch {
      cachedPythonRuntimes.delete(cacheRoot);
      runtime = undefined;
    }
  }
  if (!runtime) {
    runtime = buildCachedPythonRuntime(packaged, privateRuntimeRoot, cacheRoot, markerIdentity, userId);
    cachedPythonRuntimes.set(cacheRoot, runtime);
  }
  const interpreter = assertCachedPythonRuntime(runtime, privateRuntimeRoot, false);
  return {
    interpreter,
    assertIntegrity: () => {
      assertCachedPythonRuntime(runtime!, privateRuntimeRoot, true);
    },
  };
}

function pythonSitePackages(projectRoot: string): string {
  if (process.platform === 'win32') return path.join(projectRoot, '.venv', 'Lib', 'site-packages');
  const libDir = path.join(projectRoot, '.venv', 'lib');
  let versions: fs.Dirent[];
  try { versions = fs.readdirSync(libDir, { withFileTypes: true }); }
  catch (cause) {
    throw new Error('报销项目的 Python 依赖环境无效', { cause: cause instanceof Error ? cause : undefined });
  }
  const candidates = versions.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^python3\.\d+$/.test(entry.name));
  if (candidates.length !== 1) throw new Error('报销项目的 Python 依赖环境不唯一');
  return path.join(libDir, candidates[0].name, 'site-packages');
}

function parseCsvRecordLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ',') { fields.push(field); field = ''; }
    else field += character;
  }
  if (quoted) throw new Error('Python 依赖 RECORD 含未闭合引号');
  fields.push(field);
  return fields;
}

function recordFiles(sitePackages: string, distribution: TrustedPythonDistribution): ParsedRecordFile[] {
  const distInfo = path.join(sitePackages, distribution.distInfoDirectory);
  let distInfoStat: fs.Stats;
  try { distInfoStat = fs.lstatSync(distInfo); }
  catch (cause) {
    throw new Error(`报销项目的 Python 依赖安装记录缺失: ${distribution.distribution}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (!distInfoStat.isDirectory() || distInfoStat.isSymbolicLink()) {
    throw new Error(`报销项目的 Python 依赖安装记录无效: ${distribution.distribution}`);
  }
  const record = path.join(distInfo, 'RECORD');
  const recordContent = readDirectFile(
    record,
    1,
    MAX_RECORD_BYTES,
    `报销项目的 Python 依赖安装记录: ${distribution.distribution}`,
  );
  if (!digestMatches(crypto.createHash('sha256').update(recordContent).digest(), distribution.recordSha256)) {
    throw new Error(`报销项目的 Python 依赖安装记录不受支持: ${distribution.distribution}`);
  }
  const lines = recordContent.toString('utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 1 || lines.length > MAX_RECORD_FILES) {
    throw new Error(`报销项目的 Python 依赖文件清单无效: ${distribution.distribution}`);
  }
  const verified: ParsedRecordFile[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const fields = parseCsvRecordLine(line);
    if (fields.length !== 3) throw new Error(`报销项目的 Python 依赖文件清单无效: ${distribution.distribution}`);
    const [relativePath, encodedHash, rawBytes] = fields;
    if (!encodedHash && !rawBytes) {
      if (relativePath === `${distribution.distInfoDirectory}/RECORD` || relativePath.includes('/__pycache__/')
          || relativePath.startsWith('__pycache__/')) continue;
      throw new Error(`报销项目的 Python 依赖存在未校验文件: ${distribution.distribution}`);
    }
    const hashMatch = BASE64URL_SHA256_PATTERN.exec(encodedHash);
    const bytes = Number(rawBytes);
    if (!RELATIVE_RUNTIME_PATH_PATTERN.test(relativePath) || !hashMatch || !Number.isSafeInteger(bytes)
        || bytes < 0 || bytes > MAX_TRUSTED_DEPENDENCY_FILE_BYTES || seen.has(relativePath)) {
      throw new Error(`报销项目的 Python 依赖文件清单无效: ${distribution.distribution}`);
    }
    seen.add(relativePath);
    const source = path.join(sitePackages, ...relativePath.split('/'));
    if (!isPathInside(path.resolve(source), path.resolve(sitePackages))) {
      throw new Error(`报销项目的 Python 依赖路径越界: ${distribution.distribution}`);
    }
    let sourceStat: fs.Stats;
    try { sourceStat = fs.lstatSync(source); }
    catch (cause) {
      throw new Error(`报销项目的 Python 依赖文件缺失: ${relativePath}`, {
        cause: cause instanceof Error ? cause : undefined,
      });
    }
    const expectedHash = Buffer.from(hashMatch[1], 'base64url');
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== bytes
        || expectedHash.length !== 32 || !crypto.timingSafeEqual(sha256File(source), expectedHash)) {
      throw new Error(`报销项目的 Python 依赖文件被修改: ${relativePath}`);
    }
    verified.push({ relativePath, bytes, sha256: expectedHash });
  }
  if (!verified.length) throw new Error(`报销项目的 Python 依赖文件清单为空: ${distribution.distribution}`);
  return verified;
}

function runtimeCacheKey(platformKey: string): string {
  const identity = JSON.stringify({
    schema: EXPENSE_RUNTIME_CACHE_SCHEMA,
    componentVersion: TRUSTED_EXPENSE_COMPONENT_VERSION,
    platformKey,
    sourceFiles: TRUSTED_EXPENSE_COMPONENT_FILES,
    distributions: TRUSTED_EXPENSE_PLATFORM_ARTIFACTS[platformKey]?.pythonDistributions,
  });
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function copyVerifiedFile(source: string, destination: string, expectedBytes: number, expectedSha256: Buffer): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const sourceDescriptor = fs.openSync(source, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW));
  try {
    const stat = fs.fstatSync(sourceDescriptor);
    const content = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < content.length) {
      const read = fs.readSync(sourceDescriptor, content, offset, content.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (!stat.isFile() || stat.size !== expectedBytes || offset !== expectedBytes
        || !crypto.timingSafeEqual(crypto.createHash('sha256').update(content).digest(), expectedSha256)) {
      throw new Error(`受信文件在复制期间发生变化: ${source}`);
    }
    fs.writeFileSync(destination, content, { mode: 0o600, flag: 'wx' });
  } finally {
    fs.closeSync(sourceDescriptor);
  }
}

function assertCachedFile(file: string, cacheRoot: string, expectedBytes: number, expectedSha256: Buffer): void {
  if (!isPathInside(path.resolve(file), path.resolve(cacheRoot))) throw new Error('可信缓存路径越界');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedBytes
      || !crypto.timingSafeEqual(sha256File(file), expectedSha256)) {
    throw new Error('可信缓存文件完整性校验失败');
  }
}

function listCacheFiles(cacheRoot: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(cacheRoot, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`可信缓存包含符号链接: ${relative}`);
      const stat = fs.lstatSync(absolute);
      if (process.platform !== 'win32' && (stat.mode & 0o222) !== 0) {
        throw new Error(`可信缓存包含可写入路径: ${relative}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`可信缓存包含非普通文件: ${relative}`);
    }
  };
  visit(cacheRoot);
  return files.sort();
}

function assertCompleteCache(
  cacheRoot: string,
  runtimeRoot: string,
  markerIdentity: string,
  expectedFiles: readonly ExpectedCacheFile[],
): void {
  const completeMarker = path.join(cacheRoot, '.complete.json');
  const cacheStat = fs.lstatSync(cacheRoot);
  const markerStat = fs.lstatSync(completeMarker);
  if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()
      || !isPathInside(safeRealpath(cacheRoot, '可信缓存目录不可用'), runtimeRoot)
      || !markerStat.isFile() || markerStat.isSymbolicLink()
      || (process.platform !== 'win32' && ((cacheStat.mode & 0o222) !== 0 || (markerStat.mode & 0o222) !== 0))
      || fs.readFileSync(completeMarker, 'utf8') !== markerIdentity) {
    throw new Error('可信缓存完成标记无效');
  }
  const allowed = new Set(['.complete.json', ...expectedFiles.map(({ relativePath }) => relativePath)]);
  const actual = listCacheFiles(cacheRoot);
  if (actual.length !== allowed.size || actual.some((relativePath) => !allowed.has(relativePath))) {
    throw new Error('可信缓存包含未经宿主批准的文件');
  }
  for (const expected of expectedFiles) {
    assertCachedFile(
      path.join(cacheRoot, ...expected.relativePath.split('/')),
      cacheRoot,
      expected.bytes,
      expected.sha256,
    );
  }
}

function prepareTrustedRuntime(
  userId: string,
  projectRoot: string,
): Omit<ValidatedExpenseComponent, 'projectRoot' | 'interpreter' | 'assertExecutionIntegrity'> & {
  assertIntegrity: () => void;
} {
  const platformKey = `${process.platform}-${process.arch}`;
  const artifacts = TRUSTED_EXPENSE_PLATFORM_ARTIFACTS[platformKey];
  if (!artifacts) throw new Error(`Mate 报销组件尚未固定当前平台依赖: ${platformKey}`);
  const sitePackages = safeRealpath(pythonSitePackages(projectRoot), '报销项目的 Python 依赖环境不可用');
  const sourceFiles = TRUSTED_EXPENSE_COMPONENT_FILES.map((expected) => {
    const source = path.join(projectRoot, 'src', ...expected.path.split('/'));
    assertDirectFile(source, projectRoot, expected, `报销项目组件 ${expected.path}`);
    return { source, expected };
  });
  const dependencyFiles = artifacts.pythonDistributions.flatMap((distribution) => (
    recordFiles(sitePackages, distribution).map((file) => ({
      source: path.join(sitePackages, ...file.relativePath.split('/')),
      expected: file,
    }))
  ));
  const realRuntimeRoot = ensurePrivateDirectory(
    userExpenseWorkbenchRuntimeDir(userId),
    'Mate 报销组件运行目录不可用',
  );
  const trustedCacheRoot = ensurePrivateDirectory(
    path.join(realRuntimeRoot, 'trusted-cache'),
    'Mate 报销组件可信缓存根目录不可用',
  );
  const cacheRoot = path.join(trustedCacheRoot, runtimeCacheKey(platformKey));
  const completeMarker = path.join(cacheRoot, '.complete.json');
  const markerIdentity = JSON.stringify({ schema: EXPENSE_RUNTIME_CACHE_SCHEMA, platformKey, componentVersion: TRUSTED_EXPENSE_COMPONENT_VERSION });
  const expectedCacheFiles: ExpectedCacheFile[] = [
    ...sourceFiles.map(({ expected }) => ({
      relativePath: `source/${expected.path}`,
      bytes: expected.bytes,
      sha256: Buffer.from(expected.sha256, 'hex'),
    })),
    ...dependencyFiles.map(({ expected }) => ({
      relativePath: `site-packages/${expected.relativePath}`,
      bytes: expected.bytes,
      sha256: expected.sha256,
    })),
  ];
  try {
    assertCompleteCache(cacheRoot, realRuntimeRoot, markerIdentity, expectedCacheFiles);
  } catch {
    removePrivateTree(cacheRoot);
    const temporaryRoot = `${cacheRoot}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    try {
      fs.mkdirSync(path.join(temporaryRoot, 'source'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(temporaryRoot, 'site-packages'), { recursive: true, mode: 0o700 });
      for (const { source, expected } of sourceFiles) {
        copyVerifiedFile(source, path.join(temporaryRoot, 'source', ...expected.path.split('/')), expected.bytes, Buffer.from(expected.sha256, 'hex'));
      }
      for (const { source, expected } of dependencyFiles) {
        copyVerifiedFile(source, path.join(temporaryRoot, 'site-packages', ...expected.relativePath.split('/')), expected.bytes, expected.sha256);
      }
      fs.writeFileSync(path.join(temporaryRoot, '.complete.json'), markerIdentity, { mode: 0o600, flag: 'wx' });
      freezeRuntimeTree(temporaryRoot);
      fs.mkdirSync(path.dirname(cacheRoot), { recursive: true, mode: 0o700 });
      try { fs.renameSync(temporaryRoot, cacheRoot); }
      catch (cause) {
        if (!fs.existsSync(completeMarker)) throw cause;
      }
    } finally {
      removePrivateTree(temporaryRoot);
    }
  }
  assertCompleteCache(cacheRoot, realRuntimeRoot, markerIdentity, expectedCacheFiles);
  const trustedSourceRoot = safeRealpath(path.join(cacheRoot, 'source'), 'Mate 报销组件可信源码缓存不可用');
  const trustedSitePackages = safeRealpath(path.join(cacheRoot, 'site-packages'), 'Mate 报销组件可信依赖缓存不可用');
  const trustedBridge = path.join(trustedSourceRoot, ...TRUSTED_EXPENSE_BRIDGE_PATH.split('/'));
  return {
    trustedSourceRoot,
    trustedSitePackages,
    trustedBridge,
    assertIntegrity: () => assertCompleteCache(
      cacheRoot,
      realRuntimeRoot,
      markerIdentity,
      expectedCacheFiles,
    ),
  };
}

function validateExpenseComponent(userId: string, projectRoot: string): ValidatedExpenseComponent {
  if (typeof projectRoot !== 'string' || !projectRoot || projectRoot.includes('\0') || !path.isAbsolute(projectRoot)) {
    throw new Error('报销项目必须是绝对目录');
  }
  const requested = path.resolve(projectRoot);
  let rootStat: fs.Stats;
  try { rootStat = fs.lstatSync(requested); }
  catch { throw new Error('报销项目目录不存在'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('报销项目必须是非符号链接目录');
  const root = safeRealpath(requested, '报销项目目录不可用');
  const trustedRuntime = prepareTrustedRuntime(userId, root);
  const hostPython = prepareHostPythonRuntime(userId);
  return {
    projectRoot: root,
    interpreter: hostPython.interpreter,
    assertExecutionIntegrity: () => {
      hostPython.assertIntegrity();
      trustedRuntime.assertIntegrity();
    },
    trustedSourceRoot: trustedRuntime.trustedSourceRoot,
    trustedSitePackages: trustedRuntime.trustedSitePackages,
    trustedBridge: trustedRuntime.trustedBridge,
  };
}

export function validateExpenseProjectRoot(projectRoot: string): string {
  return validateExpenseComponent(getActiveUserId(), projectRoot).projectRoot;
}

class ExpenseWorkbenchSession {
  private process: ManagedStdioProcess | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly userId: string, private readonly component: ValidatedExpenseComponent) {}

  private ensureProcess(): ManagedStdioProcess {
    if (this.process) return this.process;
    this.component.assertExecutionIntegrity();
    const childProcess = startManagedStdioProcess({
      command: this.component.interpreter,
      args: [
        '-I',
        '-S',
        '-B',
        '-c',
        PYTHON_BOOTSTRAP,
        this.component.trustedSourceRoot,
        this.component.trustedSitePackages,
        this.component.trustedBridge,
      ],
      cwd: this.component.trustedSourceRoot,
      env: buildExpenseWorkbenchEnvironment(this.component.projectRoot, this.userId),
      maxInputLineBytes: MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES,
      maxOutputLineBytes: MAX_RESPONSE_BYTES,
    });
    childProcess.onLine((line) => this.handleLine(line));
    childProcess.onStderr((chunk) => {
      const safe = chunk.replace(/[\r\n]+/g, ' ').replace(/(token|secret|password|key)=\S+/gi, '$1=[redacted]').slice(0, 500);
      if (safe.trim()) log.warn('expense bridge diagnostic', { text: safe });
    });
    childProcess.onExit((error) => this.handleExit(error));
    this.process = childProcess;
    return childProcess;
  }

  start(): void {
    this.ensureProcess();
  }

  private handleLine(line: string): void {
    let parsed: ExpenseWorkbenchResponse;
    try { parsed = parseExpenseWorkbenchResponse(line); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error('expense bridge response invalid');
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(failure);
      }
      this.pending.clear();
      void this.close();
      return;
    }
    const pending = this.pending.get(parsed.request_id);
    if (!pending) return;
    this.pending.delete(parsed.request_id);
    clearTimeout(pending.timer);
    pending.resolve(parsed);
  }

  private handleExit(error: Error | null): void {
    this.process = null;
    const failure = error || new Error('expense bridge exited');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
  }

  request(operation: ExpenseWorkbenchOperation, payload: JsonObject, hostRequest: ExpenseWorkbenchHostRequest = {}): Promise<ExpenseWorkbenchResponse> {
    const requestId = `mate-${crypto.randomBytes(12).toString('hex')}`;
    const request = serializeExpenseWorkbenchRequest(requestId, operation, this.userId, payload, hostRequest);
    return this.requestSerialized(operation, request);
  }

  requestSerialized(operation: ExpenseWorkbenchOperation, request: string): Promise<ExpenseWorkbenchResponse> {
    const run = this.queue.then(() => this.sendSerialized(operation, request));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async sendSerialized(operation: ExpenseWorkbenchOperation, request: string): Promise<ExpenseWorkbenchResponse> {
    const parsedRequest = JSON.parse(request) as { request_id?: string };
    const requestId = parsedRequest.request_id;
    if (!requestId) throw new Error(`expense bridge ${operation} request id is missing`);
    const process = this.ensureProcess();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('expense bridge request timed out'));
        void this.close();
      }, REQUEST_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      process.writeLine(request).catch((error: Error) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    const process = this.process;
    if (!process) return;
    this.process = null;
    await process.close();
  }
}

const sessions = new Map<string, ExpenseWorkbenchSession>();

function sessionKey(userId: string, projectRoot: string): string {
  return `${userId}\u0000${projectRoot}`;
}

export async function configureExpenseProject(
  userId: string,
  projectRoot: string,
  agentId: string,
): Promise<ExpenseWorkbenchProjectStatus> {
  if (!userId || userId !== getActiveUserId()) throw new Error('active user context changed');
  await assertCanonicalExpenseWorkbenchAgent(userId, agentId);
  const component = validateExpenseComponent(userId, projectRoot);
  const root = component.projectRoot;
  await closeExpenseWorkbenchSessions(userId);
  const probe = new ExpenseWorkbenchSession(userId, component);
  probe.start();
  try {
    const performHandshake = async (
      handshakeOperation: 'manifest' | 'health.get' | 'identity.get',
    ): Promise<JsonObject> => {
      const response = await probe.request(handshakeOperation, {});
      if (!response.ok || !response.result) throw new Error(`报销组件 ${handshakeOperation} 握手失败`);
      return validateExpenseWorkbenchResult(handshakeOperation, response.result);
    };
    const manifest = await performHandshake('manifest');
    const health = await performHandshake('health.get');
    const identity = await performHandshake('identity.get');
    if (health.status !== 'ready' || identity.role !== WORKBENCH_PRINCIPAL_ROLE) {
      throw new Error('报销组件运行身份或健康状态不受支持');
    }
    const advertised = new Set(identity.capabilities as JsonValue[]);
    for (const required of EXPENSE_WORKBENCH_EMPLOYEE_OPERATIONS) {
      if (required === 'applications.submit' || isExpenseWorkbenchExternalOperation(required)) continue;
      if (!advertised.has(required)) throw new Error(`报销组件缺少必要能力: ${required}`);
    }
    if (!(manifest.operations as JsonValue[]).includes('materials.addAndBind')) {
      throw new Error('报销组件缺少原子材料绑定操作');
    }
    await writeStoredConfig(userId, { version: 1, project_root: root });
  } finally {
    await probe.close();
  }
  return { configured: true, project_name: path.basename(root), platform: process.platform === 'win32' ? 'windows' : 'posix' };
}

export function getExpenseProjectStatus(userId: string): ExpenseWorkbenchProjectStatus {
  const config = readStoredConfig(userId);
  if (!config) return { configured: false, platform: process.platform === 'win32' ? 'windows' : 'posix' };
  try {
    const root = validateExpenseComponent(userId, config.project_root).projectRoot;
    return { configured: true, project_name: path.basename(root), platform: process.platform === 'win32' ? 'windows' : 'posix' };
  } catch {
    return { configured: false, platform: process.platform === 'win32' ? 'windows' : 'posix' };
  }
}

export async function callExpenseWorkbench(
  userId: string,
  agentId: string,
  operation: ExpenseWorkbenchOperation,
  payload: JsonObject,
  hostRequest: ExpenseWorkbenchHostRequest = {},
): Promise<JsonObject> {
  if (!userId || userId !== getActiveUserId()) throw new Error('active user context changed');
  await assertCanonicalExpenseWorkbenchAgent(userId, agentId);
  const request = serializeExpenseWorkbenchRequest(
    `mate-${crypto.randomBytes(12).toString('hex')}`,
    operation,
    userId,
    payload,
    hostRequest,
  );
  const config = readStoredConfig(userId);
  if (!config) throw new Error('请先选择报销项目目录');
  const component = validateExpenseComponent(userId, config.project_root);
  const projectRoot = component.projectRoot;
  const key = sessionKey(userId, projectRoot);
  let session = sessions.get(key);
  if (!session) {
    session = new ExpenseWorkbenchSession(userId, component);
    sessions.set(key, session);
  }
  if (hostRequest.host_capability_id !== undefined && (!hostRequest.host_capability_id || !/^hcap-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(hostRequest.host_capability_id))) {
    throw new Error('invalid host confirmation capability');
  }
  const response = await session.requestSerialized(operation, request);
  if (!response.ok) {
    const failure = new Error(response.error?.message || 'expense workbench operation failed');
    if (response.error) Object.assign(failure, { code: response.error.code, retryable: response.error.retryable });
    throw failure;
  }
  return validateExpenseWorkbenchResult(operation, response.result || {});
}

export async function closeExpenseWorkbenchSessions(userId?: string): Promise<void> {
  const entries = [...sessions.entries()].filter(([key]) => !userId || key.startsWith(`${userId}\u0000`));
  await Promise.all(entries.map(async ([key, session]) => {
    sessions.delete(key);
    await session.close();
  }));
}
