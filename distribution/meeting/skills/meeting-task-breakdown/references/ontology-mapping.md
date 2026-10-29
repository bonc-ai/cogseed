# 拆分任务概念与规则

## TBox

概念：MinutesReference、ActionClue、CandidateTask、AcceptanceCriterion、Dependency、PendingField、SourceRef。

与共享会议本体的对应：ActionClue 即会议记录中的行动项 A 编号（图谱分类“会议行动项”，父分类“任务”）；CandidateTask 回指其来源行动项或决议（D 编号），对应关系“行动项—派生自→决议”“行动项—指派给→人物”。负责人仅在会议记录已带实体 id 时沿用，不自行匹配。
SourceRef = source_id + segment_id + 可选真实时间位置；草稿引用已有来源，不创建新的会议事实。用户补充与模型建议分别标记。

## RBox

结构化 field / op / value / action 约束；这是审阅候选，不是已执行的形式化规则引擎：

- {"field": "decision", "op": "eq", "value": "deferred", "action": "exclude_from_selected_tasks"}
- {"field": "acceptance_origin", "op": "eq", "value": "proposed", "action": "require_content_confirmation"}
- {"field": "owner", "op": "missing", "value": true, "action": "preserve_null_and_pending"}
- {"field": "dependency_graph", "op": "cyclic", "value": true, "action": "return_needs_input"}
- {"field": "confirmation", "op": "eq", "value": "pending", "action": "deny_external_creation"}

- {"field":"current_minutes_confirmed","op":"eq","value":false,"action":"return_needs_input_without_tasks"}
- {"field":"post_confirmation_split_choice","op":"neq","value":"split_tasks","action":"do_not_generate_tasks"}
- {"field":"external_creation_authorized","op":"eq","value":false,"action":"return_list_only"}

## ABox

以下是虚构例子：来源 demo-meeting-001/p1；周岚明确说先验证连接，验证通过后才读取转写。相关草稿保留“验证通过后”条件和 p1 引用。真实运行只能使用调用方传入的实例，不复用这些示例身份。

## source_refs

- 当前会话用户确认的纪要、任务拆分和知识库归档范围。
- 本 Skill 的 input-contract.md、output-contract.md 和 eval-cases.yaml。
