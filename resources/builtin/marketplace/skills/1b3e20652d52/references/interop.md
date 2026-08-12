# Interop — SessionPlan → deck_brief（与 presales-deck-authoring 联动）

> 本技能（客户画像售前赋能）与 `presales-deck-authoring`（售前模板写作）经**契约缝**联动，非合并。
> 分工：本技能管"**这一场怎么打**"（选版本/场景/异议/红线）；写作技能管"**deck 怎么写好且过口径**"（四幕/动作标题/五步/三门）。
> 一致性来源：**两技能读同一张冻结表为唯一口径源**——靠共享治理本体一致，不靠耦合。

## 契约缝：本技能输出 `SessionPlan` → 写作技能输入 `deck_brief`

| SessionPlan（本技能出） | → | deck_brief（写作技能入） |
|---|---|---|
| `deck_version`（高层/中层/Demo） | → | `deck_tier` |
| `scenarios` / `differentiation` | → | `act_scope` / topic |
| `industry` · `relationship_trust` | → | `industry` / `variant` |
| `granularity` + `redlines` | → | 口径约束（喂给写作技能三门 QA） |
| `objection_cards` | → | 异议焊入（写作技能 speaker_note） |

## 子能力⑤ 定制出稿的委托
本技能子能力⑤（定制出稿）**不自造写作能力**——把 SessionPlan 当 deck_brief **委托** `presales-deck-authoring` 出 `page_blocks`，回收为 `CustomizedDeck`（status 恒 `pending_human_review`）。

## 耦合两档
- **松耦合（现在）**：本技能出 SessionPlan → 人/agent 当 deck_brief 手递给写作技能。零改动、最可控。
- **编排（将来）**：完整 agent 运行时里本技能作 session master、编排写作技能为被调用能力（需 metaskill 引擎，非当前脚手架层）。

## 边界
两技能均 `promotion_ceiling: staged`；契约缝只传**脱敏 SessionPlan**，不传客户机密；对客定稿恒人工终审。session 规则：二者各为 master_task_skill，不共享同一会话——只手递契约/编排调用，不焊死。
