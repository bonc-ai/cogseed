# CogSeed 品牌层与认知资产导航设计

- 日期：2026-08-10
- 状态：待实施
- 实施工作树：`/Users/sudai/.config/codex/worktrees/Mate Agent/remove-meta-skill-evolution-b-prime`
- 基线分支：`dev/remove-meta-skill-evolution-b-prime`

## 1. 目标

在已经移除独立 Evolution Console 前端入口的工作树上，完成以下用户可见改造：

1. 将一级导航中的“资料库 / Library”入口移动到设置页；资料库页面、IPC、存储和既有调用保留。
2. 将一级导航中的“指挥官 / Commander”显示为“新建会话”；只改可见文案，不改变 Commander 后端角色和会话调度逻辑。
3. 将一级导航中的 “Recall” 显示为“认知资产”，内部 `recall` 命名、IPC、数据目录和历史调用保持兼容。
4. 按 Recall/CogSeed PRD 保持认知资产工作台的三类用户入口：总览、认知沉淀、能力资产。
5. 将 Mate Agent 的用户可见品牌统一改为 CogSeed，但保留旧协议和内部身份兼容。
6. 验证应用从本工作树启动，而不是从旧的 `/Users/sudai/Documents/Mate Agent` 工作树启动。

## 2. 非目标与兼容边界

本轮不做以下变更：

- 不改 `src/main/features/recall/` 目录名。
- 不改 `src/main/features/evolution/` 目录名；该工作树已经删除独立 Evolution Console，但保留技能版本/回滚所需的后端能力。
- 不改历史 IPC channel 名称，包括 `recall.*`、`contexts.*` 和其他已有通道。
- 不改 `mateagent` 协议 scheme、`orkas` legacy scheme、App ID、数据目录和已有用户数据格式。
- 不做旧安装目录或数据目录迁移。
- 不删除资料库后端能力，只移动 renderer 的用户入口。
- 不把 `commander` 内部角色改名为 `new-session`。

## 3. 导航设计

### 3.1 一级导航

目标显示顺序：

```text
搜索
新建会话
自动化
AI 团队
技能库
认知资产
连接器
个人本体
工作空间
```

独立 Evolution Console 的入口已经在目标工作树中删除，本轮不重新引入。

### 3.2 资料库入口

- 从 sidebar 删除 `contexts-btn` / Library 一级按钮。
- 在 Settings 中增加“资料库”设置入口，复用现有 contexts 页面打开逻辑。
- 资料库入口必须从设置页可达，并且不能创建第二套资料库渲染器或 IPC 路由。
- 既有项目资料库、聊天附件、Agent picker 资料库能力不改变。
- 历史持久化 view 为 `contexts` 时，仍能安全打开设置中的资料库入口或兼容跳转，不进入空面板。

### 3.3 新建会话

- `new-chat-btn` 的业务行为保持不变。
- `commander` 仍然是内部 actor、会话类型和调度名称。
- 仅修改 renderer locale、按钮可见文本、相关 tooltip/aria-label 和测试断言。

### 3.4 认知资产

- sidebar visible label 从 Recall 改为“认知资产”。
- Recall 页面内部使用 CogSeed PRD 的用户语言：
  - 总览
  - 认知沉淀
  - 能力资产
- 保留旧的内部路由和深链映射，legacy page id 通过已有 normalizer 映射到新的页面/子视图。
- 技术名词只保留在必要的详情或辅助说明中，不改变数据契约。

## 4. CogSeed 品牌层

### 4.1 统一修改

- `src/resources/brand.json`：将用户可见 `appName` / `zhName` 调整为 CogSeed 品牌值，保留现有 appId 和协议字段。
- `src/main/brand.ts`：继续从 brand.json 读取品牌，不新增分散常量。
- `package.json`：更新 description 和 Electron `productName` 等用户可见构建字段，但不改 appId/protocol identity。
- `run.sh`、`run.cmd`、`bootstrap.cjs`：启动输出和错误前缀使用 CogSeed。
- renderer/main locales：更新窗口、登录、设置、品牌和 Recall/Cognition 相关用户可见文案。
- README、docs 入口说明和品牌测试：更新为 CogSeed；必要时保留“Mate Agent”作为历史兼容说明，而不是当前产品名。

### 4.2 保留兼容

以下值保持不变：

```text
mateagent
orkas
com.mateagent.desktop
recall
commander
contexts
```

这些值属于协议、存储、内部业务或历史兼容边界，不作为用户可见品牌展示。

## 5. 实施分层

1. 先修改 renderer 导航和 settings 入口。
2. 再统一 Recall/认知资产和新建会话的 visible i18n 文案。
3. 再修改 CogSeed 品牌配置、启动输出和产品元数据。
4. 更新/新增结构测试和品牌测试。
5. 在目标工作树运行 focused tests、`git diff --check`、`npm test`。
6. 重启目标工作树，确认 Electron 命令行包含 `remove-meta-skill-evolution-b-prime`，并人工核对导航。

## 6. 风险与处理

- **错误工作树启动**：启动前检查 Electron 命令行路径和 branch；验证日志不得只看 variant 名称。
- **资料库入口重复**：设置入口复用原 `contexts` 路由和 renderer，不复制数据加载逻辑。
- **品牌误改协议**：品牌值与协议/App ID 分开断言，测试确保旧 scheme 仍存在。
- **内部名称被误删**：对 `recall`、`commander`、`contexts` 的 IPC 和 feature import 做静态回归检查。
- **Evolution Console 回归**：保留删除测试，确保 sidebar、topbar、panel 和 lazy bundle 均不重新出现。

## 7. 验收标准

- 当前运行进程来自目标工作树，而不是 `/Users/sudai/Documents/Mate Agent`。
- 一级导航中没有资料库和进化控制台。
- 设置页能打开原资料库页面。
- 一级导航显示“新建会话”和“认知资产”。
- Recall 内页显示 CogSeed、总览、认知沉淀、能力资产。
- 用户可见品牌为 CogSeed。
- `mateagent` / `orkas` 协议兼容，App ID、数据目录和内部 IPC 不变。
- JavaScript 与 Python 资源测试全部通过。
