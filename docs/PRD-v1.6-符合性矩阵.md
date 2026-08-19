# PRD v1.6 实现符合性矩阵

- **适用仓库**：CogSeed desktop `dev/fengjw-KSTAR`（同步至 `origin/develop` @ `01fbd2ed`）
- **核对依据**：`P3394_CogSeed_PRD_doc-v1.6_Review.docx`（4398 行）
- **核对日期**：2026-08-17
- **实证基线**：核心领域测试套件 `node scripts/run-tests.mjs run test/main/features/recall test/main/features/cognition test/main/features/kstar test/main/features/p3394` → **155 files / 1264 tests 全绿**
- **状态定义**：
  - **已实现**：有明确代码/IPC通道/测试证据，满足验收。
  - **部分实现**：核心已落地，但覆盖/字段/链路不全。
  - **未实现**：无可验证实现（含 feature-flag 关闭且无消费的占位）。
- **重要边界**：PRD 明确「Review - staged候选」，不代表能力已实现；本矩阵以**代码真实状态**为准。

---

## 0. 总体结论

- **8月19日 Must 的「复用证明」主链路已真实成立且有测试**：已确认候选 → 最小能力包 → 目标 Agent 隔离真实加载（CLI `boundary=real`）→ 首个 Action Plan → ContextReuseReceipt → `transfer_validated` 升档。核心底座（五类来源、四类正式资产、统一候选管道、晋升三闸门、单账本、认知树）全部落地。
- **差异化契约大半停在概念层**：KSTAR Gate A/B、关系断言、三来源契约、Skill 主动生命周期的更新/暂不更新决策链等为 Sprint 3/4 待办，非已交付。
- **全部 Later 项**（社区、Blueprint、企业联邦、发布隐私检查）符合 PRD 预期未实现，但有可复用雏形。

**Feature-Flag 快照**（`src/main/features/p3394/flags.ts`）：`skilllifecycle=true`；`rolecomposition/snapshot/relationship/nightly/realtime/blueprint/federation/community/gateb` **全部默认 false**（flags.ts 外零消费，纯占位）。

---

## 1. FR-ONB 极简启动与连接

| ID | 需求 | 状态 | 证据 | 差距 |
|---|---|---|---|---|
| FR-ONB-01 | 无账号创建本地空间，首启无注册墙 | 已实现 | `users.ts:392-410` `initActiveUser` 首启 `genUserId()`；`onboarding.js:230`"无需CogSeed账号即可开始"；`prefs.getOnboarding` | 无 |
| FR-ONB-02 | 首条链路不要求手工API Key，不接收凭证 | 已实现 | `ipc/index.ts:3596-3614` `cognition.extractFromSession` 走本机已检测 CLI Agent；`onboarding.js:244`"不会接收登录凭证" | 有可选「连接并存储API」分支，但存本机加密库不上传；默认链路无需 Key |
| FR-ONB-03 | 首屏三个价值动作+全局自然语言输入 | 部分实现 | `onboarding.js:283-311` 分流卡（继续/选会话/空白任务）、`:275`"不用先认识资产" | 首屏为点击式向导，**无自然语言输入框**；Commander 输入在引导完成后才可见 |
| FR-ONB-04 | 首次任务在临时任务空间运行 | 部分实现 | `spaces.ts:106` 含 `temporary_task` 类型 | 创建临时空间未传 `space_type`，`spaces.create` 默认 `complex_project`——类型未真正接线 |
| FR-ONB-05 | 角色选择可推荐但不阻断 | 已实现 | `onboarding.js:10,3022-3023` 隐形匹配；`recommend-start.ts:277-307` `matchScenario` 超阈值才推荐 | 无 |

**小结：ONB 簇四簇中最完整（4/5 全实现或可验证），仅「全局自然语言输入首屏化」与「临时空间接线」两项缺口。**

---

## 2. FR-CON 连接 / FR-SRC 来源与权限 / FR-SES Session

| ID | 需求 | 状态 | 证据 | 差距 |
|---|---|---|---|---|
| FR-CON-01 | 展示Agent连接能力等级（检测/读会话/启动/回收四级） | 部分实现 | 检测=`local_agents/registry.ts:258-326`；读=`claude_sessions.ts`；启动=`runner.ts runCliAgent`；回收=`runner.ts` | 四项能力各自存在，但无统一四级「能力等级」分级/展示实体（连接器仅 `connected/degraded` 状态机） |
| FR-CON-02 | 连接中断不丢本地候选/资产/回执，重启恢复 | 部分实现 | `connectors/types.ts:59-73` degraded 持久化 cooldown；`registry.ts` 持久化 status/grant/tools_cache | 连接器状态可恢复；但候选/资产/回执无「连接中断→统一恢复」契约 |
| FR-CON-04 | 能力不足提供可审查降级 | 已实现 | `connectors/types.ts:64-74` degraded；`manager.ts:269-288`；`connectors.js:575`"未验证·<reason>" | 无 |
| FR-CON-05 | 区分 native_session / exported_evidence / reference_only | 未实现 | 全仓库 `native_session/exported_evidence/reference_only` **零命中**（仅 p3394 `native_session_id` 语义不同） | 无三来源契约实体 |
| FR-SRC-01 | 按当前工作/最近/主动选择展示来源 | 部分实现 | `recommend-start.ts:13-14,244` rank(投入+最近)；`scope-manifest.ts`；onboarding 分流 | 三维度分散，无统一「来源」聚合视图 |
| FR-SRC-02 | 读前逐项/范围授权，可查看撤销 | 已实现 | `scope-manifest.ts:23-117` scope-manifest.json；`contract.ts:121` 不读全文、`:125` revoke；`forget.ts` | 无 |
| FR-SRC-03 | 默认排除密钥/凭证/敏感文件 | 已实现(部分) | `context-reuse-receipt.ts:15-133` 凭据正则脱敏；`skills.ts:1632` 拦凭据目录；connectors `secrets_enc` 加密 | 密钥/凭据已覆盖；「排除敏感文件/无关上下文」无统一读取过滤 |
| FR-SRC-04 | 可暂停实时发现和夜间整理 | 部分实现 | `sync-scheduler.ts:71-91` 暂停；`briefing.pause`；daily | 「夜间整理」sweep 是启动时执行，非夜间定时 |
| FR-SRC-05 | 拖入/粘贴/文件/Artifact 主动来源，保留类型/哈希/引用 | 已实现(部分) | `chat_attachments.ts:333` sha256 hash_file；`contexts.ts`；`ExternalResource` 含 contentHash/resourceId | Artifact 作为「复用来源」证据较弱 |
| FR-SRC-06 | 来源Agent推送或菜单栏捕获（Should） | 部分实现 | `personal_context/contract.ts:115-126` ConnectorProvider 扩展点 | Agent 推送与菜单栏捕获未实现 |
| FR-SES-01 | Session 契约字段（Identity/Scope/Policy/游标/Outcome/版本） | 未实现 | `session contract/outcome_contract/primary goal` **零命中**；仅 `p3394_bridge/interop` 分散近似 | 无统一 Session 契约实体 |
| FR-SES-03 | Session 终态生成 Episode Record | 部分实现 | `kstar/types.ts:35-82` KstarEpisodeRecord；`executor.ts:217-218` 任务终态产 episode | Episode 由「任务终态」产出，非「Session终态」；session close 仅写轻量 close 记录 |
| FR-SES-04 | 外部会话按能力等级建立 ExternalSessionBinding | 未实现 | `ExternalSessionBinding` **零命中** | 无实体/流程 |

**小结：SRC 授权/脱敏/哈希有真实实现；CON 与 SES 的核心契约实体（三来源、能力分级、Session 契约、ExternalSessionBinding）全为概念层，未落地。**

---

## 3. FR-EXT 认知沉淀 / FR-REV 候选审查

| ID | 需求 | 状态 | 证据 | 差距 |
|---|---|---|---|---|
| FR-EXT-01 | 任务完成后生成候选（来源/类型/作用域/不确定性） | 已实现 | `capture-service.ts:2148` queueRecallCaptureFromTerminal、`:71` MAX=3、`:719-738` 抽取 schema；`candidate-service.ts:77-118` | 无 |
| FR-EXT-02 | 主动圈选历史会话，按时间/Agent/项目/Session 筛选 | 部分实现 | `capture-service.ts:2523/2546` manual/historical；`recall.captures.manualCreate` | 仅按 Session 圈选；`source-catalog.ts:44-48` 无时间/Agent/项目筛选 |
| FR-EXT-03 | 实时发现授权 Session 变化 | 部分实现 | `capture-service.ts:2893-2906` 订阅 task terminals；`subscribeTaskTerminals` | `realtime` flag 默认 false 无消费；当前为「任务终态 smart 发现」(waiting_quiet)，非真实时监听 |
| FR-EXT-04 | 本地夜间整理，失败/休眠/延迟可见 | 部分实现 | `capture-settings.ts:11-45` nightly；状态 scheduled/queued/extracting/failed/cancelled | PRD 六状态中 `running/delayed` 无独立状态名（分别以 queued/extracting 与 scheduled/wait_nightly 隐式表达） |
| FR-EXT-06 | 选择提取规则/模板/Skill/关于我，不同准入门槛 | 已实现 | `promotion.ts:53 validatePromotionByAssetType`（四类不同门槛）；`formal-asset-promotion.test.ts` | 无 |
| FR-EXT-07 | 候选去重与拒绝抑制 | 已实现 | `candidate-service.ts:528/655-696` 指纹合并；`review-decision.ts:185 isCandidateSuppressed` | 无 |
| FR-EXT-08 | 主动 Skill 生命周期建议（创建/调用/更新/暂不更新） | 已实现 | `skill-lifecycle.ts:25` 四类型、`:142` classify；`recordSkillLifecycleRecommendation`(append-only) | 主进程有 `skill-lifecycle.ts` 与 recall `suggestedAction` 两套模型；渲染层「skill_evolution 候选没有决策通道」(`skills.js:2421/2459`) |
| FR-REV-01 | 候选卡展示判断/依据/不确定性/建议/选择 | 已实现 | `skills.js:2200-2278`；`_abilityCandidateDisplayTitle` 剥离 KSTAR 英文前缀 | 无 |
| FR-REV-02 | 保存/修改/暂缓/拒绝，每决定可审计 | 已实现 | `review-decision.ts:26` 七类型 append-only jsonl；`recall.candidates.save/update/defer/reject/ignore/keepCurrent` | 无 |
| FR-REV-03 / AC-25 | 短确认语绑定原建议与作用域 | 已实现 | `review-decision.ts:78-106` SHORT_CONFIRMATIONS，缺 antecedent_ref 抛错；含 scope/supersedes_ref | 无 |
| AC-05 | 提取最多3条候选+来源/作用域+推荐 Main Skill | 部分实现 | `capture-service.ts:71` MAX=3 | 「推荐 Main Skill」未实现：无 main_skill 概念，skill_method 候选仅经 `prepareRecallSkillDraft` 生成 draft |
| AC-28 | 原 Word/代码/报告保持来源；仅可复用结构成 Template | 已实现 | `capture-service.ts:729` prompt 显式"source file stays source, only reusable structure can be a template"；`promotion.ts:95` | 无 |
| AC-31 | 统一认知管道路由，来源/候选/四类资产/非资产清晰 | 已实现 | `source-catalog`→`candidate-service`→`formal-assets/`；`inbox.ts` 统一待办 | 无 |

**小结：沉淀核心闭环（来源→候选→四类资产 + 审查账本）中高满足；缺口集中在前端筛选维度、真实时发现、状态对齐、Main Skill 推荐。**

---

## 4. FR-REU 复用 / FR-EVL 评价

| ID | 需求 | 状态 | 证据 | 差距 |
|---|---|---|---|---|
| FR-REU-01 / AC-06 | 形成最小能力包（Main Skill/Ontology/规则/模板/Context/权限） | 已实现 | `capability-pack.ts:28-47` MinimumCapabilityPack；`:80-135` 只存引用不复制正文 | `versions` 只装 Main Skill 一条，规则/模板/切片不带各自版本号 |
| FR-REU-02 / AC-07 | 目标Agent加载能力包生成首个 Action Plan | 已实现 | `capability-load.ts:89-129` 要求先任务理解再 ACTION_PLAN≥3步；`:156-176` CLI 探测 real；`:135-283` completeReceipt | 无 |
| FR-REU-03 / AC-08 | 传递证明：用了什么/来自哪/计划变化 | 部分实现 | `proof-service.ts:21`、`terminal-proof.ts:54-79`、`context-projection.ts:544-551`、`skills.js:2067`"不说明结果好坏" | 「计划变化」无结构化 before/after 差异记录 |
| FR-REU-04 | 跨Agent/跨Session真实接续 | 已实现 | `capability-load.ts:156-283`；`context-reuse-receipt.ts:21-22`；`recall-terminal-proof.ts:24-49`；`recall-bridge.ts` | 无 |
| FR-REU-05 | 可比 Baseline/Treatment + Behavior Diff | 已实现 | `behavior-contrast.ts:22-35,191-258` sameInputHash；IPC `p3394.behaviorContrast.*` | `changed` 只比输出哈希/状态，非语义级；依赖注入 executor |
| FR-EVL-01 / AC-09 | 即时传递校验（带入正确/需要调整/不该带入） | 已实现 | `projection-card.ts:6`；`context-projection.ts:749-839`；`projection-decision-service.ts:122-196` | 「需要调整」闭环文案弱 |
| FR-EVL-02 / AC-10 | 四类效果评价 | 已实现 | `proof-service.ts:20` EffectivenessOutcome 五枚举；`effectiveness-feedback.ts:10-32`；四类文案 | 前端按钮组缺 `worse`(negative) 独立按钮 |
| FR-EVL-03 | Evidence不足/沉默时暂不学习 | 已实现 | `proof-service.ts:177-179` better 无证据降级；`policy.ts:117-129` 仅 better 升档；`review-inference.ts:127-145` unknown 不沉淀 | 无 |
| FR-EVL-04 | 执行前冻结预期 ExpectedResultSnapshot | 部分实现 | `evaluation-contract.ts:28-43`(success_criteria/frozen_at)、`:8`"P0最小版，完整评价P1"；`proof-service.ts:92`(无结构字符串) | 无「成功标准+来源+版本+时间+哈希」五要素统一快照对象 |
| FR-EVL-05 | 实际结果与用户反馈独立记录 | 已实现 | `proof-service.ts:22` observedResult+evidenceRefs；`episode-builder.ts:308-321` 五来源 evidence | observedResult 为文本，未强制非对话 Evidence |
| FR-EVL-06 | 结果泄漏使 Episode 失效并重跑 | 部分实现 | `proof-service.ts:180-181` invalid/rework outcome；`effectiveness-feedback.ts:52-70` | 无「泄漏检测→自动失效→强制重跑」自动闭环 |
| FR-EVL-07 | 直白语言审查 Skill 候选（有效/修正/不适用/暂不判断） | 未实现 | `locales/zh.json:4332`"Skill候选暂无accept通道" | 固定四选一审查 UI/通道缺失 |
| FR-EVL-08 | 已确认 Skill 新版本隔离复用验证 | 部分实现 | `capability-load.ts`(隔离 synthetic agent)、`main-skill-baseline.ts:311-343` verifyBaseline、`gate.ts:92-180` | 各块齐备但未串成端到端自动流程 |
| FR-EVL-09 / AC-19 / AC-30 | 区分信号/Episode/进化；Gate B 通过才表述已验证 | 部分实现 | `policy.ts` 三轴分离；成熟度阶梯 seed/bud/transfer/effectiveness；`extraction-service.ts:88-104` 沉淀门控 | 无显式 Gate A/B 命名与唯一收口；KStar 自进化线绕效果验证直接落 `system_precipitated_unverified` |
| AC-21 | 真实加载+Receipt 后升 Transfer Verified | 已实现 | `proof-service.ts:96-134` validReceipt(boundary=real/非rejected) 才 `setAbilityAssetMaturity→transfer_validated` | 无 |

**小结：复用/传递主链路（能力包→隔离加载→Action Plan→Receipt→升档→四类评价）中上满足；缺口集中在 Gate B 收口与 Skill 四选一确认。**

---

## 5. FR-AST 资产管理 / FR-TREE 认知树

| ID | 需求 | 状态 | 证据 | 差距 |
|---|---|---|---|---|
| FR-AST-01 | 四类资产统一浏览检索 | 部分实现 | `repository.ts:85-96`、`assets-adapter.ts:27-123`、`recall.assets.list`、`cognition.assets.list` | `recall.assets.list` 无自由文本 search 参数 |
| FR-AST-02 | 暂停/限域/撤销/回滚，注入行为立即变化 | 已实现 | `asset-service.ts:392-461,579-589,853-885`；`recall.assets.pause/resume/revoke/rollback` | 无 |
| FR-AST-03 | 查看使用记录与效果，追溯 Session/Agent/Receipt/评价 | 已实现 | `timeline-service.ts:99-214`；`cognition-chain.ts:99-196`；`recall.timeline.forAsset` | 无 |
| FR-AST-05 | 多 Workspace 引用不复制，稳定ID/Owner/版本谱系 | 已实现 | `asset-service.ts:120-172`、`workspace-refs.ts`、`listAbilityAssetsForSpace`(资产随 recall 全局存) | 无 |
| FR-AST-06 | 状态变化先记事件+Receipt，写入成功才更新 | 部分实现 | 候选晋升 `candidate-service.ts:1406-1717` ReviewDecision+HandoffReceipt+重试 | 纯治理动作(pause/revoke/archive/delete)只写审计事件，无独立 Receipt 产物 |
| FR-AST-07 | 来源撤权/Role停用/Workspace删除不删资产，停读取+复核 | 部分实现 | `source-control.ts:203-257`、`source-removal.ts`、`asset-service.ts:956-1012`；`inbox.ts:250-259` source_unavailable | 来源撤权已覆盖；**Role停用与Workspace删除两路径未接线**到停默认读取+复核 |
| FR-AST-08 / AC-23 | Skill 统一版本化写入，确认后生成不可变版本+Diff+回滚 | 部分实现 | `skill-draft-service.ts:854-1027`(prepare/confirm/hash校验/回滚)；`version-diff.ts` | Skill 升版「原/新版本+Diff」可读通道缺失，`skills.js:2458` 明示无 diff 读取通道 |
| FR-AST-09 | Skill 调用与暂不更新透明 | 部分实现 | `inbox.ts:144-202`；`cognition.candidates.decide`(ipc:2461) 硬校验 personal_ontology | 「接受限域更新」按钮 disabled；「保持当前版本」只是跳转链接，无持久化暂不更新决策 |
| FR-AST-10 | 四类/非资产统一路由，仅四类进成熟度与树 | 已实现 | `types.ts:89-95` FORMAL_ASSET_TYPES、`repository.ts:68-83` keepFormalOnly、`tree-service.ts:44-46` | 无 |
| FR-TREE-01 | 一个用户一棵认知树 | 已实现 | `tree-service.ts:7-8,111-153` 单 graph；`skills.js:2329-2343` | 无 |
| FR-TREE-02 | 树按成熟度成长（轮廓/浅绿/深绿三档） | 部分实现 | `tree-service.ts:22-24` maturity；`skills.js:2290-2357` | 视觉仅**两档**：浅(seed/bud/transfer_validated)与深(effectiveness_validated)；轮廓叶与浅绿叶未区分 |
| FR-TREE-03 | 树/列表/历史/关系共享同一事件账本 | 已实现 | 树/列表/历史/关系均读同一 `listAbilityAssets`+版本/审计 JSONL | 无 |
| AC-11 | 确认后 Owner 固定用户，Workspace 只新增引用 | 已实现 | `asset-service.ts:311-313`(ownerId=userId)、`candidate-service.ts:1584-1606`(spaceId→workspace-ref) | 无 |
| AC-14 | 资产暂停/撤销后不再默认注入 | 已实现 | `asset-semantics.ts:128`、`runtime.ts:100`、`context-projection.ts:614-621` | 无 |
| AC-20 | 候选确认后未主动选择不静默注入 | 部分实现 | `policy.ts:101-106`(seed/bud→false)；**但**`runtime.ts:138-150` silentDefaultInjection 按适合度放行 seed/bud，`context-projection.ts:633-648` 走该路径 | **已文档化偏离**：`formal-asset-runtime.test.ts:27-47` 固化为"产品决策"，与 PRD 和文件自身注释(635)冲突 |
| AC-22 | 只生成创建/调用/更新/暂不更新建议 | 部分实现 | `inbox.ts:144-202`、`skill-draft-service.ts:960-1027` | skill_evolution 候选更新/暂不更新决策缺失(ipc:2461-2462) |
| AC-24 | 暂不更新展示原因+再次评估条件 | 未实现 | `skills.js:2473-2474`「保持当前版本」是导航链接 | 无持久化暂不更新决策/原因/再评估条件 |
| AC-29 | 同资产多 Workspace 只一条记录 | 已实现 | `asset-service.ts:383-390`、`workspace-refs.ts:50-95` | 无 |
| 3.5 元数据 | asset_id/type/owner/source_refs/version/scope/applicable/forbidden/evidence/maturity/sensitivity | 部分实现 | `candidate-service.ts:120-172` 全覆盖 11 项（缺 target_agents）；`types.ts:36-62` | **`target_agents` 完全缺失**：仓库规格 `specs/cognition-assets/spec.md:164,269` 自标「❌ 完全缺失」，资产记录无持久字段 |
| 3.6 成熟度 | Candidate/Confirmed/Transfer/Effectiveness/Paused五态 | 部分实现 | 内部 seed/bud/transfer/effectiveness + status(paused/revoked)+rollback | 展示层把 seed(Candidate)与 bud(User Confirmed)合并为「已确认，尚未验证」(`skills.js:361-364`)，未在成熟度轴区分 |

**小结：资产/认知树簇中高满足，底座（canonical边界/账本/版本/治理动作/单树）扎实；缺口为 `target_agents` 元数据、树三档视觉、Skill 更新决策链、AC-20 静默注入偏离。**

---

## 6. FR-WSP Workspace / 空间

| ID | 需求 | 状态 | 证据 | 差距 |
|---|---|---|---|---|
| FR-WSP-01 | 空间组织持续成果/任务/资产引用，不取得资产所有权 | 部分实现 | `spaces.ts:34-73`(sustained_outcome/base_agents/main_skill_ref/bindings)、`deleteSpace:818-873`(不删资产) | 「阶段目标/任务」非 Space 一等实体，仅会话级 taskRefs |
| FR-WSP-02 / AC-16 | 每次 TaskRun 绑定 Main Skill Baseline | 已实现 | `workbench/main-skill-baseline.ts:86-99`(skill_ref/action_plan_ref/ontology_binding_ref/evaluation_contract_ref/frozen_by)、`:242-287` freeze、`:311-343` verify | action_plan_ref 等是无反解调用方的字符串(仅校验形状) |
| FR-WSP-03 | Workspace 多 Main Skill，KSTAR 按 Skill Run 形成 Episode | 部分实现 | `kstar/types.ts` 含 workspaceId/taskRunId | **Episode 无 main_skill_ref/baseline 绑定字段**；Space 仅单一 main_skill_ref |
| FR-WSP-04 / AC-13 | 复杂项目 Workspace 达上架 Gate | 部分实现 | `workbench/gate.ts:44-52,92-180` 四条件；`capability-load.ts`；`workbench.gate.evaluate` | Gate 仅查 baseline+receipt+validation+invocability，**未纳入"模板/示例任务/异常路径真实可运行"**；渲染层只显示 gate_status 徽章不阻断空壳 |
| FR-WSP-05 | 职场事务 Workspace 达 Gate | 未实现 | `role_templates.ts:897-939`(workplace 场景) | 有职场场景但无专用上架 Gate(通用4条件) |
| FR-WSP-07 | 任务接续快照（从已提交状态派生/有效期/敏感） | 部分实现 | `task_continuation.ts:22-41`(最小快照)、`deriveFromSummary:83` | 仅从会话摘要轻量派生；**无**从 Checkpoint/事件游标派生、无有效期/敏感级别、无 draft/issued/superseded 状态机；`snapshot` flag false |
| FR-WSP-08 | 主导+辅助角色组合 | 部分实现 | `spaces.ts:44-47,487`(主+≤2副)、`formatRoleProfileForSystemPrompt:1049-1097` | 「组合范围/投影优先级」未实现；`rolecomposition` flag false |
| FR-WSP-09 | Workspace 审查并更新资产引用版本 | 部分实现 | `spaces.ts:113`(pinned/review_required/follow)、`:154` 读时默认 review_required；`asset-events.ts:38-41` 事件类型 | **无 TaskRun 启动冻结资产版本链**(task-run.ts 不存在)；事件类型无 emitter/consumer；**写入缺省 follow_latest_compatible 与需求默认 review_required 相悖**(`spaces.ts:929`) |
| FR-WSP-10 / AC-WSP-05 | 前台统一新建空间，无平行新建项目 | 已实现 | `workspace.js:419`、`spaces.js:110/263`"新建空间"；渲染层「新建项目」零命中 | 无 |
| FR-WSP-11 | 复杂/专业/周期/临时四类空间 | 已实现 | `spaces.ts:106` 四值、workspace.js:81-87 四类 UI | 无（临时类型接线见 FR-ONB-04） |
| FR-WSP-12 | 首次只荐一个主+≤2可选空间 | 部分实现 | `onboarding.js:409-462`、`role_templates.ts:897-939` | 推荐作用于模板/场景而非"空间"粒度，无显式主+可选空间选择集 |
| FR-WSP-13 | 从 Blueprint 安装私人 Package | 未实现 | `flags.ts` blueprint=false | 无功能代码 |
| FR-WSP-15 | 跨空间 Context Binding | 部分实现 | `workspace-refs.ts:10-95`(只读引用/scope收窄/撤销/历史) | **无版本化、无限时** |
| FR-WSP-16 | 外部 Project/目录/Thread 映射执行端 | 未实现 | `ExternalExecutionBinding` **零命中** | 无该概念 |
| FR-WSP-17 / AC-WSP-12 | 私人空间实例隐私/归档/删除，删实例不删资产 | 部分实现 | `spaces.ts:818-873`(删空间不删资产)、`workspace-refs.ts:88-95` | 无空间"归档"控制；无 Workspace Package 概念 |
| AC-WSP-03 | TaskRun 启动后版本冻结，只展示升级建议 | 未实现 | 无 task-run.ts；`capability-pack.ts:122` 仅打包时快照 | 无运行时版本冻结链路 |

**小结：Must（WSP-01~04）主链路基本落地且有测试；Sprint3/4 与 Later 多为数据模型先行、运行时链路缺位。最严重：KSTAR 未按 Main Skill Run 形成 Episode、资产版本冻结链路无消费、跨空间 Binding 缺版本化+限时、Blueprint/ExternalExecutionBinding 零实现。另注意 `bindSpaceAsset` 写入默认 `follow_latest` 与需求 `review_required` 相悖。**

---

## 7. FR-ROL 角色 / FR-ONT 个人本体 / FR-REL 关系 / FR-CNT 任务接续

| ID | 需求 | 状态 | 证据 | 差距 |
|---|---|---|---|---|
| FR-ROL-01 | 角色模板推荐/选择/叠加/跳过 | 部分实现 | `role_templates.ts:42-50,955,897-939`；`personal-ontology.js:344-453` 安装UI；`onboarding.js:262` 跳过 | 无「推荐理由/模板来源/范围」字段或展示 |
| FR-ROL-02 | 模板只给 TBox/RBox/缺口清单，未确认不建 ABox | 已实现 | `role_templates.ts:18-40`(T-box=fields/R-box=isRelation)、`template_files.ts`(install 只建挖空模板)、`candidates.ts:559-683`(confirm 才写 A-box) | 「缺口清单」以空坑形式存在，无显式缺口对象 |
| FR-ROL-03 | Role Binding 版本化/暂停/升级/回滚 | 部分实现 | `groups.ts:71,329` template_version；卸载归档 `template_files.ts` | 只有 install/uninstall/归档；无暂停/升级/回滚三态与迁移 |
| FR-ONT-01 | Personal Ontology 区分核心/切片/来源证据 | 部分实现 | 个人核心=`personal`资产、切片=模板组+ontologyRefs、来源=evidenceRefs | 分散于两套体系，无统一「核心vs切片vs证据」单一模型 |
| FR-ONT-02 | Task Agent 发布 Ontology Contract | 部分实现 | `capability-pack.ts:28-47`、`capability-load.ts:90-118`、`p3394_bridge/capability-profile.ts:11-19` | 无单一 Ontology Contract 对象；缺最小输入/可选读取/输出类型/候选写入范围/敏感/失败行为 |
| FR-ONT-03 | 每次 TaskRun 生成最小 Context Projection | 已实现 | `context-projection.ts:81-99`(taskRunId/assetIds/versions/sourceRefs/authorization/expiresAt)、`:411-507` Top-N 最小子图 | 无 |
| FR-ONT-04 | TaskRun 使用独立 Task Ontology Instance | 部分实现 | `context-projection.ts:81-99` 按 taskRunId 作用域化；`capability-pack.ts:120` | 无首类「Task Ontology Instance」对象，散落多处 |
| FR-ONT-05 | Agent 输出按类型分流，禁止直接写正式资产 | 部分实现 | `promotion.ts:53-87`、`policy.ts:84-106`、`inbox.ts:139-296` | 晋升闸门已实现，但多条入口可直接 promote，无单一强制落 inbox 拦截 |
| FR-ONT-06 | 显式教学信号形成限定范围确认+回执 | 已实现 | `teaching-service.ts:108-243`(classify/record/revoke)；`teaching-receipt.test.ts` | 无 |
| FR-REL-01 | 提取人物/组织/关系候选 | 未实现 | `ontology-rules.ts`(A→B R-box)与 `p3394/protocol.ts`(A2A委托)均非人物关系 | 无人物/组织关系候选管线 |
| FR-REL-02 | 稳定实体ID/别名/合并/撤销 | 未实现 | grep 别名/合并仅 agent 注册表与 OAuth | 无 |
| FR-REL-03 | 关系生效前用户审查 | 未实现 | `ontology-rules.ts` 直接进 world-model，无审查流 | 无 |
| FR-REL-04 | 关系确认/拒绝/结束/取代/撤销/冲突版本化 | 未实现 | `superseded` 仅出现在候选/连接器，非关系 | 无 |
| FR-REL-05 | 冲突关系进待确认 | 未实现 | 最近「conflict」是资产分类冲突，非关系 | 无 |
| FR-REL-06 | 最小关系投影 | 未实现 | `context-projection.ts` 只投影资产非关系 | 无 |
| FR-REL-07 | 记录关系实际使用 | 部分实现 | `context-reuse-receipt.ts:24-41` 面向资产引用 | 无关系/版本维度使用追踪 |
| FR-CNT-01 | 生成接续快照（从已提交状态派生） | 部分实现 | `task_continuation.ts:22-41,109-166`(goal/stage/constraints/nextStep)；`readSeedSummary` | 仅从会话摘要派生；`latestArtifact` 恒 null |
| FR-CNT-02 | 明确区分事实/决定/约束/待确认/已否定/成果/阶段/下一步 | 未实现 | `task_continuation.ts:22-41` 仅 4 个笼统字段 | 无状态分桶 |
| FR-CNT-03 | 引用最新 Artifact 及版本，来源失效停止 | 部分实现 | `capability-pack.ts:37,122`、`context-projection.ts:695-732`(validateFrozenProjectionAssets) | 接续快照本身 latestArtifact 未版本化不校验来源 |
| FR-CNT-04 | 快照存 relationship_refs/asset_refs/Evidence/权限/有效期 | 部分实现 | `capability-pack.ts:96-130`(仅引用不复制) | 接续快照(而非 capability-pack)不保存这些 |
| FR-CNT-05 | 用户审查后签发，未确认 draft 不得进目标 Agent | 部分实现 | `context-projection.ts:41,915-928`(preview→confirmed) | `capability-load.ts:135` 直接 spawn 目标 CLI，**无确认闸门** |
| FR-CNT-06 | 目标 Agent 先返回理解+Action Plan，高风险前确认 | 部分实现 | `capability-load.ts:90-129`(先理解+计划)、`:51,176` read-only | 无「用户确认后执行高风险」闸门，仅靠 read-only 兜底 |
| FR-CNT-07 | 过期/撤权/来源失效停止使用 | 已实现 | `context-projection.ts:703-731`、`capability-pack.ts:154`、`workspace-refs.ts:71-86` | 无 |
| FR-CNT-08 | 每次使用生成 ContextReuseReceipt | 已实现 | `context-reuse-receipt.ts:250-359`、`group_chat/bus.ts:5737`、IPC `p3394.contextReuseReceipt.read` | 无 |
| FR-CNT-09 | 同一 Task 唯一当前签发快照，旧快照 superseded | 未实现 | `task_continuation.ts:109-116` 单文件幂等 | 无版本化/签发/取代(superseded) |
| FR-CNT-10 | 默认排除完整历史/无关对象 | 部分实现 | `context-projection.ts:393-399`(Top-N+阈值)、`capability-pack.ts` | 接续快照 sourceSummary 存整段会话摘要，未裁剪 |

**小结：FR-ONT 与 FR-CNT 的"执行能力"（context-projection/teaching/receipt/失效拦截）中高；但 FR-REL 整簇基本缺失，FR-CNT 的"接续快照本体"过弱且与 capability-pack 两套割裂、无 superseded 版本化。**

---

## 8. KSTAR 受控进化契约（PRD §8.2/§8.5/§8.7）

| ID | 需求 | 状态 | 证据 | 差距 |
|---|---|---|---|---|
| 8.2-1 | SkillAsset 含 Manifest/Goal/IO Schema/依赖/OntologyBinding/Evaluation | 部分实现 | `main-skill-baseline.ts:86-99`(skill_ref/action_plan_ref/ontology_binding_ref/evaluation_contract_ref)；`types.ts:36-77` | **无统一 SkillManifest**；ActionPlan/IO/依赖/许可证/回滚点不在正式资产；`main-skill-baseline.ts:154-158` 自述"carriers do not exist yet" |
| 8.2-2 | 正式准入（nseap-creator/导入兼容候选/Validator/安全/最小运行） | 部分实现 | `promotion.ts:53-87`、`cognition/gate.ts:134-162`、`semantic-review.ts`、`nseap_skill_skeleton.ts:59`、`policy.ts` | 有晋升/安全闸；但"外部导入先进兼容候选"无独立路径；nseap-creator 未硬性强制 |
| 8.2-3 | 正式 KSTAR 绑定不可变 Baseline；无 Baseline 不启动 | 部分实现 | `main-skill-baseline.ts:242-287,311-343`(freeze/verify)；`workbench/gate.ts:101-159` | 基线冻结/漂移检测已实现；但 Episode 启动路径**未校验 baseline**(workbench/task-run 不存在) |
| 8.5-1 | Episode 记录 K/S/T/A/R̂/R/ΔA/ΔR/Attribution/Candidate | 部分实现 | `kstar/types.ts:35-82`(仅 k/s/t/a/r+evidence)；ΔA/ΔR/Attribution 在 `KstarReviewRecord`；R̂ 在 `KstarRequirementRecord.rHat`；Candidate 在 `KstarCandidateProposal` | **Episode 本体缺 R̂/ΔA/ΔR/Attribution/Candidate 字段**(拆到旁挂记录)；进化对象是四类 AbilityAssetType，非固定 SkillAsset |
| 8.5-2 | 用户反馈不替代 R；checkpoint_type 四类 | 未实现 | `checkpoint_type` **零命中**；仅 `user_teaching_signal` 来源 kind | 无 plan_review/artifact_review/task_outcome/user_teaching 分类 |
| 8.5-3 | 四层粒度（Signal/Checkpoint→Episode→Gate A候选→Gate B进化） | 部分实现 | Teaching signal、review/checkpoint、Episode、Typed 候选均存在 | "Gate A Typed Candidate"与"Gate B 验证进化"作为独立层不存在 |
| 8.5-4 | R̂ 冻结（来源/版本/时间/哈希）+ R 独立 + 污染失效 | 部分实现 | `evaluation-contract.ts:28-43`(frozen_at)、`:8`"P0最小版P1"；`KstarExpectedResult`(requirement-types:30) 无版本/时间/哈希 | 全库无 `invalid_expected_result_contamination` 污染标记；无"时间序不可证→Incomparable" |
| 8.5-5 | 归因纪律（ΔA 未解释不更新；ActionPlan 只构成传递证明） | 部分实现 | `world-model-reconciliation.ts:185-219`(归因诚实返回 unclear/ΔA≠0→execution_gap)；`review-inference.ts:239`("deltaA gates deltaR") | "ActionPlan 只构成传递证明"无显式代码 |
| 8.5-6 | Skill 候选四类决定（有效/修正/不适用/暂不判断） | 未实现 | `ipc/index.ts:2462` `cognition.candidates.decide` 硬校验 personal_ontology；`skills.js:2417-2422`(TODO P5，skill_evolution 候选无决策通道) | 四选一决策通道缺失 |
| 8.5-7 | no_change 五因分类，不触发版本/树成长 | 已实现 | `skill-lifecycle.ts:27-33`(covered/one_off/insufficient/not_attributable/below_repeat)、`:98-102`(强制 reason+reassess_when) | "最小判定器"(`:140`自述Diff/归因引擎属Gate A P1)；未接树成长抑制 gate |
| 8.7 Gate A | 绑定 Baseline+记录动作/产物/冻结预期/独立实际+生成候选+用户四选一 | 部分实现 | Baseline/episode/ΔAΔR归因/候选沉淀(`direct-experience-assets.ts`)/Diff/回滚均有 | **无专用 SkillEvolutionCandidate+Diff 类型**；无用户四选一；自进化路径 needsConfirmation 恒 false 自动沉淀 |
| 8.7 Gate B | 隔离复用+可比+改善+负迁移+Receipt | 未实现 | `flags.ts` `gateb=false`；`context-reuse-receipt.ts` 仅服务 Transfer Proof | 无隔离重跑/可比/负迁移/版本结论模块；开关关闭 |
| 0.6.4 | KSTAR 受控进化 7 条规则 | 部分实现 | 前段(不Baseline冻结→预期冻结→Δ/归因→候选沉淀→Evidence不足保留)具备 | 中后段断裂：无用户确认(自动沉淀)、无不可变新版本强制、无 Gate B |

**小结：中低满足(约30-40%)。前半程（测量/冻结/对账）已实现且有测试；后半程（用户四选一确认→不可变新版本→Gate B 隔离验证）整体缺失。三处最严重：Episode 缺 R̂/ΔA/ΔR/Attribution/Candidate 完整字段、R̂ 无版本/时间/哈希冻结与污染标记、Gate A/B 并非真实双闸(仅 gateb flag + 候选安全准入闸)。**

---

## 9. FR-COM 社区 / FR-XPR 跨产品 / 隐私

| ID | 需求 | 状态 | 证据 | 差距 |
|---|---|---|---|---|
| FR-COM-01 | 浏览/安装社区 Workspace Blueprint | 未实现 | `flags.ts:24-25,41` blueprint=false(flags.ts 外零消费） | 无蓝图概念；现有 `marketplace.ts` 只做 Agent/Skill 市场 |
| FR-COM-02 | 社区只分享蓝图，不含私人数据 | 未实现 | 全仓库无 workspace package/community 消费 | 无 |
| FR-COM-03 | 贡献经审查资产改进 | 未实现 | 上传/删除 dev-only，`marketplace_dev.ts/.js` 源文件被剥离 | 无贡献/发布流程 |
| FR-COM-04 | 贡献前敏感/画像检查 | 未实现 | 现有扫描(`red-flags.ts:124-174`、`sentry-adapter.ts`)是 Skill 导入期安全扫描非贡献前 PII 检查 | 无 |
| FR-COM-05 | 蓝图经来源/许可证/依赖/安全 Evidence 审查 | 未实现 | `marketplace.ts:1015-1031` scanSkillDir(仅 Skill) | 无蓝图审查 |
| FR-COM-07 | 贡献须用户显式发起 | 未实现 | 无发布通道 | 无 |
| FR-COM-08 | 安装后仍需授权本地数据/连接器 | 未实现 | 连接器 OAuth per-user(`oauth.ts`) | 架构天然满足"安装物不含作者凭证"，但无显式治理机制 |
| FR-XPR-01 | 企业资产授权外部引用，不驱动个人树 | 未实现 | `federation=false`；无企业资产类型 | 无 |
| AC-PRV-01 | 发布前隐私检查 | 未实现 | 仅日志/遥测脱敏(`log-redact.ts`)，非发布门禁 | 无 |

**小结：9 项 Later 需求无一按 PRD 语义实现"（符合 Later 预期）。两处可复用雏形：Agent/Skill 市场生态（可扩展为蓝图市场）与安全/凭证扫描器（可扩展为 PII/画像检查）。**

---

## 10. 结构性结论与优先级建议

### 8月19日 Must 达成度
- **已达成**：极简启动/免凭证/授权来源/凭证脱敏/来源哈希（ONB+SRC 大半）；**复用证明主链路**（能力包→隔离加载→Action Plan→Receipt→Transfer Verified）；四类资产+候选审查+去重/短确认；单一认知树；四类效果评价。
- **未达成（Sprint 3/Later 待办而非保底）**：KSTAR Gate A/B、关系断言、三来源契约实体、Skill 更新/暂不更新决策链、任务接续快照版本化。

### 建议优先补齐（按差异化价值）
1. **KSTAR Gate B 收口 + Gate A 用户四选一**：补 Episode 的 R̂/ΔA/ΔR/Attribution 完整字段、污染失效标记、四选一决策通道、隔离复用验证收口函数。
2. **关系断言簇（FR-REL-01~07）**：这是 PRD 34 项元数据中的核心差异化能力，当前为空白；需实体ID/别名/受控谓词/生命周期/最小投影。
3. **`target_agents` 元数据**：仓库规格自标"完全缺失"，影响更精确的注入控制。
4. **三来源契约（native_session/exported_evidence/reference_only）**：诚实的连接能力分级，8/19 主张边界所需的透明基础。
5. **Skill 主动生命周期的更新/暂不更新 UI 决策链**：`cognition.candidates.decide` 硬校验 personal_ontology，阻断 skill 候选；diff 无读取通道。

### 需确认的契约背离
- **AC-20 静默注入**：`runtime.ts:138-150` 按"适合度"放行 seed/bud，绕过 policy 层"transfer_validated 才静默注入"，与 PRD 冲突且被测试固化为"产品决策"。
- **`bindSpaceAsset`（`spaces.ts:929`）写入缺省 `follow_latest_compatible`**，与 FR-WSP-09"默认 review_required"治理契约相悖。

---

*本矩阵基于代码实际状态与 1264 测试实证，不代表 PRD/产品验收结论。PRD 为 staged 评审材料，部分 Later 项未实现符合预期；是否纳入 Sprint 承诺须经 Refinement。*
