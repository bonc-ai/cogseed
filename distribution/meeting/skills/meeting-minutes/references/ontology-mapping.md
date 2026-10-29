# 会议纪要概念与规则

所有会议共用同一套概念与关系（TBox/RBox）；每场会议只新增实例（ABox）。主锚点是“会议”。本技能只产出符合下列切片的草稿，不读写图谱。

## TBox

本技能使用的切片与本体图谱分类的对应：

| 概念 | 图谱分类（父分类） | 记录编号 |
| --- | --- | --- |
| Meeting 会议 | 会议记录（事件） | meeting.ref |
| Decision 决议 | 会议决议（决策） | D1、D2… |
| OpenQuestion 未决问题 | 会议未决问题 | Q1、Q2… |
| ActionClue 行动项线索 | 会议行动项（任务） | A1、A2… |
| Participant 参会人 | 人物 / 团队成员（用户维护） | 实体 id 或 null |
| Series 会议系列 | 会议系列（用户维护） | 实体 id 或 null |
| Project 项目 | 项目（用户维护） | 实体 id 或 null |

辅助概念：TranscriptSegment、MinutesDraft、Suggestion、SourceRef。Suggestion 不入图谱。SourceRef = source_id + segment_id + 可选真实时间位置，写作“来源 · 段落”文字；草稿引用已有来源，不创建新的会议事实。用户补充与模型建议分别标记。

编号规则：同一会议的修订沿用原编号；新增条目取下一个编号；删除的编号不复用。

## RBox

固定关系词表（只用这些名称）：会议—作出决议→决议；会议—提出问题→未决问题；会议—产生行动项→行动项；行动项—派生自→决议；行动项—指派给→人物；人物—参与→会议；会议—属于项目→项目；会议—属于系列→会议系列；决议—解决了→历史未决问题。

结构化 field / op / value / action 约束；这是审阅候选，不是已执行的形式化规则引擎：

- {"field": "transcript_complete", "op": "eq", "value": false, "action": "return_needs_input"}
- {"field": "statement_kind", "op": "eq", "value": "suggestion", "action": "exclude_from_decisions"}
- {"field": "source_refs", "op": "empty", "value": true, "action": "mark_as_user_addition_or_pending"}
- {"field": "archive_intent", "op": "exists", "value": true, "action": "return_to_agent_without_writing"}
- {"field":"minutes_revision","op":"changed","value":true,"action":"require_current_version_review"}
- {"field":"review_summary","op":"count_lte","value":3,"action":"keep_full_minutes_available"}
- {"field":"participant_match","op":"count_neq","value":1,"action":"keep_entity_id_null_and_ask"}
- {"field":"participant_match","op":"eq","value":0,"action":"propose_new_entity_unconfirmed"}
- {"field":"new_entities.confirmed","op":"set_by","value":"skill","action":"forbidden"}
- {"field":"item.source_refs.segment_id","op":"missing","value":true,"action":"move_to_pending_questions"}
- {"field":"action_item.implements_decision","op":"eq","value":true,"action":"require_derived_from"}
- {"field":"prior_item_resolution","op":"inferred","value":true,"action":"suggest_only_until_user_confirms"}
- {"field":"meeting_record.confirmed","op":"set_by","value":"skill","action":"forbidden"}

## ABox

以下是虚构例子：来源 demo-meeting-001/p1；周岚明确说先验证连接，验证通过后才读取转写。对应草稿：D1“先完成连接验证，验证通过后再读取转写”，source_refs 为“demo-meeting-001 · p1”；ontology_context 中“周岚”唯一命中时 participants 带该实体 id，否则为 null 并列入待确认。真实运行只能使用调用方传入的实例，不复用这些示例身份。

## source_refs

- 当前会话用户确认的纪要、任务拆分和知识库归档范围。
- 本 Skill 的 input-contract.md、output-contract.md 和 eval-cases.yaml。
