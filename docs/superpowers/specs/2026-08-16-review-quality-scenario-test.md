# 场景测试：review 沉淀质量验证（对话历史注入后台推理）

- 日期：2026-08-16
- 构建：`930f14c5`（静默窗口 review + 后台推理注入对话历史 + forecast 确定性度量）
- 目的：验证 review 方案改动对**沉淀质量**的影响——活跃期 review 由后台推理承担（对话历史 + 确定性度量），质量是否保持、噪音是否可控
- 方式：用户在 GUI 跑 5 类任务，我跑审计脚本 + 盯后台日志对比基线
- 配套：`scripts/audit-kstar-precipitation.mjs`（质量审计）

---

## 基线（改动生效前，48h 窗口，uid 78967691）

| 指标 | 基线值 | 健康区间 |
|---|---|---|
| lesson 提取率 | 31%（211/683） | 20~60% |
| review 生成方式 | commander=673 / model=6 / unknown=3 | 改动后 model 占比应上升 |
| attribution | unclear=484(71%) / rule_gap=193(28%) / execution_gap=6 | unclear 偏高，重点观察 |
| outcome | met_expected=673(98%) | 正常 |
| 资产 type | rule=8 / skill_method=1 / template=1 | 合理 |
| kstar- 候选 | 2（confirmed=2，mergedInto=1） | 去重命中正常 |

**核心对比问题**：改动后新 review 应主要来自 `model` 方式（后台推理），其 lesson 率/归因分布/具体性要与基线 commander 方式相当或更好。

---

## 场景 A：资料/写作类（含同语义重复）

### A1 发任务

**操作**：新会话，发送：

```
帮我写一份 成都城市 的资料，500 字
```

**你可见的预期**：
- Commander 直接交付约 500 字成都资料
- 无 review 气泡、无 KStar 工具提示

**后台验证**（我盯）：
```
kstar model routing verdict { isTask: true }
kstar auto-forecast committed        ← 世界模型预测（后台）
【回合结束】terminal completed → capture 启动
```

**质量观察点**：
- review 生成方式：**期望 model**（你在 8s 内继续 → 跳过 commander；或后台推理）
- lesson 若存在：应具体（"XX 类资料：开头注明字数、按板块组织"），且**与既有"N 字资料"资产语义重复 → 触发去重融合，不产生新资产**（场景 A 的隐式验证）

### A2 快速连续第二个任务（验证活跃期不插队）

**操作**：回复后**立即**（8s 内）发送：

```
再帮我写一份 重庆城市 的资料，500 字
```

**你可见的预期**：
- 第二个任务**不被 review 回合排队阻塞**，直接开始执行

**后台验证**：
```
【第一个回合 terminal 后】8s 内检测到用户新消息 → review 跳过
kstar commander review skipped: user active during quiet window
【第二个回合正常进行】无 review 回合插入
```

**质量观察点**：
- 第一个回合的 review 由**后台推理**（model 方式）生成，带对话历史
- lesson 与既有资产去重 → mergedIntoAssetId 或证据并入

---

## 场景 B：文件/代码操作类（工具类 lesson）

**操作**：新会话，发送：

```
把我项目里这段逻辑重构一下：读取配置时如果文件不存在就返回默认值，不要抛异常。保存到 refactor.ts
```

**你可见的预期**：
- Commander 读取相关文件、重构、写出 `refactor.ts`

**后台验证**：
```
【执行回合】read_file/write_file 工具调用
【终态】terminal completed → capture → review
```

**质量观察点**（重点）：
- lesson 是否含**具体工具/步骤/触发条件**（如"配置读取用 try-catch 降级而非抛错"）——而不是"认真完成了任务"
- attribution 应贴近 `skill_gap`/`template_gap`（执行偏差），不应是 `rule_gap` 大量堆叠
- lesson 具体性：含 `read_file`/`write_file`/文件名/异常类型 → 好；泛泛而谈 → 关注

---

## 场景 C：需求中途变更类（归因准确性，重点场景）

### C1 发任务

**操作**：新会话，发送：

```
帮我写一份 天津城市 的资料，500 字，用表格形式
```

### C2 中途变更

**操作**：Commander 交付后（或执行中）追加：

```
改成散文风格，不要表格了，再加一段历史沿革
```

**你可见的预期**：
- Commander 按新要求重写

**后台验证**：
```
【回合 2】terminal → capture 2（用户活跃可能跳过 commander review）
```

**质量观察点**（核心）：
- **归因正确性**：最终结果与最初预测（表格）不同，但原因 = **需求漂移**（用户改了要求），不是执行失败
  - 期望：attribution 不应是 `execution_gap`（执行没问题）；合理的是 `unclear` 或与需求相关
  - 后台推理**有对话历史**应能识别"用户改了要求"——这是本次改动的核心价值
- lesson 若存在：应为"需求变更场景先确认新要求再执行"类，而不是"表格任务要执行得更好"（错误教训）
- **错误信号**：lesson 把需求漂移归因为执行失败 → 后台推理被确定性度量误导（弊病回归）

---

## 场景 D：委派 agent 类

**操作**：新会话，发送：

```
让 研究助手 帮我查一下 2024 年新能源汽车销量前五，整理成表格
```

（若无"研究助手"agent，换任意已装 agent）

**你可见的预期**：
- Commander 委派 agent 执行、汇总结果

**后台验证**：
```
【dispatch】dispatch_to/run_worker + ability_assets 授权
【终态】Commander 汇总 → terminal → capture
```

**质量观察点**：
- lesson 是否捕获委派相关经验（如"查数据类任务先确认数据源/时间范围"）
- 对话历史应包含委派过程（narration），归因能区分"agent 结果质量问题" vs "委派指令不清"

---

## 场景 E：简单问答（噪音控制）

**操作**：新会话，发送：

```
你好
```

（等回复后再发一条"谢谢"或普通闲聊）

**你可见的预期**：
- Commander 正常回应

**后台验证**：
```
kstar model routing verdict { isTask: false } 或 trivial 过滤
【terminal】capture → review
```

**质量观察点**（重点）：
- **不应沉淀**：问候/闲聊的 review 应无 lesson（lesson 率对 trivial 任务应为 0）或 lesson 平凡（confidence 低 → 被沉淀 gate 拦截）
- review 记录本身存在（audit trail），但 `lesson` 缺失或 confidence < 0.7
- **错误信号**：闲聊也产出 lesson → 对话历史把噪音当素材（幻觉入口）

---

## 审计与判定

### 验证命令（跑完全部场景后）

```bash
node scripts/audit-kstar-precipitation.mjs --since-hours 24
```

### 判定表

| 指标 | 通过 | 关注（需缓解） | 失败 |
|---|---|---|---|
| model 方式 review 占比 | 显著上升（>20%） | 无 model review（路径未生效） | — |
| model 方式 lesson 率 | 20~60% | 偏低(<10%) 或偏高(>70%) | 全是噪音 lesson |
| 场景 C 归因 | 需求漂移 → 非 execution_gap | 部分 execution_gap | 全部执行归因（对话历史没起作用） |
| 场景 E 闲聊 | 无 lesson / confidence 低 | 偶发 lesson | 稳定产出 lesson（噪音） |
| lesson 具体性 | 含步骤/工具/触发条件 | 半泛化 | 全泛化（"认真完成任务"） |
| 语义去重 | 场景 A 触发 mergedInto | 未触发（可能无重复资产） | 重复资产出现 |

### 缓解预案（按失败形态选择）

1. **对话过滤收紧**：只保留 user 消息 + Commander 关键消息（去状态/重试噪音）
2. **截断策略**：保留开头（需求）+ 结尾（结果）两端，中间抽样——而非纯最新优先
3. **平凡性 gate**：lesson 与 goalText 相似度过高视为平凡，模型输出后确定性拦截
4. **归因约束**：对话出现"用户变更/追加要求"信号时，禁止 attribution=execution_gap

---

## 记录区（填完场景后更新）

| 场景 | 日期 | review 方式 | lesson | 归因 | 判定 |
|---|---|---|---|---|---|
| A 成都 | | | | | |
| A2 重庆（活跃） | | | | | |
| B 重构 | | | | | |
| C 天津变更 | | | | | |
| D 委派 | | | | | |
| E 问候 | | | | | |
