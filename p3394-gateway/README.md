# @cogseed/p3394-gateway

给对端 Agent 装的 **P3394 实现包**。装上即内建 P3394，与 CogSeed 直接互通 ——
中间没有转接层，包本身就是 P3394 在对端的那一半（收消息 → 交给本机 Agent 模型 → 回消息）。

## 安装/获取（对端机器上；本地优先，避免不必要的 NPM 拉取）

按顺序检查，有就直接用：

```bash
# a) 已全局安装过 → 直接用
command -v p3394-gateway

# b) CogSeed 自带副本（CogSeed 桌面版内置此包，无需 NPM）：
#    开发仓库: <仓库根>/p3394-gateway/gateway.cjs
#    macOS 已安装应用:
ls /Applications/CogSeed*.app/Contents/Resources/app.asar.unpacked/p3394-gateway/gateway.cjs
#    Windows: <安装目录>/resources/app.asar.unpacked/p3394-gateway/gateway.cjs
#    找到后直接启动（等同于装了包）:
#    node <上面找到的路径>

# c) 以上都没有才从 NPM 装（包发布中；失败回退 b 用 CogSeed 自带副本）
npm install -g @cogseed/p3394-gateway
```

> 包尚未正式发布时，本地副本（b）是首选方式：拿到 `gateway.cjs` 后直接
> `node gateway.cjs`（配置环境变量同上）。发布进度见 `PUBLISH.md`。

## 启动

默认适配 Hermes（需要本机已装 `hermes` CLI）：

```bash
COGSEED_ENDPOINT=http://127.0.0.1:8444 \
COGSEED_TOKEN=<CogSeed 的桥接令牌> \
p3394-gateway
```

网关**启动即注册**：向 CogSeed 发一个 hello 信封，自报 agent_id / 显示名 / 本端
地址，CogSeed 自动把它记进 P3394 注册表（含 endpoint）。注册完成后，用户在
CogSeed 对话里说"问一下 Hermes"，Commander 就会通过 P3394 直接调用本机 Hermes
的真实模型，并把回答带回来——即「CogSeed 先发消息 → 对端装包上线即注册 →
再互相通信」的流程。

## 适配其他 Agent

内置预设，`P3394_AGENT=<预设名>` 一键切换：

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
  transcript 与工作区，多轮对话自动携带历史上下文。
- **sscli**：`P3394_AGENT_MODE=sscli` 常驻单个 CLI 进程，按 `p3394-sscli/1.0`
  JSONL 协议交换 hello / open_session / deliver / 事件 / cancel / heartbeat
  （指南 §9.2），适合支持结构化会话协议的 Agent Runtime。

两种模式通用：

- **ECS 注册与心跳**：启动 hello 自注册（身份/显示名/地址/能力/node_kind/
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
| `P3394_GATEWAY_HOST` | 127.0.0.1 | 监听地址（ECS 跨机器填局域网 IP；默认回环，安全优先） |
| `P3394_HEARTBEAT_MS` | 60000 | ECS 心跳间隔（向 CogSeed 报活刷新在线状态；0 关闭） |
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
| `P3394_NODE_KIND` | agent | 注册节点类型：agent/sub_agent/task_agent/capability/model_runtime（注册进 CogSeed 统一节点注册表） |
| `P3394_PROFILES` | p3394-session/1.0,p3394-artifact/1.0 | 自报支持的协议 profile（逗号分隔，随 hello/心跳上报） |

## 安全

- 仅监听 127.0.0.1，不暴露到网络
- 消息文本以参数数组传给 CLI（不经 shell，无注入）
- 同一 idempotency_key 只处理一次（模型不重复跑）

