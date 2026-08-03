# 会话复制与合并设计

**日期：** 2026-08-01
**状态：** 已实现并验证
**范围：** 单个会话复制（fork）与多个会话合并（merge），仅影响 main 侧会话数据、group chat 状态、session store、IPC 与 renderer 入口。

## 1. 目标

本设计新增两个面向会话的能力：

1. **复制会话**：从一个源会话创建一个新会话。新会话完整继承源会话的共享上下文、Commander 上下文、成员 roster、每个 agent 的私有上下文，以及源会话已有的 UI 消息历史结构；但新会话必须使用新的 `cid`，并将所有 session id 重映射到新 `cid`。附件、artifacts、produced files 不复制本体，只保留历史引用。
2. **合并会话**：从多个源会话创建一个新会话。新会话不回放所有源消息，而是以一条 UI 摘要消息呈现结果；后台将多个源会话的共享上下文与每个 agent 的私有上下文压缩后写入新会话，使其可以继续工作。附件、artifacts、produced files 不复制本体，只在摘要中保留来源引用。

## 2. 已确认的产品决策

- 合并后的新会话 UI 只显示一条合并摘要消息，不展开全部源会话历史。
- 合并时，源会话中的附件、artifacts、produced files 不复制本体，只保留来源引用。
- 复制时，附件、artifacts、produced files 也不复制本体。
- 合并时，同一个 `agent_id` 在多个源会话中的私有上下文按 agent 聚合后压缩。
- 复制与合并都必须产生新的 `cid`。
- 复制与合并都必须生成新的 Commander session 和新的 agent 私有 session。
- 复制与合并不得直接拼接多个源会话的原始 session jsonl 作为最终可运行上下文。
- 合并结果必须保留冲突、未决问题、决策来源与引用关系，避免静默丢信息。

## 3. 用户可见行为

### 3.1 复制会话

用户在单个会话的更多菜单中选择“复制”后：

- 系统创建一个新会话。
- 新会话标题默认沿用源标题并加副本后缀。
- 新会话的聊天界面显示与源会话一致的上下文起点，但它是一个新的会话实体。
- 新会话中可继续 @ 原有 agent，且 agent 应能读取它们的继承私有上下文。

### 3.2 合并会话

用户选择多个会话后点击“合并”为新会话：

- 系统创建一个新会话。
- 新会话聊天区只显示一条系统生成的合并摘要。
- 摘要中说明来源会话、主要共识、冲突、未决问题、agent 私有上下文索引、来源引用。
- 用户可以直接继续在新会话中提问或调度 agent。

## 4. 设计原则

1. **新 cid，新 session id。** 任何复制或合并都不能沿用旧会话的 `cid`、`gconv-*` 或 `gmember-*` session id。
2. **UI 与模型上下文分离。** UI 只负责显示一条合并摘要或复制说明；真正可供模型运行的上下文分别写入 Commander session 与 agent 私有 session。
3. **结构化压缩优先。** 合并时不做原始日志拼接，而是抽取事实、决策、约束、风险、待办和来源引用后再压缩。
4. **按 agent 聚合。** 同一 `agent_id` 在多个源会话里的私有上下文合并到同一个新 agent session。
5. **不迁移大文件本体。** 附件、artifacts、produced files 不复制，避免跨会话的文件归属迁移与存储膨胀。
6. **主线程业务化。** 复制/合并逻辑放在 feature 层，IPC 只做参数校验与转发。

## 5. 数据与上下文边界

### 5.1 需要继承的内容

复制：

- conversation 元数据（标题、项目归属、自动任务来源、置顶状态等可保留字段）
- UI 消息历史结构
- members.json 中的成员 roster
- state.json 中与会话状态相关的字段
- Commander session（`gconv-<cid>`）
- 每个 agent 的私有 session（`gmember-<cid>-<agentId>`）
- 每个 session 对应的 `.context.json` sidecar
- 共享协作上下文中的结构化状态（若源会话存在）

合并：

- 需要继承的全部内容之外，还要把多个源会话的共享上下文和 agent 私有上下文做结构化压缩
- agent 私有上下文按 `agent_id` 聚合
- 来源引用保留到摘要中，但不复制附件/artifacts/files 本体

### 5.2 不复制本体的内容

以下内容在复制与合并中都不迁移文件本体：

- 附件
- artifacts
- produced files
- 仅作为历史记录存在的旧路径引用

这些内容只能出现在新会话的摘要、历史消息或来源引用里。

## 6. 推荐架构

### 6.1 新增 feature 服务

新增一个 main 侧 feature，例如：

`/Users/sudai/Documents/Mate Agent/src/main/features/conversation_clone_merge.ts`

职责：

- 读取一个或多个源会话
- 生成新 `cid`
- 创建新 conversation 记录
- 复制或压缩 UI 历史
- 复制或压缩 Commander session
- 复制或压缩 agent 私有 session
- 复制 members/state/collaboration 的必要字段
- 处理 session id 重映射
- 返回新会话创建结果给 IPC

### 6.2 IPC

在 `src/main/ipc/index.ts` 中增加两个入口：

- `conversations.clone`
- `conversations.merge`

IPC 层只做：

- `cid` / `cid[]` 校验
- 项目归属校验
- 传入标题、目标项目、可选策略参数
- 调用 feature 层并返回结果

### 6.3 Renderer

在 `src/renderer/modules/conversation.js` 中增加：

- 单会话“复制”动作
- 多选会话“合并”动作
- 新会话打开后的摘要渲染

## 7. 复制流程设计

### 7.1 输入

- 源 `cid`
- 可选 project hint

### 7.2 输出

- 新 `Conversation`
- 新 UI 消息历史
- 新 `members.json`
- 新 `state.json`
- 新 Commander session
- 新 agent 私有 session 及 `.context.json`

### 7.3 处理步骤

1. 读取源会话元数据与布局。
2. 创建新 `cid`。
3. 创建新 conversation 记录，标题默认加副本后缀。
4. 复制源会话的 UI 消息历史到新会话对应文件，但不复制附件/artifacts/files 本体。
5. 复制 members roster 到新会话。
6. 复制 state 中允许继承的字段，清除运行态、活动态、锁定态和任何与旧 `cid` 强绑定的临时状态。
7. 生成新 Commander session：
   - 从源 Commander session 读取上下文
   - 写入新 `gconv-<newCid>` session
   - 复制 `.context.json` sidecar
8. 对每个 agent 成员：
   - 读取 `gmember-<oldCid>-<agentId>`
   - 写入 `gmember-<newCid>-<agentId>`
   - 复制或重建 `.context.json`
9. 若源会话存在协作上下文，则复制可继承的结构化状态到新会话对应位置。
10. 记录一条复制完成的系统消息或摘要提示。

### 7.4 复制规则

- 新会话中的 session id 必须全部基于新 `cid`。
- 旧会话中不存在的 agent 不得凭空生成私有 session。
- 若某个 agent 的旧 session 或 `.context.json` 缺失，复制流程应退化为只复制可用部分，并记录警告。
- 不复制文件本体，只保留旧消息中的历史引用。

## 8. 合并流程设计

### 8.1 输入

- 源 `cid[]`
- 新标题
- 可选 project hint

### 8.2 输出

- 新 `Conversation`
- 一条 UI 合并摘要消息
- 新 Commander 压缩上下文
- 每个 agent 的压缩私有上下文
- 新 members roster（源会话 agent 并集）

### 8.3 处理步骤

1. 读取所有源会话的元数据、消息历史、members、state、Commander session、agent 私有 session、协作上下文。
2. 抽取结构化材料：
   - 共享目标
   - 已确认决策
   - 约束
   - 风险
   - 未决问题
   - 可继续执行的任务
   - 来源引用
3. 按 `agent_id` 聚合 agent 私有上下文。
4. 生成新的合并摘要：
   - 在 UI 中只放一条消息
   - 在模型可读上下文中形成更细的结构化摘要
5. 生成新 Commander session：
   - 以合并摘要作为新 session 的起始上下文
   - 不写入原始多会话的完整历史
6. 为每个聚合出的 agent 生成新的私有 session：
   - 合并其在多个源会话中的私有上下文
   - 保留该 agent 相关的来源引用
7. 创建新 conversation 和 members/state 记录。
8. 新会话打开时，renderer 只显示合并摘要消息。

### 8.4 合并摘要结构

建议采用稳定结构，便于后续模型读取：

- Source Conversations
- User Goal
- Current State
- Confirmed Decisions
- Constraints
- Agent Roster
- Agent Private Context Index
- Open Questions
- Pending Work
- Source References
- Risks / Conflicts

### 8.5 合并规则

- 同一 `agent_id` 在多个源会话中的私有上下文必须聚合。
- 如果源会话之间存在冲突，必须在摘要中标明“冲突”或“待确认”。
- 不得静默选择某一源会话为真值而不说明来源。
- 不得把源会话原始 tool_use / tool_result 历史直接拼到新会话 UI。
- 附件、artifacts、produced files 只保留引用，不复制本体。

## 9. 冲突与失败处理

### 9.1 复制失败

如果复制过程中某个源 session 或 context sidecar 缺失：

- 允许部分降级复制
- 记录 warning
- 仍尽量完成新会话创建
- 如果新会话关键结构无法建立，则返回失败，不留下半成品会话

### 9.2 合并失败

如果多个源会话的上下文压缩失败：

- 允许先生成结构化摘要草稿再重试压缩
- 若最终 Commander session 无法生成，则回滚新会话创建
- 若个别 agent 私有上下文缺失，则该 agent 仅参与可用来源的合并，并在摘要中标记缺口

### 9.3 冲突处理

- 事实冲突、决策冲突、版本冲突都必须保留来源与说明
- 不自动覆盖用户已确认但互相矛盾的结论
- 必要时在摘要中显式列出“冲突来源 A / 冲突来源 B”

## 10. 安全与边界约束

- 不能绕过 path sandbox。
- 不能直接操作不属于当前会话的附件目录来复制本体文件。
- 不能让新会话继续引用旧 `cid` 的可运行 session 路径。
- 不能在 renderer 侧直接操作 session 文件。
- 不能在 IPC 中放业务逻辑。

## 11. 测试策略

### 11.1 单元测试

覆盖以下行为：

- 复制时新 session id 正确映射
- 复制时 members/state/session sidecar 正确继承
- 复制时不复制附件/artifacts/files 本体
- 合并时同一 `agent_id` 的私有上下文被聚合
- 合并摘要包含来源引用与冲突说明
- 合并结果不直接拼接原始 UI 历史

### 11.2 集成测试

覆盖以下路径：

- `conversations.clone` IPC
- `conversations.merge` IPC
- 新会话创建后，`conversations.get` 能读到正确的新元数据
- `conversations.history` 能展示复制后或合并后的预期 UI
- 复制/合并后，session-store 能按新 session id 正常加载

### 11.3 回归测试

重点防止以下问题：

- 旧 `cid` 的 session 被误复用
- tool protocol sidecar 被破坏
- 复制/合并写出半成品会话
- 合并时 agent 私有上下文丢失
- 附件本体被意外迁移

## 12. 验收标准

1. 单个会话可以被复制为新会话，且新会话能继续正常运行。
2. 多个会话可以被合并为新会话，且新会话只显示一条合并摘要。
3. 复制和合并都不会复制附件、artifacts、produced files 本体。
4. 合并时同一 `agent_id` 的私有上下文会按 agent 聚合。
5. 新会话中的 Commander session 和 agent session 全部使用新 `cid`。
6. 复制/合并后，用户可以继续在新会话中发消息并调度 agent。

## 13. 实施顺序建议

1. 先实现复制：数据模型更直观，能验证 session id 重映射与 state/member 复制。
2. 再实现合并：在复制基础上加入结构化摘要与 agent 私有上下文聚合。
3. 最后补 renderer 入口与多选合并交互。
