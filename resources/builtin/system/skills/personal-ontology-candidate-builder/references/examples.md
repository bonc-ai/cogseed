# Examples

## Example 1: Preference Candidate（偏好，最常见类型）

对话片段：

```text
用户在多轮对话中反复要求："别整那些花里胡哨的术语，直接说人话。"
```

输出候选：

```markdown
### cand-comm-style-01
- 类型: preference
- 置信度: high
- 摘要: 喜欢直接说人话，不要堆术语
- 记忆去向: user
- 记忆文本: 沟通风格：喜欢直接、口语化的解释，不要堆砌术语
- 来源: conv-abc123-turn-4, conv-abc123-turn-9, conv-def456-turn-2
```

（这条被三次不同对话引用支撑，所以是 `high` 置信度；只出现一次的类似内容应该标 `medium` 或 `low`。）

## Example 2: Rule Candidate（经验规则）

对话片段：

```text
用户说："以后 API 返回空结果的时候，就正常显示空状态，别自动 fallback 到假数据。"
```

输出候选：

```markdown
### cand-rule-no-mock-01
- 类型: rule
- 置信度: high
- 摘要: API 返回空结果时显示空状态，不要 fallback 到假数据
- 记忆去向: shared
- 记忆文本: 规则：API 返回空结果时显示空状态，不自动 fallback 到 mock 数据
- 来源: conv-xyz789-turn-15
```

## Example 3: Instance Candidate（实例）

对话片段：

```text
用户提到正在做一个叫"晚风"的读书笔记 App，用 Flutter 写的。
```

输出候选：

```markdown
### cand-project-wanfeng-01
- 类型: instance
- 置信度: medium
- 摘要: 用户在开发一个叫"晚风"的读书笔记 App，技术栈是 Flutter
- 记忆去向: shared
- 记忆文本: 项目「晚风」：读书笔记类 App，技术栈 Flutter
- 来源: conv-proj-intro-turn-1
```

## Example 4: Blocked Item（阻断项）

对话片段：

```text
用户粘贴了一段包含真实 API Key 的配置。
```

输出阻断项：

```markdown
### mem-config-with-key
- 原因: 内容包含未脱敏的 API Key
- 修复建议: 移除或替换 API Key 后再重新提炼这条候选
```

## Example 5: 第三方内容（不是用户本人的偏好）

对话片段：

```text
用户说："我朋友老王特别不爱用微信语音，每次都让我打字。"
```

输出候选：

```markdown
### cand-relation-friend-pref-01
- 类型: relation
- 置信度: medium
- 摘要: 用户的朋友"老王"不喜欢用语音消息，偏好文字沟通
- 记忆去向: shared
- 记忆文本: 用户朋友"老王"偏好文字沟通，不喜欢语音消息
- 来源: conv-chat-turn-7
```

（注意：这条是关于"老王"的偏好，不是用户自己的偏好，所以不该塞进 `memory_scope: user`，而应该作为一条 `relation` 放进 `shared`，并在摘要里说清楚是谁的偏好。）
