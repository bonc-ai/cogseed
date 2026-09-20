# Tasks: 本体三盒归位与打通

**Feature**: `007-ontology-tri-box`
**Spec**: `specs/007-ontology-tri-box/spec.md`
**Plan**: `specs/007-ontology-tri-box/plan.md`

## Phase 0: Setup

- [x] T001 建立 `specs/007-ontology-tri-box/` 规格工件（spec/plan/tasks）
- [x] T002 探索实证差距（R 盒零入口 / A 盒双存储 / 结构缺口）并写入 spec 背景

## Phase 1: 界面归位（词汇/事实/规则 三区 + 关系值入口）

- [x] T101 组详情按三盒分区渲染：isRelation 或值含 → 的字段归「规则」区，其余归「事实」区，区块标题四语
- [x] T102 字段说明（description）显示——T 盒定义可视化
- [x] T103 添加值识别 `A → B` 形状并提示「将作为规则保存」；新建字段可声明关系字段
- [x] T104 vm 测试：分区断言 / 关系值写入后世界模型 ontologyRules 命中 / description 渲染

## Phase 2: 三盒总览 + 核实两档 + 来源修复包

- [x] T201 「三盒总览」视图：A 盒合并（组字段值 + personal 资产）、R 盒合并（关系值 + 规则资产）、T 盒词汇统计，条目带来源侧标记
- [x] T202 核实两档：FieldValue.verified 枚举化（true / 'independent'）、落盘 `@verified:independent`、IPC 透传、界面两枚章、世界模型档位
- [x] T203 即时直投改传真实会话 id；无真实会话场景哈希 id + degraded 如实标注
- [x] T204 渲染层剥 `immediate-` 前缀比对；证据统计按 id 去重
- [x] T205 文案两分：「模型当场记（无独立出处）」≠「来源已删除」；「来源已删除的候选」分组收窄为真删除情形
- [x] T206 测试：两档解析往返 / 总览合并计数 / 去重统计 / 剥前缀命中 / 新候选无合成 id；真机验证 7 条候选归组恢复

## Phase 3: 结构对齐（逐项小方案先行）

- [x] T301 R 盒规则分类（operation/preference/constraint）+ 状态（proposed/active）落盘与筛选
- [x] T302 敏感性分档：FieldValue.sensitivity + `@restricted` marker + 注入侧过滤（restricted 零注入）
- [x] T303 授权切片交互小方案文档（任务关键词/空间绑定/手动选择）交用户拍板——未拍板不动注入裁剪
- [x] T304 组版本回滚：写入前快照 `.history/<groupId>/`（上限滚动）+ IPC history.list/restore + 界面「历史」入口
- [x] T305 测试：分类筛选 / restricted 零注入（注入块与 ontologyFacts 双查）/ 快照恢复一致性

## Phase 4: 收尾

- [x] T401 全量测试两遍一致（唯二 develop 基线除外）+ lint + tsc
- [x] T402 真机 CDP 四场景（三盒分区+关系值 / 总览 / 核实两档+候选归组 / restricted+历史）
- [x] T403 specs/003-006 回填（已实施功能：记忆并入 / 主动使用+漏取审计 / 本体增强三件 / 出身收敛——素材：终态图、全景图、goal-loop 账本 1-45 轮、测试反推）
- [x] T404 推送分支（不提 PR），spec 状态改 Implemented
