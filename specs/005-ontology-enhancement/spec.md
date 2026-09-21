# Feature Specification: 本体增强三件+界面重构

**Feature Branch**: `认知资产迭代`
**Created**: 2026-09-19（回填 2026-09-20）
**Status**: Implemented
**Input**: 用户需求原话：「结合这个（《Personal Ontology v0.1.0》）看一下我们的本体部分」→「三件全做」→「这个前端界面也要全部重构，你也想想」→ 效果图过目「按这个实施」。

**Source**: design/本体组增强三件-方案-20260919.md、design/个人本体界面重构-终态图-20260920.html、design/本体增强两天开发前后对比-20260920.html、goal-loop 账本 38-45 轮。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 本体分组字段值带时间锚（蓝图 R26）

1. **Given** 值行落盘 `@asof:YYYY-MM` **When** 渲染与投影 **Then** 界面显示「截至 YYYY-MM」、超 12 个月标「可能过时」、世界模型收到 asOf/needsRefresh；无锚旧值不受影响。

### User Story 2 - 学习回流本体（蓝图 R13）

2. **Given** 资产晋升（personal/rule/template；skill 不回流） **When** 晋升完成 **Then** 自动投本体候选池（同 id 覆盖、池内 ≤20），用户确认才写入，绝不直写。
3. **Given** 确认去向 **When** 资产库已有画像 **Then** 双轨直入资产库（语义查重门拦重复）；空库回退旧文件。

### User Story 3 - 同字段矛盾暴露（蓝图 R32）

4. **Given** 写入新值与既有值语义相似 ≥0.60 且模型判互斥 **When** 后台检测完成 **Then** 冲突台账记行、界面红框，永不自动删；值删后自愈；判定 180s 超时兜底；台账事务串行防覆盖。

### User Story 4 - 断言核实章（蓝图 五维度之核实）

5. **Given** 用户手点核实 **When** 三态循环 无→有来源支持→独立核实→无 **Then** 落盘 `@verified`/`@verified:independent`，世界模型透出档位；确认写入不自动核实。

### User Story 5 - 本体界面重构（三子页）

6. **Given** 认知资产→个人本体 **When** 打开 **Then** 三子页（画像=资产库源+纯内容零出身标记；本体分组=结构化编辑：字段块/值行/来源/时间/核实/矛盾/分类/受限；角色模板）；记忆页退役（设置卡跳认知资产、导出导入保留迁入、四语改「本体分组」）。

## Tasks（已实施，提交 175ad762…bb960e14）

- [x] @asof 解析/序列化/世界模型 / [x] 回流+双轨+防洪 / [x] 矛盾检测（并行后台+台账自愈+超时+串行） / [x] @verified 两档 / [x] 三子页+结构化编辑+回流确认区 / [x] 记忆页退役+改名四语 / [x] 顺手修：fields.setValue IPC 漏参、refresh 状态重置、桥前缀比对
