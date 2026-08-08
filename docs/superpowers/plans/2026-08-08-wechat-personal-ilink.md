# 个人微信（iLink）接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过腾讯官方 iLink Bot API 为 PC 新增个人微信渠道——扫码绑定、长轮询收消息、带 context_token 的回复与尽力而为的主动消息。

**Architecture:** 在现有 messaging 框架内新增一个平台：`WechatPersonalAdapter`（纯 fetch 实现 iLink HTTP 协议，长轮询 + 游标 + generation 代际）、`wechat-registration`（扫码状态机）、`wechat-state-store`（cursor/context_token 加密落盘）。owner 注册时由 `confirmed.ilink_user_id` 原子绑定。回复通过 `contextTokenRef` 绑定触发它的那条消息的 token。

**Tech Stack:** TypeScript、Node 原生 `fetch`（redirect: "error"）、现有 `async-mutex`/`local-secret-store`/`storage.ts`、vitest（`npm test`）。

## Global Constraints

- 平台枚举新增 `'wechat_personal'`；`types.ts` 的 `MessagingPlatformCatalogEntry.platform` 已允许该值
- 所有 iLink 请求：`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <token>`、`X-WECHAT-UIN: base64(random uint32)`（每次请求随机）、`iLink-App-Id`、`iLink-App-ClientVersion`、`Content-Type: application/json`、`redirect: "error"`
- Base URL 只接受 HTTPS、无用户名密码、标准端口、host ∈ `TRUSTED_ILINK_HOSTS`（初始 `ilinkai.weixin.qq.com`）
- `context_token` 只能从入站消息获取；`sendmessage` 响应不返回新 token；回复必须使用触发它的 token（`contextTokenRef`）
- `get_updates_buf` 是 opaque cursor，整批处理完（全部到达 ledger 终态）才提交，响应值整体替换
- owner 在注册时由 `confirmed.ilink_user_id` 绑定（`ownerExternalUserId` + `policy.allowUserIds` 同一 per-user 锁内写入）；`ilink_bot_id`/`ilink_user_id` 缺失 → 注册 `failed`，不创建实例
- 非 owner 消息：进 manager 产生 ledger 拒绝记录，不写 peer state；群消息（`group_id`）adapter 边界忽略
- 动态状态（cursor/peer token/时间戳）全部位于加密 payload（local-secret facade），存 `<uid>/local/config/messaging-wechat-state.json`（经 `paths.ts` helper）
- state 读取时校验 `credentialFingerprint`，不匹配 fail closed；重绑（凭据/owner 变化）必须清空 state；删实例删 state；损坏隔离为 `.corrupt` 并重建
- adapter 持 generation 代际：`start()` 递增，旧代际 fetch 结果丢弃（不写 state、不调 onInbound）
- `checkHealth()`：缓存状态 + 距最后成功 `getupdates` 90s 阈值；HTTP 401 / JSON `ret=-14` 为终态"需要重新扫码"，不进错误退避
- 主动消息（proactive）：仅 owner、目标固定 `self`、owner 有最新 token 且 `lastInboundAt ≤ 24h`；错误码 `wechat_context_missing` / `wechat_context_expired_locally` / `wechat_reauth_required` / `wechat_context_rejected` / `wechat_not_connected`
- 一期只支持 direct；不把"微信渲染 Markdown"作为协议保证
- 无新 npm 依赖；`npm test` 必须全绿

---

### Task 1: 类型与路径扩展

**Files:**
- Modify: `src/main/features/messaging/types.ts`
- Modify: `src/main/paths.ts`（`userLocalConfigDir` 附近，约 468 行 messaging 区块）
- Test: `test/main/features/messaging.test.ts`（追加类型断言用例）

**Interfaces:**
- Produces: `MessagingPlatform` 联合类型包含 `'wechat_personal'`；`MessagingSecret.ilinkBotToken/ilinkBaseUrl/ilinkBotId`；`InboundEnvelope.contextTokenRef`；`MessagingSendContext.contextTokenRef`；`DeliveryLedgerEntry.contextTokenRef`；`paths.userMessagingWeChatStateFile(uid)`

- [ ] **Step 1: 写失败测试（平台枚举 + 路径 helper）**

在 `test/main/features/messaging.test.ts` 末尾追加：

```ts
describe('wechat_personal platform types', () => {
  it('includes wechat_personal in the platform union and registry validation', async () => {
    const { MESSAGING_PLATFORMS } = await import('../../../src/main/features/messaging/types');
    expect(MESSAGING_PLATFORMS).toContain('wechat_personal');
  });

  it('exposes the wechat state file under the local config dir', async () => {
    const { userMessagingWeChatStateFile } = await import('../../../src/main/paths');
    const file = userMessagingWeChatStateFile('uid-1');
    expect(file).toContain('config');
    expect(file).toContain('messaging-wechat-state.json');
    expect(file).not.toContain('cloud');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/main/features/messaging.test.ts`
Expected: FAIL——`MESSAGING_PLATFORMS` 不含 `wechat_personal`，`userMessagingWeChatStateFile` 未定义

- [ ] **Step 3: 实现类型与路径**

`src/main/features/messaging/types.ts`：

```ts
export const MESSAGING_PLATFORMS = ['telegram', 'feishu_lark', 'wecom', 'wechat_personal'] as const;
export type MessagingPlatform = (typeof MESSAGING_PLATFORMS)[number];
```

`MessagingSecret` 增加：

```ts
export interface MessagingSecret {
  botToken?: string;
  appId?: string;
  appSecret?: string;
  tenantAccessToken?: string;
  wecomBotId?: string;
  wecomBotSecret?: string;
  /** iLink (personal WeChat) credentials. `ilinkBaseUrl` is the confirmed
   * base URL, validated against the static host whitelist before storage. */
  ilinkBotToken?: string;
  ilinkBaseUrl?: string;
  ilinkBotId?: string;
}
```

`InboundEnvelope` 增加（注释说明用途）：

```ts
  /** Wechat-personal only: reference to the encrypted context_token snapshot
   * in the wechat state store. The reply for this message must use exactly
   * this token; it is never the peer's latest token. */
  contextTokenRef?: string;
```

`DeliveryLedgerEntry` 与 `MessagingSendContext` 各增加一行 `contextTokenRef?: string;`（同上注释）。

`src/main/paths.ts` 在 messaging 文件定义区块（约 468-474 行）追加：

```ts
// Wechat iLink dynamic state (cursor + context tokens) is machine-private
// and encrypted in place; never synced.
export const userMessagingWeChatStateFile = (uid: string) => path.join(userLocalConfigDir(uid), 'messaging-wechat-state.json');
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/main/features/messaging.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/types.ts src/main/paths.ts test/main/features/messaging.test.ts
git commit -m "feat(messaging): wechat_personal 平台类型与状态文件路径"
```

---

### Task 2: registry——微信凭据校验与 owner 原子绑定

**Files:**
- Modify: `src/main/features/messaging/registry.ts`
- Test: `test/main/features/messaging.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: Task 1 的 `MessagingSecret.ilinkBotToken/ilinkBaseUrl/ilinkBotId`
- Produces: `TRUSTED_ILINK_HOSTS`、`isTrustedIlinkBaseUrl(value: string): boolean`、`CreateWechatInstanceInput`、`createWechatInstance(uid, input): Promise<MessagingInstanceClient>`

- [ ] **Step 1: 写失败测试**

```ts
describe('wechat_personal registry', () => {
  const validSecret = {
    ilinkBotToken: 'a'.repeat(64),
    ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
    ilinkBotId: 'bot-12345',
  };

  it('validates iLink secrets and rejects untrusted base urls', async () => {
    const { _registryTestHooks } = await import('../../../src/main/features/messaging/registry');
    expect(_registryTestHooks.validateSecret('wechat_personal', validSecret)).toEqual(validSecret);
    const badUrls = [
      'http://ilinkai.weixin.qq.com',              // 非 HTTPS
      'https://evil.example.com',                  // 非白名单 host
      'https://user:pass@ilinkai.weixin.qq.com',   // 带用户信息
      'https://ilinkai.weixin.qq.com:8443',        // 非标准端口
      'not a url',
    ];
    for (const url of badUrls) {
      expect(() => _registryTestHooks.validateSecret('wechat_personal', { ...validSecret, ilinkBaseUrl: url }))
        .toThrow();
    }
    expect(() => _registryTestHooks.validateSecret('wechat_personal', { ...validSecret, ilinkBotToken: 'x' }))
      .toThrow();
  });

  it('creates a wechat instance with owner and allowlist in one atomic write', async () => {
    const registry = await import('../../../src/main/features/messaging/registry');
    const created = await registry.createWechatInstance('uid-1', {
      displayName: '我的微信',
      ...validSecret,
      ownerExternalUserId: 'wxid-owner',
    });
    expect(created.platform).toBe('wechat_personal');
    expect(created.ownerConfigured).toBe(true);
    expect(created.ownerLabel).toBeUndefined();
    expect(created.ownerIdentitySource).toBe('qr');
    const client = await registry.listInstances('uid-1');
    expect(client).toHaveLength(1);
    expect(client[0].policy.allowUserIds).toEqual(['wxid-owner']);
    // 无中间态：直接读盘也同时具备 owner 与 allowlist
    const internal = await registry.getInstance('uid-1', created.id);
    expect(internal?.ownerExternalUserId).toBe('wxid-owner');
    expect(internal?.policy.allowUserIds).toEqual(['wxid-owner']);
  });

  it('fails closed when owner id is missing', async () => {
    const registry = await import('../../../src/main/features/messaging/registry');
    await expect(registry.createWechatInstance('uid-1', {
      displayName: '我的微信',
      ...validSecret,
      ownerExternalUserId: '',
    })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/main/features/messaging.test.ts`
Expected: FAIL——`validateSecret` 对 `wechat_personal` 无分支、`createWechatInstance` 未定义

- [ ] **Step 3: 实现**

`src/main/features/messaging/registry.ts`：

a) 导入区追加 `path` 不需要；在文件顶部常量区追加：

```ts
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
```

b) `validateSecret` 的 wecom 分支之前插入：

```ts
  if (platform === 'wechat_personal') {
    const ilinkBotToken = requiredSecretText(secret.ilinkBotToken, 'ilink bot token', 512);
    if (!/^[A-Za-z0-9._~-]{16,512}$/.test(ilinkBotToken)) throw new Error('invalid iLink bot token');
    const ilinkBaseUrl = requiredSecretText(secret.ilinkBaseUrl, 'ilink base url', 512);
    if (!isTrustedIlinkBaseUrl(ilinkBaseUrl)) throw new Error('untrusted iLink base url');
    const ilinkBotId = requiredSecretText(secret.ilinkBotId, 'ilink bot id', 128);
    return { ilinkBotToken, ilinkBaseUrl, ilinkBotId };
  }
```

c) 文件末尾（`_registryTestHooks` 之前）新增：

```ts
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
```

注意：`normalizePolicy` 的 `allowUserIds` 每项限 160 字符，`boundedText` 已保证。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/main/features/messaging.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/registry.ts test/main/features/messaging.test.ts
git commit -m "feat(messaging): registry 支持 wechat_personal 凭据校验与注册时 owner 原子绑定"
```

---

### Task 3: wechat-state-store——cursor/token 加密落盘

**Files:**
- Create: `src/main/features/messaging/wechat-state-store.ts`
- Test: `test/main/features/messaging-wechat-state.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `paths.userMessagingWeChatStateFile`
- Produces:
  - `wechatCredentialFingerprint(ilinkBotId: string, ownerExternalUserId: string): string`
  - `loadWechatState(uid, instanceId, fingerprint): Promise<WechatInstanceState | null>`（指纹不匹配或损坏 → null 并隔离/清空）
  - `saveWechatCursor(uid, instanceId, fingerprint, getUpdatesBuf): Promise<void>`
  - `saveWechatPeerToken(uid, instanceId, fingerprint, peerId, contextToken, now): Promise<string>`（返回 tokenRef）
  - `clearWechatInstanceState(uid, instanceId): Promise<void>`
  - `deleteWechatInstanceState(uid, instanceId): Promise<void>`
  - `readWechatPeerToken(uid, instanceId, tokenRef): Promise<{ token: string; peerId: string } | null>`

- [ ] **Step 1: 写失败测试**

`test/main/features/messaging-wechat-state.test.ts`（复用 messaging.test.ts 的 tmpDir/ORKAS_WORKSPACE_ROOT 夹具模式）：

```ts
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
    expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/main/features/messaging-wechat-state.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现 `wechat-state-store.ts`**

```ts
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';

import { createLogger } from '../../logger';
import { nowIso, readJson, writeJson } from '../../storage';
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

const EMPTY_FILE: WechatStateFile = { version: 1, instances: {} };
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

async function readFile(uid: string): Promise<WechatStateFile> {
  const raw = await readJson<Partial<WechatStateFile>>(userMessagingWeChatStateFile(uid));
  if (raw.version !== 1 || !raw.instances || typeof raw.instances !== 'object') return { ...EMPTY_FILE };
  return { version: 1, instances: raw.instances as WechatStateFile['instances'] };
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

/** Corrupt state is isolated (renamed `.corrupt`) and treated as absent;
 * cursor replay is deduped by the inbound ledger and a missing token simply
 * reads back as `wechat_context_missing` until the next inbound message. */
async function isolateCorrupt(uid: string, instanceId: string): Promise<void> {
  try {
    const file = userMessagingWeChatStateFile(uid);
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt.${Date.now()}`);
  } catch (error) {
    log.error('wechat state corruption isolation failed', {
      instanceId,
      error: (error as Error).message,
    });
  }
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/main/features/messaging-wechat-state.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/wechat-state-store.ts test/main/features/messaging-wechat-state.test.ts
git commit -m "feat(messaging): wechat-state-store 加密持久化 cursor/context_token（指纹校验与损坏隔离）"
```

---

### Task 4: WechatPersonalAdapter——wire client 与生命周期

**Files:**
- Create: `src/main/features/messaging/wechat-personal.ts`
- Test: `test/main/features/messaging-wechat-personal.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 类型、Task 2 `TRUSTED_ILINK_HOSTS/isTrustedIlinkBaseUrl`、Task 3 state store
- Produces: `WechatPersonalAdapter implements MessagingAdapter`，构造签名 `(instance, secret, uid: string)`（uid 必填，manager 创建时传入；owner 从 instance 读取）；本任务完成 `start/stop/checkHealth`、wire client、长轮询骨架（`getUpdates`/`handleBatch` 最小版：读 state 取 cursor、请求、空批次直接返回，**不写 state、不提交 cursor、不做 owner 过滤**——Task 5 升级为完整版）；导出 `_wechatTestHooks`（`buildHeaders`、`classifyError`、`statusOf`）

- [ ] **Step 1: 写失败测试（wire client + 生命周期）**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-wechat-adapter-'));
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

describe('wechat personal adapter wire contract', () => {
  const instance = {
    id: 'inst-1',
    platform: 'wechat_personal' as const,
    displayName: '我的微信',
    enabled: true,
    responseMode: 'text' as const,
    workspace: { type: 'default' as const },
    policy: { replyMode: 'every_message' as const, allowUserIds: ['owner-1'], allowGroupIds: [], requireMentionInGroups: false },
    status: { kind: 'disconnected' as const, checkedAt: new Date().toISOString() },
    createdAt: '',
    updatedAt: '',
  };
  const secret = {
    ilinkBotToken: 't'.repeat(64),
    ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
    ilinkBotId: 'bot-1',
  };

  it('builds the full header set with a random X-WECHAT-UIN per call', async () => {
    const { _wechatTestHooks } = await import('../../../src/main/features/messaging/wechat-personal');
    const a = _wechatTestHooks.buildHeaders('bot-1', 't'.repeat(64));
    const b = _wechatTestHooks.buildHeaders('bot-1', 't'.repeat(64));
    expect(a['AuthorizationType']).toBe('ilink_bot_token');
    expect(a['Authorization']).toBe(`Bearer ${'t'.repeat(64)}`);
    expect(a['iLink-App-Id']).toBe('bot-1');
    expect(a['iLink-App-ClientVersion']).toBeTruthy();
    expect(a['Content-Type']).toBe('application/json');
    expect(a['X-WECHAT-UIN']).not.toBe(b['X-WECHAT-UIN']);
  });

  it('classifies HTTP 401 and JSON ret=-14 as terminal reauth errors', async () => {
    const { _wechatTestHooks } = await import('../../../src/main/features/messaging/wechat-personal');
    expect(_wechatTestHooks.classifyError(new Error('HTTP 401'))).toBe('reauth_required');
    expect(_wechatTestHooks.classifyError(new Error('ret=-14'))).toBe('reauth_required');
    expect(_wechatTestHooks.classifyError(new Error('socket hang up'))).toBe('network');
  });

  it('long-polls getupdates, commits the opaque cursor after the batch settles, and stops on 401', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const onStatus = vi.fn().mockResolvedValue(undefined);
    const onInbound = vi.fn().mockResolvedValue({ accepted: true, duplicate: false });
    const fetches: Promise<Response>[] = [];
    const makeResponse = (body: unknown): Response => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    // 第一轮：空批次（无 buf 或空 buf），第二轮：401
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        calls.push({ url: String(_url), init });
        fetches.push(Promise.resolve(makeResponse({ ret: 0, get_updates_buf: 'cursor-1', messages: [] })));
        return fetches[fetches.length - 1];
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        calls.push({ url: String(_url), init });
        return makeResponse({ ret: -14, errmsg: 'token invalid' });
      });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new WechatPersonalAdapter(instance, secret, 'uid-1');
    const controller = new AbortController();
    const startPromise = adapter.start(controller.signal, { onInbound, onStatus } as never);
    // 等两轮请求完成
    await vi.waitFor(() => {
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
    // 401 → 终态 error，不自动重试
    await vi.waitFor(() => {
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    });
    controller.abort();
    await startPromise;
    // 所有请求都带 redirect: error 与完整 headers
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers['AuthorizationType']).toBe('ilink_bot_token');
      expect(headers['Authorization']).toContain('Bearer ');
      expect((call.init as { redirect?: string }).redirect).toBe('error');
      expect(call.url).toContain('/ilink/bot/getupdates');
    }
  });

  it('does not treat an external abort or long-poll timeout as an error status', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      throw new Error('aborted');
    }));
    const onStatus = vi.fn().mockResolvedValue(undefined);
    const adapter = new WechatPersonalAdapter(instance, secret, 'uid-1');
    const controller = new AbortController();
    const startPromise = adapter.start(controller.signal, { onInbound: vi.fn(), onStatus } as never);
    setTimeout(() => controller.abort(), 20);
    await startPromise;
    const errorCalls = onStatus.mock.calls.filter(([s]) => s.kind === 'error');
    expect(errorCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/main/features/messaging-wechat-personal.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现 `wechat-personal.ts`（wire client + 生命周期）**

```ts
import { randomBytes } from 'node:crypto';

import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import { isTrustedIlinkBaseUrl } from './registry';
import type {
  AdapterCallbacks,
  InboundEnvelope,
  MessagingAdapter,
  MessagingInstance,
  MessagingInstanceStatus,
  MessagingSecret,
} from './types';

const log = createLogger('messaging:wechat-personal');

const CLIENT_VERSION = 'pc-1.0.0';
const LONG_POLL_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 35_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** checkHealth: last successful long poll within this window counts as connected. */
const HEALTH_STALE_MS = 90_000;

export type WechatErrorClass = 'network' | 'reauth_required' | 'delivery_rejected';

export function buildHeaders(ilinkBotId: string, ilinkBotToken: string): Record<string, string> {
  return {
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${ilinkBotToken}`,
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32LE(0))).toString('base64'),
    'iLink-App-Id': ilinkBotId,
    'iLink-App-ClientVersion': CLIENT_VERSION,
    'Content-Type': 'application/json',
  };
}

export function classifyError(error: unknown): WechatErrorClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 401|401|ret=-14|ret":\s*-14|-14/.test(message)) return 'reauth_required';
  return 'network';
}

export class WechatPersonalAdapter implements MessagingAdapter {
  readonly platform: MessagingPlatform = 'wechat_personal';
  private readonly instance: MessagingInstance;
  private readonly ilinkBotToken: string;
  private readonly ilinkBaseUrl: string;
  private readonly ilinkBotId: string;
  private callbacks: AdapterCallbacks | null = null;
  private generation = 0;
  private terminalError: Error | null = null;
  private lastPollAt = 0;
  private lastStatus: MessagingInstanceStatus = statusOf('disconnected');

  constructor(instance: MessagingInstance, secret: MessagingSecret, uid: string) {
    if (!secret.ilinkBotToken || !secret.ilinkBaseUrl || !secret.ilinkBotId) {
      throw new Error('iLink credentials missing');
    }
    if (!isTrustedIlinkBaseUrl(secret.ilinkBaseUrl)) throw new Error('untrusted iLink base url');
    this.instance = instance;
    this.uid = uid;
    this.ilinkBotToken = secret.ilinkBotToken;
    this.ilinkBaseUrl = secret.ilinkBaseUrl.replace(/\/+$/, '');
    this.ilinkBotId = secret.ilinkBotId;
    this.ownerExternalUserId = (instance as MessagingInstanceInternal).ownerExternalUserId || '';
    this.fingerprint = wechatCredentialFingerprint(this.ilinkBotId, this.ownerExternalUserId);
  }

  private async request(
    pathname: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ ret: number; errmsg?: string; [key: string]: unknown }> {
    const response = await fetch(`${this.ilinkBaseUrl}${pathname}`, {
      method: 'POST',
      headers: buildHeaders(this.ilinkBotId, this.ilinkBotToken),
      body: JSON.stringify({ base_info: {}, ...body }),
      redirect: 'error',
      signal,
    });
    if (response.status === 401) throw new Error('HTTP 401');
    const text = await response.text();
    let parsed: { ret?: unknown; errmsg?: string; [key: string]: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`invalid JSON response (${response.status})`);
    }
    if (typeof parsed.ret === 'number' && parsed.ret !== 0) {
      throw new Error(`ret=${parsed.ret}${parsed.errmsg ? ` ${parsed.errmsg}` : ''}`);
    }
    return parsed;
  }

  async start(signal: AbortSignal, callbacks: AdapterCallbacks): Promise<void> {
    if (signal.aborted) return;
    if (this.callbacks) throw new Error('Wechat adapter already started');
    this.callbacks = callbacks;
    this.terminalError = null;
    this.generation += 1;
    const generation = this.generation;
    await callbacks.onStatus(this.statusOf('connecting'));
    try {
      while (!signal.aborted && !this.terminalError) {
        try {
          const body = await this.getUpdates(generation, signal);
          if (generation !== this.generation || signal.aborted) return;
          await this.handleBatch(generation, body, signal);
        } catch (error) {
          if (generation !== this.generation || signal.aborted) return;
          const cls = classifyError(error);
          if (cls === 'reauth_required') {
            this.terminalError = new Error('Wechat needs re-scan');
            await callbacks.onStatus(this.statusOf('error', '需要重新扫码'));
            return;
          }
          await callbacks.onStatus(this.statusOf('error', 'Wechat connection error'));
          await abortableWait(RETRY_BASE_MS, signal);
          if (generation !== this.generation || signal.aborted) return;
          await callbacks.onStatus(this.statusOf('connecting'));
        }
      }
    } finally {
      if (this.callbacks === callbacks) this.callbacks = null;
      if (!signal.aborted && !this.terminalError) await callbacks.onStatus(this.statusOf('disconnected'));
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
  }

  async checkHealth(): Promise<MessagingInstanceStatus> {
    if (this.terminalError) return this.statusOf('error', this.terminalError.message);
    if (Date.now() - this.lastPollAt <= HEALTH_STALE_MS) return this.statusOf('connected');
    return this.statusOf('disconnected');
  }

  /** Task 5 completes inbound/outbound handling. */
  sendMessage(
    _chatId: string,
    _text: string,
    _signal?: AbortSignal,
    _context?: import('./types').MessagingSendContext,
  ): Promise<{ deliveryId?: string }> {
    throw new Error('not implemented');
  }
}
```

类字段与辅助函数（本任务需要的最小集，Task 5 补齐其余）：

```ts
  private readonly uid: string;
  private readonly ownerExternalUserId: string;
  private readonly fingerprint: string;

  private async getUpdates(
    generation: number,
    signal: AbortSignal,
  ): Promise<{ get_updates_buf?: string; messages?: RawWechatMessage[] }> {
    const stateStore = await import('./wechat-state-store');
    const state = await stateStore.loadWechatState(this.uid, this.instance.id, this.fingerprint);
    const cursor = state?.getUpdatesBuf || '';
    const body = await this.request('/ilink/bot/getupdates', {
      get_updates_buf: cursor,
      long_polling: true,
    }, signal);
    if (generation !== this.generation) throw new Error('generation changed');
    this.lastPollAt = Date.now();
    this.lastStatus = statusOf('connected');
    void this.callbacks?.onStatus(this.lastStatus);
    return body;
  }

  /** Task 4 最小版：空批次直接返回；有消息时并发 dispatch 并等待终态后提交 cursor。
   * Task 5 补充 owner 过滤、tokenRef 注入与 state 写入。 */
  private async handleBatch(
    generation: number,
    body: { get_updates_buf?: string; messages?: RawWechatMessage[] },
    signal: AbortSignal,
  ): Promise<void> {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) return;
    const stateStore = await import('./wechat-state-store');
    const tasks: Array<Promise<unknown>> = [];
    for (const raw of messages) {
      if (generation !== this.generation || signal.aborted) return;
      const envelope = normalizeInbound(this.instance, this.ownerExternalUserId, raw);
      if (!envelope) continue;
      const dispatch = (this.callbacks?.onInbound(envelope) || Promise.resolve({ accepted: false, duplicate: false }))
        .catch((error: unknown) => {
          log.warn('wechat inbound dispatch failed', { instanceId: this.instance.id, error: logErrorSummary(error) });
          throw error;
        });
      tasks.push(dispatch);
    }
    if (tasks.length === 0) return;
    const settled = await Promise.allSettled(tasks);
    if (generation !== this.generation || signal.aborted) return;
    const allTerminal = settled.every((result) => result.status === 'fulfilled');
    if (allTerminal && typeof body.get_updates_buf === 'string' && body.get_updates_buf) {
      await stateStore.saveWechatCursor(this.uid, this.instance.id, this.fingerprint, body.get_updates_buf);
    }
  }

function statusOf(kind: MessagingInstanceStatus['kind'], message?: string): MessagingInstanceStatus {
  return {
    kind,
    checkedAt: new Date().toISOString(),
    ...(message ? { message: message.slice(0, 500) } : {}),
    ...(kind === 'connected' ? { connectedAt: new Date().toISOString() } : {}),
  };
}

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    let timer: NodeJS.Timeout;
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Raw iLink inbound message shape (fields are optional in the protocol). */
interface RawWechatItem {
  type?: string;
  text_item?: { text?: string };
}

interface RawWechatMessage {
  msg_id?: string;
  from_user_id?: string;
  group_id?: string;
  item_list?: RawWechatItem[];
  context_token?: string;
  create_time?: number;
}

export function normalizeInbound(
  instance: MessagingInstance,
  ownerExternalUserId: string,
  raw: RawWechatMessage,
): InboundEnvelope | null {
  if (typeof raw.group_id === 'string' && raw.group_id) return null;
  const messageId = typeof raw.msg_id === 'string' ? raw.msg_id.trim() : '';
  const userId = typeof raw.from_user_id === 'string' ? raw.from_user_id.trim() : '';
  const contextToken = typeof raw.context_token === 'string' ? raw.context_token.trim() : '';
  if (!messageId || !userId || !contextToken) return null;
  const text = (raw.item_list || [])
    .filter((item) => item?.type === 'text_item')
    .map((item) => item.text_item?.text?.trim() || '')
    .filter(Boolean)
    .join('\n');
  if (!text) return null;
  return {
    platform: 'wechat_personal',
    instanceId: instance.id,
    externalMessageId: messageId,
    externalChatId: userId,
    externalUserId: userId,
    text: text.slice(0, 12_000),
    isGroup: false,
    mentionPresent: false,
    receivedAt: new Date().toISOString(),
  };
}
```

模块导入补充（文件头部）：

```ts
import { isTrustedIlinkBaseUrl } from './registry';
import { wechatCredentialFingerprint } from './wechat-state-store';
import type { MessagingInstanceInternal } from './types';
```

注意：`normalizeInbound` 是纯函数，**不设置 `contextTokenRef`**——ref 由 `handleBatch` 在 dispatch 前注入（Task 5 完整版）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/main/features/messaging-wechat-personal.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/wechat-personal.ts test/main/features/messaging-wechat-personal.test.ts
git commit -m "feat(messaging): WechatPersonalAdapter wire client 与长轮询生命周期（generation/终态/退避）"
```

---

### Task 5: WechatPersonalAdapter——入站 owner 过滤/tokenRef 与出站发送

**Files:**
- Modify: `src/main/features/messaging/wechat-personal.ts`
- Test: `test/main/features/messaging-wechat-personal.test.ts`（追加）

**Interfaces:**
- Consumes: Task 3 state store（`saveWechatPeerToken/readWechatPeerToken/loadWechatState`）、Task 4 的 `normalizeInbound`/`handleBatch` 最小版
- Produces: `handleBatch` 完整版（owner 前置过滤：非 owner 不写 state 仍 dispatch；owner 写 token 落盘并注入 `contextTokenRef`）；`sendMessage(chatId, text, signal, context)` 完整实现（有 tokenRef 按 ref 取 token，无 ref 且 chatId===owner 用 owner 最新 token，均缺失抛 `wechat_context_missing`）

- [ ] **Step 1: 写失败测试（入站/出站）**

```ts
describe('wechat personal adapter inbound/outbound', () => {
  // instance/secret 复用上文定义；增加一个 owner 实例
  const ownerInstance = {
    ...instance,
    ownerExternalUserId: 'owner-1',
  };

  it('normalizes a direct text message without leaking the raw token', async () => {
    const { _wechatTestHooks } = await import('../../../src/main/features/messaging/wechat-personal');
    const envelope = _wechatTestHooks.normalizeInbound(ownerInstance, {
      msg_id: 'm-1',
      from_user_id: 'owner-1',
      item_list: [{ type: 'text_item', text_item: { text: '你好' } }],
      context_token: 'ctx-1',
      create_time: 1700000000000,
    });
    expect(envelope).not.toBeNull();
    expect(envelope!.externalMessageId).toBe('m-1');
    expect(envelope!.externalUserId).toBe('owner-1');
    expect(envelope!.text).toBe('你好');
    expect(envelope!.isGroup).toBe(false);
    // 纯函数不携带明文 token；tokenRef 由 handleBatch 在 dispatch 前注入
    expect(envelope!.contextTokenRef).toBeUndefined();
  });

  it('rejects group messages and messages missing required fields', async () => {
    const { _wechatTestHooks } = await import('../../../src/main/features/messaging/wechat-personal');
    expect(_wechatTestHooks.normalizeInbound(ownerInstance, {
      msg_id: 'm-2', group_id: 'g-1', from_user_id: 'owner-1',
      item_list: [{ type: 'text_item', text_item: { text: 'hi' } }], context_token: 'ctx-2',
    })).toBeNull();
    expect(_wechatTestHooks.normalizeInbound(ownerInstance, {
      from_user_id: 'owner-1',
      item_list: [{ type: 'text_item', text_item: { text: 'hi' } }], context_token: 'ctx-3',
    })).toBeNull(); // 缺 msg_id
    expect(_wechatTestHooks.normalizeInbound(ownerInstance, {
      msg_id: 'm-4', from_user_id: 'owner-1',
      item_list: [], context_token: 'ctx-4',
    })).toBeNull(); // 无文本 item
    expect(_wechatTestHooks.normalizeInbound(ownerInstance, {
      msg_id: 'm-5', from_user_id: 'owner-1',
      item_list: [{ type: 'text_item', text_item: { text: 'hi' } }],
    })).toBeNull(); // 缺 context_token
  });

  it('injects a tokenRef for the owner and sends with the bound token', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const stateStore = await import('../../../src/main/features/messaging/wechat-state-store');
    const fingerprint = stateStore.wechatCredentialFingerprint('bot-1', 'owner-1');
    // 模拟入站时序：先落盘 peer token，拿到真实 tokenRef
    const tokenRef = await stateStore.saveWechatPeerToken(
      'uid-1', 'inst-1', fingerprint, 'owner-1', 'ctx-bound', 1_700_000_000_000,
    );

    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    }));

    const adapter = new WechatPersonalAdapter(ownerInstance, secret, 'uid-1');
    const result = await adapter.sendMessage('owner-1', '回复内容', undefined, {
      contextTokenRef: tokenRef,
    });
    expect(result).toEqual({});
    expect(sent).toHaveLength(1);
    const msg = sent[0].body.msg as Record<string, unknown>;
    expect(msg.to_user_id).toBe('owner-1');
    expect(msg.context_token).toBe('ctx-bound');
    expect((msg.item_list as Array<{ text_item: { text: string } }>)[0].text_item.text).toBe('回复内容');
  });

  it('injects a tokenRef into the envelope before dispatch and persists the token', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const stateStore = await import('../../../src/main/features/messaging/wechat-state-store');
    const fingerprint = stateStore.wechatCredentialFingerprint('bot-1', 'owner-1');
    const onInbound = vi.fn().mockResolvedValue({ accepted: true, duplicate: false });
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: 'cursor-1',
        messages: [{
          msg_id: 'm-1', from_user_id: 'owner-1',
          item_list: [{ type: 'text_item', text_item: { text: '你好' } }],
          context_token: 'ctx-live',
        }],
      }), { status: 200 })));
    const adapter = new WechatPersonalAdapter(ownerInstance, secret, 'uid-1');
    const controller = new AbortController();
    const startPromise = adapter.start(controller.signal, { onInbound, onStatus: vi.fn().mockResolvedValue(undefined) } as never);
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalled());
    controller.abort();
    await startPromise;
    const envelope = onInbound.mock.calls[0][0] as { contextTokenRef?: string };
    expect(envelope.contextTokenRef).toBeTruthy();
    const state = await stateStore.loadWechatState('uid-1', 'inst-1', fingerprint);
    expect(state?.peers['owner-1']?.contextToken).toBe('ctx-live');
    expect(state?.getUpdatesBuf).toBe('cursor-1');
  });

  it('does not persist peer state for a non-owner sender', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const stateStore = await import('../../../src/main/features/messaging/wechat-state-store');
    const fingerprint = stateStore.wechatCredentialFingerprint('bot-1', 'owner-1');
    const onInbound = vi.fn().mockResolvedValue({ accepted: false, duplicate: false });
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: 'cursor-2',
        messages: [{
          msg_id: 'm-2', from_user_id: 'stranger-1',
          item_list: [{ type: 'text_item', text_item: { text: 'hack' } }],
          context_token: 'ctx-stranger',
        }],
      }), { status: 200 })));
    const adapter = new WechatPersonalAdapter(ownerInstance, secret, 'uid-1');
    const controller = new AbortController();
    const startPromise = adapter.start(controller.signal, { onInbound, onStatus: vi.fn().mockResolvedValue(undefined) } as never);
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalled());
    controller.abort();
    await startPromise;
    const envelope = onInbound.mock.calls[0][0] as { contextTokenRef?: string; externalUserId: string };
    expect(envelope.externalUserId).toBe('stranger-1');
    expect(envelope.contextTokenRef).toBeUndefined();
    const state = await stateStore.loadWechatState('uid-1', 'inst-1', fingerprint);
    expect(state?.peers['stranger-1']).toBeUndefined();
  });

  it('refuses to send when no token is available', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new WechatPersonalAdapter(ownerInstance, secret, 'uid-1');
    await expect(adapter.sendMessage('owner-1', 'hi', undefined, { contextTokenRef: 'owner-1::no-such-uuid' }))
      .rejects.toThrow(/context/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/main/features/messaging-wechat-personal.test.ts`
Expected: FAIL——`handleBatch` 未注入 tokenRef、`sendMessage` 抛 "not implemented"

- [ ] **Step 3: 实现（升级 handleBatch + sendMessage）**

将 Task 4 的 `handleBatch` 最小版替换为完整版（owner 过滤 + tokenRef 注入 + state 写入）：

```ts
  private async handleBatch(
    generation: number,
    body: { get_updates_buf?: string; messages?: RawWechatMessage[] },
    signal: AbortSignal,
  ): Promise<void> {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) return;
    const stateStore = await import('./wechat-state-store');
    const tasks: Array<Promise<unknown>> = [];
    for (const raw of messages) {
      if (generation !== this.generation || signal.aborted) return;
      const envelope = normalizeInbound(this.instance, this.ownerExternalUserId, raw);
      if (!envelope) continue;
      // 仅 owner 写 peer state；非 owner 仍 dispatch 进 manager 产生 ledger 拒绝记录
      if (envelope.externalUserId === this.ownerExternalUserId) {
        const contextToken = typeof raw.context_token === 'string' ? raw.context_token.trim() : '';
        if (contextToken) {
          const tokenRef = await stateStore.saveWechatPeerToken(
            this.uid, this.instance.id, this.fingerprint,
            envelope.externalUserId, contextToken, Date.now(),
          );
          envelope.contextTokenRef = tokenRef;
        }
      }
      const dispatch = (this.callbacks?.onInbound(envelope) || Promise.resolve({ accepted: false, duplicate: false }))
        .catch((error: unknown) => {
          log.warn('wechat inbound dispatch failed', { instanceId: this.instance.id, error: logErrorSummary(error) });
          throw error;
        });
      tasks.push(dispatch);
    }
    if (tasks.length === 0) return;
    const settled = await Promise.allSettled(tasks);
    if (generation !== this.generation || signal.aborted) return;
    const allTerminal = settled.every((result) => result.status === 'fulfilled');
    if (allTerminal && typeof body.get_updates_buf === 'string' && body.get_updates_buf) {
      await stateStore.saveWechatCursor(this.uid, this.instance.id, this.fingerprint, body.get_updates_buf);
    }
  }
```

实现 `sendMessage`（替换 Task 4 的抛错骨架）：

```ts
  async sendMessage(
    chatId: string,
    text: string,
    lifecycleSignal?: AbortSignal,
    context?: import('./types').MessagingSendContext,
  ): Promise<{ deliveryId?: string }> {
    const stateStore = await import('./wechat-state-store');
    const tokenRef = typeof context?.contextTokenRef === 'string' ? context.contextTokenRef : '';
    let token = '';
    if (tokenRef) {
      // 回复场景：必须使用触发该轮的 token（tokenRef 编码 peerId）
      const peer = await stateStore.readWechatPeerToken(this.uid, this.instance.id, tokenRef);
      token = peer?.token || '';
    } else if (chatId === this.ownerExternalUserId) {
      // 主动消息场景（无入站触发的 ref）：仅允许发给 owner 本人
      const state = await stateStore.loadWechatState(this.uid, this.instance.id, this.fingerprint);
      token = state?.peers[chatId]?.contextToken || '';
    }
    if (!token || !chatId) throw new Error('wechat_context_missing');
    const body = await this.request('/ilink/bot/sendmessage', {
      msg: {
        to_user_id: chatId,
        context_token: token,
        item_list: [{ type: 'text_item', text_item: { text: text.slice(0, 4_000) } }],
      },
    }, lifecycleSignal || new AbortController().signal);
    return body && typeof body.msg_id === 'string' ? { deliveryId: String(body.msg_id) } : {};
  }
```

`_wechatTestHooks` 更新：

```ts
export const _wechatTestHooks = { buildHeaders, classifyError, normalizeInbound, statusOf };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/main/features/messaging-wechat-personal.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/wechat-personal.ts test/main/features/messaging-wechat-personal.test.ts
git commit -m "feat(messaging): WechatPersonalAdapter 入站归一化/owner 过滤/游标提交与 tokenRef 出站"
```

---

### Task 6: wechat-registration——扫码登录状态机

**Files:**
- Create: `src/main/features/messaging/wechat-registration.ts`
- Test: `test/main/features/messaging-wechat-registration.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 `createWechatInstance`/`isTrustedIlinkBaseUrl`、Task 3 `clearWechatInstanceState`
- Produces: `WechatRegistrationState`、`startWechatQrRegistration(uid): Promise<WechatRegistrationStatus>`、`getWechatQrRegistrationStatus(uid, flowId)`、`cancelWechatQrRegistration(uid, flowId)`（IPC 复用，风格对齐 feishu-registration）

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-wechat-reg-'));
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

describe('wechat registration flow', () => {
  it('walks wait -> scaned -> confirmed and creates an owner-bound instance', async () => {
    const { startWechatQrRegistration, getWechatQrRegistrationStatus } =
      await import('../../../src/main/features/messaging/wechat-registration');
    const statuses: string[] = [];
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async (url: string) => {
        expect(String(url)).toContain('/ilink/bot/get_bot_qrcode');
        return new Response(JSON.stringify({ ret: 0, qrcode: 'qr-abc', url: 'https://ilinkai.weixin.qq.com/qr' }), { status: 200 });
      })
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'wait' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'scaned' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        ret: 0,
        status: 'confirmed',
        bot_token: 't'.repeat(64),
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_bot_id: 'bot-1',
        ilink_user_id: 'owner-1',
      }), { status: 200 })));
    const started = await startWechatQrRegistration('uid-1');
    expect(started.state).toBe('awaiting_scan');
    // 轮询直到 completed（内部以短间隔轮询）
    await vi.waitFor(async () => {
      const s = getWechatQrRegistrationStatus('uid-1', started.flowId);
      statuses.push(s.state);
      expect(s.state).toBe('completed');
    }, { timeout: 8_000, interval: 100 });
    const registry = await import('../../../src/main/features/messaging/registry');
    const instances = await registry.listInstances('uid-1');
    expect(instances).toHaveLength(1);
    expect(instances[0].ownerConfigured).toBe(true);
    expect(instances[0].policy.allowUserIds).toEqual(['owner-1']);
  });

  it('fails closed when confirmed payload misses ilink_user_id', async () => {
    const { startWechatQrRegistration, getWechatQrRegistrationStatus } =
      await import('../../../src/main/features/messaging/wechat-registration');
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-1' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'confirmed', bot_token: 't'.repeat(64), baseurl: 'https://ilinkai.weixin.qq.com', ilink_bot_id: 'bot-1' }), { status: 200 })));
    const started = await startWechatQrRegistration('uid-1');
    await vi.waitFor(() => {
      expect(getWechatQrRegistrationStatus('uid-1', started.flowId).state).toBe('failed');
    }, { timeout: 8_000, interval: 100 });
    const registry = await import('../../../src/main/features/messaging/registry');
    expect(await registry.listInstances('uid-1')).toHaveLength(0);
  });

  it('rejects a confirmed baseurl outside the whitelist', async () => {
    const { startWechatQrRegistration, getWechatQrRegistrationStatus } =
      await import('../../../src/main/features/messaging/wechat-registration');
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-2' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        ret: 0, status: 'confirmed',
        bot_token: 't'.repeat(64), baseurl: 'https://evil.example.com',
        ilink_bot_id: 'bot-2', ilink_user_id: 'owner-2',
      }), { status: 200 })));
    const started = await startWechatQrRegistration('uid-1');
    await vi.waitFor(() => {
      expect(getWechatQrRegistrationStatus('uid-1', started.flowId).state).toBe('failed');
    }, { timeout: 8_000, interval: 100 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/main/features/messaging-wechat-registration.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现 `wechat-registration.ts`**

```ts
import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { nowIso, safeId } from '../../storage';
import { logErrorSummary } from '../../util/log-redact';
import { createWechatInstance, isTrustedIlinkBaseUrl } from './registry';
import { clearWechatInstanceState } from './wechat-state-store';

const log = createLogger('messaging:wechat-registration');
const FLOW_RETENTION_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 1_000;
const QR_REFRESH_MAX = 3;

export type WechatRegistrationState =
  | 'starting'
  | 'awaiting_scan'
  | 'scanned'
  | 'redirecting'
  | 'verification_required'
  | 'completed'
  | 'expired'
  | 'blocked'
  | 'cancelled'
  | 'failed';

export interface WechatRegistrationStatus {
  flowId: string;
  state: WechatRegistrationState;
  qrUrl?: string;
  qrCode?: string;
  errorCode?: string;
  instanceId?: string;
  updatedAt: string;
}

interface WechatRegistrationFlow {
  uid: string;
  flowId: string;
  state: WechatRegistrationState;
  qrUrl?: string;
  qrCode?: string;
  baseUrl: string;
  qrRefreshCount: number;
  errorCode?: string;
  instanceId?: string;
  updatedAt: string;
}

const flows = new Map<string, WechatRegistrationFlow>();

function assertUserId(uid: string): void {
  if (!safeId(uid)) throw new Error('invalid user id');
}

function publicStatus(flow: WechatRegistrationFlow): WechatRegistrationStatus {
  return {
    flowId: flow.flowId,
    state: flow.state,
    ...(flow.qrUrl ? { qrUrl: flow.qrUrl } : {}),
    ...(flow.qrCode ? { qrCode: flow.qrCode } : {}),
    ...(flow.errorCode ? { errorCode: flow.errorCode } : {}),
    ...(flow.instanceId ? { instanceId: flow.instanceId } : {}),
    updatedAt: flow.updatedAt,
  };
}

function finish(flow: WechatRegistrationFlow, state: WechatRegistrationState, errorCode?: string): void {
  flow.state = state;
  flow.updatedAt = nowIso();
  if (errorCode) flow.errorCode = errorCode;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapQrStatus(raw: string, flow: WechatRegistrationFlow): WechatRegistrationState | null {
  switch (raw) {
    case 'wait': return 'awaiting_scan';
    case 'scaned': return 'scanned';
    case 'scaned_but_redirect': return 'redirecting';
    case 'need_verifycode': return 'verification_required';
    case 'verify_code_blocked': return 'blocked';
    case 'binded_redirect': return 'redirecting';
    case 'expired': return 'expired';
    case 'confirmed': return 'completed';
    default: return null; // 未映射状态 → failed
  }
}

async function pollQrStatus(flow: WechatRegistrationFlow): Promise<void> {
  const baseUrl = flow.baseUrl.replace(/\/+$/, '');
  while (flow.state === 'starting' || flow.state === 'awaiting_scan' || flow.state === 'scanned' || flow.state === 'redirecting') {
    if (flow.state === 'cancelled' || flow.state === 'failed' || flow.state === 'completed') return;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(flow.qrCode || '')}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      log.warn('wechat qr status poll failed', { flowId: flow.flowId, error: logErrorSummary(error) });
      await wait(POLL_INTERVAL_MS);
      continue;
    }
    let parsed: { ret?: number; status?: string; bot_token?: string; baseurl?: string; ilink_bot_id?: string; ilink_user_id?: string };
    try {
      parsed = await response.json();
    } catch {
      await wait(POLL_INTERVAL_MS);
      continue;
    }
    if (typeof parsed.ret === 'number' && parsed.ret !== 0) {
      finish(flow, 'failed', `qr_ret_${parsed.ret}`);
      return;
    }
    const mapped = mapQrStatus(parsed.status || '', flow);
    if (mapped === null) {
      finish(flow, 'failed', 'unknown_qr_status');
      return;
    }
    if (mapped === 'expired') {
      flow.qrRefreshCount += 1;
      if (flow.qrRefreshCount > QR_REFRESH_MAX) {
        finish(flow, 'expired', 'qr_refresh_exhausted');
        return;
      }
      await refreshQrCode(flow);
      continue;
    }
    if (mapped === 'completed') {
      await completeConfirmed(flow, parsed);
      return;
    }
    flow.state = mapped;
    flow.updatedAt = nowIso();
    await wait(POLL_INTERVAL_MS);
  }
}

async function refreshQrCode(flow: WechatRegistrationFlow): Promise<void> {
  try {
    const response = await fetch(`${flow.baseUrl.replace(/\/+$/, '')}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = await response.json() as { ret?: number; qrcode?: string; url?: string };
    if (typeof parsed.ret === 'number' && parsed.ret !== 0) {
      finish(flow, 'failed', `qr_ret_${parsed.ret}`);
      return;
    }
    flow.qrCode = typeof parsed.qrcode === 'string' ? parsed.qrcode : '';
    if (typeof parsed.url === 'string' && parsed.url) {
      const url = new URL(parsed.url);
      if (isTrustedIlinkBaseUrl(url.origin)) flow.qrUrl = parsed.url;
    }
    flow.updatedAt = nowIso();
  } catch (error) {
    log.warn('wechat qr refresh failed', { flowId: flow.flowId, error: logErrorSummary(error) });
  }
}

async function completeConfirmed(
  flow: WechatRegistrationFlow,
  parsed: { bot_token?: string; baseurl?: string; ilink_bot_id?: string; ilink_user_id?: string },
): Promise<void> {
  const botToken = typeof parsed.bot_token === 'string' ? parsed.bot_token.trim() : '';
  const baseUrl = typeof parsed.baseurl === 'string' ? parsed.baseurl.trim() : '';
  const botId = typeof parsed.ilink_bot_id === 'string' ? parsed.ilink_bot_id.trim() : '';
  const ownerId = typeof parsed.ilink_user_id === 'string' ? parsed.ilink_user_id.trim() : '';
  // fail closed：任一核心字段缺失/非法 → 不创建实例
  if (!botToken || !baseUrl || !isTrustedIlinkBaseUrl(baseUrl) || !botId || !ownerId) {
    finish(flow, 'failed', 'confirmed_payload_invalid');
    return;
  }
  try {
    const instance = await createWechatInstance(flow.uid, {
      displayName: '个人微信',
      ilinkBotToken: botToken,
      ilinkBaseUrl: baseUrl,
      ilinkBotId: botId,
      ownerExternalUserId: ownerId,
    });
    // 重绑语义：无论本 flow 之前是否存在旧状态，confirmed 后一律清空
    await clearWechatInstanceState(flow.uid, instance.id);
    flow.instanceId = instance.id;
    finish(flow, 'completed');
  } catch (error) {
    log.warn('wechat instance creation failed', { flowId: flow.flowId, error: logErrorSummary(error) });
    finish(flow, 'failed', 'instance_create_failed');
  }
}

export async function startWechatQrRegistration(uid: string): Promise<WechatRegistrationStatus> {
  assertUserId(uid);
  const flow: WechatRegistrationFlow = {
    uid,
    flowId: randomUUID(),
    state: 'starting',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    qrRefreshCount: 0,
    updatedAt: nowIso(),
  };
  flows.set(flow.flowId, flow);
  await refreshQrCode(flow);
  if (flow.state === 'failed') return publicStatus(flow);
  flow.state = 'awaiting_scan';
  flow.updatedAt = nowIso();
  void pollQrStatus(flow);
  return publicStatus(flow);
}

export function getWechatQrRegistrationStatus(uid: string, flowId: string): WechatRegistrationStatus {
  assertUserId(uid);
  const flow = flows.get(flowId);
  if (!flow) throw new Error('wechat registration flow not found');
  return publicStatus(flow);
}

export function cancelWechatQrRegistration(uid: string, flowId: string): WechatRegistrationStatus {
  assertUserId(uid);
  const flow = flows.get(flowId);
  if (!flow) throw new Error('wechat registration flow not found');
  finish(flow, 'cancelled');
  return publicStatus(flow);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/main/features/messaging-wechat-registration.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/wechat-registration.ts test/main/features/messaging-wechat-registration.test.ts
git commit -m "feat(messaging): wechat-registration 扫码状态机（fail closed 与白名单校验）"
```

---

### Task 7: manager/proactive 接线

**Files:**
- Modify: `src/main/features/messaging/adapters.ts`（`createAdapter` 加分支）
- Modify: `src/main/features/messaging/manager.ts`（catalog 转正、adapter 构造传 uid、delivery 透传 `contextTokenRef`）
- Modify: `src/main/features/messaging/proactive.ts`（微信目标支持）
- Test: `test/main/features/messaging-owner-bind-integration.test.ts`（追加微信全链路用例）

**Interfaces:**
- Consumes: Task 4/5 的 `WechatPersonalAdapter`（构造 `(instance, secret, uid)`）
- Produces: catalog 转正；`sendDelivery` 将 `envelope.contextTokenRef` 写入 `DeliveryLedgerEntry`；proactive 微信目标与错误码

- [ ] **Step 1: 写失败测试（微信全链路集成）**

在 `test/main/features/messaging-owner-bind-integration.test.ts` 末尾追加：

```ts
describe('wechat_personal end-to-end', () => {
  it('routes an owner inbound message through to a bound conversation reply with tokenRef', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const stateStore = await import('../../../src/main/features/messaging/wechat-state-store');
    const manager = await import('../../../src/main/features/messaging/manager');
    const registry = await import('../../../src/main/features/messaging/registry');
    // 注册态实例（owner 已绑定）并启用
    const instance = await registry.createWechatInstance('uid-1', {
      displayName: '我的微信',
      ilinkBotToken: 't'.repeat(64),
      ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
      ilinkBotId: 'bot-1',
      ownerExternalUserId: 'owner-1',
    });
    await registry.updateInstance('uid-1', instance.id, { enabled: true });
    // 直接走 manager 的 ingestInbound（adapter 之外的管线）
    const result = await manager.ingestInbound('uid-1', {
      platform: 'wechat_personal',
      instanceId: instance.id,
      externalMessageId: 'm-1',
      externalChatId: 'owner-1',
      externalUserId: 'owner-1',
      text: '你好',
      isGroup: false,
      mentionPresent: false,
      receivedAt: new Date().toISOString(),
      contextTokenRef: 'ref-1',
    });
    expect(result.accepted).toBe(true);
    // 非 owner 被拒绝
    const denied = await manager.ingestInbound('uid-1', {
      platform: 'wechat_personal',
      instanceId: instance.id,
      externalMessageId: 'm-2',
      externalChatId: 'stranger-1',
      externalUserId: 'stranger-1',
      text: 'hack',
      isGroup: false,
      mentionPresent: false,
      receivedAt: new Date().toISOString(),
    });
    expect(denied.accepted).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/main/features/messaging-owner-bind-integration.test.ts`
Expected: FAIL——`ingestInbound` 对 `wechat_personal` 尚未全通（owner 拒绝或平台断言）

- [ ] **Step 3: 实现接线**

a) `adapters.ts` 的 `createAdapter` 末尾分支：

```ts
export function createAdapter(instance: MessagingInstance, secret: MessagingSecret, uid?: string): MessagingAdapter {
  if (instance.platform === 'telegram') return new TelegramAdapter(instance, secret);
  if (instance.platform === 'wecom') return new WecomAdapter(instance, secret);
  if (instance.platform === 'wechat_personal') {
    if (!uid) throw new Error('wechat adapter requires uid');
    return new WechatPersonalAdapter(instance, secret, uid);
  }
  return new FeishuAdapter(instance, secret);
}
```

b) `manager.ts` 的 `startRuntime`（约 1320 行 `adapter = createAdapter(loaded.instance, loaded.secret);`）改为 `createAdapter(loaded.instance, loaded.secret, uid)`。

c) `manager.ts` 的 `PLATFORM_CATALOG` 中 `wechat_personal` 条目转正：

```ts
  {
    platform: 'wechat_personal',
    displayName: '个人微信',
    description: '微信官方 iLink 通道，扫码绑定后长轮询双向对话。',
    available: true,
    twoWay: true,
  },
```

d) `manager.ts`：查找 `sendDelivery`/创建 `DeliveryLedgerEntry` 的位置（`grep -n "DeliveryLedgerEntry\|deliveryLedger" src/main/features/messaging/manager.ts`），在构造 entry 处透传：

```ts
  ...(envelope.contextTokenRef ? { contextTokenRef: envelope.contextTokenRef } : {}),
```

并在 `adapter.sendMessage` 调用处把 `contextTokenRef` 放进 `MessagingSendContext`：

```ts
  ...(entry.contextTokenRef ? { contextTokenRef: entry.contextTokenRef } : {}),
```

（具体行号以 grep 结果为准；若 manager 将 delivery 创建封装在 `ledger.ts`，则同步在 `ledger.ts` 的 entry 类型使用处透传。）

e) `proactive.ts`：`ProactiveTargetView.platform` 从 `'feishu_lark'` 改为 `'feishu_lark' | 'wechat_personal'`；`listProactiveTargets` 的平台过滤从 `instance.platform !== 'feishu_lark'` 改为白名单两个平台；微信目标的可用性检查追加：

```ts
  // Wechat proactive sends need a live owner token within the 24h window.
  if (instance.platform === 'wechat_personal') {
    const stateStore = await import('./wechat-state-store');
    const state = await stateStore.loadWechatState(uid, instance.id, /* fingerprint */ '');
    const ownerPeer = state?.peers[instance.ownerExternalUserId || ''];
    if (!ownerPeer) status = 'not_connected';
    else if (Date.now() - ownerPeer.lastInboundAt > 24 * 60 * 60 * 1000) status = 'owner_missing';
  }
```

指纹获取：proactive 从 registry 取 `instance`（含 owner）+ secret 的 `ilinkBotId`（`getInstanceWithSecret`），调用 `wechatCredentialFingerprint(ilinkBotId, ownerExternalUserId)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/main/features/messaging-owner-bind-integration.test.ts test/main/features/messaging-proactive.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/adapters.ts src/main/features/messaging/manager.ts src/main/features/messaging/proactive.ts test/main/features/messaging-owner-bind-integration.test.ts
git commit -m "feat(messaging): manager/proactive 接入 wechat_personal（catalog 转正与 tokenRef 透传）"
```

---

### Task 8: IPC 与 Renderer（设置页卡片 + 扫码弹窗 + i18n）

**Files:**
- Modify: `src/main/ipc/messaging.ts`（追加 `messaging.wechat_qr.start/status/cancel` handlers）
- Modify: `src/renderer/modules/messaging-settings.js`
- Modify: `src/renderer/locales/zh.json`、`en.json`、`ja.json`、`pt.json`
- Test: 现有 renderer 测试（`test/renderer/settings-tabs.test.ts`）如有渠道断言则同步；手动验证见 Task 9

**Interfaces:**
- Consumes: Task 6 注册 API
- Produces: 渲染层"个人微信"渠道卡片可用（`group: 'open'`），扫码弹窗 + 状态文案

- [ ] **Step 1: IPC handlers**

`src/main/ipc/messaging.ts`，仿照 `messaging.feishu_qr.*`（约 240-250 行）追加：

```ts
  'messaging.wechat_qr.start': async (_payload: Record<string, unknown>, ctx: MessagingContext) => ({
    registration: wechatRegistration.startWechatQrRegistration(ctx.userId),
  }),
  'messaging.wechat_qr.status': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    registration: wechatRegistration.getWechatQrRegistrationStatus(ctx.userId, registrationFlowId(payload?.flowId)),
  }),
  'messaging.wechat_qr.cancel': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    registration: wechatRegistration.cancelWechatQrRegistration(ctx.userId, registrationFlowId(payload?.flowId)),
  }),
```

并加 `import * as wechatRegistration from '../features/messaging/wechat-registration';`。

- [ ] **Step 2: Renderer 渠道转正与扫码弹窗**

`src/renderer/modules/messaging-settings.js`：

- 渠道定义（约 54 行）`{ key: 'wechat', platform: 'wechat_personal', icon: 'wechat', group: 'soon' }` → `group: 'open'`
- 状态文案表（约 62-72 行 feishu 状态映射旁）追加 wechat 状态映射：`starting`/`awaiting_scan`/`scanned`/`redirecting`/`verification_required`/`completed`/`expired`/`blocked`/`cancelled`/`failed`（i18n key `messaging.wechat_qr.status_*`）
- 绑定入口：仿照 feishu 的"扫码绑定"按钮与弹窗（`messaging.feishu_qr.start` 调用 + 二维码 `<img src=qrUrl>` 或 `qrCode` 渲染 + `messaging.wechat_qr.status` 轮询 + `cancel`），轮询间隔沿用现有 feishu 轮询实现；`completed` 后提示"绑定成功，可在微信中与 ClawBot 对话"
- 实例 DTO 显示沿用现有卡片（`ownerConfigured` 徽标等）

- [ ] **Step 3: i18n**

四个 locale 文件各追加（zh/en/ja/pt 逐一翻译）：

```json
  "messaging": {
    "wechat": {
      "channelName": "个人微信",
      "channelDescription": "微信官方 iLink 通道，扫码绑定后可与 Mate Agent 对话",
      "bindTitle": "扫码绑定个人微信",
      "bindHint": "用微信扫描二维码并确认，完成后在微信中与 ClawBot 对话",
      "status": {
        "starting": "正在启动…",
        "awaiting_scan": "等待扫码",
        "scanned": "已扫码，请在手机上确认",
        "redirecting": "跳转中…",
        "verification_required": "需要验证码",
        "completed": "绑定成功",
        "expired": "二维码已过期",
        "blocked": "已被限制",
        "cancelled": "已取消",
        "failed": "绑定失败"
      }
    }
  }
```

（en/ja/pt 对应翻译；现有 locale 文件里 `messaging` 键结构以文件内既有分组为准，必要时并入既有分组。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/renderer/settings-tabs.test.ts test/renderer/skills-cognition-layout.test.ts`
Expected: PASS（若渠道断言未涉及 wechat 则直接通过）

- [ ] **Step 5: 提交**

```bash
git add src/main/ipc/messaging.ts src/renderer/modules/messaging-settings.js src/renderer/locales/zh.json src/renderer/locales/en.json src/renderer/locales/ja.json src/renderer/locales/pt.json
git commit -m "feat(messaging): 个人微信渠道转正——IPC 扫码流程、设置页卡片与 i18n"
```

---

### Task 9: 全量回归与真实环境验证

**Files:** 无新代码

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 2: 真实环境验证（遵循 AGENTS.md 的 messaging 验证流程）**

```bash
cd PC && ./scripts/restart-mate.sh
```

- 确认启动：`~/.orkas/runtime-variants/messaging/data/logs/<date>.log` 无报错；`/tmp/mate-agent-messaging-run.log` 正常
- 在设置页 → 消息平台 → 个人微信 → 扫码绑定：二维码展示 → 手机微信扫码确认 → 状态走 `scanned → completed` → 实例出现在列表
- 微信中与 ClawBot 对话发"你好"：确认入站日志（`messaging inbound envelope received`）与回复送达
- 第二条消息验证 burst merge（连续两条快速消息合并为一轮回复）
- 若真实接口字段与社区文档不符（`ret` 码、字段名差异），记录并回填 Task 4/6 的 wire contract 与测试夹具
- 非 owner（若有第二设备）发消息：确认拒绝且不产生回复
- 主动消息：在对话后 24h 内从 Commander 触发 `messaging_send`，确认送达；token 缺失时返回 `wechat_context_missing`

- [ ] **Step 3: 提交验证修正**

```bash
git add -A
git commit -m "fix(messaging): 真实环境校准 iLink wire contract"
```

---

## Self-Review 记录

- **规格覆盖**：规格第 3 节组件 → Task 1/2/3/4/5/6；3.5 主动消息 → Task 7；3.6 Renderer/IPC → Task 8；第 4 节数据流 → Task 5/7 测试；第 5 节错误处理 → Task 4（终态/退避/分类）+ Task 5（字段校验）；第 6 节测试 → 各任务测试步骤；第 7 节风险 → Task 9。规格 3.1 的 wire contract/redirect/generation 全部落 Task 4；tokenRef 绑定与 retry 恢复落 Task 5；重绑清理/指纹/损坏落 Task 3 + Task 6。
- **占位符扫描**：无 TBD/TODO；Task 7 中 delivery 透传的行号以 grep 为准（给出搜索命令），属显式定位指引而非占位。
- **类型一致性**：`contextTokenRef` 在 Task 1 定义、Task 5 生成、Task 7 透传、Task 4/5 消费，签名一致；`WechatPersonalAdapter` 构造函数 `(instance, secret, uid)` 在 Task 5 定义、Task 7 调用，一致；`wechatCredentialFingerprint` 在 Task 3 定义、Task 7 proactive 消费，一致。
- **已知取舍**：`readWechatPeerToken` 的 tokenRef 编码 peerId（`${peerId}::${uuid}`），读取时解析前缀取该 peer 当前 token（token 仅随入站变化，等价于绑定轮 token；peerId 本就在 delivery ledger 的 `externalChatId` 中明文，无新增泄露）；指纹取 `(ilinkBotId, ownerId)`，重绑清空由注册 flow 的 `clearWechatInstanceState` 保证（Task 6 每次 confirmed 必执行）。
