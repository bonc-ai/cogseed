# KSTAR evolution

每次真实运行保存 Situation、Task、predicted Action/Result、actual Action/Result、
ΔA、ΔR、source/run refs 与失败归因。只有真实来源可满足真实学习；synthetic
用例只验证结构。ΔA≠0 时创建 Change Candidate，ΔR 只用于分析。任何变化均需
重新通过适用的 Validation → Governance → Canary，禁止静默修改运行中 Skill。
