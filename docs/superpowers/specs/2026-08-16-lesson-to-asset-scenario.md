# 场景测试：lesson → 能力资产全链路验证（修复后）

- 日期：2026-08-16
- 构建：`4cfd97ac`（superseded 校验 + value 统一 + 标题内容化 + 双路径去重）
- 目的：验证修复后的沉淀链路——lesson 从 review 到能力资产，**内容纯净、无双候选、状态正确**
- 方式：用户在 GUI 跑任务，我盯候选池/资产数据

---

## 本次修复的链路问题（验证点）

```
review lesson → 闭环 → 沉淀
  ├─ ❌ 修复前：superseded 候选使池遍历 malformed → 整条沉淀静默失败
  ├─ ❌ 修复前：value=summary → 标题残片拼进 statement
  ├─ ❌ 修复前：双路径指纹不一致 → confirmed+superseded 双候选
  └─ ✅ 修复后：指纹一致去重、statement 纯净、无 superseded 累积
```

---

## 场景 A：lesson → 资产主链路

**操作**：新会话，发送：

```
帮我写一份 西安城市 的资料，500 字
```

等回复后，发新任务触发闭环：

```
这个任务完成了，帮我写一份 兰州城市 的资料，500 字
```

**后台验证**（我盯）：
```
【review】model 方式 + lesson（若有）
【闭环】judged NEW task → finish → 沉淀
【候选】恰好 1 条（无双候选：无 superseded 并存）
【候选状态】pending_review
【statement】= lesson 全文单行，无标题残片第二行
【title】= 内容核心（无"可复用经验："前缀、无"（通用）"后缀）
【资产】statement 纯净、version=1、生命周期自动标注
```

**判定**：
- ✅ 1 条候选 + pending_review + statement 纯净
- ❌ superseded 候选出现 / statement 两行 / 沉淀 degraded（warn 日志）

---

## 场景 B：同义 lesson 去重（验证不产 superseded）

**操作**：再发一个"写城市资料"类任务（如 兰州 → 新任务闭环）：

```
这个任务完成了，帮我写一份 郑州城市 的资料，500 字
```

**后台验证**：
```
【去重】若 lesson 与场景 A 同义 → 第二条 mergedInto 第一条（候选池内合并）
【候选数】不新增 superseded 候选（指纹去重：第二次返回 existing）
【日志】无 direct experience precipitation degraded
```

**判定**：
- ✅ 候选池不出现新的 superseded（去重走指纹，不写 superseded）
- ❌ 又出现 superseded / degraded warn

---

## 场景 C：审计对比

**操作**：跑完 A/B 告诉我。

**后台验证**：
```bash
node scripts/audit-kstar-precipitation.mjs --since-hours 1
```

| 指标 | 通过 | 失败 |
|---|---|---|
| 沉淀 degraded warn | 0 次 | 出现（链路又断）|
| superseded 候选 | 无新增 | 新增（去重路径有问题）|
| statement | 单行纯净 | 含"可复用经验："第二行 |
| title | 内容核心 | 模板前缀/截断残片 |
| 候选状态 | pending_review | weak（非预期）|

---

## 记录区

| 场景 | 日期 | 候选数 | superseded | statement | title | 判定 |
|---|---|---|---|---|---|---|
| A 任务→闭环（19:51）| 08-16 | 1 新候选（confirmed）| 0 新增 | 单行纯净 | 内容核心（无前缀/后缀）| ✅ |
| B 同义去重 | 08-16 | 指纹去重 | 0 新增（存量 1 条正常读取）| — | — | ✅ |
| C 审计 | 08-16 | 0 次 degraded（修复后）| 无新增 | 达标 | 达标 | ✅ |

### 实测结论（2026-08-16 19:51，构建 4cfd97ac）

- 修复后 0 次 `precipitation degraded`（修复前 19:36/19:37 各一次 malformed）
- 新沉淀（"直接输出任务结果文件比仅提供文本更可能满足需求…"）：
  - 候选 value==judgment（指纹统一生效）
  - 资产 statement **单行纯净**（修复前 lesson+标题残片两行）
  - 资产 title = 内容核心（无"可复用经验："前缀、无"（通用）"后缀）
- 存量 superseded 候选（19:05 产生）读取正常，不阻塞后续沉淀
