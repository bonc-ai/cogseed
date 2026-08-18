# 认知资产链路 — 现状与修复决策

> 基线 develop `a506bc76`（= origin/develop） · 2026-08-17
>
> **审计阶段未改代码；此后已在工作区落地 4 项修复**：M-10 · M-5 · M-4 · N-12。
> 每项的落地记录附在 §5 对应层下，§3 / §4 的表格状态已同步。
>
> 上一批「认知资产页面不可交互 — 修复说明」保留在 `git show a506bc76:spec.md`。

---

## 怎么读这份文档

**不要从第一条开始按顺序修。** 这份文档分五段，作用各不相同：

| 段 | 作用 | 你该做什么 |
|---|---|---|
| §1 **已排除** | 已经查清、确认**不是**问题的结论 | 直接采信，不要重新调查。省掉的是最贵的那部分时间 |
| §2 **架构决策** | 3 个未定的产品/架构选择 | **未拍板前不要动 §3 的相关条目**，否则修完会被推翻 |
| §3 **主链问题（9 条 · 已修 3）** | 会让「沉淀 → 复用 → 证明」在某条路径上不成立的 | 真正要修的就是这些。剩余 6 条已按危害形态分 A/B/C 三类 |
| §4 **非阻塞问题（18 条 · 已修 1）** | 治理完整性、语义一致性、技术债 | 排在主链之后。有几条会随 §2 的决策一起消失 |
| §5 **修复顺序** | 四层：诚实化 → 拍板 → 修根因 → 治理展示 | 照这个走。**第 0 层不依赖任何决策，可立即开始** |

判断依据统一为：**是否影响这句话成立** —— 「一条认知资产真的可以从一次真实任务中产生，成为正式资产，被下一次真实任务加载和消费，并留下可追溯的回执与证据。」

**当前答案**：在 Commander / 空间会话路径上**为真**；在 CogSeed Runtime（Mate）上**为假**；通过 Ability Pack **为假**。

---

## 1. 已排除 — 不要再查的

这些是本次逐符号追过调用链、或跨两次扫描交叉复验后确认**没有问题**的部分。列在最前面，是为了让下一个人不要在这些地方重复挖。

### 1.1 主链本身是通的（有 production path 与端到端测试）

真实任务 → `saveRecallCandidate` → `promoteRecallCandidate` → `ability-assets` → `createAutomaticContextProjection` → `buildRecallTurnPromptContext` 拼进 system prompt → 同处 `prepareReceipt` 落回执 → 终态 `handleRecallTaskTerminal` → `completeTransferProofWithReceipt` → `setAbilityAssetMaturity` 升 `transfer_validated`。

每一跳都有生产调用方；`src/main/index.ts:1147/1151` 启动时注册闭合与终态证明两个监听器；`test/main/features/recall/fitness-receipt-closure-scenario.test.ts` 的 5 条端到端场景覆盖 evidence → candidate → asset → projection → receipt → transfer proof → maturity，全绿。

### 1.2 不存在的东西（不要去找）

| 曾经担心的 | 事实 |
|---|---|
| Workspace 读 recipe、KSTAR 读另一套 skill/snapshot | **Recipe 概念在本仓不存在**。全仓只在 `kstar/extraction-service.ts:160` 和 `skills.js:8` 两处注释文字里出现过这个词 |
| `snapshot_import` / `snapshot_export` / `record_evidence` 工具未注册 | 这三个工具**已完全不在当前树里**，零命中 |
| KSTAR 自己维护一套 evidence / memory / skill / cognition snapshot | **没有。** 28 个 kstar 模块中 20 个直接 `import` recall；沉淀经 `saveRecallCandidate` + `autoApplyRecallCandidate` 走统一出口；`cloud/kstar/` 只存 episodes/reviews/requirements 等 KSTAR 自己的领域对象，不存资产 |
| KSTAR 绕过统一路径直接读写本地文件 | 没有。`kstar/paths.ts` 全部经 `userCloudRoot` |

### 1.3 已经统一、不要重构的

- **候选生产**：五个真实生产者全部收口到 `saveRecallCandidate`（`recall/capture-service` · `kstar/direct-experience-assets` · `kstar/recall-bridge` · `session_import/asset-router` · `recall/teaching-service`，另加 IPC 直入）
- **资产创建**：`promoteRecallCandidate` 是唯一晋升出口 → `createAbilityAsset`，带 gate 校验、语义去重、版本快照、review-decision 落账。系统线缺边界会被 `rule_boundary_required` 挡下
- **Evidence schema**：`recall/source-service.CognitionSourceRef` 是共享归一化点，kstar / cognition / p3394 全部经它。`expert_signals` 是本地专家信号，**刻意**不并入
- **Ability 类型**：只有 `RecallAbilityAssetRecord` 一处定义，`AbilityAssetType` 被 kstar / cognition / formal-assets 共同 import
- **三个证明库正交**：p3394 复用回执 · recall 迁移证明 · recall 效果证明，各有存储与 ID 空间，跨库单向引用。`timeline-service.ts:218-224` 有显式注释保护「不要把 Receipt → Transfer → Effectiveness 三段拍成一段」
- **成熟度阶梯完整**：`seed → bud → transfer_validated → effectiveness_validated`，有序常量 + 数值序，支持升也支持降

### 1.4 页面层是干净的（上一份文档结论，本次逐条复验仍成立）

- **6 + 4 页面结构成立**：路由白名单 10 项、`index.html` 6 个 `data-cognition-page`、差额正好是 4 个只能从对象点进去的二级页
- **页面切分没有被误当成对象切分**：`selectedAssetId` 单一来源四页共用；治理页的「有候选」取自待办读模型而非自算（代码有显式注释保护）；候选有独立二级页与独立状态
- **0.7 拍平没有压平数据**：对象、状态机、ID 关系、权威事实源全部保持
- **没有新建权威库**
- **认知树是真实二级页**（`recall.tree.read/rebuild` + `CognitionTreeRecord`），是资产的投影视图，不该升为一级页
- **`receipts-adapter` 的权威源纪律是对的**：以 p3394 回执目录为准，`ExecutionRecord` 降级为可选展示补充

**上一份文档只需修正一处**：Q6「新沉淀出的资产会被 KSTAR / Agent 自动发现吗？」答「会」——在它扫描的层次内正确，但往下一层要加限定：**Commander 会、空间会话会、CogSeed Runtime 不会**（见 M-1）。

### 1.5 空间会话的注入是真实生效的

空间会话走的就是 `group_chat/bus.ts` 这条链，`spaceId` 作为 `workspaceId` 进投影。**分叉只在「绑定」这一个动作上**（见 M-9），不是整个 Workspace 都在链路外。

### 1.6 M-6「reuseTurnIds 仅在内存」——查过了，不是问题（2026-08-17 撤销）

这条曾被本次审计列为主链问题，描述是「进程重启后清单丢失 → 终态退回无回执分支 → 资产永不升档」。
动手修之前逐条追了失效路径，**描述不成立**，条目已撤销。ID 保留不复用。

| 检查 | 事实 |
|---|---|
| 清单会不会先于终态丢失？ | 不会。`state.taskRun = undefined` 与终态事件发射在同一个同步块里（`bus.ts:1481-1489`），操作同一个对象，中间没有窗口 |
| 进程活着时 state 会不会被驱逐？ | 不会。`dropConv` 只在**会话被删除**时调用（`chats.ts:2109`，`_purgeDeletedConversationFiles` 内），不是切换会话，也没有内存压力驱逐 |
| 进程中途死亡呢？ | 那次运行**根本不发终态**——重启的 `sweepStaleProcessing` 只把会话扫成 idle，注释写明「The next user message kicks off a fresh worker」（`chats.ts:2388-2391`）。缺的不是清单，是整条终态路径 |
| 就算补发终态呢？ | 中断的运行状态是 `cancelled`/`failed` → `proofStatusFor` → `'rejected'` → `maturityForTransferOutcome('rejected')` 返回 `undefined` → **本来就不升档**。这是既有的产品决定，不是缺陷 |

**结论**：持久化 `reuseTurnIds` 修不了任何东西——它针对的场景要么不存在，要么按设计就该不升档。

**顺带记下一个不是缺陷的观察**：出生继承路径的 `prepareReceipt` 在 `if (state.taskRun)` 守卫**之外**
（`bus.ts` 继承注入块），所以没有活动 run 时会写下一张无人认领的回执。它是惰性的——`terminal-proof`
只按显式 turn id 读回执，不会误取——而且「注入确实发生过」被如实记下来本身是对的。不要去"修"它。

### 1.7 最近这批合并没有引入回归

`133f9005`（约 3600 行）+ `097a4943` + `a506bc76` 合入后：测试 9202 → 9230（新增 28 条），失败 20 → 21，多出的那条单独重跑 7/7 全绿（flaky）。recall / cognition / kstar / skills 相关用例全部通过。`typecheck` 零错误。

这批还**主动修好了**：上次文档的 Q8-2（Skill 更新候选 diff 正文通道，现已能画文件级 diff）、`version-store` 绕开 paths（已引入 `userLocalRoot`）、Skill 升级待办的候选抑制；并新增了 `skill_version_pins` 把版本冻结送进 CogSeed Runtime，以及 `recall/skill-binding-service.ts`。

---

## 2. 架构决策 — 未拍板前不要动手

这三个是**产品/架构决策，不是技术选型**。它们决定 §3 里对应条目的修复形态，先修后定必然返工。

### 决策一 · Ability Pack 这条线到底要不要

留着它，每次讨论「资产怎么复用」都会分裂成两个答案；删掉它，Context Projection 就是唯一载体。

- **阻塞**：M-2 · 并连带决定 N-1 · N-13 · N-15
- **倾向**：**删**。真实复用已由 Context Projection + 出生继承两条路承担，且都有回执与证明；Pack 的价值只在「跨 Agent / 跨设备交付」，当前没有产品需求在推
- **红线**：删 Pack 时**不要动 `CapabilityPackAssetRef` 类型**——`agent_inheritance` 在真实复用它来冻结出生继承的资产引用

### 决策二 · CogSeed Runtime 要不要拿到认知资产

如果 Mate 任务是「另一种执行形态」，它就该和 Commander 有同等认知能力；如果定位是「受控的、只按显式指令跑的执行器」，那现状就是对的，但要写进文档而不是留成疑问。

- **阻塞**：M-1
- **倾向**：**接**。`RuntimeRunRequest.context` 这个槽已存在，且 chen 的 `skill_version_pins` 已经验证过「主进程组装 → 随请求下发」这条路；不接的话，用户在 Mate 里会明确感到「它不记得我教过的东西」
- **红线**：注入必须在主进程侧组装好再下发，**不要让 worker 去读 recall store**——它是隔离进程

### 决策三 · 回执是机器本地事实，还是可同步事实

这决定 M-7 是「修」还是「写进文档」。

- **阻塞**：M-7 · 影响 M-5 的实现方式
- **倾向**：**回执随资产进 cloud**。「这条资产被证明过」是资产的属性，不是某台机器的属性；否则用户换台电脑，所有成熟度都变成不可复核的既成事实
- **红线**：回执体含 `reusedRefs` 等执行痕迹，进同步域前要过一遍脱敏口径

---

## 3. 主链问题（9 条 · 已修 3 / 剩 6）

判定标准：**会让「沉淀 → 复用 → 证明」这条命题在某条路径上不成立，或让它成立得不可靠。**

**剩余 6 条按危害形态分三类**（2026-08-17 重排。原来只按「能打通哪段链」排序，不足以区分
「链断了」和「链没断但界面在说假话」——后者用户天天碰到，且修起来便宜一个数量级）：

| 类别 | 条目 | 共同形态 | 是否需产品决策 |
|---|---|---|---|
| **A · 直接阻断沉淀→复用→证明** | M-1 · M-2 · M-3 | 某条执行路径上资产根本没参与，或硬约束没送到模型 | M-1 需决策二 · M-2 需决策一 · **M-3 不需要** |
| **B · 前端显示假状态/假数据** | M-8 · M-9 | UI 声称做成了某事，后端落点不同或根本没有消费者 | 否（但收敛双轨需要） |
| **C · 架构/跨设备一致性** | M-7 | 单机内自洽，换机后事实丢失 | 需决策三 |

**A 类里 M-3 是唯一零决策依赖的**——三处 record 构造照抄一行即可，补的是硬安全约束。
B 类两条都不需要决策就能让 UI 诚实（§5 第 0 层 0-3 / 0-4），真正的双轨收敛才需要。

| ID | 问题 | 现在会发生什么 | 位置 | 前置 |
|---|---|---|---|---|
| **M-1** | CogSeed Runtime 不消费任何认知资产 | Mate 任务的执行上下文里零 ability asset、零出生继承、零投影，只有 agent 身份 / role / workflow / knowhow / standards / skillList。**该 runtime 上整条链不成立** | `cogseed_backend/agent-execution-context.ts:70` `buildCogSeedAgentRuntimeContext` | 决策二 |
| **M-2** | Ability Pack 全线零生产消费者 | `buildCapabilityPack` / `loadCapabilityPackToTarget` 全仓只有测试调用，无 IPC、无 feature 调用方；`cloud/mate_agent/capability-packs/` 恒为空目录。**「Asset → Pack → Reuse 已打通」是假的**；测试全绿，验证的是自己造包再自己读包 | `p3394/capability-pack.ts:80`<br>`p3394/capability-load.ts:135` | 决策一 |
| **M-3** | `forbidden_when` / `applicable_when` 在注入时被丢弃 | Commander 投影注入、committed 投影注入、派发授权注入三条路径的 record 里都没有适用/禁用条件。晋升时校验了边界、UI 显示了边界，**唯独模型拿不到硬约束**。只有出生继承那条路径带 | `recall/prompt-injection.ts`（三处 record 构造，零命中）<br>对照 `inherited-cognition-prompt.ts:60-61` | — |
| **M-4** ✅ | `effectiveness_validated` 结构性不可达 — **已修** | UI 评价按钮只发 `{ transferProofId, feedback }`，不带 `evidenceRefs`；`evaluateEffectivenessProof` 把无证据的 `better` 降级成 `insufficient_evidence`。**证明链最后一段永远走不完，「效果已验证」恒为 0**。后端逻辑是对的，缺的是 UI 侧收集证据的入口。<br>**现状**：「带入正确」改走取证面板，收 `note`（必填观察）+ `evidenceRefs`（只给系统真握有 id 的执行/会话）。落地记录见 §5 · 2-2 | `skills-bindings.js:402-403`<br>↔ `recall/proof-service.ts` | — |
| **M-5** ✅ | 回执永不 complete — **已修** | 三条注入路径都调 `prepareReceipt`，但 `completeReceipt` 没有可达的生产调用方（唯一入口 `behavior-contrast` 的 IPC 无渲染层调用者）。所有群聊回执 `status='prepared'`、`completedAt` 恒空。**当前不阻断，只因升档判定放宽到「非 rejected 即可」——这层宽容一旦收紧，链路会静默断掉**。<br>**现状**：回合收尾统一 `completeReceipt`，正常收尾记 completed、中断/报错记 degraded。落地记录见 §5 · 2-1 | `bus.ts:3970 / 4030 / 5799` | — |
| **M-7** | 回执存 local，资产存 cloud | 回执在 `local/kstar/executions/`（机器私有、不同步），资产在 `cloud/recall/`。**换机或重装后「使用与证明」页为空，成熟度无法复核** | `p3394/context-reuse-receipt.ts:164`<br>↔ `recall/paths.ts:11` | 决策三 |
| **M-8** | 两个候选池共用「接受候选」语义 | `cognition.candidates.decide` accept → 写 memory/ontology；`recall.candidates.promote` accept → 产资产。名字一样落点不同，**用户以为沉淀了其实没产生资产**。桥只有单向的 `importPersonalOntologyCandidate` | `cognition/candidates-adapter.ts`<br>→ `personal_ontology_candidates.confirmCandidate` | — |
| **M-9** | 空间资产绑定只写不读 | `spaces.assets.bind` 写入 `space.asset_reference_bindings`，**没有任何 runtime 读取方**（运行时读的是 `recall/workspace-refs`）。用户「把资产绑到这个空间」这个显式复用意图对模型没有产生任何影响。`content_hash` 字段存在但从未被计算填入 | `features/spaces.ts::bindSpaceAsset`<br>vs `recall/workspace-refs.ts::listWorkspaceAssetReferences` | — |
| **M-10** ✅ | 评价控件挂在必然失败的行上 — **已修** | 「这次复用是否有用」的渲染条件是 `refs.transferProofId \|\| refs.taskRunId`，**四种行都会显示**；但后端两条通道都要求存在 `status==='succeeded'` 且已绑定回执的迁移证明。**用户点「已带入本次任务」下面的评价 → 直接报 `no successful transfer proof for task run`**（实机已复现）。<br>**现状**：渲染闸门 `_proofRatingEligibility` 与后端前置条件一一对应，task 通道在 UI 上停用。落地记录见 §5 · 0-1/0-2 | 渲染 `skills.js:2157-2161`<br>通道 `effectiveness-feedback.ts:99`<br>`proof-service.ts:170-171` | — |

### M-10 的完整判定表（实机报错的根因）

| 行类型 | 用户看到 | refs | 走哪条通道 | 结果 |
|---|---|---|---|---|
| `projection_confirmed` | 已带入本次任务 | 只有 `taskRunId` | `feedbackForTask` | ❌ `no successful transfer proof for task run` |
| `usage_recorded` | 被引用 | 只有 `taskRunId` | `feedbackForTask` | ❌ 同上 |
| `transfer_prepared` | — | `transferProofId`（status=prepared） | `feedback(proofId)` | ❌ `requires a successful transfer` |
| `transfer_completed` succeeded **且有 receiptId** | 已正确带入 | `transferProofId` | `feedback(proofId)` | ✅ **唯一可行** |
| `transfer_completed` degraded/rejected | Evidence 不足 / 未能带入 | `transferProofId` | `feedback(proofId)` | ❌ `requires a successful transfer` |
| `transfer_completed` succeeded 但无 receiptId | 已正确带入 | `transferProofId` | `feedback(proofId)` | ❌ `requires a verified transfer receipt` |

**控件渲染在 4 种行上，实际只有 1 种行的 1 种状态能成功。** 就算走到那一格，M-4 又会把 `better` 降级成 `insufficient_evidence`。

渲染层注释写着「首次评价只从 `transfer_completed`（以及尚未评价的使用记录）进入」——说明让 `usage_recorded` 当入口是**有意**的，但这个意图和 `recordTaskEffectivenessFeedback` 的前置条件对不上。`projection_confirmed` 则连注释里都没提，是渲染条件写宽了顺带带进来的。

**M-4 是两次扫描唯一双双命中的一条**，上一份文档也把它列为「当前最值得优先补的一处断链」，本次独立复验后同意。**M-10 是 M-4 + M-5 在用户面前的那张脸**——用户碰不到「成熟度升不上去」，但一定会碰到「点了报错」。

---

## 4. 非阻塞问题（18 条 · 已修 1）

不影响那句核心命题成立，但影响治理完整性、语义一致性与后续维护成本。**排在主链之后**；其中 N-1 / N-13 / N-15 会随决策一一起消失。

### 4.1 治理与证据完整性（5 条）

| ID | 问题 | 事实 | 位置 |
|---|---|---|---|
| **N-1** | 资产事件账本零写入 | `appendAssetEvent` 无任何调用方 → `replayAssetView` 恒空、`audit-receipt` 连写入函数都不存在。这套声称 append-only 的治理账本实际不存在 | `p3394/asset-events.ts:113` · `asset-view.ts:26` · `audit-receipt.ts` |
| **N-2** | 语义复核与通用候选抑制未接 | `reviewCandidateSemantically` / `mergeSemanticReview` / `parseSemanticReview` / `toSecurityView` / `isCandidateSuppressed` 全无调用方。晋升只走确定性规则闸，候选视图 security 字段从不被填充。**部分缓解**：Skill 升级这一类待办本次已有独立抑制（`bindingHasDecision(…, ['rejected'])`） | `cognition/semantic-review.ts:123` · `gate.ts:254` · `review-decision.ts:185` |
| **N-3** | `glossary` / `memoryRefs` 只写不读 | Agent 出生时 `collectAgentBirthContext` 采集术语表与记忆引用并落盘，但没有任何路径把它们送进提示词——`inherited-cognition-prompt` 只渲染 assets。「出生就该知道 KSTAR 在这里指什么」实际没发生 | 写：`agent_inheritance.ts:231` · 读：无 |
| **N-4** | `episode.k.memoryRefs` 恒为空数组 | KSTAR Episode 的 K 段声明了 memoryRefs，两个构造点都硬写 `[]`。字段存在但从不承载事实 | `kstar/episode-builder.ts:171 / 342` |
| **N-5** | `usageReceiptId` 装了两种 id | `usage_recorded` 行放 usage 记录 id，`transfer_completed` 行放真 receiptId。前端按 receiptId 建索引，**usage 行的回执详情恒查不到**。渲染层注释本身只提到 `transfer_completed` 一种情形，说明是写入侧口径漂移 | `recall/timeline-service.ts:163` vs `:197`<br>前端 `skills.js:2252 / 2350` |

### 4.2 契约与命名空间（3 条）

| ID | 问题 | 事实 | 位置 |
|---|---|---|---|
| **N-6** | `cognition.assets.list` 类型枚举完全不相交 | IPC 校验只放行 `skill/knowledge/ontology/evaluation`，适配器过滤的是 `personal/rule/template/skill_method`。任何 type 过滤要么抛错要么恒空。**渲染层当前不传该参数，问题潜伏** | `ipc/index.ts:2510` vs `cognition/types.ts:103` |
| **N-7** | 新旧资产共用 `cognition.assets.*` 通道前缀 | `ipc/index.ts:4694` 用一段解构显式剔掉 legacy 的 `cognition.assets.list` 避免撞车，其余 8 个 legacy 通道仍指向旧 store（seed/sprout/growing/bright，存 `cloud/cognition/`）。**靠一行解构维持的命名空间隔离很脆** | `ipc/cognition.ts` ↔ `ipc/index.ts:2443-2540` |
| **N-8** | `cognition.candidates.decide` 不接受 `skill_evolution` | handler 硬性要求 `source === 'personal_ontology'`。**已缓解**：chen 新开了 `recall.skills.decide`（accept/defer/reject）并接上渲染层，本条从「阻断」降为「命名空间不统一」 | `ipc/index.ts:2472` 附近<br>替代通道 `ipc/index.ts:2327` |

### 4.3 展示层数据真实性（4 条）

上一份文档已确认四视图的数据源基本是真的，**不要重做信息架构**，这里剩的都是个别字段。

| ID | 问题 | 事实 | 位置 |
|---|---|---|---|
| **N-9** | Dashboard 计数被 limit 截断 | `pendingCandidates` 与 `receipts` 的计数取自 `limit:10` 的列表再取 `.length`，**这两个数字永远最多是 10**；候选数还只统计本体池，不含真正会变资产的 recall 候选。<br>**2026-08-17 复核修正了危害范围**：这两个 count **渲染层根本没消费**——`_skillsCognitionState.dashboard` 全仓只有一个读点（`skills.js:2019`），只取 `warnings` 与 `degraded`。「待我处理」的三个数字另有来源且都是全量（`cognition.inbox.list` / `recall.candidates.list` 均无 limit）。<br>**真正被截断的可见数字只有一个**：「教学回执」metric 取自 `recall.teaching.list {limit:20}` 再 `.filter(active).length`（`skills.js:2042`），**超过 20 条就不准**，且 revoked 的也占配额。<br>另因 M-5 曾使回执恒为 prepared，`warnings` 永久挂一条 `receipt_prepared`——M-5 已修，新回执不再触发，存量 prepared 仍在 | `cognition/dashboard.ts:9-10`<br>`skills.js:2019 / 2042` |
| **N-18** | 回执没有 Agent 维度 | `ContextReuseReceipt` 只有 `sourceSessionId` / `targetSessionId`；`agentId` 来自 `ExecutionRecord`，是**单值可选展示补充**，不是"源 Agent → 目标 Agent"这一对。<br>原型 v0.9.1 §07 的回执栅格要求「源Agent Codex → 目标Agent WorkBuddy」，以及「跨 Agent」筛选——**这两样后端都给不出**。<br>新增条目（2026-08-17 对照原型时发现），非阻塞：它不影响证明链成立，只影响「使用与证明」能说清多少 | `p3394/context-reuse-receipt.ts:24-41`<br>`cognition/receipts-adapter.ts:53` |
| **N-10** | 时间线 usage 与 proof 视觉同级 | 「用过 20 次」和「被证明有效 1 次」同一条流、同一种条目样式。数据侧不需要动（`RecallAssetTimelineKind` 17 个值仍分得开）。**已部分缓解**：现有四层筛选 | `skills.js:2027` · 筛选 `skills.js:2234-2244` |
| **N-11** | 资产查不到时卡片回退裸 ID | 回执列表里资产本地查不到时直接显示 `receipt.assetId`，用户看到一串 id 而不是「已删除/未同步」 | `skills.js:1071` |
| **N-12** ✅ | 非资产分流页仍是死路 — **已修** | 曾经：`recall.continuation.list/read` 不存在，页面外壳在但显示「待接入」，带 `TODO(P5)`。<br>**现状**：两个通道已开，页面读真实快照。落地记录见 §5 · 3-2a |

### 4.4 技术债（5 条）

不阻塞任何链路，但持续制造「这个开关/钩子是不是该用」的误判成本。

| ID | 问题 | 事实 | 位置 |
|---|---|---|---|
| **N-13** | `nseap-meta-skill-engine` 整包孤立 | 92 个文件、只有 `dist/` 没有 `src/`、不在 workspaces 里、全仓零 import。删除计划早已执行完，只剩目录没清 | `packages/nseap-meta-skill-engine/`<br>计划见 `docs/superpowers/plans/2026-08-10-remove-meta-skill-evolution-line-b-prime.md` |
| **N-14** | P3394 特性开关 10 去其 9 无消费者 | 只有 `skilllifecycle` 被读。`gateb`（KSTAR 隔离复用验证）、`snapshot`、`rolecomposition` 等 9 个无任何读取点——**包括看起来正是为 M-1/M-2 准备的那个 `gateb`** | `p3394/flags.ts` · 唯一消费者 `skills/skill-lifecycle.ts:93` |
| **N-15** | 孤儿 i18n 文案键 | `cognition.minimum_capability_pack`「最小能力包」四语齐全，渲染层零引用。是 Pack 那条线被弃用后的遗留物 | `src/renderer/locales/{zh,en,ja,pt}.json` |
| **N-16** | 技能版本库仍优先读环境变量 | chen 已把 `userLocalRoot` 引进来（原来完全自造），但仍是 `process.env.ORKAS_WORKSPACE_ROOT \|\| path.dirname(path.dirname(userLocalRoot(uid)))` 再重新拼一遍 `uid/local/...`。绕了一圈回到 paths 已经能直接给的东西 | `skills/version-store.ts:67-76` |
| **N-17** | P3394 KSTAR 闭合钩子是空壳 | `P3394BridgeKstarCloseHook` 是内存 Map，`proposed_updates` 恒为 `[]`，`close()` 从未被调用，`list()` 无读者。只在 executor 构造时被实例化 | `p3394_bridge/kstar-close-hook.ts` · 实例化点 `executor.ts:113` |

---

## 5. 修复顺序

**排序原则（2026-08-17 因 M-10 实机报错修订）**

原来的排序只按「修完能多打通哪一段链」。M-10 暴露了这个原则不够用：**一批问题的共同形态是「UI 声称能做，后端做不到」**——M-10 点了报错、M-9 绑了没用、M-8 接受了没产生资产、M-2 有目录没内容。这类问题里，「让系统停止说假话」比「让它做对事」便宜一个数量级，而且不依赖任何架构决策。

所以改成四层，**层内才按打通链路排序**：

```
第 0 层  让系统停止说假话    ← 零决策依赖、零后端语义改动、可立即做
第 1 层  拍板架构决策        ← 不写代码
第 2 层  修根因              ← 把「做不到」变成「做得到」
第 3 层  治理与展示          ← 底层稳定后再动
```

### 第 0 层 · 让系统停止说假话（可立即开始）

不改任何后端语义，只让入口与它背后的真实能力对齐。做完这层，用户不会再点到报错，团队也能看清哪些能力是真的缺。

| # | 内容 | 状态 | 说明 |
|---|---|---|---|
| **0-1** | **M-10** 收紧评价控件的渲染条件 | ✅ **已完成** | 见下方「0-1 / 0-2 落地记录」 |
| **0-2** | **M-10 配套** 把后端三条错误信息改成用户能读懂的话 | ✅ **已完成** | 同上 |
| **0-3** | **M-9** 空间绑定：接进选择逻辑，或在 UI 上明说它只是记录 | 待做 | 二选一，但**必须选一个**。现状是用户做了一个对模型毫无影响的动作 |
| **0-4** | **M-8** 两个「接受候选」入口在 UI 上区分开 | 待做 | 同上：要么合并，要么让用户看得出这两个 accept 的落点不同 |

#### 0-1 / 0-2 落地记录（2026-08-17）

**闸门收口**（`skills.js` 新增 `_proofRatingEligibility(event, receipt)`）：只有
`transfer_completed` + `status==='succeeded'` + 有 `refs.usageReceiptId`（即证明已绑回执）
且回执边界为 real 时开放评价，与后端 `evaluateEffectivenessProof` 的前置条件一一对应。
**`feedbackForTask` 那条 task 通道在 UI 上彻底不再使用**——它的后端前置条件与 proof 通道
完全相同，单独留着只会制造第二条注定失败的路径。

**没有藏掉控件**：不可评价时照样渲染这一区，换成六种诚实说明之一——
还没形成迁移证明 / 迁移证明未完成 / 被判 Evidence 不足 / 未能带入 / 未绑定回执 / 回执非真实边界。
每一句都说清卡在哪、接下来会怎样。四语文案齐全。

**链条条带同源**：`_renderProofChainStrip` 的「评价」段改用同一个闸门，避免出现
「链条写着可评价、底下却没有按钮」。

**错误码**（`proof-service.ts` 新增 `recallProofError` + `RecallProofErrorCode`）：
三条错误带上 `E_RECALL_TRANSFER_NOT_SUCCEEDED` / `E_RECALL_TRANSFER_RECEIPT_MISSING` /
`E_RECALL_NO_SUCCESSFUL_TRANSFER`。IPC 分发器（`ipc/index.ts::handleInvoke`）本来就透传
`err.code`，不需要新管道。**message 保持原样**——日志与既有测试按它断言。渲染层
`_recallProofErrorText(result)` 按码翻译，未知码退回原始 error，不吞掉失败。

**测试**：`recall-cognition-flow.test.ts` 新增 7 行矩阵用例覆盖全部六种不可评价情形 +
唯一可评价的那一格；两条编码了旧行为的断言已改写（原来断言 `usage_recorded` 挂 task 通道
按钮，那正是这次报错的来源）。

### 第 1 层 · 拍板 §2 的三个决策

不写代码。决策一未定就动 M-2、决策三未定就动 M-7，都会返工。

### 第 2 层 · 修根因

| # | 内容 | 为什么在这个位置 |
|---|---|---|
| **2-1** | **M-5** 让回执闭合 ✅ **已完成**；**M-7** 按决策三处理 — 待做 | **提到 M-4 之前**——0-1 做完后会直接看到「几乎没有一行能评价」，根因就在这里：回执不闭合、终态证明覆盖率不明。回执是整条证明链的锚点，先把锚点做实 |
| **2-2** | **M-4** 补效果证据入口 ✅ **已完成** | 两次扫描唯一双双命中。后端逻辑不用改，只需 UI 评价时带上可追溯的对比引用 |

#### 2-1 / 2-2 落地记录（2026-08-17）

**M-5 回执闭合**（`bus.ts`）：新增 `turnReuseReceiptPrepared` 标记，三条注入路径
（Commander 投影 / 派发授权 / 出生继承，共用 `turn-<turnId>` 一个回执键）任一落成即置位；
回合收尾统一 `completeReceipt`。

状态取值是这次的关键判断：**注入发生在回合开始，所以只要回合跑起来了「加载」就是真的**。
回合本身失败或被中断，改变的是这次运行的质量，不是「有没有加载过」——所以取 `degraded`
而不是 `rejected`。`rejected` 的语义是「这次复用被拒绝/无效」，用在这里会让
`collectLoadedAssetsFromReceipts`（按 `status==='rejected'` 过滤）把本来算数的加载证据丢掉。
任务级别的成败由 terminal-proof 另行判定，两者不能混。

`terminal-proof.test.ts` 新增三态矩阵钉住这条语义：completed ✅ 升档 / degraded ✅ 升档 /
rejected ❌ 不升档。**这条测试保护的是「让回执闭合」本身不会把升档链打断**——那会比停在
prepared 更糟。

**M-4 效果证据**（`skills.js` + `skills-bindings.js`）：「带入正确」不再一点就落账，改为先开
取证面板——PRD 3.6 给 Effectiveness Validated 的成立条件是「可比 Baseline/Treatment、
Behavior Diff、Evaluation」，一个赞不算证明。面板收两样东西：

- **观察**（`note`，必填）。此前这个字段从来没传过，后端只能合成英文占位串
  `User feedback: positive`，渲染层还要专门把它过滤掉。现在是用户真写的话。
- **可追溯引用**（`evidenceRefs`）。只给系统真的握有 id 的东西：回执背后的那次执行
  （`execution_evaluation`/`evaluation`）、资产被带入的那个会话（`conversation`/`session`）。
  **不编造**——回执正文取不到时面板照样能提交，但如实说明这条会被记成
  `insufficient_evidence`，结论保留、成熟度不动。

其余三档（需要修正 / 未产生明显差异 / Evidence 不足）语义不变，仍直接落账：后端只对
`better` 要求可追溯引用。
| **2-3** | **M-3** 把 `forbidden_when` 带进注入 | 三处 record 构造照 `inherited-cognition-prompt.ts:60-61` 补上即可。改动最小、风险最低，但补的是硬安全约束。可与 2-1/2-2 并行 |
| **2-4** | 按决策一清理或接通 Pack 线（**M-2**，连带 N-13 / N-15） | 删除 → 三条一次性收敛；接通 → 必须同时给出生产入口和消费者，否则不动 |
| **2-5** | 按决策二给 CogSeed Runtime 注入资产（**M-1**） | 走 `RuntimeRunRequest.context` 已有的槽，参照 `skill_version_pins` 的组装方式。完成后第二个 runtime 与 Commander 能力对齐 |
| **2-6** | **M-8 / M-9** 的真实收敛 | 0-3 / 0-4 只是让 UI 诚实，这一步才是把双轨并掉 |

### 第 3 层 · 治理与展示

| # | 内容 | 说明 |
|---|---|---|
| **3-1** | **N-1 / N-2** 治理层：接上或删掉 | 必须排在展示层之前——「版本与治理」页要展示的东西，得先真的在写 |
| **3-2a** | **N-12** 非资产分流接真实快照 | ✅ **已完成**，见下方落地记录。它不依赖任何决策，也不碰资产语义，所以提前做了 |
| **3-2b** | 展示层与剩余技术债 | N-9（范围已收窄，只剩「教学回执」一个截断数字）/ N-18 / N-5 / N-6 / N-10 / N-11 / N-14 / N-16 / N-17 |

#### 3-2a 落地记录（2026-08-17）

**范围刻意收窄到「让这一页有真数据」**：不动 `TaskContinuationSnapshot` 的语义与状态机，
不重构 chats / task_continuation 主链，不把 continuation 并进四类资产、候选池或认知树。
非资产续接只负责「继续未完成任务」，是否沉淀成资产仍走原有 候选识别 → accept → asset 链。

**后端**：`task_continuation.ts` 新增只读的 `listContinuationSnapshots(userId, {limit})`。
快照落在每个会话自己的 `groupDir/continuation-snapshot.json`，**没有聚合索引，也刻意不建**
——快照是非资产对象，生命周期跟着会话走，多一份索引就多一处会和会话删除失步的状态。
改为扫会话列表（`chats.listConversations` 自带 TTL 缓存）逐个读，绝大多数直接 ENOENT。
`chats` 已经动态 import 本模块，所以这里也用动态 import 避免静态循环。

**IPC**：`recall.continuation.list`（返回 `{items, total}`）· `recall.continuation.read`。
**`total` 与 `items.length` 分开返回**：limit 截断的是显示条数，不是事实条数。这一页整页的
意义就是「任务状态确实被记下来了」，把截断后的长度当总数正是这里最不该犯的错。

**渲染**：真实快照卡 + loading / empty / error(带重试) 四态。展开时走 `recall.continuation.read`
取磁盘当前值回填——快照会被 `ensureProjectBrief` 在后台蒸馏改写，不重读就是给用户看过期状态；
单读失败保留列表里那份并照常展开，不把既成事实变成错误态。

**只渲染快照真握有的字段**：goal / stage / nextStep / constraints / latestArtifact / createdAt
+ 会话标题 / projectId / spaceId。**特别是没有 `updatedAt`**——快照只记 `createdAt`，所以卡上
写「生成于」而不是「更新于」。原型 v0.9.1 画了「更新时间」，后端没有这个事实，没有补推断值。

`usable=false`（goal 仍是导入样板噪音）的快照照样列出并标注，不过滤：那是既成事实，
藏掉会让用户以为这次导入压根没生成接续状态。

**测试**：`recall-cognition-flow.test.ts` 新增 5 条——四态渲染矩阵、字段真实性 +
total/shown 分离、展开走 read 且带 projectId、单读失败保留列表值。原来那条断言
「说出通道未接入」的用例已作废并替换。

### 为什么把 M-4 从第 2 位挪到 2-2

原排序把「补效果证据入口」放在第 2 位，理由是「改动小、可见度最高」。M-10 复现后这个判断要修正：**用户根本走不到需要 evidenceRefs 的那一步**——四种行里三种直接报错，第四种还要求迁移证明已绑定回执。先补 evidenceRefs 等于给一扇打不开的门换锁。

正确顺序是：先让门能开（0-1 诚实化 + 2-1 回执闭环），再换锁（2-2 证据入口）。

### 修复时的红线

- **第 0 层不要靠「藏掉入口」交差**——把按钮删掉是最快的，但它同时删掉了「这条链现在到底通到哪一步」这个信息。诚实空态要说清原因

- 删 Pack **不要动 `CapabilityPackAssetRef` 类型**——`agent_inheritance` 在真实复用它
- 给 Runtime 注入资产**不要让 worker 去读 recall store**——隔离进程，必须主进程组装后下发
- 收敛空间双轨**不要动「资产池全局共享、workspace-ref 只是收紧」这条产品决策**——它在 `context-projection.ts:527` 有明确记录
- 接治理账本**不要重构 `asset-service` 的状态机**——账本应旁挂在现有状态变更处
- **不要重做四视图的信息架构**——两次扫描都确认了它的结构是对的
- 不要因为 §1 里写着「已排除」就跳过验证性测试；那是审计结论，不是改动后的保证

---

## 6. 基线与最近合并

新增 3 个 commit，核心是 `133f9005`「feat: version cognition skills and support rollback」（陈万康，约 3600 行），经 `097a4943` / `a506bc76` 合入 develop。**是实打实的推进，不是搬运。**

| 状态 | 条目 | 说明 |
|---|---|---|
| 已修 | Skill 更新候选 diff 正文通道（上次文档 Q8-2） | 新增 `skills/version-diff.ts::diffSkillTrees`，接进 `cognition/skill-summary.ts` 与 `recall/skill-draft-service.ts`，开出 IPC `cognition.skills.diff`，渲染层已能画文件级 diff。**那个「只能显示壳」的二级页现在活了** |
| 已修（部分） | 技能版本库绕开 paths 收口 | 已引入 `userLocalRoot`，残留见 N-16 |
| 改善 | 候选抑制（Skill 升级这一类） | `inbox-adapter` 接入 `bindingIsStale` + `bindingHasDecision`，已追上版本的、以及用户拒绝过的升级不再重复产生待办。通用路径见 N-2 |
| 新能力 | Skill 版本冻结进 Runtime | `RuntimeRunRequest.skill_version_pins`（64 位 manifestHash 校验）+ 建任务时 `ensureSkillRuntimeSnapshot` → worker 执行时 `verifySkillRuntimeSnapshot`。**这条通道证明了 M-1 的修法可行** |
| 新增 | `recall/skill-binding-service.ts` | 资产 ↔ 已安装 Skill 的绑定记录，含 staleness 与决策留痕，7 个真实消费方。新 IPC：`recall.skills.decide`、`cognition.skills.{audit,diff,rollback,rollback.preview}` |

---

## 7. 测试结果

| 基线 | 用例 | 失败 | 结论 |
|---|---|---|---|
| `c476c792`（三笔合并之前） | — | 对照组 | 用 `git worktree` 跑同一批可疑用例，确认哪些是历史红 |
| `00c7b029` | 9202 | 20 | 822 文件。唯一新增回归是 `spawn-command` 的 node PATH 检测（本地 CLI 线） |
| **`a506bc76`（当前）** | **9230 (+28)** | **21 (+1)** | 827 文件（+5，全是新覆盖）。多出的 `messaging-owner-bind-integration` 单独重跑 7/7 全绿，是 flaky |

**其它层**：`typecheck` 通过 · `lint` 仓库不存在该 script · `build` 只有 `package:dev:mac`（发布动作，本次不触发）· `test:resources` 无法运行（见下）。

### 21 条失败的归属 —— 没有一条落在认知资产链路上

- **10 条 · 环境**：`security/scan-gate` ×3、`security/matrix` ×5、`orkas-pkg` ×2。根因是 `rules_source` 回落到 `builtin`——本机 Python 测试环境没配（`venv/` 不存在、system python3 无 pytest，`npm run test:resources` 直接拒跑）。**需先 `npm run test:resources:setup` 再复核，不能凭这个断言线上安全闸有洞**
- **2 条 · 测试桩缺失**：`space_system_prompt_inject`，`buildRunner` 抛 *No model configured*。落在 Workspace 提示词注入线上，建议优先修——它正是验证空间注入的那条用例
- **1 条 · 测试没跟着改**：`cogseed-residual-identifiers` 断言 CLAUDE.md 含 `window.cogseed.{invoke, stream}`，但 CLAUDE.md 已按仓库纪律精简为指针文件
- **1 条 · flaky**：`messaging-owner-bind-integration`（已验证）
- **7 条 · 历史遗留**：`capture-service` nightly 调度、`hub-account` 释放闸、`auto_tasks`、`personal_context-forget`、`conversation-produced-chips`、`builtin-resource-gate`、`spawn-command`。全部在 `c476c792` 基线上同样为红

---

## 8. UI / Interaction Gap 清单（独立维度）

**这一节和 §3 / §4 是两个轴，不要混读。** M/N 问的是「这条链在后端成不成立」；这一节问的是
「页面上每个能点的东西，点下去有没有真实动作，以及它和 v0.9.1 原型差在哪一层」。
一个交互点可以后端完全健康而 UI 缺口很大（如认知树），也可以 UI 完整而后端是空的（如 M-9 绑定）。

**对照基准**：`CogSeed_认知资产用户旅程_交互原型_v0.9.1.html`（12 视图）。

### 8.0 机械扫描结果：没有死控件

对 `skills.js` 发出的全部 `data-{cognition,recall,ability}-*` 钩子与 `skills-bindings.js` 的处理器
做了双向差集，逐个追到 IPC 通道或本地状态：

- **渲染发出但无人处理：0 个**（差集里那批全是 payload 属性，如 `data-recall-asset-version`，
  由同元素上的控件属性在 `.dataset` 里读走）
- **处理器存在但渲染从不发出：2 个** —— `data-recall-capture-retry` 与
  `data-recall-candidate-pool-link`。**都是被取代后的死代码，不是够不到的功能**：重试现在走
  `data-recall-capture-action="retry"`（`skills.js:1204`）。建议清理，无功能影响
- **筛选/展开/选中类控件不发 IPC 是正确的**（`cognition-proof-filter`、`recall-capture-filter`、
  `ability-asset-category` 等），它们只改本地视图状态

**结论：「UI 能点但后端没动作」这类问题在认知资产页当前不存在。** 缺口全部是
「原型要求的交互点还没有」或「有交互点但后端给不出真值」。

### 8.1 按页面（2026-08-17 重做 · 只记当前代码里真实可见的入口）

**这一轮把上一版里"后端有通道所以算 UI 问题"的条目全部剔除了。** 判定改为：
**渲染层有调用方才算 UI 问题**。据此剔除的见 §8.3。

图例：**回流** = 动作成功后重取快照并重画；**二次确认** = 破坏性动作先给影响预览。

| 页面 | 交互点 | 数据来源（真实通道） | 点击有后端动作 | 回流 | 状态完整性 | 与 v0.9.1 差异 |
|---|---|---|---|---|---|---|
| **待我处理** | 需确认/可稍后分级 | `cognition.inbox.list`（无 limit） | — | — | empty ✅ error ✅ **loading ❌** | 原型有「已处理」页签，当前无 |
| | 候选决定 6 动作 | `recall.candidates.{promote,reject,defer,ignore,resume,update}` | ✅ | ✅ | busy ✅ 失败 alert ✅ | 一致 |
| | 批量确认 | `recall.candidates.promoteBatch` | ✅ | ✅ | busy ✅ | 原型无此项（当前更强） |
| | 教学回执撤销 | `recall.teaching.revoke` | ✅ | ✅ | busy ✅ | 一致 |
| | 「教学回执」计数 | `recall.teaching.list {limit:20}` | — | — | — | **>20 条不准**（唯一截断可见数字） |
| **我的资产** | 四类分类筛选 | `cognition.assets.list {limit:500}` | 本地 | — | **loading ❌ error ❌** empty ✅ | >500 静默丢弃，无 total |
| | 资产选中/详情 | 同上（本地状态） | 本地 | — | — | 一致 |
| | 治理动作 | `recall.assets.{pause,resume,revoke,update}` | ✅ | ✅ | busy ✅ 需填原因 ✅ | 一致 |
| | 生成/导入 Skill | `recall.skills.{prepare,confirm}` | ✅ | ✅ | busy ✅ 进行中文案 ✅ | 一致 |
| **使用与证明** | 四层筛选 | 本地（基于 `recall.timeline.list`） | 本地 | — | ✅ 四态齐全 | 当前分层**优于**原型 |
| | 事件选中 | `recall.timeline.list` + `cognition.receipts.list` | 本地 | — | ✅ | 一致 |
| | 效果评价（三档） | `recall.proofs.effectiveness.feedback` | ✅ | ✅ | busy ✅ 六种不可评价说明 ✅ | 一致 |
| | 「带入正确」取证面板 | 同上（带 note + evidenceRefs） | ✅ | ✅ | 必填校验 ✅ | 原型是一键，当前更严（PRD 3.6 要求） |
| | 源Agent→目标Agent | — | — | — | — | **后端无 Agent 对，画不出** |
| **版本与治理** | 资产列表 + 指标 | `cognition.assets.list` | 本地 | — | empty ✅ **loading ❌ error ❌** | 一致 |
| | 版本列表 + diff | `recall.assets.versions` + `cognition.assets.diff` | ✅ | — | busy ✅ | 一致 |
| | 暂停/归档/恢复/回滚 | `recall.assets.*`，动作集按状态生成 | ✅ | ✅ | busy ✅ | 一致 |
| | 删除/撤销/彻底清除 | `recall.assets.{delete,revoke,purge}` | ✅ | ✅ | **二次确认 ✅** | 一致 |
| **管理来源** | 五类来源列表 | `recall.sources.list`，空类也列出 | — | — | **error ✅（独立守卫）** empty ✅ **loading ❌** | 五类与原型**完全一致** |
| | 暂停/恢复/重试/重连 | `recall.sources.{pause,resume,retry,reconnect}` | ✅ | ✅ | busy ✅ | 一致 |
| | 移除来源 | `recall.sources.remove` | ✅ | ✅ | **影响预览 `removeImpact` ✅** | 原型无此保护（当前更强） |
| **沉淀活动** | 五格筛选 | 服务端 `counts` | 本地 | — | **筛选感知空态 ✅** loading ❌ | 一致 |
| | 三种执行时机 | `recall.captures.settings.update` | ✅ | ✅ | disabled（未启用时）✅ | 三种与原型**完全一致** |
| | 任务动作 | `recall.captures.*`，动作集由服务端 `capture.actions` 声明 | ✅ | ✅ | busy ✅ | 一致 |
| | 主动整理历史 | `recall.captures.historicalAutoStart` | ✅ | ✅ | busy ✅ | 一致 |
| **非资产续接** | 快照列表 | `recall.continuation.list`（`{items,total}`） | — | — | ✅ **四态齐全** | 一致 |
| | 展开快照 | `recall.continuation.read` | ✅ | ✅ | 读失败保留列表值 ✅ | 无「更新时间」（后端只有 createdAt） |

### 8.2 UI Gap 表（不含任何 M 类后端问题）

| 号 | 缺口 | 影响页面 | 前端当前表现 | v0.9.1 目标 | 需要改哪一层 |
|---|---|---|---|---|---|
| **G-1** ✅ | **首屏与切页无 loading 态** — **已修** | 五页 | 曾经：先显示页面再取数，body 空白；切 tab 渲染出空态 | 加载中与"真的没有"分开 | 已落地，见下方记录 |
| **G-2** ✅ | 「教学回执」计数截断 — **已修** | 待我处理 | 曾经：`limit:20` 后取 `.length`，>20 不准 | 真值 | `recall.teaching.list` 增 `total`；见下方记录 |
| **G-3** ✅ | 资产列表无 total — **已修** | 我的资产 / 版本与治理 | 曾经：`limit:500`，超出静默丢弃 | 真值或明示截断 | `cognition.assets.list` 增 `total`；见下方记录 |
| **G-4** ✅ | 无「已处理」历史 — **已修** | 待我处理 | 曾经：决定完即消失 | 原型 03「已处理」 | 新增 `cognition.reviewDecisions.list`；见下方记录 |
| **G-5** ✅ | 成功无正反馈 — **已修** | 待我处理 / 使用与证明 / 管理来源 / 沉淀活动 / 我的资产 | 曾经：失败有 alert，成功只靠列表变化 | toast 明确回执 | 已落地，见下方记录 |
| **G-6** ✅ | 缺「空种子」首启页 — **已修** | （新增页） | 曾经：新用户看到四类资产的空列表 | 原型 02 引导页 | 已落地，见下方记录 |
| **G-7** ✅ | 认知树非有机可视化 — **已修** | 认知树 | 曾经：只有卡片式分支 | 原型 01 SVG 树 | 已落地，见下方记录 |
| **G-8** 🔒 | 树上无「芽」 | 认知树 | 候选不在树上 | 原型画 3 个橙色芽点 | **BLOCKED — 缺失字段已逐条列出，见 §8.4** |
| **G-9** ✅ | 一级导航 IA 收敛 — **已定稿并实施** | 全局 | 四个任务视图已就位，但落地会自动跳页 | 默认停待我处理、不跳页 | 见 §8.5 |

**顺序**：~~G-1~~ ✅ → ~~G-5~~ ✅ → ~~G-6~~ ✅ → ~~G-7~~ ✅ → ~~G-2/G-3/G-4~~ ✅ → ~~G-9~~ ✅ →（G-8 🔒 BLOCKED）。

**UI Gap 清单只剩 G-8，且它卡在后端契约而非产品意愿。**

#### G-1 / G-5 落地记录（2026-08-17）

**G-1 加载态**：新增 `_cognitionSnapshotPending()`（`skills.js`），判据是
**「从未加载过 + 正在加载」**而不是单看 `loading`——动作回流和轮询也会把 `loading`
置真，那时页面已有真实内容，再切回骨架会让内容闪一下，比不显示更糟。五页在
host 守卫之后统一插入这一分支。

同时 `initSkillsCognitionConsole` 改为**先画一次再取数**（此前只设可见性，首屏
body 是空白的）。为此把页面分发从 `switchSkillsCognitionPage` 抽成
`_cognitionRenderCurrentPage({ enter })`——`enter` 区分"进入这一页"与"重画"，
只有进入时才触发该页的按需加载（树重投 / 接续快照 / 证明链），否则首屏预渲染
会顺手多打三个请求。

**G-5 成功回执**：新增 `_cognitionNotifyDone(key, fallback)`，补齐候选六种决定、
效果评价、来源开关（pause/resume/retry/reconnect）、沉淀任务动作、教学撤销、
资产 pause/resume/revoke 的成功提示。原本已有 toast 的 7 处（来源移除、资产治理、
回滚、跨域确认、Skill 决定/回滚、批量确认）不动。

两个实现约束值得记下，都是测试逼出来的：

1. **回执不能位于关键路径上**。调用点全在动作的 `try` 块里、回执之后才是
   `loadSkillsCognitionSnapshot()`。helper 一旦抛，异常会被动作自己的 catch 接住
   ——动作其实成功了，界面却既不刷新又弹一句报错。所以 helper 整体包 try/catch，
   且**定义在 `_initSkillsCognitionBindings` 内部**（模块级定义在渲染测试的
   `extractFunction` harness 里不在作用域，会 ReferenceError）。
2. **一次点击只发一条 toast**。个人本体晋升多一步画像刷新，失败时它自己会弹
   「资产已保存，个人画像自动更新未完成」——那句已包含"保存成功"。所以通用回执
   移到画像刷新之后、且只在它没说话时才发；叠两条（成功 + 警告）既吵又自相矛盾。

**测试**：`recall-cognition-flow.test.ts` +15 条——五页 × 加载态/刷新不回退两组
矩阵，候选四种决定的可区分回执，以及"画像刷新失败时不叠第二条 toast"。


#### G-6 落地记录（2026-08-17）

**它是一种状态，不是第五个任务视图。** 四个页各自的空态回答"这一类现在是空的"，
回答不了新用户真正的问题——"我该从哪儿开始"。所以做成独立页 `seed`，只由落地
判定进入，不进 tab 条。

**首启判据 `_cognitionIsFirstRun()`** 取全部五类真实读模型（资产/候选/沉淀任务/
教学信号/待办），任何一类非空都不算首启。两条纪律与 `_cognitionInboxIsEmpty`
一致：**读取失败不算空账户**（把读盘失败显示成"你什么都没有"，用户会以为资产
丢了），**快照未落地也不算**。

**落地路由**：一件东西都没有 → `seed`；只是没有待办 → `assets`。两者不能合并。

**两个入口都落在真实能力上**：
- 「选择历史会话」→ 沉淀活动页（真实通道 `recall.captures.historicalAutoStart` 在那里）
- 「去开始一次任务」→ 复用侧栏既有 `new-chat-btn`，不另起建会话路径

**原型 02 的主按钮「继续最近任务」没有做**：认知资产侧没有"最近任务"这个读模型，
要么去翻会话列表（跨模块），要么编一个。给一个指不准地方的按钮比少一个按钮更糟。
这条是**诚实降级**，不是遗漏。

**测试**：+10 条——首启判定的正例、五类各自非空的反例、读取失败/未落地两种不算
首启、入口只有两个且没有"继续最近任务"、未落地时显示加载态。


#### G-7 落地记录（2026-08-17）

**SVG 概览 + 原有分类卡并存**：只留图，叶子多了点不准也读不全；只留卡片，回不到
"这是一棵树"的整体感。分类卡是真 `<button>`，也是键盘与读屏的完整入口——因此
SVG 叶子可点但**不可聚焦**（`<g>` 加 tabindex 会做出能 Tab 到、按 Enter 没反应的
焦点陷阱）。

**布局确定性**：位置只由 assetType 和该类内下标算出，无随机、无时间戳。否则每次
重画叶子都会跳位置，用户会以为树变了。有用例钉住"同一份数据重画两次完全相同"。

**三处刻意没有照搬原型**（都是"画上去更好看，但后端不认"）：

| 原型 01 有 | 没做 | 理由 |
|---|---|---|
| 枝头 3 个橙色**芽点** | ❌ | 树里没有候选节点（`CognitionTreeNodeId` = `asset:${id}`、`type` 恒为 `'asset'`）。要画只能让渲染层自己把候选摆上去 = 在图上编造后端不认的状态。候选位置由图例说明。**这就是 G-8** |
| 树干**版本年轮 v3** | ❌ | 版本是每个资产各自的（`node.version`），不存在"这棵树的版本"。版本落在每片叶子的 tooltip 里 |
| 只画有资产的枝 | ❌（改为空枝照画） | 四类是后端固定的 assetType，不是"有数据才存在的东西"。光枝如实表达"这一类你还没有"，藏掉会让用户以为系统只有三类 |

**颜色只表达成熟度**一个真实字段，且与图例圆点用**同一个** color-mix 表达式——
图例和叶子对不上颜色，图例等于没有。非 active 状态（暂停/归档）只降透明度不换色：
它是另一个维度，换色会被读成第三档成熟度。

**超出上限给 `+N`**，不静默截断；完整列表在下面的分类卡里。

**测试**：+6 条——成熟度着色与分类卡并存、有候选时树上仍无芽（并断言图例仍说明
候选去向）、树干无聚合版本号、空枝仍画出四类、重画幂等、超限给 +N。


#### G-2 / G-3 / G-4 落地记录（2026-08-17）

**统一契约 `items + total`**，三个读口一致：`total` 是满足查询条件的**真实**条数，
不受 limit 影响。渲染层不再拿 `items.length` 当总数。

| 读口 | 改法 | 为什么这么改 |
|---|---|---|
| `recall.teaching.list` | 新增 `listUserTeachingSignalPage`，抽出共享的 `readSortedTeachingSignals`（读+过滤+排序，不截断），两个出口共用 | total 与 items 必须走**同一套过滤条件**，否则两个数字互相对不上，比没有 total 更难查。旧出口 `listUserTeachingSignals` 行为不变——它还有别的调用方 |
| `cognition.assets.list` | IPC 层不传 limit 取全量、自己 slice，返回 `total: all.length` | 适配器本来就是先建完整数组、最后一步才 slice（`assets-adapter.ts` 末尾），所以 total **不额外付读盘代价**。没有改适配器签名，没有动资产查询主链 |
| `cognition.inbox.list` | 显式返回 `total`（恒等于 `items.length`） | 待办读口本身不截断，但让「items + total」在各读口上是同一个契约，渲染层不必按页记住哪个口有 total |

**G-4 新增 `listRecentReviewDecisions`**：决定账本的存储是**一个 targetRef 一个
jsonl**，既有 `listReviewDecisions` 只能按 targetRef 单读，回答不了"我一共处理过
什么"。新读口扫目录再合并，与 `listContinuationSnapshots` 同一形态——**不为一个
只读视图新建聚合索引**（多一份索引就多一处会和账本失步的状态）。单个账本损坏
只跳过那一个并 warn，其余记录仍是既成事实。文件内沿用原去重口径（同一
`decision_id` 取账本中最后一条，outcome 回填后拿到终态）。

**前端两处诚实降级**：

1. **教学回执被截断时改口径**。后端 `total` 是**全部**教学回执，而指标问的是
   "生效中的"。截断时按 active 过滤算不准，所以此时显示 total 并把标签换成
   「教学回执（全部）」；未截断才按 active 计数。不换标签就是拿全部条数冒充
   生效条数。
2. **资产截断时不给按状态的派生统计**。「全部资产」用真实 total，但「正常使用」
   /「需要关注」只能按本次取回的条目算——给一个只统计了前 500 条的数字，比不给
   更容易让人做错判断。

**已处理历史只渲染账本真有的字段**（决定类型/时间/target_ref/scope/actor/outcome）。
账本里没有候选标题，就显示 `target_ref` 本身，**不去别处凑一个可能已经不存在的
名字**。历史带做成待我处理页里的一条带而不是页签——它和上面两条带是同一个问题的
两面（还需要我决定的 / 我已经决定过的）。空态判定不计入历史：有历史不代表有待办，
算进去「当前无需处理」就永远不会出现。

**测试**：后端 12 条（跨候选合并、倒序、limit/total 分离、outcome 去重、空账本、
重载后仍在）+ 教学 3 条（limit 只截 items、total 与 items 同过滤条件、旧出口不变）
+ 渲染 12 条（两个 total 的 semantic、历史四态、重试入口、只有历史时仍显示空态、
后端没给 total 时退回本次条数）+ E2E 2 条（决定落账后同时重取快照与历史且顺序正确、
历史只来自后端读口）。

**一处旧测试过时**（非回归）：`test/main/ipc/recall.test.ts` 的 teaching mock 只
stub 了 `listUserTeachingSignals`，handler 改走分页出口后 mock 缺函数导致 `ok:false`。
已补 stub，并让 mock 的 `total`(42) 与 `items.length`(0) **故意不等**——否则用例分不出
实现是真读了 total，还是又拿 items.length 顶替。


### 8.4 G-8 · BLOCKED by cognition tree contract v2

**结论：BLOCKED。不是"先做个效果"，是当前契约无法支撑，前端不得自行推断。**

已按当前代码逐条核验（`recall/tree-service.ts`）：

| 事实 | 位置 |
|---|---|
| 节点 id 类型是 `` `asset:${string}` `` ——**没有候选 id 的位置** | `tree-service.ts:10` |
| 节点 `type` 是字面量 `'asset'`，不是联合类型 | `tree-service.ts:19` |
| `rebuildCognitionTree` **只读 `listAbilityAssets`**，候选池根本没进来 | `tree-service.ts:112` |
| 边只有 `type: 'asset_relation'`，两端都必须是资产节点 | `tree-service.ts:27-32` |

**契约 v2 必须补齐、当前一条都没有的语义：**

1. **节点身份**：候选的稳定 node id 与 `CognitionTreeNodeId` 的联合类型（如 `` `candidate:${string}` ``），以及 `type: 'asset' | 'candidate'`。
2. **候选 ↔ 资产的挂载关系**：候选挂在哪个节点上。`RecallCandidateRecord.targetAssetId` 只在"更新既有资产"的候选上有值，**新增类候选没有父节点**——树上无处可挂。缺一条 `attachedTo` / `parentNodeId` 的明确定义，以及"没有父节点的候选挂哪里"的规则。
3. **芽的显示规则**：哪些 `RecallCandidateStatus` 该显示为芽（`pending_review`？`failed`？被 `isCandidateSuppressed` 抑制的呢？），由后端判定而不是渲染层猜。
4. **候选的生命周期投影**：芽没有 `maturity`（那是资产字段），需要定义芽自己的状态如何映射到视觉。
5. **状态变化后的更新语义**：候选 promote 成资产后，芽→叶是同一节点变形还是删一个建一个？决定渲染层能不能做增量更新，也决定 id 是否要稳定跨越这次转变。
6. **`COGNITION_TREE_CONTRACT_VERSION` 需从 1 升到 2**，并给出旧读者的降级行为。

**前端本轮明确没有做**：不按标题/分类/关键词猜父节点，不额外落一份前端映射状态，
不新增假的挂载关系。现有认知树能力（SVG 概览 + 分类卡 + 关系列表）全部保留。
候选的位置仍由图例说明，并有用例钉住"即使 state 里有候选，SVG 内也不得出现它们"
（`recall-cognition-flow.test.ts` · 「即使有待确认候选，也不在树上画芽」）。

### 8.5 G-9 落地记录（2026-08-17）

**产品决策已定稿**：一级只有四个**任务视图**——待我处理 / 我的资产 / 使用与证明 /
版本与治理。四类资产（关于我 / 规则与偏好 / 模板与范例 / 技能与方法）是**分类**，
留在「我的资产」内部，不升一级。总览页不恢复。管理来源与沉淀活动是页头辅助入口。

**核查结果：IA 骨架此前已经就位**（四 tab + 两辅助入口 + 六条旧路由别名），
本轮真正要改的只有一处——**落地自动跳页**：

| 项 | 改前 | 改后 |
|---|---|---|
| 默认落地 | 待我处理 | 待我处理（不变） |
| 待办为空 | **静默** `switchSkillsCognitionPage('assets')` | 停在原地，空态给**显式**「去看我的资产」按钮 |
| 一件东西都没有 | **静默**切到独立 `seed` 页 | 停在原地，空态渲染首启引导 |

理由：用户点进认知资产，看到的必须是自己点的那一页。静默跳走之后，他既不知道
被跳了，也分不清"真的没事"和"页面坏了"。

**连带清理**：独立 `seed` 页在取消跳转后**没有任何入口**了。留着就是死路由，
已连同 HTML 容器、路由注册、render 函数一并删除；引导内容抽成
`_cognitionSeedMarkup()`，由「待我处理」空态复用。**可达性脚本已验证：
注册页面 10 个，死页面 0，孤立 HTML 容器 0。**

**顺带修掉一个真实语义缺陷**：`_cognitionIsFirstRun()` 此前不看处理历史——
用户把候选全拒了、或把资产都删了，手里确实是空的，却会被告知"你的认知种子已经
准备好"。现在有处理历史即不算首启（历史未读回时不据此判断，避免首屏闪引导页）。

### 8.3 上一版列过、这次剔除的（渲染层无调用方，不算 UI 问题）

| 曾列为 | 剔除理由（已逐条 grep 验证） |
|---|---|
| M-8「两个 accept 语义不同」在 UI 上会误导 | `cognition.candidates.{list,decide}` **渲染层零调用方**；`actionsForCandidate` 对 `personal_ontology` **从不返回 `accept`**（`normalize.ts:28` 只给 `open_personal_ontology` + `import_to_recall`），且这两个动作本身也从未被渲染（其 i18n 键是孤儿）。UI 上不存在两个同形 accept |
| M-9「绑定后不生效」是假状态 | `spaces.assets.bind` **渲染层零调用方**。空间「资产」tab 读的是 `recall.assets.listForSpace`、撤销走 `recall.assets.revoke`，**整条都在 recall 路径上**。用户在 UI 上根本做不出那个绑定动作 |
| — | ⚠️ `workspace.js:197` 的注释仍写着「资产 = asset_reference_bindings（listSpaceAssetBindings）」，与 182 行的实际实现不符——**M-9 的原始误判很可能来自这行注释**。已在本轮修正 |

**结论**：M-8 / M-9 应从 §3 的 B 类（前端显示假状态）降级为**非阻塞的死通道 + 命名空间问题**，
它们不产生任何用户可见的假状态。§3 的 B 类因此清空。

---

## 附 · 真实存储地图

跨 store 对齐键只有 `assetId` + `version`。**资产本身没有 content hash**——唯一的内容哈希是 `agent_inheritance.inheritedAssetContentHash`（sha256 前 32 位，覆盖 type/title/statement/scope/version），只服务于出生继承的漂移检测。`space.asset_reference_bindings.content_hash` 字段存在但从未被计算填入。

| 路径 | 内容 |
|---|---|
| `cloud/recall/records/` | candidates · ability-assets · projections · transfer-proofs · effectiveness-proofs · workspace-refs · captures · teaching · skill-bindings · usage-records/events.jsonl |
| `cloud/kstar/` | episodes · reviews · tasks · requirements · task-states · extraction-runs |
| `cloud/mate_agent/` | review-decisions · skill-lifecycle · tasks · sessions · execution-records · **asset-events（空，N-1）** · **audit-receipts（空，N-1）** · **capability-packs（空，M-2）** |
| `cloud/cognition/` | 遗留 CognitionAsset store（seed/sprout/growing/bright，N-7） |
| `cloud/spaces/<sid>/` | space.json 内嵌 `asset_reference_bindings`（M-9） |
| `cloud/chats/<cid>/` · `cloud/projects/<pid>/chats/<cid>/` | `continuation-snapshot.json` —— 任务接续快照（**非资产**，不进四类资产与认知树）。无聚合索引，`listContinuationSnapshots` 扫会话列表逐个读 |
| `local/kstar/executions/<id>/` | record.json · events.jsonl · **context-reuse-receipt.json**（M-7） |
| `local/skills/versions/` + `local/kstar/versions/` | 技能版本（后者为 legacy 回退路径） |

**注册表**：不存在统一索引。每个 store 各自 `fs.readdir` 扫目录（`listAbilityAssets` · `listTransferProofs` · `listEffectivenessProofs` · `listReceipts` · `listContextProjections`）。当前规模下不是问题，记在这里是为了将来资产量上去时知道瓶颈在哪。

---

## 本文档的边界

所有结论来自当前工作区代码与已执行的测试。凡产品文档或 PRD 描述而代码中不存在的能力，一律记在问题里，未计入「当前实现」。

审计方法：全仓符号级 `rg` 交叉核对调用方（排除 `node_modules / dist / vendor` 与文档）；上一份《认知资产模块现状梳理》（基线 `dev/shiyuxuan-cognition-assets-converge @ 17c4cd22`）的每条结论在当前 HEAD 上重新复验并更新状态；测试对比用临时 `git worktree` 跑对照组（已清理）。

审计范围：`src/main/features/{recall,cognition,kstar,p3394,p3394_bridge,cogseed_backend,cogseed_runtime,group_chat,spaces,skills,session_import,agent_inheritance}`、`src/main/ipc/`、`src/renderer/modules/{skills,skills-bindings,workspace,spaces,cognition}`、`packages/`。
