# 飞书连接器三项完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为飞书/Lark 连接器补上 reaction 合成消息、入站突发合并、@all 修复与姓名解析三项能力（依据 spec：`docs/superpowers/specs/2026-08-06-feishu-connector-polish-design.md`）。

**Architecture:** 全部改动在 `src/main/features/messaging/` 内增量完成。reaction 事件在 FeishuAdapter 事件分发器注册，经投递账本反查确认归属后合成为 synthetic 入站消息；突发合并在 manager 层用新 `burst-merge.ts` 泛型防抖器按 (instanceId, chatId) 合并分片；@all 与姓名解析在入站归一化与 adapter 层完成。不碰 IPC、渲染层、types 必填契约（只加可选字段）、新 npm 依赖。

**Tech Stack:** TypeScript、Electron Node 运行时、Vitest（经 `node scripts/run-tests.mjs run <file>` 运行）、@larksuiteoapi/node-sdk（测试时 `vi.doMock`）。

## Global Constraints

- 测试命令：`node scripts/run-tests.mjs run test/main/features/<file>.test.ts`（转发给 Vitest；全量用 `npm test`）。
- 存量实例权限不升级：新 API 调用失败一律静默降级（catch + `log.warn` 一次），不得抛出或阻塞消息流——与 adapters.ts `addProcessingReaction` 现有模式一致。
- `InboundEnvelope` 只加可选字段（`synthetic?`）；`AdapterCallbacks` 只加可选回调（`resolveDelivery?`），不得破坏现有实现。
- 合并参数固定：600ms 窗口 / 8 条 / 4000 字符 / ≥3500 字符自适应 2000ms。
- 测试沿用临时目录模式：`beforeEach` 设 `ORKAS_WORKSPACE_ROOT` 到 `fs.mkdtempSync` 目录 + `vi.resetModules()` + 动态 import。
- 不引入新 npm 依赖；不改 IPC/渲染层。
- git 作者统一「牛保康 <niubaokang@local>」（仓库已配置）。

---

### Task 1: 账本按外部投递 ID 反查

**Files:**
- Modify: `src/main/features/messaging/ledger.ts`（在 `getDelivery` 之后新增函数）
- Test: `test/main/features/ledger-query.test.ts`（新建）

**Interfaces:**
- Consumes: `userMessagingDeliveryLedgerFile(uid)`（`../../paths`）、`normalizeDelivery`、`assertUserId`、`assertInstanceId`（ledger.ts 内已有）、`DeliveryLedgerEntry`（`./types`）
- Produces: `getDeliveryByExternalId(uid: string, instanceId: string, externalDeliveryId: string): Promise<DeliveryLedgerEntry | null>` —— Task 3 的 reaction 归属校验依赖此函数

- [ ] **Step 1: 写失败测试**

创建 `test/main/features/ledger-query.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ledger-'));
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

describe('messaging delivery ledger external-id lookup', () => {
  it('finds a delivery by its external delivery id', async () => {
    const { beginDelivery, getDeliveryByExternalId, deliveryKey } =
      await import('../../../src/main/features/messaging/ledger');
    await beginDelivery('u-1', {
      key: deliveryKey('bot-1', 'src-1'),
      instanceId: 'bot-1',
      externalChatId: 'oc_1',
      sourceMessageId: 'src-1',
      textHash: 'hash',
      text: 'hello',
      idempotencyKey: 'idem-1',
    });
    const found = await getDeliveryByExternalId('u-1', 'bot-1', 'om_9');
    expect(found).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs run test/main/features/ledger-query.test.ts`
Expected: FAIL，`getDeliveryByExternalId` 未定义（TypeError / cannot find name）。

- [ ] **Step 3: 实现**

在 `src/main/features/messaging/ledger.ts` 的 `getDelivery` 函数之后追加：

```ts
/** Reverse lookup of a delivered message by its platform delivery id.
 * Reaction events carry the outbound message id without any chat context;
 * this resolves the owning delivery (and its chat) locally so a reaction on
 * a message we never sent is simply ignored. The ledger keeps terminal
 * entries, so the match survives the delivery being finished long ago. */
export async function getDeliveryByExternalId(
  uid: string,
  instanceId: string,
  externalDeliveryId: string,
): Promise<DeliveryLedgerEntry | null> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  const id = externalDeliveryId.trim();
  if (!id || id.length > 512) return null;
  const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
  for (const entry of Object.values(data.entries)) {
    if (entry.instanceId === instanceId && entry.externalDeliveryId === id) return entry;
  }
  return null;
}
```

- [ ] **Step 4: 补完整用例并跑过**

把 Step 1 的测试改为三用例（命中 / miss / 跨实例隔离）：

```ts
describe('messaging delivery ledger external-id lookup', () => {
  async function seed(uid: string): Promise<void> {
    const { beginDelivery, deliveryKey } = await import('../../../src/main/features/messaging/ledger');
    await beginDelivery(uid, {
      key: deliveryKey('bot-1', 'src-1'),
      instanceId: 'bot-1',
      externalChatId: 'oc_1',
      sourceMessageId: 'src-1',
      textHash: 'hash',
      text: 'hello',
      idempotencyKey: 'idem-1',
    });
  }

  it('finds a finished delivery by its external delivery id', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    await seed('u-1');
    await ledger.finishDelivery('u-1', ledger.deliveryKey('bot-1', 'src-1'), {
      status: 'sent',
      externalDeliveryId: 'om_9',
    });
    const found = await ledger.getDeliveryByExternalId('u-1', 'bot-1', 'om_9');
    expect(found).toMatchObject({ instanceId: 'bot-1', externalDeliveryId: 'om_9', externalChatId: 'oc_1', status: 'sent' });
  });

  it('returns null for unknown or other-instance delivery ids', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    await seed('u-1');
    await ledger.finishDelivery('u-1', ledger.deliveryKey('bot-1', 'src-1'), {
      status: 'sent',
      externalDeliveryId: 'om_9',
    });
    expect(await ledger.getDeliveryByExternalId('u-1', 'bot-1', 'om_unknown')).toBeNull();
    expect(await ledger.getDeliveryByExternalId('u-1', 'bot-2', 'om_9')).toBeNull();
  });

  it('returns null for blank or oversized ids without touching the file', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    expect(await ledger.getDeliveryByExternalId('u-1', 'bot-1', '  ')).toBeNull();
    expect(await ledger.getDeliveryByExternalId('u-1', 'bot-1', 'x'.repeat(600))).toBeNull();
  });
});
```

Run: `node scripts/run-tests.mjs run test/main/features/ledger-query.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/ledger.ts test/main/features/ledger-query.test.ts
git commit -m "feat(messaging): look up delivered messages by external delivery id"
```

---

### Task 2: 注册 addons 扩展（reaction scope + 事件）

**Files:**
- Modify: `src/main/features/messaging/feishu-registration.ts:110-116`（`APP_ADDONS`）
- Test: `test/main/features/feishu-registration.test.ts:89-92`（addons 断言）

**Interfaces:**
- Consumes: 无（仅常量）
- Produces: 新的 `APP_ADDONS` 常量 —— 新注册实例获得 reaction/contact/chat 权限；存量实例不受影响（Task 3 的静默降级依赖此语义）

- [ ] **Step 1: 写失败测试（更新断言）**

在 `test/main/features/feishu-registration.test.ts` 中找到 addons 断言（约 L89-92）：

```ts
      addons: {
        scopes: { tenant: ['im:message:send_as_bot'] },
        events: { items: { tenant: ['im.message.receive_v1'] } },
```

改为：

```ts
      addons: {
        scopes: {
          tenant: [
            'im:message:send_as_bot',
            'im:message:reaction:readonly',
            'contact:user.base:readonly',
            'im:chat:readonly',
          ],
        },
        events: { items: { tenant: ['im.message.receive_v1', 'im.message.reaction.created_v1'] } },
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs run test/main/features/feishu-registration.test.ts`
Expected: FAIL（addons 断言不匹配）

- [ ] **Step 3: 实现**

`src/main/features/messaging/feishu-registration.ts` 的 `APP_ADDONS` 改为：

```ts
const APP_ADDONS = {
  // The official preset plus the scopes/events the polish features need:
  // reaction events (feedback loop), contact user names and chat titles for
  // readable bindings. Instances bound before this change keep their old
  // grant; the adapters degrade silently when the API denies those calls.
  preset: false,
  scopes: {
    tenant: [
      'im:message:send_as_bot',
      'im:message:reaction:readonly',
      'contact:user.base:readonly',
      'im:chat:readonly',
    ],
  },
  events: {
    items: {
      tenant: ['im.message.receive_v1', 'im.message.reaction.created_v1'],
    },
  },
} satisfies lark.AppAddons;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs run test/main/features/feishu-registration.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/feishu-registration.ts test/main/features/feishu-registration.test.ts
git commit -m "feat(messaging): extend Feishu registration addons for reaction and identity scopes"
```

---

### Task 3: reaction 合成消息（事件注册 + 过滤 + 合成 + 接线）

**Files:**
- Modify: `src/main/features/messaging/types.ts`（`InboundEnvelope` 加 `synthetic?`；`AdapterCallbacks` 加 `resolveDelivery?`）
- Modify: `src/main/features/messaging/adapters.ts`（`FeishuReactionEvent` 接口、`normalizeFeishuReaction`、`reactionEnvelope`、构造函数事件注册、`_adapterTestHooks` 导出）
- Modify: `src/main/features/messaging/manager.ts`（startInstance 的 `callbacks` 加 `resolveDelivery`）
- Test: `test/main/features/feishu-adapter.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `getDeliveryByExternalId(uid, instanceId, externalDeliveryId)`
- Produces: `normalizeFeishuReaction(event)`（`_adapterTestHooks` 导出，纯函数）与合成 envelope（`synthetic: true`）；manager 的 `callbacks.resolveDelivery` 实现 —— Task 5 的 `enqueueInbound` 依靠 `synthetic` 跳过合并

- [ ] **Step 1: 写失败测试**

在 `test/main/features/feishu-adapter.test.ts` 的 `describe('Feishu official event adapter')` 内追加两个用例：

```ts
  it('normalizes reaction events and rejects non-user operators', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const { normalizeFeishuReaction } = _adapterTestHooks;
    expect(normalizeFeishuReaction({
      message_id: 'om_9',
      operator_id: 'ou_1',
      operator_type: 'user',
      reaction_type: { emoji_type: 'THUMBSUP' },
      create_time: '1710000000000',
    })).toEqual({
      messageId: 'om_9',
      operatorOpenId: 'ou_1',
      emoji: 'THUMBSUP',
      createTime: '2024-03-09T20:00:00.000Z',
    });
    expect(normalizeFeishuReaction({
      message_id: 'om_9',
      operator_id: 'ou_bot',
      operator_type: 'app',
      reaction_type: { emoji_type: 'Typing' },
    })).toBeNull();
    expect(normalizeFeishuReaction({ operator_type: 'user' })).toBeNull();
    expect(normalizeFeishuReaction({ message_id: 'om_9', operator_id: 'ou_1', operator_type: 'user' })).toBeNull();
  });

  it('synthesizes an inbound envelope only for reactions on our own messages', async () => {
    let handlers: Record<string, (event: unknown) => Promise<unknown>> = {};
    const dispatcher = {
      register: vi.fn((registered: Record<string, (event: unknown) => Promise<unknown>>) => {
        handlers = registered;
        return dispatcher;
      }),
    };
    const EventDispatcher = vi.fn(function EventDispatcher() { return dispatcher; });
    const WSClient = vi.fn(function WSClient() { return { start: vi.fn(async () => {}), close: vi.fn() }; });
    const Client = vi.fn(function Client() { return {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      im: { v1: { message: { create: vi.fn() } } },
    }; });
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client,
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher,
      LoggerLevel: { error: 'error' },
      WSClient,
    }));
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });
    const onInbound = vi.fn(async () => ({ accepted: true, duplicate: false }));
    const delivery = {
      key: 'k',
      instanceId: 'feishu-bot-1',
      externalChatId: 'oc_1',
      sourceMessageId: 'src-1',
      textHash: 'h',
      status: 'sent' as const,
      attempts: 1,
      updatedAt: new Date().toISOString(),
      externalDeliveryId: 'om_9',
    };
    const resolveDelivery = vi.fn(async () => delivery);
    (adapter as unknown as { callbacks: unknown }).callbacks = { onInbound, resolveDelivery };

    const reaction = handlers['im.message.reaction.created_v1'];
    expect(reaction).toBeTypeOf('function');

    // app 操作者（bot 自己的处理中 reaction）→ 不查账本
    await reaction({ operator_type: 'app', message_id: 'om_9', reaction_type: { emoji_type: 'Typing' } });
    expect(resolveDelivery).not.toHaveBeenCalled();
    expect(onInbound).not.toHaveBeenCalled();

    // 不是我们发的消息 → 不合成
    resolveDelivery.mockResolvedValueOnce(null);
    await reaction({ operator_type: 'user', operator_id: 'ou_1', message_id: 'om_9', reaction_type: { emoji_type: 'THUMBSUP' }, create_time: '1710000000000' });
    expect(onInbound).not.toHaveBeenCalled();

    // 我们发过的消息 → 合成 synthetic envelope
    await reaction({ operator_type: 'user', operator_id: 'ou_1', message_id: 'om_9', reaction_type: { emoji_type: 'THUMBSUP' }, create_time: '1710000000000' });
    expect(onInbound).toHaveBeenCalledTimes(1);
    const envelope = onInbound.mock.calls[0][0];
    expect(envelope).toMatchObject({
      platform: 'feishu_lark',
      instanceId: 'feishu-bot-1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_1',
      text: 'reaction:added:THUMBSUP',
      isGroup: true,
      mentionPresent: true,
      synthetic: true,
    });
    expect(envelope.externalMessageId).toContain('om_9');
  });

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs run test/main/features/feishu-adapter.test.ts`
Expected: FAIL（`normalizeFeishuReaction` 未定义 / 事件未注册）

- [ ] **Step 3: 实现**

**types.ts** — `InboundEnvelope` 末尾（`receivedAt: string;` 之后）加：

```

```ts
  /** Synthetic feedback event (a reaction on one of our messages), not a
   * real user text message. Skips burst merging and carries the interaction
   * intent of the original message. */
  synthetic?: boolean;
```

`AdapterCallbacks` 接口（types.ts 内）加：

```ts
  /** Resolve a previously delivered outbound message by its platform
   * delivery id, or null when it is not ours. Feishu reaction events use
   * this to scope feedback to messages this bot actually sent. */
  resolveDelivery?(externalDeliveryId: string): Promise<DeliveryLedgerEntry | null>;
```

**adapters.ts**：

a) `FeishuEventData` 接口之后新增：

```ts
interface FeishuReactionEvent {
  message_id?: string;
  operator_id?: string;
  operator_type?: string;
  reaction_type?: { emoji_type?: string };
  create_time?: string;
}
```

b) `normalizeFeishuCardAction` 之前新增两个纯函数：

```ts
/** Reaction events are feedback signals, not chat traffic: only a real user
 * reacting to one of our own messages is forwarded. Bot reactions (including
 * our own processing indicator) must never loop back into the agent. */
function normalizeFeishuReaction(event: FeishuReactionEvent): {
  messageId: string;
  operatorOpenId: string;
  emoji: string;
  createTime: string;
} | null {
  if (event.operator_type !== 'user') return null;
  const messageId = event.message_id?.trim() || '';
  const operatorOpenId = event.operator_id?.trim() || '';
  const emoji = event.reaction_type?.emoji_type?.trim() || '';
  if (!messageId || !operatorOpenId || !emoji) return null;
  const rawCreateTime = Number(event.create_time);
  const createTime = Number.isFinite(rawCreateTime) && rawCreateTime > 0
    ? new Date(rawCreateTime > 10_000_000_000 ? rawCreateTime : rawCreateTime * 1000).toISOString()
    : new Date().toISOString();
  return { messageId, operatorOpenId, emoji, createTime };
}

/** Feishu group chat ids are oc_-prefixed; p2p chat ids are the peer's
 * open_id (ou_-prefixed), so the delivery's chat id tells the group bit. */
function reactionIsGroup(delivery: DeliveryLedgerEntry): boolean {
  return delivery.externalChatId.startsWith('oc_');
}

function reactionEnvelope(
  instance: MessagingInstance,
  reaction: NonNullable<ReturnType<typeof normalizeFeishuReaction>>,
  delivery: DeliveryLedgerEntry,
): InboundEnvelope {
  return {
    platform: 'feishu_lark',
    instanceId: instance.id,
    externalMessageId: `${reaction.messageId}:${reaction.operatorOpenId}:${reaction.emoji}:${reaction.createTime}`,
    externalChatId: delivery.externalChatId,
    externalUserId: reaction.operatorOpenId,
    text: `reaction:added:${reaction.emoji}`,
    isGroup: reactionIsGroup(delivery),
    mentionPresent: true,
    synthetic: true,
    receivedAt: reaction.createTime,
  };
}
```

c) 构造函数 `eventDispatcher.register` 内、`'card.action.trigger'` 处理器之后追加：

```ts
      'im.message.reaction.created_v1': async (event: FeishuReactionEvent) => {
        if (!this.callbacks?.onInbound || !this.callbacks.resolveDelivery) return {};
        const reaction = normalizeFeishuReaction(event);
        if (!reaction) return {};
        try {
          const delivery = await this.callbacks.resolveDelivery(reaction.messageId);
          if (!delivery) return {};
          const envelope = reactionEnvelope(this.instance, reaction, delivery);
          void this.callbacks.onInbound(envelope).catch((error) => {
            log.warn('Feishu reaction dispatch failed', {
              instanceId: this.instance.id,
              error: logErrorSummary(error),
            });
          });
        } catch (error) {
          log.warn('Feishu reaction delivery lookup failed', {
            instanceId: this.instance.id,
            error: logErrorSummary(error),
          });
        }
        return {};
      },
```

d) `_adapterTestHooks`（adapters.ts 末尾）加导出：

```ts
export const _adapterTestHooks = { fetchJson, status, normalizeFeishuEvent, normalizeWecomEvent, boundedWecomText, parseFeishuBotOpenId, feishuMessageToText, normalizeFeishuCardAction, normalizeFeishuReaction };
```

**manager.ts** — startInstance 的 `callbacks` 定义（约 L1118）加：

```ts
    onInbound: async (envelope) => {
      if (!isCurrentRuntime(uid, runtime)) return { accepted: false, duplicate: false, reason: 'instance_not_found' };
      return handleInbound(uid, envelope);
    },
    resolveDelivery: async (deliveryId) => ledger.getDeliveryByExternalId(uid, instanceId, deliveryId),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs run test/main/features/feishu-adapter.test.ts`
Expected: PASS（Step 1 的完整用例即最终用例——上面的测试已包含过滤链全部断言，无需再补；若 SDK mock 形状报错，以实际跑通为准调整 mock 结构，核心断言不变）

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/types.ts src/main/features/messaging/adapters.ts src/main/features/messaging/manager.ts test/main/features/feishu-adapter.test.ts
git commit -m "feat(messaging): synthesize inbound events from reactions on our own messages"
```

---

### Task 4: burst-merge 防抖合并器（纯模块）

**Files:**
- Create: `src/main/features/messaging/burst-merge.ts`
- Test: `test/main/features/burst-merge.test.ts`（新建）

**Interfaces:**
- Consumes: 无（纯 TypeScript，无业务依赖）
- Produces:
  - `FEISHU_BURST_DEFAULTS: BurstMergeOptions`（600 / 8 / 4000 / 3500 / 2000）
  - `createBurstMerger<T>(options, flush: (batch: BurstBatch<T>) => void): BurstMerger<T>`
  - `BurstMerger.push(key, item: { id: string; text: string; payload: T })`、`flush(key?)`、`dispose()`
  - `BurstBatch<T> = { key, ids: string[], text: string, payload: T }`
  —— Task 5 的 manager 挂接依赖这些签名

- [ ] **Step 1: 写失败测试**

创建 `test/main/features/burst-merge.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEISHU_BURST_DEFAULTS, createBurstMerger } from '../../../src/main/features/messaging/burst-merge';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function collect() {
  const batches: Array<{ key: string; ids: string[]; text: string }> = [];
  const merger = createBurstMerger<number>(FEISHU_BURST_DEFAULTS, (batch) => {
    batches.push({ key: batch.key, ids: batch.ids, text: batch.text });
  });
  return { merger, batches };
}

describe('burst merge', () => {
  it('merges a burst of split messages into one batch after the window', () => {
    const { merger, batches } = collect();
    merger.push('bot-1\u0000oc_1', { id: 'm-1', text: 'part one', payload: 1 });
    merger.push('bot-1\u0000oc_1', { id: 'm-2', text: 'part two', payload: 2 });
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(600);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({ key: 'bot-1\u0000oc_1', ids: ['m-1', 'm-2'], text: 'part one\npart two' });
    expect(batches[0]).not.toHaveProperty('payload');
  });

  it('flushes immediately at the count limit and keeps the first payload', () => {
    const { merger, batches } = collect();
    for (let i = 0; i < 8; i += 1) {
      merger.push('k', { id: `m-${i}`, text: `t${i}`, payload: i });
    }
    expect(batches).toHaveLength(1);
    expect(batches[0].ids).toHaveLength(8);
    merger.push('k', { id: 'm-8', text: 't8', payload: 8 });
    expect(batches).toHaveLength(2);
  });

  it('flushes immediately at the char limit', () => {
    const { merger, batches } = collect();
    merger.push('k', { id: 'm-1', text: 'x'.repeat(3999), payload: 1 });
    merger.push('k', { id: 'm-2', text: 'yy', payload: 2 });
    expect(batches).toHaveLength(1);
    expect(batches[0].ids).toEqual(['m-1', 'm-2']);
  });

  it('uses the longer adaptive window near the char threshold', () => {
    const { merger, batches } = collect();
    merger.push('k', { id: 'm-1', text: 'x'.repeat(3500), payload: 1 });
    vi.advanceTimersByTime(600);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1400);
    expect(batches).toHaveLength(1);
  });

  it('keeps separate groups per key', () => {
    const { merger, batches } = collect();
    merger.push('k-1', { id: 'm-1', text: 'a', payload: 1 });
    merger.push('k-2', { id: 'm-2', text: 'b', payload: 2 });
    vi.advanceTimersByTime(600);
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.key).sort()).toEqual(['k-1', 'k-2']);
  });

  it('flush(key) and dispose() cancel pending timers', () => {
    const { merger, batches } = collect();
    merger.push('k-1', { id: 'm-1', text: 'a', payload: 1 });
    merger.push('k-2', { id: 'm-2', text: 'b', payload: 2 });
    merger.flush('k-1');
    expect(batches).toHaveLength(1);
    expect(batches[0].key).toBe('k-1');
    merger.dispose();
    vi.advanceTimersByTime(10_000);
    expect(batches).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs run test/main/features/burst-merge.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src/main/features/messaging/burst-merge.ts`：

```ts
/**
 * Debounced merger for bursty platform traffic (mirrors Hermes'
 * `_enqueue_text_event`). Feishu splits long messages into several pushed
 * chunks; each chunk must not consume a separate agent turn. Messages are
 * grouped by an opaque key (instance + chat), joined with "\n" and flushed
 * after a quiet window, immediately at the count/char limits, or on demand.
 */

export interface BurstMergeOptions {
  /** Quiet window before a batch is flushed (ms). */
  windowMs: number;
  /** Maximum messages per batch; reaching it flushes immediately. */
  maxCount: number;
  /** Maximum accumulated characters per batch; reaching it flushes. */
  maxChars: number;
  /** Accumulated chars at which the adaptive window kicks in. */
  adaptiveThresholdChars: number;
  /** Window used once the threshold is reached (ms). */
  adaptiveWindowMs: number;
}

export interface BurstItem<T> {
  id: string;
  text: string;
  /** Opaque caller payload; the first item's payload rides on the batch. */
  payload: T;
}

export interface BurstBatch<T> {
  key: string;
  /** Message ids in arrival order; the first id is the batch identity. */
  ids: string[];
  /** Items joined with "\n". */
  text: string;
  payload: T;
}

export interface BurstMerger<T> {
  push(key: string, item: BurstItem<T>): void;
  flush(key?: string): void;
  dispose(): void;
}

export const FEISHU_BURST_DEFAULTS: BurstMergeOptions = {
  windowMs: 600,
  maxCount: 8,
  maxChars: 4_000,
  adaptiveThresholdChars: 3_500,
  adaptiveWindowMs: 2_000,
};

interface BurstGroup<T> {
  items: BurstItem<T>[];
  chars: number;
  timer: NodeJS.Timeout | null;
}

export function createBurstMerger<T>(
  options: BurstMergeOptions,
  flush: (batch: BurstBatch<T>) => void,
): BurstMerger<T> {
  const groups = new Map<string, BurstGroup<T>>();

  const windowFor = (chars: number): number =>
    chars >= options.adaptiveThresholdChars ? options.adaptiveWindowMs : options.windowMs;

  const emit = (key: string, group: BurstGroup<T>): void => {
    if (group.timer) {
      clearTimeout(group.timer);
      group.timer = null;
    }
    groups.delete(key);
    flush({
      key,
      ids: group.items.map((item) => item.id),
      text: group.items.map((item) => item.text).join('\n'),
      payload: group.items[0].payload,
    });
  };

  const schedule = (key: string, group: BurstGroup<T>): void => {
    if (group.timer) clearTimeout(group.timer);
    group.timer = setTimeout(() => emit(key, group), windowFor(group.chars));
  };

  return {
    push(key, item) {
      if (!key || !item || !item.id) return;
      const text = item.text ?? '';
      let group = groups.get(key);
      if (!group) {
        group = { items: [], chars: 0, timer: null };
        groups.set(key, group);
      }
      group.items.push(item);
      group.chars += text.length;
      if (group.items.length >= options.maxCount || group.chars >= options.maxChars) {
        emit(key, group);
        return;
      }
      schedule(key, group);
    },
    flush(key) {
      if (key !== undefined) {
        const group = groups.get(key);
        if (group) emit(key, group);
        return;
      }
      for (const [groupKey, group] of [...groups]) emit(groupKey, group);
    },
    dispose() {
      for (const group of groups.values()) {
        if (group.timer) clearTimeout(group.timer);
      }
      groups.clear();
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs run test/main/features/burst-merge.test.ts`
Expected: PASS（6 用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/burst-merge.ts test/main/features/burst-merge.test.ts
git commit -m "feat(messaging): add debounced burst merger for split inbound messages"
```

---

### Task 5: manager 挂接合并器 + reaction 直通

**Files:**
- Modify: `src/main/features/messaging/manager.ts`（`enqueueInbound`、`mergerFor`、`flushBurstBatch`、startInstance 的 `onInbound` 改用 `enqueueInbound`、`_managerTestHooks` 导出）
- Test: `test/main/features/messaging.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 4 的 `createBurstMerger` / `FEISHU_BURST_DEFAULTS`；Task 3 的 `synthetic` 标记
- Produces: `enqueueInbound(uid, envelope): Promise<MessagingInboundResult>`（adapter 入站入口；synthetic 直通，普通消息进合并器）。注意：`ingestInbound`（IPC/测试入口）**保持直通 `handleInbound` 不变**，现有测试 L463/465/572/676/781 的立即派发语义不受影响——只有 adapter 的 `onInbound` 改走 `enqueueInbound`

- [ ] **Step 1: 写失败测试**

在 `test/main/features/messaging.test.ts` 追加（放在文件末尾、最后一个 describe 之后）。实例创建与 adapter mock 照本文件 L420-445 的既有模式（真实 registry + mock adapters/group_chat）：

```ts
describe('messaging burst merge on inbound', () => {
  async function seededInstance(uid: string): Promise<{ manager: typeof import('../../../src/main/features/messaging/manager'); groupSend: ReturnType<typeof vi.fn> }> {
    vi.useFakeTimers();
    const groupSend = vi.fn(async () => ({ ok: true }));
    const adapter = {
      platform: 'feishu_lark' as const,
      start: vi.fn(async (_signal: AbortSignal, callbacks: unknown) => {
        await new Promise((resolve) => { void callbacks; resolve(null); });
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ deliveryId: 'om_9' })),
    };
    vi.doMock('../../../src/main/features/messaging/adapters', () => ({ createAdapter: vi.fn(() => adapter) }));
    vi.doMock('../../../src/main/features/group_chat', () => ({ send: groupSend }));
    vi.doMock('../../../src/main/features/group_chat/bus', () => ({ subscribe: vi.fn() }));
    const registry = await import('../../../src/main/features/messaging/registry');
    const manager = await import('../../../src/main/features/messaging/manager');
    const created = await registry.createInstance(uid, {
      platform: 'feishu_lark',
      displayName: 'Test Feishu',
      policy: { allowUserIds: [uid] },
      secret: { appId: 'cli_1234567890abcdef', appSecret: 'app-secret' },
    });
    await manager.setEnabled(uid, created.id, true);
    await vi.waitFor(async () => {
      const instances = await manager.listInstances(uid);
      expect(instances[0]?.status.kind).toBe('connected');
    });
    return { manager, groupSend };
  }

  it('merges split messages into one dispatch', async () => {
    const uid = 'user-1';
    const { manager, groupSend } = await seededInstance(uid);
    const base = (id: string, text: string) => ({
      platform: 'feishu_lark' as const,
      instanceId: (await (await import('../../../src/main/features/messaging/registry')).listInstances(uid))[0].id,
      externalMessageId: id,
      externalChatId: 'oc_1',
      externalUserId: uid,
      text,
      isGroup: true,
      mentionPresent: true,
      receivedAt: new Date().toISOString(),
    });
    await manager.enqueueInbound(uid, base('m-1', 'part one'));
    await manager.enqueueInbound(uid, base('m-2', 'part two'));
    expect(groupSend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(groupSend).toHaveBeenCalledTimes(1);
    expect(groupSend.mock.calls[0][0]).toMatchObject({ text: 'part one\npart two' });
    vi.useRealTimers();
  });

  it('dispatches synthetic envelopes immediately, bypassing the merger', async () => {
    const uid = 'user-1';
    const { manager, groupSend } = await seededInstance(uid);
    const instanceId = (await (await import('../../../src/main/features/messaging/registry')).listInstances(uid))[0].id;
    await manager.enqueueInbound(uid, {
      platform: 'feishu_lark',
      instanceId,
      externalMessageId: 'evt-1',
      externalChatId: 'oc_1',
      externalUserId: uid,
      text: 'reaction:added:THUMBSUP',
      isGroup: true,
      mentionPresent: true,
      synthetic: true,
      receivedAt: new Date().toISOString(),
    });
    expect(groupSend).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
```

（`vi.waitFor` 在 fake timers 下会自动推进定时器（vitest 内置支持）。若 `start` mock 的签名与现有 L420 模式有出入，以本文件既有 adapter mock 为准调整；核心断言：合并消息 600ms 后单次派发且文本 join、synthetic 立即派发。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs run test/main/features/messaging.test.ts`
Expected: FAIL（`enqueueInbound` 未导出 / 未定义）

- [ ] **Step 3: 实现**

**manager.ts**：

a) import 处加（`createLogger` 之后）：

```ts
import { logErrorSummary } from '../../util/log-redact';
import { createBurstMerger, FEISHU_BURST_DEFAULTS, type BurstBatch, type BurstMerger } from './burst-merge';
```

b) 模块级（`chatLocks` 附近）加：

```ts
/** Per-user burst mergers; synthetic envelopes bypass them entirely. */
const burstMergers = new Map<string, BurstMerger<{ envelope: InboundEnvelope; resolve: (result: MessagingInboundResult) => void }>>();
```

c) `handleInbound` 定义之后加：

```ts
function mergerFor(uid: string): BurstMerger<{ envelope: InboundEnvelope; resolve: (result: MessagingInboundResult) => void }> {
  let merger = burstMergers.get(uid);
  if (!merger) {
    merger = createBurstMerger(FEISHU_BURST_DEFAULTS, (batch) => {
      void flushBurstBatch(uid, batch);
    });
    burstMergers.set(uid, merger);
  }
  return merger;
}

/** Flush one merged batch: mark the trailing message ids as seen so a lone
 * redelivery is rejected as a duplicate, then dispatch as a single envelope
 * carrying the first message id. The original caller's promise resolves only
 * after the merged turn is dispatched (or failed). */
async function flushBurstBatch(uid: string, batch: BurstBatch<{ envelope: InboundEnvelope; resolve: (result: MessagingInboundResult) => void }>): Promise<void> {
  const first = batch.payload.envelope;
  const resolve = batch.payload.resolve;
  try {
    for (const id of batch.ids.slice(1)) {
      const key = ledger.inboundKey(first.instanceId, id);
      try {
        const reservation = await ledger.reserveInbound(uid, key, first.receivedAt);
        if (!reservation.duplicate) await ledger.completeInbound(uid, key, { status: 'duplicate' });
      } catch {
        // Trailing ids are best-effort dedup markers; a bad id must not fail the batch.
      }
    }
    const envelope: InboundEnvelope = { ...first, externalMessageId: batch.ids[0], text: batch.text };
    resolve(await handleInbound(uid, envelope));
  } catch (error) {
    log.warn('messaging burst merge dispatch failed', {
      instanceId: first.instanceId,
      error: logErrorSummary(error),
    });
    resolve({ accepted: false, duplicate: false, reason: 'burst_merge_failed' });
  }
}

/** Inbound entry for adapters: synthetic feedback envelopes dispatch
 * immediately; regular text goes through the burst merger so split platform
 * messages consume a single agent turn. */
export async function enqueueInbound(uid: string, envelope: InboundEnvelope): Promise<MessagingInboundResult> {
  assertUserId(uid);
  if (!envelope || typeof envelope !== 'object') throw new Error('invalid inbound envelope');
  if (!envelope.instanceId || !envelope.externalMessageId || !envelope.externalChatId || !envelope.externalUserId || !envelope.text) {
    throw new Error('inbound envelope missing required fields');
  }
  if (envelope.synthetic) return handleInbound(uid, envelope);
  return new Promise<MessagingInboundResult>((resolve) => {
    const merger = mergerFor(uid);
    merger.push(`${envelope.instanceId}\u0000${envelope.externalChatId}`, {
      id: envelope.externalMessageId,
      text: envelope.text,
      payload: { envelope, resolve },
    });
  });
}
```

d) startInstance 的 `callbacks.onInbound`（约 L1118）改为：

```ts
    onInbound: async (envelope) => {
      if (!isCurrentRuntime(uid, runtime)) return { accepted: false, duplicate: false, reason: 'instance_not_found' };
      return enqueueInbound(uid, envelope);
    },
```

e) `_managerTestHooks` 导出加 `enqueueInbound`：

```ts
export const _managerTestHooks = {
  runtimeMap,
  handleInbound,
  handleCardAction,
  buildResolvedApprovalCard,
  stopInstance,
  liveStatuses,
  renderToolLine,
  toolLinesFromProcessEvent,
  enqueueInbound,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs run test/main/features/messaging.test.ts`
Expected: PASS（含新增 2 用例；`ingestInbound` 现有用例若直调 `handleInbound` 路径则不受影响——若现有用例通过 `ingestInbound` 且未等合并窗口，改为在用例中调用 `_managerTestHooks.handleInbound` 或补 `vi.useFakeTimers`）

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/manager.ts test/main/features/messaging.test.ts
git commit -m "feat(messaging): merge burst inbound text in manager and bypass for synthetic events"
```

---

### Task 6: @all 提及修复

**Files:**
- Modify: `src/main/features/messaging/adapters.ts`（`feishuMentionIsAll` + `normalizeFeishuEvent` 的 mentionPresent 计算）
- Test: `test/main/features/feishu-adapter.test.ts`（追加用例）

**Interfaces:**
- Consumes: 无
- Produces: `feishuMentionIsAll(mention): boolean`（`_adapterTestHooks` 导出）与 `mentionPresent` 对 `@所有人` 消息为 true

- [ ] **Step 1: 写失败测试**

在 `test/main/features/feishu-adapter.test.ts` 的 `describe('Feishu official event adapter')` 内追加：

```ts
  it('treats @all mentions as a present mention in text and post messages', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const instance = feishuInstance();
    const textAll = _adapterTestHooks.normalizeFeishuEvent(instance, {
      message: {
        message_id: 'om_3',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_all 明天同步进度' }),
        create_time: '1710000000000',
        mentions: [{ key: '@_all', id_type: 'user_id', id: 'all' }],
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    }, 'ou_bot');
    expect(textAll).toMatchObject({ mentionPresent: true });
    const postAll = _adapterTestHooks.normalizeFeishuEvent(instance, {
      message: {
        message_id: 'om_4',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'post',
        content: JSON.stringify({
          zh_cn: { title: '', content: [[{ tag: 'text', text: '通知' }]] },
        }),
        create_time: '1710000000000',
        mentions: [{ key: '@_all', id_type: 'user_id', id: 'all' }],
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    }, 'ou_bot');
    expect(postAll).toMatchObject({ mentionPresent: true });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs run test/main/features/feishu-adapter.test.ts`
Expected: FAIL（`mentionPresent` 为 false）

- [ ] **Step 3: 实现**

**adapters.ts**：

a) `feishuMentionOpenId` 函数之后加：

```ts
/** Feishu renders "@所有人" as an at-mention with id "all" (or the
 * "@_all" key). Policy gates group traffic on mentions; an @all message
 * addresses the bot as much as any explicit mention, so it counts. */
function feishuMentionIsAll(mention: NonNullable<FeishuMessage['mentions']>[number]): boolean {
  if (mention.key === '@_all') return true;
  const idObject = typeof mention.id === 'object' && mention.id ? mention.id as Record<string, unknown> : null;
  const idValue = typeof mention.id === 'string' ? mention.id : '';
  const openId = typeof mention.open_id === 'string' ? mention.open_id : '';
  const idOpenId = idObject && typeof idObject.open_id === 'string' ? idObject.open_id : '';
  return ['all', '@_all'].includes((idValue || openId || idOpenId).trim());
}
```

b) `normalizeFeishuEvent` 中 `mentionPresent` 计算改为：

```ts
  const mentionsAll = (message.mentions || []).some(feishuMentionIsAll);
  ...
    mentionPresent: botMentionTokens.length > 0 || mentionsAll,
```

c) `_adapterTestHooks`（Task 3 之后的状态）整行替换为：

```ts
export const _adapterTestHooks = { fetchJson, status, normalizeFeishuEvent, normalizeWecomEvent, boundedWecomText, parseFeishuBotOpenId, feishuMessageToText, normalizeFeishuCardAction, normalizeFeishuReaction, feishuMentionIsAll };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs run test/main/features/feishu-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/adapters.ts test/main/features/feishu-adapter.test.ts
git commit -m "fix(messaging): count @all mentions as a present mention in policy gating"
```

---

### Task 7: 姓名解析（user/chat 查询 + 缓存）

**Files:**
- Modify: `src/main/features/messaging/adapters.ts`（FeishuAdapter 内 `enrichSenderInfo` + LRU 缓存；`handleInboundWithReaction` 与 reaction 分支调用）
- Test: `test/main/features/feishu-adapter.test.ts`（追加用例）

**Interfaces:**
- Consumes: 无（SDK client 的 `contact.v3.user.get` / `im.v1.chat.get`）
- Produces: 入站 envelope 填充 `externalUserName` / `externalChatTitle`（bindings.ts 已有消费，会话标题自动可读）

- [ ] **Step 1: 写失败测试**

在 `test/main/features/feishu-adapter.test.ts` 追加 describe：

```ts
describe('Feishu sender enrichment', () => {
  it('fills user name and chat title once, then serves from cache', async () => {
    const userGet = vi.fn(async () => ({ code: 0, data: { user: { name: 'Alice' } } }));
    const chatGet = vi.fn(async () => ({ code: 0, data: { chat: { name: '项目群' } } }));
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      contact: { v3: { user: { get: userGet } } },
      im: { v1: { chat: { get: chatGet }, message: { create: vi.fn() } } },
    };
    const Client = vi.fn(function Client() { return client; });
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const EventDispatcher = vi.fn(function EventDispatcher() { return dispatcher; });
    const WSClient = vi.fn(function WSClient() { return { start: vi.fn(async () => {}), close: vi.fn() }; });
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client,
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher,
      LoggerLevel: { error: 'error' },
      WSClient,
    }));
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });
    const base = {
      platform: 'feishu_lark' as const,
      instanceId: 'bot-1',
      externalMessageId: 'm-1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_1',
      text: 'hello',
      isGroup: true,
      mentionPresent: true,
      receivedAt: new Date().toISOString(),
    };
    const first = await (adapter as unknown as { enrichSenderInfo(envelope: unknown): Promise<unknown> }).enrichSenderInfo(base);
    expect(first).toMatchObject({ externalUserName: 'Alice', externalChatTitle: '项目群' });
    expect(userGet).toHaveBeenCalledTimes(1);
    expect(chatGet).toHaveBeenCalledTimes(1);
    const second = await (adapter as unknown as { enrichSenderInfo(envelope: unknown): Promise<unknown> }).enrichSenderInfo(base);
    expect(userGet).toHaveBeenCalledTimes(1);
    expect(chatGet).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ externalUserName: 'Alice', externalChatTitle: '项目群' });
  });

  it('degrades silently when identity lookups fail', async () => {
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      contact: { v3: { user: { get: vi.fn(async () => { throw new Error('no permission'); }) } } },
      im: { v1: { chat: { get: vi.fn(async () => { throw new Error('no permission'); }) }, message: { create: vi.fn() } } },
    };
    const Client = vi.fn(function Client() { return client; });
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const EventDispatcher = vi.fn(function EventDispatcher() { return dispatcher; });
    const WSClient = vi.fn(function WSClient() { return { start: vi.fn(async () => {}), close: vi.fn() }; });
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client,
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher,
      LoggerLevel: { error: 'error' },
      WSClient,
    }));
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });
    const base = {
      platform: 'feishu_lark' as const,
      instanceId: 'bot-1',
      externalMessageId: 'm-1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_1',
      text: 'hello',
      isGroup: true,
      mentionPresent: true,
      receivedAt: new Date().toISOString(),
    };
    const result = await (adapter as unknown as { enrichSenderInfo(envelope: unknown): Promise<unknown> }).enrichSenderInfo(base);
    expect(result).toMatchObject(base);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs run test/main/features/feishu-adapter.test.ts`
Expected: FAIL（`enrichSenderInfo` 未定义）

- [ ] **Step 3: 实现**

**adapters.ts** — `FeishuAdapter` 类内：

a) 私有字段（`cardActionDedup` 附近）加：

```ts
  private readonly identityCache = new Map<string, { value: string; expiresAt: number }>();
```

b) 私有方法（`handleInboundWithReaction` 之前）加：

```ts
  private readonly IDENTITY_CACHE_TTL_MS = 10 * 60 * 1000;
  private readonly IDENTITY_CACHE_MAX = 512;

  /** LRU-ish identity cache with a 10-minute TTL (mirrors Hermes'
   * `_resolve_sender_name_from_api`). Failures are never cached. */
  private cachedIdentity(key: string, load: () => Promise<string | null>): Promise<string | null> {
    const now = Date.now();
    const hit = this.identityCache.get(key);
    if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);
    if (this.identityCache.size >= this.IDENTITY_CACHE_MAX) {
      const oldest = this.identityCache.keys().next().value;
      if (oldest !== undefined) this.identityCache.delete(oldest);
    }
    return load().then((value) => {
      if (value !== null) {
        this.identityCache.set(key, { value, expiresAt: Date.now() + this.IDENTITY_CACHE_TTL_MS });
      }
      return value;
    });
  }

  private async resolveUserName(openId: string): Promise<string | null> {
    return this.cachedIdentity(`user:${openId}`, async () => {
      try {
        const response = await this.client.contact?.v3?.user?.get?.({ path: { user_id: openId } }) as
          | { code?: number; data?: { user?: { name?: string } } }
          | undefined;
        const name = response?.data?.user?.name;
        return typeof name === 'string' && name.trim() ? name.trim() : null;
      } catch {
        return null;
      }
    });
  }

  private async resolveChatTitle(chatId: string): Promise<string | null> {
    return this.cachedIdentity(`chat:${chatId}`, async () => {
      try {
        const response = await this.client.im?.v1?.chat?.get?.({ path: { chat_id: chatId } }) as
          | { code?: number; data?: { chat?: { name?: string } } }
          | undefined;
        const name = response?.data?.chat?.name;
        return typeof name === 'string' && name.trim() ? name.trim() : null;
      } catch {
        return null;
      }
    });
  }

  /** Fill readable sender/chat names onto an inbound envelope. Every lookup
   * is optional and cached; failures keep the previous (id-only) state. */
  private async enrichSenderInfo(envelope: InboundEnvelope): Promise<InboundEnvelope> {
    if (envelope.platform !== 'feishu_lark') return envelope;
    let next = envelope;
    if (!next.externalUserName) {
      const name = await this.resolveUserName(next.externalUserId);
      if (name) next = { ...next, externalUserName: name };
    }
    if (next.isGroup && !next.externalChatTitle) {
      const title = await this.resolveChatTitle(next.externalChatId);
      if (title) next = { ...next, externalChatTitle: title };
    }
    return next;
  }
```

c) `handleInboundWithReaction` 整个方法体替换为（在 `addProcessingReaction` 之后、`onInbound` 之前 enrich）：

```ts
  private async handleInboundWithReaction(envelope: InboundEnvelope): Promise<void> {
    const callbacks = this.callbacks;
    if (!callbacks) return;
    const messageId = envelope.externalMessageId;
    await this.addProcessingReaction(messageId);
    const enriched = await this.enrichSenderInfo(envelope);
    try {
      const result = await callbacks.onInbound(enriched);
      if (!result.accepted) {
        await this.removeProcessingReaction(messageId);
        await this.addFailureReaction(messageId);
      }
    } catch (error) {
      log.warn('Feishu inbound dispatch failed', {
        instanceId: this.instance.id,
        error: logErrorSummary(error),
      });
      await this.removeProcessingReaction(messageId);
      await this.addFailureReaction(messageId);
    }
  }
```

d) reaction 事件分支（Task 3 加的处理器的 `try` 块内）整段替换为：

```ts
      'im.message.reaction.created_v1': async (event: FeishuReactionEvent) => {
        if (!this.callbacks?.onInbound || !this.callbacks.resolveDelivery) return {};
        const reaction = normalizeFeishuReaction(event);
        if (!reaction) return {};
        try {
          const delivery = await this.callbacks.resolveDelivery(reaction.messageId);
          if (!delivery) return {};
          const envelope = reactionEnvelope(this.instance, reaction, delivery);
          const enriched = await this.enrichSenderInfo(envelope);
          void this.callbacks.onInbound(enriched).catch((error) => {
            log.warn('Feishu reaction dispatch failed', {
              instanceId: this.instance.id,
              error: logErrorSummary(error),
            });
          });
        } catch (error) {
          log.warn('Feishu reaction delivery lookup failed', {
            instanceId: this.instance.id,
            error: logErrorSummary(error),
          });
        }
        return {};
      },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs run test/main/features/feishu-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/features/messaging/adapters.ts test/main/features/feishu-adapter.test.ts
git commit -m "feat(messaging): enrich inbound Feishu envelopes with cached user and chat names"
```

---

### Task 8: 全量验证

**Files:** 无

- [ ] **Step 1: 全量类型检查 + 测试**

Run: `npm test`
Expected: 全部 PASS（含新增 ledger-query、burst-merge 与扩展的 feishu-adapter、feishu-registration、messaging 用例）；类型检查无错误。

- [ ] **Step 2: 确认无未提交改动**

Run: `git status --short`
Expected: 干净（或仅剩计划/设计文档）。

- [ ] **Step 3: 收尾提交（如有遗漏）**

```bash
git add -A
git commit -m "chore(messaging): final polish for reaction merge and identity features" || true
```
