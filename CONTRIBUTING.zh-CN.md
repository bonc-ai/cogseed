# 为 CogSeed 做贡献

[English](./CONTRIBUTING.md) · 简体中文

> 本文是 `CONTRIBUTING.md` 的中文翻译。如中英文内容不一致，以英文版为准。

感谢你有兴趣为 CogSeed 做贡献！本项目采用开放方式开发，欢迎提交 Bug
报告、修复、新功能、文档、测试和示例。

## 行为准则

请阅读并遵守[行为准则](./CODE_OF_CONDUCT.md)。参与本项目即表示你愿意遵守
其中的规范。

## 开始之前

体验发布版源码，请按 [README](./README.zh-CN.md#从源码运行) 操作。
以下步骤用于从最新 `develop` 开始贡献开发。

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

3. 从最新的 `develop` 创建一个短期分支：

   ```bash
   git switch -c dev/<your-github-username> upstream/develop
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
- 遵守 [AGENTS.md](./AGENTS.md) 中的仓库结构和工程边界。
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

合并到 `community/skills/` 只表示仓库已评审候选，不代表已验证导入、发布到 Hub、
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

- 外部贡献应提交到 `develop`，不要提交到 `main` 或 `cicd`。
- 如有对应 Issue，请在 Pull Request 中引用。
- 说明改动内容、修改原因和验证方式。
- 不要在差异中混入生成产物或无关格式调整。
- 及时响应评审意见，并保持分支与 `upstream/develop` 同步。

首次贡献者的工作流可能显示为等待维护者批准。这是来自 Fork 的 Pull Request
的正常行为，并不表示检查失败。

提交到 `develop` 的 Pull Request 必须通过：

- `check-commit-emails`：防止个人邮箱进入公开历史；
- `static-gates`：运行类型检查、Lint、设计 Token、内置资源清单、README
  链接和跳过测试策略检查；
- `affected-tests`：根据 Pull Request 差异和模块依赖图选择相关测试。

Windows 测试分片也会运行。虽然它们目前不是必需的状态检查，但出现红灯时
仍需调查。改动合入 `develop` 后会再次运行完整测试；从 `develop` 提升到
`cicd` 时会执行完整的 macOS、Windows 和合规发布门禁。

## 分支与合并规则

CogSeed 使用三个长期分支：

- `main`：受保护的公开发布分支，应始终保持可发布状态。
- `develop`：受保护的集成分支，也是功能开发和外部贡献 Pull Request 的
  目标分支。
- `cicd`：受保护的发布门禁；从 `develop` 提升后，会先通过完整验证和合规
  流程，才允许创建发布标签。

贡献者的短期分支默认使用 `dev/<your-github-username>`。发布维护者可以创建
`release/vX.Y` 分支处理仅包含补丁的版本工作。

合并前至少需要一名 CODEOWNER 批准，并通过所有必需状态检查。Pull Request
作者不能批准自己的改动；只有具备写入权限的维护者才能在满足要求后合并。
维护者通过 GitHub 合并时，必须启用 **Keep my email addresses private**，
确保生成的合并提交也使用 noreply 地址。

### 提交消息

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```text
<type>(<scope>): <subject>
```

示例：`fix(messaging): handle disconnected group delivery`。

## 许可证

提交贡献即表示你同意该贡献按照 [MIT License](./LICENSE) 进行许可。
