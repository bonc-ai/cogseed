# Governance boundaries — customer-profile-presales（non-claims）

- `promotion_ceiling: staged`；`production_release_allowed: false`。每件制品皆 staged。
- 本 Skill **分析 + 起草作战方案与定制稿草案**；它**不**定稿、不发送、不上场、不做生产发布。
  对客最终稿是人签字的下游动作；`customized_deck.status` 恒为 `pending_human_review`。
- 资源/身份值（owner_id、真实授权范围、《销售 QA 库》/冻结表/模板库访问）由 **Agent/Gateway 层注入**
  （`binding_resolved_by: agent_layer`）。本 Skill 不持令牌、不直连资源、不解析身份。
- **符号裁决对错**（选哪版、哪档颗粒度、合不合规、承诺能不能给）；**神经只裁决好坏**（只起草钩子/异议/措辞候选）。
  LLM 绝不写 `formal`/`config_key`/`value`，绝不裁决良构性或门禁通过。
- **口径受治理**：所有输出以**冻结表为唯一口径源**；触及口径（slogan/语域/承诺分级/案例红线）的变更**走回流纪律**，
  不在本 Skill 内私改。B/C 关系档自动删除禁讲项；正式材料不点名友商；未定价（O16）不报硬数字。
- **不碰客户机密**：画像用脱敏/概要信息，不录入客户机密数据。
- **不宣称**：生产就绪、已投产、已在真实业务中"学会/自主进化"、评测通过即业务价值已验证、
  合成/演示证据代表客户价值、或可被生产 Agent 运行时直接加载。这是一个 staged、合标准的脚手架。

## 本 Skill 刻意不做的事（明说）
- **不**跑真实 KSTAR 因果学习闭环（ΔR/ΔA、reflect→distill→gates）——那需 `metaskill` 引擎；本脚手架只有 KSTAR *钩子*。
- **不**达 Tier C（发布评估）——那是治理/发布属主的活，不在本 Skill 范围。
- **不**产出生产可部署对象；对客定稿/发送/上场是独立的人类决策（第 9 章锁定态），永不被任何评分/回放/ΔR 自动触发。
