<!-- INTERNAL_ONLY -->
<!-- DO_NOT_EXPORT_TO_PUBLIC -->
> ⚠️ **INTERNAL_ONLY / DO_NOT_EXPORT_TO_PUBLIC**
>
> 内部开发文档。origin/develop 已在 `e9568127`（开源清理）中删除本文件；本分支
> 作为内部开发分支保留它。**回并 develop 前必须先删除**，否则会把内部文档带回
> 开源基线。公开导出分支 orphan/public 基于 develop 树，本文件不在其中。

# CogSeed 认知资产专项问题 Spec

> 基线 `dev/shiyuxuan-cognition-ui-gap @ 261bd187` · 2026-08-18
>
> **审计阶段只读；此后已在工作区落地 11 项修复**：P0-M1-01 · P1-M5-01 · P2-M8-01 ·
> M-2/N-13/N-15 · M-7 · N-6 · N-3 · N-1 · N-14 · R-1 · **G-8**。落地记录附在各条目下，
> §2.1 的状态列已同步，**全量销号见 §11**（M/N/G/P/R + L 系列逐条 VERIFIED / REMAINING / DEFERRED）。
> **尚未 commit。** 真实环境 E2E 记录见 §12.3。
>
> 本文只收录**本轮新发现**的认知资产链路问题。上一版《认知资产链路 — 现状与修复决策》
> （M-1…M-10 / N-1…N-18 / G-1…G-9，含存储地图与 UI Gap 表）**仍然有效、未被本文取代**，
> 全文用 `git show 261bd187:spec.md` 取回。其中未关闭的条目见 §7.2，**不在本文重复展开**。
>
> ⚠️ **B2 的开放清单已严重过时**（基线相差 77 个提交）。逐条复验后已关闭的有
> M-1 · M-3 · M-9 · N-2 · N-5。下一轮**不要直接引用 B2 的 §3/§4 表格**——先复验。

---

## 0. 本轮范围

只查一条命题在**最终安装包实际交付的代码**里成不成立：

> 认知资产真的从上游产生 → 真正确认 → 真正持久化 → 真正被下游 runtime 消费 →
> 真正在下一次交互中复用 → 真正留下可追踪证据。

审计对象是 `~/Downloads/CogSeed Dev.app`（2026-08-18 04:52，`com.cogseed.desktop.dev`，
版本 2026.7.2-1.3）解包后的 `app.asar`，逐条回 `~/Desktop/mate-agent-develop` 工作区源码复核。
两边的 `features/{cognition,recall}`、`recall/formal-assets`、`renderer/modules/cognition`、
`ipc/` 文件集**逐一 diff 完全一致**，所以下文行号对源码与安装包同时成立。

覆盖模块：capture · candidate · promotion · formal-asset · repository · persistence ·
cognition tree · ontology · runtime · context projection · prompt injection · reuse ·
receipt · usage history · bubble cognition · IPC · preload/shim · renderer · cloud/local · pack。

---

## 1. 基线与去重说明

本轮结论对**两条**基线做了去重，不是一条：

| # | 基线 | 覆盖什么 | 来源 |
|---|---|---|---|
| B1 | 《CogSeed 开源前 · 代码扫描问题待办清单》2026-08-18（代码基线 `1d87b2be`） | 开源上线全仓问题：闭源引擎剥离、内部名词改名、员工 PII、内部文档、DMG 签名公证、LICENSE/NOTICE、npm audit、法务备案 | 微信收件箱 docx |
| B2 | 上一版 `spec.md`（代码基线 `a506bc76`） | 认知资产链路本身：M-1…M-10 主链、N-1…N-18 非阻塞、G-1…G-9 UI Gap、存储地图 | `git show 261bd187:spec.md` |

**去重规则执行结果**：本轮扫描共产出 9 条候选问题，其中 6 条被 B1/B2 完整覆盖（KNOWN，见 §7），
剩余 3 条进入本文。**没有为凑数把 LIVE 链路写成问题**——§6 记录了 7 条本轮复验为真闭环的链路。

一条纪律：**同一根因只保留一条主问题。** 「气泡沉淀不进候选 / 不晋升 / 认知树看不到 /
runtime 不消费 / 没有 receipt / 无法确认」是同一个根因的六个症状，合并为 `P0-M1-01` 一条，
症状列在它的「影响范围」里，不另开 issue。

---

## 2. 总览

### 2.1 问题矩阵

| ID | 级别 | 模块 | 问题 | 状态 | 根因 | 用户影响 |
|---|---|---|---|---|---|---|
| **P0-M1-01** | P0 | M1 Capture / Candidate | 气泡「认知」沉淀写入孤立 Store，未接正式认知资产主链 | ✅ **已修**（2026-08-18） | 气泡入口经 REST shim 打到 legacy cognition store，该 store 无任何下游消费者，其唯一读界面在包内无宿主 | 提示「已保存到待确认认知」，实则永远看不到、永远不会被复用、也无法确认 |
| **P1-M5-01** | P1 | M5 Ontology | 资产 → 本体绑定 `ontologyRefs` 有读无写 | ✅ **已修**（2026-08-18） | 全链无生产者：IPC 开了参数、渲染层不传、主进程晋升路径不传 | 注入模型的资产恒不带本体绑定，「这条经验属于哪个概念」在复用时丢失 |
| **P2-M8-01** | P2 | M8 IPC / Contract | REST shim 间接层使通道可达性分析失效 | ✅ **已修**（2026-08-18） | `ipc-shim.js` 把 URL 翻成通道名，渲染层只出现 URL 字符串，按通道名 grep 恒为 0 命中 | 无直接用户影响；但它是 P0-M1-01 连续两轮审计被漏检的直接原因 |
| **M-2 / N-13 / N-15** | P1 | M9 Packaging | Ability Pack 线零消费者（含孤立包与孤儿文案） | ✅ **已删**（2026-08-18，决策一=删） | 组装/加载全无生产调用方，`capability-packs/` 恒为空目录 | 「Asset → Pack → Reuse 已打通」是假的 |
| **M-7** | P1 | M7 Reuse / Receipt | 回执存 local、资产存 cloud，换机后证明链断 | ✅ **已修**（2026-08-18，决策三=分层） | 回执是设备级执行日志，未进同步域 | 换机后「使用与证明」为空、成熟度无法复核 |
| **N-6** | P2 | M8 IPC / Contract | `cognition.assets.list` 类型枚举与正式四类不相交 | ✅ **已修**（2026-08-18） | IPC 层抄了一份四类字面量，与 `formalAssets` 漂移 | type 过滤要么抛错要么恒空（渲染层未传，问题潜伏） |
| **N-3** | P2 | M6 Inheritance | 出生继承 `glossary` 只写不读 | ✅ **已修**（2026-08-18） | 采集并落盘，但无路径送进提示词 | 「出生就该知道术语指什么」实际没发生 |
| **N-1** | P2 | M9 Governance | 资产事件重复账本零写入 | ✅ **已删**（2026-08-18） | `asset-events`/`asset-view`/`audit-receipt` 生产消费者均为 0，且被 `RecallAssetTimelineKind` 完整覆盖 | 声称 append-only 的治理账本实际不存在 |
| **N-14** | P2 | M9 Flags | P3394 特性开关 10 去其 9 无消费者 | ✅ **已收敛**（2026-08-18，删而不是接） | 9 个开关无任何读取点 | 无直接用户影响；开关表读起来像"有能力没开" |
| **R-1** | P2 | UI Route | 落地页与未知 route 兜底页不是同一页 | ✅ **已定案**（2026-08-18，判定=保留 split，不统一） | `90331a2c` 刘婷婷版把两者拆开：落地 `assets`、兜底 `inbox`（旧架构两者同为 `tree`，天然一致） | 无用户影响；刷新落「我的认知树」、点到坏链接落「待我处理」，用例已按此钉住 |
| **G-8** | P1 | Cognition Tree | 树上无「芽」，待确认认知在树上完全不可见 | ✅ **已实现**（2026-08-18，契约 v2） | `CognitionTreeNodeId` 只有 `asset:`，契约层没有候选节点 | 刚沉淀的候选在树上看不见，用户需在两页之间自己对账 |

### 2.2 统计

```
本轮新登记（审计阶段）
  NEW        2 条   (P1-M5-01 · P2-M8-01)
  ESCALATED  1 条   (P0-M1-01，原 N-7 非阻塞 → P0)
  KNOWN      6 条   已由 B1/B2 覆盖，见 §7

全量销号（§11，含 B2 的 M/N/G 与上一轮 R）
  VERIFIED   31 条   其中 4 条为「VERIFIED（代码/测试）」，待 §12.3 真实环境 E2E
  REMAINING   9 条   N-4 · N-7 · N-11 · N-16 · N-18 · L-1 · L-2 · L-3 · R-2a
  DEFERRED    6 条   M-6(不存在) · M-8 · N-8 · N-10 · R-3 · R-4
                     （R-2 已拆：R-2a 转 REMAINING，余 5 条休眠留在 KNOWN_DEAD_ROUTES）

IPC 疑点归因（§5.1）
  ①  cognition.js 8 处 apiFetch 指向已删路由   → 不可达，无阻塞  → L-3
  ②  cognition.assets.list 同名双注册          → 语义正确、行为有测试 → 并入 L-2
  ③  8 个 legacy handler 仍注册（写口活）      → 用户到不了，保留理由不成立 → L-2
  ④  6 条死 shim 路由                          → 拆 1 真故障 + 5 休眠 → R-2a
```

---

## 3. P0 — 阻塞核心闭环

### Cognition Capture

### P0-M1-01 气泡「认知」沉淀写入孤立 Store，未接正式认知资产主链

**状态**：ESCALATED
**继承自**：B2 · N-7「新旧资产共用 `cognition.assets.*` 通道前缀」
**原级别**：非阻塞（4.2 契约与命名空间，描述为「靠一行解构维持的命名空间隔离很脆」）
**新级别**：P0
**升级原因**：N-7 把 8 个 legacy 通道当作**一致休眠**的命名空间债务处理。本轮查明其中
`cognition.assets.capture` **有真实、用户每天可点的生产调用方**——聊天气泡菜单。它不是
"很脆的隔离"，它是一条正在跑的写入链，终点是没有任何消费者的孤岛。

**模块**：M1 Capture / Candidate
**严重度**：P0

**影响范围**（同一根因的六个症状，不另开条目）：
- 不进入候选池（`cloud/recall/records/candidates/`）
- 不经过晋升闸门 `validatePromotionByAssetType`
- 不成为四类正式资产，认知树 / 我的资产 / 待我处理三页全部看不到
- runtime 注入链不消费（注入只读 formal assets）
- 不产生 ContextReuseReceipt，使用与证明页无任何痕迹
- **无法确认**：唯一能把它转正的 `cognition.assets.confirm` 在包内没有可达 UI

#### 现象

用户在任意消息气泡菜单点「认知」→ 弹出沉淀面板（标题 / 摘要 / 证据 / 来源四个必填框）
→ 提交 → Toast 提示 **「已保存到待确认认知」**。

此后：认知资产页四个视图里都找不到这条；下一次对话不会带上它；「使用与证明」里没有它；
「待我处理」里也没有它。数据**确实写进了磁盘**，只是写进了一个没人读的文件。

#### 真实调用链（当前）

```
气泡菜单 .bubble-cognition-btn
  conversation.js:10634  渲染按钮
  conversation.js:10729  click → _openCognitionCaptureFromBubble
  conversation.js:10568  → window.openCognitionCapture({conversationId, messageId})
      ↓
renderer/modules/cognition/cognition.js
  :507  预填草稿 → invoke('cognition.capture.draft')      ← 这一跳是 LIVE 且正确
  :466  提交 → window.apiFetch('/api/cognition/assets/capture', {method:'POST'})
      ↓
renderer/modules/ipc-shim.js:60
  ['POST', '/api/cognition/assets/capture', 'cognition.assets.capture']
      ↓
ipc/cognition.ts:118  'cognition.assets.capture'
      ↓
features/cognition/index.ts:963  createCognitionAssetWithEvidence
      ↓
features/cognition/index.ts:727  writeJson(userCognitionFile(userId), store)
      ↓
paths.ts:250-251   cloud/cognition/assets.json     ← 终点，reviewState: 'pending'
      ↓
   （无下游消费者）
```

#### 预期调用链

```
气泡菜单
  → saveRecallCandidate（candidate-service.ts:540，五个生产者已收口的统一入口）
  → cloud/recall/records/candidates/<id>.json
  → 出现在「待我处理」
  → 用户确认 → recall.candidates.promote
  → promoteRecallCandidate（candidate-service.ts:1420）
  → 晋升闸门 validatePromotionByAssetType
  → createAbilityAsset → cloud/recall/records/ability-assets/
  → listFormalAssets → 认知树 / 我的资产
  → runtime 注入 → receipt
```

#### 根因

气泡入口接的是 **legacy CognitionAsset store**（B2 存储地图里标注为「遗留」的
`cloud/cognition/`），而不是 formal-asset 主链。两套 store 之间**没有任何桥接或同步逻辑**。

`userCognitionFile` 全仓仅 3 处引用，全在 `features/cognition/index.ts` 自己内部
（定义 1 处 + 读 1 处 + 写 1 处），没有任何 recall / kstar / runtime 模块读它。

#### 证据

| 项 | 位置 |
|---|---|
| 气泡按钮渲染 | `src/renderer/modules/conversation.js:10634`（`.bubble-cognition-btn`） |
| 点击绑定 | `src/renderer/modules/conversation.js:10729` |
| 入口函数 | `src/renderer/modules/conversation.js:10568` `_openCognitionCaptureFromBubble` |
| 提交 URL | `src/renderer/modules/cognition/cognition.js:466` |
| shim 映射 | `src/renderer/modules/ipc-shim.js:60` |
| handler | `src/main/ipc/cognition.ts:118` |
| service | `src/main/features/cognition/index.ts:963` `createCognitionAssetWithEvidence` |
| 落盘 | `src/main/features/cognition/index.ts:727` → `src/main/paths.ts:251` `cloud/cognition/assets.json` |
| **无消费者** | `grep -rn "userCognitionFile" src/` → 仅 `paths.ts:251` · `cognition/index.ts:4,680,727` |
| **无桥接** | 全仓无 `cloud/cognition` → candidate / ability-asset 的转换函数 |
| **确认 UI 无宿主** | `cognition.js` 渲染进 `[data-personal-onto-workspace-pane="growth"]`；该选择器在 `index.html` 与全部 renderer JS 中**零命中**（`cognition.js` 自身除外） |
| **确认才写 memory** | `cognition/index.ts:1088` `ensureCognitionMemoryEntryLocked` 只在 `confirmCognitionAsset`(:1057) 内；`createCognitionAssetWithEvidence`(:963) **不写 memory** |
| Toast 文案 | `cognition.js:487` `cognition.capture.saved`「已保存到待确认认知」 |

**为什么两轮审计都没抓到**：B2 §8.0 的机械扫描按 `data-*` 钩子做双向差集，§8.3 按**通道名**
grep 渲染层调用方。气泡这条链在渲染层只出现 URL 字符串 `/api/cognition/assets/capture`，
`grep "'cognition.assets.capture'" src/renderer` **恒为 0 命中**。见 `P2-M8-01`。

#### 用户可见影响

产品核心主张「你教过它的东西会被记住并复用」在这条入口上**是假的**。而且失败得很安静：
有成功提示、有数据落盘、没有报错——用户没有任何线索去怀疑它没生效。

比起「点了报错」（B2 的 M-10），这一类更贵：用户会持续投入内容，直到某天发现全都不在。

#### 为什么属于 P0

对照本文 §10 的 P0 判据，命中两条：
1. **用户以为成功但实际上没进入正式认知资产**
2. **数据写进孤岛且永远无法复用**

它不是"某个次级入口不完整"——气泡菜单是从对话里沉淀认知的**最主要入口**。

#### 修复边界

**要做**：把气泡入口从 legacy store 改接主链。终点是 `saveRecallCandidate`，让它产出一条
真正的 recall 候选，随后走既有的「待我处理 → 确认 → 晋升」路径。

**明确不做**：
- **不迁移 `cloud/cognition/` 存量数据**——先决定这批 pending 记录的归属（§8 决策一），
  在决定之前不要写迁移脚本
- **不删 `features/cognition/index.ts`**——`invalidateCognitionMemorySources` 等函数与
  memory 事务有耦合，删除属于 N-7 的收敛范围，不在本条内做
- **不改晋升闸门与四类判据**——气泡候选和其它四个生产者走同一套闸门，不给它开后门
- **不动 `cognition.capture.draft`**——草稿生成这一跳是 LIVE 且正确的，复用它

#### 修复建议

沉淀面板提交改为产出候选而非资产。`saveRecallCandidate` 需要 `judgment` / `evidenceRefs` /
`suggestedType` / `suggestedScope`，而面板当前收的是 `title` / `summary` / `evidence` /
`sourceLabel`——字段不是一一对应，需要一层映射，**并且要决定 `suggestedType` 从哪来**：
让用户在面板上选四类之一，或由 `cognition.capture.draft` 一并推断。建议后者，面板已经在用它。

`evidenceRefs` 必须真实：面板手上有 `conversationId` + `messageId`，足以构造
`{kind:'message', id:messageId}` + `{kind:'conversation', id:conversationId}`，
**不要用用户手填的 `sourceLabel` 字符串冒充证据引用**——那正是 `promoteRecallCandidate`
在 `unavailableCandidateSources` 里要挡的东西。

#### Contract 影响

`cognition.assets.capture` 与 `/api/cognition/assets/capture` 这条路由在修复后应废弃。
废弃时**连 shim 路由一起删**，否则会留下一条能打通到孤岛的 URL。

#### 持久化影响

`cloud/cognition/assets.json` 在修复后不再增长。存量记录处置见 §8 决策一。

#### Runtime 影响

修复后气泡沉淀的内容将首次进入 runtime 注入范围（经正式资产 → 投影 → promptBlock）。
注意这会**真实增加注入量**，`context-projection` 的相关度筛选要能扛住。

#### 回归风险

- 气泡沉淀改产候选后，「待我处理」的待办量会上升——这是正确的，但要确认
  `formal-assets/inbox.ts` 的分级逻辑不会被淹没
- 面板四个必填框的语义变了（从「资产字段」变成「候选字段」），四语文案需同步
- `cognition.capture.draft` 的返回形状如果被改动，会影响面板预填

#### 验收标准

- [ ] 气泡点「认知」提交后，该条目出现在「待我处理」页
- [ ] 该候选的 `evidenceRefs` 含真实 `messageId` + `conversationId`，`unavailableCandidateSources` 判定为可用
- [ ] 确认后经 `promoteRecallCandidate` 产出正式资产，`assetId` / `version` / `evidenceRefs` / `maturity` 齐备
- [ ] 该资产出现在认知树与「我的资产」（`cognition.assets.list` 返回含它）
- [ ] 下一次同类任务中被 `buildRecallTurnPromptContext` 带入，`bus.ts` 落下 `turn-<turnId>` 回执
- [ ] 提交后 `cloud/cognition/assets.json` **不再新增记录**
- [ ] 面板提交失败时不再显示成功 Toast
- [ ] 新增端到端用例覆盖 气泡 → 候选 → 资产 → 注入 → 回执 全链

#### 落地记录（2026-08-18）

**提交改走主链**（`cognition/cognition.js`）：`POST /api/cognition/assets/capture`
→ `invoke('recall.candidates.save', …)`，产出一条真正的 recall 候选，与其它五个
候选生产者共用同一个入口与同一套晋升闸门——**没有给它开后门**。

**evidenceRefs 用系统真握有的 id**：锚点消息（`kind:'conversation', subtype:'message'`）
+ 来源会话（`subtype:'session'`），两者都拿不到时直接拒绝保存。不拿用户手填的
`sourceLabel` 冒充证据引用——那正是晋升时 `unavailableCandidateSources` 要挡的形态。

**分类由面板收齐，不靠后端猜**：`saveRecallCandidate` 会 `requireAssetType`，
所以 `cognition_capture.md` 提示词加了 `suggested_type`（四类，与 `AbilityAssetType`
同一套词汇），`capture-draft.ts` 校验后作为**默认值**预填。关键取舍两处：
1. `suggested_type` 是**可选键**——模型漏字段不该让整条草稿作废，面板选择器是必填的；
2. 模型给出非法值时**留空**而不是回落 `skill_method`——回落只会把分类错误藏进资产库。

**路由一并删除**（`ipc-shim.js`）：留着 `/api/cognition/assets/capture` 等于留一条
通往孤岛 store 的入口。`cognition.assets.capture` handler 暂留（属 N-7 收敛范围），
但已无任何调用方。

**存量数据**：按决策一**直接丢弃**——这些记录从未被任何界面展示过，不写迁移代码，
不去推断它们的 `suggestedType`。

**测试**：`cognition-pages.test.ts` +1 条钉住「四类必填 + 模型预判只作默认值 +
锚点消息 id 进表单」；`ipc-shim-cognition.test.ts` 改写为断言该路由已不存在且不得
打到该通道；`personal-ontology.test.ts` 的路由断言同步改写。
`typecheck` 通过，认知资产相关 287 条用例中 286 通过，唯一失败
（`recall-cognition-flow` 未知路由回落）经 `git stash` 对照确认为**既有红**，与本次改动无关。

---

## 4. P1 — 核心能力不完整

### Ontology

### P1-M5-01 资产 → 本体绑定 `ontologyRefs` 有读无写

**状态**：NEW
**模块**：M5 Ontology
**严重度**：P1

**影响范围**：正式资产的本体绑定字段恒为空 → 注入模型的 `WorldModelAbilityAsset.ontologyRefs`
恒为 `[]` → Skill 草稿生成拿不到本体上下文。

#### 现象

`AbilityAssetOntologyRef{groupId, section?, field?}` 这套结构完整定义、有校验、有消费者，
但**没有任何生产者**。任何一条正式资产的 `ontologyRefs` 从创建到复用全程为空。

#### 真实调用链（当前）

```
定义        recall/ontology-refs.ts        normalizeAbilityAssetOntologyRefs
  ↓
校验/透传    candidate-service.ts:540       候选保存时 normalize（value.ontologyRefs）
            candidate-service.ts:1428      晋升时 normalize（options.ontologyRefs）
            asset-service.ts:153/397       资产创建/解析时 normalize
  ↓
消费        projection-knowledge.ts:108    复制进注入用的 WorldModelAbilityAsset
            skill-draft-service.ts:785     Skill 草稿的本体上下文
  ↓
       ——— 但上面每一处的入参恒为 undefined ———
```

**生产者缺口逐层确认**：

| 层 | 是否传 `ontologyRefs` | 证据 |
|---|---|---|
| 渲染层 · 资产编辑 | ❌ | `skills-bindings.js:1276-1282` 只发 `assetId` / `statement` / `scope` / `applicableWhen` / `forbiddenWhen` / `reason` |
| IPC · `recall.assets.update` | ✅ 接受 | `ipc/index.ts:2318,2327,2334` —— **槽位是开的，没人填** |
| IPC · `recall.candidates.promote` | ❌ | `ipc/index.ts:2307` 只透传 `riskAcknowledged` / `profileTarget` |
| 主进程 · 晋升 | ❌ | `capture-service.ts:2579` 与 `:2599` 两个 `promoteRecallCandidate` 调用点均不传 |
| 主进程 · 捕获管线 | ❌ | 候选构造处不写该字段 |

#### 根因

`recall.assets.update` 的契约里留了 `ontologyRefs` 槽，但**编辑表单没有对应控件**；
晋升路径则连槽都没往下传。字段沿着「定义 → 校验 → 消费」建完了，唯独没有人写第一笔。

#### 证据

- 消费方存在：`recall/projection-knowledge.ts:108`、`recall/skill-draft-service.ts:785`
- IPC 槽位：`src/main/ipc/index.ts:2318 / 2327 / 2334`
- 渲染层未传：`src/renderer/modules/skills-bindings.js:1276-1282`
- 晋升未传：`src/main/features/recall/capture-service.ts:2579`、`:2599`
- 归一化函数：`src/main/features/recall/ontology-refs.ts`

#### 用户可见影响

弱且间接：本体（T-Box / R-Box + USER.md / MEMORY.md）**本身是被注入的**
（`projection-knowledge.ts` 独立加载），断的只是「这条资产绑定到哪个本体概念」这条边。
模型拿得到本体，也拿得到资产，但拿不到两者的对应关系。

#### 为什么是 P1 而不是 P0

链路没有断——资产照常沉淀、照常注入、照常复用。缺的是一个增强语义。
按 §10 判据落在「ontology 不完整」。**不要因为它名字里有 ontology 就往上提。**

#### 修复边界

**要做**：至少打通一条真实写入路径。

**明确不做**：
- **不自动推断绑定**——不要按标题/关键词匹配本体分组给资产"猜"一个 `groupId`，
  那是在数据库里造事实。与 B2 §8.4 对 G-8 的判断同一条纪律
- **不为它新建本体索引**
- 不改 `AbilityAssetOntologyRef` 结构

#### 修复建议

两个入口二选一或都做：
1. **资产编辑表单**加本体绑定控件（IPC 槽已就绪，只差 UI 与四语文案）——改动最小
2. **晋升时透传**：候选如果已带本体线索，`promoteRecallCandidate` 把它传下去

如果产品上确认「资产不需要本体绑定」，那就**删掉字段与两处消费**，而不是留着空跑。
留一个恒空的字段比没有它更糟——B2 的 N-3 / N-4 已经各有一条同形态的债。

#### Contract 影响

若走路径 1，`recall.assets.update` 契约不变，只是首次被完整使用。

#### 持久化影响

`RecallAbilityAssetRecord.ontologyRefs` 开始有值。已有记录保持 `undefined`，
读取侧 `(asset.ontologyRefs || [])` 已经容错，无需迁移。

#### Runtime 影响

注入的资产开始携带本体绑定。注意 `projection-knowledge.ts` 有
`MAX_ONTOLOGY_ASSETS` / `MAX_ONTOLOGY_STATEMENT` 上限，绑定多了要确认不会挤掉资产正文。

#### 回归风险

低。消费侧已全部容错空值。

#### 验收标准

- [ ] 存在至少一条真实生产路径，可写入非空 `ontologyRefs`
- [ ] 写入后 `readAbilityAsset` 能读回，`version` 递增
- [ ] `projection-knowledge` 注入的 `WorldModelAbilityAsset.ontologyRefs` 非空
- [ ] 不存在任何按文本相似度自动推断绑定的代码路径
- [ ] 若选择删除方案：字段、`normalizeAbilityAssetOntologyRefs`、两处消费同时移除，无残留

---

## 5. P2 — 一致性 / 维护性 / UI 问题

### IPC / Contract

### P2-M8-01 REST shim 间接层使通道可达性分析失效

**状态**：NEW
**模块**：M8 IPC / Contract
**严重度**：P2

#### 现象

`ipc-shim.js` 保留了 HTTP 时代的 `apiFetch(url)` 形态，把 URL 翻译成 IPC 通道名。
于是渲染层代码里**只出现 URL 字符串，不出现通道名**。任何"这个通道有没有调用方"的
grep 审计，对经 shim 到达的通道恒得出「无调用方」的错误结论。

#### 证据

对 shim 路由表里的 cognition/recall 通道逐个反查渲染层通道名直调，**7 个零命中**：

```
SHIM-ONLY  cognition.assets.capture        ← 有真实生产调用方（P0-M1-01）
SHIM-ONLY  cognition.assets.confirm
SHIM-ONLY  cognition.assets.create
SHIM-ONLY  cognition.assets.defer
SHIM-ONLY  cognition.assets.evidence.add
SHIM-ONLY  cognition.assets.get
SHIM-ONLY  cognition.assets.reuse
```

- 路由表：`src/renderer/modules/ipc-shim.js:57-65`
- 全量核对方法：shim 路由通道 60 个 · 渲染层通道名直调 321 个，取差集

#### 接口状态分类（本轮对认知资产相关通道的判定）

| 通道 | 状态 | 依据 |
|---|---|---|
| `cognition.assets.capture` | **BROKEN** | 有生产调用方，但 callee 落在无消费者的 store（P0-M1-01） |
| `cognition.assets.{confirm,defer,get,create,page,reuse,evidence.add}` | **DEAD** | 唯一调用方 `cognition.js` 的宿主 DOM 在包内不存在 |
| `cognition.assets.list` | **LIVE** | `ipc/index.ts` 显式从 spread 中剔除 legacy 同名实现，指向 formal assets |
| `cognition.capture.draft` | **LIVE** | `cognition.js:507`，草稿生成正确 |
| `recall.*`（本轮触及的 30 余个） | **LIVE** | 均由 `skills.js` / `skills-bindings.js` 按通道名直调 |

#### 根因

一层为了不改 3000 行旧代码而保留的兼容层，代价是**静态可达性分析失真**。
B2 §8.0 / §8.3 两次机械扫描都建立在「按通道名 grep 渲染层」之上，因此系统性地漏掉了这 7 个。

#### 用户可见影响

无。这是审计方法论与可维护性问题。

#### 修复边界

**要做**：让可达性可被机械验证。

**明确不做**：
- **不为此重写 `apiFetch` 调用点**——那是 3000 行的改动，收益不匹配
- 不删 shim

#### 修复建议

成本最低的做法：在 CI 加一条检查，把 `ipc-shim.js` 路由表展开成「URL → 通道」映射，
与渲染层 `apiFetch` 调用点求交，产出一份**通道 → 真实调用方**的完整清单，
让后续审计能一次看全。顺带钉住「shim 路由指向的通道必须存在 handler」。

P0-M1-01 修复后，7 个中的 `capture` 会消失；其余 6 个属 N-7 的收敛范围。

#### 验收标准

- [ ] 存在一份可机械生成的「通道 → 调用方（含经 shim 的）」清单
- [ ] CI 能对「shim 路由指向不存在的 handler」报错
- [ ] 上述 7 个通道的状态（LIVE/DEAD/BROKEN）在清单中可直接读出

---

### 5.1 IPC 通道 4 个疑点归因（本轮收口）

`ipc-channel-reachability.test.ts` 落地后照出 4 个疑点，逐条归因如下。
**结论：本轮改动没有引入新的阻塞；但门禁第一次照出了一条既有的、用户可达的故障（④-a）。**

#### 疑点 ① `cognition.js` 仍有 8 处 `apiFetch('/api/cognition/assets*')`，而路由已删

**事实**：本轮删掉了 shim 里全部 `/api/cognition/assets*` 路由（`ipc-shim.js:57-66`），
但 `renderer/modules/cognition/cognition.js` 里仍留着 8 个调用点：

| 行 | 调用 |
|---|---|
| `:235` | `GET /api/cognition/assets`（`loadLegacyAssets`） |
| `:261` | `GET /api/cognition/assets/page` |
| `:309` | `GET /api/cognition/assets/{id}` |
| `:349` | `POST /api/cognition/assets`（create） |
| `:373` | `POST .../evidence` |
| `:382` | `POST .../reuse` |
| `:603` | `POST .../confirm` |
| `:604` | `POST .../defer` |

命中任意一条即 `unknown route: <METHOD> <path>` + 404（`ipc-shim.js:389`）。

**归因：不构成阻塞——这些代码没有触发路径。**

- `render()` 第一行取 `el('cognition-page')`：`index.html` 中**不存在 `id="cognition-page"`**
  （grep 全文 0 命中），取不到直接 `return`，列表 / 详情 / 治理整条链都进不去。
- `cognition.js:630` 的 `[data-personal-onto-workspace-pane="growth"]`：全 `src/renderer`
  只有这一处引用（即它自己），**无宿主**。
- 该模块**无任何外部调用方**：`loadCognitionAssets` / `window.CognitionAssets` 在模块外零命中。
- 模块里唯一活着的是沉淀浮层：`.cognition-capture-overlay` 挂 `document.body`，
  草稿走 `cognition.capture.draft`（LIVE），提交走 `recall.candidates.save`（`:489`）——
  **两条都不经这 8 个路由**。

**残留风险（记为 L-3）**：将来若有人给这个模块补一个宿主 DOM，它会整页 404。
`ipc-shim.js:66` 已用注释钉死「不要恢复任何 `/api/cognition/assets*` 路由」，
但**没有门禁挡住「给 `cognition.js` 补宿主」这个反方向**。本轮不加门禁——加了会立刻红
（8 个调用点还在），得先决定这个模块是删还是留。

#### 疑点 ② `cognition.assets.list` 同名双注册，靠一行解构维持隔离

**事实**：两处同名实现——`ipc/cognition.ts:92`（legacy，读 `cloud/cognition/`）与
`ipc/index.ts:2603`（canonical，读 `recall/formal-assets`）。`ipc/index.ts:4866` 用
`...(({ 'cognition.assets.list': _legacy, ...rest }) => rest)(cognitionHandlers)` 剔除 legacy 后再 spread。

**归因：当前语义正确，但没有直接门禁。**
`cognition-ipc.test.ts:124/138/141/151` 钉的是**行为**（返回 formal assets、四类 type 通过、
上一代 type 被拒），所以「谁赢」是被间接钉住的——这层保护有效。
但 `ipc-channel-reachability.test.ts` 的 `registeredChannels()` 是正则扫文本，**两处都命中**，
无法区分优先级，它挡不住「有人调换 spread 顺序让 legacy 覆盖 canonical」。
判定：与 L-2 同根因（legacy handler 仍注册），**随 L-2 一起收敛，不单开条目**。

#### 疑点 ③ 8 个 legacy `cognition.assets.*` handler 仍注册，写口仍活（= L-2）

**事实**：`ipc/cognition.ts` 的 `page/get/create/capture/evidence.add/confirm/defer/reuse`
仍经 `ipc/index.ts:4866` 注册；其中 6 个是**写口**，被调到就会落进 `cloud/cognition/`。

**归因：用户到不了；且「必须保留」的理由经复核不成立。**

- **到不了**：REST 入口已删；渲染层按通道名直调的 `cognition.assets.*` 经本轮复核只有
  `list`（`conversation-info.js:300`、`skills.js:4271`）与 `diff`（`skills-bindings.js:355`，
  handler 在 `ipc/index.ts:2651`），其余命中全是注释。
- **理由不成立**：L-1 要求保留旧 store 的**读**（`listActiveCognitionSourceIds` 被
  `model/core-agent/runner.ts:45 / :1052` 每回合真读，用于门控历史 MEMORY 行）。
  但那条读路径是**主进程内部直调，不经过 IPC**——这 8 个 handler 与 L-1 **无关**，
  删掉不影响历史 MEMORY 门控。
- **本轮未删**：超出 G-8 范围，且要连带 `ipc/cognition.ts` 的 legacy service 面，
  不在没有回归覆盖的情况下擅自扩大改动。

#### 疑点 ④ 6 条死 shim 路由（= R-2）：不是同一种死法

逐个反查渲染层调用方后，这 6 条**必须分成两类**——原先笼统记作「域外既有债、无代码影响」是错的：

| 通道 | shim 路由 | 渲染层调用方 | 判定 |
|---|---|---|---|
| `contexts.officeHtml` | `ipc-shim.js:81` | **有**：`contexts.js:1643` | **④-a 活的 404** |
| `marketplace.uploadAgent` | `:96` | 无 | ④-b 休眠 |
| `marketplace.uploadSkill` | `:97` | 无 | ④-b 休眠 |
| `workbench.actionPlan.read` | `:54` | 无 | ④-b 休眠 |
| `workbench.taskRuns.list` | `:55` | 无 | ④-b 休眠 |
| `workbench.taskRun.start` | `:56` | 无 | ④-b 休眠 |

**④-a — 用户可达的既有故障（本轮新发现，非本轮引入）**

```
「上下文」文件浏览器打开 .docx/.docm/.xlsx/.xlsm/.pptx/.pptm
  contexts.js:1533  CTX_OFFICE_EXTS
  contexts.js:1540  → 判定为 'office'
  contexts.js:1588  → _showCtxOfficeViewer(rel)
  contexts.js:1643  → apiFetch('/api/contexts/office?path=...')
      ↓
ipc-shim.js:81      路由存在 → 'contexts.officeHtml'
      ↓
主进程            无 contexts.officeHtml handler
                  （全仓只有 spaces.files.officeHtml，ipc/index.ts:3207）
      ↓
   invoke 抛错
```

`_showCtxOfficeViewer` **没有 try/catch**，在 `:1644` 的 `res.json()` 之前就已 reject，
预览永远停在 `…`，且没有任何报错 UI。
**用户症状：在「上下文」里打开 Office 文件永远转圈。**

**归因**：与本轮改动无关（`contexts` 模块，本轮 diff 未触及）；是 REST→IPC 迁移时漏迁的
一个 handler。两轮「按通道名 grep 渲染层」的审计都把它判成休眠通道——**和 P0-M1-01
是同一个方法论盲区**，这正是新门禁第一次照出来的东西，也是 P2-M8-01 值得做的直接证据。
**修法明确**：照 `spaces.files.officeHtml`（`ipc/index.ts:3207`）补一个 `contexts.officeHtml`。
**本轮不做**：域外（contexts，不属认知资产链路），改动要连带 contexts 的读盘边界。
→ 交 contexts 模块认领，记为 **R-2a**。

**④-b — 5 条真休眠**：无渲染层调用方，命中不了；已登记在 `KNOWN_DEAD_ROUTES`，新增一条即红。

---

## 5bis. G-8 — 认知树「芽」（本轮实现）

### G-8 认知树上没有候选「芽」，待确认的认知在树上完全不可见

| | |
|---|---|
| 级别 | P1（UI Gap，B2 记为 🔒 BLOCKED） |
| 状态 | ✅ **已实现**（2026-08-18），代码 + 自动化测试成立；真实环境 E2E 见 §12.3 |
| 模块 | Cognition Tree · Contract |

#### 现象

树只画正式资产。用户刚确认过一条候选，回到认知树想看"我刚沉淀的那条长出来没有"——
在它被晋升之前，树上什么都没有。候选的存在只由图例一句话说明（"候选尚未成为正式资产，
因此不在树上"），等于让用户自己在两个页面之间对账。

#### 根因（B2 判定，本轮复核成立）

`CognitionTreeNodeId` 是 `asset:${string}` 字面量类型，`CognitionTreeNode.type` 恒为 `'asset'`。
契约层根本没有候选节点。渲染层要画芽，只能自己去候选列表里捞一遍再摆上去——
那是在图上编造一个后端不认的状态，且必然做出**第二套**「哪些候选算芽」的判据。

#### 修复边界（产品决策已确认，本轮直接实现）

- 芽的判据**复用已有的唯一来源**，不新造：
  `getRecallCandidateCapabilities(candidate).canPromote === true`
  **且** `validatePromotionByAssetType(candidate, { actor: 'user' }).ok === true`。
- 挂载**只认候选自己的 `suggestedType`**。禁止按 title / statement / summary / 关键词
  二次推断分类——那是第二套分类事实源。
- 芽**不携带** `status` / `maturity` / `version`：那三个字段属于正式资产生命周期，
  给候选补一份就是伪造认知事实。
- 芽**不长边**：`CognitionTreeEdge` 的 `from`/`to` 收窄为 `CognitionTreeAssetNodeId`。

#### 一处 Contract 冲突及其判定

产品要求「`canPromote === true` 才显示为芽」与「`failed` 一律不显示为芽」**互相冲突**：
`candidate-capabilities.ts` 的 `BY_STATUS.failed` 是 `{ ...ACTIONABLE, canRetry: true }`，
`ACTIONABLE.canPromote` 为 `true`（后端确实放行失败候选重试后晋升）。

**判定：以「不显示」为准**，在 `tree-service.ts::isBudCandidate` 里作为一条**独立的产品判断**
显式挡掉，并在注释里写明理由——枝头的芽是"等你确认"的邀请，把一条沉淀失败的记录摆成邀请
是在骗用户；它在「沉淀失败的候选」分组里仍可见可重试，入口没有丢。
**没有**为了让判据统一而去改 `candidate-capabilities` 的 `failed` 行——那会同时影响
inbox 计数、批量勾选与后端晋升放行，是为了对齐一句话而动产品语义。

另：`suppressed` **不是** `RecallCandidateStatus` 的成员（枚举为 observed / weak_observation /
pending_review / deferred / confirmed / rejected / ignored / expired / failed / superseded）。
`rejected` / `confirmed` / `ignored` / `expired` / `superseded` 均为终态，`canPromote === false`，
天然不长芽，无需额外判据。

#### Contract 影响

`recall/tree-service.ts`，`COGNITION_TREE_CONTRACT_VERSION` 1 → **2**：

```ts
export type CognitionTreeAssetNodeId     = `asset:${string}`;
export type CognitionTreeCandidateNodeId = `candidate:${string}`;
export type CognitionTreeNodeId = CognitionTreeAssetNodeId | CognitionTreeCandidateNodeId;
export type CognitionTreeNode   = CognitionTreeAssetNode | CognitionTreeCandidateNode;
// CognitionTreeCandidateNode: { id, type:'candidate', assetType, label, displayState, risk }
// CognitionTreeEdge.from/to 收窄为 CognitionTreeAssetNodeId
```

**旧记录兼容**：不写迁移器。`readCognitionTree` 既有的 `isCurrentContract` 判据对
`contractVersion === 1` 返回 false，直接 `rebuildCognitionTree` 重投一次。树是投影，
唯一事实源仍是资产记录与候选记录本身，**重建不会丢任何用户数据**。
C7 之前的 lifecycle 图（source/candidate/usage 节点）走同一条路，行为不变。

#### 唯一性不变量（G-8 的核心承诺）

> Candidate 芽 → 用户确认晋升 → 芽消失 → Formal Asset node 出现。
> **同一次 tree rebuild 中不得 candidate + asset 双现。**

两道保险：

1. 晋升把候选落成 `confirmed`（`candidate-service.ts:1717`），终态 `canPromote === false`。
2. `isBudCandidate` 额外检查 `candidate.promotedAssetId` 是否已在本次节点集里——
   **即使某条晋升路径忘了落状态**，投影层自己也拒绝双现。

#### 持久化影响

无新增文件。仍写 `recall/tree/graph.json`（`writeRecallJsonRecord(userId, 'tree', 'graph')`）。
渲染层四个入口全部走 `recall.tree.rebuild`（`skills.js:393 / 4212`、`skills-bindings.js:1058`），
所以持久化的芽不会过期；`recall.tree.read` 保留给要读快照的调用方。

#### UI 语义

| | 叶（正式资产） | 芽（候选） |
|---|---|---|
| SVG | `<ellipse rx=15 ry=8.5>` 实心、旋转 | `<circle r=5.5>` **空心 + 虚线描边**，画在枝尖之外 |
| 分类卡 | `.cognition-tree-leaf.is-{deep,light}` 实线边 | `.cognition-tree-leaf.is-bud` **虚线边 + 琥珀色** |
| 点击 | `data-cognition-open-asset` → 资产页 | `data-cognition-open-candidate` → **候选详情页** |
| 计数 | 计入「{deep} 片叶已验证 / {light} 片待复用」 | **不计入**；分枝头单独一个虚线徽章 |

形状 / 大小 / 填充三处同时不同，不只靠颜色——只靠颜色区分，色觉障碍用户会把待确认候选
读成已确认资产。芽在 SVG 里与叶片同样**不可聚焦**（避免 `<g tabindex>` 焦点陷阱），
键盘与读屏的完整入口是分类卡里的真 `<button>`。

#### 证据

| 环节 | 文件 · 符号 |
|---|---|
| Contract | `src/main/features/recall/tree-service.ts`（v2、两类节点、`isBudCandidate`） |
| 判据 callee | `candidate-capabilities.ts::getRecallCandidateCapabilities` · `formal-assets/promotion.ts::validatePromotionByAssetType` |
| 数据源 callee | `asset-service.ts::listAbilityAssets` · `candidate-service.ts::listRecallCandidates` |
| 导出 | `recall/index.ts:52`（新增 4 个节点类型导出） |
| IPC | `ipc/index.ts:2460` `recall.tree.read` · `:2461` `recall.tree.rebuild`（未改签名） |
| Persistence | `recall/tree/graph.json`，`store.ts::writeRecallJsonRecord` |
| Renderer | `skills.js::_renderCognitionTreeCanvas` / `renderSkillsCognitionTree`；委托 `skills-bindings.js:934` |
| CSS | `recall-local.css` `.cognition-tree-svg-bud` / `.cognition-tree-leaf.is-bud` / `.cognition-tree-branch-buds` |
| i18n | 四语新增 `cognition.tree_bud_pending`、`cognition.tree_bud_pending_hint`；改写 `cognition.tree_legend_bud_hint`（旧文案说"因此不在树上"，已不成立） |

#### 测试

`test/main/features/recall/tree-service.test.ts`（11 条全绿，其中 G-8 新增 7 条）：

- 可晋升候选投影成芽，按 `suggestedType` 挂枝，且不带 maturity/version、不长边
- `rejected` / `failed` 不长芽（并断言 `failed` 的 `canPromote` **确实是 true**，
  钉住"这条挡不住靠 canPromote"）
- 过不了晋升闸门的候选不长芽
- **晋升后芽消失、叶片出现，同一次 rebuild 不双现**（read 口与 rebuild 口给出同一棵树）
- `promotedAssetId` 已在树上时丢弃该芽（状态漂移下的第二道保险）
- v1 记录读取时重投成 v2，**不丢已有资产**
- v2 记录里出现未知节点类型 → 拒绝，不静默吞掉

`test/renderer/recall-cognition-flow.test.ts`（140 条全绿，其中 G-8 新增 3 条、改写 2 条）：

- 树契约给了 candidate 节点 → 画成 `cognition-tree-svg-bud`（`r="5.5"`）、
  点击走 `data-cognition-open-candidate`、**不产生任何 `data-cognition-open-asset`**、
  分类卡里有 `cognition-tree-leaf is-bud` 真按钮
- 芽不计入叶片成长统计
- 只有芽没有资产时仍然画树（不显示"树上还没有叶片"把芽藏掉）
- **渲染层不从 `recallCandidates` 自己捞芽**：候选再多，树契约里没有 candidate 节点就不长芽

---

## 6. 已确认正常链路

**本轮逐符号复验为真闭环，形成稳定基线，下一轮不必重扫。这些不计入问题数量。**

| 链路 | 结论 | 关键证据 |
|---|---|---|
| 候选生产 → 落盘 | **PASS** | `candidate-service.ts:540` `saveRecallCandidate`，五生产者已收口 |
| 晋升闸门真实拦截 | **PASS** | `formal-assets/promotion.ts` `validatePromotionByAssetType`；不合格抛 `PromotionBlockedError`（`candidate-service.ts:1495`）。证据不足 / 高风险 / 来源失效 / 过期 / 同文本跨类冲突 五道判据均有生产路径 |
| 正式资产落盘字段完整 | **PASS** | `candidate-service.ts:1615` `createAbilityAsset`：`assetId` · `version:'1'` · `evidenceRefs` · `maturity`(user→bud / system→seed) · `lifecycleStatus` · `sourceSessionIds` · `applicableWhen`/`forbiddenWhen`/`sensitivity` 齐备 |
| 重启后仍在 | **PASS** | 纯文件 JSON（`recall/paths.ts` → `cloud/recall/records/`），无内存态 |
| 认知树读真实 repository | **PASS** | `skills.js:4210` → `ipc/index.ts:2603` → `assets-adapter.ts` → `formal-assets/repository.ts` `listFormalAssets`。**无 mock、无临时 snapshot、无 local fallback**；`keepFormalOnly` 挡掉非四类支撑对象并留 warn |
| runtime 注入（Commander / 空间会话） | **PASS** | `bus.ts:3991` `buildRecallTurnPromptContext` → `bus.ts:4005` `systemPrompt = systemPrompt + '\n\n' + recallContext.promptBlock`，真实执行链 |
| runtime 准入闸门 | **PASS** | `formal-assets/runtime.ts` `evaluateAssetRuntimeEligibility`：`status!=='active'` / `forbiddenWhen` 命中 / `applicableWhen` 声明未匹配 / 跨作用域未确认 / `targetAgents` 白名单 / 敏感级越界 六条判据全部参与。`maturity` 有意不作硬门槛（注释说明：否则 seed 永不可用、自进化闭环断裂） |
| 回执落盘与读回 | **PASS** | `bus.ts:4018` `prepareReceipt` → `bus.ts:5634` `completeReceipt` → `local/kstar/executions/<id>/`；`receipts-adapter.ts` 以回执目录为权威源 |
| 认知资产模块打包完整性 | **PASS** | `features/{cognition,recall}` · `recall/formal-assets` · `renderer/modules/cognition` · `ipc/` 五个目录源码 ↔ 安装包 `app.asar` 文件集 diff **完全一致，零缺失**，无 Packaging Gap |

> ⚠️ 注意作用域：「runtime 注入 PASS」指 **Commander / 空间会话**这条路径。
> CogSeed Runtime（Mate）不消费认知资产，仍是 B2 的 **M-1**，未关闭。
> 另 B2 的 **M-3**（注入 record 里不带 `applicable_when`/`forbidden_when`）与本表不矛盾：
> **闸门用了这两个字段做准入，但发给模型的正文里没有它们**——一个是筛选，一个是告知。

---

## 7. 已过滤旧问题

**已知问题已过滤：6 项**（另 B1 的 15 类开源上线问题整体不属本文范围）。以下不展开。

### 7.1 由 B1《开源前代码扫描问题待办清单》覆盖 — 本轮扫描命中但不重复登记

skill-sentry 闭源引擎进包 · skill-declaration-core（原 nseap-security-core）未剥离 ·
`SYNC.md` 员工路径 `/Users/wu.j.y/` · ECS 售前技能包 `d470761b0a07`（含真实客户案例）·
`personal-ontology-candidate-builder` 场景文件的 NSEAP IRI · NSEAP/ECS/Forge/Nexus/Raymond/P3394
统一改名 · 内部文档 · DMG 为 Dev 构建 / adhoc 签名 / 未公证 / `com.cogseed.desktop.dev` ·
README 内网 GitLab · git 历史 PII · LICENSE / NOTICE · npm audit · vendored license · SBOM。

> 本轮唯一值得回填给 B1 的一条事实：**发布名 DMG `CogSeed-2026.7.2-1.3-mac-arm64.dmg`
> 内装的是 `CogSeed Dev.app`**（bundle id 与 adhoc 签名均与 Dev 包一致）。这与 B1 第 1 节
> 「下架官网含闭源引擎的 DMG」是同一件事，不另开条目。

### 7.2 由 B2 上一版 `spec.md` 覆盖 — 状态未变，不重复登记

| 旧 ID | 问题 | 本轮复核 |
|---|---|---|
| **N-6** | `cognition.assets.list` 类型枚举不相交（IPC 收 `skill/knowledge/ontology/evaluation`，适配器过滤 `personal/rule/template/skill_method`） | ✅ **已修**（2026-08-18）。校验改走 `formalAssets.isFormalAssetType`，不再在 IPC 层抄一份四类字面量；`cognition-ipc.test.ts` 新增矩阵用例（四类接受 / 四个旧分类拒绝） |
| **N-7** | 8 个 legacy `cognition.assets.*` 通道指向旧 store | 其中 7 个仍为 DEAD，**第 8 个 `capture` 已升级为 P0-M1-01**；N-7 本体（命名空间收敛）不变 |
| **M-7** | 回执存 `local/kstar/`，资产存 `cloud/recall/` | 本轮逐路径复核（同机重启 ✅ 可关联 / 跨会话 ✅ / 跨设备 ❌ 断在回执不进同步域 / 云端恢复 ❌ 同上）。**断点与 M-7 原描述一致，无新增**。仍待 B2 决策三。**KNOWN** |
| **M-1** | CogSeed Runtime 不消费认知资产 | ✅ **已关闭**（2026-08-18 复验）。决策二已拍板=接：`cogseed_backend/runtime-asset-context.ts` 由主进程组装 confirmed 投影，经 `runtime-controller.ts:313/341` 走 Runtime 协议既有 `context` 槽下发，worker 不读 recall store（守住了红线） |
| **M-3** | `forbidden_when` / `applicable_when` 未进注入正文 | ✅ **已关闭**（2026-08-18 复验）。`prompt-injection.ts` 四处 record 构造均已带边界条件（代码内有 `M-3:` 标注），含 Commander 投影、committed 投影、派发授权三条路径 |
| **N-8** | `cognition.candidates.decide` 命名空间不统一 | 未变。附带观察：`cognition.candidates.list` 的 type 枚举含 `experience` / `skill_evolution`，而 `candidates-adapter.ts` 的 `typeForPersonal` 只产出 `preference`/`rule`/`ontology`，这两个过滤值不可达——属 N-8 同一命名空间问题，不另开。**KNOWN** |

### 7.3 B2 中仍未关闭、本轮未触及的条目

M-8 · N-4 · N-11 · N-16 · N-18。取回见文首。**其余原开放项已在本轮销号，逐条判定见 §11。**

> **⚠️ B2 的开放清单已经过时。** B2 基线是 `a506bc76`，当前 HEAD `261bd187` 之间隔了
> **77 个提交**。2026-08-18 逐条复验后，**M-1 / M-3 / M-9 三条已关闭**（见 §7.2 与下表），
> 上面这份剩余清单才是当前真实状态。**下一轮不要直接引用 B2 的 §3/§4 表格**——先复验。

| 旧 ID | 复验结论 |
|---|---|
| **M-9** 空间资产绑定只写不读 | ✅ **已关闭**：`space.asset_reference_bindings`（账本 A）已删除（`spaces.ts:111` 注释记录），空间资产统一走 `recall/workspace-refs` |
| **M-2** Ability Pack 零消费者 | ✅ **已退役**（2026-08-18）：产品链删除，只留仍被出生继承真实复用的 `CapabilityPackAssetRef` |
| **N-1** 资产事件账本零写入 | ✅ **已删除**（2026-08-18）：三个文件与测试均已移除，`RecallAssetTimelineKind` 完整覆盖 |
| **N-13** `nseap-meta-skill-engine` 孤立包 | ✅ **仓库层面已关闭**：git 未跟踪；本地目录清理见 R-3 |
| **N-15** 孤儿 i18n `cognition.minimum_capability_pack` | ✅ **已删**（2026-08-18）：四语文件中该键已移除 |
| **N-17** KStar 闭合钩子空壳 | ✅ **已关闭**（前提不成立）：`p3394_bridge/executor.ts:532` 是生产调用 |
| **N-14** P3394 特性开关无消费者 | ✅ **已收敛**（2026-08-18）：9 个无消费者的开关删除，只留 `skilllifecycle` |
| **N-3** `glossary` 未进提示词 | ✅ **已修**（2026-08-18）。`selectInheritedCognition` 透传快照 `glossary`，`buildInheritedCognitionPrompt` 新增 `<inherited-glossary>` 段。**只接术语表不接 `memoryRefs`**——后者是裸 id，塞进提示词是噪音；要让记忆参与得走 recall 投影那条有内容的路径 |
| **N-5** `usageReceiptId` 装两种 id | ✅ **已关闭**（复验）。`timeline-service.ts:167` 有 `N-5:` 标注，usage 行改记 `usage_id`，不再伪装回执 id |
| **N-2** 语义复核未接 | ✅ **已关闭**（复验）。`semantic-review-gate.test.ts` 覆盖 defer/promote/degraded/LOW/幂等五种情形 |
| **N-4** `episode.k.memoryRefs` 恒空 | ❌ 仍开放：两处硬写 `[]` 仍在 |
| **G-8** 树上无「芽」 | ✅ **已实现**（2026-08-18）：契约升 v2，节点 `type` 为 `'asset' \| 'candidate'`。见 §5bis |

---

## 8. 推荐修复顺序

排序不是简单 P0 → P1 → P2，依赖关系决定了顺序：

```
第 0 步  拍板：cloud/cognition 存量 pending 记录怎么办     ← 不写代码
第 1 步  P0-M1-01  气泡入口改接主链
第 2 步  P2-M8-01  通道可达性清单进 CI
第 3 步  P1-M5-01  Ontology 写入（或删除字段）
```

**决策一 · `cloud/cognition/assets.json` 里已有的 pending 记录怎么办**

必须先定，否则第 1 步做完会留下一批孤儿数据。三个选项：

- **丢弃**（推荐）：这些记录从未被任何界面展示过，用户不知道它们存在；改完后不再新增。
  丢弃成本最低，且不需要写迁移逻辑去猜 `suggestedType`。
- **迁移**：转成 recall 候选。但候选需要 `suggestedType` / `suggestedScope` / 结构化
  `evidenceRefs`，legacy 记录都没有，必然要靠推断填——违反「不在数据库里造事实」的纪律。
- **只读导出**：给用户一次性导出，然后丢弃。折中，但要额外做一个一次性 UI。

**为什么 P0-M1-01 必须排在 P1-M5-01 前面**：气泡是最主要的沉淀入口，它不通的时候，
本体绑定做得再完整也没有资产可绑。

**为什么 P2-M8-01 插在中间而不是垫底**：它是审计工具，第 1 步做完后正好用它验证
「`cognition.assets.capture` 已无调用方」，同时防止下一轮再漏。做它的成本是一条 CI 脚本。

**红线**：
- 修气泡入口**不要给它开闸门后门**——它必须和其它五个候选生产者走同一套 `validatePromotionByAssetType`
- **不要靠删掉气泡按钮交差**。那会同时删掉「从对话里沉淀」这个核心交互，
  且和 B2 §5「不要靠藏掉入口交差」是同一条纪律
- 修 Ontology **不要按文本相似度自动推断绑定**

---

## 9. 验收标准

本 spec 整体关闭的条件：

- [x] `P0-M1-01` 全部验收项通过，且新增端到端用例覆盖 气泡 → 候选 → 资产 → 注入 → 回执
- [x] `P1-M5-01` 走通打通路径，无「留一个恒空字段」的中间态
- [x] `P2-M8-01` 的通道清单进门禁（`ipc-channel-reachability.test.ts`），能读出认知资产相关通道的 LIVE/DEAD 状态
- [x] §8 决策一有明确结论并落入代码或文档（=丢弃：不迁移、不补造事实，见 §11.1）
- [x] `G-8` 认知树「芽」实现，且唯一性不变量有自动化测试（见 §5bis）
- [x] §6「已确认正常链路」9 条在改动后重跑仍全部 PASS —— **这是本轮改动的回归底线**
- [x] `typecheck` 通过；`recall-cognition-flow.test.ts`（140/140）与 `tree-service.test.ts`（11/11）全绿
- [ ] **legacy store 整体收敛**：`listActiveCognitionSourceIds` 的历史 MEMORY 门控仍需旧 store，
      故 `userCognitionFile` 的**读**路径有意保留；写路径已清零。剩余 8 个 legacy IPC handler 见 §11.6 L-2

---

## 10. 当前闭环状态

| 能力 | 状态 | 说明 |
|---|---|---|
| Candidate | **PASS** | 六个生产者全部走 `saveRecallCandidate`；气泡入口已并入（P0-M1-01） |
| Promotion | **PASS** | 唯一晋升出口 + `validatePromotionByAssetType` 真实拦截 |
| Formal Asset | **PASS** | 字段完整、版本、证据、成熟度齐备 |
| Persistence | **PASS** | 文件落盘（`cloud/recall/records/`），重启后可读回 |
| Cognition Tree | **PASS** | 读真实 repository；契约 v2 起同时投影候选「芽」（G-8），判据复用 canPromote + 晋升闸门 |
| Ontology | **PASS**（代码/测试层） | 显式绑定入口 → `recall.assets.update` → `ontologyRefs` 落盘 → projection 消费（P1-M5-01）。真实环境 E2E 见 §12.3 |
| Runtime | **PASS** | Commander / 空间会话 + CogSeed Runtime（M-1 已接，`runtime-controller.ts:313/341/382`） |
| Reuse | **PASS** | 每回合自动投影 + 六条准入判据真实参与 |
| Receipt | **PASS**（分层） | 单机全链 PASS；跨设备由 cloud 最小 ReuseProof 承接（M-7），完整执行轨迹仍留 local |
| Contract | **PARTIAL** | 主链 `recall.*` 全 LIVE；legacy `cognition.assets.*` 的 **REST 入口已删净**，但 8 个 IPC handler 仍注册（渲染层零调用，见 §12.2 L-2） |

---

## 11. 全量销号（M / N / G / P / R）

**判定口径**（三档，不含第四档）：

- **VERIFIED** —— 代码成立 + 有自动化测试钉住 + 本轮跑绿。真实环境 E2E 另见 §12.3；
  凡依赖 E2E 才能下结论的，本表写 **VERIFIED（代码/测试）**，不写成已闭环。
- **REMAINING** —— 当前 HEAD 仍是开放问题，本轮未收口。
- **DEFERRED** —— 结论已定为"不做"或"归属别的模块/基线"，不再计入本 spec 的开放数。

### 11.1 P 系列（本轮新登记）

| ID | 判定 | 证据（caller → callee → persistence → tests） |
|---|---|---|
| **P0-M1-01** 气泡沉淀假闭环 | **VERIFIED（代码/测试）** | caller `renderer/modules/cognition/cognition.js:489` `invoke('recall.candidates.save')`（旧 `POST /api/cognition/assets/capture` 已删，同文件 :473 注释记录）→ callee `ipc/index.ts:2202` → `candidate-service.ts::saveRecallCandidate` → persistence `cloud/recall/records/candidates/*.json` → 下游 Promotion / Formal Asset / Tree / Projection 全部为既有生产链。tests `ipc-shim-cognition.test.ts`、`recall-cognition-flow.test.ts`、`ipc-channel-reachability.test.ts`（"气泡沉淀不得再经 shim 打到遗留 store"）。**旧 pending 数据按决策一=丢弃**：不迁移、不补造 `suggestedType`/`evidence`，只作历史残留 |
| **P1-M5-01** Asset → Ontology 有读无写 | **VERIFIED（代码/测试）** | caller `skills-bindings.js:1283-1299`（控件不存在时**不传** `ontologyRefs`，undefined = 不改动）→ callee `recall.assets.update` → `asset-service.ts::updateAbilityAsset` → `normalizeAbilityAssetOntologyRefs`（只接受真实存在的本体节点）→ persistence `ability-assets/*.json` `ontologyRefs` → consumer `context-projection`。UI `skills.js:3590` `_renderAssetOntologyBinding`。tests `personal-ontology.test.ts`。**红线成立**：全链无任何按 title/statement/type/category/关键词的自动推断 |
| **P2-M8-01** REST→IPC 可达性漏检 | **VERIFIED（代码/测试）** | `test/renderer/ipc-channel-reachability.test.ts` 三条不变量：① shim 路由必须有 handler（6 条既有死路由显式登记，见 R-2）② 认知资产域内 shim-only 通道必须登记（当前 `KNOWN_SHIM_ONLY` **为空**）③ 气泡不得再经 shim 打到遗留 store。**门禁生效**：新增一条即红 |

### 11.2 M 系列（B2 主链）

| ID | 判定 | 证据 / 说明 |
|---|---|---|
| **M-1** Runtime 不消费认知资产 | **VERIFIED** | `cogseed_backend/runtime-asset-context.ts::buildRuntimeAssetContext` ← `runtime-controller.ts:313 / 341 / 382`，经 Runtime 协议既有 `context` 槽下发；worker 不读 recall store（红线守住） |
| **M-2** Ability Pack 零消费者 | **VERIFIED（已退役）** | `capability-load.ts` 与 `capability-pack.test.ts` / `capability-load.test.ts` 已删；`capability-pack.ts` **只剩 `CapabilityPackAssetRef` 一个 export**（:20）。该类型仍被真实生产链复用：`agent_inheritance.ts:32/73/174` 出生继承、`recall/cognition-selection.ts:23/130`——**故意保留，不是漏删**。`mateAgentCapabilityPacksDir` 已从 `paths.ts` 移除 |
| **M-3** 边界条件不进注入正文 | **VERIFIED** | `prompt-injection.ts:196 / 276 / 477` 三处 record 构造均带 `applicableWhen`/`forbiddenWhen`（代码内 `M-3:` 标注），覆盖 Commander 投影 / committed 投影 / 派发授权 |
| **M-4** `effectiveness_validated` 不可达 | **VERIFIED**（B2 已修，本轮复验未回归） | 取证面板收 `note` + `evidenceRefs` |
| **M-5** 回执永不 complete | **VERIFIED**（B2 已修，本轮复验未回归） | 回合收尾统一 `completeReceipt` |
| **M-7** 跨设备证明链断 | **VERIFIED（代码/测试）** | 新增 `recall/reuse-proof.ts`：cloud 最小 ReuseProof（`cloud/recall/records/reuse-proofs/`）。caller `proof-service.ts:224 recordReuseProof` / `:102 readReuseProof`。**最小字段照 `receiptProvesTransfer` 反推**（receiptId / boundary / status / provenAssets），完整 execution / prompt / 原始轨迹**仍留 local**，未扩大同步面。tests `reuse-proof.test.ts` |
| **M-8** 两个候选池共用 accept 语义 | **DEFERRED** | `cognition.candidates.{list,decide}` **渲染层零调用方**；`actionsForCandidate` 对 `personal_ontology` 从不返回 `accept`。UI 上不存在两个同形 accept，无用户可见影响。归入 L-2（legacy 命名空间收敛）一并处理 |
| **M-9** 空间旧绑定账本 | **VERIFIED** | `spaces.ts:111` 注释记录 `asset_reference_bindings`（账本 A）已删除，空间资产统一走 `recall/workspace-refs` |
| **M-10** 评价控件挂在必然失败的行上 | **VERIFIED**（B2 已修，本轮复验未回归） | `_proofRatingEligibility` 与后端前置条件一一对应 |
| **M-6** | **DEFERRED** | B2 未登记该编号（M 系列为 1–5、7–10），无对应条目 |

### 11.3 N 系列（B2 非阻塞）

| ID | 判定 | 证据 / 说明 |
|---|---|---|
| **N-1** 资产事件重复账本 | **VERIFIED（已删除）** | `asset-events.ts` / `asset-view.ts` / `audit-receipt.ts` 及其测试已删；生产/消费者均为 0。覆盖它的是 `timeline-service.ts::RecallAssetTimelineKind`（LIVE，有渲染层消费）。孤立路径 `mateAgentAssetEventsDir`、**本轮补删的 `mateAgentAuditReceiptsDir`** 已从 `paths.ts` 移除（见 §12.1 冲突 C-1） |
| **N-2** 语义复核 gate 未接 | **VERIFIED** | `semantic-review-gate.test.ts` 覆盖 defer / promote / degraded / LOW-advisory / 幂等五种情形 |
| **N-3** `glossary` 未进提示词 | **VERIFIED** | `cognition-selection.ts` 透传快照 `glossary` → `inherited-cognition-prompt.ts:76-89` `renderGlossaryBlock` → `<inherited-glossary>` 段。tests `inherited-cognition-prompt.test.ts`。**只接术语表不接 `memoryRefs`**（后者是裸 id，塞进提示词是噪音） |
| **N-4** `episode.k.memoryRefs` 恒空 | **REMAINING** | `kstar/episode-builder.ts:171 / 342` 两处仍硬写 `[]` |
| **N-5** `usageReceiptId` 语义混装 | **VERIFIED** | `timeline-service.ts:49 / 167` 有 `N-5:` 标注，usage 行改记 usage_id，不再伪装回执 id |
| **N-6** type Contract 漂移 | **VERIFIED** | `ipc/index.ts:2571` 改用 `formalAssets.isFormalAssetType(type)`，不再在 IPC 层抄一份四类字面量。tests `cognition-ipc.test.ts`（四类接受 / 四个旧分类拒绝矩阵） |
| **N-7** legacy `cognition.assets.*` 命名空间 | **PARTIAL → 见 L-2** | **REST 入口已删净**（`ipc-shim.js:57-66`，门禁在 `ipc-channel-reachability.test.ts`）；8 个 IPC handler 仍注册于 `ipc/cognition.ts`，渲染层零调用。**REMAINING** |
| **N-8** `cognition.candidates.decide` 命名空间 | **DEFERRED** | 渲染层零调用方，替代通道 `recall.skills.decide` 已接。归入 L-2 |
| **N-9** Dashboard 计数被 limit 截断 | **VERIFIED**（B2 已修，即 G-2） | `recall.teaching.list` 增 `total` |
| **N-10** 时间线 usage 与 proof 视觉同级 | **DEFERRED** | 数据侧不需要动（17 个 `RecallAssetTimelineKind` 分得开），已有四层筛选缓解。纯视觉分级，不属认知资产事实源问题 |
| **N-11** 资产查不到时回退裸 ID | **REMAINING** | `skills.js:1274` 仍以 `receipt.assetId` 兜底，用户看到裸 id 而非「已删除/未同步」 |
| **N-12** 非资产分流页死路 | **VERIFIED**（B2 已修） | `recall.continuation.list/read` 已开，页面读真实快照 |
| **N-13** `nseap-meta-skill-engine` 孤立包 | **VERIFIED（仓库层面）** | git 未跟踪（0 个跟踪文件），不随仓库发布。本地目录清理见 R-3 |
| **N-14** P3394 特性开关 | **VERIFIED（已收敛）** | `p3394/flags.ts:8` 注释记录"原来 10 个开关只有 `skilllifecycle` 有读取点，**删掉而不是接上**"；当前接口只剩 `skilllifecycle`（:28 / :32），唯一消费者 `skills/skill-lifecycle.ts`。**没有**把已默认上线的能力重新接到默认 false 的 flag 上 |
| **N-15** 孤儿 i18n `cognition.minimum_capability_pack` | **VERIFIED（已删）** | 四语文件中该键已移除（见 `git diff src/renderer/locales/`） |
| **N-16** 技能版本库优先读环境变量 | **REMAINING** | `skills/version-store.ts:67-76` 仍是 `process.env.ORKAS_WORKSPACE_ROOT \|\| path.dirname(path.dirname(userLocalRoot(uid)))` 再拼一遍。**域外**（skills 模块），非认知资产事实源问题 |
| **N-17** KStar close hook 空壳 | **VERIFIED（前提不成立，条目关闭）** | B2 记「`close()` 从未被调用」。当前 HEAD `p3394_bridge/executor.ts:532` `this.kstar.close(this.sessions.close(sessionId))` 是**生产调用**（实例化点 :115）。旧结论前提已不成立，不按旧 spec 再机械修一次 |
| **N-18** 回执没有 Agent 维度 | **REMAINING** | `ContextReuseReceipt` 仍只有 `sourceSessionId` / `targetSessionId`，给不出"源 Agent → 目标 Agent"这一对。非阻塞：不影响证明链成立，只影响「使用与证明」能说清多少 |

### 11.4 G 系列（UI Gap）

| ID | 判定 | 说明 |
|---|---|---|
| **G-1** 无 loading 态 | **VERIFIED**（B2 已修） | 五页加载中与空态分开 |
| **G-2** 教学回执计数截断 | **VERIFIED**（B2 已修） | `recall.teaching.list` 增 `total` |
| **G-3** 资产列表无 total | **VERIFIED**（B2 已修） | `cognition.assets.list` 增 `total` |
| **G-4** 无「已处理」历史 | **VERIFIED**（B2 已修） | `cognition.reviewDecisions.list` |
| **G-5** 成功无正反馈 | **VERIFIED**（B2 已修） | toast 明确回执 |
| **G-6** 缺「空种子」首启页 | **VERIFIED**（B2 已修） | `_cognitionIsFirstRun` 判据取全部五类真实读模型；读取失败不算空账户 |
| **G-7** 认知树非有机可视化 | **VERIFIED**（B2 已修） | SVG 树 + 分类卡双呈现 |
| **G-8** 树上无「芽」 | **VERIFIED（代码/测试）** | 见 §5bis。契约 v2 + 7 条主进程用例 + 3 新 2 改渲染层用例，含唯一性不变量自动化测试。真实环境 E2E 见 §12.3 |
| **G-9** 一级导航 IA 收敛 | **VERIFIED**（B2 已定稿并实施） | 四个任务视图就位、落地不跳页。默认落地 `assets` / 未知兜底 `inbox`，见 R-1 |

### 11.5 R 系列（上一轮 Remaining）

| ID | 判定 | 说明 |
|---|---|---|
| **R-1** cognition route 用例红 | **VERIFIED（判定=保留 split，不统一）** | 产品决策已拍板（2026-08-18）：**保留刘婷婷当前的 assets / inbox 分工，不做统一**。落地页 = `assets`（「我的认知树」），未知 / 非法 page 兜底 = `inbox`（「待我处理」）。实现两处：`skills.js:23` `page: 'assets'`、`skills.js:352` `allowed.has(requested) ? requested : 'inbox'`。**没有为了让两者一致去改任何一边**——它们语义本就不同：落地页回答「我平时来看什么」，兜底页回答「你点到了坏链接，去处理待办」。合并前的旧架构两者同为 `tree`，一致是巧合不是设计。用例 `recall-cognition-flow.test.ts`「页面架构：落地页 assets、未知路由兜底 inbox」钉住现状 |
| **R-2** 6 条死 shim 路由 | **拆分：R-2a（真故障）+ 5 条休眠** | 逐条反查渲染层调用方后**不能一概而论**，见 §5.1 疑点 ④。5 条真休眠（`marketplace.upload{Agent,Skill}` · `workbench.{actionPlan.read,taskRun.start,taskRuns.list}`）无调用方，登记在 `KNOWN_DEAD_ROUTES`，新增一条即红 |
| **R-2a** `contexts.officeHtml` 无 handler，但有真实调用方 | **REMAINING（域外 · 用户可达故障 · 本轮新发现）** | `contexts.js:1588 → :1643 apiFetch('/api/contexts/office')` → `ipc-shim.js:81` 有路由 → 主进程**无 handler**（只有 `spaces.files.officeHtml`，`ipc/index.ts:3207`）→ invoke 抛错，且 `_showCtxOfficeViewer` 无 try/catch。**用户症状：「上下文」里打开 .docx/.xlsx/.pptx 永远转圈**。与本轮改动无关，是 REST→IPC 迁移漏迁；由新门禁照出。修法=照 `spaces.files.officeHtml` 补一个 handler。**本轮不做**（域外），交 contexts 模块认领 |
| **R-3** `packages/nseap-meta-skill-engine/` 本地目录 | **DEFERRED（无代码影响）** | git 未跟踪，本地 `rm -rf` 即可 |
| **R-4** 既有红：nightly 调度 + `ERR_DLOPEN_FAILED` | **DEFERRED（环境）** | 见 §12.4 的实测口径与数字修正 |
| **R-5** legacy store 整体收敛 | **REMAINING → 见 L-1 / L-2** | 拆成两条独立记录，见下 |

### 11.6 L 系列（legacy 收敛，本轮新登记）

| ID | 判定 | 说明 |
|---|---|---|
| **L-1** 旧 cognition store「写死读活」 | **REMAINING（有意保留，边界已钉死）** | **不能直接删。** `features/cognition/index.ts:988` `listActiveCognitionSourceIds` 仍被 `model/core-agent/runner.ts:45 / :1052` **每回合真实读取**，`memory.ts::formatForSystemPrompt` 用它门控历史 MEMORY 行的可见性。删掉会让老用户已作废的历史 MEMORY 重新进入 prompt。<br>**当前边界（四条，本轮复核成立）**：① 无任何新写入口（REST 已删）② 不参与正式资产 ③ 不进 Cognition Tree ④ 不作为 Runtime Formal Asset 注入。**它只做历史 MEMORY 兼容门控，不是第二套正式资产事实源** |
| **L-2** legacy `cognition.assets.*` IPC handler 仍注册 | **REMAINING** | `ipc/cognition.ts` 的 8 个 handler（`page/get/create/**capture**/evidence.add/confirm/defer/reuse`）仍经 `ipc/index.ts:4828` 注册（该行仅解构剔除 `cognition.assets.list`）。**REST 入口已删、渲染层零调用，用户到不了**；但通道仍在，写口仍能落进 `cloud/cognition/`。<br>**建议下一步**：在 `ipc-channel-reachability.test.ts` 加一条不变量——渲染层不得按通道名直调 legacy `cognition.assets.*` 写口——把"用户到不了"从当前事实升级成门禁。**本轮未做**（超出 G-8 范围，未擅自扩大改动） |
| **L-3** `cognition.js` 8 处 apiFetch 指向已删路由 | **REMAINING（当前不可达，无门禁）** | 见 §5.1 疑点 ①。8 个调用点命中即 404，但模块**无宿主 DOM**（`index.html` 无 `id="cognition-page"`；`[data-personal-onto-workspace-pane="growth"]` 全 renderer 仅 `cognition.js:630` 自引用）、**无外部调用方**，因此当前不可达。`ipc-shim.js:66` 的注释挡住了「恢复路由」，但没挡住「补宿主 DOM」。<br>**建议下一步**：决定这个 legacy 页面模块是删是留——留就补 handler，删就整块移除；在此之前不加门禁（加了会立刻红） |

---

## 12. 本轮执行记录

### 12.1 与交接状态不一致之处（以当前 HEAD 代码为准）

| # | 交接描述 | 当前 HEAD 实际 | 处理 |
|---|---|---|---|
| **C-1** | N-1 "已删除，并清 export / paths.ts 孤立路径" | `mateAgentAssetEventsDir` 已删，但 **`mateAgentAuditReceiptsDir` 仍在 `paths.ts`，0 调用方** | 本轮补删；同步修正 `formal-assets/policy.ts:6` 指向已删账本的过时注释 |
| **C-2** | G-8 判据 "`canPromote === true` 才显示" + "`failed` 一律不显示" | 两条**互相冲突**：`candidate-capabilities.ts` 的 `failed` 行继承 `ACTIONABLE`，`canPromote` 为 `true` | 以"不显示"为准，在 `isBudCandidate` 里作独立产品判断挡掉，注释写明；**未改** `candidate-capabilities`（会波及 inbox 计数 / 批量勾选 / 后端晋升放行）。已加测试钉住 |
| **C-3** | G-8 排除项含 `suppressed` | `RecallCandidateStatus` **没有** `suppressed` 成员 | 无需额外判据；其余终态天然 `canPromote === false` |
| **C-4** | "全域测试之前剩余 3 条红" | 认知资产相关范围（`test/main/features/recall` + `test/renderer` + `test/main/ipc`）确为 **3 条**；**全仓口径是 13 个文件 / 73 条** | 已用 `git stash` 对照复验：**去掉本轮 G-8 改动后同样是 73 条**，与本轮无关。数字差异是口径差异，见 §12.4 |

### 12.2 本轮改动清单（G-8）

```
src/main/features/recall/tree-service.ts          契约 v2 + 芽投影 + isBudCandidate（重写）
src/main/features/recall/index.ts                 新增 4 个节点类型导出
src/renderer/modules/skills.js                    _renderCognitionTreeCanvas / renderSkillsCognitionTree 画芽
src/renderer/recall-local.css                     .cognition-tree-svg-bud / .is-bud / .cognition-tree-branch-buds
src/renderer/locales/{zh,en,ja,pt}.json           +2 键，改写 tree_legend_bud_hint
src/main/paths.ts                                 删 mateAgentAuditReceiptsDir（C-1）
src/main/features/recall/formal-assets/policy.ts  过时注释修正（C-1）
test/main/features/recall/tree-service.test.ts    +7 条 G-8 用例，2 处 v1→v2 断言更新
test/renderer/recall-cognition-flow.test.ts       +3 新 / 2 改（含旧「不画芽」用例改写）
spec.md                                           §5bis · §10 · §11 全量销号 · §12
```

### 12.3 真实环境 E2E

> 见本节末尾的执行结果。**在 E2E 通过之前，§11 中标注「VERIFIED（代码/测试）」的条目
> 一律不得读作「已闭环」。**

### 12.4 测试口径

| 口径 | 结果 |
|---|---|
| `typecheck` | ✅ 通过 |
| 认知资产相关（`test/main/features/recall` + `test/renderer` + `test/main/ipc`） | **225 文件 / 2316 条 · 2 文件 / 3 红**（2026-08-18 复跑）。三条全部为既有红，**所在文件本轮 diff 未触及**：`ipc/library-write.test.ts` ×2（`better-sqlite3` `ERR_DLOPEN_FAILED`，`NODE_MODULE_VERSION 145` vs 运行时要求 `137`，环境问题=R-4）、`recall/capture-service.test.ts` ×1（nightly 调度=R-4）。条目数 2301→2316 是本轮新增用例所致 |
| IPC 门禁三件套 | ✅ `ipc-channel-reachability.test.ts` 3/3 · `ipc-shim-cognition.test.ts` 1/1 · `cognition-ipc.test.ts` 8/8 |
| `tree-service.test.ts` | ✅ 11/11 |
| `recall-cognition-flow.test.ts` | ✅ 140/140 |
| 全仓 `vitest run` | **9480 条 / 73 红 / 13 个文件**。全部为原生模块（sqlite-vec / better-sqlite3 `ERR_DLOPEN_FAILED`）与 nightly 调度。**已对照复验：stash 掉本轮 G-8 改动后仍是同样的 73 条**，与本轮无关 |

失败文件（全部为既有红）：`sqlite-memory` · `auto_tasks` · `ccswitch_import` · `contexts` ·
`kb_indexer` · `kb_vector` · `local_agents/bridge` · `messaging-owner-bind-integration` ·
`model_authorization_discovery` · `personal_context-forget` · `recall/capture-service` ·
`session_import` · `ipc/library-write` · `core-agent/kb-tools`。

---

## 本文档的边界

所有结论来自 2026-08-18 对 `CogSeed Dev.app`（版本 2026.7.2-1.3）解包代码与
`dev/shiyuxuan-cognition-ui-gap @ 261bd187` 工作区的只读交叉核对，两边文件集已 diff 一致。
本轮已运行测试套件与真实环境 E2E，口径与结果见 §12.3 / §12.4。
凡产品文档描述而代码中不存在的能力，一律记在问题里，未计入「当前实现」。
