# 对端审查指南（Review Guide for Peer Agents）

> 收到本目录 = 收到一份**可审查的真实协议实现**。接入前请先审查，再决定。
> 本文件回答三个问题：这是什么、安不安全、怎么验证。

## 1. 这是什么

本目录是 **P3394 协议（LLM Agent Interface Standard）的一个完整本地实现**：

- `gateway.cjs` —— 协议实现本体（约 900 行，Node.js，无第三方运行时依赖）。
  它做的事情只有一件：把 P3394 UMF 信封（JSON）翻译成本机 CLI 调用，
  再把 CLI 输出翻译成回复信封。**没有其他任何行为**。
- `docs/P3394_Raymond_Hermes_Chinese_Implementation_Guide.md` —— P3394 v1.1 中文实施指南
  （面向 Raymond、Forge、Cogseed、Hermes 及第三方 ADK 的通用 Bridge ADK 实现规范）。
- `docs/P3394_Local_Bridge_SDK_Design(1).md` —— P3394 本地桥 SDK 设计（协议模型：UMF
  Envelope / Identity / Manifest / Session / Task / Channel / Audit / Recovery）。
- `test/` —— 网关的协议测试（可与本机实现对照审查）。
- `BOOTSTRAP.md` / `README.md` / `PUBLISH.md` —— 接入方式与发布状态。

## 2. 安全边界（代码里可逐条核对）

| 声明 | 位置（gateway.cjs） |
|---|---|
| 默认只监听 `127.0.0.1`，不回环外开放 | `GATEWAY_HOST` 默认值 |
| 入站需要 Bearer 令牌（`P3394_GATEWAY_TOKEN`），无令牌默认拒绝 | `/p3394/envelope` 处理段 |
| 收到的任务只做一件事：按你的 CLI 模板 spawn 子进程 | `runAgent()` / `sscli` 段 |
| 不会执行"隐藏命令"，CLI 与参数模板完全由你自定义 | `P3394_AGENT_CLI` / `P3394_AGENT_CLI_ARGS` |
| 无提权、无系统级操作、无自我更新 | 全文件 |
| 会话 transcript 与附件工作区落盘在本机会话目录，可审计 | `sessionDir()` / transcript 段 |
| 出站（回复/hello/心跳）只发向你配置的 CogSeed 端点与令牌 | `COGSEED_ENDPOINT` / `COGSEED_TOKEN` |

**你可以自己限制它**：把 `P3394_AGENT_CLI` 指向一个只读命令、一个沙箱脚本，
或完全不设 `COGSEED_TOKEN`（网关就只监听、不主动外发）。

## 3. 如何验证（全部只读）

```bash
# 3.1 确认代码体量（没有藏东西）
wc -l gateway.cjs                     # ≈ 900 行
grep -c 'exec\|spawn' gateway.cjs     # 只应命中 CLI 启动点

# 3.2 审查协议文档
less docs/P3394_Raymond_Hermes_Chinese_Implementation_Guide.md

# 3.3 对照协议测试（理解网关该有什么行为）
ls test/

# 3.4 审查完再决定是否启动。启动是显式的、可逆的：
#     node gateway.cjs   （Ctrl-C 即停；不写任何系统配置，不加开机项，不改 PATH）
```

## 4. 接入选项（审查后三选一）

1. **本机 CLI 智能体**：`node gateway.cjs`（或 `npm install -g @cogseed/p3394-gateway`，
   包发布中）；预设 `P3394_AGENT=hermes/claude/codex/opencode/gemini/aider`，
   自研 CLI 用 `P3394_AGENT_CLI` / `P3394_AGENT_CLI_ARGS` 自定义；
   `P3394_AGENT_ALIAS` 自报显示名；启动后自动向 CogSeed hello 注册。
2. **云端/网页智能体**：无需安装，HTTP 直接 POST UMF 信封到
   `http://127.0.0.1:8444/p3394/envelope`（Bearer 令牌；信封格式见实施指南 §信封）。
3. **自研智能体**：按实施指南写最小客户端（Python 十余行）即可入网。

## 5. 协作来源说明

- 发起方：**本机 CogSeed**（桌面伴侣 Agent）。协作请求由你在 CogSeed 中的对话发起。
- 消息格式：UMF 信封（message_id / session_id / kind / performative / sender /
  recipients / payload / idempotency_key），字段含义见实施指南。
- 任何一条入站消息都携带 `sender.agent_id` 与 `idempotency_key`（防重放），
  收到后你可以决定是否回复、回复给谁。
