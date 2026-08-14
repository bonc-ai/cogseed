# KStar 闭环重新梳理：期望流程 × 当前实现 × 黑盒清单

**日期：** 2026-08-15
**基线：** `codex/commander-centric-kstar` @ `f5453e22`
**目的：** 按用户重述的闭环逐段对照现状，标出"已有 / 部分 / 黑盒（需定夺或开发）"。

## 1. 期望闭环（用户重述，逐段）

1. 用户发消息 → Commander 接收 → **路由**：普通信息直接回复；有意义类进入 KStar。
2. KStar 消息再分：**旧任务的新需求** or **新任务的新需求**。
3. 新任务新需求：整理**旧任务所有差异 r** → 演化沉淀为可复用资产。
4. 建立**新 task 容器** → 按需求**抓取所需资产**（**取消用户确认候选资产**）→ 注入上下文 = **S**。
5. **世界模型**基于 S（本体 + 其他三类资产 + 上下文）→ **预测 R 和 A**。
6. **真实执行** → 实际结果 vs 预期 R → **差异 r 保留** → 反复直到任务完成。
7. 任务完成：**所有差异 r + 上下文整理**，按差异 r 原因与闭环过程 → 可复用资产 → **传递到能力资产**。

## 2. 逐段对照

| # | 期望步骤 | 当前实现 | 状态 | 关键证据 |
|---|---|---|---|---|
| 1a | 路由：普通 vs 任务 | 无显式路由；Commander 不调 `kstar_control` = 普通会话（模型驱动） | ✅ 已有（隐式） | `control-tool.ts`；`kstar-commander-centric.test.ts` |
| 1b | 路由：旧任务新需求 vs 新任务新需求 | 工具语义隐式表达：`requirement:create`（同 task 新需求）/ `task:create`（新任务） | ⚠️ 部分 | `control-service.upsertState` |
| 2 | 新任务新需求：整理旧任务差异 r → 沉淀 | 沉淀在**单次闭环**（terminal → review → proposals → 直接资产）触发；**新任务起点无"旧任务整理"步骤** | ❌ 黑盒 B2 | `task-closure.reconcileKstarExtraction` |
| 3 | 新建 task 容器 | `task:create` 仅在**无开放任务**时允许；开放任务存在时被拒（`an open KStar Task already exists`）→ 必须先 finish/abandon | ❌ 黑盒 B2 | `control-service.ts` upsertState |
| 4a | 按需求抓取资产 | `request_projection → previewContextProjection(buildRecallView)`：资格过滤 + 语义排序 + 投影卡片 | ✅ 已有 | `context-projection.ts` |
| 4b | **取消用户确认候选资产** | 投影必须用户确认（preview→confirmed）才注入/执行；卡片、确认 IPC、审批恢复、派发守卫全部依赖确认态 | ❌ 黑盒 B3（**最大的设计变更**） | 阶段 3/4/6 全链 |
| 4c | 注入上下文 = S | 注入到 Commander system prompt（块 `<confirmed-ability-assets>`）；自动投影路径已存在 | ✅ 已有（G6：system 段） | `prompt-injection.ts`、`bus.ts:3812` |
| 5a | 世界模型预测 R 和 A | **Commander 即世界模型**：`commit_forecast` 提交 2–4 候选（aHat=plan/expectedTools/expectedActors，rHat=predictedResult），宿主校验+重算+选优；独立 world-model runner 已在 Task 7 删除 | ✅ 已有（形态需定夺） | `forecast-commit.ts`、`world-model-scoring.ts` |
| 5b | S = 本体 + 其他三类资产 + 上下文 | S 只含投影资产（abilityAssets 四类）+ 规则 + 环境/生命周期摘要；**本体（personal ontology）未纳入** | ❌ 黑盒 B4 | `forecast-commit.ts` simulationInput |
| 6a | 真实执行 | 派发守卫（已确认投影 + forecastId）→ Agent 执行 → Episode 捕获 actual | ✅ 已有 | `guardKstarPrivilegedDispatch` |
| 6b | 实际 vs 预期 R → 差异 r 保留 | 每 episode 一条 review（deltaR/deltaA/outcome/attribution）落盘 | ✅ 已有（单轮） | `review-inference.ts` |
| 6c | **反复直到完成：多轮差异 r 聚合** | **沉淀只取 `requirement.episodeIds.at(-1)`（最后一个 episode）**；任务级差异 r 集合不存在 | ❌ 黑盒 B5 | `task-aggregate.proposalFromRequirement` |
| 7 | 完成：所有差异 r + 上下文整理 → 可复用资产 → 能力资产 | 直接沉淀线已通（`f5453e22`），但按"单 episode 证据"沉淀，非"任务级聚合证据"；候选审核线保留 | ⚠️ 部分（任务级聚合缺失） | `direct-experience-assets.ts` |

## 3. 黑盒清单（需定夺 / 需开发）

### B1（定夺）消息路由的显式化程度
- 现状：普通/任务由模型是否调用 `kstar_control` 隐式决定（寒暄零写入已固化）；旧/新需求由工具操作语义表达。
- 定夺点：是否需要**显式意图词汇**（如 `none / continue / new_requirement / new_task` 回传），还是保持"无调用=普通"的隐式路由？推荐：**保持隐式路由**（已证明可靠、少一次模型往返），但把"旧任务新需求 vs 新任务新需求"做成工具侧的显式操作选择（B2 一并解决）。

### B2（开发）新任务容器切换 + 旧任务差异 r 整理（当前被阻塞）
- 现状：开放任务存在时 `task:create` 被拒；必须先 finish/abandon。
- 需要：`upsert_state` 增加**显式"开新任务"语义**——Commander 声明 `task:create` 且存在开放任务时，宿主自动执行"旧任务收尾"：① 标记旧 requirement/task 关闭（topic_switch 语义）；② **触发旧任务差异 r 整理与沉淀**（B5/B7）；③ 创建新 task 容器（新 requirement、新投影、新 S）。
- 定夺点：旧任务"未确认复盘"就直接关（用户没点确认）是否允许沉淀？推荐：允许——差异 r 与复盘已落盘（unclear 也保留），沉淀按证据门槛执行（与直连线一致）。

### B3（✅ Q1 已定夺并实现 `245cf20a`）取消资产确认后的自动注入
- 现状全链依赖用户确认：preview 卡片 → `confirmContextProjection` → 注入只读 confirmed → 派发守卫要求 confirmed + forecastId → 审批恢复续接同一会话。
- 需要定夺：
  1. **自动确认形态**：投影创建即 `confirmed`（`authorization:'workspace_policy'` 字段**从未被消费**，正好可启用）；或保留 preview 但自动 confirm（幂等）。
  2. **自动注入哪些资产**：全量资格通过资产按语义排序取 Top-N（需要引入**相关度阈值**，顺带关掉 G7）？还是全部？推荐：Top-N（如 8）+ 阈值。
  3. **用户知情权**：不确认但仍应**可见**（回答末尾回执/卡片只读展示"本次使用了哪些资产"，顺带实现 G10 的注入回执）。
  4. **派发守卫**：自动确认后守卫自动通过；**wake 审批是否保留**？（推荐保留——它是"是否执行 Agent"的授权，与"用哪些知识"不同层）。
  5. **回滚/纠错**：资产注入错了怎么办（负反馈 → 推荐/暂停已存在）。
- 连带影响：投影状态机（preview/confirmed 语义）、审批恢复服务（阶段 4 变简单：无需续接确认）、IPC 卡片链路可保留为只读。

### B4（定夺）世界模型形态 + 本体入 S
- 现状：Commander 即世界模型（Task 7 已删独立 runner，静态测试固化）。推荐：**保持**（单一认知 actor 是本次改造的核心决策）。
- 定夺点：S 是否纳入**本体（personal ontology）资产**作为预测输入？推荐：纳入——本体属于用户稳定偏好/事实，与 rule/template/skill_method 并列注入冻结知识 K（`loadCommittedProjectionKnowledge` 扩展 ontologyRefs）。

### B5（开发，核心缺口）任务级差异 r 聚合
- 现状：每 episode 一条 review；沉淀只看最后一个 episode。
- 需要：任务级聚合层——收集 requirement 全部 `episodeIds` 的 reviews：① 差异 r 集合（deltaR/deltaA 序列）；② 归因聚合（哪些原因反复出现：execution_gap/rule_gap/…）；③ 上下文整理（goalText + 各轮 finalText + producedFiles 汇总）；④ 聚合后生成**任务级 proposals**（复用 `proposeKstarCandidates` 的判定，但证据为全任务）→ 直连沉淀一次。
- 触发时机：任务关闭（finish）与新任务切换（B2）都触发；幂等（按 taskId 聚合运行记录）。

### B6（定夺）迭代检查点的显式化
- 现状：每次派发=一个 episode=一次 review，循环天然存在（用户继续发消息）。
- 定夺点：是否需要"任务内迭代记录"（每轮差异 r 显式挂到 task 而非仅 requirement.episodeIds）？推荐：**不需要新对象**——episode/review 已承担；B5 聚合层从现有记录推导即可。

### B7（定夺）"演化"的定义与触发时机
- 现状：直接资产 maturity `seed → bud → transfer_validated → effectiveness_validated`（由 usage/proof/feedback 驱动）；独立 `features/evolution` 服务存在但未接入本闭环。
- 定夺点：演化 = maturity 阶梯（推荐，已实现）还是引入 evolution 服务重算？沉淀时机 = 闭环节点（现状）还是"新任务起点整理旧任务"（B2）？推荐：**两者都跑**——finish 时沉淀 + 新任务切换时对未沉淀的旧任务补沉淀（幂等）。

## 4. 建议的实施顺序

1. **B3 先定夺**（取消确认是产品级方向变更，影响面最大：投影状态机、守卫、IPC、UI）。
2. **B2 + B5 + B7 一个批次**（新任务切换 = 旧任务收尾沉淀；任务级差异 r 聚合是沉淀质量的根基）。
3. **B4 本体入 S**（小改动，扩展冻结知识来源）。
4. **B1 保持隐式路由**（不开发，仅文档确认）。
5. 顺带关闭 G7（相关度阈值，B3-2 需要）。

## 5. 待你定夺的问题（汇总）

- Q1 ✅ 已执行：`workspace_policy` 自动确认（投影创建即 confirmed，`request_projection` 返回 `projection_confirmed`）+ 语义 Top-N（默认阈值 0.35、上限 8，低分资产记 `low_relevance`）+ 只读回执（`recall_citations` 随回复展示、usage 落盘，G7/G10 关闭）。
- Q2 ✅ 已定夺：wake 审批保留（Agent 执行授权层，与知识选择不同层）。
- Q3 ✅ 已定（用户授权按推荐执行）：**Commander 即世界模型**——Forecast 候选由 Commander 生成（aHat=plan/expectedTools/expectedActors，rHat=predictedResult），宿主 `forecast-commit` 校验+重算+确定性选优；不另建独立预测器（与 Task 7 删除独立 runner 一致，静态测试固化）。
- Q4 本体资产是否纳入 S/K 冻结知识（推荐纳入）？
- Q5 旧任务收尾时"未确认复盘也允许沉淀"（推荐允许，按证据门槛）？
- Q6 新任务切换是否自动触发旧任务差异 r 整理沉淀（推荐自动，幂等）？
