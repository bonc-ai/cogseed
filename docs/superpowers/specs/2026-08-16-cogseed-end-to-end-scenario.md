# CogSeed 全功能端到端场景 —— 一个产品经理的两周

- 日期：2026-08-16
- 构建：`6c85649a`（develop）
- 定位：把开源项目 CogSeed 的所有功能，串进**一个连续、有情节的完整场景**——一个产品经理从安装到跨 Agent 复用、再到系统主动干活的完整旅程
- 用途：给新人/评审/演示一条可以照做的主线；每条剧情后标注 `【功能模块】` 便于追溯

---

## 角色与背景

**陈屿**，一家 B 端 SaaS 公司的产品经理，也是典型的高频多 Agent 工作者：白天用 Codex / Claude Code 写 PRD 和原型，晚上还要推进一个「费用管理」模块的交付。他最大的痛点是——**经验散落在不同工具的会话里，换一个工具就接不上**。

这两周，陈屿要用 CogSeed 完成三件事：

1. 把散落在 Codex / Claude Code 里的历史经验收回来；
2. 和 Commander 团队协作，把「费用管理」模块从需求推进到可演示原型；
3. 让系统在他不盯着的时候，也能定时干活、复盘、把经验沉淀成自己的资产。

下面按时间线推进。

---

## 第一幕：第一天 · 从零起步

### 1.1 装好、点开、认识它

陈屿 `./run.sh` 启动 CogSeed，第一次进入时弹出了三步引导【onboarding】：

- 第 1 步「认识 CogSeed」：一句话讲清楚这不是又一个 Agent，而是「跨 Agent 的个人能力资产层」；
- 第 2 步「检测本地 Agent」：系统真的去探测本机已装的 Claude Code / Codex（`localAgents.list`），没装就诚实显示不可用，绝不伪造数据；
- 第 3 步「隐形匹配工作空间」：不再让他手动挑角色，而是根据导入的会话自动建议模板，复用或新建工作空间；没建议就落到「临时空间」。

陈屿明白了：**先进入真实工作，再逐步显露结构**。

### 1.2 把模型接上

陈屿打开 **设置 → 模型授权**【model-authorization】。他有三个选择：

- OAuth 登录（走 Server 授权）；
- 手动填 API Key；
- 从本机 **CC Switch** 数据库导入已存好的模型凭据——导入前会展示**脱敏结果**，原始 Key 永远不进 renderer【ccswitch_import】。

他选了 CC Switch 导入，测试授权、发现可用模型、设好默认模型，再给 Commander 和不同 Agent 绑定授权。**模型是大家的，但账号和认知是自己的。**

### 1.3 把历史经验收回来

首页三个价值动作里，陈屿点了「**继续之前的工作**」【continue-work / session_import】：

1. 选来源：Claude Code / Codex / Claude 桌面版；
2. 勾选要续接的会话；
3. 导入——每个会话被提炼成一段可续接的简报，并顺带提取出候选认知（personal / rule / template 三类）。

如果有会话因为没配模型而只能存原始开头，界面会诚实标注「已导入 · 未提炼」，而不是假装成功。

> **到这里用到的功能**：onboarding、model-authorization、ccswitch_import、continue-work、session_import、local-agents 检测。

---

## 第二幕：第二天 · 建立空间，开始多 Agent 协作

### 2.1 建一个「空间」来装这次交付

陈屿在 **空间** 页【spaces】新建了一个「云图费用模块」空间。空间 = 主界面 + 资源作用域限制，把本体、Skill、Task Agent 都圈定在这个持续目标里。广场视图是卡片网格，详情视图分「资源 tab」和「本体 tab」。

### 2.2 Commander 接管目标，拆计划、派活

陈屿在这个空间里开了会话，只发了一句目标：

> 「把『费用管理』模块从现状推进到可演示：先梳理需求，再出 PRD，最后做一个可点击原型。」

**Commander** 理解了目标，维护一张共享计划【plan-rail】，并开始用结构化的 `dispatch_to` 分派任务【group_chat / commander_backend】。陈屿能实时看到：成员状态、工具过程、产物、任务交接——每个 worker 只读自己的可见性切片，不读完整群聊。

### 2.3 把本机的 Codex / Claude Code 拉进协作

Commander 判断「写 PRD」和「搭原型」需要编码能力，于是分派给**本地 CLI Agent**【local_agents / interactive-cli】：

- Codex / Claude Code / OpenCode / OpenClaw / Hermes 作为受控子进程接入；
- 工作目录、环境变量、会话恢复、文件变更证据统一由主进程管理；
- 陈屿能在**终端面板**【terminal-panel】里看到 CLI 的输出和交互。

### 2.4 把产品资料放进知识库

陈屿把历史 PRD、竞品分析、客户访谈纪要放进**知识库**【contexts / kb-picker】：

- 源文件是可同步的私有数据；
- 派生索引、向量库、模型缓存留在本机【kb_indexer / kb_vector】；
- Agent 只能通过知识库工具访问这些上下文，不能直接扫描目录。

### 2.5 接一个外部连接器

陈屿想读取飞书里的会议纪要和需求讨论，于是进**连接器**【connectors / connections】用 OAuth 接入了飞书【messaging / feishu-registration】。工具通过 umbrella meta-tools 暴露给模型，而不是把每个动作摊平成扁平工具列表。

### 2.6 产出第一个可点击原型（Artifact）

Commander 派出的 Agent 产出了一个 HTML 原型，作为 **Artifact**【chat-artifact】落到会话里。陈屿直接在 `chat-app://` 沙箱里点开原型【artifact-security】：原型能看能点，但拿不到 `window.cogseed`、拿不到 IPC，也不能越界读文件。原型里的反馈会作为一条普通用户消息回到会话。

> **到这里用到的功能**：spaces、conversation、plan-rail、group_chat、commander_backend、local_agents、interactive-cli、terminal-panel、contexts、kb-picker、kb_indexer、kb_vector、connectors、connections、messaging、chat-artifact、artifact-security。

---

## 第三幕：第三天 · 把经验沉淀成资产

### 3.1 系统提出候选，陈屿做决定

任务跑完，陈屿打开**认知沉淀 → 待确认候选**【recall / cognition】。系统从会话、执行评估、用户教学信号里**只提出候选**，每一条都带来源、类型、作用域和不确定性。陈屿逐条处理：**确认 / 修改 / 拒绝 / 暂缓**【recall.candidates.*】。

（这一条是 PRD 的硬契约：**候选由系统提出，正式资产由用户决定**。）

### 3.2 四类正式资产

确认后的候选按内容分流进**四类能力资产**【skills / recall-information-architecture】：

| 类型 | 对应 PRD | 陈屿这次确认的例子 |
|---|---|---|
| `personal` | 关于我 | 「我负责云图费用模块的产品决策」 |
| `rule` | 规则与偏好 | 「PRD 必须保留唯一编辑源和版本记录」 |
| `template` | 模板与范例 | 「费用模块 PRD 的章节骨架」 |
| `skill_method` | 技能与方法 | 「需求澄清 → 原型验证」的工作流程 |

每条资产都有稳定 ID、版本、scope policy、审计记录，状态是「已确认，尚未验证」。

### 3.3 补全「关于我」与个人上下文

陈屿进**个人本体**【personal-ontology】维护「关于我」的概念、规则和长期关系；又在**个人上下文中心**【personal-context-center / personal-context-review】里复核系统抓到的个人事实，批准或纠正。

### 3.4 KSTAR 复盘：这次任务学到了什么

后台 **KSTAR** 记录了这次任务的需求、执行事实、review 和能力缺口【kstar】。复盘里，陈屿能看到这次任务「预期 vs 实际」的差异和归因——但按 PRD 契约，KSTAR 只产生**进化候选**，不自动改写正式资产。

> **到这里用到的功能**：recall（capture / candidate）、cognition、skills、recall-information-architecture、personal-ontology、personal-context-center、kstar。

---

## 第四幕：第四天 · 跨 Agent 接续与效果证明

### 4.1 打一个「最小能力包」带走

陈屿想把这次沉淀的能力带到另一台机器 / 另一个 Agent 上继续。系统从**已确认资产**组装一个**最小能力包**【capability-pack】——只装引用（`asset_id + version`），不复制内容，带 Main Skill、规则、模板、本体切片，24 小时有效，指向目标 Agent。

### 4.2 跨 Agent 接续 + 传递证明

目标 Agent 真实加载能力包，产出第一个 Action Plan。CogSeed 生成 **ContextReuseReceipt**【context-reuse-receipt】作为**传递证明**——记录 `reusedRefs`（带上了什么）、`omittedRefs`（刻意没带什么）、权限模式、边界（real / degraded / test-double）。

这时的资产成熟度从「已确认，尚未验证」升到「**已成功带入（Transfer Verified）**」【proof-service / p3394-observability】。陈屿在「使用与证明」页能看到这次带的是哪一版、带入结果如何。

### 4.3 结果评价 + 有效性证明

任务完成后，系统做**有效性证明**：Baseline / Treatment / BehaviorDiff 只允许一个变量变化【behavior-contrast】。陈屿判定结果：

- 若 `better` → 资产升到「已验证有效（Effectiveness Validated）」；
- 若 `worse` → 系统建议**暂停**，`rework` → 建议**返工**；未经确认不默认继续用。

陈屿这条「需求澄清→原型验证」工作流，结果更好，资产成熟度升级，且全程有**单一事件账本**【asset-events】可回溯——先落事件，再更新界面。

> **到这里用到的功能**：capability-pack、context-reuse-receipt、proof-service、behavior-contrast、p3394-observability、asset-events、audit-receipt。

---

## 第五幕：第五天 · 让系统主动干活

### 5.1 从市场装一个现成的 Skill

陈屿打开**市场**【marketplace】，从内置/社区内容里挑了一个「会议纪要 → 需求」的 Skill 装进本地【marketplace_installs / skills-bindings】。装完就能在协作里被调用，不用自己从零写。

### 5.2 定一个定时任务

陈屿在**定时任务**页【auto / auto_tasks】创建了一个任务：**每个工作日早上 9 点，汇总昨天的产品进展，发一条日报**。任务 = 内容 + 调度 + 可选项目作用域，由主进程内置调度器在到点时通过 `groupChat.send` 触发。

### 5.3 记忆与全局搜索

陈屿在**记忆**页【memory】看到自己的 `USER.md`（用户画像）和 `MEMORY.md`（共享笔记），可以导入导出、看字符额度。想找任何东西时，按 **Cmd+K** 全局搜索【search】——一次搜资料库 + 聊天历史，按 chat / agent / skill / context 分组，点一下直达来源。

### 5.4 系统的自我复盘

陈屿没盯着的这段时间，**复盘编排器**【reflection-orchestrator】在后台周期性地对每个 Agent 做元认知复盘：有冷却、有脏标记门控、每周期有上限，产出对 Agent 表现的反思，供下次协作参考。

> **到这里用到的功能**：marketplace、marketplace_installs、skills-bindings、auto、auto_tasks、memory、search、reflection-orchestrator、metacognition。

---

## 第六幕：第六天 · 接入真实世界

### 6.1 让外部消息进群聊

陈屿把**飞书/企微**的消息接进正常群聊调度链路【messaging】：外部同事在飞书里提的需求，会作为一条消息进到对应会话，由 Commander 统一路由、分派、回复。全程走同一套权限和可见性边界。

### 6.2 顺手把报销做了

陈屿打开**职场事务工作台**【expense-workbench】，用内置的报销 Agent 整理报销材料：材料、个人情况、规则和模板形成一个待提交的报销包（开源版不直接提交企业系统）。报销明细和附件留在正常会话里。

### 6.3 生成一段演示视频

陈屿要用一段短视频向老板演示原型。他用了**视频生产**【video_studio】能力：基于本地 FFmpeg / Whisper，把原型操作和语音讲解合成一段演示视频，附带质量检查（qa / html_check）。

### 6.4 同步与手机远程查看

晚上回家，陈屿登录 **Hub 账号**【hub-account / cogseed_backend】，把云数据（会话、资产、上下文）同步走；手机上通过 **Relay / Touchpoints**【touchpoints】远程看进度、发指令——iOS 只做遥控，真正的活还是 PC 上的 Agent 在干。

### 6.5 权限与安全一直在兜底

整个过程里，**权限中心**【permissions / local_access_policy / granted_roots / file-operation-policy】在把关：文件类工具先过 path-sandbox，高危命令要确认【bash_permission】，敏感字段在日志和遥测里被脱敏。

> **到这里用到的功能**：messaging、expense-workbench、video_studio、hub-account、cogseed_backend、touchpoints（relay）、permissions、bash_permission、file-operation-policy、path-sandbox。

---

## 收尾：两周后，陈屿得到了什么

1. **能力属于自己**：散落在 Codex / Claude Code 的经验，经过确认、复用、效果证明，变成了跨 Agent 可携带的资产；
2. **换工具能接上**：一个最小能力包 + 传递证明，就能在另一个 Agent 继续，不用重新解释；
3. **系统主动干活**：定时日报、后台复盘、外部消息接入，不用他一直盯着；
4. **每一笔都可信**：资产有来源、版本、作用域、审计账本和回滚入口，认知树的成长不造假。

---

## 附录：功能覆盖清单（供演示时逐项勾选）

| 幕 | 功能模块（模块/目录） | 状态 |
|---|---|---|
| 一 | onboarding / model-authorization / ccswitch_import / continue-work / session_import | ✅ |
| 二 | spaces / conversation / plan-rail / group_chat / local_agents / terminal-panel / contexts(kb) / connectors / messaging / chat-artifact | ✅ |
| 三 | recall / cognition / candidate-review / skills(四类资产) / personal-ontology / personal-context-center / kstar | ✅（KStar 自动沉淀线见下） |
| 四 | capability-pack / context-reuse-receipt / proof-service / behavior-contrast / p3394-observability / asset-events | ⚠️ 端到端 UI 部分待接线 |
| 五 | marketplace / auto(auto_tasks) / memory / search / reflection-orchestrator | ✅ |
| 六 | messaging(feishu/wecom) / expense-workbench / video_studio / hub-account / cogseed_backend / touchpoints(relay) / permissions / bash_permission | ⚠️ 部分依赖 hosted/外部系统 |

> 状态含义与上一条「Golden Path 演示」文档一致：✅ 后端+IPC+渲染层已接线；⚠️ 后端具备、端到端 UI 或真实外部链路未完全接线。KStar 的「候选 → 用户确认」与「自动沉淀」两条线的口径差异，参见 `2026-08-16-cogseed-golden-path-demo-scenario.md` 第 8 节。
