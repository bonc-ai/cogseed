# Cognition Lifecycle Graph

这个 Graph 负责认知资产的生命周期，不负责把认知资产本身建模成知识图谱。

```mermaid
flowchart TD
  A[capture_candidate] --> B[validate_evidence]
  B -->|valid| C{human_review}
  B -->|invalid| F[failed]
  C -->|confirm| D[activate_memory]
  C -->|defer| P[pending/deferred]
  C -->|reject| P
  D -->|completed| E[verify_activation]
  D -->|retryable and bounded| D
  D -->|unrecoverable| F
  E -->|bound and reuse < 3| G[active]
  E -->|bound and reuse >= 3| H[bright]
  E -->|binding mismatch| F
  G --> I[record_reuse]
  I -->|reuse < 3| G
  I -->|reuse >= 3| H
  G --> J[reconcile_memory]
  H --> J
  J -->|valid| G
  J -->|valid and reuse >= 3| H
  J -->|missing/changed| K[invalidated]
```

核心约束：

- `human_review` 是唯一允许进入 `activate_memory` 的人工门，模型或路由器不能绕过它。
- `activate_memory` 使用认知资产 ID 和正文哈希做幂等键；重试不会产生重复长期记忆。
- 每次副作用前后都有检查点，写入失败会保留可重试状态。
- 复用和失效都是有界、单调的状态转移；不存在无限重试或无限复用循环。
- 所有跨节点状态都是结构化字段，不能依赖重新回放完整聊天历史。

机器可读契约见 [`cognition-lifecycle-graph-spec.json`](./cognition-lifecycle-graph-spec.json)。
