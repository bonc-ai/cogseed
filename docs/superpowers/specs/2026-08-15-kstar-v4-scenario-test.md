# 场景测试：KStar 统一候选池 + 语义去重 + 自动闭环（用户实测版）

- 日期：2026-08-15
- 构建：`085c07a7`（Commander-Centric KStar + 统一候选池 + 语义去重 + 质量融合 + 静默窗口自动闭环）
- 目的：验证设计 v4 实施后的真实链路——lesson 进候选池、重复合并、自动闭环
- 方式：用户在 GUI 操作，我盯后台日志验证

---

## 场景 A：任务自动治理 + lesson 沉淀进候选池

### A1 发任务

**操作**：新会话，发送：

```
帮我写一份 武汉城市 的资料，500 字
```

**你可见的预期**：
- Commander 直接执行并交付约 500 字武汉资料（Markdown、注明字数）
- 全程无 `<kstar-review>` 气泡、无任何 KStar 工具提示

**后台验证**（我盯）：
```
kstar model routing verdict { isTask: true }
kstar.control upsert_state ok → request_projection ok
kstar auto-forecast committed
kstar host routing opened task
【终态后】scheduleAutoClose → task-state 写入 pendingAutoCloseAt
```

### A2 检查自动闭环窗口已排程

**操作**：什么都不做，等我确认。

**后台验证**：
```
task-state: { pendingAutoCloseAt: "2026-08-15T...30min后" }  ← 静默窗口已排程
```

---

## 场景 B：闭环沉淀 → 候选池 → 晋升资产

### B1 发第二个任务（触发旧任务闭环）

**操作**：**同一个会话**，发送：

```
再帮我写一份 长沙城市 的资料，500 字
```

**你可见的预期**：
- Commander 继续执行，交付长沙资料
- 武汉任务被自动关闭（B2 切换）——你不需要做任何事

**后台验证**：
```
kstar model routing judged NEW task; old task closed
precipitateRequirementLevel（武汉 lesson 聚合）
  → saveRecallCandidate（captureKey: kstar-...）→ 候选池
  → autoApplyRecallCandidate（语义查重）→ 晋升资产
  → ability-assets 新增（lifecycle: automatically_extracted_unverified）
```

### B2 确认资产出现

**操作**：打开左侧 **认知资产** 页面（develop 的 Recall UI）。

**你可见的预期**：
- 出现一条新资产（类型：规则/经验方法），内容含"武汉/N 字资料/字数"相关经验
- 资产的状态/来源可查（使用与证明 tab 有来源）

---

## 场景 C：语义去重（重复内容不双写）

### C1 发一个会沉淀"同规则"的任务

**操作**：新会话，发送：

```
帮我写一份 天津城市 的资料，300 字
```

（与场景 A 同类的"N 字资料"任务——会再次触发"N 字资料类请求注明字数"这条 lesson）

**你可见的预期**：
- 正常执行交付

**后台验证**：
```
第二次沉淀同语义 lesson
  → 语义查重命中已有资产（cosine ≥ 0.85）
  → 不新建资产：证据并入已有候选/资产，候选标记 mergedInto
  → ability-assets 数量不增加（仍只有武汉那条）
```

### C2 确认不重复

**操作**：回认知资产页面。

**你可见的预期**：
- 资产列表没有出现第二条"N 字资料"规则（同一规则只保留一条）

---

## 场景 D：静默窗口自动闭环（可选，需等 30 分钟）

如果你愿意等 30 分钟不操作该会话：

**操作**：场景 A 的会话保持不动 30 分钟。

**后台验证**：
```
pendingAutoCloseAt 到期 → runAutoClose → finish（auto_close_quiet）
  → task-state taskComplete: true
  → 沉淀链路自动执行
```

**你可见的预期**：无任何打扰；之后再打开认知资产页面能看到沉淀结果。

---

## 通过标准

1. A/B/C 全程无 review 气泡、无死循环、无工具提示
2. B 闭环后 lesson 进候选池并晋升为资产（`automatically_extracted_unverified`）
3. C 同规则重复出现不产生第二份资产（语义去重生效）
4. D（若测）30 分钟静默后自动闭环，无需用户操作
5. 认知资产页面能查看到沉淀的资产与来源

## 失败判定

- 资产数量重复增长 → 语义去重失效（查 similarity 阈值/embedding）
- 闭环不沉淀 → 候选池链路断（查 saveRecallCandidate/captureKey）
- pendingAutoCloseAt 未写入 → 自动闭环未排程（查 scheduleAutoClose）
- review 气泡出现 → review 隐藏失效
