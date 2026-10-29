# 演进边界

此钩子仅声明修订边界，没有实现或启用自动演进。
max_self_patch_ops: 0
max_self_patch_depth: 0

Runtime 不得改写 Skill 或 Agent 定义。模型可提出 Draft 文字修改，人工审阅后通过标准作者流程处理。触发、输入输出、归属、资源、审计、确认和 staged 上限是受保护边界；形式化检查结果决定符合性，模型建议不能自行宣布通过或发布。
