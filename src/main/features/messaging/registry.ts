import * as fs from 'node:fs';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';

import { genId12, nowIso, readJson, safeId, writeJson } from '../../storage';
import {
  userMessagingConfigFile,
} from '../../paths';
import * as localSecrets from '../../util/local-secret-store';
import { createLogger } from '../../logger';
import type {
  MessagingConfigFile,
  MessagingInstance,
  MessagingInstanceClient,
  MessagingInstanceDisk,
  MessagingPlatform,
  MessagingPolicy,
  MessagingSecret,
  MessagingInstanceStatus,
  FeishuTenantBrand,
  WorkspaceScope,
} from './types';
import {
  FEISHU_TENANT_BRANDS,
  INSTANCE_STATUS_KINDS,
  isValidFeishuAppId,
  isValidWecomBotId,
  isValidWecomBotSecret,
  MESSAGING_PLATFORMS,
  REPLY_MODES,
} from './types';

const log = createLogger('messaging:registry');
const SECRET_NAMESPACE = 'messaging.instance';
const EMPTY_CONFIG: MessagingConfigFile = { version: 1, instances: {} };
const locks = new Map<string, Mutex>();

export interface CreateMessagingInstanceInput {
  platform: MessagingPlatform;
  feishuTenantBrand?: FeishuTenantBrand;
  displayName: string;
  workspace?: WorkspaceScope;
  policy?: Partial<MessagingPolicy>;
  secret: MessagingSecret;
}

export interface UpdateMessagingInstanceInput {
  displayName?: string;
  feishuTenantBrand?: FeishuTenantBrand;
  enabled?: boolean;
  workspace?: WorkspaceScope;
  policy?: Partial<MessagingPolicy>;
  secret?: MessagingSecret;
  clearSecret?: boolean;
}

function assertUserId(uid: string): void {
  if (!safeId(uid)) throw new Error('invalid user id');
}

function getLock(uid: string): Mutex {
  let lock = locks.get(uid);
  if (!lock) {
    lock = new Mutex();
    locks.set(uid, lock);
  }
  return lock;
}

function assertInstanceId(id: string): void {
  if (!safeId(id)) throw new Error('invalid messaging instance id');
}

function assertPlatform(platform: string): asserts platform is MessagingPlatform {
  if (!(MESSAGING_PLATFORMS as readonly string[]).includes(platform)) {
    throw new Error(`unsupported messaging platform: ${platform}`);
  }
}

function boundedText(value: string, field: string, max: number): string {
  const text = value.trim();
  if (!text) throw new Error(`${field} required`);
  if (text.length > max) throw new Error(`${field} too long`);
  return text;
}

function requiredSecretText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} required`);
  return boundedText(value, field, max);
}

function normalizeIdList(value: unknown, field: string, strict: boolean): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    if (strict) throw new Error(`invalid ${field}`);
    return [];
  }
  if (value.length > 500) {
    if (strict) throw new Error(`${field} too long`);
    return [];
  }
  const values: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      if (strict) throw new Error(`invalid ${field}`);
      continue;
    }
    const id = candidate.trim();
    if (!id || id.length > 160) {
      if (strict) throw new Error(`invalid ${field}`);
      continue;
    }
    values.push(id);
  }
  return Array.from(new Set(values));
}

function normalizePolicy(input?: Partial<MessagingPolicy>, strict = false): MessagingPolicy {
  const rawReplyMode = input?.replyMode;
  if (rawReplyMode !== undefined && !(REPLY_MODES as readonly string[]).includes(rawReplyMode)) {
    if (strict) throw new Error('invalid reply mode');
  }
  const replyMode = rawReplyMode && (REPLY_MODES as readonly string[]).includes(rawReplyMode)
    ? rawReplyMode
    : 'every_message';
  const rawRequireMention = input?.requireMentionInGroups;
  if (rawRequireMention !== undefined && typeof rawRequireMention !== 'boolean' && strict) {
    throw new Error('invalid group mention requirement');
  }
  return {
    replyMode: replyMode as MessagingPolicy['replyMode'],
    allowUserIds: normalizeIdList(input?.allowUserIds, 'allowUserIds', strict),
    allowGroupIds: normalizeIdList(input?.allowGroupIds, 'allowGroupIds', strict),
    requireMentionInGroups: rawRequireMention === false ? false : true,
  };
}

function normalizeWorkspace(input?: WorkspaceScope): WorkspaceScope {
  if (!input || input.type === 'default') return { type: 'default' };
  if (input.type !== 'project' || !input.projectId || !safeId(input.projectId)) {
    throw new Error('invalid workspace scope');
  }
  return { type: 'project', projectId: input.projectId };
}

function normalizeFeishuTenantBrand(
  platform: MessagingPlatform,
  value: FeishuTenantBrand | undefined,
  strict = false,
): FeishuTenantBrand | undefined {
  if (platform !== 'feishu_lark') {
    if (value !== undefined && strict) throw new Error('Feishu tenant brand is only valid for Feishu instances');
    return undefined;
  }
  if (value === undefined) return 'feishu';
  if (!(FEISHU_TENANT_BRANDS as readonly string[]).includes(value)) {
    if (strict) throw new Error('invalid Feishu tenant brand');
    return 'feishu';
  }
  return value;
}

function normalizeStatus(status: MessagingInstanceStatus | undefined): MessagingInstanceStatus {
  const kind = status?.kind && (INSTANCE_STATUS_KINDS as readonly string[]).includes(status.kind)
    ? status.kind
    : 'disconnected';
  return {
    kind: kind === 'connected' || kind === 'connecting' ? 'disconnected' : kind as MessagingInstanceStatus['kind'],
    ...(typeof status?.message === 'string' && status.message ? { message: status.message.slice(0, 500) } : {}),
    checkedAt: typeof status?.checkedAt === 'string' ? status.checkedAt : nowIso(),
    ...(typeof status?.connectedAt === 'string' && status.connectedAt ? { connectedAt: status.connectedAt.slice(0, 80) } : {}),
  };
}

function normalizeInstance(raw: MessagingInstanceDisk): MessagingInstanceDisk {
  assertInstanceId(raw.id);
  assertPlatform(raw.platform);
  const displayName = boundedText(String(raw.displayName || ''), 'display name', 120);
  const now = nowIso();
  return {
    id: raw.id,
    platform: raw.platform,
    feishuTenantBrand: normalizeFeishuTenantBrand(raw.platform, raw.feishuTenantBrand),
    displayName,
    enabled: raw.enabled === true,
    workspace: normalizeWorkspace(raw.workspace),
    policy: normalizePolicy(raw.policy),
    status: normalizeStatus(raw.status),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    ...(typeof raw.secretsEnc === 'string' && raw.secretsEnc ? { secretsEnc: raw.secretsEnc } : {}),
  };
}

async function readConfig(uid: string): Promise<MessagingConfigFile> {
  assertUserId(uid);
  const raw = await readJson<Partial<MessagingConfigFile>>(userMessagingConfigFile(uid));
  if (raw.version !== 1 || !raw.instances || typeof raw.instances !== 'object') return { ...EMPTY_CONFIG };
  const instances: Record<string, MessagingInstanceDisk> = {};
  for (const [id, value] of Object.entries(raw.instances)) {
    try {
      const candidate = { ...(value as MessagingInstanceDisk), id };
      instances[id] = normalizeInstance(candidate);
    } catch (error) {
      log.warn('skip malformed messaging instance', { id, error: (error as Error).message });
    }
  }
  return { version: 1, instances };
}

async function writeConfig(uid: string, config: MessagingConfigFile): Promise<void> {
  assertUserId(uid);
  await writeJson(userMessagingConfigFile(uid), config);
}

function secretContext(uid: string, instanceId: string): localSecrets.LocalSecretContext {
  return { namespace: SECRET_NAMESPACE, ownerId: uid, recordId: instanceId };
}

function validateSecret(platform: MessagingPlatform, secret: MessagingSecret): MessagingSecret {
  assertPlatform(platform);
  if (platform === 'telegram') {
    const botToken = requiredSecretText(secret.botToken, 'bot token', 512);
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) throw new Error('invalid Telegram bot token');
    return { botToken };
  }
  if (platform === 'feishu_lark') {
    const appId = requiredSecretText(secret.appId, 'app id', 200);
    if (!isValidFeishuAppId(appId)) throw new Error('invalid Feishu app id');
    const appSecret = requiredSecretText(secret.appSecret, 'app secret', 512);
    const tenantAccessToken = typeof secret.tenantAccessToken === 'string' && secret.tenantAccessToken.trim()
      ? secret.tenantAccessToken.trim().slice(0, 2048)
      : undefined;
    return { appId, appSecret, ...(tenantAccessToken ? { tenantAccessToken } : {}) };
  }
  const wecomBotId = requiredSecretText(secret.wecomBotId, 'WeCom bot id', 128);
  const wecomBotSecret = requiredSecretText(secret.wecomBotSecret, 'WeCom bot secret', 512);
  if (!isValidWecomBotId(wecomBotId)) throw new Error('invalid WeCom bot id');
  if (!isValidWecomBotSecret(wecomBotSecret)) throw new Error('invalid WeCom bot secret');
  return { wecomBotId, wecomBotSecret };
}

function encryptSecret(uid: string, instanceId: string, secret: MessagingSecret): string {
  return localSecrets.encryptLocalSecret(secretContext(uid, instanceId), JSON.stringify(secret));
}

function decryptSecret(uid: string, instance: MessagingInstanceDisk): MessagingSecret | null {
  if (!instance.secretsEnc) return null;
  try {
    const text = localSecrets.decryptLocalSecret(secretContext(uid, instance.id), instance.secretsEnc);
    const parsed = JSON.parse(text) as MessagingSecret;
    return validateSecret(instance.platform, parsed);
  } catch (error) {
    log.warn('messaging secret unavailable', { instanceId: instance.id, error: (error as Error).message });
    return null;
  }
}

function toClient(instance: MessagingInstanceDisk, hasCredentials: boolean): MessagingInstanceClient {
  const { secretsEnc: _secretsEnc, ...metadata } = instance;
  return { ...metadata, hasCredentials };
}

export function isValidInstanceId(id: string): boolean {
  return safeId(id);
}

export async function listInstances(uid: string): Promise<MessagingInstanceClient[]> {
  const config = await readConfig(uid);
  return Object.values(config.instances)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }))
    .map((instance) => toClient(instance, !!decryptSecret(uid, instance)));
}

export async function getInstance(uid: string, instanceId: string): Promise<MessagingInstance | null> {
  assertInstanceId(instanceId);
  const config = await readConfig(uid);
  const instance = config.instances[instanceId];
  return instance ? { ...instance } : null;
}

export async function getInstanceWithSecret(uid: string, instanceId: string): Promise<{ instance: MessagingInstance; secret: MessagingSecret } | null> {
  assertInstanceId(instanceId);
  const config = await readConfig(uid);
  const instance = config.instances[instanceId];
  if (!instance) return null;
  const secret = decryptSecret(uid, instance);
  return secret ? { instance: { ...instance }, secret } : null;
}

export async function createInstance(uid: string, input: CreateMessagingInstanceInput): Promise<MessagingInstanceClient> {
  assertUserId(uid);
  assertPlatform(input.platform);
  const displayName = boundedText(input.displayName, 'display name', 120);
  const secret = validateSecret(input.platform, input.secret);
  return getLock(uid).runExclusive(async () => {
    const config = await readConfig(uid);
    const id = genId12();
    const now = nowIso();
    const instance: MessagingInstanceDisk = {
      id,
      platform: input.platform,
      feishuTenantBrand: normalizeFeishuTenantBrand(input.platform, input.feishuTenantBrand, true),
      displayName,
      enabled: false,
      workspace: normalizeWorkspace(input.workspace),
      policy: normalizePolicy(input.policy, true),
      status: { kind: 'disconnected', checkedAt: now },
      createdAt: now,
      updatedAt: now,
      secretsEnc: encryptSecret(uid, id, secret),
    };
    config.instances[id] = instance;
    await writeConfig(uid, config);
    return toClient(instance, true);
  });
}

export async function updateInstance(uid: string, instanceId: string, input: UpdateMessagingInstanceInput): Promise<MessagingInstanceClient> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  if (input.clearSecret && input.secret) throw new Error('cannot replace and clear credentials in the same update');
  return getLock(uid).runExclusive(async () => {
    const config = await readConfig(uid);
    const current = config.instances[instanceId];
    if (!current) throw new Error('messaging instance not found');
    const next: MessagingInstanceDisk = {
      ...current,
      ...(typeof input.displayName === 'string' ? { displayName: boundedText(input.displayName, 'display name', 120) } : {}),
      ...(input.feishuTenantBrand !== undefined
        ? { feishuTenantBrand: normalizeFeishuTenantBrand(current.platform, input.feishuTenantBrand, true) }
        : {}),
      ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
      ...(input.workspace ? { workspace: normalizeWorkspace(input.workspace) } : {}),
      ...(input.policy ? { policy: normalizePolicy({ ...current.policy, ...input.policy }, true) } : {}),
      ...(input.secret ? { secretsEnc: encryptSecret(uid, instanceId, validateSecret(current.platform, input.secret)) } : {}),
      ...(input.clearSecret ? { secretsEnc: undefined } : {}),
      updatedAt: nowIso(),
    };
    config.instances[instanceId] = next;
    await writeConfig(uid, config);
    return toClient(next, !!decryptSecret(uid, next));
  });
}

export async function updateStatus(uid: string, instanceId: string, status: MessagingInstanceStatus): Promise<void> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  await getLock(uid).runExclusive(async () => {
    const config = await readConfig(uid);
    const current = config.instances[instanceId];
    if (!current) return;
    current.status = normalizeStatus(status);
    current.updatedAt = nowIso();
    await writeConfig(uid, config);
  });
}

export async function deleteInstance(uid: string, instanceId: string): Promise<boolean> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  return getLock(uid).runExclusive(async () => {
    const config = await readConfig(uid);
    if (!config.instances[instanceId]) return false;
    delete config.instances[instanceId];
    await writeConfig(uid, config);
    return true;
  });
}

export function removeConfigFileForTest(uid: string): void {
  try { fs.rmSync(path.resolve(userMessagingConfigFile(uid)), { force: true }); } catch { /* test cleanup only */ }
}

export const _registryTestHooks = {
  normalizePolicy,
  normalizeWorkspace,
  normalizeFeishuTenantBrand,
  validateSecret,
  toClient,
};
