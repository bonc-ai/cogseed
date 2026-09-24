# 社区 Skill 最小试点

[English](./README.md)

首期接收开发者自主提出的声明式 Skill，用于处理用户提供或明确授权读取的本地内容。
推荐 Issue 只是可选的新手题目，不是白名单、名额或提交前置条件。候选内容不得包含
或要求执行脚本、联网、写入外部系统、二进制文件或新增依赖。

## 贡献流程

1. 选择任一入口：
   - 认领一个推荐的 `community skill` Issue；或
   - 自主设计 Skill，无需事前批准，也不强制创建或关联 Issue。
2. 先搜索已有 Skill 和开放 PR，避免明显重复。
3. 将 `_template/` 复制为 `community/skills/<skill-id>/`；`skill-id` 使用小写
   ASCII kebab-case。
4. 替换全部模板占位符，并提供至少一个正向、一个反向评测案例。
5. 在 `provenance.json` 中记录 GitHub 作者和全部第三方材料。
6. 运行 `npm run community:skills:check`。
7. 使用 DCO 签署提交，采用[社区 Skill PR 模板](../../.github/PULL_REQUEST_TEMPLATE/community-skill.md)
   向 `develop` 分支提交 PR。如果 GitHub 默认打开了通用模板，可以在 PR 地址中使用
   `template=community-skill.md` 查询参数，或复制专用模板正文。

仓库通用环境、邮箱和 DCO 规则仍然适用，详见
[中文贡献指南](../../CONTRIBUTING.zh-CN.md)。

维护者可以从[首期 Issue 草案](../PILOT_BACKLOG.zh-CN.md)创建推荐任务。这些草案
只用于降低首次贡献门槛，不限制开发者自主选题和直接提交。

## 必需目录结构

```text
community/skills/<skill-id>/
├── SKILL.md
├── evals/
│   └── evals.json
└── provenance.json
```

可选的纯文本内容可以放入 `references/`、`templates/` 或 `examples/`。首期每个包
最多 30 个文件、总大小不超过 1 MiB。软链接、可执行文件、脚本、二进制、真实
机器绝对路径和未替换的模板占位符都会被拒绝。

## 评审与状态

评审会检查用户价值、触发和拒绝边界、输出质量、评测案例、原创与引用、隐私和
安全。试点目标是在三个工作日内给出首次响应，但不承诺一定接受或在固定日期合并。

状态严格分开：

1. **已提交 PR**：贡献提案。
2. **社区候选已合并**：只表示源码通过仓库评审。
3. **已验证导入**：在干净 CogSeed 环境中另行验证成功。
4. **已发布 Hub**：通过独立审核并由 CogSeed Hub 分发。
5. **已随包发布**：另行批准进入正式应用版本。

前一状态不自动证明后一状态。首期默认只到状态 2；维护者明确执行并记录额外 Gate
后，才能进入后续状态。

## 评审负责人

`community/` 通过 CODEOWNERS 指定 `@windsgone`。涉及安全、版权、脚本、联网或
依赖的提案不属于首期范围，必须退回并进入单独的维护者评审流程。
