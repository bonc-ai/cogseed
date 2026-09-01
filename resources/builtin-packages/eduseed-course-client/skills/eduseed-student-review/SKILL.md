---
name: eduseed-student-review
description: ① 按 rubric 维度评审他人提交（同伴评审/教师终审），评审前强制读真实代码并做评语质量预检;② 适合"帮我评审这个提交""终审张三的 C03""看看待评审的作业";③ 触发词:评审、终审、打分、反馈、待评审
---

# EduSeed 评审｜同伴评审与教师终审（Plugin 版）

本 Skill 是 EduSeed 课程客户端（Course Plugin）的评审技能，与 `eduseed-student-submit`
共用运行时 `scripts/runtime.js`。评审者读真实代码、按 rubric 反馈，结果回传平台。

## 运行时调用方式

```bash
"$COGSEED_NODE" "$COGSEED_PC_DIR/bin/run-skill.cjs" eduseed-student-review runtime -- <命令> '<JSON载荷>'
```

## 本技能常用命令

| 命令 | 评审中的用途 |
|---|---|
| `get-dashboard` | 看待评审队列/统计 |
| `get-evaluation` | 确认目标提交的 AI 初评（`{"submissionId":...}`） |
| `get-challenge` | 拿 rubric_dimensions（逐维度打分依据） |
| `submit-review` | **提交评审（唯一写入命令）**：`{"evaluatorType":"peer","submissionId","score","feedback"}` 或教师 `{"evaluatorType":"teacher",...,"action":"accept|return","submissionRecordId?"}` |

## 评审工作流

1. **确认分配** — 同伴评审：平台校验分配关系（未被分配 → 403，不要尝试评任意提交）
2. **读真实代码（强制）** — clone 到本地 worktree，用文件工具查看源码/README/提交历史；
   **不允许只读项目摘要就打分**
3. **按 rubric 打分** — 逐维度给分，汇总 0-100
4. **结构化反馈** — 每个维度一句话评语 + 具体到代码位置/函数名
5. **提交评审** — `submit-review`：
   - 同伴：`evaluatorType:"peer"`（平台校验分配关系）
   - 教师：`evaluatorType:"teacher"` + `action`（accept→COMPLETED；return→RETURNED_FOR_REVISION），走消息总线

## 评语质量预检（提交前自检）

- ✅ ≥50 字，具体到代码（"src/main.py 硬编码 API key"，不是"挺好的"）
- ✅ 有建设性建议（"建议改成环境变量"）
- ❌ 全维度满分（疑似橡皮图章，需说明理由）
- ❌ 复制粘贴模板评语

## 教师终审附加规则（教师反馈最终优先级）

- AI 初评是参考，教师裁定是权威
- 分差 >15 分时平台标注"高偏差请复核"——教师应说明调整理由
- 教师终审会由运行时自动记录 KSTAR episode（读代码/采纳建议/ΔR 视角）

## 停止规则

未被分配评审（平台 403）；代码无法访问（报告而非编造）；用户取消。

## 失败行为

never_review_without_reading_code；never_score_without_rubric；
never_fabricate_code_references；return_completed_and_uncompleted_parts

## 版本检查（skill 自动更新）

开始评审前执行 `plugin-version`：`update_required` 为 true 时先升级插件再继续；`update_available` 提示可升级。
