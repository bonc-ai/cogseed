# 场景测试：auto-close 运行时 timer（30 分钟静默自动闭环）

- 日期：2026-08-16
- 构建：`91e572fc`（运行时 timer 修复——到期自动触发，无需重启）
- 目的：验证修复后的 auto-close 在**真实环境**到期时自动闭环沉淀
- 前置：本次场景前修复已生效（boot 13:24:02）

---

## 步骤

### 1. 发任务

**操作**：新会话，发送：

```
帮我写一份 南昌城市 的资料，500 字
```

**后台验证**（我盯）：
```
kstar host routing opened task
【回合结束】scheduleAutoClose → task-state.pendingAutoCloseAt = now + 30min
（日志无 review 回合；review 由后台推理完成）
```

### 2. 可选：中途重启（验证 recovery 按剩余时间重建）

**操作**：发完任务后任意时刻说"重启一下"。

**预期**：重启后 recovery 扫描到未过期窗口 → **按剩余时间重建 timer**（不是立即闭环、也不是丢失）。

### 3. 停手 30 分钟

**操作**：**不再发任何消息**（包括其他会话），等 30 分钟。

**你可见的预期**：无任何提示（静默闭环）。

### 4. 检查结果

**后台验证**（我盯，30 分钟后）：
```
【无需重启】timer 到期 → runAutoClose → finish
task-state: taskComplete=true, pendingAutoCloseAt 清除
review: model 方式；lesson：南昌资料相关（若有可复用经验）
候选 → 语义去重 → 资产（若 lesson 非平凡且不与既有重复）
```

## 判定

| 项 | 通过 | 失败 |
|---|---|---|
| 到期自动闭环（无重启）| 30min 后 taskComplete=true | 仍 open（timer 没触发）|
| pendingAutoCloseAt 清除 | finish 后为 undefined | 残留 |
| 沉淀 | review 存在；lesson 走候选/资产（或合理跳过）| 无 review / 卡在 created |

## 对照（修复前行为）

修复前：13:17:42 到期的任务**没有**在运行时闭环——13:18:54 重启后 recovery 才补跑。本场景验证的就是"不重启也能闭环"。
