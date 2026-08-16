# P3 版本比对 —— 前端接入点

本轮（P3）只做到 main 侧：版本比对、新读口、四类变更待办。**没有改任何
renderer 文件，也没有加任何 i18n 键**——认知资产一级页面正在由另一条线改造，
四个 locale 文件都在它的改动范围里，P3 加键必然冲突。

页面改造合入后，按下面清单一次性接线即可，接线本身不含新判断逻辑。

## 1. 版本与治理：显示「这一版改了什么」

**读口**：`cognition.assets.diff` → `{ ok, diffs: AssetVersionDiff[] }`，最新的在前。

```ts
interface AssetVersionDiff {
  assetId: string;
  fromVersion: string;
  toVersion: string;
  at: string;
  reason?: string;
  actor?: 'user' | 'system';
  changes: { kind: AssetChangeKind; field: string; before: string; after: string }[];
  kinds: AssetChangeKind[];   // 本次涉及的分类，影响面从大到小排好序
}
```

`before` / `after` 已格式化成可读文本（空值为 `—`，条件列表用 `、` 连接，
证据只给条数），渲染层直接显示，不要再解析结构。

接入位置：`renderSkillsCognitionGovernance` 里 `_renderRecallAssetHistory`
展开的版本面板——每个版本行下面挂它相对上一版的 changes。第一版没有 diff
（没有可对比的前一版），这是刻意的，不要显示成"全部字段都改了"。

## 2. 待我处理：四类新待办的文案

`cognition.inbox.list` 现在可能返回这四个新 `kind`，
`_cognitionInboxKindLabel` / `_cognitionInboxKindHint` 需要补对应分支与
四语言键：

| kind | 打扰级 | 建议中文文案 | 建议 hint |
|---|---|---|---|
| `sensitivity_escalated` | confirm | 敏感级被升高 | 这条资产能带往的目的地变多了，请确认这次扩权。 |
| `rule_scope_changed` | confirm | 规则的作用范围变了 | 系统改动了它的适用/禁止范围，它从此会进出一批不同的任务。 |
| `skill_upgrade_suggested` | confirm | Skill 可以升版 | 方法在生成 Skill 之后又改过，已装的 Skill 落后于资产。 |
| `template_updated` | low_disturbance | 模板正文被更新 | 系统改写了模板内容，确认后继续使用。 |

`detail` 字段服务端已填好可读内容（如 `L0 → L2`、`处理需求评审时 → 所有任务`、
`1 → 2`），渲染层直接显示。

需要的 i18n 键（四语言各 8 个）：
`cognition.inbox_sensitivity_escalated` / `_hint`、
`cognition.inbox_rule_scope_changed` / `_hint`、
`cognition.inbox_skill_upgrade` / `_hint`、
`cognition.inbox_template_updated` / `_hint`。

未补键时不会出错：`_cognitionInboxKindLabel` 对未知 kind 回退成 kind 字符串，
条目仍然可点，只是标题是英文枚举名。

## 3. 两条刻意的规则（接线时不要绕过）

**变更类待办只报系统线改的。** 用户自己刚改过的边界不需要再回来问他一遍——
他就是那个改的人。这条同时是「永不消失的待办」的解法：没有已读状态可存，
但用户一旦自己编辑或确认过（产生一次 `actor: 'user'` 的版本），变更类待办就
自动退场。唯一例外是 `skill_upgrade_suggested`——已装的 Skill 不会跟着方法自己
变，所以不看 actor。

**没有版本历史时，变更类待办整体不产出。** 读不到 ≠ 没变过。

## 4. 尚未接的一类

「关于我的事实冲突」仍未实现。本机 `personal` 类资产为 0 条，没有可验证的
真实样本；personal 内部的事实级冲突（"我在 A 公司" vs "我在 B 公司"）需要语义
比对，不能靠字符串相等，在没有样本的情况下不适合猜着做。当前的
`classification_conflict` 只覆盖"同一句话被归成两个类型"。
