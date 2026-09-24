# Spec Kit 与 AI Product Suite 团队使用说明

## 仓库提供什么

本接入固定 Specify CLI 1.0.6 的原生项目资源、Codex 集成和 AI Product Suite 0.2.1
内部候选组件。`.specify/` 保存模板、脚本、规则和组件注册信息；
`.agents/skills/speckit-*` 保存 10 个原生 Skills 和 10 个 AI Product Skills。
拉取包含本接入的分支后，不需要再次 `specify init` 或重新安装三个 AI Product 组件。
现有仓库规则仍由 [AGENTS.md](../AGENTS.md) 定义。

AI Product Suite 的原始授权是内部非生产试用；仓库维护者已确认获得作者对本次分发的许可。
参见 [本次分发说明](../.specify/licenses/distribution-note.md) 和保留的
[原始试用说明](../.specify/licenses/ai-product-internal-trial.md)。
原生 Spec Kit 资源采用 [MIT 许可证](../.specify/licenses/spec-kit-MIT.txt)。

## 每台电脑首次准备

需要 Git、Codex、可执行 Bash 的环境（Windows 可用 Git Bash）、Python 3 和 uv。
Specify CLI 按官方版本安装一次，多项目共用：

```bash
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.0.6
specify version
```

已有 1.0.6 时无需重装。其他版本升级需先验证项目脚本与组件兼容性。

**模板组合脚本使用 PATH 上的 Python，不会自动使用 Specify CLI 的隔离环境。**
先执行 `python3 -c 'import yaml'`；失败时可在项目内创建独立环境，不向系统 Python 安装包：

```bash
uv venv .venv-speckit
uv pip install --python .venv-speckit 'PyYAML>=6,<7'
# macOS/Linux：
source .venv-speckit/bin/activate
# Windows Git Bash：使用 source .venv-speckit/Scripts/activate
```

在这个环境中启动编码 Agent，确保其执行的模板脚本也使用该 Python。
Windows 步骤尚未在本次 macOS 验证中执行，需要 Windows 同事首次接入时验证。
`.venv-speckit/` 是机器环境，不得提交。

## 首次检查

在仓库根目录执行：

```bash
specify integration status
specify extension list
specify preset list
specify workflow list
.specify/scripts/bash/resolve-template.sh constitution-template --json
.specify/scripts/bash/resolve-template.sh spec-template --json
.specify/scripts/bash/resolve-template.sh plan-template --json
.specify/scripts/bash/resolve-template.sh tasks-template --json
```

预期 Codex 集成正常，三个组件分别是 `ai-product`、`ai-product-method`、
`ai-product-lifecycle`，均为 0.2.1。四次实际解析必须成功，输出应同时包含原生模板和附加规则。
`preset resolve` 的层级展示不能替代以上脚本检查。
仓库补充了 `.specify/.gitignore`，因此集成状态可能报告该受管文件已修改；
应保留这些忽略规则，不要使用 `integration upgrade --force` 覆盖。

## 从一个真实任务开始

首次正式使用前评审 [Constitution](../.specify/memory/constitution.md)，并记录采纳日期。
需求明确时使用 `$speckit-specify`，然后依次执行 `$speckit-plan`、`$speckit-tasks`、
`$speckit-analyze`、`$speckit-implement`。存在产品或 AI 不确定性时，从
`$speckit-ai-product-route` 开始，根据路由选择后续工作，不要求每个小改动跑完整生命周期。
按已有功能目录增量维护规格，项目级索引可在首次创建实际规格时建立。

需要完整工作流时，在已配置 Codex CLI 的终端显式启动：

```bash
specify workflow run ai-product-lifecycle \
  --input 'spec=你的真实需求' --input 'entry_mode=iteration' --input 'integration=codex'
```

这会调用 Agent 并可能修改项目，不属于安装检查。工作流在人工 Gate 暂停；
后续使用 `specify workflow resume <run-id>`。Gate 决定不替代工具权限和发布授权。
首要不确定性由 route 后的 review-route Gate 选择，并非 workflow 的输入参数。

## 任务系统协作

需要与外部任务系统联动时，每人单独准备对应 CLI/Skill 及已登录的工作浏览器。
执行任务适配器检查，确认同步状态正常后再读取任务正文及全部评论。
任务编号必须写入规格；空描述、未知验收边界不能补写为事实。
业务验证遵循本仓库命令，不照搬外部 Hub 的包管理或数据库命令。
提交与回写结果按当前任务授权及所用 Skill 的预览、执行、回读规则进行。
本次接入不包含全局外部任务工具、登录信息或远程写入凭证。

## 维护与共享

- 提交原生资源、Skills、组件内容、项目级注册信息和可共享的默认配置。
- 不提交当前 feature 指针、安装锁、缓存、备份、工作流运行记录或本机覆盖配置。
- 工作流来源使用仓库相对路径，不依赖安装者的临时目录；组件内容已完整复制到仓库。
- 本地来源组件不由公开 Catalog 自动更新；版本升级通过新 MR 审阅组件差异并重新验证。
- 安装和测试通过只证明工具可用，不代表需求已验收、已发布或已产生业务价值。
