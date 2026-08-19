/**
 * Launch-confirmation gate for external CLI agents.
 *
 * User story: on first install CogSeed has no API-key model configured, so a
 * first message auto-routes to a local CLI agent (claude / codex / opencode /
 * …) via the CLI fallback path — or the user @-mentions an external agent.
 * Either way the FIRST time a conversation hands a message to an EXTERNAL CLI
 * agent, the user must explicitly confirm that handoff; a silent spawn would
 * send the user's message (and, from then on, filesystem / tool access) to a
 * third-party program without consent.
 *
 * The confirmation is per-CONVERSATION first use: each conversation (cid)
 * asks once per (agent, cli) the first time that external agent would be
 * launched in it. Product decision (2026-08-19): a NEW conversation must
 * always re-confirm — consent is scoped to the conversation the user is
 * actively working in, not remembered globally across conversations. Within
 * one conversation, an "allow" verdict covers later turns so the user is
 * not re-prompted every message.
 *
 * Flow:
 *   1. If this conversation already allowed this (agent, cli), grant
 *      silently (store survives restarts mid-conversation).
 *   2. Otherwise a `local-agents:launch-confirm` push event asks the
 *      renderer to show the allow / deny dialog; the renderer answers
 *      through the `local-agents.launch_confirm_response` IPC.
 *   3. No answer within the timeout (user away / window closed) → DENY.
 *      The turn is refused and the message is not sent to the CLI.
 *
 * Store: `<uid>/local/config/launch-permissions.json` — machine-private.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { userLocalConfigDir } from '../../paths';
import { createLogger } from '../../logger';
import { logErrorRef, maskId } from '../../util/log-redact';

const log = createLogger('local-agents:launch-confirm');

// Human-in-the-loop confirmation window. A launch is still denied if
// unanswered, but 2 minutes was too easy to hit when the user stepped away
// during a long-running agent task.
const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

interface StoreFile {
  version: 1;
  /** sessions[cid][agentKey] === 'allow' — per-conversation allow verdicts.
   *  agentKey = `${agentId}:${cli}`. Scoped to a single conversation so a
   *  new conversation always re-confirms; persists restarts mid-conversation.
   *  Denies are never remembered (a deny should not permanently brick an
   *  agent without a UI to undo it). */
  sessions: Record<string, Record<string, 'allow'>>;
}

function storeFile(uid: string): string {
  return path.join(userLocalConfigDir(uid), 'launch-permissions.json');
}

function readStore(uid: string): StoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(uid), 'utf8'));
    const sessions = parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object'
      ? parsed.sessions
      : {};
    return { version: 1, sessions };
  } catch { /* missing / corrupt → empty */ }
  return { version: 1, sessions: {} };
}

function writeStore(uid: string, store: StoreFile): void {
  const p = storeFile(uid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function agentKey(agentId: string, cli: string): string {
  return `${agentId}:${cli}`;
}

/** Allow verdicts are scoped to a conversation (cid): a NEW conversation
 *  always re-confirms the first launch of an external agent. */
export function hasSessionAllow(uid: string, cid: string, agentId: string, cli: string): boolean {
  return readStore(uid).sessions[cid]?.[agentKey(agentId, cli)] === 'allow';
}

export function recordSessionAllow(uid: string, cid: string, agentId: string, cli: string): void {
  const store = readStore(uid);
  const session = store.sessions[cid] || {};
  session[agentKey(agentId, cli)] = 'allow';
  store.sessions[cid] = session;
  writeStore(uid, store);
  log.info('launch allow recorded', { cid: maskId(cid), agent_id: maskId(agentId), cli });
}

// ── Pending requests ─────────────────────────────────────────────────────

export interface LaunchConfirmRequestInfo {
  request_id: string;
  agent_id: string;
  agent_name: string;
  cli: string;
  cid: string;
}

interface Pending {
  info: LaunchConfirmRequestInfo;
  uid: string;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

const _pending = new Map<string, Pending>();

/** Lazy ipc lookup — same pattern `connectors/registry.ts` uses for
 *  `connectors:changed`; avoids a static feature→ipc import cycle and
 *  degrades cleanly in tests / the open-source build without the IPC bridge. */
function _broadcast(channel: string, payload: unknown): boolean {
  if (_broadcastOverride) {
    _broadcastOverride(channel, payload);
    return true;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    if (!ipc.broadcastToRenderer) return false;
    ipc.broadcastToRenderer(channel, payload);
    return true;
  } catch {
    return false;
  }
}

/** Test seam: capture the `local-agents:launch-confirm` push without loading
 *  the electron-backed ipc module. Pass null to restore the default. */
let _broadcastOverride: ((channel: string, payload: unknown) => void) | null = null;
export function _setBroadcastForTest(fn: ((channel: string, payload: unknown) => void) | null): void {
  _broadcastOverride = fn;
}

/**
 * Gate one external-agent launch. Resolves true (allowed) / false.
 * Never throws — a broken push channel degrades to deny-after-timeout.
 *
 * Per-conversation semantics: the same (cid, agent, cli) is asked at most
 * once — after an allow, later turns in this conversation launch silently;
 * a NEW conversation always asks again.
 */
export async function requestLaunchConfirm(opts: {
  uid: string;
  cid: string;
  agentId: string;
  agentName: string;
  cli: string;
}): Promise<boolean> {
  if (hasSessionAllow(opts.uid, opts.cid, opts.agentId, opts.cli)) return true;

  const requestId = crypto.randomBytes(8).toString('hex');
  const info: LaunchConfirmRequestInfo = {
    request_id: requestId,
    agent_id: opts.agentId,
    agent_name: opts.agentName,
    cli: opts.cli,
    cid: opts.cid,
  };

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      _pending.delete(requestId);
      log.warn('launch confirm timed out → deny', {
        request_id: maskId(requestId),
        agent_id: maskId(opts.agentId),
        cli: opts.cli,
      });
      resolve(false);
    }, RESPONSE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    _pending.set(requestId, { info, uid: opts.uid, resolve, timer });
    if (!_broadcast('local-agents:launch-confirm', info)) {
      log.warn('no renderer broadcast available — launch will deny on timeout', { request_id: maskId(requestId) });
    }
  });
}

/** Renderer answer (via `local-agents.launch_confirm_response`). Unknown ids
 *  are ignored (stale dialog after timeout). `always` is accepted for IPC
 *  backward-compat but ignored: consent is per-conversation, never global.
 */
export function respond(requestId: string, allow: boolean, always: boolean): boolean {
  const pending = _pending.get(requestId);
  if (!pending) return false;
  _pending.delete(requestId);
  clearTimeout(pending.timer);
  if (allow) {
    try { recordSessionAllow(pending.uid, pending.info.cid, pending.info.agent_id, pending.info.cli); }
    catch (err) { log.warn('launch allow persist failed', { error: logErrorRef(err) }); }
  }
  pending.resolve(allow);
  return true;
}

/** Abandon every pending request for a conversation (run ended / aborted). */
export function cancelForCid(cid: string): void {
  for (const [id, pending] of _pending) {
    if (pending.info.cid !== cid) continue;
    _pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(false);
  }
}
