# 交接文档：Commander-Centric KStar 功能模块说明（受保护）

- 日期：2026-08-17
- 合入：`c0153fad`（Merge branch 'codex/commander-centric-kstar' into 'develop'）
- 状态：受保护实现规范——以下模块/能力是本线交付的完整闭环，后续修改不得删除、覆盖、降级或绕过
- 一句话交接：**Commander 是唯一 LLM、世界模型宿主侧预测、注入按适合度而非成熟度、沉淀走单路径、证明以回执为准、语言硬闸防污染**——这六条是产品决策，不是实现细节。

---

## 0. 给后续开发者 / AI 的最高优先级指令

修改本线任何文件前，必须先阅读本文档。

### 0.1 禁止事项

除非有明确的新产品决策和对应迁移方案，否则禁止：

- 给 Commander 重新暴露 `kstar_control` 工具（世界模型预测已收归宿主侧）。
- 把注入依据改回「按成熟度/置信度门槛」——产品决定是**按适合度（fitness）注入**，seed 资产可被任务召回，未验证状态由注入时的提示块标注诚实呈现。
- 恢复「提交投影冻结清单作为迁移证明的资产事实」——证明必须**以 ContextReuseReceipt 为准**（真实加载的资产才升档）。
- 把证明的覆盖判定从「回执并集覆盖」改回「单张回执全覆盖」——多回合分散注入会永不升档。
- 把规则边界判定从「适用或禁止任一存在即算有边界」收紧为「两者都必须存在」——KStar 聚合刻意只声明有证据支撑的 applicableWhen，实机全部 rule 资产为单边界，收紧即整条 KStar rule 沉淀被系统线阻断。
- 恢复 KStar 双沉淀路径（drain 候选产出 + requirement 级并存）——已收口为**单路径**，drain 只做任务/会话关闭。
- 删除语言硬闸（中文任务产出英文 lesson 的确定性拦截）——模型会无视软约束提示词（实机两次污染），必须保留确定性判定。
- 用 `review.reason`（诊断文本）充当沉淀 judgment——缺口候选必须有推理出的 lesson，诊断文本宁可不产。
- 恢复「会话自动抽取线的弱判断」/ 让 KStar 沉淀伪装成 capture 线来源（lifecycleStatus 必须区分 system_precipitated_unverified 与 automatically_extracted_unverified）。
- 对下列关键字文件在 merge 冲突中整体使用 ours 或 theirs。

### 0.2 本线交付的产品决策（不得视为可优化细节）

1. **Commander-Centric**：Commander 是唯一 LLM；Agent/Worker 不消费自动注入，只接受 Commander 显式 dispatch 的资产。
2. **世界模型宿主侧预测**：auto-forecast 生成预测（含 forecastId/projectionId），Commander 不再提交 forecast。
3. **适合度注入**：seed 资产可被任务召回；成熟度只是信任显示，不是注入门槛。
4. **回执闭环（PRD 3.6）**：投影/派发注入真实发生时落 ContextReuseReceipt（key `turn-<turnId>`），终态事件带 `reuse_turn_ids`，迁移证明以回执为准升档。
5. **沉淀单路径**：KStar 候选统一走 requirement 级聚合（task-level-precipitation），drain 不产候选。
6. **语言硬闸**：lesson 与任务主导脚本不匹配 → 出生点丢弃 + 消费方防御，英文经验（中文任务）绝不进池。

---

## 1. 功能模块清单（本线交付）

### 1.1 KStar 世界模型与闭环（src/main/features/kstar/）

| 文件 | 职责 | 关键契约 |
|---|---|---|
| `auto-forecast.ts` | 世界模型预测生成（宿主侧，独立 runner） | 通过共享 `model/core-agent/runner` 预测（非独立 dispatch 路径）；失败只告警不阻断执行 |
| `forecast-commit.ts` | 宿主提交 forecast 到 requirement | projectionId/forecastId 关联 |
| `projection-decision-service.ts` | 投影决策（确认/拒绝） | 只宿主调用 |
| `task-closure.ts` | 任务终态闭环：build episode → review 推理 → 标记 extraction run | `finishClosure` 只写 episode+review **不产候选**（沉淀在任务级边界）；`scheduleAutoClose` 静默窗口 30min（completed/cancelled 都调度）；`startGroupKstarClosure` 订阅 TaskTerminalEvent |
| `task-level-precipitation.ts` | **requirement 级聚合沉淀（唯一 KStar 沉淀路径）** | `aggregateRequirementProposals`：合并工具链/证据、取最强信号；`clearsPrecipitationGate` 四路门控（ΔR≥0.15/明确偏离/命名缺口/lesson+conf≥0.7）；语言硬闸 `lessonUsable`；proposals ≤3 |
| `extraction-service.ts` | lesson 整理：标题提炼/作用域/缺口类型/门控 | `lessonTitleCore`（去模板前缀、40 字截断）、`scopeForTask`（report/code/review/product/general）、`gapType`、`clearsPrecipitationGate`、`proposeKstarCandidates`（episode 级，含语言硬闸防御） |
| `review-inference.ts` | review 模型推理（后台独立 runner，不占 Commander 队列） | 确定性 reconcileWorldModel 度量 ΔR/ΔA；模型只归因+提炼 lesson；**语言硬闸出生点**：主导脚本不匹配直接丢弃 lesson（warn 日志）；提示词含 HARD RULE language |
| `review-service.ts` | review 存取 | |
| `direct-experience-assets.ts` | 统一候选池入口 | `proposalToCandidateInput`：**judgment=value**（两条沉淀路径指纹统一），`suggestedAction:'create'` 显式，`captureKey=kstar-<req>-<i>` 幂等，带 spaceId |
| `recall-bridge.ts` | drain 路径桥（已收口不产候选） | 保留函数兼容签名 |
| `task-aggregate.ts` | **已收口**：`drainKstarTaskState` 只做任务/会话关闭 | proposals/candidates 恒空；proposalFromRequirement/dedupeProposals 已删除 |
| `task-intent.ts` | 任务意图提示（advisory，不写状态） | |
| `requirement-closure.ts` | requirement 关闭（prmReview/aar） | candidateSeed=reason 仅存 aar 元数据，**不参与沉淀** |

### 1.2 Recall 注入与证明（src/main/features/recall/）

| 文件 | 职责 | 关键契约 |
|---|---|---|
| `context-projection.ts` | 投影/语义排序 | `DEFAULT_MIN_MATCH_SCORE = 0.40`（实机校准：0.25 太松，0.34-0.38 弱匹配污染）；`DEFAULT_RELATIVE_SIGNIFICANCE = 0.5`；`rankAssetsBySemanticMatch`（bge-small-zh-v1.5，512 维） |
| `prompt-injection.ts` | Commander 注入构建 | `buildRecallTurnPromptContext`：committedProjectionId 优先，否则自动投影；快照优先于 live（版本冻结）；citation 带 matchScore |
| `formal-assets/runtime.ts` | 运行时准入（适合度注入） | `evaluateAssetRuntimeEligibility`：status/scope/forbidden/applicable/targetAgents/sensitivity + **无成熟度硬门槛**（seed 可注入）；`not_applicable_context`/`scope_mismatch` 保留 |
| `formal-assets/policy.ts` | 策略唯一真相源 | `maturityForTransferOutcome`（succeeded→transfer_validated）、`allowsSilentDefaultInjection` |
| `candidate-service.ts` | 统一候选池 + 晋升出口 | 指纹去重（judgment\|value\|type\|scope\|action\|target）；`reviewReady`；`autoApplyRecallCandidate`（语义查重默认开，**embedding 不可用抛 SemanticDedupUnavailableError 宁可停**）；`superseded` 状态补全（读时兼容，chen 新写入用 ignored） |
| `capture-value-screening.ts` | 候选分类/质量判定 | **规则边界 hasBoundary = applicableWhen 或 forbiddenWhen 任一存在（`||`，2026-08-17 从 && 改回）** |
| `similarity.ts` | 语义查重/质量融合 | `SEMANTIC_DUP_THRESHOLD=0.85`、`SEMANTIC_RELATED=0.70`、`QUALITY_GAP=0.10`；degraded ≠ no_match |
| `terminal-proof.ts` | 终态迁移证明（**以回执为准**） | `collectLoadedAssetsFromReceipts`（boundary='real' 过滤）；`findReceiptCoveringAssets`（**并集覆盖**，多回执分散注入可升档）；assetVersions=existing（回执资产），投影只作治理记录 |
| `proof-service.ts` | 证明存取/升档 | `prepareTransferProof` 支持 assetIds 覆盖；`receiptProvesTransfer`（合法回执+至少覆盖一个，并集由宿主判定）；`completeTransferProofWithReceipt` 仅宿主调用 |
| `asset-reference.ts` | 回执引用解析 | `parseAbilityAssetReference`（asset:aa@v2:reason）、`abilityAssetReferencesCover` |
| `source-removal.ts` / `conversation-message-policy.ts` / `timeline-service.ts` | develop 侧能力（保留） | 不影响本线契约 |

### 1.3 语言硬闸（src/main/util/language.ts）

```
dominantScript(text): 'cjk' | 'latin' | 'none'   — CJK/Latin 字符占比判定
lessonLanguageMismatches(task, lesson): boolean  — 主导脚本不同 → true
  边界：混合 lesson（中文主导）放行；无法判定不拦截
  生效点：review-inference（出生点） + extraction-service + task-level-precipitation（消费方）
```

---

## 2. 与 v0.7 四视图的边界（spec(3) 协同）

- 本线交付的是**后端能力 + 数据契约**；四视图（待我处理/我的资产/使用与证明/版本与治理）是 renderer 层，由 v0.7 线交付。
- 交叉点（renderer 调用本线 IPC）：`recall.candidates.list`、`cognition.inbox.list`、`recall.tree.read`、transfer-proofs 读取、`cognition.assets.list`——这些 IPC 契约由本线保证，renderer 不得改为静态展示。
- 四视图中的「传递已证明/效果已验证」语义由本线 `terminal-proof`/`effectiveness-proof` 数据驱动，不得合并为单一「已使用」。

---

## 3. Merge 冲突处理规则（本线关键字）

涉及以下文件的冲突必须逐块语义合并，禁止整体 ours/theirs：

```
src/main/features/kstar/           （auto-forecast / task-closure / task-level-precipitation /
                                     extraction-service / review-inference / direct-experience-assets /
                                     recall-bridge / task-aggregate / requirement-closure）
src/main/features/recall/          （context-projection / prompt-injection / candidate-service /
                                     capture-value-screening / terminal-proof / proof-service /
                                     formal-assets/{runtime,policy} / similarity / asset-reference）
src/main/util/language.ts
src/main/features/group_chat/bus.ts   （receipt 创建 / reuseTurnIds / Commander 注入 / dispatch 准入）
```

每个冲突块判断：ours 加了什么能力、theirs 加了什么、能否同时保留、是否破坏上述产品决策。

---

## 4. 验收：什么算「功能完好」

以真实链路为准，不接受仅 DOM/页面/toast 存在作为完成：

1. **注入**：任务开始，Commander 提示块含资产引用（citation 带 matchScore ≥0.40），seed 资产可被召回。
2. **沉淀**：任务闭环（finish/切换/30min 静默）→ requirement 级聚合 → 候选池恰 1 条/任务（无双写）→ 系统线晋升成资产（lifecycleStatus=system_precipitated_unverified，maturity=seed）。
3. **语言**：中文任务绝不产出英文 lesson（日志可见 "lesson dropped for language mismatch" 为正常拦截信号）。
4. **证明**：注入回合落 receipt（`turn-<turnId>`）→ 终态事件带 reuse_turn_ids → proof succeeded + receiptId → 资产 maturity=transfer_validated。
5. **幂等**：同任务重复闭环不产生重复资产/候选（指纹 + captureKey 幂等）。

---

## 5. 已知边界（可后续演进，但需先确认）

- `committedProjectionId` 管线存在但当前无生产调用方（注入走自动投影）；若未来要让世界模型投影直接驱动注入，需补接线并复核 0.40 阈值语义。
- 语义查重 embedding 不可用 → 自动晋升中止（degraded 抛错留池）——保守设计，需产品确认是否允许 capture 线降级。
- 聚合 proposals 上限 3（实际最多 2 条：strongest 二选一 + gap）——防御性上限，加分支时注意。
- 实机 rule 资产全部单边界（applicableWhen 或 forbiddenWhen 其一）——若产品要双向边界，需同时改 KStar 聚合与迁移存量资产，不能只收紧判定。

---

## 6. 测试基线

- 本线测试：`test/main/features/recall/`、`test/main/features/kstar/`、`test/main/features/recall/fitness-receipt-closure-scenario.test.ts`（4 场景端到端）、`test/main/util/language.test.ts`、`test/static/kstar-single-core.test.ts`。
- embedding 测试用确定性哈希 mock（不依赖 ONNX 模型）。
- 运行：`node scripts/run-tests.mjs run test/main/features/recall/ test/main/features/kstar/`
- 已知 develop 上游固有失败（非本线）：renderer 8 文件 44 测试（纯 develop 基线一致）。

---

## 7. 给 AI 的最终提醒

本线已形成完整闭环：**世界模型预测 → 适合度注入 → 回执证明 → 单路径沉淀 → 语言硬闸**。
后续任务默认是增量修改、能力融合、缺口补齐，不是重新设计。
当新需求/develop 改动/重构与本文档冲突时：先停止删除或覆盖，列出冲突，保留双方有效能力，优先兼容式增量实现；必须改变核心能力时先由产品负责人明确拍板。
