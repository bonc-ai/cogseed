# Mate Agent 品牌改造设计规范

- 日期：2026-07-22
- 状态：已确认，待实施
- 原产品基线：Orkas × P3394 融合 MVP
- 新英文应用名：Mate Agent
- 新中文产品名：Mate 智伴
- 产品定位语：你的协作型智能体工作台

## 1. 背景与目标

当前融合 MVP 仍沿用 Orkas 的名称和虎鲸图标，难以在产品识别、桌面应用入口和安装产物层面与原 Orkas 区分。本次改造只调整品牌、系统应用身份和用户可见文案，不重构已经验证通过的 Orkas Conversation、Agent Runtime 与 P3394 治理链路。

目标：

1. 用户能够通过名称和图标立即识别 Mate Agent。
2. Mate Agent 的 Dock、任务栏、窗口、安装包和协议身份与 Orkas 明确区分。
3. 保持当前会话、配置、Agent、Skill 和 P3394 数据可读取。
4. 不产生第二套 Conversation、Message Store 或 Agent Runtime。
5. 不纳入账号、云同步、多设备和团队协作。

## 2. 已确认的品牌方案

### 2.1 名称

| 场景 | 规范值 |
|---|---|
| 英文应用名 | Mate Agent |
| 中文产品名 | Mate 智伴 |
| 桌面、Dock、任务栏 | Mate Agent |
| 窗口标题 | Mate Agent |
| 中文欢迎页 | Mate 智伴 |
| 安装包基础名 | Mate-Agent |
| 产品定位语 | 你的协作型智能体工作台 |

### 2.2 图标方向：双节点伴星

图标由一个主节点和一个伴随节点组成：

- 主节点代表用户或当前工作中心。
- 伴随节点代表 Mate Agent。
- 两个节点通过柔和的弧形连接带构成协作关系。
- 整体从左下向右上延伸，表达任务推进。
- 不使用鲸鱼、动物轮廓或字母 O。
- 不直接使用字母 M，避免小尺寸识别下降并保持图形商标独立性。

### 2.3 色彩

| 角色 | 色值 |
|---|---|
| 智能紫 | `#7C3AED` |
| 协作蓝 | `#3B82F6` |
| 星际青 | `#22D3EE` |
| 深靛蓝背景 | `#11152B` |
| 节点核心 | 白色或浅蓝白 |

主体使用紫色到蓝色的渐变；青色只用于连接区域和高光。整体必须与 Orkas 当前的黑色虎鲸剪影形成明显差异。

### 2.4 小尺寸规范

- macOS 使用圆角矩形底板并保留平台安全边距。
- Windows/Linux 透明边缘必须干净。
- 16×16、24×24 和 32×32 版本减少模糊光效与细线。
- 两个节点在所有尺寸下必须清晰可辨。
- 不依赖文字表达品牌。

## 3. 品牌替换范围

### 3.1 用户可见及系统身份

| 当前值 | 新值 |
|---|---|
| Orkas | Mate Agent |
| `com.orkas.desktop` | `com.mateagent.desktop` |
| `Orkas.app` | `Mate Agent.app` |
| `orkas://` | `mateagent://` 主协议；`orkas://` 暂作 OAuth 兼容协议 |
| 虎鲸图标 | 双节点伴星图标 |

需要覆盖：

1. `package.json` 中的描述、`productName`、`appId`、协议和安装包命名。
2. Electron `app.setName`、Windows App User Model ID、窗口、菜单和 Dock 图标。
3. macOS 源码运行时应用包名称、`Info.plist`、签名、LaunchServices 注册和 Electron `path.txt`。
4. Renderer 欢迎页、侧栏、Commander 描述、关于/帮助区域和其他用户可见文案。
5. 中文、英文、日文、葡萄牙文中的产品品牌文字。
6. 用户可见日志、启动错误和打包提示中的品牌前缀。
7. PNG、ICNS、ICO 和应用内 Logo。

### 3.2 MVP 阶段保留的内部兼容标识

以下属于实现细节，不在本次大规模重命名：

- `window.orkas` 预加载桥接对象。
- `ORKAS_*` 环境变量。
- `.orkas` 本地数据目录。
- `orkas-pkg.cjs` 等内部 CLI 文件名。
- `__orkas-meta.json` 等历史元数据文件。
- 内部 IPC channel、存储字段、类型名和历史兼容层。
- 不会正常展示给用户的代码注释与技术文档引用。

保留这些标识是为了降低回归风险，并保证当前数据和运行链路继续可用。用户可见区域不得继续显示 Orkas 品牌。

## 4. 数据与架构约束

品牌改造后仍必须满足：

```text
Orkas Conversation = 唯一会话事实源
Orkas Agent Runtime = 唯一原始执行事实源
P3394 = Task / Governance / Verification / Experience 事实源
```

这里的 Orkas 是现有内部运行内核名称，不作为新产品的用户可见品牌。

禁止：

- 新建第二套 Conversation。
- 新建第二套 Message Store。
- 新建第二套 Agent process/session runtime。
- 新建第二条 group-chat dispatch 路径。
- 绕开原始 `enqueue(...)`。
- 改变 P3394 Wake Gate、Evidence、KSTAR 和 ExperienceCandidate 的职责边界。
- 在本次改造中加入账号、云同步、多设备或团队协作。

本次继续使用 `.orkas` 数据目录，不复制大量用户数据，不更改存储格式。将来若需要 Mate Agent 与 Orkas 在同一台机器上完全独立并行运行，应另立数据目录迁移项目。

## 5. 资源与实现结构

### 5.1 图标资源

```text
src/resources/icons/
├── mate-agent-master.svg
├── icon.png
├── icon.icns
├── icon.ico
└── logo.png
```

- 母版采用 1024×1024 SVG。
- `icon.png` 为 512×512 通用图标。
- `icon.icns` 包含 macOS 所需多分辨率资源。
- `icon.ico` 包含 Windows 16–256px 多尺寸资源。
- `logo.png` 用于应用内品牌展示。
- 输出过程应可重复，不应只保留无法维护的最终位图。

### 5.2 品牌定义

品牌信息应尽可能集中，至少统一以下值：

- 英文应用名。
- 中文产品名。
- App ID。
- URL Scheme。
- 产品定位语。
- 图标资源路径。

打包配置、主进程和脚本之间无法直接共享同一种模块格式时，可以使用小型兼容配置或明确的静态一致性测试，避免为集中化而引入运行时复杂度。

### 5.3 macOS 开发运行时

现有开发脚本会把 Electron.app 重命名并修改 `Info.plist`。改造后必须：

1. 识别 Electron.app、旧 Orkas.app 和新 Mate Agent.app 三种状态。
2. 幂等地得到 Mate Agent.app。
3. 更新 `CFBundleIdentifier`、`CFBundleName`、`CFBundleDisplayName` 和 URL Scheme。
4. 更新 Electron `path.txt`。
5. 完成 ad-hoc 签名和 LaunchServices 注册。
6. 不因旧开发应用包存在而导致启动失败。

## 6. 协议与安全

新系统协议使用：

```text
mateagent://
```

要求：

- 安装包和开发运行时均声明同一 Scheme。
- Windows App User Model ID 与 `com.mateagent.desktop` 一致。
- 连接器回调只接受既有允许路径及参数，不因品牌改名扩大能力范围。
- `mateagent://` 是 Mate Agent 的主协议，安装包和开发运行时必须注册。
- 由于当前 `orkas.ai` 连接器 OAuth 落地页仍固定回跳 `orkas://connectors/...`，MVP 阶段同时注册并接受 `orkas://`，但只允许既有连接器 OAuth callback 路径。
- 旧协议不得扩展到账户登录、通用导航或任意命令执行，只作为连接器授权兼容入口。
- 等服务端能够按客户端身份生成 `mateagent://` 回跳后，再通过单独迁移移除 `orkas://`，避免当前连接器授权链路失效。
- 内部兼容代码可以保留旧命名；新代码和测试必须把 `mateagent://` 视为主协议。

## 7. 错误处理

- 图标源文件或平台图标缺失时，构建或启动检查应给出明确错误，不静默回退到 Electron 默认图标。
- 图标生成失败时不得覆盖已有有效资源。
- macOS 应用包迁移必须可重复执行，并处理旧 Orkas.app 残留。
- 改名后必须继续读取既有本地数据，不能进入意外的空白配置状态。
- 打包产物中不得同时出现用户可见的 Orkas 名称或旧虎鲸图标。
- 协议回调改名后应保留既有路径校验、状态校验和错误处理。

## 8. 测试与验收

必须执行：

1. `git diff --check`。
2. TypeScript 类型检查。
3. 全量 JavaScript/TypeScript 测试。
4. 全量 Python 测试。
5. SVG、PNG、ICNS 和 ICO 格式、尺寸与透明度检查。
6. macOS Electron 真实启动。
7. 中文界面人工检查。
8. 1280×768 和 1024×720 布局检查。
9. P3394 WakeRequest 待审批、拒绝、批准和历史恢复回归。
10. Agent Runtime 原始执行链路回归。
11. Evidence 和 KSTAR 人工验收回归。
12. ExperienceCandidate 二次批准/拒绝回归。
13. 打包配置、App ID、应用名及 `mateagent://` 主协议检查。
14. `mateagent://` 与仅限连接器 callback 的 `orkas://` 兼容回归。
15. 用户可见 Orkas 品牌残留扫描。

完成标准：

- Dock、任务栏和应用内显示双节点伴星图标。
- 系统应用名为 Mate Agent。
- 中文产品界面显示 Mate 智伴。
- 名称和图标与 Orkas 能够一眼区分。
- 原有会话、配置、Agent、Skill 和 P3394 数据仍然可读取。
- 不改变会话、执行和治理事实源边界。
- 全部自动化测试通过。

## 9. 非目标

本次明确不处理：

- 账号体系。
- 云端同步。
- 多设备。
- 团队协作。
- 底层 Agent Runtime 重写。
- Conversation 或 Message Store 重构。
- `.orkas` 数据目录的完全品牌迁移。
- `orkas.ai` 服务端 OAuth 落地页改造及旧协议移除。
- 全部内部变量、文件名和技术术语重命名。

## 10. 实施顺序

1. 建立品牌常量与静态一致性测试。
2. 创建双节点伴星 SVG 母版并生成各平台图标。
3. 修改打包和系统应用身份。
4. 修改 macOS 开发运行时应用包处理。
5. 替换用户可见文案与 Renderer Logo。
6. 更新连接器协议身份。
7. 执行品牌残留审计。
8. 执行全量自动化测试和真实 Electron QA。
