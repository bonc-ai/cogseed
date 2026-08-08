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
  MessagingInstanceClient,
  MessagingInstanceDisk,
  MessagingInstanceInternal,
  MessagingOwnerIdentitySource,
  MessagingPlatform,
  MessagingPolicy,
  MessagingSecret,
  MessagingInstanceStatus,
  FeishuTenantBrand,
  WorkspaceScope,
  MessagingResponseMode,
} from './types';
import {
  FEISHU_TENANT_BRANDS,
  INSTANCE_STATUS_KINDS,
  isValidFeishuAppId,
  isValidFeishuOpenId,
  isValidWecomBotId,
  isValidWecomBotSecret,
  MESSAGING_PLATFORMS,
  REPLY_MODES,
  RESPONSE_MODES,
} from './types';

const log = createLogger('messaging:registry');
const SECRET_NAMESPACE = 'messaging.instance';
const EMPTY_CONFIG: MessagingConfigFile = { version: 1, instances: {} };
const locks = new Map<string, Mutex>();

/** iLink is a Tencent-controlled relay; the confirmed base URL and any QR
 * redirect host must stay inside this static whitelist. Never extend it from
 * server-supplied values. */
export const TRUSTED_ILINK_HOSTS = new Set(['ilinkai.weixin.qq.com']);

export function isTrustedIlinkBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  return TRUSTED_ILINK_HOSTS.has(url.hostname);
}

interface OwnerIdentityInput {
  ownerExternalUserId?: string;
  ownerExternalUserName?: string;
  ownerIdentitySource?: MessagingOwnerIdentitySource;
}

export interface CreateMessagingInstanceInput extends OwnerIdentityInput {
  platform: MessagingPlatform;
  feishuTenantBrand?: FeishuTenantBrand;
  displayName: string;
  responseMode?: MessagingResponseMode;
  workspace?: WorkspaceScope;
  policy?: Partial<MessagingPolicy>;
  secret: MessagingSecret;
}

/**
 * Feishu/Lark credentials are issued only after the official QR flow. A draft
 * deliberately has no `secretsEnc` value, cannot be enabled, and exposes no
 * sensitive material to the renderer.
 */
export interface CreateFeishuDraftInput extends OwnerIdentityInput {
  feishuTenantBrand: FeishuTenantBrand;
  displayName: string;
  responseMode?: MessagingResponseMode;
  workspace?: WorkspaceScope;
  policy?: Partial<MessagingPolicy>;
}

export interface BindFeishuDraftInput extends OwnerIdentityInput {
  feishuTenantBrand: FeishuTenantBrand;
  secret: Pick<MessagingSecret, 'appId' | 'appSecret'>;
  /** The successful QR account is always explicitly authorized first. */
  initialAllowUserId: string;
}

export interface UpdateMessagingInstanceInput extends OwnerIdentityInput {
  displayName?: string;
  feishuTenantBrand?: FeishuTenantBrand;
  responseMode?: MessagingResponseMode;
  enabled?: boolean;
  workspace?: WorkspaceScope;
  policy?: Partial<MessagingPolicy>;
  secret?: MessagingSecret;
  clearSecret?: boolean;
  clearOwner?: boolean;
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

function normalizeOwnerIdentity(
  platform: MessagingPlatform,
  input: OwnerIdentityInput,
  strict = false,
): Pick<MessagingInstanceInternal, 'ownerExternalUserId' | 'ownerExternalUserName' | 'ownerIdentitySource'> {
  const hasOwnerFields = input.ownerExternalUserId !== undefined
    || input.ownerExternalUserName !== undefined
    || input.ownerIdentitySource !== undefined;
  if (platform !== 'feishu_lark') {
    if (hasOwnerFields && strict) throw new Error('owner identity is only valid for Feishu/Lark');
    return {};
  }
  if (typeof input.ownerExternalUserId !== 'string') {
    if (hasOwnerFields && strict) throw new Error('owner open id required');
    return {};
  }
  const ownerExternalUserId = input.ownerExternalUserId.trim();
  if (!isValidFeishuOpenId(ownerExternalUserId)) {
    if (strict) throw new Error('invalid owner open id');
    return {};
  }
  let ownerExternalUserName: string | undefined;
  if (input.ownerExternalUserName !== undefined) {
    if (typeof input.ownerExternalUserName !== 'string') {
      if (strict) throw new Error('invalid owner name');
    } else {
      const name = input.ownerExternalUserName.trim();
      if (name.length > 120) {
        if (strict) throw new Error('owner name too long');
      } else if (name) {
        ownerExternalUserName = name;
      }
    }
  }
  const source = input.ownerIdentitySource;
  if (source !== undefined && source !== 'qr' && source !== 'manual' && source !== 'auto') {
    if (strict) throw new Error('invalid owner identity source');
  }
  return {
    ownerExternalUserId,
    ...(ownerExternalUserName ? { ownerExternalUserName } : {}),
    ownerIdentitySource: source === 'qr' ? 'qr' : source === 'auto' ? 'auto' : 'manual',
  };
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
  // Missing allowlists are persisted as empty arrays. Inbound policy evaluates
  // empty arrays as deny-all, so malformed or legacy config never opens access.
  return {
    replyMode: replyMode as MessagingPolicy['replyMode'],
    allowUserIds: normalizeIdList(input?.allowUserIds, 'allowUserIds', strict),
    allowGroupIds: normalizeIdList(input?.allowGroupIds, 'allowGroupIds', strict),
    requireMentionInGroups: rawRequireMention === false ? false : true,
  };
}

function normalizeWorkspace(input?: WorkspaceScope): WorkspaceScope {
  if (!input || input.type === 'default') return { type: 'default' };
  if (input.type === 'all') return { type: 'all' };
  if (input.type !== 'project' || !input.projectId || !safeId(input.projectId)) {
    throw new Error('invalid workspace scope');
  }
  return { type: 'project', projectId: input.projectId };
}

function normalizeResponseMode(
  platform: MessagingPlatform,
  value: MessagingResponseMode | undefined,
  strict = false,
): MessagingResponseMode {
  // Rich-text `post` replies are the default Feishu experience; streaming
  // cards remain available as an opt-in mode.
  const fallback: MessagingResponseMode = 'text';
  if (value === undefined) return fallback;
  if (!(RESPONSE_MODES as readonly string[]).includes(value)) {
    if (strict) throw new Error('invalid response mode');
    return fallback;
  }
  if (platform !== 'feishu_lark' && value !== 'text') {
    if (strict) throw new Error('streaming cards are only supported by Feishu/Lark');
    return 'text';
  }
  return value;
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

/**
 * WeChat owner identity is bound at registration time from the confirmed
 * `ilink_user_id` and must survive disk read-back. Unlike Feishu/Lark there
 * is no open-id format, so the read path only re-validates the bounded text
 * written by `createWechatInstance`.
 */
function normalizeWechatOwnerIdentity(input: OwnerIdentityInput): Pick<
  MessagingInstanceInternal, 'ownerExternalUserId' | 'ownerExternalUserName' | 'ownerIdentitySource'
> {
  if (typeof input.ownerExternalUserId !== 'string' || !input.ownerExternalUserId.trim()) return {};
  const ownerExternalUserId = input.ownerExternalUserId.trim();
  if (ownerExternalUserId.length > 160) return {};
  const source = input.ownerIdentitySource;
  return {
    ownerExternalUserId,
    ownerIdentitySource: source === 'qr' ? 'qr' : source === 'auto' ? 'auto' : 'manual',
  };
}

function normalizeInstance(raw: MessagingInstanceDisk): MessagingInstanceDisk {
  assertInstanceId(raw.id);
  assertPlatform(raw.platform);
  const displayName = boundedText(String(raw.displayName || ''), 'display name', 120);
  const ownerIdentity = raw.platform === 'wechat_personal'
    ? normalizeWechatOwnerIdentity(raw)
    : normalizeOwnerIdentity(raw.platform, raw);
  const now = nowIso();
  return {
    id: raw.id,
    platform: raw.platform,
    feishuTenantBrand: normalizeFeishuTenantBrand(raw.platform, raw.feishuTenantBrand),
    displayName,
    enabled: raw.enabled === true,
    responseMode: normalizeResponseMode(raw.platform, raw.responseMode),
    workspace: normalizeWorkspace(raw.workspace),
    policy: normalizePolicy(raw.policy),
    status: normalizeStatus(raw.status),
    ...ownerIdentity,
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
  if (platform === 'wechat_personal') {
    const ilinkBotToken = requiredSecretText(secret.ilinkBotToken, 'ilink bot token', 512);
    if (!/^[A-Za-z0-9._~-]{16,512}$/.test(ilinkBotToken)) throw new Error('invalid iLink bot token');
    const ilinkBaseUrl = requiredSecretText(secret.ilinkBaseUrl, 'ilink base url', 512);
    if (!isTrustedIlinkBaseUrl(ilinkBaseUrl)) throw new Error('untrusted iLink base url');
    const ilinkBotId = requiredSecretText(secret.ilinkBotId, 'ilink bot id', 128);
    return { ilinkBotToken, ilinkBaseUrl, ilinkBotId };
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
  const {
    secretsEnc: _secretsEnc,
    ownerExternalUserId,
    ownerExternalUserName,
    ownerIdentitySource,
    ...metadata
  } = instance;
  const ownerConfigured = Boolean(ownerExternalUserId);
  return {
    ...metadata,
    hasCredentials,
    ownerConfigured,
    ...(ownerConfigured && ownerExternalUserName ? { ownerLabel: ownerExternalUserName } : {}),
    ...(ownerConfigured && ownerIdentitySource ? { ownerIdentitySource } : {}),
  };
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

export async function getInstance(uid: string, instanceId: string): Promise<MessagingInstanceInternal | null> {
  assertInstanceId(instanceId);
  const config = await readConfig(uid);
  const instance = config.instances[instanceId];
  return instance ? { ...instance } : null;
}

export async function getInstanceWithSecret(uid: string, instanceId: string): Promise<{ instance: MessagingInstanceInternal; secret: MessagingSecret } | null> {
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
  const ownerIdentity = normalizeOwnerIdentity(input.platform, input, true);
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
      responseMode: normalizeResponseMode(input.platform, input.responseMode, true),
      workspace: normalizeWorkspace(input.workspace),
      policy: normalizePolicy(input.policy, true),
      status: { kind: 'disconnected', checkedAt: now },
      ...ownerIdentity,
      createdAt: now,
      updatedAt: now,
      secretsEnc: encryptSecret(uid, id, secret),
    };
    config.instances[id] = instance;
    await writeConfig(uid, config);
    return toClient(instance, true);
  });
}

export async function createFeishuDraft(uid: string, input: CreateFeishuDraftInput): Promise<MessagingInstanceClient> {
  assertUserId(uid);
  const displayName = boundedText(input.displayName, 'display name', 120);
  const feishuTenantBrand = normalizeFeishuTenantBrand('feishu_lark', input.feishuTenantBrand, true);
  if (!feishuTenantBrand) throw new Error('Feishu tenant brand required');
  const workspace = normalizeWorkspace(input.workspace);
  const policy = normalizePolicy(input.policy, true);
  const ownerIdentity = normalizeOwnerIdentity('feishu_lark', input, true);
  return getLock(uid).runExclusive(async () => {
    const config = await readConfig(uid);
    const id = genId12();
    const now = nowIso();
    const instance: MessagingInstanceDisk = {
      id,
      platform: 'feishu_lark',
      feishuTenantBrand,
      displayName,
      enabled: false,
      responseMode: normalizeResponseMode('feishu_lark', input.responseMode, true),
      workspace,
      policy,
      status: { kind: 'disabled', checkedAt: now },
      ...ownerIdentity,
      createdAt: now,
      updatedAt: now,
    };
    config.instances[id] = instance;
    await writeConfig(uid, config);
    return toClient(instance, false);
  });
}

function normalizeInitialAllowUserId(value: string): string {
  const userId = boundedText(value, 'initial allowed user id', 160);
  if (userId.includes('\0')) throw new Error('invalid initial allowed user id');
  return userId;
}

/**
 * Atomically attach QR-issued credentials to the exact existing draft. This
 * intentionally refuses to overwrite a configured robot, which makes a late
 * or superseded QR flow unable to replace user-owned credentials.
 */
export async function bindFeishuDraft(
  uid: string,
  instanceId: string,
  input: BindFeishuDraftInput,
): Promise<MessagingInstanceClient> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  const feishuTenantBrand = normalizeFeishuTenantBrand('feishu_lark', input.feishuTenantBrand, true);
  if (!feishuTenantBrand) throw new Error('Feishu tenant brand required');
  const secret = validateSecret('feishu_lark', input.secret);
  const initialAllowUserId = normalizeInitialAllowUserId(input.initialAllowUserId);
  const ownerIdentity = normalizeOwnerIdentity('feishu_lark', {
    ...input,
    ownerIdentitySource: 'qr',
  }, true);
  if (ownerIdentity.ownerExternalUserId !== initialAllowUserId) {
    throw new Error('owner open id must match initial allowed user id');
  }
  return getLock(uid).runExclusive(async () => {
    const config = await readConfig(uid);
    const current = config.instances[instanceId];
    if (!current) throw new Error('messaging draft not found');
    if (current.platform !== 'feishu_lark') throw new Error('messaging draft is not a Feishu/Lark robot');
    if (current.enabled || decryptSecret(uid, current)) {
      throw new Error('messaging draft already has credentials');
    }
    const allowUserIds = Array.from(new Set([...current.policy.allowUserIds, initialAllowUserId]));
    const next: MessagingInstanceDisk = {
      ...current,
      feishuTenantBrand,
      enabled: false,
      policy: normalizePolicy({ ...current.policy, allowUserIds }, true),
      status: { kind: 'disconnected', checkedAt: nowIso() },
      ...ownerIdentity,
      secretsEnc: encryptSecret(uid, instanceId, secret),
      updatedAt: nowIso(),
    };
    config.instances[instanceId] = next;
    await writeConfig(uid, config);
    return toClient(next, true);
  });
}

/**
 * Cancel/expiry compensation must preserve the draft itself. Credentials are
 * cleared only when they still exactly match the QR result owned by the flow;
 * a newer user configuration is left untouched.
 */
export async function revokeFeishuDraftCredentials(
  uid: string,
  instanceId: string,
  expectedSecret: Pick<MessagingSecret, 'appId' | 'appSecret'>,
): Promise<{ revoked: boolean; instance: MessagingInstanceClient | null }> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  const normalizedSecret = validateSecret('feishu_lark', expectedSecret);
  return getLock(uid).runExclusive(async () => {
    const config = await readConfig(uid);
    const current = config.instances[instanceId];
    if (!current) return { revoked: false, instance: null };
    if (current.platform !== 'feishu_lark') return { revoked: false, instance: toClient(current, !!decryptSecret(uid, current)) };
    const currentSecret = decryptSecret(uid, current);
    if (currentSecret?.appId !== normalizedSecret.appId || currentSecret.appSecret !== normalizedSecret.appSecret) {
      return { revoked: false, instance: toClient(current, !!currentSecret) };
    }
    const {
      secretsEnc: _secretsEnc,
      ownerExternalUserId,
      ownerExternalUserName,
      ownerIdentitySource,
      ...withoutCredentialsAndOwner
    } = current;
    const preserveOwner = ownerIdentitySource !== 'qr';
    const next: MessagingInstanceDisk = {
      ...withoutCredentialsAndOwner,
      ...(preserveOwner && ownerExternalUserId ? {
        ownerExternalUserId,
        ...(ownerExternalUserName ? { ownerExternalUserName } : {}),
        ...(ownerIdentitySource ? { ownerIdentitySource } : {}),
      } : {}),
      enabled: false,
      status: { kind: 'disabled', checkedAt: nowIso() },
      updatedAt: nowIso(),
    };
    config.instances[instanceId] = next;
    await writeConfig(uid, config);
    return { revoked: true, instance: toClient(next, false) };
  });
}

export async function updateInstance(uid: string, instanceId: string, input: UpdateMessagingInstanceInput): Promise<MessagingInstanceClient> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  if (input.clearSecret && input.secret) throw new Error('cannot replace and clear credentials in the same update');
  const hasOwnerInput = input.ownerExternalUserId !== undefined
    || input.ownerExternalUserName !== undefined
    || input.ownerIdentitySource !== undefined;
  if (input.clearOwner && hasOwnerInput) throw new Error('cannot replace and clear owner in the same update');
  return getLock(uid).runExclusive(async () => {
    const config = await readConfig(uid);
    const current = config.instances[instanceId];
    if (!current) throw new Error('messaging instance not found');
    if ((hasOwnerInput || input.clearOwner) && current.platform !== 'feishu_lark') {
      throw new Error('owner identity is only valid for Feishu/Lark');
    }
    const ownerPatch = hasOwnerInput
      ? normalizeOwnerIdentity(current.platform, input, true)
      : {};
    const next: MessagingInstanceDisk = {
      ...current,
      ...(typeof input.displayName === 'string' ? { displayName: boundedText(input.displayName, 'display name', 120) } : {}),
      ...(input.feishuTenantBrand !== undefined
        ? { feishuTenantBrand: normalizeFeishuTenantBrand(current.platform, input.feishuTenantBrand, true) }
        : {}),
      ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
      ...(input.responseMode !== undefined
        ? { responseMode: normalizeResponseMode(current.platform, input.responseMode, true) }
        : {}),
      ...(input.workspace ? { workspace: normalizeWorkspace(input.workspace) } : {}),
      ...(input.policy ? { policy: normalizePolicy({ ...current.policy, ...input.policy }, true) } : {}),
      ...(input.secret ? { secretsEnc: encryptSecret(uid, instanceId, validateSecret(current.platform, input.secret)) } : {}),
      ...(input.clearSecret ? { secretsEnc: undefined } : {}),
      ...ownerPatch,
      ...(input.clearOwner ? {
        ownerExternalUserId: undefined,
        ownerExternalUserName: undefined,
        ownerIdentitySource: undefined,
      } : {}),
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

export interface CreateWechatInstanceInput {
  displayName: string;
  ilinkBotToken: string;
  ilinkBaseUrl: string;
  ilinkBotId: string;
  /** The confirmed `ilink_user_id`; must be present or the instance is not created. */
  ownerExternalUserId: string;
  workspace?: WorkspaceScope;
  policy?: Partial<MessagingPolicy>;
  responseMode?: MessagingResponseMode;
}

/**
 * Wechat owner identity is bound at registration time from the confirmed
 * `ilink_user_id`. Owner and allowlist land in the same per-user lock so
 * there is never an unowned-but-enabled window and no first-message claim.
 */
export async function createWechatInstance(uid: string, input: CreateWechatInstanceInput): Promise<MessagingInstanceClient> {
  assertUserId(uid);
  const displayName = boundedText(input.displayName, 'display name', 120);
  const secret = validateSecret('wechat_personal', {
    ilinkBotToken: input.ilinkBotToken,
    ilinkBaseUrl: input.ilinkBaseUrl,
    ilinkBotId: input.ilinkBotId,
  });
  const ownerExternalUserId = boundedText(input.ownerExternalUserId, 'owner user id', 160);
  const allowUserIds = Array.from(new Set([...(input.policy?.allowUserIds ?? []), ownerExternalUserId]));
  return getLock(uid).runExclusive(async () => {
    const config = await readConfig(uid);
    const id = genId12();
    const now = nowIso();
    const instance: MessagingInstanceDisk = {
      id,
      platform: 'wechat_personal',
      displayName,
      enabled: false,
      responseMode: normalizeResponseMode('wechat_personal', input.responseMode, true),
      workspace: normalizeWorkspace(input.workspace),
      policy: normalizePolicy({ ...input.policy, allowUserIds }, true),
      status: { kind: 'disabled', checkedAt: now },
      ownerExternalUserId,
      ownerIdentitySource: 'qr',
      createdAt: now,
      updatedAt: now,
      secretsEnc: encryptSecret(uid, id, secret),
    };
    config.instances[id] = instance;
    await writeConfig(uid, config);
    return toClient(instance, true);
  });
}

export const _registryTestHooks = {
  normalizePolicy,
  normalizeWorkspace,
  normalizeResponseMode,
  normalizeFeishuTenantBrand,
  validateSecret,
  toClient,
};
