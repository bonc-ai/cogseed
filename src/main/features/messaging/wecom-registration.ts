import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { logErrorSummary } from '../../util/log-redact';
import * as manager from './manager';
import type {
  MessagingInstanceClient,
  MessagingPolicy,
  WorkspaceScope,
} from './types';
import {
  isValidWecomBotId,
  isValidWecomBotSecret,
} from './types';

const log = createLogger('messaging:wecom-registration');
const FLOW_RETENTION_MS = 10 * 60 * 1000;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_ORIGIN = 'https://work.weixin.qq.com';
const AUTH_PATH = '/ai/qc/gen';
const CLEANUP_DELAYS_MS = [0, 50, 150] as const;

export type WecomRegistrationState =
  | 'awaiting_scan'
  | 'activating'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed';

export type WecomRegistrationErrorCode =
  | 'invalid_response'
  | 'expired'
  | 'activation_failed';

export interface WecomRegistrationDraft {
  displayName: string;
  workspace?: WorkspaceScope;
  policy?: Partial<MessagingPolicy>;
}

export interface WecomRegistrationStatus {
  flowId: string;
  state: WecomRegistrationState;
  authUrl?: string;
  expiresAt?: string;
  errorCode?: WecomRegistrationErrorCode;
  instance?: MessagingInstanceClient;
}

interface WecomRegistrationFlow {
  readonly uid: string;
  readonly flowId: string;
  readonly draft: WecomRegistrationDraft;
  readonly authUrl: string;
  state: WecomRegistrationState;
  expiresAt: number;
  errorCode?: WecomRegistrationErrorCode;
  instance?: MessagingInstanceClient;
  finishedAt?: number;
  activation?: Promise<WecomRegistrationStatus>;
}

const currentFlows = new Map<string, WecomRegistrationFlow>();
const retiredFlows = new Map<string, WecomRegistrationFlow>();

function flowKey(uid: string, flowId: string): string {
  return `${uid}\u0000${flowId}`;
}

function assertUserId(uid: string): void {
  if (!safeId(uid)) throw new Error('invalid user id');
}

function assertFlowId(flowId: string): void {
  if (!safeId(flowId)) throw new Error('invalid WeCom registration flow id');
}

function assertDraft(draft: WecomRegistrationDraft): WecomRegistrationDraft {
  if (!draft || typeof draft !== 'object') throw new Error('invalid WeCom registration draft');
  if (typeof draft.displayName !== 'string') throw new Error('display name required');
  const displayName = draft.displayName.trim();
  if (!displayName) throw new Error('display name required');
  if (displayName.length > 120) throw new Error('display name too long');
  if (draft.workspace !== undefined && (!draft.workspace || typeof draft.workspace !== 'object')) {
    throw new Error('invalid workspace');
  }
  if (draft.policy !== undefined && (!draft.policy || typeof draft.policy !== 'object')) {
    throw new Error('invalid policy');
  }
  return { ...draft, displayName };
}

function validateCredentials(botId: string, botSecret: string): { wecomBotId: string; wecomBotSecret: string } {
  if (typeof botId !== 'string' || !isValidWecomBotId(botId.trim())) throw new Error('invalid WeCom bot id');
  if (typeof botSecret !== 'string' || !isValidWecomBotSecret(botSecret.trim())) {
    throw new Error('invalid WeCom bot secret');
  }
  return { wecomBotId: botId.trim(), wecomBotSecret: botSecret.trim() };
}

function pruneRetiredFlows(): void {
  const cutoff = Date.now() - FLOW_RETENTION_MS;
  for (const [key, flow] of retiredFlows) {
    if (flow.finishedAt !== undefined && flow.finishedAt < cutoff) retiredFlows.delete(key);
  }
}

function flowFor(uid: string, flowId: string): WecomRegistrationFlow | undefined {
  pruneRetiredFlows();
  const current = currentFlows.get(uid);
  if (current?.flowId === flowId) return current;
  return retiredFlows.get(flowKey(uid, flowId));
}

function isCurrent(flow: WecomRegistrationFlow): boolean {
  return currentFlows.get(flow.uid) === flow;
}

function isPending(flow: WecomRegistrationFlow): boolean {
  return flow.state === 'awaiting_scan' || flow.state === 'activating';
}

function finish(flow: WecomRegistrationFlow, state: WecomRegistrationState, errorCode?: WecomRegistrationErrorCode): void {
  flow.state = state;
  flow.errorCode = errorCode;
  flow.finishedAt = Date.now();
}

function expireIfNeeded(flow: WecomRegistrationFlow): boolean {
  if (!isCurrent(flow) || !isPending(flow) || Date.now() < flow.expiresAt) return false;
  finish(flow, 'expired', 'expired');
  return true;
}

function canActivate(flow: WecomRegistrationFlow): boolean {
  return isCurrent(flow) && flow.state === 'activating' && !expireIfNeeded(flow);
}

function publicStatus(flow: WecomRegistrationFlow): WecomRegistrationStatus {
  return {
    flowId: flow.flowId,
    state: flow.state,
    ...(isPending(flow) ? {
      authUrl: flow.authUrl,
      expiresAt: new Date(flow.expiresAt).toISOString(),
    } : {}),
    ...(flow.errorCode ? { errorCode: flow.errorCode } : {}),
    ...(flow.instance ? { instance: flow.instance } : {}),
  };
}

/**
 * Enterprise WeCom owns both QR-code generation and result polling on this
 * page. Do not mint a look-alike URL or attach an application-controlled
 * callback: after successful authorization the official page posts the bot
 * credentials to its opener, where the renderer validates its origin and the
 * exact popup window before forwarding them over IPC.
 */
function buildAuthUrl(): string {
  const url = new URL(AUTH_PATH, AUTH_ORIGIN);
  return url.toString();
}

async function wait(ms: number): Promise<void> {
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function removeStaleInstance(uid: string, instanceId: string): Promise<void> {
  let lastError: unknown;
  for (const delay of CLEANUP_DELAYS_MS) {
    await wait(delay);
    try {
      await manager.deleteInstance(uid, instanceId);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  log.error('stale WeCom registration instance cleanup failed', {
    instanceId,
    error: logErrorSummary(lastError),
  });
  throw new Error('unable to remove stale WeCom registration instance', { cause: lastError });
}

async function discardCreatedInstance(flow: WecomRegistrationFlow, instance: MessagingInstanceClient): Promise<boolean> {
  try {
    await removeStaleInstance(flow.uid, instance.id);
    if (isCurrent(flow) && flow.instance?.id === instance.id) flow.instance = undefined;
    return true;
  } catch (error) {
    // Keep only the metadata DTO so a failed compensation is visible and
    // recoverable without exposing the bot secret in the status response.
    log.error('WeCom registration compensation requires manual cleanup', {
      flowId: flow.flowId,
      instanceId: instance.id,
      error: logErrorSummary(error),
    });
    flow.instance = instance;
    finish(flow, 'failed', 'activation_failed');
    return false;
  }
}

export async function startWecomQrRegistration(
  uid: string,
  draft: WecomRegistrationDraft,
): Promise<WecomRegistrationStatus> {
  assertUserId(uid);
  const normalizedDraft = assertDraft(draft);
  const previous = currentFlows.get(uid);
  if (previous) {
    if (isPending(previous)) finish(previous, 'cancelled');
    retiredFlows.set(flowKey(uid, previous.flowId), previous);
  }
  const flowId = randomUUID();
  const expiresAt = Date.now() + AUTH_WINDOW_MS;
  const flow: WecomRegistrationFlow = {
    uid,
    flowId,
    draft: normalizedDraft,
    authUrl: buildAuthUrl(),
    state: 'awaiting_scan',
    expiresAt,
  };
  currentFlows.set(uid, flow);
  return publicStatus(flow);
}

export function getWecomQrRegistrationStatus(uid: string, flowId: string): WecomRegistrationStatus {
  assertUserId(uid);
  assertFlowId(flowId);
  const flow = flowFor(uid, flowId);
  if (!flow) throw new Error('WeCom registration flow not found');
  expireIfNeeded(flow);
  return publicStatus(flow);
}

export function cancelWecomQrRegistration(uid: string, flowId: string): WecomRegistrationStatus {
  assertUserId(uid);
  assertFlowId(flowId);
  const flow = flowFor(uid, flowId);
  if (!flow) throw new Error('WeCom registration flow not found');
  if (isPending(flow)) finish(flow, 'cancelled');
  return publicStatus(flow);
}

export async function completeWecomQrRegistration(
  uid: string,
  flowId: string,
  botId: string,
  botSecret: string,
): Promise<WecomRegistrationStatus> {
  assertUserId(uid);
  assertFlowId(flowId);
  const flow = flowFor(uid, flowId);
  if (!flow) throw new Error('WeCom registration flow not found');
  if (flow.state === 'completed') return publicStatus(flow);
  if (!isCurrent(flow) || !isPending(flow)) return publicStatus(flow);
  if (expireIfNeeded(flow)) return publicStatus(flow);
  // The official page can repeat AUTH_SUCCESS while it retries its own
  // result polling. Join the in-flight activation instead of creating a
  // second local instance from the same temporary credentials.
  if (flow.activation) return flow.activation;
  const secret = validateCredentials(botId, botSecret);
  flow.state = 'activating';
  const activation = (async (): Promise<WecomRegistrationStatus> => {
    let created: MessagingInstanceClient | undefined;
    try {
      created = await manager.createInstance(uid, {
        platform: 'wecom',
        displayName: flow.draft.displayName,
        workspace: flow.draft.workspace,
        policy: flow.draft.policy,
        secret,
      });
      flow.instance = created;
      if (!canActivate(flow)) {
        await discardCreatedInstance(flow, created);
        return publicStatus(flow);
      }
      const enabled = await manager.setEnabled(uid, created.id, true);
      flow.instance = enabled;
      if (!canActivate(flow)) {
        await discardCreatedInstance(flow, enabled);
        return publicStatus(flow);
      }
      finish(flow, 'completed');
      return publicStatus(flow);
    } catch (error) {
      const expired = expireIfNeeded(flow);
      if (created) {
        const discarded = await discardCreatedInstance(flow, created);
        if (!discarded) return publicStatus(flow);
      }
      if (isCurrent(flow) && flow.state === 'activating' && !expired) {
        finish(flow, 'failed', 'activation_failed');
      }
      log.warn('WeCom QR registration activation failed', {
        flowId: flow.flowId,
        expired,
        error: logErrorSummary(error),
      });
      return publicStatus(flow);
    }
  })();
  flow.activation = activation;
  try {
    return await activation;
  } finally {
    if (flow.activation === activation) flow.activation = undefined;
  }
}

export const _wecomRegistrationTestHooks = {
  currentFlows,
  retiredFlows,
  buildAuthUrl,
  validateCredentials,
  publicStatus,
};
