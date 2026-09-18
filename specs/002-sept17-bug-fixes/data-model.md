# Data Model: 9.17 Bug 清单修复

## ChatEntryChoice（既有，未改结构）

`pickChatEntryGroup()` 的返回元素。本次仅改变「哪些条目可以进入返回集」。

| 字段 | 说明 |
|---|---|
| `entryId` | 条目 id |
| `profileId` | 凭据 profile id（冷却以它为键） |
| `provider` / `model` | 运行时选择 |
| `apiKey` | 已解析凭据（不落盘、不进日志） |
| `baseUrl` / `maxOutputTokens` | 可选覆盖 |

状态归类：
- **健康候选**：`isEntryAllowed` 为真、密钥可解析、未冷却 → 主候选集
- **冷却兜底候选**：`isEntryAllowed` 为真、密钥可解析、`isCooledDown` 为真 → 仅当主集为空时返回
- **不可用**：禁用 / 已删除 / 密钥无法解析 → 任何情况都不返回

## 表单提交值（既有契约 + 一个可选键）

`<agent-input-submission form_id=... agent_id=...>` 标签体为 JSON 对象，键为字段 id。

- 普通提交：仅字段 id
- 跳过提交：字段 id（未作答为空值）+ `__skipped: true`

`decodeSubmission` 按 `Record<string, unknown>` 解析，未知键透传给消费方；主进程摘要生成按 `form.fields` 遍历，不受影响。

## 问答输入框高度

| 状态 | 高度 | 溢出 |
|---|---|---|
| 单行 | 26px（最小） | hidden |
| 多行未超上限 | `scrollHeight` | hidden |
| 超过上限 | 120px | auto（纵向滚动） |
| 发送后 | 复位 26px | hidden |
