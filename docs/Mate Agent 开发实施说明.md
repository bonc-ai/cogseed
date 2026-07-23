# Mate Agent 开发实施说明

> 版本：v1.0  
> 日期：2026年7月22日  
> 定位：面向 Mate Agent 本体开发的模块拆分、关系图整理与落地路径说明。

## 1. 报告目的

这份说明不是纯概念架构稿，而是把 Mate Agent 的开发关系整理成可以直接执行的实施说明。重点回答四件事：

- 这个项目的核心边界是什么。
- 模块之间的关系怎么画才清楚。
- 开发时先做什么、后做什么。
- 每一步如何验证没有破坏现有基座。

## 2. 当前开发基线

- 单进程 Electron 应用。
- Main 是 Node 后端，Renderer 只使用原生 HTML/CSS/JS。
- 进程间通信只走 IPC 和 `window.orkas.invoke / stream`。
- `#core-agent` 通过动态 import 加载，不做静态引入。
- 本体运行基座仍然是 Orkas；Mate Agent 是对外产品品牌。
- P3394 负责 Wake、KSTAR、Verification、Experience 的治理闭环。

## 3. 开发关系总图

```text
用户
  ↓
Renderer (HTML / CSS / JS)
  ↓  window.orkas.invoke / stream
src/main/preload.js
  ↓  contextBridge allow-list
src/main/ipc/index.ts
  ├─ src/main/features/group_chat/bus.ts
  ├─ src/main/features/p3394/*
  ├─ src/main/features/local_agents/*
  ├─ src/main/features/config.ts
  ├─ src/main/features/auth.ts
  └─ src/main/model/core-agent/*
```

### 3.1 关系类型统一规范

| 关系类型 | 含义 | 例子 | 规范要求 |
|---|---|---|---|
| 组件调用 | 一个模块调用另一个模块 | Renderer → IPC → group_chat | 只写调用链，不写数据归属 |
| 数据归属 | 数据属于谁、谁能持久化 | Conversation、AgentSession | 不和执行链混写 |
| 审批门禁 | 先审批再执行 | WakeRequest | 不允许直接绕过 |
| 执行链路 | 一次任务如何落地 | AgentRun → Artifact → Evidence | 只描述执行事实 |
| 验证回流 | 结果如何回到治理层 | KSTAR → ExperienceCandidate | 不直接写永久知识 |

## 4. 核心模块职责

| 层级 | 代码位置 | 主要职责 | 说明 |
|---|---|---|---|
| Renderer | `src/renderer/*` | 展示界面、收集输入、触发交互 | 不直接访问主进程内部实现 |
| Preload | `src/main/preload.js` | 暴露 `window.orkas` 安全接口 | 只保留 allow-list |
| IPC | `src/main/ipc/index.ts` | 参数校验和路由分发 | 不放业务逻辑 |
| 会话层 | `src/main/features/group_chat/*` | 消息、参与者、调度、任务流转 | 是主对话和派发入口 |
| 治理层 | `src/main/features/p3394/*` | Wake、KSTAR、Experience、审批 | 负责门禁和闭环 |
| Agent 层 | `src/main/features/local_agents/*` | 本地 CLI Agent 运行、会话、注册 | 仅通过批准的调度入口运行 |
| 配置层 | `src/main/features/config.ts` | 用户偏好、品牌、后端选择 | 保持持久化简单明确 |
| 模型层 | `src/main/model/core-agent/*` | LLM 调用、工具目录、会话适配 | 只做模型与工具编排 |

## 5. 开发实施路径

### 阶段 1：先把边界固定

1. 确认品牌名、应用名、协议名和图标资源一致。
2. 保持 `.orkas`、`window.orkas`、`#core-agent` 等内部兼容标识不乱改。
3. 保证 Renderer 仍然只走 IPC。

### 阶段 2：把后端选择做成显式配置

1. 在 `config.ts` 里统一保存 Commander 后端偏好。
2. 通过 IPC 暴露读取、设置和检测能力。
3. 默认仍保持 Orkas Core Agent，Hermes 作为可选后端。

### 阶段 3：把唤醒门禁做扎实

1. 所有专业 Agent 的加入、恢复、唤醒都先过 Wake Gate。
2. 未批准的唤醒必须落为 `AgentWakeRequest`。
3. `group_chat/bus.ts` 继续作为唯一调度通道。

### 阶段 4：把 KSTAR 闭环接完整

1. 为重要任务记录 Situation、Prediction、Execution、Verification、Learning。
2. 把 `KSTAR` 结果与 `ExperienceCandidate` 明确分开。
3. 不把后台整理当成 KSTAR 本身。

### 阶段 5：把测试和验收补齐

1. main 侧做单元测试和路由测试。
2. renderer 做交互测试。
3. macOS / Windows 分平台验证打包与启动。

## 6. 关键运行流程

### 6.1 用户发送消息

```text
用户输入
  ↓
Renderer 组装消息
  ↓
IPC 校验参数
  ↓
group_chat.bus.enqueue / send
  ↓
主任务更新、事件同步、必要时唤醒专业 Agent
```

### 6.2 专业 Agent 唤醒

```text
dispatch_to / hand_off_to / run_worker
  ↓
gateNestedAgentWake
  ↓
evaluateWake
  ├─ 已有有效批准 → 直接通过
  └─ 没有批准 → 生成 AgentWakeRequest
                    ↓
                用户审批
                    ↓
                通过后再执行
```

### 6.3 KSTAR 闭环

```text
Situation
  ↓
Formation
  ↓
Prediction
  ↓
Execution
  ↓
Verification
  ↓
Learning
```

## 7. 需要长期坚持的约束

- 不新增 HTTP server。
- 不在主进程放业务逻辑。
- 不新增第二套 Conversation 或 Message Store。
- 不绕过 Wake Gate、KSTAR 和 Evidence。
- 不新增 CLI / MCP 直连的其他 spawn 路径。
- 不把 `src/main/preload.js` 改成非 `.js`。
- 不在没有讨论的情况下新增 npm 依赖。

## 8. 测试与验收建议

| 维度 | 建议检查 | 说明 |
|---|---|---|
| 逻辑正确性 | `npm run typecheck` | 先消除类型和接口问题 |
| 主流程 | `npm run test:js` | 覆盖 main 侧核心行为 |
| 体验层 | renderer 测试 | 验证设置页、状态页、消息流 |
| 打包层 | macOS / Windows 验证 | 确认图标、协议、启动名一致 |
| 治理层 | Wake / KSTAR 用例 | 验证审批和闭环不被绕过 |

## 9. 参考实现文件

- `package.json`
- `src/main/ipc/index.ts`
- `src/main/features/group_chat/bus.ts`
- `src/main/features/p3394/wake-service.ts`
- `src/main/features/p3394/kstar-runtime.ts`
- `src/main/features/local_agents/runner.ts`
- `src/main/features/config.ts`
- `src/main/model/core-agent/tool-catalog.ts`
- `src/main/preload.js`
- `test/main/features/p3394/wake-service.test.ts`
- `test/main/features/p3394/kstar-runtime.test.ts`
- `test/renderer/p3394-experience-controls.test.ts`

## 10. 结论

Mate Agent 的开发实施顺序应该是：先固化边界，再补后端选择，再把唤醒门禁做完整，随后收敛 KSTAR 闭环，最后用测试和分平台验证封住回归。这样整理出来的关系图，才能既清楚，又能直接指导实施。
