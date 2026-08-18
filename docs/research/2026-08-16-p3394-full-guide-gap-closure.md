# P3394 双文档全量补齐记录（2026-08-16）

对照 `P3394_Local_Bridge_SDK_Design`（SDK primer）与
`P3394_Raymond_Hermes_Chinese_Implementation_Guide`（实施指南）逐章审计后，
在 `dev/p3394-bridge-runtime` 分支补齐的差距。全部在
`cogseed-agent-p3394-bridge` worktree 内实现、测试并真机验证。

## 本轮补齐项

| 项 | 内容 | 位置 |
|---|---|---|
| ① 信封字段 | `spec_version`（缺省归一化 p3394/1.0）、`role`（requester/responder/observer）、`sender.delegation` 链 | `p3394_bridge/envelope.ts` |
| ② 状态机 | Session 六态（negotiating→active⇄waiting⇄suspended→closing→closed/rejected）+ epoch/version/participants；Task submitted→working→input-required→terminal，非法迁移拒绝 | `session-manager.ts`、`task-manager.ts` |
| ③ 统一注册表 | `node_kind`（agent/sub_agent/task_agent/capability/model_runtime）、`supported_profiles`、`preferred_channels`、`data_policy`、`cost_policy`；`findByCapability` 支持 requiredProfile/dataClassification 过滤；capability/model_runtime 禁止伪装 autonomous-agent | `registry.ts` |
| ④ §11 自动回发 | 对端先开口（信封带 reply_endpoint/reply_token）→ CogSeed 回答在 completed/failed 时自动 POST 回发；loopback 或已注册端点白名单（防 SSRF）；`COGSEED_P3394_AUTO_REPLY=0` 关闭 | `executor.ts`、`app-wiring.ts` |
| ⑤ Channel SDK 合约 | descriptor（id/schemes/roles/bindings/capabilities/entrypoint）、health、capabilities；按 scheme 注册 + 重复 scheme 冲突拒绝 + 必需能力缺失拒绝启动 | `channel-adapter.ts` |
| ⑥ Adapter Test Kit | 通用契约套件（descriptor/投递回执/订阅退订/健康/优雅关闭）+ `scripts/p3394-adapter-test.ts` CLI | `channel-testkit.ts` |
| ⑦ 对象存储 | `objects/sha256` 内容寻址存储、`p3394-object:` URI、>64KB 文件自动引用化、资源端点 `GET /p3394/objects/:digest`（鉴权）、接收端拉取验证 | `object-store.ts`、`http-channel.ts` |
| ⑧ Reduced Profile | A2A/MCP/OpenAI-model 映射报告（preserved/synthesized/dropped + session 语义），必需 UMF 字段被丢弃则协商失败 | `reduced-profiles.ts` |
| ⑨ A2A Channel | Agent Card 双路径获取、message/send + tasks/get 轮询、UMF↔A2A 双向映射 | `a2a-channel.ts` |
| ⑩ Model Runtime | OpenAI-compatible chat completions 投影为 reduced capability（session 由本地桥保持） | `model-runtime-adapter.ts` |
| ⑪ SA-MCP | Bridge MCP surface（stdio JSON-RPC：peer.discover/send、task.get/cancel、resource.get）+ Agent Runtime surface 消费端 `P3394McpRuntimeAdapter` + `scripts/p3394-mcp-serve.ts` | `mcp-surface.ts`、`mcp-runtime-adapter.ts` |
| ⑫ Conformance | Level 0-3 声明（当前声明 level-2-session-aware + 能力清单）；Level 2+ 必须有三项支撑、Level 3 必须 multi_party/delegation；doctor 增加 conformance-level/channel-adapter/object-store/auto-reply 检查 | `manifest.ts`、`doctor.ts` |

## 出站绑定分派

`outbound-hub` 按 peer 端点 scheme 分派：`p3394+a2a:` → A2A 绑定、
`openai+` / node_kind=model_runtime → 模型绑定、其余 → 原生 HTTP。
非原生绑定的回复信封回灌 `tryResolveReply`，`p3394_send` 等待语义不变。

## 网关同步

- hello/心跳带 `node_kind`/`supported_profiles`（`P3394_NODE_KIND`、`P3394_PROFILES`）；
- 入站 `p3394-object:` part 自动从发送方资源端点拉取并验证 digest；
- manifest 声明 level-2 conformance；信封带 spec_version/role。

## 验证

- `node scripts/run-tests.mjs run test/main/features/p3394_bridge` → 37 文件 170 用例全过；
- group_chat + chats 回归 832 用例全过；`npm run typecheck` 0 错；
- 网关 smoke 23 项全过；
- 真机：`scripts/p3394-outbound-flow.ts` 全流程（含真实 hermes）。

## 边界（超出桌面端范围，需服务端/公司决策）

- 企业目录服务 / Nexus 认知资产同步 / 多租户 ECS 联邦：需要服务端；
- npm publish（`@cogseed/p3394-gateway`）：需要公司 npm org 决策；
- Python p3394 SDK：文档默认栈为 Python，CogSeed 线用 TS/Node 等价实现；
- SQLite：仓库规则保留给 KB 向量库，P3394 状态沿用 JSON/JSONL。
