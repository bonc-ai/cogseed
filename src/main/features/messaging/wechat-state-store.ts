import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { Mutex } from 'async-mutex';

import { createLogger } from '../../logger';
import { writeJson } from '../../storage';
import { userMessagingWeChatStateFile } from '../../paths';
import * as localSecrets from '../../util/local-secret-store';

const log = createLogger('messaging:wechat-state');
const SECRET_NAMESPACE = 'messaging.wechat.state';
const locks = new Map<string, Mutex>();

export interface WechatPeerState {
  contextToken: string;
  updatedAt: number;
  lastInboundAt: number;
}

export interface WechatInstanceState {
  /** Binds this state to a specific bot+owner pair; a re-bound account must
   * never read a previous account's cursor or tokens. */
  credentialFingerprint: string;
  getUpdatesBuf: string;
  peers: Record<string, WechatPeerState>;
}

interface WechatStateFile {
  version: 1;
  instances: Record<string, { stateEnc?: string }>;
}

/** Fresh object per call. A shared constant would alias its `instances` map
 * into every missing-file read path: a save through that path would then
 * mutate module state and resurrect stale entries after the file disappears. */
function emptyFile(): WechatStateFile {
  return { version: 1, instances: {} };
}
const PEER_MAX = 8;
const PEER_ID_MAX = 160;
const TOKEN_MAX = 2048;

function lockFor(uid: string): Mutex {
  let lock = locks.get(uid);
  if (!lock) {
    lock = new Mutex();
    locks.set(uid, lock);
  }
  return lock;
}

function secretContext(uid: string, instanceId: string): localSecrets.LocalSecretContext {
  return { namespace: SECRET_NAMESPACE, ownerId: uid, recordId: instanceId };
}

/** Registration always clears instance state, so a re-bound account can never
 * carry a stale cursor or tokens; the fingerprint binds state to the bot+owner
 * pair as a second guard. */
export function wechatCredentialFingerprint(ilinkBotId: string, ownerExternalUserId: string): string {
  return createHash('sha256').update(`${ilinkBotId}\u0000${ownerExternalUserId}`).digest('hex');
}

/** Corrupt state is isolated (renamed `.corrupt.<ts>`) and treated as absent;
 * cursor replay is deduped by the inbound ledger and a missing token simply
 * reads back as `wechat_context_missing` until the next inbound message. */
async function isolateCorrupt(uid: string, instanceId?: string): Promise<void> {
  try {
    const file = userMessagingWeChatStateFile(uid);
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt.${Date.now()}`);
  } catch (error) {
    log.error('wechat state corruption isolation failed', {
      ...(instanceId ? { instanceId } : {}),
      error: (error as Error).message,
    });
  }
}

async function readFile(uid: string): Promise<WechatStateFile> {
  const filePath = userMessagingWeChatStateFile(uid);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return emptyFile();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A raw read is required here: `readJson` swallows parse errors and would
    // look like a missing file, so the corrupt file would never be isolated.
    log.error('wechat state file corrupt (bad json), isolating');
    await isolateCorrupt(uid);
    return emptyFile();
  }
  const rawFile = parsed as Partial<WechatStateFile>;
  if (rawFile.version !== 1 || !rawFile.instances || typeof rawFile.instances !== 'object') {
    return emptyFile();
  }
  return { version: 1, instances: rawFile.instances as WechatStateFile['instances'] };
}

async function writeFile(uid: string, file: WechatStateFile): Promise<void> {
  await writeJson(userMessagingWeChatStateFile(uid), file);
}

function decryptState(uid: string, instanceId: string, enc: string): WechatInstanceState | null {
  try {
    const text = localSecrets.decryptLocalSecret(secretContext(uid, instanceId), enc);
    const parsed = JSON.parse(text) as Partial<WechatInstanceState>;
    if (typeof parsed.credentialFingerprint !== 'string'
      || typeof parsed.getUpdatesBuf !== 'string'
      || !parsed.peers || typeof parsed.peers !== 'object') {
      return null;
    }
    return parsed as WechatInstanceState;
  } catch {
    return null;
  }
}

function encryptState(uid: string, instanceId: string, state: WechatInstanceState): string {
  return localSecrets.encryptLocalSecret(secretContext(uid, instanceId), JSON.stringify(state));
}

async function loadState(uid: string, instanceId: string, fingerprint: string): Promise<WechatInstanceState | null> {
  return lockFor(uid).runExclusive(async () => {
    const file = await readFile(uid);
    const entry = file.instances[instanceId];
    if (!entry?.stateEnc) return null;
    const state = decryptState(uid, instanceId, entry.stateEnc);
    if (!state) {
      log.error('wechat state unreadable, isolating', { instanceId });
      await isolateCorrupt(uid, instanceId);
      delete file.instances[instanceId];
      await writeFile(uid, file);
      return null;
    }
    if (state.credentialFingerprint !== fingerprint) return null;
    return state;
  });
}

export async function loadWechatState(uid: string, instanceId: string, fingerprint: string): Promise<WechatInstanceState | null> {
  return loadState(uid, instanceId, fingerprint);
}

async function saveState(uid: string, instanceId: string, fingerprint: string, mutate: (state: WechatInstanceState) => void): Promise<void> {
  await lockFor(uid).runExclusive(async () => {
    const file = await readFile(uid);
    const entry = file.instances[instanceId];
    let state: WechatInstanceState | null = null;
    if (entry?.stateEnc) {
      state = decryptState(uid, instanceId, entry.stateEnc);
      if (!state) {
        log.error('wechat state unreadable, isolating before write', { instanceId });
        await isolateCorrupt(uid, instanceId);
        delete file.instances[instanceId];
        state = null;
      }
    }
    if (state && state.credentialFingerprint !== fingerprint) {
      // Fail closed: never merge new writes into a foreign account's state.
      state = null;
    }
    if (!state) {
      state = { credentialFingerprint: fingerprint, getUpdatesBuf: '', peers: {} };
    }
    mutate(state);
    file.instances[instanceId] = { stateEnc: encryptState(uid, instanceId, state) };
    await writeFile(uid, file);
  });
}

export async function saveWechatCursor(uid: string, instanceId: string, fingerprint: string, getUpdatesBuf: string): Promise<void> {
  if (!getUpdatesBuf) return;
  await saveState(uid, instanceId, fingerprint, (state) => {
    state.getUpdatesBuf = getUpdatesBuf.slice(0, 4096);
  });
}

export async function saveWechatPeerToken(
  uid: string,
  instanceId: string,
  fingerprint: string,
  peerId: string,
  contextToken: string,
  now: number,
): Promise<string> {
  if (!peerId || peerId.length > PEER_ID_MAX || !contextToken || contextToken.length > TOKEN_MAX) {
    throw new Error('invalid wechat peer token entry');
  }
  // tokenRef encodes the peer id so a delivery retry after restart can map
  // back to the peer; the token read back is the peer's current token, which
  // only changes on inbound (the token that triggered the reply round).
  const tokenRef = `${peerId}::${randomUUID()}`;
  await saveState(uid, instanceId, fingerprint, (state) => {
    if (state.peers[peerId] === undefined && Object.keys(state.peers).length >= PEER_MAX) {
      // Only the owner is expected; bounded growth is a hard safety net.
      const oldest = Object.entries(state.peers)
        .sort((a, b) => a[1].lastInboundAt - b[1].lastInboundAt)[0];
      if (oldest) delete state.peers[oldest[0]];
    }
    state.peers[peerId] = { contextToken, updatedAt: now, lastInboundAt: now };
  });
  return tokenRef;
}

export async function readWechatPeerToken(
  uid: string,
  instanceId: string,
  tokenRef: string,
): Promise<{ token: string; peerId: string } | null> {
  return lockFor(uid).runExclusive(async () => {
    const separator = tokenRef.indexOf('::');
    const peerId = separator > 0 ? tokenRef.slice(0, separator) : '';
    if (!peerId) return null;
    const file = await readFile(uid);
    const entry = file.instances[instanceId];
    if (!entry?.stateEnc) return null;
    const state = decryptState(uid, instanceId, entry.stateEnc);
    const peer = state?.peers[peerId];
    if (!state || !peer || typeof peer.contextToken !== 'string' || !peer.contextToken) return null;
    return { token: peer.contextToken, peerId };
  });
}

export async function clearWechatInstanceState(uid: string, instanceId: string): Promise<void> {
  await lockFor(uid).runExclusive(async () => {
    const file = await readFile(uid);
    delete file.instances[instanceId];
    await writeFile(uid, file);
  });
}

export async function deleteWechatInstanceState(uid: string, instanceId: string): Promise<void> {
  await clearWechatInstanceState(uid, instanceId);
}
