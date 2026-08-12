# Outcome evaluation — customer-profile-presales（stub，作者待填）

**实际**侧与偏差：
- `actual_deck_version` / `actual_granularity` / `actual_objection_hits`：本场真实所用。
- `owner_spotcheck`：负责人抽检"讲到位没"（pass/fail + 备注）——业务事实基准（Ground Truth）。
- `field_new_objections`：现场冒出的未预置异议（回填《销售 QA 库》的素材）。
- `ΔR = R − R̂`：抽检未过 / 出现未预置异议 = 正向学习信号（非发布指令）。
- `ΔA`：售前是否临场手改路由（ΔA≠0 则 ΔR 不可信，只诊断）。

> 结果偏差进学习管线仅在 staged 候选层；对客定稿永远人签字。
