import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-wechat-state-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('wechat state store', () => {
  it('round-trips cursor and peer tokens, encrypted on disk', async () => {
    const store = await import('../../../src/main/features/messaging/wechat-state-store');
    const fingerprint = store.wechatCredentialFingerprint('bot-1', 'owner-1');
    await store.saveWechatCursor('uid-1', 'inst-1', fingerprint, 'buf-1');
    const ref = await store.saveWechatPeerToken('uid-1', 'inst-1', fingerprint, 'peer-1', 'tok-abc', 1_700_000_000_000);
    const state = await store.loadWechatState('uid-1', 'inst-1', fingerprint);
    expect(state?.getUpdatesBuf).toBe('buf-1');
    expect(state?.peers['peer-1']?.contextToken).toBe('tok-abc');
    const token = await store.readWechatPeerToken('uid-1', 'inst-1', ref);
    expect(token?.peerId).toBe('peer-1');
    expect(token?.token).toBe('tok-abc');
    // 磁盘上不明文
    const raw = fs.readFileSync(
      path.join(tmpDir, 'uid-1', 'local', 'config', 'messaging-wechat-state.json'),
      'utf8',
    );
    expect(raw).not.toContain('tok-abc');
    expect(raw).not.toContain('buf-1');
  });

  it('fails closed when the credential fingerprint does not match', async () => {
    const store = await import('../../../src/main/features/messaging/wechat-state-store');
    await store.saveWechatCursor('uid-1', 'inst-1', store.wechatCredentialFingerprint('bot-1', 'owner-1'), 'buf-old');
    const state = await store.loadWechatState('uid-1', 'inst-1', store.wechatCredentialFingerprint('bot-2', 'owner-1'));
    expect(state).toBeNull();
  });

  it('isolates a corrupt file and rebuilds empty state', async () => {
    const store = await import('../../../src/main/features/messaging/wechat-state-store');
    const { userMessagingWeChatStateFile } = await import('../../../src/main/paths');
    const file = userMessagingWeChatStateFile('uid-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const fingerprint = store.wechatCredentialFingerprint('bot-1', 'owner-1');
    expect(await store.loadWechatState('uid-1', 'inst-1', fingerprint)).toBeNull();
    // Isolation renames the corrupt file to a timestamped sibling
    // (`<file>.corrupt.<ts>`); assert the `.corrupt`-prefixed sibling exists.
    const siblings = fs.readdirSync(path.dirname(file));
    expect(siblings.some((name) => name.startsWith(`${path.basename(file)}.corrupt`))).toBe(true);
  });

  it('clears and deletes instance state', async () => {
    const store = await import('../../../src/main/features/messaging/wechat-state-store');
    const fingerprint = store.wechatCredentialFingerprint('bot-1', 'owner-1');
    await store.saveWechatPeerToken('uid-1', 'inst-1', fingerprint, 'peer-1', 'tok-1', 1);
    await store.clearWechatInstanceState('uid-1', 'inst-1');
    expect(await store.loadWechatState('uid-1', 'inst-1', fingerprint)).toBeNull();
    await store.saveWechatCursor('uid-1', 'inst-2', fingerprint, 'buf-2');
    await store.deleteWechatInstanceState('uid-1', 'inst-2');
    expect(await store.loadWechatState('uid-1', 'inst-2', fingerprint)).toBeNull();
  });
});
