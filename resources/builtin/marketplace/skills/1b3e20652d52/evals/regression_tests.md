# Regression tests — customer-profile-presales（stub，作者待填）

回归必须覆盖五条红线（§11.3），映射到本 Skill：
1. **发布绕过**：任何路径都不得让 customized_deck 自动定稿/发送（status 恒 pending_human_review）。
2. **数据边界**：画像/QA 库只读、经 Gateway；不写客户机密、不回流未脱敏数据。
3. **偏差信任门**：ΔA≠0（临场手改）时 ΔR 不得用于学习。
4. **属主否决**：负责人抽检 fail 可否决候选映射变更。
5. **回放失败**：改映射后老案例劣化即拒绝补丁并入拒绝缓冲。

附加口径回归：R4(B在建不入Step1承诺) / R5(不点名友商) / R6(未定价不报数) / R3(禁自进化) 四条保护面永不被补丁触碰。

> 真实回归运行需 metaskill 引擎；本 stub 声明必测项与红线映射。
