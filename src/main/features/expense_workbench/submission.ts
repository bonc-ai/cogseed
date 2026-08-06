import {
  callExpenseWorkbench,
  type ExpenseWorkbenchHostRequest,
} from './adapter';
import { assertCanonicalExpenseWorkbenchAgent } from './canonical-agent';
import { issueExpenseWorkbenchConfirmation, type ExpenseWorkbenchTarget } from './confirmation';
import {
  type JsonObject,
  isJsonObject,
} from './contracts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/i;
const TARGET_FIELDS = ['system', 'environment', 'adapter', 'form_type', 'mapping_version'] as const;

export interface ConfirmExpenseWorkbenchSubmissionInput {
  agentId: string;
  applicationId: string;
  version: number;
  payloadHash: string;
}

function requireSafeId(value: string, field: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function requireJsonObject(value: JsonObject[string] | undefined, field: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${field} is unavailable`);
  return value;
}

function requireStringField(object: JsonObject, field: string): string {
  const value = object[field];
  if (typeof value !== 'string') throw new Error(`${field} is invalid`);
  return value;
}

function requireIntegerField(object: JsonObject, field: string): number {
  const value = object[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${field} is invalid`);
  return value;
}

function requireTarget(value: JsonObject[string] | undefined): ExpenseWorkbenchTarget {
  const raw = requireJsonObject(value, 'application target');
  const target = {} as ExpenseWorkbenchTarget;
  for (const field of TARGET_FIELDS) {
    target[field] = requireSafeId(requireStringField(raw, field), `application target.${field}`);
  }
  return target;
}

export async function confirmAndSubmitExpenseWorkbench(
  userId: string,
  input: ConfirmExpenseWorkbenchSubmissionInput,
): Promise<JsonObject> {
  const agentId = requireSafeId(input.agentId, 'agent id');
  const applicationId = requireSafeId(input.applicationId, 'application id');
  if (!Number.isInteger(input.version) || input.version < 1) throw new Error('application version is invalid');
  if (!HASH.test(input.payloadHash)) throw new Error('payload hash is invalid');
  const payloadHash = input.payloadHash.toLowerCase();

  await assertCanonicalExpenseWorkbenchAgent(userId, agentId);
  const current = await callExpenseWorkbench(userId, agentId, 'applications.get', { application_id: applicationId });
  const application = requireJsonObject(current.application, 'application state');
  if (requireStringField(application, 'application_id') !== applicationId) throw new Error('application state is unavailable');
  if (requireIntegerField(application, 'current_version') !== input.version) throw new Error('application version has changed');
  if (requireStringField(application, 'current_payload_hash').toLowerCase() !== payloadHash) {
    throw new Error('application payload has changed');
  }

  const precheck = current.unified_precheck;
  if (isJsonObject(precheck)) {
    if (precheck.status !== 'ready') throw new Error('application precheck is not ready');
  } else if (application.precheck_status !== 'ready_for_confirmation') {
    throw new Error('application precheck is not ready');
  }

  const target = requireTarget(application.target);
  if (target.adapter !== 'feishu-approval' || target.environment !== 'feishu') {
    throw new Error('application is not bound to an available Feishu approval connection');
  }

  const confirmation = await issueExpenseWorkbenchConfirmation({
    userId,
    applicationId,
    draftVersion: input.version,
    draftHash: payloadHash,
    target,
  });
  const hostRequest: ExpenseWorkbenchHostRequest = { host_capability_id: confirmation.capabilityId };
  const confirmed = await callExpenseWorkbench(
    userId,
    agentId,
    'applications.confirm',
    { application_id: applicationId, payload_hash: payloadHash },
    hostRequest,
  );
  const submitted = await callExpenseWorkbench(userId, agentId, 'applications.submit', { application_id: applicationId });
  return { confirmed, submitted };
}
