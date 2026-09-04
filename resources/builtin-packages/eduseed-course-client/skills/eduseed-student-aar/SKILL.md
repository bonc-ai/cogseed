---
name: eduseed-student-aar
description: ① 按七维模板引导课后 AAR 复盘并产出 KSTAR 学习信号（学到了什么/流程/与AI协作/完成了什么/卡点与突破/改进方向/ΔR归因），配合学习记录工具回顾证据;② 适合"帮我写 AAR""复盘这次挑战""总结我学到了什么";③ 触发词:AAR、复盘、总结、反思、进步
---

# EduSeed AAR 复盘｜七维结构化反思（Plugin 版）

本 Skill 是 EduSeed 课程客户端（Course Plugin）的学生侧技能，与 `eduseed-student-submit`
共用运行时 `scripts/runtime.js`。AAR = KSTAR 中 K → K′ 的知识更新环节。

## 运行时调用方式

```bash
"$COGSEED_NODE" "$COGSEED_PC_DIR/bin/run-skill.cjs" eduseed-student-aar runtime -- <命令> '<JSON载荷>'
```

## 本技能常用命令

| 命令 | 复盘中的用途 |
|---|---|
| `list-my-submissions` / `get-evaluation` | 回顾这次挑战的提交与评分证据 |
| `get-delta-r` | ΔR 归因素材：`{"submissionId":...}`（校准）或 `{"challengeId":...}`（跨尝试进步曲线） |
| `list-episodes` / `get-episode` / `get-replay-suggestions` | KSTAR 学习记忆：历史 episode + 下次改进建议 |

## AAR 七维模板

1. **我学到了什么** — 具体概念/方法/技能（如"通过 System Prompt 控制 Agent 角色行为"，不是"学会了用 AI"）
2. **我的流程** — 阶段/时间投入/做了什么/卡点 四列表
3. **我与 AI 的协作** — 协作动作/具体例子/效果/反思；好指令 ✅ / 差指令 ❌ / 迭代案例 🔄
4. **我完成了什么** — 交付物最终状态 + 自我评价
5. **卡点与突破** — 最大卡点、解决方式、"这个概念真正进脑子"的瞬间
6. **改进方向** — 下次同类挑战怎么做不同（具体可执行动作，不是"更努力"）
7. **KSTAR 学习信号** — R̂（预期）→ R（实际）→ ΔR 归因（K/S/T/Â 哪个环节）→ K′（下次带入的新知识）

## 工作流

1. **回顾证据** — 用上面命令拉取本次提交/评分/ΔR（复盘必须基于真实记录，不凭印象）
2. **口述采集** — 问用户"这几天做了什么/卡在哪/AI 帮了什么/误导了什么"——先口述再结构化
3. **按七维整理** — 生成结构化 AAR（不编造用户没说的经历）
4. **审阅补充** — 请用户确认、补充遗漏、修正偏差
5. **写回交付物** — AAR 文本存入项目 `AAR复盘.md`；提交时作为 aarText（≥10 字，质量门是七维全有实质内容）

## 质量门

- 七维全有实质内容，拒绝"挺好的""学到了很多"式敷衍
- 含失败经验：没有失败记录的 AAR 不完整（KSTAR：ΔR 是学习信号）
- 每句建议可执行，绑定到具体挑战/代码/协作实例

## 停止规则

用户拒绝口述（不编造经历）；挑战未完成（提醒先完成再复盘）。

## 失败行为

never_invent_experience；never_skip_dimensions_without_user_consent；
return_completed_and_uncompleted_parts

## 版本检查（skill 自动更新）

开始复盘前执行 `plugin-version`：`update_required` 为 true 时先升级插件再继续；`update_available` 提示可升级。
