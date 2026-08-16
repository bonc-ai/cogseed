# 场景测试 v2：后台 review 沉淀质量验证（Commander review 已移除）

- 日期：2026-08-16
- 构建：`2ea90030`（review 彻底后台化——独立 runner + forecast 确定性度量 + 对话历史；Commander review 回合已删除）
- 前情：v1（静默窗口方案）实测失败——review 回合照发占队列、8 个 Commander review 全部 lesson=None（重构类任务的明显教训也不沉淀）。本次验证纯后台推理路径
- 方式：用户在 GUI 跑任务，我盯后台日志 + 审计脚本
- 配套：`scripts/audit-kstar-precipitation.mjs`

---

## 方案要点（v2 与 v1 差异）

| | v1（已废弃） | v2（当前） |
|---|---|---|
| review 来源 | Commander 回合（8s 静默窗口后） | **纯后台推理**（ephemeral runner） |
| 队列影响 | 每回合后占队列 8-10s | **零**（独立 runner，永不入 Commander 队列） |
| 期望基准 | Commander 凭记忆 | **forecast rHat 确定性对比**（reconcileWorldModel） |
| 情境 | Commander 记忆 | **对话历史**（最新 40 条/6KB，注入模型归因） |
| lesson 产出 | 实测 0% | 待验证（期望重构类任务有产出） |

---

## 基线（v1 实测：8 个 review 全部 commander 方式）

| 指标 | v1 实测 | v2 期望 |
|---|---|---|
| review 生成方式 | commander=8 | **model 为主**（inferenceMethod='model'） |
| lesson 提取率 | **0%**（8/8 无 lesson） | 出现非平凡 lesson（尤其重构类） |
| review 回合占队列 | 每回合 +8-10s | **无 review 回合**（日志无 review 请求） |
| attribution | 全 unclear | 需求漂移场景 ≠ execution_gap |

---

## 场景 A：资料类（去重 + lesson 具体性）

### A1 发任务

**操作**：新会话，发送：

```
帮我写一份 广州城市 的资料，500 字
```

**你可见的预期**：
- Commander 直接交付约 500 字广州资料
- **回复后不再出现"正在输入"幽灵**（无 review 回合）

**后台验证**（我盯）：
```
【回合结束】terminal completed → capture（后台推理启动，无新回合）
【日志】无 kstar_review_request / 无额外 turn-start
【review】inferenceMethod='model'
```

**质量观察点**：
- review 生成方式 = **model**（不是 commander）
- lesson：若产出应为"N 字资料"类（与既有资产同语义 → **语义去重触发 mergedIntoAssetId**，不新建资产）
- 若 lesson=None 也接受（routine 任务）——**关键是不再出现"幽灵回合"**

---

## 场景 B：重构类（核心验证——确定性度量算出 gap）

**操作**：新会话，发送（源码不存在也没关系，按原样发）：

```
把我项目里这段逻辑重构一下：读取配置时如果文件不存在就返回默认值，不要抛异常。保存到 refactor.ts
```

**你可见的预期**：
- Commander 核查工作区后说明无法凭空重构（索要源码）——或真重构成功（取决于工作区）

**后台验证**：
```
【review】model 方式
【delta】若未交付重构 → deltaR 应 < 0（worse_than_expected）而非 met_expected
【lesson】期望产出"重构类任务先确认源码存在/先读取当前实现再动手"
```

**质量观察点**（**核心**）：
- v1 的 Commander review 对同一任务给了 `met_expected` + 无 lesson（自评"处置得体"）
- v2 的确定性度量**以 forecast 为基准**：用户要"重构交付"，实际"未交付" → gap → **worse_than_expected**
- lesson 若产出"先确认源码存在"→ **v2 方案成功**（确定性度量 > 执行者自评）

---

## 场景 C：需求中途变更（归因准确性）

**操作**：新会话发送：

```
帮我写一份 西安城市 的资料，500 字，用表格形式
```

交付后追加：

```
改成散文风格，不要表格了，再加一段历史沿革
```

**你可见的预期**：
- Commander 按新要求重写

**质量观察点**：
- 变更后的 review：delta 可能非零（结果与最初 forecast 不同）——**归因不应是 execution_gap**（执行没问题，是需求变了）
- 对话历史应让模型识别"用户改了要求" → attribution 合理（unclear/knowledge_gap 可接受，execution_gap 是错误信号）
- lesson 若产出：应为"需求变更场景先确认新要求"类

---

## 场景 D：委派 agent 类

**操作**：新会话，发送：

```
让 研究助手 帮我查一下 2024 年新能源汽车销量前五，整理成表格
```

（若无该 agent 换任意已装 agent）

**质量观察点**：
- 委派场景的 review 正常（model 方式）
- lesson 若产出：委派相关经验（如"查数据先确认数据源/时间范围"）
- **注意**：若 agent 需要交互授权，任务可能挂起——review 应记录"episode 停留在等待授权"且不沉淀错误教训

---

## 场景 E：简单问候（噪音控制）

**操作**：新会话，发送：

```
你好
```

**质量观察点**：
- review 存在（audit trail）但 **lesson 应为空**（问候无沉淀价值）
- 若产出 lesson → 噪音（对话历史被当素材），需上平凡性 gate

---

## 场景 F：快速连续消息（验证完全不插队）

**操作**：同一会话，发任务后**立即**（几秒内）发下一条：

```
帮我写一份 深圳城市 的资料，500 字
再写一份 杭州城市 的资料，500 字
```

（或分两条快速发送）

**你可见的预期**：
- 两条都直接执行，**第二条不被任何 review 排队**（v1 会插一个 review 回合）

**后台验证**：
```
【两条消息间】无 kstar_review_request、无 review 回合 turn-start
【两个回合】连续两个用户回合
```

---

## 审计与判定

### 验证命令

```bash
node scripts/audit-kstar-precipitation.mjs --since-hours 24
```

### 判定表（v2）

| 指标 | 通过 | 关注 | 失败 |
|---|---|---|---|
| review 生成方式 | model 为主 | 混合 | 仍全 commander（路径未生效） |
| review 回合 | 无（日志无 review 请求） | 偶发 | 每回合都有（删除不彻底） |
| lesson 率（任务型） | 出现非平凡 lesson | 极低 | 全无（同 v1，推理没起作用） |
| 场景 B delta | 未交付 → worse_than_expected | met_expected（度量失效） | — |
| 场景 C 归因 | 非 execution_gap | 部分 | 全 execution_gap（对话历史没起作用） |
| 场景 E 问候 | lesson 空 | 偶发 lesson | 稳定产出（噪音） |
| 语义去重 | 场景 A 触发 mergedInto | 未触发 | 重复资产 |

### 缓解预案（按失败形态）

1. **lesson 平凡性 gate**：lesson 与 goalText 相似度过高 → 判定平凡，拦截
2. **对话过滤收紧**：只留 user + Commander 关键消息（去状态/重试噪音）
3. **截断策略**：开头（需求）+ 结尾（结果）两端保留，中间抽样
4. **归因约束**：对话含"用户变更/追加"信号时禁止 execution_gap

---

## 记录区

| 场景 | 日期 | review 方式 | delta | 归因 | lesson | 判定 |
|---|---|---|---|---|---|---|
| A 资料类（成都/重庆）| 08-16 12:41-12:47 | model | met_expected | unclear | "知名城市资料直接凭内部知识组织，跳过信息收集步骤" | ✅ |
| B 重构（源码缺失）| 08-16 12:45/12:46 | model | met_expected | execution_gap/unclear | "工作区无源码时提供通用实现+标注调整点+询问对齐；区分运行时验证与静态类型检查" | ✅ |
| C 歧义请求（郑州资粮）| 08-16 12:47 | model | **worse_than_expected** | execution_gap | "请求歧义时先澄清意图再产出（资粮≠城市资料）" | ✅ |
| D 委派 | v1 已测（commander 无 lesson）；v2 未重跑 | — | — | — | — | 待补 |
| E 问候 | 08-16 12:46 | — | — | — | **lesson 空**（无噪音沉淀）| ✅ |
| F 快速连续 | 08-16 12:41-12:47 | — | — | — | — | ✅ 日志 0 次 review 请求 |
| 全局 | 修复后 4 条新 review | model=3, unknown=1 | — | execution_gap=2 | 3/4 有 lesson（v1 为 0%）| ✅ |

### 实测结论（2026-08-16 12:41-12:47，构建含 forecast 解包修复 ac02dc22）

- **无 review 回合**：日志 0 次 kstar_review_request（v1 每回合 +8-10s 排队 → 消除）
- **lesson 产出恢复**：3/4 新 review 有非平凡 lesson（v1 为 0%）；含"工作区无源码→通用实现+标注+询问对齐"、"歧义请求先澄清"等具体教训
- **确定性度量捕捉执行者盲区**：歧义任务（资粮）度量出 worse_than_expected + execution_gap——v1 的 Commander 自评会判 met_expected
- **噪音控制**：问候无 lesson；证据不足（导入会话继续指令）→ unknown/conf 0 不沉淀
- **已知小瑕疵**：lesson 语言不稳定（中文/英文混合，随模型输出）；对话历史截断参数未校准
