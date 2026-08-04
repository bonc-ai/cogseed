import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { userExpenseWorkbenchConfirmationsDir, WS_ROOT } from '../../paths';
import { ensurePrivateDirectoryWithin } from '../../util/private-directory';

const CAPABILITY_TTL_SECONDS = 15 * 60;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/i;
const CAPABILITY_ID = /^hcap-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TARGET_FIELDS = ['system', 'environment', 'adapter', 'form_type', 'mapping_version'] as const;

export interface ExpenseWorkbenchTarget {
  system: string;
  environment: string;
  adapter: string;
  form_type: string;
  mapping_version: string;
}

export interface ExpenseWorkbenchConfirmationInput {
  userId: string;
  applicationId: string;
  draftVersion: number;
  draftHash: string;
  target: ExpenseWorkbenchTarget;
}

interface ConfirmationEnvelope {
  schema_version: 1;
  host_issued: true;
  capability_id: string;
  user_id: string;
  application_id: string;
  draft_version: number;
  draft_hash: string;
  conversation_id: string;
  target: ExpenseWorkbenchTarget;
  issued_at: string;
  expires_at: string;
}

function requireSafeId(value: string, field: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function requireTarget(target: ExpenseWorkbenchTarget): ExpenseWorkbenchTarget {
  if (!target || typeof target !== 'object') throw new Error('confirmation target is required');
  const normalized = {} as ExpenseWorkbenchTarget;
  for (const field of TARGET_FIELDS) {
    const value = target[field];
    if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`confirmation target.${field} is invalid`);
    normalized[field] = value;
  }
  return normalized;
}

function capabilityRoot(userId: string): string {
  return userExpenseWorkbenchConfirmationsDir(userId);
}

export async function issueExpenseWorkbenchConfirmation(input: ExpenseWorkbenchConfirmationInput): Promise<{ issued: true; capabilityId: string }> {
  const userId = requireSafeId(input.userId, 'user id');
  const applicationId = requireSafeId(input.applicationId, 'application id');
  if (!Number.isInteger(input.draftVersion) || input.draftVersion < 1) throw new Error('draft version is invalid');
  if (!HASH.test(input.draftHash)) throw new Error('draft hash is invalid');
  const target = requireTarget(input.target);
  const root = ensurePrivateDirectoryWithin(
    WS_ROOT,
    capabilityRoot(userId),
    'confirmation storage is not a safe directory',
  );
  const capabilityId = `hcap-${crypto.randomBytes(18).toString('hex')}`;
  const now = new Date();
  const expires = new Date(now.getTime() + CAPABILITY_TTL_SECONDS * 1000);
  const envelope: ConfirmationEnvelope = {
    schema_version: 1,
    host_issued: true,
    capability_id: capabilityId,
    user_id: userId,
    application_id: applicationId,
    draft_version: input.draftVersion,
    draft_hash: input.draftHash.toLowerCase(),
    conversation_id: `mate-${crypto.randomBytes(16).toString('hex')}`,
    target,
    issued_at: now.toISOString(),
    expires_at: expires.toISOString(),
  };
  const filename = `${capabilityId}.json`;
  const destination = path.join(root, filename);
  const temporary = path.join(root, `.${filename}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  if (!CAPABILITY_ID.test(capabilityId)) throw new Error('generated confirmation capability is invalid');
  return { issued: true, capabilityId };
}
