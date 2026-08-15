# 场景测试：合并后 Commander-Centric KStar 全链路（用户实测版）

- 日期：2026-08-15
- 构建：`e9ae7a14`（develop 39 提交 + commander-centric-kstar 25 提交 + 合并修复）
- 目的：验证我们开发的功能在合并 develop 后完整可用，且 review 不再打扰用户
- 方式：用户在 GUI 操作，后台盯日志验证

## 前置

- 实例已重启到 e9ae7a14，启动健康
- 建议新建一个会话开始（避免旧会话干扰）

---

## 场景 A：任务自动治理 + 世界模型预测 + 执行

### A1 发任务

**操作**：新会话，发送：

```
帮我写一份 成都城市 的资料，500 字
```

**你可见的预期**：
- Commander 直接开始执行并交付约 500 字成都资料（Markdown）
- **不会**出现任何 `<kstar-review>{...}</kstar-review>` 气泡
- **不会**出现任何 kstar_control / forecast 相关提示

**后台验证**（我盯日志）：
```
kstar model routing verdict { isTask: true }
kstar.control upsert_state ok
kstar.control request_projection ok
kstar auto-forecast committed { candidateCount: 2-4 }
kstar host routing opened task
```

### A2 确认执行完成

**操作**：等 Commander 交付完资料。

**你可见的预期**：
- 交付文本开头注明实际字数（如"497 字"）
- 无 review 气泡、无循环刷屏

---

## 场景 B：闭环沉淀 + 复用

### B1 发第二个任务（触发旧任务闭环）

**操作**：**同一个会话**，发送：

```
再帮我写一份 杭州城市 的资料，500 字
```

**你可见的预期**：
- Commander 继续执行，交付杭州资料
- 第一个任务（成都）被自动关闭并沉淀——你**不需要做任何事**
- 依然没有 review 气泡

**后台验证**：
```
kstar model routing judged NEW task; old task closed
precipitateRequirementLevel（成都任务的 lesson 沉淀为 rule 资产）
kstar auto-forecast committed（杭州任务）
```

### B2 验证复用（可选，最直观）

**操作**：再发第三个任务：

```
帮我写一份 广州城市 的资料，500 字
```

**你可见的预期**：
- Commander 依然注明字数 + Markdown + 板块结构（说明沉淀的"N 字资料"规则被投影复用）
- 交付质量与之前一致或更好

---

## 场景 C：归因不明的 lesson 也能沉淀（我们修的质量 bug）

### C1 发一条会被复盘的任务

**操作**：新会话，发送：

```
帮我总结一下这个项目的架构，输出一份简要报告
```

**你可见的预期**：
- Commander 执行并交付报告
- **全程无 review 气泡、无候选卡打断**

**后台验证**：
- review 记录 `attribution: unclear` + `lesson` 存在
- 闭环后 lesson 沉淀为 `rule` 资产（修复前会被 gate 卡死）

---

## 通过标准

1. A/B/C 全程无 `<kstar-review>` 气泡、无死循环、无 kstar_control 相关工具提示
2. 每次任务：routing → auto-forecast → 执行 全自动，用户零介入
3. 任务切换时旧任务自动沉淀，资产 lifecycleStatus 为 `system_precipitated_unverified`（诚实状态）
4. 第三个任务能观察到沉淀规则被复用（字数标注 + Markdown）

## 失败判定

- 出现 review 气泡 → review 隐藏失效（查 system_kind 打标）
- 任务切换不沉淀 → 闭环链路断（查 precipitateRequirementLevel）
- auto-forecast 一直失败 → runner 问题（查 `kstar auto-forecast runner failed` 日志）
- 实例崩溃 → run.sh 或合并回归（查启动日志）
