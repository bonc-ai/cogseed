# 社区 Agent 试点

[English](./README.md)

社区 Agent 把一个完整任务交给 AI 完成：它用一段工作流说明先做什么、后做什么，并调用
它自带的 Skill 完成其中的步骤。本试点接收声明式、纯文本的 Agent，提交格式以 CogSeed
客户端的 Agent 包格式（`agent-package-v1`）为准。

当前用户还不能在 CogSeed 客户端里直接安装社区 Agent，所以本试点**不要求安装实测**，
评审按格式和内容质量判断。PR 合并只代表"社区候选已评审"，不代表已发布到 CogSeed Hub
或随正式版本分发。

## 贡献流程

1. 选择任一入口：
   - 认领一个 `community agent` 推荐 Issue；或
   - 自主设计 Agent，无需事前批准，也不强制创建或关联 Issue。
2. 先搜索已有 Agent 和开放 PR，避免明显重复。
3. 将 `_template/` 复制为 `community/agents/<agent-id>/`；`agent-id` 使用小写 ASCII
   kebab-case。
4. 编写 `agent.json` 和 `README.md`；Agent 需要的新 Skill 写在 `skills/<skill-name>/` 下。
5. 替换全部模板占位符，在 `evals/evals.json` 中提供至少一个正向、一个反向案例。
6. 在 `provenance.json` 中记录 GitHub 作者和全部第三方材料。
7. 对照本文末尾的自检清单逐项检查。
8. 使用 DCO 签署提交（`git commit -s`），向公仓 `main` 分支提交 PR；认领了 Issue 的，在
   PR 描述中写 `Closes #<Issue 编号>`。

仓库通用环境、邮箱和 DCO 规则仍然适用，详见[中文贡献指南](../../CONTRIBUTING.zh-CN.md)。

## 目录结构

```text
community/agents/<agent-id>/
├── agent.json                  # Agent 定义（客户端读取）
├── README.md                   # 适用场景、示例任务、预期结果（客户端读取）
├── skills/                     # 本 Agent 自带的 Skill（客户端读取，可选）
│   └── <skill-name>/
│       └── SKILL.md
├── evals/
│   └── evals.json              # 示例任务与验收要点（社区评审用）
└── provenance.json             # 作者与来源声明（社区评审用）
```

客户端只读取 `agent.json`、`README.md` 和 `skills/`；`evals/` 与 `provenance.json` 供社区
评审使用。参照 Skill 试点，每个包最多 30 个文件、总大小不超过 1 MiB。软链接、可执行
文件、脚本、二进制、真实机器绝对路径和未替换的模板占位符都会被拒绝。

## `agent.json` 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | Agent 名称。只能含字母、数字、下划线、连字符和汉字，不含空格，首尾无空白；显示宽度不超过 60（汉字计 2）；不得使用"指挥官""commander""cogseed"等保留名 |
| `description_zh` / `description_en` | 至少一个 | 说明这个 Agent 面向谁、处理什么、交付什么，以及典型的用户说法；不超过 800 字符。客户端靠它判断何时派给这个 Agent，请写具体 |
| `workflow` | 是 | Markdown 工作流。引用 Skill 时只写 Skill 名，例如"调用技能 study-plan-builder"，不写文件路径或安装路径 |
| `category` | 是 | 分类代码，取 `education`、`ecommerce`、`rnd`、`creation`、`data`、`office`、`general` 之一；学习与教育场景用 `education` |
| `agent_id` | 有自带 Skill 时必填 | 与目录名 `<agent-id>` 一致；只含字母、数字、下划线和连字符，不超过 64 字符 |
| `skill_list` | 否 | 本 Agent 可使用的 Skill 列表，规则见下一节；不写表示不限制，`[]` 表示不使用任何 Skill |
| `icon` | 否 | 图标名，例如 `graduation-cap`、`book-open`、`pen`、`calculator`、`users`、`briefcase`、`document`、`chart`、`code`、`target`；不得使用 `crown` |
| `color` | 否 | 颜色名：`gold`、`coral`、`mint`、`lavender`、`peach`、`sky`、`sunshine`、`rose`、`sage`、`periwinkle`、`butter`、`blush`、`cyan`、`violet`、`lime`、`salmon`、`emerald` |
| `knowhow` | 否 | 核心能力，每条一句，建议 2–5 条 |
| `standards` | 否 | 可观察的交付标准，每条一句，建议 2–5 条 |
| `inputs` | 否 | 开始前需要用户填写的表单项；每项包含 `id`（小写字母、数字、下划线，最长 32）、`label`、`type`（`text`、`textarea`、`select`、`multiselect`、`number`、`boolean`、`file`、`directory`）和 `default` |
| `interactive` | 否 | 布尔值 |
| `output_format` | 否 | `auto`、`text`、`dashboard`、`artifact` 之一；不确定时用 `auto` |
| `runtime` | 否 | 只能是 `{"kind": "in_process"}` |

不要写 `version`、`created_at`、`updated_at`，也不要写连接器、账号、密钥或任何上表以外的
字段；版本和发布时间由平台在发布时生成，格式外字段会被拒绝。

## Skill 引用规则

`skill_list` 中每一项必须是下面两类之一：

| 写法 | 含义 | 本试点 |
|---|---|---|
| `<skill-name>` | 本 Agent 自带的 Skill，必须对应 `skills/<skill-name>/SKILL.md` | 接受，计入 Skill 贡献 |
| `builtin:<name>` | 客户端内置能力 | 客户端当前默认未开放，暂不接受；开放后另行通知 |

本试点不接受引用 Hub 上的 Skill（12 位十六进制 ID）、其他目录或其他 PR 中的社区 Skill。
需要已有能力时，请在本 Agent 的 `skills/` 下写一个新的 Skill。

## 自带 Skill 的写法

- 目录名使用小写 ASCII kebab-case，不能恰好是 12 位十六进制字符；
- `SKILL.md` 必须带 frontmatter，`name` 与目录名一致，`description` 不少于 20 个字符；
- 正文结构与[社区 Skill 模板](../skills/_template/SKILL.md)一致：写明 `use_when`、
  `do_not_use_when`、输入、工作流、输出和边界；
- 不要手写 `ownerAgent` 等归属字段，平台导入时会自动补齐。

## 内容边界

只接受纯文本、声明式内容：不包含或要求执行脚本、联网、写入外部系统、二进制文件或新增
依赖。示例与评测材料不得包含真实个人信息、客户材料或受限课程材料。

## 评审与状态

评审会检查格式、用户价值、工作流与 Skill 的分工、触发和拒绝边界、示例任务、原创与引用、
隐私和安全。目标是在一个工作日内给出首次响应，但不承诺一定接受或在固定日期合并。

状态划分与[社区 Skill 试点](../skills/README.zh-CN.md#评审与状态)一致，本试点默认只到
"社区候选已接受"。客户端开放 Agent 安装后，已合并的 Agent 需另行完成导入验证。

本格式跟随客户端 Agent 包格式草案；若格式调整，维护者负责迁移已合并的 Agent，不要求
贡献者返工。

## 自检清单

- [ ] 目录为 `community/agents/<agent-id>/`，`agent_id` 与目录名一致；
- [ ] `agent.json` 是合法 JSON，包含 `name`、`workflow`、`category` 和至少一种描述；
- [ ] `name` 不含空格，`category`、`icon`、`color` 取值在上表范围内；
- [ ] 没有 `version`、`created_at`、`updated_at` 或其他格式外字段；
- [ ] `skill_list` 每一项都有对应的 `skills/<skill-name>/SKILL.md`，工作流中引用的 Skill 名与之一致；
- [ ] 每个自带 Skill 的 frontmatter `name` 与目录名一致；
- [ ] `README.md` 写清适用场景、不适用情况、示例任务和预期结果；
- [ ] `evals/evals.json` 至少一个正向、一个反向案例；
- [ ] `provenance.json` 已填写作者和第三方材料；
- [ ] 全部模板占位符已替换，没有本机绝对路径或个人信息；
- [ ] 提交带 DCO sign-off，提交邮箱与 GitHub 账号一致。
