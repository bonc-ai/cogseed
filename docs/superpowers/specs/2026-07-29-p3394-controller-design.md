# P3394 可调用控制器 · 设计文档

> 状态：已过审（三段设计逐段确认）· 日期：2026-07-29 · 语言：中文
> 硬门槛：本文档是实现的唯一设计基线，写代码前必须已批准。
> **落地时机：打包之后**（本升级在 agent 消息热路径上，不与打包抢时间）。

## 背景与目标

P3394 当前是「记录 + 无状态规范化函数」：`normalizeP3394AgentMessage` 是同步纯函数，
`session_epoch` 写死 0、`canonical_session_id` 拿 conversationId 凑、collaboration
context 只当标签透传。目标是把它升级为**有状态的可调用控制器**（`P3394Controller`），
在 agent 消息热路径上，基于**真实 session-store 来源**与**协作工作流 context 范围**做准入裁决。

关键判断（核实后）：现有调用处（`bus.ts:924`）已异步读好 collaboration snapshot、
已构造 delegation、调用处本身已是 `await (async()=>{})` 形态。故本升级**不新增 context 读**、
契约冲击小；真正的新增工作量集中在 **epoch 机制**。

## 四个已锁定决策（2026-07-29 经 AskUserQuestion 逐条确认）

1. **控制器形态** = 独立 `P3394Controller` 类（`src/main/features/p3394/controller.ts`），
   包在现有 `normalizeP3394AgentMessage` 外面，不重写内核。
2. **Context 范围严格度** = 适中：只校 `context_id` 归属（跨 workflow 越界则拒），
   revision 不强制匹配（交给 collaboration 现有 `context_revision_mismatch` 机制）。
3. **Session epoch** = 做 epoch 递增机制（不再写死 0）。
4. **Epoch 落点/语义** = 持久化到 `<uid>/local/kstar/`；语义为**接收方水位**
   （单边维护「该 session 见过的最大 epoch」，防回放不防伪造——当前发送方是可信 bus，
   伪造无场景）。

---

## 第 1 段 · 整体架构与控制器形态

新增 `src/main/features/p3394/controller.ts`：

```
P3394Controller
  ├─ 依赖注入: sessionSource(接 session-store)、contextSource(接 collaboration)、epochStore
  ├─ admitMessage(input): Promise<P3394NormalizeResult>   ← 主入口，取代 bus 里的裸 normalize
  │    1. 复用 normalizeP3394AgentMessage 做规范化 + 已有校验(capability/speechAct/executable/委托)
  │    2. session 裁决: 从 session-store 取真实 session id/kind/region，填进 metadata
  │    3. epoch 裁决: 接收方水位判重放 + 递增填 metadata.session_epoch
  │    4. context 裁决: 校 collaboration context_id 归属(适中级)
  │    5. 全过 → 放行(带真实 session/epoch/context 元数据)；安全违规 → agent.error
```

**关键设计点：**

- `normalizeP3394AgentMessage` **保留不动**（纯函数、现有测试全绿）。controller 外包，
  规范化仍由它做，controller 只加「有状态的 session/epoch/context 裁决」。改法 2（委托校验）等已有逻辑零改动。
- **异步**：`admitMessage` 为 `async`。bus 调用处（924 行）从同步 normalize 改为
  `await controller.admitMessage(...)`。调用处本已含 `await`，契约冲击小。
- **依赖注入**：session/context/epoch 三个来源做成可注入接口 → 可用 mock 独立测试，不依赖真实磁盘。

**热路径影响**：collaboration snapshot 已在 bus 读好（复用，不新增）；新增 session-store 解析
（正则 + 一次 resolveSessionPath，可缓存）+ epoch 一次加锁读写。每条消息实际多 1-2 次异步操作。

---

## 第 2 段 · Session 来源接入 + Epoch 机制

### A. Session 真实来源（接现有体系，不自建）

- 会话 id 为 `<kind>-<tail>` 格式；`sessions_sweep.ts::classify` 解析 kind；
  路由权威在 `model/core-agent/session-store.ts::resolveSessionPath`。
  kind 分 resumable（gconv/gmember/skill/agent，走 cloud）与 ephemeral（reflect 等，走 local）。
- 注入接口 `SessionSource.resolve(sessionId) → { sessionId, kind, region, valid }`。
- controller 把真实 kind/region 填进 `message.metadata`（不再是裸 conversationId）。
- **裁决**：解析不出合法 kind → 只填充 + 记录，**不拒**（避免误杀；严格拦截留到有真实需求）。

### B. Epoch 机制（唯一真新增）

- **存储**：新文件 `<uid>/local/kstar/p3394-epochs.json`，结构 `{ [canonical_session_id]: number }`。
- **并发**：照抄 `kstar-store.ts` 的 `async-mutex` 按 uid 加锁 + 原子写（kstar-store.ts:47-73 既有模式）。
- **接口**：`EpochStore.nextEpoch(uid, sessionId)`（加锁读→+1→原子写→返回）、`current(uid, sessionId)`。
- **语义 = 接收方水位**（决策 4）：controller 维护「该 session 见过的最大 epoch」；
  收到消息带 epoch 且 ≤ 水位 → 判重放拒（`replay_detected`）；否则 `nextEpoch` 填 metadata、更新水位。

### C. 并发与热路径

- epoch 读写加 uid 级 mutex（照抄 kstar-store），同 uid 消息串行化 epoch 操作。
- session 解析结果可加进程内缓存降开销。

---

## 第 3 段 · Context 归属裁决 + admitMessage 完整流程

### A. Context 归属裁决（适中级）

数据在手：bus 已异步读 `CollaborationSnapshot`（含 `run_id`/`context_id`/`status`/`context_revision`），
controller 复用，不新增读。

规则（只校 id 归属，不碰 revision）：

```
若消息带 collaboration 引用(input.collaboration.context_id):
  1. 取当前 workflow 的 snapshot.context_id
  2. 消息声称的 context_id ≠ 当前 workflow context_id → 拒(跨 workflow 越界)
  3. 相符 → 放行(revision 不强制，交给 collaboration 现有 context_revision_mismatch)
若消息不带 collaboration → 跳过 context 裁决(非协作消息，不拦)
```

- 增强（低风险）：`snapshot.status` 已终止（completed/aborted）时对新消息**只记警告，不拒**（避免误杀收尾消息）。
- 拒绝 reason：`context_scope_violation`。

### B. admitMessage 完整裁决顺序

```
async admitMessage(input): Promise<P3394NormalizeResult>
 ├─ 1. 规范化 + 已有校验(复用 normalizeP3394AgentMessage)
 │      capability / speechAct / executable block / 委托校验(改法2)
 │      任一失败 → 直接返回该 error(不进后续)
 ├─ 2. session 裁决: resolve → 填真实 kind/region；解析失败 → 只填充+记录，不拒
 ├─ 3. epoch 裁决: 收到 epoch ≤ 水位 → 拒(replay_detected)；否则 nextEpoch 填 metadata、更新水位
 ├─ 4. context 归属裁决: context_id 越界 → 拒(context_scope_violation)
 └─ 全过 → { ok:true, message(带真实 session/epoch/context 元数据) }
```

顺序理由：先做无 IO 的规范化/权限（快、失败早退），再做有 IO 的 session/epoch/context（慢）。

### C. 失败处理与降级（保护热路径不被拖垮）

| 场景 | 处理 |
|---|---|
| SessionSource 读失败 | 降级：不填真实 kind，metadata 标 `session_resolved:false`，**放行** |
| EpochStore 读/写失败 | 降级：epoch 填 0 + 标 `epoch_degraded:true`，**放行** |
| Context snapshot 读失败 | 降级：跳过 context 裁决，**放行**（bus 本就 `.catch(()=>null)`） |
| 真正的越权/重放/越界 | 才 `agent.error` 拒绝 |

**原则**：基础设施故障 → 降级放行 + 标记；安全违规 → 拒绝。故障不误伤正常消息
（与 evolution 的「降级标 degraded」一脉相承）。

### D. reason_code 扩展

`P3394AgentError.body.reason_code` 联合类型新增：
- `replay_detected`（epoch 水位）
- `context_scope_violation`（context 越界）

---

## 验收标准

- `normalizeP3394AgentMessage` 内核不变，其现有测试全绿（零回归）。
- `P3394Controller.admitMessage` 三来源均可注入 mock，独立单测通过（不依赖真实磁盘）。
- session：合法 `<kind>-<tail>` 消息 metadata 带真实 kind/region；解析失败降级放行 + 标记。
- epoch：同 session 递增；重放（epoch ≤ 水位）拒 `replay_detected`；EpochStore 故障降级放行 + `epoch_degraded`。
- context：跨 workflow 越界拒 `context_scope_violation`；同 context 放行；不带 collaboration 不拦；snapshot 读失败降级放行。
- bus 调用处改为 `await admitMessage`，group_chat 全量测试无回归。
- 热路径：正常协作消息全部放行，无误杀；基础设施故障不断流。
- 全程无新进程/端口/HTTP；epoch 只落 `<uid>/local/`；prompt 无品牌/真实路径。

## 不做（明确排除）

- 不重写 `normalizeP3394AgentMessage` 内核（只外包）。
- 不做发送方 epoch 递增/双边状态（决策 4 选接收方水位）。
- 不做 context revision 强制匹配（交给 collaboration 现有机制）。
- 不做 relationship 来源认证加固（改法 3，另议；当前 relationship 已由可信 bus 推导）。
- 不自建 session 状态机（复用 session-store）。
- 不在打包前落地（本升级在热路径，落地放打包之后）。

