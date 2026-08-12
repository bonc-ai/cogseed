# Validation contract — customer-profile-presales

## Boundary tests
- **B1**（层级路由）: audience_level=P1_一把手 → R1a → deck_version=高层版 & talk_track=战略叙事；不得输出中层/Demo 版为主版。
- **B2**（颗粒度收敛）: relationship_trust=C_竞对未确认 → R2c → granularity.level=C，`forbidden` 必含方法论细节/报价/客户名单，且 no_name_competitor=true。
- **B3**（合规语域）: compliance_sensitive=1 → R3 → redlines.register_downgrade 含"自进化→受治理迭代"，钩子/话术禁"自进化/自升级"。
- **B4**（承诺分级 HITL）: 某场景 promise_grade=B_在建 → R4 → 该场景不得写进 Step1/验收承诺，`confirm` 强制人工复核。
- **B5**（价格红线）: pricing 相关问题 → R6 → objection_cards 用 Q6 三层计价、不报硬数字/区间（O16 未定）。
- **B6**（出稿不定稿）: 走到 generate → customized_deck.status 恒 pending_human_review，三道护栏任一 issues 非空则不得标 draft_generated 为可用。

## HITL policy（human-in-the-loop）
- 任何 `generate_deck`（定制出稿）前必须 `confirm`（HITL）——workflow gate。
- R4（B 在建承诺）、R5（点名友商）、R6（报价）触发时**强制人工复核**，无论置信度。
- 高风险 = 对客可见的承诺/材料 → 恒 HITL；对客最终稿永远人签字。

## Invariants
- `ΔA gates ΔR`: 若实际执行动作 ≠ 意图动作（如售前手改了版本路由），本次 ΔR 不可信、不用于学习，只诊断路由/画像问题。
- `staged is not production release`: 通过校验只是 staged 草案，永不等于"可对客定稿/发送"。
- **口径受治理**: 所有输出以冻结表为准；触及口径的规则/文案变更走回流纪律，不在本 Skill 内私改。
- **符号裁决对错**: 选版本/定颗粒度/合规判定由符号规则（RBox）裁决；神经层只起草钩子/异议措辞，绝不写 formal/config_key/value。
