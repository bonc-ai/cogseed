# P3394 自举接入指南（给任何智能体）

> 把本文发给任意智能体（ChatGPT、Claude、自研 Agent……），它能**自己完成接入**，
> 无需人工预配置。P3394 是 IEEE 智能体互操作协议：两边交换 UMF 信封（JSON）对话。

## 0. 一分钟理解

- CogSeed 已内建 P3394，入口固定：`http://127.0.0.1:8444`（本机）
- 你接入后就能：**收到 CogSeed 的任务**（CogSeed 主动调你），或**主动给 CogSeed 发消息**
- 按你的能力三选一（见下）

## 1. 方式 A：你有 shell（本机 CLI 智能体，如 Claude Code / Codex / 自研 CLI）

安装并启动网关包（它把 P3394 信封自动翻译成你的 CLI 调用与回答）：

```bash
npm install -g @cogseed/p3394-gateway
P3394_AGENT=<预设名> p3394-gateway    # 预设: hermes/claude/codex/opencode/gemini/aider
# 自研 CLI 用自定义模板:
# P3394_AGENT_CLI=<你的命令> P3394_AGENT_CLI_ARGS='<参数模板，{message} 为消息占位>' p3394-gateway
```

启动后你的 P3394 端点在 `http://127.0.0.1:9000`；网关会**自动向 CogSeed 发 hello 注册**
（自报 agent_id / 显示名 / 本端地址 / 能力），CogSeed 记下后即可主动调用你。
CogSeed 出站信封会自动携带回复地址与令牌，你的网关**零配置**回发。

网关能力（两种模式通用）：同一 `session_id` 多轮共享会话上下文；附件按
`resource` part 端到端传递（入站落在会话 `workspace/in/`，Agent 写入
`workspace/out/` 的文件随回复回传；大文件用 `p3394-object:sha256:...`
内容寻址引用，网关自动从发送方资源端点拉取并校验 digest）；`cancel`
控制帧可中断运行中的任务。若你的 Agent 支持常驻进程 + JSONL 会话协议，
用 `P3394_AGENT_MODE=sscli`（协议 `p3394-sscli/1.0`：hello / open_session /
deliver / 事件 / cancel / heartbeat）。

可选：用 `P3394_NODE_KIND`（agent/sub_agent/task_agent/capability/model_runtime）
与 `P3394_PROFILES`（逗号分隔）声明节点类型与支持的协议 profile——CogSeed
按能力与本地优先策略解析节点。完成。

## 2. 方式 B：你是云端/网页智能体（无常驻 shell，但有 HTTP/网络工具）

不用装任何东西。以**客户端身份**直接给 CogSeed 发消息（单向/一问一答）：

```bash
curl -X POST http://127.0.0.1:8444/p3394/envelope \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <CogSeed token>' \
  -d '{"envelope":{"message_id":"m-<唯一id>","session_id":"s-<唯一id>","kind":"message",
       "performative":"request",
       "sender":{"agent_id":"<你的id>","alias":"<你的显示名>"},"recipients":[{"agent_id":"cogseed"}],
       "payload":{"parts":[{"type":"text","text":"<你的消息>"}]},
       "idempotency_key":"<唯一key>"}}'
```

Python 客户端（自研智能体同理，最小代码）：

```python
import json, uuid, urllib.request

def p3394_send(endpoint, token, agent_id, text):
    env = {
        "spec_version": "p3394/1.0",
        "message_id": f"m-{uuid.uuid4().hex[:12]}",
        "session_id": f"s-{uuid.uuid4().hex[:12]}",
        "kind": "message",
        "performative": "request",
        "sender": {"agent_id": agent_id, "alias": "<你的显示名>"},
        "recipients": [{"agent_id": "cogseed"}],
        "payload": {"parts": [{"type": "text", "text": text}]},
        "idempotency_key": f"idem-{uuid.uuid4().hex[:12]}",
    }
    req = urllib.request.Request(
        f"{endpoint}/p3394/envelope",
        data=json.dumps({"envelope": env}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    return json.load(urllib.request.urlopen(req))

print(p3394_send("http://127.0.0.1:8444", "<CogSeed token>", "<你的名字>", "你好 CogSeed"))
```

CogSeed 会在它的日常对话里处理并回复（回复可见于 CogSeed 对话界面）。
`sender.alias` 是你在 CogSeed 对话里显示的名字（可选；不填就用 agent_id）。

**想让 CogSeed 的回答自动回发给你**（而不是只显示在它的对话里）：在信封里带上
`extensions.reply_endpoint`（你的接收地址）与 `reply_token`——CogSeed 完成后
会把回答作为 `performative=inform` 的信封 POST 回该地址（§11 自动回发）。
若你是本机 HTTP 客户端，这个地址用 `http://127.0.0.1:<你的端口>` 即可。

需要**持续双向**（CogSeed 主动调你）时：让用户在本机为你跑方式 A 的网关（见 §1）。

## 2.5 方式 C：你的宿主支持 MCP（SA-MCP 双面 profile）

若你运行在支持 MCP 工具的宿主里（Claude Desktop 类、自研 MCP host），可把
CogSeed 的 P3394 能力作为 MCP 工具挂载：

```bash
npx tsx <cogseed仓库>/scripts/p3394-mcp-serve.ts
```

暴露的工具：`p3394.peer.discover`（列节点）、`p3394.peer.send`（发消息等回复）、
`p3394.task.get` / `p3394.task.cancel`、`p3394.resource.get`（内容寻址对象）。
该进程自带回环回复监听（默认端口 18444，`P3394_MCP_REPLY_PORT` 覆盖）。

## 3. 令牌与地址

- CogSeed 入站令牌持久化于其运行目录 `p3394-bridge.json` 的 `token` 字段（重启不变）
- CogSeed 出站信封的 `extensions` 携带 `reply_endpoint` / `reply_token`——**你回发时直接用它们**，无需询问用户

## 4. 自检清单（接入后逐项确认）

1. 你的端点/客户端能收到 CogSeed 消息，或你能成功 POST 到 CogSeed
2. 回复信封 `kind` 用 `message`、`performative` 用 `inform`，`session_id` 与来信一致
3. 同一 `idempotency_key` 只处理一次
