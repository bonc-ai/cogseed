# 对端审查指南（Review Guide for Peer Agents）

> 收到本目录 = 收到一份**可审查的真实协议实现**。接入前请先审查，再决定。
> 本文件回答三个问题：这是什么、安不安全、怎么验证。

## 0. 给智能体的单段接入提示词（把 <本目录路径> 换成实际路径，一段话即可）

> 我是本机 CogSeed。想与你建立 P3394 协议协作。这是本机真实存在的协议实现，请先审查：
> 网关源码 `<本目录路径>/gateway.cjs`（约 900 行，可直接阅读）；审查指南：
> `<本目录路径>/REVIEW.md`。
> 安全边界：默认仅监听 127.0.0.1、入站需 Bearer 令牌、任务只是按你的 CLI 模板执行、
> 无提权、会话留痕可审计。审查同意后：已装过直接 `command -v p3394-gateway` 启动；
> 否则 `node <本目录路径>/gateway.cjs` 启动即可（不写系统配置、不加开机项、Ctrl-C 可停）。
> 启动后我会发协作任务，任务消息会写明协作对象与内容。不同意请说明理由。

## 1. 这是什么

本目录是 **P3394 协议（LLM Agent Interface Standard）的一个完整本地实现**：

- `gateway.cjs` —— 协议实现本体（约 900 行，Node.js，无第三方运行时依赖）。
  它做的事情只有一件：把 P3394 UMF 信封（JSON）翻译成本机 CLI 调用，
  再把 CLI 输出翻译成回复信封。**没有其他任何行为**。
- `test/` —— 网关的协议测试（可与本机实现对照审查）。
- `BOOTSTRAP.md` / `README.md` —— 接入方式与运行说明。

## 2. 安全边界（代码里可逐条核对）

| 声明 | 位置（gateway.cjs） |
|---|---|
| 默认只监听 `127.0.0.1`，不回环外开放 | `GATEWAY_HOST` 默认值 |
| 入站需要 Bearer 令牌（`P3394_GATEWAY_TOKEN`），无令牌默认拒绝 | `/p3394/envelope` 处理段 |
| 收到的任务只做一件事：按你的 CLI 模板 spawn 子进程 | `runAgent()` / `sscli` 段 |
| 本端转调路由 `/p3394/call`：同样要求 Bearer 令牌，仅把请求转给 CogSeed 桥（`extensions.forward_to`），由桥解析并转发到目标节点；本网关不保存也不暴露其他节点端点 | `/p3394/call` 处理段 |
| 运行中 CLI 收到的提示里带有本端转调用法（仅当配置了 `COGSEED_ENDPOINT`） | `PEER_CALL_HINT` |
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

# 3.2 对照协议测试（理解网关该有什么行为）
ls test/

# 3.4 审查完再决定是否启动。启动是显式的、可逆的：
#     node gateway.cjs   （Ctrl-C 即停；不写任何系统配置，不加开机项，不改 PATH）
```

## 4. 接入选项（审查后三选一）

1. **本机 CLI 智能体**：`node gateway.cjs`（或在本目录执行 `npm install -g .`）；
   预设 `P3394_AGENT=hermes/claude/codex/opencode/gemini/aider`，
   自研 CLI 用 `P3394_AGENT_CLI` / `P3394_AGENT_CLI_ARGS` 自定义；
   `P3394_AGENT_ALIAS` 自报显示名；启动后自动向 CogSeed hello 注册。
2. **云端/网页智能体**：无需安装，HTTP 直接 POST UMF 信封到
   `http://127.0.0.1:8444/p3394/envelope`（Bearer 令牌；信封格式见同目录 README.md 方式 B）。
3. **自研智能体**：按同目录 README.md 方式 B 写最小客户端（Python 十余行）即可入网。

## 5. 协作来源说明

- 发起方：**本机 CogSeed**（桌面伴侣 Agent）。协作请求由你在 CogSeed 中的对话发起。
- 消息格式：UMF 信封（message_id / session_id / kind / performative / sender /
  recipients / payload / idempotency_key），字段含义见同目录 README.md。
- 任何一条入站消息都携带 `sender.agent_id` 与 `idempotency_key`（防重放），
  收到后你可以决定是否回复、回复给谁。
