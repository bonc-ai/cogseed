# 场景测试：KStar 全链路演示（一条会话跑完整个循环）

- 日期：2026-08-16
- 构建：`8e63fd90`（后台 review + 运行时 auto-close timer + 质量修复）
- 目的：把 KStar 的完整能力串成一次演示——治理开启 → 预测 → 执行 → 反思 → 沉淀 → 复用 → 自动闭环
- 方式：用户在 GUI 按步骤操作，我盯后台日志/数据验证每个环节
- 前置：应用已是最新构建（本场景前重启过）

---

## 全链路图（本次演示验证的每一环）

```
① 发任务 ──> ② host 判定(judge) ──> ③ 开任务+投影(预选资产) ──> ④ 世界模型预测(forecast)
                                                              │
⑤ Commander 执行（注入投影资产 + 引用账本）<───────────────────┘
                                                              │
⑥ 回合结束 → 后台 review（确定性度量 + 对话历史）              │
                                                              │
⑦ 任务切换/30min 静默 → 聚合沉淀 → 候选 → 语义去重 → 资产 ─────┘
                                                              │
⑧ 下次同类任务 → 投影召回该资产 → 注入 Commander（复用闭环）
```

---

## 第 1 幕：任务治理开启（②③④⑤）

**操作**：新会话，发送：

```
帮我写一份 南昌城市 的资料，500 字
```

**后台验证**（每个环节我都盯）：
```
② kstar model routing verdict { isTask: true }
③ kstar host routing opened task + request_projection（自动确认）
④ kstar auto-forecast committed（世界模型给出候选方案/预期结果）
⑤ turn-end（Commander 执行完成，events/produced 记录）
⑥ review: model 方式（后台推理，无 review 回合）
```

**你可见的预期**：
- Commander 交付约 500 字南昌资料
- 无任何 KStar 提示/工具气泡/review 卡片（全部后台）
- **回复后没有"正在输入"幽灵**（review 不占队列）

---

## 第 2 幕：中途变更（continuation + 归因）

**操作**：同一会话，追加：

```
加一段历史沿革，改成散文风格
```

**后台验证**：
```
judge → continuation: true（不关旧任务，继续）
【回合结束】新 review（对话历史识别"用户改了要求"）
归因应合理（非 execution_gap——执行没问题，是需求变了）
```

**你可见的预期**：Commander 按新要求重写。

---

## 第 3 幕：新任务触发旧任务闭环沉淀（⑦）

**操作**：同一会话，发一个**不同类型**的任务：

```
把 hello.py 里的代码改成读取配置，配置不存在就返回默认值
```

（若工作区无 hello.py 也没关系——Commander 会说明）

**后台验证**：
```
judge → NEW task; old task closed（南昌任务被闭环）
→ finish → 聚合沉淀（南昌 lesson → 候选 → 语义去重 → 资产）
【新任务】继续正常治理/执行
```

**你可见的预期**：Commander 无缝切换到新任务。

**沉淀检查**（我盯）：
- 南昌 lesson（若有可复用经验）→ 候选池 → 晋升资产（或合理跳过）
- 重构 lesson（"先确认源码存在"类，若适用）→ 候选

---

## 第 4 幕：资产复用闭环（⑧）

**操作**：新会话，再发一次同类型任务：

```
帮我写一份 武汉城市 的资料，500 字
```

**后台验证**：
```
【开任务时】投影召回第 3 幕沉淀的"城市资料"资产（语义匹配）
【执行时】该资产注入 Commander 回合（promptBlock + 引用账本）
【回合结束】recall 引用记录（citation usage ledger）
```

**你可见的预期**：Commander 直接凭经验交付（若资产建议"跳过信息收集步骤"，执行会更快/更顺）。

**这就是"沉淀 → 复用 → 再沉淀"的闭环**：第 3 幕沉淀的经验，第 4 幕被实际使用。

---

## 第 5 幕（可选）：30 分钟静默自动闭环

**操作**：跑完第 4 幕，**停手 30 分钟**。

**后台验证**：
```
【无需重启】timer 到期 → finish → 聚合沉淀（武汉 lesson）
task-state: taskComplete=true, pendingAutoCloseAt 清除
```

---

## 判定总表

| 环节 | 通过标准 |
|---|---|
| ② 路由判定 | verdict isTask=true + opened task |
| ③ 投影 | request_projection ok（自动确认）|
| ④ 预测 | auto-forecast committed（2-4 候选）|
| ⑤ 执行注入 | Commander 回合带投影资产（recall promptBlock）|
| ⑥ 后台 review | model 方式、无 review 回合、无幽灵输入 |
| ⑦ 闭环沉淀 | 旧任务 finish → 候选 → 资产（或合理跳过）|
| ⑧ 复用 | 第 4 幕投影召回第 3 幕资产 + 引用记录 |
| auto-close | 30min 到期自动闭环（可选）|

## 备注

- 若某环节 lesson 被语义去重合并（mergedIntoAssetId）——**也是通过**（去重在工作）
- 若第 4 幕资产未被召回（投影没匹配）——检查 scope/语义，可能需校准阈值
- 全程无 KStar UI 打扰（review 卡隐藏、工具气泡不存在、自动闭环静默）
