# @cogseed/p3394-gateway

给对端 Agent 装的 **P3394 实现包**。装上即内建 P3394，与 CogSeed 直接互通 ——
中间没有转接层，包本身就是 P3394 在对端的那一半（收消息 → 交给本机 Agent 模型 → 回消息）。

## 先审查，再接入

本目录是**可审查的真实协议实现**：`gateway.cjs` 是完整源码（约 900 行，无第三方运行时
依赖），`test/`
是协议测试。安全边界（默认仅回环监听、Bearer 令牌、CLI 完全自定义、无提权、会话留痕）
逐条可核对。完整审查指引见 **`REVIEW.md`**——对端智能体接入前请先读它。

## 安装/获取（对端机器上；本地优先，避免不必要的 NPM 拉取）

按顺序检查，有就直接用：

```bash
# a) 已全局安装过 → 直接用
#    POSIX: command -v p3394-gateway
#    Windows: where p3394-gateway

# b) CogSeed 自带副本（CogSeed 桌面版内置此包，无需 NPM）：
#    开发仓库: <仓库根>/p3394-gateway/gateway.cjs
#    macOS 已安装应用:
ls /Applications/CogSeed*.app/Contents/Resources/app.asar.unpacked/p3394-gateway/gateway.cjs
#    Windows 已安装应用:
dir "%LOCALAPPDATA%\Programs\cogseed\resources\app.asar.unpacked\p3394-gateway\gateway.cjs"
#    找到后直接启动（等同于装了包）:
#    node <上面找到的路径>

# c) 需要全局命令时，从当前仓库源码安装：
cd <仓库根>/p3394-gateway
npm install -g .
```

直接运行 `gateway.cjs` 不会写入系统配置；只有需要全局
`p3394-gateway` 命令时才需要执行 `npm install -g .`。

## 启动

默认适配 Hermes（需要本机已装 `hermes` CLI）：

```bash
COGSEED_ENDPOINT=http://127.0.0.1:8444 \
COGSEED_TOKEN=<CogSeed 的桥接令牌> \
p3394-gateway
```

> **`COGSEED_TOKEN` 从哪拿**：它是 CogSeed 的 P3394 桥接令牌，持久化在
> CogSeed 运行目录的 `p3394-bridge.json` 文件（`token` 字段），重启不变。
> 通常本机 CogSeed 已自动生成并存好该令牌——直接读取该文件即可：
> `cat <CogSeed运行目录>/p3394-bridge.json` 里的 `"token"` 值。
> 若本机 CogSeed 尚未开启 P3394 桥，请先在 CogSeed 的「外接」入口连接一个
> 本机 Agent（此时会生成并持久化令牌），再回来读它。也可以先不填令牌启动：
> 网关仍会正常监听回环，但 CogSeed 会在注册/回发时拒绝未授权令牌。

网关**启动即注册**：向 CogSeed 发一个 hello 信封，自报 agent_id / 显示名 / 本端
地址，CogSeed 自动把它记进 P3394 注册表（含 endpoint）。注册完成后，用户在
CogSeed 对话里说"问一下 Hermes"，Commander 就会通过 P3394 直接调用本机 Hermes
的真实模型，并把回答带回来——即「CogSeed 先发消息 → 对端装包上线即注册 →
再互相通信」的流程。

## 适配其他 Agent（任意名字都可接入）

### 三步接入（统一包 · 装包即用，G-35）

本包就是**任意智能体的 P3394 统一接入包**：装上它，任何一次性命令行形态的
智能体（不原生讲协议也行）立即成为一个讲 `p3394-sscli/1.0` 的 P3394 节点
（内置通用垫片协议化：delta 流式 / 会话连续 / 取消 / 心跳）。

```bash
# 1. 拿到本包（CogSeed 仓库 p3394-gateway/ 目录，或已安装的桌面版内置副本）
# 2. 一条命令接入你的智能体（--agent 启动默认走 sscli）：
node gateway.cjs --agent my-agent --exec my-agent --args '{message} --headless'
# 3. 在 CogSeed「智能体总览 → 外接·本机」添加 my-agent 即可协作。
#    （原生讲 p3394-sscli 协议的智能体加 --native 直连，不经垫片）
```

命令行参数：`--agent <名>  --exec <命令>  --args '<参数模板>'  --port <端口>
--home <目录>  --native`（`node gateway.cjs --help` 有完整说明；参数优先于
同名环境变量）。CogSeed 托管侧同样默认全量 sscli：任意自接 CLI 经垫片接入，
个别 CLI 需回退 oneshot 时设 `COGSEED_P3394_SSCLI_EXCLUDE=名字1,名字2`。

### 环境变量方式（等价）

**预设只是便捷模板，不是白名单**——P3394 面向任意智能体/任意程序，`P3394_AGENT` 填任何名字都能启动：

| 情况 | 身份 | 实际执行 |
|---|---|---|
| 内置预设名（hermes/claude/codex/…） | 预设 id | 预设模板（见下表） |
| **任意名字**（如 `pi`、`my-agent`、程序名） | **就是这个名字** | **同名命令 + 把消息作为唯一参数**（`<名字> {message}`） |
| 任意名字 + 自定义参数 | 就是这个名字 | `P3394_AGENT_CLI` / `P3394_AGENT_CLI_ARGS` 完全自定义 |

```bash
P3394_AGENT=pi p3394-gateway
# 身份=pi，执行 `pi {message}`；如果 pi 需要特定参数（如 -p 无头模式）：
P3394_AGENT=pi P3394_AGENT_CLI_ARGS='-p {message} --no-session' p3394-gateway
```

内置预设表：

| 预设名 | Agent | 调用方式 |
|---|---|---|
| `hermes`（默认） | Hermes | `hermes -z {message} --cli` ✅ 真机验证 |
| `claude` | Claude Code | `claude -p {message}` ✅ 真机验证 |
| `codex` | OpenAI Codex CLI | `codex exec {message}` |
| `opencode` | OpenCode | `opencode run {message}` |
| `gemini` | Google Gemini CLI | `gemini -p {message}` |
| `aider` | Aider | `aider --message {message} --yes` |

```bash
P3394_AGENT=claude p3394-gateway   # 换成 Claude Code
P3394_AGENT=codex p3394-gateway   # 换成 Codex
```

其他 Agent 用自定义模板覆盖预设：

```bash
P3394_AGENT_CLI=my-agent P3394_AGENT_CLI_ARGS='ask {message}' p3394-gateway
```

> 各 CLI 语法以本机安装版本为准；预设基于官方文档的 headless/oneshot 模式。

## 运行模式与能力

- **oneshot（默认）**：每消息 spawn 一次 CLI；网关按 `session_id` 维护会话
  transcript 与工作区，多轮对话自动携带历史上下文。运行期间 CLI 印到
  stdout/stderr 的可见输出会实时以 **stream delta 帧** 回发 CogSeed（气泡边
  输出边增长，不必等工具+回复跑完）；`openclaw` 预设整体排除（其 CLI 无中间
  分片、最终 JSON 回复信封写在 stderr 末尾，保持一次性回发）。可用
  `P3394_DISABLE_ONESHOT_STREAM=1` 关闭。
- **CLI 原生会话恢复（resume，G-27）**：预设表登记了 `resumeArgs` 的 CLI
  （opencode `--session`、openclaw `--session-id`、claude 降级模式 `--resume`）
  由网关在会话目录维护 `cli-session.json`（CLI 自己的会话号），下轮 spawn
  自动追加恢复参数——CLI 自己恢复完整上下文，prompt 只带本轮新内容，**不再
  回放 `[会话历史]`**。会话号来源两种：从 CLI 输出按 `sessionIdPattern`
  正则提取（opencode/claude），或由网关生成 UUID 传入（`sessionGenerate`，
  openclaw）。会话被拒（not found / expired 等特征）时自动清绑定、退回
  transcript 回放重试一次。未登记 resume 的 CLI（gemini/hermes/aider/
  workbuddy）行为不变，继续 transcript 回放兜底；常驻后端（claude 常驻 /
  codex app-server）自管会话，不走此机制。新 CLI 接入 resume 只需在预设表
  加同款字段。
- **sscli**：`P3394_AGENT_MODE=sscli` 常驻单个 CLI 进程，按 `p3394-sscli/1.0`
  JSONL 协议交换 hello / open_session / deliver / 事件 / cancel / heartbeat
  （指南 §9.2）。**已全面落地（过渡桥）**：原生讲协议的 CLI 直连
  （`P3394_SSCLI_NATIVE=1`，目前为测试桩与未来原生支持者预留）；其余全部
  预设（hermes/gemini/aider/openclaw/opencode/workbuddy）由 CogSeed 托管时
  自动经 **sscli-shim 通用垫片**（`sscli-shim.cjs`）接入——shim 对网关讲
  协议、内部每轮 spawn 真实 CLI（resume/transcript 语义与 oneshot 一致，
  会话状态落 `<home>/shim-sessions/`）。P3394 标准推广、CLI 原生实现协议
  后撤垫片换直连即可，登记与上层零改动。`COGSEED_P3394_SSCLI_SHIM=0`
  可单独撤垫片回退 oneshot（claude 不受影响）。

两种模式通用：

- **注册与心跳**：启动 hello 自注册（身份/显示名/地址/能力/node_kind/
  profiles），之后按 `P3394_HEARTBEAT_MS` 周期报活——CogSeed 侧可看到本节点
  在线状态；
- **会话连续性**：同一 `session_id` 的多轮消息共享会话目录与 transcript；
- **Artifact 传递**：入站 `resource/artifact` part 落盘到会话
  `workspace/in/` 并把路径告诉 Agent；Agent 运行期间写入
  `workspace/out/` 的文件随回复作为 resource part 回传；
- **内容寻址对象**：入站 `p3394-object:sha256:...` part 自动从发送方资源
  端点（`/p3394/objects/<digest>`）拉取并校验 digest（§12）；
- **取消**：`kind=control` + `performative=cancel` + `task_id` 控制帧立即
  终止运行中的任务（绕过串行队列）；
- **§11 自动回发**：向 CogSeed 发消息（先开口）时用信封
  `extensions.reply_endpoint/reply_token` 声明回发地址，CogSeed 的回答会
  自动送回本网关；
- **协议版本**：出站信封（hello/心跳/回复）均带 `spec_version: p3394/1.0`
  与角色字段（`role: responder`）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `P3394_GATEWAY_PORT` | 9000 | 本端 P3394 端点端口 |
| `P3394_GATEWAY_HOST` | 127.0.0.1 | 监听地址（跨机器填局域网 IP；默认回环，安全优先） |
| `P3394_HEARTBEAT_MS` | 60000 | 心跳间隔（向 CogSeed 报活刷新在线状态；0 关闭） |
| `P3394_GATEWAY_HOME` | ~/.p3394-gateway | 会话目录/transcript/工作区根目录 |
| `P3394_ADVERTISE_ENDPOINT` | http://127.0.0.1:9000 | 启动时向 CogSeed 自报的本端地址（跨机器填对端可达的 IP） |
| `P3394_GATEWAY_TOKEN` | 空 | 本端入站鉴权（空 = 不鉴权，仅回环监听） |
| `COGSEED_ENDPOINT` | http://127.0.0.1:8444 | 回复发回的 CogSeed 端点 |
| `COGSEED_TOKEN` | 空 | 回发 CogSeed 的 Bearer 令牌 |
| `P3394_AGENT` | hermes | 预设名：hermes/claude/codex/opencode/gemini/aider |
| `P3394_AGENT_ID` | 随预设 | 本节点 agent_id（写进 manifest） |
| `P3394_AGENT_ALIAS` | 空 | 自报显示名（写进 sender.alias 与 manifest；CogSeed 对话里显示这个名字） |
| `P3394_AGENT_MODE` | oneshot | `oneshot`（每消息 spawn CLI）或 `sscli`（常驻 CLI + JSONL 协议） |
| `P3394_AGENT_CLI` | 随预设 | 自定义 CLI（覆盖预设） |
| `P3394_AGENT_CLI_ARGS` | 随预设 | CLI 参数模板，{message} 为消息占位（覆盖预设） |
| `P3394_AGENT_TIMEOUT_MS` | 600000 | Agent 单次回答上限 |
| `P3394_DISABLE_ONESHOT_STREAM` | 空 | `1` 关闭 oneshot 模式增量输出回发（默认开启） |
| `P3394_STREAM_POST_TIMEOUT_MS` | 15000 | 流式回发单帧 POST 请求超时（对端不响应时保证终态回复不被拖死） |
| `P3394_STREAM_FINISH_DEADLINE_MS` | 30000 | 流式回发 finish() 对整条 delta 链的整体截止（异常慢时让位给终态） |
| `P3394_NODE_KIND` | agent | 注册节点类型：agent/sub_agent/task_agent/capability/model_runtime（注册进 CogSeed 统一节点注册表） |
| `P3394_PROFILES` | p3394-session/1.0,p3394-artifact/1.0 | 自报支持的协议 profile（逗号分隔，随 hello/心跳上报） |

## 许可证与来源

本包是 CogSeed（桌面伴侣 Agent）的一部分，随 @cogseed/p3394-gateway 以 [MIT](./LICENSE) 许可证发布（CogSeed + BONC 东方国信）。上游来源与第三方依赖声明见同目录 NOTICE。本包无第三方运行时依赖（仅用 Node.js 内置模块）。

本包实现的 "P3394" 指 IEEE P3394 智能体互操作标准，该标准仍归其标准组织所有。更多三方上游信息见项目根目录 NOTICE 与 THIRD_PARTY_NOTICES.md。

## 安全

- 仅监听 127.0.0.1，不暴露到网络
- 消息文本以参数数组传给 CLI（不经 shell，无注入）
- 同一 idempotency_key 只处理一次（模型不重复跑）
