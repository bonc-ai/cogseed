import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

import { createLogger } from '../../logger';
import {
  userExpenseWorkbenchConfigFile,
  userExpenseWorkbenchHomeDir,
  userExpenseWorkbenchTempDir,
  userLocalConfigDir,
} from '../../paths';
import { getActiveUserId } from '../users';
import { isPathAllowed } from '../../util/path-sandbox';
import { startManagedStdioProcess, type ManagedStdioProcess } from '../local_agents/runner';
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

const log = createLogger('expense-workbench:adapter');
const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES = 256 * 1024;
export const MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const WORKBENCH_PRINCIPAL_ROLE = 'employee';
const WORKBENCH_COMPONENT_ID = 'expense-precheck';
const WORKBENCH_ENTRYPOINT = 'expense_reimbursement.task_agent.stdio_bridge';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BRIDGE_ERROR_CODE_PATTERN = /^(?:[a-z][a-z0-9_]*|[A-Z][A-Z0-9_]*)$/;

function inheritedEnvironmentValue(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value ? value : undefined;
}

/** The bridge gets only neutral process settings and a host-selected role.
 * Secrets and privilege-bearing values from Electron's environment are never
 * inherited by the reimbursement child process. */
export function buildExpenseWorkbenchEnvironment(projectRoot: string, userId: string): NodeJS.ProcessEnv {
  const home = userExpenseWorkbenchHomeDir(userId);
  const temp = userExpenseWorkbenchTempDir(userId);
  for (const directory of [home, temp]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch { /* Windows has no POSIX mode contract. */ }
  }
  return {
    ...(inheritedEnvironmentValue('PATH') ? { PATH: inheritedEnvironmentValue('PATH') } : {}),
    ...(inheritedEnvironmentValue('Path') ? { Path: inheritedEnvironmentValue('Path') } : {}),
    HOME: home,
    USERPROFILE: home,
    ...(inheritedEnvironmentValue('LANG') ? { LANG: inheritedEnvironmentValue('LANG') } : {}),
    ...(inheritedEnvironmentValue('LC_ALL') ? { LC_ALL: inheritedEnvironmentValue('LC_ALL') } : {}),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    PYTHONPATH: path.join(projectRoot, 'src'),
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
  manifest: z.object({ protocol_version: z.literal(1), component_id: z.literal(WORKBENCH_COMPONENT_ID), component_version: z.literal('v1.3.0-rc1'), operations: operationList, data_scope: z.literal('isolated_host_user') }).strict(),
  'health.get': z.object({ status: z.enum(['ready', 'degraded']), component_version: z.literal('v1.3.0-rc1'), checks: z.object({ domain_store: z.enum(['ready', 'unavailable']), data_scope: z.literal('isolated_host_user'), external_connections: z.literal('unconfigured') }).strict() }).strict(),
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
  const file = userExpenseWorkbenchConfigFile(userId);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonValue;
    if (!isJsonObject(parsed) || parsed.version !== 1 || typeof parsed.project_root !== 'string') return null;
    return { version: 1, project_root: parsed.project_root };
  } catch { return null; }
}

async function writeStoredConfig(userId: string, config: StoredProjectConfig): Promise<void> {
  const file = userExpenseWorkbenchConfigFile(userId);
  await fsp.mkdir(userLocalConfigDir(userId), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temp, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temp, file);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}

function interpreterFor(projectRoot: string): string {
  const relative = process.platform === 'win32'
    ? path.join('.venv', 'Scripts', 'python.exe')
    : path.join('.venv', 'bin', 'python3');
  return path.join(projectRoot, relative);
}

interface WorkbenchManifest {
  schema_version: 1;
  component_id: typeof WORKBENCH_COMPONENT_ID;
  protocol_version: 1;
  entrypoint: typeof WORKBENCH_ENTRYPOINT;
  bridge_sha256: string;
}

function readWorkbenchManifest(root: string, bridge: string): WorkbenchManifest {
  const manifestPath = path.join(root, 'src', 'expense_reimbursement', 'task_agent', 'workbench_manifest.json');
  if (!isPathAllowed(manifestPath, [root])) throw new Error('报销项目组件清单不在项目边界内');
  let manifest: JsonValue;
  try {
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
      throw new Error('component manifest is not a bounded regular file');
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as JsonValue;
  } catch (cause) {
    throw new Error('报销项目组件清单无效', { cause: cause instanceof Error ? cause : undefined });
  }
  if (!isJsonObject(manifest)
      || Object.keys(manifest).sort().join(',') !== 'bridge_sha256,component_id,entrypoint,protocol_version,schema_version'
      || manifest.schema_version !== 1
      || manifest.component_id !== WORKBENCH_COMPONENT_ID
      || manifest.protocol_version !== 1
      || manifest.entrypoint !== WORKBENCH_ENTRYPOINT
      || typeof manifest.bridge_sha256 !== 'string'
      || !SHA256_PATTERN.test(manifest.bridge_sha256)) {
    throw new Error('报销项目组件身份不受支持');
  }
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(bridge)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(manifest.bridge_sha256, 'hex'))) {
    throw new Error('报销项目桥接文件与组件清单不匹配');
  }
  return {
    schema_version: 1,
    component_id: WORKBENCH_COMPONENT_ID,
    protocol_version: 1,
    entrypoint: WORKBENCH_ENTRYPOINT,
    bridge_sha256: manifest.bridge_sha256,
  };
}

export function validateExpenseProjectRoot(projectRoot: string): string {
  if (!projectRoot || !path.isAbsolute(projectRoot)) throw new Error('报销项目必须是绝对目录');
  const requested = path.resolve(projectRoot);
  let rootStat: fs.Stats;
  try { rootStat = fs.lstatSync(requested); }
  catch { throw new Error('报销项目目录不存在'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('报销项目必须是非符号链接目录');
  const root = fs.realpathSync(requested);
  const python = interpreterFor(root);
  let pythonStat: fs.Stats;
  try { pythonStat = fs.statSync(python); }
  catch { throw new Error('报销项目的 Python 虚拟环境不存在'); }
  // Virtualenv launchers are normally symlinks (for example, python3 ->
  // python3.12). Follow that expected link, but require the resolved target
  // to be a regular executable. The user-selected project path itself remains
  // lexical and absolute, so a caller cannot redirect the launcher path.
  if (!pythonStat.isFile()) throw new Error('报销项目的 Python 解释器无效');
  if (process.platform !== 'win32' && (pythonStat.mode & 0o111) === 0) throw new Error('报销项目的 Python 解释器不可执行');
  const bridge = path.join(root, 'src', 'expense_reimbursement', 'task_agent', 'stdio_bridge.py');
  let bridgeStat: fs.Stats;
  try { bridgeStat = fs.lstatSync(bridge); }
  catch { throw new Error('报销项目缺少 Mate 桥接文件'); }
  if (!bridgeStat.isFile() || bridgeStat.isSymbolicLink() || bridgeStat.size < 1 || bridgeStat.size > 2 * 1024 * 1024
      || !isPathAllowed(bridge, [root])) {
    throw new Error('报销项目缺少安全的 Mate 桥接文件');
  }
  readWorkbenchManifest(root, bridge);
  return root;
}

class ExpenseWorkbenchSession {
  private process: ManagedStdioProcess | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly userId: string, private readonly projectRoot: string) {}

  private ensureProcess(): ManagedStdioProcess {
    if (this.process) return this.process;
    const interpreter = interpreterFor(this.projectRoot);
    const childProcess = startManagedStdioProcess({
      command: interpreter,
      args: ['-m', 'expense_reimbursement.task_agent.stdio_bridge'],
      cwd: this.projectRoot,
      env: buildExpenseWorkbenchEnvironment(this.projectRoot, this.userId),
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
    const run = this.queue.then(() => this.send(operation, payload, hostRequest));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async send(operation: ExpenseWorkbenchOperation, payload: JsonObject, hostRequest: ExpenseWorkbenchHostRequest): Promise<ExpenseWorkbenchResponse> {
    const requestId = `mate-${crypto.randomBytes(12).toString('hex')}`;
    const request = serializeExpenseWorkbenchRequest(requestId, operation, this.userId, payload, hostRequest);
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
  await assertCanonicalExpenseWorkbenchAgent(agentId);
  const root = validateExpenseProjectRoot(projectRoot);
  await closeExpenseWorkbenchSessions(userId);
  const probe = new ExpenseWorkbenchSession(userId, root);
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
    const root = validateExpenseProjectRoot(config.project_root);
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
  await assertCanonicalExpenseWorkbenchAgent(agentId);
  const config = readStoredConfig(userId);
  if (!config) throw new Error('请先选择报销项目目录');
  const projectRoot = validateExpenseProjectRoot(config.project_root);
  const key = sessionKey(userId, projectRoot);
  let session = sessions.get(key);
  if (!session) {
    session = new ExpenseWorkbenchSession(userId, projectRoot);
    sessions.set(key, session);
  }
  if (hostRequest.host_capability_id !== undefined && (!hostRequest.host_capability_id || !/^hcap-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(hostRequest.host_capability_id))) {
    throw new Error('invalid host confirmation capability');
  }
  const response = await session.request(operation, payload, hostRequest);
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
