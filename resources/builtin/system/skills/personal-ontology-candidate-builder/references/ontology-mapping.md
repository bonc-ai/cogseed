# Ontology Mapping（三层本体入口）

Skill: `personal-ontology-candidate-builder`  ·  Level: `L3`  ·  Owner: `Mate Agent Team`

本文件是三层本体的总览入口，链接到独立文件：

- **TBox**（概念层）: `../ontology/personal_ontology/scene_tbox.yaml`
- **RBox**（规则层）: `../ontology/personal_ontology/scene_rbox.yaml`
- **ABox**（实例层）: `../ontology/personal_ontology/scene_abox.yaml`
- **Package**（包清单）: `../ontology/personal_ontology/scene_package.yaml`
- **Mapping**（物理映射）: `../ontology/personal_ontology/scene_mapping.yaml`

## 本体的三层语义（个人本体领域）

| 层 | 文件 | 内容 |
|---|---|---|
| TBox | `scene_tbox.yaml` | 概念层：候选五类（偏好/实例/属性/关系/规则）、角色模板（学生/学者/FDE）、来源四值（候选/手动/导入/智能）、去向（user/shared/字段区/流水区）、脱敏状态、17 个类 |
| RBox | `scene_rbox.yaml` | 规则层：14 条规则（确认制/高置信不自动生效/本地存储/敏感拦截/不做企业路由/来源必带/追加不覆盖/人读 markdown 输出/环境变量拼路径） |
| ABox | `scene_abox.yaml` | 实例层：9 个 fewshot 示例（学生 PPT 偏好、沟通风格、项目实例、工具关系、踩坑规则、模板对号入座、3 个阻断负例） |
| Package | `scene_package.yaml` | 包清单：assets 引用（tbox/rbox/abox/mapping 各带 file）、metadata、依赖、治理 |
| Mapping | `scene_mapping.yaml` | 映射层：候选→candidates.md、阻断→blocked_items.md、确认→USER.md/MEMORY.md/分组、模板→student.md、来源→会话 |

## 与本体的关系（链接机制）

- `scene_abox.yaml` 带 `tbox_ref` + `rbox_ref`，`scene_mapping.yaml` 带 `tbox_ref`，`scene_package.yaml` 的 assets 声明引用——文件间互相链接，满足"要有链接的"要求。
- 运行时契约（SKILL.md + `references/output-contract.md`）与本体的 RBox 规则一致；冲突时以 SKILL.md 为准。

## 与平台的关系

- 本技能的个人本体候选构建本体描述**个人记忆提炼领域**，是企业组织本体/业务本体的对立面——本技能只服务用户个人。
- 面向大众用户（学生/学者/FDE/普通用户），不含企业角色（如 业务一线/业务专家/运维工程师）的三层路由。
