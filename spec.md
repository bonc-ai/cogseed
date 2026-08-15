# 认知继承与复用链 — 改动说明

> 分支 `restore/cognition-asset-gaps` · 已合入 develop `62b970b` · 2026-08-14
>
> 这份文档给要和这批改动对接的人。只写**契约**和**行为变更**，实现细节在源码头部注释和测试里。

---

## 1. 这批改动解决什么

08-12 张照航 revert 了 MR !47（`e4782aa`），08-13 重新 merge 同一分支时那批内容**没有回来**——revert 一个 merge 之后再合同一分支，git 认为那些提交已经合过。结果是 `agent_inheritance.ts`、`cognition-chain.ts` 等模块至今在 develop 上不存在。

这批改动做两件事：

1. **恢复**被 revert 冲掉、且至今没回来的能力资产语义与认知履历
2. **接通**「资产 → Agent 出生继承 → 本次运行选择 → 注入提示词 → 复用回执 → 履历与证明」这条链

恢复时**没有原样搬回旧代码**——旧实现依赖的 `p3394/capability-pack-delivery` 已被有意删除，重新按现行 `p3394/capability-pack` 契约接线。

---

## 2. 分支与合并状态

| | |
|---|---|
| 分支 | `restore/cognition-asset-gaps` |
| 分叉基线 | `69f7ca6`（08-13 11:16） |
| 已合入 | `origin/develop` @ `62b970b`（含 world-model 闭环那 39 个提交） |
| 提交数 | 13（12 个改动 + 1 个 merge） |
| 改动量 | 40 文件，+4172 / −31 |

合并时有 3 处冲突，**全是双方各加各的**，一律保留两边：

- `asset-service` 导入区：develop 的 `normalizeCausalRule` + 本分支的 `createLogger`
- `asset-service` 版本快照 `Pick`：develop 的 `learningProvenance` + 本分支的 `applicableWhen`/`forbiddenWhen`/`sensitivity`
- `candidate-service` promote：develop 的 `causalRule` 归一化 + 本分支的语义字段读取

合并后 typecheck 通过，recall + agent-inheritance **336 passed**。

---

## 3. 四层边界（最重要的约定）

新代码严格分四层，**不得互相吞**：

| 层 | 是什么 | 谁写 |
|---|---|---|
| `Asset` | 长期事实——资产本体 | 评审采纳时 |
| `InheritanceSnapshot` | 出生时事实——**不可变**，一次写入 | Agent 创建时 |
| `Selection` | 本次运行的决策——用完即弃 | 每轮运行时 |
| `Receipt` | 运行后的事实 | 注入时 |

**`SelectedCognition` 不是新的资产类型**，只是一次决策结果。它的 `content` 只有渲染要用的四个字段（`type`/`title`/`statement`/`scope`），不搬 `evidenceRefs`、`candidateId` 这些——真正的资产还是原资产。这条有测试钉住形状。

---

## 4. 新增模块

| 模块 | 职责 |
|---|---|
| `features/agent_inheritance.ts` | Agent 出生快照：继承了哪些资产的哪一版、什么没带走及原因 |
| `features/recall/asset-semantics.ts` | 适用/禁用条件、敏感级 L0–L2、规范 10.2 默认使用矩阵 |
| `features/recall/cognition-selection.ts` | **选择层**：从出生快照算出这一次真该带哪些 |
| `features/recall/inherited-cognition-prompt.ts` | 本地运行时的渲染侧：Selection → 提示词块 + 回执引用 |
| `features/recall/cognition-chain.ts` | 认知履历：五段视图 + 未带入原因 |

选择层是中立的，**两个消费方各自渲染**：本地运行时渲染正文进 system prompt；跨 Agent 交付渲染引用进 capability pack（后者尚未接）。

---

## 5. 对外契约

### 5.1 出生快照 `AgentInheritanceRecord`

```ts
{
  schemaVersion: 2,
  agentId: string,
  inheritedAssets: CapabilityPackAssetRef[],   // { asset_id, version, content_hash }
  excludedAssets?: { assetId, reason }[],      // 没带走的及原因
  rolePrompt: string,
  origin: { conversationId?, projectId?, workspaceId? },
  glossary?: { term, definition }[],
  memoryRefs?: string[],
  createdAt: string,
}
```

落盘位置 `<uid>/cloud/agents/<agentId>/inheritance.json`。**一次写入，重复记录抛错。**

- 只记引用，不搬正文。唯一例外是 `glossary`——术语的价值就在「出生那一刻它指什么」。
- `content_hash` 覆盖 `type/title/statement/scope/version`，不只是版本号：历史数据里存在改了正文没动版本的记录。
- `readAgentInheritance` 返回 `null` = **这个 Agent 生成时还没有继承机制**，与 `inheritedAssets: []`（确实没继承到）是两件事，消费方必须分开展示。
- 兼容早先内嵌 capability pack 的 v1 记录（只在读取时转换，不回写）。

`excludedAssets[].reason` 取值：`user_excluded`（人的决定）/ `paused` / `archived` / `revoked` / `deleted` / `purged`（系统按状态判）。

### 5.2 选择结果

```ts
SelectedCognition {
  assetRef, resolvedVersion, content: { type, title, statement, scope },
  applicableWhen?, forbiddenWhen?, sensitivity?,
  usePolicy: 'auto' | 'prompt' | 'confirm',
  sameScope: boolean,
  crossScopeConfirmed?: boolean,
}
WithheldCognition {
  assetRef,
  reasons: WithheldReason[],       // 全部成立的原因
  primaryReason: WithheldReason,   // 写进回执的那一条
}
```

**`reasons` 是复数**：一条资产可以同时既被暂停、又不在白名单里、内容还漂了。只记第一个会让用户看到的解释取决于代码判断顺序。

**`primaryReason` 按固定领域规则挑，不靠 if 顺序**：

```
1 权限/安全   scope 四维、敏感级越界、未分级
2 状态       revoked > purged > deleted > archived > paused > 成熟度不够
3 完整性     asset_missing > content_changed > version_changed
```

### 5.3 回执引用格式

```
带入:   asset:<id>@v<n>
未带入: asset:<id>@v<n>:<reason>
```

`cognition-chain` 按 `split(':').slice(2).join(':')` 取原因（前两段固定，之后全是原因）。**改格式会让履历的 evidence 段失效。**

三类未带入原因分开记，不合并：

- `<primaryReason>` — 选择层判定
- `needs_confirmation` — 跨作用域待确认（渲染侧的权限决定）
- `truncated` — 提示词篇幅放不下（资源限制）

回执 `executionId` 用 `turn-<turnId>`，与 `execution-records` 同名同目录。**不要自造合成 id**——早先版本用 `exec-inherit-<hash>`，导致回执落在没有 `record.json` 的目录里，重启后扫描器反复 warn，且语义上挂在一次不存在的执行上。

回执状态停在 `prepared`，它只说明 **LOADED**。`DELIVERED ≠ LOADED ≠ USED ≠ PROVED_USEFUL`，别让一张 prepared 回执把后三件也认领了。

### 5.4 新增 IPC 通道

| 通道 | 用途 |
|---|---|
| `agents.inheritance` | 读出生快照（`null` 与空数组含义不同） |
| `recall.cognitionChain.read` | 读认知履历五段 |
| `recall.proofs.list` | 按 assetId 反查迁移证明与效果证明 |
| `recall.assets.crossScope` | 确认 / 撤回跨作用域使用许可 |

渲染层新增路由：`GET /api/agents/:id/inheritance`。

### 5.5 资产新增字段（全部可选）

| 字段 | 含义 |
|---|---|
| `applicableWhen` / `forbiddenWhen` | 自然语言条件。**缺失 = 没记录过，不是「无限制」** |
| `sensitivity` | `L0`/`L1`/`L2`。**缺失 ≠ L0**，是「没分过级」。刻意没有 L3——L3 被准入闸挡在候选之前 |
| `crossScopeConfirmedAt` | 用户确认过可跨作用域使用的时间 |

新增审计动作：`cross_scope_confirmed`、`cross_scope_withdrawn`、`maturity_corrected`。

---

## 6. 行为变更（会影响其他人）

### 6.1 新资产的成熟度起点 `seed` → `bud`

promote 时写的两个字段本来自相矛盾：`lifecycleStatus = user_confirmed_unverified`，但 `maturity = seed`（规范 10.2 里 seed 是 **Candidate 档**）。而 `bud` 的定义原文就是「User Confirmed / Unverified」。

接上选择层后这个矛盾变成实的：**seed 一律 `never`，新资产永远进不了任何 Agent**，也就永远产生不了使用证据、做不了 transfer proof、升不了档——卡死在最底下一级（`setAbilityAssetMaturity` 只有 proof-service 一个调用方，且只升到 `transfer_validated` 以上，`seed→bud` 没有任何路径）。

**改了两处**：`candidate-service` 的 promote，以及 `asset-service.createAbilityAsset` 的初始状态守卫（原本硬校验 `maturity === 'seed'`）。只改一处会让所有 promote 直接抛错。

### 6.2 `scopePolicy` 白名单改回三态

```
undefined   没有限制
[]          明确一个都不允许      ← 原来被塌成 undefined
[a, b]      只允许这两个
```

原来 `out.length ? out : undefined` 把空数组塌成「没有限制」。这是权限洞：过滤方拿到同一个值只能二选一，放行会外发本该拦死的资产，拦死会让所有没设限的资产一起失效。

适用于全部白名单字段，不只 `agentIds`。

### 6.3 `cognition-chain` 原因解析修正

原来是 `split(':').slice(3) || pop()`。这个格式 split 出来只有三段，`slice(3)` 恒为空，一直靠 `pop()` 兜底才碰巧对；而 `pop()` 在「没带原因」的引用上会把 `<id>@v<n>` 当成原因返回。改成 `slice(2)`。

同时 `rejected` 的回执不再算进「实际带入」。

### 6.4 资产动作列表新增 `chain`

`_recallAssetActions()` 每个状态都多一个 `chain`（使用与证明入口）。`purged` 从 `['versions']` 变成 `['versions', 'chain']`——墓碑没有内容可治理，但它被谁带走过是既成事实。

**依赖这个列表的测试需要跟着更新**（`recall-cognition-flow.test.ts` 已改）。

---

## 7. 数据迁移

启动任务 `recall:correct-seed-maturity`（`boot_init` deferred 阶段，重磁盘档）。

把 `lifecycleStatus === 'user_confirmed_unverified'` 且 `maturity === 'seed'` 的资产修正到 `bud`。**判据是那对矛盾本身，不是「凡 seed 皆升」**；已撤销、已彻底清除、已经 bud 以上的一概不碰。

审计写 `maturity_corrected`（`actor: system`），**不复用升档语义**——这是修正归档错误，不是靠证据挣来的晋级，日后回看不能混为一谈。

幂等，修完空转。真机验证：`count=3`，三条资产各写一条审计，无重复。

---

## 8. 测试

新增 9 个测试文件，154 条用例，全绿。关键的几条钉的是**纪律而不是实现**：

- 主原因优先级与传入次序无关（打乱后结果不变）
- 履历段名不得漏出实现名（能力包 / 回执 / Capability Pack）
- 履历段名不得带进度语义（未完成 / 待完成 / pending）
- `not_yet` 在 CSS 里不得使用告警色
- 「没有继承记录」与「继承为空」是两句不同的话
- 「等你确认」与「放不下」是两句不同的话
- 跨作用域一律不比同作用域松（确认之后依然成立）

### 已知红线基线

`origin/develop` 上本来就红的有 **22 个测试文件**（p3394 KSTAR 清理残留、安全扫描、渲染层若干）。本分支**零新增失败**。

验证方法（对接时请用同一套，否则数字对不上）：

```bash
git worktree add --detach <dir> origin/develop
ln -s <repo>/node_modules <dir>/node_modules
# 两边各跑 npm run test:js，diff 失败文件集
```

> 注意：`npm run test:js`，不要直接调 `npx vitest`——脚本管着 sqlite ABI 的切换与回滚。

---

## 9. 明确没做的

| 缺口 | 说明 |
|---|---|
| `capability-load` 无生产入口 | 「能力包 → 目标端加载 → 回执」执行引擎完整且有测试，但 `buildCapabilityPack` 与 `loadCapabilityPackToTarget` **生产调用方为 0**，没有任何 IPC 通道，只能从测试到达 |
| 跨 Agent 文件交付未恢复 | 旧的 `capability-pack-delivery` / `capability-pack-export`（manifest.json + context-pack.md）仍在删除状态。恢复时必须保留一条纪律：**导出不写 ContextReuseReceipt**，文件复制不构成传递证明 |
| 能力包状态机未实现 | `draft → authorized → delivered → acknowledged → transfer_verified → outcome_reviewed` 一段都没有；token 与撤销也没有 |
| proofs 只有读没有写 | `recall.proofs.list` 是反查接口；产生 proof 仍需既有的 transfer/effectiveness 流程 |
| 条件不做机器判定 | `applicableWhen`/`forbiddenWhen` 是自然语言，选择层**只携带不判定**。要做场景相关性筛选得走一次 LLM 判断，属于新增能力 |

---

## 10. 对接时最容易踩的三件事

1. **改 `_recallAssetActions` 返回值会撞测试**——动作清单被写死在断言里。
2. **改回执引用格式会让履历静默失效**——`cognition-chain` 的解析与 `reuseRefsForTurn` 的生成必须同步改。
3. **`null` 与空数组的区别是语义不是风格**——出生快照、`scopePolicy`、`sensitivity` 三处都靠这个区别承载信息，归一化时不要顺手塌掉。
