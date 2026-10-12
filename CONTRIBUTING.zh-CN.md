# 为 CogSeed 做贡献

[English](./CONTRIBUTING.md) · 简体中文

> 本文是 `CONTRIBUTING.md` 的中文翻译。如中英文内容不一致，以英文版为准。

感谢你有兴趣为 CogSeed 做贡献！公仓提供经过审核的发布快照，日常研发在私仓进行。欢迎提交 Bug
报告、修复、新功能、文档、测试和示例。

## 行为准则

请阅读并遵守[行为准则](./CODE_OF_CONDUCT.md)。参与本项目即表示你愿意遵守
其中的规范。

## 开始之前

体验发布版源码，请按 [README](./README.zh-CN.md#从源码运行) 操作。
以下步骤用于从最新公仓 `main` 开始贡献开发。

CogSeed 主要面向 macOS 和 Windows 开发。在开始之前，请安装 Git、Node.js
24.x 和 npm 11.11.0。平台要求和环境配置详见
[开发指南](./docs/DEVELOPMENT.zh-CN.md#开发环境配置)。

1. Fork 仓库，然后克隆你的 Fork，并添加上游仓库：

   ```bash
   git clone https://github.com/<your-github-username>/cogseed.git
   cd cogseed
   git remote add upstream https://github.com/bonc-ai/cogseed.git
   git fetch upstream
   ```

2. 为本仓库单独配置 Git 身份。请从 **GitHub → Settings → Emails** 复制你
   的完整 noreply 地址；CogSeed 的公开历史检查要求使用
   `{user-id}+{username}@users.noreply.github.com` 格式：

   ```bash
   git config user.name "Your Name"
   git config user.email "<github-user-id>+<username>@users.noreply.github.com"
   ```

3. 从最新的公仓 `main` 创建一个短期分支：

   ```bash
   git switch -c dev/<your-github-username> upstream/main
   ```

4. 安装锁定版本的依赖。`npm ci` 还会准备原生模块并下载开发所需资源，
   因此首次安装需要网络连接，可能耗时数分钟：

   ```bash
   npm ci
   npm run test:resources:setup
   ```

5. 修改代码前，先确认干净基线能够通过检查：

   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run readme:check
   ```

## 开发命令

| 命令 | 用途 |
|---|---|
| `./run.sh` | 在 macOS 或 Linux 上启动源码版应用 |
| `run.cmd` | 在 Windows 上启动源码版应用 |
| `npm run typecheck` | 执行 TypeScript 类型检查（`tsc --noEmit`） |
| `npm run lint` | 检查源代码、测试和脚本 |
| `npm test` | 运行完整的 JavaScript 和资源测试 |
| `npm run test:js -- <file>` | 运行单个 JavaScript/TypeScript 测试文件 |
| `npm run test:resources` | 运行 Python 资源测试 |
| `npm run readme:check` | 检查 README 中的本地链接和内置资源 |
| `npm run builtin:manifest` | 重新生成内置资源清单 |
| `npm run builtin:manifest:check` | 检查内置资源清单是否为最新版本 |

请勿直接调用 Vitest。仓库测试运行器会在 JavaScript 测试前后管理 Electron
原生模块的 ABI。

## 修改要求

- 保持改动聚焦，优先提交规模较小、便于评审的 Pull Request。
- 遵守 [开发指南](./docs/DEVELOPMENT.zh-CN.md#开发规则) 中的仓库结构和工程边界。
- 对修改的行为补充或更新测试；适用时应覆盖失败和恢复路径。
- 打开 Pull Request 前，运行 `npm run typecheck`、`npm run lint`、
  `npm test` 和 `npm run readme:check`。
- 修改内置资源后，运行 `npm run builtin:manifest`，并提交更新后的清单。
- 切勿提交凭证、私密日志、本地运行数据或客户材料。疑似安全漏洞请按照
  [SECURITY.md](./SECURITY.md) 私下报告。

### 社区 Skill 最小试点

开发者既可以认领推荐的社区 Skill Issue，也可以自主选题并从
[`community/skills/_template/`](./community/skills/_template/) 直接创建声明式候选。
自主选题无需事前批准，也不强制关联 Issue，但必须在 PR 中完整说明用户问题、边界、
评测案例和来源。首期不接收脚本、可执行文件、二进制、联网、外部系统写入或新增依赖。
完整目录结构、校验命令、评审边界和候选状态见
[社区 Skill 贡献指南](./community/skills/README.zh-CN.md)。

接受到 `community/skills/` 只表示仓库已评审候选并导入私仓，随后续快照公开；
不代表已验证应用导入、发布到 Hub、
随正式版本分发或获准用于生产环境。

## 开发者原创声明（DCO）

每个提交都必须包含 `Signed-off-by` 尾注，用来确认你有权按照本项目许可证
提交该贡献。尾注必须使用与提交作者相同的 GitHub noreply 地址：

```text
Signed-off-by: Your Name <12345678+username@users.noreply.github.com>
```

创建提交时添加签署信息：

```bash
git commit -s
```

为最近一个本地提交补充尾注：

```bash
git commit --amend --no-edit --signoff
```

签署即表示你同意[开发者原创声明](https://developercertificate.org/)中的
条款。请勿在提交消息或尾注中填写其他邮箱地址；邮箱合规检查会扫描完整的
公开提交记录。

## 报告问题

- 提交新 Issue 前先搜索现有问题。
- 请提供 CogSeed 版本、平台、预期行为、实际行为和可复现步骤。
- 从截图和日志中移除凭证及私密数据。
- 发现安全漏洞时，**请勿创建公开 Issue**，请按照
  [SECURITY.md](./SECURITY.md) 私下报告。

## Pull Request

- 外部贡献应提交到公仓的 `main` 分支。
- 如有对应 Issue，请在 Pull Request 中引用。
- 说明改动内容、修改原因和验证方式。
- 不要在差异中混入生成产物或无关格式调整。
- 及时响应评审意见，并保持分支与 `upstream/main` 同步。

首次贡献者的工作流可能显示为等待维护者批准。这是来自 Fork 的 Pull Request
的正常行为，并不表示检查失败。

评审前请运行前述验证命令及本次修改相关的测试。公仓 CI 以实际配置的工作流
和必需状态检查为准；文档不能证明检查已经执行或通过。请明确标注未验证的平台。

## 贡献回流

公仓 `main` 在发版时接收审核通过的源码快照。外部 PR 面向该分支评审；
接受的补丁由维护者导入私仓开发分支，并保留公仓 PR 引用、原始提交作者和 DCO 签署。
仅完成导入时保持公仓 PR 打开，不将其当作已经合并或发版。

对应源码候选通过发布门禁后，维护者使用 merge commit 将已评审的公仓 PR
合入 `main`，保留贡献者的原始提交。仍须满足必需 CI 和 CODEOWNERS 审批；
不得用 squash 或 rebase 丢弃这些提交。下一次快照以更新后的公仓 `main`
为基础；已登记贡献尚未进入该分支历史时，同步会被阻止。作者邮箱应使用与
GitHub 账号关联的 noreply 地址，以便 GitHub 识别贡献归属。

只允许合入基于当前清洁公开基线、已经审核的公开历史。基于旧历史的贡献须
经过保留作者的清洁迁移，不得接回切换前历史或私仓历史。内容已通过快照公开的
历史修复，须保持当前完整文件树不变，并满足相同 CI 和审批门禁。

进入研发、合入源码都不等于已经发版；维护者在版本可用时补充公开 Release
链接。内部评审记录及私仓提交历史不会复制到公仓。

贡献者从 `upstream/main` 创建分支，并按公仓 PR 的反馈修改。不要自行向公仓
合入私仓分支或推送发布快照。

### 提交消息

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```text
<type>(<scope>): <subject>
```

示例：`fix(messaging): handle disconnected group delivery`。

## 许可证

提交贡献即表示你同意该贡献按照 [MIT License](./LICENSE) 进行许可。
