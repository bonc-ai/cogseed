# Companion Research Repro Demo Runbook

## 目标

使用 CogSeed 的正式 Companion Research Repro 入口演示：

```text
Paper 选区 + GitHub repo/commit + local workspace + 用户意图
→ ReferenceManifest
→ ProjectContext
→ 用户修正
→ TaskContract
→ 用户确认
→ Commander 执行
→ Evidence
```

## 准备

1. 启动 CogSeed。
2. 打开或新建一个 Commander 会话。
3. 准备固定 repo 的本地 workspace path。
4. 准备 Paper 选区文本、repo URL、commit 和用户意图。

## 演示步骤

1. 在会话顶部的 `Companion 论文复现` 卡片填写：
   - 论文标题
   - 论文选区
   - 仓库 URL
   - Commit
   - Workspace 路径
   - 用户意图
2. 点击 `保存导入`。
   - 验证 ReferenceManifest 展示 included/skipped 文件。
3. 点击 `生成 ProjectContext`。
   - 验证技术栈、项目目标、不确定项可见。
4. 填写一条修正前/修正后/原因，点击 `应用修正`。
   - 验证修正会进入证据链。
5. 点击 `生成契约`。
   - 验证 TaskContract 显示 goal、成功标准、计划、风险。
6. 在未确认前观察 `开始执行` 按钮为 disabled。
7. 点击 `确认契约`。
8. 点击 `开始执行`。
   - 系统通过现有 group chat/Commander 链路发送执行任务。
   - 若执行失败，应展示失败状态和 evidence 事件，不伪造成成功。

## 验收点

- ReferenceManifest 能说明读了什么、跳过什么。
- ProjectContext 有不确定项和修正记录。
- TaskContract 未确认前不能执行。
- 确认后执行走 Commander/group chat，不直接跑 shell。
- Evidence JSONL 存在于当前 conversation group 目录的 `companion_repro/evidence.jsonl`。

## 当前限制

- 第一版不解析整篇 PDF，只接收用户粘贴的 Paper 选区。
- 第一版不自动 clone GitHub，要求 repo 已在本地 workspace。
- 第一版不做经验复用、Replay/Eval、负迁移检测。
